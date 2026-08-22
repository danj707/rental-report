// Spec for the admin watchdog switches.
//
// Dan (2026-08-22): "I'd like an option to enable/disable the drift checking
// system. If it gets too noisy, I can turn it off. This would disable the
// check, slack notifications, etc."
//
// The property that matters is that OFF means off everywhere. A switch that
// silenced Slack but left the scheduled check running would keep hammering
// Metabase and keep painting the panel red — the reader would conclude the
// switch does not work, and they would be half right. So each flag gates the
// check AND the alert, with notifySlack as a backstop for manual runs.
//
// The other property: this must not be able to mute activity pings. The flags
// are keyed off ALERT_FLAG_BY_EVENT, and an event with no entry there is always
// allowed — so `pdf`, `excel`, `view` and friends can never be switched off by
// a watchdog toggle.
//
// Run: node scripts/watchdog-flags.spec.js
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

// Lift the real flag layer, with the flag file injected.
function build(stored) {
  const body = slice("const DEFAULT_FLAGS", "// Maintenance mode is checked on every request");
  return new Function("readJSON", "writeJSON", "FLAGS_FILE", "_maintCache",
    body + "\nreturn { DEFAULT_FLAGS, ALERT_FLAG_BY_EVENT, getFlags, setFlag, watchdogEnabled, alertEnabled };"
  )(() => stored, (_f, v) => { stored = v; }, "flags.json", { ts: 0 });
}

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── defaults ────────────────────────────────────────────────────────────────

test("all three watchdogs default ON, so a fresh deploy watches", () => {
  const f = build({});
  for (const k of ["schemaBreakAlerts", "paramDriftAlerts", "reportDownAlerts"]) {
    assert.strictEqual(f.DEFAULT_FLAGS[k], true, k);
    assert.strictEqual(f.watchdogEnabled(k), true, k);
  }
});

test("a missing flag file means watching, not silence", () => {
  // The failure direction matters: an unreadable flag store must not mute the
  // watchdogs.
  const f = build({});
  assert.strictEqual(f.alertEnabled("schema-break"), true);
  assert.strictEqual(f.alertEnabled("param-drift"), true);
  assert.strictEqual(f.alertEnabled("report-down"), true);
});

test("an explicitly stored false switches that watchdog off", () => {
  const f = build({ schemaBreakAlerts: false });
  assert.strictEqual(f.alertEnabled("schema-break"), false);
  assert.strictEqual(f.alertEnabled("param-drift"), true, "the others are unaffected");
  assert.strictEqual(f.alertEnabled("report-down"), true);
});

test("each watchdog is independent", () => {
  const all = build({ schemaBreakAlerts: false, paramDriftAlerts: false, reportDownAlerts: false });
  assert.strictEqual(all.alertEnabled("schema-break"), false);
  assert.strictEqual(all.alertEnabled("param-drift"), false);
  assert.strictEqual(all.alertEnabled("report-down"), false);
});

// ── activity pings must never be gated ──────────────────────────────────────

test("an activity event has no switch and is always allowed", () => {
  // If a watchdog toggle could mute `pdf` or `view`, the Slack activity feed
  // would go quiet for reasons nobody would ever connect to this panel.
  const f = build({ schemaBreakAlerts: false, paramDriftAlerts: false, reportDownAlerts: false });
  for (const e of ["view", "pdf", "excel", "print", "summary", "email", "game",
                   "permits", "munis", "map", "insights", "created", "org-deleted"]) {
    assert.strictEqual(f.alertEnabled(e), true, `${e} must never be switchable`);
    assert.ok(!(e in f.ALERT_FLAG_BY_EVENT), `${e} must not be in ALERT_FLAG_BY_EVENT`);
  }
});

test("only the three platform alerts are switchable", () => {
  const f = build({});
  assert.deepStrictEqual(Object.keys(f.ALERT_FLAG_BY_EVENT).sort(),
    ["param-drift", "report-down", "schema-break"]);
});

test("an unknown event is allowed rather than silently muted", () => {
  assert.strictEqual(build({}).alertEnabled("some-future-alert"), true);
});

// ── OFF means off everywhere ────────────────────────────────────────────────

test("notifySlack refuses a switched-off alert", () => {
  const body = slice("function notifySlack(rec) {", "  const key = rec.event ===");
  assert.ok(body.includes("if (!alertEnabled(rec.event)) return;"),
    "notifySlack is the backstop — a manual run must not post while muted");
});

test("the catalog check does not even read the catalog when switched off", () => {
  const body = slice("async function checkCatalogDrift(opts) {", "  let rows;");
  assert.ok(body.includes('if (!watchdogEnabled("schemaBreakAlerts") && !opts.force)'),
    "the scheduled check must stop, not just the alert");
  assert.ok(body.includes('skipped: "schemaBreakAlerts is switched off"'),
    "and it must say why, so the panel can explain itself");
});

test("the param-type check stops when switched off", () => {
  const body = slice("async function checkCardParamTypes(opts) {", "  const entries =");
  assert.ok(body.includes('if (!watchdogEnabled("paramDriftAlerts") && !opts.force)'));
  assert.ok(body.includes('skipped: "paramDriftAlerts is switched off"'));
});

test("report-down records the failure but does not announce it when switched off", () => {
  // Deliberately NOT the same as inactive: the report really is broken and the
  // panel should still say so. Only the announcement is suppressed.
  const body = slice('    if (entry.status === "error") {', "    existing.reports[storeSlug][rt] = entry;");
  assert.ok(body.includes('const alertable = active && watchdogEnabled("reportDownAlerts")'),
    "the switch must gate the alert, alongside the activity check");
  assert.ok(body.includes("if (!active) entry.inactive = true;"),
    "inactive is still tracked separately from the switch");
});

test("a manual run still works while a watchdog is muted", () => {
  // Being able to look without being paged is the point of opts.force here.
  for (const [fn, end] of [["async function checkCatalogDrift(opts) {", "  let rows;"],
                           ["async function checkCardParamTypes(opts) {", "  const entries ="]]) {
    assert.ok(slice(fn, end).includes("&& !opts.force"), fn);
  }
});

// ── the admin surface ───────────────────────────────────────────────────────

test("the flags POST rejects an unknown key instead of writing a dead flag", () => {
  const body = slice('app.post("/api/admin/flags"', "// ── POST /api/admin/restart");
  assert.ok(body.includes("hasOwnProperty.call(DEFAULT_FLAGS, key)"),
    "an unknown key used to succeed and write a flag nothing reads");
  assert.ok(body.includes("Unknown flag"), "and it should say so");
});

test("every switchable flag has a toggle, a label and a status line", () => {
  for (const [id, key] of [["schemabreak", "schemaBreakAlerts"],
                           ["paramdrift", "paramDriftAlerts"],
                           ["reportdown", "reportDownAlerts"]]) {
    assert.ok(src.includes(`id="flag-${id}"`), `${id} needs a checkbox`);
    assert.ok(src.includes(`toggleFlag('${key}',this.checked)`), `${id} must post ${key}`);
    assert.ok(src.includes(`id="flag-${id}-track"`) && src.includes(`id="flag-${id}-thumb"`),
      `${id} needs the same switch markup as the existing flags`);
    assert.ok(src.includes(`id="flag-${id}-status"`), `${id} needs a status line`);
    assert.ok(new RegExp(`\\b${id}: \\['`).test(src), `${id} needs on/off status text`);
  }
});

test("the toggles are wired into one place, so none can be missed on refresh", () => {
  const apply = slice("    function applyFlags(flags) {", "    function updateFlagUI");
  for (const k of ["emailSubscriptions", "cachingEnabled", "maintenanceMode",
                   "schemaBreakAlerts", "paramDriftAlerts", "reportDownAlerts"]) {
    assert.ok(apply.includes(k), `applyFlags must refresh ${k}`);
  }
  assert.ok(src.includes("if (j.ok) { applyFlags(j.flags); }"),
    "a successful toggle must re-render every switch from the server's answer");
});

test("switching a watchdog OFF warns what stops being noticed", () => {
  assert.ok(src.includes("var WATCHDOG_FLAGS = {"), "needs the confirm copy");
  assert.ok(/if \(WATCHDOG_FLAGS\[key\] && !value &&/.test(src),
    "the confirm fires on OFF, not ON — turning a watchdog back on needs no warning");
  for (const k of ["schemaBreakAlerts", "paramDriftAlerts", "reportDownAlerts"]) {
    assert.ok(new RegExp(`${k}: '`).test(src), `${k} needs its own consequence line`);
  }
});

// ── the mute itself is announced ────────────────────────────────────────────

test("toggling a watchdog posts to Slack, and OFF is the loud one", () => {
  assert.ok(/SLACK_NOTIFY = new Set\(\[[^\]]*"watchdog"/.test(src), "watchdog must be in SLACK_NOTIFY");
  assert.ok(src.includes("watchdog: { emoji:"), "needs event meta");
  assert.ok(src.includes('rec.event === "watchdog"'), "needs a message branch");
  const branch = slice('  } else if (rec.event === "watchdog") {', '  } else if (rec.event === "param-drift")');
  assert.ok(branch.includes("rec.on ?"), "ON and OFF must read differently");
  assert.ok(branch.includes("rec.consequence"), "the OFF notice must say what stops being noticed");
  assert.ok(branch.includes("const mention = rec.on ? \"\"") , "only OFF @-mentions");
});

test("the mute notice cannot be muted by the switch it is reporting", () => {
  // The trap: if `watchdog` were gated like the alerts, switching schema drift
  // off would also suppress the notice saying so.
  const f = build({ schemaBreakAlerts: false, paramDriftAlerts: false, reportDownAlerts: false });
  assert.strictEqual(f.alertEnabled("watchdog"), true);
  assert.ok(!("watchdog" in f.ALERT_FLAG_BY_EVENT));
});

test("each watchdog has label and consequence copy in one place", () => {
  const meta = slice("const WATCHDOG_FLAG_META = {", "};");
  for (const k of ["schemaBreakAlerts", "paramDriftAlerts", "reportDownAlerts"]) {
    assert.ok(meta.includes(k), `${k} needs Slack copy`);
  }
  assert.ok(meta.includes("label:") && meta.includes("consequence:"));
  const post = slice('app.post("/api/admin/flags"', "// ── POST /api/admin/restart");
  assert.ok(post.includes("WATCHDOG_FLAG_META[key]"), "the POST must fire the event for watchdog flags only");
  assert.ok(post.includes('logEvent("_platform", "watchdog", "watchdog"'), "and log it like the other platform events");
});

test("the state is readable from the API, so 'why didn't it fire' is answerable", () => {
  assert.ok(src.includes('enabled: watchdogEnabled("schemaBreakAlerts")'));
  assert.ok(src.includes('enabled: watchdogEnabled("paramDriftAlerts")'));
  assert.ok(src.includes('reportDownAlerts: watchdogEnabled("reportDownAlerts")'));
});

console.log(`\n${passed}/${passed} passing`);
