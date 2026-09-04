#!/usr/bin/env node
/* ============================================================================
 * programs-card-window.spec.js — card 17295 v9, the window-first rewrite.
 *
 * THE BUG IT GUARDS. Card 17295's only date filter was the [[ ]] pair at the
 * very bottom, against the sd LATERAL. So every CTE above it — bk, item_tx,
 * sec_fin (with its payment_plan_installment LATERAL), slots, ppl, wl and
 * sec_fac — was computed over the ORG'S WHOLE HISTORY and then discarded for
 * out-of-window sections. Measured at Watertown over Sep 2026, item_tx (the
 * dominant CTE) ran 14.0s over 9,194 order items; scoped to the window it is
 * 0.08s over 890. Same shape as the money CTE on card 21286.
 *
 * WHY THE ASSERTIONS ARE WHAT THEY ARE. This is a pure input restriction: the
 * output is governed by the SAME bottom [[ ]] clauses as before, and sec_win's
 * predicate is those clauses lifted to the top. Three ways that can silently
 * stop being true, and each is an assertion here:
 *
 *   1. THE BOTTOM [[ ]] CLAUSES MUST STAY. They are the authority; sec_win is
 *      an optimisation. Delete them "because sec_win already does it" and the
 *      card starts returning rows the report never asked for the moment the two
 *      predicates drift.
 *   2. sec_win MUST TEST THE SAME ENVELOPE. sd.first_start is MIN(g.mn) — the
 *      overall MIN(starts_at) — and sd.last_end is MAX(g.mx). sec_env computes
 *      exactly those. A section with no sessions gets NULL from both and passes
 *      both tests, which is why each side carries its own IS NULL branch: drop
 *      one and every section with no sessions silently leaves the report.
 *   3. sec_env IS ONE GROUP BY, NOT A PER-SECTION LATERAL. A LATERAL here
 *      re-does per section the work sd already does per section, and measured
 *      it cost more than it saved. Reverting it is invisible in the output.
 *
 * AND THE TRAILING ORDER BY. It vanished once already on card 17300 — `wc -l`
 * counts newlines and the file's last line has none, so reading "lines N-M"
 * silently stops one short. Pinned here rather than trusted.
 *
 * The spec reads the PENDING candidate while it exists and the live mirror once
 * the push has landed, so it keeps guarding across the rename rather than
 * needing to be edited on the day.
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "sql", "report-cards");
const PENDING = path.join(DIR, "17295-programs-report.v9-PENDING.sql");
const LIVE    = path.join(DIR, "17295-programs-report.sql");

// The pending file is the candidate until it is pushed, at which point it is
// deleted and the mirror carries the same SQL. Guard whichever one is the v9.
const file = fs.existsSync(PENDING) ? PENDING : LIVE;
const raw  = fs.readFileSync(file, "utf8");
const which = path.basename(file);

// Comments quote the shapes this guards against on purpose, so every structural
// assertion runs over a comment-stripped copy. Line comments first: this repo
// has already been bitten by a stray `/*` inside a line comment swallowing
// thousands of lines when block comments were stripped first.
const sql = raw.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0; const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
const count = (re) => (sql.match(re) || []).length;

// --- 1. the bottom filter is still the authority --------------------------
ok(/\[\[\s*AND \(sd\.first_start IS NULL OR \(sd\.first_start AT TIME ZONE cfg\.tz\)::date <= \{\{end_date\}\}::date\) \]\]/.test(sql),
   which + ": the final [[ ]] filter on sd.first_start is gone — sec_win is an optimisation, not the authority");
ok(/\[\[\s*AND \(sd\.last_end\s+IS NULL OR \(sd\.last_end\s+AT TIME ZONE cfg\.tz\)::date >= \{\{start_date\}\}::date\) \]\]/.test(sql),
   which + ": the final [[ ]] filter on sd.last_end is gone");

// --- 2. sec_env / sec_win exist and test the same envelope ----------------
ok(/sec_env AS \(/.test(sql), which + ": sec_env is missing");
ok(/sec_win AS \(/.test(sql), which + ": sec_win is missing");
ok(/sec_env AS \([\s\S]*?MIN\(se\.starts_at\)[\s\S]*?MAX\(se\.ends_at\)[\s\S]*?GROUP BY se\.section_id/.test(sql),
   which + ": sec_env no longer computes MIN(starts_at)/MAX(ends_at) grouped by section — that envelope is what sd tests");
ok(!/sec_env AS \([\s\S]{0,400}?LATERAL/.test(sql),
   which + ": sec_env is back to a per-section LATERAL, which re-does the work sd already does per section");

const win = (sql.match(/sec_win AS \(([\s\S]*?)\n\),/) || [])[1] || "";
ok(/\[\[\s*AND \(e\.mn IS NULL OR \(e\.mn AT TIME ZONE cfg\.tz\)::date <= \{\{end_date\}\}::date\) \]\]/.test(win),
   which + ": sec_win's upper bound does not match the filter it stands in for");
ok(/\[\[\s*AND \(e\.mx IS NULL OR \(e\.mx AT TIME ZONE cfg\.tz\)::date >= \{\{start_date\}\}::date\) \]\]/.test(win),
   which + ": sec_win's lower bound does not match the filter it stands in for");
// Both IS NULL branches: a section with no sessions has no sec_env row, so
// dropping either one drops every such section from the report.
ok((win.match(/IS NULL OR/g) || []).length === 2,
   which + ": sec_win lost an IS NULL branch — a section with no sessions would silently leave the report");
// Both clauses are optional, or an unparameterised run (NO_DATE_REPORTS, the
// health probe) restricts to a window nobody asked for.
ok((win.match(/\[\[/g) || []).length === 2 && /WHERE TRUE/.test(win),
   which + ": sec_win's date clauses are not both optional [[ ]] off a WHERE TRUE");

// --- 3. every history-wide CTE actually reads it --------------------------
// Named individually rather than by a count, so a CTE that quietly stops being
// scoped fails by its own name instead of a number moving.
const scoped = [
  [/bk AS \([\s\S]*?JOIN sec_win sw ON sw\.section_id = COALESCE\(b\.section_id, se\.section_id\)/,
   "bk (and therefore item_tx, item_collected and sec_fin, which all read it)"],
  [/JOIN sec_win sw0\s+ON sw0\.section_id = se\.section_id/, "slots, on the session list"],
  [/JOIN sec_win sw1\s+ON sw1\.section_id = b\.section_id/, "slots, on the section-booking arm"],
  [/JOIN sec_win sw2\s+ON sw2\.section_id = ses2\.section_id/, "slots, on the session-booking arm"],
  [/EXISTS \(SELECT 1 FROM sec_win sw WHERE sw\.section_id = bs\.section_id\)/, "ppl"],
  [/EXISTS \(SELECT 1 FROM sec_win sw[\s\S]{0,120}?COALESCE\(w\.section_id, se\.section_id\)\)/, "wl"],
  [/JOIN sec_win sw\s+ON sw\.section_id = sf\.section_id/, "sec_fac"],
  [/JOIN sec_win swm ON swm\.section_id = s\.id/, "the main section list, so the sd LATERAL only runs in-window"],
];
for (const [re, name] of scoped) {
  ok(re.test(sql), which + ": " + name + " is no longer scoped to sec_win — it runs over the org's whole history again");
}

// The session-booking arm has only a session id, so it needs `session` joined
// to reach a section at all. Drop that and sw2 has nothing to match on.
ok(/JOIN session ses2 ON ses2\.id = b\.session_id AND ses2\.organization_id = cfg\.org_id/.test(sql),
   which + ": the session-booking arm lost its own session join, so it cannot resolve a section to scope by");

// --- 4. nothing was lost in transcription ---------------------------------
ok(/ORDER BY p\.name, s\.name\s*$/.test(sql.trimEnd() + "\n"),
   which + ": the trailing ORDER BY is gone — the exact thing that silently vanished on card 17300");
// The output column list is what the page reads; v9 changes inputs only.
for (const col of ["period_received", "period_refunds", "period_net", "autopay_plan_items",
                   "manual_plan_items", "past_due_value", "scheduled_autopay_value",
                   "scheduled_manual_value", "no_plan_balance_value", "location_count",
                   "instructor_count", "waitlist_converted", "program_season"]) {
  ok(new RegExp("AS " + col + "\\b").test(sql),
     which + ": output column " + col + " is missing — v9 restricts inputs and must change no output");
}

// --- 5. the dates are cast, so a re-Texted tag still parses ---------------
// Every date tag in this file is used as {{x}}::date. Metabase regenerates tags
// as Text on an API push, and a bare Text tag against a date operator is a
// second, independent way for the card to be down after a push.
const tagUses = sql.match(/\{\{(start_date|end_date)\}\}[^\s)]*/g) || [];
ok(tagUses.length > 0 && tagUses.every(t => t.includes("::date")),
   which + ": a start_date/end_date tag is used without ::date, so a re-Texted tag would not parse");

if (failures.length) {
  console.error("\n✗ programs-card-window.spec.js — " + failures.length + " failure(s):\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n" + pass + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
console.log("✓ programs-card-window.spec.js — " + pass + " assertions passed (" + which + ")");
