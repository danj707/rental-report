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
// A regex over our own patch is not evidence the server behaves. SKIP_SOURCE=1
// takes the source assertions out so the LIVE half can be shown to catch a
// regression on its own — the campmap-pin-persistence pattern.
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";
const src = (c, w) => { if (SKIP_SOURCE) return; n++; assert.ok(c, w); };
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

// ── 4d. The shared-card budget ───────────────────────────────────────────────
// A per-org floor bounds ONE org; the card is spent by all of them. Dan: "can't
// have one org going rogue and borking it for everyone."
{
  const from = SERVER.indexOf("function sharedCardLoad(");
  ok(from > 0, "server.js should declare sharedCardLoad()");
  ok(/const REPORT_BUDGET_MULTIPLE = \d+;/.test(SERVER),
     "the budget is a MULTIPLE of the all-defaults baseline, not a fixed number — written that way "
     + "so it cannot go stale as orgs are onboarded");
  ok(/if \(settings\.cacheTtlMin != null && resolveReportCard\(org, report\)\.shared\)/.test(SERVER),
     "the budget check runs on a SHARED card only — an org with its own card spends nobody else's time");
  ok(/next\.total > next\.budget && next\.total > now\.total/.test(SERVER),
     "…and only refuses a change that makes it WORSE: an org already over budget must still be able "
     + "to lengthen its cache back toward the default");
  ok(/Already running short: /.test(SERVER),
     "a refusal names who is already heavy — the org dragging the slider is not necessarily the one "
     + "that filled the budget");

  // The panel's platform figure must be a SUM over what each org chose, not this
  // org's rate multiplied by the org count. The multiplication was shipped in the
  // mockup and read as though one org set the rate for everyone.
  ok(/const platform = card \? card\.othersTotal \+ perDay : null;/.test(PAGE),
     "the platform figure is this org's drafted rate ADDED to what the others actually chose");
  ok(!/perDay \* orgs/.test(PAGE),
     "…and never this org's rate multiplied by the org count — that number is simply false");
  ok(/data-rs-overbudget/.test(PAGE),
     "and going over budget has to be visible before Save, not only in the error that refuses it");
}

// ── 4e. Two gates, and the panel is behind both ──────────────────────────────
{
  ok(/reportSettings: false,/.test(SERVER),
     "the feature flag defaults OFF — Dan: 'this power is too much for an org user to handle'");
  ok(/function isReportSettingsAdmin\(req\)/.test(SERVER),
     "…and the flag is only half of it: there is a super-admin check as well");
  ok(/return !!getFlags\(\)\.reportSettings && reportSettingsKeyOk\(req\);/.test(SERVER),
     "the admin check is flag AND key, so turning the flag off closes the surface for everyone");
  ok(/if \(!DASHBOARD_PASSWORD\) return "";/.test(SERVER),
     "NO PASSWORD MEANS NO KEY — it fails closed. dashboardAuth opens the root page when no password "
     + "is set; a control that spends a shared resource must do the opposite");
  ok(/crypto\.timingSafeEqual/.test(SERVER), "the key is compared in constant time");
  ok(/DASHBOARD_PASSWORD \+ "\|report-settings\|v1"/.test(SERVER),
     "the key is DERIVED from the password rather than being it, so a URL carrying it cannot open "
     + "the admin dashboard, and rotating the password rotates the key");
  ok(/if \(!isReportSettingsAdmin\(req\)\) return refuse404\(res\);/.test(SERVER),
     "the routes 404 rather than 403 — an org staffer with a valid token should not learn the "
     + "surface exists. Through refuse404 so the dead-link watch does not then announce the path "
     + "in Slack");
  is((SERVER.match(/if \(!isReportSettingsAdmin\(req\)\) return refuse404\(res\);/g) || []).length, 2,
     "…on BOTH the read and the write");

  ok(/\{rsIsAdmin\(\) && \(/.test(PAGE),
     "the page renders the gear for a super-admin only");
  ok(/adminKey: settingsAdmin \? String\(req\.query\.admin \|\| ""\) : "",/.test(SERVER),
     "…and the key is echoed back to the page only when the request already proved admin. It stays "
     + "empty for a cookie session, which needs no echo — the cookie rides the page's own fetches");
}

// ── 4ef. Signing in to the dashboard is what carries you to the report ───────
// Dan, on the preview: "the settings should show if I login as a super admin,
// then navigate to the org page and reports, no? Not seeing it." Right — and
// nothing carried the credential. Basic auth is scoped to "/" by the browser, so
// the only way in was pasting &admin=<key> onto every report URL by hand.
{
  src(/function setReportSettingsCookie\(req, res\)/.test(SERVER),
     "a successful dashboard sign-in has to leave something behind, or navigating to a report "
     + "starts from nothing");
  src(/if \(password === DASHBOARD_PASSWORD\) \{[\s\S]{0,900}?setReportSettingsCookie\(req, res\);/.test(SERVER),
     "…and it is set on the PASSWORD MATCH inside dashboardAuth, not on every request to /");
  src(/const key = reportSettingsAdminKey\(\);\n\s*if \(!key\) return;/.test(SERVER),
     "THE COOKIE CARRIES THE DERIVED KEY, NEVER THE PASSWORD — if it leaks it opens the settings "
     + "panel and nothing else, and rotating the password rotates it. No password, no cookie: "
     + "the same fail-closed direction as the key itself");
  const setter = /function setReportSettingsCookie\(req, res\) \{[\s\S]*?\n\}/.exec(SERVER)[0];
  src(/HttpOnly/.test(setter),
     "HttpOnly — no page ever reads it, the server injects settingsAdmin into ORG_CONFIG");
  src(/SameSite=Lax/.test(setter),
     "SameSite=Lax is the CSRF defence: it rides a normal click through from the dashboard but is "
     + "not sent on a cross-site PUT to the settings route");
  src(/https \? '; Secure' : ''/.test(setter),
     "Secure over https only, or the cookie is dropped on http://localhost and the gear silently "
     + "never appears in dev");
  src(/readCookie\(req, RS_ADMIN_COOKIE\)/.test(SERVER),
     "and the admin check has to actually read it");

  // The three ways in are one credential — the query parameter and the header
  // stay for a handed-over link and for this spec, which drives the routes
  // without a browser.
  const gate = /function reportSettingsKeyOk\(req\) \{[\s\S]*?\n\}/.exec(SERVER)[0];
  src(/req\.query && req\.query\.admin/.test(gate) && /x-admin-key/.test(gate),
     "the URL key and the header still work — a link someone was handed must not stop working");
  src(/reportSettingsKeyMatches/.test(gate) && /crypto\.timingSafeEqual/.test(SERVER),
     "…and every one of them goes through the same constant-time compare");

  // A PROVEN admin with the flag off is a different state from an org staffer,
  // and rendering both as "no gear" is exactly what made this look broken.
  src(/function reportSettingsFlagOff\(req\) \{\n\s*return !getFlags\(\)\.reportSettings && reportSettingsKeyOk\(req\);/.test(SERVER),
     "settingsFlagOff is gated on the KEY, so it can never appear for a staffer holding the org "
     + "token — otherwise it would advertise the surface the 404s exist to hide");
  src(/\{!rsIsAdmin\(\) && rsFlagOff\(\) && \(/.test(PAGE),
     "the page renders a disabled gear in that state — absent-not-greyed is the right rule for "
     + "someone who may never have the control, but for someone holding the key it is a dead end "
     + "with no exit");
  const offBtn = /\{!rsIsAdmin\(\) && rsFlagOff\(\) && \([\s\S]*?\)\}/.exec(PAGE)[0];
  src(/disabled/.test(offBtn) && /Feature Flags/.test(offBtn),
     "…and it says where the switch is, or it is one more control that does not explain itself");
}

// ── 4eg. A refusal is not a dead link, and opening the panel is a ping ───────
{
  src(/function refuse404\(res, body\) \{\n\s*res\.locals\.deliberate404 = true;/.test(SERVER),
     "a deliberate 404 has to be able to SAY so — noteDeadLink keys on 'a 404 that arrived with a "
     + "valid-looking token', which is exactly the shape of every refusal here");
  src(/if \(res\.locals && res\.locals\.deliberate404\) return;/.test(SERVER),
     "…and the dead-link watch has to honour the marker, or every refused request posts a DEAD LINK "
     + "alert naming the very path the 404 exists to keep quiet");
  // SCOPED to the settings routes. A global count breaks the moment another route
  // adopts refuse404() — which is what happened when the report wizard was
  // disabled, and an assertion that fails on a non-regression is a false alarm
  // waiting to happen.
  const settingsRoutes = SERVER.split(/app\.(?:get|put)\("\/:org\/:report\/api\/settings"/).slice(1)
    .map(chunk => chunk.slice(0, 1200)).join("\n");
  is((settingsRoutes.match(/return refuse404\(res/g) || []).length, 4,
     "both settings routes refuse through it, on both the admin gate and the unregistered report");

  src(/"epact", "settings-open", "settings-save"/.test(SERVER),
     "opening the panel posts to Slack — the standing rule is that a new surface ships with its "
     + "activity ping, and a LOOK is the earlier signal than a change");
  // Membership, not position: this pinned `"settings-open"]` — the END of the
  // ALLOWED array — so appending any later event broke it without anything
  // about settings-open changing. What it is protecting is that the event is on
  // the list at all; a beacon whose event is missing 400s silently.
  src(/const ALLOWED = \[[^\]]*"settings-open"[^\]]*\]/.test(SERVER),
     "…and the event has to be on the log route's ALLOWED list or the beacon 400s silently");
  src(/"settings-open":\s*\{ emoji/.test(SERVER), "and it needs a message meta entry");
  src(/logClientEvent\('settings-open', \{ custom: rsCustomised\(\) \? 1 : 0 \}\)/.test(PAGE),
     "the beacon carries whether this org is already off the platform defaults — browsing and "
     + "revisiting are different signals");
  src(/function rsCustomised\(\)[\s\S]*?JSON\.stringify\(cur\[k\]\) !== JSON\.stringify\(def\[k\]\)/.test(PAGE),
     "…compared field by field, not by 'is there a stored record' — a record holding nothing but "
     + "defaults is not a customised org");
}

// ── 4f. The flag has a switch a human can reach ──────────────────────────────
// A flag with no toggle is a flag nobody flips — Dan would have had to POST to
// /api/admin/flags by hand to use the feature he asked for.
{
  ok(/id="flag-reportsettings" onchange="toggleFlag\('reportSettings',this\.checked\)"/.test(SERVER),
     "the Feature Flags block needs a switch for reportSettings; the block is hand-written per "
     + "toggle, so a new flag does NOT appear on its own");
  ok(/updateFlagUI\('reportsettings', flags\.reportSettings\)/.test(SERVER),
     "…and applyFlags has to drive it, or the switch renders permanently off");
  ok(/reportsettings: \['ON —/.test(SERVER), "and it needs status copy like every other flag");
  // The admin dashboard is one giant template literal: a stray apostrophe in
  // emitted JS collapses on the way out and discards the whole script block,
  // which has happened before (PR #137). ci-check-admin-js.js is the real guard;
  // this just keeps the new copy out of the danger.
  const block = /reportsettings: \[([^\]]*)\]/.exec(SERVER);
  ok(block && !/\\'/.test(block[1]),
     "no escaped apostrophes in the new status copy — inside this literal that needs \\\\' and the "
     + "next person to edit the line would have to re-derive why");
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
      // A password is REQUIRED now: no DASHBOARD_PASSWORD means no super-admin
      // key, which means nobody can open the panel. That is the fail-closed
      // direction, and this spec proves it below.
      RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "spec-password" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  // TWO orgs, because "per org" is the guarantee this whole feature rests on and
  // it was not pinned by anything.
  const { org, token, org2, token2 } = (() => {
    const i = SERVER.indexOf("const ORGS = {");
    const j = SERVER.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = vm.runInNewContext("(" + SERVER.slice(SERVER.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    const slugs = Object.keys(ORGS).filter(k => ORGS[k] && ORGS[k].token);
    return { org: slugs[0], token: ORGS[slugs[0]].token,
             org2: slugs[1], token2: ORGS[slugs[1]].token };
  })();

  const call = (method, p, body, extraHeaders) => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 20000,
      headers: Object.assign({}, body ? { "Content-Type": "application/json" } : {}, extraHeaders || {}) },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => {
        let j = null; try { j = JSON.parse(b); } catch {}
        res({ status: r.statusCode, body: b, json: j, headers: r.headers });
      }); });
    req.on("error", rej);
    req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const crypto = require("crypto");
  const ADMIN_KEY = crypto.createHash("sha256")
    .update("spec-password|report-settings|v1").digest("hex").slice(0, 32);
  const Sbare = `/${org}/roster/api/settings?token=${encodeURIComponent(token)}`;
  const S = `${Sbare}&admin=${ADMIN_KEY}`;

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("server did not boot\n" + log.slice(-600)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });

    // ── The two gates ────────────────────────────────────────────────────
    // The flag is OFF by default, so even the right key opens nothing.
    let r = await call("GET", S);
    is(r.status, 404,
       "with the reportSettings flag OFF the route 404s even for a super-admin — the flag is the "
       + "first gate, and 404 rather than 403 so the surface is not advertised");

    r = await call("POST", "/api/admin/flags",
                   { password: "spec-password", key: "reportSettings", value: true });
    is(r.status, 200, "the flag flips through the existing admin switch: " + r.body.slice(0, 120));

    r = await call("GET", Sbare);
    is(r.status, 404,
       "a valid ORG TOKEN is not enough: every staffer at the org has it, and these settings change "
       + "what all of them see plus what the shared card costs");

    r = await call("GET", `${Sbare}&admin=wrongkeywrongkeywrongkeywrongke`);
    is(r.status, 404, "and a wrong key of the right length is refused too");

    r = await call("GET", `/api/admin/report-settings-key?password=spec-password`);
    is(r.status, 200, "the super-admin can look the key up, behind the password itself");
    is(r.json.key, ADMIN_KEY, "…and it is derived from DASHBOARD_PASSWORD, not equal to it");
    ok(r.json.key !== "spec-password",
       "a URL carrying this key must not hand over the admin dashboard");

    r = await call("GET", `/api/admin/report-settings-key?password=nope`);
    is(r.status, 403, "and looking it up needs the password");

    // ── Signing in, then navigating ──────────────────────────────────────
    // The whole point: no &admin= anywhere below this line.
    const basic = "Basic " + Buffer.from("admin:spec-password").toString("base64");
    let dash = await call("GET", "/", null, { Authorization: basic });
    is(dash.status, 200, "the dashboard accepts the password");
    const setCookie = [].concat(dash.headers["set-cookie"] || []).find(c => /^rs_admin=/.test(c));
    ok(setCookie, "signing in leaves a session behind — without it, navigating to a report starts "
       + "from nothing and the gear can only be reached by pasting a key onto the URL");
    ok(setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax") && setCookie.includes("Path=/"),
       "…HttpOnly, SameSite=Lax and site-wide, so it rides a click through to /:org/roster but not "
       + "a cross-site write");
    is(/^rs_admin=([^;]*)/.exec(setCookie)[1], ADMIN_KEY,
       "the cookie carries the DERIVED key, not the password");
    ok(!setCookie.includes("spec-password"), "the password itself never leaves in a cookie");

    const asAdmin = { Cookie: "rs_admin=" + ADMIN_KEY };
    r = await call("GET", Sbare, null, asAdmin);
    is(r.status, 200, "the cookie alone opens the settings route — signing in and navigating is the "
       + "flow, the URL key is the fallback");

    r = await call("GET", Sbare, null, { Cookie: "rs_admin=wrongkeywrongkeywrongkeywrongke" });
    is(r.status, 404, "…and a wrong cookie is refused like any other wrong key");

    let pg = await call("GET", `/${org}/roster?token=${encodeURIComponent(token)}`, null, asAdmin);
    let pcfg = JSON.parse(/window\.ORG_CONFIG=(\{.*?\});<\/script>/.exec(pg.body)[1]);
    is(pcfg.settingsAdmin, true,
       "and the ROSTER PAGE reached by navigation renders the gear — this is the bug Dan hit: he "
       + "signed in as super-admin, navigated to the report, and there was nothing there");

    pg = await call("GET", `/${org}/roster?token=${encodeURIComponent(token)}`);
    pcfg = JSON.parse(/window\.ORG_CONFIG=(\{.*?\});<\/script>/.exec(pg.body)[1]);
    is(pcfg.settingsAdmin, false, "a reader with only the org token still gets no gear");
    is(pcfg.settingsFlagOff, false,
       "…and is not told a switched-off surface exists either — that would advertise exactly what "
       + "the 404s hide");

    r = await call("GET", S);
    is(r.status, 200, "with the flag on AND the key, the settings route answers: " + r.body.slice(0, 120));
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

    r = await call("GET", `/${org}/gl/api/settings?token=${encodeURIComponent(token)}&admin=${ADMIN_KEY}`);
    is(r.status, 404, "an unregistered report 404s rather than accepting settings nothing reads");

    r = await call("PUT", `/${org}/roster/api/settings?token=nope&admin=${ADMIN_KEY}`, { defaultDays: 30 });
    ok(r.status === 404 || r.status === 403,
       "a bad token is refused. 404 rather than 403 is CORRECT here and worth knowing: the global "
       + "org-token middleware answers first and deliberately does not leak whether the org exists, "
       + "so the in-handler token check is a backstop for the day that exemption list grows");
    r = await call("GET", S);
    is(r.json.settings.defaultDays, 14, "…and the refused write changed nothing");

    // ── PER ORG, and proven by looking at a SECOND one ───────────────────
    // Everything above changed org A. A settings feature that leaked across orgs
    // would let one org's admin reshape every other org's report, and the store
    // being keyed by slug is not by itself evidence that every reader honours it.
    const S2 = `/${org2}/roster/api/settings?token=${encodeURIComponent(token2)}&admin=${ADMIN_KEY}`;
    r = await call("PUT", S, { defaultDays: 60, defaultStatus: "enrolled", autoRun: false,
                               cacheTtlMin: 30, showStamp: true, warmDefaultWindow: true,
                               hide: { views: true, excel: true },
                               epactColumns: ["Rec ID", "First Name"], epactLabel: "section",
                               epactBom: false });
    is(r.status, 200, "org A takes a full set of non-default settings");

    const b = (await call("GET", S2)).json.settings;
    const dflt = R.reportSettingsDefaults("roster");
    for (const k of Object.keys(dflt)) {
      is(JSON.stringify(b[k]), JSON.stringify(dflt[k]),
         `org B's "${k}" is untouched by org A's save — the settings are per ORG, and every reader `
         + `has to honour that, not just the store's shape`);
    }

    // And the PAGE, which is what a reader actually gets.
    let pgB = await call("GET", `/${org2}/roster?token=${encodeURIComponent(token2)}`);
    const cfgB = JSON.parse(/window\.ORG_CONFIG=(\{.*?\});<\/script>/.exec(pgB.body)[1]);
    is(cfgB.settings.defaultDays, dflt.defaultDays,
       "…including the injected ORG_CONFIG, which decides org B's first render");
    is(JSON.stringify(cfgB.settings.hide), "{}",
       "and a control org A removed is still on org B's toolbar");

    // An org nobody has touched has NO RECORD, which is why reset drops the
    // record rather than writing the defaults into it: a later change to a
    // platform default still has to reach every org that never customised.
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, "report-settings.json"), "utf8"));
    is(Object.keys(store), [org],
       "the store holds a record for the ONE org that was configured and nobody else");

    // The one thing that is deliberately NOT contained: the cache is shared, so
    // org A shortening its lifetime moves the platform total org B is priced
    // against. That is the whole reason the budget exists.
    const scB = (await call("GET", S2)).json.sharedCard;
    ok(scB && scB.total > scB.baseline,
       "org A's shorter cache DOES move the shared-card total — per-org settings, one shared card, "
       + "which is exactly what the budget is for");
    ok(scB.heaviest.some(h => h.org === org),
       "…and org B's panel names org A as the one running short, so the refusal is actionable by "
       + "whoever is looking at it");

    // ── The dead end that started this ───────────────────────────────────
    // Flag off, credential good: the surface is closed, and the page has to SAY
    // so rather than looking identical to "you are not an admin".
    r = await call("POST", "/api/admin/flags",
                   { password: "spec-password", key: "reportSettings", value: false });
    is(r.status, 200, "the flag flips back off");
    pg = await call("GET", `/${org}/roster?token=${encodeURIComponent(token)}`, null, asAdmin);
    pcfg = JSON.parse(/window\.ORG_CONFIG=(\{.*?\});<\/script>/.exec(pg.body)[1]);
    is(pcfg.settingsAdmin, false, "with the flag off even a proven super-admin gets no working gear");
    is(pcfg.settingsFlagOff, true,
       "…but IS told the feature is switched off and where the switch is. Signing in, navigating, "
       + "and finding nothing is indistinguishable from the feature not existing");
    r = await call("GET", Sbare, null, asAdmin);
    is(r.status, 404, "and the route stays closed — the notice is presentation, not a way in");

    // The notice must be gated on the KEY, not merely on the flag. Checked here
    // rather than above because with the flag ON both readers get false anyway,
    // so only this state can tell the two implementations apart.
    pg = await call("GET", `/${org}/roster?token=${encodeURIComponent(token)}`);
    pcfg = JSON.parse(/window\.ORG_CONFIG=(\{.*?\});<\/script>/.exec(pg.body)[1]);
    is(pcfg.settingsFlagOff, false,
       "a staffer with only the org token is NOT told a switched-off super-admin surface exists — "
       + "that would advertise exactly what the 404s are there to hide");

    // THE BEACON, DRIVEN FOR REAL. A fire-and-forget beacon never complains, and
    // a wrong event name or a report missing from REPORT_TYPES comes back 400/404
    // in silence — that trap has bitten this repo four times. A 200 alone is not
    // enough either: the row has to land.
    r = await call("POST", `/${org}/roster/api/log?event=settings-open&custom=1`
                           + `&token=${encodeURIComponent(token)}`);
    is(r.status, 200, "the settings-open beacon is accepted: " + r.body.slice(0, 120));

    // A REFUSAL MUST NOT LOOK LIKE A STALE LINK. Every 404 above arrived with a
    // valid org token, which is precisely what noteDeadLink() watches for.
    const evAll = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
      .trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return {}; } });
    const dead = evAll.filter(e => e.event === "deadlink" && /api\/settings/.test(String(e.path || "")));
    is(dead.length, 0,
       "a refused settings request must not post a DEAD LINK alert — the path is real and the "
       + "caller was told no, and the alert would name in Slack exactly what the 404 hides");

    const events = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
      .trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return {}; } });
    const opened = events.find(e => e.event === "settings-open");
    ok(opened, "…and reaches events.jsonl rather than being dropped");
    is(String(opened.custom), "1", "carrying whether the org is already off the platform defaults");
    ok(events.some(e => e.event === "settings-save"), "a save reaches events.jsonl");
    ok(events.some(e => e.event === "settings-reset"), "and so does a reset");

    console.log("✓ report-settings.spec.js — " + n + " assertions");
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
