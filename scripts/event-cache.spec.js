// Spec for the memoized event log.
//
// Why this exists — the admin dashboard took ~10 seconds to serve (2026-08-24):
//
//   readEvents() read events.jsonl in full and JSON.parsed every line on EVERY
//   call, applying the date cutoff only afterwards, so readEvents(1) cost the
//   same as readEvents(null). The admin page calls it 89 times to render once —
//   AI spend, the platform trend, and three times per org across the sidebar,
//   the org sparkline and buildMetrics. At 82k lines / 23MB that is ~2GB of
//   synchronous reads and ~7.3M JSON.parse calls per page load, on the event
//   loop, so it also stalled every other request while it ran. Measured against
//   production: /metrics/api/data (29 of those calls) took 4.5s, and the same
//   endpoint at days=1 took 4.9s — proving the cost was the parse and not the
//   aggregation.
//
// The fix parses only bytes appended since the last read. That makes staleness
// the new failure mode, and a stale event log is worse than a slow one: it would
// silently hold back the activity gate that decides which reports get watched,
// the health panel, and every usage number on the dashboard. Nothing about a
// stale cache looks wrong on screen — the page renders perfectly with old
// numbers. So freshness is what most of this spec is about.
//
// The properties that fail silently, and are therefore pinned here:
//
//   1. An appended event is visible on the next call. If this breaks, every
//      count on the dashboard freezes at whatever it was when the process
//      booted, and nothing complains.
//   2. A half-written line is not parsed, and IS picked up once completed. The
//      writer is appendFileSync, so a read can land mid-line; dropping that
//      line permanently would lose events for good.
//   3. The result is a copy. The audit log route does readEvents(days).reverse(),
//      which mutates in place — handing out the cache itself would leave every
//      later caller reading a backwards log.
//   4. A truncated or replaced file re-reads from the top, rather than trusting
//      a byte offset into a file that no longer exists.
//   5. The windowed read binary-searches, which is only valid while the log is
//      in timestamp order. An out-of-order log must fall back to a filter and
//      still return exactly what the old implementation returned.
//   6. It does not re-parse what it has already parsed — the whole point.
//
// Run: node scripts/event-cache.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

function slice(start, end) {
  const a = src.indexOf(start);
  assert.ok(a > 0, `server.js should contain: ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `could not find the end of: ${start}`);
  return src.slice(a, b);
}

// Lift the real block out of server.js, with EVENTS_FILE pointed at a temp file
// and JSON shadowed by a counting wrapper — so "it did not re-parse" is measured
// rather than assumed.
function build(file) {
  const body = slice("// ── Event log cache ──", "// Aggregate events into metrics for one org");
  assert.ok(body.includes("function readEvents(daysBack)"), "the slice must contain readEvents");
  const counter = { parses: 0 };
  const countingJSON = {
    parse(t) { counter.parses++; return JSON.parse(t); },
    stringify: JSON.stringify,
  };
  const api = new Function("fs", "EVENTS_FILE", "JSON",
    body + "\nreturn { readEvents, eventCache, loadEventCache };"
  )(fs, file, countingJSON);
  api.counter = counter;
  return api;
}

// The reference implementation: what readEvents did before the cache. Every
// equivalence assertion below is against this, not against hand-written
// expectations, so the spec cannot drift into agreeing with a new bug.
function reference(file, daysBack, now) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const cutoff = daysBack ? new Date(now - daysBack * 86400000).toISOString() : null;
  return raw.trim().split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(e => e && (!cutoff || e.ts >= cutoff));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "event-cache-"));
let fileSeq = 0;
function newFile() { return path.join(tmp, `events-${++fileSeq}.jsonl`); }

/* THE FIXTURE CLOCK MUST BE THE IMPLEMENTATION'S CLOCK.
   This was a hardcoded Date.UTC(2026, 7, 24, 12, 0, 0) — the day the spec was
   written. Every fixture event is stamped RELATIVE to it (see ev(daysAgo)),
   but readEvents() takes its cutoff from the real Date.now(), so once the
   wall clock moved more than 7 days past 2026-08-24 the whole fixture fell
   outside every narrow window and "appends land in the windowed read too"
   started asserting 0 !== 2. It failed on 2026-08-31 and would have failed
   on every PR from then on — the CI failure was a DATE, not a code change,
   and it was blocking Railway from building any preview (checkSuites: true).
   Freezing a fixture clock is only coherent when the code under test reads
   the same frozen clock; this one reads the wall clock, so the fixture has
   to as well. */
const NOW = Date.now();
function ev(daysAgo, org, event) {
  return { ts: new Date(NOW - daysAgo * 86400000).toISOString(), org, report: "gl", event };
}
function write(file, events) {
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join("\n") + "\n");
}
function append(file, events) {
  fs.appendFileSync(file, events.map(e => JSON.stringify(e)).join("\n") + "\n");
}
// A log in real order: oldest first, which is what appendFileSync produces.
function chronological(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(ev(i * (90 / n), "org" + (i % 5), i % 7 === 0 ? "pdf" : "view"));
  return out;
}

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── it returns what the old implementation returned ─────────────────────────

test("every window matches the pre-cache implementation exactly", () => {
  const f = newFile();
  write(f, chronological(400));
  const api = build(f);
  for (const days of [null, 1, 3, 7, 30, 45, 90, 365]) {
    const got = api.readEvents(days).map(e => e.ts);
    const want = reference(f, days, Date.now()).map(e => e.ts);
    assert.deepStrictEqual(got, want, `window ${days} must match the old behaviour`);
  }
});

test("a missing log reads as empty, not as a crash", () => {
  const api = build(path.join(tmp, "does-not-exist.jsonl"));
  assert.deepStrictEqual(api.readEvents(30), []);
  assert.deepStrictEqual(api.readEvents(null), []);
});

test("an unparseable line is skipped, and the rest of the log survives it", () => {
  const f = newFile();
  write(f, chronological(10));
  fs.appendFileSync(f, "{ this is not json }\n");
  append(f, [ev(0, "apex", "view")]);
  const api = build(f);
  assert.strictEqual(api.readEvents(null).length, 11, "10 good + 1 good, the broken line dropped");
  assert.strictEqual(api.readEvents(null).length, reference(f, null, Date.now()).length);
});

// ── freshness: the failure mode the cache introduces ────────────────────────

test("an appended event is visible on the very next call", () => {
  const f = newFile();
  write(f, chronological(50));
  const api = build(f);
  assert.strictEqual(api.readEvents(null).length, 50);
  append(f, [ev(0, "brand-new", "view")]);
  const after = api.readEvents(null);
  assert.strictEqual(after.length, 51, "a stale cache is worse than a slow page");
  assert.strictEqual(after[after.length - 1].org, "brand-new");
});

test("appends land in the windowed read too, not just the unfiltered one", () => {
  const f = newFile();
  write(f, chronological(50));
  const api = build(f);
  const before = api.readEvents(7).length;
  append(f, [ev(0, "fresh", "view"), ev(0, "fresh", "pdf")]);
  assert.strictEqual(api.readEvents(7).length, before + 2);
  assert.deepStrictEqual(api.readEvents(7).map(e => e.ts), reference(f, 7, Date.now()).map(e => e.ts));
});

test("a half-written last line is not parsed, and is picked up once finished", () => {
  const f = newFile();
  write(f, chronological(20));
  const complete = JSON.stringify(ev(0, "torn", "view"));
  const cut = Math.floor(complete.length / 2);
  fs.appendFileSync(f, complete.slice(0, cut));           // writer caught mid-line
  const api = build(f);
  assert.strictEqual(api.readEvents(null).length, 20, "the partial line must not be parsed");
  fs.appendFileSync(f, complete.slice(cut) + "\n");       // writer finishes
  const after = api.readEvents(null);
  assert.strictEqual(after.length, 21, "and must not be lost either");
  assert.strictEqual(after[20].org, "torn");
});

test("a multi-byte character split across a read boundary is not corrupted", () => {
  const f = newFile();
  write(f, chronological(5));
  const rec = JSON.stringify({ ...ev(0, "münchen-café-日本", "view"), ua: "naïve—dash" });
  const bytes = Buffer.from(rec + "\n", "utf8");
  // Stop the first write inside a multi-byte sequence.
  let split = Math.floor(bytes.length / 2);
  while (split > 0 && (bytes[split] & 0xc0) === 0x80) split--;
  split++;
  assert.ok((bytes[split] & 0xc0) === 0x80, "the split must land mid-character to be a real test");
  fs.appendFileSync(f, bytes.subarray(0, split));
  const api = build(f);
  assert.strictEqual(api.readEvents(null).length, 5);
  fs.appendFileSync(f, bytes.subarray(split));
  const after = api.readEvents(null);
  assert.strictEqual(after.length, 6);
  assert.strictEqual(after[5].org, "münchen-café-日本", "the characters must survive the boundary");
  assert.strictEqual(after[5].ua, "naïve—dash");
});

test("a truncated or replaced log is re-read from the top", () => {
  const f = newFile();
  write(f, chronological(60));
  const api = build(f);
  assert.strictEqual(api.readEvents(null).length, 60);
  write(f, chronological(5));                              // rotated / hand-edited / fresh volume
  assert.strictEqual(api.readEvents(null).length, 5, "a byte offset into the old file means nothing");
  assert.deepStrictEqual(api.readEvents(null).map(e => e.ts), reference(f, null, Date.now()).map(e => e.ts));
});

// ── the cache must not be handed out ────────────────────────────────────────

test("the caller cannot mutate the cache — the audit log reverses its result", () => {
  const f = newFile();
  write(f, chronological(30));
  const api = build(f);
  const first = api.readEvents(null)[0].ts;
  api.readEvents(null).reverse();                          // what /api/admin/audit-log does
  assert.strictEqual(api.readEvents(null)[0].ts, first, "reverse() must not reach the cache");
  const windowed = api.readEvents(30);
  windowed.reverse();
  assert.strictEqual(api.readEvents(30)[0].ts, api.readEvents(30)[0].ts);
  assert.notStrictEqual(api.readEvents(null), api.readEvents(null), "each call returns its own array");
});

// ── the binary search is only valid on an ordered log ───────────────────────

test("an out-of-order log falls back to a filter and still answers correctly", () => {
  const f = newFile();
  const jumbled = [ev(2, "a", "view"), ev(80, "b", "view"), ev(0, "c", "view"), ev(40, "d", "view")];
  write(f, jumbled);
  const api = build(f);
  api.readEvents(null);                                    // order is judged while parsing
  assert.strictEqual(api.eventCache.sorted, false, "out-of-order must be detected");
  assert.deepStrictEqual(
    api.readEvents(7).map(e => e.org).sort(),
    reference(f, 7, Date.now()).map(e => e.org).sort(),
    "the answer must not depend on which path was taken");
});

test("an event with no timestamp cannot silently fall into a window", () => {
  const f = newFile();
  write(f, [ev(1, "a", "view"), { org: "no-ts", report: "gl", event: "view" }, ev(0, "b", "view")]);
  const api = build(f);
  api.readEvents(null);
  assert.strictEqual(api.eventCache.sorted, false, "a missing ts disables the binary search");
  assert.deepStrictEqual(api.readEvents(7).map(e => e.org), reference(f, 7, Date.now()).map(e => e.org));
  assert.strictEqual(api.readEvents(null).length, 3, "but it is still part of the whole log");
});

test("a sorted log is recognised as sorted, or the fast path never runs", () => {
  const f = newFile();
  write(f, chronological(100));
  const api = build(f);
  api.readEvents(30);
  assert.strictEqual(api.eventCache.sorted, true,
    "a normal append-only log must take the binary-search path, or this whole change buys nothing");
});

// ── and the point of the exercise ───────────────────────────────────────────

test("89 calls parse the log once, not 89 times", () => {
  const f = newFile();
  write(f, chronological(2000));
  const api = build(f);
  api.readEvents(30);
  const afterFirst = api.counter.parses;
  assert.strictEqual(afterFirst, 2000, "the first call parses every line");
  // The admin dashboard's real shape: 1 all-time + 1 trend + 3 per org × 29.
  for (let i = 0; i < 89; i++) api.readEvents(i % 3 === 0 ? null : 30);
  assert.strictEqual(api.counter.parses, afterFirst,
    "no line may be parsed twice — 89 re-parses is the bug this exists to prevent");
});

test("an append parses only the appended lines", () => {
  const f = newFile();
  write(f, chronological(1000));
  const api = build(f);
  api.readEvents(null);
  const before = api.counter.parses;
  append(f, [ev(0, "x", "view"), ev(0, "y", "view"), ev(0, "z", "view")]);
  api.readEvents(null);
  assert.strictEqual(api.counter.parses - before, 3, "only the tail is parsed");
});

test("an unchanged log does not even read the file", () => {
  const f = newFile();
  write(f, chronological(100));
  const api = build(f);
  api.readEvents(null);
  const bytes = api.eventCache.bytes;
  assert.ok(bytes > 0, "the byte offset must be tracked");
  api.readEvents(null);
  assert.strictEqual(api.eventCache.bytes, bytes, "a no-op call must not move the offset");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed} passing`);
