#!/usr/bin/env node
/* custom-reports.spec.js — the per-org custom data reports (CUSTOM_REPORTS).
 *
 * Dan, 2026-09-09, on Joseph Lormans' CivicRec exports: "now what's missing are
 * the roll ups or total rows at the bottom… Create a new card pulling data from
 * the mb cards, add filters that match up with the mb report, then format it on
 * the frontend to look like his Civic Rec reports?" — minus the wrapper card,
 * which buys nothing: the four aquatics cards are already the right feed shape.
 *
 * TWO HALVES, because they prove different things.
 *   · The SOURCE/UNIT half LIFTS AND RUNS the renderer's pure functions. A regex
 *     over a reducer passes on an inverted comparison, and a roll-up that adds
 *     up wrongly renders a perfectly plausible number.
 *   · The LIVE half boots a real server against a fixture org and drives the
 *     real routes — the gate, the beacon and the deliberate-404 marking. No
 *     source assertion has ever caught the beacon-that-404s trap, which has now
 *     cost this repo four silent losses.
 *
 * SKIP_SOURCE=1 drops the source half, so the live half can be shown to catch a
 * regression on its own.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const os = require("os");

let pass = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { failures.push(name + " — " + e.message); console.log("  ✗ " + name); }
};
const atest = async (name, fn) => {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { failures.push(name + " — " + e.message); console.log("  ✗ " + name); }
};

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "public/custom-report.html"), "utf8");
const srv  = fs.readFileSync(path.join(root, "server.js"), "utf8");
const org  = fs.readFileSync(path.join(root, "public/org.html"), "utf8");
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";

/* Lift a module-scope function declaration by name. The parameter list is
   skipped FIRST: counting braces from the first `{` matches a DESTRUCTURED
   parameter and cuts the function in half — recorded three times in CLAUDE.md,
   and it has bitten this helper before. */
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope");
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

/* The renderer's pure half, RUN rather than regexed. `prettyDate` is pulled in
   because flattenTree's labels go through it. */
const NUMERIC_FIXTURE = { Reservations: { dp: 0 }, "Lane Hours": { dp: 2 } };
const UUID_RE_SRC = /const UUID_RE = [^\n]+/.exec(page);
assert.ok(UUID_RE_SRC, "the identifier test is where this expects it");
const lifted = new Function("NUMERIC", "MONTHS", `
  ${UUID_RE_SRC[0]}
  ${liftFn(page, "numOf")}
  ${liftFn(page, "fmtNum")}
  ${liftFn(page, "prettyDate")}
  ${liftFn(page, "cellText")}
  ${liftFn(page, "columnsOf")}
  ${liftFn(page, "orderCols")}
  ${liftFn(page, "groupRows")}
  ${liftFn(page, "flattenTree")}
  ${liftFn(page, "flatTable")}
  ${liftFn(page, "levelsSafe")}
  ${liftFn(page, "collapseRows")}
  ${liftFn(page, "filterRows")}
  ${liftFn(page, "valueCountsFor")}
  ${liftFn(page, "searchRows")}
  ${liftFn(page, "isFilterable")}
  return { numOf, fmtNum, prettyDate, cellText, columnsOf, orderCols, groupRows, flattenTree,
           flatTable, levelsSafe, collapseRows, filterRows, valueCountsFor, searchRows, isFilterable };
`)(NUMERIC_FIXTURE,
   ['January','February','March','April','May','June','July','August','September','October','November','December']);
const { fmtNum, prettyDate, cellText, columnsOf, orderCols, groupRows, flattenTree, flatTable,
        searchRows, isFilterable, levelsSafe, collapseRows, filterRows, valueCountsFor } = lifted;

/* ── The fixture ───────────────────────────────────────────────────────────
   Deliberately shaped so a WRONG roll-up cannot look right:
     · two months, so the Month level has more than one group to close
     · two locations inside July and two inside August, so a month total can
       never coincide with any single location subtotal
     · every month total (13, 21) and the grand (34) appear nowhere else, so an
       assertion on them cannot pass on a subtotal read from the wrong level.
   Rows arrive in the card's own ORDER BY (Month, Location), which is what the
   grouper walks — a fixture in any other order would be testing a sort the
   feed never produces. */
const ROWS = [
  { Month: "2026-07", Location: "Wiseburn", Lane: "A", "Program Type": "Lap Swim",     Reservations: 3,  "Lane Hours": 10.5 },
  { Month: "2026-07", Location: "Wiseburn", Lane: "B", "Program Type": "Swim Lessons", Reservations: 2,  "Lane Hours": 4.5 },
  { Month: "2026-07", Location: "Urho",     Lane: "C", "Program Type": "Masters",      Reservations: 8,  "Lane Hours": 21.25 },
  { Month: "2026-08", Location: "Wiseburn", Lane: "A", "Program Type": "Lap Swim",     Reservations: 20, "Lane Hours": 40.5 },
  { Month: "2026-08", Location: "Hilltop",  Lane: "D", "Program Type": "Open / Rec Swim", Reservations: 1, "Lane Hours": 2 },
];
const LEVELS = ["Month", "Location"];
const NUMS = ["Reservations", "Lane Hours"];

if (!SKIP_SOURCE) {
console.log("\ncustom-reports.spec.js\n");

/* ── 1. The grouping ───────────────────────────────────────────────────── */

test("a parent reconciles to its children, at every level", () => {
  const t = groupRows(ROWS, LEVELS, NUMS);
  assert.strictEqual(t.groups.length, 2, "two months");
  const [jul, aug] = t.groups;
  assert.strictEqual(jul.value, "2026-07");
  assert.strictEqual(jul.groups.length, 2, "July has two locations");
  assert.strictEqual(jul.groups[0].totals.Reservations, 5,  "Wiseburn July = 3 + 2");
  assert.strictEqual(jul.groups[1].totals.Reservations, 8,  "Urho July");
  assert.strictEqual(jul.totals.Reservations, 13, "the month is the sum of its locations");
  assert.strictEqual(aug.totals.Reservations, 21);
  assert.strictEqual(t.totals.Reservations, 34, "the grand total is every row");
  // Fractions matter: hours are half-hours and a rounding at the wrong level
  // makes a column that does not add up on screen.
  assert.strictEqual(jul.totals["Lane Hours"], 36.25);
  assert.strictEqual(t.totals["Lane Hours"], 78.75);
});

test("the grouper never re-sorts — it walks the card's own order", () => {
  // Out-of-order rows produce two separate groups with the same value rather
  // than one merged group. That is deliberate: re-sorting here would silently
  // disagree with the ORDER BY the card was written with, and the report would
  // stop matching the CSV beside it.
  const shuffled = [ROWS[0], ROWS[3], ROWS[1]];
  const t = groupRows(shuffled, LEVELS, NUMS);
  assert.strictEqual(t.groups.length, 3, "07, 08, 07 — three runs, not two groups");
  assert.strictEqual(t.totals.Reservations, 25, "and the grand total is still every row");
});

test("a row the card could not attribute is grouped, never dropped", () => {
  // Hiding it would make the grand total disagree with the CSV beside it.
  const t = groupRows(ROWS.concat([{ Month: "", Location: null, Reservations: 4, "Lane Hours": 1 }]), LEVELS, NUMS);
  assert.strictEqual(t.totals.Reservations, 38);
  assert.strictEqual(t.groups[t.groups.length - 1].value, "", "empty is its own group");
});

test("with no group levels it is one flat run plus a grand total", () => {
  const t = groupRows(ROWS, [], NUMS);
  assert.ok(t.leaf, "no levels means no groups");
  assert.strictEqual(t.rows.length, 5);
  assert.strictEqual(t.totals.Reservations, 34);
});

/* ── 2. Which subtotal each level gets ─────────────────────────────────── */

test("the DEEPEST group takes the unlabelled subtotal, outer levels the labelled one", () => {
  // CivicRec's own rule (report C: an unlabelled row under each Activity, then
  // "Totals for Category: X"). Give both to the deepest group and it prints the
  // same numbers twice, one directly under the other.
  const items = flattenTree(groupRows(ROWS, LEVELS, NUMS), LEVELS);
  const subs = items.filter(i => i.kind === "sub");
  const deep = subs.filter(s => s.depth === 1);
  const outer = subs.filter(s => s.depth === 0);
  assert.strictEqual(deep.length, 4, "four locations across the two months");
  assert.ok(deep.every(s => s.label === ""), "the innermost roll-up carries no label");
  assert.strictEqual(outer.length, 2, "two months");
  assert.ok(outer.every(s => /^Totals for Month: /.test(s.label)),
    "and each outer one names the group it closes");
  assert.strictEqual(outer[0].label, "Totals for Month: July 2026");
});

test("every group heading is emitted, in order, before its rows", () => {
  const items = flattenTree(groupRows(ROWS, LEVELS, NUMS), LEVELS);
  const kinds = items.map(i => i.kind + (i.kind === "head" ? ":" + i.value : ""));
  assert.deepStrictEqual(kinds.slice(0, 5), [
    "head:2026-07", "head:Wiseburn", "row", "row", "sub",
  ], "month heading, location heading, its rows, then its subtotal");
  assert.strictEqual(items.filter(i => i.kind === "row").length, ROWS.length,
    "and every row is displayed exactly once");
});

test("one level of grouping still gets a subtotal and never a duplicate", () => {
  const items = flattenTree(groupRows(ROWS, ["Month"], NUMS), ["Month"]);
  const subs = items.filter(i => i.kind === "sub");
  assert.strictEqual(subs.length, 2);
  assert.ok(subs.every(s => s.label === ""), "the only level is the deepest one");
});

/* ── 3. Formatting ─────────────────────────────────────────────────────── */

test("a negative is written in parentheses, the way the money cards report it", () => {
  // organization-credit is genuinely negative on both sides, and CivicRec
  // writes User Credit as ($5.00). Reports 3 and 4 carry that column.
  assert.strictEqual(fmtNum(-26, 2), "(26.00)");
  assert.strictEqual(fmtNum(1234.5, 2), "1,234.50");
  assert.strictEqual(fmtNum(70, 2), "70.00", "an integer still shows its decimals");
  assert.strictEqual(fmtNum(null, 2), "", "and a missing value is blank, never 0");
});

test("no date on this page goes through new Date(<iso>)", () => {
  // new Date("2026-08-01") is UTC midnight and renders as July 31 across the
  // US — five instances of that bug are recorded in CLAUDE.md.
  assert.strictEqual(prettyDate("2026-08"), "August 2026");
  assert.strictEqual(prettyDate("2026-08-01"), "Aug 1, 2026");
  assert.strictEqual(prettyDate("Wiseburn"), "Wiseburn", "a non-date is handed back untouched");
  const body = page.slice(page.indexOf("const MONTHS"), page.indexOf("/* ── Numbers"));
  // `new Date()` and `new Date(y, m, d)` are fine — the trap is a Date built
  // from a STRING, which is how an ISO date becomes UTC midnight.
  assert.doesNotMatch(body, /new Date\(\s*['"`]/, "no Date from a string literal");
  assert.doesNotMatch(body, /new Date\(\s*[A-Za-z_$][\w$]*\s*\)/,
    "and none from a single variable, which is how an ISO string sneaks in");
});

/* ── 4. Columns and the export ─────────────────────────────────────────── */

test("the columns are READ from the feed, in the card's own order", () => {
  // A transcribed header is a copy that goes stale the day the card gains a
  // column — the guessed-grain mistake, one field over.
  assert.deepStrictEqual(columnsOf(ROWS),
    ["Month", "Location", "Lane", "Program Type", "Reservations", "Lane Hours"]);
  assert.deepStrictEqual(columnsOf([{ a: 1 }, { a: 1, b: 2 }]), ["a", "b"],
    "a column absent from row 1 is still a column");
  assert.deepStrictEqual(columnsOf(null), [], "and no rows is no columns, not a throw");
});

test("the CSV is the ROWS ONLY — no subtotal lines", () => {
  // A data file gets re-aggregated by whoever opens it, and a subtotal row
  // indistinguishable from a data row double-counts the moment anyone sums a
  // column. The formatted version of this report is the print/PDF one.
  const t = flatTable(ROWS, columnsOf(ROWS));
  assert.strictEqual(t.length, ROWS.length + 1, "a header and the rows, nothing else");
  assert.deepStrictEqual(t[0], ["Month", "Location", "Lane", "Program Type", "Reservations", "Lane Hours"]);
  assert.deepStrictEqual(t[1], ["2026-07", "Wiseburn", "A", "Lap Swim", 3, 10.5]);
  // The group columns are IN the file: a spreadsheet row cannot be expanded,
  // so what the screen puts in a heading the file has to carry per row.
  assert.ok(t[0].includes("Month") && t[0].includes("Location"));
});

test("the exports go through the shared writer, the popup and the BOM", () => {
  assert.match(page, /csvFromRows\(flatTable\(shownRows, exportCols\(\)\)\)/,
    "one CSV writer, not a per-page quoting rule");
  // AND IT READS THE VIEW, not the raw feed. An export that quietly carries
  // rows the reader filtered out, or a column they hid, is the exact bug
  // already recorded in CLAUDE.md for the Programs Excel export — and a file
  // that disagrees with the page it came from is how a number stops being
  // trusted. Scoped to the two download functions, because `rows` is the right
  // thing to read almost everywhere else on this page.
  const dl = page.slice(page.indexOf("function downloadCsv()"), page.indexOf("function print()"));
  assert.doesNotMatch(dl, /flatTable\(rows\b/, "the exports must not read the unfiltered feed");
  assert.match(page, /saveTextViaPopup\([\s\S]{0,200}bom: true/,
    "with the BOM — Excel sniffs bytes, and a sandboxed iframe's own download is dropped");
  assert.match(page, /saveWorkbookViaPopup\(XLSX, wb/, "and Excel through the same popup");
  assert.match(page, /XLSX\.utils\.aoa_to_sheet\(table\)/,
    "built from the SAME flat table, so the two files cannot disagree");
});

/* ── 5. The registry ───────────────────────────────────────────────────── */

const spec = (() => {
  const i = srv.indexOf("const CUSTOM_REPORTS = {");
  const j = srv.indexOf("\n};", i);
  return srv.slice(i, j + 3);
})();

/* One report's own entry. The registry holds four now, so an assertion about
   what report 1 must NOT offer is meaningless against the whole map — report 4
   legitimately carries the value report 1 must not. */
function entryOf(key) {
  const i = spec.indexOf('"' + key + '": {');
  if (i < 0) throw new Error(key + " is not in CUSTOM_REPORTS");
  let depth = 0, j = spec.indexOf("{", i);
  for (; j < spec.length; j++) {
    if (spec[j] === "{") depth++;
    else if (spec[j] === "}") { depth--; if (depth === 0) break; }
  }
  return spec.slice(i, j + 1);
}

test("the gate is the orgId, never the slug", () => {
  // The slug is each project's own name for an organisation and they drift —
  // the town-of-shrewsbury link 404'd for five weeks, and El Segundo is already
  // spelled differently in the dashboard project.
  assert.match(srv, /const CUSTOM_REPORT_ORG_IDS = \{[\s\S]*?elSegundo: "8ae77057-6bce-4c20-b0f2-366ed5fa14dd"/);
  assert.match(srv, /function customReportEnabled\(slug, key\) \{[\s\S]*?spec\.orgIds\.includes\(org\.orgId\)/,
    "membership is decided on org.orgId");
  assert.doesNotMatch(spec, /el-segundo/, "no slug anywhere in the registry");
});

test("card 21682's public link is what the report reads", () => {
  assert.match(spec, /uuid: process\.env\.MB_AQUATIC_LANE_HOURS_UUID \|\| "b1f4ca67-1a91-4e91-8581-5b3dbaf0d9a2"/);
  assert.match(spec, /card: 21682/, "and the numeric id, so the page can name it on screen");
});

test("the location list is per report and matches the card's own CASE ladder", () => {
  // Card 1 has no city-wide Rec ID bucket. The shared Metabase dashboard offers
  // one filter for four cards and two of its values return zero rows on two of
  // them, which reads as a broken filter; each report here offers only what it
  // can answer.
  const sql = fs.readFileSync(path.join(root, "sql/report-cards/21682-aquatic-lane-hours.sql"), "utf8");
  ["El Segundo Wiseburn Aquatic Center", "Urho Saari Swim Stadium", "Hilltop Park"].forEach(l => {
    assert.ok(spec.includes(`"${l}"`), l + " is offered");
    assert.ok(sql.includes(`'${l}'`), l + " is a value the card can actually return");
  });
  // SCOPED TO REPORT 1's OWN ENTRY. Report 4 legitimately offers the city-wide
  // bucket — a Rec ID answers to neither pool — so a registry-wide assertion
  // would either fail on correct code or have to be deleted, and deleting it
  // loses the thing it was written to catch.
  assert.ok(locationsOf("aquatic-lane-hours").every(l => l.indexOf("City-wide") === -1),
    "card 1 sells no Rec IDs, so it must not offer that value");
  assert.ok(locationsOf("aquatic-passes").indexOf("(City-wide - Rec ID)") !== -1,
    "and card 4 does, because it is the card that sells them");
});

/* The locations ARRAY, parsed — not the entry's text. The entry's own comment
   explains which locations are deliberately absent and therefore NAMES them, so
   a text assertion fails on correct code. Fourth instance of that trap in this
   repo; see CLAUDE.md. */
function locationsOf(key) {
  const e = entryOf(key);
  const m = e.match(/locations:\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return (m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1));
}

test("each report offers only locations its OWN card can answer for", () => {
  // Hilltop runs no aquatic programme sections and sells no passes, so offering
  // it on reports 2 and 4 would return zero rows and read as a broken filter
  // however correct the data is. Measured 2026-09-09 against all four cards.
  assert.ok(locationsOf("aquatic-classes").indexOf("Hilltop Park") === -1,
    "Hilltop runs no aquatic sections — card 2 would answer nothing");
  assert.ok(locationsOf("aquatic-passes").indexOf("Hilltop Park") === -1,
    "Hilltop sells no passes or Rec IDs — card 4 would answer nothing");
  assert.ok(locationsOf("aquatic-dropin").indexOf("Hilltop Park") !== -1,
    "but Hilltop DOES sell drop-in swim, so card 3 offers it");
  // Every report offers at least the two real pools, or the filter is useless.
  ["aquatic-lane-hours", "aquatic-classes", "aquatic-dropin", "aquatic-passes"].forEach(k => {
    const l = locationsOf(k);
    assert.ok(l.indexOf("El Segundo Wiseburn Aquatic Center") !== -1, k + " offers Wiseburn");
    assert.ok(l.indexOf("Urho Saari Swim Stadium") !== -1, k + " offers Urho Saari");
  });
});

test("an unknown location is DROPPED, not forwarded", () => {
  // A value outside the list returns zero rows and reads as an empty report
  // rather than as a rejected filter.
  assert.match(srv, /if \(loc && spec\.locations\.includes\(loc\)\)/);
});

test("the label and the emoji have ONE definition", () => {
  // REPORT_DIRECTORY drives the project-update composer's chips and org.html
  // draws the card. Two copies drift the first time one is renamed, and the
  // card then opens a report it does not name.
  assert.match(srv, /REPORT_DIRECTORY\[k\] = \{ label: CUSTOM_REPORTS\[k\]\.label, emoji: CUSTOM_REPORTS\[k\]\.emoji \}/);
  assert.match(srv, /customReportMeta: Object\.fromEntries\(customReportsForOrg\(slug\)\.map/);
  assert.match(org, /Object\.assign\(REPORT_META, \(cfg\.customReportMeta \|\| \{\}\)\)/,
    "org.html merges what the server sent rather than carrying its own copy");
  assert.doesNotMatch(org, /aquatic-lane-hours/, "and hardcodes nothing about this report");
});

test("it is NOT a REPORT_TYPES entry", () => {
  // A report type with a SHARED_UUIDS entry is offered to every org, health
  // checked, prewarmed and subscribable. This card's SQL hardcodes El Segundo's
  // locations and GL codes, so every other org would get an empty report.
  const types = srv.match(/const REPORT_TYPES = \[([^\]]*)\]/)[1];
  assert.ok(!types.includes("aquatic-lane-hours"));
  const shared = srv.slice(srv.indexOf("const SHARED_UUIDS = {"), srv.indexOf("\n};", srv.indexOf("const SHARED_UUIDS = {")));
  assert.ok(!shared.includes("aquatic-lane-hours"));
});

/* ── 6. Route order ────────────────────────────────────────────────────── */

test("the beacon route is registered ABOVE the generic one", () => {
  // Express matches in registration order and resolveOrg 404s any report
  // outside REPORT_TYPES. A beacon that 404s is fire-and-forget and never
  // complains — four silent losses in this repo already.
  const mine = srv.indexOf("app.post(`/:org/${key}/api/log`");
  const generic = srv.indexOf('app.post("/:org/:report/api/log"');
  assert.ok(mine > 0 && generic > 0, "both routes exist");
  assert.ok(mine < generic, "the custom one is registered first");
  const data = srv.indexOf("app.get(`/:org/${key}/api/data`");
  assert.ok(data > 0 && data < srv.indexOf('app.get("/:org/:report/api/data"'));
});

test("the beacon does not smuggle a `report` key into the event", () => {
  // logEvent merges `extra` over the record it builds, so an extra called
  // `report` overwrites the report TYPE — which takes the row out of
  // getReportActivity()'s reach. Caught by reading events.jsonl back.
  const route = srv.slice(srv.indexOf("app.post(`/:org/${key}/api/log`"),
                          srv.indexOf("// ── POST /:org/facilities/api/log"));
  assert.doesNotMatch(route, /report:\s*spec\.label/);
  assert.match(route, /const extra = \{\s*\n\s*rows:/, "rows and location only");
});

test("the CSV download is announced, and says which report and how much", () => {
  const notify = srv.match(/const SLACK_NOTIFY = new Set\(\[([\s\S]*?)\]\)/)[1];
  assert.ok(notify.includes('"report-csv"'), "report-csv is in SLACK_NOTIFY");
  assert.match(srv, /"report-csv":\s*\{ emoji: "[^"]+", verb: "downloaded the data CSV from" \}/);
  assert.match(srv, /const CUSTOM_LOG_EVENTS = \["excel", "print", "report-csv"\]/);
  assert.match(page, /logClientEvent\('report-csv', \{ n: shownRows\.length/,
    "the row count travels with it — and it is the count in the FILE, which is "
    + "the view, not the feed");
  assert.match(page, /basePath \+ '\/api\/log\?' \+ qs\.toString\(\)/,
    "?event= in the QUERY STRING — a JSON body comes back 400 and never complains");
});

/* ── 7. The page's own degradations ────────────────────────────────────── */

test("a failed run keeps the header describing the rows on screen", () => {
  // fetchData leaves the previous window's numbers up on a failure, so a header
  // that had already moved would label them with a range nobody asked for —
  // the Memberships 504 lesson.
  assert.match(page, /setApplied\(\{ start: sd, end: ed, location: loc \}\)/);
  assert.match(page, /data-head-from>\{applied\.start/, "the header reads `applied`");
  assert.match(page, /data-head-to>\{applied\.end/);
  assert.match(page, /data-head-location>\{applied\.location/);
});

test("the route's own sentence reaches the reader", () => {
  // reportFetchError RETURNS an Error rather than throwing one, so a bare
  // `return reportFetchError(r)` resolves the chain WITH an Error object and a
  // 504 renders as an empty report instead of the remedy. It has to be thrown,
  // which needs an async arrow — and a non-async one is a SyntaxError that
  // takes the whole babel block with it.
  assert.match(page, /\.then\(async r => \{ if \(!r\.ok\) throw await reportFetchError\(r\)/,
    "thrown from an async arrow, not returned");
  // SCOPED TO THE FETCH CHAIN, not the whole file: the comment above that line
  // quotes the broken form on purpose, and a file-wide assertion fails on
  // correct code because of it. Third instance of that in this repo.
  const chain = page.slice(page.indexOf("const run = useCallback"), page.indexOf("}, []);"));
  assert.doesNotMatch(chain.replace(/^\s*\/\/.*$/gm, ""), /return reportFetchError\(/,
    "returning it swallows the message the route went to the trouble of sending");
});

test("a level the feed does not carry is not grouped on", () => {
  // Otherwise every row lands in one group called "(none)" — a report that
  // looks fine and says nothing.
  // Lifted and RUN rather than regexed: a regex over a filter passes on an
  // inverted comparison.
  assert.deepStrictEqual(levelsSafe(["Month", "Location", "Nope"], ["Month", "Location", "Lane"]),
                         ["Month", "Location"]);
  assert.deepStrictEqual(levelsSafe(["Month"], []), [], "a feed with no columns groups on nothing");
  assert.match(page, /const levels = useMemo\(\(\) => levelsSafe\(GROUP_BY, cols\)/,
    "and the page actually calls it");
});

/* ── The column picker and the filters ─────────────────────────────────── */

// Deliberately shaped so a wrong roll-up cannot look right: hiding Rental Name
// must MERGE the two Lap Swim rows on lane A into one reading 5 / 16.0, and the
// figures 5 and 16.0 appear nowhere else in the fixture.
const WIDE = [
  { Month: "2026-07", Location: "Wiseburn", Lane: "A", "Program Type": "Lap Swim",  "Rental Name": "Court Reservation: A", Reservations: 3, "Lane Hours": 10.5 },
  { Month: "2026-07", Location: "Wiseburn", Lane: "A", "Program Type": "Lap Swim",  "Rental Name": "Court Reservation: B", Reservations: 2, "Lane Hours": 5.5 },
  { Month: "2026-07", Location: "Wiseburn", Lane: "B", "Program Type": "Rec Swim",  "Rental Name": "Rec Swim",            Reservations: 7, "Lane Hours": 21.0 },
  { Month: "2026-08", Location: "Urho",     Lane: "A", "Program Type": "Masters",   "Rental Name": "",                    Reservations: 1, "Lane Hours": 2.0 },
];
const WIDE_NUM = ["Reservations", "Lane Hours"];

test("hiding a column RE-SUMS the rows rather than blanking a cell", () => {
  // The whole reason the picker exists. Card 21682 returns 825 rows for
  // September and 493 of them differ only in an auto-generated
  // "Court Reservation: <lane>" string — so a picker that merely hid the column
  // would leave 825 identical-looking rows adding to the same total, which
  // reads as a broken report rather than a shorter one.
  const kept = ["Month", "Location", "Lane", "Program Type"];
  const out = collapseRows(WIDE, kept, WIDE_NUM);
  assert.strictEqual(out.length, 3, "the two Court Reservation rows merge");
  assert.strictEqual(out[0].Reservations, 5, "3 + 2");
  assert.strictEqual(out[0]["Lane Hours"], 16, "10.5 + 5.5");
  assert.ok(!("Rental Name" in out[0]), "the hidden column is gone, not blank");
  // AND THE TOTAL IS UNCHANGED. A collapse that loses or duplicates a row is
  // the one failure a reader cannot see, because the page still looks right.
  const before = WIDE.reduce((t, r) => t + r["Lane Hours"], 0);
  const after  = out.reduce((t, r) => t + r["Lane Hours"], 0);
  assert.strictEqual(after, before, "collapsing must not move the grand total");
});

test("the collapse keeps the card's own order, and never merges across a separator", () => {
  // FIRST APPEARANCE WINS, so the hierarchy still comes from the card's ORDER BY
  // and nothing is re-sorted here — the property groupRows depends on.
  const out = collapseRows(WIDE, ["Month"], WIDE_NUM);
  assert.deepStrictEqual(out.map(r => r.Month), ["2026-07", "2026-08"]);
  // Two dimension values must not straddle a joined key: "a b" + "c" and
  // "a" + "b c" are different rows and a string join silently merges them.
  const tricky = [
    { X: "a b", Y: "c", N: 1 },
    { X: "a",   Y: "b c", N: 1 },
  ];
  assert.strictEqual(collapseRows(tricky, ["X", "Y"], ["N"]).length, 2,
    "these are two different rows and must stay two");
});

test("an empty filter means ALL, never none", () => {
  // The rule every other multi-select in this repo follows, and it is why there
  // is a Clear and no Select all: two controls producing one state is a control
  // that looks broken.
  assert.strictEqual(filterRows(WIDE, {}).length, 4);
  assert.strictEqual(filterRows(WIDE, { f_Lane: [] }).length, 4, "an emptied filter is not a filter");
  assert.strictEqual(filterRows(WIDE, { Lane: ["A"] }).length, 3);
  assert.strictEqual(filterRows(WIDE, { Lane: ["A"], "Program Type": ["Masters"] }).length, 1,
    "two filters intersect");
});

test("a blank value is its own filter option, labelled and never dropped", () => {
  // A row the card could not attribute is still a row, and hiding it makes the
  // grand total disagree with the CSV beside it.
  const opts = valueCountsFor(WIDE, "Rental Name");
  assert.ok(opts.some(o => o.value === ""), "blank is offered");
  assert.strictEqual(filterRows(WIDE, { "Rental Name": [""] }).length, 1,
    "and selecting it keeps the blank row");
  // Busiest first, so the value someone is hunting for leads.
  const byLane = valueCountsFor(WIDE, "Lane");
  assert.deepStrictEqual(byLane.map(o => o.value), ["A", "B"]);
  assert.strictEqual(byLane[0].count, 3);
});

test("the filters are in the URL and the column picker is NOT", () => {
  // Which columns you like looking at is a display preference — per browser,
  // like every other column picker here. The filters are part of the question
  // the report answers, so a link has to carry them.
  assert.match(page, /localStorage\.setItem\(COLS_KEY/, "columns persist per browser");
  assert.doesNotMatch(page, /searchParams\.set\('hidden'/, "and never reach the URL");
  assert.match(page, /SP\.getAll\(filterParam\(c\)\)/,
    "read with getAll — repeated keys, because these values contain commas");
  // AND KEYED BY COLUMN NAME. filterRows looks up r[key], so a map keyed by the
  // URL parameter name matches nothing and the filter silently does nothing at
  // all — which is how it shipped for one revision. The unit fixture could not
  // see it because it supplied column names the app never did; the render check
  // is what caught it.
  assert.match(page, /if \(next\.length\) out\[col\] = next; else delete out\[col\];/,
    "the filter map is keyed by the column, never by its URL slug");
  assert.match(page, /selected=\{filters\[c\] \|\| \[\]\}/,
    "and the menu reads it the same way");
  const url = page.slice(page.indexOf("const u = new URL(window.location.href)"),
                         page.indexOf("window.history.replaceState"));
  assert.match(url, /searchParams\.delete\(k\)/, "delete before appending");
  // The column -> parameter slug conversion happens HERE and nowhere else: the
  // slug is a URL concern, and letting it into the state is what broke the
  // filters for a revision.
  assert.match(url, /searchParams\.append\(filterParam\(c\), v\)/);
  // Appending without deleting stacks a second copy of every value on each
  // render — the exact bug already recorded for the season filter.
  assert.ok(url.indexOf("delete") < url.indexOf("append"), "delete comes FIRST");
});

test("the hidden-column default is applied even though nobody touched a control", () => {
  // scopedRows on the Programs page handed `rows` straight back when no filter
  // was picked — correct while every filter was opt-in, and wrong the moment one
  // became a DEFAULT. hiddenColumns IS a default, so the early return has to be
  // computed from state rather than from whether the reader has interacted.
  const memo = page.slice(page.indexOf("const shownRows = useMemo"),
                          page.indexOf("// Only group on levels"));
  assert.match(memo, /if \(shownDims\.length === dimCols\.length\) return kept;/,
    "the skip is a comparison of what is shown against what exists");
  assert.doesNotMatch(memo, /touched|dirty|userHasFiltered/,
    "never gated on whether the reader has interacted");
});

test("the TABLE is handed the narrowed view, not the whole feed", () => {
  // Found by mutation, not by review: every other assertion here passed with
  // the table still rendering `bodyCols` over `rows`, which is the bug the
  // whole picker exists to prevent — the hidden column comes back, blank, and
  // the row count on screen disagrees with the one in the toolbar.
  const render = page.slice(page.indexOf("<GroupedTable"), page.indexOf("<GroupedTable") + 200);
  assert.match(render, /cols=\{viewCols\}/, "the table renders the visible columns");
  assert.match(render, /rowCount=\{shownRows\.length\}/, "and counts the visible rows");
  assert.doesNotMatch(render, /bodyCols|rows\.length/,
    "never the unfiltered column set or the unfiltered count");
});

test("filtered to nothing is a DIFFERENT empty state from a window with no rows", () => {
  // Otherwise the reader widens the dates when the fix is to clear a filter.
  assert.match(page, /data-empty-filtered/);
  assert.match(page, /const emptiedByFilter = !!\(rows && rows\.length\) && !shownRows\.length/);
});

test("a narrowed view SAYS it is narrowed, in the page and not the toolbar", () => {
  // Excluded is never hidden: a grand total over a narrowed set with nothing on
  // screen saying so is how a number stops being trusted — and whoever prints
  // this has no toolbar to look at.
  assert.match(page, /data-scope-note/);
  const note = page.slice(page.indexOf("data-scope-note"), page.indexOf("data-scope-note") + 1400);
  assert.match(note, /shownRows\.length[\s\S]{0,80}rows\.length/, "N of M rows");
  const printCss = page.slice(page.indexOf("@media print"), page.indexOf("@media print") + 1200);
  assert.doesNotMatch(printCss, /\.scope-note[^}]*display:\s*none/,
    "and it survives into the PDF, which is where it matters most");
});

test("report 2 does NOT roll up a per-section total", () => {
  // "Participants (section total)" is the same value repeated on every month a
  // section runs, so summing it down a column double-counts any section
  // spanning two months. Same trap as the wizard summing "Number of Payments" —
  // right at Clarksville by luck, latently wrong everywhere else.
  const e = entryOf("aquatic-classes");
  const num = e.match(/numeric:\s*\{([\s\S]*?)\n    \}/)[1];
  assert.ok(num.indexOf("Participants") === -1,
    "a per-section total must not be additive");
  assert.ok(num.indexOf('"Session Hours"') !== -1 && num.indexOf('"Net Revenue"') !== -1,
    "while the genuinely additive columns still roll up");
});

test("the subtotal rows span the index column plus the text columns, ONCE", () => {
  // The bug this exists for: the row emitted a label cell spanning
  // 1 + textCols AND a filler cell spanning textCols - 1, so every subtotal
  // and the grand total pushed their numbers that many columns to the RIGHT of
  // their own headers. It was invisible on the one shape it rendered
  // correctly — a single text column suppressed the filler by its own `> 1`
  // guard — which is why report 1 looked fine while drop-in and passes did not.
  //
  // The positional proof is the render case; this is the source form of it, so
  // the guard survives a rewrite that stops going through those two rows.
  const tbl = page.slice(page.indexOf("function GroupedTable"), page.indexOf("function App()"));
  assert.ok(!/colSpan=\{textCols\.length - 1\}/.test(tbl),
    "no second leading cell may span the text columns again");
  assert.strictEqual((tbl.match(/colSpan=\{labelSpan\}/g) || []).length, 2,
    "the subtotal row and the grand total row each take exactly one label span");
  assert.ok(/const labelSpan = Math\.max\(1, 1 \+ textCols\.length\)/.test(tbl),
    "and that span is the index column plus every text column");
});

test("the search reads EVERY column, including the hidden ones", () => {
  // "SCAQ" lives only in Rental Name, which report 1 opens with hidden. A
  // search restricted to the visible columns would find nothing — and a reader
  // hunting a name should not first have to work out which column it is in.
  const rows = [
    { Month: "2026-07", "Rental Name": "SCAQ", Zip: "90245", Reservations: 8 },
    { Month: "2026-08", "Rental Name": "Lap Swim", Zip: "90501", Reservations: 3 },
  ];
  assert.strictEqual(searchRows(rows, "scaq").length, 1, "case-insensitive, and it reaches a hidden column");
  assert.strictEqual(searchRows(rows, "90245").length, 1, "and a value no header carries");
  assert.strictEqual(searchRows(rows, "").length, 2, "an empty box is not a filter");
  assert.strictEqual(searchRows(rows, "   ").length, 2, "nor is whitespace");
  // AND, not a substring of the joined row: every word must appear somewhere,
  // so the reader need not type them in the card's own column order.
  assert.strictEqual(searchRows(rows, "scaq 90245").length, 1, "both terms, in either order");
  assert.strictEqual(searchRows(rows, "90245 scaq").length, 1, "order does not matter");
  assert.strictEqual(searchRows(rows, "scaq 90501").length, 0,
    "terms from two different rows match neither");
  // The separator between columns must not let a term straddle two of them.
  assert.strictEqual(searchRows([{ a: "foo", b: "bar" }], "foobar").length, 0,
    "a term may not span a column boundary");
});

test("Rental Name gets no filter MENU, and keeps its column", () => {
  const reg = srv.slice(srv.indexOf("const CUSTOM_REPORTS = {"), srv.indexOf("\n};", srv.indexOf("const CUSTOM_REPORTS = {")));
  const lane = reg.slice(reg.indexOf('"aquatic-lane-hours"'), reg.indexOf('"aquatic-classes"'));
  assert.ok(/noFilter: \["Rental Name"\]/.test(lane), "no menu for 145 distinct values");
  assert.ok(/hiddenColumns: \["Rental Name"\]/.test(lane),
    "and it is still a COLUMN — one tick in the picker brings it back");
});

test("All Users keeps the two filters that are places or answers, not people", () => {
  const reg = srv.slice(srv.indexOf("const CUSTOM_REPORTS = {"), srv.indexOf("\n};", srv.indexOf("const CUSTOM_REPORTS = {")));
  const users = reg.slice(reg.indexOf('"all-users"'));
  const nf = /noFilter: \[([\s\S]*?)\]/.exec(users);
  assert.ok(nf, "all-users declares a noFilter list");
  const listed = (nf[1].match(/"([^"]+)"/g) || []).map(x => x.slice(1, -1));
  // Every per-PERSON dimension. A menu per email address is the report itself
  // rendered as a dropdown.
  ["Household Role", "Rec ID", "First Name", "Last Name", "Email", "Phone",
   "Street Number", "Street Name", "City", "State",
   "Created At", "Date Added to Residency Group"].forEach(c =>
    assert.ok(listed.includes(c), c + " must lose its menu"));
  assert.ok(!listed.includes("Residency?"),
    "Residency? stays — two values, and staff ask it");
  // ZIP CODE STAYS TOO, and it is not forced on: it is simply absent from the
  // denylist, so the cardinality cap still governs it. A zip is a PLACE, which
  // is the family Dan named as filterable, and El Segundo runs 81 distinct
  // values over a September window against a cap of 100. Over a wide enough
  // window it will pass the cap and the menu drops out on its own — that is
  // the cap doing its job, not a regression, so this asserts only that nothing
  // suppresses it by hand.
  assert.ok(!listed.includes("Zip Code"),
    "Zip Code is left to the cardinality cap rather than denied a menu");
});

test("a filter is offered for a VOCABULARY, never for a directory", () => {
  // Dan, 2026-09-10: "don't add filters for data sets that are huge, like names,
  // emails, etc... only for items like locations, sites, membership names, lane
  // or court names, groups, residency status."
  //
  // Derived from the ROWS rather than from a list, so a new report inherits it
  // and a card that gains a column gets the right answer the day it ships.
  const many = Array.from({ length: 60 }, (_, i) =>
    ({ Email: "p" + i + "@example.com", Location: i % 2 ? "Wiseburn" : "Urho", "Residency?": i % 3 ? "Yes" : "No" }));
  assert.strictEqual(isFilterable(many, "Location", 40), true, "two locations is a filter");
  assert.strictEqual(isFilterable(many, "Residency?", 40), true, "and two residency answers");
  assert.strictEqual(isFilterable(many, "Email", 40), false, "sixty emails is a directory");
  // The cap is inclusive, and one past it is not.
  const exact = Array.from({ length: 60 }, (_, i) => ({ c: "v" + (i % 40) }));
  assert.strictEqual(isFilterable(exact, "c", 40), true, "exactly at the cap is still a filter");
  assert.strictEqual(isFilterable(Array.from({ length: 60 }, (_, i) => ({ c: "v" + (i % 41) })), "c", 40), false,
    "one past it is not");
  // Blank is a value like any other — it is an option on the menus that survive.
  assert.strictEqual(isFilterable([{ c: "" }, { c: null }, { c: "x" }], "c", 40), true);
  assert.strictEqual(isFilterable([], "c", 40), true, "an unanswered feed is not a directory");
  // The CAP ITSELF is bounded by two measured numbers rather than picked: card
  // 21685 emits 55 pass and membership names (which Dan named as something that
  // SHOULD have a filter) and card 21682 emits 145 rental names (the menu he
  // asked to remove). A cap outside that range gets one of the two wrong.
  const cap = Number(/const FILTER_MAX_OPTIONS = (\d+);/.exec(page)[1]);
  assert.ok(cap > 55, "55 membership names must keep their menu, got cap " + cap);
  assert.ok(cap < 145, "145 rental names must lose theirs, got cap " + cap);
});

test("a column already being filtered KEEPS its menu, whatever its cardinality", () => {
  // A deep link can narrow on anything. A filter with no control to clear it is
  // a dead end — the scope note would read "Email: ada@example.com" with
  // nothing on screen able to undo it.
  assert.ok(/\(filters\[c\] \|\| \[\]\)\.length \|\|/.test(page),
    "an active filter is the first branch of filterCols");
});

test("the page reads the noFilter list rather than hard-coding one", () => {
  assert.ok(/const NO_FILTER = Array\.isArray\(CFG\.noFilter\)/.test(page),
    "it comes from the registry, injected");
  assert.ok(/NO_FILTER\.indexOf\(c\) === -1 && isFilterable\(/.test(page),
    "and it gates the FILTER menus, alongside the cardinality cap");
  assert.ok(/\{filterCols\.map\(c => \(/.test(page),
    "the menus are rendered from that set, not from every dimension");
  // It must NOT gate the column picker: absence of a menu is not absence of a
  // column, and conflating them would silently drop Rental Name from the picker
  // the render case ticks.
  assert.ok(/options=\{dimCols\.map\(c => \(\{ value: c, label: c \}\)\)\}/.test(page),
    "the column picker still offers every dimension");
});

test("Print and PDF are two controls, and only one of them is the server's", () => {
  assert.ok(!/Print \/ PDF/.test(page), "the combined button is gone");
  assert.ok(/onClick=\{print\}>🖨️ Print</.test(page), "Print is the browser's own");
  assert.ok(/onClick=\{downloadPdf\}>📄 PDF</.test(page), "PDF is the server's");
  assert.ok(/openReportPdf\(withToken\(basePath \+ '\/api\/pdf\?'/.test(page),
    "through the popup, because a download from a sandboxed iframe is dropped");
  // The marker Puppeteer waits on. Without it the PDF route sits at the
  // 120s waitForSelector on a page that rendered instantly.
  assert.ok(/id="report-ready"/.test(page), "and the page says when it has resolved");
  assert.ok(/\{!loading && <div id="report-ready"/.test(page),
    "once it has RESOLVED — a marker present while loading captures a spinner");
});

test("the PDF route is registered above the generic one, and gated", () => {
  const custom = srv.indexOf("app.get(`/:org/${key}/api/pdf`");
  const generic = srv.indexOf('app.get("/:org/:report/api/pdf"');
  assert.ok(custom > -1, "the custom reports have their own PDF route");
  assert.ok(generic > -1 && custom < generic,
    "ABOVE the generic one — Express matches in registration order, and " +
    "resolveOrg 404s any report outside REPORT_TYPES, which these are not");
  const block = srv.slice(custom, custom + 1400);
  assert.ok(/customReportEnabled\(slug, key\)/.test(block), "an org without the report is refused");
  assert.ok(/deliberate404/.test(block),
    "and that refusal is MARKED, or every stale link posts a DEAD LINK alert");
});

test("generatePdf carries this report's whole filter vocabulary", () => {
  // THE GUARD HAS TO CROSS THE BOUNDARY THE BUG CROSSES. A render case drives
  // the PAGE at ?_print=1 and proves it READS these; it says nothing about
  // whether the server SENDS them, which is exactly how five green render cases
  // sat over a PDF that ignored `pii`. So this lifts generatePdf's own query
  // builder and runs it.
  const gp = srv.slice(srv.indexOf("async function generatePdf("));
  const start = gp.indexOf("const qsObj = {");
  // Bounded by the line that CONSUMES the query string, not by the forwarding
  // itself: an end marker naming the code under test means deleting that code
  // breaks the SLICE, and the mutation then dies with "the builder is not where
  // this expects it" instead of failing on the parameter it dropped. That is
  // the guard-dies-instead-of-failing trap, recorded four times in CLAUDE.md.
  const end = gp.indexOf("const url = `http://localhost:");
  assert.ok(start > -1 && end > start, "the query builder is where this expects it");
  const buildQs = new Function("startDate", "endDate", "orgTok", "filters",
    gp.slice(start, end).replace(/const orgTok = [^\n]*\n/, "") + "\nreturn qs.toString();");

  const qs = buildQs("2026-09-01", "2026-09-30", "tok", {
    location: "Urho Saari Swim Stadium",
    f_Program_Type: ["Lap Swim", "Masters"],
    f_Rental_Name: "Court Reservation: Lane 2 - B, Court Reservation: Lane 3 - A",
    q: "90245",
    hide: ["Rental Name", "Booking Type"],
  });
  const p = new URLSearchParams(qs);
  assert.deepStrictEqual(p.getAll("f_Program_Type"), ["Lap Swim", "Masters"],
    "REPEATED, never comma-joined — a rental name legitimately contains a comma");
  assert.deepStrictEqual(p.getAll("f_Rental_Name"),
    ["Court Reservation: Lane 2 - B, Court Reservation: Lane 3 - A"],
    "and a value carrying one survives whole");
  assert.strictEqual(p.get("q"), "90245", "the search travels");
  assert.deepStrictEqual(p.getAll("hide"), ["Rental Name", "Booking Type"],
    "and the column picker, which lives in localStorage and has NO other way " +
    "to reach a Puppeteer render");

  // THE EMPTY VALUE IS THE ONE THAT BREAKS. `hide=` means the reader unhid
  // everything; dropped, the print page falls back to the report's own
  // hiddenColumns and the PDF hides columns that are on the reader's screen.
  const off = new URLSearchParams(buildQs("2026-09-01", "2026-09-30", "tok", { q: "", hide: "" }));
  assert.ok(/(^|&)hide=(&|$)/.test(off.toString()), "an EMPTY hide is forwarded, not dropped");
  assert.ok(/(^|&)q=(&|$)/.test(off.toString()), "and an empty search with it");

  // Absent still means "the caller is not speaking about this".
  const none = new URLSearchParams(buildQs("2026-09-01", "2026-09-30", "tok", {}));
  assert.strictEqual(none.has("hide"), false, "absent stays absent");
  assert.strictEqual(none.has("q"), false, "absent stays absent");
});

test("a ?hide= link SETS the columns and does not rewrite the reader's default", () => {
  assert.ok(/const HIDE_IN_URL = SP\.has\('hide'\)/.test(page),
    "presence decides, not truthiness — an empty hide is a real answer");
  assert.ok(/if \(HIDE_IN_URL\) return SP\.getAll\('hide'\)/.test(page),
    "the URL wins over this browser's preference");
  assert.ok(/function saveHidden\(v\) \{\s*\n\s*if \(HIDE_IN_URL\) return;/.test(page),
    "and a link must not quietly become the reader's own default");
});

test("the exports and the print view all follow the search", () => {
  // The standing rule: a filter is not finished when the screen is right. Every
  // export reads shownRows, and shownRows is searched BEFORE it is collapsed —
  // subtotals for rows that are not on screen is the same defect one level up.
  assert.ok(/const kept = searchRows\(filterRows\(rows \|\| \[\], filters\), q\);/.test(page),
    "search then filter, then collapse");
  ["downloadCsv", "downloadExcel"].forEach(fn => {
    const body = page.slice(page.indexOf("function " + fn), page.indexOf("}", page.indexOf("function " + fn) + 200));
    assert.ok(/shownRows/.test(body), fn + " exports the narrowed rows");
  });
  assert.ok(/q \? u\.searchParams\.set\('q', q\)/.test(page), "and it is in the URL, so a link lands on it");
  // Excluded is never hidden: whoever prints this has no toolbar to look at.
  assert.ok(/q\.trim\(\) \? ' · search: "' \+ q\.trim\(\) \+ '"' : ''/.test(page),
    "the scope note names the search on the page");
});

test("the Metabase card id is off the report, and the cache warning is not", () => {
  const head = page.slice(page.indexOf('<div className="rep-head">'), page.indexOf("{loading &&"));
  assert.ok(!/Metabase card/.test(head), "internal plumbing on a report an org prints and files");
  assert.ok(/meta\.stale_cache && \(/.test(head),
    "the stale-cache warning STAYS — that is a fact about the figures");
});

test("a report with no public link yet is NOT offered", () => {
  // all-users has a real card (21715) and no public link. An entry whose uuid
  // is unset would build /api/public/card//query/json and surface Metabase's
  // own error, which reads as a BROKEN report rather than an unfinished one.
  // So the gate refuses it, the dashboard does not draw a chip for it, and the
  // routes 404 — the same shape as SHARED_UUIDS omitting an unset key.
  assert.match(srv, /if \(!spec\.uuid\) return false;/,
    "customReportEnabled requires a public link");
  const gate = srv.slice(srv.indexOf("function customReportEnabled"),
                         srv.indexOf("function customReportsForOrg"));
  assert.ok(gate.indexOf("spec.uuid") < gate.indexOf("spec.orgIds"),
    "and it is checked before the org, so a missing link is never an org problem");
});

test("every registered report names a card, a uuid and its org", () => {
  ["aquatic-lane-hours", "aquatic-classes", "aquatic-dropin", "aquatic-passes"].forEach(k => {
    const e = entryOf(k);
    assert.match(e, /card: 216\d\d/, k + " names its numeric card id");
    assert.match(e, /uuid: process\.env\.[A-Z_]+ \|\| "[0-9a-f-]{36}"/, k + " has a public uuid");
    assert.match(e, /orgIds: \[CUSTOM_REPORT_ORG_IDS\.elSegundo\]/, k + " is gated on the orgId");
    assert.doesNotMatch(e, /el-segundo/, k + " carries no slug");
  });
});

test("an out-of-date run cannot overwrite a newer one", () => {
  assert.match(page, /const seq = \+\+runSeq\.current/);
  assert.match(page, /if \(seq !== runSeq\.current\) return;/);
});

/* ── 12. The column order survives the cache ───────────────────────────────
   `feed_cache.v` is a Postgres jsonb column, and jsonb sorts an object's keys
   by length then bytes rather than keeping insertion order. So the row keys
   arrive SHUFFLED on any cached load, which at a four-hour TTL is nearly every
   load. Measured against production on card 21683, the same request:
     fresh   ... Sessions in Month, Session Hours, Collected, Refunded, Net Revenue
     cached  ... Refunded, Collected, Instructor, Section ID, Net Revenue, ...
   The server sends the order as an array, which jsonb does keep. */

test("the column order comes from meta, not from the shuffled row keys", () => {
  // Exactly the jsonb shuffle: (length, alphabetical) over the real card's headers.
  const shuffled = [
    { Month: "2026-09", Program: "P", Section: "S", Location: "L",
      Refunded: 1, Collected: 2, Instructor: "I", "Net Revenue": 3 },
  ];
  const declared = ["Month", "Location", "Program", "Section", "Instructor",
                    "Collected", "Refunded", "Net Revenue"];
  assert.deepStrictEqual(columnsOf(shuffled, { columns: declared }), declared,
    "the card's own order, off meta");
  // The pre-fix cache entry: no meta.columns, so it still renders — shuffled,
  // and self-healing on the next miss. Degrading, never blank.
  assert.deepStrictEqual(columnsOf(shuffled, {}), Object.keys(shuffled[0]),
    "an entry written before this shipped still renders");
  assert.deepStrictEqual(columnsOf(shuffled, null), Object.keys(shuffled[0]));
});

test("a stale meta.columns can neither invent a column nor lose one", () => {
  const rows = [{ A: 1, B: 2, C: 3 }];
  assert.deepStrictEqual(columnsOf(rows, { columns: ["C", "A", "GONE"] }), ["C", "A", "B"],
    "a name the card no longer emits is dropped; one it gained is kept");
  assert.deepStrictEqual(columnsOf(rows, { columns: [] }), ["A", "B", "C"]);
});

test("the server sends the order as an ARRAY", () => {
  assert.match(srv, /columns: safeRows\.length \? Object\.keys\(safeRows\[0\]\) : \[\]/,
    "taken from the first row, so it is still the card's order and not a transcription");
});

test("columnOrder is a PREFIX, and it survives the text/numeric split", () => {
  const cols = ["Household Role", "Rec ID", "First Name", "Last Name", "Email", "People"];
  assert.deepStrictEqual(orderCols(cols, ["First Name", "Last Name", "Email"]),
    ["First Name", "Last Name", "Email", "Household Role", "Rec ID", "People"],
    "what is named leads; everything else keeps the card's order behind it");
  assert.deepStrictEqual(orderCols(cols, []), cols, "no override is no change");
  assert.deepStrictEqual(orderCols(cols, ["Nope"]), cols, "a stale name matches nothing");
  // The table filters text and numeric out of this list, and both filters are
  // stable — so naming two numerics reorders them WITHIN the numeric block
  // rather than dragging them in front of the text columns.
  const mixed = ["Section", "Sessions in Month", "Refunded", "Collected", "Net Revenue"];
  const NUM = { "Sessions in Month": 1, Refunded: 1, Collected: 1, "Net Revenue": 1 };
  const ordered = orderCols(mixed, ["Collected", "Refunded", "Net Revenue"]);
  assert.deepStrictEqual(ordered.filter(c => !NUM[c]).concat(ordered.filter(c => NUM[c])),
    ["Section", "Collected", "Refunded", "Net Revenue", "Sessions in Month"],
    "collected, refunded, net — and the text column is still first");
});

test("All Users leads with the name", () => {
  const e = /"all-users": \{[\s\S]*?\n  \},/.exec(srv)[0];
  assert.match(e, /columnOrder: \["First Name", "Last Name", "Email"\]/);
  assert.match(srv, /columnOrder: spec\.columnOrder \|\| \[\]/, "and it reaches the page");
});

/* ── 13. Money reads as money ─────────────────────────────────────────────── */

test("a money column carries a dollar sign and a count does not", () => {
  assert.strictEqual(fmtNum(1234.5, 2, true), "$1,234.50");
  assert.strictEqual(fmtNum(1234.5, 2, false), "1,234.50");
  assert.strictEqual(fmtNum(1234, 0), "1,234", "a count is untouched");
  // Accounting style, and the sign goes OUTSIDE the currency mark — which is
  // how a finance office reads a credit and how CivicRec prints one.
  assert.strictEqual(fmtNum(-50, 2, true), "($50.00)");
  assert.strictEqual(fmtNum(-50, 2), "(50.00)");
  assert.strictEqual(fmtNum(null, 2, true), "", "an absent value is not $0.00");
  assert.strictEqual(fmtNum("", 2, true), "");
});

test("both the cell and the totals row read the money flag", () => {
  assert.match(page, /fmtNum\(r\[c\], NUMERIC\[c\]\.dp, NUMERIC\[c\]\.money\)/, "the cell");
  assert.match(page, /fmtNum\(totals\[c\], NUMERIC\[c\]\.dp, NUMERIC\[c\]\.money\)/, "the subtotal and grand total");
});

test("every money column in the registry is declared money, and no count is", () => {
  const reg = /const CUSTOM_REPORTS = \{[\s\S]*?\n\};/.exec(srv)[0];
  // Named one by one rather than pattern-matched: a column that IS money and
  // is not flagged renders a bare number beside flagged ones, which reads as a
  // count. These are the four cards' own headers.
  ["Collected", "Refunded", "Net Revenue", "Revenue \\(net of refunds\\)",
   "Cash", "Check", "Credit / Debit", "User Credit"].forEach(c => {
    const m = new RegExp('"' + c + '": \\{[^}]*money: true');
    assert.match(reg, m, c + " is money");
  });
  // ...and the counts beside them are not. "Refunds" is a COUNT on cards 21684
  // and 21685 while "Refunded" is money on 21683 — one letter apart.
  ["Admissions", "Sold", "Refunds", "Reservations", "Lane Hours", "People",
   "Sessions in Month", "Session Hours"].forEach(c => {
    const m = new RegExp('"' + c + '": \\{[^}]*money');
    assert.doesNotMatch(reg, m, c + " is a count, not money");
  });
});

test("exports carry the raw number, never the formatted one", () => {
  // A data file gets re-aggregated by whoever opens it, so "$1,234.50" is a
  // string that will not sum. Same argument that keeps the raw timestamp in it.
  const ft = liftFn(page, "flatTable");
  assert.doesNotMatch(ft, /fmtNum|cellText/, "flatTable formats nothing");
  const out = flatTable([{ A: 1234.5, B: "2026-09-09T22:58:30-07:00" }], ["A", "B"]);
  assert.strictEqual(out[1][0], 1234.5);
  assert.strictEqual(out[1][1], "2026-09-09T22:58:30-07:00");
});

/* ── 14. A timestamp a person can read ─────────────────────────────────────── */

test("a timestamp reads as a date and a time", () => {
  assert.strictEqual(prettyDate("2026-09-09T22:58:30.270278-07:00"), "Sep 9, 2026 10:58 PM");
  assert.strictEqual(prettyDate("2026-09-10T05:37:47.97003-07:00"),  "Sep 10, 2026 5:37 AM");
  assert.strictEqual(prettyDate("2026-09-10T00:04:00-07:00"), "Sep 10, 2026 12:04 AM", "midnight is 12 AM");
  assert.strictEqual(prettyDate("2026-09-10T12:04:00-07:00"), "Sep 10, 2026 12:04 PM", "noon is 12 PM");
  // The forms that were already handled must not move.
  assert.strictEqual(prettyDate("2026-08-19"), "Aug 19, 2026");
  assert.strictEqual(prettyDate("2026-08"), "August 2026");
  assert.strictEqual(prettyDate("Lego Club (library)"), "Lego Club (library)",
    "a value we cannot parse is one the card meant literally");
});

test("the timestamp is read off the string, never through new Date()", () => {
  // The card has already stamped these in the ORG's timezone. Parsing to an
  // instant and re-formatting renders them in the READER's zone, which moves a
  // late-evening signup onto the next day for anyone east of the org. Five
  // instances of that bug are recorded in CLAUDE.md. Comments are stripped
  // first: this one quotes the broken form on purpose.
  const fn = liftFn(page, "prettyDate").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(fn, /new Date|Date\.parse|toLocale/,
    "no instant parsing anywhere in it");
  // The proof, not the shape: an offset the reader is not in must not shift it.
  assert.strictEqual(prettyDate("2026-09-09T23:30:00+13:00"), "Sep 9, 2026 11:30 PM",
    "the wall clock the card wrote is the answer, whatever the offset says");
});

test("the cell and the search box read the same text", () => {
  // A reader who can SEE "Sep 9, 2026" has to be able to search for it.
  assert.match(page, /: cellText\(r\[c\]\)/, "the cell goes through it");
  const rows = [{ Name: "Ellen", "Created At": "2026-09-09T22:58:30-07:00" }];
  assert.strictEqual(searchRows(rows, "sep 9").length, 1, "what is on screen");
  assert.strictEqual(searchRows(rows, "2026-09-09").length, 1, "and the raw value still");
  assert.strictEqual(searchRows(rows, "sep 11").length, 0);
});

/* ── 15. An identifier is never a vocabulary ───────────────────────────────── */

test("a uuid column gets no filter menu, whatever its cardinality", () => {
  // Section ID is 45 uuids in a September window — under the cap, so the cap
  // let it through and the report offered a dropdown of 45 uuids.
  const ids = Array.from({ length: 45 }, (_, i) =>
    ({ "Section ID": "3b8c2479-1a22-4d34-b98a-" + String(i).padStart(12, "0"), Program: "P" }));
  assert.strictEqual(isFilterable(ids, "Section ID", 100), false, "45 uuids is not a vocabulary");
  assert.strictEqual(isFilterable(ids, "Program", 100), true, "the column beside it still gets one");
  // Judged over the values that HAVE one: a handful of blanks must not hand a
  // menu back to an id column.
  const withBlanks = ids.concat([{ "Section ID": "", Program: "P" }, { "Section ID": null, Program: "P" }]);
  assert.strictEqual(isFilterable(withBlanks, "Section ID", 100), false);
  // ...and a real vocabulary that merely LOOKS long is untouched.
  assert.strictEqual(isFilterable([{ L: "Urho Saari Swim Stadium" }], "L", 100), true);
});

test("the cardinality cap still does its own job", () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ Email: "a" + i + "@x.com" }));
  assert.strictEqual(isFilterable(many, "Email", 100), false, "a directory");
  assert.strictEqual(isFilterable(many.slice(0, 40), "Email", 100), true);
});

/* ── The base data reports ────────────────────────────────────────────────
   Dan, 2026-09-10: "Let's do these as 'base data reports' and scope them so
   they can live cross org. Build them out in El Segundo first."

   THE PORTABILITY CLAIM IS THE ONE WORTH GUARDING, because it is the whole
   difference between these three and the four aquatics reports beside them,
   and because it rots SILENTLY: a card that grows one hardcoded location name
   still renders perfectly for El Segundo and returns nothing for everybody
   else. The assertion below reads the SQL mirrors and fails on an org-specific
   literal, so "ready to turn on for another org" stays a fact rather than an
   intention. */
const BASE_DATA_REPORTS = ["credit-balances", "credit-ledger", "rental-refunds-due"];

/* LIFT AND RUN the registry rather than regexing it. A regex over
   `numeric: { ... }` passes on a key that is present and wrong; evaluating the
   literal lets these assertions ask what the server will actually read. The two
   names it closes over are supplied, so the slice cannot reach past its own
   inputs — the failure this file has already recorded three times. */
const registry = (() => {
  const orgIds = /const CUSTOM_REPORT_ORG_IDS = \{[\s\S]*?\n\};/.exec(srv)[0];
  return new Function("process", orgIds + "\n" + spec + "\nreturn CUSTOM_REPORTS;")({ env: {} });
})();

test("the registry evaluates, and holds every report the server serves", () => {
  // Guards the lift itself: if this stopped returning the real map, every
  // assertion below would be checking an empty object and passing vacuously.
  assert.ok(Object.keys(registry).length >= 5, "the lifted registry looks empty");
  ["aquatic-lane-hours", "all-users"].concat(BASE_DATA_REPORTS)
    .forEach(k => assert.ok(registry[k], k + " missing from the lifted registry"));
});

test("the base data reports are registered, and each names its card", () => {
  BASE_DATA_REPORTS.forEach(k => {
    const spec = registry[k];
    assert.ok(spec, k + " is missing from CUSTOM_REPORTS");
    assert.ok(Number.isInteger(spec.card) && spec.card > 0, k + " has no card id");
    assert.ok(spec.label && spec.desc, k + " needs a label and a description");
  });
});

test("their SQL carries NO org-specific literal — the portability claim", () => {
  // The aquatics cards hardcode El Segundo's three location names and its GL
  // code ladder, which is exactly why they are org-gated by necessity. These
  // must not: {{org_id}} is the only thing that scopes them.
  const mirrors = {
    "credit-balances": "credit-balances.sql",
    "credit-ledger": "credit-ledger.sql",
    "rental-refunds-due": "rental-refunds-due.sql",
  };
  // Org-specific shapes: a GL code ladder, a named El Segundo facility, or a
  // bare organisation uuid standing in for the parameter.
  const banned = [
    [/'001-\d{3}-/, "a hardcoded GL code"],
    [/Urho Saari|Wiseburn|Hilltop Park|El Segundo/i, "a named El Segundo facility"],
    [/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/, "a literal uuid"],
  ];
  BASE_DATA_REPORTS.forEach(k => {
    const file = path.join(root, "sql", "report-cards", mirrors[k]);
    assert.ok(fs.existsSync(file), "no SQL mirror for " + k);
    const sql = fs.readFileSync(file, "utf8");
    // Strip the comment header: it QUOTES the measurements, El Segundo included,
    // and the claim is about the query rather than about the prose above it.
    const body = sql.replace(/^\s*--.*$/gm, "");
    assert.ok(/\{\{org_id\}\}/.test(body), k + " does not scope on org_id at all");
    banned.forEach(([re, why]) => {
      assert.ok(!re.test(body), k + " carries " + why + " — it is not cross-org");
    });
  });
});

test("every base data report takes the same date range as the others", () => {
  // Dan, 2026-09-10: "those reports should have the same date range filters as
  // the others for consistency." So all three carry the window, and none of
  // them opts out of the toolbar — a report whose From/To did nothing would be
  // the dead control this repo keeps writing down.
  const mirrors = {
    "credit-balances": "credit-balances.sql",
    "credit-ledger": "credit-ledger.sql",
    "rental-refunds-due": "rental-refunds-due.sql",
  };
  BASE_DATA_REPORTS.forEach(k => {
    assert.ok(!registry[k].undated, k + " opts out of the shared date range");
    const sql = fs.readFileSync(path.join(root, "sql", "report-cards", mirrors[k]), "utf8");
    const body = sql.replace(/^\s*--.*$/gm, "");
    // OPTIONAL is load-bearing: the reports open unwindowed, and on refunds-due
    // the unwindowed read is the one the report is actually for.
    assert.ok(/\[\[[^\]]*\{\{start_date\}\}/.test(body), k + " has no optional start bound");
    assert.ok(/\[\[[^\]]*\{\{end_date\}\}/.test(body), k + " has no optional end bound");
    // Cast, so the card runs under a Date tag or a Text one — an API save
    // regenerates every tag as Text, and this is what makes that survivable.
    assert.ok(/\{\{start_date\}\}::date/.test(body), k + " does not cast start_date");
    assert.ok(/\{\{end_date\}\}::date/.test(body), k + " does not cast end_date");
  });
});

test("a POSITION is never windowed, and says so in its own column names", () => {
  // The balance report has two bases under one date range, which is precisely
  // what made the Programs summary read as a bug for weeks. There the
  // arithmetic was right and the LABELS were the defect, so every windowed
  // column here carries "in Period" and `Balance` does not.
  const n = registry["credit-balances"].numeric;
  assert.ok(n["Balance"], "Balance must still roll up");
  ["Issued in Period", "Used in Period", "Entries in Period"].forEach(c =>
    assert.ok(n[c], c + " is missing — a windowed column lost its label"));
  assert.ok(!n["Credit Issued"] && !n["Credit Used"],
    "a windowed column is named as though it were all-time");

  const sql = fs.readFileSync(path.join(root, "sql", "report-cards", "credit-balances.sql"), "utf8");
  const body = sql.replace(/^\s*--.*$/gm, "");
  // THE LOAD-BEARING ONE. Ledger Difference compares the live balance against
  // the WHOLE ledger; windowing that CTE makes every account with no activity
  // in range falsely read as drifted. Verified against real data: El Segundo
  // reads 1 drifted account over September, not 27.
  assert.ok(/all_time AS \(/.test(body), "the all-time CTE is gone");
  assert.ok(!/all_time AS \([\s\S]*?\{\{start_date\}\}[\s\S]*?\n\),/.test(body),
    "the all-time CTE got windowed — Ledger Difference would manufacture drift");
  assert.ok(/COALESCE\(t\.net_cents, 0\)/.test(body),
    "Ledger Difference no longer reads the all-time net");
});

test("a signed Amount column is never split into two unsigned ones", () => {
  // The ledger's monthly subtotal is the NET movement, which is what
  // reconciles against the balances report. Two unsigned columns would read
  // more tidily and would stop adding up.
  const n = registry["credit-ledger"].numeric;
  assert.ok(n["Amount"], "the ledger must roll up Amount");
  assert.ok(!n["Issued"] && !n["Used"], "Amount was split and no longer nets");
});

test("the refund queue carries an AGE, and the age never rolls up", () => {
  // The measurement that decides how the whole report reads: refunds that DO
  // happen are 95% done within seven days (median 0.5d, p95 7.0d over 11,022
  // refunded cancellations), so past a week the normal process was never going
  // to catch the item. Only 377 of 11,761 outstanding are inside that window;
  // median age is 155 days and median amount $5.00. Without the age column the
  // report hands an org 11,761 mostly-$5 rows and calls it a work queue.
  const sql = fs.readFileSync(path.join(root, "sql", "report-cards", "rental-refunds-due.sql"), "utf8");
  const body = sql.replace(/^\s*--.*$/gm, "");
  assert.ok(/AS "Days Waiting"/.test(body), "the age column is gone");
  assert.ok(/CURRENT_DATE - cx\.canceled_at::date/.test(body),
    "the age is not measured from the cancellation");
  // An age is a property of ONE booking. Summing it down the column adds up
  // nothing anyone wants — the same treatment as Sites.
  assert.ok(!registry["rental-refunds-due"].numeric["Days Waiting"],
    "Days Waiting must not roll up");
  // Worked by amount, not by date: the old LARGE rows are the actionable ones.
  assert.ok(/ORDER BY 1, \(m\.paid_cents - m\.refunded_cents\) DESC/.test(body),
    "the queue is no longer ordered biggest-first");
});

test("Sites is NOT additive, and Ledger Difference is not the headline", () => {
  // Summing a per-booking court count down the column adds up nothing anyone
  // wants — the same trap as the wizard summing Number of Payments.
  assert.ok(!registry["rental-refunds-due"].numeric["Sites"],
    "Sites must not roll up");
  assert.ok(registry["rental-refunds-due"].hiddenColumns.includes("Sites"));
  // The reconciliation is available and is not the point of the report.
  assert.ok(registry["credit-balances"].hiddenColumns.includes("Ledger Difference"));
  assert.ok(registry["credit-balances"].numeric["Ledger Difference"],
    "it still has to roll up once someone unhides it");
});
}

/* ══ LIVE HALF ═══════════════════════════════════════════════════════════
   Boots a real server against a fixture org and drives the real routes. The
   Metabase URL points at a dead port: nothing here needs the card to answer,
   and a spec that reaches production to prove a gate is a spec that fails when
   the replica is busy. */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-reports-"));
const PORT = 3400 + Math.floor(Math.random() * 400);
const EL_SEGUNDO = "8ae77057-6bce-4c20-b0f2-366ed5fa14dd";
fs.writeFileSync(path.join(dataDir, "orgs.json"), JSON.stringify({
  "fixture-el-segundo": { token: "aqYES0000token", orgId: EL_SEGUNDO, logoUrl: "", displayName: "Fixture El Segundo" },
  "fixture-other":      { token: "aqNO00000token",  orgId: "11111111-2222-3333-4444-555555555555", logoUrl: "", displayName: "Fixture Other" },
}));
// A completed warm, so the boot does not fan out across ~28 orgs against
// production Metabase — the self-inflicted load CLAUDE.md records twice.
fs.writeFileSync(path.join(dataDir, "prewarm-state.json"),
  JSON.stringify({ lastCompletedAt: new Date().toISOString() }));

const child = spawn(process.execPath, [path.join(root, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
         METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", d => { out += d; });
child.stderr.on("data", d => { out += d; });

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "GET", timeout: 20000 }, res => {
      let b = ""; res.on("data", d => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}
function post(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", timeout: 20000 }, res => {
      let b = ""; res.on("data", d => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}
const waitUp = () => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    if (Date.now() - t0 > 45000) return reject(new Error("server did not boot:\n" + out.split("\n").slice(-15).join("\n")));
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 2000 }, res => { res.resume(); resolve(); });
    r.on("error", () => setTimeout(tick, 400));
    r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
  };
  tick();
});
const events = () => {
  try {
    return fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
};

(async () => {
  try { await waitUp(); }
  catch (e) { console.error("✗ " + e.message); process.exit(1); }

  console.log("\ncustom-reports.spec.js — live\n");

  await atest("the org it was built for gets the page", async () => {
    const r = await get("/fixture-el-segundo/aquatic-lane-hours?token=aqYES0000token");
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /"reportLabel":"Aquatic Lane Hours"/, "and its config is injected server-side");
    assert.match(r.body, /"cardId":21682/);
    assert.match(r.body, /"groupBy":\["Month","Location"\]/);
  });

  await atest("every other org gets a 404, token or not", async () => {
    assert.strictEqual((await get("/fixture-other/aquatic-lane-hours?token=aqNO00000token")).status, 404,
      "a valid token for the wrong org is still a 404");
    assert.strictEqual((await get("/fixture-other/aquatic-lane-hours/api/data?token=aqNO00000token")).status, 404,
      "and so is its feed");
    assert.strictEqual((await get("/fixture-el-segundo/aquatic-lane-hours")).status, 404,
      "and the org token is still required");
  });

  await atest("the card is on the right org's dashboard and nobody else's", async () => {
    const mine = await get("/fixture-el-segundo?token=aqYES0000token");
    assert.match(mine.body, /"reports":\[[^\]]*"aquatic-lane-hours"/);
    assert.match(mine.body, /"customReportMeta":\{"aquatic-lane-hours":\{"label":"Aquatic Lane Hours"/);
    const other = await get("/fixture-other?token=aqNO00000token");
    assert.doesNotMatch(other.body, /aquatic-lane-hours/);
  });

  await atest("the beacon records the download, keyed to the report", async () => {
    const r = await post("/fixture-el-segundo/aquatic-lane-hours/api/log?event=report-csv&n=862&location=Urho%20Saari%20Swim%20Stadium&token=aqYES0000token");
    assert.strictEqual(r.status, 200);
    const e = events().filter(x => x.event === "report-csv").pop();
    assert.ok(e, "a row reached events.jsonl — a 200 alone would not prove that");
    assert.strictEqual(e.report, "aquatic-lane-hours",
      "the report TYPE, not a label smuggled in through `extra`");
    assert.strictEqual(e.rows, 862);
    assert.strictEqual(e.location, "Urho Saari Swim Stadium");
  });

  await atest("an unknown event and a foreign org are both refused", async () => {
    assert.strictEqual((await post("/fixture-el-segundo/aquatic-lane-hours/api/log?event=nope&token=aqYES0000token")).status, 400);
    assert.strictEqual((await post("/fixture-other/aquatic-lane-hours/api/log?event=excel&token=aqNO00000token")).status, 404);
  });

  await atest("the counts are clamped here, never echoed", async () => {
    await post("/fixture-el-segundo/aquatic-lane-hours/api/log?event=excel&n=99999999999&location=" +
               encodeURIComponent("x".repeat(400)) + "&token=aqYES0000token");
    const e = events().filter(x => x.event === "excel").pop();
    assert.strictEqual(e.rows, undefined, "an out-of-range count is dropped, not stored");
    assert.strictEqual(e.location.length, 80, "and a long string is clamped");
  });

  await atest("NOT ONE of those refusals posted a DEAD LINK alert", async () => {
    // The fixture tokens are 8+ chars ON PURPOSE. noteDeadLink() ignores a
    // shorter one as bot noise, so with "tok-no" this assertion was VACUOUS and
    // the mutation that unmarks the refusal survived it.
    // noteDeadLink() keys on "a 404 that arrived with a valid-looking token",
    // which is byte-identical to the shape of every refusal above. Without the
    // deliberate-404 marking, disabling this report for an org posts one alert
    // per click, naming the path the 404 exists to keep quiet. Verified to fire
    // before the marking was added.
    const dead = events().filter(e => e.event === "deadlink");
    assert.strictEqual(dead.length, 0,
      "got " + dead.length + ": " + dead.map(d => d.path).join(", "));
  });

  child.kill("SIGKILL");
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}

  if (failures.length) {
    console.error("\n✗ custom-reports.spec.js — " + failures.length + " failure(s):\n");
    failures.forEach(f => console.error("  ✗ " + f));
    console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
    process.exit(1);
  }
  console.log("\n✓ custom-reports.spec.js — " + pass + " assertions passed.");
})();
