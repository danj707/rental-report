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
const lifted = new Function("NUMERIC", "MONTHS", `
  ${liftFn(page, "numOf")}
  ${liftFn(page, "fmtNum")}
  ${liftFn(page, "prettyDate")}
  ${liftFn(page, "columnsOf")}
  ${liftFn(page, "groupRows")}
  ${liftFn(page, "flattenTree")}
  ${liftFn(page, "flatTable")}
  ${liftFn(page, "levelsSafe")}
  ${liftFn(page, "collapseRows")}
  ${liftFn(page, "filterRows")}
  ${liftFn(page, "valueCountsFor")}
  return { numOf, fmtNum, prettyDate, columnsOf, groupRows, flattenTree, flatTable,
           levelsSafe, collapseRows, filterRows, valueCountsFor };
`)(NUMERIC_FIXTURE,
   ['January','February','March','April','May','June','July','August','September','October','November','December']);
const { fmtNum, prettyDate, columnsOf, groupRows, flattenTree, flatTable,
        levelsSafe, collapseRows, filterRows, valueCountsFor } = lifted;

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
