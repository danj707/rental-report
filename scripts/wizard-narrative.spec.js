// Spec for the Report Wizard's report write-up.
//
// A generated report used to be a title and a stack of charts, which leaves the
// reader guessing what they are looking at. The write-up has two halves and the
// whole design rests on keeping them apart:
//
//   1. `summary` / `notes` — written by the model, which is generating the config
//      BEFORE a single row has been fetched. It can say what the report asks and
//      what a row of each source means; it CANNOT know a total, a top program or
//      a date range. So the system prompt forbids figures, and this spec pins
//      that instruction — a summary that invents "$2.5M across 26 programs"
//      reads exactly as authoritative as the KPI cards beside it and is a
//      fabrication.
//   2. the "Built from" line — computed in the page from the rows that actually
//      arrived. It is the only part that may carry a number.
//
// And the grain map ("one row per section") lives in server.js and is injected,
// not copied into the page: the line is worth printing only if it is true, and
// two copies drift the first time a card changes grain.
//
// It also pins the build screen's typed placeholder, whose animation is proven
// in a real browser by ci-check-render.js — what is checked here is the handful
// of invariants that would let that browser case pass on a dead animation.
//
// Run: node scripts/wizard-narrative.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const page = fs.readFileSync(path.join(ROOT, "public", "report-wizard.html"), "utf8");

let passed = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); passed++; };

// The system prompt, sliced out so the assertions below read it rather than the
// whole file (which mentions these words in other places).
const PROMPT = (() => {
  const i = src.indexOf("const WIZARD_SYS_PROMPT = `");
  assert.ok(i > 0, "WIZARD_SYS_PROMPT not found");
  const j = src.indexOf("app.post(\"/:org/report-wizard/api/generate\"", i);
  return src.slice(i, j);
})();

test("the model is asked for a summary AND caveat notes", () => {
  assert.match(PROMPT, /"summary":/, "no summary field in the declared JSON shape");
  assert.match(PROMPT, /"notes":/, "no notes field in the declared JSON shape");
  assert.match(PROMPT, /ALWAYS include "summary" and "notes"/,
    "an optional write-up is a write-up most reports will not have");
});

test("the worked example carries a summary and notes, not just the field names", () => {
  // The prompt's complete example is what the model actually copies. Declaring a
  // field it has never seen filled in is how you get a one-word summary.
  const ex = PROMPT.slice(PROMPT.indexOf("COMPLETE WORKING EXAMPLE"));
  assert.match(ex, /"summary": "This report shows/, "the example has no summary to imitate");
  assert.match(ex, /"notes": \[/, "the example has no notes to imitate");
});

test("the prompt FORBIDS figures in the write-up — it is written before any data lands", () => {
  assert.match(PROMPT, /MUST NOT CONTAIN FIGURES/,
    "the model writes this from field names and a handful of samples; any number in it " +
    "is invented, and it sits next to real KPI cards");
  assert.match(PROMPT, /BEFORE any data has been fetched/);
  assert.match(PROMPT, /NEVER write a number/);
});

test("the token budget has headroom for the prose", () => {
  const m = /const WIZARD_MAX_TOKENS = (\d+);/.exec(src);
  assert.ok(m, "WIZARD_MAX_TOKENS not found");
  assert.ok(Number(m[1]) >= 4000,
    "the config is ONE JSON object, so running short does not truncate the prose — it " +
    "truncates the JSON and the whole generation fails as 'invalid config'");
});

// ── The server normalises the write-up before the page sees it ───────────────
test("summary and notes are normalised server-side, so a bad shape cannot blank the page", () => {
  const gen = src.slice(src.indexOf('app.post("/:org/report-wizard/api/generate"'));
  assert.match(gen, /config\.summary = typeof config\.summary === "string"/,
    "a non-string summary must not reach the page");
  assert.match(gen, /Array\.isArray\(config\.notes\) \? config\.notes : config\.notes \? \[config\.notes\] : \[\]/,
    "a model that returns one note as a bare string must not blank the report");
  assert.match(gen, /\.slice\(0, 900\)/, "the summary needs a length clamp");
  assert.match(gen, /\.slice\(0, 4\)/, "the note count needs a clamp");
});

// Run the real normaliser over hostile shapes, rather than trusting the regexes
// above to mean it works.
test("the real normaliser survives a string, a number, blanks and an essay", () => {
  const gen = src.slice(src.indexOf('app.post("/:org/report-wizard/api/generate"'));
  const start = gen.indexOf("config.summary = typeof");
  const end = gen.indexOf("if (!config.dataSources", start);
  assert.ok(start > 0 && end > start, "could not slice the normaliser out of the route");
  const norm = new Function("config", gen.slice(start, end) + "\nreturn config;");

  let c = norm({ summary: 42, notes: "just the one" });
  assert.strictEqual(c.summary, "", "a number is not a summary");
  assert.deepStrictEqual(c.notes, ["just the one"], "a bare string becomes one note");

  c = norm({ summary: "  padded  ", notes: ["a", "", "  ", null, 7, "b", "c", "d", "e"] });
  assert.strictEqual(c.summary, "padded");
  assert.deepStrictEqual(c.notes, ["a", "b", "c", "d"], "blanks and non-strings drop, four survive");

  c = norm({ summary: "x".repeat(5000), notes: ["y".repeat(5000)] });
  assert.strictEqual(c.summary.length, 900);
  assert.strictEqual(c.notes[0].length, 240);

  c = norm({});
  assert.strictEqual(c.summary, "");
  assert.deepStrictEqual(c.notes, [], "a config with no write-up is legal — saved reports predate it");
});

// ── One grain map, in server.js ──────────────────────────────────────────────
test("the grain map lives in server.js and is injected into the page", () => {
  assert.match(src, /const WIZARD_SOURCE_GRAIN = \{/, "WIZARD_SOURCE_GRAIN not found");
  assert.match(src, /sourceGrain: WIZARD_SOURCE_GRAIN,/,
    "the wizard page route must inject it, or the page has nothing to read");
  assert.match(page, /var SOURCE_GRAIN = CFG\.sourceGrain \|\| \{\};/,
    "the page must read the injected map");
});

test("the page does NOT carry its own grain map — two copies would drift", () => {
  // The failure this prevents is silent and specific: a card changes grain, the
  // server map is updated, and the page keeps printing "one row per section"
  // under a feed that is now one row per registration.
  const decl = /SOURCE_GRAIN\s*=\s*\{[^}]/.exec(page);
  assert.ok(!decl, "the page declares a literal grain map: " + (decl && decl[0]));
  assert.ok(!/one row per (section|participant|GL account)/.test(page),
    "a grain phrase is hardcoded in the page — it belongs in WIZARD_SOURCE_GRAIN");
});

test("every source the wizard can offer has a grain, or the line says 'per record'", () => {
  const rt = JSON.parse(/const REPORT_TYPES = (\[[^\]]+\])/.exec(src)[1]);
  const i = src.indexOf("const WIZARD_SOURCE_GRAIN = {");
  const grain = require("vm").runInNewContext(
    "(" + src.slice(src.indexOf("{", i), src.indexOf("\n};", i) + 2) + ")");
  const missing = rt.filter(r => !grain[r] && r !== "qoq" && r !== "annual-report");
  assert.deepStrictEqual(missing, [],
    "these sources would print the generic fallback: " + missing.join(", "));
  assert.match(page, /'one row per record'/, "and the fallback has to exist for a new source");
});

// ── The page's own half ──────────────────────────────────────────────────────
test("the row count comes from the fetched rows, not from the model", () => {
  const i = page.indexOf("function ReportNarrative");
  const comp = page.slice(i, page.indexOf("// ── Widget Renderer ──", i));
  assert.match(comp, /rows \? rows\.length : 0/,
    "the only number in this block must be measured, never generated");
  assert.ok(!/report\.rowCount|report\.rows/.test(comp),
    "reading a count off the model's config would print a number it cannot know");
});

test("a source that answered with nothing is called out, not shown as a zero", () => {
  const i = page.indexOf("function ReportNarrative");
  const comp = page.slice(i, page.indexOf("// ── Widget Renderer ──", i));
  assert.match(comp, /no rows returned/,
    "a failed fetch used to render as widgets full of dashes with nothing saying why");
  assert.match(comp, /missing: !rows \|\| !rows\.length/);
});

test("a report with no write-up renders nothing rather than an empty decorated box", () => {
  const i = page.indexOf("function ReportNarrative");
  const comp = page.slice(i, page.indexOf("// ── Widget Renderer ──", i));
  assert.match(comp, /if \(!summary && !notes\.length && !built\.length\) return null;/,
    "saved reports from before this shipped have no summary and must not grow an empty panel");
});

// ── The build screen's typed placeholder ────────────────────────────────────
// The animation itself is proven in a real browser by ci-check-render.js
// (`wizard · typed placeholder`, keyed on data-rw-typed="1"). What is checked
// here is the one thing that would make that case pass trivially.
test("the caret does NOT count as typing — or the render guard passes on a dead animation", () => {
  assert.match(page, /data-rw-typed=\{typed \? '1' : '0'\}/,
    "data-rw-typed must key on the TEXT. Fold the caret into it and it reads '1' on the " +
    "first frame, so the render case passes with nothing ever typed.");
  assert.match(page, /placeholder=\{typed \? typed \+ typeCaret : STATIC_PLACEHOLDER\}/,
    "the caret is composed at the call site, separately from the text");
});

test("the animation writes to the PLACEHOLDER, never to the value", () => {
  const i = page.indexOf("function useTypedPlaceholder");
  const hook = page.slice(i, page.indexOf("// The placeholder once the animation", i));
  assert.ok(!/setPrompt/.test(hook),
    "an animation that writes into the box races the admin typing in it");
});

test("touching the box kills the animation for good, rather than pausing it", () => {
  assert.match(page, /onFocus=\{stopTyping\}/, "focus must stop it");
  assert.match(page, /onChange=\{function\(e\) \{ setPrompt\(e\.target\.value\); stopTyping\(\); \}\}/,
    "typing must stop it");
  assert.match(page, /stopTyping\(\); setPrompt\(ex\);/,
    "clicking a quick prompt must stop it too — otherwise it resumes behind their chosen text");
});

test("a reader who asked for less motion gets the static placeholder", () => {
  assert.match(page, /prefers-reduced-motion: reduce/, "no reduced-motion check in the page");
  const i = page.indexOf("function useTypedPlaceholder");
  const hook = page.slice(i, page.indexOf("// The placeholder once the animation", i));
  assert.match(hook, /if \(!active \|\| reduce\.current/, "the hook must honour it");
});

console.log(`\n${passed}/${passed} passing`);
