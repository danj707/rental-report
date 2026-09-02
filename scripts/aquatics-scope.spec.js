#!/usr/bin/env node
/* ============================================================================
 * aquatics-scope.spec.js — which sites count as aquatics, per org.
 *
 * DAN'S RULE (2026-09-01): "pools can be courts, but courts can never be pools."
 *
 * WHY THIS REPLACES aquatics-lanes.spec.js. A site has to be typed `court` to be
 * instant-bookable, so an org that wants a self-bookable swim lane has no option
 * but to lie about the type — El Segundo types 67 of its lanes that way. The
 * page used to RECOVER those with a regex: bare "lane" in the site name, no
 * competing court word, and an aquatic-sounding location. It worked, and it was
 * a guess that had to be right about every org on the platform, and it quietly
 * encoded a product capability gap into reporting.
 *
 * It is configuration now. The Aquatics tab defaults to `pool` and nothing else;
 * an org that types its lanes `court` says so in its report settings. El Segundo
 * is configured in the same change, so nobody loses a number.
 *
 * WHAT THIS PINS:
 *
 *   1. THE GUESS CANNOT COME BACK. A court-typed "North Lane 1 - A" at "Urho
 *      Saari Swim Stadium" stays a court. This is the assertion that fails if
 *      someone reinstates the regex "to be helpful".
 *   2. The org's own words still count: a site literally named "Pool 1" typed
 *      court is a pool, and rink/gym recovery is untouched.
 *   3. ONE predicate scopes every aquatics surface. FIVE read it — the tab, its
 *      lane-hours panel, the tab badge, the Excel export and the scope note —
 *      and the hours panel used to hardcode 'pool', which would have had it
 *      reporting eleven hours beside a tab reporting thousands.
 *   4. Empty scope means EVERY location, never none. The safe direction: an org
 *      that renames a location gets its whole tab back rather than an empty one.
 *   5. The stored list is bounded on every axis it can grow along, because it is
 *      free text written to disk and read back into a page.
 *   6. The gear is on the EMPTY branch too. An org whose lanes are all typed
 *      `court` has no pool bookings at all until it is configured, so a control
 *      only on the populated branch is a dead end for the one org that needs it.
 *
 * It LIFTS AND RUNS refineSiteType and vertRowMatch rather than regexing them.
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE   = path.join(__dirname, "..", "public", "facilities.html");
const SERVER = path.join(__dirname, "..", "server.js");
const src    = fs.readFileSync(PAGE, "utf8");
const server = fs.readFileSync(SERVER, "utf8");
// Both files QUOTE the removed regex in their comments on purpose, so every
// source assertion runs over a comment-stripped copy or it fails on correct
// code. Fourth instance of this note in the repo.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const srv  = server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope");
  let p = text.indexOf("(", start), pd = 0, j = p;
  for (; j < text.length; j++) {
    if (text[j] === "(") pd++;
    else if (text[j] === ")") { pd--; if (pd === 0) break; }
  }
  let depth = 0, i = text.indexOf("{", j);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}

// ── 1 + 2. refineSiteType no longer guesses ────────────────────────────────
let refine = null;
try {
  refine = new Function(liftFn(src, "refineSiteType") + "\nreturn refineSiteType;")();
  pass++;
} catch (e) { failures.push("refineSiteType THREW when lifted: " + e.message); }

if (refine) {
  // Real El Segundo site and location names.
  eq(refine("court", "North Lane 1 - A", "El Segundo Wiseburn Aquatic Center"), "court",
     "THE LANE GUESS IS GONE: a court-typed lane at an aquatic centre stays a court until the org says otherwise");
  eq(refine("court", 'Inst Lane 4-2" Depth (25Y) - A', "Urho Saari Swim Stadium"), "court",
     "...however aquatic the location sounds");
  eq(refine("court", "Lane 3 - B", "Urho Saari Swim Stadium"), "court",
     "...and however lane-like the name");
  // The real counterexample the old guess needed two guards to survive.
  eq(refine("court", "Johnson Lane Tennis/Pickleball Court #1", "Johnson Lane Park"), "court",
     "Johnson Lane Park is a road name, and its courts are still courts");
  // The org's own word is not a guess about a location.
  eq(refine("court", "Pool 1", "Anywhere"), "pool",
     "a site an org literally named a pool is still recovered — that is the org's word, not our inference");
  eq(refine("court", "Aquatic Center Lap Area", "Anywhere"), "pool", "...and 'aquatic' likewise");
  eq(refine("court", "Ice Rink A", "Anywhere"), "rink", "rink recovery is untouched");
  eq(refine("court", "Gymnasium", "Anywhere"), "gym", "so is gym recovery");
  eq(refine("court", "Gym Court 1", "Anywhere"), "court",
     "...and a court inside a gym is still a court, because the org called it one");
  eq(refine("pool", "Anything", "Anywhere"), "pool", "a non-court type is returned untouched");
}
ok(!/LANE_RX|LANE_LOC_RX|LANE_NOT_RX/.test(code),
   "the lane regexes are gone and cannot be reached");

// ── 3 + 4. one predicate, and what it does ─────────────────────────────────
let VC = null, match = null;
try {
  const H = new Function(`
    const VERT_CONFIG = {
      aquatics: { label: 'Pool / Aquatics', types: ['pool'], scope: [] },
      fields:   { label: 'Fields',          types: ['field'], scope: [] },
    };
    function setup(extra, scope) {
      VERT_CONFIG.aquatics.types = ['pool'].concat(extra || []);
      VERT_CONFIG.aquatics.scope = scope || [];
      Object.keys(VERT_CONFIG).forEach(k => {
        const v = VERT_CONFIG[k];
        v.key = k;
        v._types = new Set(v.types);
        v._scope = (v.scope && v.scope.length) ? new Set(v.scope) : null;
      });
    }
    ${liftFn(src, "vertRowMatch")}
    return { setup, vertRowMatch };
  `)();
  VC = H.setup; match = H.vertRowMatch;
  pass++;
} catch (e) { failures.push("vertRowMatch THREW when lifted: " + e.message); }

if (match) {
  const pool  = { "Site Type": "pool",  Location: "Urho Saari Swim Stadium", Facility: "Main Pool" };
  const lane  = { "Site Type": "court", Location: "Urho Saari Swim Stadium", Facility: "Lane 3 - B" };
  const court = { "Site Type": "court", Location: "Recreation Park Courts",  Facility: "Tennis 1" };

  VC([], []);
  eq(match(pool, "aquatics"), true, "POOLS ALWAYS COUNT — that is the platform default and not a setting");
  eq(match(lane, "aquatics"), false,
     "an unconfigured org counts no courts, whatever they are called — this is the whole rule");
  eq(match(court, "aquatics"), false, "...including its real courts");

  VC(["court"], []);
  eq(match(lane, "aquatics"), true, "with `court` configured, the org's lanes count");
  eq(match(pool, "aquatics"), true, "...and its pools still do");
  eq(match(court, "aquatics"), true,
     "...but so do its TENNIS courts, which is exactly why the location scope exists");

  VC(["court"], ["Urho Saari Swim Stadium"]);
  eq(match(lane, "aquatics"), true, "scoped to the swim stadium, the lanes count");
  eq(match(court, "aquatics"), false, "...and Recreation Park's tennis courts drop out");
  eq(match(pool, "aquatics"), true, "...while the pool at that location stays");

  VC(["court"], ["Lane 3 - B"]);
  eq(match(lane, "aquatics"), true,
     "the scope matches a SITE name too — Dan asked to be able to name either");

  VC(["court"], ["A Location That Was Renamed"]);
  eq(match(lane, "aquatics"), false, "a scope that matches nothing does narrow to nothing...");
  VC(["court"], []);
  eq(match(lane, "aquatics"), true, "...but EMPTY MEANS EVERY LOCATION, never none");

  eq(match({ "Site Type": "field", Location: "x", Facility: "y" }, "fields"), true,
     "other verticals are unaffected");
  eq(match(pool, "nosuchtab"), false, "an unknown vertical matches nothing rather than throwing");
}

// ── the readers ────────────────────────────────────────────────────────────
eq((code.match(/vertRowMatch\(/g) || []).length - 1, 5,
   "FIVE surfaces scope through the one predicate: the tab, the hours panel, the badge, the export, the note");
ok(!/\['Site Type'\] === 'pool'/.test(code),
   "the lane-hours panel no longer hardcodes 'pool' — it used to, and it is the panel that carries the whole feature");
ok(!/new Set\(vert\.types\)/.test(code) && !/new Set\(VERT_CONFIG\[[a-z]+\]\.types\)/.test(code),
   "no surface builds its own type set — that is how the facility Summary disagreed with itself for a week");
ok(/data-aq-scope/.test(code) && /function vertScopeNote\(/.test(code),
   "EXCLUDED IS NEVER HIDDEN: the tab states what it is scoped to, on screen");

// ── 6. the gear is reachable whatever the tab shows ────────────────────────
// The property has not changed — an org whose lanes are all typed `court` has no
// pool bookings until it is configured, so the control must not live inside a
// branch that only renders when there is data. What changed is HOW: it was
// mounted twice inside the view (populated branch and empty branch) and it is in
// the TOOLBAR now, which renders whatever the tab shows.
//
// Dan asked for that placement — "the upper right corner of the top bar, same as
// on every main page of every report" — after the first version put it in a
// footnote at the bottom of the tab and he reported the whole feature missing
// from the live page while it was rendering perfectly, below the fold.
{
  const tb = code.indexOf("className: 'toolbar'");
  const gear = code.indexOf("e(AquaticsSettings,");
  ok(tb > 0 && gear > tb && gear - tb < 3000,
     "THE GEAR IS IN THE TOOLBAR — so it is reachable for an org with no pool bookings, which is the one org that needs it");
  eq((code.match(/e\(AquaticsSettings,/g) || []).length, 1,
     "...mounted ONCE, not once per branch of the view");
  const i = code.indexOf("className: 'btn-excel'");
  ok(i > 0 && code.indexOf("e(AquaticsSettings,") > i,
     "...and LAST in the toolbar, after the exports, like every other report's gear");
  ok(/'\\u2699 Which sites count'/.test(code) || /Which sites count/.test(code),
     "...and LABELLED: a bare glyph in a dark toolbar is what made it invisible");
}
ok(/data-aqrs-open/.test(code) && /data-aqrs-locked/.test(code) && /data-aqrs-flagoff/.test(code),
   "three gear states, as on the Class Roster: working, locked, and switched off");
ok(/settings-unlock/.test(code),
   "the locked gear unlocks IN PLACE — sending an admin to another report to sign in is a dead end");

// ── 5. the server schema ───────────────────────────────────────────────────
let R = null;
try {
  const from = server.indexOf("const AQUATICS_EXTRA_TYPES");
  const to   = server.indexOf("function epactIsVerified");
  // The roster half of the schema references constants declared further up
  // server.js; this spec is about the facility half, so they are stubbed rather
  // than the whole file being dragged in.
  R = new Function("path", "DATA_DIR", "readJSON", "writeJSON",
    "const ROSTER_COL_DEFAULTS = {}, ROSTER_HIDEABLE = [], EPACT_FIELD_CATALOGUE = [['a']],"
    + " EPACT_VERIFIED_COLUMNS = ['a'], REPORT_TTL_FLOOR_MIN = 30, REPORT_TTL_CEILING_MIN = 1440;\n"
    + server.slice(from, to)
    + "\nreturn { AQUATICS_EXTRA_TYPES, REPORT_SETTINGS_SCHEMA, reportSettingsDefaults, normalizeReportSettings };")(
      { join: (...a) => a.join("/") }, "/tmp", () => ({}), () => {});
  pass++;
} catch (e) { failures.push("the settings registry THREW when lifted: " + e.message); }

if (R) {
  const d = R.reportSettingsDefaults("facility");
  eq(JSON.stringify(d.aquaticsExtraTypes), "[]",
     "THE DEFAULT IS POOLS ONLY — an unconfigured org sees exactly what it saw before any of this existed");
  eq(JSON.stringify(d.aquaticsScope), "[]", "...and every location");
  ok(!R.AQUATICS_EXTRA_TYPES.includes("pool"),
     "`pool` is not offered as an extra type: it is always included and is not a choice");

  const n = (body) => R.normalizeReportSettings("facility", body);
  eq(JSON.stringify(n({ aquaticsExtraTypes: ["court"] }).settings.aquaticsExtraTypes), '["court"]',
     "a real site type is accepted");
  ok(n({ aquaticsExtraTypes: ["pool"] }).dropped.length === 1,
     "...and `pool` is refused, because it is not an extra");
  ok(n({ aquaticsExtraTypes: ["nonsense"] }).dropped.length === 1, "...as is a type that does not exist");

  const s1 = n({ aquaticsScope: ["  Urho Saari  ", "Urho Saari", "", "   "] }).settings.aquaticsScope;
  eq(JSON.stringify(s1), '["Urho Saari"]',
     "the scope is trimmed and de-duplicated, and BLANKS ARE DROPPED — an empty entry can never match a location and would sit in the panel looking like a bug");
  const long = "x".repeat(500);
  eq(n({ aquaticsScope: [long] }).settings.aquaticsScope.length, 0,
     "an over-long entry is refused: this is free text written to disk and read back into a page");
  eq(n({ aquaticsScope: Array.from({ length: 400 }, (_, i) => "L" + i) }).settings.aquaticsScope.length, 200,
     "...and the list is bounded in count as well as in item length");
  ok(n({ aquaticsScope: "not-a-list" }).dropped.length === 1, "a non-list is refused rather than coerced");
}
ok(/AQUATICS_EXTRA_TYPES/.test(srv) && /aquaticsScope:\s*\{ kind: "strings"/.test(srv),
   "the schema registers both controls");
ok(/settings: reportSettings\(slug, "facility"\)/.test(srv),
   "the hub INJECTS the settings rather than fetching them — they decide which site types the tab counts at all");

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ aquatics-scope.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("✓ aquatics-scope.spec.js — " + pass + " assertions passed.");
