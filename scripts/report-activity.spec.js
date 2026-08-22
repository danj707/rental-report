// Spec for activity-gated alerting.
//
// Dan's rule (2026-08-22): do not alert on a report nobody uses; once it is
// used, it joins the alert set on its own. The alerts had been spending their
// credibility on reports with no audience — `overview` has 8 opens ever (none
// in three months) and `annual-report` 3, and both sit in REPORT_DEPENDENCIES,
// so a dropped table under either would page someone about a page nobody
// visits.
//
// The two properties that matter most here are the ones that fail silently:
//
//   1. Activity must count EVERY usage event, not just `view`. The six Program
//      Summary bands (selfservice, program-checkins, program-demographics,
//      retention, checkins, section-detail) have zero `view` events by design
//      and are fetched by 15 orgs apiece. Counting views alone would quietly
//      stop watching the most-used reports on the platform.
//
//   2. `report-down` must NOT count as usage. It is logged against the real
//      org/report, so a broken unused report would alert once, qualify itself
//      as active, and keep alerting forever.
//
// Run: node scripts/report-activity.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

function slice(start, end) {
  const a = src.indexOf(start);
  assert.ok(a > 0, `server.js should contain: ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `could not find the end of: ${start}`);
  return src.slice(a, b);
}

// Lift the real activity block, with readEvents injected so the spec can hand
// it any event stream it likes.
function build(events) {
  const body = slice("const ACTIVITY_WINDOW_DAYS", "async function runHealthCheck");
  return new Function("readEvents", "process",
    body + "\nreturn { getReportActivity, isReportActive, isReportTypeActive,"
         + " ACTIVITY_WINDOW_DAYS, NON_USAGE_EVENTS };"
  )(() => events, { env: {} });
}

// The catalog gate, lifted with the same injected event stream, so the filter
// itself is exercised rather than just asserted to exist in the source.
function buildSplit(events) {
  const body = slice("const ACTIVITY_WINDOW_DAYS", "async function runHealthCheck")
    + "\n" + slice("function splitBreakageByActivity", "// A stable identity");
  return new Function("readEvents", "process",
    body + "\nreturn splitBreakageByActivity;")(() => events, { env: {} });
}

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

const ev = (org, report, event) => ({ org, report, event });

// ── what counts as usage ────────────────────────────────────────────────────

test("a viewed report is active", () => {
  const a = build([ev("apex", "gl", "view")]);
  assert.strictEqual(a.isReportActive("apex", "gl"), true);
  assert.strictEqual(a.isReportTypeActive("gl"), true);
});

test("a fetched-but-never-viewed report is active — the Program Summary bands", () => {
  // The whole reason activity is not view-only. These six have zero `view`
  // events across the entire log and are fetched by 15 orgs.
  const bands = ["selfservice", "program-checkins", "program-demographics",
                 "retention", "checkins", "section-detail"];
  const a = build(bands.map(rt => ev("watertown", rt, "fetch")));
  for (const rt of bands) {
    assert.strictEqual(a.isReportActive("watertown", rt), true, `${rt} must count as active`);
    assert.strictEqual(a.isReportTypeActive(rt), true, rt);
  }
});

test("an export counts as usage even with no view", () => {
  for (const e of ["pdf", "excel", "print", "summary", "email", "permits", "munis"]) {
    const a = build([ev("pawnee", "facility", e)]);
    assert.strictEqual(a.isReportActive("pawnee", "facility"), true, e);
  }
});

test("a brand-new export event counts without anyone editing this file", () => {
  // NON_USAGE_EVENTS is a denylist on purpose: whatever ships next is usage.
  const a = build([ev("apex", "gl", "some-future-export-2027")]);
  assert.strictEqual(a.isReportActive("apex", "gl"), true);
});

// ── what must NOT count ─────────────────────────────────────────────────────

test("report-down does not make a broken unused report look active", () => {
  // The self-sustaining-alert bug: report-down is logged against the real
  // org/report, so counting it would qualify the report as active forever.
  // Real usage elsewhere is needed so the empty-log failsafe is not what is
  // being measured here.
  const a = build([
    ev("apex", "gl", "view"),
    ev("norman", "products", "report-down"),
    ev("norman", "products", "report-down"),
  ]);
  assert.strictEqual(a.getReportActivity().events, 1, "only the real view counts");
  assert.strictEqual(a.isReportActive("norman", "products"), false);
  assert.strictEqual(a.isReportTypeActive("products"), false);
});

test("the platform alerts and org lifecycle events are not usage", () => {
  for (const e of ["report-down", "schema-break", "param-drift", "created", "org-deleted"]) {
    assert.ok(build([]).NON_USAGE_EVENTS.has(e), `${e} must not count as usage`);
  }
});

test("a log of nothing but alerts falls back to watching everything", () => {
  const a = build([
    ev("norman", "products", "report-down"),
    ev("clarksville", "roster", "report-down"),
  ]);
  assert.strictEqual(a.getReportActivity().events, 0);
  // events === 0 is the failsafe below — which is correct here too: a log with
  // no real usage in it is indistinguishable from a missing log.
  assert.strictEqual(a.isReportActive("apex", "gl"), true);
});

// ── the failsafe ────────────────────────────────────────────────────────────

test("an empty log watches everything rather than silently watching nothing", () => {
  // A missing events file, a fresh volume, or a new PR preview must not mean
  // "22 reports went unused" — that would disable every alert at once.
  const a = build([]);
  assert.strictEqual(a.getReportActivity().events, 0);
  assert.strictEqual(a.isReportActive("anything", "at-all"), true);
  assert.strictEqual(a.isReportTypeActive("at-all"), true);
});

test("once there is real usage, unused reports go inactive", () => {
  const a = build([ev("apex", "gl", "view")]);
  assert.strictEqual(a.isReportActive("apex", "overview"), false);
  assert.strictEqual(a.isReportTypeActive("annual-report"), false);
});

// ── per-org vs per-type ─────────────────────────────────────────────────────

test("activity is per org AND report, so one org's use does not cover another's", () => {
  const a = build([ev("apex", "historic", "view")]);
  assert.strictEqual(a.isReportActive("apex", "historic"), true);
  assert.strictEqual(a.isReportActive("smyrna", "historic"), false);
  // …but a shared card serving anyone at all is still worth watching.
  assert.strictEqual(a.isReportTypeActive("historic"), true);
});

test("malformed rows are skipped without throwing", () => {
  const a = build([null, {}, { org: "a" }, { report: "gl" }, ev("apex", "gl", "view")]);
  assert.strictEqual(a.getReportActivity().events, 1);
  assert.strictEqual(a.isReportActive("apex", "gl"), true);
});

test("the result is cached, so a health run does not re-read the log per report", () => {
  let calls = 0;
  const body = slice("const ACTIVITY_WINDOW_DAYS", "async function runHealthCheck");
  const a = new Function("readEvents", "process",
    body + "\nreturn { isReportActive };")(
      () => { calls++; return [ev("apex", "gl", "view")]; }, { env: {} });
  for (let i = 0; i < 50; i++) a.isReportActive("apex", "gl");
  assert.strictEqual(calls, 1, "the events log should be read once, not 50 times");
});

test("the window is 45 days by default — a monthly report is not 'unused'", () => {
  // 30 would make a month-end pull borderline on the 31st.
  assert.strictEqual(build([]).ACTIVITY_WINDOW_DAYS, 45);
  assert.ok(src.includes("process.env.REPORT_ACTIVITY_WINDOW_DAYS"), "window must be overridable");
});

// ── wiring: the gates have to be where the alerts are ───────────────────────

test("the health check skips inactive reports instead of probing them", () => {
  const enumeration = slice("  // Per-org: only reports with a per-org mbUuid", "  // If failuresOnly");
  assert.ok(enumeration.includes("if (!isReportActive(slug, rt)) { markInactive(slug, rt); continue; }"),
    "per-org enumeration must skip inactive reports");
  assert.ok(enumeration.includes('if (!isReportTypeActive(rt)) { markInactive("_shared", rt); continue; }'),
    "the shared probe must skip report types nobody uses");
});

test("an inactive report can never raise report-down, even on a forced run", () => {
  const body = slice("    if (entry.status === \"error\") {", "    existing.reports[storeSlug][rt] = entry;");
  assert.ok(body.includes("const alertable = shared ? isReportTypeActive(rt) : isReportActive(slug, rt)"),
    "the alert branch needs its own activity gate");
  assert.ok(/if \(alertable && ripe && !quiet\)/.test(body),
    "newFailures and the report-down event must both be behind `alertable`");
});

test("one failed probe is not a report down — two in a row is", () => {
  // The ~20-alert afternoon: these cards sit close to their 60s budget, so a
  // single miss is load. Alerting on the first miss is the noise.
  const body = slice("    if (entry.status === \"error\") {", "    existing.reports[storeSlug][rt] = entry;");
  assert.ok(body.includes('entry.failCount = (prev?.status === "error" ? (prev.failCount || 1) : 0) + 1'),
    "consecutive failures must be counted, and reset by a success");
  assert.ok(body.includes("const ripe = entry.failCount >= HEALTH_ALERT_AFTER"),
    "the alert must wait for HEALTH_ALERT_AFTER consecutive failures");
  assert.ok(/HEALTH_ALERT_AFTER = Number\(process\.env\.HEALTH_ALERT_AFTER \|\| 2\)/.test(src),
    "two by default, overridable");
});

test("a slow card is classified slow, and the error says what Metabase said", () => {
  // "HTTP 400" alone cannot distinguish a dropped table from a statement
  // timeout, which are opposite problems with opposite fixes.
  assert.ok(src.includes('entry.error = `HTTP ${resp.status}${why ? ": " + why : ""}`'),
    "the response body must reach the entry");
  assert.ok(src.includes('entry.status = classifyProbeFailure({ httpStatus: resp.status, body: why })'));
  assert.ok(src.includes('entry.status = classifyProbeFailure({ body: err.message, timedOut })'));
});

// ── slow is not broken: only broken reports alert ───────────────────────────

const classify = (() => {
  const fn = new Function(slice("function classifyProbeFailure", "async function runHealthCheck")
    + "\nreturn classifyProbeFailure;")();
  return fn;
})();

test("a timeout is slow, never broken", () => {
  assert.strictEqual(classify({ timedOut: true }), "slow");
  assert.strictEqual(classify({ timedOut: true, httpStatus: 0 }), "slow");
});

test("a Metabase statement timeout behind HTTP 400 is slow", () => {
  // The exact shape Metabase returns: 400, with the reason only in the body.
  assert.strictEqual(classify({
    httpStatus: 400,
    body: '{"status":"failed","error":"canceling statement due to statement timeout"}',
  }), "slow");
  assert.strictEqual(classify({ httpStatus: 400, body: "Query timed out" }), "slow");
});

test("a Metabase 5xx is load, not a card defect", () => {
  for (const st of [500, 502, 503, 504]) assert.strictEqual(classify({ httpStatus: st }), "slow", String(st));
});

test("a dropped table, a missing parameter and a gone card are all broken", () => {
  // The failures that do not fix themselves — the only kind worth an alert.
  assert.strictEqual(classify({
    httpStatus: 400,
    body: '{"error":"ERROR: relation \\"class\\" does not exist","error_type":"invalid-query"}',
  }), "error", "the dropped `class` table must still alert");
  assert.strictEqual(classify({
    httpStatus: 400,
    body: '{"error":"Cannot run the query: missing required parameters: #{\\"end_date\\"}"}',
  }), "error", "a card that changed its required parameters is broken");
  assert.strictEqual(classify({ httpStatus: 404, body: '"Not found."' }), "error",
    "an unshared or deleted card is broken");
});

test("only a broken report reaches the failures list and the alert", () => {
  const body = slice("    if (entry.status === \"error\") {", "    existing.reports[storeSlug][rt] = entry;");
  assert.ok(body.length > 0, "the alert branch is gated on status error, so slow can never enter it");
  assert.ok(src.includes('if (e.status === "error" && !e.inactive) existing.failures.push'),
    "a slow entry must not be counted as a failure");
});

test("a slow round resets the broken streak rather than feeding it", () => {
  const body = slice("    if (entry.status === \"error\") {", "    existing.reports[storeSlug][rt] = entry;");
  assert.ok(body.includes('(prev?.status === "error" ? (prev.failCount || 1) : 0) + 1'),
    "only a previous *broken* round may carry the streak forward");
});

test("slow and inactive do not render as red on the admin panel", () => {
  assert.ok(src.includes("else if (h.status === 'slow') { dotCls += ' dot-warn'"),
    "slow must be amber, not red — it never alerts, so it must not look like a failure");
  assert.ok(src.includes("else if (h.status === 'inactive') { dotCls += ' dot-none'"),
    "unmonitored is not a judgement about whether the report works");
});

test("the alert clock survives a recovery, so a flapping card cannot re-alert", () => {
  const body = slice("    if (entry.status === \"error\") {", "  await runChunked(");
  assert.ok(body.includes("if (prev?.lastAlertedAt) entry.lastAlertedAt = prev.lastAlertedAt;"));
  assert.ok(body.includes("else if (existing.reports[storeSlug]?.[rt]?.lastAlertedAt)"),
    "a healthy entry must carry the clock forward too");
});

test("the health probe sends the same parameters the report route sends", () => {
  // org_id alone meant a card with REQUIRED date tags failed every single run
  // (_shared/programs, `missing-required-parameter`) and a card with optional
  // ones scanned the whole table instead of one window.
  const body = slice("      const timeout = setTimeout(", "      const resp = await fetch(url");
  assert.ok(body.includes("buildMetabaseParams({}, rt, useSharedHC ? org.orgId : null)"),
    "the probe must build its parameters the same way the data route does");
  assert.ok(!body.includes("orgIdParamHC"), "the org_id-only probe must be gone");
});

test("stale _shared rows are purged, including HEALTH_SKIP report types", () => {
  // _shared was exempt from the purge, so qbr-stats sat in the failure count as
  // `error` for 47 days after the check stopped probing it.
  const purge = slice("  // Purge stale entries from old check strategy", "  // Rebuild global failures");
  assert.ok(purge.includes("if (!SHARED_UUIDS[rt] || HEALTH_SKIP_REPORTS.has(rt)) delete existing.reports._shared[rt];"),
    "_shared rows for skipped or no-longer-shared reports must be cleared");
});

test("a shared card is probed once, not once per org", () => {
  // #134 pointed 28 shadowed per-org rows at the real shared cards, adding ~28
  // heavy Metabase queries per run — which pushed those same cards over their
  // timeouts and generated the alerts. One probe per card is enough.
  const enumeration = slice("  // Per-org: only reports with a per-org mbUuid", "  // If failuresOnly");
  assert.ok(enumeration.includes("if (resolveReportCard(slug, rt).shared) continue;"),
    "per-org enumeration must skip reports a shared card serves");
  const purge = slice("  // Purge stale entries from old check strategy", "  // Rebuild global failures");
  assert.ok(purge.includes("if (resolveReportCard(slug, rt).shared) delete existing.reports[slug][rt];"),
    "stale per-org rows must be purged or the panel keeps showing their failures");
});

test("an inactive failure is recorded but kept out of the failures list", () => {
  // Otherwise it inflates the 'N total failing' count and the failure email.
  assert.ok(src.includes('if (e.status === "error" && !e.inactive) existing.failures.push'),
    "the failures rebuild must exclude inactive entries");
  assert.ok(src.includes("if (!alertable) entry.inactive = true;"),
    "the entry must be flagged so the panel can explain itself");
});

test("a report that goes quiet while broken stops showing as a failure", () => {
  // The early-return path: nothing due to check, but reports just went
  // inactive. Without this the panel stays red forever.
  const early = slice("  if (toCheck.length === 0) {", "  const tierLabel");
  assert.ok(early.includes("saveHealthResults(existing)"), "inactive marks must persist");
  assert.ok(early.includes("existing.failures"), "the failures list must be re-filtered");
});

test("a breakage that only hits dead reports names nothing to alert on", () => {
  // The real filter, over a fabricated drift. `gl` is used, `overview` and
  // `annual-report` are not.
  const split = buildSplit([ev("apex", "gl", "view")]);
  const deadOnly = split({
    missingTables: [{ table: "legacy_kpi", reports: ["overview"] }],
    missingColumns: [{ table: "users", column: "nickname", reports: ["annual-report"] }],
  });
  assert.deepStrictEqual(deadOnly.active, [],
    "nothing active is affected, so there is nothing to alert about");
  assert.deepStrictEqual(deadOnly.reports, ["annual-report", "overview"],
    "the full list is still reported for the state file");
  assert.deepStrictEqual(deadOnly.missingTables, []);
  assert.deepStrictEqual(deadOnly.missingColumns, []);
});

test("a breakage hitting a used report alerts, and names only the live parts", () => {
  const split = buildSplit([ev("apex", "gl", "view")]);
  const mixed = split({
    missingTables: [
      { table: "legacy_kpi", reports: ["overview"] },
      { table: "order_item_transaction", reports: ["gl", "overview"] },
    ],
    missingColumns: [{ table: "users", column: "nickname", reports: ["annual-report"] }],
  });
  assert.deepStrictEqual(mixed.active, ["gl"]);
  assert.deepStrictEqual(mixed.missingTables, ["order_item_transaction"],
    "legacy_kpi is read only by a dead page — it must not be in the alert");
  assert.deepStrictEqual(mixed.missingColumns, []);
});

test("a table shared by a live and a dead report still counts as live", () => {
  const split = buildSplit([ev("apex", "gl", "view")]);
  const r = split({
    missingTables: [{ table: "order_item", reports: ["overview", "gl"] }],
    missingColumns: [],
  });
  assert.deepStrictEqual(r.missingTables, ["order_item"]);
  assert.deepStrictEqual(r.active, ["gl"]);
});

test("schema-break only fires when an ACTIVE report is affected", () => {
  const body = slice("  // A dropped table only matters if it breaks a report", "  return {\n    ok: true, breaking");
  assert.ok(body.includes("splitBreakageByActivity(drift)"), "the gate must be applied");
  assert.ok(/if \(live\.active\.length > 0 && \(changed \|\| opts\.force\)\)/.test(body),
    "the schema-break event must be gated on an active report");
  assert.ok(body.includes("state.reportsAffected = live.reports"),
    "the full unfiltered list must stay in the state file");
});

test("param-drift only fires for cards serving an active report", () => {
  const body = slice("  // Only a card serving a report someone actually uses", "  return {\n    ok: true, wrongType");
  assert.ok(body.includes("drift.wrongType.filter(w => w.servedActive.length > 0)"));
  assert.ok(/if \(live\.length > 0 && \(changed \|\| opts\.force\)\)/.test(body));
  assert.ok(body.includes("w.servedActive"), "the message must name the active reports, not all of them");
});

test("served entries carry enough to answer 'is this in use'", () => {
  assert.ok(src.includes("function servedIsActive(e) { return e.shared ? isReportTypeActive(e.rt) : isReportActive(e.slug, e.rt); }"),
    "a shared card is checked per report type, a per-org card per org+report");
  assert.ok(src.includes("const servedActive = serves.filter(servedIsActive).map(servedLabel);"));
});

test("the activity set is inspectable, so a missing alert can be explained", () => {
  assert.ok(src.includes('app.get("/api/admin/report-activity"'), "needs an admin endpoint");
  assert.ok(src.includes("failsafe: a.events === 0"), "the endpoint must say when the failsafe is on");
  assert.ok(src.includes("healthCheckPerOrgProbes:"),
    "it must report how many probes activity actually removes, not just how many pairs exist");
});

console.log(`\n${passed}/${passed} passing`);
