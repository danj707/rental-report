#!/usr/bin/env node
/* panel-csv.spec.js — the tables behind the charts are downloadable.
 *
 * Dan, 2026-09-03: "they are pretty to look at, but harder to get the actual
 * data out that they need." Every report exported ONE sheet of raw rows and
 * none of the chart aggregates, so "hours by lane" or "money by month" had to
 * be re-derived by hand — and the hour maths is not in the export at all.
 *
 * The design this pins: ONE builder per table, called by BOTH the per-panel
 * download link and the workbook sheet. A source assertion cannot tell a sheet
 * that shares a builder from one that reimplements it, so the builders are
 * LIFTED AND RUN and the counts of their callers are asserted.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { failures.push(name + " — " + e.message); console.log("  ✗ " + name); }
};

const root = path.join(__dirname, "..");
const fac = fs.readFileSync(path.join(root, "public/facilities.html"), "utf8");
const prog = fs.readFileSync(path.join(root, "public/programs.html"), "utf8");
const openPdf = fs.readFileSync(path.join(root, "public/open-pdf.js"), "utf8");
const srv = fs.readFileSync(path.join(root, "server.js"), "utf8");
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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

/* ── 1. ONE CSV writer, shared ─────────────────────────────────────────── */
const win = {};
new Function("window", "document", openPdf)(win,
  { addEventListener() {}, querySelector() { return null; } });
const csvFromRows = win.csvFromRows;

test("csvFromRows lives in the shared file, not per page", () => {
  assert.ok(typeof csvFromRows === "function", "open-pdf.js exports csvFromRows");
  assert.doesNotMatch(strip(fac), /function\s+\w*[cC]sv(Cell|Escape)\s*\(/,
    "facilities does not grow its own quoting rule");
  assert.doesNotMatch(strip(prog), /function\s+\w*[cC]sv(Cell|Escape)\s*\(/,
    "and neither does programs");
});

test("a value with a comma, a quote or a newline is quoted RFC4180", () => {
  // Both cases are REAL: El Segundo has a lane called 'Inst Lane 4-2" Depth
  // (25Y) - A', and a section named "Camp, Red" shifts every column after it.
  assert.strictEqual(csvFromRows([["a"], ['Inst Lane 4-2" Depth']]),
    'a\r\n"Inst Lane 4-2"" Depth"\r\n');
  assert.strictEqual(csvFromRows([["a"], ["Camp, Red"]]), 'a\r\n"Camp, Red"\r\n');
  assert.ok(csvFromRows([["a"], ["x"]]).endsWith("\r\n"),
    "CRLF throughout — some Windows importers refuse a bare LF");
});

test("an empty cell is empty, never the text null", () => {
  assert.strictEqual(csvFromRows([["a", "b"], [null, undefined]]), "a,b\r\n,\r\n");
});

test("a Date is written ISO, not in a locale a sheet would re-parse", () => {
  // "8/31/26" is read as 31 August or as an error depending on the reader's
  // locale; the ISO form is unambiguous.
  assert.match(csvFromRows([["d"], [new Date("2026-08-31T00:00:00Z")]]), /2026-08-31/);
});

/* ── 2. The Aquatics builders, RUN ─────────────────────────────────────── */
const AQ = new Function(`
  const CFG = { slug: 'x' };
  const oeHour12 = h => { const x = ((h % 24) + 24) % 24; return ((x % 12) || 12) + (x < 12 ? 'a' : 'p'); };
  ${liftFn(fac, "siteLabel")}
  const AQ_MONEY = v => Math.round((Number(v) || 0) * 100) / 100;
  ${liftFn(fac, "aqCsvLaneHours")}
  ${liftFn(fac, "aqCsvDayPart")}
  ${liftFn(fac, "aqCsvBySite")}
  ${liftFn(fac, "aqCsvByMonth")}
  ${liftFn(fac, "aqCsvWeekdayMonth")}
  ${liftFn(fac, "aqCsvMix")}
  ${liftFn(fac, "aqCsvPartySize")}
  return { aqCsvLaneHours, aqCsvDayPart, aqCsvBySite, aqCsvByMonth, aqCsvWeekdayMonth,
           aqCsvMix, aqCsvPartySize };
`)();

test("lane hours come out per lane, with the block average computed", () => {
  const out = AQ.aqCsvLaneHours([
    { lane: "South Lane 8 - A", location: "Wiseburn", hours: 10, bookings: 4 },
    { lane: "North Lane 7 - B", location: "Wiseburn", hours: 3, bookings: 0 },
  ]);
  assert.deepStrictEqual(out[0],
    ["Lane", "Location", "Hours booked", "Bookings", "Avg block (hours)"]);
  assert.deepStrictEqual(out[1], ["South Lane 8 - A", "Wiseburn", 10, 4, 2.5]);
  assert.strictEqual(out[2][4], "",
    "a lane with no bookings gets a BLANK average, not a divide by zero");
});

test("the day-part grid comes out LONG, one row per weekday per hour", () => {
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  heat[3][13] = 9;
  const out = AQ.aqCsvDayPart({ heat });
  assert.strictEqual(out.length, 1 + 7 * 24, "7 x 24 unpivoted, so it pivots");
  const row = out.find(r => r[0] === "Wed" && r[1] === 13);
  assert.deepStrictEqual(row, ["Wed", 13, "1p", 9]);
});

test("a missing grid yields a header and no rows, not a throw", () => {
  assert.deepStrictEqual(AQ.aqCsvDayPart(null).length, 1);
});

test("the site table carries the LANE NAME, not the sublane letter", () => {
  // The label rule that printed "A" twelve times on El Segundo's chart.
  const out = AQ.aqCsvBySite([
    { facility: "North Lane 7 - A", location: "Wiseburn", bookings: 92, canceled: 1,
      revenue: 795.5, guests: 92 },
  ]);
  assert.strictEqual(out[1][0], "North Lane 7 - A",
    "siteLabel keeps the whole name; the old split kept only the trailing letter");
  assert.strictEqual(out[1][4], 795.5, "money rounds to the cent");
});

test("a site named for its own location has the prefix trimmed, once", () => {
  const out = AQ.aqCsvBySite([
    { facility: "Riverside Park - Oak Pavilion", location: "Riverside Park",
      bookings: 1, canceled: 0, revenue: 0, guests: 0 },
  ]);
  assert.strictEqual(out[1][0], "Oak Pavilion");
});

test("weekday-by-month is long too, and a month with no cell reads 0", () => {
  const out = AQ.aqCsvWeekdayMonth(["2026-08"], { "2026-08": null });
  assert.strictEqual(out.length, 1 + 7);
  assert.strictEqual(out[1][2], 0, "an absent cell is 0, never blank or NaN");
});

test("the month table keeps canceled separate from booked", () => {
  const out = AQ.aqCsvByMonth(["2026-08"],
    { "2026-08": { bookings: 10, canceled: 3, revenue: 99.994 } });
  assert.deepStrictEqual(out[1], ["2026-08", 10, 3, 99.99]);
});

test("the booking mix names both channels", () => {
  const out = AQ.aqCsvMix([{ label: "Instant-book", n: 2, revenue: 5 },
                           { label: "Staff-booked", n: 8, revenue: 50 }]);
  assert.deepStrictEqual(out.map(r => r[0]), ["Channel", "Instant-book", "Staff-booked"]);
});

test("party size comes out as its buckets", () => {
  const out = AQ.aqCsvPartySize([{ label: "1–5 guests", v: 7 }]);
  assert.deepStrictEqual(out[1], ["1–5 guests", 7]);
});

/* ── 3. The Programs builders, RUN ─────────────────────────────────────── */
const PR = new Function(`
  const PROG_MONEY = v => Math.round((Number(v) || 0) * 100) / 100;
  ${liftFn(prog, "progCsvByMonth")}
  ${liftFn(prog, "progCsvByKey")}
  return { progCsvByMonth, progCsvByKey };
`)();

test("by-month carries BOTH readings, because they peak apart", () => {
  // At El Segundo programming peaks in September and money in August. A file
  // with one series would invite exactly the confusion the panel prevents.
  const out = PR.progCsvByMonth(
    [{ month: "2026-08", sections: 57, future: false },
     { month: "2026-09", sections: 167, future: true }],
    [{ month: "2026-08", value: 77812.83 }]);
  assert.deepStrictEqual(out[0],
    ["Month", "Sections running", "Money collected", "Month in the future"]);
  assert.deepStrictEqual(out[1], ["2026-08", 57, 77812.83, "no"]);
  assert.deepStrictEqual(out[2], ["2026-09", 167, "", "yes"],
    "a future month with no money is BLANK, not 0 — unsold is not earned-nothing");
});

test("by-location and by-instructor are SECTION grain", () => {
  // A location and an instructor are facts about a section: 11.6% of programs
  // with a located section run at more than one site, so a program-grain
  // rollup would file money against a site the reader excluded.
  const secs = [
    { location: "Urho Saari", instructor: "Naomi", enrolled: 10, capacity: 20,
      periodReceived: 100, periodRefunds: 5 },
    { location: "Urho Saari", instructor: "", enrolled: 5, capacity: 10,
      periodReceived: 50, periodRefunds: 0 },
  ];
  const byLoc = PR.progCsvByKey(secs, "location", "Location");
  assert.deepStrictEqual(byLoc[0][0], "Location");
  assert.deepStrictEqual(byLoc[1], ["Urho Saari", 2, 15, 30, 50, 150, 5],
    "two sections summed, fill % computed from the totals");

  const byIns = PR.progCsvByKey(secs, "instructor", "Instructor");
  const none = byIns.find(r => r[0] === "(none on file)");
  assert.ok(none, "A BLANK INSTRUCTOR IS ITS OWN ROW, not dropped: 65% of El " +
    "Segundo's sections have none, and silently omitting them would make the " +
    "file disagree with the enrolment total on screen");
  assert.strictEqual(none[2], 5);
});

test("a zero capacity yields a blank fill %, never a divide by zero", () => {
  const out = PR.progCsvByKey([{ location: "X", enrolled: 3, capacity: 0 }],
                              "location", "Location");
  assert.strictEqual(out[1][4], "");
});

/* ── 4. ONE builder, TWO readers ───────────────────────────────────────── */
test("every Aquatics builder is read by BOTH a panel link and the workbook", () => {
  const body = strip(fac);
  // aqSheetTables is the workbook's registry; the panel links are the
  // e(PanelCsv, ...) call sites. A builder called once is a table you can get
  // one way but not the other.
  const sheets = body.slice(body.indexOf("function aqSheetTables"),
                            body.indexOf("function PanelCsv"));
  ["aqCsvBySite", "aqCsvByMonth", "aqCsvWeekdayMonth", "aqCsvMix"].forEach(fn => {
    assert.ok(sheets.includes(fn + "("), fn + " is in the workbook registry");
    assert.ok((body.match(new RegExp(fn + "\\(", "g")) || []).length >= 3,
      fn + " is called by its definition, the panel link and the sheet");
  });
});

test("the lane-hours tables are panel-only, and that is deliberate", () => {
  // They come from card 17294, which this page fetches only inside the
  // lane-hours panel. A sheet would have to re-fetch and re-reduce, which is
  // the second implementation this design exists to avoid.
  const body = strip(fac);
  const sheets = body.slice(body.indexOf("function aqSheetTables"),
                            body.indexOf("function PanelCsv"));
  assert.ok(!sheets.includes("aqCsvLaneHours"));
  assert.ok(body.includes("aqCsvLaneHours(lanes)"), "but the panel offers them");
  assert.ok(body.includes("aqCsvDayPart(hg)"));
});

test("the download goes through the popup, or the browser drops it", () => {
  // A download started from a sandboxed iframe is silently discarded — the
  // reason open-pdf.js exists at all.
  assert.match(strip(fac), /window\.saveTextViaPopup\(window\.csvFromRows\(rows\)/);
  assert.match(strip(prog), /window\.saveTextViaPopup\(window\.csvFromRows\(rows\)/);
  assert.match(strip(fac), /bom: true/, "and asks for the BOM, so Excel reads accents");
  assert.match(strip(prog), /bom: true/);
});

test("a table with no rows offers no control", () => {
  // "Renders a link that downloads a header and nothing else" and "renders
  // nothing" are different claims, and only one of them is not a dead end.
  assert.match(strip(fac), /if \(!rows \|\| rows\.length < 2\) return null;/);
  assert.match(strip(prog), /if \(!rows \|\| rows\.length < 2\) return null;/);
});

test("the workbook skips an empty table rather than writing a bare header", () => {
  assert.ok((strip(fac).match(/rows\.length < 2\) return;/g) || []).length >= 1);
  assert.ok((strip(prog).match(/rows\.length < 2\) return;/g) || []).length >= 1);
});

test("the Programs sheets are scoped to what is ON SCREEN", () => {
  // The Excel export reading the unscoped rows is a bug this file has already
  // had: an admin who narrowed to one location got the whole org.
  const body = strip(prog);
  const xl = body.slice(body.indexOf("function downloadExcel"),
                        body.indexOf("function logClientEvent"));
  assert.match(xl, /filteredRows/, "the sheets derive from filteredRows");
  assert.doesNotMatch(xl, /const secRows = \(rows \|\|/,
    "and never from the unscoped feed");
});

/* ── 5. The beacon ─────────────────────────────────────────────────────── */
test("panel-csv reaches the activity feed on both routes", () => {
  // `facilities` is NOT in REPORT_TYPES, so the hub needs its own log route;
  // `programs` is, so it rides the generic one. Both allowlists must carry it
  // or the beacon 400s and, being fire-and-forget, never complains — the trap
  // that has bitten this repo four times.
  assert.match(srv, /"game", "summary", "outdoor", "fields", "panel-csv"/,
    "the facilities hub route allows it");
  assert.match(srv, /"ft-export", "panel-csv", "intel-csv"\];/,
    "the generic report route allows it");
  // SLACK_NOTIFY is a Set, so its literal ends `]);` where the route array
  // ends `];` — that is the only thing telling these two assertions apart.
  assert.match(srv, /"ft-export", "panel-csv", "intel-csv"\]\);/,
    "and it is in SLACK_NOTIFY, or it is recorded and never posted");
});

test("the message NAMES the panel, and debounces by it", () => {
  // "downloaded chart data from *facility*" says nothing about which chart,
  // which is the only part of this event worth reading. And pulling lane hours
  // then revenue-by-site is two needs: the default org|report|event key would
  // keep whichever was clicked first.
  assert.match(srv, /rec\.event === "panel-csv"\s*\n\s*\? `\$\{rec\.org\}\|\$\{rec\.report\}\|panel-csv\|\$\{rec\.panel \|\| ""\}`/,
    "debounced per panel");
  assert.match(srv, /downloaded \$\{panel\} as CSV/, "and the panel is in the text");
});

test("the panel name is clamped server-side, never echoed", () => {
  assert.match(srv, /panel: String\(req\.query\.panel \|\| ""\)\.slice\(0, 60\)/);
  assert.ok((srv.match(/String\(req\.query\.panel \|\| ""\)\.slice\(0, 60\)/g) || []).length === 2,
    "on both routes");
});

/* ── 6. Community Intel: the contact lists download again ─────────────── */
const users = fs.readFileSync(path.join(root, "public/users.html"), "utf8");

test("the request-only modal is gone, and so is its state", () => {
  // It existed only to block the download: seven buttons opened a sheet saying
  // exports were withdrawn and pointing the reader at an email address. Dan
  // re-enabled them — the households are the org's own residents, and emailing
  // the lapsing ones is the point of the segment.
  assert.doesNotMatch(users, /CSV Export Restricted/,
    "the restriction sheet is removed, not merely unreachable");
  assert.doesNotMatch(users, /no longer available for direct download/);
  assert.doesNotMatch(users, /requestCSV/,
    "and no caller is left pointing at a function that no longer exists");
  assert.doesNotMatch(users, /csvRequestModal/, "nor its state");
});

test("all seven segments download, through the ONE writer", () => {
  const want = ["unbooked", "non-resident", "solo-unbooked", "lapsing",
                "programs-only", "facility-only", "engaged"];
  want.forEach(seg => assert.ok(users.includes("'" + seg + "'"),
    seg + " is a downloadable segment"));
  // One writer, so the column set cannot drift between segments.
  assert.strictEqual((users.match(/function downloadContacts\(/g) || []).length, 1);
  // EIGHT call sites for seven segments: `unbooked` is offered twice, from the
  // leverage list and from its own button, and both must reach the same writer.
  assert.strictEqual((users.match(/downloadContacts\(/g) || []).length, 1 + 8,
    "eight call sites and one definition");
  assert.match(users, /window\.saveTextViaPopup\(window\.csvFromRows\(rows\)/,
    "and it goes through the shared writer and the popup");
  assert.match(users, /bom: true/, "with the BOM, so an accented name is not mojibake");
});

test("an empty list yields no file", () => {
  assert.match(users, /if \(!list \|\| !list\.length\) return;/,
    "a download that produces a header and nothing else is a dead end");
});

test("EVERY contact download is on the record", () => {
  // This is what pays for the download being direct: the files carry resident
  // names, emails and phone numbers, so a list leaving the platform with no
  // record of who took what is the thing to avoid.
  assert.match(users, /event=intel-csv&segment=/,
    "the beacon names the segment");
  assert.match(users, /&n=' \+ list\.length/, "and the contact count");
  assert.match(srv, /"panel-csv", "intel-csv"\];/, "the log route allows it");
  assert.match(srv, /"panel-csv", "intel-csv"\]\);/, "and it is in SLACK_NOTIFY");
  assert.match(srv, /downloaded the \$\{seg\} contact list/,
    "the message names the segment, not just that an export happened");
  assert.match(srv, /rec\.event === "intel-csv"\s*\n\s*\? `\$\{rec\.org\}\|\$\{rec\.report\}\|intel-csv\|\$\{rec\.segment \|\| ""\}`/,
    "debounced per segment — two lists leaving is two records");
  assert.match(srv, /segment: String\(req\.query\.segment \|\| ""\)\.slice\(0, 60\)/,
    "and the segment is clamped server-side, never echoed");
});

test("the contact columns are one list, declared once", () => {
  assert.match(users, /var INTEL_COLS = \['First Name', 'Last Name', 'Email'/,
    "the header is a named constant, so seven files cannot carry seven shapes");
});

/* ── report ─────────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error("\n✗ panel-csv.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("\n✓ panel-csv.spec.js — " + pass + " assertions passed.");
