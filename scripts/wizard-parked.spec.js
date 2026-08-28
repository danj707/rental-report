#!/usr/bin/env node
/**
 * wizard-parked.spec.js — the Report Wizard is off for every org.
 *
 * Dan: "lets park the report wizard features and disable the report-wizard for
 * all orgs." Not broken — parked, and the reasoning is recorded next to
 * WIZARD_ENABLED_ORGS in server.js.
 *
 * TWO GATES, because either alone is a half-measure:
 *   * RETIRED_REPORTS hides the card. On its own it leaves the page live —
 *     the comment above that Set says so, and campmap served ~24 visitors a
 *     month through direct links the whole time it was listed there.
 *   * wizardEnabled() decides whether anything answers. On its own it leaves a
 *     card on the org dashboard that 404s when clicked.
 *
 * AND THE 404s MUST BE MARKED DELIBERATE. noteDeadLink() alerts on "a 404 that
 * arrived with a valid-looking token", which is exactly the shape of every
 * bookmarked wizard link from now on. Without refuse404 / deliberate404,
 * switching this off would fill Slack with DEAD LINK alerts naming a path we
 * turned off on purpose — the bug Dan hit on the settings routes, at scale.
 *
 * SKIP_SOURCE=1 drops the source assertions.
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

// ── 1. Off by default, and off everywhere ───────────────────────────────────
{
  const m = /const RETIRED_REPORTS = new Set\((\[[^\]]*\])\)/.exec(SERVER);
  ok(m && vm.runInThisContext(m[1]).includes("report-wizard"),
     "report-wizard is in RETIRED_REPORTS, so the card is gone from the org dashboard and the "
     + "admin portal");

  src(/const WIZARD_ENABLED_ORGS = new Set\(\n\s*\(process\.env\.WIZARD_ENABLED_ORGS \|\| ""\)/.test(SERVER),
     "the route gate is an allowlist that starts EMPTY — off for every org, and one slug turns it "
     + "back on for that org alone. Same shape as MUNIS_EXPORT_ORGS, which is how the Tyler export "
     + "was parked");
  src(/function wizardEnabled\(slug\) \{ return WIZARD_ENABLED_ORGS\.has\(slug\); \}/.test(SERVER),
     "…read through one helper, so a new wizard route cannot forget the gate");

  // Every wizard route, gated.
  for (const route of [
    ['app.get("/:org/report-wizard"', "the page"],
    ['app.post("/:org/report-wizard/api/generate"', "generate"],
    ['app.post("/:org/report-wizard/api/feedback"', "feedback"],
    ['app.post("/:org/report-wizard/api/log"', "the activity beacon"],
  ]) {
    const i = SERVER.indexOf(route[0]);
    ok(i > 0, `${route[1]} route exists`);
    const body = SERVER.slice(i, i + 1600);
    src(/wizardEnabled\(slug\)/.test(body),
       `${route[1]} route has to check wizardEnabled — RETIRED_REPORTS only hides the card, it does `
       + `not stop a direct link, and campmap proved people use those`);
  }

  src(/wizardVisible: wizardEnabled\(slug\) && !RETIRED_REPORTS\.has\("report-wizard"\)/.test(SERVER),
     "the org page's card is gated on BOTH, or it renders a link to a 404");
}

// ── 2. THE 404s ARE DELIBERATE, so Slack stays quiet ────────────────────────
{
  const page = SERVER.slice(SERVER.indexOf('app.get("/:org/report-wizard"'));
  src(/res\.locals\.deliberate404 = true;\n\s*return res\.status\(404\)\.send\("The Report Wizard is not enabled/.test(page),
     "the PAGE marks its 404 deliberate. Every bookmarked /:org/report-wizard?token=… link is now "
     + "'a 404 with a valid-looking token', which is exactly what noteDeadLink alerts on");
  const apiRefusals = (SERVER.match(/if \(!wizardEnabled\(slug\)\) return refuse404\(res, \{/g) || []).length;
  is(apiRefusals, 3,
     "and all three API routes refuse through refuse404(), which sets the same marker — otherwise "
     + "parking the feature spams the channel with alerts about a path we turned off on purpose");
}

// ── 3. NOTHING IS DELETED, so un-parking is one line ────────────────────────
{
  ok(fs.existsSync(path.join(ROOT, "public", "report-wizard.html")),
     "the page file stays — parked is not deleted, and this is what made un-retiring it in August a "
     + "one-line change rather than a rebuild");
  for (const f of ["wizard-prompts.spec.js", "wizard-schema-resilience.spec.js", "wizard-narrative.spec.js"]) {
    ok(fs.existsSync(path.join(ROOT, "scripts", f)),
       `${f} stays and keeps running — a parked feature with its guards deleted comes back broken`);
  }
  ok(/const WIZARD_PROMPTS = \[/.test(SERVER), "the prompt registry stays");
  ok(/function fetchWizardSchemas\(/.test(SERVER), "so does the schema resilience work");
  ok(/function wizardRepairConfigFields\(/.test(SERVER), "and the field repair pass");
  // The reasoning, so the next person does not have to re-derive it.
  const PROSE = SERVER.replace(/\n\s*\/\/\s*/g, " ");
  src(/really needs direct db connectivity via an api/.test(PROSE),
     "Dan's reason is recorded verbatim next to the switch");
  src(/104,340 rows in 52s/.test(SERVER) && /42\.7s/.test(SERVER),
     "…with the measurements that back it, or 'it felt slow' is all that survives");
  src(/SOURCE SUBSTITUTION IS STILL OPEN/.test(SERVER),
     "…and the one finding that outlives the parking is written down rather than lost in a thread");
}

// ── 4. Live: it really is off ───────────────────────────────────────────────
(async () => {
  const PORT = 3985;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wizpark-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: "http://127.0.0.1:9",
      ANTHROPIC_API_KEY: "sk-ant-spec-not-called",
      RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
      WIZARD_ENABLED_ORGS: "",   // explicitly empty: this is the shipped state
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

    is((await call("GET", `/${org}/report-wizard?${T}`)).status, 404, "the wizard page is off");
    is((await call("POST", `/${org}/report-wizard/api/generate?${T}`, { prompt: "x" })).status, 404,
       "generate is off — the expensive one, and a direct POST must not reach the model");
    is((await call("POST", `/${org}/report-wizard/api/feedback?${T}`, { vote: "up" })).status, 404,
       "feedback is off");
    is((await call("POST", `/${org}/report-wizard/api/log?event=wizard-save&${T}`)).status, 404,
       "the beacon is off");

    // The card is gone from the org page.
    const pg = await call("GET", `/${org}?${T}`);
    is(pg.status, 200, "the org page still serves");
    ok(!/report-wizard/.test(pg.body) || /"wizardVisible":false/.test(pg.body),
       "…without a Report Wizard card, or at least with it explicitly switched off in the config");

    // AND NOT ONE DEAD LINK ALERT, though every request above carried a real token.
    const evFile = path.join(dataDir, "events.jsonl");
    const events = fs.existsSync(evFile)
      ? fs.readFileSync(evFile, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return {}; } })
      : [];
    const dead = events.filter(e => e.event === "deadlink" && /report-wizard/.test(String(e.path || "")));
    is(dead.length, 0,
       "PARKING A FEATURE MUST NOT PAGE ANYONE. Every request above arrived with a valid token and "
       + "got a 404 — the exact shape noteDeadLink alerts on — so without the deliberate-404 marker "
       + "this would post one alert per bookmarked link");
    ok(!events.some(e => e.report === "report-wizard" && e.event === "view"),
       "and a refused page does not log a view, which would keep the report looking 'active' to the "
       + "watchdogs that gate alerting on usage");

    console.log("✓ wizard-parked.spec.js — " + n + " assertions");
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
