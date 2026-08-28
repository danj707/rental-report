#!/usr/bin/env node
/**
 * wizard-schema-resilience.spec.js
 *
 * Dan tried to build a report and got "Report generation failed / No data
 * sources available for this org" — from an org with TWELVE configured sources.
 *
 * MEASURED CAUSE (2026-08-28, the wizard's own probe replayed against production
 * Metabase with its original 15s budget and all-in-parallel fan-out):
 *
 *     facility          TIMEOUT      programs          TIMEOUT
 *     calendar          7442ms       court-utilization TIMEOUT
 *     fasttrack        12265ms       waitlist         14392ms
 *     roster            TIMEOUT      memberships      13285ms
 *     products         12956ms       instructor-payout TIMEOUT
 *     users             TIMEOUT      gl                8958ms
 *     => 6 of 12 usable
 *
 * At a 40s budget, sequentially, 10 of 12 answered. So the cards are SLOW, not
 * broken — and the survivors at 12-14.4s were sitting on the cliff edge, which
 * is why a slightly busier minute takes all twelve.
 *
 * Three defects, and the third is the one that made it unrecoverable:
 *   1. 15s against cards this repo has measured between 8s and past 90s.
 *   2. Twelve heavy queries fired at once — the wizard as its own load source,
 *      the same shape as the health check firing ~28 redundant probes.
 *   3. THE EMPTY RESULT WAS CACHED FOR 30 MINUTES. One slow window poisoned the
 *      org, and the Try Again button on screen re-read the poisoned entry, so it
 *      could not possibly work.
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
const PAGE = fs.readFileSync(path.join(ROOT, "public", "report-wizard.html"), "utf8");

let n = 0;
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";
const src = (c, w) => { if (SKIP_SOURCE) return; n++; assert.ok(c, w); };
const ok = (c, w) => { n++; assert.ok(c, w); };
const is = (a, b, w) => { n++; assert.deepStrictEqual(a, b, w); };

// ── 1. Lift and RUN the two helpers ─────────────────────────────────────────
// runInThisContext, not runInNewContext: a new realm has its own Array and
// Object prototypes, so deepStrictEqual fails on values that are correct. The
// deps are injected as IIFE parameters instead.
const H = (() => {
  const m = /function warmestRowsFor\(orgSlug, reportType\) \{[\s\S]*?\n\}\n[\s\S]*?function wizardSchemaFromRows\(rows\) \{[\s\S]*?\n\}/.exec(SERVER);
  assert.ok(m, "could not lift warmestRowsFor / wizardSchemaFromRows");
  const dataCache = new Map();
  return vm.runInThisContext(
    "(function(dataCache, reportTtlMs){\n" + m[0] +
    "\nreturn { warmestRowsFor, wizardSchemaFromRows, dataCache };\n})"
  )(dataCache, () => 2 * 60 * 60 * 1000);
})();

// Schema derivation: names, types, a few samples — and nothing else.
{
  const sch = H.wizardSchemaFromRows([
    { Program: "Swim", "Net Revenue": 1200, Notes: null },
    { Program: "Camp", "Net Revenue": 900.5, Notes: null },
  ]);
  is(sch.rowCount, 2, "the row count is the rows that actually arrived");
  is(sch.fields.map(f => f.name), ["Program", "Net Revenue", "Notes"],
     "field names are passed through character-for-character — the model is told to copy them");
  is(sch.fields[0].type, "string", "a text column is a string");
  is(sch.fields[1].type, "number", "a money column is a number, so the model can aggregate it");
  is(sch.fields[0].samples, ["Swim", "Camp"], "with a few sample values");
}

// warmestRowsFor: ANY window will do, but only a LIVE one.
{
  const now = Date.now();
  H.dataCache.clear();
  H.dataCache.set("apex:programs:", { data: { rows: [{ A: 1 }] }, ts: now - 60000, rt: "programs" });
  H.dataCache.set("apex:programs:v1:?parameters=%5B%5D",
                  { data: { rows: [{ A: 1 }, { A: 2 }] }, ts: now - 1000, rt: "programs" });
  H.dataCache.set("apex:gl:v1:?parameters=x", { data: { rows: [{ G: 1 }] }, ts: now, rt: "gl" });
  H.dataCache.set("other:programs:v1:?x", { data: { rows: [{ Z: 9 }] }, ts: now, rt: "programs" });

  is(H.warmestRowsFor("apex", "programs").length, 2,
     "ANY parameter set answers a schema — the columns do not depend on the date window, and a "
     + "lookup that guessed ONE key would miss almost every time: the data route keys on the "
     + "window the reader asked for and pre-warm keys on this month. That is the pre-warm key bug, "
     + "and it fails just as silently");
  is(H.warmestRowsFor("apex", "gl").length, 1, "…scoped to the right report");
  is(H.warmestRowsFor("other", "programs")[0].Z, 9, "…and to the right org");
  is(H.warmestRowsFor("apex", "facility"), null, "a report with nothing warm returns null, not []");

  H.dataCache.clear();
  H.dataCache.set("apex:programs:v1:?x", { data: { rows: [{ A: 1 }] }, ts: now - 9e9, rt: "programs" });
  is(H.warmestRowsFor("apex", "programs"), null,
     "an EXPIRED entry is not warm data — a schema from stale columns would describe a card that "
     + "has since changed shape");

  H.dataCache.clear();
  H.dataCache.set("apex:programs:v1:?x", { data: { rows: [] }, ts: now, rt: "programs" });
  is(H.warmestRowsFor("apex", "programs"), null,
     "and an entry with no rows tells us nothing about the columns");
}

// ── 2. The three fixes, in source ───────────────────────────────────────────
{
  src(/const WIZARD_PROBE_TIMEOUT_MS = Number\(process\.env\.WIZARD_PROBE_TIMEOUT_MS \|\| 20000\)/.test(SERVER),
     "the per-probe budget has to clear the cards' measured range — 15s loses to a healthy card");
  src(/signal: AbortSignal\.timeout\(Math\.min\(WIZARD_PROBE_TIMEOUT_MS, left\)\)/.test(SERVER),
     "…and the probe uses it, clamped by whatever is LEFT of the total budget — otherwise the last "
     + "probe can run 20s past a 35s deadline and the bound is decorative");

  const fn = /async function fetchWizardSchemas\([\s\S]*?\n\}\n/.exec(SERVER)[0];
  ok(!/Promise\.allSettled\(reportTypes/.test(fn),
     "NOT twelve heavy queries at once. Fired in parallel the wizard is its own load source and "
     + "half the cards lose to a timeout it caused — measured, 6 of 12");
  ok(/WIZARD_PROBE_CONCURRENCY/.test(fn),
     "…a few at a time instead. One at a time is the other failure: a cold sweep measured 64s at "
     + "concurrency 3, so serialising all twelve is minutes of somebody watching a spinner");
  ok(/const deadline = Date\.now\(\) \+ WIZARD_SCHEMA_BUDGET_MS;/.test(fn)
     && /if \(left <= 0\)/.test(fn),
     "and a TOTAL budget, because per-probe timeouts do not bound the sum. Whatever answered when "
     + "it expires is what the report is built from — the wizard needs one source, not twelve");
  ok(/const warm = warmestRowsFor\(orgSlug, rt\);/.test(fn),
     "the app's own warm data is tried BEFORE Metabase — a schema is columns, and any org that "
     + "opened a report today already has them");
  ok(fn.indexOf("warmestRowsFor") < fn.indexOf("AbortSignal.timeout"),
     "…and tried first, or the cheap path never runs");

  // LAST KNOWN GOOD. This is what turns "the wizard is down because Metabase is
  // busy" into "the wizard works".
  src(/rememberWizardSchemas\(orgSlug, schemas\);/.test(fn),
     "a freshly measured schema is persisted");
  src(fn.indexOf("rememberWizardSchemas") < fn.indexOf("readWizardSchemaStore()[orgSlug]"),
     "…BEFORE the fallback fills the gaps, or a remembered schema is re-stored as though it had "
     + "just been measured, and its timestamp stops meaning anything");
  src(/stale: true/.test(fn),
     "a schema that came from the store is marked, so nothing downstream can mistake it for a "
     + "reading taken now");
  src(/const WIZARD_SCHEMA_FILE = path\.join\(DATA_DIR, "wizard-schemas.json"\)/.test(SERVER),
     "…and it lives on the volume, so a restart does not forget it");
  src(/if \(!Object\.keys\(schemas\)\.length\) return;/.test(SERVER),
     "an empty result is never written to the store — that would be caching a failure on DISK, "
     + "which is the 30-minute bug with a longer memory");

  src(/const ttl = answered > 0 \? WIZARD_SCHEMA_TTL : WIZARD_SCHEMA_FAIL_TTL;/.test(SERVER),
     "A FAILED PROBE IS NOT AN EMPTY ANSWER AND MUST NOT BE CACHED AS ONE. Caching {} for 30 "
     + "minutes is what made the Try Again button inert");
  const ttlMatch = /const WIZARD_SCHEMA_FAIL_TTL = Number\(process\.env\.WIZARD_SCHEMA_FAIL_TTL_MS \|\| (\d+) \* 1000\)/.exec(SERVER);
  src(!!ttlMatch, "the failure TTL is its own constant");
  if (ttlMatch) src(Number(ttlMatch[1]) <= 60,
     "…and it is seconds, not minutes: long enough to stop a double-click stampeding twelve "
     + "cards, short enough that Try Again actually retries");

  src(/retryable: st\.configured > 0/.test(SERVER),
     "the route says whether trying again could help");
  src(/No data sources are configured for this org/.test(SERVER)
      && /answered in time/.test(SERVER),
     "AN ORG WITH TWELVE SOURCES MUST NOT BE TOLD IT HAS NONE. Those are different facts and they "
     + "have different fixes — one is a config gap, the other is 'press it again'");
  // COMMENTS STRIPPED FIRST: the fix's own comment quotes the old sentence on
  // purpose, and a naive search finds it there. Same reason checkin-status.spec
  // strips them before checking for an uncast date tag.
  const CODE = SERVER.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok(!/No data sources available for this org/.test(CODE),
     "…and the old sentence, which was simply false, is gone from the CODE");

  src(/onClick=\{function\(\) \{ setPhase\('prompt'\); \}\}>Try Again/.test(PAGE),
     "Try Again returns to the prompt WITHOUT clearing it — retyping a paragraph because a card "
     + "was slow is its own insult (setPrompt('') belongs to handleNew alone)");
  src((PAGE.match(/setPrompt\(''\)/g) || []).length === 1,
     "…and there is exactly one place that clears the prompt");
}

// ── 3. Live ─────────────────────────────────────────────────────────────────
// A STUB METABASE, so the whole arc is real rather than half-planted: a run that
// succeeds must WRITE the store, and only then can "Metabase died and the wizard
// still works" mean anything.
const { spawn: _spawn } = require("child_process");

function bootServer(port, dataDir, extraEnv) {
  const child = _spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), DATA_DIR: dataDir,
      ANTHROPIC_API_KEY: "sk-ant-spec-not-called",
      WIZARD_PROBE_TIMEOUT_MS: "2500",
      WIZARD_SCHEMA_FAIL_TTL_MS: "1",
      RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "spec-password",
    }, extraEnv || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const box = { child, log: "" };
  child.stdout.on("data", d => { box.log += d; });
  child.stderr.on("data", d => { box.log += d; });
  return box;
}

function waitUp(port, box) {
  return new Promise((res, rej) => {
    const t0 = Date.now(), tick = () => {
      if (Date.now() - t0 > 60000) return rej(new Error("no boot\n" + box.log.slice(-600)));
      const r = http.get({ host: "127.0.0.1", port, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
      r.on("error", () => setTimeout(tick, 400));
      r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
    }; tick();
  });
}

function post(port, p, body) {
  return new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: p, timeout: 90000,
      headers: { "Content-Type": "application/json" } },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => {
        let j = null; try { j = JSON.parse(b); } catch {}
        res({ status: r.statusCode, body: b, json: j });
      }); });
    req.on("error", rej);
    req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end(JSON.stringify(body));
  });
}

(async () => {
  const { org, token } = (() => {
    const i = SERVER.indexOf("const ORGS = {");
    const j = SERVER.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = vm.runInNewContext("(" + SERVER.slice(SERVER.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    const slug = Object.keys(ORGS).find(k => ORGS[k] && ORGS[k].token && ORGS[k].orgId);
    return { org: slug, token: ORGS[slug].token };
  })();
  const GEN = `/${org}/report-wizard/api/generate?token=${encodeURIComponent(token)}`;

  // ── A. Metabase answering: the store has to be WRITTEN ────────────────────
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wiz-a-"));
  let stubHits = 0;
  const stub = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (/\/query\/json/.test(req.url)) {
      stubHits++;
      return res.end(JSON.stringify([
        { Program: "Swim Lessons", Section: "Level 1", "Net Revenue": 1200, Enrolled: 12 },
        { Program: "Summer Camp", Section: "Week 2", "Net Revenue": 3400, Enrolled: 30 },
      ]));
    }
    res.end(JSON.stringify({ parameters: [] }));
  });
  await new Promise(r => stub.listen(0, "127.0.0.1", r));
  const stubPort = stub.address().port;

  const A = bootServer(3992, dirA, { METABASE_URL: `http://127.0.0.1:${stubPort}` });
  try {
    await waitUp(3992, A);
    const r = await post(3992, GEN, { prompt: "Program revenue by section" });
    ok(!/data sources/.test(r.body),
       "with sources answering, the wizard clears the schema gate: " + r.body.slice(0, 120));
    ok(stubHits > 0, "…having actually probed");

    const storeFile = path.join(dirA, "wizard-schemas.json");
    ok(fs.existsSync(storeFile),
       "A SUCCESSFUL RUN WRITES THE STORE. Without this there is never a last-known-good, and the "
       + "next slow afternoon takes the wizard down again");
    const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    const kept = store[org] || {};
    ok(Object.keys(kept).length > 0, "…keyed by org");
    const one = kept[Object.keys(kept)[0]];
    is(one.fields.map(f => f.name), ["Program", "Section", "Net Revenue", "Enrolled"],
       "…and it remembers the COLUMNS, which is all a schema is");
    ok(typeof one.ts === "number", "with a timestamp, so staleness is knowable");
    ok(!JSON.stringify(store).includes("Swim Lessons") === false,
       "sample values travel with it — the model is shown examples, and they came from real rows");
  } finally { A.child.kill("SIGKILL"); }

  // ── B. Metabase now DEAD, same volume: the wizard must still work ─────────
  await new Promise(r => stub.close(r));
  const B = bootServer(3993, dirA, { METABASE_URL: "http://127.0.0.1:9" });
  try {
    await waitUp(3993, B);
    const r = await post(3993, GEN, { prompt: "Program revenue by section" });
    ok(!/data sources/.test(r.body),
       "METABASE IS GONE AND THE WIZARD STILL BUILDS. That is the whole point of the store — the "
       + "columns did not stop existing because a query timed out. status " + r.status + " "
       + r.body.slice(0, 120));
    ok(/last-known-good/.test(B.log),
       "…and the log says the schemas were remembered, not measured — a stale schema must never be "
       + "a silent substitution");
  } finally { B.child.kill("SIGKILL"); try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {} }

  // ── C. Never answered, nothing remembered: say so, and let Try Again work ──
  const dirC = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wiz-c-"));
  const C = bootServer(3994, dirC, { METABASE_URL: "http://127.0.0.1:9" });
  try {
    await waitUp(3994, C);
    let r = await post(3994, GEN, { prompt: "Program revenue and fill rate by gender" });
    is(r.status, 503,
       "with every source unreachable and nothing remembered, the wizard answers 503 — a transient "
       + "upstream failure, not a 500 that reads as a bug in the report: " + r.body.slice(0, 140));
    is(r.json.retryable, true, "…and says trying again could help");
    ok(/answered in time/.test(r.json.error || ""),
       "the message says the sources did not ANSWER: " + JSON.stringify(r.json.error));
    ok(/\d+ data sources/.test(r.json.error || ""),
       "…and counts the ones this org HAS, which is the sentence that was wrong — it told an org "
       + "with twelve that it had none");
    ok(!/No data sources available/.test(r.json.error || ""),
       "the old wording is gone from the wire, not just from the source");

    ok(!fs.existsSync(path.join(dirC, "wizard-schemas.json")),
       "and NOTHING is written to the store from a run where nothing answered — that would be the "
       + "30-minute cache bug with a longer memory");

    // THE RETRY HAS TO REACH METABASE AGAIN. The old code cached {} for 30
    // minutes, so this second call would have been answered from the poisoned
    // entry and the button on screen could never have worked.
    const before = (C.log.match(/\[wizard\] schemas /g) || []).length;
    ok(before >= 1, "the first call probed");
    r = await post(3994, GEN, { prompt: "Program revenue and fill rate by gender" });
    const after = (C.log.match(/\[wizard\] schemas /g) || []).length;
    ok(after > before,
       `Try Again must RE-PROBE rather than re-read a cached failure (rounds ${before} → ${after}). `
       + `Caching an empty result is the campmap POS_OK bug in the one place where the recovery `
       + `button is on screen and inert`);
    is(r.status, 503, "…and answers the same honest error while it is still failing");
  } finally { C.child.kill("SIGKILL"); try { fs.rmSync(dirC, { recursive: true, force: true }); } catch {} }

  console.log("✓ wizard-schema-resilience.spec.js — " + n + " assertions");
})().catch(e => { console.error(e); process.exit(1); });
