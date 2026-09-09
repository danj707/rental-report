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
  return { numOf, fmtNum, prettyDate, columnsOf, groupRows, flattenTree, flatTable };
`)(NUMERIC_FIXTURE,
   ['January','February','March','April','May','June','July','August','September','October','November','December']);
const { fmtNum, prettyDate, columnsOf, groupRows, flattenTree, flatTable } = lifted;

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
  assert.match(page, /csvFromRows\(flatTable\(rows, cols\)\)/,
    "one CSV writer, not a per-page quoting rule");
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
  assert.doesNotMatch(spec, /City-wide/, "card 1 sells no Rec IDs, so it must not offer that value");
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
  assert.match(page, /logClientEvent\('report-csv', \{ n: rows\.length/,
    "the row count travels with it");
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
  assert.match(page, /GROUP_BY\.filter\(g => cols\.includes\(g\)\)/);
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
