// Regression spec for the disk-cache filename scheme in server.js.
// Mirrors cacheFileName() verbatim and documents the bug it fixes.
//
// Bug: disk-cache filenames were `base64url(key).slice(0,180)`. Report cache
// keys embed their Metabase params (dates, filters) as a long URL-encoded JSON
// string, so the date VALUES land past the 180-char cutoff. Two different date
// ranges for the same org/report therefore produced the SAME filename — a
// 7-day request read back the 30-day pre-warm/seed file written under the
// collided name. (Observed: apex/facility next-7 email PDF showed ~37 days.)
//
// Fix: hash the full key (sha256) — fixed length, collision-free.
// Run: node scripts/cache-filename.spec.js
"use strict";
const assert = require("assert");
const crypto = require("crypto");

// ── the two schemes ──
const oldFileName = key => Buffer.from(key).toString("base64url").slice(0, 180) + ".json";
const cacheFileName = key => crypto.createHash("sha256").update(key).digest("hex") + ".json"; // mirrors server.js

// Build a realistic report cache key exactly like the /:org/:report/api/data route:
//   `${org}:${report}:?parameters=${encodeURIComponent(JSON.stringify(params))}`
function key(org, report, startDate, endDate, orgId) {
  const params = [];
  if (orgId) params.push({ type: "string/=", target: ["variable", ["template-tag", "org_id"]], value: orgId });
  params.push({ type: "date/single", target: ["variable", ["template-tag", "start_date"]], value: startDate });
  params.push({ type: "date/single", target: ["variable", ["template-tag", "end_date"]], value: endDate });
  return `${org}:${report}:?parameters=${encodeURIComponent(JSON.stringify(params))}`;
}

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// The real report scenario: next-7 vs the 30-days-back/7-ahead seed window.
const ORGID = "c641a437-49c7-49f8-82bd-3417a7e3754b";
for (const orgId of [null, ORGID]) {
  const tag = orgId ? "shared (org_id present)" : "per-org (no org_id)";
  const k7   = key("apex", "facility", "2026-08-13", "2026-08-19", orgId);
  const kSeed = key("apex", "facility", "2026-07-14", "2026-08-20", orgId);

  test(`keys differ for different date ranges [${tag}]`, () => {
    assert.notStrictEqual(k7, kSeed);
  });

  test(`OLD scheme collides (documents the bug) [${tag}]`, () => {
    assert.strictEqual(oldFileName(k7), oldFileName(kSeed), "expected the old truncated names to collide");
  });

  test(`NEW scheme does NOT collide [${tag}]`, () => {
    assert.notStrictEqual(cacheFileName(k7), cacheFileName(kSeed));
  });
}

test("filename is deterministic for the same key", () => {
  const k = key("apex", "facility", "2026-08-13", "2026-08-19", ORGID);
  assert.strictEqual(cacheFileName(k), cacheFileName(k));
});

test("filename is a bounded, filesystem-safe length regardless of key size", () => {
  const huge = "apex:facility:" + "x".repeat(5000);
  assert.strictEqual(cacheFileName(huge).length, 64 + ".json".length); // 64 hex chars + ext
  assert.match(cacheFileName(huge), /^[0-9a-f]{64}\.json$/);
});

console.log(`\n${passed}/${passed} passing`);
