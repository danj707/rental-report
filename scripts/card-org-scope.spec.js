#!/usr/bin/env node
/*
 * card-org-scope.spec.js — no card CTE may read a base table platform-wide.
 *
 * The bug this exists for: card 17298's section_registration, program_activities
 * and section_eligibility carried no org filter at all. They aggregated 51,154 /
 * 9,695 / 31,380 rows across every org on the platform and then discarded ~98%.
 * Watertown's week: 49.8s. Scoped: 7.2s, identical rows.
 *
 * THE RULE, and it is deliberately the weak form. A CTE is scoped if EITHER
 *   (a) its body mentions organization_id anywhere, OR
 *   (b) its FROM/JOIN list references another CTE — an inner join to an
 *       already-scoped set restricts first, so the base table is never read
 *       platform-wide (17294's item_tx, 21649's run/enr/sfac, every one of
 *       19570's money CTEs).
 * Neither is proof of a good plan; both are proof the author had the question in
 * mind. What this catches is the shape that has no answer at all — the one that
 * shipped on 17298 and cost three minutes.
 *
 * A NEW ENTRY IN ALLOW IS A DECISION, NOT A SILENCER. Each carries the measured
 * cost and why it is not worth a push; see CLAUDE.md, "THE AUDIT: DOES ANY OTHER
 * CARD SCAN THE PLATFORM?".
 */
const fs = require("fs");
const path = require("path");

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else failures.push(msg);
}

// Measured platform-wide scans we have decided to live with, with the reason.
const ALLOW = {
  // 36,183 rows seq-scanned, 35,883 groups built, to label El Segundo's ~83
  // aquatic sections. Measured 487ms on a card that runs in ~2s. section_facilitator
  // carries its own indexed organization_id so the fix is one line — but 21683 is
  // El Segundo-only and is in the UI-paste carve-out (an API save wipes its
  // hardcoded org_id default and its Date tags), so it costs a paste to buy 0.4s.
  "21683-aquatics-classes.sql::fac": "measured 487ms, El Segundo only, UI-paste carve-out",
};

function stripComments(s) {
  // line comments FIRST — server.js and these mirrors both carry a `/*` inside a
  // line comment, and the other order swallows everything to the next real close.
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// Split the top-level WITH list into [name, body] pairs. Quote-aware so a ')'
// inside a string literal cannot end a CTE early.
function splitCtes(sql) {
  const out = [];
  const w = /\bWITH\b/i.exec(sql);
  if (!w) return out;
  let i = w.index + w[0].length;
  const head = /^\s*(?:RECURSIVE\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\s+AS\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(/i;
  for (;;) {
    const m = head.exec(sql.slice(i));
    if (!m || m.index !== 0) return out;
    const name = m[1].replace(/"/g, "");
    let j = i + m[0].length;
    let depth = 1;
    while (j < sql.length && depth) {
      const c = sql[j];
      if (c === "'") {
        j++;
        while (j < sql.length && sql[j] !== "'") j++;
      } else if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    out.push([name, sql.slice(i + m[0].length, j - 1)]);
    while (j < sql.length && /\s/.test(sql[j])) j++;
    if (sql[j] !== ",") return out;
    i = j + 1;
  }
}

const REF = /\b(?:FROM|JOIN)\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))?)/gi;

function refs(body) {
  const out = [];
  let m;
  REF.lastIndex = 0;
  while ((m = REF.exec(body))) out.push(m[1].replace(/"/g, "").split(".").pop().toLowerCase());
  return out;
}

const dirs = ["sql/report-cards", "sql"];
const files = [];
for (const d of dirs) {
  for (const f of fs.readdirSync(d)) {
    if (f.endsWith(".sql")) files.push(path.join(d, f));
  }
}
ok(files.length >= 25, `expected the SQL mirrors to be found, got ${files.length}`);

let ctesSeen = 0;
let allowHit = 0;

for (const file of files) {
  const base = path.basename(file);
  const sql = stripComments(fs.readFileSync(file, "utf8"));
  const ctes = splitCtes(sql);
  for (const [name, body] of ctes) {
    const r = refs(body);
    const cteNames = new Set(ctes.map(([n]) => n.toLowerCase()));
    const readsBase = r.some((t) => !cteNames.has(t) && t !== "lateral");
    if (!readsBase) continue; // pure CTE-driven
    ctesSeen++;
    const key = `${base}::${name}`;
    // A one-row lookup of the org itself is scoped by definition — several cards'
    // `cfg` CTE is `FROM organization o WHERE o.id = {{org_id}}`, which names no
    // column called organization_id and needs none.
    const orgLookup =
      r.every((t) => cteNames.has(t) || t === "organization") &&
      /\.id\s*=\s*\{\{\s*org_id\s*\}\}/.test(body);
    const scoped = orgLookup || /organization_id/i.test(body) || r.some((t) => cteNames.has(t));
    if (ALLOW[key]) {
      allowHit++;
      ok(!scoped, `${key} is on the ALLOW list but is now scoped — remove the entry rather than leaving a stale exemption`);
      continue;
    }
    ok(
      scoped,
      `${key} reads a base table with no organization_id anywhere and no join to a scoped CTE — ` +
        `this is the shape that cost card 17298 three minutes. Scope it, or add it to ALLOW with the measured cost.`
    );
  }
}

ok(ctesSeen > 100, `expected to have examined many CTEs, examined ${ctesSeen} — the splitter is probably broken`);
ok(allowHit === Object.keys(ALLOW).length, `every ALLOW entry must name a CTE that still exists (matched ${allowHit} of ${Object.keys(ALLOW).length})`);

// The three CTEs the fix landed on must stay scoped, by name — a file-wide
// organization_id test passes on a card that scopes everything except these.
const cal = stripComments(fs.readFileSync("sql/report-cards/17298-calendar-schedule.sql", "utf8"));
for (const [name, body] of splitCtes(cal)) {
  if (!["section_registration", "program_activities", "section_eligibility"].includes(name)) continue;
  ok(/organization_id/i.test(body), `17298::${name} lost its org filter — this is the Watertown bug, verbatim`);
}

// program_activities is scoped through the PROGRAM on purpose: program_activity
// .organization_id is NULL on SF Rec & Park's "Tennis Lesson with Vern", a program
// with 215 sections, so the obvious form silently relabels all 215 Uncategorized.
{
  const pa = splitCtes(cal).find(([n]) => n === "program_activities");
  ok(pa && !/\bca\.organization_id\b/.test(pa[1]), "17298::program_activities must not scope on ca.organization_id — it is NULL on a live SF program with 215 sections");
  ok(pa && /pa_prog\.organization_id/.test(pa[1]), "17298::program_activities must scope through the program join");
}

if (failures.length) {
  for (const f of failures) console.error("FAIL: " + f);
  console.error(`\n${failures.length} assertion(s) failed.`);
  process.exit(1);
}
console.log(passed + " assertions passed.");
