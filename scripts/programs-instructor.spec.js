#!/usr/bin/env node
/* ============================================================================
 * programs-instructor.spec.js — the Instructor column and filter on the
 * Programs report, the "by month" panel, and the invariants that keep both
 * from lying.
 *
 * WHY IT EXISTS. Dan asked for El Segundo's class/instructional reporting —
 * "per class, by location, by month, by instructor". Card 17295 has emitted
 * `location`, `location_count`, `instructor` and `instructor_count` since v6
 * (2026-08-31); `programs.html` MAPPED instructor at line 957 and rendered it
 * NOWHERE. That is the same shape as the location filter that shipped unable to
 * render for two days: a unit test that supplies the field under test cannot
 * tell you whether anything supplies it in production, and no source assertion
 * catches a column that is mapped and never displayed. The render cases key on
 * the CELL for exactly that reason.
 *
 * ── WHAT WAS MEASURED, so nobody re-derives it ─────────────────────────────
 * El Segundo Recreation, live, 2026-09-01: 286 live sections, 131 with an
 * instructor (45.8%), 23 with MORE THAN ONE, 19 distinct instructor strings,
 * 13 locations, and 285 of 286 sections at exactly one location.
 *
 * THE INSTRUCTOR KEY IS THE WHOLE COMMA-JOINED STRING, and that is a deliberate
 * limit rather than an oversight. The card emits facilitators as one string
 * (STRING_AGG with ', '), so "Penny Finders" and "Eric Stenberg, Penny Finders"
 * are two different options — 5 sections and 2 sections at El Segundo, and
 * NEITHER is that vendor's real total. That is honest for a FILTER (tick the
 * pairing you mean) and would be wrong for a per-instructor leaderboard, which
 * is why there is no leaderboard. Splitting the string is safe today —
 * 0 of 1,056 instructor names platform-wide contain a comma — and silently
 * wrong the first time a vendor is called "Acme, Inc.", so it is a decision
 * rather than a refactor. Dan's call, 2026-09-01: no leaderboard yet.
 *
 * ── THE BY-MONTH PANEL DRAWS TWO SERIES BECAUSE THEY DISAGREE ──────────────
 * Measured at El Segundo: programming peaks in SEPTEMBER (165 sections
 * running) and money peaks in AUGUST ($77,813 collected), eight weeks apart,
 * because people pay at registration and then attend for a term. One chart
 * labelled "by month" is read as whichever the reader assumed.
 *
 * The activity series is derived from the feed's own section spans. That is an
 * APPROXIMATION of "has a session in this month" and it was checked before
 * shipping: against the real session data for El Segundo over twelve months it
 * is identical in nine and over by exactly ONE section in three (a section
 * whose run straddles a month it has no sessions in). It over-counts, never
 * under-counts, by at most one section in sixty.
 *
 * The money series CANNOT come from card 17295 — that card returns one period
 * figure for the whole window, not a series — so it comes from card 21055, and
 * is absent until that card has a public link.
 *
 * WHAT THIS PINS:
 *
 *   1. ONE FUNNEL, THREE DIMENSIONS. `scopedRows` applies location, season AND
 *      instructor. A separate funnel is how the facility Summary shipped chips
 *      that scoped some panels and not others.
 *   2. scopedProgramSet fires on ANY of the three, or the demographics and
 *      retention tabs stay unscoped while every panel beside them moves.
 *   3. progEffectiveInstructors keeps known ticks, drops unknown, and takes
 *      `loaded` — a feed that has not answered is not a feed without that
 *      instructor. Fourth instance of the ?ci_rows=failed bug.
 *   4. `instructor` is read with getAll, never split(','), and the write-back
 *      DELETES before it appends. The value can itself contain ", ".
 *   5. The presence gate is asked of the RAW response, never of a rollup.
 *   6. ONE MultiPicker serves Seasons and Instructor. Two copies of that markup
 *      would drift, and the toolbar-inheritance resets are exactly the fix that
 *      lands in one copy and not the other.
 *   7. The Excel export reads the SCOPED rows. It read the unscoped rollups, so
 *      an admin who narrowed to one location and hit Excel got the whole org.
 *   8. Nothing in the by-month path parses a month through `new Date()`.
 *
 * It LIFTS AND RUNS the real helpers rather than regexing them — a regex passes
 * on an inverted comparison. (The nightStateFrom lesson.)
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "public", "programs.html");
const SERVER = path.join(__dirname, "..", "server.js");
const CARD = path.join(__dirname, "..", "sql", "report-cards", "programs-revenue-by-month.sql");
const src = fs.readFileSync(PAGE, "utf8");
const server = fs.readFileSync(SERVER, "utf8");
const card = fs.readFileSync(CARD, "utf8");

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));
const deq = (g, w, m) => ok(JSON.stringify(g) === JSON.stringify(w),
  m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// Comments quote the broken forms on purpose (`new Date(`, a raw comma split),
// so every source assertion runs over a comment-stripped copy or it fails on
// correct code. Same note as checkin-status.spec.js and fasttrack-export.spec.js.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  let depth = 0, i = text.indexOf("{", start);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}

let H = {};
try {
  H = new Function(
    "const INSTR_NONE = '\\u0000noinstructor';\n" +
    "const PROG_MAX_MONTHS = 24;\n" +
    liftFn(src, "instructorKey") + "\n" +
    liftFn(src, "progEffectiveInstructors") + "\n" +
    liftFn(src, "progDistinctFromSections") + "\n" +
    liftFn(src, "progSetCell") + "\n" +
    liftFn(src, "progMonthKey") + "\n" +
    liftFn(src, "progMonthRange") + "\n" +
    liftFn(src, "progMonthlyActivity") + "\n" +
    liftFn(src, "progMonthlyMoney") + "\n" +
    "return { INSTR_NONE, instructorKey, progEffectiveInstructors, progDistinctFromSections, progSetCell," +
    " progMonthKey, progMonthRange, progMonthlyActivity, progMonthlyMoney };")();
  pass++;
} catch (e) {
  // A guard that DIES instead of failing has not told anyone what broke — the
  // lesson already recorded for the scopedRows slice in programs-season.spec.js.
  failures.push("the instructor/by-month helper block THREW when lifted: " + e.message);
}

if (H.instructorKey) {
  const { INSTR_NONE, instructorKey, progEffectiveInstructors, progDistinctFromSections,
          progMonthKey, progMonthRange, progMonthlyActivity, progMonthlyMoney } = H;

  // ── instructorKey ───────────────────────────────────────────────────────
  eq(instructorKey({ instructor: "Grace Maxwell" }), "Grace Maxwell", "a name passes through");
  eq(instructorKey({ instructor: "Eric Stenberg, Penny Finders" }), "Eric Stenberg, Penny Finders",
     "A COMMA-JOINED PAIRING IS KEPT WHOLE — splitting it here is the open question, not the behaviour");
  eq(instructorKey({ instructor: "" }), INSTR_NONE, "an empty instructor is 'nobody on file'");
  eq(instructorKey({ instructor: null }), INSTR_NONE, "null is the same fact");
  eq(instructorKey({}), INSTR_NONE, "a row with no instructor key does not become 'undefined'");

  // ── progEffectiveInstructors ────────────────────────────────────────────
  const OPTS = [
    { value: "Sergiu Boerica", n: 44 },
    { value: "Grace Maxwell",  n: 7 },
    { value: INSTR_NONE,       n: 155 },
  ];
  deq(progEffectiveInstructors([], OPTS, true), [], "no ticks stays no ticks (which MEANS all)");
  deq(progEffectiveInstructors(["Grace Maxwell"], OPTS, true), ["Grace Maxwell"], "a known tick survives");
  deq(progEffectiveInstructors([INSTR_NONE], OPTS, true), [INSTR_NONE],
      "'no instructor on file' is a real selection, not a stale one");
  deq(progEffectiveInstructors(["Grace Maxwell", "Someone Gone"], OPTS, true), ["Grace Maxwell"],
      "AN UNKNOWN TICK IS DROPPED AND THE KNOWN ONE KEPT — falling back to 'all' would silently widen a deliberate request");
  deq(progEffectiveInstructors(["Someone Gone"], OPTS, true), [],
      "when nothing survives it falls back to all, because an empty list and 'all' render the same");
  deq(progEffectiveInstructors(["Grace Maxwell"], [], false), ["Grace Maxwell"],
      "THE LOAD GATE: before the feed answers there are no options YET, which is not the same fact as 'no such instructor'");

  // ── progDistinctFromSections (the Excel columns) ────────────────────────
  const prog = { _sections: [
    { location: "Recreation Park Courts", instructor: "Eric Stenberg, Penny Finders" },
    { location: "Urho Saari Swim Stadium", instructor: "Grace Maxwell" },
    { location: "Recreation Park Courts", instructor: null },
  ] };
  eq(progDistinctFromSections(prog, "location"), "Recreation Park Courts; Urho Saari Swim Stadium",
     "the export carries the SET of locations, de-duplicated");
  eq(progDistinctFromSections(prog, "instructor"), "Eric Stenberg, Penny Finders; Grace Maxwell",
     "JOINED WITH '; ' AND NOT ', ' — a value can itself contain a comma, and a comma-joined set could never be taken apart again");
  eq(progDistinctFromSections({ location: "Solo Park" }, "location"), "Solo Park",
     "a program-grain feed with no _sections falls back to the row's own value rather than reporting nothing");
  eq(progDistinctFromSections({ _sections: [] }, "location"), "", "no sections and no value is empty, not 'undefined'");
  eq(progDistinctFromSections(null, "location"), "", "a missing row does not throw");

  // ── the by-month helpers ────────────────────────────────────────────────
  eq(progMonthKey("2026-08-31"), "2026-08", "a month key is the first seven characters and nothing else");
  eq(progMonthKey(null), "", "a missing date has no month");
  deq(progMonthRange("2026-11-15", "2027-02-01"), ["2026-11", "2026-12", "2027-01", "2027-02"],
      "a range crosses the year boundary by counting months as integers");
  deq(progMonthRange("2027-01-01", "2026-01-01"), [], "a backwards range is empty, not a crash");
  eq(progMonthRange("2020-01-01", "2030-01-01").length, 24,
     "a very wide window is capped rather than drawing sixty unreadable bars");

  // The activity series. Spans deliberately overlap on September only.
  const secs = [
    { startDate: "2026-08-01", endDate: "2026-10-31" },
    { startDate: "2026-09-01", endDate: "2026-12-31" },
    { startDate: "2026-07-01", endDate: "2026-09-30" },
    { startDate: "2026-09-01", endDate: "2026-09-30" },
  ];
  const act = progMonthlyActivity(secs, "2026-07-01", "2026-12-31");
  deq(act.map(a => a.sections), [1, 2, 4, 2, 1, 1],
      "a section counts in every month its own span covers");
  eq(act.length, 6, "every month in the window gets an entry, including the empty ones");
  const peak = act.reduce((b, a) => (a.sections > b.sections ? a : b), act[0]);
  eq(peak.month, "2026-09", "the activity peak is September, as measured at El Segundo");
  deq(progMonthlyActivity([{ startDate: null, endDate: "2026-09-30" }], "2026-07-01", "2026-09-30")
        .map(a => a.sections), [0, 0, 0],
      "a section with no start date is skipped rather than counted everywhere");
  deq(progMonthlyActivity([{ startDate: "2026-08-10", endDate: null }], "2026-07-01", "2026-09-30")
        .map(a => a.sections), [0, 1, 0],
      "a section with no END date counts in its start month only, never to the end of time");

  // The money series, and the gate that keeps a missing card from reading as $0.
  eq(progMonthlyMoney(null), null, "a feed that has not answered is null");
  eq(progMonthlyMoney([]), null, "an empty feed is null too");
  eq(progMonthlyMoney([{ Foo: 1 }]), null,
     "PRESENCE, NOT VALUE: rows without a Month column are null, so the chart hides rather than rendering confident zeros");
  const money = progMonthlyMoney([
    { Month: "2026-08", Collected: 77812.83, Refunds: 4754.45, Net: 73058.38 },
    { Month: "2026-09", Collected: 4172.59, Refunds: 500.35, Net: 3672.24 },
  ]);
  ok(money && money.size === 2, "two months parse");
  eq(money && money.get("2026-08").collected, 77812.83, "El Segundo's real August figure survives the parse");
  eq(money && money.get("2026-09").net, 3672.24, "and its net");
  // A REAL ZERO IS NOT A MISSING CARD. Card 21055 emits a row per month via
  // generate_series, so a month with no money is 0 and must still parse.
  const zero = progMonthlyMoney([{ Month: "2026-10", Collected: 0, Refunds: 0, Net: 0 }]);
  ok(zero && zero.get("2026-10").collected === 0,
     "a month the card says earned $0 is a real answer, distinct from the card being absent");
}

// ── source invariants ──────────────────────────────────────────────────────

// 1. ONE FUNNEL, THREE DIMENSIONS.
const funnel = code.slice(code.indexOf("const scopedRows = useMemo"),
                          code.indexOf("const scopedProgramSet = useMemo"));
ok(/instructorKey\(/.test(funnel) && /instrSel/.test(funnel),
   "scopedRows applies the INSTRUCTOR dimension — a separate funnel is how the facility Summary scoped some panels and not others");
ok(/locFilter/.test(funnel) && /seasonSel/.test(funnel),
   "...and still applies location and season, so the third dimension was added to the funnel rather than beside it");
ok(/\[rows, progSections, sectionGrain, locFilter, seasonSel, instrSel\]/.test(funnel),
   "instrSel is in the funnel's dependency list, or ticking an instructor recomputes nothing");

// 2. scopedProgramSet fires on ANY dimension.
const setBlock = code.slice(code.indexOf("const scopedProgramSet = useMemo"),
                            code.indexOf("const scopedProgramSet = useMemo") + 700);
ok(/!locFilter && !seasonSel\.length && !instrSel\.length/.test(setBlock),
   "scopedProgramSet gates on ALL THREE being empty — gating on two leaves the demographics and retention tabs instructor-unscoped");

// 4. Repeated parameter, delete-then-append.
ok(/instructors:\s*p\.getAll\(['"]instructor['"]\)/.test(code),
   "?instructor= is read with getAll — the value can contain ', ', so a split would cut a legitimate pairing in half");
ok(!/split\(['"],['"]\)[^\n]*instructor/i.test(code), "nothing splits an instructor value on a comma");
const wb = code.slice(code.indexOf("u.searchParams.delete('instructor')"),
                      code.indexOf("u.searchParams.delete('instructor')") + 220);
ok(/delete\('instructor'\)[\s\S]*append\('instructor'/.test(wb),
   "the write-back DELETES before it appends, or every render stacks another copy of each value");

// 5. The presence gate is asked of the RAW response.
ok(/instructor:\s*raw\.some\(r =>/.test(code),
   "colPresence.instructor is asked of the RAW rows — a column question asked of a rollup with a fixed key set is how the location filter shipped unable to render");

// 6. ONE MultiPicker, two controls.
ok(/function MultiPicker\(/.test(code), "MultiPicker exists at module scope");
eq((code.match(/<MultiPicker/g) || []).length, 2,
   "BOTH controls render through it — a second copy of that markup drifts the first time one of them changes");
ok(/slug="season"/.test(code) && /slug="instructor"/.test(code),
   "...and each keeps its own data-prog-<slug>-* handles, so every existing season selector still resolves");
// Scoped to the CSS SELECTORS, not the whole file: the data attributes are
// still data-prog-season-*, which every existing selector depends on, and a
// bare /season-btn/ matches those too. Testing the wrong thing here passed on
// correct code the first time round.
ok(!/\.season-(menu|btn|wrap)\b/.test(src),
   "the season-specific CSS classes are gone — the menu styling is shared, so the toolbar-inheritance resets cannot be fixed in one menu and not the other");
ok(/\.toolbar \.mpick-menu label\.sm-opt/.test(src),
   "and the reset that stops the toolbar rendering the rows UPPERCASE, grey and STACKED still targets them");

// 7. The Excel export reads the SCOPED rows.
const xl = code.slice(code.indexOf("function downloadExcel"), code.indexOf("function downloadExcel") + 2200);
ok(/filteredRows\.map/.test(xl) && !/^\s*const data = rows\.map/m.test(xl),
   "the export maps the SCOPED rows — it read the unscoped rollups, so narrowing to one location and hitting Excel returned the whole org");
ok(/'Location\(s\)'/.test(xl) && /'Instructor\(s\)'/.test(xl),
   "both new columns are in the export Dan asked for");
ok(/progDistinctFromSections\(r, 'location'\)/.test(xl) && /progDistinctFromSections\(r, 'instructor'\)/.test(xl),
   "...populated from the program's own sections, since a program rollup has neither of its own");
["'Program','Season'", "'Charged','Received','Outstanding','Refunds','Net Revenue'"].forEach(frag => {
  ok(xl.indexOf(frag) >= 0, "the export keeps its existing columns: " + frag);
});

// 7b. THE PANEL READS THROUGH THE FUNNEL, and withdraws what it cannot scope.
const panel = code.slice(code.indexOf("const act = progMonthlyActivity(") - 900,
                         code.indexOf("const act = progMonthlyActivity(") + 900);
ok(/filteredRows/.test(panel) && !/progMonthlyActivity\(progSections/.test(panel),
   "the activity chart is built from the SCOPED sections — a chart ignoring the toolbar while the cards beside it obey is the facility Summary bug");
ok(/const scoped = !!\(locFilter \|\| seasonSel\.length \|\| instrSel\.length/.test(panel),
   "...and any active filter withdraws the money chart, because card 21055 is org-wide and has nothing to filter on");
ok(/scoped \? null : progMonthlyMoney\(monthlyRows\)/.test(panel),
   "...withdrawn by making it null, so it hides exactly the way a missing card does");

// 8. No date parsing anywhere in the by-month path.
const bymonth = code.slice(code.indexOf("function progMonthKey"), code.indexOf("function progMonthlyMoney") + 900);
ok(!/new Date\(/.test(bymonth),
   "NOTHING in the by-month helpers parses a date — 'YYYY-MM-DD' through new Date() is UTC midnight and lands on the previous day across the US");

// INSTR_NONE must be an escape, never a raw NUL byte: a raw NUL makes git treat
// the whole file as BINARY, and a file that cannot be read in a diff cannot be
// reviewed. Same note as LOC_NONE.
ok(/const INSTR_NONE = '\\u0000/.test(src), "INSTR_NONE is written as a \\u0000 escape");
ok(src.indexOf("\u0000") < 0, "...and there is no raw NUL byte anywhere in the page");

// The columns must actually RENDER. A mapped-but-never-displayed column is the
// bug this whole change exists to fix, and it is invisible to every other check.
ok(/data-prog-seccell-instructor=/.test(code), "the instructor CELL carries its value, so a render case can assert the cell and not just the column");
ok(/data-prog-seccell-location=/.test(code), "so does the location cell");
ok(/data-prog-secmore-instructor=/.test(code),
   "a section with more than one facilitator is MARKED — printing only the primary is a confident half-truth");
ok(/leftCols\s*=\s*4 \+ \(showRegModeCol \? 1 : 0\)[\s\S]{0,140}showLocationCol[\s\S]{0,80}showInstructorCol/.test(code),
   "the Grand Total colSpan counts the new left-hand columns, or the footer's money lands under the wrong headers");

// ── the new card, and its registration ─────────────────────────────────────
ok(/order_item_type\s*=\s*'reservation-enrollment'/.test(card),
   "card 21055 filters to programme revenue — 'product' is memberships and merchandise, 'site-reservation' is facility");
ok(/generate_series/.test(card),
   "it emits a row per month, so the page never has to do date arithmetic to build an axis");
ok(/to_char\(m\.mo, 'YYYY-MM'\)\s*AS "Month"/.test(card),
   "Month is a bare 'YYYY-MM' STRING — there is nothing for the page to parse");
// The header comment says "never AT TIME ZONE" on purpose, so the executable
// half is what gets tested — the same comment-stripping note as above.
const cardSql = card.replace(/^\s*--.*$/gm, "");
ok(!/AT TIME ZONE/.test(cardSql),
   "datetime_at_primary_timezone is ALREADY localized, so the card never converts it — that is what stops Metabase's Pacific rendering putting a boundary payment in the wrong month");
ok(/\{\{start_date\}\}::date/.test(card) && /\{\{end_date\}\}::date/.test(card),
   "the bounds are CAST, so the SQL holds whether an API push left the tags Date or Text");
ok(/"programs-monthly"/.test(server) && /REPORT_TYPES/.test(server),
   "programs-monthly is a registered report type, or its data route 404s as an unknown report");
ok(/MB_PROGRAMS_MONTHLY_UUID/.test(server),
   "its UUID comes from the environment and is ABSENT until set — an entry pointing at nothing would fail the feed for every org");
ok(/NON_ADDABLE_REPORTS[\s\S]{0,400}programs-monthly/.test(server),
   "it is not addable as a card of its own — it is a band on the Programs report");

// ── the program table's set cell ────────────────────────────────────────────
// Dan, on the live page: "not seeing instructor names and info on the program
// pages. filter works, but doesn't show the data we need." The names were on the
// SECTION rows only, so an admin had to expand 23 programs one at a time.
if (H && H.progSetCell) {
  const one  = { _sections: [{ instructor: 'Naomi Rivas' }, { instructor: 'Naomi Rivas' }] };
  const many = { _sections: [{ instructor: 'Naomi Rivas' }, { instructor: 'Eric Stenberg' }] };
  const none = { _sections: [{ instructor: null }, { instructor: '' }] };

  eq(H.progSetCell(one, 'instructor').text, 'Naomi Rivas',
     "ONE instructor across a program's sections reads as the name — that is the whole point of the column");
  eq(H.progSetCell(one, 'instructor').n, 1, "...and reports one");
  eq(H.progSetCell(many, 'instructor').text, '2 instructors',
     "TWO must not print one of them as though it were the answer — a program spanning instructors says so");
  eq(H.progSetCell(many, 'instructor').title, 'Naomi Rivas\nEric Stenberg',
     "...with the full list on hover, so the count is not a dead end");
  eq(H.progSetCell(none, 'instructor').n, 0, "no instructor on file reports zero");
  eq(H.progSetCell(none, 'instructor').text, '\u2014', "...and renders a dash rather than an empty cell");
  const twoLocs = { _sections: [{ location: 'Urho Saari' }, { location: 'Wiseburn' }] };
  eq(H.progSetCell(twoLocs, 'location').text, '2 locations', "the label follows the column");

  // THE BUG AS IT SHIPPED. The rollup keeps a program's sections in `_sections`
  // and the Summary tab's own progMap builds `sections`, so reading only the
  // first made every cell on the program table a dash — the feature Dan
  // reported missing.
  eq(H.progSetCell({ sections: [{ instructor: 'Mary Lee' }] }, 'instructor').text, 'Mary Lee',
     "TWO NAMES FOR ONE LIST: `sections` is read as well as `_sections`");
  // A section row handed to it directly still answers from its own value.
  eq(H.progSetCell({ instructor: 'Jenna Lockwood' }, 'instructor').text, 'Jenna Lockwood',
     "a program-grain row with no section list falls back to its own value");
}

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ programs-instructor.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("✓ programs-instructor.spec.js — " + pass + " assertions passed.");
