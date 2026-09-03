// Spec for the paid-book metrics added to the Memberships report on
// 2026-08-29: the Auto-Renew tab and the Sales & Mix tab, plus card 17301 v2.
//
// WHAT THE INVESTIGATION FOUND, and why these shapes exist. Measured on prod
// (db 4) on 2026-08-29:
//
//   · A `group` IS the membership record, so 141,128 "active memberships" is
//     mostly a residency file — 130,170 of them are priced at $0. The paid book
//     is 10,958 memberships ($2,563,002) plus 13,802 passes ($737,628).
//
//   · AUTO-RENEW IS A PLAN SETTING, NOT A MEMBER CHOICE. Of the 317 plans
//     carrying a paid membership, 268 have zero members on auto-renew and 47
//     have every member on it. Exactly 2 plans are mixed, covering 4 members.
//     So the useful unit is the plan.
//
//   · SEASON PASSES ARE NOT CHURN. 4,637 active paid memberships sit on plans
//     with a fixed `group.end_date`, and not one can auto-renew. Of the
//     $846,397 expiring within 90 days, $807,142 is season passes reaching the
//     end of their season — a dated re-buy, not members leaving. Folding the
//     two together is the error this whole split exists to prevent.
//
//   · `membership.last_used_at` is NULL on all 155,853 memberships and all
//     73,888 passes, so member dormancy cannot come from the feed's own column.
//
// Run: node scripts/memberships-revenue.spec.js
"use strict";

// The Retention-window assertions below turn on a UTC-vs-local off-by-one, which
// is MEANINGLESS in a UTC process — and both this sandbox and GitHub Actions run
// UTC. Caught by mutation: swapping mbISODate for toISOString().slice(0,10)
// passed the whole spec until the timezone was forced. That is the exact shape
// of a guard that looks like one and is not (see fasttrack-dates.spec.js, which
// learned it first).
//
// America/Los_Angeles is chosen for the property, not the org: it is BEHIND UTC,
// so a local evening is already tomorrow in UTC and the two implementations
// diverge. A zone ahead of UTC would not discriminate for an evening timestamp.
const TZ = "America/Los_Angeles";
if (process.env.TZ !== TZ) {
  const r = require("child_process").spawnSync(process.execPath, [__filename],
    { env: Object.assign({}, process.env, { TZ }), stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "public", "memberships.html"), "utf8");
const sql  = fs.readFileSync(path.join(ROOT, "sql", "report-cards", "17301-memberships.sql"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let passed = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); passed++; };

// ── Lift the helpers and RUN them ───────────────────────────────────────────
// Running beats regexing: a regex over our own patch passes on an inverted
// comparison (the nightStateFrom lesson).
function cut(name) {
  const i = page.indexOf("function " + name + "(");
  assert.ok(i > 0, name + " should be a named module-scope function");
  let d = 0, end = -1;
  for (let k = page.indexOf("{", i); k < page.length; k++) {
    if (page[k] === "{") d++;
    else if (page[k] === "}") { d--; if (d === 0) { end = k + 1; break; } }
  }
  assert.ok(end > i, "could not bound " + name);
  return page.slice(i, end);
}
const NAMES = ["mbIsPaid", "mbProductShape", "mbIsAutoRenew", "mbCanAutoRenew",
               "mbCycleDays", "mbMonthlyValue", "mbPlanCycles", "mbCadence",
               "mbChurnPerCycle", "mbRenewalsSoFar", "mbIsCanceled",
               "mbCancelPending", "mbHasCancelSchedule", "mbPlanKey", "mbHasProductKind",
               "mbHasResidency", "mbResidencyKey",
               "mbHasEconomics", "mbDecompose", "mbEffectiveTab", "mbRetentionWindow",
               "mbISODate"];
const api = new Function(
  "var MB_URL_TABS = ['memberships','autorenew','salesmix','checkins','retention'];\n" +
  NAMES.map(cut).join("\n") + "\nreturn { " + NAMES.join(", ") + " };")();
const { mbIsPaid, mbProductShape, mbIsAutoRenew, mbCanAutoRenew, mbCycleDays,
        mbMonthlyValue, mbPlanCycles, mbCadence, mbChurnPerCycle,
        mbRenewalsSoFar, mbIsCanceled, mbCancelPending,
        mbHasCancelSchedule, mbPlanKey, mbHasProductKind, mbHasEconomics, mbDecompose,
        mbHasResidency, mbResidencyKey,
        mbEffectiveTab, mbRetentionWindow, mbISODate } = api;

// The same membership, as the two feeds that are live at once describe it.
// A 4-hour cache means a pre-v2 response and a v2 response are both in flight
// for four hours after the card ships.
const V3_MONTHLY = { price: 20, renewalType: "Auto-renew", autoRenew: true,
  productKind: "membership", hasPlanTerms: true, hasCycle: true,
  planSeasonEnd: "", planTermDays: null,
  periodStart: "2026-08-29", nextRenewal: "2026-09-29" };
// The SAME membership as v2 described it — plan columns present, "Product Kind"
// absent. Indistinguishable from a gate fee, which is exactly the v2 bug.
const V2_MONTHLY_NO_KIND = { price: 20, renewalType: "Auto-renew", autoRenew: true,
  hasPlanTerms: true, hasCycle: true, planSeasonEnd: "", planTermDays: null,
  periodStart: "2026-08-29", nextRenewal: "2026-09-29" };
// A $6 gate admission. NOTHING about its plan columns distinguishes it from the
// monthly subscription above — a pass has no `group`, so both come back NULL.
// Norman sells 4,518 of these; v2 offered every one as a conversion candidate.
const V3_GATE_PASS = { price: 6, renewalType: "One-time", autoRenew: false,
  productKind: "pass", hasPlanTerms: true, hasCycle: true,
  planSeasonEnd: "", planTermDays: null, periodStart: "", nextRenewal: "" };
// A pass that DOES carry a term rule, now that pass_schema is joined. Still a
// pass: the kind is settled before any term test, or a dated pass would be
// filed as a season membership and land in the re-buy number.
const V3_SEASON_PASS = { price: 40, renewalType: "One-time", autoRenew: false,
  productKind: "pass", hasPlanTerms: true, hasCycle: true,
  planSeasonEnd: "2026-09-30", planTermDays: null,
  periodStart: "", nextRenewal: "" };
const PRE_V2_MONTHLY = { price: 20, renewalType: "Auto-renew", autoRenew: undefined,
  hasPlanTerms: false, hasCycle: false, planSeasonEnd: "", planTermDays: null,
  periodStart: "", nextRenewal: "2026-09-29" };
const V2_SEASON = { price: 240, renewalType: "One-time", autoRenew: false,
  hasPlanTerms: true, hasCycle: true, planSeasonEnd: "2026-09-30", planTermDays: null,
  periodStart: "", nextRenewal: "" };
const V2_ANNUAL_TERM = { price: 240, renewalType: "One-time", autoRenew: false,
  hasPlanTerms: true, hasCycle: true, planSeasonEnd: "", planTermDays: 365,
  periodStart: "", nextRenewal: "" };

// ── Paid vs free ────────────────────────────────────────────────────────────
test("a $0 residency record is not part of the paid book", () => {
  assert.strictEqual(mbIsPaid({ price: 0 }), false,
    "130,170 of the platform's 141,128 active memberships are free resident " +
    "records; counting them as revenue is the whole reason this test exists");
  assert.strictEqual(mbIsPaid({ price: 20 }), true);
  assert.strictEqual(mbIsPaid(null), false);
});

// ── Product shape ───────────────────────────────────────────────────────────
test("a plan with a fixed end date is a SEASON, not a subscription", () => {
  assert.strictEqual(mbProductShape(V2_SEASON), "season");
});

test("a rolling term is its own shape — it expires and cannot auto-renew today", () => {
  assert.strictEqual(mbProductShape(V2_ANNUAL_TERM), "term");
});

test("no end date and no term length is open-ended", () => {
  assert.strictEqual(mbProductShape(V3_MONTHLY), "open");
});

test("a pass is a PASS, whatever its plan columns say", () => {
  // The v2 bug, pinned. A pass has no `group`, so "Plan Season End" and
  // "Plan Term Days" are both NULL — byte-identical to an open-ended
  // subscription. Absence of a group term rule is not evidence of a
  // subscription, and no field-level test can tell the two apart; only the
  // product kind can. At Norman 16,940 of 20,341 rows are passes and 10,669
  // of them carried neither term rule.
  assert.strictEqual(mbProductShape(V3_GATE_PASS), "pass",
    "a $6 gate admission was being offered as an auto-renew conversion");
});

test("the pass test is settled FIRST, before any term rule", () => {
  // pass_schema now gives a pass its own end date. If the season test ran
  // first, a dated pass would read "season" and its value would land in the
  // next-season re-buy figure, which is a membership question.
  assert.strictEqual(mbProductShape(V3_SEASON_PASS), "pass");
});

test("a pre-v3 feed says UNKNOWN rather than guessing subscription", () => {
  // THE CACHE INVARIANT DOES NOT HOLD HERE, and that is deliberate: v2 and v3
  // genuinely cannot answer the same question, because v2 has no column that
  // separates a $20 monthly membership from a $6 gate fee. The resolution is
  // the presence gate below — the panels HIDE on a pre-v3 feed instead of
  // rendering a number built on a guess. Same rule as hasAbsent/ciHasStatus.
  assert.strictEqual(mbProductShape(V2_MONTHLY_NO_KIND), "unknown",
    "without Product Kind this row is indistinguishable from a day pass");
});

test("the conversion panels gate on the COLUMN, not on any row being a pass", () => {
  assert.strictEqual(mbHasProductKind([V2_MONTHLY_NO_KIND, PRE_V2_MONTHLY]), false,
    "a warm pre-v3 cache entry must hide the conversion count, not zero it");
  assert.strictEqual(mbHasProductKind([V2_MONTHLY_NO_KIND, V3_MONTHLY]), true,
    "presence of the column is the test — an org that sells no passes still " +
    "gets its conversion count");
  assert.strictEqual(mbHasProductKind([]), false);
  assert.strictEqual(mbHasProductKind(null), false);
});

test("a pre-v2 feed reads UNKNOWN, never open-ended", () => {
  // This is the load-bearing one. Guessing "open" on a feed with no plan
  // columns would file all 4,637 season passes as subscriptions and put
  // $807,142 of season-end re-buy into the churn number.
  assert.strictEqual(mbProductShape(PRE_V2_MONTHLY), "unknown");
  assert.strictEqual(mbProductShape({ hasPlanTerms: false, planSeasonEnd: "" }), "unknown");
});

// ── The denominator ─────────────────────────────────────────────────────────
// A rate is only meaningful over a base that can move. Measured on prod
// 2026-08-30 over ACTIVE PAID memberships: open 5,398 with 1,841 on auto-renew;
// season 4,650 with ZERO; term 932 with ZERO; and 13,802 passes, which cannot
// carry one as a matter of schema.
test("a season plan is not a membership that merely isn't auto-renewing", () => {
  assert.strictEqual(mbCanAutoRenew(V2_SEASON), false,
    "0 of 4,650 active paid season memberships carry a subscription — dividing " +
    "by them told Norman it was at 7.1% when it was at 97.6%");
});

test("a fixed-term plan is out too — same measurement, 0 of 932", () => {
  assert.strictEqual(mbCanAutoRenew(V2_ANNUAL_TERM), false);
});

test("a pass is out — it has no subscription column at all", () => {
  assert.strictEqual(mbCanAutoRenew(V3_GATE_PASS), false);
  assert.strictEqual(mbCanAutoRenew(V3_SEASON_PASS), false);
});

test("a subscription-shaped membership is IN, on or off auto-renew", () => {
  assert.strictEqual(mbCanAutoRenew(V3_MONTHLY), true);
  assert.strictEqual(mbCanAutoRenew(
    Object.assign({}, V3_MONTHLY, { autoRenew: false, renewalType: 'One-time' })), true,
    "a monthly plan nobody enrolled is the whole point of the tab — it is the " +
    "conversion candidate, and it must be in the denominator");
});

test("AN ACTUAL AUTO-RENEWER IS NEVER EXCLUDED, whatever its plan shape", () => {
  // The zeros above are MEASURED, not a schema guarantee. This is the branch
  // that makes the exclusion safe to apply at all: if a season plan ever does
  // carry a subscription, it has to show up rather than vanish from the tab.
  const seasonOnAutoRenew = Object.assign({}, V2_SEASON,
    { autoRenew: true, renewalType: 'Auto-renew' });
  assert.strictEqual(mbProductShape(seasonOnAutoRenew), 'season');
  assert.strictEqual(mbCanAutoRenew(seasonOnAutoRenew), true,
    "excluding a member who IS auto-renewing would drop revenue off the tab");
});

test("a pre-v3 feed excludes NOTHING — it cannot tell, so it does not guess", () => {
  // Degrades to exactly the old behaviour rather than shrinking a denominator
  // on a guess. Same direction as mbProductShape returning `unknown`.
  //
  // THE ROW MUST NOT BE AUTO-RENEWING. Both pre-v3 fixtures above carry it, so
  // the safety-valve branch answered first and this assertion passed with the
  // `unknown` branch deleted — caught by mutation, and the reason this test
  // builds its own row instead of reusing one.
  const unkownOff = { price: 20, renewalType: 'One-time', autoRenew: undefined,
    hasPlanTerms: true, hasCycle: true, planSeasonEnd: '', planTermDays: null,
    periodStart: '', nextRenewal: '' };
  assert.strictEqual(mbIsAutoRenew(unkownOff), false, "fixture must be OFF auto-renew");
  assert.strictEqual(mbProductShape(unkownOff), 'unknown');
  assert.strictEqual(mbCanAutoRenew(unkownOff), true,
    "an un-kinded row could be a $20 monthly or a $6 gate fee; excluding it " +
    "would shrink the denominator on a guess");
  assert.strictEqual(mbCanAutoRenew(V2_MONTHLY_NO_KIND), true);
  assert.strictEqual(mbCanAutoRenew(PRE_V2_MONTHLY), true);
});

// Bound the memo by its own dependency line rather than a hardcoded one: the
// terminator used to be "}, [filtered]);" for every block, so when arPlans
// switched to filteredAnyStatus the slice silently ran on into the NEXT memo
// and an assertion about arPlans started reading someone else's code.
const block = (name) => {
  const i = page.indexOf("const " + name + " = useMemo(");
  assert.ok(i > 0, name + " should be a useMemo");
  const end = page.slice(i).search(/\n\s*\}, \[[^\]]*\]\);/);
  assert.ok(end > 0, "could not bound " + name);
  return page.slice(i, i + end);
};

test("the plan table lists ONLY plans set up for auto-renew", () => {
  // Dan, after two rounds of narrowing a denominator instead: "the memberships
  // showing up in the auto renew tab should be those that are setup for auto
  // renew." So the test is `on > 0`, which subsumes every exclusion argued for
  // before it — a pass, a season plan and a desk-paid cash plan all have nobody
  // enrolled and fall out on one rule rather than three special cases.
  const b = block("arPlans");
  // The rule is at the door: a row that is not on auto-renew never enters the
  // map, so a plan with nobody on it cannot appear. That one test subsumes
  // every exclusion argued for in earlier rounds — pass, season, rolling term
  // and desk-paid cash plans all fall out together.
  assert.match(b, /if \(!mbIsPaid\(r\) \|\| !mbIsAutoRenew\(r\)\) continue;/,
    "a plan nobody auto-renews on is not part of the auto-renew book");
  assert.ok(!/mbCanAutoRenew/.test(b),
    "eligibility is the CANDIDATE question, not the book question — the table " +
    "must not re-introduce a second rule for who appears");
  assert.ok(!/mbProductShape\(r\) === 'pass'\) continue/.test(page),
    "and nothing may re-derive a per-shape exclusion");
});

test("an eligible-but-unenrolled plan is a CANDIDATE, and is named", () => {
  // The 5 desk-paid memberships Dan pointed at have to go somewhere. Dropping
  // them from the table without naming them would lose the only actionable
  // population on the tab; "Could Convert: 5" alone is a number to wonder
  // about, so the card carries the plan names.
  const b = block("arStats");
  assert.ok(b.includes("candidatePlans"), "the candidate PLANS must be derived");
  assert.match(b, /mbProductShape\(r\) === 'open'/,
    "candidacy is still the recurring-shape test");
  assert.match(page, /data-ar-cand-plan=/,
    "and the plan names must reach the page, not just the count");
});

test("ONE plan key, because three surfaces now read it", () => {
  // The per-plan table, the retention filter pills, and the filter itself. Two
  // copies drift the first time the fallback order changes, and then a pill
  // matches nothing and silently draws an empty chart.
  assert.strictEqual(mbPlanKey({ group: "Monthly Individual", type: "Fitness" }),
    "Monthly Individual", "the plan wins over the product type");
  assert.strictEqual(mbPlanKey({ group: "", type: "Fitness" }), "Fitness");
  assert.strictEqual(mbPlanKey({}), "\u2014");
  assert.strictEqual(mbPlanKey(null), "\u2014");
  assert.ok(!/r\.group \|\| r\.type \|\| '\u2014'/.test(page),
    "nothing may re-derive the plan key inline");
});

test("the leaving-soon count carries its ROWS, not just a number", () => {
  // Dan: "can we add a drop down/expansion option here to show WHO those two
  // users are? Kinda unhelpful otherwise." A count with nowhere to go is the
  // dead end the Failed check-ins tile had.
  const b = block("arPlans");
  assert.match(b, /e\.pending\+\+; e\.pendingRows\.push\(r\);/,
    "the members themselves have to survive the aggregation");
  assert.match(page, /data-ar-pending-member=/,
    "and reach the page");
  assert.match(page, /ciUserUrl\(recOrgId, r\.userId\)/,
    "named members link through to their Rec account, built from the uuid");
});

test("best and worst are ranked over plans big enough to mean something", () => {
  // A 3-member plan at 0% is not "your best plan", it is three people who have
  // not left yet -- and a headline card is the worst place to say otherwise.
  // Revenue is deliberately NOT floored: a big plan is a big plan, and no rate
  // is being asserted about it.
  const b = block("arHighlights");
  assert.match(b, /p\.n >= AR_RANK_MIN && p\.churn != null/,
    "best/worst must only rank plans over the member floor with a real rate");
  assert.match(b, /byRevenue = arPlans\.slice\(\)\.sort/,
    "revenue ranks over every plan");
  assert.ok(!/byRevenue[\s\S]{0,120}AR_RANK_MIN/.test(b),
    "the floor must not silently drop the biggest earner");
  assert.match(page, /const AR_RANK_MIN = 20;/);
});

test("the money cards all cover the SAME memberships", () => {
  // Dan: "78k billed per cycle, yet 68k monthly revenue? 71 per members but
  // 76.23 average charge?" Two correct sums over different populations. At Apex
  // the charge total covered 1,030 and the monthly figure 1,028, and the
  // 30.44/31 conversion did the rest. They agree now, and the count is on screen.
  const b = block("arStats");
  assert.match(b, /if \(mv != null\) \{\s*perCycle \+= r\.price; monthly \+= mv; withCycle\+\+/,
    "the charge total and the monthly total must be built in the same branch");
  assert.match(b, /avgCharge: withCycle \? perCycle \/ withCycle : 0/,
    "the average charge must use that same denominator");
  assert.match(b, /noCycle, noCycleValue/,
    "and what was left out has to be countable, so the page can say so");
});

test("the tab no longer claims an adoption RATE", () => {
  // Every denominator tried here was contested — paid memberships, then
  // non-passes, then subscription-shaped. The tab reports the book it can
  // state without argument: how many auto-renew, on what, billing what.
  assert.ok(!/data-ar-pct=/.test(page),
    "a percentage needs a denominator, and this tab no longer asserts one");
  assert.ok(!/data-ar-base=/.test(page));
});

// ── The cache invariant ─────────────────────────────────────────────────────
test("a membership on auto-renew reads that way on both feed shapes", () => {
  assert.strictEqual(mbIsAutoRenew(V3_MONTHLY), true);
  assert.strictEqual(mbIsAutoRenew(PRE_V2_MONTHLY), true,
    "both feed shapes are live at once for four hours after the card ships");
});

test("the pre-v2 fallback can only ever UNDERCOUNT, never overcount", () => {
  // Measured over active memberships on prod 2026-08-29: 1,760 carry both
  // signals, 88 carry a live subscription with no renewal date, and NOT ONE
  // carries a renewal date without a subscription. So the only possible
  // disagreement is a pre-v2 feed missing someone — a 4.8% undercount that
  // corrects upward when the cache turns over.
  //
  // The dangerous direction is the other one: reporting a member as
  // auto-renewing when no subscription exists would put revenue in the forecast
  // that nothing will collect.
  const renewalDateButNoSubscription = { autoRenew: false, renewalType: "Auto-renew" };
  assert.strictEqual(mbIsAutoRenew(renewalDateButNoSubscription), false,
    "where v2 can speak it must win — a renewal date without a subscription " +
    "is not auto-renew, and prod has zero such memberships anyway");
});

test("the explicit column wins over the inferred one", () => {
  // Renewal Type is inferred from membership_next_renewal_at; Auto Renew is
  // stripe_subscription_id. Where they disagree, the subscription is the truth.
  assert.strictEqual(mbIsAutoRenew({ autoRenew: false, renewalType: "Auto-renew" }), false);
  assert.strictEqual(mbIsAutoRenew({ autoRenew: true, renewalType: "One-time" }), true);
});

// ── How is this plan working out? ───────────────────────────────────────────
// Dan: "which a/r memberships are working out the best, which have a high
// cancellation rate."
const V4_RENEWED = { price: 20, autoRenew: true, productKind: "membership",
  hasPlanTerms: true, hasCycle: true, planSeasonEnd: "", planTermDays: null,
  status: "active", startDate: "2026-06-01", periodStart: "2026-08-29",
  nextRenewal: "2026-09-29", canceledAt: "", hasCancelSchedule: true,
  cancelScheduledAt: "" };
const V4_LEFT = Object.assign({}, V4_RENEWED,
  { status: "canceled", canceledAt: "2026-08-15", nextRenewal: "", periodStart: "" });
const V4_LEAVING = Object.assign({}, V4_RENEWED, { cancelScheduledAt: "2026-09-29" });

// ── The cycle belongs to the PLAN, not to one row's timestamps ──────────────
// A correction. The first version divided by each row's own (next renewal -
// period start), which held at City of Norman and does NOT hold generally: on a
// membership whose renewal is imminent that gap is the time REMAINING, not the
// period's length. Measured at Apex over 1,323 auto-renewers, 8 rows have a
// "cycle" under a day (smallest 15 minutes) and 35 more under a week.
test("a sub-day gap is not a billing cadence and does not get a vote", () => {
  // THE FIXTURE HAS TO BE ADVERSARIAL OR THIS PROVES NOTHING. A first draft used
  // nine clean rows against one bad one, and the filter could be deleted with the
  // test still passing — a median over 9 good values is unmoved by a 10th. The
  // filter earns its place only where the bad rows are the majority, which is a
  // small plan whose members are mostly mid-renewal. Caught by mutation.
  const rows = [
    { group: "Tier 1 Monthly Household", periodStart: "2026-02-10", nextRenewal: "2026-03-12" },
    { group: "Tier 1 Monthly Household", periodStart: "2026-02-11", nextRenewal: "2026-03-13" },
    // Four rows whose renewal is imminent: minutes, not a cadence.
    ...Array.from({ length: 4 }, (_, i) => ({ group: "Tier 1 Monthly Household",
      periodStart: "2026-02-10T00:00:00Z",
      nextRenewal: "2026-02-10T00:" + String(10 + i * 10) + ":00Z" })),
  ];
  const cycles = mbPlanCycles(rows);
  assert.strictEqual(cycles["Tier 1 Monthly Household"], 30,
    "the cadence is 30 days; admitting the sub-day rows makes the median ~0.03");
});

test("THE 44,665-RENEWAL BUG, pinned", () => {
  // The exact Apex row: started 2022-06-10, current period started 2026-02-10,
  // and its own two timestamps are 43 minutes apart. Dividing 1,341 days by that
  // produced 44,665 renewals on a monthly plan and dragged the plan average to
  // 228x. Against the PLAN's 30-day cadence it reads 45, which matches the dates.
  const apex = { group: "Tier 1 Monthly Household", startDate: "2022-06-10",
    periodStart: "2026-02-10T00:00:00Z", nextRenewal: "2026-02-10T00:43:00Z" };
  assert.ok(mbCycleDays(apex) < 0.05, "the row's own gap really is that small");
  assert.strictEqual(mbRenewalsSoFar(apex, 30), 45);
  assert.strictEqual(mbRenewalsSoFar(apex, mbCycleDays(apex)), null,
    "a sub-day cycle must never be accepted as a divisor");
});

test("an implausible answer is NULL, not a confident number", () => {
  // Belt and braces on top of the plan-median cycle. If the dates are wrong, a
  // dash is honest and 44,665 is not.
  assert.strictEqual(mbRenewalsSoFar(
    { startDate: "1970-01-01", periodStart: "2026-02-10" }, 1), null);
  assert.strictEqual(mbRenewalsSoFar({ startDate: "2026-02-10", periodStart: "2026-02-10" }, 30), 0);
  assert.strictEqual(mbRenewalsSoFar({ startDate: "2026-01-01", periodStart: "2026-02-10" }, null), null);
});

// ── Churn is per renewal period, in the plan's own cadence ──────────────────
test("churn is a rate over RENEWAL OPPORTUNITIES, not a lifetime total", () => {
  // Apex read 1,119 of 2,176 = 51% and Dan read it as a crisis. It is a running
  // total since 2022. The hazard rate answers the question that was being asked.
  assert.strictEqual(Math.round(mbChurnPerCycle(6, 3) * 1000) / 10, 33.3);
  assert.strictEqual(mbChurnPerCycle(0, 0), null, "no opportunities, no rate");
  assert.strictEqual(mbChurnPerCycle(45, 0), 0);
  // The two measures genuinely differ, which is the whole point of the change.
  const lifetime = 3 / 9;
  assert.notStrictEqual(Math.round(mbChurnPerCycle(18, 3) * 100),
    Math.round(lifetime * 100));
});

test("every rate carries the period it is measured in", () => {
  // Dan: "always report the churn rate based on its renewal period." A weekly
  // 5% and a monthly 5% are not the same thing.
  assert.strictEqual(mbCadence(7).per, "per week");
  assert.strictEqual(mbCadence(30).per, "per month");
  assert.strictEqual(mbCadence(31).per, "per month");
  assert.strictEqual(mbCadence(91).per, "per quarter");
  assert.strictEqual(mbCadence(365).per, "per year");
  assert.strictEqual(mbCadence(null), null);
});

test("the book-level rate carries NO period, because the book mixes them", () => {
  // A book of weekly and monthly plans has no single cadence, so labelling it
  // "per month" would be false for part of it. Per RENEWAL is unit-free.
  const b = block("arBook");
  assert.ok(!/cadence:/.test(b),
    "no book-level period label -- the per-plan table names each plan's own");
  assert.ok(b.includes("churn:") && b.includes("everCancelled:"),
    "both measures survive; only one of them is a rate");
});

test("renewals are DERIVED, because no renewal history exists anywhere", () => {
  // `public.subscription` is a marketing opt-in table and `membership` keeps
  // only the current period, so this is (period start - start) / cycle.
  // Jun 1 -> Aug 29 is 89 days over a 31-day cycle: 2.87, which rounds to 3.
  // Verified sound on prod rather than assumed — weekly divides exactly and
  // monthly sits 0.06 off a whole number, which is calendar drift.
  assert.strictEqual(mbCycleDays(V4_RENEWED), 31);
  assert.strictEqual(mbRenewalsSoFar(V4_RENEWED, 31), 3);
});

test("a cancelled membership yields NULL renewals, never 0", () => {
  // next_renewal_at is cleared on cancellation, so there is no cycle to divide
  // by. A 0 would say a member who renewed six times and then left never
  // renewed at all — and averaged into a plan, it punishes the plan hardest
  // for the members it kept billing longest.
  assert.strictEqual(mbRenewalsSoFar(V4_LEFT, 31), null,
    "a cancelled row has no period start to measure from");
  assert.strictEqual(mbRenewalsSoFar({ startDate: "2026-06-01", periodStart: "" }, 31), null);
  assert.strictEqual(mbRenewalsSoFar(null, 31), null);
});

test("cancellation reads the DATE first and the status word second", () => {
  assert.strictEqual(mbIsCanceled(V4_LEFT), true);
  assert.strictEqual(mbIsCanceled(V4_RENEWED), false);
  assert.strictEqual(mbIsCanceled({ status: "cancelled" }), true, "both spellings");
  assert.strictEqual(mbIsCanceled({ canceledAt: "2026-08-15", status: "active" }), true,
    "the date is the fact; status vocabulary varies by product");
});

test("SCHEDULED to cancel is not CANCELLED, and they must not be added", () => {
  // Still live, still billing, still in the book — and will not renew. The
  // only forward-looking churn signal in the schema; Norman has 126 of them.
  assert.strictEqual(mbCancelPending(V4_LEAVING), true);
  assert.strictEqual(mbIsCanceled(V4_LEAVING), false,
    "counting it as cancelled would double-count it the moment it actually is");
  assert.strictEqual(mbCancelPending(V4_RENEWED), false);
  assert.strictEqual(mbCancelPending(Object.assign({}, V4_LEFT,
    { cancelScheduledAt: "2026-09-29" })), false,
    "already gone is not 'leaving'");
});

test("the pending-cancel card gates on the COLUMN, not on the count", () => {
  assert.strictEqual(mbHasCancelSchedule([V4_RENEWED]), true,
    "present and empty is a real answer: this member is not leaving");
  assert.strictEqual(mbHasCancelSchedule([
    { autoRenew: true, cancelScheduledAt: "" }]), false,
    "a pre-v4 feed must HIDE the card, not render a 0 reading 'nobody is leaving'");
  assert.strictEqual(mbHasCancelSchedule([]), false);
});

test("A CHURN METRIC MAY NOT BE COMPUTED OVER A VIEW THAT HIDES CHURN", () => {
  // The status pill defaults to ['active'], so a cancellation rate taken from
  // `filtered` is structurally 0.0% for every org, forever — and reads as a
  // healthy book rather than a broken number. Caught by the render check: the
  // per-plan rate came out 0% on a fixture built to make it 60%.
  assert.match(page, /const \[statusFilter, setStatusFilter\] = useState\(\(\) => \{\s*try \{ return JSON\.parse\(localStorage\.getItem\(LS_STATUS\)\) \|\| \['active'\]/,
    "if this default ever stops being 'active' this test's premise changes");
  assert.ok(block("arPlans").includes("filteredAnyStatus"),
    "the per-plan cancellation rate must see cancelled rows");
  assert.ok(block("arBook").includes("filteredAnyStatus"),
    "and so must the book-level rate");
  assert.ok(!/for \(const r of filtered\)/.test(block("arPlans")),
    "reading `filtered` here is the bug, not a style choice");
});

// ── Cycle and monthly value ─────────────────────────────────────────────────
test("the billing cycle is measured, and an unknown cycle stays null", () => {
  assert.strictEqual(mbCycleDays(V3_MONTHLY), 31);
  assert.strictEqual(mbCycleDays(PRE_V2_MONTHLY), null,
    "a missing cycle is 'we do not know how often this bills', not 'monthly'");
  assert.strictEqual(mbCycleDays(V2_SEASON), null);
});

test("monthly value is null when the cycle is unknown — never defaulted", () => {
  const mv = mbMonthlyValue(V3_MONTHLY);
  assert.ok(Math.abs(mv - 19.639) < 0.01, "20 over a 31-day cycle is ~$19.64/mo, got " + mv);
  assert.strictEqual(mbMonthlyValue(PRE_V2_MONTHLY), null,
    "defaulting this would turn a per-cycle charge into a fabricated monthly figure");
});

test("a weekly plan is worth more per month than its charge", () => {
  // Measured on prod: 50 memberships bill on a 7-day cycle. Reading the charge
  // as monthly would understate them 4x. This is also the arithmetic that
  // caught a wrong MRR construction during the investigation.
  const weekly = { price: 55, periodStart: "2026-08-01", nextRenewal: "2026-08-08" };
  const mv = mbMonthlyValue(weekly);
  assert.ok(mv > 200 && mv < 250, "55 every 7 days is ~$239/mo, got " + mv);
});

// ── Presence, not count ─────────────────────────────────────────────────────
test("the economics panels gate on the COLUMN, not on any row having a value", () => {
  assert.strictEqual(mbHasEconomics([V2_SEASON]), true,
    "a season pass has no cycle, but the feed still carries the columns — an org " +
    "with genuinely no auto-renew must see the panel and read a real zero");
  assert.strictEqual(mbHasEconomics([PRE_V2_MONTHLY]), false,
    "rendering $0 here would say this org earns nothing from auto-renew when the " +
    "truth is that this feed cannot tell us (the hasAbsent / ciHasStatus rule)");
  assert.strictEqual(mbHasEconomics([]), false);
  assert.strictEqual(mbHasEconomics(null), false);
});

// ── The price / volume bridge ───────────────────────────────────────────────
test("volume is priced at the PRIOR month's average, not the new one", () => {
  // Norman, measured: June 1,401 units / $88,362 → July 1,546 / $22,200.
  // June's average is $63.07, July's is $14.36. Pricing the extra 145 units at
  // July's average would credit volume with $2,082 instead of $9,145 and quietly
  // move $7,000 of the explanation into the wrong bucket.
  //
  // Asserting only that volume + price == total cannot catch this: price is
  // DEFINED as total - volume, so that identity holds however volume is
  // computed. The value is what has to be pinned.
  const d = mbDecompose({ units: 1401, revenue: 88362 }, { units: 1546, revenue: 22200 });
  assert.ok(Math.abs(d.volume - 9145) < 25, "expected ~+$9,145 of volume, got " + d.volume);
  assert.ok(Math.abs(d.price - (-75307)) < 25, "expected ~-$75,307 of price, got " + d.price);
  assert.ok(Math.abs((d.volume + d.price) - d.total) < 0.01, "the parts must still sum");
});

test("units up and revenue down is attributed to price, not to churn", () => {
  const d = mbDecompose({ units: 1401, revenue: 88362 }, { units: 1546, revenue: 22200 });
  assert.ok(d.volume > 0, "10.4% more units sold is a POSITIVE volume contribution");
  assert.ok(d.price < 0, "the whole fall is price and mix");
  assert.ok(Math.abs(d.price) > Math.abs(d.volume) * 5,
    "price must dominate, or the panel would send an admin hunting for churn " +
    "that is not there — nobody left, a $224 season pass simply stopped selling");
});

test("a first month with no prior returns null rather than a fabricated delta", () => {
  assert.strictEqual(mbDecompose(null, { units: 10, revenue: 100 }), null);
  assert.strictEqual(mbDecompose({ units: 0, revenue: 0 }, { units: 10, revenue: 100 }), null);
});

// ── Deep links ──────────────────────────────────────────────────────────────
test("both new tabs are reachable by ?tab=, and an unknown value falls back", () => {
  assert.strictEqual(mbEffectiveTab("autorenew"), "autorenew");
  assert.strictEqual(mbEffectiveTab("salesmix"), "salesmix");
  assert.strictEqual(mbEffectiveTab("checkins"), "checkins");
  assert.strictEqual(mbEffectiveTab("nonsense"), "memberships");
  assert.strictEqual(mbEffectiveTab(null), "memberships");
});

test("the URL write-back carries the tab, so a deep link is not erased", () => {
  // Third instance of the ?ci_rows= write-back bug across this repo: an effect
  // rebuilds the query string on mount and wipes a tab that was read from it.
  assert.match(page, /qs\.delete\('tab'\); else qs\.set\('tab', activeTab\)/,
    "the write-back must set the tab generically, not list the tabs it knows");
});

// ── The Retention window only ever widens ───────────────────────────────────
// Reported from the live preview: the cohort chart "shows briefly then
// disappears". The pane renders from the previous `data` while a refetch is in
// flight, so the full chart drew and then the narrow response collapsed it.
const RET_NOW = new Date(2026, 7, 30);   // 2026-08-30, local — the day it was seen

test("a 12-month window survives clicking Retention", () => {
  // THE BUG, exactly as reported. The old condition fired on `endDate < e`
  // alone, so a window already covering twelve months was replaced by the
  // 31 days between Jul 31 and Aug 31.
  const w = mbRetentionWindow("2025-09-01", "2026-08-29", RET_NOW);
  // The invariant is directional, not a fixed date: the window may only GROW.
  assert.ok(w.start <= "2025-09-01", "start moved forward to " + w.start + " — that narrows it");
  assert.ok(w.end   >= "2026-08-29", "end moved backward to " + w.end + " — that narrows it");
  const days = (Date.parse(w.end) - Date.parse(w.start)) / 86400000;
  assert.ok(days > 300, "the window collapsed to " + days + " days — the chart would vanish");
});

test("a narrow window IS widened to twelve months, not to 30 days", () => {
  // The other half: `start12` was `now - 30 * 86400000` despite its name and
  // the comment above it. Even the intended expansion only gave a month.
  const w = mbRetentionWindow("2026-08-01", "2026-08-29", RET_NOW);
  assert.strictEqual(w.start, "2025-08-30", "twelve calendar months back");
  assert.ok(w.changed, "a one-month window must trigger the widen");
  const days = (Date.parse(w.end) - Date.parse(w.start)) / 86400000;
  assert.ok(days > 360, "expected ~12 months, got " + days + " days");
});

test("an already-wide window is left completely alone", () => {
  // No refetch, so nothing can collapse and nothing flickers.
  const w = mbRetentionWindow("2024-01-01", "2027-01-01", RET_NOW);
  assert.strictEqual(w.changed, false);
  assert.strictEqual(w.start, "2024-01-01");
  assert.strictEqual(w.end, "2027-01-01");
});

test("the window is built from LOCAL date parts, never toISOString", () => {
  // toISOString is UTC: an evening in any US timezone rolls to tomorrow and the
  // window shifts a day. Same trap as the fasttrack dates and campmap horizon.
  assert.strictEqual(mbISODate(new Date(2026, 7, 30, 23, 30)), "2026-08-30");
  assert.strictEqual(mbISODate(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
});

// ── Nothing existing may be lost ────────────────────────────────────────────
// This whole PR is additive. These pin the surfaces that were already there.
test("every pre-existing table column is still rendered", () => {
  ["'Email'", "'Membership Type'", "'Status'", "'Renewal'", "'Price'", "'Paid'",
   "'Refunded'", "'Net Collected'", "'Start'", "'Next Renewal'", "'Last Used'", "'Uses'"
  ].forEach(label => {
    assert.ok(page.includes("label: " + label), "table column " + label + " went missing");
  });
});

test("every pre-existing Excel column is still exported", () => {
  // Scoped to the ROW MAP, not the whole file: several of these names also
  // appear in the totals row and in normalizeRow, so a file-wide search passes
  // even after a column is deleted from the export itself. (Found by mutation —
  // the first version of this test survived exactly that edit.)
  const i = page.indexOf("const exportExcel = () => {");
  assert.ok(i > 0, "could not find exportExcel");
  const map = page.slice(i, page.indexOf("// totals row", i));
  ["'User ID'", "'First Name'", "'Last Name'", "'Email'", "'Membership ID'",
   "'Membership Type'", "'Group / Plan'", "'Status'", "'Renewal Type'", "'Price'",
   "'Paid'", "'Refunded'", "'Net Collected'", "'Start Date'", "'End Date'",
   "'Next Renewal'", "'Canceled At'", "'Created At'", "'Last Used'", "'Usage Count'",
   "'Attendance Count'"
  ].forEach(col => {
    assert.ok(map.includes(col + ":"), "Excel column " + col + " went missing");
  });
});

test("all six pre-existing views are still offered", () => {
  ["byType", "byStatus", "renewalMix", "revenueByType", "monthlyRevenue", "upcomingRenewals"]
    .forEach(v => {
      assert.ok(page.includes("key: '" + v + "'"), "view " + v + " went missing");
    });
});

test("all three pre-existing tabs are still reachable", () => {
  ["memberships", "checkins", "retention"].forEach(t => {
    assert.strictEqual(mbEffectiveTab(t), t, "tab " + t + " is no longer reachable");
  });
});

test("the Auto-Renew KPI and the Auto-Renew tab share one implementation", () => {
  // Two auto-renew numbers on one page that disagree by 5% is the trap the
  // facility Summary already shipped once. The KPI now routes through the same
  // helper, so on a pre-v2 feed it is byte-for-byte today's behaviour and on v2
  // both surfaces move together.
  assert.match(page, /r\.status === 'active' && mbIsAutoRenew\(r\)/,
    "the summary KPI must not re-derive auto-renew on its own");
});

test("the six pre-existing KPI cards are still computed", () => {
  ["autoRenewCount", "mrrEstimate", "totalRevenue", "totalNetCollected"].forEach(k => {
    assert.ok(page.includes(k), "summary field " + k + " went missing");
  });
  assert.match(page, /byStatus = \{ active:0, canceled:0, expired:0, inactive:0 \}/,
    "the four status counts feed four KPI cards");
});

// ── Card 17301 v2 ───────────────────────────────────────────────────────────
const sqlBody = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

test("v2 keeps every original column, by name", () => {
  ['"User ID"', '"First Name"', '"Last Name"', '"Email"', '"Membership ID"',
   '"Membership Type"', '"Group / Plan"', '"Status"', '"Renewal Type"', '"Price"',
   '"Paid"', '"Refunded"', '"Net Collected"', '"Start Date"', '"End Date"',
   '"Next Renewal"', '"Canceled At"', '"Created At"', '"Last Used"', '"Usage Count"',
   '"Attendance Count"'
  ].forEach(c => {
    assert.ok(sqlBody.includes(c), "original card column " + c + " went missing");
  });
});

test("v2 adds exactly the five columns the new tabs need", () => {
  ['"Coverage"', '"Plan Season End"', '"Plan Term Days"', '"Auto Renew"', '"Period Start"']
    .forEach(c => assert.ok(sqlBody.includes(c), "missing new column " + c));
});

test("v3 states the product kind rather than leaving it to be inferred", () => {
  assert.match(sqlBody, /mp\.product_type\s+AS "Product Kind"/,
    "product_type was already read in the WHERE clause and thrown away; " +
    "selecting it is what keeps 13,802 paid passes out of the auto-renew " +
    "denominator");
});

test("v3 reads the term rule from BOTH product families", () => {
  // The bug in one line: gg.end_date alone is NULL for every pass, and the
  // page then concluded "no season end, no term days, therefore open-ended".
  assert.match(sqlBody, /COALESCE\(gg\.end_date, pss\.end_date\)\s+AS "Plan Season End"/,
    "a pass's season end lives on pass_schema, not on `group`");
  assert.match(sqlBody, /COALESCE\(gg\.ends_after_seconds, pss\.ends_after_seconds\)/,
    "a pass's rolling term lives on pass_schema, not on `group`");
});

test("the pass_schema join is on a primary key too, so it cannot fan out", () => {
  // Verified against prod before the push: Norman, 20,341 rows with and
  // without the join, every row distinct.
  assert.match(sqlBody, /LEFT JOIN public\.pass_schema pss\s+ON pss\.id = mp\.pass_schema_id/);
});

test("both new joins are on primary keys, so neither can fan out a row", () => {
  // Verified against prod before the push: Norman, 20,341 rows and an identical
  // md5 over the original columns with and without the joins.
  assert.match(sqlBody, /LEFT JOIN public\.membership mm\s+ON mm\.id = mp\.membership_id/,
    "membership must join on its primary key");
  assert.match(sqlBody, /LEFT JOIN public\."group" gg\s+ON gg\.id = mp\.group_id/,
    "group must join on its primary key");
});

test("auto-renew comes from the subscription id, not from the inferred column", () => {
  assert.match(sqlBody, /mm\.stripe_subscription_id IS NOT NULL\)?\s+AS "Auto Renew"/,
    "Renewal Type infers auto-renew from next_renewal_at; this is the real test");
});

test("v4 carries the forward-looking cancellation signal", () => {
  assert.match(sqlBody, /mm\.cancel_scheduled_at\s+AS "Cancel Scheduled At"/,
    "canceled_at is the past; this is the only column that says who is about " +
    "to leave, and nothing else in the schema exposes it");
  assert.match(sqlBody, /mm\.cancel_reason\s+AS "Cancel Reason"/);
  // Both come off the membership join v2 already made, so v4 added no joins.
  // v5 adds three (users, resident_households, resident_users) for the
  // Resident? column, so a bare count is no longer the invariant — what
  // matters is that EVERY join can still only match one row. Each of the three
  // is on a unique key: users.id is the primary key, and both resident CTEs
  // are SELECT DISTINCT over a single column. Verified against prod as well as
  // asserted here — el-segundo-recreation returns 3,132 rows with and without
  // them.
  const joins = (sqlBody.match(/LEFT JOIN/g) || []).length;
  assert.strictEqual(joins, 9,
    "v5 adds exactly three joins for Resident? — a fourth means a join arrived " +
    "without anyone checking whether it can fan out a row");
  assert.match(sqlBody, /LEFT JOIN public\.users cu\s*\n\s*ON cu\.id = mp\.customer_user_id/,
    "the buyer join is on users.id, the primary key, so it cannot fan out");
  assert.match(sqlBody, /resident_households AS \(\s*\n\s*SELECT DISTINCT/,
    "resident_households is DISTINCT — without it a household with two live " +
    "residency memberships would duplicate every purchase row it made");
  assert.match(sqlBody, /resident_users AS \(\s*\n\s*SELECT DISTINCT/,
    "resident_users is DISTINCT, for the same reason");
});

test("the ORDER BY is intact", () => {
  // Dropped once already on card 17300, because `wc -l` counts newlines and the
  // last line had none. Cheap to pin, expensive to lose.
  assert.match(sqlBody, /ORDER BY\s+COALESCE\(mp\.membership_status, mp\.pass_status\)/);
});

// ── Beacons ─────────────────────────────────────────────────────────────────
// A beacon whose event is not allow-listed 400s SILENTLY. That bug has now
// shipped four times in this repo and no source assertion ever caught it, so
// both halves are pinned here and the live half is in checkin-beacons.spec.js.
test("both new events are on the log route's allowlist", () => {
  const i = server.indexOf('const ALLOWED = ["excel", "print", "summary"');
  assert.ok(i > 0, "could not find the log route allowlist");
  const line = server.slice(i, server.indexOf("\n", i));
  assert.ok(line.includes('"mb-autorenew"'), "mb-autorenew would 400 silently");
  assert.ok(line.includes('"mb-salesmix"'), "mb-salesmix would 400 silently");
});

test("both new events reach Slack, per the standing activity rule", () => {
  const i = server.indexOf("const SLACK_NOTIFY = new Set([");
  const line = server.slice(i, server.indexOf("\n", i));
  assert.ok(line.includes('"mb-autorenew"'), "logged but never posted");
  assert.ok(line.includes('"mb-salesmix"'), "logged but never posted");
});

test("both new events have an emoji and a verb, or the message reads bare", () => {
  assert.match(server, /"mb-autorenew":\s+\{ emoji: "[^"]+", verb: "[^"]+" \}/);
  assert.match(server, /"mb-salesmix":\s+\{ emoji: "[^"]+", verb: "[^"]+" \}/);
});

test("the extras are clamped server-side, never echoed from the query string", () => {
  const i = server.indexOf('event === "mb-autorenew"');
  assert.ok(i > 0);
  const block = server.slice(i, i + 400);
  assert.match(block, /Number\.isFinite/, "an unclamped extra is attacker-controlled text in Slack");
});

// ── The dead column ─────────────────────────────────────────────────────────
test("nothing new is built on last_used_at", () => {
  // NULL on all 155,853 memberships and all 73,888 passes. The existing column
  // stays (removing it is its own decision) but the new tabs must not read it.
  const arTab = page.slice(page.indexOf("activeTab === 'autorenew' &&"),
                           page.indexOf("activeTab === 'checkins' && ("));
  assert.ok(!/lastUsed/.test(arTab),
    "the new tabs must not depend on a column that has never had a value");
});

/* ── Residency: a DIMENSION, not a fifth tab ───────────────────────────────
 * Card 17301 v5 adds "Resident?". The surfaces are a toolbar filter that
 * scopes the whole report and one split panel — not a sub-tab, because every
 * question residency raises ("do residents retain better", "do non-residents
 * auto-renew", "what share of the book is resident") is the same cut applied
 * to panels that already exist. A tab could answer it once; a filter answers
 * it everywhere.
 * ------------------------------------------------------------------------ */
const RES_YES  = { hasResidency: true,  residency: "Yes", netCollected: 100, autoRenew: true,  productKind: "membership" };
const RES_NO   = { hasResidency: true,  residency: "No",  netCollected: 50,  autoRenew: false, productKind: "membership" };
const RES_NULL = { hasResidency: true,  residency: "",    netCollected: 25,  autoRenew: false, productKind: "membership" };
const PRE_V5   = { hasResidency: false, residency: "",    netCollected: 25,  autoRenew: false, productKind: "membership" };

test("residency is PRESENCE-gated, so a pre-v5 feed shows nothing rather than 0%", () => {
  assert.strictEqual(mbHasResidency([PRE_V5, PRE_V5]), false,
    "a feed with no Resident? column must hide the surfaces, not render every " +
    "member as a non-resident");
  assert.strictEqual(mbHasResidency([RES_NO, RES_NO]), true,
    "an org where every member happens to be a NON-resident still has a working " +
    "residency setup and keeps its filter — the gate is the column, not a 'Yes'");
  assert.strictEqual(mbHasResidency([RES_NULL, RES_NULL]), false,
    "an org that runs no residency group gets NULL from the card, which is " +
    "unknowable, not 'nobody is a resident'");
});

test("an unknowable row is never filed as a non-resident", () => {
  assert.strictEqual(mbResidencyKey(RES_YES),  "resident");
  assert.strictEqual(mbResidencyKey(RES_NO),   "nonresident");
  assert.strictEqual(mbResidencyKey(RES_NULL), null,
    "an org with no residency group is unknown, NOT non-resident");
  assert.strictEqual(mbResidencyKey(PRE_V5),   null,
    "a pre-v5 row is unknown, NOT non-resident");
});

test("the filter lives in the ONE funnel, so it scopes every tab", () => {
  // filteredAnyStatus is where every toolbar filter already lives, and the
  // Auto-Renew tab reads it directly while everything else reads `filtered`,
  // which derives from it. Putting residency anywhere else would scope some
  // panels and not others — the facility Summary bug.
  // Bound it FORWARD from filteredAnyStatus. "const filtered = useMemo" also
  // appears in an earlier component, so indexOf finds that one and the slice
  // comes out empty — the block() gotcha recorded in CLAUDE.md, hit again.
  const fStart = page.indexOf("const filteredAnyStatus = useMemo");
  const funnel = page.slice(fStart, page.indexOf("const filtered = useMemo", fStart));
  assert.ok(fStart > 0 && funnel.length > 200, "the funnel slice is non-empty");
  assert.match(funnel, /if \(residencyFilter\) \{/,
    "residency is applied inside filteredAnyStatus");
  assert.match(funnel, /mbResidencyKey\(r\)/,
    "and it reads the shared predicate rather than testing r.residency inline");
  assert.match(page, /\}, \[data, renewalFilter, typeFilter, priceMin, priceMax, search, residencyFilter\]\);/,
    "residencyFilter is in the funnel's dependency list, or the page will not " +
    "recompute when it changes");
});

test("filtering never excludes a row whose residency is unknowable", () => {
  // The same safety valve as mbCanAutoRenew's `unknown` branch. Narrowing a
  // book on a guess is the denominator mistake this report has already made
  // twice.
  // Bound it FORWARD from filteredAnyStatus. "const filtered = useMemo" also
  // appears in an earlier component, so indexOf finds that one and the slice
  // comes out empty — the block() gotcha recorded in CLAUDE.md, hit again.
  const fStart = page.indexOf("const filteredAnyStatus = useMemo");
  const funnel = page.slice(fStart, page.indexOf("const filtered = useMemo", fStart));
  assert.ok(fStart > 0 && funnel.length > 200, "the funnel slice is non-empty");
  assert.match(funnel, /if \(rk !== null && rk !== residencyFilter\) return false;/,
    "a null key falls through rather than being excluded");
});

test("the split is taken over filteredAnyStatus, not the status-filtered view", () => {
  // statusFilter defaults to ['active'], so a breakdown of "the book" taken
  // from `filtered` would silently answer a different question than its own
  // heading — the same trap that made the cancellation rate structurally 0.0%.
  const sStart = page.indexOf("const residencySplit = useMemo");
  const split = page.slice(sStart, page.indexOf("// ── Summary metrics ──", sStart));
  assert.ok(sStart > 0 && split.length > 200, "the split slice is non-empty");
  assert.match(split, /for \(const r of filteredAnyStatus\)/,
    "the split iterates filteredAnyStatus");
  assert.doesNotMatch(split, /of filtered\)/,
    "and never the status-filtered view");
  assert.match(split, /mbResidencyKey\(r\)/,
    "the panel and the filter read the SAME predicate, so they cannot disagree");
  assert.match(split, /if \(!mbHasResidency\(data\)\) return null;/,
    "the panel is absent, not zeroed, when residency is unknowable");
});

/* THE SPLIT LEADS WITH THE PAID BOOK.
 * A residency register is mostly FREE verification records. El Segundo has
 * 2,337 of 3,275 priced at $0 and 1,989 of those on the resident side, so
 * counting every record made the panel read "73.2% of the book · $2,949" —
 * residents as 73% of the book earning 22% of the money. Both numbers were
 * right; together they read as a mistake.
 *
 * This LIFTS AND RUNS the reducer rather than regexing it: a source assertion
 * cannot tell a share taken over the paid book from one taken over everything.
 */
function runResidencySplit(rows) {
  const sStart = page.indexOf("const residencySplit = useMemo");
  const body = page.slice(page.indexOf("{", page.indexOf("=> {", sStart)) + 1,
                          page.indexOf("}, [data, filteredAnyStatus]);", sStart));
  return new Function("filteredAnyStatus", "data", "mbHasResidency", "mbResidencyKey",
                      "mbIsAutoRenew", "useMemo", body)(
    rows, rows, mbHasResidency, mbResidencyKey, mbIsAutoRenew, null);
}

test("the resident share is taken over the PAID book, not over free records", () => {
  // El Segundo's real shape in miniature: residents hold a pile of $0
  // verification records, non-residents buy the passes.
  const paidRes    = { hasResidency: true, residency: "Yes", price: 40, netCollected: 40, productKind: "pass" };
  const paidNonRes = { hasResidency: true, residency: "No",  price: 60, netCollected: 60, productKind: "pass" };
  const freeRes    = { hasResidency: true, residency: "Yes", price: 0,  netCollected: 0,  productKind: "membership" };

  const rows = [paidRes, paidNonRes, paidNonRes, paidNonRes]
    .concat(Array.from({ length: 20 }, () => freeRes));
  const out = runResidencySplit(rows);

  assert.strictEqual(out.resident.n, 1, "one PAID resident record");
  assert.strictEqual(out.nonresident.n, 3, "three PAID non-resident records");
  assert.strictEqual(out.residentPct, 25,
    "25% of the paid book — counting the 20 free records would read 84%, which " +
    "is the number that made the panel look broken");
  assert.strictEqual(out.resident.revenue, 40, "free records add no revenue");
  assert.strictEqual(out.free, 20, "and the free register is REPORTED, never dropped");
  assert.strictEqual(out.freeResident, 20);
});

test("an org with no free records reads exactly as it did before", () => {
  const yes = { hasResidency: true, residency: "Yes", price: 10, netCollected: 10, productKind: "pass" };
  const no  = { hasResidency: true, residency: "No",  price: 10, netCollected: 10, productKind: "pass" };
  const out = runResidencySplit([yes, no, no, no]);
  assert.strictEqual(out.residentPct, 25, "the share is unchanged where nothing is free");
  assert.strictEqual(out.free, 0, "and the free card does not render");
});

test("the free register is named on screen rather than silently excluded", () => {
  assert.match(page, /data-mb-res-free=/,
    "an excluded population is named with its count — the same rule as the " +
    "unknown bucket, and as the aquatics scope note");
  // BOTH cards, counted — one assertion passed while the resident card still
  // said "of the book", because the non-resident card carried the new wording.
  assert.strictEqual((page.match(/% of the paid book/g) || []).length, 2,
    "BOTH the resident and non-resident cards say which book the share is of, " +
    "or the reader supplies the wrong one for whichever half was missed");
});

test("the unknown bucket is shown, not folded into non-resident", () => {
  assert.match(page, /data-mb-res-unknown=/,
    "an excluded population is named on screen with its count — a silent " +
    "exclusion is how a number stops being trusted");
  assert.match(page, /excluded from the split rather than filed as non-resident/);
});

test("the control is ABSENT where residency is unknowable", () => {
  assert.match(page, /\{mbHasResidency\(data\) && \(\s*\n\s*<select data-mb-residency/,
    "the select renders only behind the presence gate — a control that can " +
    "only answer 'unknown' is a dead end, and 'renders disabled' and 'renders " +
    "nothing' are different claims");
});

test("the Excel export writes blank, not No, where residency is unknowable", () => {
  assert.match(page, /'Resident\?':\s*mbResidencyKey\(r\) === 'resident' \? 'Yes' : mbResidencyKey\(r\) === 'nonresident' \? 'No' : ''/,
    "a spreadsheet pivot must not be able to file the unknown as non-resident");
});

test("the card reads the group's residency TOGGLE, never its name", () => {
  assert.match(sqlBody, /g\.group_type = 'residency'/,
    "the toggle is the test");
  assert.doesNotMatch(sqlBody, /name ILIKE '%residen/i,
    "a name match sweeps in 'Non-Resident' groups — 516 people on " +
    "'Pool Pass (Non-residents)' were reported as residents platform-wide");
  assert.match(sqlBody, /COALESCE\(mp\.membership_household_id, mp\.pass_household_id, cu\.household_id\)/,
    "all three paths to a resident are used. The two-path version was measured " +
    "and returned 'No' on all 3,132 El Segundo rows while 1,317 resident " +
    "households existed, because every row there is coverage='individual' and " +
    "the product-household columns are null");
  assert.match(sqlBody, /WHEN NOT \(SELECT val FROM has_res_group\) THEN NULL/,
    "an org with no residency group gets NULL, never 'No'");
});

console.log("\n" + passed + " assertions passed.");
