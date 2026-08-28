#!/usr/bin/env node
/**
 * retired-reports.spec.js — `overview` and `annual-report` are off.
 *
 * Measured from events.jsonl over the log's whole life: overview had EIGHT opens
 * ever and none in three months; annual-report had THREE. Dan: "do 4, nuke that."
 *
 * Neither drew a card already (annual-report is in NON_ADDABLE_REPORTS, overview
 * is not in REPORT_TYPES) and overview's route was removed some time ago. What
 * was still live is /:org/annual-report and its generate route, which calls the
 * model.
 *
 * THE 404s ARE MARKED DELIBERATE. noteDeadLink() alerts on "a 404 that arrived
 * with a valid-looking token" — the shape of any stale link to either report.
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

{
  const m = /const RETIRED_REPORTS = new Set\((\[[^\]]*\])\)/.exec(SERVER);
  const retired = m ? vm.runInThisContext(m[1]) : [];
  for (const rt of ["overview", "annual-report"]) {
    ok(retired.includes(rt), `${rt} is retired`);
  }
  src(/function reportRetired\(rt\) \{ return RETIRED_REPORTS\.has\(rt\); \}/.test(SERVER),
     "one helper, so a route added later cannot quietly skip the gate");
  src(/if \(reportRetired\("annual-report"\)\) return refuse404\(res/.test(SERVER),
     "the GENERATE route is gated — it calls the model, so it is the expensive surface to leave open "
     + "on a report with three opens ever");
  src(/res\.locals\.deliberate404 = true;\n\s*return res\.status\(404\)\.send\("The Annual Report has been retired\."\)/.test(SERVER),
     "and the page's 404 is marked deliberate, or a stale link pages someone");

  // NOTHING DELETED, and the dependency entries stay for a specific reason.
  for (const f of ["overview.html", "annual-report.html"]) {
    ok(fs.existsSync(path.join(ROOT, "public", f)), `${f} stays — retired is not deleted`);
  }
  ok(/"annual-report": ANNUAL_REPORT_SYS_PROMPT/.test(SERVER), "the prompt stays");
  src(/REPORT_DEPENDENCIES/.test(SERVER) && /splitBreakageByActivity/.test(SERVER),
     "both stay in REPORT_DEPENDENCIES on purpose: that map is what splitBreakageByActivity() reads "
     + "to decide a dropped table under a DEAD report must not page anyone, and removing them loses "
     + "exactly that");
}

(async () => {
  const PORT = 3983;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-retired-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: "http://127.0.0.1:9",
      ANTHROPIC_API_KEY: "sk-ant-spec-not-called", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
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

    is((await call("GET", `/${org}/annual-report?${T}`)).status, 404, "the annual report page is off");
    is((await call("POST", `/${org}/annual-report/api/generate?${T}`,
                   { start_date: "2026-01-01", end_date: "2026-12-31" })).status, 404,
       "and its generate route, which calls the model");
    is((await call("GET", `/${org}/overview?${T}`)).status, 404, "overview stays off");

    // The reports people DO use are untouched.
    for (const rt of ["gl", "facility", "programs", "roster"]) {
      is((await call("GET", `/${org}/${rt}?${T}`)).status, 200, `${rt} still serves`);
    }

    const evFile = path.join(dataDir, "events.jsonl");
    const events = fs.existsSync(evFile)
      ? fs.readFileSync(evFile, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return {}; } })
      : [];
    is(events.filter(e => e.event === "deadlink"
         && /annual-report|overview/.test(String(e.path || ""))).length, 0,
       "RETIRING A REPORT MUST NOT PAGE ANYONE. Every request above carried a valid token and got a "
       + "404 — exactly what noteDeadLink alerts on");
    ok(!events.some(e => e.report === "annual-report" && e.event === "view"),
       "and a refused page logs no view, so it cannot keep looking active to the watchdogs");

    console.log("✓ retired-reports.spec.js — " + n + " assertions");
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
