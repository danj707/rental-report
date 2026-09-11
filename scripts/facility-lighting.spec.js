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
// The slice STARTS at LIT_SOURCE_WORDS, not at litWindowLabel, because
// litWindowLabel calls litSourceWord — and a slice that reaches past its own
// inputs dies with a bare ReferenceError instead of failing by name. That is
// exactly what this spec did on the first run after the sources landed, which
// is the Nth instance of it in this repo and the reason the boundary is
// asserted rather than assumed.
const start = src.indexOf("var LIT_SOURCE_WORDS = {");
ok(start > 0, "facility.html should declare LIT_SOURCE_WORDS at module scope");
const end = src.indexOf("function addonNoteFragment(items)", start);
ok(end > start, "addonNoteFragment should follow the lighting helpers");
ok(src.indexOf("function litWindowLabel(r) {") > start,
   "litWindowLabel should sit inside the lifted block, after its own helper");

// formatTime comes with it: it is the page's ONE definition of how a time is
// displayed, and litWindowLabel routing through it is what stops the note
// reading "06:00pm" beside a Begin cell reading "6:00pm" on the same row.
const ftStart = src.indexOf("function formatTime(t) {");
ok(ftStart > 0, "facility.html should declare formatTime at module scope");
const ftEnd = src.indexOf("\nfunction ", ftStart + 10);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src.slice(ftStart, ftEnd) + "\n" + src.slice(start, end), sandbox);
const { litWindowLabel, muscoLit, lightingSyncState, litSourceWord } = sandbox;
ok(typeof litWindowLabel === "function", "litWindowLabel should be liftable");
ok(typeof muscoLit === "function", "muscoLit should be liftable");
ok(typeof lightingSyncState === "function", "lightingSyncState should be liftable");
ok(typeof litSourceWord === "function", "litSourceWord should be liftable");

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
const noteStart = src.indexOf("if (muscoLit(r)) {");
ok(noteStart > 0, "the lit note should be gated on muscoLit, not on the raw column");
const noteBlock = src.slice(noteStart, noteStart + 700);
ok(/litWindowLabel\(r\)/.test(noteBlock),
   "the lit note should compose its window through litWindowLabel");
ok(!/new Date\(/.test(noteBlock),
   "the lit note should not parse an instant in the reader's timezone");
ok(/lightingSyncState\(r\)/.test(noteBlock),
   "the lit note should carry the Musco sync state, not a bare lamp");

// The Excel export follows the view: an export that carried a different clock
// from the screen is the exports-must-respect-filters rule one field over.
const xlStart = src.indexOf("if (showLighting)  headers.push(");
ok(xlStart > 0, "the Excel export should still have a lighting column group");
ok(/'Lighting', 'Musco Sync', 'Lit Window', 'Lit From', 'Lit Until'/.test(src.slice(xlStart, xlStart + 200)),
   "the Excel header should carry Musco Sync and Lit Window beside the raw instants");
const xlRow = src.indexOf("if (showLighting) { row.push(");
ok(xlRow > 0, "the Excel row builder should still write the lighting group");
const xlRowBlock = src.slice(xlRow, xlRow + 320);
ok(/litWindowLabel\(r\)/.test(xlRowBlock),
   "the Excel row should read the window through the same helper the screen does");
ok(/muscoLit\(r\)/.test(xlRowBlock),
   "the Excel row should read lit-ness through muscoLit, or a stale feed exports a removed schedule as lit");
ok(!/row\.push\(r\.lighting/.test(xlRowBlock),
   "the Excel row should not write the raw Lighting column straight through");

// One cell per header, or every column after this one shifts — the fault the
// last three column additions caused on other reports.
const hdrCount = (src.slice(xlStart, xlStart + 200).match(/'Lit|'Lighting|'Musco/g) || []).length;
const cellCount = (xlRowBlock.match(/row\.push\(/g) || []).length;
eq(cellCount, hdrCount, "the lighting group should push one cell per header");
// ...and the column widths have to grow with them, or every width after this
// group lands under the wrong column.
const widthLine = src.slice(src.indexOf("...(showLighting?["), src.indexOf("...(showLighting?[") + 90);
eq((widthLine.match(/wch/g) || []).length, hdrCount,
   "the lighting group should carry one column width per header");

// ── A RULE IS NOT A CLOCK (2026-09-11) ──────────────────────────────────────
// Musco can anchor an end of the window to sunset, and such a schedule stores
// NO lit_from — measured on the real rows, NULL on both of the two that use
// it, so the card's CONCAT_WS yields the END ALONE. The exact string those
// rows produce is "11:00pm", and printing it raw says the lights come ON at
// 11 when it means they go OFF at 11.
eq(litSourceWord("sunset"), "Sunset", "sunset should render as a word");
eq(litSourceWord("SUNSET"), "Sunset", "the source match should not be case-sensitive");
eq(litSourceWord("reservation"), "",
   "a reservation-anchored end has a real clock and must not be worded");
eq(litSourceWord("set_time"), "",
   "set_time IS a clock (23:00 on the one live row) and must not be worded");
eq(litSourceWord(""), "", "a missing source should yield no word");
eq(litSourceWord(null), "", "a null source should yield no word, not throw");

// The bug, with the exact string the two live sunset rows produce.
eq(litWindowLabel({ litWindow: "11:00pm", litStartSource: "sunset", litEndSource: "set_time" }),
   "Sunset - 11:00pm",
   "a sunset start must be worded, not dropped, or the note reads as ON at 11");
eq(litWindowLabel({ litWindow: "11:00pm", litStartSource: "sunset", litEndSource: "reservation" }),
   "Sunset - 11:00pm",
   "the other live sunset shape should read the same way");

// WITHOUT the source columns this is the old, misleading output. Asserted so
// the fallback is a KNOWN state rather than an accident: a feed cached before
// the card carried the sources still renders the bare end for one TTL, and
// that is the behaviour being aged out rather than a second bug.
eq(litWindowLabel({ litWindow: "11:00pm" }), "11:00pm",
   "a pre-source feed should fall back to the card's own string unchanged");

// The clock is assigned to the end that is NOT rule-driven, rather than read
// positionally — a one-sided string cannot say which end it is on its own.
eq(litWindowLabel({ litWindow: "06:00pm", litStartSource: "reservation", litEndSource: "sunrise" }),
   "6:00pm - Sunrise",
   "a rule on the END should take the word while the clock stays on the start");

// A rule beats a clock even when both are present: the stored instant is one
// day's sunset and the rental recurs, so the RULE is the true statement.
eq(litWindowLabel({ litWindow: "07:42pm - 11:00pm", litStartSource: "sunset", litEndSource: "set_time" }),
   "Sunset - 11:00pm",
   "a resolved sunset instant should still render as the rule that produced it");

// Both ends ruled, no clocks at all.
eq(litWindowLabel({ litWindow: "", litStartSource: "sunset", litEndSource: "sunrise" }),
   "Sunset - Sunrise", "two rules and no clocks should still render a window");

// The fallback path words itself the same way, or a feed expiring mid-session
// restyles the note.
eq(litWindowLabel({ litUntil: "2026-07-16T23:00:00Z", litStartSource: "sunset" }).indexOf("Sunset -"),
   0, "the pre-Lit-Window fallback should word a sunset start too");

// ── muscoLit: the schedule, never the add-on ────────────────────────────────
ok(muscoLit({ lighting: "Yes", lightingSync: "synced" }),
   "a synced schedule is lit");
ok(!muscoLit({ lighting: "", lightingSync: "" }), "no schedule is not lit");
ok(!muscoLit(null), "a missing row is not lit, and must not throw");

// THE ADD-ON TRAP, and it is not hypothetical: "Field Lights" and "Field Light
// Fee" are among the four most-attached add-ons on the platform (409 rentals
// carry one), they are money, and they turn nothing on. Dan, sending a
// screenshot of exactly that row: "The screenshot is just an example, not an
// actual musco lighting integration."
ok(!muscoLit({ lighting: "", addons: "Field Lights ($25.00)", addonFees: 25 }),
   "an add-on named Field Lights must never count as Musco lighting");
ok(!muscoLit({ lighting: "", addons: "Musco Lighting ($25.00)" }),
   "an add-on named Musco Lighting must still not count — the schedule is the signal");

// The stale-cache leg: card 17294 drops removed schedules in its own join, but
// a response fetched before that change is live for four more hours and still
// says Yes.
ok(!muscoLit({ lighting: "Yes", lightingSync: "removed" }),
   "a removed schedule on a stale feed must not render as lit");
ok(!muscoLit({ lighting: "Yes", lightingSync: "REMOVED " }),
   "the removed test should survive case and whitespace");

// Denylist, like the card's join: an unclassifiable status is more likely live
// than removed, and the failure direction has to be "tell someone".
ok(muscoLit({ lighting: "Yes", lightingSync: "" }),
   "a blank status should stay lit rather than being hidden");
ok(muscoLit({ lighting: "Yes", lightingSync: "something-new" }),
   "an unknown status should stay lit rather than being hidden");

// ── lightingSyncState: only 'synced' is a confirmation ──────────────────────
eq(lightingSyncState({ lightingSync: "synced" }).tone, "ok",
   "a synced schedule is the only confident state");
eq(lightingSyncState({ lightingSync: "synced" }).icon, "\u{1F4A1}",
   "a synced schedule keeps the lamp");
eq(lightingSyncState({ lightingSync: "error" }).tone, "bad",
   "a rejected schedule should be alarming");
ok(lightingSyncState({ lightingSync: "error" }).icon !== "\u{1F4A1}",
   "a rejected schedule must not draw the same lamp as a healthy one");
ok(/NOT come on/.test(lightingSyncState({ lightingSync: "error" }).label),
   "the error state should say what it costs, not just that it failed");

// The vendor's own message is the difference between "something failed" and
// "Musco rejected this field id".
ok(/field id/.test(lightingSyncState({ lightingSync: "error", lightingError: "unknown field id" }).label),
   "the vendor's message should ride along with an error");

// An unrecognised status is reported as unconfirmed rather than drawn as a
// confident lamp. This is the load-bearing one: 'synced' and 'error' come from
// the staff MCP tool's DOCUMENTATION and have never been seen in data — no
// schedule on the platform has ever carried a non-'removed' status, and
// synced_at is NULL on all 9 — so the unknown branch is the one that will run
// first if the real vocabulary differs.
ok(lightingSyncState({ lightingSync: "whatever" }).tone !== "ok",
   "an unrecognised status must not report as confirmed");
ok(lightingSyncState({ lightingSync: "" }).tone !== "ok",
   "a blank status must not report as confirmed");
ok(lightingSyncState(null).tone !== "ok",
   "a missing row must not report as confirmed, and must not throw");
ok(/not recognised/.test(lightingSyncState({ lightingSync: "whatever" }).label),
   "an unrecognised status should name itself so it can be added to the map");

// ── The card carries the rule and the reason ───────────────────────────────
["Lit Start Source", "Lit End Source", "Lighting Error"].forEach(c => {
  ok(sqlCode.indexOf('AS "' + c + '"') > 0, "card 17294 should emit " + c);
});
["start_source", "end_source", "last_error"].forEach(c => {
  ok(new RegExp("rls\\." + c + "\\s+AS\\s+lighting_").test(sqlCode),
     "the base CTE should carry rls." + c);
});
// The card ships the RULE and the page words it — composing "Sunset" in SQL
// would put a second definition of how a time is displayed on the other side
// of a four-hour cache.
ok(!/'Sunset'/i.test(sqlCode.slice(sqlCode.indexOf('AS "Lit Window"') - 900,
                                   sqlCode.indexOf('AS "Lit Window"') + 60)),
   "the card should not word the sunset rule itself — the page owns display");

// ── The page maps them, and the row is highlighted ─────────────────────────
[["litStartSource", "Lit Start Source"], ["litEndSource", "Lit End Source"],
 ["lightingError", "Lighting Error"]].forEach(([k, col]) => {
  ok(new RegExp(k + ":\\s*raw\\['" + col + "'\\]").test(src),
     "normalizeRow should map " + col);
});

// Dan: "If a rental has an actual 'Musco Lighting' configuration set ... then
// I'd want a yellow bar highlighting that row for easy visibility."
ok(/\.data-row\.musco-lit[\s\S]{0,240}background:\s*#fffbeb/.test(src),
   "a Musco-lit row should carry the yellow highlight");
// BOTH spellings, and asserted separately. A single /print-color-adjust/ also
// matches the -webkit- prefix, so deleting the standard property SURVIVED the
// first draft of this assertion — caught by mutation, not by review.
const barCss = src.slice(src.indexOf(".data-row.musco-lit"), src.indexOf(".data-row.musco-lit") + 300);
ok(/-webkit-print-color-adjust:\s*exact/.test(barCss),
   "the highlight needs the prefixed print-color rule for Chromium's PDF");
ok(/\n\s*print-color-adjust:\s*exact/.test(barCss),
   "the highlight needs the standard print-color rule — that is the copy a grounds crew holds");
const rowJsx = src.slice(src.indexOf("className={'data-row'"), src.indexOf("className={'data-row'") + 220);
ok(/muscoLit\(r\)/.test(rowJsx),
   "the row class should come from muscoLit, so it can never fire on an add-on");
ok(!/addons/.test(rowJsx), "the row class must not read the add-on list");

// FOUR SURFACES, ONE PREDICATE. The note, the filter, the highlight and the
// export disagreeing about whether a field's floodlights are on this booking
// is the facility-Summary failure one report over.
ok((src.match(/muscoLit\(/g) || []).length >= 6,
   "muscoLit should be read by the note, the filter, the highlight and the export");
const filterBlock = src.slice(src.indexOf("if (filterLighting) {"),
                              src.indexOf("if (filterLighting) {") + 700);
ok(/result\.filter\(muscoLit\)/.test(filterBlock),
   "the Lit Only filter should read the same predicate as everything else");
ok(!/r\.lighting === 'Yes'/.test(filterBlock),
   "the Lit Only filter should not re-derive lit-ness from the raw column");

// The filter deliberately keeps a REJECTED schedule in view. A filter that
// hid the broken ones is how a broken one goes unnoticed — the same failure
// direction as the card's own denylist, and a reversal of what was proposed.
ok(!/tone\s*===\s*'ok'/.test(filterBlock) && !/lightingSyncState/.test(filterBlock),
   "the Lit Only filter should not narrow to confirmed schedules");

console.log(n + " assertions passed.");
