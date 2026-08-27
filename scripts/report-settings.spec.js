// Spec for per-org report settings.
//
// THE ASK (Dan, 2026-08-27): "we could also add some type of report settings,
// where you could customize some report defaults that applied per org. Select
// columns, etc." Then, settling the design questions: "since it's single tenant,
// anyone can edit the settings. we'll figure out a multi tenant thing later. Per
// org. One report for now, we'll do the class roster."
//
// WHAT THIS PINS, and why each one fails silently otherwise:
//
//  1. A SETTING SEEDS, IT DOES NOT OVERRIDE. Platform default → the org's
//     setting → this person's own choice, in that order. An org default that
//     overrode localStorage would take a reader's chosen columns away, and the
//     first ticket would be "my settings keep resetting". It is the same line
//     that kept columns out of saved views.
//  2. THE TWO CACHE-KEY BUILDERS MUST AGREE. They did not, and the drift was
//     total: the data route built `org:report:v1:?parameters=…` while pre-warm
//     wrote `org:report:?parameters=…`, so nothing pre-warm produced could be
//     read back. Proven by construction — the two template literals cannot
//     produce the same string — which is why this spec compares the builders
//     rather than timing a request.
//  3. VALIDATION IS AN ALLOWLIST WITH A FLOOR. A settings PUT that silently
//     dropped a field would look like a working control and not be one, so the
//     route names what it refused; and a cache lifetime below the floor is
//     clamped, because at that point it stops being a preference and starts
//     spending everyone's Metabase budget on a card every org shares.
//  4. THE VERIFIED ePACT TEMPLATE IS KNOWN, AND DEVIATION IS NEVER SILENT.
//
// Run: node scripts/report-settings.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const PAGE = fs.readFileSync(path.join(ROOT, "public", "roster.html"), "utf8");

let n = 0;
const ok = (c, w) => { n++; assert.ok(c, w); };
const is = (a, b, w) => { n++; assert.deepStrictEqual(a, b, w); };

// ── 1. ONE cache-key builder, used by both callers ──────────────────────────
// This is the bug the whole freshness group rests on. Compare the SHIPPING
// function against the shipping call sites rather than restating the format.
{
  const from = SERVER.indexOf("function feedCacheKey(");
  ok(from > 0, "server.js should declare feedCacheKey()");
  const feedCacheKey = new Function(
    'const FEED_VERSION = { "court-utilization": 2 };\n'
    + SERVER.slice(from, SERVER.indexOf("\n}", from) + 2)
    + "\nreturn feedCacheKey;")();

  is(feedCacheKey("apex", "roster", "?p=1"), "apex:roster:v1:?p=1",
     "the key carries the feed version — that segment is what busts the cache when a card gains a column");
  is(feedCacheKey("apex", "court-utilization", ""), "apex:court-utilization:v2:",
     "and it reads the version per report");

  // The data route and pre-warm must BOTH go through it.
  is((SERVER.match(/const cacheKey = feedCacheKey\(orgSlug, reportType, paramStr\);/g) || []).length, 1,
     "the data route must build its key with feedCacheKey");
  ok(/setCache\(feedCacheKey\(slug, rt, paramStr\), result, rt\)/.test(SERVER),
     "pre-warm's param'd key must go through feedCacheKey — it did not, and every entry it wrote was unreachable");
  ok(/setCache\(feedCacheKey\(slug, rt, monthKeyWithOrg\), result, rt\)/.test(SERVER),
     "…and so must its this-month key");
  ok(!/setCache\(`\$\{slug\}:\$\{rt\}:\$\{paramStr\}`/.test(SERVER),
     "no caller may hand-build a feed key any more — that is exactly how the two drifted apart");
  is((SERVER.match(/`\$\{orgSlug\}:\$\{reportType\}:v\$\{FEED_VERSION/g) || []).length, 1,
     "the versioned format may appear exactly ONCE — inside feedCacheKey. A second copy is how "
     + "the route and pre-warm drifted apart in the first place");
}

// ── 2. The registry and its validator, lifted and RUN ────────────────────────
function loadRegistry() {
  const from = SERVER.indexOf("const REPORT_SETTINGS_FILE = ");
  const to = SERVER.indexOf("function reportTtlMs(");
  assert.ok(from > 0 && to > from, "server.js should still declare the report-settings registry");
  // readJSON/path/DATA_DIR are only needed by the store readers, which these
  // tests do not touch — stub them so the pure half can be executed.
  return new Function("path", "DATA_DIR", "readJSON", "writeJSON",
    SERVER.slice(from, to)
    + "\nreturn { REPORT_SETTINGS_SCHEMA, reportSettingsDefaults, normalizeReportSettings,"
    + " epactIsVerified, EPACT_VERIFIED_COLUMNS, EPACT_FIELD_CATALOGUE, ROSTER_COL_DEFAULTS,"
    + " ROSTER_HIDEABLE, REPORT_TTL_FLOOR_MIN, reportSettingsEnabled };")(
      { join: (...a) => a.join("/") }, "/tmp", () => ({}), () => {});
}
const R = loadRegistry();

is(Object.keys(R.REPORT_SETTINGS_SCHEMA), ["roster"],
   "one report for now — every other report 404s until someone asks for it, the SAVED_VIEW_PARAMS pattern");
ok(R.reportSettingsEnabled("roster") && !R.reportSettingsEnabled("gl"),
   "and the gate reads the registry rather than a second list");

// ── 3. Defaults are the values the page ships ────────────────────────────────
{
  const d = R.reportSettingsDefaults("roster");
  is(d.defaultDays, 14, "the default window is the platform's 14 days");
  is(d.defaultStatus, "all", "and no status filter");
  is(d.cacheTtlMin, 120, "and the roster's shipping 2-hour cache");
  is(d.warmDefaultWindow, false,
     "pre-warming the default window is OFF by default: it adds a Metabase query per org per day, "
     + "and a load increase should be switched on and measured, not slipped in");
  is(d.epactColumns, R.EPACT_VERIFIED_COLUMNS,
     "and the ePACT columns are the verified five — every org gets Apex's template until someone changes it");

  // The column defaults must equal the page's, or a fresh org sees one set and
  // the panel claims another.
  const m = /const COL_DEFAULTS = \{([\s\S]*?)\n\};/.exec(PAGE);
  ok(m, "roster.html should declare COL_DEFAULTS");
  const pageCols = new Function("return {" + m[1] + "};")();
  is(d.cols, pageCols,
     "the server's column defaults must equal the page's COL_DEFAULTS exactly — two lists for one "
     + "set of columns drift the first time one is edited");
}

// ── 4. Validation: clamp, refuse, and SAY what was refused ───────────────────
{
  const v = (body) => R.normalizeReportSettings("roster", body);

  is(v({ cacheTtlMin: 5 }).settings.cacheTtlMin, R.REPORT_TTL_FLOOR_MIN,
     "a cache lifetime under the floor is CLAMPED, not refused — a dial that snaps teaches the limit "
     + "where an error just loses the edit");
  is(v({ cacheTtlMin: 99999 }).settings.cacheTtlMin, 24 * 60, "and the ceiling holds too");
  is(R.REPORT_TTL_FLOOR_MIN, 30,
     "the floor is 30 minutes — the roster runs on a card EVERY org shares, so one org at 5 minutes "
     + "spends everyone's Metabase budget");

  const bad = v({ defaultStatus: "nonsense", nope: 1, autoRun: "yes" });
  is(bad.settings.defaultStatus, undefined, "an unknown enum value is not stored");
  ok(bad.dropped.some(d => /defaultStatus/.test(d)), "…and the caller is told which field, and why");
  ok(bad.dropped.some(d => /nope \(unknown\)/.test(d)), "an unregistered key is named, not silently ignored");
  ok(bad.dropped.some(d => /autoRun \(not a boolean\)/.test(d)), "and so is a wrong type");

  is(v({ epactColumns: ["Rec ID", "Rec ID", "Age"] }).settings.epactColumns, ["Rec ID", "Age"],
     "a duplicated column is collapsed — ePACT maps on position, so two identical headers is a broken file");
  is(v({ epactColumns: ["Rec ID", "Not A Column"] }).settings.epactColumns, ["Rec ID"],
     "and a column outside the catalogue is dropped rather than exported empty");
  is(v({ epactColumns: [] }).settings.epactColumns, undefined,
     "an empty column set is refused outright — a header-only CSV is not an export");

  // Flags merge onto the defaults, so a partial patch cannot blank the rest.
  const cols = v({ cols: { recId: true } }).settings.cols;
  is(cols.recId, true, "a flag patch applies");
  is(cols.age, true, "…and leaves the other eleven at their defaults rather than dropping them");
}

// ── 4b. Which controls an org may remove ─────────────────────────────────────
{
  is(R.ROSTER_HIDEABLE, ["questions", "views", "pdf", "print", "excel", "epact"],
     "saved views, both exports, print and the PDF are all removable — Dan's list");
  ok(!R.ROSTER_HIDEABLE.includes("email"),
     "email subscriptions are NOT offered on the roster: it is not in EMAIL_SUBSCRIBABLE_REPORTS, "
     + "so there is no subscribe control to remove, and a switch over a control that does not "
     + "exist is the same dead end as a greyed button");
  ok(/const EMAIL_SUBSCRIBABLE_REPORTS = new Set\(\["facility", "gl"\]\)/.test(SERVER),
     "…and that is why — if the roster ever joins that set, the toggle belongs here");

  // Every hideable key must have a label, or the panel renders a raw key.
  const m = /const HIDE_LABELS = \{([\s\S]*?)\n\};/.exec(PAGE);
  ok(m, "roster.html should declare HIDE_LABELS");
  const labels = new Function("return {" + m[1] + "};")();
  R.ROSTER_HIDEABLE.forEach(k =>
    ok(labels[k], "\"" + k + "\" is removable but has no label — the panel would show the raw key"));

  // …and every one must actually gate something on the page.
  R.ROSTER_HIDEABLE.forEach(k =>
    ok(new RegExp("rsShown\\('" + k + "'\\)").test(PAGE),
       "\"" + k + "\" is offered as removable but nothing on the page reads it — a switch that "
       + "controls nothing looks like a working control and is not one"));
}

// ── 4c. A wide default window warns rather than being refused ────────────────
{
  is(R.REPORT_SETTINGS_SCHEMA.roster.defaultDays.warnAbove, 30,
     "over ~30 days the roster gets heavy — a calendar month at apex was ~382 pages / 12,130 rows");
  is(R.normalizeReportSettings("roster", { defaultDays: 90 }).settings.defaultDays, 90,
     "…but it is a WARNING, not a limit: an org running year-round programmes may want a quarter");
  ok(/data-rs-wide/.test(PAGE), "and the panel has to say so on screen");
  ok(/const ROSTER_WIDE_WINDOW_DAYS = 30;/.test(PAGE),
     "the threshold is named once in the page rather than typed into the copy");
}

// ── 5. The ePACT catalogue excludes SESSION-grain fields ─────────────────────
{
  const offered = R.EPACT_FIELD_CATALOGUE.map(c => c[0]);
  ok(!offered.includes("Session Start") && !offered.includes("Session End"),
     "no SESSION-grain field may be offered: the export reproduces her SELECT DISTINCT over the "
     + "chosen columns, so adding one would stop the dedupe collapsing two same-day sessions and "
     + "upload the same camper twice");
  R.EPACT_VERIFIED_COLUMNS.forEach(c =>
    ok(offered.includes(c), "the verified column \"" + c + "\" must be in the catalogue"));

  ok(R.epactIsVerified(R.EPACT_VERIFIED_COLUMNS), "the verified set reads as verified");
  ok(!R.epactIsVerified(R.EPACT_VERIFIED_COLUMNS.slice().reverse()),
     "the same columns in a different ORDER are not the verified template — ePACT maps on position");
  ok(!R.epactIsVerified(R.EPACT_VERIFIED_COLUMNS.concat(["Age"])), "and neither is a superset");
}

// ── 6. The page: seed, don't override ────────────────────────────────────────
ok(/\{ \.\.\.COL_DEFAULTS, \.\.\.orgColDefaults\(\), \.\.\.JSON\.parse\(localStorage/.test(PAGE),
   "column precedence must read platform → org → person. Reversing the last two would let an "
   + "org default reach in and reset a reader's own toggles");
ok(/const ROSTER_DEFAULT_DAYS = 14;/.test(PAGE),
   "the PLATFORM constant stays: the server's next14 range is pinned to it, so a saved view named "
   + "\"Next 14 days\" and the report's own default cannot drift apart");
ok(/function getDefaultRange\(today, days\)/.test(PAGE),
   "…and an org's window arrives as an argument rather than by editing that constant");
ok(/data-rs-open/.test(PAGE) && /className="btn-settings"/.test(PAGE),
   "the gear needs a stable hook for the render check to drive");

// ── 7. Slack ─────────────────────────────────────────────────────────────────
ok(/"settings-save", "settings-reset"/.test(SERVER),
   "a settings change alters what every reader of that report sees, so it belongs in SLACK_NOTIFY");
ok(/rec\.event === "settings-save"/.test(SERVER),
   "…with its own message branch: the shared one would name the report and never what changed");
ok(/ePACT columns no longer the verified set/.test(SERVER),
   "and the message must call out an ePACT template that left the verified set");

// ── 8. Live: the real routes, against a real store ───────────────────────────
(async () => {
  const PORT = 3996;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-rsettings-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: "http://127.0.0.1:9",
      RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const { org, token } = (() => {
    const i = SERVER.indexOf("const ORGS = {");
    const j = SERVER.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = vm.runInNewContext("(" + SERVER.slice(SERVER.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    const slug = Object.keys(ORGS).find(k => ORGS[k] && ORGS[k].token);
    return { org: slug, token: ORGS[slug].token };
  })();

  const call = (method, p, body) => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 20000,
      headers: body ? { "Content-Type": "application/json" } : {} },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => {
        let j = null; try { j = JSON.parse(b); } catch {}
        res({ status: r.statusCode, body: b, json: j });
      }); });
    req.on("error", rej);
    req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const S = `/${org}/roster/api/settings?token=${encodeURIComponent(token)}`;

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("server did not boot\n" + log.slice(-600)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });

    let r = await call("GET", S);
    is(r.status, 200, "the settings route answers: " + r.body.slice(0, 120));
    is(r.json.settings.defaultDays, 14, "an org with no stored record reads the platform defaults");
    is(r.json.epactVerified, true, "…and its ePACT template is the verified one");

    r = await call("PUT", S, { defaultDays: 21, cacheTtlMin: 5, hide: { excel: true } });
    is(r.status, 200, r.body.slice(0, 160));
    is(r.json.settings.defaultDays, 21, "a saved window comes back");
    is(r.json.settings.cacheTtlMin, 30, "and a sub-floor cache lifetime is clamped on the way in");
    is(r.json.settings.hide.excel, true, "and a hidden control is stored");

    r = await call("GET", S);
    is(r.json.settings.defaultDays, 21, "the record persists across requests");
    is(r.json.settings.defaultStatus, "all",
       "…and a field the patch never mentioned still reads its default rather than undefined");

    // THE PAGE MUST SEE IT. Injected into ORG_CONFIG, not fetched, because the
    // settings decide the first render.
    const page = await call("GET", `/${org}/roster?token=${encodeURIComponent(token)}`);
    is(page.status, 200, "the roster page still serves");
    const cfg = /window\.ORG_CONFIG=(\{.*?\});<\/script>/.exec(page.body);
    ok(cfg, "the roster page should carry an injected ORG_CONFIG");
    const parsed = JSON.parse(cfg[1]);
    is(parsed.settings.defaultDays, 21,
       "the saved setting is injected into the page — a page that fetched them would flash the "
       + "platform defaults first");
    ok(Array.isArray(parsed.settingsMeta.epactCatalogue) && parsed.settingsMeta.epactCatalogue.length > 5,
       "and the catalogue travels with it so the panel cannot invent its own column list");

    r = await call("PUT", S, { reset: true });
    is(r.json.settings.defaultDays, 14, "reset returns to the platform defaults");
    r = await call("GET", S);
    is(r.json.settings.defaultDays, 14,
       "…by DROPPING the org's record rather than writing the defaults into it, so a later change "
       + "to a platform default still reaches an org that reset");

    r = await call("GET", `/${org}/gl/api/settings?token=${encodeURIComponent(token)}`);
    is(r.status, 404, "an unregistered report 404s rather than accepting settings nothing reads");

    r = await call("PUT", `/${org}/roster/api/settings?token=nope`, { defaultDays: 30 });
    ok(r.status === 404 || r.status === 403,
       "a bad token is refused. 404 rather than 403 is CORRECT here and worth knowing: the global "
       + "org-token middleware answers first and deliberately does not leak whether the org exists, "
       + "so the in-handler token check is a backstop for the day that exemption list grows");
    r = await call("GET", S);
    is(r.json.settings.defaultDays, 14, "…and the refused write changed nothing");

    const events = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
      .trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return {}; } });
    ok(events.some(e => e.event === "settings-save"), "a save reaches events.jsonl");
    ok(events.some(e => e.event === "settings-reset"), "and so does a reset");

    console.log("✓ report-settings.spec.js — " + n + " assertions");
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
