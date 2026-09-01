#!/usr/bin/env node
/* ============================================================================
 * programs-autopay.spec.js — the two payment-plan metrics Dan asked for on
 * 2026-09-01 and cards 17295 v7 / v8 underneath them:
 *
 *   · "% on Auto-Pay vs % on manual collection" on the Programs summary (v7)
 *   · Outstanding split into past due / scheduled / on auto-pay (v8)
 *
 * Auto-pay charges a card on file at each payment-plan installment date;
 * without it somebody has to collect every installment. Three things about this
 * metric can be wrong in ways that still render a plausible number, and each
 * one is an assertion here:
 *
 *   1. THE DENOMINATOR IS PAYMENT-PLAN REGISTRATIONS ONLY. A registration paid
 *      in full is on neither method, and folding it in turns the figure into a
 *      statement about how many people use plans rather than how the plan money
 *      arrives. The card enforces it: on_autopay is NULL for an item with no
 *      installments and such an item is counted on NEITHER side.
 *   2. DOLLARS AND COUNTS DISAGREE BY 26x. At apex, 10.5% of plan dollars are
 *      on auto-pay ($211,200.50 of $2,004,762.18) against 0.4% of plan
 *      registrations (79 of 22,109) — auto-pay is used for the expensive plans,
 *      $2,673 average against $81. Either number alone reads as the whole
 *      answer, so both are printed and the fixtures here make them differ.
 *   3. NO PLAN MONEY IS null, NOT 0%. "Nobody uses auto-pay" and "this org runs
 *      no payment plans" are different facts. Same rule as a pre-v7 feed, where
 *      the card is hidden rather than zeroed (mbHasProductKind / ciHasStatus).
 *
 * And for the Outstanding split (v8):
 *
 *   4. THE FOUR BUCKETS PARTITION Outstanding. They do by construction in the
 *      card, so the page returns the RESIDUAL rather than trusting them, and
 *      renders it when it is real — a breakdown whose parts quietly fail to sum
 *      is how a number stops being trusted.
 *   5. A DATELESS INSTALLMENT IS SCHEDULED, NEVER PAST DUE. 15,231 of 166,507
 *      unpaid installments across 76 orgs have no due_at; apex has zero, so
 *      apex alone cannot test it. `due_at < NOW()` is false for a NULL, and the
 *      scheduled side spells the NULL out rather than relying on an ELSE.
 *   6. PAST DUE IS NOT SPLIT BY COLLECTION METHOD. Dan: "declines are flagged
 *      in product, they are the same as a non-auto payment past due CC payment
 *      installment." A past-due auto-pay installment IS a declined card, and
 *      filing it under "on auto-pay" reports it as collecting on schedule.
 *
 * It LIFTS AND RUNS both helpers rather than regexing them — a regex passes on a
 * share computed from the wrong pair of columns. (The nightStateFrom lesson.)
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "programs.html");
const SQL  = path.join(__dirname, "..", "sql", "report-cards", "17295-programs-report.sql");
const src  = fs.readFileSync(PAGE, "utf8");
const sql  = fs.readFileSync(SQL, "utf8");

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// ── lift and RUN the helper ─────────────────────────────────────────────────
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  let depth = 0, i = text.indexOf("{", start);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}
// progAutopayShare reads fmtNum, so both come along. Two lifts, one scope.
const progAutopayShare = new Function(
  liftFn(src, "fmtNum") + "\n" + liftFn(src, "progAutopayShare") +
  "; return progAutopayShare;")();
const progOutstandingSplit = new Function(
  liftFn(src, "fmtNum") + "\n" + liftFn(src, "progOutstandingSplit") +
  "; return progOutstandingSplit;")();

// ── the apex shape, and the reason both readings are printed ────────────────
// One expensive auto-pay plan against many small manual ones. These are the
// real proportions: at apex the auto-pay average is $2,673 and the manual one
// $81, which is why a dollars share and a count share cannot substitute.
const APEX = [
  { autopayPlanItems: 79, autopayPlanValue: 211200.50, manualPlanItems: 0,     manualPlanValue: 0 },
  { autopayPlanItems: 0,  autopayPlanValue: 0,         manualPlanItems: 22030, manualPlanValue: 1793561.68 },
];
{
  const r = progAutopayShare(APEX);
  eq(r.pctValue, 10.5, "the DOLLARS share at apex");
  eq(r.pctItems, 0.4,  "the REGISTRATIONS share at apex");
  ok(r.pctValue / r.pctItems > 20,
     "the two readings differ by more than 20x — which is why the card prints both");
  eq(r.planItems, 22109, "plan registrations is the sum of both sides");
  eq(Math.round(r.planValue * 100) / 100, 2004762.18, "plan value is the sum of both sides");
}

// ── THE DENOMINATOR. A registration paid in full is on neither method. ──────
// The card already excludes it (on_autopay is NULL with no installments), so
// the page never has to subtract anything — but a row carrying real revenue and
// no plan columns must not be able to move the share either.
{
  const withPaidInFull = APEX.concat([
    // 6,000 registrations and $500,000 collected, no payment plan at all. BOTH
    // numbers matter: without `enrollments` here, a mutation that adds the
    // enrolment count to the manual side has nothing to add and SURVIVES —
    // which is exactly what happened on the first draft of this spec.
    { enrollments: 6000, charged: 500000, received: 500000, netRevenue: 500000 },
  ]);
  const r = progAutopayShare(withPaidInFull);
  eq(r.pctValue, 10.5, "a registration paid in full does not enter the denominator");
  eq(r.planItems, 22109, "...nor the registration count");
}

// ── NO PLAN MONEY IS null, NOT 0% ──────────────────────────────────────────
eq(progAutopayShare([]), null, "no rows at all is null");
eq(progAutopayShare([{ charged: 900, received: 900 }]), null,
   "an org with revenue but NO payment plans is null — 0% would say nobody uses auto-pay");
eq(progAutopayShare(null), null, "a feed that has not answered is null");
// A pre-v7 feed carries none of the four keys, so it lands in the same branch.
// The card is additionally gated on colPresence.autopay (asserted below), which
// is what distinguishes "no plans" from "this feed cannot tell us".
eq(progAutopayShare([{ programName: "Aquatic Exercise", charged: 40 }]), null,
   "a pre-v7 row contributes nothing rather than counting as manual");

// ── A REAL 0% IS A REAL ANSWER, and must not be null ───────────────────────
// Shrewsbury, measured: 493 sections, 87 manual plan registrations worth
// $32,494, and not one on auto-pay. That org has a genuine 0% and has to see it.
{
  const r = progAutopayShare([{ autopayPlanItems: 0, autopayPlanValue: 0,
                                manualPlanItems: 87, manualPlanValue: 32494 }]);
  ok(r !== null, "an org with plans and no auto-pay is NOT null — it has a real 0%");
  eq(r.pctValue, 0, "...and reads 0% by dollars");
  eq(r.pctItems, 0, "...and 0% by registrations");
}

// ── 100% is reachable, and rounding is to one decimal ──────────────────────
{
  const r = progAutopayShare([{ autopayPlanItems: 3, autopayPlanValue: 900,
                                manualPlanItems: 0, manualPlanValue: 0 }]);
  eq(r.pctValue, 100, "an all-auto-pay book reads 100%");
}
{
  const r = progAutopayShare([{ autopayPlanItems: 1, autopayPlanValue: 1,
                                manualPlanItems: 2, manualPlanValue: 2 }]);
  eq(r.pctValue, 33.3, "the share is rounded to one decimal, not to an integer");
}

// ── ZERO DOLLARS BUT REAL REGISTRATIONS ────────────────────────────────────
// A comped or fully-waived plan has installments worth nothing. The dollars
// share cannot be computed, and a 0 there would be a claim; the count still can.
{
  const r = progAutopayShare([{ autopayPlanItems: 2, autopayPlanValue: 0,
                                manualPlanItems: 2, manualPlanValue: 0 }]);
  ok(r !== null, "registrations with no money still count as payment plans");
  eq(r.pctValue, null, "a $0 plan book has no dollars share — null, not 0%");
  eq(r.pctItems, 50, "...but the registration share is still real");
}

// ── page invariants ────────────────────────────────────────────────────────

// The mapper has to carry the columns, or nothing downstream can see them.
// THIS IS THE ASSERTION THE LOCATION FILTER NEEDED AND DID NOT HAVE: it shipped
// with progHasLocation reading a key no code ever wrote, and every source and
// unit assertion passed because the fixtures set the key themselves.
for (const [field, col] of [
  ["autopayPlanItems", "autopay_plan_items"],
  ["manualPlanItems",  "manual_plan_items"],
  ["autopayPlanValue", "autopay_plan_value"],
  ["manualPlanValue",  "manual_plan_value"],
]) {
  ok(new RegExp(field + ":\\s*raw\\['" + col + "'\\]").test(src),
     "normalizeRow maps " + col + " onto " + field);
}

// ...and the ROLLUP has to add them up, or a multi-section program reports only
// whatever its first section happened to carry.
for (const f of ["autopayPlanItems", "manualPlanItems", "autopayPlanValue", "manualPlanValue"]) {
  ok(new RegExp("g\\." + f + "\\s*\\+=\\s*fmtNum\\(r\\." + f + "\\)").test(src),
     "rollupToPrograms sums " + f + " across a program's sections");
}

// PRESENCE, NOT VALUE, and asked of the RAW response. `rows` are program
// rollups with a fixed key set, so 'autopay_plan_items' in r is false there for
// every feed — which is exactly how the location gate came to be always-false.
ok(/autopay:\s*raw\.some\(r => 'autopay_plan_items' in r\)/.test(src),
   "the presence gate tests for the COLUMN on the raw feed, not a value on a rollup");
ok(/\{colPresence\.autopay && apShare && \(/.test(src),
   "the card is gated on the column being present AND there being plan money");

// It must read the FUNNEL, not the raw feed — or the location, season, date and
// search filters would all scope the row beside it and not this one.
ok(/var apShare = progAutopayShare\(filteredRows\);/.test(src),
   "apShare is computed from filteredRows, the funnel's own output");
// The declaration itself is `function progAutopayShare(rows)`, so this has to
// exclude it or the assertion can never pass.
ok(!/(?<!function )progAutopayShare\(rows\)/.test(src),
   "nothing computes the share from the unscoped feed");

// Both readings on screen, keyed so a browser can assert the VALUE. "A card
// rendered" passes on a share computed from the wrong pair of columns.
ok(/data-prog-autopay-pct=/.test(src), "the dollars share is keyed for the render check");
ok(/data-prog-autopay-items=/.test(src), "the registration share is keyed too");
{
  // The HEADLINE is the dollars share. Swapping the two renders an equally
  // plausible number, so which attribute carries which is pinned.
  const i = src.indexOf("data-prog-autopay-pct=");
  const j = src.indexOf("data-prog-autopay-items=");
  ok(i > 0 && j > i, "the attributes are still findable, headline first");
  ok(/data-prog-autopay-pct=\{apShare\.pctValue == null \? '' : apShare\.pctValue\}/.test(src),
     "the headline attribute carries pctValue (DOLLARS), not pctItems");
  ok(/data-prog-autopay-items=\{apShare\.pctItems == null \? '' : apShare\.pctItems\}/.test(src),
     "the sub-line attribute carries pctItems (REGISTRATIONS)");
}

// ── card 17295 v7 (the repo mirror) ────────────────────────────────────────
for (const col of ["autopay_plan_items", "manual_plan_items",
                   "autopay_plan_value", "manual_plan_value"]) {
  ok(new RegExp("AS " + col + "\\b").test(sql), "card 17295 emits " + col);
}

// IS TRUE / IS FALSE, never a bare test. pp.on_autopay is NULL for an item with
// no installments; `FILTER (WHERE NOT pp.on_autopay)` would drop those from the
// manual side too (correct by accident) but `FILTER (WHERE pp.on_autopay)` reads
// the same as IS TRUE and the pair has to be explicit to survive review.
// COUNT them, both sides. A single .test() matched the *_cents line and let a
// mutation of the *_items line through on the first draft of this spec.
eq((sql.match(/FILTER \(WHERE pp\.on_autopay IS TRUE\)/g) || []).length, 2,
   "BOTH auto-pay aggregates (the count and the value) test IS TRUE");
eq((sql.match(/FILTER \(WHERE pp\.on_autopay IS FALSE\)/g) || []).length, 2,
   "BOTH manual aggregates test IS FALSE — so a NULL (no installments) is on neither side");
// IS NOT TRUE is the dangerous near-miss: it INCLUDES NULL, so every
// registration paid in full would be reported as collected manually.
ok(!/on_autopay IS NOT /.test(sql),
   "neither side uses IS NOT TRUE / IS NOT FALSE, which would sweep in every item with no plan at all");

// An unresolvable plan row must read as MANUAL, never as auto-pay: it is
// certainly not proven auto-pay. Without the COALESCE, BOOL_OR over a missed
// join returns NULL and the registration silently leaves the denominator.
ok(/BOOL_OR\(COALESCE\(pl\.autopay_enabled, FALSE\)\)/.test(sql),
   "on_autopay COALESCEs a missing plan row to FALSE (manual), not to NULL");

// NO NEW SCAN. The collection method comes off the pp LATERAL that was already
// reading each item's installments for pending_cents. A second lateral over
// payment_plan_installment would double the work on a card already past the
// app's 60s+120s ceiling.
{
  const n = (sql.match(/FROM payment_plan_installment ppi/g) || []).length;
  eq(n, 1, "there is exactly ONE pass over payment_plan_installment");
}

// ...and pending_cents keeps its own expression and filter, untouched. Verified
// at apex against a copy of the pre-v7 lateral: 4,323 sections, ZERO diffs.
ok(/COALESCE\(SUM\(ppi\.amount_cents\) FILTER \(WHERE ppi\.paid_at IS NULL AND ppi\.waived_at IS NULL\),0\) AS pending_cents/.test(sql),
   "pending_cents is byte-for-byte the pre-v7 expression");
// plan_cents is EVERY installment, paid and unpaid — it is the size of the book
// on each method, not what is still owed. Reusing pending_cents here would make
// the metric shrink as an org collects, which is the opposite of adoption.
ok(/COALESCE\(SUM\(ppi\.amount_cents\),0\)\s+AS plan_cents/.test(sql),
   "plan_cents is unfiltered — total plan value, not the remaining balance");

// The v7 columns are APPENDED, so a warm v6 cache entry stays readable.
{
  // Scoped to the FINAL select list. Both names also appear as CTE aliases
  // inside sec_fac and sec_fin, where sec_fin comes first — so an unscoped
  // indexOf compares the wrong pair and fails on a perfectly ordered card.
  const out = sql.slice(sql.lastIndexOf("\nSELECT\n"));
  const iV6 = out.indexOf("AS instructor_count");
  const iV7 = out.indexOf("AS autopay_plan_items");
  ok(iV6 > 0 && iV7 > iV6, "the v7 columns come AFTER every v6 one in the output list");
}

// ══════════════════════════════════════════════════════════════════════════
// v8 — WHY the outstanding balance is outstanding
// ══════════════════════════════════════════════════════════════════════════

// The apex shape, all-time: 96% of Outstanding was not-yet-due money and the
// $24,728 that was actually late was invisible inside it.
const APEX_OUT = [
  { outstanding: 577575.32, pastDueValue: 24727.58,
    scheduledAutopayValue: 191999.90, scheduledManualValue: 360847.84,
    noPlanBalanceValue: 0 },
];
{
  const r = progOutstandingSplit(APEX_OUT);
  eq(r.pastDue, 24727.58, "past due at apex");
  eq(r.schedManual, 360847.84, "scheduled, manual, at apex");
  eq(r.schedAutopay, 191999.90, "scheduled, on auto-pay, at apex");
  eq(r.residual, 0, "the four add back to Outstanding exactly");
  ok(r.reconciles, "...so it reconciles");
  ok(r.pastDue / r.outstanding < 0.05,
     "past due is under 5% of the total — which is why one Outstanding figure hid it");
}

// It sums across ROWS, so a program's split is its sections' and the report's is
// every program's.
{
  const r = progOutstandingSplit([
    { outstanding: 600, pastDueValue: 100, scheduledAutopayValue: 500, scheduledManualValue: 0,   noPlanBalanceValue: 0 },
    { outstanding: 250, pastDueValue: 50,  scheduledAutopayValue: 0,   scheduledManualValue: 200, noPlanBalanceValue: 0 },
    { outstanding: 400, pastDueValue: 0,   scheduledAutopayValue: 0,   scheduledManualValue: 300, noPlanBalanceValue: 100 },
    { outstanding: 75,  pastDueValue: 25,  scheduledAutopayValue: 0,   scheduledManualValue: 50,  noPlanBalanceValue: 0 },
  ]);
  eq(r.outstanding, 1325, "Outstanding is the sum of the rows");
  eq(r.pastDue, 175, "past due is the sum of the rows");
  eq(r.schedManual, 550, "scheduled is the sum of the rows");
  eq(r.schedAutopay, 500, "on auto-pay is the sum of the rows");
  eq(r.noPlan, 100, "the no-plan balance is the sum of the rows");
  ok(r.reconciles, "and the four still add back up");
}

// ── A BREAKDOWN THAT DOES NOT SUM MUST SAY SO ──────────────────────────────
// The card partitions Outstanding exactly, so the only honest drift is per-row
// rounding. Anything larger is a defect and belongs on screen, not hidden.
{
  const r = progOutstandingSplit([
    { outstanding: 1000, pastDueValue: 100, scheduledAutopayValue: 100,
      scheduledManualValue: 100, noPlanBalanceValue: 0 },
  ]);
  eq(r.residual, 700, "the unexplained remainder is reported, not absorbed");
  ok(!r.reconciles, "...and flagged as not reconciling");
}
{
  // Two cents of rounding across a few rows is not a defect and must not shout.
  const r = progOutstandingSplit([
    { outstanding: 100.02, pastDueValue: 50.00, scheduledAutopayValue: 25.00,
      scheduledManualValue: 25.00, noPlanBalanceValue: 0 },
  ]);
  ok(r.reconciles, "cents of rounding still reconciles — the tolerance is not zero");
  eq(r.residual, 0.02, "...and the residual is still reported honestly");
}

// ── nothing owed needs no breakdown, but an UNEXPLAINED balance still does ──
eq(progOutstandingSplit([]), null, "no rows is null");
eq(progOutstandingSplit([{ outstanding: 0, pastDueValue: 0, scheduledAutopayValue: 0,
                           scheduledManualValue: 0, noPlanBalanceValue: 0 }]), null,
   "an org that owes nothing gets no breakdown");
{
  // The gate tests the TOTAL, not the parts. A pre-v8 feed carrying a real
  // Outstanding must not be silently dropped here — colPresence.outSplit is
  // what hides the panel in that case, and it is asserted separately below.
  const r = progOutstandingSplit([{ outstanding: 900 }]);
  ok(r !== null, "an outstanding balance with no v8 columns still returns a result");
  eq(r.residual, 900, "...whose whole balance is unexplained, rather than reading as scheduled");
}

// ── page invariants ────────────────────────────────────────────────────────
for (const [field, col] of [
  ["pastDueValue",          "past_due_value"],
  ["scheduledAutopayValue", "scheduled_autopay_value"],
  ["scheduledManualValue",  "scheduled_manual_value"],
  ["noPlanBalanceValue",    "no_plan_balance_value"],
]) {
  ok(new RegExp(field + ":\\s*raw\\['" + col + "'\\]").test(src),
     "normalizeRow maps " + col + " onto " + field);
  ok(new RegExp("g\\." + field + "\\s*\\+=\\s*fmtNum\\(r\\." + field + "\\)").test(src),
     "rollupToPrograms sums " + field + " across a program's sections");
}

ok(/outSplit:\s*raw\.some\(r => 'past_due_value' in r\)/.test(src),
   "the presence gate tests for the COLUMN on the raw feed");
ok(/\{colPresence\.outSplit && outSplit \? \(/.test(src),
   "the breakdown renders only when the column is present — a pre-v8 feed keeps the single figure");
ok(/progOutstandingSplit\(filteredRows\)/.test(src),
   "the split is computed from filteredRows, the same funnel output as the total it decomposes");
// Excludes the declaration, which is literally `function
// progOutstandingSplit(rows)` — same trap as the share assertion above.
ok(!/(?<!function )progOutstandingSplit\(rows\)/.test(src),
   "nothing computes the split from the unscoped feed");
ok(/!outSplit\.reconciles && \(/.test(src),
   "the page renders the unexplained remainder when the parts do not sum");
// Past due leads, because it is the only row anybody can act on.
{
  const i = src.indexOf("data-out-pastdue=");
  const j = src.indexOf("data-out-sched=");
  const k = src.indexOf("data-out-autopay=");
  ok(i > 0 && j > i && k > j, "past due is the FIRST row of the breakdown");
}
// ...and it is NOT split by method. A `data-out-pastdue-autopay` would be that
// split leaking back in, which Dan ruled out: a declined card is simply late.
ok(!/data-out-pastdue-autopay/.test(src),
   "past due is one number, not split by collection method");

// ── card 17295 v8 (the repo mirror) ────────────────────────────────────────
for (const col of ["past_due_value", "scheduled_autopay_value",
                   "scheduled_manual_value", "no_plan_balance_value"]) {
  ok(new RegExp("AS " + col + "\\b").test(sql), "card 17295 emits " + col);
}

// PAST DUE IS THE STRICT TEST. `due_at < NOW()` is false for a NULL, so a
// dateless installment cannot be reported as late. 9% of unpaid installments
// platform-wide have no due date, across 76 orgs.
ok(/AND ppi\.due_at < NOW\(\)\),0\)\s+AS past_due_cents/.test(sql),
   "past due tests due_at < NOW() and nothing else");
// ...and SCHEDULED SPELLS THE NULL OUT. An implicit `>= NOW()` alone drops every
// dateless installment from all three buckets, and the four stop summing to
// Outstanding — silently, and only for the 76 orgs that have them.
{
  const n = (sql.match(/\(ppi\.due_at >= NOW\(\) OR ppi\.due_at IS NULL\)/g) || []).length;
  eq(n, 2, "BOTH scheduled aggregates count a NULL due date as scheduled");
}
// The buckets share pending_cents' own unpaid/unwaived filter, or they would
// partition a different set than the number they decompose.
{
  const n = (sql.match(/WHERE ppi\.paid_at IS NULL AND ppi\.waived_at IS NULL/g) || []).length;
  ok(n >= 3, "every due-date bucket carries the unpaid/unwaived filter — got " + n);
}
// Every bucket mirrors pending_cents' `payment_plan IS NULL` test, or an item
// with no plan but with installments is counted twice and the four overshoot.
{
  const n = (sql.match(/CASE WHEN ic\.payment_plan IS NULL THEN 0/g) || []).length;
  eq(n, 3, "the three plan buckets are zero for an item with no payment plan");
}
ok(/SUM\(CASE WHEN ic\.payment_plan IS NULL\n\s*THEN GREATEST\(ic\.final_cents - ic\.collected_cents, 0\)\n\s*ELSE 0 END\)\s+AS no_plan_balance_cents/.test(sql),
   "the no-plan bucket is the OTHER half of that same CASE, so the two cover it exactly");
// Still one pass: v8 adds three aggregates to the lateral v7 already extended.
{
  const n = (sql.match(/FROM payment_plan_installment ppi/g) || []).length;
  eq(n, 1, "v8 still reads payment_plan_installment exactly ONCE");
}
{
  const iV7 = sql.lastIndexOf("AS manual_plan_value");
  const iV8 = sql.lastIndexOf("AS past_due_value");
  ok(iV7 > 0 && iV8 > iV7, "the v8 columns come AFTER every v7 one in the output list");
}

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ programs-autopay.spec.js — " + failures.length + " failure(s):\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n" + pass + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
console.log("✓ programs-autopay.spec.js — " + pass + " assertions passed");
