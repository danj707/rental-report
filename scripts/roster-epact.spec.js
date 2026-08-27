// Spec for the Class Roster's ePACT export and its tightened default window.
//
// THE ASK (Dan, 2026-08-27): orgs upload participant lists into ePACT, an
// outside HIPAA vendor holding camp health forms. Melinda at Apex produces that
// list by hand from a Metabase SQL. "The 'export' button needs to exactly
// reproduce what's shown in the sql from the class roster… Would love the export
// button to live on the row header for the section and in the top toolbar."
//
// WHAT "EXACTLY REPRODUCE" TURNED OUT TO MEAN. Her five columns map onto the
// roster feed, but two of the mappings are traps and both are pinned here:
//
//  1. `Household Owner Email` is NOT the roster's `Owner Email`. Her SQL
//     computes COALESCE(NULLIF(participant.email,''), owner.email) — which is
//     exactly the card's `Email` column. The roster's `Owner Email` is
//     owner.email ALONE. Her LABEL says Owner and her SQL does not, so the
//     mapping that reads right is the wrong one, and it is wrong silently: most
//     child participants have no email of their own, so the two columns agree on
//     the majority of rows and diverge only for the teenagers.
//
//  2. SELECT DISTINCT is load-bearing. Measured at apex: it collapses 82,244
//     rows to 82,127 — the same participant in the same section on the same
//     DATE, from two sessions that day. The roster feed is participant × session
//     grain, so without it those campers are uploaded twice.
//
// And two of her clauses are already true of the feed, verified rather than
// assumed (apex, 2026-08-27, against card 17296 and the read replica):
//
//    b.status='confirmed' AND b.canceled_at IS NULL
//        The card is restricted to b.status IN ('confirmed','cancelled') and
//        derives Status from canceled_at alone, so roster `Enrolled` IS her set:
//        0 bookings are status='cancelled' with a null canceled_at, so the two
//        cannot diverge. 16,831 are confirmed-then-cancelled; both sides drop
//        them, which is why this export ignores the on-screen status pill.
//    JOIN order_item  →  a NO-OP: all 82,244 qualifying bookings have one.
//
// ALSO PINNED: the default date range. The roster prints a block per session
// date, so a calendar month at apex opened at ~382 pages before the reader had
// chosen anything. Dan: "the goal should be for an admin to start at a tightly
// filtered view so they can see what the options are, then set date ranges and
// type in partial section names, click 'run'."
//
// Run: node scripts/roster-epact.spec.js
"use strict";

// The date conversion has to be timezone-FREE, and the only way a spec can show
// that is to run it somewhere a Date-based implementation would give a different
// answer. Two things had to be got right here, and the first version of this
// guard got the second one wrong:
//
//   - UTC (this sandbox and GitHub Actions) discriminates nothing: every
//     implementation agrees there.
//   - America/New_York, the obvious choice and the one fasttrack-dates.spec.js
//     uses, does not discriminate EITHER for this input. The card emits
//     MM/DD/YYYY, new Date() reads that as LOCAL midnight, and local midnight in
//     any US zone is still the same DATE once converted to UTC. The mutation
//     survived the whole spec under Eastern.
//
// A zone EAST of UTC is what separates them: local midnight there is the
// previous day in UTC, so `new Date(s).toISOString().slice(0,10)` loses a day.
// The zone is chosen for that property, not because an org is in it.
const TZ = "Asia/Tokyo";
if (process.env.TZ !== TZ) {
  const r = require("child_process").spawnSync(process.execPath, [__filename],
    { env: Object.assign({}, process.env, { TZ }), stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const PAGE = fs.readFileSync(path.join(ROOT, "public", "roster.html"), "utf8");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const POPUP = fs.readFileSync(path.join(ROOT, "public", "open-pdf.js"), "utf8");

let n = 0;
const ok = (cond, what) => { n++; assert.ok(cond, what); };
const is = (a, b, what) => { n++; assert.deepStrictEqual(a, b, what); };

// ── Lift the real helpers and RUN them ──────────────────────────────────────
// The page builds a React tree at module scope, so the whole block cannot be
// evaluated. Slicing the pure helpers out and executing them is the difference
// between a guard and a regex over our own patch (the nightStateFrom lesson).
// The slice now begins at the settings readers, because the ePACT helpers
// consult them (a per-org column set and label format). Lifting the real RS()
// rather than stubbing it is what lets the assertions below drive a configured
// org through the shipping code.
const rstart = PAGE.indexOf("function RS() {");
ok(rstart > 0, "roster.html should declare RS()");
const start = PAGE.indexOf("const EPACT_HEADERS = [");
ok(start > 0, "roster.html should declare EPACT_HEADERS");
const end = PAGE.indexOf("\n}", PAGE.indexOf("function epactFileSlug("));
ok(end > start, "roster.html should declare epactFileSlug after EPACT_HEADERS");

const dstart = PAGE.indexOf("const ROSTER_DEFAULT_DAYS =");
ok(dstart > 0, "roster.html should declare ROSTER_DEFAULT_DAYS");
const dend = PAGE.indexOf("\n}", PAGE.indexOf("function getDefaultRange("));
const toISO = PAGE.slice(PAGE.indexOf("function toISO("));

// Evaluated as an IIFE in THIS realm rather than in a fresh vm context: a cross-
// realm array has a different Array.prototype, and deepStrictEqual fails on two
// identical-looking arrays for that reason alone.
const NAMES = ["EPACT_HEADERS", "epactIsoDate", "epactLabel", "epactRows", "epactCsv",
               "epactFileSlug", "getDefaultRange", "ROSTER_DEFAULT_DAYS"];
// `window` is injected so a test can set ORG_CONFIG and drive a CONFIGURED org
// through the same code an unconfigured one uses.
const WIN = { ORG_CONFIG: {} };
const lifted = vm.runInThisContext("(function(window){"
  + PAGE.slice(rstart, PAGE.indexOf("\n}", PAGE.indexOf("function rsShown(")) + 2) + "\n"
  + toISO.slice(0, toISO.indexOf("\n}") + 2) + "\n"
  + PAGE.slice(dstart, dend + 2) + "\n"
  + PAGE.slice(start, end + 2) + "\n"
  + "return { RS, rsDefaultDays, rsShown, epactColumns, epactVerified, EPACT_FIELDS, "
  + NAMES.join(", ") + " }; })")(WIN);
const { EPACT_HEADERS, epactIsoDate, epactLabel, epactRows, epactCsv, epactFileSlug,
        getDefaultRange, ROSTER_DEFAULT_DAYS, epactColumns, epactVerified, EPACT_FIELDS } = lifted;
// Every test below runs with NO org settings unless it says otherwise, so the
// unconfigured path — which is every org until someone opens the panel — is the
// one the existing assertions cover.
const withSettings = (settings, fn) => {
  WIN.ORG_CONFIG = { settings, settingsMeta: { verifiedEpactColumns: EPACT_HEADERS } };
  try { return fn(); } finally { WIN.ORG_CONFIG = {}; }
};

// ── 1. The header row is her header row, verbatim ───────────────────────────
is(EPACT_HEADERS,
   ["Rec ID", "First Name", "Last Name", "Household Owner Email", "Session Date - Section Name"],
   "the five headers must match her SQL's aliases exactly — ePACT's importer maps on them");

// ── 2. The date is converted by string surgery, not by new Date() ───────────
is(epactIsoDate("08/27/2026"), "2026-08-27", "MM/DD/YYYY becomes YYYY-MM-DD");
is(epactIsoDate("8/7/2026"), "2026-08-07", "single-digit month and day are padded");
// THIS is the assertion the timezone re-exec exists for: new Date("08/27/2026")
// is LOCAL midnight, which in a zone east of UTC is the 26th in UTC.
is(epactIsoDate("01/01/2027"), "2027-01-01",
   "a Jan 1 date must not slide into the previous year (new Date + toISOString does, east of UTC)");
is(epactIsoDate("2026-08-27"), "2026-08-27", "an already-ISO date passes through");
is(epactIsoDate(""), "", "no date means no date");
is(epactIsoDate(null), "", "and null is not a date either");

// ── 3. A fixture where every row is a case ─────────────────────────────────
const R = (o) => Object.assign({
  recId: "", firstName: "", lastName: "", email: "", ownerEmail: "",
  section: "", sessionDate: "", status: "Enrolled",
}, o);

const ROWS = [
  // A teenager with their own address: her SQL takes the PARTICIPANT's email
  // when it exists, so this row separates `email` from `ownerEmail`.
  R({ recId: "5OLLPM", firstName: "Ana", lastName: "Reyes", email: "ana@example.com",
      ownerEmail: "parent-reyes@example.com", section: "Camp Blue", sessionDate: "07/06/2026" }),
  // The same participant, same section, same DAY, second session — her
  // SELECT DISTINCT collapses this into the row above.
  R({ recId: "5OLLPM", firstName: "Ana", lastName: "Reyes", email: "ana@example.com",
      ownerEmail: "parent-reyes@example.com", section: "Camp Blue", sessionDate: "07/06/2026" }),
  // Same participant, DIFFERENT day: two rows, because ePACT groups by date.
  R({ recId: "5OLLPM", firstName: "Ana", lastName: "Reyes", email: "ana@example.com",
      ownerEmail: "parent-reyes@example.com", section: "Camp Blue", sessionDate: "07/07/2026" }),
  // A young child with no email of their own — falls back to the household
  // owner. This is the majority shape, which is why the mapping trap is quiet.
  R({ recId: "9ZZQ21", firstName: "Bo", lastName: "Adams", email: "owner-adams@example.com",
      ownerEmail: "owner-adams@example.com", section: "Camp Blue", sessionDate: "07/06/2026" }),
  // CANCELLED — must never reach a camp health vendor's roster.
  R({ recId: "3XCANC", firstName: "Cass", lastName: "Nolan", email: "nolan@example.com",
      ownerEmail: "nolan@example.com", section: "Camp Blue", sessionDate: "07/06/2026",
      status: "Cancelled" }),
  // A section with no session to date it: her label goes NULL, so this exports
  // with an EMPTY label rather than a guessed date.
  R({ recId: "7NODATE", firstName: "Dee", lastName: "Okafor", email: "dee@example.com",
      ownerEmail: "dee@example.com", section: "Camp Undated", sessionDate: "" }),
  // A comma in the section name — the CSV has to survive being one.
  R({ recId: "4COMMA", firstName: "Eli", lastName: "Zhang", email: "eli@example.com",
      ownerEmail: "eli@example.com", section: "Camp, Red", sessionDate: "07/08/2026" }),
];

const out = epactRows(ROWS);

is(out.length, 5, "7 feed rows become 5: one duplicate collapsed, one cancellation dropped");

ok(!out.some(t => t[0] === "3XCANC"),
   "a cancelled registration must never appear — her SQL takes canceled_at IS NULL");

is(out.filter(t => t[0] === "5OLLPM").length, 2,
   "the same camper on two DAYS is two rows; the same camper twice on one day is one (SELECT DISTINCT)");

// The mapping trap, made to fail loudly.
const ana = out.find(t => t[0] === "5OLLPM");
is(ana[3], "ana@example.com",
   "Household Owner Email must come from the roster's `Email` (COALESCE participant, owner) — NOT its `Owner Email`");
ok(!out.some(t => t[3] === "parent-reyes@example.com"),
   "owner.email alone must never be exported for a participant who has their own address");

const bo = out.find(t => t[0] === "9ZZQ21");
is(bo[3], "owner-adams@example.com",
   "and a child with no address of their own still falls back to the household owner");

// ── 4. The concatenated label ──────────────────────────────────────────────
is(ana[4], "2026-07-06 - Camp Blue",
   "the label is ISO date, space-hyphen-space, section name");

const undated = out.find(t => t[0] === "7NODATE");
ok(undated, "a section with no session date is still EXPORTED, not silently dropped");
is(undated[4], "",
   "…but its label is EMPTY. TO_CHAR(NULL) makes her whole concatenation NULL, and a "
   + "guessed camp date beside a real child's name in a vendor's system is a fabrication");
ok(!/Camp Undated/.test(undated[4]),
   "a bare section name with no date is not her output either — the whole field is null");

// ── 5. Sort order: label, then last name, then first ──────────────────────
const labels = out.map(t => t[4]);
is(labels.slice().sort(), labels.slice(),
   "rows come out ordered by the concatenated field, as hers does");
const sameDay = out.filter(t => t[4] === "2026-07-06 - Camp Blue").map(t => t[2]);
is(sameDay, ["Adams", "Reyes"], "within one label, by last name");

// ── 6. CSV shape ──────────────────────────────────────────────────────────
const csv = epactCsv(out);
const lines = csv.replace(/\r\n$/, "").split("\r\n");
is(lines[0], "Rec ID,First Name,Last Name,Household Owner Email,Session Date - Section Name",
   "the header line is written unquoted and in order");
is(lines.length, 6, "one header line plus five data lines");
ok(lines.some(l => l.includes('"2026-07-08 - Camp, Red"')),
   "a section name containing a comma must be quoted, or every column after it shifts");
ok(/\r\n$/.test(csv), "CRLF line endings — a bare LF trips some Windows importers");

{
  // Quoting is where a CSV writer is usually wrong. Drive it directly.
  const rough = epactCsv([['a"b', "c,d", "e\nf", "", "plain"]]);
  ok(rough.includes('"a""b"'), 'a double quote must be doubled and the field quoted');
  ok(rough.includes('"c,d"'), "a comma must force quoting");
  ok(rough.includes('"e\nf"'), "an embedded newline must force quoting");
}

is(epactFileSlug("Camp Blue / Session 2!"), "camp-blue-session-2",
   "a section name has to survive being a filename");

// ── 7. An empty set produces nothing, not a header-only file ──────────────
is(epactRows([]), [], "no rows in, no rows out");
is(epactRows([R({ status: "Cancelled" })]), [],
   "a view of nothing but cancellations exports nothing — and the buttons are disabled for it");

// ── 8. The default window ────────────────────────────────────────────────
is(ROSTER_DEFAULT_DAYS, 14, "Dan asked for something tighter, like 14 days");
is(getDefaultRange(new Date(2026, 7, 27)), { start: "2026-08-27", end: "2026-09-09" },
   "the default runs from TODAY for 14 days inclusive — it must not open on the whole month");
is(getDefaultRange(new Date(2026, 11, 24)), { start: "2026-12-24", end: "2027-01-06" },
   "and it crosses a year boundary correctly");
is(getDefaultRange(new Date(2027, 1, 20)), { start: "2027-02-20", end: "2027-03-05" },
   "…and a short month");
ok(!/getCurrentMonthRange\(\)/.test(PAGE),
   "nothing may still open the roster on a calendar month — that is the 382-page default");
ok(/\{rsDefaultDays\(\)\} Days<\/button>/.test(PAGE.replace(/\s+/g, " ")),
   "the reset button must be labelled from the ORG's effective window, not a hardcoded number — "
   + "an org on 21 days would otherwise get a button reading \"14 Days\" that sets 21");
ok(!/\{ROSTER_DEFAULT_DAYS\} Days/.test(PAGE.replace(/\s+/g, " ")),
   "…and not from the platform constant");
ok(!/\|\| 'Current Month'/.test(PAGE),
   "the header label must not still claim 'Current Month' — the default is no longer one");

// ── 9. ONE builder, TWO buttons ──────────────────────────────────────────
is((PAGE.match(/const EPACT_HEADERS = \[/g) || []).length, 1,
   "exactly one column list. Two would drift the first time ePACT wanted a field, and a "
   + "vendor import is the last place to find that out");
is((PAGE.match(/function epactRows\(/g) || []).length, 1, "and one row builder");
is((PAGE.match(/saveTextViaPopup\(epactCsv\(/g) || []).length, 1,
   "one place writes the file, called from both buttons");

ok(/className="btn-epact"[\s\S]{0,400}?exportEpact\(displayRows, ''\)/.test(PAGE),
   "the toolbar button exports the whole filtered view (like Export Permits on the rental report)");
ok(/data-epact-section=\{secName\}/.test(PAGE),
   "the section-header button should carry data-epact-section so a browser check can drive it");
ok(/onClick=\{\(\) => exportEpact\(secRows, secName\)\}/.test(PAGE),
   "…and export that section's rows, through the same builder");
ok(/secEpact > 0 &&/.test(PAGE),
   "no button on a section with nobody to upload — a control that yields an empty file is a dead end");
ok(/disabled=\{!epactAll\.length\}/.test(PAGE),
   "and the toolbar button is disabled rather than producing a header-only CSV");

// The export must NOT be widened by the status pill: an admin looking at
// Cancelled and pressing ePACT must not upload cancellations.
ok(/if \(r\.status === 'Cancelled'\) return;/.test(PAGE),
   "the cancellation filter lives in the builder, so no caller can opt out of it");

// ── 10. The text-file escape reuses the ONE popup implementation ──────────
ok(/window\.saveTextViaPopup = function/.test(POPUP),
   "open-pdf.js should expose saveTextViaPopup for a file the page already holds as text");
is((POPUP.match(/document\.write\(popupDoc\(/g) || []).length, 1,
   "one popup implementation for the workbook and CSV paths — the download-escape trick is "
   + "subtle enough that a second copy would drift");
ok(/function csvToTsv\(/.test(POPUP),
   "the clipboard fallback needs the rows TAB-separated; a comma-separated paste lands in one cell");

// ── 9b. Per-org settings reach the export, and the DEFAULT stays verified ────
// Configurable columns are only safe if the unconfigured path is untouched: every
// org gets Apex's verified five until someone deliberately changes them.
is(epactColumns(), EPACT_HEADERS,
   "with no org settings the columns are the verified five — that is what every org gets today");
ok(epactVerified(), "…and an unconfigured org reads as verified");

withSettings({ epactColumns: ["Rec ID", "Last Name", "Grade"] }, () => {
  is(epactColumns(), ["Rec ID", "Last Name", "Grade"], "an org's chosen columns are honoured");
  ok(!epactVerified(), "and leaving the verified five is reported, not silent");
  const out = epactRows(ROWS, epactColumns());
  is(out[0].length, 3, "the tuple is as wide as the chosen column set");
  const csv = epactCsv(out, epactColumns());
  is(csv.split("\r\n")[0], "Rec ID,Last Name,Grade", "and the header line follows the choice");
});

withSettings({ epactColumns: ["First Name", "Last Name", "Rec ID", "Household Owner Email", "Session Date - Section Name"] }, () => {
  ok(!epactVerified(),
     "the same five in a DIFFERENT order is not the verified template either — ePACT maps on position");
});

withSettings({ epactColumns: ["Session Start", "Nope"] }, () => {
  is(epactColumns(), EPACT_HEADERS,
     "a column set the catalogue does not know falls back to the verified five rather than "
     + "exporting empty columns. Session Start is absent on purpose: it is SESSION grain, so it "
     + "would stop the dedupe collapsing two same-day sessions and upload a camper twice");
});

ok(!("Session Start" in EPACT_FIELDS) && !("Session End" in EPACT_FIELDS),
   "no SESSION-grain field may be offered — the dedupe is what keeps a camper from being uploaded twice");

// The label format, and the one case where a dateless row can still be filled.
withSettings({ epactLabel: "section" }, () => {
  is(epactLabel({ sessionDate: "", section: "Camp Undated" }), "Camp Undated",
     "'section' alone needs no date, so it is the one format a dateless row can fill");
});
withSettings({ epactLabel: "section-date" }, () => {
  is(epactLabel({ sessionDate: "07/06/2026", section: "Camp Blue" }), "Camp Blue (2026-07-06)",
     "section-then-date is offered as an alternative shape");
  is(epactLabel({ sessionDate: "", section: "Camp Blue" }), "",
     "…and it still refuses to invent a date for a dateless row");
});

// The window: platform constant stays pinned, the org can still move its own.
is(getDefaultRange(new Date(2026, 7, 27)), { start: "2026-08-27", end: "2026-09-09" },
   "with no day count the platform default is 14 days — this is what next14 is pinned to");
is(getDefaultRange(new Date(2026, 7, 27), 21), { start: "2026-08-27", end: "2026-09-16" },
   "and an org's own window is honoured without touching the constant");
withSettings({ defaultDays: 21 }, () => {
  is(lifted.rsDefaultDays(), 21, "the org's window is what the page opens on");
});
withSettings({ defaultDays: 0 }, () => {
  is(lifted.rsDefaultDays(), ROSTER_DEFAULT_DAYS, "a nonsense window falls back rather than rendering nothing");
});

// Hiding a control removes it. Absence, not a disabled button.
withSettings({ hide: { excel: true } }, () => {
  ok(!lifted.rsShown("excel"), "a hidden control reports as hidden");
  ok(lifted.rsShown("epact"), "…and the others are untouched");
});

// Columns: platform seed, then org, then the person. The person wins.
ok(/\{ \.\.\.COL_DEFAULTS, \.\.\.orgColDefaults\(\), \.\.\.JSON\.parse\(localStorage/.test(PAGE),
   "column precedence must be platform \u2192 org \u2192 person, in that order: an org default that "
   + "overrode localStorage would take a reader's own columns away");

// ── 10b. The BOM ───────────────────────────────────────────────────────────
// Byte-diffed against the file Metabase serves for the same section (apex,
// "After School Care - Hackberry Hill Elementary School 2026-2027", 68 rows):
// every row identical and in the same order, and the ONLY difference was that
// Metabase's file opened with a UTF-8 BOM. It writes one on every CSV it serves,
// so ePACT already ingests BOM'd files today — and without one Excel sniffs the
// bytes wrong and an accented participant name opens as mojibake.
ok(/bytes: new TextEncoder\(\)\.encode\(\(opts\.bom \? "\\uFEFF" : ""\) \+ String\(text\)\)/.test(POPUP),
   "saveTextViaPopup must be able to prefix the FILE with a UTF-8 BOM");
ok(/tsv: opts\.tsv != null \? opts\.tsv : csvToTsv\(String\(text\)\)/.test(POPUP),
   "…and the clipboard copy must be built from the RAW text — a BOM pasted into a "
   + "sheet shows up as a stray character in the first cell");
ok(/bom: RS\(\)\.epactBom !== false,/.test(PAGE),
   "the ePACT export must ask for the BOM by DEFAULT, so its file matches the one the card "
   + "serves \u2014 `!== false` is the load-bearing half: an org with no settings, and an org "
   + "that never touched this switch, must both still get one");
ok(!/\uFEFF/.test(epactCsv([["a", "b", "c", "d", "e"]])),
   "epactCsv itself stays pure text — the BOM is a delivery concern, and putting it "
   + "in the builder would carry it into the clipboard copy too");

// ── 11. The Slack beacon ─────────────────────────────────────────────────
ok(/"form-open", "epact"\]/.test(SERVER),
   "`epact` must be on the generic log route's ALLOWED list, or every beacon 400s silently");
ok(/"epact",[^\]]*"deadlink"/.test(SERVER),
   "…and in SLACK_NOTIFY, or it is recorded and never posted (the fourth instance of that trap)");
ok(/epact:\s*\{ emoji:/.test(SERVER), "and it needs its own emoji/verb");
ok(/rec\.event === "epact"\s*\n\s*\?\s*`\$\{rec\.org\}\|\$\{rec\.report\}\|epact\|\$\{rec\.scope \|\| "view"\}\|\$\{rec\.section \|\| ""\}`/
   .test(SERVER),
   "debounced by SECTION, so an admin exporting four camps in a row reads as four exports");
ok(/} else if \(rec\.event === "epact"\) \{/.test(SERVER),
   "its own message branch — the shared one would print the report type and never the count");
ok(/scope: req\.query\.scope === "section" \? "section" : "view"/.test(SERVER),
   "scope is normalised server-side rather than trusted from the query string");

// ── 12. The beacon, driven for real ─────────────────────────────────────────
// Source assertions alone have missed this exact bug FOUR times in this repo
// (campmap, the Facilities hub, Memberships, the wizard): the client code reads
// correctly, the server parses, the page renders, and a fire-and-forget beacon
// never complains about a 400 or a 404. So boot the server, POST the ping, and
// require a 200 AND a row in events.jsonl.
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

(async () => {
  const PORT = 3994;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-epact-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: "http://127.0.0.1:9",
      RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const { org, token } = (() => {
    const i = SERVER.indexOf("const ORGS = {");
    const j = SERVER.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = vm.runInNewContext("(" + SERVER.slice(SERVER.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    const slug = Object.keys(ORGS).find(k => ORGS[k] && ORGS[k].token);
    assert.ok(slug, "no org with a token in server.js");
    return { org: slug, token: ORGS[slug].token };
  })();

  const post = (qs) => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", timeout: 15000,
      path: `/${org}/roster/api/log?${qs}&token=${encodeURIComponent(token)}` },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res({ status: r.statusCode, body: b })); });
    req.on("error", rej);
    req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end();
  });

  const events = () => {
    const f = path.join(dataDir, "events.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return {}; } });
  };

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("server did not boot\n" + log.slice(-600)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });

    let r = await post("event=epact&rows=124&scope=section&section=Camp%20Blue");
    is(r.status, 200, "the per-section ePACT beacon must be accepted: " + r.body);
    const sec = events().filter(x => x.event === "epact").pop();
    ok(sec, "nothing reached events.jsonl — a 200 alone would not prove it recorded");
    is(sec.report, "roster", "logged against the report that was exported");
    is(sec.rows, 124, "the participant count travels with it");
    is(sec.scope, "section", "and the scope, so a bulk upload is distinguishable from one class");
    is(sec.section, "Camp Blue", "and which class");

    r = await post("event=epact&rows=1900");
    is(r.status, 200, "the whole-view export is accepted too: " + r.body);
    const view = events().filter(x => x.event === "epact").pop();
    is(view.scope, "view", "an export with no section defaults to the view scope, not to 'section'");
    is(view.section, "", "and carries no class name");

    r = await post("event=epact&rows=-4&scope=nonsense");
    is(r.status, 200, r.body);
    const junk = events().filter(x => x.event === "epact").pop();
    is(junk.rows, undefined, "a negative count is dropped rather than recorded");
    is(junk.scope, "view", "an unknown scope is normalised, not stored");

    console.log("✓ roster-epact.spec.js — " + n + " assertions");
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
