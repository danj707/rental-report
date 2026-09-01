#!/usr/bin/env node
/* ============================================================================
 * programs-autopay.spec.js — "% on Auto-Pay vs % on manual collection" on the
 * Programs summary (Dan, 2026-09-01), and card 17295 v7 underneath it.
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
 * It LIFTS AND RUNS progAutopayShare rather than regexing it — a regex passes on
 * a share computed from the wrong pair of columns. (The nightStateFrom lesson.)
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

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ programs-autopay.spec.js — " + failures.length + " failure(s):\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n" + pass + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
console.log("✓ programs-autopay.spec.js — " + pass + " assertions passed");
