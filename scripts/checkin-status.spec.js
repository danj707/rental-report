// Spec for the two attendance statuses added on 2026-08-26: ABSENT on the
// Programs Check-Ins band, FAILED on the Memberships Check-Ins tab.
//
// WHAT THE INVESTIGATION FOUND, and why the shapes differ. "Visitor log" is the
// product's name for public.attendance_event; there is no visitor_log table. It
// carries SEVEN types, not two, and two facts about them decide everything here:
//
//   · `marked_absent` is target_type='session', so it attributes to a section.
//   · `check_in_denied` is target_type='organization' — measured, all 58 rows
//     platform-wide, every one a membership (52) or pass (6) scan. It has no
//     session and therefore NO SECTION, so a per-section "Failed" column could
//     only ever be a dash on every row forever. It belongs on the memberships
//     feed, which is already org-grain.
//
//   · the log is APPEND-ONLY — attendance_event has no deleted_at — so undoing a
//     mark writes `marked_absent_undone` and the original row stays. A naive
//     COUNT(*) FILTER (WHERE type='marked_absent') counts absences an admin took
//     back: measured, that is Chico 13 instead of 12 and Apex 6 instead of 5.
//
// Run: node scripts/checkin-status.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const progSql = fs.readFileSync(path.join(ROOT, "sql", "program-checkins.sql"), "utf8");
const memSql  = fs.readFileSync(path.join(ROOT, "sql", "memberships-checkins.sql"), "utf8");
const progPage = fs.readFileSync(path.join(ROOT, "public", "programs.html"), "utf8");

let passed = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); passed++; };

// ── The ABSENT rule lives in SQL, so the SQL is what gets pinned ─────────────
test("absence is resolved as a STATE — the latest mark or undo wins", () => {
  assert.match(progSql, /DISTINCT ON \(ae\.target_id, ae\.participant_user_id\)/,
    "one row per (session, participant) is what makes it a state rather than a tally");
  assert.match(progSql, /ORDER BY ae\.target_id, ae\.participant_user_id, ae\.created_at DESC, ae\.id DESC/,
    "latest first, with id as the tie-break — two events in the same millisecond " +
    "must not resolve differently between runs");
  assert.match(progSql, /IN \('marked_absent','marked_absent_undone'\)/,
    "the undo type has to be IN the window the state is resolved over, or it cannot cancel anything");
  assert.match(progSql, /WHERE a\.type = 'marked_absent'/,
    "only pairs whose surviving state is the mark are counted");
});

test("a naive count is NOT what ships — the guard names the orgs it would break", () => {
  // Belt and braces: if someone replaces the state CTE with a plain FILTER, the
  // assertions above go quiet unless the shape is also pinned negatively.
  assert.ok(!/COUNT\(\*\) FILTER \(WHERE ae\.type = 'marked_absent'\)/.test(progSql),
    "counting marked_absent rows directly re-introduces the retracted-absence bug");
  assert.match(progSql, /Chico 13\s*\n?--\s*(instead of 12|.*12)|Chico 13 instead of 12/,
    "the measurement that justifies the rule should stay next to it");
});

test("the state is resolved over ALL history, then the surviving mark is windowed", () => {
  // If the window were applied while resolving, a mark inside the range whose
  // undo falls outside it would survive — the report would show an absence the
  // admin had already taken back.
  const stateCte = progSql.slice(progSql.indexOf("absent_state AS ("), progSql.indexOf("abs AS ("));
  assert.ok(!/start_date|end_date/.test(stateCte),
    "the state CTE must not be date-filtered:\n" + stateCte);
  const absCte = progSql.slice(progSql.indexOf("abs AS ("), progSql.indexOf("secs AS ("));
  assert.match(absCte, /a\.created_at >= \{\{start_date\}\}/, "the surviving mark's own date is filtered");
});

test("the check-in/check-out aggregate is untouched, so no existing figure moves", () => {
  const att = progSql.slice(progSql.indexOf("WITH att AS ("), progSql.indexOf("-- Current absence STATE"));
  assert.match(att, /COUNT\(\*\) FILTER \(WHERE ae\.type = 'check_in'\)/);
  assert.match(att, /COUNT\(\*\) FILTER \(WHERE ae\.type = 'check_out'\)/);
  assert.match(att, /COUNT\(DISTINCT ae\.participant_user_id\) FILTER \(WHERE ae\.type = 'check_in'\)/);
  assert.ok(!/marked_absent/.test(att),
    "absences must not leak into the attendance aggregate — that is the facility " +
    "Summary bug (a fee line counted as a booking) in another costume");
  // Verified live 2026-08-26 against the deployed card: Apex 67 sections /
  // 1246 check-ins and Watertown 69 / 7734, zero rows differing on any existing
  // column. Recorded here so the next editor knows what to re-measure.
  assert.match(progSql, /v2 \(2026-08-26\)/, "the version note should stay");
});

test("a section with absences but no scans still gets a row", () => {
  assert.match(progSql, /secs AS \(\s*\n\s*SELECT section_id FROM att\s*\n\s*UNION\s*\n\s*SELECT section_id FROM abs/,
    "the section list is the UNION of both, or a section where everyone was " +
    "marked absent and nobody scanned in is invisible");
});

test("absences are scoped by the same section filters as check-ins", () => {
  // Measured: Reading has 16 of 66 marks on ARCHIVED sections and Apex all 5.
  // Those sections do not appear as rows at all, so their absences have nowhere
  // to go — dropping them is what keeps the column consistent with the table.
  assert.match(progSql, /sec\.deleted_at IS NULL AND sec\.canceled_at IS NULL AND sec\.archived_at IS NULL/);
  const absCte = progSql.slice(progSql.indexOf("abs AS ("), progSql.indexOf("secs AS ("));
  assert.match(absCte, /ss\.deleted_at IS NULL AND ss\.canceled_at IS NULL/);
});

// ── The FAILED rule ─────────────────────────────────────────────────────────
test("failures ride the MEMBERSHIPS feed, because a denial has no section", () => {
  assert.match(memSql, /ae\.type IN \('check_in', 'check_in_denied'\)/);
  assert.match(memSql, /WHEN ae\.type = 'check_in_denied' THEN 'Failed'/);
  assert.match(memSql, /ELSE 'Checked In'/);
  assert.match(memSql, /target_type='organization'/,
    "the reason it cannot be a per-section column belongs in the file");
  assert.ok(!/check_in_denied/.test(progSql),
    "a denial must NOT be plumbed into the program card — it has no session to " +
    "attribute it to, so the column could only ever be a dash");
});

test("the memberships card keeps its existing method filter", () => {
  // All 58 denials are membership (52) or pass (6), so widening the type filter
  // needs no change here — and narrowing it would silently drop them.
  assert.match(memSql, /ae\.check_in_method_type IN \('membership', 'pass'\)/);
});

// ── The page must be correct BEFORE and AFTER the card ships ────────────────
test("a feed with no Absent column yields null, never 0", () => {
  assert.match(progPage, /const absentRaw\s+= r\['Absent'\];/);
  assert.match(progPage, /absentRaw == null \|\| absentRaw === '' \? null : fmtNum\(absentRaw\)/,
    "fmtNum(undefined) is 0, and a 0 here claims nobody was marked absent");
});

test("the column and tile are hidden — not zeroed — when the feed cannot answer", () => {
  assert.match(progPage, /let totAbsent = 0, totAbsentees = 0, hasAbsent = false;/);
  assert.match(progPage, /if \(r\.absent != null\)\s+\{ hasAbsent = true;/,
    "presence must be driven by a non-null value, not by a truthy count — a real " +
    "0 absences on a card that DOES emit the column must still show the column");
  assert.strictEqual((progPage.match(/checkinSummary\.hasAbsent/g) || []).length, 4,
    "expected the same gate on all four surfaces — the table header, the cell, " +
    "the summary tile and the caption sentence. Miss one and the page half-admits " +
    "to a column it cannot fill.");
});

console.log(`\n${passed}/${passed} passing`);
