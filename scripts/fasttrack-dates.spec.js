// Spec for the Fast Track report's date handling.
//
// Reported 2026-08-24 (Dan): the report showed Smyrna's 154th Birthday Concert
// on "Oct 2 · Sat 02:00pm–07:00pm" while Rec's own admin showed Oct 3,
// 5:00–10:00pm. Two independent errors stacked up, and only one of them is
// fixable in this file.
//
// Ground truth from the read replica for those four sections:
//
//   session.starts_at            2026-10-03 21:00 UTC
//     America/New_York (Smyrna)  2026-10-03 Sat 17:00   <- what Rec shows
//     America/Los_Angeles        2026-10-03 Sat 14:00
//
//   1. THE TIME. Card 17300 computes section_day/section_time with
//      to_char(sess.starts_at, ...) and section_start with ::date. Both read the
//      SESSION TimeZone, and Metabase's report timezone is America/Los_Angeles
//      (current_setting('TimeZone') confirms it), so an Eastern org's 5pm event
//      is emitted as 02:00pm. That is a card fix, not a client one — the client
//      never sees the instant, only the string the card already rounded off.
//
//   2. THE DATE, which this spec covers. "Section Start" is ::date, so Metabase
//      sends the bare string "2026-10-03". new Date('2026-10-03') is specified
//      to parse as UTC midnight, so toLocaleDateString in any browser west of
//      UTC renders Oct 2 — the report moved a Saturday concert to Friday while
//      still printing the card's own "Sat" next to it, which is how the two bugs
//      were distinguishable at all.
//
// The trap worth pinning: the same report also carries real timestamps ("Reg
// Opens", "Reg Closes", "Publish Date"), which are instants and MUST keep going
// through new Date(). A parser that treats those as local wall-clock would shift
// every countdown on the page. So this checks both directions.
//
// Run: node scripts/fasttrack-dates.spec.js
"use strict";

// This spec is about a UTC-vs-local off-by-one, so it is meaningless in a UTC
// process — and both this sandbox and GitHub Actions run UTC. Reverting the fix
// passed every assertion here until the timezone was forced, which is the exact
// shape of a guard that looks like one and is not. So: re-exec under a fixed
// Eastern timezone (Smyrna's own) and assert against that.
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

const PAGE = path.join(__dirname, "..", "public", "fasttrack.html");
const src = fs.readFileSync(PAGE, "utf8");

// Lift the real helper out of the page. The page builds a React tree at module
// scope, so the whole block cannot be evaluated — only the function.
function lift(name, endMarker) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start > 0, "public/fasttrack.html should declare " + name);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, "could not find the end of " + name);
  const body = src.slice(start, end);
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(body + "\nthis." + name + " = " + name + ";", ctx);
  return ctx[name];
}

const parseCardDate = lift("parseCardDate", "function fmtDateShort");
const dateBlock = (function () {
  // fmtDateShort → sectionGoLive → calDaysUntil / dayPhrase / dayShort all sit
  // between these two markers; slice the lot, since sectionGoLive needs
  // fmtDateShort in scope anyway.
  const a = src.indexOf("function fmtDateShort");
  const b = src.indexOf("function regTiming");
  assert.ok(b > a, "could not slice the date helpers");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + `
    this.sectionGoLive = sectionGoLive;
    this.calDaysUntil = calDaysUntil;
    this.dayPhrase = dayPhrase;
    this.dayShort = dayShort;
  `, ctx);
  return ctx;
})();
const sectionGoLive = dateBlock.sectionGoLive;
const calDaysUntil = dateBlock.calDaysUntil;
const dayPhrase = dateBlock.dayPhrase;
const dayShort = dateBlock.dayShort;

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── the reported bug ────────────────────────────────────────────────────────

test("a date-only column keeps its calendar date", () => {
  const d = parseCardDate("2026-10-03");
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 9, "October");
  assert.strictEqual(d.getDate(), 3, "Oct 3 must not become Oct 2");
});

test("it formats as the date Rec shows, in any timezone west of UTC", () => {
  // toLocaleDateString reads the host timezone; the point is that the Date is
  // built from local parts, so no offset can move it off Oct 3.
  const d = parseCardDate("2026-10-03");
  assert.strictEqual(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), "Oct 3");
  assert.strictEqual(d.getHours(), 0, "local midnight, not an offset from UTC midnight");
  assert.strictEqual(d.toISOString().slice(0, 10), "2026-10-03",
    "in Eastern, local midnight on Oct 3 is 04:00Z the same day");
});

test("the naive parse really was wrong — this is the bug, reproduced", () => {
  const naive = new Date("2026-10-03");
  assert.ok(naive.getTimezoneOffset() > 0, "the spec must run behind UTC or it proves nothing");
  assert.strictEqual(naive.getDate(), 2,
    "new Date('2026-10-03') lands on Oct 2 in Eastern — which is what the report printed");
  assert.strictEqual(parseCardDate("2026-10-03").getDate(), 3,
    "and parseCardDate must not agree with it");
});

test("the card's weekday and the parsed date agree", () => {
  // The card sends "Sat" for this section. The old code printed the card's Sat
  // beside its own Oct 2 — a Friday — so the row contradicted itself.
  const d = parseCardDate("2026-10-03");
  assert.strictEqual(d.toLocaleDateString("en-US", { weekday: "short" }), "Sat");
});

// ── the other direction: instants must stay instants ────────────────────────

test("a full timestamp is still parsed as an instant", () => {
  const iso = "2026-08-25T14:00:00.000Z";
  assert.strictEqual(parseCardDate(iso).getTime(), new Date(iso).getTime(),
    "Reg Opens drives every countdown on the page and must not be shifted");
});

test("a timestamp with an offset keeps that offset", () => {
  const withOffset = "2026-08-25T10:00:00-04:00";
  assert.strictEqual(parseCardDate(withOffset).getTime(), new Date(withOffset).getTime());
});

test("a date-time without a zone is left to the platform, not treated as a date", () => {
  const local = "2026-10-03T17:00:00";
  assert.strictEqual(parseCardDate(local).getTime(), new Date(local).getTime());
});

// ── empties and junk ────────────────────────────────────────────────────────

test("blank and missing values are null, not Invalid Date", () => {
  [null, undefined, "", "   "].forEach(v => {
    assert.strictEqual(parseCardDate(v), null, JSON.stringify(v) + " should be null");
  });
});

test("an unparseable value is null rather than NaN leaking into arithmetic", () => {
  assert.strictEqual(parseCardDate("not a date"), null);
  assert.strictEqual(parseCardDate("2026-13-45"), null, "an impossible date is not a date");
});

test("surrounding whitespace does not defeat the date-only path", () => {
  const d = parseCardDate("  2026-10-03  ");
  assert.ok(d, "should parse");
  assert.strictEqual(d.getDate(), 3);
});

// ── two registration windows: early access is still registration ───────────
//
// Every Smyrna birthday-concert table carries both, a week apart:
//   Premier   early access Aug 24   general Aug 31
//   Preferred early access Aug 25   general Sep 1
// The page read only the general window, so it announced "Reg opens Aug 31 ·
// 8 days" for sections whose first families could register the next morning.

test("go-live is the earlier window, and says which one it is", () => {
  const gl = sectionGoLive({ regOpens: "2026-08-31T14:00:00Z", earlyAccess: "2026-08-24T14:00:00Z" });
  assert.strictEqual(gl.at.toISOString(), "2026-08-24T14:00:00.000Z", "early access opens first");
  assert.strictEqual(gl.kind, "early",
    "the label has to name it, or 'opens tomorrow' misreports who can register");
  assert.strictEqual(gl.general.toISOString(), "2026-08-31T14:00:00.000Z",
    "the general date is kept so the card can show both");
});

test("a general window that opens first still wins", () => {
  const gl = sectionGoLive({ regOpens: "2026-08-24T14:00:00Z", earlyAccess: "2026-08-31T14:00:00Z" });
  assert.strictEqual(gl.kind, "general");
  assert.strictEqual(gl.at.toISOString(), "2026-08-24T14:00:00.000Z");
});

test("one window on its own works either way round", () => {
  assert.strictEqual(sectionGoLive({ regOpens: "2026-09-01T10:00:00Z" }).kind, "general");
  assert.strictEqual(sectionGoLive({ earlyAccess: "2026-09-01T10:00:00Z" }).kind, "early");
});

test("a section with no window at all has no go-live", () => {
  const gl = sectionGoLive({});
  assert.strictEqual(gl.at, null);
  assert.strictEqual(gl.kind, null);
});

test("an unparseable window is ignored rather than poisoning the comparison", () => {
  const gl = sectionGoLive({ regOpens: "2026-09-01T10:00:00Z", earlyAccess: "not a date" });
  assert.strictEqual(gl.kind, "general", "a junk early date must not win by being NaN");
  assert.strictEqual(gl.at.toISOString(), "2026-09-01T10:00:00.000Z");
});

test("the early-access column is actually consumed now", () => {
  // It was mapped from the card and referenced exactly once — the mapping line
  // itself — for as long as the report has existed.
  const uses = (src.match(/earlyAccess/g) || []).length;
  assert.ok(uses >= 2, "earlyAccess must be read somewhere, not just mapped (found " + uses + ")");
  assert.ok(/sectionGoLive\(/.test(src), "and go-live must be derived through the helper");
});

// ── the page must actually use it ───────────────────────────────────────────

test("every date-only column goes through parseCardDate", () => {
  // A helper nothing calls is not a fix. These are the columns the card emits as
  // ::date; each one was a naive new Date() before.
  ["sectionStart", "sectionEnd"].forEach(f => {
    const naive = new RegExp("new Date\\\\((?:r|s|p)\\\\." + f + "\\\\)");
    assert.ok(!naive.test(src), f + " must not be parsed with a bare new Date()");
  });
  assert.ok(/parseCardDate\(r\.sectionStart\)/.test(src), "cold-section rows");
  assert.ok(/parseCardDate\(s\.sectionEnd\)/.test(src), "the all-past check");
  assert.ok(/parseCardDate\(ur\['First FT Date'\]\)/.test(src), "user rows");
  assert.ok(/parseCardDate\(ur\['First Any Booking'\]\)/.test(src), "user rows");
});

test("timestamps are deliberately NOT routed through it", () => {
  assert.ok(/new Date\(s\.regOpens\)/.test(src),
    "Reg Opens is an instant; routing it through a date-only parser would shift countdowns");
});

// ── "today" is today ────────────────────────────────────────────────────────
//
// Reported 2026-08-24 (Dan), at 9:45am ET: the report said "OPENS TOMORROW" and
// "early access Aug 24 (tomorrow)" about a window opening THAT DAY. Every
// countdown used Math.ceil((then - now) / 86400000), which counts 24-hour spans
// rather than calendar days — so anything later the same day came back as 1, and
// the "OPENS TODAY" branch sitting right there in the code was unreachable.
//
// These run under TZ=America/New_York (see the top of this file), which is both
// Smyrna's zone and the reader's, so "today" means what Dan means by it.

const AT = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi || 0);
const NOW = AT(2026, 8, 24, 9, 45);          // 9:45am ET on the 24th

test("something opening later today is today, not tomorrow", () => {
  assert.strictEqual(calDaysUntil(AT(2026, 8, 24, 14, 0), NOW), 0, "2pm today");
  assert.strictEqual(calDaysUntil(AT(2026, 8, 24, 23, 59), NOW), 0, "one minute before midnight");
  // The bug, reproduced: ms/24h arithmetic makes both of those "tomorrow".
  assert.strictEqual(Math.ceil((AT(2026, 8, 24, 14, 0) - NOW) / 86400000), 1,
    "this is what the page was doing, and why it said tomorrow");
});

test("tomorrow is tomorrow, however few hours away it is", () => {
  assert.strictEqual(calDaysUntil(AT(2026, 8, 25, 0, 5), NOW), 1,
    "14 hours away, but it is the next calendar day");
  assert.strictEqual(calDaysUntil(AT(2026, 8, 25, 10, 45), NOW), 1,
    "25 hours away — ceil calls this 2 days");
  assert.strictEqual(Math.ceil((AT(2026, 8, 25, 10, 45) - NOW) / 86400000), 2,
    "the old math overcounted in this direction too");
});

test("the further-out dates on the reported card land where Rec says", () => {
  // Smyrna's four birthday-concert tables, from the screenshot: early access
  // Aug 24, 25, 26, 27 — read at 9:45am on the 24th.
  assert.strictEqual(calDaysUntil(AT(2026, 8, 24, 12, 0), NOW), 0);
  assert.strictEqual(calDaysUntil(AT(2026, 8, 25, 12, 0), NOW), 1);
  assert.strictEqual(calDaysUntil(AT(2026, 8, 26, 12, 0), NOW), 2);
  assert.strictEqual(calDaysUntil(AT(2026, 8, 27, 12, 0), NOW), 3);
});

test("a window that already opened reads as past, not as today", () => {
  assert.strictEqual(calDaysUntil(AT(2026, 8, 23, 12, 0), NOW), -1);
  assert.strictEqual(calDaysUntil(AT(2026, 8, 17, 9, 45), NOW), -7);
});

test("a span crossing a DST boundary does not drift", () => {
  // US DST ends 1 Nov 2026, so 31 Oct → 1 Nov is a 25-hour day in Eastern.
  // Calendar arithmetic cannot notice; 24-hour arithmetic can.
  const from = AT(2026, 10, 31, 9, 0);
  assert.strictEqual(calDaysUntil(AT(2026, 11, 1, 9, 0), from), 1);
  assert.strictEqual(calDaysUntil(AT(2026, 11, 5, 9, 0), from), 5);
});

test("a missing date has no countdown rather than a wrong one", () => {
  assert.strictEqual(calDaysUntil(null, NOW), null);
  assert.strictEqual(dayPhrase(null), "");
  assert.strictEqual(dayShort(null), "");
});

test("zero never reaches the page as \"in 0 days\"", () => {
  assert.strictEqual(dayPhrase(0), "today");
  assert.strictEqual(dayPhrase(1), "tomorrow");
  assert.strictEqual(dayPhrase(6), "in 6 days");
  assert.strictEqual(dayPhrase(-3), "today", "a past date is not negative days away on screen");
  assert.strictEqual(dayShort(0), "today");
  assert.strictEqual(dayShort(1), "tomorrow");
  assert.strictEqual(dayShort(9), "9d");
});

test("no countdown on the page is computed by dividing milliseconds", () => {
  // The two remaining /86400000 uses are backward-looking windows (a 3-day
  // recency cutoff and a 30-day "opened recently" filter), where elapsed time
  // genuinely is the question. A forward-looking one is the bug returning.
  // Comments are stripped first — this file's own explanation of the bug quotes
  // the broken expression, and a guard that trips on its own documentation is
  // worse than no guard.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const forward = code.match(/Math\.ceil\(\([^)]*\)\s*\/\s*86400000\)/g) || [];
  assert.deepStrictEqual(forward, [],
    "found a countdown still using 24-hour spans: " + forward.join(", "));
  assert.ok(/function calDaysUntil/.test(src), "and the helper must exist");
  const uses = (src.match(/calDaysUntil\(/g) || []).length;
  assert.ok(uses >= 7, "every countdown should go through it (found " + uses + ")");
});

console.log(`\n${passed}/${passed} passing`);
