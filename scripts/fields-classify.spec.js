// Spec for the Fields tab's name-derived classification.
//
// WHY THIS EXISTS. Rec stores no sport on a field: `court.sub_type` is NULL on
// all 1,903 of them platform-wide. So the Fields tab infers the sport from the
// field and park NAMES, which is a guess — and a guess that renders perfectly
// when it is wrong. The courts tab already learned this the hard way: matching
// /rv/ before the exact values labelled an RV-ONLY campsite "Tent & RV", the one
// answer a tent camper must never be given (see refineSiteType in CLAUDE.md).
//
// The same shape of trap is here twice:
//   1. sport precedence — "Little League Diamond" is baseball, and a generic
//      /athletic|multi|turf/ rule must not claim it first.
//   2. add-on families — LIGHTS are the biggest add-on on fields and are billed
//      as a line item (the Musco lighting integration has 5 field rows
//      platform-wide, against thousands of light-fee add-ons), so a light fee
//      landing in "Other" would hide the tab's headline finding.
//
// Run: node scripts/fields-classify.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "facilities.html");
const src = fs.readFileSync(PAGE, "utf8");

const api = (function () {
  const a = src.indexOf("    const FIELD_SPORTS = [");
  const b = src.indexOf("    function FieldsBanner(");
  assert.ok(a > 0 && b > a, "could not slice the field classifiers");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + `
    this.fieldSport = fieldSport;
    this.fieldAddonGroup = fieldAddonGroup;
    this.FIELD_SPORTS = FIELD_SPORTS;
    this.FIELD_SPORT_LABEL = FIELD_SPORT_LABEL;
    this.FIELD_ADDON_GROUPS = FIELD_ADDON_GROUPS;
  `, ctx);
  return ctx;
})();
const { fieldSport, fieldAddonGroup, FIELD_SPORTS, FIELD_SPORT_LABEL, FIELD_ADDON_GROUPS } = api;

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── sport, from the field name ──────────────────────────────────────────────

test("the obvious names land where they should", () => {
  assert.strictEqual(fieldSport("Baseball Field 1", "Riverside Park"), "baseball");
  assert.strictEqual(fieldSport("Softball Diamond 3", "Riverside Park"), "baseball");
  assert.strictEqual(fieldSport("Diamond 2", "Riverside Park"), "baseball");
  assert.strictEqual(fieldSport("Soccer Field 4", "Riverside Park"), "soccer");
  assert.strictEqual(fieldSport("Football Field", "Riverside Park"), "football");
  assert.strictEqual(fieldSport("Lacrosse Field", "Riverside Park"), "lacrosse");
  assert.strictEqual(fieldSport("Multipurpose Field 1", "Riverside Park"), "multi");
  assert.strictEqual(fieldSport("Turf Field", "Riverside Park"), "multi");
});

test("a specific sport beats the generic multipurpose rule", () => {
  // This is the refineSiteType lesson: the catch-all must be LAST, or a named
  // diamond inside an "Athletic Complex" is filed as multipurpose turf.
  assert.strictEqual(fieldSport("Little League Diamond", "Athletic Complex"), "baseball");
  assert.strictEqual(fieldSport("Soccer Field 2", "Multi-Sport Athletic Park"), "soccer");
  assert.strictEqual(fieldSport("Practice Baseball Field", "Turf Complex"), "baseball");
  const multiIdx = FIELD_SPORTS.findIndex(s => s.key === "multi");
  assert.strictEqual(multiIdx, FIELD_SPORTS.length - 1,
    "the multipurpose rule must stay last in FIELD_SPORTS or it swallows named fields");
});

test("the PARK name is used when the field name says nothing", () => {
  // Measured platform-wide: adding the location moves ~4,800 bookings out of
  // unclassified, because a park called "Smith Soccer Complex" names the sport
  // its "Field 3" does not.
  assert.strictEqual(fieldSport("Field 3", "Smith Soccer Complex"), "soccer");
  assert.strictEqual(fieldSport("Field 1", "Northside Ballfields"), "baseball");
});

test("a field named for nothing is null, not a wrong guess", () => {
  assert.strictEqual(fieldSport("Upper Field", "Northside Park"), null);
  assert.strictEqual(fieldSport("Field 2", "Kiwanis Park"), null);
  assert.strictEqual(fieldSport("", ""), null);
  assert.strictEqual(fieldSport(null, null), null);
});

test("every sport key has a label, or the panel renders a raw key", () => {
  FIELD_SPORTS.forEach(sp => {
    assert.ok(FIELD_SPORT_LABEL[sp.key], "no label for " + sp.key);
  });
});

// ── add-on families ─────────────────────────────────────────────────────────

test("every real-world light fee lands in Lights", () => {
  // These four are the actual top add-ons on field bookings platform-wide.
  ["Field Light Fee", "Field Lights", "LAGSC Lights - Both Fields",
   "Rental-Athletic Field Light Fee"].forEach(n => {
    assert.strictEqual(fieldAddonGroup(n), "lights", n + " must be a light");
  });
});

test("crew and prep charges land in Staffing & prep", () => {
  ["Rental-Facility Attendant Fee", "Field Prep & Lining", "Game Cleaning Fee",
   "TUSD Restroom Supply Fee", "TUSD Park Services Fee"].forEach(n => {
    assert.strictEqual(fieldAddonGroup(n), "prep", n + " must be staffing/prep");
  });
});

test("anything else is Other rather than forced into a family", () => {
  assert.strictEqual(fieldAddonGroup("Alcohol Permit"), "other");
  assert.strictEqual(fieldAddonGroup("Extra materials"), "other");
  assert.strictEqual(fieldAddonGroup(""), "other");
  assert.strictEqual(fieldAddonGroup(null), "other");
});

test("Lights is checked before the catch-all, and Other is last", () => {
  assert.strictEqual(FIELD_ADDON_GROUPS[0].key, "lights",
    "lights are the biggest add-on on fields; they must not fall through to another family");
  assert.strictEqual(FIELD_ADDON_GROUPS[FIELD_ADDON_GROUPS.length - 1].key, "other");
  assert.strictEqual(FIELD_ADDON_GROUPS[FIELD_ADDON_GROUPS.length - 1].re, null,
    "the last family is the fallback and must match nothing on its own");
});

// ── the tab must be wired, and must not read the wrong feed ────────────────

test("the tab is wired end to end", () => {
  assert.ok(/function FieldsView/.test(src), "the view exists");
  assert.ok(/e\(FieldsView, \{ start, end \}\)/.test(src), "and is reachable from the tab dispatch");
  assert.ok(/'Site Type'\] === 'field'/.test(src), "scoped to field-typed sites");
  assert.ok(/event=fields/.test(src), "opening the tab pings the Slack activity feed");
  assert.ok(/game: 'bases'/.test(src), "the banner carries its minigame");
  assert.ok(/oeHeatGrid\(arrivals\)/.test(src), "day-part grid comes from the shared helper");
});

test("it reads the reservation feed, not the court-utilization one", () => {
  // Card 17297 filters c.type = 'court', so fields are absent from it entirely.
  // Pointing this tab at that feed would render an empty state forever.
  // The full marker, not a prefix: an earlier comment in this file also starts
  // "// ── Court Utilization", and slicing to that one produced an empty
  // segment and a passing-looking failure.
  const end = src.indexOf("    // ── Court Utilization — native view");
  const from = src.indexOf("function FieldsView");
  assert.ok(end > from && from > 0, "could not slice FieldsView");
  const upTo = src.slice(from, end);
  assert.ok(/facility\/api\/data/.test(upTo), "must fetch the per-day reservation feed (card 17294)");
  assert.ok(!/court-utilization\/api\/data/.test(upTo),
    "card 17297 excludes fields — that feed can never populate this tab");
});

console.log(`\n${passed}/${passed} passing`);
