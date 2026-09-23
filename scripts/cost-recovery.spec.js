#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   COST RECOVERY / P&L — guards

   EVERY DEFECT THIS REPORT CAN HAVE IS ARITHMETIC ABOUT A SHARE OR A
   THRESHOLD, and a regex over an inverted comparison passes. So this LIFTS
   AND RUNS the page's own helpers rather than reading them, and boots a real
   server for the store half — a regex over our own patch is not evidence the
   routes behave.

   SKIP_SOURCE=1 drops the source assertions, so the live half can be shown to
   catch a regression on its own.
   ═══════════════════════════════════════════════════════════════════════ */
const fs   = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const os = require("os");

let passed = 0; const failures = [];
function ok(cond, msg) { if (cond) passed++; else failures.push(msg); }
function eq(a, b, msg) { ok(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
// Read through a safe default: a route answering the wrong shape must FAIL BY
// NAME, not die on a bare TypeError that names nothing. Recorded in CLAUDE.md
// after exactly that killed a run.
function costOf(res, key) { return (((res || {}).json || {}).costs || {})[key] || {}; }
function nCosts(res) { return Object.keys((((res || {}).json || {}).costs) || {}).length; }
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, `${msg} — expected ~${b} (±${tol}), got ${a}`);
}
// A throw at CALL time must fail BY NAME rather than killing the run with a
// bare stack naming nothing. Recorded in CLAUDE.md after a lift died that way.
function guard(msg, fn) { try { return fn(); } catch (e) { failures.push(`${msg} — THREW: ${e.message}`); return undefined; } }

const PAGE   = fs.readFileSync(path.join(__dirname, "..", "public", "cost-recovery.html"), "utf8");
const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ── LIFT: the first <script> block is pure, module-scope helpers on purpose ──
const first = PAGE.indexOf("<script>");
const end   = PAGE.indexOf("</script>", first);
ok(first > -1 && end > first, "the page's helper block was found");
const lifted = PAGE.slice(first + "<script>".length, end);
ok(/function crShare/.test(lifted) && /function crRollup/.test(lifted),
   "the lifted block carries the helpers — if this fails every assertion below is vacuous");

const H = {};
guard("lifting the helper block", () => {
  // eslint-disable-next-line no-new-func
  new Function(lifted + `
    ;this.crFyOf=crFyOf;this.crPeriods=crPeriods;this.crShare=crShare;this.crDays=crDays;
    this.crRecovery=crRecovery;this.crChipState=crChipState;this.crRollup=crRollup;
    this.crCostedSum=crCostedSum;
    this.crRecoveryTone=crRecoveryTone;this.crTierVerdict=crTierVerdict;
    this.crCostByCat=crCostByCat;this.crLedgerBreakdown=crLedgerBreakdown;
    this.CR_STATE_ORDER=CR_STATE_ORDER;
    this.crCostDollars=crCostDollars;this.crLedgerSlice=crLedgerSlice;this.crMoney=crMoney;this.crPctText=crPctText;
    this.CR_TIERS=CR_TIERS;this.CR_CATS=CR_CATS;`).call(H);
});

// ── the fiscal year ────────────────────────────────────────────────────
// Massachusetts has run a July–June municipal fiscal year since 1974, and
// Shrewsbury is on it. July is the FIRST month of the NEXT year's FY, which is
// the off-by-one that would put every summer camp in the wrong year.
eq(H.crFyOf("2026-07-01"), 2027, "July 1 opens the next fiscal year");
eq(H.crFyOf("2026-06-30"), 2026, "June 30 closes the current one");
eq(H.crFyOf("2026-12-31"), 2027, "December sits in the FY that opened in July");
eq(H.crFyOf("2026-01-01"), 2026, "January sits in the FY that opened last July");

// ── periods ────────────────────────────────────────────────────────────
const fys = guard("crPeriods fy", () => H.crPeriods("fy", [], "2025-08-01", "2026-09-30")) || [];
eq(fys.length, 2, "two fiscal years span Aug 2025 to Sep 2026");
eq(fys[0].v, "FY2026", "the first is FY2026");
eq(fys[0].s, "2025-07-01", "FY2026 opens on July 1 2025");
eq(fys[1].e, "2027-06-30", "FY2027 closes on June 30 2027");

const qs = guard("crPeriods quarter", () => H.crPeriods("quarter", [], "2026-07-01", "2026-12-31")) || [];
eq(qs.length, 4, "one fiscal year is four quarters");
eq(qs[0].v, "FY2027 Q1", "Q1 is the July quarter");
eq(qs[0].s, "2026-07-01", "Q1 opens July 1");
eq(qs[2].s, "2027-01-01", "Q3 opens in January");

// MONTHS ARE STEPPED ON INTEGERS, never by adding days to a Date — a bare ISO
// string through new Date() is UTC midnight and lands on the previous day west
// of UTC, which is five recorded instances in CLAUDE.md.
const ms = guard("crPeriods month", () => H.crPeriods("month", [], "2026-11-15", "2027-02-03")) || [];
eq(ms.length, 4, "Nov through Feb is four months, across the year boundary");
eq(ms[0].v, "2026-11", "the first month is November 2026");
eq(ms[1].e, "2026-12-31", "December ends on the 31st");
eq(ms[2].v, "2027-01", "the list rolls into the next calendar year");
eq(ms[3].e, "2027-02-28", "February 2027 ends on the 28th");
const feb = guard("leap February", () => H.crPeriods("month", [], "2028-02-01", "2028-02-29")) || [];
eq(feb[0].e, "2028-02-29", "a leap February ends on the 29th");

// ── the slice ──────────────────────────────────────────────────────────
const P = { season: "Fall '26", start: "2026-08-01", end: "2026-12-31" };

// A SEASON IS ALL OR NOTHING. Half a season is not a thing anybody asks for,
// and a season is the unit a season is judged on.
eq(H.crShare(P, { v: "Fall '26" }, "season"), 1, "a program in the season counts whole");
eq(H.crShare(P, { v: "Spring 26" }, "season"), 0, "a program in another season counts not at all");

// PRO-RATA over the days the program runs. 2026-08-01..2026-12-31 is 153 days;
// Jul–Sep overlaps on 61 of them.
const q1 = { v: "FY2027 Q1", s: "2026-07-01", e: "2026-09-30" };
const q2 = { v: "FY2027 Q2", s: "2026-10-01", e: "2026-12-31" };
near(H.crShare(P, q1, "quarter"), 61 / 153, 1e-9, "Q1 takes the 61 days that overlap");
near(H.crShare(P, q2, "quarter"), 92 / 153, 1e-9, "Q2 takes the other 92");
// THE PARTS SUM TO THE WHOLE. A share scheme whose slices do not add to 1 moves
// money into or out of existence as the reader changes period, which is the one
// failure a P&L cannot have.
near(H.crShare(P, q1, "quarter") + H.crShare(P, q2, "quarter"), 1, 1e-9,
     "the quarters a program spans sum to exactly the whole program");
eq(H.crShare(P, { v: "x", s: "2027-01-01", e: "2027-03-31" }, "quarter"), 0,
   "a quarter the program does not touch takes nothing");

// AN UNDATED PROGRAM CANNOT BE PLACED IN A DATE PERIOD. It returns 0 so the
// caller can COUNT it and say how many were left out — silently dropping them
// is how a total stops reconciling with the season view beside it.
eq(H.crShare({ season: "Fall '26", start: null, end: null }, q1, "quarter"), 0,
   "a program with no dates lands in no date period");
eq(H.crShare({ season: "Fall '26", start: null, end: null }, { v: "Fall '26" }, "season"), 1,
   "...but it still counts whole in its own season");

// ── recovery ───────────────────────────────────────────────────────────
// null, NEVER 0. "Not costed yet" and "recovers nothing" are different facts.
eq(H.crRecovery(1000, null), null, "no cost yields no percentage, not 0%");
eq(H.crRecovery(1000, 0), Infinity, "revenue against a zero cost is not a percentage");
eq(H.crRecovery(0, 0), null, "no money either way yields nothing to state");
eq(H.crRecovery(700, 800), 87.5, "700 against 800 is 87.5%");

/* ── A RATE IS TAKEN OVER THE PROGRAMMES THAT CARRY A COST ──────────────
   Dan opened Shrewsbury's report with 82 programmes and a cost typed on two:
   the Total row read $202,024 against $7,378 and printed a recovery of 2738%,
   the KPI strip said the same, and every tier bar was drawn the same way.
   Revenue summed over all 82, cost over the two — two populations in one
   ratio, the fee worksheet's own bug one report over.

   Three reducers had their own copy of that sum, which is why it shipped.
   crCostedSum is the one predicate now, and these run it rather than reading
   it: every defect here is a comparison, and a regex passes on an inverted
   one. */
const cs = guard("crCostedSum over a part-costed portfolio", () => H.crCostedSum([
  { rev: 20000, cost: 50000 },   // costed
  { rev: 10000, cost: null },    // not costed — the one the bug counted
  { rev: 3000,  cost: 10000 },   // costed
])) || {};
eq(cs.rev, 23000, "only the costed programmes' revenue enters the numerator");
eq(cs.cost, 60000, "the denominator is those same programmes' cost");
eq(cs.n, 2, "and the count travels with them, so the page can name the population");
eq(guard("crCostedSum recovery", () => H.crRecovery(cs.rev, cs.cost)), 38.333333333333336,
   "23,000 against 60,000 is 38% — the shipped build divided 33,000 by 60,000 and said 55%");

const csNone = guard("crCostedSum with nothing costed", () => H.crCostedSum([
  { rev: 10000, cost: null }, { rev: 5000, cost: undefined },
])) || {};
eq(csNone.rev, 0, "nothing costed contributes no revenue");
eq(csNone.n, 0, "...and no programmes");
eq(guard("crCostedSum recovery with nothing costed", () => H.crRecovery(csNone.rev, csNone.cost)), null,
   "which yields no percentage rather than 0%");
eq(guard("crCostedSum on an empty period", () => (H.crCostedSum([]) || {}).n), 0,
   "an empty period is zero, not a throw");
eq(guard("crCostedSum on a malformed row", () => (H.crCostedSum([null, undefined, { rev: 1, cost: 2 }]) || {}).n), 1,
   "a malformed row is skipped rather than throwing");

/* The three readers, each SCOPED to its own function — a file-wide test is
   satisfied by whichever one still happens to call the helper. */
function slice(src, from, to, label) {
  const i = src.indexOf(from);
  ok(i > -1, label + ": the slice's start was found, or every assertion over it is vacuous");
  if (i < 0) return "";
  const j = src.indexOf(to, i + from.length);
  ok(j > -1, label + ": the slice's end was found");
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

const totalsFn = slice(PAGE, "function totals(d) {", "window.__crSliceFor", "totals");
ok(/crCostedSum\(d\.rows\)/.test(totalsFn),
   "totals takes its net and its rate over the costed programmes");
ok(/t\.net = c\.rev - t\.cost/.test(totalsFn) && !/t\.net = t\.rev - t\.cost/.test(totalsFn),
   "...so the portfolio net is not all-programme revenue less a partial cost");
ok(/t\.recovery = crRecovery\(c\.rev, t\.cost\)/.test(totalsFn),
   "...and the rate goes through crRecovery, so it cannot disagree with a row cell about a zero cost");
ok(/t\.rev \+= r\.rev/.test(totalsFn),
   "the REVENUE COLUMN's own total is still every row — the fix must not shrink the column");

const footFn = slice(PAGE, "function renderTableFoot(d, dB) {", "function patchRow", "renderTableFoot");
ok(/var t = totals\(d\)/.test(footFn),
   "the Total row reads the one reducer rather than summing the rows a second way");
ok(/var split = t\.blank > 0 && t\.costed > 0/.test(footFn),
   "the second row appears only while some programmes are costed and some are not");
ok(/split \?[\s\S]{0,120}\\u2014<\/td>/.test(footFn) || /split \?[\s\S]{0,120}—<\/td>/.test(footFn),
   "the Total row withholds the net and the rate it cannot make from two populations");
ok(/Costed \\u00b7|Costed ·/.test(footFn),
   "...and the row that carries them names how many programmes they are over");

const tiersFn = slice(PAGE, "function renderTiers(d) {", "var CHIP", "renderTiers");
/* A PYRAMID STANDS ON ITS BASE. GreenPlay puts community benefit at the bottom
   and individual benefit at the apex, so the ladder runs 4 down to 1 — the
   opposite of the order it shipped in, and invisible to any assertion keyed on
   an attribute rather than on position. */
ok(/\[4, 3, 2, 1\]\.map/.test(tiersFn),
   "the ladder is drawn from the apex down to the base, which is what a pyramid is");
ok(/crTierVerdict\(rec, T\)/.test(tiersFn),
   "each tier says in words where it landed, rather than leaving four bars to be decoded");
ok(/data-cr-pyverdict/.test(tiersFn),
   "and the panel reads this org's own numbers back against the model");
ok(/if \(r\.cost !== null\) \{ a\.rev \+= r\.rev/.test(tiersFn),
   "a tier's bar counts revenue only with its own cost beside it");
ok(!/a\.rev \+= r\.rev; a\.n\+\+/.test(tiersFn),
   "...so a tier of twenty programmes with one costed cannot draw a bar out of all twenty's revenue");
ok(/crRecovery\(a\.rev, a\.cost\)/.test(tiersFn),
   "and the tier rate goes through the same helper as everything else");

/* THE FREE-PROGRAMME FILTER, and the one rule that makes it safe. Dan asked
   to hide the $0 wall — 37 of Shrewsbury's 82 programmes charge nothing — and
   named the limit in the same breath: "There still might be associated costs,
   so I don't want to exclude them." So a free programme somebody HAS costed
   survives the checkbox; it is pure subsidy, the most interesting line the
   report draws, and hiding it would take real money off the page. */
const sliceFn = slice(PAGE, "function sliceFor(per) {", "function totals(d) {", "sliceFor");
ok(/hideFree && p\.revenue === 0 && cd === null/.test(sliceFn),
   "hiding free programmes spares any that carry a cost — the filter tests BOTH");
ok(/hidFree\+\+|hidFree \+= 1/.test(sliceFn),
   "...and counts what it took out, because an exclusion nobody can see is how a total stops being trusted");
ok(/sortRows\(out\)/.test(sliceFn),
   "the reader's sort is applied in sliceFor, so the CSV and the statement come out in the order on screen");

const footCount = slice(PAGE, "function renderTableFoot(d, dB) {", "function patchRow", "renderTableFoot2");
ok(/d\.hidFree \?/.test(footCount),
   "and the row count NAMES the hidden programmes rather than silently shrinking the table");

/* NULLS LAST IN BOTH DIRECTIONS. An uncosted programme has no net and no
   recovery, and sorting it as zero files the whole uncosted wall at one end of
   a money column as though somebody had measured it. */
const sortFn = slice(PAGE, "function sortRows(out) {", "function sliceFor(per) {", "sortRows");
ok(/if \(xn\) return 1;/.test(sortFn) && /if \(yn\) return -1;/.test(sortFn),
   "a row that cannot answer sorts last whichever way the column is pointing");
ok(/sortDir/.test(sortFn), "and the direction is applied to the comparison rather than to the array");

const kpiFn = slice(PAGE, "function renderKpis(d, dB) {", "function renderTiers", "renderKpis");
/* THE STRIP'S COLOURS. `in` and `out` are proven in a browser (only a resolved
   cascade can say whether the tint beat the skin); the surplus/shortfall
   mapping is proven HERE and named as a source assertion, because every period
   in the render fixture runs at a shortfall, so no case can show the amber. */
eq((kpiFn.match(/"net" : "bad"/g) || []).length, 3,
   "all three strip branches paint a surplus amber and a SHORTFALL red — a shortfall " +
   "wearing the surplus colour is the one thing this strip must not do");
eq((kpiFn.match(/crRecoveryTone\(t\.recovery, t\.target\)/g) || []).length, 3,
   "...and all three judge the recovery tile against the pyramid's blended target");
ok(/"in"\)/.test(kpiFn) && /"out" : ""/.test(kpiFn),
   "revenue reads as money in and costs as money out");
ok(/costedNote\(t, d\.rows\.length\)/.test(kpiFn),
   "the strip works out which programmes its net and rate are over");
eq((kpiFn.match(/note \? note/g) || []).length >= 3, true,
   "...and says so on the surplus and the recovery tiles rather than leaving it to be inferred");
ok(/fullRevOwn = t\.costedRev \+ L\.income/.test(kpiFn),
   "full-cost recovery takes the same population as direct recovery");
ok(/tile\("Revenue", crMoney\(fullRev\)/.test(kpiFn),
   "...while the Revenue tile still shows every programme's money, which is what the department took");

// ── ON TARGET IS INSIDE THE BAND, not above its midpoint ───────────────
// This is the defect a visual review caught in the mockup: tier 1 at 34% was
// painted under-target, when 34% sits squarely inside tier 1's 25–50% band and
// is exactly what tier 1 is for.
eq(H.crChipState(340, 1000, 1), "ok",   "tier 1 at 34% is inside its 25–50% band");
eq(H.crChipState(200, 1000, 1), "warn", "tier 1 at 20% is a little under its 25% floor");
eq(H.crChipState(100, 1000, 1), "bad",  "tier 1 at 10% is far enough under to be called out");
eq(H.crChipState(875, 1000, 3), "ok",   "tier 3 at 87.5% is inside 75–100%");
eq(H.crChipState(300, 1000, 4), "bad",  "tier 4 at 30% is far under 100–125%");
eq(H.crChipState(1400, 1000, 1), "over", "tier 1 at 140% is above its band, not merely fine");
eq(H.crChipState(1000, null, 3), "blank", "an uncosted program asks for a cost");
eq(H.crChipState(1000, 500, 0), "untiered", "no tier means no verdict, not a wrong one");
eq(H.crChipState(0, null, 0), "nofee", "a free program with no cost is neither good nor bad");

// ── the roll-up: PROGRAM x SEASON ──────────────────────────────────────
// 26% of Shrewsbury's programs recur across seasons. Keyed on the program
// ALONE, entering this winter's cost would silently rewrite the P&L of every
// season already closed — so the two rows below must NOT merge.
const rolled = guard("crRollup", () => H.crRollup([
  { programId: "p1", programName: "Swim", season: "Fall '26",   enrollments: 10, netRevenue: 1000, startDate: "2026-09-01", endDate: "2026-11-30", instructor: "Ana" },
  { programId: "p1", programName: "Swim", season: "Fall '26",   enrollments:  5, netRevenue:  500, startDate: "2026-10-01", endDate: "2026-12-31", instructor: "Bo, Ana" },
  { programId: "p1", programName: "Swim", season: "Winter 27",  enrollments:  8, netRevenue:  800, startDate: "2027-01-05", endDate: "2027-03-01", instructor: "Ana" },
  { programId: "p2", programName: "Yoga", season: "Fall '26",   enrollments:  4, netRevenue:  400, startDate: "2026-09-01", endDate: "2026-10-15", instructor: "" },
])) || [];
eq(rolled.length, 3, "two programs over two seasons roll up to three rows, not two");
const swimFall = rolled.filter(r => r.key === "p1|Fall '26")[0] || {};
eq(swimFall.revenue, 1500, "the season's sections sum into one program row");
eq(swimFall.enrolled, 15, "so do its enrolments");
eq(swimFall.sections, 2, "and it says how many sections it covers");
eq(swimFall.start, "2026-09-01", "the span opens on the EARLIEST section");
eq(swimFall.end, "2026-12-31", "and closes on the LATEST");
eq((swimFall.instructorList || []).join(","), "Ana,Bo", "instructors are de-duplicated across sections");
const swimWinter = rolled.filter(r => r.key === "p1|Winter 27")[0] || {};
eq(swimWinter.revenue, 800, "the SAME program in another season keeps its own money");

// ── cents in, dollars out ──────────────────────────────────────────────
// Rates and stored money are integer cents everywhere in this repo; a stored
// 149.99999 is a report a cent out for reasons nobody can find.
eq(H.crCostDollars({ instructors: 250000, staff: 50000 }), 3000, "cents add up and convert once");
eq(H.crCostDollars({}), null, "an empty record is NOT costed at zero");
eq(H.crCostDollars(null), null, "nor is a missing one");
eq(H.crCostDollars({ instructors: 0 }), null, "nor is one holding only zeroes");
eq(H.crMoney(null), "—", "a missing figure renders an em dash, never $0");
eq(H.crPctText(null), "—", "so does a missing percentage");

// ── the open-ended ledger ──────────────────────────────────────────────
// Jason at Windham: "add a series of 'open ended' rows where he can add
// expenses, profit, etc. Not tied to any program."
const LROWS = [
  { account: "Senior Trips", kind: "income",  amount: 120000, season: "Fall '26" },
  { account: "Senior Trips", kind: "expense", amount:  40000, season: "Fall '26" },
  { account: "Facilities",   kind: "expense", amount: 200000, season: "Fall '26" },
  { account: "Facilities",   kind: "expense", amount:  50000 },                      // no season, no dates
  { account: "Grants",       kind: "income",  amount: 100000, start: "2026-08-01", end: "2026-12-31" },
];
const Lseason = guard("crLedgerSlice season", () => H.crLedgerSlice(LROWS, { v: "Fall '26" }, "season")) || {};
eq(Lseason.income, 1200, "an income line counts as money in");
eq(Lseason.expense, 2400, "expense lines sum");
eq(Lseason.placed, 3, "three of the five land in Fall '26");
// UNPLACED IS COUNTED, NEVER SILENT. A row with no season and no dates cannot
// be put in a period, and a total that quietly omits it is how a budget sheet
// stops reconciling with the P&L beside it.
// TWO, not one: the unassigned line AND the dated Grants line, because in
// SEASON mode it is the season that places a row and Grants carries none. That
// is the rule being symmetric rather than a miscount — the same row is
// perfectly placeable one mode over.
eq(Lseason.unplaced, 2, "in season mode, every line without a season is counted as unplaced");

// A DATED row is pro-rated exactly as a program is, so one line of overhead
// cannot be counted twice by switching period.
const La = guard("ledger q1", () => H.crLedgerSlice(LROWS, q1, "quarter")) || {};
const Lb = guard("ledger q2", () => H.crLedgerSlice(LROWS, q2, "quarter")) || {};
near(La.income + Lb.income, 1000, 1e-6,
     "a dated line split across two quarters sums to exactly itself — never more, never less");
eq(La.expense, 0, "a season-only line lands in NO date period");
// ...and the season-only lines are then the unplaced ones, because in a date
// mode it is dates that place a row. The rule is symmetric on purpose.
eq(La.unplaced, 4, "in a date mode, every line without dates is the unplaceable one instead");
eq(Lb.placed, 1, "...and only the dated line lands in Q2");

// ── THE POLISH PASS, 2026-09-22 ──────────────────────────

/* A RECOVERY FIGURE IS NOT JUDGED AGAINST 100%, and this is the assertion that
   says why. Dan asked for "red is < 100, green > 100" and on this report that
   is the wrong line: tier 1 is MEANT to recover 25-50%, so a department
   running mostly community programming would be painted red for doing exactly
   what the pyramid asks of it. It is judged against the portfolio's own
   blended target instead — the figure the card's sub-line already prints. */
eq(H.crRecoveryTone(40, 35), "good",
   "40% against a target of 35% is GOOD, though it is nowhere near 100%");
eq(H.crRecoveryTone(88, 85), "good",
   "...and so is 88% against 85% — the case a build measuring against 100 paints red");
eq(H.crRecoveryTone(130, 35), "good", "well above target stays good");
eq(H.crRecoveryTone(28, 35), "net", "a near miss is the middle state, not a failure");
eq(H.crRecoveryTone(10, 35), "bad", "and 25 points under the target is bad");
eq(H.crRecoveryTone(null, 35), "", "nothing costed takes no colour rather than reading as a failure");
eq(H.crRecoveryTone(40, null), "",
   "and with NOTHING TIERED there is no target, so the tile takes no colour rather than " +
   "inventing a verdict about a portfolio nobody has classified");
eq(H.crRecoveryTone(Infinity, 35), "", "a rate over a zero cost is not a rate and gets no colour");

/* The plain-English verdict. ABOVE IS NOT WORDED AS A FAILURE: a tier 1
   programme recovering 90% is priced like a tier 3, which is worth knowing and
   is not a fault — the same distinction crChipState draws between `over` and
   `bad` one level down. */
eq((H.crTierVerdict(40, H.CR_TIERS[1]) || [])[0], "inband", "inside the band reads as inside the band");
eq((H.crTierVerdict(90, H.CR_TIERS[1]) || [])[0], "above", "above the band is its own state, not a failure");
eq((H.crTierVerdict(10, H.CR_TIERS[1]) || [])[0], "under", "and under the band is under");
ok(/40 pts above/.test((H.crTierVerdict(90, H.CR_TIERS[1]) || [])[1] || ""),
   "the verdict counts the points rather than leaving a reader to subtract");
eq((H.crTierVerdict(null, H.CR_TIERS[1]) || [])[0], "", "an uncosted tier gets no verdict at all");

/* DIRECT COST SPLIT FIVE WAYS, and the assertion that matters is that it TIES:
   crCostByCat's total has to equal what crCostDollars gives the strip, or the
   statement and the report it was generated from disagree about the same
   period. The predicate is the same one — only a finite positive value counts. */
const cbc = guard("crCostByCat", () => H.crCostByCat(
  [{ p: { key: "a" }, w: 1 }, { p: { key: "b" }, w: 0.5 }, { p: { key: "c" }, w: 1 }],
  { a: { instructors: 100000, staff: 50000 }, b: { supplies: 40000 } })) || { by: {} };
eq(Math.round(cbc.by.instructors), 1000, "a whole-period programme contributes its whole instructor cost");
eq(Math.round(cbc.by.staff), 500, "...and its staff cost");
eq(Math.round(cbc.by.supplies), 200, "a HALF-period programme contributes half of its supplies");
eq(Math.round(cbc.total), 1700, "the five categories sum to the direct cost the strip shows");
eq(cbc.uncosted, 1, "and a programme with no record is counted as uncosted rather than as a zero");
const cbcZero = guard("crCostByCat over a zeroed record",
  () => H.crCostByCat([{ p: { key: "a" }, w: 1 }], { a: { instructors: 0 } })) || {};
eq(cbcZero.uncosted, 1,
   "a record holding nothing but zeroes is UNCOSTED, exactly as crCostDollars reads it — " +
   "the two must agree or the statement counts a programme the strip does not");

/* ONE LEDGER BREAKDOWN, TWO READERS. The roll-up on the Overhead tab and the
   statement's overhead section both read this, because two reductions of the
   same lines is how they start reporting different overhead for one period. */
const lb = guard("crLedgerBreakdown", () => H.crLedgerBreakdown([
  { account: "Trips", category: "Grants",      kind: "income",  amount: 100000, season: "Fall '26" },
  { account: "Trips", category: "Staff wages", kind: "expense", amount: 40000,  season: "Fall '26" },
  { account: "Fleet", category: "Maintenance", kind: "expense", amount: 200000, season: "Fall '26" },
  { account: "Fleet", category: "Maintenance", kind: "expense", amount: 50000 },
], { v: "Fall '26", t: "Fall '26" }, "season")) || { byAcct: {}, byCat: {} };
eq(Math.round(lb.income), 1000, "income is summed across the placed lines");
eq(Math.round(lb.expense), 2400, "and the unplaced line is left out of the expense, not folded in");
eq(Math.round((lb.byAcct.Fleet || {}).exp), 2000, "the account roll-up carries only what landed in the period");
eq(Math.round((lb.byCat.Maintenance || {}).exp), 2000, "and so does the category roll-up");
eq((lb.accts || [])[0], "Fleet", "accounts are ordered by size, so the biggest line leads");

/* The Status column can only be sorted if a state has an ORDER, and the useful
   one is by how much attention a row wants rather than alphabetical. */
ok(H.CR_STATE_ORDER.bad < H.CR_STATE_ORDER.ok,
   "sorting Status ascending puts the programmes furthest under their band first");
ok(H.CR_STATE_ORDER.blank < H.CR_STATE_ORDER.ok,
   "...and an uncosted programme ahead of a healthy one");

/* The roll-up on screen and the statement share ONE reduction of the ledger.
   A second copy is how the account table and the overhead section start
   reporting different money for the same period. */
const rollFn = slice(PAGE, "function ledgerRollupHtml(ids, per, m) {", "function renderLedger", "ledgerRollupHtml");
ok(/crLedgerBreakdown\(/.test(rollFn),
   "the account roll-up reads the shared breakdown rather than summing the lines a second way");
ok(!/byAcct\[acct\] = byAcct\[acct\] \|\|/.test(rollFn),
   "...and does not keep its own copy of that reduction");
const stmtFn = slice(PAGE, "function renderStatement(d) {", "function setView(v) {", "renderStatement");
ok(/crLedgerBreakdown\(/.test(stmtFn) && /crCostByCat\(d\.rows, costs\)/.test(stmtFn),
   "the statement is built from the same reducers the screen uses, so it cannot disagree with it");
ok(/var t = totals\(d\)/.test(stmtFn),
   "...including the one that decides which programmes the net is over");

/* EVERY SAVED LINE CARRIES ITS DELETE. The old gate read three named fields,
   so a line someone had given only a category had no way out and looked stuck
   — and a delete nobody can find is the Fast Track pin over again, which is
   exactly how this was reported. */
const lrow = slice(PAGE, "function ledgerRowHtml(id, r, n) {", "/* THE ROLL-UP IS THE POINT", "ledgerRowHtml");
ok(/var saved = !!r;/.test(lrow),
   "a stored ledger row is known to be stored, rather than inferred from which fields are filled");
ok(/\+ "<td>" \+ \(saved/.test(lrow),
   "...and that is what decides whether the row can be deleted");
ok(!/r\.account \|\| r\.label \|\| r\.amount/.test(lrow),
   "so a line carrying only a category is no longer stuck on the page");
ok(/title="Delete this line"/.test(lrow),
   "and the control says what it does, because this one was reported as missing while it was on screen");

// ── server registration ────────────────────────────────────────────────
if (!process.env.SKIP_SOURCE) {
  const slice = (from, to) => {
    const a = SERVER.indexOf(from); if (a < 0) return "";
    const b = SERVER.indexOf(to, a); return b < 0 ? SERVER.slice(a) : SERVER.slice(a, b);
  };
  /* `slice` is SERVER-scoped. The PDF assertions below are about the PAGE, and
     a slice taken from the wrong file returns "" and passes every "must not
     contain" test vacuously — so they get their own, with a was-it-found
     assertion on each use. */
  const pslice = (from, to) => {
    const a = PAGE.indexOf(from); if (a < 0) return "";
    const b = PAGE.indexOf(to, a); return b < 0 ? PAGE.slice(a) : PAGE.slice(a, b);
  };

  // THE STANDING RULE: every new report ships HIDDEN. Dan, 2026-09-14: "by
  // default all new reports should be hidden unless I say otherwise."
  const dh = slice("const DEFAULT_HIDDEN_REPORTS", ";");
  ok(dh.length > 10, "DEFAULT_HIDDEN_REPORTS was found — otherwise the next assertion is vacuous");
  ok(/"cost-recovery"/.test(dh), "cost-recovery ships HIDDEN wherever it is offered");

  ok(/const REPORT_TYPES = \[[^\]]*"cost-recovery"/.test(SERVER),
     "cost-recovery is a real report type, so the admin toggle accepts it");

  /* ── TWO GATES, AND THEY ANSWER DIFFERENT QUESTIONS ────────────────────
     Dan, 2026-09-23: "add these two reports to shrewsbury and windham's org
     dashboard pages only, but keep them hidden, i'll toggle them on."

     COST_RECOVERY_ORGS decides which orgs get an EYE; DEFAULT_HIDDEN_REPORTS
     decides what that eye starts on. Asserting only the first would pass on a
     build that shipped the pilot orgs VISIBLE, and asserting only the second
     would pass on a build that put the card on all 29 dashboards — which is
     why both are pinned, and pinned together. */
  const cro = slice("const COST_RECOVERY_ORGS", ";");
  ok(cro.length > 10, "COST_RECOVERY_ORGS was found — otherwise the next assertions are vacuous");
  ok(/"shrewsbury"/.test(cro) && /"windham"/.test(cro), "the pilot is Shrewsbury and Windham");
  const croSlugs = (cro.match(/"[a-z0-9-]+"/g) || []);
  ok(croSlugs.length === 2, "…and ONLY those two — a third slug is a decision somebody has to justify");

  /* THE EYE STILL GOVERNS. Both gates on the org dashboard, in one condition:
     drop the second and the pilot orgs get a card they never asked to see. */
  ok(/if \(costRecoveryEnabled\(slug\) && !reportHiddenForOrg\(slug, 'cost-recovery'\)\) available\.push\('cost-recovery'\);/.test(SERVER),
     "the org dashboard needs BOTH the pilot gate and the inverted visibility gate");

  /* THE EYE HIDES, IT DOES NOT LOCK — the standing rule, and the one the first
     Opportunities build got wrong. The page route must NOT read either gate, or
     Dan cannot open his own admin card for an org he has not switched on. */
  const pageRoute = slice('app.get("/:org/cost-recovery"', "\n});");
  ok(pageRoute.length > 50, "the page route was found");
  ok(!/costRecoveryEnabled|reportHiddenForOrg/.test(pageRoute),
     "the PAGE is gated on neither — hiding a card must not lock the report");

  // The admin grid card that carries the toggle. Without it there is no eye and
  // the report cannot be turned on for anybody from the dashboard.
  ok(/toggleVis\('\$\{slug\}','cost-recovery'/.test(SERVER),
     "the admin grid renders a visibility toggle for it");
  ok(/const crHidden = reportHiddenForOrg\(slug, 'cost-recovery'\)/.test(SERVER),
     "…reading the inverted default, so a fresh org draws it as hidden");
  ok(/if \(costRecoveryEnabled\(slug\)\) \{\s*\n\s*const crHidden/.test(SERVER),
     "…and only for the pilot orgs, so the other 27 grow no row they can never use");

  /* THE CROSS-PROJECT API HAS TO AGREE. A card the org page never draws,
     reported visible to rec-dashboard, is the town-of-shrewsbury 404 in a new
     costume — so the entry is gated on the same pilot set. */
  const vis = slice('app.get("/api/org-visibility/:slug"', "\n});");
  ok(vis.length > 50, "the visibility API was found");
  ok(/costRecoveryEnabled\(slug\)/.test(vis) && /type: "cost-recovery"/.test(vis),
     "the visibility API reports cost-recovery, and only for the pilot orgs");

  /* ── THE PDF HAS TO SURVIVE A SANDBOXED IFRAME ────────────────────────
     Dan: "don't forget about the pdf printing issue for reports inside an
     iframe sandbox. I suspect the way you've implemented printing or pdfs
     here won't work." He was right — both buttons called window.print(), and
     a modal opened by a sandboxed frame is blocked with no error and no
     event. The house pattern is `openReportPdf`: a TOP-LEVEL POPUP navigating
     to a server-rendered PDF, which is never a download for the sandbox to
     refuse. Print stays beside it as the reader's own escape hatch when the
     page stands alone. */
  ok(/openReportPdf/.test(PAGE), "the PDF goes through openReportPdf, not window.print");
  ok(/<script src="\/open-pdf\.js">/.test(PAGE), "…and the page loads the file that defines it");
  /* SYNCHRONOUS, FROM THE CLICK HANDLER. Behind an await or a .then() the user
     gesture is gone and the browser blocks the popup — the rule open-pdf.js
     states at the top of itself. */
  const pdfClick = pslice('$("pdfBtn").addEventListener', "});");
  ok(pdfClick.length > 20, "the PDF click handler was found — otherwise the next assertion is vacuous");
  ok(/openPdf\(/.test(pdfClick) && !/await|\.then\(/.test(pdfClick),
     "the PDF button opens the popup straight from the click, with no await before it");
  ok(/if \(!window\.openReportPdf\) \{ window\.print\(\); return; \}/.test(PAGE),
     "…and falls back to print rather than being a dead button if the helper is absent");

  /* THE URL IS THE ONLY CHANNEL. A Puppeteer render opens this page fresh with
     an empty localStorage, so anything the PDF needs has to be in the query
     string — which is why a PDF route was worth nothing until the report's
     state lived there. */
  ["mode", "period", "tier", "view", "hide_blank", "hide_free"].forEach(k => {
    ok(new RegExp('Q\\.(get|has)\\("' + k.replace("_", "_") + '"\\)').test(PAGE)
       || new RegExp('q\\.set\\("' + k + '"').test(PAGE),
       "the page reads/writes `" + k + "` on the URL, or the PDF cannot carry it");
  });
  ok(/history\.replaceState/.test(PAGE) && !/history\.pushState/.test(PAGE),
     "the URL is REPLACED, not pushed — every keystroke in a cost box re-renders");
  const syncBlk = pslice("function syncUrl()", "\n  }");
  ok(syncBlk.length > 20, "syncUrl was found");
  ok(/if \(PRINT\) return;/.test(syncBlk),
     "…and the print page never writes one back: it is TOLD its state");

  /* #report-ready IS WHAT generatePdf WAITS 120s FOR, and the failure path has
     to stamp it too or a report whose feed did not answer costs two minutes
     and then a 500. */
  ok(/id = "report-ready"/.test(PAGE), "the page stamps #report-ready");
  const failBranch = pslice("showError(String(e && e.message || e));", "});");
  ok(failBranch.length > 20, "the failed-feed branch was found");
  ok(/markReady\(\)/.test(failBranch),
     "…on the FAILED-feed branch as well, or the PDF route hangs for two minutes");

  /* THE SERVER HALF. A render case at ?_print=1 proves the PAGE reads a
     parameter and says NOTHING about whether generatePdf sends it — which is
     exactly how gl_codes, refunds, pii and sites each shipped reaching the
     screen and not the PDF. So the query builder is LIFTED AND RUN. */
  const gp = SERVER.slice(SERVER.indexOf("async function generatePdf("));
  const qsBlock = gp.slice(gp.indexOf("const qsObj = {"),
    gp.indexOf("const qs = new URLSearchParams(qsObj);") + "const qs = new URLSearchParams(qsObj);".length);
  ok(qsBlock.includes("forEach"), "the generatePdf query block was found and is liftable");
  const buildQs = new Function("startDate", "endDate", "orgTok", "filters",
    qsBlock + "\nreturn qs.toString();");

  const full = buildQs("2026-07-01", "2026-09-23", "tok",
    { mode: "quarter", period: "FY2026 Q1", period_b: "FY2025 Q1", tier: "2",
      view: "statement", hide_blank: "1", hide_free: "1" });
  ["mode=quarter", "period=FY2026+Q1", "period_b=FY2025+Q1", "tier=2",
   "view=statement", "hide_blank=1", "hide_free=1"].forEach(want => {
    ok(full.indexOf(want) >= 0, "generatePdf forwards " + want + ". Got: " + full);
  });

  /* THE BOOLEANS TRAVEL ON PRESENCE — and a VALUE test cannot prove that,
     which is worth writing down rather than dressing up. The page spells them
     "1"/"0", and the string "0" is TRUTHY in JS, so folding them into the
     truthy loop passes this assertion and every one above it. Measured by
     mutation, not assumed: that fold SURVIVED until the source assertion below
     was added. It is the same thing `sitetype` already records one block up —
     a parameter that works by accident of its encoding is one rename from
     breaking silently, and the rename here is "0" -> "". */
  const off = buildQs("2026-07-01", "2026-09-23", "tok", { hide_blank: "0", hide_free: "0" });
  ok(/(^|&)hide_blank=0(&|$)/.test(off) && /(^|&)hide_free=0(&|$)/.test(off),
     "an explicit OFF must survive — dropped, the print page falls back to its "
     + "own default instead of the answer the reader gave. Got: " + off);
  // [source] The guard that actually holds the shape, because the value test above cannot.
  ok(/if \(filters\.hide_blank !== undefined\) qsObj\.hide_blank = filters\.hide_blank;/.test(SERVER)
     && /if \(filters\.hide_free !== undefined\) qsObj\.hide_free = filters\.hide_free;/.test(SERVER),
     "both booleans are forwarded on PRESENCE (!== undefined), never by the truthy "
     + "loop — which would keep working only while they are spelled \"0\" rather than \"\"");
  const none = buildQs("2026-07-01", "2026-09-23", "tok", {});
  ok(!/hide_blank=|hide_free=/.test(none),
     "…while ABSENT is not invented as a value: absent means the caller is not "
     + "speaking about it at all. Got: " + none);

  /* PRINT MODE COMES FROM THE REQUESTED VIEW, because Puppeteer never clicks
     the Print button that sets the class on screen. Without this the statement
     PDF carries the KPI strip — the bug one surface over, arriving by the
     other door. */
  ok(/if \(view === "statement"\) document\.body\.classList\.add\("printing-statement"\)/.test(PAGE),
     "a ?view=statement render prints the statement alone, with no click involved");
  ok(/body\.is-print \.toolbar/.test(PAGE),
     "…and ?_print=1 drops the chrome before the capture, not only in @media print");

  /* INVENTORY IS DELIBERATELY NOT SCOPED THE SAME WAY, and that is not an
     oversight. Its seed is keyed on Madison's ORGID and Madison is not
     onboarded here yet, so a slug allowlist would let the seed apply and the
     card still never render — silently undoing the report it was built for. */
  ok(!/INVENTORY_ORGS|inventoryReportOrgs/.test(SERVER),
     "inventory keeps the every-org-hidden shape, so Madison's orgId seed still lands");

  // NO CARD OF ITS OWN. It reads the programs card through the programs feed,
  // so a second health probe of the same card is the doubled load this file
  // already records — and a SHARED_UUIDS entry would give it a second cache key
  // for one card.
  const hs = slice("const HEALTH_SKIP_REPORTS", ";");
  ok(/"cost-recovery"/.test(hs), "cost-recovery is skipped by the health check — the programs card is probed once");
  const su = slice("const SHARED_UUIDS = {", "\n};");
  ok(su.length > 10, "SHARED_UUIDS was found");
  ok(!/cost-recovery/.test(su), "cost-recovery has NO card uuid of its own");
  ok(/\/programs\/api\/data/.test(PAGE), "the page reads the PROGRAMS feed, sharing its cache entry");

  // The page route gates on the programs card, since that is what it reads.
  const route = pageRoute;
  ok(/SHARED_UUIDS\.programs/.test(route), "the page route gates on the PROGRAMS card, which is what it needs");
  ok(/logEvent\(slug, "cost-recovery", "view"/.test(route), "opening the report is recorded");

  // Slack. An org typing what a program costs is the one number Rec does not
  // hold, so every save is worth seeing.
  const sn = slice("const SLACK_NOTIFY", ";");
  ok(/"cost-save"/.test(sn), "cost-save posts to Slack");
  ok(/"cost-csv"/.test(sn), "cost-csv posts to Slack");
  ok(/"cost-save":/.test(SERVER) && /"cost-csv":/.test(SERVER), "both carry an emoji and a verb");
  // NAME what moved. "Somebody saved costs" is the post that makes a feature
  // look busy and tells nobody anything.
  // Scoped to the MESSAGE branch. The first `rec.event === "cost-save"` in
  // server.js is the DEBOUNCE key chain, so an unscoped slice lands there and
  // the two assertions below pass on a build with no message branch at all.
  const branch = slice('} else if (rec.event === "cost-save") {', "} else if (rec.event === \"fee-alloc\")");
  ok(branch.length > 50 && /text =/.test(branch), "the cost-save MESSAGE branch was found");
  ok(/rec\.program/.test(branch), "the Slack line NAMES the program being costed");
  ok(/rec\.saved/.test(branch) && /rec\.removed/.test(branch),
     "and tells a save from a clear — they are different events");
  // Debounced PER PROGRAM: costing a morning's programs is a decision per
  // program, and the default org|report|event key would keep only the first.
  ok(/rec\.event === "cost-save"\s*\n?\s*\?\s*`\$\{rec\.org\}\|cost-recovery\|cost-save\|\$\{rec\.program/.test(SERVER),
     "cost-save debounces per PROGRAM, not per org");

  // The beacon rides the generic log route, which needs the event allowlisted —
  // a missing entry 400s and, being fire-and-forget, never complains. That trap
  // has bitten this repo four times.
  const allowed = slice('const ALLOWED = ["excel"', "];");
  ok(/"cost-csv"/.test(allowed), "cost-csv is on the generic log route's allowlist");

  // ── the store ────────────────────────────────────────────────────────
  // A LAZY path, never `const F = path.join(DATA_DIR, …)` at module scope: that
  // read is stale in db mode and its write lands on the container's own disk.
  ok(/function costRecoveryFile\(\)/.test(SERVER),
     "the store path is a FUNCTION — a module-scope const is read before the store is configured");
  ok(!/const COST_RECOVERY_FILE\s*=\s*path\.join/.test(SERVER),
     "...and is not also a module-scope const");

  const put = slice('app.put("/:org/cost-recovery/api/costs"', "\n});");
  ok(put.length > 100, "the PUT route was found");
  ok(/Object\.assign\(\{\}, all\[slug\] \|\| \{\}\)/.test(put),
     "the PUT MERGES into what is stored — a whole-document replace makes the second saver discard the first");
  ok(/patch\[k\] === null/.test(put), "an explicit null clears one program's cost");
  ok(/COST_MAX_KEYS/.test(put), "the document is bounded — anyone holding the token can write to it");
  ok(/logEvent\(slug, "cost-recovery", "cost-save"/.test(put), "a save is recorded");

  const get = slice('app.get("/:org/cost-recovery/api/costs"', "\n});");
  ok(/no-store/.test(get), "the costs read is no-store — an ETag'd list is how a saved figure appears not to save");
  ok(/Invalid token/.test(get) && /Invalid token/.test(put), "both halves check the org token");

  // EXPORTS RESPECT THE FILTERS — the standing rule.
  const csv = PAGE.slice(PAGE.indexOf('$("exportCsv")'));
  ok(/sliceFor\(per\)/.test(csv), "the CSV exports the SLICE on screen, not the whole feed");
  ok(/bom: true/.test(csv), "the CSV carries the BOM Excel needs to read an accented name");
}

// ── LIVE: boot a real server and drive the real routes ─────────────────
// No source assertion can see that a PUT and a GET agree about what is stored.
(async () => {
  if (process.env.SKIP_LIVE) { report(); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-spec-"));
  const PORT = 3994 + Math.floor(Math.random() * 4);
  const slug = "watertown";
  let token = "";
  const m = /watertown:\s*\{[\s\S]{0,400}?token:\s*"([^"]+)"/.exec(SERVER);
  if (m) token = m[1];
  ok(!!token, "the fixture org's token was read from ORGS — without it every live call 404s at the middleware");

  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dir, SKIP_PREWARM: "1",
      PREWARM_STARTUP_SKIP_MS: "999999999", SLACK_WEBHOOK_URL: "", NODE_ENV: "test",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", () => {}); srv.stderr.on("data", () => {});

  // THE TOKEN RIDES THE QUERY STRING. The global org-token middleware reads
  // req.query.token and nothing else, so a header-only call is 404'd by the
  // middleware before it ever reaches these routes — which is what the first
  // run of this spec spent sixteen assertions discovering.
  const tok = (p) => p.indexOf("/healthz") === 0 ? p
    : p + (p.indexOf("?") < 0 ? "?" : "&") + "token=" + encodeURIComponent(token);
  const call = (method, p, body) => new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: PORT, path: tok(p), method,
      headers: Object.assign({ "x-token": token }, data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
      (res) => { let b = ""; res.on("data", c => b += c); res.on("end", () => {
        let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, json: j, text: b, headers: res.headers });
      }); });
    req.on("error", () => resolve({ status: 0, json: null, text: "" }));
    if (data) req.write(data);
    req.end();
  });

  const up = async () => { for (let i = 0; i < 90; i++) {
    const r = await call("GET", "/healthz"); if (r.status === 200) return true;
    await new Promise(z => setTimeout(z, 250)); } return false; };

  try {
    ok(await up(), "the live server booted");

    const empty = await call("GET", `/${slug}/cost-recovery/api/costs`);
    eq(empty.status, 200, "an org that has never costed anything gets a 200, not an error");
    eq(nCosts(empty), 0, "...and an empty store");
    ok(/no-store/.test(String(empty.headers["cache-control"] || "")),
       "the response is no-store, so a save is visible on the next read");

    const w1 = await call("PUT", `/${slug}/cost-recovery/api/costs`,
      { costs: { "p1|Fall '26": { instructors: 250000, staff: 50000, tier: 3 } } });
    eq(w1.status, 200, "a cost saves");
    eq((w1.json || {}).saved, 1, "and says so");

    // THE MERGE IS THE WHOLE CONCURRENCY STORY. A second writer sending only
    // its own program must not discard the first one's.
    const w2 = await call("PUT", `/${slug}/cost-recovery/api/costs`,
      { costs: { "p2|Fall '26": { instructors: 100000 } } });
    eq(w2.status, 200, "a second program saves");
    const both = await call("GET", `/${slug}/cost-recovery/api/costs`);
    eq(nCosts(both), 2, "BOTH survive — a whole-document PUT would have dropped the first");
    eq(costOf(both, "p1|Fall '26").instructors, 250000, "the first writer's figure is intact");
    eq(costOf(both, "p1|Fall '26").tier, 3, "and so is its tier");

    // Zeroing every box is a CLEAR, not a no-op — otherwise the screen and the
    // store disagree on the next reload.
    const z = await call("PUT", `/${slug}/cost-recovery/api/costs`,
      { costs: { "p2|Fall '26": { instructors: 0 } } });
    eq((z.json || {}).removed, 1, "an all-zero entry clears that program rather than storing nothing");
    const after = await call("GET", `/${slug}/cost-recovery/api/costs`);
    eq(nCosts(after), 1, "...and the other program is untouched");

    const nul = await call("PUT", `/${slug}/cost-recovery/api/costs`, { costs: { "p1|Fall '26": null } });
    eq((nul.json || {}).removed, 1, "an explicit null clears too");

    const bad = await call("PUT", `/${slug}/cost-recovery/api/costs`,
      { costs: { "nokeyseparator": { instructors: 100 }, "p3|Fall '26": { instructors: 100 } } });
    eq(((bad.json || {}).dropped || []).length, 1, "a key that is not <programId>|<season> is refused");
    eq((bad.json || {}).saved, 1, "...while the valid one beside it still saves");

    // Negative and absurd values cannot reach the store.
    await call("PUT", `/${slug}/cost-recovery/api/costs`,
      { costs: { "p4|Fall '26": { instructors: -500, staff: 9e15, bogus: 10 } } });
    const clean = await call("GET", `/${slug}/cost-recovery/api/costs`);
    const p4 = costOf(clean, "p4|Fall '26");
    ok(p4.instructors === undefined, "a negative cost is dropped rather than stored");
    ok(p4.staff <= 100000000, "an absurd cost is clamped");
    ok(p4.bogus === undefined, "a category the schema does not know is dropped");

    const noTok = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: PORT, path: `/${slug}/cost-recovery/api/costs` },
        (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(0));
    });
    ok(noTok === 403 || noTok === 404, `a tokenless read is refused (got ${noTok})`);

    // ── the ledger routes ────────────────────────────────────────────
    const l0 = await call("GET", `/${slug}/cost-recovery/api/ledger`);
    eq(l0.status, 200, "an org with no budget lines gets a 200");
    eq(Object.keys(((l0.json || {}).rows) || {}).length, 0, "...and an empty ledger");

    const l1 = await call("PUT", `/${slug}/cost-recovery/api/ledger`, { rows: {
      a1: { account: "Senior Trips", label: "Coach hire", category: "Transportation",
            kind: "expense", amount: 30000, season: "Fall '26", ord: 0 },
    } });
    eq((l1.json || {}).saved, 1, "a budget line saves");

    // Same merge rule as the program costs, and for the same reason.
    await call("PUT", `/${slug}/cost-recovery/api/ledger`, { rows: {
      a2: { account: "Facilities", label: "Boiler", category: "Maintenance", kind: "expense", amount: 200000, ord: 1 },
    } });
    const l2 = await call("GET", `/${slug}/cost-recovery/api/ledger`);
    const lrows = ((l2.json || {}).rows) || {};
    eq(Object.keys(lrows).length, 2, "a second writer's line does not discard the first");
    eq((lrows.a1 || {}).account, "Senior Trips", "the first line is intact");
    eq((lrows.a1 || {}).category, "Transportation", "...including its category");

    // A blank row is NOT a record. The page renders thirty to type into and
    // persisting those would grow a document for no reason.
    const l3 = await call("PUT", `/${slug}/cost-recovery/api/ledger`, {
      rows: { a9: { kind: "expense", ord: 7 } } });
    eq((l3.json || {}).saved, 0, "a row carrying only its defaults is not stored");

    // Emptying a row out is a DELETE, or the screen and the store disagree on
    // the next reload.
    const l4 = await call("PUT", `/${slug}/cost-recovery/api/ledger`, {
      rows: { a2: { account: "", label: "", category: "", amount: 0, kind: "expense" } } });
    eq((l4.json || {}).removed, 1, "a row emptied back out is cleared, not stored blank");

    const lbad = await call("PUT", `/${slug}/cost-recovery/api/ledger`, {
      rows: { "has spaces": { label: "x", amount: 100 } } });
    eq(((lbad.json || {}).dropped || []).length, 1, "a malformed row id is refused");

    // "R:8, NR:9" is a real value in Jason's sheet — but it is not a row id, a
    // category or an amount, and nothing here should invent a number from it.
    const lneg = await call("PUT", `/${slug}/cost-recovery/api/ledger`, {
      rows: { a5: { account: "Trips", label: "Odd", amount: -40, kind: "income" } } });
    eq((lneg.json || {}).saved, 1, "a line with a label but a bad amount still saves its label");
    const l5 = await call("GET", `/${slug}/cost-recovery/api/ledger`);
    ok((((l5.json || {}).rows || {}).a5 || {}).amount === undefined,
       "...and the negative amount is dropped rather than stored");

    const page = await call("GET", `/${slug}/cost-recovery`);
    eq(page.status, 200, "the report page serves");
    ok(/window\.ORG_CONFIG=/.test(page.text), "and carries its org config");
    ok(/costCategories/.test(page.text), "including the category vocabulary, so the page does not grow its own");
  } finally {
    srv.kill("SIGTERM");
    await new Promise(z => setTimeout(z, 250));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  report();
})();

function report() {
  if (failures.length) {
    console.error(`\n${passed} assertions passed, ${failures.length} FAILED.\n`);
    failures.forEach(f => console.error("  ✗ " + f));
    process.exit(1);
  }
  console.log(`${passed} assertions passed.`);
}
