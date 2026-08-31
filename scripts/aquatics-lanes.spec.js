#!/usr/bin/env node
/* ============================================================================
 * aquatics-lanes.spec.js — the lane branch in refineSiteType()
 *
 * WHY THIS EXISTS. El Segundo types its 70 swim lanes `court` so they surface
 * in the consumer app's instant-book "Pools, Rinks & Courts" section — the same
 * reason refineSiteType() exists at all for rinks and gyms. But their lanes are
 * named "North Lane 1 - A" / "Lane 3 - B" / "Inst Lane 4-2\" Depth (25Y) - A",
 * which carry no pool/swim/aquatic word, so the name rule missed all of them and
 * the Aquatics vertical showed 24 sites while 70 carried the traffic —
 * 29,981 lane hours all-time, 7,252 in the last 30 days.
 *
 * THE BRANCH IS A DELIBERATE, NARROW EXCEPTION to that function's own
 * never-consult-the-location rule. That rule protects a TENNIS COURT sitting at
 * "Aquatic Park" from being miscast. A site named "Lane 3 - B" is not a tennis
 * court: the name is genuinely ambiguous and carries no sport, so the location
 * is the only thing that can resolve it. Two independent guards keep the
 * original intent — a competing court word in the NAME rejects the site, and so
 * does a non-aquatic LOCATION.
 *
 * The counterexample that makes both guards necessary is real, not invented:
 * Douglas County's Johnson Lane Park has "Johnson Lane Tennis/Pickleball Court
 * #1/#2" and "Johnson Lane 2-Half Court Basketball Court" — "Lane" as a ROAD
 * name. That is the /ball ?field/ -> "Football Field" bug one field over.
 *
 * THIS SPEC LIFTS AND RUNS the real function out of public/facilities.html
 * rather than regexing over it. A regex passes on an inverted comparison; only
 * running the thing proves what it classifies. (The nightStateFrom lesson.)
 *
 * Measured platform-wide 2026-08-31, before the branch shipped:
 *   487 sites match \blane\b — 373 already typed `pool`, 94 typed `court`
 *   305 already recovered by the existing name rule
 *    74 court-typed lanes the name rule misses
 *    68 of those sit at a location named pool/aquatic/swim/plunge
 *     6 do not: 3 El Segundo archived sites, 3 Johnson Lane Park courts
 *   Blast radius: El Segundo +66, Northern Door +2, every other org unchanged.
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "facilities.html");
const src = fs.readFileSync(PAGE, "utf8");

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { failures.push(msg); }
}
function eq(got, want, msg) {
  ok(got === want, msg + " — got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}

// ── lift the classifier and RUN it ──────────────────────────────────────────
// Slice from the lane regexes through the end of refineSiteType. The page
// builds a whole React app at module scope, so the file cannot be evaluated
// wholesale; this takes the one self-contained block.
function liftRefineSiteType(text) {
  const start = text.indexOf("const LANE_RX");
  if (start < 0) throw new Error("LANE_RX not found — did the lane branch get removed?");
  const tail = text.indexOf("return 'court';", start);
  if (tail < 0) throw new Error("refineSiteType's court fallthrough not found");
  const end = text.indexOf("}", tail);
  const block = text.slice(start, end + 1);
  return new Function(block + "; return refineSiteType;")();
}

const refineSiteType = liftRefineSiteType(src);

// ── the cases, all real site + location names from prod ─────────────────────
// Each is (rawType, siteName, locationName) -> expected type.
const CASES = [
  // El Segundo's lanes — the whole point of the branch.
  ["court", "North Lane 1 - A",                   "El Segundo Wiseburn Aquatic Center", "pool"],
  ["court", "North Lane 7 - B",                   "El Segundo Wiseburn Aquatic Center", "pool"],
  ["court", "Lane 3 - B",                         "Urho Saari Swim Stadium",            "pool"],
  ["court", "Inst Lane 4-2\" Depth (25Y) - A",    "El Segundo Wiseburn Aquatic Center", "pool"],
  // Already recovered by the NAME rule — must keep working, and must not
  // depend on the location to do it.
  ["court", "Competition Pool Lane 2",            "Somewhere Unnamed",                  "pool"],
  ["court", "Swim Lane 4",                        "",                                   "pool"],

  // ── the counterexamples ───────────────────────────────────────────────────
  // Johnson Lane Park: "Lane" as a road name. Rejected by BOTH guards.
  ["court", "Johnson Lane Tennis/Pickleball Court #2",   "Johnson Lane Park", "court"],
  ["court", "Johnson Lane Tennis/Pickleball Court #1",   "Johnson Lane Park", "court"],
  ["court", "Johnson Lane 2-Half Court Basketball Court", "Johnson Lane Park", "court"],
  // A competing court word beats an aquatic location on its own.
  ["court", "Johnson Lane Tennis Court", "Community Pool Complex", "court"],
  ["court", "Bowling Lane 3",            "Community Pool Complex", "court"],
  ["court", "Volleyball Lane 2",         "Aquatic Center",         "court"],
  // A non-aquatic location beats a bare lane name on its own.
  ["court", "Lane 2 - B", "ZZ Archived Sites [do not use]", "court"],
  ["court", "Lane 5",     "Memorial Park",                  "court"],

  // ── untouched behaviour ───────────────────────────────────────────────────
  ["court", "Tennis Court 1",  "Recreation Park Courts",             "court"],
  ["court", "Sheet A",         "Ice Arena",                          "court"],
  ["court", "Ice Rink 1",      "Anywhere",                           "rink"],
  ["pool",  "Big Pool",        "El Segundo Wiseburn Aquatic Center", "pool"],
  ["field", "Bakalyar Field",  "Campus El Segundo Athletic Fields",  "field"],
  ["room",  "Craft Room",      "Joslyn Center",                      "room"],
  // A type Rec already stated specifically is never reconsidered, even when
  // the name would otherwise match a branch.
  ["field", "Lane Field",      "Wiseburn Aquatic Center",            "field"],
];

for (const [raw, site, loc, want] of CASES) {
  eq(refineSiteType(raw, site, loc), want, "refineSiteType(" + raw + ", " + JSON.stringify(site) + " @ " + JSON.stringify(loc) + ")");
}

// A missing location must not throw and must not promote a bare lane. The
// facility feed can carry a null Location, and a classifier that throws there
// takes the whole Facilities hub down (the blank-page class).
eq(refineSiteType("court", "Lane 3 - B", null),      "court", "null location does not promote a bare lane");
eq(refineSiteType("court", "Lane 3 - B", undefined), "court", "undefined location does not promote a bare lane");
eq(refineSiteType("court", null, null),              "court", "null site name is survivable");
eq(refineSiteType("court", "Pool Lane 1", null),     "pool",  "the NAME rule still fires with no location");

// ── the call site must pass the location through ────────────────────────────
// The branch is dead code if refineRows() keeps calling with two arguments,
// and nothing else in the file would fail.
ok(/refineSiteType\(\s*r\['Site Type'\]\s*,\s*r\['Facility'\]\s*,\s*r\['Location'\]\s*\)/.test(src),
   "refineRows() passes Location through to refineSiteType (otherwise the branch is unreachable)");

// The Aquatics vertical must keep reading `pool` — the branch works by
// reclassifying INTO that type, so a vertical that grew its own lane handling
// would double-count or diverge.
ok(/aquatics:\s*\{[^}]*types:\s*\['pool'\]/.test(src),
   "the aquatics vertical still scopes to ['pool'] and lets refineSiteType do the recovery");

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ aquatics-lanes.spec.js — " + failures.length + " failure(s):\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n" + pass + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
console.log("✓ aquatics-lanes.spec.js — " + pass + " assertions passed");
