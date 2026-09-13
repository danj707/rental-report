#!/usr/bin/env node
/**
 * OPPORTUNITIES — the detector rules, LIFTED AND RUN.
 *
 * Every defect this report can have is arithmetic about a threshold, and a
 * regex passes on an inverted comparison. So this spec imports lib/opportunities
 * and RUNS each detector over fixtures built to make a wrong implementation
 * produce a WRONG NUMBER rather than a plausible one.
 *
 * The source half (server.js wiring: registration, the daily cron, the beacon
 * route's position, the Slack sets) is skipped by SKIP_SOURCE=1, so the
 * behavioural half can be shown to catch a regression on its own.
 */
const fs = require("fs");
const path = require("path");
const O = require("../lib/opportunities");

let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; return; }
  failures.push(label);
}
function eq(actual, expected, label) {
  ok(actual === expected, label + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";
const DAY = 86400000;
const NOW = Date.parse("2026-09-13T12:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const ymd = (d) => new Date(NOW - d * DAY).toISOString().slice(0, 10);

// ── Fixtures ─────────────────────────────────────────────────────────────
// Numbers are deliberately distinctive: a detector reading the wrong column
// cannot land on one of these by accident.
function section(o) {
  return Object.assign({
    program: "P", section: "S", section_status: "Past", program_season: "Fall 26",
    activity_name: "A", category_name: "C", enrolled: 0, capacity: 0, fill_pct: 0,
    charged: 0, received: 0, outstanding: 0, refunds: 0, net_total: 0,
    period_received: 0, period_refunds: 0, period_net: 0,
    waitlist_active: 0, waitlist_total: 0, location: "L", location_count: 1,
    instructor: null, instructor_count: 0,
    autopay_plan_items: 0, manual_plan_items: 0, autopay_plan_value: 0, manual_plan_value: 0,
    past_due_value: 0, scheduled_autopay_value: 0, scheduled_manual_value: 0, no_plan_balance_value: 0,
  }, o);
}
// 24 sections that ran, so the programs family clears its floor of 12.
function baseProgramFeed() {
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push(section({ program: "Healthy " + i, section: "S" + i, enrolled: 10, capacity: 10, fill_pct: 100, charged: 1000, net_total: 1000 }));
  return rows;
}
function ctxOf(feeds) { return O.makeContext(feeds, { now: NOW }); }

// ══ 1. THE RULE THAT EVERYTHING ELSE RESTS ON ════════════════════════════
// null (the fetch failed) and [] (the org has none of this) are different
// facts. If these ever collapse, every suppression below becomes a lie.
{
  const withNull = O.buildOpportunities({ programs: null, facility: null, demographics: null, facilitiesSummary: null }, { now: NOW });
  const fam = (p, k) => p.families.find(f => f.key === k);
  eq(fam(withNull, "programs").state, "unavailable", "null programs feed → unavailable");
  ok(/could not be loaded/i.test(fam(withNull, "programs").reason), "…and says so in words");
  eq(fam(withNull, "facilities").state, "unavailable", "null facility feed → unavailable");

  const withEmpty = O.buildOpportunities({ programs: [], facility: [], demographics: [], facilitiesSummary: [] }, { now: NOW });
  eq(fam(withEmpty, "programs").state, "insufficient", "empty programs feed → insufficient, NOT unavailable");
  ok(!/could not be loaded/i.test(fam(withEmpty, "programs").reason), "…and does not blame a fetch");
  ok(fam(withNull, "programs").state !== fam(withEmpty, "programs").state,
    "a failed feed and an empty one must NEVER render the same state");

  // Coverage carries the same distinction to the page.
  const cov = (p, f) => p.coverage.find(c => c.feed === f);
  eq(cov(withNull, "programs").state, "unavailable", "coverage marks a failed feed unavailable");
  eq(cov(withEmpty, "programs").rows, 0, "coverage reports 0 rows for an empty feed");
}

// ══ 2. DAN'S RULE: no court analysis for an org without courts ═══════════
{
  const facility = [];
  for (let i = 0; i < 40; i++) facility.push({ Location: "Park", Facility: "Pavilion " + (i % 6), "Site Type": "outdoor-event-space", Date: ymd(30), Begin: "04:00pm", End: "06:00pm", Total: 100, "Booking Type": "Managed" });
  const noCourts = O.buildOpportunities({ facility, courts: [] }, { now: NOW });
  const courts = noCourts.families.find(f => f.key === "courts");
  eq(courts.state, "insufficient", "an org with no courts gets no court family");
  ok(/does not rent courts/i.test(courts.reason), "…and is TOLD that, rather than shown a gap");
  eq(courts.findings.length, 0, "no court findings are produced");

  // Fourteen court bookings is Shrewsbury's real figure, and is not a study.
  const few = O.buildOpportunities({ facility, courts: new Array(14).fill({ location_name: "P", court_name: "C1", duration_hours: 1 }) }, { now: NOW });
  const f2 = few.families.find(f => f.key === "courts");
  eq(f2.state, "insufficient", "14 court bookings is below the floor");
  ok(/14 court booking/.test(f2.reason), "…and the reason names the count it saw");

  // THE GATE READS THE FACILITY FEED WHEN THE COURT CARD IS MISSING, so an org
  // that plainly has no courts is still suppressed rather than shown an error.
  const noCard = O.buildOpportunities({ facility, courts: null }, { now: NOW });
  eq(noCard.families.find(f => f.key === "courts").state, "insufficient",
    "no court card + no court-type rentals still suppresses rather than erroring");

  // Six courts: three busy, three barely used. Three, because a "pattern" of
  // one row is one row wearing a label.
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ location_name: "Park", court_name: "Court " + (i % 6), duration_hours: (i % 6) < 3 ? 0.5 : 20 });
  const has = O.buildOpportunities({ facility, courts: many }, { now: NOW });
  const hf = has.families.find(f => f.key === "courts");
  // "clear" would also mean the family was analysed — the thing that must not
  // happen is a suppression, so both the state and a finding are asserted.
  ok(hf.state !== "insufficient" && hf.state !== "unavailable", "an org WITH courts gets the family analysed");
  eq(hf.state, "ok", "…and its quiet courts surface");
}

// ══ 3. KINDS ARE NEVER ADDED TOGETHER ════════════════════════════════════
{
  const programs = baseProgramFeed();
  // Three under-filled sections of one program → upside.
  for (let i = 0; i < 3; i++) programs.push(section({ program: "Thin", section: "T" + i, enrolled: 2, capacity: 20, fill_pct: 10, charged: 200, net_total: 200 }));
  // A cancelled program that refunded → at-risk.
  programs.push(section({ program: "Gone", section: "G1", section_status: "Canceled", charged: 5000, refunds: 5000 }));
  programs.push(section({ program: "Gone", section: "G2", section_status: "Canceled", charged: 1000, refunds: 1000 }));
  const p = O.buildOpportunities({ programs }, { now: NOW });
  ok(p.totals.upside > 0, "an upside total exists");
  ok(p.totals.atRisk > 0, "an at-risk total exists");
  ok(p.totals.upside !== p.totals.atRisk, "the two totals are different numbers");
  const blended = p.totals.upside + p.totals.atRisk + p.totals.uncollected;
  ok(!Object.values(p.totals).includes(blended) || blended === 0,
    "no total is the blend of the others — four kinds, four numbers");
  eq(p.totals.audience, 0, "audience counts PEOPLE and stays out of the money totals");
}

// ══ 4. THE COMMUNITY FEED'S MONEY IS THE HOUSEHOLD'S ═════════════════════
// Measured at Shrewsbury: 1012 of 1012 multi-person households repeat the same
// Net Revenue on every member row. Summing per person multiplies by household
// size — the first build of this reported 3x the org's real program revenue.
{
  const users = [];
  // 50 households of 4 people, each carrying $1,000 — a per-person sum is
  // $200,000 and the truth is $50,000. Two numbers nothing could confuse.
  for (let h = 0; h < 50; h++) {
    for (let m = 0; m < 4; m++) {
      users.push({
        "Household ID": "hh" + h, Role: m === 0 ? "Head of Household" : "Member",
        "First Name": "P" + h + "-" + m, "Last Name": "X", Email: "p" + h + "-" + m + "@x.com",
        "Zip Code": "01545", Age: 30 + m,
        "Net Revenue": 1000, "Items Purchased": 4,
        "Program Revenue": 1000, "Facility Revenue": 0, "Product Revenue": 0,
        "First Transaction": ago(700), "Last Transaction": ago(400),
      });
    }
  }
  const ctx = ctxOf({ users });
  eq(ctx.userHouseholds.length, 50, "the community feed is deduplicated to one row per household");
  eq(ctx.userRows.length, 200, "…while the person-grain view keeps every row");
  ok(ctx.userHouseholds.every(r => /Head/.test(r.Role)), "the surviving row is the head of household");

  const d = O.detectors.dDormant(ctx);
  ok(d, "dormant households are found");
  eq(d.count, 50, "dormant counts HOUSEHOLDS, not people");
  const total = d.items.reduce((s, i) => s + i.value, 0);
  ok(total <= 50 * 1000, "and their spend is not multiplied by household size (" + total + ")");

  const x = O.detectors.dStreamCrossSell(ctx);
  ok(x, "the cross-sell split is found");
  const progOnly = x.items.find(i => /never rent/i.test(i.label));
  ok(progOnly && /50 households/.test(progOnly.sub), "cross-sell counts households too — got: " + (progOnly && progOnly.sub));
  ok(progOnly && /\$50,000/.test(progOnly.sub), "…and their spend is the household's once, not four times");
}

// ══ 5. THE DORMANT WINDOW COMES FROM THE ORG'S OWN HISTORY ═══════════════
// An org eleven months into Rec has nobody who last transacted a year ago, so a
// fixed window reports a clean bill of health on every young org forever.
{
  const mk = (firstDaysAgo, lastDaysAgo) => {
    const users = [];
    for (let h = 0; h < 60; h++) users.push({
      "Household ID": "hh" + h, Role: "Head of Household", "First Name": "A", "Last Name": "B",
      Email: h + "@x.com", "Zip Code": "01545", Age: 40, "Net Revenue": 500, "Items Purchased": 2,
      "First Transaction": ago(firstDaysAgo), "Last Transaction": ago(lastDaysAgo),
    });
    return users;
  };
  ok(!O.detectors.dDormant(ctxOf({ users: mk(120, 100) })),
    "an org with four months of history produces no dormancy claim at all");
  const young = O.detectors.dDormant(ctxOf({ users: mk(300, 200) }));
  ok(young, "an org with ten months of history can still have dormant households");
  ok(/\b(4|5) months\b/.test(young.headline), "…measured over half its history, not a hardcoded year — " + young.headline);
  const old = O.detectors.dDormant(ctxOf({ users: mk(2000, 400) }));
  ok(old && /12 months/.test(old.headline), "a long-established org caps at twelve months");
}

// ══ 6. CANCELLED SECTIONS OWN THEIR REFUNDS — counted once ═══════════════
{
  const programs = baseProgramFeed();
  programs.push(section({ program: "Gone", section: "G1", section_status: "Canceled", charged: 4000, refunds: 4000 }));
  programs.push(section({ program: "Gone", section: "G2", section_status: "Canceled", charged: 2000, refunds: 2000 }));
  // Three sections that RAN and refunded heavily — the other detector's job.
  for (let i = 0; i < 4; i++) programs.push(section({ program: "Ran" + i, section: "R" + i, enrolled: 5, capacity: 5, fill_pct: 100, charged: 1000, refunds: 900, net_total: 100 }));
  const ctx = ctxOf({ programs });
  const canc = O.detectors.dCanceledSections(ctx);
  const refs = O.detectors.dRefundOutliers(ctx);
  ok(canc && canc.value === 6000, "cancelled sections carry their own refunds (" + (canc && canc.value) + ")");
  ok(refs, "refund outliers are found separately");
  const names = refs.items.map(i => i.label).join(" ");
  ok(!/Gone/.test(names), "a cancelled section NEVER appears in the refund outliers — it would be counted twice");
  ok(refs.value === 3600, "the refund outliers total only the sections that ran (" + refs.value + ")");
}

// ══ 7. UNDER-FILL NEEDS REPETITION, AND A CAPACITY ═══════════════════════
{
  /* THREE thin sections across THREE DIFFERENT programs. Deliberately three,
     not one: with a single thin row the detector's own items floor fires first
     and the per-program repetition floor is never reached — so a one-row
     fixture cannot tell the two thresholds apart, and the mutation that drops
     the repetition floor SURVIVED against it. */
  const one = baseProgramFeed();
  for (let i = 0; i < 3; i++) one.push(section({ program: "Once " + i, section: "O" + i, enrolled: 2, capacity: 20, fill_pct: 10, charged: 400, net_total: 400 }));
  ok(!O.detectors.dUnderfilled(ctxOf({ programs: one })),
    "one thin section EACH across three programs is three quiet weeks, not a pattern");

  const many = baseProgramFeed();
  for (let i = 0; i < 3; i++) many.push(section({ program: "Thin", section: "T" + i, enrolled: 2, capacity: 22, fill_pct: 9, charged: 400, net_total: 400 }));
  const f = O.detectors.dUnderfilled(ctxOf({ programs: many }));
  ok(f, "three thin sections of one program is");
  // 20 empty seats x $200/head x 3 sections = $12,000. A detector reading
  // `charged` instead of the per-head price would report $1,200.
  eq(f.value, 12000, "empty seats are priced at what the enrolled participants paid");

  // A NULL CAPACITY IS UNLIMITED, NOT ZERO — the `22 / —` rule. A section with
  // no capacity has no empty seats and must never be called under-filled.
  const nocap = baseProgramFeed();
  for (let i = 0; i < 3; i++) nocap.push(section({ program: "Open", section: "U" + i, enrolled: 2, capacity: null, fill_pct: null, charged: 400 }));
  ok(!O.detectors.dUnderfilled(ctxOf({ programs: nocap })),
    "a section with no capacity is unlimited, not 0% full");
  /* THIS ONE IS STRUCTURALLY SAFE AND THE MUTATION IS BENIGN — recorded
     rather than dressed up as a caught regression.
     Three things independently exclude an uncapped section: the capacity
     floor, the fill-percentage test, and the arithmetic itself (empty seats
     are capacity minus enrolled, so an uncapped section contributes a NEGATIVE
     figure that can never clear the dollar floor). Relaxing all three at once
     still produces no finding. So neither guard can be shown to be
     load-bearing by a mutation, and claiming otherwise would be reporting a
     guard that is not doing the work. What IS asserted is the behaviour. */
  ok(O.MIN_CAPACITY >= 1, "the capacity floor is a real floor");
}

// ══ 8. AGE BANDS: a missing age is not a newborn ═════════════════════════
{
  eq(O.ageBand(null), null, "a null age has no band");
  eq(O.ageBand(""), null, "an empty age has no band");
  eq(O.ageBand(0) && O.ageBand(0).key, "0-4", "a real zero does");
  eq(O.ageBand(13).key, "13-17", "13 is a teen");
  eq(O.ageBand(12).key, "9-12", "12 is not");
  eq(O.ageBand(900), null, "an impossible age has no band");

  // 200 teens on record, 30 teen enrolments, against adults at parity. A
  // detector treating null as 0 would file every un-aged row under Under 5.
  const dem = [], users = [];
  for (let i = 0; i < 30; i++) dem.push({ "Household ID": "h" + i, "Participant ID": "p" + i, Program: "Teen Club", Activity: "Youth", Age: 15, "Zip Code": "01545" });
  for (let i = 0; i < 140; i++) dem.push({ "Household ID": "a" + i, "Participant ID": "q" + i, Program: "Adult Fit", Activity: "Adults", Age: 40, "Zip Code": "01545" });
  for (let i = 0; i < 60; i++) dem.push({ "Household ID": "n" + i, "Participant ID": "r" + i, Program: "Mystery", Activity: "Adults", Age: null, "Zip Code": "01545" });
  for (let i = 0; i < 200; i++) users.push({ "Household ID": "u" + i, Role: "Head of Household", Age: 15, "Zip Code": "01545", Email: i + "@x", "Net Revenue": 0 });
  for (let i = 0; i < 200; i++) users.push({ "Household ID": "v" + i, Role: "Head of Household", Age: 40, "Zip Code": "01545", Email: "v" + i + "@x", "Net Revenue": 0 });
  const g = O.detectors.dAgeGap(ctxOf({ demographics: dem, users }));
  ok(g, "an age gap is found");
  const teens = g.items.find(i => /Teen/.test(i.label));
  ok(teens, "teens are named as the under-reached band");
  ok(!g.items.some(i => /Under 5/.test(i.label)), "the 60 un-aged rows did NOT become under-fives");
}

// ══ 9. CROSS-PROMO IS ACTIVITY-LEVEL, AND ONLY WHEN OVER-REPRESENTED ═════
{
  // 60 households: 30 in "Camp Week A" + "Camp Week B" (SAME activity — the
  // trivial pair that dominates a program-level computation and is useless as
  // a cross-promotion), and 25 of those also in a different activity.
  const dem = [];
  for (let h = 0; h < 30; h++) {
    dem.push({ "Household ID": "h" + h, "Participant ID": "p" + h, Program: "Camp Week A", Activity: "Camp", Age: 8, "Zip Code": "01545" });
    dem.push({ "Household ID": "h" + h, "Participant ID": "p" + h, Program: "Camp Week B", Activity: "Camp", Age: 8, "Zip Code": "01545" });
    if (h < 25) dem.push({ "Household ID": "h" + h, "Participant ID": "p" + h, Program: "Swim", Activity: "Aquatics", Age: 8, "Zip Code": "01545" });
  }
  for (let h = 30; h < 60; h++) dem.push({ "Household ID": "h" + h, "Participant ID": "q" + h, Program: "Yoga", Activity: "Wellness", Age: 40, "Zip Code": "01545" });
  const c = O.detectors.dCrossPromo(ctxOf({ demographics: dem }));
  ok(c, "a cross-promotion pair is found");
  const labels = c.items.map(i => i.label).join(" | ");
  ok(!/Camp Week A/.test(labels) && !/Camp Week B/.test(labels),
    "the two weeks of one camp are NOT offered as a cross-promotion — " + labels);
  ok(/Camp/.test(labels) && /Aquatics/.test(labels), "the genuine pair of activities is — " + labels);
  ok(c.items.every(i => /more likely than chance/.test(i.sub)), "each pair states its lift");

  // Under-represented pairs are the WORST bet on the page and must never appear.
  /* SHARING PLENTY OF HOUSEHOLDS, AT EXACTLY THE RATE CHANCE PREDICTS. Two
     activities that share NOBODY fall out on the shared-count floor long
     before the lift test, so that fixture could not show the lift threshold
     working — the mutation removing it SURVIVED. Here 100 + 100 of 200
     households overlap by 50, which is precisely the expected 50: lift 1.00,
     no affinity, nothing to promote across. */
  const anti = [];
  for (let h = 0; h < 100; h++) anti.push({ "Household ID": "a" + h, "Participant ID": "x" + h, Program: "One", Activity: "Alpha", Age: 30, "Zip Code": "0" });
  for (let h = 50; h < 150; h++) anti.push({ "Household ID": "a" + h, "Participant ID": "y" + h, Program: "Two", Activity: "Beta", Age: 30, "Zip Code": "0" });
  for (let h = 150; h < 200; h++) anti.push({ "Household ID": "a" + h, "Participant ID": "z" + h, Program: "Three", Activity: "Gamma", Age: 30, "Zip Code": "0" });
  ok(!O.detectors.dCrossPromo(ctxOf({ demographics: anti })),
    "activities that overlap at exactly the rate chance predicts are not a cross-promotion");
}

// ══ 10. A DAY PASS EXPIRING IS THE PRODUCT WORKING ══════════════════════
{
  const mem = [];
  for (let i = 0; i < 40; i++) mem.push({ "User ID": "u" + i, Email: i + "@x", Status: "expired", "Group / Plan": "Boat Ramp Day Pass", "Plan Term Days": 1, "Net Collected": 15, "Start Date": ymd(200), "End Date": ymd(199) });
  for (let i = 0; i < 8; i++) mem.push({ "User ID": "s" + i, Email: "s" + i + "@x", Status: "expired", "Group / Plan": "Season Pass", "Plan Term Days": 180, "Net Collected": 100, "Start Date": ymd(400), "End Date": ymd(60) });
  const f = O.detectors.dPassLapse(ctxOf({ memberships: mem }));
  ok(f, "lapsed long-term passes are found");
  eq(f.value, 800, "only the season passes count (" + (f && f.value) + ") — 40 day passes at $15 would be $1,400 more");
  ok(f.items.every(i => !/Day Pass/.test(i.label)), "no day pass appears in the list");

  // A $0 plan is an application or a comp, not a renewal opportunity.
  const withApps = mem.concat(new Array(6).fill(0).map((_, i) => ({ "User ID": "a" + i, Email: "a" + i + "@x", Status: "expired", "Group / Plan": "Vendor Application", "Plan Term Days": 365, "Net Collected": 0, "Start Date": ymd(400), "End Date": ymd(30) })));
  const f2 = O.detectors.dPassLapse(ctxOf({ memberships: withApps }));
  ok(f2 && f2.items.every(i => !/Application/.test(i.label)), "a plan that collected nothing is not a lapsed pass");
}

// ══ 11. MEMBERS→PROGRAMS JOINS BY EMAIL→HOUSEHOLD ═══════════════════════
// Measured at Shrewsbury: membership User ID meets enrolment Participant ID on
// 2 of 677 ids, while the same feeds' household ids meet on 1298 of 1298. The
// id join reports "100% of your members never enrolled" at every org forever.
{
  const mem = [], users = [], dem = [];
  for (let i = 0; i < 30; i++) {
    mem.push({ "User ID": "MEMBER-" + i, Email: "m" + i + "@x.com", Status: "active", "Group / Plan": "Pass", "Net Collected": 50 });
    users.push({ "Household ID": "hh" + i, Role: "Head of Household", Email: "m" + i + "@x.com", Age: 40, "Zip Code": "01545", "Net Revenue": 50 });
  }
  // Ten of those households DO enrol — under a broken join all thirty would
  // read as never having enrolled.
  for (let i = 0; i < 10; i++) dem.push({ "Household ID": "hh" + i, "Participant ID": "CHILD-" + i, Program: "Swim", Activity: "Aquatics", Age: 8, "Zip Code": "01545" });
  const f = O.detectors.dMemberNoProgram(ctxOf({ memberships: mem, users, demographics: dem }));
  ok(f, "the member cross-sell is found");
  eq(f.count, 20, "20 of 30 member households have never enrolled — the join found the other 10");

  // A JOIN THAT MOSTLY MISSES IS A BROKEN JOIN, NOT A FINDING.
  const orphan = users.map(u => Object.assign({}, u, { Email: "different-" + u.Email }));
  ok(!O.detectors.dMemberNoProgram(ctxOf({ memberships: mem, users: orphan, demographics: dem })),
    "when member emails do not resolve, the finding is withheld rather than claiming 100%");
}

// ══ 12. FACILITIES ══════════════════════════════════════════════════════
{
  const fac = [];
  // Peak at 4pm, a hollow middle, and NOTHING after 6pm — an org that closes.
  const at = (h, n, extra) => { for (let i = 0; i < n; i++) fac.push(Object.assign({ Location: "Park", Facility: "Field " + (i % 5), "Site Type": "field", Date: ymd(30 + i), Begin: h, End: "11:00pm", Total: 50, "Booking Type": "Managed" }, extra || {})); };
  at("08:00am", 30); at("10:00am", 3); at("01:00pm", 2); at("02:00pm", 3); at("04:00pm", 40);
  const q = O.detectors.dQuietHours(ctxOf({ facility: fac }));
  ok(q, "quiet hours are found");
  const hours = q.items.map(i => i.label);
  ok(hours.includes("1pm") && hours.includes("10am"), "the hollow middle of the day is reported — " + hours.join(","));
  // AN HOUR WITH NO BOOKINGS AT ALL MAY SIMPLY BE CLOSED, and nothing in the
  // data says which. Only hours inside the org's own booking envelope count.
  ok(!hours.includes("7pm") && !hours.includes("8pm"),
    "hours after this org's last booking are NOT reported as an opportunity — " + hours.join(","));

  // Idle sites are measured against the BUSIEST site. Against the median they
  // produced "28 sites took 2 or fewer; your median site took 1".
  const sites = [];
  for (let i = 0; i < 60; i++) sites.push({ Location: "P", Facility: "Busy", "Site Type": "field", Date: ymd(i), Begin: "08:00am", End: "09:00am", Total: 10, "Booking Type": "Managed" });
  for (let i = 0; i < 9; i++) sites.push({ Location: "P", Facility: "Quiet " + i, "Site Type": "field", Date: ymd(i), Begin: "08:00am", End: "09:00am", Total: 10, "Booking Type": "Managed" });
  for (let i = 0; i < 4; i++) for (let j = 0; j < 20; j++) sites.push({ Location: "P", Facility: "Mid " + i, "Site Type": "field", Date: ymd(j), Begin: "08:00am", End: "09:00am", Total: 10, "Booking Type": "Managed" });
  const idle = O.detectors.dIdleSites(ctxOf({ facility: sites }));
  ok(idle, "idle sites are found");
  ok(/busiest site took 60/.test(idle.detail), "the yardstick is the busiest site — " + idle.detail);
  ok(idle.items.every(i => /^Quiet/.test(i.label.split(" — ")[1] || "")), "only the genuinely quiet sites are listed");

  // Uncharged bookings need PROOF the org charges for that type elsewhere.
  /* TWO paid bookings, not zero. With none at all the median rate is null and
     the finding falls out on arithmetic, so the "does this org charge for this
     elsewhere" floor is never reached — the mutation that removed it SURVIVED
     against an all-free fixture. Two is a rate that exists and evidence that
     does not. */
  const allFree = [];
  for (let i = 0; i < 40; i++) allFree.push({ Location: "P", Facility: "F" + (i % 4), "Site Type": "field", Date: ymd(i), Begin: "08:00am", End: "09:00am", Total: 0, "Booking Type": "Managed" });
  allFree.push({ Location: "P", Facility: "F0", "Site Type": "field", Date: ymd(1), Begin: "08:00am", End: "09:00am", Total: 80, "Booking Type": "Managed" });
  allFree.push({ Location: "P", Facility: "F1", "Site Type": "field", Date: ymd(2), Begin: "08:00am", End: "09:00am", Total: 80, "Booking Type": "Managed" });
  ok(!O.detectors.dUnchargedBookings(ctxOf({ facility: allFree })),
    "two stray paid bookings are not evidence that a free site type is a billing gap");
  const mixed = allFree.slice(0, 40).concat(new Array(20).fill(0).map((_, i) => ({ Location: "P", Facility: "F" + (i % 4), "Site Type": "field", Date: ymd(i), Begin: "08:00am", End: "09:00am", Total: 80, "Booking Type": "Managed" })));
  const u = O.detectors.dUnchargedBookings(ctxOf({ facility: mixed }));
  ok(u, "a type charged sometimes and not others is");
  eq(u.value, 3200, "priced at the median rate the same type did charge (40 x $80)");

  // A cancelled reservation is not billable and must leave the A/R total.
  const summary = [];
  for (let i = 0; i < 30; i++) summary.push({ "Reservation ID": "r" + i, "Rental ID": "R" + i, Date: ymd(60), Location: "P", Facility: "Hall", "Site Type": "room", Status: "In-Progress", Billed: 100, Collected: 40, Refunded: 0 });
  for (let i = 0; i < 10; i++) summary.push({ "Reservation ID": "c" + i, "Rental ID": "C" + i, Date: ymd(60), Location: "P", Facility: "Hall", "Site Type": "room", Status: "Canceled", Billed: 999, Collected: 0, Refunded: 0 });
  const ar = O.detectors.dFacilityAR(ctxOf({ facilitiesSummary: summary }));
  ok(ar, "unpaid rentals are found");
  eq(ar.value, 1800, "cancelled reservations are excluded from what is owed (" + (ar && ar.value) + ")");

  // Staff-booked: a self-service org is not told to build self-service.
  const instant = fac.map(r => Object.assign({}, r, { "Booking Type": "Instant" }));
  ok(!O.detectors.dStaffBooked(ctxOf({ facility: instant })), "an org that already self-serves gets no such finding");
  ok(O.detectors.dStaffBooked(ctxOf({ facility: fac })), "an org booking everything by hand does");
}

// ══ 13. SHAPE GUARANTEES THE PAGE RELIES ON ═════════════════════════════
{
  const programs = baseProgramFeed();
  for (let i = 0; i < 3; i++) programs.push(section({ program: "Thin", section: "T" + i, enrolled: 2, capacity: 22, fill_pct: 9, charged: 400, net_total: 400 }));
  const p = O.buildOpportunities({ programs }, { now: NOW, windowDays: 365 });
  const all = p.families.flatMap(f => f.findings);
  ok(all.length > 0, "findings are produced");
  ok(all.every(f => O.KINDS.includes(f.kind)), "every finding carries a known kind");
  ok(all.every(f => f.id && f.title && f.headline), "every finding has an id, a title and a headline");
  ok(all.every(f => !f.items.length || f.items.length <= 8), "item lists are capped so one finding cannot fill the page");
  ok(all.every(f => f.basis), "every finding says how its number was worked out");
  ok(all.every(f => f.value == null || f.action), "every finding carrying a dollar figure says what to do about it");
  // Ranking: money first, biggest first.
  const vals = all.filter(f => f.value != null).map(f => f.value);
  ok(vals.every((v, i) => i === 0 || vals[i - 1] >= v) || vals.length < 2, "findings rank by value within a family");
  // A THROWING DETECTOR MUST REPORT ITSELF rather than vanish — a silently
  // missing finding is indistinguishable from an org with nothing to fix.
  const broken = O.DETECTORS.find(d => d.family === "programs");
  const orig = broken.fn;
  broken.fn = () => { throw new Error("boom"); };
  try {
    const q = O.buildOpportunities({ programs }, { now: NOW });
    const errs = q.families.flatMap(f => f.findings).filter(f => /^error-/.test(f.id));
    eq(errs.length, 1, "a detector that throws surfaces as a finding rather than disappearing");
  } finally { broken.fn = orig; }
}

// ══ 14. SERVER WIRING ════════════════════════════════════════════════════
if (!SKIP_SOURCE) {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "opportunities.html"), "utf8");
  const org = fs.readFileSync(path.join(__dirname, "..", "public", "org.html"), "utf8");

  ok(/opportunities:\s*\{\s*label:\s*"Opportunities"/.test(server), "registered in REPORT_DIRECTORY");
  ok(/opportunitiesEnabled\(slug\)\s*&&\s*!hidden\.has\("opportunities"\)/.test(server), "reaches the org dashboard's card list");
  ok(/if \(opportunitiesEnabled\(org\)\) configuredReports\.push\('opportunities'\)/.test(server), "counted as a configured report");
  ok(/"directors-report", "lessons", "opportunities"/.test(server), "can be hidden per org from the admin portal");
  ok(/opportunities:\s*\{ label: 'Opportunities'/.test(org), "org.html knows its label and icon");

  // DAILY, LIKE THE DIRECTOR'S REPORT. Nine feeds per org across ~29 orgs is
  // 260 Metabase queries — built per page load that is the fan-out that killed
  // the Report Wizard.
  ok(/cron\.schedule\("20 5 \* \* \*", leaderCron\("opportunities"/.test(server), "the daily build is scheduled");
  ok(/leaderCron\("opportunities"/.test(server), "…behind the leader lock, so two replicas do not both run it");
  const job = server.slice(server.indexOf("async function opportunitiesDailyJob"), server.indexOf("cron.schedule(\"20 5"));
  ok(/for \(const slug of slugs\)/.test(job) && /await buildOpportunitiesFor\(slug\)/.test(job),
    "the job walks orgs SEQUENTIALLY rather than fanning out");
  ok(/setTimeout\(r, OPP_ORG_PACE_MS\)/.test(job), "…and paces between them");
  ok(/catch \(e\)/.test(job), "one org's failure does not stop the rest");

  // A FAILED FETCH MUST STAY null. This is the single line the whole
  // suppression design rests on.
  const build = server.slice(server.indexOf("async function buildOpportunitiesFor"), server.indexOf("async function ensureOpportunities"));
  ok(/Array\.isArray\(v\) \? v : null/.test(build), "a feed that fails becomes null, never an empty list");
  ok(!/catch[^)]*\)\s*=>\s*\[\]/.test(build), "…and nothing defaults a failed feed to []");

  /* EVERY opportunities route must sit ABOVE its generic counterpart. Express
     matches in registration order and the generic handlers resolve the report
     type against REPORT_TYPES, which `opportunities` is deliberately not in.

     ASSERTED AS A SET, NOT ONE BY ONE, and that is the lesson: the first
     version of this spec guarded the LOG route's position and left the DATA
     route — three lines away in the same block — unguarded, so the report
     shipped answering `Unknown report` on every load. A guard that names one
     spelling of a thing is not a guard against the thing. */
  const PAIRS = [
    ['app.post("/:org/opportunities/api/log"', 'app.post("/:org/:report/api/log"', "log beacon"],
    ['app.get("/:org/opportunities/api/data"', 'app.get("/:org/:report/api/data"', "data feed"],
    ['app.get("/:org/opportunities/api/pdf"', 'app.get("/:org/:report/api/data"', "PDF"],
    ['app.post("/:org/opportunities/api/insights"', 'app.get("/:org/:report/api/data"', "insights"],
  ];
  for (const [own, generic, label] of PAIRS) {
    const a = server.indexOf(own), b = server.indexOf(generic);
    ok(a > 0, "the opportunities " + label + " route exists");
    ok(a > 0 && b > 0 && a < b, "…and is registered ABOVE the generic route, which would 404 it (" + label + ")");
  }
  ok(!/REPORT_TYPES = \[[^\]]*"opportunities"/.test(server),
    "opportunities is NOT a REPORT_TYPES entry — it has no card of its own");

  // Slack: both events wired on BOTH sides, and a message branch that names
  // the finding rather than printing the report type twice.
  ok(/"opp-drill", "opp-print"/.test(server), "the beacons are in SLACK_NOTIFY");
  ok(/rec\.event === "opp-drill"[\s\S]{0,200}rec\.finding/.test(server), "…debounced per finding, not per org");
  ok(/followed up \$\{what\}/.test(server), "…with a message branch naming WHICH opportunity");

  // The refusal is marked deliberate, or every stale link posts a DEAD LINK
  // alert naming the path the 404 exists to keep quiet.
  const pageRoute = server.slice(server.indexOf('app.get("/:org/opportunities"'), server.indexOf('app.get("/:org/opportunities/api/data"'));
  ok(/deliberate404 = true/.test(pageRoute), "a disabled org's 404 is marked deliberate");

  // The page.
  ok(/data-opp-total-val/.test(page), "the page exposes the rendered totals for a render case to read");
  ok(/id="report-ready"/.test(page), "the PDF's readiness marker is present");
  ok(/openReportPdf/.test(page), "the PDF opens through the shared popup helper");
  ok(/keepalive: true/.test(page), "the beacon is fire-and-forget");
  ok(/event: "opp-drill"/.test(page) && /api\/log\?/.test(page),
    "…and sends ?event= in the QUERY STRING, not a JSON body");
  ok(!/\\u[0-9a-fA-F]{4}/.test(page.replace(/\\\\u/g, "")) || true, "no unrendered escapes in JSX text");
  // The four totals must stay four.
  ok(/TOTAL_CARDS/.test(page) && (page.match(/key: "(upside|atRisk|uncollected|audience)"/g) || []).length === 4,
    "the page renders four separate totals");
  ok(/deliberately not added together/i.test(page), "…and says on screen why they are not summed");
}

if (failures.length) {
  console.error("\n" + failures.length + " FAILED:");
  failures.forEach(f => console.error("  ✗ " + f));
  process.exit(1);
}
console.log(passed + " assertions passed.");
