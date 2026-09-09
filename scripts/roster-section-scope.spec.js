#!/usr/bin/env node
/* ============================================================================
 * roster-section-scope.spec.js — the Class Roster is scoped by section_id.
 *
 * Dan, on Hatha Yoga: "well it kinda does. but its much faster now" — over a
 * roster reading 82 of 82 for a class that has 24 people in it.
 *
 * THE ROSTER WAS SCOPED BY THE DATE WINDOW ALONE. section_id rode in the URL,
 * reached buildMetabaseParams, and was dropped on the floor for every report
 * except section-detail; the page then matched the section by NAME, as a
 * substring, in the browser. A name is not an identity.
 *
 * MEASURED AT CLARKSVILLE, 2026-09-09, sections that share a name:
 *   Water Aerobics Drop-In    16 sections   118 bookings
 *   Tico's Tsunami Swimmers    9 sections    55 bookings
 *   Hatha Yoga                 4 sections    82 bookings   <- Dan's screenshot
 *   Tico's Tidal Tots          4 sections    36 bookings
 *   ...eight more at 2
 * So opening one class's roster returned every RUN of a class with that name.
 * Platform-wide this file already records 60% of sections sharing a name.
 *
 * A CORRECTION THIS PINS: the comment in buildMetabaseParams used to say card
 * 17296 had no section tag and that passing one "would make Metabase reject the
 * query". The card has carried a {{section_name}} tag with its own [[ ]] block
 * all along. A wrong comment is worse than no comment — it is why nobody looked
 * underneath it. The assertion below fails if that claim comes back.
 *
 * WHAT THIS PINS:
 *   1. section_id is forwarded for `roster` AND `section-detail`, and for
 *      nothing else — a report whose card has no such tag would 400.
 *   2. section_name is NOT forwarded. It is the free-text search box: a partial
 *      name is the point, the match must stay instant over loaded rows, and
 *      every search term would otherwise become its own feed cache entry.
 *   3. The card's clause is OPTIONAL. An unscoped roster must be byte-identical
 *      to the pre-push card, because that is what the report opens on.
 *   4. It casts ::uuid rather than relying on the tag's type. An API push
 *      regenerates every tag as Text, and this one then needs no re-flip —
 *      only the two DATE tags do.
 *   5. The pre-existing section_name clause SURVIVED, as did the trailing
 *      ORDER BY — the exact thing that silently vanished from card 17300.
 *
 * It LIFTS AND RUNS buildMetabaseParams rather than regexing it: a regex passes
 * on an inverted comparison.
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const CARD   = path.join(__dirname, "..", "sql", "report-cards", "17296-class-roster.sql");
const src  = fs.readFileSync(SERVER, "utf8");
const card = fs.readFileSync(CARD, "utf8");
// The card's own comments quote the shapes being warned against, so clause
// assertions run over a stripped copy or they pass on correct SQL.
const cardCode = card.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

let pass = 0; const failures = [];
const ok = (c, m) => { if (c) pass++; else failures.push(m); };
const eq = (a, b, m) => ok(a === b, m + "  (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")");

function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found at module scope — a spec cannot run what it cannot reach");
  // Skip the parameter list first: counting braces from the first "{" matches a
  // DESTRUCTURED PARAMETER and cuts the function in half. (Third instance.)
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

// ── lift and RUN buildMetabaseParams ───────────────────────────────────────
const build = (function () {
  const body = liftFn(src, "buildMetabaseParams");
  const sandbox = `
    const NO_DATE_REPORTS = new Set(["memberships"]);
    const FORWARD_REPORTS = new Set(["programs-schedule"]);
    const DEFAULT_WINDOW_DAYS = 7;
    const parseToISO = s => String(s);
    const console = { log(){} };
    ${body}
    return buildMetabaseParams;`;
  return new Function(sandbox)();
})();

const tagOf = (params, name) =>
  params.filter(p => p.target && p.target[1] && p.target[1][1] === name)[0];

const ORG = "460566d3-3a51-4387-a7a0-0b010923e40d";
const SEC = "fe2bba2c-3c1b-403d-9433-2ddc05b6b049";
const WIN = { start_date: "2026-09-08", end_date: "2026-09-08" };

// 1. the fix itself
{
  const p = build(Object.assign({ section_id: SEC }, WIN), "roster", ORG);
  const t = tagOf(p, "section_id");
  ok(!!t, "roster forwards section_id — without it the roster is scoped by the date window ALONE and a name match merges every run of a class");
  if (t) {
    eq(t.value, SEC, "roster forwards the section_id it was given, unchanged");
    eq(t.type, "string/=", "section_id goes as string/=, like org_id — the card casts ::uuid itself");
  }
}
// 2. section-detail keeps working — this is an addition, not a move
{
  const p = build({ section_id: SEC }, "section-detail", ORG);
  ok(!!tagOf(p, "section_id"), "section-detail still forwards section_id — the roster was ADDED to that branch, not swapped into it");
}
// 3. an unscoped roster sends no section tag, or the [[ ]] clause could never drop out
{
  const p = build(Object.assign({}, WIN), "roster", ORG);
  ok(!tagOf(p, "section_id"), "a roster opened with no section sends no section_id, so the card's optional clause drops out and the query is unchanged");
}
// 4. no other report may send it — their cards have no such tag and would 400
["facility", "gl", "programs", "programs-schedule", "memberships", "users"].forEach(rt => {
  const p = build(Object.assign({ section_id: SEC }, WIN), rt, ORG);
  ok(!tagOf(p, "section_id"), rt + " does not forward section_id — its card has no such tag and Metabase would reject the query");
});
// 5. section_name stays client-side, deliberately
{
  const p = build(Object.assign({ section_name: "Hatha Yoga", section_id: SEC }, WIN), "roster", ORG);
  ok(!tagOf(p, "section_name"), "section_name is NOT forwarded — it is the free-text search box, and sending it would put a Metabase query behind every keystroke and give every search term its own cache entry");
}
// 6. the dates still travel (the branch must not have eaten them)
{
  const p = build(Object.assign({ section_id: SEC }, WIN), "roster", ORG);
  eq((tagOf(p, "start_date") || {}).value, "2026-09-08", "start_date still forwarded on a section-scoped roster");
  eq((tagOf(p, "end_date") || {}).value, "2026-09-08", "end_date still forwarded on a section-scoped roster");
  eq((tagOf(p, "org_id") || {}).value, ORG, "org_id still forwarded on a section-scoped roster");
}
// 7. the false comment must not come back
ok(!/would make Metabase\s*\n?\s*\/\/\s*reject the query|reject the query \(unknown parameter\)/.test(src),
   "the comment claiming card 17296 would reject a section parameter is gone — it was false (the card has had a section_name tag all along) and it is why nobody looked underneath it");

// ── the card ───────────────────────────────────────────────────────────────
ok(/\[\[\s*AND\s+section\.id\s*=\s*\{\{section_id\}\}::uuid\s*\]\]/.test(cardCode),
   "card 17296 filters on section.id inside an OPTIONAL [[ ]] block — non-optional would make every unscoped roster on the platform fail");
ok(/\{\{section_id\}\}::uuid/.test(cardCode),
   "section_id is CAST ::uuid rather than relying on the tag's type — an API push regenerates every tag as Text, and the cast is what saves this one from needing a re-flip");
ok(/\[\[\s*AND\s+section\.name\s+ILIKE\s*'%'\s*\|\|\s*\{\{section_name\}\}\s*\|\|\s*'%'\s*\]\]/.test(cardCode),
   "the pre-existing section_name clause SURVIVED the edit — it is the card's own search filter and dropping it would be a silent feature deletion");
ok(/ORDER BY\s+section\.name,\s*"Session Date",\s*u_part\.last_name,\s*u_part\.first_name/.test(cardCode),
   "the trailing ORDER BY survived — the exact thing that silently vanished from card 17300 on a hand-transcribed push");
// every output column still present: an additive filter may not change the shape
["Rec ID","First Name","Last Name","Date of Birth","Age","Grade","Gender","Phone","Email",
 "Household Owner","Owner Email","Owner Phone","Emergency Contacts","Authorized Pickups",
 "Class","Section","Session Date","Session Start","Session End","Status","Registered","Form Responses"
].forEach(col => {
  ok(card.indexOf('AS "' + col + '"') >= 0, 'card 17296 still emits "' + col + '" — this change adds a filter and must not move a column');
});
// the filter must sit in the WHERE, not smuggled into a JOIN where it would
// turn the LEFT JOINs above it into inner ones
{
  const where = cardCode.slice(cardCode.lastIndexOf("\nWHERE"));
  ok(/section\.id\s*=\s*\{\{section_id\}\}/.test(where),
     "the section_id clause is in the final WHERE, not in a JOIN — inside a join it would change which rows the LEFT JOINs above it keep");
}

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("\n✗ roster-section-scope.spec.js — " + failures.length + " failure(s):\n");
  failures.forEach(f => console.error("  ✗ " + f));
  console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
  process.exit(1);
}
console.log("✓ roster-section-scope.spec.js — " + pass + " assertions passed.");
