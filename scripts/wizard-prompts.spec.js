#!/usr/bin/env node
/**
 * wizard-prompts.spec.js — the wizard only suggests what the org can generate.
 *
 * Dan: "if we ask org x about a set of data we don't have live for them, or they
 * don't use something, like campgrounds, then that suggestion won't even
 * appear… Douglas County should get campground and programs comments, Apex
 * should get, well, everything, and Clarksville should get aquatics, memberships
 * and product suggestions… the goal clearly is that if we surface a prompt, the
 * report should generate."
 *
 * MEASURED, over a year of facility bookings (2026-08-28):
 *
 *     douglas-county-nv   camping 573 · fields 302 · racket 51 · outdoor 49
 *     clarksville         aquatics 359 · outdoor 307 · fields 8
 *
 * Douglas has no pool and Clarksville has no campsite, so the distinction Dan
 * drew is real and is only visible in the ROWS — "campground" and "aquatics" are
 * court.type values inside the facility feed, not report types.
 *
 * SKIP_SOURCE=1 drops the source-shape assertions.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const FACILITIES = fs.readFileSync(path.join(ROOT, "public", "facilities.html"), "utf8");
const WIZARD = fs.readFileSync(path.join(ROOT, "public", "report-wizard.html"), "utf8");

let n = 0;
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";
const src = (c, w) => { if (SKIP_SOURCE) return; n++; assert.ok(c, w); };
const ok = (c, w) => { n++; assert.ok(c, w); };
const is = (a, b, w) => { n++; assert.deepStrictEqual(a, b, w); };

// ── Lift the server's implementation and RUN it ──────────────────────────────
const S = (() => {
  const re = /const WIZARD_OUTDOOR_TYPES = \[[\s\S]*?\nfunction wizardPromptsFor\(known, verticals, configured\) \{[\s\S]*?\n\}/;
  const m = re.exec(SERVER);
  assert.ok(m, "could not lift the wizard prompt registry");
  return vm.runInThisContext(
    "(function(process){" + m[0] +
    "\nreturn { WIZARD_VERTICAL_TYPES, wizardRefineSiteType, wizardVerticalsFrom, " +
    "WIZARD_PROMPTS, WIZARD_PROMPT_TARGET, wizardPromptsFor, WIZARD_VERTICAL_MIN_ROWS };})"
  )({ env: {} });
})();

// ── The client's copy of the same refinement ────────────────────────────────
const C = (() => {
  const m = /function refineSiteType\(rawType, facility\) \{[\s\S]*?\n    \}/.exec(FACILITIES);
  assert.ok(m, "could not lift refineSiteType from facilities.html");
  return vm.runInThisContext("(function(){" + m[0] + "\nreturn { refineSiteType };})")();
})();

// ── 1. THE TWO COPIES MUST AGREE, ROW FOR ROW ───────────────────────────────
// Rec types pools, rinks and gyms as `court`, so a naive read files an ice rink
// as a tennis court. Two surfaces disagreeing about what an org HAS is worse
// than one surface not knowing — the WIZARD_SOURCE_GRAIN lesson.
{
  const cases = [
    ["court", "Ice Arena Rink 1"], ["court", "Indoor Pool"], ["court", "Natatorium Lane 3"],
    ["court", "Gymnasium"], ["court", "Gym Court 2"], ["court", "Tennis Court 4"],
    ["court", "Aquatics Center Court 1"], ["campsite", "Site 12"], ["field", "Ballfield 3"],
    ["pool", "Main Pool"], ["rink", "Rink B"], ["room", "Meeting Room"],
    ["court", "Swim Lane 1"], ["court", "ICE HOUSE"], ["court", "Pickleball 2"],
    ["", ""], ["court", null], ["court", "Aquatic Park Court 7"],
  ];
  for (const [t, f] of cases) {
    is(S.wizardRefineSiteType(t, f), C.refineSiteType(t, f),
       `server and page must classify ("${t}", "${f}") identically — a rink counted as a court `
       + `means an org is offered the wrong prompt, or denied the right one`);
  }
  // And the rule itself, so an agreeing pair of WRONG implementations still fails.
  is(S.wizardRefineSiteType("court", "Ice Arena Rink 1"), "rink", "an ice rink typed court is recovered");
  is(S.wizardRefineSiteType("court", "Indoor Pool"), "pool", "so is a pool");
  // The protection against "a court at Aquatic Park becomes a pool" is that the
  // LOCATION is never passed in — only the site name. Asserted as the function's
  // shape, because that is where the guarantee actually lives: a site whose own
  // name says "Aquatic" IS reclassified, and both copies agree that it is.
  is(S.wizardRefineSiteType("court", "Aquatic Park Court 7"), "pool",
     "a site whose OWN NAME says aquatic is reclassified — matching the shipped page exactly");
  is(S.wizardRefineSiteType.length, 2,
     "…and the function takes the type and the SITE only. There is no location parameter, which is "
     + "what stops a tennis court at an aquatic centre being counted as a pool");
  src(/wizardRefineSiteType\(String\(r\["Site Type"\] \|\| ""\), r\["Facility"\]\)/.test(SERVER),
     "…and the caller passes the Facility (the site), never the Location");
  is(S.wizardRefineSiteType("pool", "Whatever"), "pool",
     "and a type Rec already gave us specifically is never reconsidered");
}

// ── 2. Verticals from real shapes ───────────────────────────────────────────
const rowsFor = (spec) => {
  const out = [];
  for (const [type, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i++) out.push({ "Site Type": type, Facility: type + " " + i });
  }
  return out;
};
{
  // Douglas, as measured.
  const douglas = S.wizardVerticalsFrom(rowsFor({
    campsite: 573, field: 302, court: 51, "outdoor-event-space": 49, room: 100, other: 62,
  }));
  is(Object.keys(douglas).sort(), ["camping", "fields", "outdoor", "racket"],
     "Douglas books campsites, fields, courts and shelters — and NO pool, which is why an aquatics "
     + "prompt must not appear for them");

  // Clarksville, as measured — 8 field rows, under the floor.
  const clarksville = S.wizardVerticalsFrom(rowsFor({
    pool: 359, "outdoor-event-space": 307, field: 8, room: 199,
  }));
  is(Object.keys(clarksville).sort(), ["aquatics", "outdoor"],
     "Clarksville books a pool and shelters, no campsite — and its EIGHT field rows are under the "
     + "floor, because a handful of bookings is not a vertical and a fields report there would "
     + "generate almost nothing");
  ok(S.WIZARD_VERTICAL_MIN_ROWS > 8,
     "…which is only true while the floor is above 8");
  is(clarksville.aquatics, 359, "the count travels, so the floor can be reasoned about");
}

// ── 3. Eligibility: exactly Dan's three orgs ────────────────────────────────
{
  const ALL_SOURCES = {};
  for (const p of S.WIZARD_PROMPTS) for (const rt of p.needs || []) ALL_SOURCES[rt] = true;

  const douglas = S.wizardPromptsFor(
    { programs: true, facility: true, gl: true, roster: true },
    { camping: 573, fields: 302, outdoor: 49, racket: 51 });
  ok(douglas.chips.some(t => /campsite/i.test(t)),
     "DOUGLAS GETS A CAMPGROUND PROMPT — the thing Dan asked for by name");
  ok(douglas.typed.some(t => /campsite/i.test(t)), "…in the typed line too");
  ok(!douglas.chips.concat(douglas.typed).some(t => /pool|aquatic/i.test(t)),
     "…and never an aquatics one, because they have no pool");
  ok(!douglas.chips.concat(douglas.typed).some(t => /membership|product/i.test(t)),
     "…nor memberships or products, which did not answer for them");

  const clarksville = S.wizardPromptsFor(
    { programs: true, facility: true, memberships: true, products: true, gl: true },
    { aquatics: 359, outdoor: 307 });
  ok(clarksville.chips.some(t => /pool|aquatic/i.test(t)),
     "CLARKSVILLE GETS AQUATICS");
  ok(clarksville.chips.some(t => /membership/i.test(t)), "…and memberships");
  ok(clarksville.chips.some(t => /product/i.test(t)), "…and products — Dan's three, exactly");
  ok(!clarksville.chips.concat(clarksville.typed).some(t => /campsite/i.test(t)),
     "…and never a campground one");

  const apex = S.wizardPromptsFor(ALL_SOURCES,
    { camping: 99, aquatics: 99, ice: 99, fields: 99, outdoor: 99, racket: 99, golf: 99 });
  is(apex.chips.length, S.WIZARD_PROMPT_TARGET.chip,
     "an org with everything fills the chip row — 'Apex should get, well, everything'");
  is(apex.typed.length, S.WIZARD_PROMPT_TARGET.typed, "…and the typed set");

  // A VERTICAL PROMPT LEADS. "Top 10 programs by revenue" is true of every org
  // and says nothing about this one.
  const leadIsSpecific = S.WIZARD_PROMPTS.find(p => p.kind === "chip" && p.text === douglas.chips[0]);
  ok(leadIsSpecific && leadIsSpecific.vertical,
     "the first chip is a vertical one where the org has a vertical — it is the reason they opened "
     + "the page, and a generic prompt in that slot wastes it");
}

// ── 4. A thin org, and the floor ────────────────────────────────────────────
{
  const thin = S.wizardPromptsFor({ programs: true }, {});
  ok(thin.chips.length >= 2 && thin.typed.length >= 2,
     "an org with only programs still gets a usable menu, topped up from the generic set");

  // A COLD VOLUME KNOWS NOTHING, and the floor must still fire. Measured on the
  // PR preview before this was fixed: Douglas and Apex were served an EMPTY list
  // and Clarksville got 2 chips of 6, because the generic top-up was gated on
  // having SEEN the programs card answer. A floor gated on liveness is not a
  // floor. `configured` is a configuration fact and is what the top-up reads.
  const cold = S.wizardPromptsFor({}, {}, { programs: true, gl: true, facility: true });
  ok(cold.chips.length >= 2,
     "with NOTHING known but a programs card configured, the generic chips still appear");
  ok(cold.typed.length >= 2, "…and the typed lines");
  ok(!cold.chips.concat(cold.typed).some(t => /pool|campsite|membership|product|GL account/i.test(t)),
     "…and NONE of them is a specific claim about a source we have not seen answer — a configured "
     + "card is not evidence the org uses it, and 'if we surface a prompt it should generate' is "
     + "about what we know, not what is wired up");
  const generics = S.WIZARD_PROMPTS.filter(p => p.generic);
  for (const p of generics) {
    is(p.needs, ["programs"],
       `a generic top-up may need NOTHING but programs (${JSON.stringify(p.text)}) — it is the `
       + `list a thin org falls back to, so it has to be the safest on the page`);
    ok(!p.vertical, "…and no vertical");
  }

  const nothing = S.wizardPromptsFor({}, {});
  is(nothing.chips, [], "an org with NO answering source is offered nothing rather than a lie");
  is(nothing.typed, [], "…in either pool — the page's own floor covers that case");
}

// ── 5. The invariants that keep this honest ─────────────────────────────────
{
  // NON_ADDABLE_REPORTS is the set fetchWizardSchemas excludes, so a prompt
  // needing one of those can NEVER be satisfied — the model is not shown a
  // schema for it. "Program revenue and fill rate by gender" was the first chip
  // on this page for months and is exactly this bug: gender lives in
  // program-demographics, which is excluded.
  const nonAddable = (() => {
    const m = /const NON_ADDABLE_REPORTS = new Set\((\[[^\]]*\])\)/.exec(SERVER);
    assert.ok(m, "could not read NON_ADDABLE_REPORTS");
    return new Set(vm.runInThisContext(m[1]));
  })();
  const reportTypes = (() => {
    const m = /const REPORT_TYPES = (\[[^\]]*\])/.exec(SERVER);
    return new Set(vm.runInThisContext(m[1]));
  })();

  for (const p of S.WIZARD_PROMPTS) {
    for (const rt of p.needs || []) {
      ok(reportTypes.has(rt), `"${rt}" is a real report type (${p.text})`);
      ok(!nonAddable.has(rt),
         `NO PROMPT MAY NEED "${rt}" — fetchWizardSchemas excludes it via NON_ADDABLE_REPORTS, so `
         + `the model is never shown a schema for it and the report cannot be generated (${p.text})`);
    }
    ok((p.needs || []).length > 0, `every prompt declares what it needs (${p.text})`);
    ok(p.kind === "chip" || p.kind === "typed", `every prompt is a chip or a typed line (${p.text})`);
    if (p.vertical) ok(S.WIZARD_VERTICAL_TYPES[p.vertical],
      `"${p.vertical}" is a real vertical (${p.text})`);
  }

  // GENDER IS THE SPECIFIC TRAP, and the rule is narrower than "never mention
  // it". Measured against the live cards for clarksville: the `users` card DOES
  // carry a Gender column (32 columns, 17,154 rows), so a community gender
  // breakdown is real. What was broken was asking for it from PROGRAMS — gender
  // at program grain lives in program-demographics, which fetchWizardSchemas
  // excludes, and "Program revenue and fill rate by gender" was the first chip
  // on this page for months on exactly that mistake.
  for (const p of S.WIZARD_PROMPTS.filter(p => /gender/i.test(p.text))) {
    ok((p.needs || []).includes("users"),
       `"${p.text}" mentions gender, so it must be on the users source — that is the one the wizard `
       + `can see a Gender column in. Asking programs for gender is the chip that could never work`);
  }

  // THE TWO POOLS STAY DIFFERENT (Dan, and the note in CLAUDE.md).
  const chipText = new Set(S.WIZARD_PROMPTS.filter(p => p.kind === "chip").map(p => p.text));
  const typedText = S.WIZARD_PROMPTS.filter(p => p.kind === "typed").map(p => p.text);
  for (const t of typedText) {
    ok(!chipText.has(t),
       `"${t}" must not be in both pools — the chips and the typing animation are on screen at the `
       + `same time, and one set driving both makes the panel repeat itself twice over`);
  }
  ok(chipText.size >= S.WIZARD_PROMPT_TARGET.chip,
     "there are at least as many chips as the row shows, or a full org still renders a short row");
  ok(typedText.length >= S.WIZARD_PROMPT_TARGET.typed, "…same for the typed pool");
}

// ── 5b. NO PROMPT MAY PROMISE A PERIOD ──────────────────────────────────────
// The wizard sends no dates, so buildMetabaseParams defaults to SEVEN DAYS.
// Measured: "Monthly product sales breakdown" for clarksville was answered with
// ONE row — a single $200 donation, window Aug 21-28. A prompt naming a month or
// a quarter is a promise the system cannot keep, and the wording is mine, so it
// is mine to get right.
{
  const PERIOD = /\b(monthly|weekly|quarterly|annual(ly)?|this (month|quarter|year|fall|spring|summer|winter)|last (month|quarter|year|week)|year[- ]over[- ]year|month[- ]over[- ]month|ytd)\b/i;
  for (const p of S.WIZARD_PROMPTS) {
    ok(!PERIOD.test(p.text),
       `"${p.text}" names a period. The wizard requests no dates, so every report is a 7-day `
       + `window — the prompt would be answered for a week and read as a month`);
  }
  for (const [name, re] of [["typed floor", /var TYPING_PROMPTS_FALLBACK = \[([\s\S]*?)\];/],
                            ["chip floor", /var EXAMPLES_FALLBACK = \[([\s\S]*?)\];/]]) {
    const m = re.exec(WIZARD);
    ok(m && !PERIOD.test(m[1]), `the ${name} must not name a period either:\n` + (m ? m[1].trim() : "?"));
  }
}

// ── 5c. A source with almost nothing does not justify a prompt ──────────────
{
  src(/const WIZARD_SOURCE_MIN_ROWS = Number\(process\.env\.WIZARD_SOURCE_MIN_ROWS \|\| 5\)/.test(SERVER),
     "a source row floor exists");
  const fn = /function wizardKnownSources\([\s\S]*?\n\}/.exec(SERVER)[0];
  src(/warm\.length >= WIZARD_SOURCE_MIN_ROWS/.test(fn),
     "…applied to warm rows — clarksville's products feed returned ONE row and still justified a "
     + "'top sellers' prompt");
  src(/\(remembered\.rowCount \|\| 0\) >= WIZARD_SOURCE_MIN_ROWS/.test(fn),
     "…and to the remembered row count, or the store reintroduces what the floor just excluded");
}

// ── 5d. THE FIELD NAMES THE MODEL IS TAUGHT MUST BE REAL ───────────────────
// Root cause of the 8 wrong figures: the system prompt's own worked examples
// used "Net Amount", "Program Name" and "Registrations" against source
// "programs", whose real columns are net_total, program and enrolled. The model
// copied the examples exactly as instructed. Measured column names below.
{
  const PROGRAMS_REAL = ["net_total", "enrolled", "capacity", "fill_pct", "program", "section"];
  const PROGRAMS_FAKE = ["Net Amount", "Program Name", "Registrations", "Section Name"];
  const prompt = (() => {
    const i = SERVER.indexOf("WIDGET TYPES:");
    const j = SERVER.indexOf("app.post(\"/:org/report-wizard/api/generate\"", i);
    return SERVER.slice(i, j);
  })();
  const progLines = prompt.split("\n").filter(l => /"source":\s*"programs"/.test(l));
  ok(progLines.length > 0, "the prompt has worked examples that use the programs source");
  for (const fake of PROGRAMS_FAKE) {
    for (const line of progLines) {
      ok(!line.includes('"' + fake + '"'),
         `the system prompt uses "${fake}" on a line that names source "programs" — it is not a `
         + `column in that feed (real: net_total, enrolled, capacity, program, section), and the `
         + `model copies the examples character-for-character as told:\n    ${line.trim().slice(0, 160)}`);
    }
  }
  // The programs table example is the one the model reproduces most often.
  ok(progLines.some(l => l.includes("net_total") && l.includes("enrolled")),
     "…and at least one programs example names the real revenue and enrolment columns");
  ok(PROGRAMS_REAL.some(r => prompt.includes(r)),
     "…and the examples should name columns that DO exist (net_total, enrolled, program)");
  ok(/COLUMN NAMING IS NOT CONSISTENT BETWEEN SOURCES/.test(SERVER),
     "the prompt says out loud that programs is snake_case while the others are Title Case — the "
     + "old text taught the opposite with 'WRONG: net_total  RIGHT: Net Revenue'");
  ok(!/WRONG: "field": "net_total"\s+RIGHT/.test(SERVER),
     "…and that instruction, which is what produced $0 revenue on Apex, is gone");
}

// ── 5e. A field the feed lacks is dropped, never rendered as zero ───────────
{
  const R = (() => {
    const m = /function wizardNormalizeKey\(k\) \{[\s\S]*?\nfunction wizardRepairConfigFields\(config, schemas\) \{[\s\S]*?\n\}/.exec(SERVER);
    assert.ok(m, "could not lift wizardRepairConfigFields");
    return vm.runInThisContext("(function(){" + m[0] + "\nreturn { wizardRepairConfigFields };})")();
  })();
  const schemas = { programs: { fields: [
    { name: "net_total" }, { name: "enrolled" }, { name: "capacity" }, { name: "program" },
  ] } };

  // Case/underscore differences are REPAIRED, because the column is really there.
  const cfg = { widgets: [{ type: "kpi-row", source: "programs", items: [
    { label: "Revenue", field: "Net Total", compute: "sum" },
    { label: "Enrolled", field: "ENROLLED", compute: "sum" },
    { label: "Programs", field: "Program", compute: "countDistinct" },
  ] }] };
  const dropped1 = R.wizardRepairConfigFields(cfg, schemas);
  is(dropped1, [], "a name differing only by case or underscores is repaired, not dropped");
  is(cfg.widgets[0].items.map(i => i.field), ["net_total", "enrolled", "program"],
     "…rewritten to the column the feed actually has");

  // A name the feed has nothing like is DROPPED. This is the Apex case exactly.
  const cfg2 = { widgets: [{ type: "kpi-row", source: "programs", items: [
    { label: "Total Net Revenue", field: "Net Amount", compute: "sum" },
    { label: "Total Enrollments", field: "Registrations", compute: "sum" },
    { label: "Total Capacity", field: "capacity", compute: "sum" },
  ] }] };
  const dropped2 = R.wizardRepairConfigFields(cfg2, schemas);
  is(cfg2.widgets[0].items.map(i => i.field), ["capacity"],
     "THE APEX CASE: 'Net Amount' and 'Registrations' are not columns in programs, so they are "
     + "dropped rather than rendering $0 and 0 beside real figures");
  is(dropped2.length, 2, "…and both are reported");
  ok(dropped2.every(d => /not a column in programs/.test(d)),
     "…naming the source, so the reason is actionable");

  // A widget with nothing left to draw goes entirely.
  const cfg3 = { widgets: [
    { type: "kpi-row", source: "programs", items: [{ label: "x", field: "Nonsense" }] },
    { type: "table", source: "programs", columns: [{ field: "program", label: "P" }] },
  ] };
  R.wizardRepairConfigFields(cfg3, schemas);
  is(cfg3.widgets.length, 1, "an empty widget is removed — worse than no widget");
  is(cfg3.widgets[0].type, "table", "…and the one that still has columns survives");

  // A filter on a missing column would match nothing, so the FILTER goes and the
  // widget stays: unfiltered is meaningful, empty is not.
  const cfg4 = { widgets: [{ type: "table", source: "programs",
    columns: [{ field: "program", label: "P" }],
    filter: [{ field: "Ghost", op: "eq", value: "x" }] }] };
  R.wizardRepairConfigFields(cfg4, schemas);
  is(cfg4.widgets.length, 1, "the widget survives a bad filter");
  is(cfg4.widgets[0].filter, null, "…with the filter removed rather than matching zero rows");

  // An UNKNOWN source is left alone — the repair only knows about sources it was
  // given a schema for, and guessing there would delete good widgets.
  const cfg5 = { widgets: [{ type: "kpi-row", source: "somethingelse",
    items: [{ label: "x", field: "Whatever" }] }] };
  is(R.wizardRepairConfigFields(cfg5, schemas), [],
     "a source with no schema is not second-guessed");
  is(cfg5.widgets[0].items.length, 1, "…and its widget is untouched");
}

// ── 6. The page reads them, and its floor is safe ───────────────────────────
{
  src(/prompts: wizardPromptsFor\(wizardKnownSources\(slug, org\), wizardVerticalsFor\(slug\),\n\s*wizardConfiguredSources\(org\)\)/.test(SERVER),
     "the page route injects the org's prompts, with BOTH tiers — known sources for the specific "
     + "claims and configured ones for the floor");
  src(/function wizardKnownSources\(/.test(SERVER) && !/await/.test(
        /function wizardKnownSources\([\s\S]*?\n\}/.exec(SERVER)[0]),
     "…computed WITHOUT awaiting anything: a page load that fired twelve Metabase queries to decide "
     + "which chips to draw would be a worse bug than the one this fixes");
  src(/var TYPING_PROMPTS = orgPrompts\('typed', TYPING_PROMPTS_FALLBACK\);/.test(WIZARD),
     "the typed animation reads the injected list");
  src(/var EXAMPLES = orgPrompts\('chip', EXAMPLES_FALLBACK\);/.test(WIZARD),
     "…and so do the chips");

  // THE PAGE'S OWN FLOOR MUST NOT BREAK THE RULE EITHER. The old static lists
  // named GL, city demographics, Fast Track and product sales — sources plenty
  // of orgs do not have — so the last resort could itself surface a prompt that
  // fails.
  const floors = [
    /var TYPING_PROMPTS_FALLBACK = \[([\s\S]*?)\];/.exec(WIZARD),
    /var EXAMPLES_FALLBACK = \[([\s\S]*?)\];/.exec(WIZARD),
  ];
  for (const f of floors) {
    ok(f, "both fallback lists exist");
    ok(!/GL account|demographic|Fast Track|product sales|by gender|by city|Facility rental/i.test(f[1]),
       "a fallback prompt may not name a source an org might not have — it is the last resort and "
       + "has to be the safest list on the page, not the most interesting one:\n" + f[1].trim());
  }
}

// ── 7. LIVE: drive the real page for three orgs with three real mixes ───────
// The unit assertions above ALL PASSED while every org was served an identical
// prompt list with no vertical in it. The verticals were being read from the
// cache after the probe, and a schema probe stores nothing — so the map was
// always empty. Only driving the real route for more than one org shows that.
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

(async () => {
  const PORT = 3986;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wizprompt-"));

  const ORGS = (() => {
    const i = SERVER.indexOf("const ORGS = {");
    const j = SERVER.indexOf("\nconst REPORT_TYPES", i);
    return vm.runInNewContext("(" + SERVER.slice(SERVER.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
  })();
  const byOrgId = {};
  for (const [slug, o] of Object.entries(ORGS)) if (o && o.orgId) byOrgId[o.orgId] = slug;

  // Three orgs, three MEASURED mixes. Douglas has no pool; Clarksville has no
  // campsite and only 8 field rows; the third has everything.
  const pick = (want) => Object.keys(ORGS).filter(k => ORGS[k] && ORGS[k].token && ORGS[k].orgId)[want];
  const A = "douglas-county-nv", B = "clarksville";
  const C = pick(0) === A || pick(0) === B ? pick(2) : pick(0);
  const MIX = {
    [A]: { campsite: 573, field: 302, court: 51, "outdoor-event-space": 49, room: 100 },
    [B]: { pool: 359, "outdoor-event-space": 307, field: 8, room: 199 },
    [C]: { court: 400, rink: 120, pool: 90, field: 200, "outdoor-event-space": 60 },
  };
  const rowsFor = slug => {
    const out = [];
    for (const [t, c] of Object.entries(MIX[slug] || {}))
      for (let k = 0; k < c; k++) out.push({ "Site Type": t, Facility: t + " " + k });
    return out;
  };

  const FACILITY_UUID = /facility: "([^"]+)"/.exec(SERVER)[1];
  const stub = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (!/\/query\/json/.test(req.url)) return res.end(JSON.stringify({ parameters: [] }));
    const m = /parameters=([^&]*)/.exec(req.url);
    let slug = null;
    if (m) { try { for (const q of JSON.parse(decodeURIComponent(m[1]))) if (byOrgId[q.value]) slug = byOrgId[q.value]; } catch (e) {} }
    if (slug && MIX[slug] && req.url.includes(FACILITY_UUID)) return res.end(JSON.stringify(rowsFor(slug)));
    res.end(JSON.stringify([{ A: 1, B: "x" }, { A: 2, B: "y" }]));
  });
  await new Promise(r => stub.listen(0, "127.0.0.1", r));

  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir,
      METABASE_URL: `http://127.0.0.1:${stub.address().port}`,
      ANTHROPIC_API_KEY: "sk-ant-spec-not-called",
      WIZARD_PROBE_TIMEOUT_MS: "4000", WIZARD_SCHEMA_FAIL_TTL_MS: "1",
      RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const req = (method, p, body) => new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 120000,
      headers: body ? { "Content-Type": "application/json" } : {} },
      x => { let b = ""; x.on("data", d => b += d); x.on("end", () => res({ status: x.statusCode, body: b })); });
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    r.end(body ? JSON.stringify(body) : undefined);
  });

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("no boot\n" + log.slice(-500)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });

    const promptsOf = async slug => {
      const tok = ORGS[slug].token;
      await req("POST", `/${slug}/report-wizard/api/generate?token=${encodeURIComponent(tok)}`, { prompt: "x" });
      const pg = await req("GET", `/${slug}/report-wizard?token=${encodeURIComponent(tok)}`);
      const cfg = JSON.parse(/window\.ORG_CONFIG=(\{.*?\});<\/script>/.exec(pg.body)[1]);
      return cfg.prompts || {};
    };

    const a = await promptsOf(A), b = await promptsOf(B), c = await promptsOf(C);
    const allOf = p => (p.chips || []).concat(p.typed || []);

    ok(allOf(a).some(t => /campsite/i.test(t)), `${A} is offered campsites`);
    ok(!allOf(a).some(t => /pool|aquatic/i.test(t)), `${A} is NOT offered a pool — they have none`);
    ok(!allOf(a).some(t => /\brink\b|ice /i.test(t)), `${A} is not offered ice either`);

    ok(allOf(b).some(t => /pool|aquatic/i.test(t)), `${B} is offered aquatics`);
    ok(!allOf(b).some(t => /campsite/i.test(t)), `${B} is NOT offered campsites`);
    ok(!allOf(b).some(t => /\bfield/i.test(t)),
       `${B} is not offered fields either — 8 rows in a year is under the floor`);

    ok(allOf(c).some(t => /pool|aquatic/i.test(t)) && allOf(c).some(t => /rink|ice /i.test(t)),
       "the org with everything gets everything");

    // THE ASSERTION THAT CAUGHT THE REAL BUG: three orgs, three different lists.
    ok(JSON.stringify(a.chips) !== JSON.stringify(b.chips),
       "TWO ORGS WITH DIFFERENT DATA MUST NOT GET THE SAME CHIPS. Every unit assertion above "
       + "passed while all three orgs were served an identical list — the verticals were read from "
       + "the cache after the probe, and a schema probe stores nothing, so the map was always empty");
    ok(JSON.stringify(a.typed) !== JSON.stringify(b.typed), "…nor the same typed lines");

    // And the store carries the verticals across a restart, so a cold page load
    // still knows the org has a campground.
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, "wizard-schemas.json"), "utf8"));
    ok(store[A] && store[A]._verticals && store[A]._verticals.verticals.camping,
       "the verticals are remembered on the volume — the page route reads them without probing, so "
       + "a cold load must not lose the campground");
    ok(!(store[B] && store[B]._verticals && store[B]._verticals.verticals.camping),
       "…per org, not globally");
  } finally {
    child.kill("SIGKILL");
    await new Promise(r => stub.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log("✓ wizard-prompts.spec.js — " + n + " assertions");
})().catch(e => { console.error(e); process.exit(1); });
