"use strict";
/**
 * OPPORTUNITIES — the analysis layer over the reports we already have.
 *
 * Every other report answers "what happened". This one answers "so do this":
 * a ranked, dollar-sized list of things worth acting on, each one drawn from
 * feeds the platform already serves and each one linking back to the report
 * that proves it.
 *
 * PURE. No Express, no Metabase, no fs — `buildOpportunities(feeds, opts)`
 * takes the rows and returns the payload, so scripts/opportunities.spec.js can
 * LIFT AND RUN the detectors over fixtures rather than regex over them. Every
 * defect in here is arithmetic about thresholds, and a regex passes on an
 * inverted comparison.
 *
 * THREE RULES THAT SHAPE EVERYTHING BELOW
 *
 * 1. A FEED THAT DID NOT ANSWER IS NOT AN ORG WITH NOTHING TO FIX.
 *    `null` (fetch failed) and `[]` (the org genuinely has none of this) are
 *    different facts and render differently — "couldn't load" vs "nothing to
 *    act on". Same presence-not-value rule as hasAbsent / ciHasStatus. A
 *    family that silently vanished on a failed fetch would tell a director
 *    their facilities are fine on the morning Metabase was down.
 *
 * 2. SUPPRESSION IS VISIBLE. Dan's ask — "if the org doesn't do court rentals,
 *    obviously don't suggest court stuff" — is a floor per family, and the
 *    floor that fired is REPORTED rather than the family just being absent.
 *    An org reading "Courts — not enough court activity to analyse (14
 *    bookings, needs 25)" knows the report looked; an org reading nothing
 *    cannot tell that from a bug.
 *
 * 3. DOLLARS OF DIFFERENT KINDS ARE NEVER ADDED TOGETHER. An empty seat is a
 *    ceiling on what could have been sold; an unpaid invoice is money already
 *    owed; a mailing list is neither. Summing them produces one impressive
 *    number that means nothing, which is how a report stops being trusted.
 *    `kind` travels with every finding and the totals stay separate.
 */

// ── Floors ───────────────────────────────────────────────────────────────
// A rate over a handful of rows is not a rate. Precedent all over this repo:
// RATE_MIN_VIEWS on the campmap strip, WL_CONV_MIN_OFFERS on the waitlist,
// SURVEY_MIN_FOR_STATS on the readout. Every one of these is the smallest N at
// which the statement under it would survive being quoted back at us.
const FLOORS = {
  sections: 12,        // programs family: sections that actually ran
  facility: 20,        // facilities family: reservations in the window
  courts: 25,          // court family — Shrewsbury has 14, and is why this exists
  memberships: 20,     // memberships/passes on record
  households: 40,      // people family: households with an enrolment
  enrolments: 60,      // people family: enrolment rows to slice demographically
  sectionsPerProgram: 2,   // "this program keeps under-filling" needs repetition
  itemsPerFinding: 3,      // below this a "pattern" is one row wearing a label
  agedBand: 25,            // people in an age band before its index means anything
  zipHouseholds: 15,       // households in a zip before its enrol rate means anything
  pairHouseholds: 20,      // households in an activity before affinity means anything
  pairShared: 5,
  dollars: 250,        // a finding worth less than this is noise on a director's desk
};

// Under-fill is "half empty", not "not quite full" — a 70%-full section is a
// normal section. Chosen to match the Director's Report's own low-fill panel
// (capacity > 10, fill < 50) so two surfaces cannot disagree about what a
// poorly-filled section is.
const UNDERFILL_PCT = 50;
const FULL_PCT = 95;
const MIN_CAPACITY = 6;

const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/,/g, "")); return isNaN(n) ? 0 : n; };
const isNum = (v) => v != null && v !== "" && !isNaN(parseFloat(String(v).replace(/,/g, "")));
const round = (v) => Math.round(v || 0);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const uniq = (xs) => [...new Set(xs)];

// A row's own per-head price, which is what an empty seat is worth. Falls back
// to the program's median rather than to a platform guess: a section that took
// no money has no price of its own, and inventing one prices empty seats in a
// free program as revenue.
function perHead(row) {
  const en = num(row.enrolled);
  return en > 0 ? num(row.charged) / en : null;
}

// ── Finding + family plumbing ────────────────────────────────────────────
// kind decides the WORDS and which total a finding lands in:
//   upside      — revenue that could plausibly be earned (a ceiling, always)
//   at-risk     — money already collected that walked back out, or may
//   uncollected — billed and not paid: owed today, not hypothetical
//   audience    — a list of people, deliberately carrying NO dollar figure
//   attention   — a pattern worth a look that resists being priced at all
const KINDS = ["upside", "at-risk", "uncollected", "audience", "attention"];

function finding(o) {
  if (!KINDS.includes(o.kind)) throw new Error("unknown finding kind: " + o.kind);
  return {
    id: o.id, family: o.family, title: o.title, kind: o.kind,
    value: o.value == null ? null : round(o.value),
    count: o.count == null ? null : o.count,
    headline: o.headline, detail: o.detail || "", action: o.action || "",
    basis: o.basis || "",
    items: (o.items || []).slice(0, 8),
    more: Math.max(0, (o.items || []).length - 8),
    link: o.link || null,
  };
}

const linkTo = (report, query) => ({ report, query: query || "" });

/**
 * The families, their gates, and their detectors.
 *
 * `gate` returns null when the family should render, or a STRING saying why it
 * is being suppressed. That string is shown to the reader — see rule 2.
 */
function familyGate(key, ctx) {
  const f = ctx.feeds;
  const miss = (name, feed) => feed === null ? name + " could not be loaded" : null;
  switch (key) {
    case "programs": {
      const m = miss("The Programs report", f.programs); if (m) return { state: "unavailable", reason: m };
      if (ctx.ranSections.length < FLOORS.sections)
        return { state: "insufficient", reason: "only " + ctx.ranSections.length + " section" + (ctx.ranSections.length === 1 ? "" : "s") + " ran in this window (needs " + FLOORS.sections + ")" };
      return null;
    }
    case "people": {
      const m = miss("Participant demographics", f.demographics); if (m) return { state: "unavailable", reason: m };
      if (ctx.enrolRows.length < FLOORS.enrolments)
        return { state: "insufficient", reason: "only " + ctx.enrolRows.length + " enrolments on record (needs " + FLOORS.enrolments + ")" };
      return null;
    }
    case "facilities": {
      const m = miss("The Facility Rental Schedule", f.facility); if (m) return { state: "unavailable", reason: m };
      if (ctx.facRows.length < FLOORS.facility)
        return { state: "insufficient", reason: "only " + ctx.facRows.length + " facility reservation" + (ctx.facRows.length === 1 ? "" : "s") + " in this window (needs " + FLOORS.facility + ")" };
      return null;
    }
    case "courts": {
      // DAN'S RULE, LITERALLY: an org that does not rent courts is never shown
      // court analysis. Gated on the org's OWN court volume rather than on
      // whether the card answered — a court card returns rows for an org with
      // three pickleball reservations, and three is not a utilisation study.
      if (f.courts === null && f.facility === null) return { state: "unavailable", reason: "Court Utilization could not be loaded" };
      const n = ctx.courtRows.length;
      if (n < FLOORS.courts)
        return { state: "insufficient", reason: n === 0
          ? "this organisation does not rent courts"
          : "only " + n + " court booking" + (n === 1 ? "" : "s") + " in this window (needs " + FLOORS.courts + ")" };
      return null;
    }
    case "money": {
      const m = miss("The Facilities summary", f.facilitiesSummary); if (m) return { state: "unavailable", reason: m };
      if (ctx.summaryRows.length < FLOORS.facility)
        return { state: "insufficient", reason: "not enough billed activity in this window" };
      return null;
    }
    default: return null;
  }
}

// ══ PROGRAMS ═════════════════════════════════════════════════════════════

// 1. Sections that ran under half full, rolled up to the PROGRAM — because one
//    thin section is a bad week and six thin sections of the same program is a
//    decision about capacity. The value is a CEILING (every empty seat sold at
//    the price the filled ones paid) and is labelled as one.
function dUnderfilled(ctx) {
  const rows = ctx.ranSections.filter(r => num(r.capacity) >= MIN_CAPACITY && num(r.enrolled) > 0 && isNum(r.fill_pct) && num(r.fill_pct) < UNDERFILL_PCT);
  if (rows.length < FLOORS.itemsPerFinding) return null;
  const byProg = new Map();
  for (const r of rows) {
    const k = r.program || "(unnamed program)";
    if (!byProg.has(k)) byProg.set(k, { name: k, secs: [], empty: 0, seats: 0, season: r.program_season });
    const g = byProg.get(k);
    g.secs.push(r);
    const seats = num(r.capacity) - num(r.enrolled);
    const price = perHead(r) ?? ctx.programMedianPrice.get(k) ?? 0;
    g.seats += seats; g.empty += seats * price;
  }
  const groups = [...byProg.values()]
    .filter(g => g.secs.length >= FLOORS.sectionsPerProgram)
    .sort((a, b) => b.empty - a.empty);
  if (!groups.length) return null;
  const total = groups.reduce((s, g) => s + g.empty, 0);
  if (total < FLOORS.dollars) return null;
  return finding({
    id: "underfilled-programs", family: "programs", kind: "upside",
    title: "Programs that keep running half empty",
    value: total, count: groups.reduce((s, g) => s + g.secs.length, 0),
    headline: groups.reduce((s, g) => s + g.secs.length, 0) + " sections across " + groups.length + " programs ran under " + UNDERFILL_PCT + "% full",
    detail: "These are not one-off quiet weeks — each of these programs had at least " + FLOORS.sectionsPerProgram + " sections finish under half full, so the capacity is set for demand that is not showing up.",
    action: "Cut the capacity to what actually enrols, merge the thin sections, or move the slot. Every seat you stop offering is a seat you stop staffing for.",
    basis: "Empty seats × the price the enrolled participants in that same section actually paid. It is a ceiling — it assumes every empty seat could have been sold.",
    items: groups.map(g => ({
      label: g.name,
      sub: g.secs.length + " sections · " + round(med(g.secs.map(s => num(s.fill_pct)))) + "% median fill · " + round(g.seats) + " empty seats",
      value: round(g.empty),
      link: linkTo("programs", g.season ? "season=" + encodeURIComponent(g.season) : ""),
    })),
    link: linkTo("programs"),
  });
}

// 2. The same program holding a jammed section and an empty one. This is the
//    cheapest fix on the whole report — no new capacity, no new marketing,
//    move people between rooms that already exist.
function dCapacityMismatch(ctx) {
  const byProg = new Map();
  for (const r of ctx.ranSections) {
    if (!(num(r.capacity) >= MIN_CAPACITY) || !isNum(r.fill_pct)) continue;
    const k = r.program || "(unnamed program)";
    if (!byProg.has(k)) byProg.set(k, []);
    byProg.get(k).push(r);
  }
  const items = [];
  for (const [name, secs] of byProg) {
    if (secs.length < 2) continue;
    const full = secs.filter(r => num(r.fill_pct) >= FULL_PCT);
    const thin = secs.filter(r => num(r.fill_pct) < UNDERFILL_PCT);
    if (!full.length || !thin.length) continue;
    const turnedAway = full.reduce((s, r) => s + num(r.waitlist_active), 0);
    const spare = thin.reduce((s, r) => s + (num(r.capacity) - num(r.enrolled)), 0);
    items.push({
      label: name,
      sub: full.length + " section" + (full.length === 1 ? "" : "s") + " at " + round(med(full.map(r => num(r.fill_pct)))) + "%+ (" + turnedAway + " waiting) alongside " + thin.length + " under " + UNDERFILL_PCT + "% with " + round(spare) + " spare seats",
      value: null, sort: turnedAway * 1000 + spare,
      link: linkTo("programs", "program=" + encodeURIComponent(name)),
    });
  }
  if (items.length < FLOORS.itemsPerFinding) return null;
  items.sort((a, b) => b.sort - a.sort);
  return finding({
    id: "capacity-mismatch", family: "programs", kind: "attention",
    title: "Full sections sitting next to empty ones",
    count: items.length,
    headline: plural(items.length, "program") + " have a section at " + FULL_PCT + "%+ and another under " + UNDERFILL_PCT + "%",
    detail: "The demand is there; it is pointed at the wrong slot. Same programme, same season, wildly different fill.",
    action: "Look at what separates them — the day, the time, the site, the age band — and move capacity toward the one that sells.",
    basis: "Sections of one program compared against each other inside this window. No dollar figure: the fix moves existing seats rather than adding revenue.",
    items, link: linkTo("programs"),
  });
}

// 3. Waitlist as unmet demand, rolled to the program. The waitlist report says
//    who is waiting; this says what that is worth and which programme to open
//    another section of first.
function dUnmetDemand(ctx) {
  if (!Array.isArray(ctx.feeds.waitlist)) return null;
  const byProg = new Map();
  for (const r of ctx.feeds.waitlist) {
    const waiting = num(r.Waitlisted);
    if (waiting <= 0) continue;
    const k = r.Program || r.Section || "(unnamed program)";
    if (!byProg.has(k)) byProg.set(k, { name: k, waiting: 0, secs: 0, value: 0, cap: 0, enrolled: 0 });
    const g = byProg.get(k);
    g.waiting += waiting; g.secs++; g.value += waiting * num(r.Price);
    g.cap += num(r.Capacity); g.enrolled += num(r.Enrolled);
  }
  const groups = [...byProg.values()].sort((a, b) => b.value - a.value || b.waiting - a.waiting);
  if (!groups.length) return null;
  const total = groups.reduce((s, g) => s + g.value, 0);
  const people = groups.reduce((s, g) => s + g.waiting, 0);
  if (total < FLOORS.dollars) return null;
  return finding({
    id: "unmet-demand", family: "programs", kind: "upside",
    title: "Demand you turned away",
    value: total, count: people,
    headline: people + " waitlist places across " + groups.length + " programs",
    detail: "These people asked to be in a section that had no room. Unlike an empty seat, this demand is named and already interested.",
    action: "Open another section of the programs at the top of this list before you market anything new.",
    basis: "Waitlisted count × the section's own price, summed per program. It assumes everyone waiting would have paid — a ceiling, but a far firmer one than an empty seat.",
    items: groups.map(g => ({
      label: g.name,
      sub: g.waiting + " waiting across " + g.secs + " section" + (g.secs === 1 ? "" : "s") + (g.cap > 0 ? " · " + round(g.enrolled) + "/" + round(g.cap) + " enrolled" : ""),
      value: round(g.value), link: linkTo("waitlist"),
    })),
    link: linkTo("waitlist"),
  });
}

// 4. Fast Track demand past capacity. The Fast Track report already computes
//    "Over Demand $" per section; this rolls it to the program and puts it
//    beside everything else competing for the director's attention.
function dFastTrackOver(ctx) {
  if (!Array.isArray(ctx.feeds.fasttrack)) return null;
  const secs = ctx.feeds.fasttrack.filter(r => String(r["Row Type"] || "").toLowerCase() === "section");
  if (!secs.length) return null;
  const byProg = new Map();
  for (const r of secs) {
    const over = num(r["Over Demand $"]);
    if (over <= 0) continue;
    const k = r.Program || "(unnamed program)";
    if (!byProg.has(k)) byProg.set(k, { name: k, over: 0, secs: 0, ft: 0, cap: 0 });
    const g = byProg.get(k);
    g.over += over; g.secs++; g.ft += num(r["FT Total"]); g.cap += num(r.Capacity);
  }
  const groups = [...byProg.values()].sort((a, b) => b.over - a.over);
  if (!groups.length) return null;
  const total = groups.reduce((s, g) => s + g.over, 0);
  if (total < FLOORS.dollars) return null;
  return finding({
    id: "fasttrack-oversubscribed", family: "programs", kind: "upside",
    title: "Fast Track demand with nowhere to put it",
    value: total, count: groups.reduce((s, g) => s + g.secs, 0),
    headline: plural(groups.length, "program") + " had more Fast Track interest than seats",
    detail: "Fast Track families registered their interest before the section opened, and there were not enough places for them.",
    action: "These are the sections to size up next season — the demand was measured before registration even opened.",
    basis: "The Fast Track report's own Over Demand figure (holds beyond capacity × section price), summed per program.",
    items: groups.map(g => ({
      label: g.name,
      sub: round(g.ft) + " Fast Track holds against " + round(g.cap) + " seats across " + g.secs + " section" + (g.secs === 1 ? "" : "s"),
      value: round(g.over), link: linkTo("fasttrack", "tab=conversions"),
    })),
    link: linkTo("fasttrack", "tab=conversions"),
  });
}

// 5. Programs whose sections get cancelled after taking money. A cancelled
//    section is not merely a refund — it is a family who planned around it.
function dCanceledSections(ctx) {
  const all = ctx.progRows;
  const byProg = new Map();
  for (const r of all) {
    const k = r.program || "(unnamed program)";
    if (!byProg.has(k)) byProg.set(k, { name: k, n: 0, canceled: 0, refunded: 0, charged: 0 });
    const g = byProg.get(k);
    g.n++;
    if (ctx.isCanceled(r)) { g.canceled++; g.refunded += num(r.refunds); g.charged += num(r.charged); }
  }
  const groups = [...byProg.values()]
    .filter(g => g.canceled > 0 && g.n >= FLOORS.sectionsPerProgram)
    .map(g => ({ ...g, rate: pct(g.canceled, g.n) }))
    .sort((a, b) => b.rate - a.rate || b.refunded - a.refunded);
  if (!groups.length) return null;
  const money = groups.reduce((s, g) => s + g.refunded, 0);
  return finding({
    id: "canceled-sections", family: "programs", kind: "at-risk",
    title: "Programs that keep getting cancelled",
    value: money > 0 ? money : null,
    count: groups.reduce((s, g) => s + g.canceled, 0),
    headline: groups.reduce((s, g) => s + g.canceled, 0) + " cancelled sections across " + groups.length + " programs",
    detail: money > 0
      ? "Between them they took " + fmtUsd(money) + " that had to be given back — and every one of those refunds is a family who had already made plans."
      : "None of them had taken money yet, which is the good version of this — but the slots were still published and filled nobody.",
    action: "A programme cancelling most of its sections is either mis-scheduled or mis-priced. Decide before publishing next season rather than after registration opens.",
    basis: "Sections whose status is Cancelled, as a share of that program's sections in this window. Refunds are the card's own refund column on those sections.",
    items: groups.map(g => ({
      label: g.name,
      sub: g.canceled + " of " + g.n + " sections cancelled (" + round(g.rate) + "%)" + (g.refunded > 0 ? " · " + fmtUsd(g.refunded) + " refunded" : ""),
      value: g.refunded > 0 ? round(g.refunded) : null,
      link: linkTo("programs", "program=" + encodeURIComponent(g.name)),
    })),
    link: linkTo("programs"),
  });
}

// 6. Refunds concentrated in sections that still RAN — deliberately excluding
//    cancelled ones, which the detector above already owns. Counting them
//    twice would double the at-risk total and blame the wrong thing.
function dRefundOutliers(ctx) {
  const rows = ctx.ranSections.filter(r => !ctx.isCanceled(r) && num(r.charged) > 0 && num(r.refunds) > 0);
  const orgCharged = ctx.ranSections.reduce((s, r) => s + num(r.charged), 0);
  const orgRefunds = ctx.ranSections.reduce((s, r) => s + num(r.refunds), 0);
  const orgRate = pct(orgRefunds, orgCharged);
  if (orgRate == null) return null;
  // "Above the org's own rate" rather than an absolute threshold: a 12% refund
  // rate is alarming at an org that runs at 2% and unremarkable at one that
  // runs at 10%. The comparison has to be against this org.
  const bar = Math.max(orgRate * 2, 20);
  const items = rows
    .map(r => ({ r, rate: pct(num(r.refunds), num(r.charged)) }))
    .filter(x => x.rate >= bar && num(x.r.refunds) >= 100)
    .sort((a, b) => num(b.r.refunds) - num(a.r.refunds));
  if (items.length < FLOORS.itemsPerFinding) return null;
  const total = items.reduce((s, x) => s + num(x.r.refunds), 0);
  if (total < FLOORS.dollars) return null;
  return finding({
    id: "refund-outliers", family: "programs", kind: "at-risk",
    title: "Sections refunding far above your own rate",
    value: total, count: items.length,
    headline: plural(items.length, "section") + " refunded more than " + round(bar) + "% of what they charged",
    detail: "Your organisation refunds " + round(orgRate) + "% of program revenue overall. These sections ran and still gave back more than double that.",
    action: "Read a handful of these rosters. Repeat refunds in one section usually mean a schedule change, a venue problem, or a description that set the wrong expectation.",
    basis: "Refunds ÷ charged per section, against this organisation's own overall rate. Cancelled sections are excluded — they are counted once, above.",
    items: items.map(x => ({
      label: (x.r.program === x.r.section ? x.r.section : x.r.program + " · " + x.r.section) || "(unnamed)",
      sub: round(x.rate) + "% of " + fmtUsd(num(x.r.charged)) + " charged" + (x.r.program_season ? " · " + x.r.program_season : ""),
      value: round(num(x.r.refunds)),
      link: linkTo("programs", "program=" + encodeURIComponent(x.r.program || "")),
    })),
    link: linkTo("programs", "tab=revenue"),
  });
}

// 7. Payment-plan arrears. Suppressed entirely at an org that runs no plans —
//    the columns are always present and always zero there, so a value test is
//    the right one here (unlike a column-presence question).
function dPlanArrears(ctx) {
  const rows = ctx.progRows.filter(r => num(r.past_due_value) > 0);
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + num(r.past_due_value), 0);
  if (total < FLOORS.dollars) return null;
  rows.sort((a, b) => num(b.past_due_value) - num(a.past_due_value));
  const manual = ctx.progRows.reduce((s, r) => s + num(r.manual_plan_value), 0);
  const auto = ctx.progRows.reduce((s, r) => s + num(r.autopay_plan_value), 0);
  return finding({
    id: "plan-arrears", family: "programs", kind: "uncollected",
    title: "Payment-plan instalments already past due",
    value: total, count: rows.length,
    headline: fmtUsd(total) + " of instalments are late across " + rows.length + " sections",
    detail: auto + manual > 0
      ? round(pct(manual, auto + manual)) + "% of your payment-plan book is collected by hand rather than on a card on file, which is where late instalments come from."
      : "",
    action: "Work this list before it ages further — a late instalment is money a family has already agreed to pay.",
    basis: "The Programs card's own past-due column: instalments whose due date has passed and which are still unpaid.",
    items: rows.map(r => ({
      label: (r.program === r.section ? r.section : r.program + " · " + r.section) || "(unnamed)",
      sub: "scheduled: " + fmtUsd(num(r.scheduled_autopay_value) + num(r.scheduled_manual_value)) + " still to come",
      value: round(num(r.past_due_value)),
      link: linkTo("programs", "tab=revenue"),
    })),
    link: linkTo("programs", "tab=revenue"),
  });
}

// ══ PEOPLE ═══════════════════════════════════════════════════════════════

// 8. Which age bands are under-served — measured against THIS ORG'S OWN
//    registered community rather than against census data we do not have.
//    "Half as likely to be enrolled as their share of your community" is a
//    claim we can actually stand behind; "the town has N teenagers" is not.
const AGE_BANDS = [
  { key: "0-4", lo: 0, hi: 4, label: "Under 5" },
  { key: "5-8", lo: 5, hi: 8, label: "Ages 5-8" },
  { key: "9-12", lo: 9, hi: 12, label: "Ages 9-12" },
  { key: "13-17", lo: 13, hi: 17, label: "Teens 13-17" },
  { key: "18-34", lo: 18, hi: 34, label: "Adults 18-34" },
  { key: "35-54", lo: 35, hi: 54, label: "Adults 35-54" },
  { key: "55-64", lo: 55, hi: 64, label: "Adults 55-64" },
  { key: "65+", lo: 65, hi: 200, label: "Seniors 65+" },
];
function ageBand(age) {
  if (age == null || age === "" || isNaN(Number(age))) return null;
  const a = Number(age);
  if (a < 0 || a > 120) return null;
  return AGE_BANDS.find(b => a >= b.lo && a <= b.hi) || null;
}

function dAgeGap(ctx) {
  if (!Array.isArray(ctx.feeds.users)) return null;
  const enrol = new Map(), base = new Map();
  for (const r of ctx.enrolRows) { const b = ageBand(r.Age); if (b) enrol.set(b.key, (enrol.get(b.key) || 0) + 1); }
  // PERSON grain here, deliberately unlike the money detectors: an age
  // belongs to a person, and deduplicating to households would compare
  // enrolments-by-person against heads-of-household.
  for (const r of ctx.userRows) { const b = ageBand(r.Age); if (b) base.set(b.key, (base.get(b.key) || 0) + 1); }
  const tE = [...enrol.values()].reduce((a, b) => a + b, 0);
  const tB = [...base.values()].reduce((a, b) => a + b, 0);
  if (tE < FLOORS.enrolments || tB < FLOORS.enrolments) return null;
  const rows = AGE_BANDS.map(b => {
    const e = enrol.get(b.key) || 0, n = base.get(b.key) || 0;
    // A band nobody in the community belongs to has no index — and a band with
    // a handful of people has one that swings on a single registration.
    return { band: b, e, n, idx: n >= FLOORS.agedBand && tB > 0 && tE > 0 ? (e / tE) / (n / tB) : null };
  });
  const under = rows.filter(r => r.idx != null && r.idx < 0.8).sort((a, b) => a.idx - b.idx);
  if (!under.length) return null;
  // The audience is what makes this actionable: not "teens are under-served"
  // but "you have N teenagers registered with you who did not enrol".
  const withBand = ctx.enrolledByBand;
  return finding({
    id: "age-gap", family: "people", kind: "audience",
    title: "Age groups your programming under-reaches",
    count: under.reduce((s, r) => s + Math.max(0, (withBand.get(r.band.key) || 0)), 0),
    headline: under.map(r => r.band.label).slice(0, 3).join(", ") + (under.length > 3 ? " and " + (under.length - 3) + " more" : "") + " enrol below their share of your community",
    detail: "Index 1.00 means a band enrols exactly in proportion to its presence in your registered community. Below 0.80 means they are meaningfully under-reached — these are people who already have an account with you.",
    action: "Before building something new, check whether the slot is the problem: teen and tween programming usually loses to school hours rather than to interest.",
    basis: "Enrolment rows by age band ÷ people of that age in your own community records. Measured against your registered households, NOT census population — an age band absent from your records is invisible here.",
    items: under.map(r => ({
      label: r.band.label,
      sub: r.e + " enrolments from " + r.n + " people on record · index " + r.idx.toFixed(2) + (withBand.get(r.band.key) ? " · " + withBand.get(r.band.key) + " never enrolled" : ""),
      value: null, link: linkTo("users", "tab=demo"),
    })),
    link: linkTo("users", "tab=demo"),
  });
}

// 9. Where your registered households are, and where they stop enrolling. The
//    interesting rows are almost always out-of-town households that came in
//    through a rental or a pass and never took a class.
function dZipGap(ctx) {
  if (!Array.isArray(ctx.feeds.users)) return null;
  const hhZip = new Map();
  for (const r of ctx.userRows) {
    const h = r["Household ID"], z = String(r["Zip Code"] || "").trim();
    if (h && z && !hhZip.has(h)) hhZip.set(h, z);
  }
  if (hhZip.size < FLOORS.households) return null;
  const tot = new Map(), enr = new Map();
  for (const [h, z] of hhZip) {
    tot.set(z, (tot.get(z) || 0) + 1);
    if (ctx.enrolledHouseholds.has(h)) enr.set(z, (enr.get(z) || 0) + 1);
  }
  const overall = pct([...enr.values()].reduce((a, b) => a + b, 0), hhZip.size);
  const rows = [...tot.entries()]
    .filter(([, n]) => n >= FLOORS.zipHouseholds)
    .map(([z, n]) => ({ zip: z, n, e: enr.get(z) || 0, rate: pct(enr.get(z) || 0, n) }))
    .filter(r => r.rate < overall * 0.75)
    .sort((a, b) => (b.n - b.e) - (a.n - a.e));
  if (rows.length < FLOORS.itemsPerFinding) return null;
  const audience = rows.reduce((s, r) => s + (r.n - r.e), 0);
  return finding({
    id: "zip-gap", family: "people", kind: "audience",
    title: "Neighbourhoods registered with you that never enrol",
    count: audience,
    headline: audience + " households in " + rows.length + " postcodes have an account and have never taken a program",
    detail: "Across your whole community " + round(overall) + "% of households have enrolled in something. In these postcodes it is far lower — and they already found you once.",
    action: "These are the cheapest people to reach: they are in your system. Check whether non-resident pricing, travel time, or simply never being emailed is what stops them.",
    basis: "Households (by their head-of-household postcode) that appear in your community records but in no enrolment. A household that rents a field or buys a pass counts as registered but not enrolled — which is the point.",
    items: rows.map(r => ({
      label: r.zip,
      sub: r.e + " of " + r.n + " households enrolled (" + round(r.rate) + "% vs " + round(overall) + "% overall)",
      value: null, link: linkTo("users", "tab=demo"),
    })),
    link: linkTo("users"),
  });
}

// 10. Cross-promotion, computed at ACTIVITY level rather than program level —
//     and that is not a simplification, it is the fix. Program-level affinity
//     is dominated by trivial pairs (camp Week C and camp Week D), which is a
//     true statement about the same product and useless as a cross-promotion.
//     Two different activities sharing households is a real signal.
function dCrossPromo(ctx) {
  const hhAct = new Map();
  for (const r of ctx.enrolRows) {
    const h = r["Household ID"], a = (r.Activity || "").trim();
    if (!h || !a) continue;
    if (!hhAct.has(h)) hhAct.set(h, new Set());
    hhAct.get(h).add(a);
  }
  const N = hhAct.size;
  if (N < FLOORS.households) return null;
  const actHH = new Map();
  for (const [h, set] of hhAct) for (const a of set) {
    if (!actHH.has(a)) actHH.set(a, new Set());
    actHH.get(a).add(h);
  }
  const acts = [...actHH.keys()].filter(a => actHH.get(a).size >= FLOORS.pairHouseholds);
  if (acts.length < 2) return null;
  const pairs = [];
  for (let i = 0; i < acts.length; i++) for (let j = i + 1; j < acts.length; j++) {
    const A = actHH.get(acts[i]), B = actHH.get(acts[j]);
    let both = 0; for (const h of A) if (B.has(h)) both++;
    if (both < FLOORS.pairShared) continue;
    const expected = (A.size * B.size) / N;
    if (!(expected > 0)) continue;
    const lift = both / expected;
    // Below 1.0 the two activities share FEWER households than chance — the
    // opposite of an affinity, and promoting across them is the worst bet on
    // the page. Only over-represented pairs are offered.
    if (lift < 1.15) continue;
    // The deliverable is the households in one and NOT the other — the list
    // you would actually email. Direction matters, so both are offered.
    pairs.push({ a: acts[i], b: acts[j], both, na: A.size, nb: B.size, lift });
  }
  if (!pairs.length) return null;
  pairs.sort((x, y) => y.lift - x.lift);
  return finding({
    id: "cross-promo", family: "people", kind: "audience",
    title: "Programs your families already pair up",
    count: pairs.reduce((s, p) => s + (p.na - p.both) + (p.nb - p.both), 0),
    headline: plural(pairs.length, "pair") + " of activities share households far more often than chance",
    detail: "A household in one of these is unusually likely to be in the other. The people in one and not the other are the warmest list you have.",
    action: "Promote each of these to the other's roster. It is the same audience, already paying you, already in the building.",
    basis: "Households enrolled in both activities ÷ what you would expect if the two were unrelated (lift). Computed at ACTIVITY level on purpose: program-level pairs are dominated by the same product's own weeks, which is not a cross-promotion.",
    items: pairs.map(p => ({
      label: p.a + " ↔ " + p.b,
      sub: p.lift.toFixed(1) + "× more likely than chance · " + p.both + " households do both · " + (p.na - p.both) + " in " + p.a + " and " + (p.nb - p.both) + " in " + p.b + " have not crossed over",
      value: null, link: linkTo("users", "tab=strategy"),
    })),
    link: linkTo("users", "tab=strategy"),
  });
}

// 11. Households that have gone quiet. THE WINDOW IS DERIVED FROM THE ORG'S OWN
//     HISTORY, not a constant: an organisation eleven months into Rec has
//     nobody who last transacted 12 months ago, so a fixed year would report a
//     clean bill of health on every young org forever.
function dDormant(ctx) {
  if (!Array.isArray(ctx.feeds.users)) return null;
  const stamps = ctx.userHouseholds.map(r => Date.parse(r["First Transaction"] || "")).filter(t => !isNaN(t));
  if (stamps.length < FLOORS.households) return null;
  const historyDays = (ctx.nowMs - Math.min(...stamps)) / 86400000;
  // Never more than half the history: a window longer than that is measuring
  // the platform's age rather than the org's churn.
  const days = Math.min(365, Math.max(120, Math.floor(historyDays / 2)));
  if (historyDays < 240) return null;   // too young for "gone quiet" to mean anything
  const cutoff = ctx.nowMs - days * 86400000;
  // ONE ROW PER HOUSEHOLD — the revenue on a person row is their household's,
  // so counting people would both triple-count the money and list a family of
  // five as five separate customers to win back.
  const people = ctx.userHouseholds
    .filter(r => num(r["Net Revenue"]) > 0 && r["Last Transaction"] && Date.parse(r["Last Transaction"]) < cutoff)
    .map(r => ({ name: ((r["First Name"] || "") + " " + (r["Last Name"] || "")).trim() || "(no name)", net: num(r["Net Revenue"]), last: r["Last Transaction"], items: num(r["Items Purchased"]) }))
    .sort((a, b) => b.net - a.net);
  if (people.length < FLOORS.itemsPerFinding) return null;
  const spend = people.reduce((s, p) => s + p.net, 0);
  return finding({
    id: "dormant-households", family: "people", kind: "audience",
    title: "Customers who have gone quiet",
    count: people.length,
    headline: plural(people.length, "household") + " who have spent with you have not transacted in " + Math.round(days / 30) + " months",
    detail: "Between them they have spent " + fmtUsd(spend) + " historically. Seasonal customers will be in here — somebody who only ever does summer camp looks dormant every winter — so read it as a list to check, not a list of losses.",
    action: "Send them what they bought last time. Re-engaging someone who has already paid you once is the cheapest revenue on this page.",
    basis: "No transaction for " + days + " days, among HOUSEHOLDS with recorded spend — the community feed repeats a household's revenue on every member, so this is deduplicated to one row per household. The window is HALF your transaction history (capped at a year), so it can never be longer than the data supports.",
    items: people.map(p => ({
      label: p.name,
      sub: "last active " + String(p.last).slice(0, 10) + " · " + p.items + " items lifetime",
      value: round(p.net), link: linkTo("users", "tab=strategy"),
    })),
    link: linkTo("users", "tab=strategy"),
  });
}

// 12. People who only ever touch ONE side of the house. A household that rents
//     a pavilion every year and has never registered a child for anything is
//     the clearest cross-sell on the platform.
function dStreamCrossSell(ctx) {
  if (!Array.isArray(ctx.feeds.users)) return null;
  // Household grain: the revenue columns are the household's (see makeContext).
  const rows = ctx.userHouseholds;
  const facOnly = rows.filter(r => num(r["Facility Revenue"]) > 0 && num(r["Program Revenue"]) === 0);
  const progOnly = rows.filter(r => num(r["Program Revenue"]) > 0 && num(r["Facility Revenue"]) === 0);
  const both = rows.filter(r => num(r["Facility Revenue"]) > 0 && num(r["Program Revenue"]) > 0);
  if (facOnly.length + progOnly.length < FLOORS.households) return null;
  const items = [];
  if (facOnly.length >= FLOORS.itemsPerFinding) items.push({
    label: "Rent your facilities, never take a program",
    sub: plural(facOnly.length, "household") + " · " + fmtUsd(facOnly.reduce((s, r) => s + num(r["Facility Revenue"]), 0)) + " of rental spend between them",
    value: null, link: linkTo("users", "tab=strategy"),
  });
  if (progOnly.length >= FLOORS.itemsPerFinding) items.push({
    label: "Take programs, never rent a facility",
    sub: plural(progOnly.length, "household") + " · " + fmtUsd(progOnly.reduce((s, r) => s + num(r["Program Revenue"]), 0)) + " of program spend between them",
    value: null, link: linkTo("users", "tab=strategy"),
  });
  if (!items.length) return null;
  return finding({
    id: "stream-cross-sell", family: "people", kind: "audience",
    title: "Customers who only use half of what you offer",
    count: facOnly.length + progOnly.length,
    headline: "Only " + plural(both.length, "household") + " use both your programs and your facilities",
    detail: "Every household in these two groups has already paid you for something. They are not prospects; they are customers who have never been told about the other half.",
    action: "Put a line about programs in the rental confirmation and a line about rentals in the registration confirmation. It costs nothing.",
    basis: "Lifetime revenue by stream, per HOUSEHOLD, from Community Intel — a household with revenue on one side and exactly zero on the other.",
    items, link: linkTo("users", "tab=revenue"),
  });
}

// 13 & 14. Memberships and passes. Two separate findings from one feed, and
//     the split is the whole point: a DAY PASS expiring is the product working
//     (the season-pass lesson this repo already paid for), so only long-term
//     products count as a lapse.
const LONG_TERM_DAYS = 60;
function dPassLapse(ctx) {
  if (!Array.isArray(ctx.feeds.memberships)) return null;
  const rows = ctx.feeds.memberships;
  if (rows.length < FLOORS.memberships) return null;
  const expired = rows.filter(r => /expired/i.test(String(r.Status || "")));
  const byPlan = new Map();
  for (const r of expired) {
    const term = num(r["Plan Term Days"]);
    const seasonEnd = r["Plan Season End"];
    // A short-term product ending is not churn. Term days is the reliable
    // signal; where it is absent a season product is treated as long-term
    // (it has a declared end date) and everything else is judged by how long
    // the membership itself actually lasted.
    const startEnd = [Date.parse(r["Start Date"] || ""), Date.parse(r["End Date"] || "")];
    const lived = (!isNaN(startEnd[0]) && !isNaN(startEnd[1])) ? (startEnd[1] - startEnd[0]) / 86400000 : null;
    const longTerm = term >= LONG_TERM_DAYS || (!term && seasonEnd) || (!term && lived != null && lived >= LONG_TERM_DAYS);
    if (!longTerm) continue;
    const k = r["Group / Plan"] || r["Membership Type"] || "(unnamed plan)";
    if (!byPlan.has(k)) byPlan.set(k, { name: k, n: 0, value: 0 });
    const g = byPlan.get(k); g.n++; g.value += num(r["Net Collected"]);
  }
  // A plan that collected nothing is an application or a comp, not a lapsed
  // pass — listing "4 expired, $0" under a renewal opportunity is noise.
  const groups = [...byPlan.values()].filter(g => g.n >= FLOORS.itemsPerFinding && g.value > 0).sort((a, b) => b.value - a.value);
  if (!groups.length) return null;
  const total = groups.reduce((s, g) => s + g.value, 0);
  if (total < FLOORS.dollars) return null;
  return finding({
    id: "pass-lapse", family: "people", kind: "upside",
    title: "Season passes and memberships that lapsed without renewing",
    value: total, count: groups.reduce((s, g) => s + g.n, 0),
    headline: groups.reduce((s, g) => s + g.n, 0) + " long-term passes expired and were not renewed",
    detail: "Day passes and other short products are deliberately excluded — one of those expiring is the product working, not a customer lost.",
    action: "A renewal reminder before expiry is the single highest-return email a parks department sends. These people bought the thing once already.",
    basis: "Memberships and passes with an expired status whose term is " + LONG_TERM_DAYS + " days or longer. The dollar figure is what those passes originally collected, i.e. the size of the renewal opportunity if every one came back.",
    items: groups.map(g => ({
      label: g.name, sub: g.n + " expired · " + fmtUsd(g.value) + " originally collected",
      value: round(g.value), link: linkTo("memberships"),
    })),
    link: linkTo("memberships"),
  });
}

function dMemberNoProgram(ctx) {
  if (!Array.isArray(ctx.feeds.memberships) || !Array.isArray(ctx.feeds.users)) return null;
  const rows = ctx.feeds.memberships;
  if (rows.length < FLOORS.memberships) return null;
  const active = rows.filter(r => /active/i.test(String(r.Status || "")));
  if (active.length < FLOORS.itemsPerFinding) return null;

  /* THE JOIN IS BY EMAIL → HOUSEHOLD, AND THAT IS NOT A CONVENIENCE.
     The obvious join is the memberships feed's User ID against the enrolment
     feed's Participant ID, and MEASURED AT A REAL ORG THOSE TWO BARELY MEET —
     2 of 677 ids at Shrewsbury, where the same feeds' household ids join
     1298 of 1298. Joined that way this finding reports "100% of your members
     never enrolled" at every org forever, which is a statement about the join
     and not about the org. A membership is held by a person and an enrolment
     is often for their child, so HOUSEHOLD is the right grain anyway. */
  const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
  const emailToHousehold = new Map();
  for (const u of ctx.feeds.users) {
    const e = norm(u.Email);
    if (e && !emailToHousehold.has(e)) emailToHousehold.set(e, u["Household ID"]);
  }
  const emails = uniq(active.map(r => norm(r.Email)).filter(Boolean));
  if (!emails.length) return null;
  const resolved = emails.filter(e => emailToHousehold.has(e));
  // A join that mostly misses is a broken join, not a finding. Reporting
  // anything from it would be reporting our own plumbing back at the reader.
  if (pct(resolved.length, emails.length) < 60) return null;
  const households = uniq(resolved.map(e => emailToHousehold.get(e)).filter(Boolean));
  if (households.length < FLOORS.itemsPerFinding) return null;
  const never = households.filter(h => !ctx.enrolledHouseholds.has(h));
  const share = pct(never.length, households.length);
  if (never.length < FLOORS.itemsPerFinding || share < 25) return null;
  return finding({
    id: "member-no-program", family: "people", kind: "audience",
    title: "Members who have never taken a program",
    count: never.length,
    headline: never.length + " of the " + households.length + " households holding an active membership or pass (" + round(share) + "%) have never enrolled in a program",
    detail: "They already pay you and are already in your buildings. A pass that never becomes a registration is a relationship stopping one step short.",
    action: "Offer them a member rate on a program. This is the shortest path there is from a pass holder to a participant.",
    basis: "Active memberships and passes matched to community records by email, then to enrolments by household — " + round(pct(resolved.length, emails.length)) + "% of member emails resolved. Household grain on purpose: a parent holds the pass and the child takes the class.",
    items: [{
      label: never.length + " member households with no enrolment",
      sub: "of " + households.length + " households holding an active membership or pass",
      value: null, link: linkTo("memberships"),
    }],
    link: linkTo("memberships"),
  });
}

// ══ FACILITIES ═══════════════════════════════════════════════════════════
//
// The hour rules are the Director's Report's and the Facilities hub's,
// deliberately the same: card 17294 prints Begin on a booking's FIRST day and
// End on its LAST, so a multi-day booking has no per-day hours and is excluded
// from every hour figure rather than divided into a guess.
const CLOCK_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i;
function clockHour(v) {
  const m = CLOCK_RE.exec(String(v == null ? "" : v).trim());
  if (!m) return null;
  return (parseInt(m[1], 10) % 12) + (/pm/i.test(m[3]) ? 12 : 0);
}
const isMultiDay = (r) => num(r["Multi-Day Days"]) > 1;
const siteKey = (r) => String(r.Location || "?") + " — " + String(r.Facility || "?");

// 15. Bookings taken at no charge on a site type that DOES bill elsewhere.
//     The comparison is the whole finding: an org that never charges for
//     fields has a policy, and an org that charges some field bookings and not
//     others has a gap. We report the gap and refuse to call it lost revenue.
function dUnchargedBookings(ctx) {
  const byType = new Map();
  for (const r of ctx.facRows) {
    const t = String(r["Site Type"] || "other");
    if (!byType.has(t)) byType.set(t, { type: t, n: 0, free: 0, paidRates: [], rev: 0 });
    const g = byType.get(t);
    g.n++;
    const tot = num(r.Total);
    if (tot <= 0) g.free++; else { g.paidRates.push(tot); g.rev += tot; }
  }
  const items = [];
  let ceiling = 0;
  for (const g of byType.values()) {
    if (g.n < FLOORS.itemsPerFinding * 2) continue;
    const freeShare = pct(g.free, g.n);
    // Needs BOTH: a meaningful share booked free, and proof the org charges
    // for this same site type sometimes. Without the second half this is just
    // a description of a free amenity.
    if (freeShare == null || freeShare < 30 || g.paidRates.length < FLOORS.itemsPerFinding) continue;
    const rate = med(g.paidRates);
    items.push({
      label: prettyType(g.type),
      sub: g.free + " of " + g.n + " bookings taken at $0 (" + round(freeShare) + "%), while the other " + g.paidRates.length + " averaged a " + fmtUsd(rate) + " median rate",
      value: round(g.free * rate),
      link: linkTo("facility", "site_types=" + encodeURIComponent(g.type)),
    });
    ceiling += g.free * rate;
  }
  if (!items.length || ceiling < FLOORS.dollars) return null;
  items.sort((a, b) => b.value - a.value);
  return finding({
    id: "uncharged-bookings", family: "facilities", kind: "attention",
    title: "Bookings taken at no charge on sites you charge for elsewhere",
    value: round(ceiling), count: items.length,
    headline: "Some site types are booked free far more often than they are billed",
    detail: "This is most likely deliberate — youth leagues, town events, in-kind use. It is worth reading anyway, because the same site type is being billed sometimes and not others, and nothing on the booking says which rule applied.",
    action: "Confirm the free bookings are the policy you meant. If they are, the number above is the value of what you donate to the community — which is worth knowing at budget time.",
    basis: "$0 bookings × the MEDIAN rate the same site type charged when it did bill. A ceiling, and almost certainly not collectable in full — treat it as the size of the question, not as lost revenue.",
    items, link: linkTo("facility"),
  });
}

// 16. Billed and not collected. Unlike everything else on this page this is
//     not a projection: the invoice exists.
function dFacilityAR(ctx) {
  const rows = ctx.summaryRows.filter(r => !/cancel/i.test(String(r.Status || "")));
  const billed = rows.reduce((s, r) => s + num(r.Billed), 0);
  const collected = rows.reduce((s, r) => s + num(r.Collected), 0);
  const gap = billed - collected;
  if (!(billed > 0) || gap < FLOORS.dollars) return null;
  const byRental = new Map();
  for (const r of rows) {
    const owed = num(r.Billed) - num(r.Collected);
    if (owed <= 0) continue;
    const k = r["Rental ID"] || r["Reservation ID"];
    if (!k) continue;
    if (!byRental.has(k)) byRental.set(k, { label: siteKey(r), owed: 0, n: 0, first: r.Date, last: r.Date });
    const g = byRental.get(k);
    g.owed += owed; g.n++;
    if (String(r.Date) < String(g.first)) g.first = r.Date;
    if (String(r.Date) > String(g.last)) g.last = r.Date;
  }
  const groups = [...byRental.values()].sort((a, b) => b.owed - a.owed);
  const aged = groups.filter(g => ctx.nowMs - Date.parse(g.last) > 30 * 86400000);
  return finding({
    id: "facility-ar", family: "money", kind: "uncollected",
    title: "Facility rentals billed and not paid",
    value: gap, count: groups.length,
    headline: fmtUsd(gap) + " of " + fmtUsd(billed) + " billed is still outstanding (" + round(pct(gap, billed)) + "%)",
    detail: aged.length
      ? aged.length + " of these rentals finished more than 30 days ago, so the normal process has already had its chance at them."
      : "All of it is recent, so most is probably still moving through the normal process.",
    action: "Work the aged end of this list first. Facility invoices age badly — across the platform the median unpaid rental balance is five months old.",
    basis: "Billed minus Collected per rental from the Facilities summary, excluding cancelled reservations. This is money already invoiced, not a projection.",
    items: groups.map(g => ({
      // The site alone is ambiguous — one site can hold several unpaid
      // rentals, and two identical labels in a list of money owed is unusable.
      label: g.label + (g.first !== g.last ? " · " + String(g.first).slice(0, 10) + " → " + String(g.last).slice(0, 10) : " · " + String(g.last).slice(0, 10)),
      sub: plural(g.n, "date") + " billed on this rental",
      value: round(g.owed), link: linkTo("facilities", "tab=summary"),
    })),
    link: linkTo("facilities", "tab=summary"),
  });
}

// 17. Which sites lose their bookings. A cancelled rental is a slot that went
//     unsold AND a customer who did not get what they wanted.
function dFacilityCancellations(ctx) {
  const bySite = new Map();
  for (const r of ctx.summaryRows) {
    const k = siteKey(r);
    if (!bySite.has(k)) bySite.set(k, { label: k, n: 0, canceled: 0, type: r["Site Type"] });
    const g = bySite.get(k); g.n++;
    if (/cancel/i.test(String(r.Status || ""))) g.canceled++;
  }
  const all = [...bySite.values()];
  const totalN = all.reduce((s, g) => s + g.n, 0);
  const totalC = all.reduce((s, g) => s + g.canceled, 0);
  const orgRate = pct(totalC, totalN);
  if (orgRate == null || totalC < FLOORS.itemsPerFinding) return null;
  const groups = all
    .filter(g => g.n >= FLOORS.zipHouseholds && g.canceled > 0)
    .map(g => ({ ...g, rate: pct(g.canceled, g.n) }))
    .filter(g => g.rate > Math.max(orgRate * 1.5, 10))
    .sort((a, b) => b.rate - a.rate);
  if (!groups.length) return null;
  return finding({
    id: "facility-cancellations", family: "facilities", kind: "attention",
    title: "Sites that lose bookings after they are made",
    count: groups.reduce((s, g) => s + g.canceled, 0),
    headline: plural(groups.length, "site") + (groups.length === 1 ? " cancels" : " cancel") + " well above your " + round(orgRate) + "% average",
    detail: "A cancellation is a slot that was wanted, held, and then released — usually too late to resell.",
    action: "Check the obvious causes first: weather exposure, a site double-listed under two names, or a booking flow that lets people hold a date they were never going to use.",
    basis: "Cancelled reservations ÷ all reservations per site, against your own organisation-wide rate. Sites with fewer than " + FLOORS.zipHouseholds + " bookings are excluded — a site that was booked twice and cancelled once is not a 50% cancellation rate.",
    items: groups.map(g => ({
      label: g.label,
      sub: g.canceled + " of " + g.n + " cancelled (" + round(g.rate) + "% vs " + round(orgRate) + "% overall)",
      value: null, link: linkTo("facilities", "tab=summary"),
    })),
    link: linkTo("facilities", "tab=summary"),
  });
}

// 18. When the buildings are empty. DELIBERATELY NOT A UTILISATION PERCENTAGE:
//     outside courts there is no published open-hours denominator, and a
//     percentage without one is invented. Concentration is measurable and says
//     the same thing for pricing purposes.
function dQuietHours(ctx) {
  const timed = ctx.facRows.filter(r => !isMultiDay(r) && clockHour(r.Begin) != null);
  if (timed.length < FLOORS.facility * 2) return null;
  const byHour = new Map();
  for (const r of timed) {
    const h = clockHour(r.Begin);
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  // The working day, which is the part an org can actually reprice. A 6am or
  // 11pm hole is not an opportunity, it is the middle of the night.
  const DAY = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  /* AND ONLY INSIDE THIS ORG'S OWN OPERATING ENVELOPE. An hour with zero
     bookings may simply be an hour the site is shut, and NOTHING in the
     booking data can tell a closed hour from an open empty one. An hour that
     sits BETWEEN two hours this org demonstrably books is one it is open for,
     so that is the only kind reported. Without this the finding leads with
     7pm and 8pm at an org that closes at six. */
  const booked = DAY.filter(h => (byHour.get(h) || 0) > 0);
  if (booked.length < 4) return null;
  const open = { lo: Math.min(...booked), hi: Math.max(...booked) };
  const counts = DAY.filter(h => h >= open.lo && h <= open.hi).map(h => ({ h, n: byHour.get(h) || 0 }));
  const peak = Math.max(...counts.map(c => c.n));
  if (peak < 10) return null;
  const quiet = counts.filter(c => c.n <= peak * 0.2);
  if (quiet.length < FLOORS.itemsPerFinding) return null;
  const busiest = counts.filter(c => c.n >= peak * 0.6).map(c => hourLabel(c.h));
  return finding({
    id: "quiet-hours", family: "facilities", kind: "attention",
    title: "Hours nobody books",
    count: quiet.reduce((s, c) => s + c.n, 0),
    headline: "Your bookings pile into " + busiest.join(", ") + " and thin out for " + plural(quiet.length, "hour") + " in the middle of your own day",
    detail: "Peak hour carries " + peak + " bookings. Each hour below takes a fraction of that, on sites that are open either side of it and staffed anyway.",
    action: "This is the off-peak rate conversation: a lower midday price for the same field costs you nothing when the alternative is an empty field, and it is the one lever that moves demand rather than chasing it.",
    basis: "Start hour of every single-day booking in the window, counted only between " + hourLabel(open.lo) + " and " + hourLabel(open.hi) + " — the hours this organisation demonstrably books, so a quiet hour here cannot be a closed one. NOT a utilisation percentage: outside courts nothing publishes open hours, and a percentage without a denominator would be invented.",
    items: quiet.sort((a, b) => a.n - b.n).map(c => ({
      label: hourLabel(c.h),
      sub: plural(c.n, "booking") + " started in this hour across the whole window · peak hour has " + peak,
      value: null, link: linkTo("facility"),
    })),
    link: linkTo("facility"),
  });
}

// 19. How much of the booking work your staff are doing by hand.
function dStaffBooked(ctx) {
  const rows = ctx.facRows;
  const instant = rows.filter(r => /instant/i.test(String(r["Booking Type"] || ""))).length;
  const managed = rows.length - instant;
  const share = pct(instant, rows.length);
  if (share == null || share >= 25 || managed < FLOORS.facility) return null;
  return finding({
    id: "staff-booked", family: "facilities", kind: "attention",
    title: "Almost every rental goes through a member of staff",
    count: managed,
    headline: share === 0
      ? "All " + managed + " rentals in this window were booked by staff — none were self-service"
      : round(share) + "% of rentals were self-service; the other " + managed + " went through staff",
    detail: "Managed booking is the right answer for a tournament or a complicated permit. It is an expensive way to sell an hour on a pavilion.",
    action: "Pick the one or two site types with the simplest rules and make them instant-bookable. Every one that moves is desk time back.",
    basis: "The Booking Type column on each reservation. Note this counts reservations, not staff hours — a recurring rental is one conversation and many rows.",
    items: instantCandidates(ctx).map(c => ({
      label: prettyType(c.type),
      sub: c.n + " staff-booked reservations across " + c.sites + " sites, median " + fmtUsd(c.rate) + " · simple, repeatable, and a candidate for self-service",
      value: null, link: linkTo("facility", "site_types=" + encodeURIComponent(c.type)),
    })),
    link: linkTo("facility"),
  });
}

function instantCandidates(ctx) {
  const byType = new Map();
  for (const r of ctx.facRows) {
    if (/instant/i.test(String(r["Booking Type"] || ""))) continue;
    const t = String(r["Site Type"] || "other");
    if (!byType.has(t)) byType.set(t, { type: t, n: 0, sites: new Set(), rates: [] });
    const g = byType.get(t);
    g.n++; g.sites.add(siteKey(r));
    if (num(r.Total) > 0) g.rates.push(num(r.Total));
  }
  return [...byType.values()]
    .filter(g => g.n >= FLOORS.itemsPerFinding * 2)
    .map(g => ({ type: g.type, n: g.n, sites: g.sites.size, rate: med(g.rates) || 0 }))
    .sort((a, b) => b.n - a.n).slice(0, 5);
}

// 20. Sites nobody books. Inventory that costs to maintain and earns nothing.
function dIdleSites(ctx) {
  const bySite = new Map();
  for (const r of ctx.facRows) {
    const k = siteKey(r);
    if (!bySite.has(k)) bySite.set(k, { label: k, n: 0, rev: 0, type: r["Site Type"] });
    const g = bySite.get(k); g.n++; g.rev += num(r.Total);
  }
  const all = [...bySite.values()];
  if (all.length < 8) return null;
  /* MEASURED AGAINST THE BUSIEST SITE, NOT THE MEDIAN ONE — and that is a
     correction, not a preference. Bookings per site are wildly skewed (at
     Shrewsbury a handful of sites carry most of 504 reservations and the
     MEDIAN site took one), so a median-based threshold produced the sentence
     "28 sites took 2 bookings or fewer; your median site took 1", which is
     incoherent on its face. The busiest site is a stable reference. */
  const busiest = Math.max(...all.map(s => s.n));
  if (busiest < 20) return null;              // nothing here is busy enough to be a yardstick
  const bar = Math.max(2, Math.round(busiest * 0.05));
  const idle = all.filter(s => s.n <= bar).sort((a, b) => a.n - b.n || a.rev - b.rev);
  if (idle.length < FLOORS.itemsPerFinding) return null;
  // If nearly everything is "idle" the yardstick is describing the shape of
  // the org rather than finding anything — a handful of busy sites and a long
  // tail is normal, every site being in the tail is not a finding.
  if (pct(idle.length, all.length) > 80) return null;
  return finding({
    id: "idle-sites", family: "facilities", kind: "attention",
    title: "Bookable sites that almost nobody uses",
    count: idle.length,
    headline: idle.length + " of your " + all.length + " bookable sites took " + plural(bar, "booking") + " or fewer all window",
    detail: "Your busiest site took " + busiest + ". These sit at the far end of the same list, earning " + fmtUsd(idle.reduce((s, x) => s + x.rev, 0)) + " between them.",
    action: "Open the public booking page and look for them. More often than not a site this quiet is one nobody can find, not one nobody wants.",
    basis: "Reservations per site against your busiest site in this window. A site that is listed but was never booked at all does not appear in the feed, so the real quiet list may be longer than this.",
    items: idle.map(s => ({
      label: s.label,
      sub: plural(s.n, "booking") + " · " + fmtUsd(s.rev) + " earned · your busiest site took " + busiest,
      value: null, link: linkTo("facility"),
    })),
    link: linkTo("facility"),
  });
}

// ══ COURTS ═══════════════════════════════════════════════════════════════
// Gated hard on court volume — see familyGate("courts"). An org with fourteen
// court bookings gets none of this.
function dCourtQuiet(ctx) {
  const rows = ctx.courtRows;
  const byCourt = new Map();
  for (const r of rows) {
    const k = (r.location_name || "?") + " — " + (r.court_name || "?");
    if (!byCourt.has(k)) byCourt.set(k, { label: k, n: 0, hours: 0 });
    const g = byCourt.get(k); g.n++; g.hours += num(r.duration_hours);
  }
  const all = [...byCourt.values()];
  if (all.length < 4) return null;
  const medHours = med(all.map(c => c.hours)) || 1;
  const quiet = all.filter(c => c.hours <= medHours * 0.4).sort((a, b) => a.hours - b.hours);
  if (quiet.length < FLOORS.itemsPerFinding) return null;
  return finding({
    id: "court-quiet", family: "courts", kind: "attention",
    title: "Courts taking a fraction of what the others take",
    count: quiet.length,
    headline: quiet.length + " of " + all.length + " courts booked under half the hours of your median court",
    detail: "Your median court took " + round(medHours) + " hours in this window. These took far less, on the same surface, usually at the same price.",
    action: "Compare them against the busy ones for lighting, parking, surface and listing order. If they are genuinely equivalent, an off-peak rate is the cheapest way to move play onto them.",
    basis: "Booked hours per court from the Court Utilization feed, against this org's own median court. Hours booked, not utilisation — the Courts report divides by each court's published open hours if you want the percentage.",
    items: quiet.map(c => ({
      label: c.label, sub: round(c.hours) + " hours across " + c.n + " bookings · median court took " + round(medHours),
      value: null, link: linkTo("facilities", "tab=racket"),
    })),
    link: linkTo("facilities", "tab=racket"),
  });
}

// ══ Formatting helpers ═══════════════════════════════════════════════════
function fmtUsd(v) { return "$" + Math.round(v || 0).toLocaleString("en-US"); }
const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));
function hourLabel(h) {
  const ampm = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ampm;
}
const TYPE_LABEL = {
  "outdoor-event-space": "Pavilions & event spaces",
  "picnic-table": "Picnic areas",
  "bounce-house": "Bounce houses",
  field: "Athletic fields",
  court: "Courts",
  room: "Rooms",
  pool: "Pool lanes",
  campsite: "Campsites",
  other: "Other sites",
};
function prettyType(t) { return TYPE_LABEL[t] || (String(t || "other").charAt(0).toUpperCase() + String(t || "other").slice(1)); }

// ══ The registry ═════════════════════════════════════════════════════════
const FAMILIES = [
  { key: "programs",   label: "Programs",   emoji: "\u{1F3AF}", blurb: "Fill, demand and cancellations across everything you ran" },
  { key: "people",     label: "Your community", emoji: "\u{1F465}", blurb: "Who is reachable, who is under-served, and who has gone quiet" },
  { key: "facilities", label: "Facilities", emoji: "\u{1F3DE}️", blurb: "How your sites and hours are actually being used" },
  { key: "courts",     label: "Courts",     emoji: "\u{1F3BE}", blurb: "Court-by-court demand" },
  { key: "money",      label: "Money owed", emoji: "\u{1F4B5}", blurb: "Billed and not yet collected" },
];

const DETECTORS = [
  { family: "programs",   fn: dUnderfilled },
  { family: "programs",   fn: dUnmetDemand },
  { family: "programs",   fn: dFastTrackOver },
  { family: "programs",   fn: dCapacityMismatch },
  { family: "programs",   fn: dCanceledSections },
  { family: "programs",   fn: dRefundOutliers },
  { family: "programs",   fn: dPlanArrears },
  { family: "people",     fn: dAgeGap },
  { family: "people",     fn: dZipGap },
  { family: "people",     fn: dCrossPromo },
  { family: "people",     fn: dDormant },
  { family: "people",     fn: dStreamCrossSell },
  { family: "people",     fn: dPassLapse },
  { family: "people",     fn: dMemberNoProgram },
  { family: "facilities", fn: dUnchargedBookings },
  { family: "facilities", fn: dFacilityCancellations },
  { family: "facilities", fn: dQuietHours },
  { family: "facilities", fn: dStaffBooked },
  { family: "facilities", fn: dIdleSites },
  { family: "courts",     fn: dCourtQuiet },
  { family: "money",      fn: dFacilityAR },
];

// ══ Context ══════════════════════════════════════════════════════════════
function makeContext(feeds, opts) {
  const f = {
    programs: feeds.programs || null,
    waitlist: feeds.waitlist || null,
    fasttrack: feeds.fasttrack || null,
    facility: feeds.facility || null,
    facilitiesSummary: feeds.facilitiesSummary || null,
    demographics: feeds.demographics || null,
    users: feeds.users || null,
    memberships: feeds.memberships || null,
    courts: feeds.courts || null,
  };
  const progRows = Array.isArray(f.programs) ? f.programs : [];
  const isCanceled = (r) => /cancell?ed/i.test(String(r.section_status || ""));
  const ranSections = progRows.filter(r => /past|in ?progress/i.test(String(r.section_status || "")));
  const programMedianPrice = new Map();
  {
    const byProg = new Map();
    for (const r of progRows) {
      const p = perHead(r);
      if (p == null || !(p > 0)) continue;
      const k = r.program || "(unnamed program)";
      if (!byProg.has(k)) byProg.set(k, []);
      byProg.get(k).push(p);
    }
    for (const [k, xs] of byProg) programMedianPrice.set(k, med(xs));
  }
  const enrolRows = Array.isArray(f.demographics) ? f.demographics : [];
  const enrolledHouseholds = new Set(enrolRows.map(r => r["Household ID"]).filter(Boolean));
  const enrolledParticipants = new Set(enrolRows.map(r => r["Participant ID"]).filter(Boolean));
  /* THE COMMUNITY FEED IS PERSON-GRAIN AND ITS MONEY IS HOUSEHOLD-LEVEL.
     Gross/Net/Program/Facility/Product Revenue and Items Purchased are the
     HOUSEHOLD's totals, repeated verbatim on every member row — measured at
     Shrewsbury, 1012 of 1012 multi-person households carry identical values
     across all their members. So any per-person sum multiplies the money by
     household size: the first build of this file reported $886,348 of program
     spend at an org whose whole program net is $278,819.
     Age is the opposite — it belongs to the person. Hence two views. */
  const userRows = Array.isArray(f.users) ? f.users : [];
  const userHouseholds = [];
  {
    const seen = new Map();
    for (const r of userRows) {
      const h = r["Household ID"];
      if (!h) { userHouseholds.push(r); continue; }   // no household id: its own row
      const prev = seen.get(h);
      // Prefer the head of household, so the name on a row is the one to contact.
      if (!prev) { seen.set(h, r); userHouseholds.push(r); }
      else if (/head/i.test(String(r.Role || "")) && !/head/i.test(String(prev.Role || ""))) {
        userHouseholds[userHouseholds.indexOf(prev)] = r;
        seen.set(h, r);
      }
    }
  }
  // People in a band whose HOUSEHOLD has never enrolled — the reachable half
  // of an age gap. Household rather than person, because the community feed
  // and the enrolment feed share a household id and not a person id.
  const enrolledByBand = new Map();
  if (userRows.length) {
    for (const r of userRows) {
      const b = ageBand(r.Age);
      if (!b) continue;
      if (enrolledHouseholds.has(r["Household ID"])) continue;
      enrolledByBand.set(b.key, (enrolledByBand.get(b.key) || 0) + 1);
    }
  }
  const facRows = Array.isArray(f.facility) ? f.facility : [];
  const summaryRows = Array.isArray(f.facilitiesSummary) ? f.facilitiesSummary : [];
  // Court volume is read from the COURT feed when there is one and from the
  // facility feed's own site type when there is not, so the gate still works
  // for an org whose court card is unavailable but whose rentals say plainly
  // that it has no courts.
  const courtRows = Array.isArray(f.courts) ? f.courts
    : facRows.filter(r => String(r["Site Type"] || "") === "court");
  return {
    feeds: f, nowMs: (opts && opts.now ? +new Date(opts.now) : Date.now()),
    progRows, ranSections, isCanceled, programMedianPrice, userRows, userHouseholds,
    enrolRows, enrolledHouseholds, enrolledParticipants, enrolledByBand,
    facRows, summaryRows, courtRows,
  };
}

/**
 * Build the payload. `feeds` values are ARRAYS of rows, or `null` for a feed
 * that could not be loaded — and the difference is carried all the way to the
 * page (rule 1 at the top of this file).
 */
function buildOpportunities(feeds, opts) {
  const o = opts || {};
  const ctx = makeContext(feeds, o);
  const families = [];
  for (const fam of FAMILIES) {
    const gate = familyGate(fam.key, ctx);
    if (gate) {
      families.push({ ...fam, state: gate.state, reason: gate.reason, findings: [] });
      continue;
    }
    const findings = [];
    for (const d of DETECTORS) {
      if (d.family !== fam.key) continue;
      let out = null;
      try { out = d.fn(ctx); }
      catch (e) {
        // One broken detector must not take the report down. It reports itself
        // rather than vanishing — a silently missing finding is indistinguishable
        // from an org with nothing to fix.
        findings.push(finding({
          id: "error-" + (d.fn.name || "detector"), family: fam.key, kind: "attention",
          title: "One check could not run", headline: "An analysis failed while building this report",
          detail: String(e && e.message || e).slice(0, 200), items: [],
        }));
      }
      if (out) findings.push(out);
    }
    findings.sort(rank);
    families.push({ ...fam, state: findings.length ? "ok" : "clear", reason: "", findings });
  }
  const all = families.flatMap(f => f.findings);
  const sum = (kind) => all.filter(f => f.kind === kind && f.value != null).reduce((s, f) => s + f.value, 0);
  return {
    generatedAt: new Date(ctx.nowMs).toISOString(),
    windowDays: o.windowDays || null,
    window: o.window || null,
    totals: {
      findings: all.length,
      // DELIBERATELY FOUR NUMBERS AND NOT ONE. See rule 3 — an empty seat, an
      // unpaid invoice and a mailing list do not add up to anything.
      upside: sum("upside"),
      atRisk: sum("at-risk"),
      uncollected: sum("uncollected"),
      audience: all.filter(f => f.kind === "audience").reduce((s, f) => s + (f.count || 0), 0),
    },
    families,
    coverage: Object.entries(ctx.feeds).map(([k, v]) => ({
      feed: k, state: v === null ? "unavailable" : "ok", rows: Array.isArray(v) ? v.length : null,
    })),
  };
}

// Dollars first and biggest first, then the lists. Within a kind, a finding
// with no dollar value sorts by how many rows it names.
const KIND_ORDER = { uncollected: 0, "at-risk": 1, upside: 2, attention: 3, audience: 4 };
function rank(a, b) {
  if (a.value != null && b.value != null && a.value !== b.value) return b.value - a.value;
  if ((a.value != null) !== (b.value != null)) return a.value != null ? -1 : 1;
  const ka = KIND_ORDER[a.kind] ?? 9, kb = KIND_ORDER[b.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  return (b.count || 0) - (a.count || 0);
}

module.exports = {
  buildOpportunities, makeContext, familyGate,
  FLOORS, FAMILIES, DETECTORS, KINDS, AGE_BANDS,
  ageBand, perHead, clockHour, prettyType, hourLabel, fmtUsd, rank,
  UNDERFILL_PCT, FULL_PCT, MIN_CAPACITY, LONG_TERM_DAYS,
  // exported for the spec — each detector is run directly over fixtures
  detectors: {
    dUnderfilled, dCapacityMismatch, dUnmetDemand, dFastTrackOver, dCanceledSections,
    dRefundOutliers, dPlanArrears, dAgeGap, dZipGap, dCrossPromo, dDormant,
    dStreamCrossSell, dPassLapse, dMemberNoProgram, dUnchargedBookings, dFacilityAR,
    dFacilityCancellations, dQuietHours, dStaffBooked, dIdleSites, dCourtQuiet,
  },
};
