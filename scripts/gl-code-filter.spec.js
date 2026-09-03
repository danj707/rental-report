#!/usr/bin/env node
/* ============================================================================
 * gl-code-filter.spec.js — the GL report's multi-select GL code filter.
 *
 * Dan: "everything starts as selected/checked, there's an unselect all, select
 * all, and individual checkboxes."
 *
 * THE OPTIONS COME FROM THE ROWS, NOT THE CHART OF ACCOUNTS, and that was
 * measured rather than assumed: at apex the chart holds 974 accounts (888
 * unarchived) while only 220 codes carry any activity in twelve months. Sourcing
 * from the chart opens a menu of 900+ rows most of which can never match a
 * receipt in view.
 *
 * WHAT THIS PINS:
 *
 *   1. AN UNMAPPED RECEIPT IS ITS OWN OPTION, never a dropped row. A GL-less
 *      line is money; filtering it away silently is how a total stops
 *      reconciling against the ledger it came from.
 *   2. Everything starts checked, and "None" STICKS — the reconcile may only run
 *      when the DATA changes, or an empty selection is widened straight back to
 *      all and the button looks broken.
 *   3. The codes are ordered numerically. A GL chart sorted as strings puts 100
 *      before 9 and is unusable for finding a code.
 *   4. ONE menu component serves both the desk and the GL pickers. Two copies
 *      drift the first time the chrome changes — the facility Summary shipped
 *      chips that scoped some panels and not others for a week.
 *   5. The selection is applied in the ONE funnel every panel reads, and is
 *      reconstructed for print/PDF from the URL — an export that quietly carries
 *      codes the reader filtered out is worse than one that fails.
 *   6. `gl_codes` is in getParams()'s explicit whitelist. Leaving it out makes
 *      the deep link read `undefined` and do nothing, invisibly in source
 *      review — the `?ci_rows=` bug, now for the fourth time in this repo.
 *
 * It LIFTS AND RUNS glOptionKey, the comparator and reconcileFilterSelection
 * rather than regexing them. (The nightStateFrom lesson.)
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "gl.html");
const src = fs.readFileSync(PAGE, "utf8");
// Comments quote the shapes being warned against, so source assertions run over
// a stripped copy or they pass on correct code.
const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));
const same = (g, w, m) => eq(JSON.stringify(g), JSON.stringify(w), m);

// The body starts after the parameter list's closing paren, NOT at the first
// brace: reconcileFilterSelection destructures its argument, so a naive scan
// stops at the parameter object and lifts half a function.
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
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

// The comparator lives inside a useMemo, so it is lifted by its arr.sort call
// rather than by name — and the slice runs behind a try/catch, because a guard
// that dies instead of failing has not told anyone what broke.
function liftComparator(text) {
  // Scoped to the allGlCodes memo: gl.html has more than one arr.sort, and the
  // first draft of this spec lifted the DESK one — which sorts fine either way,
  // so it proved nothing at all.
  const from = text.indexOf("const allGlCodes");
  if (from < 0) throw new Error("the allGlCodes memo was not found");
  const m = /arr\.sort\(\(a, b\) => \{[\s\S]*?\n    \}\);/.exec(text.slice(from));
  if (!m || !/NO_GL_LABEL/.test(m[0])) throw new Error("the GL code comparator was not found");
  return "function glCmp(a, b) " + m[0].slice("arr.sort((a, b) => ".length, -2) + "\n";
}

let H = null;
try {
  const NO_GL = /const NO_GL_LABEL = '([^']+)'/.exec(src);
  if (!NO_GL) throw new Error("NO_GL_LABEL not found");
  H = new Function(
    "const NO_GL_LABEL = " + JSON.stringify(NO_GL[1]) + ";\n" +
    liftFn(src, "glOptionKey") + "\n" +
    liftFn(src, "reconcileFilterSelection") + "\n" +
    liftComparator(src) + "\n" +
    "return { NO_GL_LABEL, glOptionKey, reconcileFilterSelection, glCmp };")();
  pass++;
} catch (e) {
  failures.push("the GL filter helpers THREW when lifted: " + e.message);
}

if (H) {
  const { NO_GL_LABEL, glOptionKey, reconcileFilterSelection, glCmp } = H;

  // ── 1. unmapped money is an option, not a dropped row ────────────────────
  eq(glOptionKey({ glCode: "4100" }), "4100", "a real code is its own option");
  eq(glOptionKey({ glCode: 4100 }), "4100", "...and a numeric code is not lost to a type mismatch");
  eq(glOptionKey({ glCode: null }), NO_GL_LABEL,
     "UNMAPPED MONEY IS ITS OWN OPTION — a null code is a receipt, not a row to hide");
  eq(glOptionKey({ glCode: "" }), NO_GL_LABEL, "...and so is an empty one");
  eq(glOptionKey({}), NO_GL_LABEL, "...and a row that never carried the field at all");
  eq(glOptionKey({ glCode: "none" }), NO_GL_LABEL,
     "...and the card's own literal 'none', or the same fact yields two options");
  eq(glOptionKey({ glCode: "None" }), NO_GL_LABEL, "...case-insensitively");
  ok(NO_GL_LABEL !== "" && /unmapped/i.test(NO_GL_LABEL),
     "the option says what it is, so nobody reads a blank checkbox as a bug");

  // ── 2. everything starts checked, and None sticks ────────────────────────
  const codes = ["4100", "4200", NO_GL_LABEL];
  same([...reconcileFilterSelection({ available: codes, previous: null, requested: null, dataChanged: true })], codes,
       "EVERYTHING STARTS CHECKED — a first load selects every code in view");
  eq(reconcileFilterSelection({ available: codes, previous: new Set(), requested: null, dataChanged: false }), null,
     "NONE STICKS: with the data unchanged the reconcile declines to touch the user's choice, empty included");
  same([...reconcileFilterSelection({ available: codes, previous: new Set(["4100"]), requested: null, dataChanged: true })],
       ["4100"], "a code that survives a date change keeps its tick");
  same([...reconcileFilterSelection({ available: codes, previous: new Set(["9999"]), requested: null, dataChanged: true })],
       codes, "...but a selection that survives NOTHING widens back to all rather than blanking the report");
  same([...reconcileFilterSelection({ available: codes, previous: null, requested: ["4200"], dataChanged: true })],
       ["4200"], "a ?gl_codes= deep link lands scoped");
  same([...reconcileFilterSelection({ available: codes, previous: null, requested: ["4200", "9999"], dataChanged: true })],
       ["4200"], "...keeping the codes it can and dropping the ones this window has not got");
  same([...reconcileFilterSelection({ available: codes, previous: null, requested: ["9999"], dataChanged: true })],
       codes, "...and a link naming nothing in view shows everything, never an empty report");

  // ── 3. numeric order ─────────────────────────────────────────────────────
  same(["100", "9", "4100"].sort(glCmp), ["9", "100", "4100"],
     "GL CODES SORT NUMERICALLY — as strings 100 precedes 9 and the menu is unusable");
  // Only the PAIR of sink branches is discriminating: a stable sort leaves an
  // element in place on a 0, so mutating either branch alone can still come out
  // ordered correctly. Mutation-tested as a pair, which is the real regression.
  same(["4100", NO_GL_LABEL, "9"].sort(glCmp), ["9", "4100", NO_GL_LABEL],
     "...and unmapped sinks to the bottom, whichever side of the comparison it lands on");
  same([NO_GL_LABEL, "4100", "9", "220"].sort(glCmp), ["9", "220", "4100", NO_GL_LABEL],
     "...from either starting order");
  same(["4100-B", "4100-A"].sort(glCmp), ["4100-A", "4100-B"], "non-numeric codes still order sensibly");
}

// ── 4. one menu component, used twice ──────────────────────────────────────
ok(/function CheckFilter\(/.test(code), "the picker is a shared component");
ok(!/function DeskFilter\(/.test(code),
   "...and the desk-only copy is GONE — two dropdowns drift the first time the chrome changes");
eq((code.match(/<CheckFilter\b/g) || []).length, 2,
   "ONE COMPONENT SERVES BOTH PICKERS — the desks and the GL codes");
ok(/\['data-' \+ slug \+ '-opt'\]/.test(code) && /\['data-' \+ slug \+ '-btn'\]/.test(code),
   "its handles are keyed by the caller's slug, so a render case can tell the two menus apart");

// ── 5. one funnel, and the export reconstructs it ──────────────────────────
ok(/glSel\.has\(glOptionKey\(r\)\)/.test(code),
   "the funnel filters by the SAME key the options were built from — two derivations is how a checkbox lights up and filters nothing");
ok(/glSel && allGlCodes\.length > 1 && glSel\.size < allGlCodes\.length/.test(code),
   "an unfiltered report does no filtering work and writes no parameter");
ok(/params\._print === '1'[\s\S]{0,400}gl_codes/.test(code),
   "PRINT AND PDF RECONSTRUCT THE SELECTION FROM THE URL — they have no React state, and an export carrying codes the reader excluded is worse than one that fails");

// The funnel's deps: a selection the memo cannot see is a filter that only
// applies after some unrelated state happens to change.
const deps = /\}, \[rows, hasDesk, selectedDesks, allDesks, glFilter([^\]]*)\]\);/.exec(code);
ok(deps && /selectedGlCodes/.test(deps[1]) && /allGlCodes/.test(deps[1]),
   "the funnel re-runs when the GL selection changes");

// ── 6. the deep link is whitelisted ────────────────────────────────────────
// BOTH readers must have it — getParams() and the intent builder. A single
// .test() passes with either one alone; the first draft of this spec did, and a
// mutation dropping it from getParams survived.
eq((code.match(/glCodes: csv\('gl_codes'\)/g) || []).length, 2,
   "gl_codes is in getParams()'s explicit whitelist AND the intent builder — leaving it out of either makes the deep link silently do nothing");
ok(/qs\.set\('gl_codes'/.test(code) && /p\.set\('gl_codes'/.test(code),
   "...and both the export params and the share link carry it, or a link drops the filter the sender was looking at");

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ gl-code-filter.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("✓ gl-code-filter.spec.js — " + pass + " assertions passed.");
