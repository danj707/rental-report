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

// ── Excel ────────────────────────────────────────────────────────────
// Same root cause as the PDF, but a spreadsheet cannot be rendered, so this
// path must end in a download and the popup is the only place with a chance of
// being allowed to start one. A blocked download is undetectable from script,
// so the popup must always leave the reader a way through — that is what these
// assertions protect.

function mockXLSX() {
  return {
    write: (wb, o) => { mockXLSX.lastOpts = o; return new Uint8Array([1, 2, 3]); },
    utils: { sheet_to_csv: (sheet, o) => (o && o.FS === "\t" ? "a\tb\nc\td" : "a,b") },
  };
}
const WB = { SheetNames: ["Sheet1"], Sheets: { Sheet1: { "!ref": "A1:B2" } } };

test("Excel: opens the popup FIRST, before building anything", () => {
  const h = load();
  h.win.saveWorkbookViaPopup(mockXLSX(), WB, "gl-report.xlsx");
  assert.strictEqual(h.calls[0][0], "open", "window.open must come first — building bytes takes time and loses the gesture");
  assert.deepStrictEqual(h.calls[0].slice(1), ["", "_blank"]);
});

test("Excel: hands the popup the bytes, a filename, and a TSV fallback", () => {
  const h = load();
  assert.strictEqual(h.win.saveWorkbookViaPopup(mockXLSX(), WB, "gl-report.xlsx"), true);
  const p = h.popup.__recExport;
  assert.ok(p, "the popup should receive a payload");
  assert.strictEqual(p.filename, "gl-report.xlsx");
  assert.ok(p.bytes && p.bytes.length, "file bytes");
  assert.strictEqual(p.tsv, "a\tb\nc\td", "tab-separated, so it pastes into cells rather than one column");
  assert.match(p.mime, /spreadsheetml/);
});

test("Excel: writes an xlsx array, not a browser-side writeFile", () => {
  const h = load();
  const X = mockXLSX();
  h.win.saveWorkbookViaPopup(X, WB, "x.xlsx");
  // Compared field-by-field: the options object is created inside the VM realm,
  // so deepStrictEqual would fail on prototypes alone.
  assert.strictEqual(mockXLSX.lastOpts.bookType, "xlsx");
  assert.strictEqual(mockXLSX.lastOpts.type, "array");
});

test("Excel: a blocked popup returns false and says so", () => {
  const h = load({ blocked: true });
  assert.strictEqual(h.win.saveWorkbookViaPopup(mockXLSX(), WB, "x.xlsx"), false);
  assert.ok(h.calls.some(c => c[0] === "alert"));
});

test("Excel: a build failure closes the popup instead of leaving a blank window", () => {
  const h = load();
  h.popup.close = () => h.calls.push(["close-window"]);
  const broken = { write: () => { throw new Error("boom"); }, utils: { sheet_to_csv: () => "" } };
  assert.strictEqual(h.win.saveWorkbookViaPopup(broken, WB, "x.xlsx"), false);
  assert.ok(h.calls.some(c => c[0] === "close-window"), "no orphaned blank popup");
  assert.ok(h.calls.some(c => c[0] === "alert" && /Could not build/.test(c[1])));
});

test("Excel: loading the helper twice does not clobber it", () => {
  const h = load();
  const first = h.win.saveWorkbookViaPopup;
  vm.runInContext(SRC, h.win);
  assert.strictEqual(h.win.saveWorkbookViaPopup, first);
});

// ── The popup's own script ────────────────────────────────────────────
// It ships to production and nothing else exercises it, so run it here against
// a stub DOM. A typo in this string is otherwise invisible until someone clicks.
function runPopupScript(payload) {
  const h = load();
  h.win.saveWorkbookViaPopup(mockXLSX(), WB, payload.filename || "x.xlsx");
  const html = h.popup._html;
  assert.ok(html, "the popup should have been written to");
  // The helper writes the closing tag as "<\\/script>" in its own source so the
  // literal sequence never appears inside a JS string; what reaches the popup is
  // an ordinary closing tag.
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "the popup document should carry one inline script");
  assert.ok(m[1].includes("__recExportStart"), "and that script defines the entry point");

  const els = {};
  const mk = id => (els[id] = { id, textContent: "", value: "", href: "", download: "",
                               clicked: 0, click() { this.clicked++; }, select() { this.selected = 1; }, onclick: null });
  ["fname", "tsv", "dl", "copy", "hint", "note"].forEach(mk);
  const clip = { written: null };
  const ctx = {
    window: null,
    document: { getElementById: id => els[id] || null },
    URL: { createObjectURL: () => "blob:mock" },
    Blob: function (parts, o) { this.parts = parts; this.type = o && o.type; },
    navigator: { clipboard: { writeText: t => { clip.written = t; return Promise.resolve(); } } },
    setTimeout: () => {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx);
  ctx.window.__recExport = h.popup.__recExport;
  ctx.window.__recStarted = 0;
  ctx.window.__recExportStart();
  return { els, clip, ctx };
}

test("popup script: labels the file, arms the link, and attempts the save once", () => {
  const { els } = runPopupScript({ filename: "gl-report.xlsx" });
  assert.strictEqual(els.fname.textContent, "gl-report.xlsx", "the reader can see what they are getting");
  assert.strictEqual(els.dl.download, "gl-report.xlsx");
  assert.strictEqual(els.dl.href, "blob:mock");
  assert.strictEqual(els.dl.clicked, 1, "exactly one automatic attempt");
});

test("popup script: the link stays clickable, so a blocked auto-save is recoverable", () => {
  const { els } = runPopupScript({});
  // The whole point: even after the scripted click is dropped, the anchor is a
  // real download link the user can press themselves.
  assert.ok(els.dl.href && els.dl.download, "link must remain armed after the attempt");
});

test("popup script: Copy for Excel puts tab-separated rows on the clipboard", () => {
  const { els, clip } = runPopupScript({});
  assert.strictEqual(typeof els.copy.onclick, "function", "the copy button must be wired");
  els.copy.onclick();
  assert.strictEqual(clip.written, "a\tb\nc\td");
  assert.strictEqual(els.tsv.value, "a\tb\nc\td", "and the textarea holds it for the manual path");
});

// ── No page may still write the file from the frame ──────────────────
test("no report page calls XLSX.writeFile directly any more", () => {
  const offenders = [];
  fs.readdirSync(path.join(__dirname, "..", "public"))
    .filter(f => f.endsWith(".html"))
    .forEach(f => {
      const html = fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
      if (/XLSX\.writeFile\(/.test(html)) offenders.push(f);
    });
  assert.deepStrictEqual(offenders, [], "these still save from inside the sandboxed frame");
});

test("every page that exports a workbook loads the helper", () => {
  const missing = [];
  fs.readdirSync(path.join(__dirname, "..", "public"))
    .filter(f => f.endsWith(".html"))
    .forEach(f => {
      const html = fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
      if (/saveWorkbookViaPopup\(/.test(html) && !/<script src="\/open-pdf\.js"/.test(html)) missing.push(f);
    });
  assert.deepStrictEqual(missing, []);
});

console.log(`\n${passed}/${passed} passing`);
