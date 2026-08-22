// Spec for the GL saved-views helpers in public/gl.html.
//
// Two invariants this pins down, both of which fail silently if they break:
//
//  1. The client's resolveSavedRange() is a hand-written mirror of the server's
//     getDateRange(). If they diverge, a saved view named "Last month" opens on
//     one window on screen and a different one in the emailed report — and
//     nothing errors.
//  2. The filter query string the page builds must survive the server's
//     allowlist byte-for-byte. The "edited" marker is a string comparison
//     against the stored params, so a single encoding difference would make
//     every freshly-saved view read as dirty the instant it is applied.
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
  const exposed = ["resolveSavedRange", "parseViewParams", "viewFilterSummary", "viewDateLabel", "SAVED_VIEW_RANGES"];
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

const H = loadClientHelpers();
const getDateRange = loadServerGetDateRange();

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// Every token the picker offers, plus last7 — accepted server-side and by the
// client mirror even though the dropdown doesn't list it.
const TOKENS = ["today", "yesterday", "prior7", "prior30", "last7", "lastMonth"];

test("every offered range is a token the server also understands", () => {
  H.SAVED_VIEW_RANGES.forEach(([token]) => assert.ok(TOKENS.includes(token), `unknown token ${token}`));
});

TOKENS.forEach(token => {
  test(`resolveSavedRange("${token}") matches the server's getDateRange`, () => {
    const client = H.resolveSavedRange(token);
    const server = getDateRange(token);
    assert.strictEqual(client.start, server.start, `${token} start`);
    assert.strictEqual(client.end, server.end, `${token} end`);
  });
});

test("an unknown token falls back to lastMonth, like the server", () => {
  assert.deepStrictEqual(
    { s: H.resolveSavedRange("nonsense").start, e: H.resolveSavedRange("nonsense").end },
    { s: getDateRange("nonsense").start, e: getDateRange("nonsense").end }
  );
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
  assert.strictEqual(H.viewDateLabel({ dateMode: "current" }), "current range");
  assert.strictEqual(H.viewDateLabel({ dateMode: "relative", relativeRange: "lastMonth" }), "Last month");
  const fixed = H.viewDateLabel({ dateMode: "fixed", fixedStart: "2025-07-01", fixedEnd: "2025-09-30" });
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

console.log(`\n${passed}/${passed} passing`);
