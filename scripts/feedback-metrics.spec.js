#!/usr/bin/env node
/* ============================================================================
 * feedback-metrics.spec.js — the thumbs metrics on the admin Platform Usage
 * cards (Dan, 2026-09-03: "I feel like displaying the feedback metrics are an
 * easy lift").
 *
 * THE DATA WAS ALREADY THERE AND NOTHING DISPLAYED IT. Six surfaces take a
 * thumb and every one of them has been writing to events.jsonl since it
 * shipped. What made this more than a display job is that a thumb is recorded
 * THREE different ways depending on which surface took it — measured against
 * production on 2026-09-03, over the whole log:
 *
 *   event              field       rows
 *   vote               sentiment   15
 *   insights-feedback  score        18
 *   wizard-feedback    vote         11   <- and NOT in SLACK_NOTIFY until now
 *   chat-feedback      score         9
 *   feedback           vote          9   <- the Report Wizard, carries the PROMPT
 *   update-vote        sentiment     3
 *                                  ---
 *                                   65   across 15 orgs
 *
 * So the assertions here are the four ways this can be wrong while still
 * rendering a plausible number:
 *
 *   1. ONE PREDICATE READS ALL SIX. Three field names for one fact is how a
 *      surface silently stops being counted. `/api/admin/feedback` read
 *      `chat-feedback` and `insights-feedback` ONLY — 27 of the 65 — and both
 *      of those families have had ZERO activity in the last 30 days while the
 *      other four account for all 17 recent ratings. That route answered "no
 *      feedback" for a month in which seventeen people rated something.
 *   2. A ROW WITH NO READABLE SENTIMENT IS COUNTED ON NEITHER SIDE. A default
 *      would file an unreadable row as agreement or as a complaint; a thumbs
 *      figure that invents a direction is worse than one that says it could
 *      not tell. It is reported separately instead.
 *   3. NO SHARE OVER A HANDFUL. 30 days holds 17 ratings across 10 orgs, so a
 *      per-org percentage would read "100%" off one thumb. The share is null
 *      under FEEDBACK_MIN_RATINGS and the per-org column prints counts only.
 *   4. THE COUNT HAS TO OPEN SOMETHING. A number with nowhere to go is the
 *      dead end this repo keeps writing down (the Failed check-ins tile, the
 *      "2 ending soon" section) — and the comment, or on a wizard row the
 *      PROMPT somebody typed and did not get a good answer to, is the highest
 *      signal text on the platform. It existed only in a JSONL file.
 *
 * It LIFTS AND RUNS the predicate rather than regexing it, and boots a real
 * server over a fixture DATA_DIR for the rendered half — a regex over our own
 * patch is not evidence the dashboard shows anything. SKIP_SOURCE=1 drops the
 * source assertions so the live half can be shown to catch a regression alone.
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
/* NO COMMENT-STRIPPING OVER server.js, and that is a deliberate retreat.

   A regex stripper is unsound on this file, in two independent ways found by
   this spec passing vacuously:

     · line 5837 carries the text "/* stay reachable so it can be" INSIDE a
       // comment (legal JS). Strip block comments first and that opener pairs
       with a real close fifteen hundred lines later, swallowing 2,792 lines.
       Nine specs in this repo had that order. Line-comments-first fixes it.
     · line ~5918 carries a "/*" inside a TEMPLATE LITERAL — real code, not a
       comment. Nothing about strip order helps, and both orders swallow the
       region that holds /api/admin/feedback.

   So the assertions below read the RAW source, and the ones that need to be
   scoped take the route's own slice instead. Nothing here needs a comment
   hidden, because no comment in this change quotes a broken form verbatim.
   Generalise it: if a spec must not see comments, slice the region it cares
   about rather than stripping a 19,000-line file with a regex. */
const region = (from, chars) => {
  const i = src.indexOf(from);
  if (i < 0) throw new Error("region not found: " + from);
  return src.slice(i, i + chars);
};
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";

let pass = 0;
const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(g === w, m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

// ── lift and RUN ────────────────────────────────────────────────────────────
function liftDecl(text, decl) {
  const start = text.indexOf(decl);
  if (start < 0) throw new Error(decl + " not found at module scope — a spec cannot run what it cannot reach");
  // Skip a parameter list before counting braces: for a destructured parameter
  // the first `{` is the pattern, not the body. Fourth instance of that trap.
  let i = decl.startsWith("function") ? text.indexOf(")", start) : start;
  let depth = 0;
  i = text.indexOf("{", i);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1) + (decl.startsWith("const") ? ";" : "");
}
const _F = new Function(
  liftDecl(src, "const FEEDBACK_SOURCES = ") + "\n" +
  liftDecl(src, "function feedbackSentiment(") + "\n" +
  liftDecl(src, "function feedbackSubject(") + "\n" +
  liftDecl(src, "function feedbackNote(") + "\n" +
  "; return { FEEDBACK_SOURCES, feedbackSentiment, feedbackSubject, feedbackNote };")();
const { FEEDBACK_SOURCES, feedbackSentiment, feedbackSubject, feedbackNote } = _F;

/* ── 1. ALL SIX FAMILIES, ALL THREE FIELD NAMES ─────────────────────────────
   These are the shapes production actually writes, read off the live log on
   2026-09-03 — not invented. Getting any one of them wrong drops a whole
   surface from the count silently. */
const SHAPES = [
  ["vote",              { sentiment: "up" },   { sentiment: "down" }],
  ["update-vote",       { sentiment: "up" },   { sentiment: "down" }],
  ["insights-feedback", { score: 1 },          { score: 0 }],
  ["chat-feedback",     { score: 1 },          { score: 0 }],
  ["feedback",          { vote: "up" },        { vote: "down" }],
  ["wizard-feedback",   { vote: "up" },        { vote: "down" }],
];
SHAPES.forEach(([event, upRow, downRow]) => {
  eq(feedbackSentiment(Object.assign({ event }, upRow)),   "up",   event + " reads an UP thumb");
  eq(feedbackSentiment(Object.assign({ event }, downRow)), "down", event + " reads a DOWN thumb");
  ok(FEEDBACK_SOURCES[event], event + " has a source label, or the list cannot say what was rated");
});
eq(Object.keys(FEEDBACK_SOURCES).length, 6, "six families, no more and no fewer");

/* THE SEVENTH SURFACE. Every event name this server logs whose name mentions a
   vote or feedback must be in the map, or it ships uncounted exactly the way
   wizard-feedback did. This is derived from server.js rather than transcribed,
   so a new surface fails here instead of being quietly missing. */
if (!SKIP_SOURCE) {
  const logged = new Set();
  for (const m of src.matchAll(/logEvent\(\s*[^,]+,\s*[^,]+,\s*"([^"]+)"/g)) logged.add(m[1]);
  const votish = [...logged].filter(n => /vote|feedback/.test(n));
  eq(votish.length, 6, "server.js logs exactly six thumbs events");
  votish.forEach(n => ok(FEEDBACK_SOURCES[n], n + " is counted — a logged thumbs event missing from the map is a surface nobody sees"));
}

/* ── 2. UNREADABLE IS NEITHER ──────────────────────────────────────────────*/
eq(feedbackSentiment({ event: "vote" }), null,
   "a vote with no sentiment field is NEITHER up nor down");
eq(feedbackSentiment({ event: "vote", sentiment: "sideways" }), null,
   "and an unrecognised value is not silently an up");
eq(feedbackSentiment({ event: "view", sentiment: "up" }), null,
   "a non-feedback event is never a rating, whatever fields it carries");
eq(feedbackSentiment(null), null, "and a missing row does not throw");
// score is a NUMBER in the log. A string "1" is not a thumbs up, and treating
// it as one would count a malformed row.
eq(feedbackSentiment({ event: "chat-feedback", score: "1" }), null,
   "score is compared strictly — a string is not a readable score");

/* ── 3. WHAT WAS RATED, in the row's own words ─────────────────────────────
   Each surface names its subject in a different field. A list that printed the
   report type for all six would read "Report Wizard on report-wizard" — the
   report type twice and the thing rated never, which is the exact defect
   already fixed once in the Slack branch. */
eq(feedbackSubject({ event: "update-vote", report: "project-update", updateTitle: "Paid status" }),
   "Paid status", "an update names the UPDATE, not the report type");
eq(feedbackSubject({ event: "feedback", report: "report-wizard", title: "Week 2 Revenue" }),
   "Week 2 Revenue", "a wizard row names the generated report");
eq(feedbackSubject({ event: "wizard-feedback", report: "rentalcalendar", siteType: "picnic-table" }),
   "site type: picnic-table", "a rental-wizard row names the suggestion");
eq(feedbackSubject({ event: "vote", report: "programs" }), "programs",
   "and a plain report vote names the report");

// THE PROMPT IS THE COMMENT on a wizard row: the question somebody typed and
// did not get a good answer to is the most useful text the platform has.
ok(/Pequos/.test(feedbackNote({ event: "feedback", prompt: "all revenue for Pequos camp" }) || ""),
   "a wizard row with no comment surfaces its PROMPT");
ok(/^“/.test(feedbackNote({ event: "feedback", prompt: "x" })),
   "...quoted, so it reads as somebody's words rather than as our label");
eq(feedbackNote({ event: "chat-feedback", comment: "no results, boo" }), "no results, boo",
   "and a real comment is carried verbatim");
eq(feedbackNote({ event: "vote" }), null, "a rating with nothing typed has no note");
// A comment beats a prompt: if somebody typed both, the comment is the one
// aimed at us.
eq(feedbackNote({ event: "feedback", comment: "wrong totals", prompt: "revenue" }), "wrong totals",
   "a comment wins over the prompt");

/* ── 4. THE SOURCE ASSERTIONS ──────────────────────────────────────────────*/
if (!SKIP_SOURCE) {
  // The old two-family filter cannot come back.
  ok(!/e\.event === "chat-feedback" \|\| e\.event === "insights-feedback"/.test(src),
     "the API route no longer reads two of the six families");
  ok(/buildFeedback\(days/.test(region('app.get("/api/admin/feedback"', 700)),
     "...it goes through buildFeedback, like the dashboard");

  // ONE aggregator, several readers. Three surfaces deriving this separately is
  // how the dashboard and the API start disagreeing about how many ratings exist.
  ok((src.match(/buildFeedback\(/g) || []).length >= 4,
     "buildFeedback has at least three callers besides its definition");
  ok(/const fb30\s*=\s*buildFeedback\(30/.test(src),
     "the KPI counts the same 30 days as every card beside it");
  ok(/const fbAll\s*=\s*buildFeedback\(null/.test(src),
     "and the list is everything on record, because 30 days holds a fraction of it");

  // EVERY family posts to Slack. wizard-feedback was missing, so 11 ratings
  // were recorded and never announced — the fifth instance of that trap here.
  const notify = src.match(/const SLACK_NOTIFY = new Set\(\[([\s\S]*?)\]\)/)[1];
  Object.keys(FEEDBACK_SOURCES).forEach(n =>
    ok(notify.includes(JSON.stringify(n)), n + " is in SLACK_NOTIFY, or it is recorded and never posted"));
  ok(/"wizard-feedback":\s*\{\s*emoji/.test(src),
     "wizard-feedback has SLACK_EVENT_META, or notifySlack has no emoji for it");
  ok(/rec\.event === "wizard-feedback"\s*\n?\s*\?\s*`\$\{rec\.org\}\|\$\{rec\.report\}\|wizard-feedback\|\$\{rec\.siteType/.test(src),
     "and it debounces per SITE TYPE — two suggestions rated is two answers");

  // The floor, and the null share.
  ok(/const FEEDBACK_MIN_RATINGS = \d+/.test(src), "the share has a floor");
  ok(/total >= FEEDBACK_MIN_RATINGS \? Math\.round\(up \/ total \* 100\) : null/.test(src),
     "...and under it the share is null, never a confident percentage of four");

  // The per-org column prints COUNTS. Measured: 30 days is 17 ratings across 10
  // orgs, so a per-org share reads 100% off a single thumb.
  ok(!/fb30\.byOrg\[r\.slug\][\s\S]{0,200}?Math\.round\([\s\S]{0,40}?\* 100\)/.test(src),
     "the per-org cell computes no percentage");
  ok(/data-fb-org="\$\{r\.slug\}"/.test(src), "and it is addressable, so a guard can read it");

  // THE COUNT OPENS SOMETHING.
  ok(/onclick="toggleFeedback\(\)"/.test(src), "the KPI is a way in, not just a number");
  ok(/function toggleFeedback\(\)/.test(src), "and the handler exists");
  ok(/id="fb-list" class="fb-list" style="display:none"/.test(src),
     "the list is CLOSED until asked for — an always-open list is a noisier feature");

  // oldest is a MIN, not an array position: events.jsonl is append-only so it
  // is normally sorted, but the header prints that date as a fact.
  ok(/if \(!oldest \|\| r\.ts < oldest\) oldest = r\.ts/.test(src),
     "the oldest rating is a minimum, not the last element");
}

/* ── 5. THE LIVE HALF ──────────────────────────────────────────────────────
   Boots a real server over a fixture DATA_DIR and reads the served HTML. A
   source assertion cannot tell a KPI that renders from one that renders the
   wrong number, and the whole dashboard is one template literal — the class of
   bug that has taken out every button on this page twice. */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fbspec-"));
const now = Date.now();
const iso = d => new Date(now - d * 86400000).toISOString();
// ASCENDING, like the append-only log. One row per family, both directions,
// deliberately DIFFERENT per org so a cell reading the wrong org's counts
// fails rather than rendering a plausible number: apex 1/1, watertown 2/3.
const FIXTURE = [
  { ts: iso(10), org: "apex", report: "gl", event: "vote" },                       // unreadable
  { ts: iso(9),  org: "westsacramento", report: "project-update", event: "update-vote", sentiment: "up", updateId: "u1", updateTitle: "Updated Fast Track Reporting" },
  { ts: iso(8),  org: "watertown", report: "rentalcalendar", event: "wizard-feedback", vote: "up", siteType: "picnic-table" },
  { ts: iso(7),  org: "watertown", report: "report-wizard", event: "feedback", vote: "down", title: "Pequossette Week 2", prompt: "all revenue for Pequos summer camp, Week 2 sections" },
  { ts: iso(6),  org: "watertown", report: "chat", event: "chat-feedback", score: 0, comment: "no results, boo" },
  { ts: iso(5),  org: "watertown", report: "fasttrack", event: "insights-feedback", score: 0, comment: "numbers looked off" },
  { ts: iso(4),  org: "watertown", report: "programs", event: "insights-feedback", score: 1 },
  { ts: iso(3),  org: "apex", report: "facility", event: "vote", sentiment: "down" },
  { ts: iso(2),  org: "apex", report: "programs", event: "vote", sentiment: "up" },
  { ts: iso(1),  org: "apex", report: "gl", event: "view" },                       // not a rating
];
fs.writeFileSync(path.join(DIR, "events.jsonl"), FIXTURE.map(r => JSON.stringify(r)).join("\n") + "\n");

const PORT = 4700 + (process.pid % 200);
const srv = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  cwd: ROOT, stdio: "ignore",
  env: Object.assign({}, process.env, { DATA_DIR: DIR, PORT: String(PORT), SLACK_WEBHOOK_URL: "" }),
});
const get = p => new Promise((resolve, reject) => {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: p }, r => {
    let b = ""; r.on("data", d => b += d); r.on("end", () => resolve({ status: r.statusCode, body: b }));
  });
  req.on("error", reject);
  req.setTimeout(30000, () => { req.destroy(new Error("timeout")); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 60; i++) {
    try { await get("/api/admin/flags"); break; } catch (_) { await wait(500); }
  }

  const api = JSON.parse((await get("/api/admin/feedback?days=400")).body);
  /* READ THROUGH A SAFE ACCESSOR. A route that answers with the wrong SHAPE
     must fail by name, not throw: mutating it back to the old two-family
     filter made `api.byOrg.apex.up` a TypeError, and the spec died reporting
     "Cannot read properties of undefined" — naming nothing. A guard that dies
     instead of failing has not told anyone what broke, which is the third
     instance of that lesson in this repo. */
  const at = (path, dflt) => path.split(".").reduce(
    (o, k) => (o == null ? undefined : o[k]), api) ?? dflt;
  ok(Array.isArray(api.rows), "the route answers with a rows array");
  ok(api.byOrg && typeof api.byOrg === "object", "and a per-org map");
  eq(api.up, 4, "the API counts four up across all six families");
  eq(api.down, 4, "and four down");
  eq(api.total, 8, "eight readable ratings");
  eq(api.unreadable, 1, "with the sentiment-less row counted on NEITHER side");
  eq(api.upPct, 50, "and a share, because eight clears the floor");
  eq(api.rows.length, 8, "every rating is listed");
  eq(at("rows.0.ts", null), FIXTURE[8].ts, "newest first");
  eq(api.oldest, FIXTURE[1].ts, "and the oldest is the earliest RATING, not the earliest event");
  eq(at("byOrg.apex.up", null), 1, "apex up");
  eq(at("byOrg.apex.down", null), 1, "apex down");
  eq(at("byOrg.watertown.up", null), 2, "watertown up");
  eq(at("byOrg.watertown.down", null), 3, "watertown down");
  ok(!api.byOrg.gl, "and an org key is an org, not a report");
  // All six labels reached the list.
  const srcs = new Set((api.rows || []).map(r => r.source));
  eq(srcs.size, 6, "all six sources appear in the list");

  // A window that holds nothing must not claim a share. `days=1` reaches back
  // one day, which holds the fixture's plain `view` and no ratings at all.
  // (Not days=0: parseInt("0") is falsy, so the route reads it as its 30-day
  // default — worth knowing before believing a zero from that call.)
  const empty = JSON.parse((await get("/api/admin/feedback?days=1")).body);
  eq(empty.total, 0, "a window with no ratings is zero");
  eq(empty.upPct, null, "...and has NO share — nobody rating anything is not everybody hating it");

  const page = (await get("/")).body;
  ok(/data-fb-total="8"/.test(page), "the KPI renders the count it computed");
  ok(/Feedback · 50% up/.test(page), "with its share, because the window clears the floor");
  ok(/class="fb-open"/.test(page), "and it says it opens something");
  // The per-org cell — 2 up / 3 down at watertown, not apex's 1/1.
  const cell = page.match(/data-fb-org="watertown"[^>]*title="([^"]*)"/);
  ok(cell && cell[1] === "2 up, 3 down in the last 30 days",
     "the per-org cell carries THIS org's counts — got " + (cell ? cell[1] : "no cell"));
  ok(/data-fb-org="apex"[^>]*title="1 up, 1 down/.test(page), "and apex carries its own");
  ok(/id="fb-list" class="fb-list" style="display:none"/.test(page),
     "the list is closed on load");
  ok(/Pequos summer camp/.test(page),
     "the wizard PROMPT is on screen — the reason the panel is worth opening");
  ok(/1 unreadable/.test(page), "and the unreadable row is disclosed rather than hidden");
  ok(/no results, boo/.test(page), "comments are rendered");

  // The column count has to match, or every figure after Feedback shifts a
  // column left — the exact fault the last three column additions caused.
  const thead = page.match(/<thead>[\s\S]*?<\/thead>/)[0];
  const nTh = [...thead.matchAll(/<th[\s>]/g)].length;
  const firstRow = page.match(/<tbody id="usage-tbody"><tr[^>]*>([\s\S]*?)<\/tr>/)[1];
  const nTd = (firstRow.match(/<td[\s>]/g) || []).length;
  eq(nTd, nTh, "the body has one cell per header");
  const foot = page.match(/id="usage-more-row"><td colspan="(\d+)"/);
  if (foot) eq(Number(foot[1]), nTh, "and the Show-all row spans them all");
  // The feedback cell is the SIXTH, matching sortUsage(this,5).
  const cells = firstRow.split(/<td[\s>]/).slice(1);
  ok(/data-fb-org/.test(cells[5] || ""),
     "the feedback cell sits where its header's sort index points");

  srv.kill();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

  if (failures.length) {
    console.error("\n✗ feedback-metrics.spec.js — " + failures.length + " failure(s):\n");
    failures.forEach(f => console.error("  ✗ " + f));
    console.error("\n" + pass + " passed, " + failures.length + " failed.\n");
    process.exit(1);
  }
  console.log("✓ feedback-metrics.spec.js — " + pass + " assertions passed" +
              (SKIP_SOURCE ? " (source half skipped)" : "") + ".");
})().catch(e => { srv.kill(); console.error("✗ feedback-metrics.spec.js threw:", e.message); process.exit(1); });
