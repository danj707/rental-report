#!/usr/bin/env node
/**
 * wizard-disabled.spec.js — the Report Wizard is off for every org.
 *
 * Dan: "we need to disable it for all orgs... they should not be able to see or
 * click it."
 *
 * SEE and CLICK are two different gates, and either alone is a half-measure:
 *
 *   * SEE  — report-wizard in RETIRED_REPORTS removes the card from the org
 *            dashboard and the admin portal.
 *   * CLICK — WIZARD_ENABLED_ORGS (empty) makes every wizard route 404. The
 *            comment on RETIRED_REPORTS says why hiding is not enough: it
 *            controls whether a report is SURFACED, not whether it works, and
 *            campmap served ~24 visitors a month through direct links the whole
 *            time it was listed there. Every wizard link already bookmarked or
 *            emailed still resolves.
 *
 * AND THE 404s MUST BE MARKED DELIBERATE. noteDeadLink() alerts on "a 404 that
 * arrived with a valid-looking token" — exactly the shape of every stale wizard
 * link from now on. Without refuse404 / res.locals.deliberate404, disabling the
 * feature posts one DEAD LINK alert per stale link, naming a path we turned off
 * on purpose. That is the settings-route false alarm, at scale.
 *
 * SKIP_SOURCE=1 drops the source assertions so the live half can be shown to
 * catch a regression on its own.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let n = 0;
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";
const src = (c, w) => { if (SKIP_SOURCE) return; n++; assert.ok(c, w); };
const ok = (c, w) => { n++; assert.ok(c, w); };
const is = (a, b, w) => { n++; assert.deepStrictEqual(a, b, w); };

// ── 1. They cannot SEE it ───────────────────────────────────────────────────
{
  const m = /const RETIRED_REPORTS = new Set\((\[[^\]]*\])\)/.exec(SERVER);
  ok(m && vm.runInThisContext(m[1]).includes("report-wizard"),
     "report-wizard is in RETIRED_REPORTS, which is what removes the card from the org dashboard "
     + "and the admin portal");
  src(/if \(!RETIRED_REPORTS\.has\('report-wizard'\)\) \{/.test(SERVER),
     "…and the admin portal's card is gated on that same Set, so it goes too");
  src(/wizardVisible: wizardEnabled\(slug\) && !RETIRED_REPORTS\.has\("report-wizard"\)/.test(SERVER),
     "the org page's card needs BOTH gates, or it draws a link to a 404");
}

// ── 2. They cannot CLICK it ─────────────────────────────────────────────────
{
  src(/const WIZARD_ENABLED_ORGS = new Set\(\n\s*\(process\.env\.WIZARD_ENABLED_ORGS \|\| ""\)/.test(SERVER),
     "the route gate is an allowlist that starts EMPTY — off for every org, and one slug re-enables "
     + "it for that org alone. Same shape as MUNIS_EXPORT_ORGS, which is how the Tyler export was "
     + "parked");
  src(/function wizardEnabled\(slug\) \{ return WIZARD_ENABLED_ORGS\.has\(slug\); \}/.test(SERVER),
     "…read through one helper, so a route added later cannot quietly skip the gate");

  for (const [marker, label] of [
    ['app.get("/:org/report-wizard"', "the page"],
    ['app.post("/:org/report-wizard/api/generate"', "generate"],
    ['app.post("/:org/report-wizard/api/feedback"', "feedback"],
    ['app.post("/:org/report-wizard/api/log"', "the activity beacon"],
  ]) {
    const i = SERVER.indexOf(marker);
    ok(i > 0, `${label} route exists`);
    src(/wizardEnabled\(slug\)/.test(SERVER.slice(i, i + 1600)),
       `${label} route has to check wizardEnabled — hiding the card does not stop a direct link, and `
       + `campmap proved people use those`);
  }
}

// ── 3. Disabling it must not page anyone ────────────────────────────────────
{
  const page = SERVER.slice(SERVER.indexOf('app.get("/:org/report-wizard"'));
  src(/res\.locals\.deliberate404 = true;\n\s*return res\.status\(404\)\.send\("The Report Wizard is not enabled/.test(page),
     "the PAGE marks its 404 deliberate — every stale /:org/report-wizard?token=… link is now 'a 404 "
     + "with a valid-looking token', which is precisely what noteDeadLink alerts on");
  const apiRefusals = (SERVER.match(/if \(!wizardEnabled\(slug\)\) return refuse404\(res, \{/g) || []).length;
  is(apiRefusals, 3, "and all three API routes refuse through refuse404(), which sets the same marker");
}

// ── 4. Nothing is deleted, so re-enabling is configuration ──────────────────
{
  ok(fs.existsSync(path.join(ROOT, "public", "report-wizard.html")),
     "the page file stays — off is not deleted, and this is what made un-retiring the wizard in "
     + "August a one-line change rather than a rebuild");
  for (const f of ["wizard-activity.spec.js", "wizard-narrative.spec.js"]) {
    ok(fs.existsSync(path.join(ROOT, "scripts", f)),
       `${f} stays and keeps running — a switched-off feature whose guards are deleted comes back `
       + `broken`);
  }
  ok(/function fetchWizardSchemas\(/.test(SERVER), "the generate path stays");
}

// ── 5. Live: it really is off, for a real org, with a real token ────────────
(async () => {
  const PORT = 3984;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wizoff-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: "http://127.0.0.1:9",
      ANTHROPIC_API_KEY: "sk-ant-spec-not-called",
      RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
      WIZARD_ENABLED_ORGS: "",   // explicitly empty: the shipped state
    }),
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
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 60000,
      headers: body ? { "Content-Type": "application/json" } : {} },
      x => { let b = ""; x.on("data", d => b += d); x.on("end", () => res({ status: x.statusCode, body: b })); });
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
    r.end(body ? JSON.stringify(body) : undefined);
  });

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("no boot\n" + log.slice(-500)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });
    const T = `token=${encodeURIComponent(token)}`;

    // CLICK: every route.
    is((await call("GET", `/${org}/report-wizard?${T}`)).status, 404, "the wizard page is off");
    is((await call("POST", `/${org}/report-wizard/api/generate?${T}`, { prompt: "x" })).status, 404,
       "generate is off — the expensive one, and a direct POST must not reach the model");
    is((await call("POST", `/${org}/report-wizard/api/feedback?${T}`, { vote: "up" })).status, 404,
       "feedback is off");
    is((await call("POST", `/${org}/report-wizard/api/log?event=wizard-save&${T}`)).status, 404,
       "the activity beacon is off");

    // SEE: the card is gone from the org dashboard.
    const pg = await call("GET", `/${org}?${T}`);
    is(pg.status, 200, "the org page still serves");
    ok(/"wizardVisible":false/.test(pg.body),
       "…with the wizard card explicitly switched off in the injected config, so the page cannot "
       + "draw it: " + (/"wizardVisible":(\w+)/.exec(pg.body) || [])[0]);
    ok(/wizardCardHTML/.test(pg.body),
       "NOTE the card BUILDER is still in the served JS — org.html renders client-side, so grepping "
       + "the HTML for an anchor proves nothing about the DOM. That claim is a browser claim and "
       + "lives in ci-check-render's `org landing · no wizard card` case, which asserts the card is "
       + "ABSENT from the rendered page. wizardVisible:false above is what gates it");

    // AND NOT ONE DEAD LINK ALERT, though every request above carried a real token.
    const evFile = path.join(dataDir, "events.jsonl");
    const events = fs.existsSync(evFile)
      ? fs.readFileSync(evFile, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return {}; } })
      : [];
    is(events.filter(e => e.event === "deadlink" && /report-wizard/.test(String(e.path || ""))).length, 0,
       "DISABLING A FEATURE MUST NOT PAGE ANYONE. Every request above arrived with a valid token and "
       + "got a 404 — the exact shape noteDeadLink alerts on — so without the deliberate-404 marker "
       + "this posts one alert per stale link");
    ok(!events.some(e => e.report === "report-wizard" && e.event === "view"),
       "and a refused page logs no view, so the report does not keep looking 'active' to the "
       + "watchdogs that gate alerting on usage");

    // One slug re-enables it, or this is a deletion rather than a switch.
    child.kill("SIGKILL");
    const PORT2 = PORT + 1;
    const child2 = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT2), DATA_DIR: dataDir, METABASE_URL: "http://127.0.0.1:9",
        ANTHROPIC_API_KEY: "sk-ant-spec-not-called",
        RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "", WIZARD_ENABLED_ORGS: org,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((res, rej) => {
        const t0 = Date.now(), tick = () => {
          if (Date.now() - t0 > 60000) return rej(new Error("no boot 2"));
          const r = http.get({ host: "127.0.0.1", port: PORT2, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
          r.on("error", () => setTimeout(tick, 400));
          r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
        }; tick();
      });
      const back = await new Promise((res, rej) => {
        const r = http.get({ host: "127.0.0.1", port: PORT2,
          path: `/${org}/report-wizard?${T}`, timeout: 30000 },
          x => { x.resume(); res(x.statusCode); });
        r.on("error", rej);
        r.on("timeout", () => { r.destroy(); rej(new Error("t")); });
      });
      is(back, 200,
         "ONE SLUG IN WIZARD_ENABLED_ORGS BRINGS THE PAGE BACK. This is a switch, not a deletion — "
         + "and it is how the improvements stayed testable while the default is off");
    } finally { child2.kill("SIGKILL"); }

    console.log("✓ wizard-disabled.spec.js — " + n + " assertions");
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
