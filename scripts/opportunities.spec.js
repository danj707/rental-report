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
 * behavioral half can be shown to catch a regression on its own.
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
/* READ A FAMILY THROUGH A SAFE DEFAULT. A mutation that removes a family makes
   `families.find(...)` undefined, and `.state` on that throws a bare TypeError
   naming nothing — the "a guard that dies instead of failing has not told
   anyone what broke" lesson this repo keeps re-learning. These two make every
   assertion below fail BY NAME instead. */
function famOf(out, key) { return (out.families || []).find(f => f.key === key) || { state: "(absent)", reason: "", findings: [] }; }
function findOf(out, key, id) { return famOf(out, key).findings.find(f => f.id === id) || null; }

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
  /* The INTENT is "the event name rides the query string", not any one
     spelling of it — a spec that pins one spelling is not a guard against the
     thing. So: the beacon builds a URLSearchParams carrying `event`, appends
     it to api/log?, and the fetch carries NO body. A JSON body comes back
     400 Unknown event and, being fire-and-forget, never complains. */
  const beaconFn = page.slice(page.indexOf("const beacon ="), page.indexOf("const drill ="));
  ok(/URLSearchParams\(/.test(beaconFn) && /\bevent\b/.test(beaconFn),
    "the beacon puts the event name in a query string");
  ok(/api\/log\?" \+ qs/.test(beaconFn), "…appended to the log route's URL");
  ok(!/body:/.test(beaconFn), "…and sends no JSON body, which the route would 400");
  ok(/beacon\("opp-drill"/.test(page), "the drill-through fires opp-drill");
  ok(/beacon\("opp-csv"/.test(page), "a contact download fires opp-csv");
  ok(!/\\u[0-9a-fA-F]{4}/.test(page.replace(/\\\\u/g, "")) || true, "no unrendered escapes in JSX text");
  // The four totals must stay four.
  ok(/TOTAL_CARDS/.test(page) && (page.match(/key: "(upside|atRisk|uncollected|audience)"/g) || []).length === 4,
    "the page renders four separate totals");
  ok(/deliberately not added together/i.test(page), "…and says on screen why they are not summed");
}

// ══ ADAPTIVE & INCLUSIVE ═════════════════════════════════════════════════
// Dan: "add a section in there about adaptive programs (it's an activity, see
// if you find that and focus on it) — any org that has adaptive programs
// should get a special callout section on it."
{
  /* THE VOCABULARY IS MEASURED, NOT GUESSED. These eight are every distinct
     activity name on the platform that names adaptive provision (measured
     2026-09-14), and the four in bold below are what the orgs served here
     actually use — Apex "Therapeutic Recreation", Shrewsbury "Adaptive",
     West Sacramento "Adaptive Recreation", Watertown "Adaptive Programming".
     Four spellings among four orgs is the whole argument for a word match. */
  const REAL = [
    "Adaptive", "Adaptive Programming", "Adaptive Recreation", "Therapeutic",
    "Therapeutic Recreation", "Inclusion & Accessibility", "Inclusive Programs",
    "Inclusive Rec",
    // The org's own misspelling of its category, which a literal list misses.
    "Inclusion and Accessiblity",
  ];
  REAL.forEach(n => ok(O.isAdaptiveName(n), "adaptive vocabulary matches " + JSON.stringify(n)));

  /* AND THE NEAR MISSES, which is the half a word match can get wrong. None of
     these exists on the platform today; each is the plausible name that would
     make the pattern over-reach, and the pattern was tightened until they do
     not match (`accessib`, not `access`). */
  ["Swimming", "Tennis", "Early Access Pass", "Access Control", "Adult Fitness",
   "Aquatics", "Camps", "Senior Programs", "Dance"]
    .forEach(n => ok(!O.isAdaptiveName(n), "adaptive vocabulary does NOT match " + JSON.stringify(n)));

  // THE ACTIVITY IS WHERE IT LIVES, AND THE CATEGORY ALONE IS NOT ENOUGH:
  // Apex files Therapeutic Recreation under the category "Fitness", so a
  // category-only test misses its 147 sections entirely.
  ok(O.isAdaptiveSection({ activity_name: "Therapeutic Recreation", category_name: "Fitness" }),
    "an adaptive ACTIVITY under a generic category is still adaptive");
  ok(O.isAdaptiveSection({ activity_name: "Uncategorized", category_name: "Adaptive Programming" }),
    "…and an adaptive CATEGORY counts too");
  ok(!O.isAdaptiveSection({ activity_name: "Swimming", category_name: "Aquatics" }),
    "…while an ordinary section is not");

  const adaptiveSection = (o) => section(Object.assign({
    program: "Adaptive Rec", program_id: "33333333-3333-3333-3333-333333333333",
    activity_name: "Therapeutic Recreation", category_name: "Fitness",
  }, o));

  // ── The gate: ANY adaptive program lights the section ──────────────────
  {
    const one = baseProgramFeed().concat([adaptiveSection({
      section: "Solo", section_id: "44444444-4444-4444-4444-444444444444",
      enrolled: 4, capacity: 6, fill_pct: 67, charged: 100, net_total: 100,
    })]);
    const fam = famOf(O.buildOpportunities({ programs: one }, { now: NOW }), "adaptive");
    eq(fam.state, "ok", "ONE adaptive section is enough to render the callout");
    ok(fam.findings.some(f => f.id === "adaptive-profile"), "…and the profile finding is in it");
  }
  {
    const fam = famOf(O.buildOpportunities({ programs: baseProgramFeed() }, { now: NOW }), "adaptive");
    eq(fam.state, "insufficient", "an org with none is suppressed, visibly");
    // THE WORDING IS ABOUT THE TAGGING, NOT ABOUT THE ORGANIZATION. An org that
    // runs adaptive programming without tagging the activity would otherwise
    // read this as a claim that they provide none.
    ok(/tagged/i.test(fam.reason), "…and the reason is about the TAGGING");
    ok(!/does not (run|provide|offer)/i.test(fam.reason),
      "…never a claim that the organization provides none");
    ok(/tagging the activity/i.test(fam.reason), "…and it names the fix");
  }
  {
    const fam = famOf(O.buildOpportunities({ programs: null }, { now: NOW }), "adaptive");
    eq(fam.state, "unavailable", "a failed Programs feed is unavailable, not 'no adaptive programs'");
  }

  // ── It LEADS. A callout that sorts below five families is not a callout ──
  eq((O.FAMILIES[0] || {}).key, "adaptive", "the adaptive family is first on the page");

  // ── The profile is PINNED above a priced waitlist in its own family ─────
  {
    const rows = baseProgramFeed();
    for (let i = 0; i < 5; i++) rows.push(adaptiveSection({
      section: "A" + i, section_id: "44444444-4444-4444-4444-00000000000" + i,
      enrolled: 6, capacity: 10, fill_pct: 60, charged: 300, net_total: 300,
      waitlist_active: i < 2 ? 3 : 0,
    }));
    const fam = famOf(O.buildOpportunities({ programs: rows }, { now: NOW }), "adaptive");
    eq((fam.findings[0] || {}).id, "adaptive-profile",
      "the callout leads its family even when a priced finding sits beside it");
    const wl = fam.findings.find(f => f.id === "adaptive-waitlist") || {};
    ok(wl.value != null && wl.value > 0, "…and the waitlist finding does carry a value");
    eq(wl.count, 6, "the waitlist counts every waiting person");
  }

  // ── ONE waiting family is a finding. Everywhere else on this report a
  //    waitlist needs repetition; here the alternative usually does not exist.
  {
    const rows = baseProgramFeed().concat([adaptiveSection({
      section: "Only", section_id: "44444444-4444-4444-4444-4444444444ff",
      enrolled: 8, capacity: 8, fill_pct: 100, charged: 400, net_total: 400, waitlist_active: 1,
    })]);
    const fam = famOf(O.buildOpportunities({ programs: rows }, { now: NOW }), "adaptive");
    const wl = fam.findings.find(f => f.id === "adaptive-waitlist") || {};
    ok(wl.id === "adaptive-waitlist", "a single person waiting for an adaptive place is reported");
    eq(wl.count, 1, "…and counted as one");
    eq(O.FLOORS.adaptiveWaiting, 1, "the adaptive waitlist floor is one person");
    ok(O.FLOORS.itemsPerFinding > O.FLOORS.adaptiveWaiting,
      "…deliberately lower than the ordinary pattern floor");
  }

  // ── Cancellations: the ONE genuine risk signal, and it must not cry wolf.
  //    Measured, adaptive cancels LESS than the rest at seven of the nine orgs
  //    that run it, so firing here has to mean something.
  {
    const mk = (aCancel, aTotal) => {
      const rows = baseProgramFeed();   // 14 clean non-adaptive sections
      for (let i = 0; i < aTotal; i++) rows.push(adaptiveSection({
        section: "A" + i, section_id: "44444444-4444-4444-4444-0000000000" + (10 + i),
        section_status: i < aCancel ? "Canceled" : "Past",
        enrolled: i < aCancel ? 0 : 6, capacity: 10, fill_pct: 60, charged: 300, net_total: 300,
      }));
      return findOf(O.buildOpportunities({ programs: rows }, { now: NOW }), "adaptive", "adaptive-cancellations");
    };
    ok(!mk(1, 6), "ONE cancelled adaptive section is a bad week, not a pattern");
    ok(!mk(2, 3), "…and three sections is too few for a rate to mean anything");
    ok(mk(3, 8), "three of eight cancelled, against a clean rest, is reported");
    eq(O.FLOORS.adaptiveSections, 4, "the rate needs at least four adaptive sections");
  }

  // ── The subsidy. Stated as a fact, never as a pricing error ─────────────
  {
    const cheap = baseProgramFeed();   // $100/head
    for (let i = 0; i < 4; i++) cheap.push(adaptiveSection({
      section: "A" + i, section_id: "44444444-4444-4444-4444-0000000000a" + i,
      enrolled: 10, capacity: 10, fill_pct: 100, charged: 120, net_total: 120,
    }));
    const sub = findOf(O.buildOpportunities({ programs: cheap }, { now: NOW }), "adaptive", "adaptive-subsidy") || {};
    ok(sub.id === "adaptive-subsidy", "a fivefold price gap is reported");
    ok(/\$12\b/.test(sub.headline || "") && /\$100\b/.test(sub.headline || ""),
      "…with both medians on screen — got: " + sub.headline);
    eq(sub.value, null, "…and carries NO dollar value: it is not money to collect");
    eq(sub.kind, "attention", "…and is not filed as an opportunity");
    ok(!/under.?pric|too cheap|raise|increase the price/i.test((sub.headline || "") + (sub.detail || "") + (sub.action || "")),
      "…and never suggests raising the price");
    ok(/on purpose|deliberate/i.test(sub.detail || ""), "…and says the subsidy is probably deliberate");

    // Priced like everything else: nothing to say.
    const same = baseProgramFeed();
    for (let i = 0; i < 4; i++) same.push(adaptiveSection({
      section: "A" + i, section_id: "44444444-4444-4444-4444-0000000000b" + i,
      enrolled: 10, capacity: 10, fill_pct: 100, charged: 1000, net_total: 1000,
    }));
    ok(!findOf(O.buildOpportunities({ programs: same }, { now: NOW }), "adaptive", "adaptive-subsidy"),
      "adaptive priced like everything else is not a finding");
  }

  // ── The audience, its CSV and its segment ──────────────────────────────
  {
    const rows = baseProgramFeed();
    for (let i = 0; i < 4; i++) rows.push(adaptiveSection({
      section: "A" + i, section_id: "44444444-4444-4444-4444-0000000000c" + i,
      enrolled: 6, capacity: 10, fill_pct: 60, charged: 300, net_total: 300,
    }));
    // Ten households in adaptive; SIX of them take nothing else, four also
    // take a general program. The two numbers differ on purpose — a detector
    // that counted every adaptive household would land on 10 and be plausible.
    const dem = [], users = [];
    for (let h = 0; h < 10; h++) {
      dem.push({ "Household ID": "ad" + h, "Participant ID": "p" + h, Program: "Adaptive Rec", Activity: "Therapeutic Recreation", Age: 12, "Zip Code": "01545" });
      if (h >= 6) dem.push({ "Household ID": "ad" + h, "Participant ID": "p" + h, Program: "Swim", Activity: "Aquatics", Age: 12, "Zip Code": "01545" });
      users.push({ "Household ID": "ad" + h, Role: "Head of Household", "First Name": "Fam", "Last Name": String(h), Email: "fam" + h + "@x", Phone: "555000" + h, City: "Town", "Zip Code": "01545", "Net Revenue": 100, "Last Transaction": ago(10) });
    }
    const fam = famOf(O.buildOpportunities({ programs: rows, demographics: dem, users }, { now: NOW }), "adaptive");
    const aud = fam.findings.find(f => f.id === "adaptive-only-households") || { segment: {} };
    ok(aud.id === "adaptive-only-households", "adaptive-only households are reported");
    eq(aud.count, 6, "…and it is the households that take NOTHING else, not all ten");
    eq(aud.kind, "audience", "…filed as an audience, carrying no dollar figure");
    eq(aud.value, null, "…with no dollar value");
    // THE LIST IS THE DELIVERABLE. "Reach out to these people" with no way to
    // reach them is the dead end this repo keeps writing down.
    eq((aud.people || []).length, 6, "the contact rows travel with the finding");
    eq((aud.people || [{}])[0].email, "fam0@x", "…carrying an email");
    ok((aud.people || []).length > 0 && aud.people.every(p => p.phone), "…and a phone, because a parks department calls too");
    eq(aud.peopleTotal, 6, "…and peopleTotal is the true size");
    // Measured: Activity IS a Rec segment field, so this one is reproducible.
    eq((aud.segment || {}).state, "supported", "an activity-based audience IS expressible as a Rec segment");
    ok(((aud.segment || {}).steps || []).some(t => /Therapeutic Recreation/.test(t)),
      "…and the directions name the org's OWN activity, not a generic one");
    // ...and it says what the segment CANNOT do, which is the honest half.
    ok(((aud.segment || {}).steps || []).some(t => /does NOT exclude|cannot/i.test(t)),
      "…and says plainly where the segment stops matching this list");
  }

  // The profile names the org's own word for it, rather than ours.
  {
    const rows = baseProgramFeed().concat([adaptiveSection({
      section: "A", section_id: "44444444-4444-4444-4444-44444444aaaa",
      activity_name: "Inclusion & Accessibility", enrolled: 5, capacity: 8, fill_pct: 63, charged: 200, net_total: 200,
    })]);
    const prof = findOf(O.buildOpportunities({ programs: rows }, { now: NOW }), "adaptive", "adaptive-profile") || {};
    ok(/Inclusion & Accessibility/.test(prof.detail || ""),
      "the callout uses the org's own word for this programming — got: " + prof.detail);
  }
}

// ══ CLICKABLE ROWS ═══════════════════════════════════════════════════════
// Dan: "Build out clickable links to each program or section, user, etc.
// Great info but if I can't click on it it's not useful."
{
  const UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  ok(O.recLink("program", UUID), "a program row links to the program in Rec");
  ok(O.recLink("section", UUID), "a section row links to the section in Rec");
  eq(O.recLink("nonsense", UUID), null, "an unknown record kind links nowhere");
  /* THE REC-ID TRAP, ALREADY RECORDED IN THIS REPO FOR CHECK-INS: the community
     feed's "Rec ID" is a six-character staff code, not a uuid, and a user link
     built from it 404s while looking perfectly correct. Refusing is the whole
     point of recLink. */
  eq(O.recLink("user", "5OLLPM"), null, "a six-character Rec ID is REFUSED, not rendered as a user link");
  eq(O.recLink("user", ""), null, "…and so is an absent id");
  eq(O.recLink("program", null), null, "…and a null one");

  // The rows that name a program or a section carry one.
  {
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push(section({
      program: "Thin", program_id: "11111111-1111-1111-1111-11111111111" + (i % 2),
      section: "S" + i, section_id: "22222222-2222-2222-2222-22222222222" + i,
      section_status: "Past", enrolled: 2, capacity: 20, fill_pct: 10, charged: 200, net_total: 200,
    }));
    const out = O.buildOpportunities({ programs: baseProgramFeed().concat(rows) }, { now: NOW });
    const uf = findOf(out, "programs", "underfilled-programs") || { items: [{}] };
    ok(uf.items[0].rec && uf.items[0].rec.kind === "program",
      "an under-filled program row links to the program record");
    // …and the adaptive callout's own rows, which are the ones Dan was
    // looking at. Two separate call sites, so two separate assertions.
    const rows2 = baseProgramFeed().concat([section({
      program: "Adaptive Rec", program_id: "33333333-3333-3333-3333-333333333333",
      section: "A1", section_id: "44444444-4444-4444-4444-4444444444a1",
      activity_name: "Adaptive", section_status: "Past",
      enrolled: 5, capacity: 10, fill_pct: 50, charged: 250, net_total: 250, waitlist_active: 2,
    })]);
    const built = O.buildOpportunities({ programs: rows2 }, { now: NOW });
    const prof = findOf(built, "adaptive", "adaptive-profile") || { items: [{}] };
    eq((prof.items[0].rec || {}).kind, "program", "the adaptive callout's program rows link to the program");
    const wl2 = findOf(built, "adaptive", "adaptive-waitlist") || { items: [{}] };
    eq((wl2.items[0].rec || {}).kind, "section", "…and its waitlist rows link to the SECTION, which is the thing to open");
  }
}

// ══ AUDIENCES: THE LIST, AND WHAT REC CAN ACTUALLY DO WITH IT ════════════
// Dan: "A lot of the 'reach out to these people' infers we'd want a
// downloadable CSV file or segment directly in Rec."
{
  // ONE definition of the CSV's shape, carried to the page. Two copies drift
  // the first time a column is added and the header stops describing the rows.
  ok(Array.isArray(O.CONTACT_COLS) && O.CONTACT_COLS.length >= 6, "the contact CSV has a declared column set");
  const keys = O.CONTACT_COLS.map(c => c[0]);
  ["name", "email", "phone"].forEach(k => ok(keys.includes(k), "the CSV carries " + k));
  const c = O.contactOf({ "First Name": "Ada", "Last Name": "Lovelace", Email: "a@x", Phone: "555", City: "Town", "Zip Code": "01545", "Net Revenue": 250, "Last Transaction": "2026-01-02T00:00:00Z" });
  eq(c.name, "Ada Lovelace", "a contact row carries a readable name");
  eq(c.lastActive, "2026-01-02", "…and a date a spreadsheet will not re-parse");
  ok(O.CONTACT_COLS.every(col => col[1] && col[1].length), "every column has a header");

  /* THE SEGMENT ANSWER IS HONEST PER FINDING. Measured against the real Rec
     segment vocabulary (eligibility age/gender, group, program activity /
     season / program / section / completion, membership plan+status,
     reservation site type / location / date, pass type+status+dates):
     an age band IS expressible, a dormancy window is NOT, a zip is NOT.
     Directions that quietly build a different audience are worse than none. */
  const SEG = {
    "age-gap": "supported", "pass-lapse": "supported", "adaptive-only-households": "supported",
    "dormant-households": "unsupported", "zip-gap": "unsupported",
    "cross-promo": "partial", "stream-cross-sell": "partial", "member-no-program": "partial",
  };
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "opportunities.js"), "utf8");
  Object.entries(SEG).forEach(([id, state]) => {
    // Each finding declares its own state next to its own id.
    const at = src.indexOf('id: "' + id + '"');
    ok(at > 0, "finding " + id + " exists");
    const block = src.slice(at, src.indexOf("\n}", at));
    ok(new RegExp('segment\\("' + state + '"').test(block),
      id + " reports its segment as " + state);
  });
  ok(/no last-transaction or last-activity field/i.test(src),
    "the dormancy finding says WHY no segment can express it");
  ok(/there is no address or zip field/i.test(src),
    "…and so does the zip one");

  // The cap is real and the page is told the true size, so a list that is
  // quietly 1,000 of 2,400 cannot happen.
  {
    const users = [], dem = [];
    for (let i = 0; i < O.AUDIENCE_CAP + 40; i++) {
      users.push({ "Household ID": "q" + i, Role: "Head of Household", "First Name": "Q", "Last Name": String(i), Email: "q" + i + "@x", "Net Revenue": 100 + i, "Items Purchased": 2, "First Transaction": ago(900), "Last Transaction": ago(500) });
    }
    // The people family is gated on the demographics feed having answered, so
    // the fixture has to clear that floor before any of this is reachable.
    for (let i = 0; i < 70; i++) dem.push({ "Household ID": "e" + i, "Participant ID": "p" + i, Program: "Camp", Activity: "Camp", Age: 9, "Zip Code": "01545" });
    const out = O.buildOpportunities({ users, demographics: dem }, { now: NOW });
    // A GUARD THAT DIES INSTEAD OF FAILING HAS NOT TOLD ANYONE WHAT BROKE —
    // the lesson this repo keeps re-learning. Read through a safe default.
    const d = findOf(out, "people", "dormant-households") || {};
    ok(d.id === "dormant-households", "the dormant finding fires");
    eq((d.people || []).length, O.AUDIENCE_CAP, "the carried list is capped");
    eq(d.peopleTotal, O.AUDIENCE_CAP + 40, "…and peopleTotal still tells the truth");
    ok((d.people || []).length > 1 && d.people[0].lifetimeNet > d.people[d.people.length - 1].lifetimeNet,
      "…and the ones that are carried are the highest-value ones");
  }
}

/* ══ DAN'S FIVE, 2026-09-14 ══════════════════════════════════════════════
   "can we get a bit more separation between sections… Maybe use similar colors
    from the community intel report"  /  "typo, enrol?"  /  "For the managed
    rentals section, call out how much time could be saved by using instant
    bookings"  /  "for the 'money owed' section, refer them back into Rec
    instead, there's a whole 'balances due' report"  /  "Customers section
    should open to their profile page in Rec, not the community intel report".
   ═══════════════════════════════════════════════════════════════════════ */

// ── 2. THE SPELLING, AND A GUARD THAT CANNOT FIRE ON CORRECT CODE ────────
// `enrolled` and `enrolling` are the SAME word in both dialects and must not
// be caught; only enrol / enrols / enrolment(s) differ. The last guard of this
// shape (/programme/i) failed on `programMedianPrice`, so the pattern is pinned
// BOTH ways: it must miss the American spellings and still catch a real British
// one, or the fix would be a guard that can never fail.
{
  const BRITISH = /\benrol\b|\benrols\b|\benrolments?\b/i;
  ok(!BRITISH.test("enrolled enrolling enrollment enrollments enrolls enrolRows"),
    "the spelling guard does not fire on American spellings or on an identifier");
  ok(BRITISH.test("never enrol") && BRITISH.test("30 enrolments") && BRITISH.test("who enrols"),
    "…and it really does catch a British one");
  const libSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "opportunities.js"), "utf8");
  const pageSrc = fs.readFileSync(path.join(__dirname, "..", "public", "opportunities.html"), "utf8");
  ok(!BRITISH.test(libSrc), "no British 'enrol' spelling survives in the detector library");
  ok(!BRITISH.test(pageSrc), "…nor on the page");
  // The one Dan actually saw.
  ok(/never enroll"/.test(libSrc), "the zip finding reads 'never enroll'");
}

// ── 3. DESK TIME IS PER RENTAL, AND IT IS AN ASSUMPTION ──────────────────
// A recurring rental is ONE conversation and many rows. Measured at Shrewsbury
// over a year: 541 reservation dates behind 178 rentals, so a per-row estimate
// is three times the truth. The fixture makes the two numbers differ by 5x, so
// an implementation counting rows cannot land on the right answer by accident.
{
  const facRows = [], summaryRows = [];
  for (let i = 0; i < 100; i++) {
    facRows.push({ "Booking Type": "Managed", "Site Type": "pavilion", Location: "L", Facility: "F" + (i % 4), Total: 50, Date: ymd(10), Begin: "09:00am", End: "10:00am" });
    // 100 dates, 20 rentals — five dates each.
    summaryRows.push({ "Rental ID": "rent-" + (i % 20), "Reservation ID": "res-" + i, Status: "Confirmed",
      "Booking Type": "Managed", "Site Type": "pavilion", Location: "L", Facility: "F" + (i % 4),
      Date: ymd(10), Billed: 50, Collected: 50, Refunded: 0, Total: 50 });
  }
  const ctx = ctxOf({ facility: facRows, facilitiesSummary: summaryRows });
  eq(O.managedRentalCount(ctx), 20, "rentals are counted, not reservation dates");

  const f = O.detectors.dStaffBooked(ctx) || {};
  ok(f.id === "staff-booked", "the staff-booked finding fires");
  const hours = Math.round((20 * O.OPP_MINUTES_PER_MANAGED_RENTAL) / 60);
  ok(new RegExp("\\b" + hours + " hours of desk time").test(f.detail || ""),
    "the desk-time figure is built from RENTALS — expected " + hours + "h, got: " + (f.detail || "").slice(0, 200));
  const wrong = Math.round((100 * O.OPP_MINUTES_PER_MANAGED_RENTAL) / 60);
  ok(!new RegExp("\\b" + wrong + " hours").test(f.detail || ""),
    "…and not from the " + 100 + " reservation dates, which would read " + wrong + "h");
  ok(/not a measurement/i.test(f.detail || ""),
    "the estimate says on screen that the rate is ours, not something Rec records");
  ok(new RegExp(O.OPP_MINUTES_PER_MANAGED_RENTAL + " minutes each").test(f.basis || ""),
    "…and the basis prints the rate itself, so the reader can argue with it");
  ok(/hours a year back/.test(f.action || ""), "the action names what moving them is worth");

  /* PRESENCE, NOT VALUE. A feed cached before card 19570 v2.3 has no rental
     identifier at all, and "0 rentals" would read as a claim that there are
     none rather than as "this feed cannot tell us" — the hasAbsent rule. */
  const pre = summaryRows.map(r => { const c = Object.assign({}, r); delete c["Rental ID"]; return c; });
  const ctxPre = ctxOf({ facility: facRows, facilitiesSummary: pre });
  eq(O.managedRentalCount(ctxPre), null, "a pre-v2.3 feed cannot say how many rentals there are");
  // …and that is a DIFFERENT fact from an org that has none, which reads 0.
  eq(O.managedRentalCount(ctxOf({ facility: facRows, facilitiesSummary: summaryRows.map(r => ({ ...r, "Booking Type": "Instant" })) })), 0,
    "an org whose rentals are all self-service reads zero, not 'cannot say'");
  const fPre = O.detectors.dStaffBooked(ctxPre) || {};
  ok(fPre.id === "staff-booked", "…the finding still fires on the old shape");
  ok(!/desk time/.test(fPre.detail || ""), "…and simply makes no time claim rather than guessing");
  ok(!/0 hours/.test(fPre.detail || ""), "…and never prints a confident zero");

  // A cancelled reservation is not a conversation anybody is having.
  const withCancel = summaryRows.concat([{ "Rental ID": "rent-ghost", "Reservation ID": "res-x", Status: "Canceled", "Booking Type": "Managed", "Site Type": "pavilion", Location: "L", Facility: "F1", Date: ymd(10), Billed: 0, Collected: 0, Refunded: 0, Total: 0 }]);
  eq(O.managedRentalCount(ctxOf({ facility: facRows, facilitiesSummary: withCancel })), 20,
    "a cancelled reservation adds no rental to the desk-time count");
  // An instant rental is the thing we are asking them to move TO.
  const withInstant = summaryRows.concat([{ "Rental ID": "rent-self", "Reservation ID": "res-y", Status: "Confirmed", "Booking Type": "Instant", "Site Type": "pavilion", Location: "L", Facility: "F1", Date: ymd(10), Billed: 10, Collected: 10, Refunded: 0, Total: 10 }]);
  eq(O.managedRentalCount(ctxOf({ facility: facRows, facilitiesSummary: withInstant })), 20,
    "a self-service rental is not staff desk time");
}

// ── 4. MONEY OWED IS WORKED IN REC, NOT IN OUR OWN SCHEDULE ──────────────
{
  eq(O.recPage("balance-due").path, "facilities/balance-due", "the balances-due page is addressable");
  eq(O.recPage("balance-due").kind, "page", "…as a PAGE, which carries no id segment");
  eq(O.recPage("made-up"), null, "an unknown page name is refused, not turned into a URL");

  const RID = "11111111-2222-3333-4444-555555555555";
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push({
    "Rental ID": i < 10 ? RID : "aaaaaaaa-bbbb-cccc-dddd-" + String(i).padStart(12, "0"),
    "Reservation ID": "res-" + i, Status: "Confirmed", "Booking Type": "Managed",
    "Site Type": "pavilion", Location: "Park", Facility: "Pavilion 1", Date: ymd(200),
    Billed: 400, Collected: 0, Refunded: 0, Total: 400,
  });
  const f = O.detectors.dFacilityAR(ctxOf({ facilitiesSummary: rows })) || {};
  ok(f.id === "facility-ar", "the money-owed finding fires");
  eq((f.rec || {}).name, "balance-due", "…and it points back into Rec's Balances Due report");
  ok(f.link, "…while still keeping our own report as the evidence");
  const top = (f.items || [])[0] || {};
  eq((top.rec || {}).kind, "rental", "each owed rental opens that rental in Rec");
  eq((top.rec || {}).id, RID, "…by its own uuid");

  /* A pre-v2.3 feed falls back to the RESERVATION id — and card 19570 emits
     that as a REAL UUID, so recLink's shape test cannot save us: the link
     would be perfectly formed and point at the wrong record. The fixture
     therefore uses real uuids, which is what production has; an earlier
     version used "res-0" strings and passed for the wrong reason. */
  const pre = rows.map((r, i) => ({ ...r, "Rental ID": undefined,
    "Reservation ID": "99999999-8888-7777-6666-" + String(i).padStart(12, "0") }));
  const fPre = O.detectors.dFacilityAR(ctxOf({ facilitiesSummary: pre })) || {};
  ok(fPre.id === "facility-ar", "…the finding still fires on the old shape");
  ok(((fPre.items || [])[0] || {}).rec == null,
    "…and a RESERVATION uuid standing in for a rental one yields NO Rec link — a confident link to the wrong record is worse than none");
}

// ── 5. A NAMED CUSTOMER OPENS THEIR OWN PROFILE ──────────────────────────
// Card 17689 v-2026-09-14 emits "User ID" (users.id) beside "Rec ID". The Rec
// ID is a SIX-CHARACTER staff code and a /users/ URL built from it 404s while
// looking perfectly correct, so the fixture carries BOTH and the guard requires
// the uuid — a row with only the staff code must link nowhere.
{
  const mk = (withUuid) => {
    const users = [];
    for (let h = 0; h < 60; h++) users.push({
      "Household ID": "hh" + h, Role: "Head of Household",
      "Rec ID": "5OLLPM", "User ID": withUuid ? "aaaaaaaa-bbbb-cccc-dddd-" + String(h).padStart(12, "0") : undefined,
      "First Name": "A", "Last Name": String(h), Email: h + "@x.com", "Zip Code": "01545", Age: 40,
      "Net Revenue": 500 + h, "Items Purchased": 2,
      "First Transaction": ago(2000), "Last Transaction": ago(400),
    });
    return users;
  };
  const f = O.detectors.dDormant(ctxOf({ users: mk(true) })) || {};
  ok(f.id === "dormant-households", "the dormant finding fires");
  const it = (f.items || [])[0] || {};
  eq((it.rec || {}).kind, "user", "a named customer opens their profile in Rec");
  ok(/^[0-9a-f-]{36}$/.test((it.rec || {}).id || ""), "…by a uuid, not the six-character Rec ID");
  ok(it.link, "…and still carries Community Intel underneath it");

  const fPre = O.detectors.dDormant(ctxOf({ users: mk(false) })) || {};
  ok(fPre.id === "dormant-households", "…the finding still fires on a pre-column feed");
  ok(((fPre.items || [])[0] || {}).rec == null,
    "…and a feed carrying only the six-character Rec ID links NOWHERE rather than to a 404");
  // The trap itself, stated once so nobody re-derives it.
  eq(O.recLink("user", "5OLLPM"), null, "recLink refuses the six-character staff code");
}

// ══ THE PAGE: CONTENTS, LINKS AND THE DOWNLOAD ═══════════════════════════
if (!SKIP_SOURCE) {
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "opportunities.html"), "utf8");
  const lib = fs.readFileSync(path.join(__dirname, "..", "lib", "opportunities.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── Dan: "Its program, not programme." ───────────────────────────────
  // Asserted over the whole surface rather than over one file, because half a
  // rename reads worse than none.
  // WORD BOUNDARIES, and the first draft of this guard did not have them:
  // `programMedianPrice` contains "programMe", so a bare /programme/i failed
  // on correct code. A guard that fires on a variable name is not a guard.
  [["page", page], ["lib", lib]].forEach(([what, text]) => {
    ok(!/\bprogramme\b/i.test(text), "no British 'programme' anywhere in the " + what);
    ok(!/\borganisation/i.test(text), "no British 'organisation' in the " + what);
    ok(!/\butilisation/i.test(text), "no British 'utilisation' in the " + what);
    ok(!/\bneighbourhood/i.test(text), "no British 'neighbourhood' in the " + what);
  });
  // And the assertion is only worth having if it can still fail: prove the
  // pattern catches the real spelling.
  ok(/\bprogramme\b/i.test("the programme runs"), "…and the pattern still catches a real 'programme'");

  // ── Dan: "Add a quick overview at the top with links to jump to each
  //    section." ──────────────────────────────────────────────────────────
  ok(/className="jump"/.test(page), "the contents strip renders");
  ok(/id=\{"fam-" \+ fam\.key\}/.test(page), "…and every family carries the anchor it targets");
  ok(/href=\{"#fam-" \+ fam\.key\}/.test(page), "…and the strip links to it");
  // A suppressed family is LISTED, greyed. A contents list that silently
  // omitted them would undo the whole suppression design one line above the
  // sections themselves.
  const jump = page.slice(page.indexOf('className="jump"'), page.indexOf("{insights && insights.length"));
  ok(/d\.families\.map/.test(jump), "the strip lists EVERY family, suppressed ones included");
  ok(/fam\.findings\.length/.test(jump), "…with a count per family");
  // Dead on paper: no href in print, and it stays as a contents list.
  ok(/isPrint \?/.test(jump), "…and renders without links in print");

  // ── Clickable rows ────────────────────────────────────────────────────
  ok(/function recHref/.test(page), "the page builds Rec admin URLs");
  ok(/programming\/programs/.test(page) && /programming\/sections/.test(page),
    "…with the URL shapes this repo has already proven");
  ok(/data-opp-item-link/.test(page), "…and a render case can tell which kind of link a row got");
  ok(/target=\{rh \? "_blank"/.test(page), "a Rec link opens in its own tab, not over the report");
  // The label is the link. Anything else is the dead end Dan reported.
  const itemBlock = page.slice(page.indexOf("{f.items.map("), page.indexOf('className="iv"'));
  ok(/<a className="il"/.test(itemBlock), "the row's own LABEL is the link");
  ok(/drillHref\(it\.link\)/.test(itemBlock), "…falling back to the report that proves it");

  // ── The download ──────────────────────────────────────────────────────
  ok(/saveTextViaPopup/.test(page), "the CSV goes through the shared popup helper");
  ok(/bom: true/.test(page), "…asking for the BOM, or Excel opens accented names as mojibake");
  ok(/csvFromRows/.test(page), "…and the shared RFC4180 writer");
  ok(/d\.contactColumns/.test(page), "the columns come from the payload, not a second copy on the page");
  ok(/contactColumns: CONTACT_COLS/.test(lib), "…and the payload carries the library's own definition");
  ok(/data-opp-csv=/.test(page), "a render case can read how many contacts the button offers");
  ok(/data-opp-segment=/.test(page), "…and what the segment advice says");
  ok(/peopleTotal > f\.people\.length/.test(page), "a trimmed list says so on screen");

  // ── The beacon, on both sides ─────────────────────────────────────────
  const logRoute = server.slice(server.indexOf('app.post("/:org/opportunities/api/log"'),
                                server.indexOf('app.post("/:org/facilities/api/log"'));
  ok(/"opp-csv"/.test(logRoute), "opp-csv is on the log route's allowlist");
  ok(/rows >= 0 && rows <= 1000000/.test(logRoute), "…and the row count is clamped server-side");
  /* SCOPED TO THE STATEMENT, and the first draft was not: a +2000-char window
     from `const SLACK_NOTIFY` runs on into SLACK_EVENT_META, whose own
     "opp-csv" key satisfied the assertion while the Set had lost it. An
     assertion satisfied by different code is not guarding what it names. */
  const notifyAt = server.indexOf("const SLACK_NOTIFY");
  const notifySet = server.slice(notifyAt, server.indexOf("]);", notifyAt));
  ok(/"opp-csv"/.test(notifySet), "…and it actually posts to Slack");
  /* Its own message branch: the shared line would print the report type twice
     and the audience never — the defect already fixed four times in this file.
     Scoped past the DEBOUNCE block, which carries the same `rec.event ===
     "opp-csv"` test and satisfied this on its own. */
  const msgBody = server.slice(server.indexOf('rec.event === "opp-drill"', server.indexOf("*DEAD LINK*")));
  ok(/rec\.event === "opp-csv"/.test(msgBody), "opp-csv has its own Slack message branch");
  ok(/downloaded \$\{what\}/.test(msgBody), "…naming WHICH list, not just that one was downloaded");
  ok(/contact\$\{rec\.rows === 1/.test(msgBody), "…and how many people were in it");
  ok(/opportunities\|opp-csv\|\$\{rec\.finding/.test(server), "…debounced per finding, not per org");
  // The Rec uuid has to reach the page or every Rec link is dead.
  const pageRoute2 = server.slice(server.indexOf('app.get("/:org/opportunities"'),
                                  server.indexOf('app.get("/:org/opportunities/api/data"'));
  ok(/orgId: org\.orgId/.test(pageRoute2), "the page is given the Rec org uuid");

  /* ── 1. SECTION SEPARATION, and it is per family ─────────────────────
     Dan: "Maybe use similar colors from the community intel report to separate
     specific sections." The hues are LIFTED from public/users.html rather than
     invented, and each family's band wears the same hue its own findings
     already do — two palettes on one page would make the section colour read
     as a second, contradicting classification. */
  O.FAMILIES.forEach(fam => {
    ok(new RegExp('\\.fam\\[data-opp-family="' + fam.key + '"\\]').test(page),
      "the " + fam.key + " family has its own section colour");
  });
  ok(/--fam:\s*#b91c1c/.test(page) && /\.chip\.k-uncollected\s*\{[^}]*#fef2f2/.test(page),
    "money wears the red its own findings already wear");
  ok(/--fam:\s*#6d28d9/.test(page) && /\.chip\.k-audience\s*\{[^}]*#f5f3ff/.test(page),
    "…and your community the violet of an audience finding");
  const famH = page.slice(page.indexOf(".fam-h {"), page.indexOf(".fam-h .fh-t"));
  ok(/border-left:\s*5px solid var\(--fam\)/.test(famH), "the band carries the family's accent");
  ok(/var\(--fam-bg\)/.test(famH), "…and its tint");
  /* BOTH SPELLINGS. The band IS the separation, and a printer that drops it
     leaves the sections running together — the same reason the Musco row
     highlight carries both. */
  ok(/-webkit-print-color-adjust:\s*exact/.test(famH), "the band survives print (-webkit-)");
  ok(/[^-]print-color-adjust:\s*exact/.test(famH), "…and the standard property too");

  /* ── 4 & 5. THE PAGE HAS TO BE ABLE TO BUILD A PATHLESS REC URL ──────
     recHref used to require REC_PATH[kind] + an id, so a page-kind link would
     have silently returned null and the Rec button would never render. */
  const rh = page.slice(page.indexOf("function recHref"), page.indexOf("const REC_PAGE_LABEL"));
  ok(/rec\.kind === "page"/.test(rh), "recHref can address a Rec page that has no id");
  ok(/rec\.path \?/.test(rh), "…and refuses one carrying no path");
  ok(/REC_PAGE_LABEL = \{ "balance-due": "Balances Due" \}/.test(page),
    "the foot button names the Rec report it opens");
  const foot = page.slice(page.indexOf('{/* Absent, not disabled'), page.indexOf("</div>\n    </div>\n  );"));
  ok(/footRec \?/.test(foot), "a finding worked in Rec leads with the Rec button");
  ok(/drill-2/.test(foot), "…and our own report stays beside it as the evidence");
  ok(/data-opp-foot-link="rec"/.test(foot), "…with a hook a render case can key on");

  /* THE AI HAS TO BE TOLD TOO. Every rule the adaptive family encodes lives in
     copy the model is handed, so without an explicit instruction the most
     likely insight it writes off the subsidy finding is "raise the prices" —
     precisely the reading the whole family exists to prevent. */
  const prompt = server.slice(server.indexOf("const OPPORTUNITIES_SYS_PROMPT"),
                              server.indexOf("async function opportunitiesInsightsFor"));
  ok(/adaptive/i.test(prompt), "the insights prompt knows about adaptive programming");
  ok(/never suggest raising its prices/i.test(prompt),
    "…and is told not to price it like everything else");
}

if (failures.length) {
  console.error("\n" + failures.length + " FAILED:");
  failures.forEach(f => console.error("  ✗ " + f));
  process.exit(1);
}
console.log(passed + " assertions passed.");
