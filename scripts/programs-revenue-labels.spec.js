#!/usr/bin/env node
/* ============================================================================
 * programs-revenue-labels.spec.js — the two things Dan pinned on the Programs
 * summary on 2026-09-02, fixed on 2026-09-03:
 *
 *   #32  "it seems these revenue amounts are a bit high, no? This is august
 *        program revenue for Aug"  — the LABELS, not the arithmetic.
 *   #31  "pin to add a 'total refunds' metric/card on this program summary
 *        page. seems like that's a big item we're missing."
 *
 * WHAT WAS WRONG. On Apex over 1-31 August 2026 the row read
 * NET REVENUE $2,768,423 ("total for these programs") beside
 * COLLECTED IN PERIOD $275,553 ("payments received in date range"), under a
 * header saying August 1 - August 31. Apex's actual August programme money,
 * measured from materialized.item_log_report, is $789,595 collected /
 * $67,846 refunded / $721,749 net. So one figure was ~3.8x August and the
 * other ~38% of it — and BOTH were correct for what they measure:
 *
 *   · card 17295 windows SECTIONS by their session dates overlapping the
 *     range, so August returns every section that RUNS in August (1,529);
 *   · net_total is ALL-TIME for those sections, however many months they took;
 *   · period_received / period_refunds / period_net are cash that moved inside
 *     the window, for those sections only.
 *
 * The ~$514K gap on the period card is August money paid for sections that do
 * NOT run in August — fall and winter registrations — which is a real
 * distinction the sub-line "payments received in date range" did not make.
 *
 * NO CARD CHANGE WAS NEEDED FOR EITHER. Card 17295 has emitted `refunds`,
 * `period_refunds` and `period_net` since v3 and public/programs.html has
 * mapped and rolled up all three the whole time — no surface read them. That
 * is the fourth instance in this repo of the mapped-and-rendered-nowhere
 * pattern (the location filter, then instructor, then the auto-pay columns),
 * and it is why the render cases key on the CELL rather than on the column.
 *
 * The assertions here are the four things that can be wrong while still
 * rendering a plausible number:
 *
 *   1. ONE REDUCER, N READERS. `progRevTotals` is the single source; six
 *      inline reduces over the same rows is how two surfaces start reporting
 *      different totals for one window.
 *   2. THE WINDOW FIGURE LEADS, and each card names its own basis. A reader of
 *      a date-ranged report means period_net by "August revenue".
 *   3. A REAL $0 RENDERS; A PRE-v3 FEED DOES NOT. The gate is PRESENCE, asked
 *      of the RAW response — the mapper defaults both refund columns to 0, so
 *      a value test renders a confident $0 on every warm pre-v3 cache entry.
 *   4. THE REFUND SHARE IS null, NEVER 0%, with nothing received. "No payments
 *      came in" is not a 0% refund rate.
 *
 * It LIFTS AND RUNS progRevTotals rather than regexing it — a regex passes on
 * a total summed from the wrong column. (The nightStateFrom lesson.)
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "programs.html");
const src  = fs.readFileSync(PAGE, "utf8");
// The source assertions run over a comment-stripped copy: the comments quote
// the OLD labels ("total for these programs") on purpose, so a naive test for
// their absence passes on the broken page and fails on the fixed one.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// ── lift and RUN ────────────────────────────────────────────────────────────
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  // Skip the parameter list before counting braces: for a destructured
  // parameter the first `{` is the pattern, not the body, and counting from it
  // cuts the function in half. Third instance of that trap in this repo.
  let i = text.indexOf(")", start);
  let depth = 0;
  i = text.indexOf("{", i);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}
const progRevTotals = new Function(
  liftFn(src, "fmtNum") + "\n" + liftFn(src, "progRevTotals") +
  "; return progRevTotals;")();

/* ── 1. APEX, in its real proportions ───────────────────────────────────────
   Two programs whose lifetime revenue dwarfs the window's, which is the whole
   shape of the complaint. The fixture makes the two figures differ by ~10x —
   a fixture where they coincide cannot tell a correct card from one reading
   the other column. */
const APEX = [
  { netRevenue: 2000000, periodNet: 200000, refunds: 300000, periodRefunds: 50000, periodReceived: 250000 },
  { netRevenue:  768423, periodNet:  75553, refunds:  40000, periodRefunds: 17846, periodReceived:  93000 },
];
{
  const r = progRevTotals(APEX);
  eq(r.lifetimeNet, 2768423, "lifetime net is the sum of net_total");
  eq(r.periodNet,    275553, "period net is the sum of period_net");
  eq(r.lifetimeRefunds, 340000, "lifetime refunds is the sum of refunds");
  eq(r.periodRefunds,    67846, "period refunds is the sum of period_refunds");
  eq(r.periodReceived,  343000, "period received is the sum of period_received");
  ok(r.lifetimeNet / r.periodNet > 9,
     "the two revenue figures differ by ~10x on this fixture, so a card reading the wrong one fails");
  // 67,846 / 343,000 = 19.78%
  eq(r.refundPct, 19.8, "the refund share is refunds over payments RECEIVED in the same window");
}

/* ── 2. THE SHARE IS null, NEVER 0%, with nothing received ──────────────────
   A window in which no payment arrived has no refund rate. A 0 there reads as
   "nothing was refunded", which is a different and possibly false claim — and
   this fixture refunds real money against zero receipts, which is exactly the
   shape that happens when a program is cancelled and refunded in a quiet
   month. */
{
  const r = progRevTotals([
    { netRevenue: 5000, periodNet: -900, refunds: 900, periodRefunds: 900, periodReceived: 0 },
  ]);
  eq(r.refundPct, null, "no payments received ⇒ null share, not 0%");
  eq(r.periodRefunds, 900, "...while the refund figure itself is still reported");
  ok(r.periodNet < 0, "and a window of pure refunds is negative, not clamped");
}

/* ── 3. A REAL ZERO IS AN ANSWER ────────────────────────────────────────────
   An org that refunded nothing in the window must read $0 and 0%, not a dash.
   Only a feed that CANNOT tell us hides the card — see the presence gate. */
{
  const r = progRevTotals([
    { netRevenue: 1000, periodNet: 400, refunds: 0, periodRefunds: 0, periodReceived: 400 },
  ]);
  eq(r.periodRefunds, 0, "a real zero is zero");
  eq(r.refundPct, 0, "and its share is a real 0%, not null — money came in and none went back");
}

/* ── 4. Missing columns read as 0, never NaN ────────────────────────────────
   fmtNum is what makes a pre-v3 row summable at all. The CARD is hidden on
   such a feed by the presence gate; the reducer must still not produce NaN,
   or every figure in the row renders as "$NaN". */
{
  const r = progRevTotals([{ netRevenue: 100, periodNet: 40 }]);
  eq(r.periodRefunds, 0, "an absent refund column sums to 0, not NaN");
  ok(!Number.isNaN(r.refundPct), "and the share is not NaN");
  eq(r.refundPct, null, "no period_received ⇒ null share");
}
{
  const r = progRevTotals([]);
  eq(r.lifetimeNet, 0, "no programs at all is zero, not NaN");
  eq(r.refundPct, null, "and has no share");
}

/* ── 5. ONE REDUCER, N READERS ──────────────────────────────────────────────
   The cards and both Grand Total rows read progRevTotals. A second inline
   reduce over the same field is how the summary row and the tables start
   disagreeing about one window — the facility Summary bug, where chips scoped
   some panels and not others for a week. */
{
  ok(/function progRevTotals\(/.test(code), "progRevTotals is at module scope, so a spec can run it");
  ok((code.match(/progRevTotals\(/g) || []).length >= 2,
     "and it has at least one caller besides its definition");
  // The inline reduces it replaced must not come back.
  ok(!/reduce\(function\(s,p\)\{ return s \+ p\.netRevenue; \}/.test(code),
     "the lifetime-net reduce is not re-inlined beside the helper");
  ok(!/reduce\(function\(s,p\)\{ return s \+ p\.periodNet; \}/.test(code),
     "nor the period-net one");
  ok(!/reduce\(function\(s,p\)\{ return s \+ p\.periodRefunds; \}/.test(code),
     "nor the period-refunds one");
}

/* ── 6. THE LABELS ─────────────────────────────────────────────────────────
   This is #32, and it is the whole fix: the arithmetic never changed. The old
   pair could not be told apart by a reader — "total for these programs" does
   not say ALL-TIME, and "payments received in date range" does not say the
   sections are only those running in the range. */
{
  ok(!/total for these programs/.test(code),
     'the sub-line "total for these programs" is gone — it did not say LIFETIME');
  ok(!/>Net Revenue<\/div>/.test(code),
     'the bare label "Net Revenue" is gone from the summary row');
  ok(/Lifetime Net Revenue/.test(code), "the all-time figure says LIFETIME on it");
  ok(/all-time for these programs, not just this period/.test(code),
     "...and its sub-line says it is not this period's revenue");
  ok(/Net Revenue in Period/.test(code), "the window figure names its window");
  ok(/received minus refunds, /.test(code),
     "...and says what it is net of, so the refunds card is not double-counted");

  // THE TWO TABS USED TO DISAGREE UNDER ONE LABEL. The summary tab's
  // "Collected in Period" showed period_NET while the Revenue tab's card of
  // the SAME NAME shows period_RECEIVED — one label, two numbers, one report.
  const collected = (code.match(/Collected in Period/g) || []).length;
  eq(collected, 1,
     'only ONE card is called "Collected in Period" now (the Revenue tab\'s period_received)');
  ok((code.match(/Lifetime Net Revenue/g) || []).length === 2,
     "and both tabs call the lifetime figure by the same name");
}

/* ── 7. THE ORDER: the window figure LEADS ─────────────────────────────────
   Dan reads the header date range and means that figure. A lifetime number
   first is what made $2.7M look like August. */
{
  // Keyed on the LABEL markup, not on the phrase: the lifetime card's own
  // tooltip says 'Read "Net Revenue in Period"', so a bare indexOf finds that
  // and the order assertion survives the cards being swapped. Caught by
  // mutation, not by review.
  const at = t => code.indexOf(">" + t + "</div>");
  const iPeriod   = at("Net Revenue in Period");
  const iRefunds  = at("Refunds in Period");
  const iLifetime = at("Lifetime Net Revenue");
  ok(iPeriod > 0 && iLifetime > 0 && iPeriod < iLifetime,
     "the period card is rendered before the lifetime card");
  ok(iRefunds > iPeriod && iRefunds < iLifetime,
     "and the refunds card sits with the other in-window figure, not after the lifetime one");
}

/* ── 8. THE PRESENCE GATE ──────────────────────────────────────────────────
   Asked of the RAW response, like every other entry in colPresence. The
   mapper defaults `refunds` and `periodRefunds` to 0, so a VALUE test renders
   a confident $0 on every warm pre-v3 cache entry — "this org refunded
   nothing" when the truth is "this feed cannot tell us". Same rule as
   hasAbsent / ciHasStatus / mbHasProductKind. */
{
  ok(/refunds:\s+raw\.some\(r => 'period_refunds' in r/.test(code),
     "the gate reads the RAW response for the COLUMN, not a rollup and not a value");
  ok(/colPresence\.refunds && \(/.test(code),
     "and the card is gated on it — absent on a pre-v3 feed, not zeroed");
  ok(/refunds: false/.test(code),
     "it defaults to false, so nothing renders before the feed answers");
}

/* ── 9. The window label is never built from nulls ─────────────────────────
   fmtRangeShort(null, null) does not throw — it renders the literal
   "Invalid Date NaN", so a card would print that on screen. */
{
  ok(/var winLabel = \(loadedStart && loadedEnd\) \? fmtRangeShort\(loadedStart, loadedEnd\) : 'this period'/.test(code),
     "winLabel guards both dates before formatting");
  ok((code.match(/winLabel/g) || []).length >= 4,
     "and the cards read it rather than calling fmtRangeShort on possibly-null dates");
}

/* ── report ─────────────────────────────────────────────────────────────────*/
if (failures.length) {
  console.error("\n✗ programs-revenue-labels.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("✓ programs-revenue-labels.spec.js — " + pass + " assertions passed.");
