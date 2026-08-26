// Spec for the Memberships → Check-Ins tab: date handling, the desk-location
// filter, and the member link.
//
// Three regressions are pinned here, all of which render perfectly while being
// wrong:
//
//  1. WEEKDAY LETTERS. The check-in card emits "Date" as a bare ::date string
//     ("2026-08-24"), and new Date() parses that as UTC midnight — so a browser
//     anywhere west of UTC reads Monday the 24th as Sunday the 23rd. That is the
//     same bug the Fast Track report had (see fasttrack-dates.spec.js); the M/T/W
//     markers on the Daily Check-Ins chart are built from ciDow(), which reads
//     the string's parts instead.
//
//  2. THE LOCATION FILTER HAS TO REACH EVERY PANEL. The facility Summary shipped
//     chips that scoped some panels and not others, and the numbers disagreed
//     across the page for a week. So: everything inside the Check-Ins derivation
//     reads ciView (the filtered rows) and nothing reads ciRows.
//
//  3. THE MEMBER LINK NEEDS users.id. The card emits BOTH ids — "Member ID" is
//     users.rec_id, the 6-character code staff read out at the desk, and "User
//     ID" is the uuid the /admin/o/<org>/users/<id> URL accepts. A link built
//     from the rec_id looks identical and 404s, so the id used is asserted.
//
// Run: node scripts/checkins-view.spec.js
"use strict";

// (1) is a UTC-vs-local off-by-one, so it cannot be tested in a UTC process —
// and this sandbox and GitHub Actions are both UTC. Re-exec under a fixed
// Eastern timezone; without this the broken parse passes every assertion.
const TZ = "America/New_York";
if (process.env.TZ !== TZ) {
  const r = require("child_process").spawnSync(process.execPath, [__filename],
    { env: Object.assign({}, process.env, { TZ }), stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "memberships.html");
const src = fs.readFileSync(PAGE, "utf8");

// ── Lift the helper block ───────────────────────────────────────────────────
// The page builds a React tree at module scope, so the file cannot be evaluated
// whole. The check-in helpers are deliberately declared together, above the
// component that reads them (Babel compiles const→var, so a helper below its
// caller is silently `undefined` rather than a throw naming it).
const START = "const CI_DOW1 =";
const END = "function normalizeRow(";
const a = src.indexOf(START), b = src.indexOf(END);
assert.ok(a > 0, "public/memberships.html should declare CI_DOW1");
assert.ok(b > a, "the check-in helpers should sit above normalizeRow()");
const ctx = { console };
vm.createContext(ctx);
// `const` in a script is lexical, so CI_DOW1/CI_DOW3 never land on the context
// object the way the function declarations do — hand them out explicitly.
vm.runInContext(src.slice(a, b) + "\n;this.CI_DOW1 = CI_DOW1; this.CI_DOW3 = CI_DOW3;", ctx);

let n = 0;
const is = (actual, expected, what) => { n++; assert.strictEqual(actual, expected, what); };
const ok = (cond, what) => { n++; assert.ok(cond, what); };

// ── 1. Dates read as local wall clock, not UTC instants ────────────────────
// 22/23/24 August 2026 is Sat/Sun/Mon. Under new Date("2026-08-24") in Eastern
// these all slide back one day, which is the regression.
is(ctx.ciDow("2026-08-24"), 1, "2026-08-24 is a Monday");
is(ctx.ciDow("2026-08-23"), 0, "2026-08-23 is a Sunday");
is(ctx.ciDow("2026-08-22"), 6, "2026-08-22 is a Saturday");
is(ctx.CI_DOW1[ctx.ciDow("2026-08-24")], "M", "Monday's marker is M");
is(ctx.CI_DOW3[ctx.ciDow("2026-08-24")], "Mon", "Monday's long marker is Mon");
is(ctx.ciIsWeekend("2026-08-22"), true, "Saturday is a weekend");
is(ctx.ciIsWeekend("2026-08-23"), true, "Sunday is a weekend");
is(ctx.ciIsWeekend("2026-08-24"), false, "Monday is not a weekend");
is(ctx.ciDateLabel("2026-08-24"), "Aug 24", "the axis label keeps the card's own day");
is(ctx.ciDow(""), null, "a missing date has no weekday rather than a wrong one");
is(ctx.ciDow(null), null, "a null date has no weekday");
// A timestamp column would still work, but the tab never gets one — the guard is
// that a longer string does not confuse the parse.
is(ctx.ciDow("2026-08-24T22:15:00Z"), 1, "a date-time prefix reads as the same local day");

// ── Month keys ─────────────────────────────────────────────────────────────
is(ctx.ciMonthKey("2026-08-24"), "2026-08", "month key comes off the string, not a Date");
is(ctx.ciMonthKey("2026-01-01"), "2026-01", "January the 1st does not fall into December");
is(ctx.ciMonthKey(""), "", "no date, no month");
is(ctx.ciMonthShort("2026-08"), "Aug", "short month label");
is(ctx.ciMonthLong("2026-08"), "August 2026", "the bar caption names the year too");

// ── Hour labels ────────────────────────────────────────────────────────────
is(ctx.ciHourShort(17), "5p", "17:00 is 5p");
is(ctx.ciHourShort(0), "12a", "midnight is 12a");
is(ctx.ciHourShort(12), "12p", "noon is 12p");
is(ctx.ciHourLong(17), "5pm", "the caption spells the peak hour out");
is(ctx.ciHourLong(9), "9am", "morning hours keep am");

// ── 3. The member link ─────────────────────────────────────────────────────
is(ctx.ciUserUrl("org-1", "24d709e5-675b-4d7e-91e3-f7b18daeb41c"),
   "https://www.rec.us/admin/o/org-1/users/24d709e5-675b-4d7e-91e3-f7b18daeb41c",
   "the link is the Rec admin user page");
is(ctx.ciUserUrl("org-1", ""), null, "no uuid, no link — the cell falls back to text");
is(ctx.ciUserUrl("", "24d709e5"), null, "no org id, no link");
is(ctx.ciUserUrl(null, null), null, "nothing at all, no link");

// ── Source invariants ──────────────────────────────────────────────────────
// (a) Every figure on the tab reads the FILTERED rows. The derivation block is
//     the IIFE that starts once ciView is known to be non-empty; a single
//     `ciRows` inside it is a panel the location filter cannot reach.
const DERIVE_START = "ciView.length > 0 && (() => {";
// Ends where the panels do: the "nothing loaded yet" line below is allowed to
// ask about ciRows, since that is the question of whether a fetch has landed at
// all rather than a figure being reported.
const DERIVE_END = "{!ciLoading && (!ciRows || ciRows.length === 0)";
const d0 = src.indexOf(DERIVE_START), d1 = src.indexOf(DERIVE_END, d0);
ok(d0 > 0, "the Check-Ins tab should derive its panels from ciView");
ok(d1 > d0, "the empty-state line should follow the check-ins panels");
const derive = src.slice(d0, d1);
is((derive.match(/\bciRows\b/g) || []).length, 0,
   "nothing inside the Check-Ins panels may read the unfiltered ciRows");
ok(/ciView\s*=\s*useMemo/.test(src), "ciView should be a memo over the loaded rows");
ok(/return ciOk\.filter\(function\s*\(r\)\s*\{\s*return \(r\['Desk Location'\]/.test(src),
   "ciView should filter on the row's own Desk Location");
ok(/if \(ciLoc === 'all'\) return ciOk;/.test(src),
   "'all' should pass the successful rows through rather than filtering to a magic string");

// ── 4. A FAILED scan is not a check-in ──────────────────────────────────────
// Card 18151 also emits membership/pass check-in DENIALS, which share the row
// shape of a success. That is the facility Summary bug exactly: invoice fee lines
// arrived shaped like bookings and every row count became a booking count. The
// defence is that ciView — which every panel already reads — carries successes
// only, so nothing downstream had to be audited panel by panel.
ok(/function ciIsFailed\(r\)/.test(src),
   "ciIsFailed should be a named module-scope function, so this spec can RUN it " +
   "rather than regex over the component (the nightStateFrom lesson)");
is(ctx.ciIsFailed({ Status: "Failed" }), true, "a Failed row is a failure");
is(ctx.ciIsFailed({ Status: "Checked In" }), false, "a Checked In row is not");
// THE BLANK-TAB GUARD. Before the card ships the column — and for the life of
// every already-warm 4-hour cache entry — no row has a Status at all. Testing
// `=== 'Checked In'` instead would make ciOk empty and take the whole tab down.
is(ctx.ciIsFailed({ "Member ID": "5OLLPM" }), false,
   "a row with NO Status is a SUCCESS — the old feed had nothing but check-ins");
is(ctx.ciIsFailed({ Status: undefined }), false, "an undefined Status is a success");
is(ctx.ciIsFailed(null), false, "a missing row is not a failure");
is(ctx.ciIsFailed({ Status: "failed" }), false,
   "the match is exact — a lowercase value is not the card's value");

ok(/const ciOk = useMemo/.test(src), "ciOk should be a memo over the loaded rows");
{
  // Slice the memo body and require it removes failures — asserted on the code
  // rather than a whitespace-normalised haystack, so it cannot pass vacuously.
  const o0 = src.indexOf("const ciOk = useMemo");
  const body = src.slice(o0, src.indexOf("}, [ciRows]);", o0));
  ok(/!ciIsFailed\(r\)/.test(body), "ciOk should be the feed MINUS failures: " + body.slice(0, 200));
  ok(/ciRows\.filter/.test(body), "…filtered from the raw feed");
}

// The failure figures must be HIDDEN, not zeroed, when the feed has no Status:
// a 0 would read as "nobody was turned away" rather than "we cannot see it yet".
ok(/const ciHasStatus = useMemo/.test(src), "the page should detect whether Status is present");
ok(/ciHasStatus && \(/.test(src), "the Failed tile should be gated on that detection");

// And the failure count must respect the desk filter, or the tile silently stays
// org-wide while everything above it narrowed.
ok(/const ciFailView = useMemo/.test(src), "failures need their own location-scoped view");
{
  // …and it must actually SCOPE. Asserting the identifier exists is not enough:
  // dropping the filter leaves the name in place and the tile silently reports
  // org-wide failures under a desk the reader narrowed to.
  const f0 = src.indexOf("const ciFailView = useMemo");
  const body = src.slice(f0, src.indexOf("}, [ciFail, ciLoc]);", f0));
  ok(body.length > 0 && body.length < 600, "could not slice the ciFailView memo");
  ok(/ciFail\.filter/.test(body) && /Desk Location/.test(body) && /ciLoc/.test(body),
     "ciFailView must filter ciFail on the row's Desk Location against ciLoc: " + body.slice(0, 200));
}
ok(/data-ci-failed=\{ciFailView\.length\}/.test(src),
   "the tile should render the SCOPED failure count");

// (b) The link is built from the uuid column, never from the rec_id.
ok(/ciUserUrl\(recOrgId, r\['User ID'\]\)/.test(derive),
   "the check-in table should link on 'User ID' (users.id)");
ok(/ciUserUrl\(recOrgId, m\.userId\)/.test(derive),
   "Top Members should link on the member's uuid");
is((derive.match(/ciUserUrl\([^)]*Member ID/g) || []).length, 0,
   "no link may be built out of 'Member ID' (users.rec_id) — it 404s");

// (c) The weekday markers come from ciDow, not from a fresh Date parse.
ok(/data-ci-dow=\{CI_DOW1\[p\.dow\]\}/.test(derive),
   "the daily chart should mark weekdays from ciDow()");
is((derive.match(/new Date\((?:e\[0\]|p\.date)/g) || []).length, 0,
   "the daily chart should not re-parse its date strings through new Date()");

console.log("✓ checkins-view.spec.js — " + n + " assertions");
