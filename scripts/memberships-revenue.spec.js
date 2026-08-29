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
const NAMES = ["mbIsPaid", "mbProductShape", "mbIsAutoRenew", "mbCycleDays",
               "mbMonthlyValue", "mbHasEconomics", "mbDecompose", "mbEffectiveTab"];
const api = new Function(
  "var MB_URL_TABS = ['memberships','autorenew','salesmix','checkins','retention'];\n" +
  NAMES.map(cut).join("\n") + "\nreturn { " + NAMES.join(", ") + " };")();
const { mbIsPaid, mbProductShape, mbIsAutoRenew, mbCycleDays,
        mbMonthlyValue, mbHasEconomics, mbDecompose, mbEffectiveTab } = api;

// The same membership, as the two feeds that are live at once describe it.
// A 4-hour cache means a pre-v2 response and a v2 response are both in flight
// for four hours after the card ships.
const V2_MONTHLY = { price: 20, renewalType: "Auto-renew", autoRenew: true,
  hasPlanTerms: true, hasCycle: true, planSeasonEnd: "", planTermDays: null,
  periodStart: "2026-08-29", nextRenewal: "2026-09-29" };
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
  assert.strictEqual(mbProductShape(V2_MONTHLY), "open");
});

test("a pre-v2 feed reads UNKNOWN, never open-ended", () => {
  // This is the load-bearing one. Guessing "open" on a feed with no plan
  // columns would file all 4,637 season passes as subscriptions and put
  // $807,142 of season-end re-buy into the churn number.
  assert.strictEqual(mbProductShape(PRE_V2_MONTHLY), "unknown");
  assert.strictEqual(mbProductShape({ hasPlanTerms: false, planSeasonEnd: "" }), "unknown");
});

// ── The cache invariant ─────────────────────────────────────────────────────
test("a membership on auto-renew reads that way on both feed shapes", () => {
  assert.strictEqual(mbIsAutoRenew(V2_MONTHLY), true);
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

// ── Cycle and monthly value ─────────────────────────────────────────────────
test("the billing cycle is measured, and an unknown cycle stays null", () => {
  assert.strictEqual(mbCycleDays(V2_MONTHLY), 31);
  assert.strictEqual(mbCycleDays(PRE_V2_MONTHLY), null,
    "a missing cycle is 'we do not know how often this bills', not 'monthly'");
  assert.strictEqual(mbCycleDays(V2_SEASON), null);
});

test("monthly value is null when the cycle is unknown — never defaulted", () => {
  const mv = mbMonthlyValue(V2_MONTHLY);
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

console.log("\n" + passed + " assertions passed.");
