// Spec for removeOrgEntrySource() — the riskiest line of the delete-org path.
//
// Deleting an org opens a PR that excises its block from the ORGS literal in
// server.js. If that regex takes one brace too many, the pushed file does not
// parse and the next deploy crash-loops EVERY org, not just the deleted one.
// So this runs the real function against the real server.js and checks the
// result the only way that matters: it still parses, the target is gone, and
// nothing else moved.
//
// Run: node scripts/delete-org.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

// Lift the two functions out of server.js rather than restating them, so this
// tests the shipping implementation.
function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a > 0, `server.js should contain ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, `could not find the end of ${startMarker}`);
  return src.slice(a, b);
}
const escapeSrc = slice("function escapeRegExp(s) {", "\n\n");
const removeSrc = slice("function removeOrgEntrySource(content, slug) {", "\n\n// Open a PR");
const removeOrgEntrySource = new Function(
  "require",
  escapeSrc + "\n" + removeSrc + "\nreturn removeOrgEntrySource;"
)(require);

// Every slug in the literal, and how its key is written.
function orgKeysInSource(text) {
  const start = text.indexOf("\nconst ORGS = {");
  const end = text.indexOf("\n};", start);
  const block = text.slice(start, end);
  return [...block.matchAll(/^  "?([a-z0-9-]+)"?:\s*\{/gm)].map(m => m[1]);
}
const ALL = orgKeysInSource(src);

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

test("finds a realistic set of orgs to work with", () => {
  assert.ok(ALL.length > 5, `expected several orgs, found ${ALL.length}`);
  assert.ok(ALL.some(s => s.includes("-")), "expected at least one hyphenated (quoted-key) slug");
  assert.ok(ALL.some(s => !s.includes("-")), "expected at least one bare-key slug");
});

// The function syntax-checks its own output and throws if it fails, so every
// successful return below is also proof the file still parses.
ALL.forEach(slug => {
  test(`removing "${slug}" leaves a parseable server.js with every other org intact`, () => {
    const out = removeOrgEntrySource(src, slug);
    const after = orgKeysInSource(out);
    assert.ok(!after.includes(slug), `${slug} should be gone`);
    assert.deepStrictEqual(after, ALL.filter(s => s !== slug), "no other org may move or vanish");
    assert.strictEqual(after.length, ALL.length - 1);
    // The block really left, not just its key line.
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.ok(!new RegExp(`^\\s+"?${esc}"?\\s*:\\s*\\{`, "m").test(out));
  });
});

test("removing an org twice over is refused rather than silently doing nothing", () => {
  const once = removeOrgEntrySource(src, ALL[0]);
  assert.throws(() => removeOrgEntrySource(once, ALL[0]), /not in the server\.js ORGS map/);
});

test("an unknown slug throws instead of returning the file unchanged", () => {
  assert.throws(() => removeOrgEntrySource(src, "no-such-org-here"), /not in the server\.js ORGS map/);
});

test("a slug that is a substring of another org is not confused for it", () => {
  // "apex" is a prefix of nothing today, but the anchored key match is what
  // guarantees that stays true when someone adds "apex-north" later.
  const withNeighbour = src.replace(
    /\n  apex: \{/,
    '\n  "apex-north": {\n    token:   "x",\n    orgId:   "y",\n  },\n  apex: {'
  );
  assert.notStrictEqual(withNeighbour, src, "fixture should have applied");
  const out = removeOrgEntrySource(withNeighbour, "apex");
  const after = orgKeysInSource(out);
  assert.ok(after.includes("apex-north"), "the neighbour must survive");
  assert.ok(!after.includes("apex"), "the target must go");
});

test("refuses to guess when a slug appears twice in the map", () => {
  const doubled = src.replace(/\n  apex: \{/, '\n  apex: {\n    token:   "dup",\n  },\n  apex: {');
  assert.throws(() => removeOrgEntrySource(doubled, "apex"), /refusing to guess/);
});

test("output is byte-identical to the input apart from the removed block", () => {
  const slug = ALL[ALL.length - 1];
  const out = removeOrgEntrySource(src, slug);
  const removed = src.length - out.length;
  assert.ok(removed > 0, "something should have been removed");
  // Rebuilding the input by re-inserting the excised text must reproduce it
  // exactly — proof nothing else was touched.
  const cut = src.length - out.length;
  let i = 0;
  while (src[i] === out[i]) i++;                       // first divergence
  const excised = src.slice(i, i + cut);
  assert.strictEqual(out.slice(0, i) + excised + out.slice(i), src);
});

console.log(`\n${passed}/${passed} passing`);
