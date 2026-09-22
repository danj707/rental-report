#!/usr/bin/env node
"use strict";

/* ============================================================================
   FEE ALLOCATION BY GL CODE — guards
   ----------------------------------------------------------------------------
   LIFTS AND RUNS public/fee-allocation.js. Every defect this feature can have is
   arithmetic about a share or a threshold, and a regex over an allocation passes
   just as happily on an inverted one - so the assertions below drive the real
   functions and read the numbers back.

   THE GOLDEN CASE is Danvers' own hand-built worksheet for 2026-08-23..31,
   measured off materialized.item_log_report rather than transcribed off the
   sheet. It is the only evidence in this repo that the shipped arithmetic
   reproduces what the town has been filing, so it is pinned figure by figure.
   ============================================================================ */

const fs   = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const F = require(path.join(ROOT, "public", "fee-allocation.js"));
const { allocateFees, apportion, normalizeFeeRates, collapseByGlCode,
        isEmptyGroup, DEFAULT_FEE_RATES } = F;

let passed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; } else { failures.push(name); console.error("  ✗ " + name); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name + "  (got " + JSON.stringify(actual) +
     ", expected " + JSON.stringify(expected) + ")");
}
// A throw inside a lifted function must fail BY NAME, not kill the run with a
// bare stack naming nothing. Nth instance of that lesson in this repo.
function guard(name, fn) {
  try { return fn(); }
  catch (e) { failures.push(name + " THREW: " + e.message);
              console.error("  ✗ " + name + " THREW: " + e.message); return null; }
}

const src  = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
// server.js quotes the broken forms in its own comments on purpose, so anything
// asserting an absence has to read past them. A regex comment-stripper is
// unsound on that file (a `/*` lives inside a template literal), so callers
// SLICE the region they care about instead - see the note in CLAUDE.md.
const slice = (text, from, to) => {
  const a = text.indexOf(from);
  if (a < 0) return "";
  const b = to ? text.indexOf(to, a + from.length) : -1;
  return b < 0 ? text.slice(a) : text.slice(a, b);
};

/* ── The rows card 17293 actually returns for Danvers, 2026-08-23..31 ────────
   Two desks, so DCOA arrives as two rows - which is what makes this fixture
   able to catch a collapse that forgets to sum across desks, and a desk-distinct
   count that is summed per row instead of deduped (216 + 1 = 217, not 866). */
const R = (glCode, deskLocation, cc, ccr, cash, chk, tot, ncp, ncr, nc, nk, ddcp, ddcr) =>
  ({ glCode, accountName: glCode, deskLocation,
     ccPayments: cc, ccRefunds: ccr, cashPayments: cash, checkPayments: chk,
     totalPayments: tot, cardPaymentTxns: ncp, cardRefundTxns: ncr,
     cashTxns: nc, checkTxns: nk,
     deskDistinctCardPayments: ddcp, deskDistinctCardRefunds: ddcr });

const DANVERS = [
  R("Childcare", "main",   74764,   0,  0, 436, 75581,   147, 0, 0, 1, 216, 1),
  R("DCOA",      "second",    55,   0,  0,  50,   105,     1, 0, 0, 1,   1, 0),
  R("DCOA",      "main",     301,   0, 80,  50,   431,     8, 0, 3, 1, 216, 1),
  R("DCOA (2)",  "main",       0,   0,  0,   0,     0,     0, 0, 0, 0, 216, 1),
  R("Rec",       "main",  9763.5, 205,  0, 300, 10063.5,  61, 1, 0, 1, 216, 1),
];

console.log("\nFee allocation — the golden week (Danvers 2026-08-23..31)");
const g = guard("golden week runs", () => allocateFees(DANVERS));
if (g) {
  const by = {}; g.rows.forEach(r => { by[r.glCode] = r; });

  // Step 1 — the inputs, summed across desks.
  eq(g.rows.length, 3, "three GL codes render (the all-zero one is dropped)");
  eq(g.basis.emptyGlCodes, 1, "one empty GL code was dropped");
  ok(!by["DCOA (2)"], "the all-zero GL code is absent, not rendered as zeros");
  eq(by.Childcare.cardPayments, 74764, "Childcare card payments");
  eq(by.DCOA.cardPayments, 356, "DCOA card payments summed across its two desks");
  eq(by.DCOA.cash, 80, "DCOA cash summed across desks");
  eq(by.DCOA.check, 100, "DCOA check summed across desks");
  eq(by.DCOA.nCardPay, 9, "DCOA card transaction count summed across desks");
  eq(by.Rec.cardPayments, 9763.5, "Rec card payments");
  eq(by.Rec.cardRefunds, 205, "Rec card refunds");
  eq(g.totals.cardPayments, 84883.5, "TOTAL card payments");
  eq(g.totals.revenue, 86180.5, "TOTAL revenue");

  // THE COUNT THE FEE IS CHARGED ON — deduped per desk (216 + 1), never the
  // per-row sum (which would be 866) and never the per-GL column sum.
  eq(g.totals.nCardPay, 217, "TOTAL card transactions = the true distinct count");
  eq(g.totals.nCardRef, 1, "TOTAL card refund transactions");
  eq(g.basis.splitCardPayments, 0, "this week contains no split-cart payments");

  // Step 2 — credit card.
  eq(by.Childcare.ccVariable, 2616.74, "Childcare CC variable fee");
  eq(by.Childcare.ccFixed, 44.10, "Childcare CC fixed fee");
  eq(by.Childcare.ccFees, 2660.84, "Childcare total CC fee");
  eq(by.Rec.ccFees, 367.50, "Rec total CC fee (payments + its one refund)");
  eq(by.DCOA.ccFees, 15.16, "DCOA total CC fee");
  eq(g.totals.ccVariable, 2970.92, "TOTAL CC variable");
  eq(g.totals.ccFixed, 65.10, "TOTAL CC fixed = 217 x $0.30");
  eq(g.totals.refVariable, 7.18, "TOTAL refund variable");
  eq(g.totals.refFixed, 0.30, "TOTAL refund fixed");

  // Steps 3 and 4.
  eq(by.Childcare.cashCheckFees, 4.36, "Childcare cash+check fee");
  eq(by.DCOA.cashCheckFees, 1.80, "DCOA cash+check fee");
  eq(by.Childcare.techFee, 755.81, "Childcare technology fee");
  eq(g.totals.techFee, 861.81, "TOTAL technology fee");

  // ── The verification block, which is the whole point of the report ──
  eq(g.totals.ccFees, 3043.50, "VERIFY CC processing ties to the remittance summary");
  eq(g.totals.cashCheckFees, 9.16, "VERIFY cash + check ties");
  eq(g.totals.techFee, 861.81, "VERIFY technology ties");
  eq(g.totals.totalFees, 3914.47, "VERIFY total Rec fees ties");

  // THE PARTS MUST SUM. Rounding each row independently leaves the column a
  // cent or two off its own total, and this report exists to reconcile against
  // a figure somebody else computed.
  const cents = (v) => Math.round(v * 100);
  const sumRows = (f) => g.rows.reduce((a, r) => a + cents(r[f]), 0);
  eq(sumRows("totalFees"), cents(g.totals.totalFees), "rows sum EXACTLY to the grand total");
  eq(sumRows("ccVariable"), cents(g.totals.ccVariable), "CC variable column sums to its total");
  eq(sumRows("ccFixed"), cents(g.totals.ccFixed), "CC fixed column sums to its total");
  eq(sumRows("techFee"), cents(g.totals.techFee), "technology column sums to its total");
  eq(sumRows("cashFee"), cents(g.totals.cashFee), "cash column sums to its total");
  eq(sumRows("checkFee"), cents(g.totals.checkFee), "check column sums to its total");
  eq(sumRows("ccFees") + sumRows("cashCheckFees") + sumRows("techFee"),
     cents(g.totals.totalFees), "the three fee families sum to the grand total");
}

/* ── A week WITH split carts, which is what the allocation exists for ────────
   Same money, but one payment paid for both GL codes: the per-GL counts say
   100 + 60 = 160 while only 159 transactions happened. Naive pricing bills
   $48.00; the truth is $47.70, and the rows must still sum to it. */
console.log("\nSplit-cart weeks — the per-GL counts overcount");
const SPLIT = [
  R("A", "main", 60000, 0, 0, 0, 60000, 100, 0, 0, 0, 159, 0),
  R("B", "main", 40000, 0, 0, 0, 40000,  60, 0, 0, 0, 159, 0),
];
const sp = guard("split week runs", () => allocateFees(SPLIT));
if (sp) {
  eq(sp.basis.billedCardPayments, 159, "the fee is charged on the TRUE count, not 160");
  eq(sp.basis.splitCardPayments, 1, "the report knows one payment spanned two GL codes");
  eq(sp.totals.ccFixed, 47.70, "TOTAL fixed fee = 159 x $0.30, not 160 x $0.30");
  const cents = (v) => Math.round(v * 100);
  eq(sp.rows.reduce((a, r) => a + cents(r.ccFixed), 0), cents(sp.totals.ccFixed),
     "the split fixed fee still sums exactly to its total");
  ok(sp.rows[0].ccFixed > sp.rows[1].ccFixed,
     "the GL code with more transactions carries more of the fixed fee");
  // The naive answer, kept as the thing NOT to produce.
  ok(sp.totals.ccFixed !== 48.00, "it does NOT bill $0.30 x the summed per-GL counts");
}

/* ── A feed cached before the card carried the counts ───────────────────────
   PRESENCE, not value. 0 transactions and "this feed cannot say" are different
   facts, and only one of them justifies printing a total. */
console.log("\nPre-column feeds degrade honestly");
const OLD = DANVERS.map(r => {
  const c = Object.assign({}, r);
  delete c.cardPaymentTxns; delete c.cardRefundTxns;
  delete c.cashTxns; delete c.checkTxns;
  delete c.deskDistinctCardPayments; delete c.deskDistinctCardRefunds;
  return c;
});
const o = guard("pre-column feed runs", () => allocateFees(OLD));
if (o) {
  eq(o.basis.hasTxnCounts, false, "the report knows the counts are absent");
  eq(o.totals.ccFixed, null, "the flat fee is WITHHELD, not priced at $0.00");
  eq(o.totals.totalFees, null, "the grand total is withheld rather than reported short");
  eq(o.rows[0].ccFees, null, "a row's CC fee is withheld too");
  eq(o.totals.nCardPay, null, "the transaction count is withheld, not reported as 0");
  // What CAN still be computed, is.
  eq(o.totals.ccVariable, 2970.92, "the percentage-based CC fee is still computed");
  eq(o.totals.techFee, 861.81, "the technology fee is still computed");
  eq(o.totals.cashCheckFees, 9.16, "cash and check fees are still computed");
}

/* ── apportion: the property everything above rests on ──────────────────── */
console.log("\nApportionment");
guard("apportion runs", () => {
  const a = apportion(10000, [1, 1, 1]);
  eq(a.reduce((x, y) => x + y, 0), 10000, "a total that does not divide evenly still sums exactly");
  eq(apportion(100, [0, 0, 0]).join(","), "0,0,0", "all-zero weights allocate nothing");
  eq(apportion(0, [5, 5]).join(","), "0,0", "a zero total allocates nothing");
  eq(apportion(100, []).length, 0, "no rows, no allocation");
  const b = apportion(1000, [999, 1]);
  eq(b[0] + b[1], 1000, "a lopsided split still sums exactly");
  ok(b[0] > b[1], "the bigger weight gets the bigger share");
  // Deterministic: two runs over the same weights cannot disagree about which
  // row takes the spare cent.
  eq(apportion(10, [1, 1, 1]).join(","), apportion(10, [1, 1, 1]).join(","),
     "the same input always allocates the same way");
  // A negative weight cannot claw money away from the rows that earned it.
  const c = apportion(100, [10, -5]);
  eq(c[0], 100, "a negative weight is treated as zero");
});

/* ── rates ──────────────────────────────────────────────────────────────── */
console.log("\nRates");
guard("rates run", () => {
  eq(normalizeFeeRates(null).ccVariableBps, 350, "an absent rate object takes the defaults");
  eq(normalizeFeeRates({ ccVariableBps: 250 }).ccVariableBps, 250, "a supplied rate is honoured");
  eq(normalizeFeeRates({ ccVariableBps: 250 }).techBps, 100, "unsupplied rates keep their default");
  // A rate we cannot read must not become 0% - that is a claim about the org's
  // contract, not about our parsing.
  eq(normalizeFeeRates({ ccVariableBps: "oops" }).ccVariableBps, 350,
     "an unreadable rate falls back to the default, never to zero");
  eq(normalizeFeeRates({ cashBps: -5 }).cashBps, 100, "a negative rate is refused");
  const z = allocateFees(DANVERS, { techBps: 0 });
  eq(z.totals.techFee, 0, "a rate genuinely set to zero really does charge nothing");
  const half = allocateFees(DANVERS, { ccVariableBps: 175 });
  eq(half.totals.ccVariable, 1485.46, "halving the variable rate halves the variable fee");
});

/* ── collapse / empty rows ──────────────────────────────────────────────── */
console.log("\nCollapse and empty rows");
guard("collapse runs", () => {
  const c = collapseByGlCode(DANVERS);
  eq(c.groups.length, 4, "four distinct GL codes before the empty one is dropped");
  eq(c.trueCardPayments, 217, "per-desk card counts are DEDUPED by desk, then summed");
  eq(c.hasTxnCounts, true, "the counts are detected as present");
  ok(isEmptyGroup(c.groups.find(x => x.glCode === "DCOA (2)")), "the all-zero group is empty");
  ok(!isEmptyGroup(c.groups.find(x => x.glCode === "Rec")), "a group with money is not empty");
  // A GL code that only ever took a refund still has something to say.
  const refundOnly = collapseByGlCode([R("X", "d", 0, 500, 0, 0, 0, 0, 2, 0, 0, 2, 2)]);
  ok(!isEmptyGroup(refundOnly.groups[0]), "a refund-only GL code is NOT dropped as empty");
});

/* ── Source: the four gates a mode has to pass on this report ───────────── */
console.log("\nThe four gates");
const gl = src("public/gl.html");
const server = src("server.js");

ok(/fees:\s*p\.get\('fees'\)/.test(slice(gl, "function getParams()", "function toISO")),
   "gate 1 — `fees` is in getParams' explicit whitelist");
ok(/if \(isFeeActive\)\s+p\.set\('fees', '1'\)/.test(gl),
   "gate 2 — the mode reaches currentFilterParams (the saved-view comparison)");
ok(/if \(isFeeActive\) qs\.set\('fees', '1'\)/.test(gl),
   "gate 2 — the mode reaches the share link");
ok(/"refunds", "fees"\]/.test(server),
   "gate 3 — `fees` is in SAVED_VIEW_PARAMS.gl, appended last");
// LIFTED AND RUN, not grepped: a render case at ?fees=1 proves the PAGE reads
// the parameter and says nothing about whether the SERVER sends it - which is
// the gate all four recorded instances of this bug actually failed.
const qsBuilder = slice(server, "const qsObj = { start_date: startDate", "const qs = new URLSearchParams(qsObj)");
ok(qsBuilder.length > 0, "generatePdf's query builder was found (or every assertion below is vacuous)");
const built = guard("generatePdf query builder runs", () => {
  const fn = new Function("startDate", "endDate", "filters", "orgTok",
    qsBuilder + "\nreturn qsObj;");
  return fn("2026-08-23", "2026-08-31", { fees: "1", tyler: "", refunds: "" }, "tok");
});
if (built) {
  eq(built.fees, "1", "gate 4 — generatePdf FORWARDS fees to the print page");
  eq(built._print, "1", "...as part of a real print URL");
}
const notFees = guard("generatePdf omits an unset mode", () => {
  const fn = new Function("startDate", "endDate", "filters", "orgTok",
    qsBuilder + "\nreturn qsObj;");
  return fn("2026-08-23", "2026-08-31", {}, "tok");
});
if (notFees) ok(notFees.fees === undefined, "an unset mode is not forwarded (the default is OFF)");

/* ── Source: the gate, the seed, and the rates staying in step ──────────── */
console.log("\nGate, seed and rates");
const schema = slice(server, "  gl: {", "  // The Facilities hub's Aquatics tab");
ok(schema.length > 0, "the gl settings schema was found");
ok(/feeAllocation:\s*\{\s*kind:\s*"bool",\s*def:\s*false\s*\}/.test(schema),
   "SHIPS OFF — feeAllocation defaults to false, per the standing rule");
for (const k of Object.keys(DEFAULT_FEE_RATES)) {
  const m = new RegExp(k + ':\\s*\\{[^}]*def:\\s*(\\d+)').exec(schema);
  ok(m && Number(m[1]) === DEFAULT_FEE_RATES[k],
     "the schema default for " + k + " matches DEFAULT_FEE_RATES (" + DEFAULT_FEE_RATES[k] + ")");
}
ok(/function feeAllocConfig\(slug\)/.test(server), "the org gate exists");
ok(/if \(!st \|\| !st\.feeAllocation\) return null;/.test(server),
   "the gate returns NULL when the org is not switched on, so callers are a truthiness test");
ok(/feeAlloc: feeAllocConfig\(slug\)/.test(server),
   "the gate (and its rates) reach the GL page's ORG_CONFIG");

const seeds = slice(server, "const REPORT_SETTINGS_SEEDS = {", "function seedReportSettings");
ok(/town-of-danvers/.test(seeds), "Danvers is seeded on");
ok(/feeAllocation: true/.test(seeds), "...with the mode enabled");
// A seed is an INITIAL VALUE. Called at module scope it writes to a disk that is
// thrown away and takes its own marker with it - silently, on every boot.
const seedFn = slice(server, "function seedReportSettings() {", "\n}\n");
ok(/if \(applied\[key\]\) continue;/.test(seedFn), "a seed applies ONCE and never again");
ok(/normalizeReportSettings\(seed\.report, seed\.settings\)/.test(seedFn),
   "a seed goes through the same validator a settings PUT does");
ok(/if \(!ORGS\[slug\]\)/.test(seedFn), "an org this server does not serve gets no phantom entry");

/* THE MARKER IS PER ORG, AND ONLY RUNNING IT CAN SHOW THAT. A regex over the
   marker line reads plausibly whichever key it writes, and the defect is
   entirely about which one: marked per KEY, an org this server cannot see YET
   is skipped by the org loop while the key is recorded applied anyway - so the
   seed never runs again and the feature ships doing nothing for the one org it
   exists for, the only symptom a line in a boot log. Danvers is a DYNAMIC org,
   so it is absent from ORGS on any boot where storeConnect() returns early (the
   configure timeout, or a thrown connect): loadDynamicOrgs runs inside it while
   the seed runs in storeBoot's finally, past every one of those returns. */
const SEED_FIXTURE = { "seed-key": {
  report: "gl", orgs: ["town-of-danvers"],
  settings: { feeAllocation: true, ccVariableBps: 350 },
} };

// `slice` stops BEFORE the closing brace, so the lift has to put it back or the
// Function body is unbalanced and every assertion below dies on a syntax error.
function bootSeed(orgs, files, store) {
  new Function(
    "path", "DATA_DIR", "readJSON", "writeJSON", "ORGS", "REPORT_SETTINGS_SEEDS",
    "normalizeReportSettings", "readReportSettingsStore", "writeReportSettingsStore",
    "console",
    seedFn + "\n}\nreturn seedReportSettings;"
  )(
    { join: function () { return Array.prototype.join.call(arguments, "/"); } },
    "/data",
    function (f, d) { return f in files ? JSON.parse(JSON.stringify(files[f])) : d; },
    function (f, v) { files[f] = JSON.parse(JSON.stringify(v)); },
    orgs,
    SEED_FIXTURE,
    function (report, settings) { return { settings: settings }; },
    function () { return JSON.parse(JSON.stringify(store.v)); },
    function (v) { store.v = JSON.parse(JSON.stringify(v)); },
    { log: function () {}, warn: function () {} }
  )();
  return { marks: files["/data/report-seeds.json"] || {}, settings: store.v };
}

// 1. An org this boot cannot see must leave the seed UNAPPLIED.
const unseen = guard("an unknown org does not mark the seed applied",
  function () { return bootSeed({}, {}, { v: {} }); });
ok(unseen && Object.keys(unseen.marks).length === 0,
   "an unknown org leaves NO marker, so the next boot retries");
ok(unseen && !unseen.settings["town-of-danvers"],
   "...and writes no settings for an org it does not serve");

// 2. ...and the very next boot, once the dynamic orgs have loaded, applies it.
const retried = guard("the next boot applies it once the org is there", function () {
  const files = {}, store = { v: {} };
  bootSeed({}, files, store);                                  // boot 1: store answered late
  return bootSeed({ "town-of-danvers": {} }, files, store);    // boot 2: ORGS populated
});
ok(retried && retried.settings["town-of-danvers"] &&
   retried.settings["town-of-danvers"].gl.feeAllocation === true,
   "a retry after the org appears DOES seed it - the whole point of not marking");
ok(retried && Object.keys(retried.marks).some(function (k) {
     return k.indexOf("|town-of-danvers") > 0; }),
   "the marker names the ORG, not the key alone");

// 3. A seeded org is never re-seeded over a toggle it has changed since.
const resettled = guard("an applied org is not seeded twice", function () {
  const files = {}, orgs = { "town-of-danvers": {} }, store = { v: {} };
  bootSeed(orgs, files, store);
  // the org switches the mode back off, then the server reboots
  store.v["town-of-danvers"].gl.feeAllocation = false;
  return bootSeed(orgs, files, store).settings;
});
ok(resettled && resettled["town-of-danvers"].gl.feeAllocation === false,
   "a seed applies ONCE per org - it never overwrites a toggle changed since");
const bootBlock = slice(server, "async function storeBoot()", "async function storeConnect()");
ok(/seedReportSettings\(\);/.test(bootBlock),
   "the seed is called from storeBoot, where the store has actually answered");
eq((server.match(/^\s*seedReportSettings\(\);/gm) || []).length, 1,
   "...from exactly ONE call site (a module-scope call writes to a discarded disk)");

/* ── Source: the page ───────────────────────────────────────────────────── */
console.log("\nThe page");
ok(/src="\/fee-allocation\.js"/.test(gl), "the page loads the shared arithmetic");
ok(!/function allocateFees/.test(gl),
   "the page does NOT carry its own copy of the arithmetic the spec proves");
ok(/window\.RecFeeAllocation/.test(gl), "...it reads the shared module at call time");
const norm = slice(gl, "function normalizeRow(raw)", "// ── Payment-method (tender) filter");
for (const col of ["Card Payment Txns", "Card Refund Txns", "Cash Txns", "Check Txns",
                   "Desk Distinct Card Payments", "Desk Distinct Card Refunds"]) {
  ok(norm.includes(col), "normalizeRow maps the card's `" + col + "` column");
}
// The null-not-zero rule, on the page as well as in the library.
ok(/cardPaymentTxns: raw\['Card Payment Txns'\] != null \? pf\([^)]+\) : null/.test(norm),
   "an absent count maps to NULL, never to 0");
/* PRICED OFF THE DESK-SCOPED ROWS, NEVER `displayRows`.

   This assertion used to read the other way round - "priced from displayRows,
   so every toolbar filter narrows it too" - and it was pinning a real bug as
   though it were the requirement, the same shape as report-settings.spec.js
   once requiring `disabled` on the gear.

   It is wrong because this worksheet reconciles against what Rec BILLED, and
   three of the toolbar's controls cannot be expressed in that bill:

   - the GL checkboxes: the $0.30 fee rides the TRUE distinct transaction
     count, a per-DESK figure, and a card payment spanning two GL codes belongs
     partly to each - so there is no honest count for "the codes still ticked".
     Priced off displayRows the fixed half stayed at the org-wide count while
     every other fee shrank with the rows: untick Childcare on Danvers' own week
     and it still billed 217 transactions ($65.10) against the $10,119.50 of
     card volume left on screen.
   - the search box, the same defect by a different door.
   - the tender picker, which is worse - applyMethodFilter REWRITES each row's
     money, so the worksheet would report cash the org never took.

   Dates and desk still apply and both are sound: a desk-distinct count is
   additive across desks. */
ok(/allocateFees\(deskRows, feeCfg, feeCounts \|\| \{\}\)/.test(gl),
   "the worksheet is priced from the DESK-SCOPED rows, so the GL/search/tender filters cannot reach it");
ok(!/allocateFees\(displayRows/.test(gl),
   "...and never from displayRows, which those three narrow");

/* ONE desk scope, THREE readers. `feeCounts` used to re-derive it from React
   state while displayRows read it from the URL, so on the FIRST render of a
   PDF a desk-filtered table was priced against org-wide counts. */
ok(/const deskRows = useMemo\(/.test(gl), "the desk scope is its own memo");
ok(/const deskRawRows = useMemo\(/.test(gl),
   "...with a raw copy, because aggregateByGlCode destroys the desk identity the dedupe needs");
ok(/var base = deskRows;/.test(gl), "displayRows builds ON the desk scope rather than repeating it");
eq((gl.match(/params\._print === '1' && params\.desks/g) || []).length, 2,
   "the print-mode desk fallback lives in the two shared memos and nowhere else");

/* The three controls are ABSENT while the mode is on, not greyed: a control
   that cannot affect the numbers is a dead end somebody clicks. Hidden rather
   than cleared, so a rollup selection survives a round trip through the mode.
   The DESK picker deliberately keeps rendering. */
for (const [guard, what] of [
  ["\\{!isFeeActive && hasGlCodes && selectedGlCodes &&", "the GL-code picker"],
  ["\\{!isFeeActive && availableMethods\\.length > 1 && selectedMethods &&", "the tender picker"],
  ["\\{!isFeeActive && \\(\\s*<input type=\"text\" value=\\{glFilter\\}", "the GL search box"],
]) {
  ok(new RegExp(guard).test(gl), what + " is hidden while the worksheet is on");
}
ok(/\{hasDesk && selectedDesks && \(\s*<CheckFilter/.test(gl),
   "...while the DESK picker still renders, because a desk-scoped worksheet is sound");
ok(/if \(!isFeeActive && glFilter\.trim\(\)\)/.test(gl),
   "no search chip on a view the search cannot narrow");
ok(/if \(!isFeeActive && availableMethods\.length > 1/.test(gl),
   "no tender chip either - a chip claims the numbers are narrowed");
// ONE pricing, two readers (the render and the Slack ping). Two calls is two
// answers that can disagree about the same window.
eq((gl.match(/RecFeeAllocation\.allocateFees\(/g) || []).length, 1,
   "the arithmetic is called exactly ONCE on the page");
ok(/result=\{feeResult\}/.test(gl), "...and the component is handed that result");
// The desk filter re-aggregates rows to one per GL code, destroying the desk
// identity the true-count dedupe needs — so the page computes it from the RAW
// desk-scoped rows, the same way the TOTALS row already does.
const counts = slice(gl, "const feeCounts = useMemo(", "const feeResult = useMemo(");
/* Scoped to the feeCounts block, because the file-wide "two print fallbacks"
   count above cannot see this: re-deriving the desk scope here from React state
   adds no `params._print` occurrence, so that assertion stayed green while the
   bug came back. It is the bug that matters most - React state is null on the
   FIRST render, so a printed desk-filtered worksheet was priced on org-wide
   counts. */
ok(/const scoped = deskRawRows;/.test(counts),
   "the true counts read the SHARED desk scope");
ok(!/rows\.filter\(/.test(counts),
   "...and feeCounts never re-filters the rows itself");
ok(/if \(!byDesk\.has\(k\)/.test(counts), "the true card count is DEDUPED by desk, not summed per row");
ok(/scoped\.some\(r => r\.cardPaymentTxns != null\)/.test(counts),
   "presence is asked of the rows, not derived from a value");
ok(/'cardPaymentTxns','cardRefundTxns','cashTxns','checkTxns'/.test(gl),
   "the per-GL counts survive the desk-filter re-aggregate on the NULL-preserving path");
ok(!/GL_MONEY_FIELDS = \[[^\]]*cardPaymentTxns/.test(gl),
   "...and NOT on the money path, where an absent column would sum to a confident 0");
ok(/const isFeeActive = feeEnabled && !isTylerActive/.test(gl),
   "two whole-table modes cannot both render");
ok(/params\._print === '1' \? params\.fees === '1' : feeView/.test(gl),
   "print mode trusts the URL, not React state (Puppeteer has no localStorage)");
ok(/if \(feeEnabled\) setFeeView\(!!f\.fees\)/.test(gl),
   "applying a view sets the mode in BOTH directions");
ok(/if \(feeEnabled\) setFeeView\(false\)/.test(gl), "Default view turns the mode off");
ok(/'tyler', 'refunds', 'fees'\]/.test(gl),
   "a stale `fees=` in the URL is cleared when a view is applied");
ok(/\{feeEnabled && !isTylerActive && \(/.test(gl),
   "the toolbar button is ABSENT where the org is not switched on, not disabled");

/* ── The Slack beacon ───────────────────────────────────────────────────── */
console.log("\nThe beacon");
// Each list is SLICED and then tested for membership, never pinned to whichever
// event happens to sit beside `fee-alloc`: the two lists share most of their
// names, so an unscoped match is satisfied by the wrong one - and a neighbour
// is somebody else's to change (main inserting `org-synced` broke exactly this).
// server.js declares five ALLOWED lists (one per beacon route); the generic log
// route's is the one carrying `roster-open`, so it is SELECTED by a member rather
// than by position.
const allowedList = (server.match(/const ALLOWED = \[[^\]]*\]/g) || [])
  .find(l => l.includes('"roster-open"')) || "";
ok(allowedList.length > 50, "the generic log route's ALLOWED list was found (or the next assertion is vacuous)");
ok(allowedList.includes('"fee-alloc"'),
   "`fee-alloc` is on the generic log route's ALLOWED list");
const notifySet = (server.match(/const SLACK_NOTIFY = new Set\(\[[^\]]*\]\)/) || [""])[0];
ok(notifySet.length > 50, "SLACK_NOTIFY was found (or the next assertion is vacuous)");
ok(notifySet.includes('"fee-alloc"'), "...and in SLACK_NOTIFY, or it posts nothing");
ok(/"fee-alloc": \{ emoji:/.test(server), "...and has an emoji and a verb");
// Its OWN message branch. The shared line prints the report type twice and the
// figure never - the defect already fixed once in the feedback branch.
ok(/rec\.event === "fee-alloc"/.test(server), "it has its own Slack message branch");
const branch = slice(server, 'rec.event === "fee-alloc"', 'rec.event === "settings-open"');
ok(/rec\.fees/.test(branch) && /rec\.txns/.test(branch),
   "...which carries the figure it priced and the transaction count");
ok(/logClientEvent\('fee-alloc'/.test(gl), "the page fires it");
ok(/if \(!feeResult \|\| isPrint\) return;/.test(gl),
   "...but not from the print render, which is Puppeteer and already logs `pdf`");

/* ── The card ───────────────────────────────────────────────────────────── */
console.log("\nThe card");
const sql = src("sql/gl-code-report.sql");
for (const col of ['"Card Payment Txns"', '"Card Refund Txns"', '"Cash Txns"', '"Check Txns"',
                   '"Desk Distinct Card Payments"', '"Desk Distinct Card Refunds"']) {
  ok(sql.includes(col), "card 17293 emits " + col);
}
ok(/ORDER BY\s+agg\.gl_code_raw,\s+agg\.desk_location\s*$/.test(sql.trim()),
   "the trailing ORDER BY survives (it has silently vanished on a push before)");
ok(/\{\{start_date\}\}::date/.test(sql) && /\{\{end_date\}\}::date \+ INTERVAL/.test(sql),
   "both date bounds are CAST, so the SQL parses under a Text tag too");
// The per-desk card counts must come from totals_by_desk, not from agg: taken
// per GL code they would be the overcounting figure all over again.
const byDesk = slice(sql, "totals_by_desk AS (", "\n)");
ok(/desk_distinct_card_payments/.test(byDesk),
   "the TRUE card count is computed per DESK, where it is additive");
// COUNTED, not tested for presence: the slice holds two of these (payments and
// refunds), so a single .test() passes with one of them deleted - the recorded
// "an assertion satisfied by different code is not guarding the thing it names"
// trap. Same for the four per-GL counts in `agg`.
eq((byDesk.match(/raw_amount_cents > 0/g) || []).length, 2,
   "BOTH per-desk card counts exclude $0 line items");
const aggBlock = slice(sql, "agg AS (", "\nchecks AS (");
eq((aggBlock.match(/raw_amount_cents > 0/g) || []).length, 4,
   "all FOUR per-GL method counts exclude $0 line items");

console.log("\n" + passed + " assertions passed" +
            (failures.length ? ", " + failures.length + " FAILED" : "") + ".");
process.exit(failures.length ? 1 : 0);
