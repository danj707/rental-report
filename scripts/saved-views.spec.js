// Spec for saved views — the shared date helpers, plus the GL and Class Roster
// pages that use them.
//
// Four invariants this pins down, all of which fail silently if they break:
//
//  1. resolveSavedRange() is a hand-written mirror of the server's
//     getDateRange(). If they diverge, a saved view named "Last month" opens on
//     one window on screen and a different one in the emailed report — and
//     nothing errors. It now lives in public/saved-views.js so there is ONE
//     mirror rather than one per report page, and this spec fails if a page
//     grows its own copy back.
//  2. The filter query string a page builds must survive the server's allowlist
//     byte-for-byte. The "edited" marker is a string comparison against the
//     stored params, so a single encoding difference would make every
//     freshly-saved view read as dirty the instant it is applied.
//  3. Every relative range a page OFFERS must be one the server will actually
//     store. This was broken: gl.html hardcoded "Today" in its dropdown, and
//     REPORT_BLOCKED_RANGES has always rejected it, so saving that view failed
//     with a message about 7am email sends. The offered list is now injected
//     from the server (SAVED_VIEW_RELATIVE_OFFER), and the check below is what
//     makes a future mismatch a test failure rather than a support ticket.
//  4. A ROSTER view carries filters only. Its column toggles and question
//     picker are per-browser display state, and a shared view that overwrote
//     them would take a colleague's chosen columns away.
//
// Run: node scripts/saved-views.spec.js
// Needs @babel/standalone (CI installs it for the JSX check):
//   npm install --no-save @babel/standalone@7.23.9
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let Babel;
try { Babel = require("@babel/standalone"); }
catch { console.log("skipped — @babel/standalone not installed (npm install --no-save @babel/standalone@7.23.9)"); process.exit(0); }

const ROOT = path.join(__dirname, "..");

// ── Pull the real helpers out of the page, rather than restating them here ──
function loadClientHelpers() {
  const html = fs.readFileSync(path.join(ROOT, "public", "gl.html"), "utf8");
  const block = /<script[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(block, "gl.html should contain a text/babel block");
  const { code } = Babel.transform(block[1], { presets: ["react"] });
  // Stubs: the module-scope code only defines things and calls createRoot().render()
  // at the very end, so nothing inside a component body actually runs here.
  const stubs = {
    React: { createElement: () => null, useState: () => [null, () => {}], useEffect() {}, useMemo() {},
             useRef: () => ({ current: null }), useCallback: f => f, Fragment: "F" },
    ReactDOM: { createRoot: () => ({ render() {} }) },
    document: { getElementById: () => ({}), body: { classList: { add() {} } }, addEventListener() {}, removeEventListener() {} },
    window: { location: { pathname: "/norman/gl", search: "" }, history: { replaceState() {} }, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({ ok: false, json: () => ({}) }),
    URL_TOKEN: "", ORG_CONFIG: {},
  };
  // resolveSavedRange / viewDateLabel now delegate to /saved-views.js, which the
  // shared-helper loader covers directly — what is lifted here is GL's OWN
  // filter vocabulary plus its multi-select reconcile.
  const exposed = ["parseViewParams", "viewFilterSummary", "reconcileFilterSelection",
                   "savedViewRanges", "defaultSavedRange"];
  const names = Object.keys(stubs);
  return new Function(...names, code + "\nreturn {" + exposed.join(",") + "};")(...names.map(n => stubs[n]));
}

// ── The server's getDateRange(), lifted from server.js so the comparison is
//    against the shipping implementation and not a copy of it ──
function loadServerGetDateRange() {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const from = src.indexOf("function toISO(d) {");
  const to = src.indexOf("// Render a self-contained HTML string to PDF");
  assert.ok(from > 0 && to > from, "server.js should still contain toISO + getDateRange");
  return new Function(src.slice(from, to) + "\nreturn getDateRange;")();
}

// ── The shared date helpers, loaded as the plain script they are ────────────
function loadSharedHelpers() {
  const src = fs.readFileSync(path.join(ROOT, "public", "saved-views.js"), "utf8");
  const win = {};
  new Function("window", src)(win);
  assert.ok(win.RecSavedViews, "saved-views.js should define window.RecSavedViews");
  return win.RecSavedViews;
}

// A stand-in for what the server injects, so defaultSavedRange() can be RUN.
const OFFERED_FOR_TEST = [["next14", "Next 14 days"], ["prior7", "Prior 7 days"]];

// ── The roster's own two helpers, text-sliced rather than Babel-transformed:
//    they are plain functions and the page around them is a React tree ────────
function loadRosterHelpers() {
  const src = fs.readFileSync(path.join(ROOT, "public", "roster.html"), "utf8");
  const from = src.indexOf("function savedViewRanges() {");
  assert.ok(from > 0, "roster.html should declare savedViewRanges");
  const to = src.indexOf("\n}", src.indexOf("function viewFilterSummary("));
  assert.ok(to > from, "roster.html should declare viewFilterSummary after it");
  // savedViewRanges() reads window.ORG_CONFIG, so hand it a controllable one.
  return new Function("window", src.slice(from, to + 2)
    + "\nreturn { ROSTER_VIEW_PARAMS, parseViewParams, viewFilterSummary, ROSTER_STATUS_LABELS,"
    + " savedViewRanges, defaultSavedRange };")({ ORG_CONFIG: { savedViewRanges: OFFERED_FOR_TEST } });
}

// ── The server's saved-view registries, lifted so the comparison is against
//    the shipping constants and not a copy of them ─────────────────────────────
function loadServerRegistries() {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const from = src.indexOf("const SAVED_VIEW_PARAMS = {");
  const to = src.indexOf("function savedViewsGate(");
  assert.ok(from > 0 && to > from, "server.js should still declare the saved-view registries");
  const blocked = /const REPORT_BLOCKED_RANGES = \{[\s\S]*?\n\};/.exec(src);
  assert.ok(blocked, "server.js should still declare REPORT_BLOCKED_RANGES");
  const reason = /const GL_RANGE_REASON = [\s\S]*?;\n/.exec(src);
  return new Function(
    (reason ? reason[0] : "const GL_RANGE_REASON='';") + blocked[0] + src.slice(from, to)
    + "\nreturn { SAVED_VIEW_PARAMS, SAVED_VIEW_RELATIVE_ACCEPT, SAVED_VIEW_RELATIVE_OFFER, REPORT_BLOCKED_RANGES };")();
}

const H = loadClientHelpers();
const S = loadSharedHelpers();
const R = loadRosterHelpers();
const REG = loadServerRegistries();
const getDateRange = loadServerGetDateRange();

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// EVERY token the shared resolver knows — not a list retyped here, so a token
// added to one side without the other fails rather than going unchecked.
const TOKENS = Object.keys(S.RANGE_LABELS);

test("the resolver knows the forward ranges a roster needs, and the backward ones GL needs", () => {
  ["next7", "next14", "next30"].forEach(t => assert.ok(TOKENS.includes(t), `missing ${t}`));
  ["lastMonth", "prior7", "prior30"].forEach(t => assert.ok(TOKENS.includes(t), `missing ${t}`));
});

TOKENS.forEach(token => {
  test(`resolveSavedRange("${token}") matches the server's getDateRange`, () => {
    const client = S.resolveSavedRange(token);
    const server = getDateRange(token);
    assert.strictEqual(client.start, server.start, `${token} start`);
    assert.strictEqual(client.end, server.end, `${token} end`);
  });
});

test("an unknown token falls back to lastMonth, like the server", () => {
  assert.deepStrictEqual(
    { s: S.resolveSavedRange("nonsense").start, e: S.resolveSavedRange("nonsense").end },
    { s: getDateRange("nonsense").start, e: getDateRange("nonsense").end }
  );
});

// ── ONE mirror, not one per page ──────────────────────────────────────────────
// Both pages must delegate. A page that reimplements the resolver drifts the
// first time a token is added to one of them, and the drift is silent.
["gl.html", "roster.html"].forEach(page => {
  test(`${page} delegates the resolver instead of reimplementing it`, () => {
    const src = fs.readFileSync(path.join(ROOT, "public", page), "utf8");
    assert.match(src, /function resolveSavedRange\(token\) \{ return RecSavedViews\.resolveSavedRange\(token\); \}/,
      "should be a thin wrapper over the shared helper");
    assert.ok(!/if \(token === 'prior30'\)/.test(src),
      "the page must not carry its own copy of the range arithmetic");
    assert.match(src, /<script src="\/saved-views\.js" defer><\/script>/,
      "…and must actually load the shared file");
  });
});

// ── Offered ⊆ storable. This is the bug that prompted the registry ────────────
Object.keys(REG.SAVED_VIEW_RELATIVE_OFFER).forEach(report => {
  test(`every range ${report} OFFERS is one the server will store`, () => {
    const accept = REG.SAVED_VIEW_RELATIVE_ACCEPT[report] || [];
    const blocked = REG.REPORT_BLOCKED_RANGES[report] || {};
    REG.SAVED_VIEW_RELATIVE_OFFER[report].forEach(([token, label]) => {
      assert.ok(accept.includes(token),
        `${report} offers "${token}" but SAVED_VIEW_RELATIVE_ACCEPT does not list it`);
      assert.ok(!blocked[token],
        `${report} offers "${token}" but REPORT_BLOCKED_RANGES rejects it — the save dialog `
        + "would show an option that always errors (this is exactly what gl.html did with Today)");
      assert.ok(S.RANGE_LABELS[token], `${report} offers "${token}" with no shared label`);
      assert.ok(label && label.length, `${report} offers "${token}" with no wording`);
    });
  });
});

test("a roster reads FORWARD and leads with its own default window", () => {
  const offer = REG.SAVED_VIEW_RELATIVE_OFFER.roster.map(([t]) => t);
  assert.strictEqual(offer[0], "next14",
    "the first option is the dialog's default, and it should be the fortnight the report itself opens on");
  assert.ok(offer.includes("next7") && offer.includes("next30"), "the forward ranges are the point");
});

test("next14 is the same fortnight the roster itself defaults to", () => {
  // ROSTER_DEFAULT_DAYS lives in the page; the range lives on the server. Two
  // numbers for one window would drift, so compare them.
  const page = fs.readFileSync(path.join(ROOT, "public", "roster.html"), "utf8");
  const m = /const ROSTER_DEFAULT_DAYS = (\d+);/.exec(page);
  assert.ok(m, "roster.html should declare ROSTER_DEFAULT_DAYS");
  const r = getDateRange("next14");
  const days = Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86400000) + 1;
  assert.strictEqual(days, Number(m[1]),
    "next14 must span exactly ROSTER_DEFAULT_DAYS days, or the view opens on a different window than the report does");
});

test("GL only looks backwards, and no longer offers a range it refuses", () => {
  const offer = REG.SAVED_VIEW_RELATIVE_OFFER.gl.map(([t]) => t);
  assert.ok(!offer.includes("today"),
    "Today was offered and always rejected — the option has to go, not the guard");
  assert.ok(!offer.some(t => /^next/.test(t)), "a GL rollup has nothing in a future window");
});

test("parseViewParams round-trips a stored filter string", () => {
  const f = H.parseViewParams("desks=Community+Recreation+Center&methods=cash%2Ccheck&glq=41&tyler=1");
  assert.deepStrictEqual(f.desks, ["Community Recreation Center"]);
  assert.deepStrictEqual(f.methods, ["cash", "check"]);
  assert.strictEqual(f.glq, "41");
  assert.strictEqual(f.tyler, true);
});

test("parseViewParams treats an empty view as no filters at all", () => {
  const f = H.parseViewParams("");
  assert.strictEqual(f.desks, null);
  assert.strictEqual(f.methods, null);
  assert.strictEqual(f.glq, "");
  assert.strictEqual(f.tyler, false);
});

test("viewDateLabel prints a pinned range and never disguises it as live", () => {
  assert.strictEqual(S.viewDateLabel({ dateMode: "current" }), "current range");
  assert.strictEqual(S.viewDateLabel({ dateMode: "relative", relativeRange: "lastMonth" }), "Last month");
  const fixed = S.viewDateLabel({ dateMode: "fixed", fixedStart: "2025-07-01", fixedEnd: "2025-09-30" });
  assert.match(fixed, /^📌 /);
  assert.match(fixed, /2025/);
});

test("viewFilterSummary reads as a sentence, and says so when empty", () => {
  assert.strictEqual(
    H.viewFilterSummary({ params: "desks=A%20Desk&methods=cash,check&glq=41" }, { cash: "Cash", check: "Check" }),
    'A Desk · Cash, Check · "41"'
  );
  assert.strictEqual(H.viewFilterSummary({ params: "" }, {}), "no filters");
});

// ── The dirty check is a string comparison, so encoding has to agree ──
// Mirrors SAVED_VIEW_PARAMS.gl + cleanViewParams() in server.js.
const ALLOW = ["desks", "methods", "glq", "tyler"];
function serverClean(raw) {
  const supplied = new URLSearchParams(String(raw || ""));
  const out = new URLSearchParams();
  for (const key of ALLOW) {
    const v = supplied.get(key);
    if (v === null) continue;
    const val = String(v).trim();
    if (!val || val === "null" || val === "undefined") continue;
    out.set(key, val.slice(0, 600));
  }
  return out.toString();
}
function clientBuild({ desks, methods, glq, tyler }) {
  const p = new URLSearchParams();          // same key order as ALLOW
  if (desks)   p.set("desks", desks.join(","));
  if (methods) p.set("methods", methods.join(","));
  if (glq)     p.set("glq", glq);
  if (tyler)   p.set("tyler", "1");
  return p.toString();
}

[
  { desks: ["Community Recreation Center", "Simms St"], methods: ["cash", "check"], glq: "41" },
  { desks: ["Ice Arena"] },
  { methods: ["cc_online"] },
  { glq: "4100 revenue" },
  { desks: ["Café & Pro Shop"], glq: "50%", tyler: true },
].forEach((sel, i) => {
  test(`filter string ${i + 1} survives the server allowlist byte-for-byte`, () => {
    const built = clientBuild(sel);
    assert.strictEqual(serverClean(built), built);
  });
});

test("the allowlist drops report plumbing a client might smuggle in", () => {
  const cleaned = serverClean("desks=A&token=secret&_print=1&_nocache=1&evil=1&start_date=2026-01-01");
  assert.strictEqual(cleaned, "desks=A");
});

// ── The ROSTER's own filter vocabulary ────────────────────────────────────────
test("a roster view carries the two FILTERS and nothing else", () => {
  assert.deepStrictEqual(REG.SAVED_VIEW_PARAMS.roster, ["section_name", "status"],
    "the server's allowlist is the definition of what a roster view can hold");
  assert.deepStrictEqual(R.ROSTER_VIEW_PARAMS, ["section_name", "status"],
    "and the page's list of keys to clear on apply has to match it, or applying a "
    + "view leaves a stale filter in the URL");
});

test("column toggles and the question picker are NOT saved", () => {
  // They persist per browser in localStorage. A shared view that carried them
  // would take a colleague's chosen columns away when they opened it.
  ["cols", "questions"].forEach(k => {
    assert.ok(!REG.SAVED_VIEW_PARAMS.roster.includes(k),
      `"${k}" is display state and must not travel in a shared view`);
  });
});

test("the dialog's default range is the first the server offers, not a name in the page", () => {
  // A hardcoded default can fall outside the offered list the moment the list
  // changes — which is how "Today" survived in gl.html.
  assert.strictEqual(R.defaultSavedRange(), "next14");
  assert.deepStrictEqual(R.savedViewRanges(), OFFERED_FOR_TEST,
    "the page must read the injected list rather than carrying its own");
  ["gl.html", "roster.html"].forEach(page => {
    const src = fs.readFileSync(path.join(ROOT, "public", page), "utf8");
    assert.ok(!/relativeRange: '(lastMonth|next14|today)'/.test(src),
      `${page} must not name a default range inline — it comes from defaultSavedRange()`);
  });
});

test("roster parseViewParams round-trips a stored filter string", () => {
  const f = R.parseViewParams("section_name=After+School+Care&status=enrolled");
  assert.strictEqual(f.section_name, "After School Care");
  assert.strictEqual(f.status, "enrolled");
});

test("roster viewFilterSummary reads as a sentence, and says so when empty", () => {
  assert.strictEqual(R.viewFilterSummary({ params: "section_name=Camp%20Blue&status=cancelled" }),
    '"Camp Blue" · Cancelled only');
  assert.strictEqual(R.viewFilterSummary({ params: "" }), "no filters");
  // `all` is the ABSENCE of a status filter, so naming it would make every
  // unfiltered view read as filtered.
  assert.strictEqual(R.viewFilterSummary({ params: "status=all" }), "no filters");
});

// The dirty marker is a string comparison against the stored params, so what the
// page builds has to survive the server's allowlist byte-for-byte — otherwise a
// view reads as "edited" the instant it is applied.
function rosterServerClean(raw) {
  const supplied = new URLSearchParams(String(raw || ""));
  const out = new URLSearchParams();
  for (const key of REG.SAVED_VIEW_PARAMS.roster) {
    const v = supplied.get(key);
    if (v === null) continue;
    const val = String(v).trim();
    if (!val || val === "null" || val === "undefined") continue;
    out.set(key, val.slice(0, 600));
  }
  return out.toString();
}
function rosterClientBuild(section, status) {
  const qs = new URLSearchParams();          // same key order as the allowlist
  if (section && section.trim()) qs.set("section_name", section.trim());
  if (status && status !== "all") qs.set("status", status);
  return qs.toString();
}
[
  ["After School Care - Hackberry Hill Elementary School 2026-2027", "enrolled"],
  ["Camp, Red", "cancelled"],
  ["Café & Pro Shop 50%", "all"],
  ["", "cancelled"],
  ["Swim 101", "all"],
].forEach(([section, status], i) => {
  test(`roster filter string ${i + 1} survives the server allowlist byte-for-byte`, () => {
    const built = rosterClientBuild(section, status);
    assert.strictEqual(rosterServerClean(built), built);
  });
});

test("the roster allowlist drops report plumbing a client might smuggle in", () => {
  assert.strictEqual(
    rosterServerClean("section_name=Camp&token=secret&_print=1&cols=%7B%7D&start_date=2026-01-01&evil=1"),
    "section_name=Camp");
});

test("status=all is never stored — an unfiltered view must not look filtered", () => {
  assert.strictEqual(rosterClientBuild("Camp", "all"), "section_name=Camp");
});

// ── Filter reconcile ─────────────────────────────────────────────────
// Regression tests for a live bug: the "None" button did nothing and unchecking
// the last box re-checked everything. The reconcile below runs on data changes
// and has an "if nothing overlaps, show everything" fallback, which is right
// for new data. It was also running on every checkbox click, so an empty
// selection was instantly widened back to all.
const DESKS = ["Front Desk", "Ice Arena", "Simms St"];
const asSet = (a) => new Set(a);
const sorted = (s) => [...s].sort();

test("a plain checkbox click is left alone — this is the None-button bug", () => {
  // Cleared everything, data unchanged: the selection must stay empty.
  assert.strictEqual(
    H.reconcileFilterSelection({ available: DESKS, previous: asSet([]), requested: null, dataChanged: false }),
    null, "null means 'leave the selection exactly as it is'"
  );
});

test("a partial selection also survives a click when the data has not changed", () => {
  assert.strictEqual(
    H.reconcileFilterSelection({ available: DESKS, previous: asSet(["Ice Arena"]), requested: null, dataChanged: false }),
    null
  );
});

test("first load with nothing selected yet selects everything", () => {
  const out = H.reconcileFilterSelection({ available: DESKS, previous: null, requested: null, dataChanged: true });
  assert.deepStrictEqual(sorted(out), sorted(asSet(DESKS)));
});

test("a data change keeps the selection and prunes what is gone", () => {
  const out = H.reconcileFilterSelection({
    available: ["Front Desk", "Simms St"], previous: asSet(["Front Desk", "Ice Arena"]),
    requested: null, dataChanged: true,
  });
  assert.deepStrictEqual(sorted(out), ["Front Desk"]);
});

test("a data change with no overlap falls back to all rather than a blank report", () => {
  const out = H.reconcileFilterSelection({
    available: ["Pool", "Gym"], previous: asSet(["Front Desk"]), requested: null, dataChanged: true,
  });
  assert.deepStrictEqual(sorted(out), ["Gym", "Pool"]);
});

test("an empty selection is NOT widened just because a click happened", () => {
  // The same empty set, the only difference being dataChanged. This pair is the
  // bug: both used to take the widening branch.
  const onClick = H.reconcileFilterSelection({ available: DESKS, previous: asSet([]), requested: null, dataChanged: false });
  const onNewData = H.reconcileFilterSelection({ available: DESKS, previous: asSet([]), requested: null, dataChanged: true });
  assert.strictEqual(onClick, null, "click: untouched");
  assert.deepStrictEqual(sorted(onNewData), sorted(asSet(DESKS)), "new data: widened");
});

test("a requested set from a saved view wins, even on a click-shaped call", () => {
  const out = H.reconcileFilterSelection({
    available: DESKS, previous: asSet(DESKS), requested: ["Ice Arena"], dataChanged: false,
  });
  assert.deepStrictEqual(sorted(out), ["Ice Arena"]);
});

test("a requested set that resolves to nothing shows all — the warned-about case", () => {
  const out = H.reconcileFilterSelection({
    available: DESKS, previous: null, requested: ["Somewhere Else"], dataChanged: true,
  });
  assert.deepStrictEqual(sorted(out), sorted(asSet(DESKS)));
});

// ── Applying a view RESETS; it does not merge ────────────────────────
// "Default view" is a view that requests nothing, so it has to come back as
// everything. Passing previous:null is how the effects express "this is an
// apply" — a merge here is what left the old filter in place when someone
// switched back to Default view, or applied a view that filters only tenders.
test("Default view (an apply requesting nothing) resets to everything", () => {
  const out = H.reconcileFilterSelection({
    available: DESKS, previous: null, requested: null, dataChanged: true,
  });
  assert.deepStrictEqual(sorted(out), sorted(asSet(DESKS)), "no filters means all of them");
});

test("an apply ignores what was selected before rather than intersecting it", () => {
  // Same call shape the effects use on apply. If this ever honoured `previous`,
  // switching from a filtered view to Default view would keep the filter.
  const asApply = (requested) => H.reconcileFilterSelection({
    available: DESKS, previous: null, requested, dataChanged: true,
  });
  assert.deepStrictEqual(sorted(asApply(null)), sorted(asSet(DESKS)));
  assert.deepStrictEqual(sorted(asApply(["Ice Arena"])), ["Ice Arena"]);
});

test("a requested set is intersected with what the data offers", () => {
  const out = H.reconcileFilterSelection({
    available: DESKS, previous: null, requested: ["Ice Arena", "Somewhere Else"], dataChanged: true,
  });
  assert.deepStrictEqual(sorted(out), ["Ice Arena"]);
});

console.log(`\n${passed}/${passed} passing`);
