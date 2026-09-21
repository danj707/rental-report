
/* ============================================================================
   FEE ALLOCATION BY GL CODE
   ----------------------------------------------------------------------------
   The remittance worksheet Danvers rebuilt by hand every week, computed from the
   rows the GL Code Rollup has already loaded. No second feed and no second
   query: every input is a column on card 17293.

   PURE ON PURPOSE - no Express, no fetch, no DOM. Every defect this can have is
   arithmetic about a threshold or a share, and a regex over an allocation passes
   just as happily on an inverted one, so scripts/fee-allocation.spec.js LIFTS
   AND RUNS these functions rather than reading them.

   ── THE ONE RULE THAT SHAPES EVERYTHING ──────────────────────────────────────
   EVERY FEE IS AN ALLOCATION OF A TOTAL, NEVER A SUM OF PER-ROW FEES.

   The section total is computed ONCE from the org-wide figure and then split
   across GL codes; it is never the sum of independently-rounded rows. Two
   reasons, and the second is why this is not merely tidier:

   1. The report is checked against the Rec remittance summary, which charges
      3.5% of the WHOLE card total and $0.30 per ACTUAL transaction. Summing
      rounded per-row fees lands a cent or two off that, and a cent that cannot
      be explained is how a finance report stops being trusted. (Danvers' own
      hand-built sheet carries exactly this: its summary reads $3,914.46 and its
      verification line $3,914.47.)

   2. THE PER-GL TRANSACTION COUNTS OVERCOUNT, and only an allocation can
      absorb it. A card payment that pays for two GL codes' items in one go is
      counted once under each, so the per-GL counts sum to MORE than the
      transactions that actually happened. Measured at Danvers over the 12
      months to 2026-09: 73 of 3,942 card payments (1.9%) touch two GL codes, so
      the per-GL counts sum to 4,015. Multiply those by $0.30 and the fixed fee
      overshoots the real charge by $21.90 a year - invisibly, because each row
      looks right. Allocating $0.30 x the TRUE distinct count across the per-GL
      counts ties to the remittance summary every week and leaves the per-GL
      split essentially unchanged.

      The week Danvers' own worksheet covers (2026-08-23..31) happens to contain
      no split payments at all - 147 + 61 + 9 = 217, exactly the true count -
      which is why the manual method has always reconciled. It will not always.

   ── WHERE THE TRUE COUNT COMES FROM ──────────────────────────────────────────
   Card 17293 emits per-DESK distinct card counts beside the per-GL ones. A
   transaction_event_id has exactly one desk, so those ARE additive across desks
   (the same property the existing "Desk Distinct Payments" column relies on for
   the TOTALS row). Absent them - a feed cached before the card carried them -
   `trueCardPayments` is null and the allocation falls back to the per-GL sum,
   which is the old hand-built behaviour rather than a wrong number.
   ============================================================================ */

// Rates are stored as INTEGERS - basis points and cents - not floats. A rate is
// a configured number that gets multiplied by every dollar on the page, so
// storing 0.035 invites a stored 0.0349999 and a report that is a cent out for
// reasons nobody can find. 350 bps is 3.5%.
const DEFAULT_FEE_RATES = {
  ccVariableBps: 350, // 3.5% of card volume
  ccFixedCents:   30, // $0.30 per card transaction
  cashBps:       100, // 1.0% of cash taken
  checkBps:      100, // 1.0% of cheques taken
  techBps:       100, // 1.0% of all sales
};

const FEE_RATE_KEYS = Object.keys(DEFAULT_FEE_RATES);

function normalizeFeeRates(raw) {
  const out = Object.assign({}, DEFAULT_FEE_RATES);
  if (raw && typeof raw === "object") {
    for (const k of FEE_RATE_KEYS) {
      const n = Number(raw[k]);
      // A rate we cannot read falls back to the platform default rather than to
      // zero: a silent 0% reads on screen as "this org is charged nothing",
      // which is a claim about their contract rather than about our parsing.
      if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
    }
  }
  return out;
}

// Dollars in, whole cents out. Every figure on the card is already rounded to
// 2dp, so this is exact rather than hopeful.
function toCents(dollars) {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function countOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/* Largest-remainder (Hamilton) apportionment of `totalCents` across `weights`.
   Returns whole cents summing EXACTLY to totalCents.

   This is what makes "the parts add up" a property rather than a hope. Rounding
   each share independently leaves the column a cent or two off its own total,
   and this report's whole job is to reconcile against a number somebody else
   computed.

   Weights that are all zero return all zeros - a section with no money in it
   allocates nothing, and spreading a total evenly over rows that contributed
   none of it would invent a charge. */
function apportion(totalCents, weights) {
  const n = weights.length;
  const out = new Array(n).fill(0);
  if (!n || !totalCents) return out;

  const sum = weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  if (sum <= 0) return out;

  const rema = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    const exact = (totalCents * w) / sum;
    const floor = Math.floor(exact);
    out[i] = floor;
    used += floor;
    rema.push({ i, r: exact - floor, w });
  }
  // Ties broken by the larger weight, then by position, so two runs over the
  // same rows can never disagree about which row gets the spare cent.
  rema.sort((a, b) => (b.r - a.r) || (b.w - a.w) || (a.i - b.i));
  let left = totalCents - used;
  for (let k = 0; left > 0 && k < rema.length; k++, left--) out[rema[k].i] += 1;
  return out;
}

const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

/* Collapse the feed's gl_code x desk rows to one row per GL CODE.

   The rollup is grouped by desk as well as GL code, so an org with two desks
   sends two rows for one GL code. The remittance worksheet is per GL code, so
   they are summed here - and the per-desk distinct card counts are collected
   separately, deduped by desk, because those are the one thing that must NOT be
   summed per row. */
function collapseByGlCode(rows) {
  const byGl = new Map();
  const byDesk = new Map();
  // PRESENCE, asked of the response, never of a value. Feeds cache for four
  // hours, so a pre-column payload and a post-column one are both live at once
  // after the card is pushed, and `countOf(undefined)` is 0 - which would print
  // a confident $0.00 fixed fee and a grand total silently short by it. Same
  // rule as hasAbsent / ciHasStatus / mbHasProductKind.
  let hasTxnCounts = false;

  for (const r of rows || []) {
    if (r && r.cardPaymentTxns != null) hasTxnCounts = true;
    const key = String(r.glCode == null ? "" : r.glCode);
    if (!byGl.has(key)) {
      byGl.set(key, {
        glCode: key,
        accountName: r.accountName || "",
        cardPayCents: 0, cardRefCents: 0, cashCents: 0, checkCents: 0, revenueCents: 0,
        nCardPay: 0, nCardRef: 0, nCash: 0, nCheck: 0,
      });
    }
    const g = byGl.get(key);
    if (!g.accountName && r.accountName) g.accountName = r.accountName;
    g.cardPayCents += toCents(r.ccPayments);
    g.cardRefCents += toCents(r.ccRefunds);
    g.cashCents    += toCents(r.cashPayments);
    g.checkCents   += toCents(r.checkPayments);
    g.revenueCents += toCents(r.totalPayments);
    g.nCardPay += countOf(r.cardPaymentTxns);
    g.nCardRef += countOf(r.cardRefundTxns);
    g.nCash    += countOf(r.cashTxns);
    g.nCheck   += countOf(r.checkTxns);

    const desk = r.deskLocation || "";
    if (!byDesk.has(desk) && r.deskDistinctCardPayments != null) {
      byDesk.set(desk, {
        pay: countOf(r.deskDistinctCardPayments),
        ref: countOf(r.deskDistinctCardRefunds),
      });
    }
  }

  let trueCardPayments = null, trueCardRefunds = null;
  if (byDesk.size) {
    trueCardPayments = 0; trueCardRefunds = 0;
    for (const v of byDesk.values()) { trueCardPayments += v.pay; trueCardRefunds += v.ref; }
  }

  return { groups: Array.from(byGl.values()), trueCardPayments, trueCardRefunds, hasTxnCounts };
}

/* A GL code with nothing in it at all is dropped.

   Danvers carries a literal "DCOA (2)" row that is zero in every column of
   every section, and it has been deleted by hand from the worksheet every week.
   The test is on ALL the money and ALL the counts, not on revenue alone: a row
   that took a refund and no payments has something to say and must stay. */
function isEmptyGroup(g) {
  return !g.cardPayCents && !g.cardRefCents && !g.cashCents && !g.checkCents &&
         !g.revenueCents && !g.nCardPay && !g.nCardRef && !g.nCash && !g.nCheck;
}

/* ── The report ─────────────────────────────────────────────────────────────
   rows  - the GL rollup's own normalized rows (see normalizeRow in gl.html)
   rates - a partial rate object; anything missing takes the platform default

   Returns { rates, rows, totals, basis }, all money in DOLLARS at 2dp so the
   page renders what it is given and does no arithmetic of its own. `basis`
   carries what the reader needs to argue with the number: the true transaction
   count, whether the feed could supply it, and how far the per-GL counts
   overcount. */
function allocateFees(rows, rates, opts) {
  const R = normalizeFeeRates(rates);
  const derived = collapseByGlCode(rows);
  const groups = derived.groups;
  /* The caller MAY supply the true card counts, and the GL page does.
     Its desk filter re-aggregates the rows to one per GL code, which destroys
     the desk identity this function would otherwise dedupe on - so the page
     computes them from the RAW desk-scoped rows (the same dedupe its TOTALS row
     already uses) and hands them over. Unsupplied, they are derived here, which
     is the path the spec drives. */
  const o = opts || {};
  const trueCardPayments = o.trueCardPayments != null ? o.trueCardPayments : derived.trueCardPayments;
  const trueCardRefunds  = o.trueCardRefunds  != null ? o.trueCardRefunds  : derived.trueCardRefunds;
  // Presence, likewise: asked of the RESPONSE by the page, of the rows here.
  const hasTxnCounts = o.hasTxnCounts != null ? !!o.hasTxnCounts : derived.hasTxnCounts;
  const live = groups.filter(g => !isEmptyGroup(g));

  const sum = (f) => live.reduce((a, g) => a + g[f], 0);
  const cardPayCents = sum("cardPayCents");
  const cardRefCents = sum("cardRefCents");
  const cashCents    = sum("cashCents");
  const checkCents   = sum("checkCents");
  const revenueCents = sum("revenueCents");

  const nCardPaySum = sum("nCardPay");
  const nCardRefSum = sum("nCardRef");

  // The count the fixed fee is charged on. Prefer the feed's true distinct
  // count; fall back to the per-GL sum when the card cannot say, which is the
  // pre-column behaviour rather than a guess.
  const billedCardPay = trueCardPayments == null ? nCardPaySum : trueCardPayments;
  const billedCardRef = trueCardRefunds == null ? nCardRefSum : trueCardRefunds;

  // ── Section totals, each computed once from the org-wide figure ──
  const ccVarTotal  = Math.round((cardPayCents * R.ccVariableBps) / 10000);
  const refVarTotal = Math.round((cardRefCents * R.ccVariableBps) / 10000);
  // The per-transaction half exists ONLY if the feed carried counts. Computed
  // from an absent column it is 0, and a 0 here is not "no card transactions" -
  // it is "this feed cannot tell us", which understates every total below it.
  // Withheld, the page prints an em dash and says why; rendered as 0 it would
  // print a fee that is $65.10 short and look entirely plausible.
  const ccFixTotal  = hasTxnCounts ? billedCardPay * R.ccFixedCents : null;
  const refFixTotal = hasTxnCounts ? billedCardRef * R.ccFixedCents : null;
  const cashTotal   = Math.round((cashCents  * R.cashBps)  / 10000);
  const checkTotal  = Math.round((checkCents * R.checkBps) / 10000);
  const techTotal   = Math.round((revenueCents * R.techBps) / 10000);

  // ── ...then split across GL codes so the columns sum to them exactly ──
  const ccVar  = apportion(ccVarTotal,  live.map(g => g.cardPayCents));
  const ccFix  = apportion(ccFixTotal || 0,  live.map(g => g.nCardPay));
  const refVar = apportion(refVarTotal, live.map(g => g.cardRefCents));
  const refFix = apportion(refFixTotal || 0, live.map(g => g.nCardRef));
  const cashF  = apportion(cashTotal,   live.map(g => g.cashCents));
  const checkF = apportion(checkTotal,  live.map(g => g.checkCents));
  const techF  = apportion(techTotal,   live.map(g => g.revenueCents));

  const d = (cents) => Math.round(cents) / 100;

  const out = live.map((g, i) => {
    const ccPayFee = hasTxnCounts ? ccVar[i] + ccFix[i] : null;
    const ccRefFee = hasTxnCounts ? refVar[i] + refFix[i] : null;
    const ccFee    = hasTxnCounts ? ccPayFee + ccRefFee : null;
    const ccheck   = cashF[i] + checkF[i];
    const total    = hasTxnCounts ? ccFee + ccheck + techF[i] : null;
    return {
      glCode: g.glCode,
      accountName: g.accountName,

      // Step 1 — what came in
      cardPayments: d(g.cardPayCents),
      cardRefunds:  d(g.cardRefCents),
      cash:         d(g.cashCents),
      check:        d(g.checkCents),
      revenue:      d(g.revenueCents),
      nCardPay: g.nCardPay, nCardRef: g.nCardRef, nCash: g.nCash, nCheck: g.nCheck,

      // Step 2 — credit card
      pctCardPay:   pct(g.cardPayCents, cardPayCents),
      ccVariable:   d(ccVar[i]),
      ccFixed:      hasTxnCounts ? d(ccFix[i]) : null,
      ccPaymentFee: hasTxnCounts ? d(ccPayFee) : null,
      pctCardRef:   pct(g.cardRefCents, cardRefCents),
      refVariable:  d(refVar[i]),
      refFixed:     hasTxnCounts ? d(refFix[i]) : null,
      ccRefundFee:  hasTxnCounts ? d(ccRefFee) : null,
      ccFees:       hasTxnCounts ? d(ccFee) : null,

      // Step 3 — cash & cheque
      cashFee:      d(cashF[i]),
      checkFee:     d(checkF[i]),
      cashCheckFees: d(ccheck),

      // Step 4 — technology
      pctRevenue:   pct(g.revenueCents, revenueCents),
      techFee:      d(techF[i]),

      // Step 5 — summary
      totalFees:    hasTxnCounts ? d(total) : null,
      feePctRevenue: hasTxnCounts ? pct(total, g.revenueCents) : null,
    };
  });

  const ccFeesTotal    = hasTxnCounts ? ccVarTotal + ccFixTotal + refVarTotal + refFixTotal : null;
  const cashCheckTotal = cashTotal + checkTotal;
  const grandTotal     = hasTxnCounts ? ccFeesTotal + cashCheckTotal + techTotal : null;

  return {
    rates: R,
    rows: out,
    totals: {
      cardPayments: d(cardPayCents),
      cardRefunds:  d(cardRefCents),
      cash:         d(cashCents),
      check:        d(checkCents),
      revenue:      d(revenueCents),
      // The counts printed on the TOTALS row are the ones the fee is charged
      // on, not the sum of the column above them. Printing the column sum there
      // would contradict the fixed fee sitting two rows down.
      nCardPay: hasTxnCounts ? billedCardPay : null,
      nCardRef: hasTxnCounts ? billedCardRef : null,
      nCash: sum("nCash"), nCheck: sum("nCheck"),

      ccVariable:   d(ccVarTotal),
      ccFixed:      hasTxnCounts ? d(ccFixTotal) : null,
      ccPaymentFee: hasTxnCounts ? d(ccVarTotal + ccFixTotal) : null,
      refVariable:  d(refVarTotal),
      refFixed:     hasTxnCounts ? d(refFixTotal) : null,
      ccRefundFee:  hasTxnCounts ? d(refVarTotal + refFixTotal) : null,
      ccFees:       hasTxnCounts ? d(ccFeesTotal) : null,

      cashFee:      d(cashTotal),
      checkFee:     d(checkTotal),
      cashCheckFees: d(cashCheckTotal),

      techFee:      d(techTotal),
      totalFees:    hasTxnCounts ? d(grandTotal) : null,
      feePctRevenue: hasTxnCounts ? pct(grandTotal, revenueCents) : null,
    },
    basis: {
      // Did the feed carry the true distinct counts, or are we on the old card?
      // PRESENCE, not a value: a pre-column feed reporting 0 would read as "no
      // card payments" rather than "this feed cannot tell us".
      // Can this feed price the per-transaction half at all? False on a payload
      // cached before the card carried the counts, and the page says so rather
      // than printing a short total.
      hasTxnCounts,
      hasTrueCounts: trueCardPayments != null,
      billedCardPayments: hasTxnCounts ? billedCardPay : null,
      billedCardRefunds:  hasTxnCounts ? billedCardRef : null,
      // How much the per-GL counts overcount, i.e. how many card payments in
      // this window paid for more than one GL code. Zero on most weeks; the
      // report says so on screen when it is not, because it is the one number
      // that explains why a row's fee is not exactly $0.30 x its own count.
      splitCardPayments: nCardPaySum - billedCardPay,
      splitCardRefunds:  nCardRefSum - billedCardRef,
      emptyGlCodes: groups.length - live.length,
    },
  };
}

/* ONE COPY, TWO READERS - the page loads this as a plain <script src> and
   scripts/fee-allocation.spec.js requires it as a module. A second copy inside
   gl.html is how a spec ends up proving the arithmetic of code the browser does
   not run, which is the shape of every drift bug this repo keeps recording.
   Deliberately NOT compiled by Babel (it is not a text/babel block), so `const`
   here behaves as `const` rather than becoming `var`. */
var RecFeeAllocation = {
  DEFAULT_FEE_RATES: DEFAULT_FEE_RATES, FEE_RATE_KEYS: FEE_RATE_KEYS,
  normalizeFeeRates: normalizeFeeRates, apportion: apportion,
  collapseByGlCode: collapseByGlCode, isEmptyGroup: isEmptyGroup,
  allocateFees: allocateFees,
};
if (typeof module !== "undefined" && module.exports) module.exports = RecFeeAllocation;
if (typeof window !== "undefined") window.RecFeeAllocation = RecFeeAllocation;
