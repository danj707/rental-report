// Spec for the date window server.js asks rec.us's nightly-availability feed for.
//
// THE BUG THIS EXISTS FOR, measured 2026-08-25 at 00:02 UTC (17:02 PDT):
//
//   MCP feed          first check-in date  2026-08-24   ← the campground's today
//   our REST request  from=                2026-08-25   ← UTC's today
//
// `from` may not be in the past, and rec.us judges "past" in the SITE's local
// date. A Pacific campground is 7-8 hours behind UTC, so from 17:00 local until
// midnight the UTC date is already tomorrow there — and a UTC-dated request
// silently drops the campground's CURRENT NIGHT. Seven hours out of every day,
// "is anything free tonight" would have come back `unknown` on all 41 Topaz
// sites, on a page that renders perfectly the whole time.
//
// This is the same shape as the two date bugs already in CLAUDE.md (the Fast
// Track `new Date("YYYY-MM-DD")` parse, and Metabase rendering timestamps in
// Pacific): a date computed in the wrong zone, invisible wherever the zones
// happen to agree. THIS SANDBOX AND GITHUB ACTIONS BOTH RUN UTC, where a naive
// implementation looks right for 17 hours a day — so, like
// fasttrack-dates.spec.js, this file re-execs itself under a fixed non-UTC
// timezone AND pins fixed instants rather than reading the clock.
//
// Run: node scripts/campmap-nightly-window.spec.js
"use strict";

// Re-exec under a timezone that is NOT UTC, for the reason above. Doing it here
// rather than in CI means the protection travels with the file.
if (process.env.TZ !== "America/Los_Angeles") {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [__filename],
    { stdio: "inherit", env: { ...process.env, TZ: "America/Los_Angeles" } });
  process.exit(r.status === null ? 1 : r.status);
}

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// Lift the real function out of server.js rather than restating it — a copy
// would pass forever after the shipping one regressed.
function slice(from, to) {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i);
  assert.ok(i > 0 && j > i, `could not slice ${from} .. ${to} — did server.js move?`);
  return src.slice(i, j);
}
const nightlyRange = new Function(
  slice("function nightlyRange(nowMs, backOne, span) {", "// One probe, memoised")
  + "\nreturn nightlyRange;")();

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

const SPAN = 210;
// The exact instant the bug was measured at: 2026-08-25 00:02 UTC, which is
// 2026-08-24 17:02 in Pacific. UTC has rolled over; the campground has not.
const EVENING = Date.parse("2026-08-25T00:02:00Z");
// Mid-afternoon UTC the same day, when Pacific has caught up and both agree.
const MIDDAY = Date.parse("2026-08-25T19:00:00Z");

// ── 1. the regression itself ────────────────────────────────────────────────
test("in the evening-Pacific window, the range starts on the campground's today", () => {
  const r = nightlyRange(EVENING, true, SPAN);
  assert.strictEqual(r.from, "2026-08-24",
    "UTC says the 25th; Topaz is still on the 24th and that night is still bookable");
});

test("and it does NOT start on the UTC date, which would drop tonight", () => {
  const r = nightlyRange(EVENING, true, SPAN);
  assert.notStrictEqual(r.from, "2026-08-25",
    "this is the bug: the campground's current night falls out of the feed");
});

// ── 2. once the dates agree, asking a day back would be genuinely past ──────
test("when the probe says no, the range starts on the UTC date", () => {
  // 19:00 UTC = 12:00 Pacific: both are on the 25th, so the 24th is over
  // everywhere and rec.us 400s it. nightlyStartsYesterday() reports false and
  // the range must follow.
  const r = nightlyRange(MIDDAY, false, SPAN);
  assert.strictEqual(r.from, "2026-08-25");
});

test("the two answers differ — the flag is load-bearing, not decoration", () => {
  assert.notStrictEqual(nightlyRange(MIDDAY, true, SPAN).from,
                        nightlyRange(MIDDAY, false, SPAN).from);
});

// ── 3. the span is rec.us's, and 211 is a 400 rather than a truncation ──────
test("the range spans exactly `span` dates, inclusive of both ends", () => {
  const days = (a, b) => (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000 + 1;
  for (const [now, back] of [[EVENING, true], [EVENING, false], [MIDDAY, false]]) {
    const r = nightlyRange(now, back, SPAN);
    assert.strictEqual(days(r.from, r.to), SPAN,
      `${r.from}..${r.to} is not ${SPAN} dates — 211 is a 400, not a truncation`);
  }
});

test("a shorter span is honoured too", () => {
  const r = nightlyRange(MIDDAY, false, 30);
  assert.deepStrictEqual(r, { from: "2026-08-25", to: "2026-09-23" });
});

// ── 4. it must not drift with the machine's local timezone ──────────────────
test("the same instant yields the same range whatever TZ the process runs in", () => {
  // This process is pinned to Pacific by the re-exec above. The dates come out
  // of toISOString(), which is UTC — the timezone correction rides on `backOne`,
  // which rec.us answers, rather than on the server's own clock. A future
  // "simplification" to getFullYear()/getMonth() would make the feed depend on
  // where the container happens to run, and fails here.
  assert.strictEqual(process.env.TZ, "America/Los_Angeles");
  assert.strictEqual(nightlyRange(MIDDAY, false, SPAN).from, "2026-08-25",
    "a local-time implementation reads 2026-08-25 here too — but see the next case");
  // 2026-08-25 06:00 UTC = 2026-08-24 23:00 Pacific. A local-time implementation
  // would say the 24th and then ALSO step back a day, landing on the 23rd, which
  // rec.us refuses outright.
  assert.strictEqual(nightlyRange(Date.parse("2026-08-25T06:00:00Z"), true, SPAN).from,
    "2026-08-24", "must be UTC-derived, then corrected by the probe — not local-derived");
});

// ── 5. crossing a month and a year boundary ─────────────────────────────────
test("the window crosses month and year ends without arithmetic slips", () => {
  const r = nightlyRange(Date.parse("2026-12-31T12:00:00Z"), false, SPAN);
  assert.strictEqual(r.from, "2026-12-31");
  assert.strictEqual(r.to, "2027-07-28");
  const b = nightlyRange(Date.parse("2027-01-01T02:00:00Z"), true, SPAN);
  assert.strictEqual(b.from, "2026-12-31", "New Year's Eve is still today in Pacific");
});

console.log(`\n${passed}/${passed} passing`);
