#!/usr/bin/env node
/* ============================================================================
 * programs-location.spec.js — the top-level Location filter on the Programs
 * report, and the invariants that keep it from lying.
 *
 * The filter scopes the WHOLE report, so the failure mode it exists to prevent
 * is the facility Summary one: chips that scoped some panels and not others,
 * and a page that disagreed with itself for a week. The mechanical form of
 * that invariant is "every panel reads locRows, never rows".
 *
 * WHAT THIS PINS, and why each one is a bug that has actually shipped here:
 *
 *   1. `loc` is in getParams()'s whitelist. It is an explicit list; a parameter
 *      missing from it reads as undefined and its deep link silently does
 *      nothing, which is exactly how ?ci_rows= shipped broken.
 *   2. progEffectiveLoc takes a `loaded` argument. Resolving a URL parameter on
 *      mount — when the feed has not answered and there are therefore no
 *      options YET — is not the same fact as "this feed has no such location".
 *      Same bug, same shape, as ?ci_rows=failed.
 *   3. The presence gate reads the COLUMN, not a value. Card 17295 v6 adds
 *      `location`; a warm 4-hour v5 cache entry has no such key, and the
 *      control must be absent rather than offering one useless option.
 *   4. The URL write-back mutates only `loc`. Rebuilding the whole query string
 *      is how the Fast Track share-link effect destroyed ?tab= — and ?token=,
 *      ?section_id= and ?program= all ride on this URL too.
 *   5. Sections with no located session get their own option. Without it they
 *      vanish the moment anyone picks a location and nothing says they were
 *      dropped.
 *
 * It LIFTS AND RUNS progEffectiveLoc rather than regexing it — a regex passes
 * on an inverted comparison. (The nightStateFrom lesson.)
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "programs.html");
const src = fs.readFileSync(PAGE, "utf8");

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// ── lift and RUN the resolver ───────────────────────────────────────────────
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  let depth = 0, i = text.indexOf("{", start);
  const open = i;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return new Function(text.slice(start, i + 1) + "; return " + name + ";")();
}

const progEffectiveLoc = liftFn(src, "progEffectiveLoc");

// LOC_NONE is written as the ESCAPE "\u0000none", never as a raw NUL byte.
// A raw NUL makes git classify this file as BINARY, and a spec that cannot
// be read in a diff cannot be reviewed.
const OPTS = [
  { value: "Urho Saari Swim Stadium", label: "Urho Saari Swim Stadium", n: 58 },
  { value: "George E. Gordon Clubhouse", label: "George E. Gordon Clubhouse", n: 103 },
  { value: "\u0000none", label: "No location set", n: 77 },
];

// no selection is always no selection
eq(progEffectiveLoc("", OPTS, true), "", "empty selection stays empty");
eq(progEffectiveLoc("", [], false), "", "empty selection stays empty before the feed answers");

// a real location survives
eq(progEffectiveLoc("Urho Saari Swim Stadium", OPTS, true), "Urho Saari Swim Stadium",
   "a location the feed has is kept");
eq(progEffectiveLoc("\u0000none", OPTS, true), "\u0000none",
   "the no-location option is a real selection, not a stale one");

// a stale location is dropped rather than emptying the report
eq(progEffectiveLoc("Demolished Rec Center", OPTS, true), "",
   "a location the feed does not have falls back to All rather than emptying the report");

// THE LOAD GATE. Before the feed answers there are no options yet, and that is
// not the same fact as "this location does not exist".
eq(progEffectiveLoc("Urho Saari Swim Stadium", [], false), "Urho Saari Swim Stadium",
   "a ?loc= survives mount, when the feed has not answered and there are no options YET");
eq(progEffectiveLoc("Urho Saari Swim Stadium", [], true), "",
   "...but is dropped once the feed HAS answered and genuinely lacks it");

// ── source invariants ───────────────────────────────────────────────────────
ok(/return \{[^}]*\bloc:\s*p\.get\('loc'\)/.test(src),
   "getParams() whitelists `loc` (a parameter missing from it reads undefined and the deep link does nothing)");

// presence, not value
ok(/rows\.some\(r => 'location' in r\)/.test(src),
   "progHasLocation tests for the COLUMN ('location' in r), not a truthy value — a v5 cache entry has no such key");

// the funnel
// ONE FUNNEL FOR BOTH DIMENSIONS. `locRows` was renamed `scopedRows` when the
// season filter landed, deliberately rather than adding a second funnel beside
// it: two funnels is how the facility Summary scoped some panels and not others.
// programs-season.spec.js owns the season half; this asserts the location half
// still flows through the same one.
ok(/const scopedRows = useMemo\(/.test(src),
   "scopedRows exists as the single funnel");
ok(!/\blocRows\b/.test(src),
   "the old location-only funnel is gone — a panel still reading it would be season-unscoped");
ok(/const scoped = scopedRows \|\| \[\];/.test(src),
   "grouped() reads scopedRows, not rows — every revenue panel flows from it");
ok(/\}, \[scopedRows, search, activityFilter, activityInfo\]\);/.test(src),
   "grouped()'s deps name scopedRows, or it will not recompute when the location changes");

// the feeds that have no location of their own
ok(/scopedProgramSet\s*\?\s*demoRows\.filter\(r => scopedProgramSet\.has\(r\['Program'\]\)\)/.test(src),
   "the demographics feed is scoped by the funnel's program set");
ok(/scopedProgramSet\s*\?\s*retRows\.filter\(r => scopedProgramSet\.has\(r\['Program'\]\)\)/.test(src),
   "the retention feed is scoped by the funnel's program set");

// no panel below the funnel may read the raw feed
{
  // Start AFTER the funnel's own definition — locOptions and locRows are
  // allowed, and required, to read the raw feed; they are what builds it. The
  // invariant is about every panel DOWNSTREAM of them.
  const i = src.indexOf("// The demographics, retention and check-in tabs read their OWN feeds");
  const j = src.indexOf("const totals = useMemo");
  ok(i > 0 && j > i, "the derivation block boundaries are still findable");
  const block = src.slice(i, j);
  const bare = block.split("\n").filter(l =>
    /(?<![A-Za-z])rows\.(filter|map|forEach|reduce)\b/.test(l) &&
    !/scopedRows|demoRows|retRows|ciRows/.test(l));
  ok(bare.length === 0,
     "no panel downstream of the funnel reads `rows` directly: " + JSON.stringify(bare));
}

// the URL write-back must not rebuild the query string
ok(/u\.searchParams\.set\('loc', locFilter\)/.test(src) && /u\.searchParams\.delete\('loc'\)/.test(src),
   "the write-back mutates only the loc key");
ok(!/new URLSearchParams\(\)\s*;[\s\S]{0,400}replaceState/.test(src),
   "the write-back does not build a fresh query string from scratch (that is how ?tab= was destroyed)");
ok(/else u\.searchParams\.delete\('loc'\)/.test(src),
   "the default CLEARS the parameter rather than writing ?loc=");

// the no-location option
ok(/label: 'No location set'/.test(src),
   "sections with no located session get their own option instead of vanishing");

// the control is hidden when there is nothing to choose between
ok(/locOptions\.length > 1 && \(<React\.Fragment>/.test(src),
   "the control is ABSENT with fewer than two options — a filter over one location is a dead end");

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ programs-location.spec.js — " + failures.length + " failure(s):\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n" + pass + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
console.log("✓ programs-location.spec.js — " + pass + " assertions passed");
