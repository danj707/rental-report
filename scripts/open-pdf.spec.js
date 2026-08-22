// Spec for public/open-pdf.js — the PDF export path for every report page.
//
// The bug it fixes: report pages run inside a sandboxed iframe, where a
// download started by the frame is silently dropped. Every PDF button did
// fetch -> blob -> <a download>.click(), so nothing happened, with no error.
// A top-level popup navigating to the PDF URL is not a download, so it works
// (court-utilization.html has always done it this way, and its PDF works).
//
// What this pins down, because both are easy to regress:
//  1. window.open happens SYNCHRONOUSLY, before anything async. A popup opened
//     after an await or a .then() has lost the user gesture and gets blocked —
//     re-introducing a fetch before the open would silently break every export.
//  2. A blocked popup returns false and tells the user, rather than restoring
//     the silent-failure behaviour this replaces.
//
// Run: node scripts/open-pdf.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "open-pdf.js"), "utf8");

// Minimal browser stand-in. Records the order of calls so the synchronous-open
// requirement can actually be asserted rather than eyeballed.
function load(opts) {
  opts = opts || {};
  const calls = [];
  const popup = {
    document: {
      write(html) { calls.push(["write", html]); popup._html = html; },
      close() { calls.push(["close"]); },
    },
    location: {
      replace(url) { calls.push(["replace", url]); },
      set href(url) { calls.push(["href", url]); },
    },
  };
  const win = {
    open(url, target) { calls.push(["open", url, target]); return opts.blocked ? null : popup; },
    alert(msg) { calls.push(["alert", msg]); },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  return { win, popup, calls, openReportPdf: win.openReportPdf };
}

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

const URL_WITH_TOKEN = "/norman/gl/api/pdf?start_date=2026-08-01&desks=A%2CB&token=abc123";

test("exposes openReportPdf on window", () => {
  assert.strictEqual(typeof load().openReportPdf, "function");
});

test("opens a blank popup FIRST, then navigates — never a fetch before the open", () => {
  const h = load();
  h.openReportPdf(URL_WITH_TOKEN, { label: "GL Code Rollup" });
  const order = h.calls.map(c => c[0]);
  assert.strictEqual(order[0], "open", "window.open must be the very first call");
  assert.deepStrictEqual(h.calls[0].slice(1), ["", "_blank"], "opens blank, in a new window");
  assert.ok(order.indexOf("replace") > order.indexOf("open"), "navigation comes after the open");
});

test("navigates the popup to the exact URL it was given, token intact", () => {
  const h = load();
  h.openReportPdf(URL_WITH_TOKEN, { label: "GL" });
  const nav = h.calls.find(c => c[0] === "replace");
  assert.ok(nav, "should navigate the popup");
  assert.strictEqual(nav[1], URL_WITH_TOKEN);
});

test("returns true when a window was opened", () => {
  assert.strictEqual(load().openReportPdf(URL_WITH_TOKEN, { label: "GL" }), true);
});

test("a blocked popup returns false and says so — never silent, which was the bug", () => {
  const h = load({ blocked: true });
  assert.strictEqual(h.openReportPdf(URL_WITH_TOKEN, { label: "GL" }), false);
  const alerted = h.calls.find(c => c[0] === "alert");
  assert.ok(alerted, "should tell the user");
  assert.match(alerted[1], /pop-?ups/i, "should name the actual remedy");
  assert.ok(!h.calls.some(c => c[0] === "replace"), "nothing to navigate");
});

test("the placeholder names the document and offers a manual fallback link", () => {
  const h = load();
  h.openReportPdf(URL_WITH_TOKEN, { label: "Instructor Payout" });
  const html = h.popup._html;
  assert.match(html, /Building your PDF/);
  assert.match(html, /Instructor Payout/);
  assert.match(html, /<a href="/, "carries a link in case the scripted navigation is refused");
});

test("the URL is HTML-escaped into the placeholder, so & cannot break the markup", () => {
  const h = load();
  h.openReportPdf("/x/api/pdf?a=1&b=2", { label: 'Report "quoted" <tag>' });
  const html = h.popup._html;
  assert.match(html, /href="\/x\/api\/pdf\?a=1&amp;b=2"/);
  assert.ok(!/<tag>/.test(html), "label must not inject markup");
  assert.match(html, /&lt;tag&gt;/);
});

test("defaults the label when none is passed", () => {
  const h = load();
  h.openReportPdf("/x/api/pdf");
  assert.match(h.popup._html, /Report/);
});

test("loading it twice does not clobber the first definition", () => {
  const h = load();
  const first = h.win.openReportPdf;
  vm.runInContext(SRC, h.win);
  assert.strictEqual(h.win.openReportPdf, first);
});

// ── The pages must actually use it, and must not still be blob-downloading PDFs ──
const PAGES = ["directors-report", "facilities", "facility", "fasttrack", "gl", "historic",
               "index", "instructor-payout", "lessons", "memberships", "products",
               "programs", "roster", "users"];

PAGES.forEach(page => {
  test(`${page}.html calls openReportPdf and loads the helper`, () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", page + ".html"), "utf8");
    assert.match(html, /openReportPdf\(/, "should route its PDF through the helper");
    assert.match(html, /<script src="\/open-pdf\.js"/, "should load open-pdf.js");
  });
});

test("no report page downloads a PDF through a blob + <a download> any more", () => {
  const offenders = [];
  fs.readdirSync(path.join(__dirname, "..", "public"))
    .filter(f => f.endsWith(".html"))
    .forEach(f => {
      const html = fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
      // .pdf filenames assigned to a download attribute — the blocked pattern.
      const re = /\.download\s*=\s*[^;\n]*\.pdf/g;
      let m;
      while ((m = re.exec(html)) !== null) offenders.push(f + ": " + m[0].trim().slice(0, 60));
    });
  // facility.html's permits export is a POST with a body, so it cannot be a
  // plain popup navigation — it is knowingly out of scope here.
  const unexpected = offenders.filter(o => !o.startsWith("facility.html"));
  assert.deepStrictEqual(unexpected, [], "these still use the blocked download path");
});

console.log(`\n${passed}/${passed} passing`);
