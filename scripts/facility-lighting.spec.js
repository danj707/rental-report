// Spec for Musco lighting on the rental schedule: a REMOVED schedule is not
// lighting, and the lit window is the FACILITY'S clock rather than the
// reader's.
//
// Dan, 2026-09-10, on a Midland rental: "the midland rental schedule shows this
// facility rental with musco lighting. but the rental itself doesn't have musco
// lighting on it, where did this come from?"
//
// Two bugs, and both were invisible to every other check because the column
// rendered a perfectly plausible value either way:
//
//   1. Taking Musco off a rental writes sync_status = 'removed' rather than
//      deleting the row. Card 17294 SELECTED that column all along and then
//      tested only whether the row EXISTED, so a removed schedule kept its 💡
//      and kept the rental inside the "Lit Only" filter. Measured 2026-09-10:
//      all 9 lighting schedules on the platform are 'removed', so this column
//      has never been right for anybody.
//
//   2. lit_from/lit_until are timestamptz, and the page parsed them with
//      `new Date(s).getHours()` — the READER'S zone. Midland's 6:00pm Central
//      read as 7:00pm to Dan in Eastern, directly under a Begin/End that IS
//      facility-local (those come off reservation_timestamp_range, a tsrange,
//      already local). The card now emits "Lit Window" pre-formatted, the same
//      way it emits Begin/End, so nothing downstream parses an instant.
//
// Run: node scripts/facility-lighting.spec.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "facility.html");
const CARD = path.join(__dirname, "..", "sql", "report-cards", "17294-facility-rental-report.sql");
const src = fs.readFileSync(PAGE, "utf8");
const sql = fs.readFileSync(CARD, "utf8");

// The card's own comments quote the broken forms on purpose (a removed
// schedule, the reader's clock), so every assertion about the SQL runs over a
// comment-stripped copy. Already recorded in this repo for checkin-status and
// for the ePACT date rule.
const sqlCode = sql.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ── LIFT AND RUN the page helper ────────────────────────────────────────────
// A regex over litWindowLabel passes on an inverted preference — it mentions
// both fields either way — so the only assertion worth making is what it
// RETURNS. The page builds a React tree at module scope, so slice the one
// function rather than evaluating the file.
const start = src.indexOf("function litWindowLabel(r) {");
ok(start > 0, "facility.html should declare litWindowLabel at module scope");
const end = src.indexOf("function addonNoteFragment(items)", start);
ok(end > start, "addonNoteFragment should follow litWindowLabel");

// formatTime comes with it: it is the page's ONE definition of how a time is
// displayed, and litWindowLabel routing through it is what stops the note
// reading "06:00pm" beside a Begin cell reading "6:00pm" on the same row.
const ftStart = src.indexOf("function formatTime(t) {");
ok(ftStart > 0, "facility.html should declare formatTime at module scope");
const ftEnd = src.indexOf("\nfunction ", ftStart + 10);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src.slice(ftStart, ftEnd) + "\n" + src.slice(start, end), sandbox);
const { litWindowLabel } = sandbox;
ok(typeof litWindowLabel === "function", "litWindowLabel should be liftable");

// The card's own string wins outright. This is the whole point: it is already
// in the facility's timezone and already formatted, so the page adds nothing.
eq(litWindowLabel({ litWindow: "06:00pm - 07:00pm" }), "6:00pm - 7:00pm",
   "the card's window should be used, normalised by the page's own formatTime");

// ...and it wins EVEN WHEN the raw instants are present, which they always are.
// A helper that preferred the instants would look correct in isolation and be
// wrong by an offset for every reader outside the card's report timezone.
eq(litWindowLabel({
     litWindow: "06:00pm - 07:00pm",
     litFrom: "2026-09-11T16:00:00-07:00",
     litUntil: "2026-09-11T17:00:00-07:00",
   }), "6:00pm - 7:00pm",
   "the card's window should beat the raw instants, not the other way round");

// The fallback exists ONLY for a feed cached before the card changed. Feeds
// cache four hours, so a pre-push response is still live afterwards and its
// rows carry no Lit Window at all.
ok(litWindowLabel({ litFrom: "2026-09-11T16:00:00-07:00", litUntil: "2026-09-11T17:00:00-07:00" })
     .indexOf(" - ") > 0,
   "a pre-column feed should still render a window rather than nothing");

// BOTH PATHS RENDER ONE BOOKING ONE WAY. The card's shape and the fallback's
// shape are different strings for the same clock; if they did not fold into
// one, a feed expiring mid-session would silently restyle the note.
eq(litWindowLabel({ litWindow: "06:00pm - 07:00pm" }).replace(/[^0-9:]/g, ""),
   "6:007:00", "the card path should print the page's own time shape");

// Nothing to say is said as nothing. An unguarded formatter renders the literal
// "Invalid Date NaN" on screen — the winLabel lesson, one report over.
eq(litWindowLabel({}), "", "no lighting data at all should render nothing");
eq(litWindowLabel(null), "", "a missing row should render nothing, not throw");
eq(litWindowLabel({ litFrom: "not a date", litUntil: "also not" }), "",
   "an unparseable instant should render nothing, never NaN");

// One side only: a sunset start that has not resolved yet must not print a
// dangling separator. Two of the nine live schedules have a NULL lit_from.
eq(litWindowLabel({ litUntil: "2026-07-16T23:00:00-07:00" }).indexOf(" - "), -1,
   "a one-sided fallback should not print a dangling separator");
ok(litWindowLabel({ litUntil: "2026-07-16T23:00:00-07:00" }).length > 0,
   "a one-sided fallback should still print the side it has");

// ── The card: a removed schedule is not lighting ────────────────────────────
// Scoped to the join itself, so the three assertions below can each fail on
// their own thing rather than all falling over the same literal.
const joinAt = sqlCode.indexOf("LEFT JOIN reservation_lighting_schedule rls");
ok(joinAt > 0, "card 17294 should still LEFT JOIN the lighting schedule");
const joinClause = sqlCode.slice(joinAt, joinAt + 220);
ok(/rls\.sync_status/.test(joinClause),
   "card 17294 should filter on sync_status IN THE JOIN");
ok(!/(!=|<>)/.test(joinClause),
   "a plain != would drop an unknown sync_status as well as a removed one");
ok(!/rls\.sync_status\s*(=|IN)\s/.test(joinClause),
   "the gate should deny the one bad status, not allow a fixed set of good ones");
ok(/sync_status IS DISTINCT FROM 'removed'/.test(joinClause),
   "the join should drop exactly the removed schedules");

// In the JOIN and not the WHERE, and not at the output: filtering anywhere else
// either drops the whole rental row or leaves the row half-lit, with a Lit From
// beside a blank Lighting. The five lighting columns have to go NULL together.
const baseWhere = sqlCode.slice(sqlCode.indexOf("WHERE fr.deleted_at IS NULL"),
                                sqlCode.indexOf("rental_items AS ("));
ok(baseWhere.length > 0 && !/rls\./.test(baseWhere),
   "the removed-schedule filter should not sit in the base CTE's WHERE clause");

// IS DISTINCT FROM, never !=. A NULL sync_status compared with != is NULL, so
// the join misses and a schedule we simply cannot classify silently disappears
// — the opposite of the failure direction this wants.

// A DENYLIST, not an allowlist. An unrecognised status is more likely live than
// removed, and an allowlist stops showing a status the product adds next month.

// ── The card: the window is the facility's clock ────────────────────────────
ok(/AS "Lit Window"/.test(sqlCode), "card 17294 should emit a Lit Window column");
ok(/lighting_lit_from\s+AT TIME ZONE/.test(sqlCode) &&
   /lighting_lit_until\s+AT TIME ZONE/.test(sqlCode),
   "both ends of the window should be converted, not just one");
ok(/COALESCE\(b\.lighting_timezone, b\.location_timezone\)/.test(sqlCode),
   "the schedule's own timezone should lead, with the location as the fallback");
ok(/rls\.timezone\s+AS lighting_timezone/.test(sqlCode) &&
   /l\.timezone AS location_timezone/.test(sqlCode),
   "base should carry both timezones for the conversion to read");

// The same format as Begin/End two columns up, so the three read as one clock.
const winEnd = sqlCode.indexOf('AS "Lit Window"');
const winClause = sqlCode.slice(Math.max(0, winEnd - 500), winEnd);
ok(/'HH12:MIam'/.test(winClause),
   "Lit Window should use the same HH12:MIam shape as Begin and End");

// CONCAT_WS skips a NULL side; a bare || would make the whole string NULL the
// moment one end is missing, which is two of the nine live schedules.
ok(/CONCAT_WS\(' - ',/.test(winClause),
   "the two ends should be joined with CONCAT_WS so a NULL side drops out");

// ADDITIVE. Lit From / Lit Until are in the Excel export and are what a
// pre-column cache entry still carries, so they cannot be replaced.
["Lighting", "Lit From", "Lit Until", "Lighting Sync"].forEach(c => {
  ok(sqlCode.indexOf('AS "' + c + '"') > 0, "card 17294 should still emit " + c);
});

// ── The page reads it, and no longer reads a clock ──────────────────────────
ok(/litWindow:\s*raw\['Lit Window'\]/.test(src),
   "normalizeRow should map the new column");

// The note line must go through the helper. A second reader of the shape is a
// second chance to get it wrong — progAutopayCell through progAutopayShare,
// siteLabel with one definition, loaderReadEstimate.
const noteStart = src.indexOf("if (r.lighting === 'Yes') {");
ok(noteStart > 0, "the lit note should still be gated on the Lighting column");
const noteBlock = src.slice(noteStart, noteStart + 400);
ok(/litWindowLabel\(r\)/.test(noteBlock),
   "the lit note should compose its window through litWindowLabel");
ok(!/new Date\(/.test(noteBlock),
   "the lit note should not parse an instant in the reader's timezone");

// The Excel export follows the view: an export that carried a different clock
// from the screen is the exports-must-respect-filters rule one field over.
const xlStart = src.indexOf("if (showLighting)  headers.push(");
ok(xlStart > 0, "the Excel export should still have a lighting column group");
ok(/'Lighting', 'Lit Window', 'Lit From', 'Lit Until'/.test(src.slice(xlStart, xlStart + 200)),
   "the Excel header should carry Lit Window beside the raw instants");
const xlRow = src.indexOf("if (showLighting) { row.push(r.lighting");
ok(xlRow > 0, "the Excel row builder should still write the lighting group");
ok(/litWindowLabel\(r\)/.test(src.slice(xlRow, xlRow + 260)),
   "the Excel row should read the window through the same helper the screen does");

// One cell per header, or every column after this one shifts — the fault the
// last three column additions caused on other reports.
const hdrCount = (src.slice(xlStart, xlStart + 200).match(/'Lit|'Lighting/g) || []).length;
const cellCount = (src.slice(xlRow, xlRow + 260).match(/row\.push\(/g) || []).length;
eq(cellCount, hdrCount, "the lighting group should push one cell per header");

console.log(n + " assertions passed.");
