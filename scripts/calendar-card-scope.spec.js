#!/usr/bin/env node
/* ============================================================================
 * calendar-card-scope.spec.js — card 17298's three CTEs are ORG-SCOPED, and
 * the calendar page does not fire two heavy queries at once.
 *
 * THE BUG IT GUARDS. Watertown's Session Schedule sat on "Loading…" for about
 * three minutes. Two compounding causes, both measured 2026-09-11:
 *
 *   1. CARD 17298 COMPUTED THREE CTEs PLATFORM-WIDE and then threw ~98% away.
 *      section_registration aggregated all 51,154 registration_window rows,
 *      program_activities all 9,695 program_activity rows, and
 *      section_eligibility all 31,380 eligibility lookups — to serve an org
 *      holding 775 of the platform's 58,429 sections. section_eligibility ALONE
 *      measured 54.9s building 31,127 groups, more than the whole card (49.8s),
 *      and its plan opened with a Seq Scan on the 14 MB lookup table.
 *
 *      Every one of those tables carries its own INDEXED organization_id that
 *      the card never used. Filtering on it turns the seq scan into a Bitmap
 *      Index Scan. Watertown's week: 49.8s → 7.2s, 62 rows and an identical
 *      row-level fingerprint (5f5d6d4e2b36e07dffe6fa8d451f3bcb) either way.
 *
 *   2. THE PAGE FIRED BOTH OF ITS FETCHES ON MOUNT. calendar.html asks for the
 *      visible week AND a today→+60 window for the filter dropdowns. Run alone
 *      those are 92.5s and 34.0s; fired together they CONTEND — 180.3s and
 *      196.9s — and blow past the data route's 60s + 120s retry budget.
 *
 * WHY program_activities IS SCOPED DIFFERENTLY, and this is the load-bearing
 * one. The obvious form — AND ca.organization_id = {{org_id}} — is WRONG.
 * program_activity.organization_id is NULL on one live row: SF Rec & Park's
 * "Tennis Lesson with Vern", a program with 215 sections. Scoping on that
 * column drops it, and all 215 sections silently relabel from "Tennis" to
 * "Uncategorized". Verified against production, all three forms side by side:
 * deployed → "Tennis", scoped-via-program → "Tennis", scoped-via-own-column →
 * NULL. So it is scoped through the PROGRAM, whose org is correct by
 * construction. The other two tables were checked the same way and have ZERO
 * mismatching rows platform-wide, which is what makes filtering them directly
 * safe for every org rather than for a sampled few.
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");

const SQL_FILE  = path.join(__dirname, "..", "sql", "report-cards", "17298-calendar-schedule.sql");
const PAGE_FILE = path.join(__dirname, "..", "public", "calendar.html");

const rawSql = fs.readFileSync(SQL_FILE, "utf8");
const page   = fs.readFileSync(PAGE_FILE, "utf8");

// The comments here quote the rejected shapes on purpose (ca.organization_id,
// "Uncategorized"), so every structural assertion runs over a comment-stripped
// copy. Line comments FIRST — this repo has been bitten by a stray `/*` inside
// a line comment swallowing thousands of lines the other way round.
const sql = rawSql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0; const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// Slice one CTE body out of the stripped SQL, so an assertion about
// section_eligibility cannot be satisfied by text in section_registration.
function cte(name) {
  const i = sql.indexOf(name + " AS (");
  if (i < 0) return "";
  let depth = 0, j = sql.indexOf("(", i);
  for (let k = j; k < sql.length; k++) {
    if (sql[k] === "(") depth++;
    else if (sql[k] === ")") { depth--; if (depth === 0) return sql.slice(j, k + 1); }
  }
  return "";
}

// --- 0. the slices resolve, or every assertion below is vacuous -----------
for (const n of ["section_registration", "program_activities", "section_eligibility"]) {
  ok(cte(n).length > 100, "the " + n + " CTE could not be sliced — every assertion about it is vacuous");
}

// --- 1. the two tables that are safe to filter directly -------------------
// Verified platform-wide: 0 rows where the table's own organization_id
// disagrees with (or is NULL against) its section's org.
const reg = cte("section_registration");
ok(/rw\.organization_id\s*=\s*\{\{org_id\}\}::uuid/.test(reg),
   "section_registration is UNSCOPED again — it aggregates all 51,154 registration_window rows on the platform");

const elig = cte("section_eligibility");
ok(/ergl\.organization_id\s*=\s*\{\{org_id\}\}::uuid/.test(elig),
   "section_eligibility is UNSCOPED again — this is the 54.9s Seq Scan that WAS the whole card");

// --- 2. program_activities is scoped through the PROGRAM, never its own column
// This is the assertion that stops the plausible-looking regression.
const pa = cte("program_activities");
ok(/JOIN\s+program\s+\w+[\s\S]*?\.organization_id\s*=\s*\{\{org_id\}\}::uuid/.test(pa),
   "program_activities is not scoped through the program — it falls back to aggregating all 9,695 rows platform-wide");
ok(!/\bca\.organization_id\b/.test(pa),
   "program_activities scopes on ca.organization_id, which is NULL on SF Rec & Park's " +
   "\"Tennis Lesson with Vern\" — 215 sections would silently relabel to Uncategorized");

// --- 3. scoping restricts INPUTS; no output may move ----------------------
for (const col of ['"Date"', '"Day"', '"Begin"', '"End"', '"Begin Sort"', '"Program"', '"Section"',
                   '"Price"', '"Activity"', '"Location"', '"Status"', '"Section URL"',
                   '"Description"', '"Eligibility"']) {
  ok(new RegExp("AS\\s+" + col).test(sql),
     "output column " + col + " is missing — this change restricts inputs and must change no output");
}
ok(/ORDER BY "Date", "Begin Sort", "Location"\s*$/.test(sql.trimEnd() + "\n"),
   "the trailing ORDER BY is gone — the exact thing that silently vanished on card 17300");

// --- 4. the date bounds stay optional and stay CAST -----------------------
// The report opens unscoped windows and a non-optional clause would break it;
// the cast is what lets the card survive an API push that re-Texts its tags.
ok((rawSql.match(/\[\[/g) || []).length === 2 && (rawSql.match(/\]\]/g) || []).length === 2,
   "the two [[ ]] date clauses are no longer optional — every org's calendar would need both dates");
const tagUses = sql.match(/\{\{(start_date|end_date)\}\}/g) || [];
ok(tagUses.length === 2 && /DATE\(\{\{start_date\}\}\)/.test(sql) && /DATE\(\{\{end_date\}\}\)/.test(sql),
   "a date tag is no longer wrapped in DATE(), so a re-Texted tag after an API push would not parse");

// --- 5. the page does not fire both fetches at once -----------------------
// No source assertion can see a race, so what is pinned is the gate itself:
// the wide filter-options fetch must be behind the visible window's fetch.
const wideEffect = (() => {
  const i = page.indexOf("Wide fetch (today");
  if (i < 0) return "";
  const j = page.indexOf("},[firstLoadDone]);", i);
  return j < 0 ? "" : page.slice(i, j);
})();
ok(wideEffect.length > 100,
   "the filter-options effect is no longer gated on firstLoadDone — it fires on mount and contends with the week fetch (180.3s vs 92.5s, measured)");
ok(/if\(!firstLoadDone\)\s*return;/.test(wideEffect),
   "the filter-options fetch lost its early return, so it runs before the visible window has landed");
// Both branches that populate the table must release the gate, or an org
// landing in month view never gets filter options at all.
ok((page.match(/setFirstLoadDone\(true\)/g) || []).length === 2,
   "only one of the week/month fetch branches sets firstLoadDone — one of the two views would never fill its dropdowns");

if (failures.length) {
  console.error("\n✗ calendar-card-scope.spec.js — " + failures.length + " failure(s):\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n" + pass + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
console.log("✓ calendar-card-scope.spec.js — " + pass + " assertions passed");
