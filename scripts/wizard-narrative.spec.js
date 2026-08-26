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

test("an UNMEASURED source gets no grain phrase — a wrong one is worse than none", () => {
  // The first version of this map was written from the card names, and a
  // backcheck on 2026-08-26 found two of the three claims it could test were
  // false: `gl` groups by gl_code AND desk_location, and `facility` emits one
  // row per DATE of a reservation (19 rows over 4 reservation ids). A grain
  // phrase is a confident sentence about what a row means, printed directly
  // under a row count, so an unmeasured source must print nothing.
  const i = src.indexOf("const WIZARD_SOURCE_GRAIN = {");
  const grain = require("vm").runInNewContext(
    "(" + src.slice(src.indexOf("{", i), src.indexOf("\n};", i) + 2) + ")");
  assert.ok(Object.keys(grain).length >= 3, "expected the measured sources");
  assert.match(page, /grain: SOURCE_GRAIN\[src\] \|\| '',/,
    "the page must fall back to NO phrase, never to a guessed one");
  assert.ok(!/one row per record/.test(page),
    "the generic fallback is exactly the fabrication this guard exists to stop");
  // And the phrases that ARE there must be the measured ones, not the originals.
  assert.strictEqual(grain.gl, "one row per GL account per desk location",
    "card 17293 groups by gl_code AND desk_location");
  assert.strictEqual(grain.facility, "one row per booked date of a reservation",
    "card 17294 repeats a multi-day booking once per date");
  assert.strictEqual(grain.programs, "one row per program section");
});

test("each grain entry records the card it was measured against", () => {
  // Provenance is the only thing that stops the next person adding a plausible
  // phrase from a card name, which is how the two wrong ones got in.
  const i = src.indexOf("const WIZARD_SOURCE_GRAIN = {");
  const block = src.slice(i, src.indexOf("\n};", i));
  for (const key of ["programs", "gl", "facility"]) {
    const line = block.split("\n").findIndex(l => new RegExp("^\\s*" + key + ":").test(l));
    assert.ok(line > 0, key + " not found in the map");
    const above = block.split("\n").slice(Math.max(0, line - 4), line).join(" ");
    assert.match(above, /card \d{5}/, key + " has no card number recorded above it");
  }
});

// ── The date window ─────────────────────────────────────────────────────────
test("the feed reports the window it actually covers, read off the params SENT", () => {
  // Found by the same backcheck: the generated GL report carried no period at
  // all. The wizard passes no dates, so buildMetabaseParams silently defaults to
  // a 7-day window, and nothing downstream could say which one it got.
  const route = src.slice(src.indexOf('app.get("/:org/:report/api/data"'));
  const meta = route.slice(0, route.indexOf("setCache(cacheKey"));
  assert.match(meta, /window: \(\(\) => \{/, "no window on the feed meta");
  assert.match(meta, /params\.find\(x => x\.target/,
    "the window must be read back off the parameters that were sent, not recomputed — " +
    "recomputing can disagree with what Metabase was actually asked");
});

test("the derived window is the one buildMetabaseParams actually sent", () => {
  // Runs the REAL buildMetabaseParams and the REAL derivation over its output,
  // so this pins behaviour rather than the shape of the code. No Metabase
  // involved — the derivation only reads the params array.
  const vm = require("vm");
  const grab = (start, end) => {
    const i = src.indexOf(start);
    assert.ok(i > 0, "could not find " + start);
    return src.slice(i, src.indexOf(end, i) + end.length);
  };
  // parseToISO comes along because buildMetabaseParams calls it; taking the real
  // pair rather than a stub is the point — a date-normalisation change has to be
  // able to fail this.
  const ctx = { console: Object.assign({}, console, { log() {} }), module: {}, exports: {} };
  vm.createContext(ctx);
  vm.runInContext(
    grab("function parseToISO(", "\n  return params;\n}") +
    "\nthis.buildMetabaseParams = buildMetabaseParams;", ctx);

  // The derivation, lifted verbatim out of the route so it cannot drift from it.
  const route = src.slice(src.indexOf('app.get("/:org/:report/api/data"'));
  const wi = route.indexOf("window: (() => {");
  // Slice the arrow function itself (ending at its closing brace + paren), then
  // call it here — so the spec runs the route's own code, not a restatement.
  const arrow = route.slice(wi + "window: ".length, route.indexOf("})(),", wi) + 2);
  const derive = new Function("params", "return (" + arrow + ")();");

  const iso = d => new Date(d).toISOString().slice(0, 10);
  const today = iso(Date.now()), weekAgo = iso(Date.now() - 7 * 86400000);

  // gl takes dates and is a BACKWARD report: no dates in => last 7 days.
  const glParams = ctx.buildMetabaseParams({}, "gl", "org-uuid");
  assert.deepStrictEqual(derive(glParams), { start: weekAgo, end: today },
    "the wizard passes no dates, so this default IS the period the report covers — " +
    "which is exactly why it has to be printed");

  // Explicit dates must be echoed unchanged.
  assert.deepStrictEqual(
    derive(ctx.buildMetabaseParams({ start_date: "2026-01-05", end_date: "2026-02-06" }, "gl", "o")),
    { start: "2026-01-05", end: "2026-02-06" });

  // facility is a FORWARD report — the window runs the other way, so printing a
  // single park-wide "last 7 days" for every source would be wrong.
  const facWin = derive(ctx.buildMetabaseParams({}, "facility", "o"));
  assert.strictEqual(facWin.start, today, "facility looks forward from today");
  assert.ok(facWin.end > today, "…to a future end: " + JSON.stringify(facWin));

  // A date-less report has no window to report, and must say null rather than
  // inventing one.
  assert.strictEqual(derive(ctx.buildMetabaseParams({}, "memberships", "o")), null,
    "memberships is in NO_DATE_REPORTS — no date params are sent at all");
});

test("the page reads the window defensively and formats it without new Date()", () => {
  assert.match(page, /d\.meta && d\.meta\.window/,
    "entries cached before this shipped have no window, so it must be optional");
  const i = page.indexOf("function fmtWindow");
  const fn = page.slice(i, page.indexOf("function ReportNarrative", i));
  assert.ok(!/new Date/.test(fn),
    'new Date("2026-08-19") is UTC midnight and formats as Aug 18 across the US — ' +
    "the same bug as the Fast Track dates");
  assert.match(fn, /\/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\//,
    "the date must be built from the ISO string's parts");
});

test("the GL source hint warns that payment COUNTS are not additive", () => {
  // Card 17293's "Number of Payments" is COUNT(DISTINCT transaction) per GL row,
  // which is why the card also ships "Desk Distinct Payments". Summing the per-GL
  // column double-counts any payment spanning two GL codes. It happened to be
  // right for Clarksville (65 == 65, one desk, no payment split across codes),
  // so this is a latent wrong number, not a current one.
  const i = src.indexOf("const WIZARD_SOURCE_HINTS = {");
  const hints = src.slice(i, src.indexOf("\n};", i));
  assert.match(hints, /NOT additive/, "the AI has no way to know this from the field names");
  assert.match(hints, /Desk Distinct Payments/, "and needs to be told what to use instead");
  assert.match(hints, /Money columns ARE additive/,
    "or the warning reads as 'do not sum anything from this source'");
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
