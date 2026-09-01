#!/usr/bin/env node
/* ============================================================================
 * programs-season.spec.js — the multi-select Season filter on the Programs
 * report, and the invariants that keep it from lying.
 *
 * WHY IT EXISTS. Dan, on Shrewsbury: "lets add a program 'season' filter on the
 * programs summary page, otherwise it's super confusing to try and contain all
 * dates of a section." Sections span months; the date range is a blunt way to
 * ask "how did Fall go". A season is the unit admins actually think in.
 *
 * THE MEASUREMENT THAT SHAPED THIS, and it killed the obvious implementation.
 * `season` carries its own start_date/end_date, so the tempting build is "tick a
 * season, jump the date range to its span". Measured at Shrewsbury:
 *
 *   season           declared span            its sections' ACTUAL dates
 *   Spring/Summer 26 2026-04-12 → 2026-09-05  2026-03-04 → 2026-11-15
 *   Fall '26         2026-10-03 → 2026-11-13  2026-08-31 → 2027-02-06
 *   Winter 26        2025-12-31 → 2026-04-10  2025-10-05 → 2026-06-10
 *
 * A season's declared span DOES NOT CONTAIN ITS OWN SECTIONS — those dates are
 * the registration window, not the programming period. Jumping the date range
 * to them would clip exactly the sections the filter exists to contain. So the
 * filter narrows what is already in view and never touches the dates, and the
 * options are built from the ROWS — which means a season with nothing in the
 * window cannot be ticked at all, so the control can never render an empty
 * result. (Platform-wide, 141 of 559 seasons have no start and 190 no end, so
 * the span is not even reliably there to misuse.)
 *
 * WHAT THIS PINS:
 *
 *   1. ONE FUNNEL, BOTH DIMENSIONS. `scopedRows` applies location AND season;
 *      there is deliberately no `locRows` any more. Two funnels is how the
 *      facility Summary shipped chips that scoped some panels and not others.
 *   2. scopedProgramSet fires on EITHER dimension. Gating it on locFilter alone
 *      leaves the demographics and retention tabs season-unscoped while every
 *      panel beside them moves — the same bug, one field over.
 *   3. progEffectiveSeasons KEEPS the known ticks and drops only the unknown
 *      ones. Falling back to "all" because one season retired silently widens a
 *      deliberate request back to everything.
 *   4. It takes `loaded`. A feed that has not answered is not a feed without
 *      that season — the ?ci_rows=failed bug, third instance.
 *   5. `season` is read with getAll, not split(','). Season names are written by
 *      humans ("Spring/Summer 26", "Fall '26") and nothing stops one containing
 *      a comma.
 *   6. seasonKey is the ONE definition of a row's season, read by the options
 *      builder, the funnel and the checkbox list. Three copies is how a checkbox
 *      lights up and filters nothing.
 *
 * It LIFTS AND RUNS the real helpers rather than regexing them — a regex passes
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
const deq = (g, w, m) => ok(JSON.stringify(g) === JSON.stringify(w),
  m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// ── lift and RUN the real helpers ───────────────────────────────────────────
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  let depth = 0, i = text.indexOf("{", start);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}

const i = src.indexOf("const SEASON_NONE");
const j = src.indexOf("function getParams");
ok(i > 0 && j > i, "the season helper block is still findable at module scope");
const { seasonKey, progEffectiveSeasons, SEASON_NONE } =
  new Function(src.slice(i, j) + "; return { seasonKey, progEffectiveSeasons, SEASON_NONE };")();

// ── seasonKey: one definition, and the two ways of having no season agree ───
eq(seasonKey({ season: "Fall '26" }), "Fall '26", "a real season passes through");
eq(seasonKey({ season: "No Season" }), "No Season", "the card's own COALESCE value is already the key");
eq(seasonKey({ season: "" }), SEASON_NONE,
   "an EMPTY season is the same fact as 'No Season' — a pre-v6 feed and the alias both produce it");
eq(seasonKey({ season: null }), SEASON_NONE, "null is the same fact too");
eq(seasonKey({}), SEASON_NONE, "a row with no season key at all does not become 'undefined'");
eq(seasonKey({ season: 2026 }), "2026", "a non-string season is stringified rather than compared by type");

const OPTS = [
  { value: "Spring/Summer 26", label: "Spring/Summer 26", n: 375 },
  { value: "Fall '26",         label: "Fall '26",         n: 192 },
  { value: "Winter 26",        label: "Winter 26",        n: 134 },
  { value: "No Season",        label: "No Season",        n: 7 },
];

// ── progEffectiveSeasons ────────────────────────────────────────────────────
deq(progEffectiveSeasons([], OPTS, true), [], "no ticks stays no ticks (which MEANS all)");
deq(progEffectiveSeasons(["Fall '26"], OPTS, true), ["Fall '26"], "a season the feed has is kept");
deq(progEffectiveSeasons(["Fall '26", "Winter 26"], OPTS, true), ["Fall '26", "Winter 26"],
    "two ticks both survive");
deq(progEffectiveSeasons(["No Season"], OPTS, true), ["No Season"],
    "No Season is a real selection, not a stale one");

// THE PARTIAL CASE — the one that separates this from progEffectiveLoc.
deq(progEffectiveSeasons(["Fall '26", "Summer 2019"], OPTS, true), ["Fall '26"],
    "an unknown season is DROPPED and the known ones KEPT — it must not widen the report back to all");
deq(progEffectiveSeasons(["Summer 2019"], OPTS, true), [],
    "...but when nothing survives it falls back to all, because an empty tick list and 'all' render the same");

// THE LOAD GATE, third instance of this bug in this repo.
deq(progEffectiveSeasons(["Fall '26"], [], false), ["Fall '26"],
    "a ?season= survives mount, when the feed has not answered and there are no options YET");
deq(progEffectiveSeasons(["Fall '26"], [], true), [],
    "...but is dropped once the feed HAS answered and genuinely lacks it");

// Junk in the URL must not become a tick.
deq(progEffectiveSeasons(["", null, undefined], OPTS, true), [],
    "empty and null values from the URL are not ticks");
deq(progEffectiveSeasons("Fall '26", OPTS, true), [],
    "a bare string is not an array and must not be treated as one character per tick");
deq(progEffectiveSeasons(undefined, OPTS, true), [], "undefined is survivable");

// The date range is deliberately NOT touched — see the header.
ok(!/setStartDate\([^)]*season/i.test(src) && !/season[^\n]*setStartDate/i.test(src),
   "ticking a season does not move the date range: a season's declared span does not contain its own sections");

// rollupToPrograms is lifted and RUN too — a stub would prove the funnel calls
// something, not that the numbers it produces are the surviving sections'.
// It reads fmtNum and progMode, so those come along in the same scope.
function liftRollup() {
  return new Function(
    liftFn(src, "fmtNum") + "\n" + liftFn(src, "progMode") + "\n" +
    liftFn(src, "rollupToPrograms") + "; return rollupToPrograms;")();
}

// ── the funnel actually filters, run over the real reducer ──────────────────
// Sliced and run rather than asserted in source: an inverted `want.has` passes
// every regex in this file.
//
// THE DEPS LINE IS MATCHED BY PATTERN, NOT BY LITERAL. Pinning the literal
// "}, [rows, locFilter, seasonSel]);" broke the moment the funnel gained a
// dependency, and the slice then ran on into the next memo — the same gotcha
// already recorded for memberships-revenue.spec.js's block().
{
  const k = src.indexOf("const scopedRows = useMemo(");
  const tail = src.slice(k);
  const m = /\n  \}, \[[^\]]*\]\);/.exec(tail);
  ok(k > 0 && m, "the scopedRows reducer is still findable");
  const body = tail.slice(tail.indexOf("{", tail.indexOf("useMemo(")) + 1, m.index);
  // RUN IT BEHIND A GUARD. This spec records failures and reports at the end,
  // so an exception thrown by the sliced code kills the process before a single
  // recorded failure is printed — a mutation that makes the funnel throw (say,
  // one that calls setStartDate inside it) would surface as a bare stack trace
  // naming nothing. A throw is a failure and must say so like any other.
  // instrSel/instructorKey arrive with the third dimension (2026-09-01). This
  // spec RUNS the real funnel, so every argument the funnel reads has to be
  // supplied or the slice throws — which is the honest signal that a dimension
  // was added, and is why the throw is caught and recorded below rather than
  // being allowed to kill the process.
  const raw = new Function("rows", "progSections", "sectionGrain", "locFilter",
                           "seasonSel", "instrSel", "LOC_NONE", "seasonKey",
                           "instructorKey", "rollupToPrograms", body);
  const SECS = [
    { programName: "Pickleball", season: "Fall '26",         location: "Oak Middle" },
    { programName: "Yoga",       season: "Fall '26",         location: "Senior Center" },
    { programName: "Swim",       season: "Spring/Summer 26", location: "Oak Middle" },
    { programName: "Camp",       season: "",                 location: null },
  ];
  // sectionGrain false, so the survivors come back as themselves and this half
  // is purely about which rows the two filters keep.
  const instructorKey = r => (r && r.instructor) || "\u0000noinstructor";
  const run = (locFilter, seasonSel, rows, instrSel) => {
    try {
      return raw(rows || SECS, SECS, false, locFilter, seasonSel, instrSel || [],
                 "\u0000none", seasonKey, instructorKey, x => x);
    } catch (e) { failures.push("the scopedRows funnel THREW: " + e.message); return []; }
  };
  const names = rs => (rs || []).map(r => r.programName).sort();
  deq(names(run("", [])), ["Camp", "Pickleball", "Swim", "Yoga"],
      "no filters returns every row");
  deq(names(run("", ["Fall '26"])), ["Pickleball", "Yoga"],
      "one ticked season narrows to it");
  deq(names(run("", ["Fall '26", "Spring/Summer 26"])),
      ["Pickleball", "Swim", "Yoga"], "two ticked seasons are a UNION, not an intersection");
  deq(names(run("", ["No Season"])), ["Camp"],
      "ticking No Season finds the row whose season is empty — via seasonKey, not a literal compare");
  // BOTH dimensions, composed. This is the assertion that fails if someone
  // splits the funnel back in two.
  deq(names(run("Oak Middle", ["Fall '26"])), ["Pickleball"],
      "location AND season compose in one funnel — Swim is at Oak Middle but the wrong season");
  deq(names(run("Senior Center", ["Spring/Summer 26"])), [],
      "a combination with nothing in it returns empty rather than falling back to either half");
  deq(names(run("\u0000none", [])), ["Camp"],
      "the no-location option finds the row with no location, rather than being read as a name");

  // ── IT FILTERS SECTIONS AND RE-ROLLS UP ───────────────────────────────────
  // Measured on prod: 659 of 5,699 programs with a located section (11.6%) run
  // at more than one location — against 0.7% of SECTIONS. So a funnel that
  // drops whole programs keeps money and enrolments from a site the reader just
  // excluded, for one program in nine. Here "Aquatics" runs at two sites with
  // $2,400 at one and $800 at the other: the correct answer is $2,400.
  const SPANNING = [
    { programName: "Aquatics", programId: "p-aq", season: "Fall '26", location: "Urho Saari",
      autopayPlanValue: 2400, autopayPlanItems: 1, manualPlanValue: 0, manualPlanItems: 0 },
    { programName: "Aquatics", programId: "p-aq", season: "Fall '26", location: "Gordon Clubhouse",
      autopayPlanValue: 0, autopayPlanItems: 0, manualPlanValue: 800, manualPlanItems: 8 },
  ];
  const rollup = liftRollup();
  let out;
  try {
    out = raw([{ programName: "Aquatics", programId: "p-aq", _sections: SPANNING }],
              SPANNING, true, "Urho Saari", [], [], "\u0000none", seasonKey,
              r => (r && r.instructor) || "\u0000noinstructor", rollup);
  } catch (e) { failures.push("the re-rollup THREW: " + e.message); out = []; }
  // EVERY read is defensive, for the reason this file already records: a
  // mutation that drops the re-rollup hands back bare SECTION rows, and
  // `out[0]._sections.length` on one of those THREW — killing the process
  // before a single named failure printed. A guard that dies has not told
  // anyone what broke.
  const one = Array.isArray(out) && out.length === 1 ? out[0] : {};
  ok(Array.isArray(out) && out.length === 1,
     "a program with one surviving section is still ONE program row");
  eq(one.autopayPlanValue, 2400,
     "the re-rolled program carries only the surviving section's auto-pay value");
  eq(one.manualPlanValue, 0,
     "...and NONE of the excluded site's manual plan value — the 11.6% bug");
  eq(Array.isArray(one._sections) ? one._sections.length : null, 1,
     "...and its _sections holds only what is in view, so the section table agrees with the totals");

  // With no filter at all the funnel must hand back the ROLLUPS untouched
  // rather than re-rolling them: rows are already program-grain there, and
  // flattening/re-rolling on every render for nothing is wasted work.
  let none;
  try {
    none = raw(["ROLLUPS"], SPANNING, true, "", [], [], "\u0000none", seasonKey,
               r => (r && r.instructor) || "\u0000noinstructor", rollup);
  } catch (e) { failures.push("the unfiltered path THREW: " + e.message); none = null; }
  eq(Array.isArray(none) ? none[0] : null, "ROLLUPS",
     "with nothing ticked the funnel returns `rows` as-is");
}

// ── source invariants ───────────────────────────────────────────────────────
ok(/seasons:\s*p\.getAll\('season'\)/.test(src),
   "getParams reads `season` with getAll — a split(',') would cut 'Spring/Summer, 26' in half");
ok(!/\.split\(','\)[^\n]*season/i.test(src) && !/season[^\n]*\.split\(','\)/i.test(src),
   "nothing splits the season parameter on a comma");

// ONE FUNNEL. The old name must be gone, or a panel still reading it is
// silently season-unscoped.
ok(!/\blocRows\b/.test(src),
   "there is no `locRows` any more — one funnel applies both dimensions");
ok(/const scopedRows = useMemo\(/.test(src), "scopedRows is the single funnel");
ok(/const scoped = scopedRows \|\| \[\];/.test(src),
   "grouped() reads scopedRows — every revenue panel flows from the composed funnel");

// The program-set gate must respond to EITHER dimension.
ok(/if \(\(!locFilter && !seasonSel\.length && !instrSel\.length\) \|\| !scopedRows\) return null;/.test(src),
   "scopedProgramSet fires on ANY dimension (locFilter alone leaves the demo/retention tabs season-unscoped; instructor joined them 2026-09-01)");
ok(/\}, \[locFilter, seasonSel, instrSel, scopedRows\]\);/.test(src),
   "...and seasonSel and instrSel are in its deps, or it will not recompute when either is ticked");

// No panel below the funnel may read the raw feed.
{
  const a = src.indexOf("// The demographics, retention and check-in tabs read their OWN feeds");
  const b = src.indexOf("const totals = useMemo");
  ok(a > 0 && b > a, "the derivation block boundaries are still findable");
  const block = src.slice(a, b);
  const bare = block.split("\n").filter(l =>
    /(?<![A-Za-z])rows\.(filter|map|forEach|reduce)\b/.test(l) &&
    !/scopedRows|demoRows|retRows|ciRows/.test(l));
  ok(bare.length === 0, "no panel downstream of the funnel reads `rows` directly: " + JSON.stringify(bare));
}

// The URL write-back: mutate one key, and delete before appending or a repeated
// parameter stacks a second copy on every keystroke.
ok(/u\.searchParams\.delete\('season'\);[\s\S]{0,120}seasonSel\.forEach\(v => u\.searchParams\.append\('season', v\)\)/.test(src),
   "the write-back deletes `season` then appends each value (append alone stacks duplicates)");
ok(!/new URLSearchParams\(\)\s*;[\s\S]{0,400}replaceState/.test(src),
   "the write-back does not rebuild the query string from scratch (that is how ?tab= was destroyed)");

// The control is hidden when there is nothing to choose between — an org with
// no seasons yields exactly one option ('No Season').
ok(/seasonOptions\.length > 1 && \(<React\.Fragment>/.test(src),
   "the control is ABSENT with fewer than two options — a filter over one season is a dead end");

// It is CHECKBOXES, per Dan: "make the season filter a checkbox,
// multiselectable. I hate single item selections in pull down menus".
// The markup moved into the shared MultiPicker on 2026-09-01 (Seasons and
// Instructor are the same control), so the attribute is built from the slug.
// Asserted by INTENT rather than by its old spelling: one tickable option per
// season, carrying that season's own value, rendered as a real checkbox.
ok(/\['data-prog-' \+ slug \+ '-opt'\]: o\.value/.test(src),
   "each season is its own tickable option, keyed by its own value");
ok(/<MultiPicker[\s\S]{0,400}slug="season"/.test(src),
   "...and the season control is that picker, so the handle really is data-prog-season-opt");
ok(/type="checkbox" checked=\{on\}/.test(src),
   "...and it is a CHECKBOX — Dan: \"I hate single item selections in pull down menus\"");
ok(/<input type="checkbox" checked=\{on\}/.test(src),
   "the options are real checkboxes, not a <select> (a select cannot multi-select)");
ok(!/<select[^>]*data-prog-season/.test(src), "the season control is not a <select>");

// The menu closes on an outside click, and the listener is not permanent.
ok(/if \(!seasonOpen\) return;[\s\S]{0,400}addEventListener\('mousedown'/.test(src),
   "the outside-click listener is added only while the menu is open");
ok(/removeEventListener\('mousedown'/.test(src), "...and removed again");

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ programs-season.spec.js — " + failures.length + " failure(s):\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n" + pass + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
console.log("✓ programs-season.spec.js — " + pass + " assertions passed");
