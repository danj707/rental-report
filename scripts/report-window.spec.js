#!/usr/bin/env node
/* ============================================================================
 * report-window.spec.js — a HALF-OPEN date window is refused, and the window
 * that was actually loaded is stamped into every Excel export.
 *
 * WHAT HAPPENED. Marina at Norman asked the Product Sales report for 1–31
 * August 2026 and got 1 August → today: 338 rows and $96,293.47 against
 * August's real $82,258.22, i.e. 17% high, with eleven days of September in a
 * file named "Aug 2026". Her End Date box was empty.
 *
 * THE MECHANISM, reproduced against card 17299 with start_date alone — 338
 * rows / $96,293.47, her file to the cent:
 *
 *   1. every report page omits a blank date from the query string
 *      (`if (ed) qs.set('end_date', ed)`),
 *   2. buildMetabaseParams only backfills a default window when BOTH dates are
 *      missing, so exactly one missing date falls through untouched, and
 *   3. the card's end bound lives in an optional `[[ ]]` block, which then
 *      drops out — so the report silently runs to today.
 *
 * Nothing warned her: the on-screen header rendered a dangling em dash
 * ("Friday, August 1, 2026 — ") and the sheet carried no window at all. The one
 * real tell was the auto filename (`products-daily-2026-08-01_all.xlsx`), and
 * she had renamed the file.
 *
 * WHAT THIS PINS:
 *
 *   1. BOTH BLANK IS LEGAL AND MUST STAY LEGAL. The waitlist report opens
 *      all-time, is in NO_DATE_REPORTS and carries its own "Clear dates" button;
 *      elsewhere both-blank hits the server's 7-day default. Neither is the bug.
 *      Only a HALF-OPEN window is refused. This is the assertion that fails if
 *      someone "tightens" the rule into "no blank dates".
 *   2. The window label is built from the date's own PARTS. `new Date("2026-08-01")`
 *      is UTC midnight and renders as July 31 west of UTC — five instances of
 *      that are already recorded in this repo, and one here would misname the
 *      very window this exists to state.
 *   3. Every page derives the problem, gates its Run on it, and SAYS WHY. A
 *      disabled control with no explanation is the dead end this repo keeps
 *      writing down, and it is how "I can't even click it" gets reported.
 *   4. Every Excel export stamps the loaded window at A1, with the table at A3.
 *   5. ...and every row-index format loop moved with it. A loop still bounded by
 *      `<= dataRows.length` silently stops two rows early, so the last two
 *      bookings lose their date or money format. Proven: with the naive bound,
 *      rows 5 and 6 of a 3-row table come back unformatted.
 *   6. THE ePACT CSV IS DELIBERATELY NOT STAMPED. It is a verified five-column
 *      upload to a HIPAA vendor that maps on position; a title line breaks the
 *      import. Same for the per-panel CSVs, which are rows-only by design.
 *
 * It LIFTS AND RUNS the three helpers rather than regexing them.
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

let pass = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else failures.push(msg); }
function eq(a, b, msg) { ok(a === b, msg + "  (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }

/* ── LIFT AND RUN the helpers ─────────────────────────────────────────────── */
const openPdf = read("public/open-pdf.js");
const sandbox = { window: {} };
// open-pdf.js is an IIFE plus a trailing function; running the whole file in a
// bare context is enough to publish the three helpers onto our fake window.
new Function("window", "document", openPdf)(sandbox.window, { addEventListener() {} });

const problem = sandbox.window.recWindowProblem;
const label   = sandbox.window.recWindowLabel;
const titles  = sandbox.window.recExportTitleRows;

ok(typeof problem === "function", "recWindowProblem is exported from open-pdf.js — the file every report page already loads");
ok(typeof label   === "function", "recWindowLabel is exported from open-pdf.js");
ok(typeof titles  === "function", "recExportTitleRows is exported from open-pdf.js");

/* 1 — both blank is the all-time / server-default case and is NOT a problem. */
eq(problem("", ""), "", "both dates blank is LEGAL — the waitlist report opens all-time and the server defaults its own 7-day window; refusing it would break a shipped feature");
eq(problem(null, undefined), "", "both dates missing is legal however they arrive");

/* 2 — the half-open window, both directions. This is the bug Marina hit. */
ok(problem("2026-08-01", "") !== "", "a start with no end is REFUSED — this is exactly what ran Norman's August through today");
ok(/through today/.test(problem("2026-08-01", "")), "...and the message names the CONSEQUENCE, not the rule — 'pick an end date' does not tell a reader what they are about to get");
ok(problem("", "2026-08-31") !== "", "an end with no start is refused — it runs from the beginning of the org's history");
ok(problem("2026-08-31", "2026-08-01") !== "", "an inverted window is refused — it returns nothing");

/* 3 — a real window passes, including a single day. */
eq(problem("2026-08-01", "2026-08-31"), "", "a complete window is not a problem");
eq(problem("2026-08-01", "2026-08-01"), "", "a single-day window is a real window");
eq(problem(" 2026-08-01 ", " 2026-08-31 "), "", "whitespace around a date is not a half-open window");

/* 4 — the label, built from PARTS. Aug 1 must never render as Jul 31. */
eq(label("2026-08-01", "2026-08-31"), "Aug 1, 2026 – Aug 31, 2026", "the window label is built from the date's own parts");
eq(label("2026-08-01", "2026-08-01"), "Aug 1, 2026", "a single-day window is named once, not as a range of one day to itself");
eq(label("", ""), "All dates", "an all-time window says so — that is an answer, not a missing value");
ok(/through today/.test(label("2026-08-01", "")), "a one-sided window is NAMED for what it covers, never left as a dangling dash — the dangling dash is what let a 41-day file pass for a 31-day one");
ok(!/Jul/.test(label("2026-08-01", "2026-08-31")), "Aug 1 does not render as July 31 — the UTC-midnight trap, five instances of which are already recorded here");

// The source half of the same claim: the parser may not reach for Date at all.
// Sliced to the two functions, because the comment above them quotes the broken
// form on purpose — a file-wide regex would fail on correct code.
const rwSlice = openPdf.slice(
  openPdf.indexOf("function rwOneDate"),
  openPdf.indexOf("window.recExportTitleRows"));
ok(rwSlice.length > 100, "the label helpers were found (or every assertion about them below is vacuous)");
ok(!/new Date\(/.test(rwSlice), "recWindowLabel never constructs a Date — a bare ISO string parses as UTC midnight and renders a day early west of UTC");

/* 5 — the Excel prelude. */
const t = titles("Product Sales", "2026-08-01", "2026-08-31");
eq(t.length, 2, "the prelude is exactly two rows — a title and a blank spacer, so the table starts at A3");
eq(t[1].length, 0, "the second row is blank");
ok(/Aug 1, 2026/.test(t[0][0]) && /Aug 31, 2026/.test(t[0][0]), "the title carries the window — that is the whole point of it");
ok(/Product Sales/.test(t[0][0]), "...and names the report");
ok(/through today/.test(titles("Product Sales", "2026-08-01", "")[0][0]), "a file built from a half-open window says so on its own first line");

/* ── every page derives it, gates on it, and says why ─────────────────────── */
const RUN_PAGES = ["custom-report", "facility", "gl", "historic", "index",
                   "memberships", "products", "programs", "roster"];
const ALL_PAGES = RUN_PAGES.concat(["waitlist"]);

ALL_PAGES.forEach(name => {
  const src = read("public/" + name + ".html");
  ok(/const windowProblem = window\.recWindowProblem\(/.test(src),
     name + ".html derives windowProblem from the SHARED helper — a second copy of the rule is a second chance to get it wrong");
  ok(/data-window-problem/.test(src),
     name + ".html renders the reason on screen — a control that refuses without saying why reads as broken");
});

RUN_PAGES.forEach(name => {
  const src = read("public/" + name + ".html");
  ok(/disabled=\{[^}]*!!windowProblem/.test(src),
     name + ".html gates its Run button on the window — this is the control Marina would have been stopped by");
});

// waitlist has no Run button: its dates drive the fetch directly, so the guard
// has to be on the fetch, and both-blank must still reach it.
const wl = read("public/waitlist.html");
ok(/if \(windowProblem\) \{[^}]*return;/.test(wl),
   "waitlist guards its fetch effect instead of a Run button — there isn't one");
ok(/\}, \[startDate, endDate, windowProblem\]\);/.test(wl),
   "...and windowProblem is in that effect's dependency array, or completing the range never re-runs the fetch");
ok(/Clear dates — back to all-time/.test(wl),
   "waitlist still offers all-time — the assertion that fails if the rule is tightened into 'no blank dates'");

// The button is one way in, not the only one: the handler refuses too.
[["products", "handleRun"], ["facility", "handleRunReport"], ["gl", "handleRun"],
 ["index", "handleRunReport"], ["roster", "handleRun"], ["memberships", "handleRunReport"],
 ["custom-report", "run"]].forEach(([name, fn]) => {
  const src = read("public/" + name + ".html");
  ok(/if \(window\.recWindowProblem\([^)]*\)\) return;/.test(src),
     name + ".html refuses inside " + fn + "() as well as on the button — a preset or a future caller must not route around it");
});

/* ── every Excel export stamps the loaded window ──────────────────────────── */
const XLSX_PAGES = ["custom-report", "facility", "gl", "historic", "memberships",
                    "products", "programs", "roster", "waitlist"];
XLSX_PAGES.forEach(name => {
  const src = read("public/" + name + ".html");
  ok(/recExportTitleRows\(/.test(src),
     name + ".html stamps the loaded window into its workbook");
});

// index.html is PDF-only — asserted so the omission is a decision on the record
// rather than a page someone forgot.
ok(!/XLSX\.utils\.book_append_sheet/.test(read("public/index.html")),
   "index.html has no Excel export to stamp (PDF only) — stated so the gap is deliberate");

// The stamped window must be the LOADED one, never the pending box: a reader
// who edits the dates and exports without running would otherwise get a file
// labelled with a window it does not contain.
[["facility", "loadedStart, loadedEnd"], ["gl", "loadedStart, loadedEnd"],
 ["historic", "loadedStart, loadedEnd"], ["memberships", "loadedStart, loadedEnd"],
 ["products", "loadedStart, loadedEnd"], ["programs", "loadedStart, loadedEnd"],
 ["roster", "loadedStart, loadedEnd"]].forEach(([name, args]) => {
  const src = read("public/" + name + ".html");
  ok(src.indexOf(args) !== -1 && new RegExp("recExportTitleRows\\([^)]*" + args.replace(/[,]/g, ",")).test(src),
     name + ".html stamps the LOADED window, not the toolbar's pending one");
});

/* ── the row-index loops moved with the table ─────────────────────────────── */
// A loop still bounded by the data length stops two rows short once the table
// starts at A3. Measured: with the naive bound, rows 5 and 6 of a 3-row table
// come back with no format at all.
[["facility",    /for \(let rowIdx = 3; rowIdx < wsData\.length; rowIdx\+\+\)/],
 ["historic",    /for \(var ri = 3; ri < wsData\.length; ri\+\+\)/],
 ["roster",      /for \(let ri = 3; ri < wsData\.length; ri\+\+\)/],
 ["programs",    /for \(let ri = 3; ri < wsData\.length; ri\+\+\)/],
 ["memberships", /for \(let ri = 3; ri <= range\.e\.r; ri\+\+\)/]].forEach(([name, re]) => {
  ok(re.test(read("public/" + name + ".html")),
     name + ".html's format loop starts at row 3 and is bounded by the SHEET, not by the data length — otherwise the last two rows silently lose their format");
});

// And the naive bound is gone from every stamped builder.
["facility", "historic", "roster", "programs"].forEach(name => {
  const src = read("public/" + name + ".html");
  ok(!/for \((?:let|var) (?:ri|rowIdx) = 1; (?:ri|rowIdx) <= (?:dataRows|data)\.length/.test(src),
     name + ".html no longer bounds a format loop by the data length — that bound is off by exactly the two prelude rows");
});

/* ── what must NOT be stamped ─────────────────────────────────────────────── */
const roster = read("public/roster.html");
const epact = roster.slice(roster.indexOf("function exportEpact"), roster.indexOf("function exportEpact") + 1200);
ok(epact.length > 200, "exportEpact was found (or the assertion below is vacuous)");
ok(!/recExportTitleRows/.test(epact),
   "the ePACT export is NOT stamped — it is a verified five-column upload to a HIPAA vendor that maps on POSITION, and a title line breaks the import");

const cr = read("public/custom-report.html");
const csvFn = cr.slice(cr.indexOf("function downloadCsv"), cr.indexOf("function downloadExcel"));
ok(csvFn.length > 100, "custom-report's downloadCsv was found (or the assertion below is vacuous)");
ok(!/recExportTitleRows/.test(csvFn),
   "custom-report's CSV stays rows-only — that report's own rule is that the CSV is the data feed while the workbook is the thing a person reads");

/* ── report ───────────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error("\n✗ report-window.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("✓ report-window.spec.js — " + pass + " assertions passed.");
