#!/usr/bin/env node
"use strict";

/* ============================================================================
   SUBSCRIBING TO MORE THAN ONE SHAPE OF ONE REPORT — guards
   ----------------------------------------------------------------------------
   The GL report renders three different documents off one feed, and a
   subscription's `reportParams.gl` is ONE string, so it could carry only one of
   them. Dan: "I'm a danvers admin and I select to receive all 3, or 2, or just
   1 report on a specific cadence."

   This LIFTS AND RUNS the registry and its three helpers, because every defect
   here is a merge or a comparison — a variant that inherits the mode parameter
   of the one before it, an empty list that resolves to "send everything", a
   filter carried into a document that cannot honour it — and a regex over any
   of those passes just as happily on the inverted version.
   ============================================================================ */

const fs   = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC  = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const GL   = fs.readFileSync(path.join(ROOT, "public", "gl.html"), "utf8");
const ADMIN= fs.readFileSync(path.join(ROOT, "public", "admin.html"), "utf8");

let passed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; } else { failures.push(name); console.error("  ✗ " + name); }
}
function eq(a, b, name) {
  ok(a === b, name + "  (got " + JSON.stringify(a) + ", wanted " + JSON.stringify(b) + ")");
}
// A throw inside a lifted function must fail BY NAME rather than killing the
// run with a bare stack naming nothing. Nth instance of that lesson here.
function guard(name, fn) {
  try { return fn(); }
  catch (e) { failures.push(name + " THREW: " + e.message);
              console.error("  ✗ " + name + " THREW: " + e.message); return null; }
}

// server.js quotes forbidden forms in its own comments on purpose, and a regex
// comment-stripper is unsound on that file (a `/*` lives inside a template
// literal), so anything asserting an absence SLICES the region it is about.
const slice = (text, from, to) => {
  const a = text.indexOf(from);
  if (a < 0) return "";
  const b = to ? text.indexOf(to, a + from.length) : -1;
  return b < 0 ? text.slice(a) : text.slice(a, b);
};

// ── lift ────────────────────────────────────────────────────────────────────
// The parameter list is skipped FIRST: counting braces from the first "{" after
// the name lands on a destructured parameter and lifts half a function.
function liftFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " is not at module scope — a spec cannot run what it cannot reach");
  let p = text.indexOf("(", start), pd = 0, j = p;
  for (; j < text.length; j++) {
    if (text[j] === "(") pd++;
    else if (text[j] === ")") { pd--; if (pd === 0) break; }
  }
  let depth = 0, i = text.indexOf("{", j);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 1);
}
function liftConst(text, decl) {
  const start = text.indexOf(decl);
  if (start < 0) throw new Error(decl + " was not found");
  let depth = 0, i = text.indexOf("{", start);
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) break; }
  }
  return text.slice(start, i + 2); // include the ";"
}

let H = null;
try {
  const body = [
    liftConst(SRC, "const REPORT_EMAIL_VARIANTS = {"),
    liftFn(SRC, "emailVariantsFor"),
    liftFn(SRC, "resolveEmailVariants"),
    liftFn(SRC, "variantParams"),
  ].join("\n\n");
  // The registry's gates are the only thing it reaches for, so they are the
  // seam: a lift that reached past them would die with a bare ReferenceError
  // rather than failing by name.
  ok(/getTylerConfig\(slug\)/.test(body) && /feeAllocConfig\(slug\)/.test(body),
     "the lift carries the org gates, so the spec can drive an org that is switched off");
  H = new Function("getTylerConfig", "feeAllocConfig",
    body + "\nreturn { REPORT_EMAIL_VARIANTS, emailVariantsFor, resolveEmailVariants, variantParams };");
} catch (e) {
  console.error("  ✗ could not lift the variant registry: " + e.message);
  console.error("\n1 assertion(s) FAILED."); process.exit(1);
}

// Danvers: turnover OFF, fee allocation ON. Shrewsbury: both off.
const danvers    = H(() => null,        slug => (slug === "danvers" ? { ccVariableBps: 350 } : null));
// An org with every mode switched on, so the ordering and stripping rules have
// two competing modes to get wrong rather than one.
const bothOn     = H(() => ({ entity: "X" }), () => ({ ccVariableBps: 350 }));
const neither    = H(() => null,        () => null);

/* SKIP_SOURCE=1 drops everything that reads our own patch — the lifted runs
   included, since they read the registry out of server.js too — so the live
   half below can be shown to catch a regression on its own. A regex over a diff
   is not evidence the server behaves. */
if (process.env.SKIP_SOURCE !== "1") {
  /* ── The registry ───────────────────────────────────────────────────────── */

  const V = danvers.REPORT_EMAIL_VARIANTS.gl;
  eq(V.length, 3, "the GL report declares three mailable shapes");
  eq(V[0].key, "rollup", "the rollup leads — it is what the report opens on");
  ok(V.every(v => typeof v.label === "string" && v.label.length),
     "every variant carries a LABEL, or three GL emails arrive under one subject");
  eq(new Set(V.map(v => v.label)).size, 3,
     "the three labels are distinct, so a reader can tell the emails apart unopened");
  eq(V.find(v => v.key === "rollup").params, "",
     "the rollup carries no mode parameter of its own");
  eq(V.find(v => v.key === "turnover").params, "tyler=1", "turnover rides ?tyler=1");
  eq(V.find(v => v.key === "fees").params, "fees=1", "fee allocation rides ?fees=1");
  ok(V.find(v => v.key === "turnover").gate && V.find(v => v.key === "fees").gate,
     "both extra shapes are GATED — an org not switched on must not be offered them");
  ok(!V.find(v => v.key === "rollup").gate,
     "the rollup is not gated: every org that can be mailed this report gets it");

  // Every mode parameter in the registry is one generatePdf actually forwards.
  // A mode the PDF route drops renders the plain rollup under the other name,
  // which is the fourth-gate failure this repo has now recorded four times.
  const fwd = slice(SRC, '["locations", "location", "sites"', "].forEach");
  V.forEach(v => {
    for (const [k] of new URLSearchParams(v.params)) {
      ok(new RegExp('"' + k + '"').test(fwd),
         'generatePdf forwards "' + k + '", or the ' + v.key + " email is the rollup wearing its name");
    }
  });

  /* ── Which variants an org may be offered ───────────────────────────────── */

  eq(danvers.emailVariantsFor("danvers", "gl").map(v => v.key).join(","), "rollup,fees",
     "Danvers is offered the rollup and the fee worksheet — turnover is not switched on");
  eq(neither.emailVariantsFor("anyone", "gl").map(v => v.key).join(","), "rollup",
     "an org with neither mode switched on is offered only the rollup");
  eq(bothOn.emailVariantsFor("x", "gl").length, 3, "an org with both switched on is offered all three");
  eq(danvers.emailVariantsFor("danvers", "facility").length, 0,
     "a report with no registry offers no variants at all");

  /* ── Resolving what one send should produce ─────────────────────────────── */

  // `[null]` is "as saved" — the answer for every report with no registry AND for
  // every subscription written before variants existed. A resolve that returned
  // the whole registry instead would start mailing three documents to everybody
  // already subscribed to one.
  const asSaved = danvers.resolveEmailVariants("danvers", "gl", undefined);
  eq(asSaved.length, 1, "a subscription that asks for no variant produces ONE send");
  eq(asSaved[0], null, "...and that send carries the params exactly as saved");
  eq(danvers.resolveEmailVariants("danvers", "gl", [])[0], null,
     "an EMPTY list is the same fact as an absent one, not 'send everything'");
  eq(danvers.resolveEmailVariants("danvers", "facility", ["rollup"])[0], null,
     "a report with no registry falls back to one as-saved send");

  eq(danvers.resolveEmailVariants("danvers", "gl", ["rollup", "fees"]).map(v => v.key).join(","),
     "rollup,fees", "two ticked shapes produce two sends");
  eq(danvers.resolveEmailVariants("danvers", "gl", ["rollup", "turnover", "fees"]).map(v => v.key).join(","),
     "rollup,fees",
     "a shape this org is not switched on for is DROPPED, not mailed as the rollup under its name");
  eq(danvers.resolveEmailVariants("danvers", "gl", ["nonsense"])[0], null,
     "an unknown key falls back to one as-saved send rather than sending nothing at all");

  /* ── The params each send actually carries ──────────────────────────────── */

  const saved = "desks=Recreation&gl_codes=4100,4200&methods=cash&glq=camp&refunds=1";
  const byKey = k => bothOn.REPORT_EMAIL_VARIANTS.gl.find(v => v.key === k);

  const rollup = guard("rollup params", () => bothOn.variantParams("gl", saved, byKey("rollup")));
  const rp = new URLSearchParams(rollup);
  eq(rp.get("desks"), "Recreation", "the rollup keeps the desk filter");
  eq(rp.get("gl_codes"), "4100,4200", "the rollup keeps the GL-code filter");
  eq(rp.get("refunds"), "1", "the rollup keeps Refund Detail");
  eq(rp.get("tyler"), null, "the rollup carries no turnover mode");
  eq(rp.get("fees"), null, "the rollup carries no fee mode");

  const turn = new URLSearchParams(guard("turnover params", () => bothOn.variantParams("gl", saved, byKey("turnover"))));
  eq(turn.get("tyler"), "1", "the turnover send asks for the turnover sheets");
  eq(turn.get("fees"), null, "...and not for the fee worksheet as well");
  eq(turn.get("gl_codes"), "4100,4200", "the turnover sheets honour the GL-code filter, so it travels");

  const fee = new URLSearchParams(guard("fee params", () => bothOn.variantParams("gl", saved, byKey("fees"))));
  eq(fee.get("fees"), "1", "the fee send asks for the worksheet");
  eq(fee.get("tyler"), null, "...and not for the turnover sheets as well");
  eq(fee.get("desks"), "Recreation",
     "the fee worksheet KEEPS the desk filter — a desk-scoped worksheet reconciles to that desk's bill");
  ["gl_codes", "methods", "glq", "refunds"].forEach(k => {
    eq(fee.get(k), null,
       "the fee worksheet drops `" + k + "` — that control is not on screen in this mode and the sheet does not apply it");
  });

  // The load-bearing one. A saved string can already carry a mode (a view saved
  // while the worksheet was on screen), and without the strip EVERY variant would
  // inherit it — three emails, one document, three names.
  const stale = "fees=1&desks=Recreation";
  eq(new URLSearchParams(bothOn.variantParams("gl", stale, byKey("rollup"))).get("fees"), null,
     "a saved `fees=1` does not survive into the ROLLUP send");
  eq(new URLSearchParams(bothOn.variantParams("gl", stale, byKey("turnover"))).get("fees"), null,
     "a saved `fees=1` does not survive into the TURNOVER send");
  eq(new URLSearchParams(bothOn.variantParams("gl", "tyler=1", byKey("fees"))).get("tyler"), null,
     "a saved `tyler=1` does not survive into the FEE send");

  eq(bothOn.variantParams("gl", null, byKey("fees")), "fees=1",
     "an unfiltered subscription still carries the mode");
  eq(bothOn.variantParams("gl", null, byKey("rollup")), null,
     "an unfiltered rollup carries nothing — an empty string would read as a filtered view");
  eq(bothOn.variantParams("gl", saved, null), saved,
     "no variant means the params pass through untouched (every pre-variant subscription)");

  /* ── The wiring, which no lifted function can see ───────────────────────── */

  const sched = slice(SRC, "async function runSchedule(", "// ── Cron jobs");
  ok(/resolveEmailVariants\(sub\.org, report, sub\.reportVariants/.test(sched),
     "the scheduler resolves each report's variants from the subscription");
  ok(/for \(const variant of variants\)/.test(sched),
     "...and sends one email PER variant");
  ok(/variantParams\(report, savedParams, variant\)/.test(sched),
     "...each with that variant's own params, not the subscription's raw string");
  ok(/sendReportEmail\([^)]*variant\)/.test(sched),
     "...and hands the variant over, or all three arrive titled the same");

  const send = slice(SRC, "async function sendReportEmail(", "// ── Run scheduled sends");
  ok(/const reportLabel = variant \? variant\.label/.test(send),
     "the email is NAMED by its variant — the subject, the heading and the PDF filename all read it");
  // Scoped to the filter predicate, not to the declaration. A bare /modeKeys/
  // test SURVIVED the mutation that stopped using it — an assertion satisfied by
  // dead code is not guarding the thing it names.
  ok(/filterCount = [^;]*!modeKeys\.has\(k\)/.test(send),
     "a variant's own mode parameter is not COUNTED as a filter — '(1 filter)' on an unfiltered worksheet claims a narrowing that is not there");
  ok(/for \(const v of \(REPORT_EMAIL_VARIANTS\[reportType\] \|\| \[\]\)\)/.test(send),
     "...and the mode keys are read from the registry rather than re-typed beside it");

  const upsert = slice(SRC, "  upsertSubscription(", "  deleteSubscription(");
  eq((upsert.match(/reportVariants: reportVariants \|\| \{\}/g) || []).length, 2,
     "BOTH branches write the variant set — the update branch's spread would otherwise keep a stale one");
  // Scoped to the dedup predicate itself rather than to what sits near it — my
  // own comment explaining the decision matched a proximity test and failed on
  // correct code, which is the Nth instance of that in this repo.
  const dedupe = slice(upsert, "const idx = subs.findIndex(", "});");
  ok(dedupe.length > 0, "the dedup predicate was found (or the next assertion is vacuous)");
  ok(!/reportVariants/.test(dedupe),
     "the variant set is NOT part of the dedup key: same address, cadence and filters is the same subscription, so ticking a third document UPDATES that row");

  const subRoute = slice(SRC, 'app.post("/:org/admin/subscribe"', 'app.delete("/:org/admin/subscribe"');
  ok(/emailVariantsFor\(req\.params\.org, rt\)/.test(subRoute),
     "the subscribe route validates variants against what THIS org is switched on for");
  ok(/\[\.\.\.new Set\(/.test(subRoute),
     "...and de-duplicates them, so one ticked box cannot become two emails");

  const testRoute = slice(SRC, 'app.post("/:org/admin/test-send"', "// ── Serve HTML report pages");
  ok(/Array\.isArray\(req\.body\.variants\)/.test(testRoute),
     "the test send takes the variants from the modal, so it previews what is about to be saved");
  ok(/sub\?\.reportVariants && sub\.reportVariants\[report\]/.test(testRoute),
     "...and falls back to a saved subscription's own set for the admin page's Test button");
  ok(/for \(const variant of variants\)/.test(testRoute),
     "...and sends one test per ticked shape, SEQUENTIALLY");

  ok(/emailVariants: emailVariantsFor\(slug, "gl"\)/.test(slice(SRC, 'app.get("/:org/gl"', "});")),
     "the GL page is HANDED its variant list rather than growing its own copy");

  // Slack. Three documents to one address in one minute is three sends, and the
  // default key would post the first and swallow the other two — the same
  // argument the recipient is already in that key for.
  const slackKey = slice(SRC, 'const key = rec.event === "email"', "rec.event === \"game\"");
  ok(slackKey.length > 0, "the email debounce key was found (or the next assertion is vacuous)");
  ok(/rec\.variant/.test(slackKey),
     "the Slack debounce keys by DOCUMENT, so three sends post three lines");
  const slackMsg = slice(SRC, '} else if (rec.event === "email") {', '} else if (rec.event === "game")');
  ok(/REPORT_EMAIL_VARIANTS\[rec\.report\]/.test(slackMsg),
     "...looked up from the registry rather than stored on the row, so renaming a variant does not redefine rows already in the feed");
  // That the name reaches the TEXT is proven behaviourally below, against a
  // fake Slack. Every source form of it was satisfied by dead code: a mutation
  // that computed the label and then dropped it kept both the lookup and the
  // `${vSuffix}` interpolations intact.
  eq((slackMsg.match(/\$\{vSuffix\}/g) || []).length, 2,
     "the name is interpolated on BOTH the sent and the FAILED branch — a failure that does not say which document failed is the one that most needs to");

  /* ── The page ───────────────────────────────────────────────────────────── */

  ok(/window\.ORG_CONFIG\?\.emailVariants/.test(GL),
     "gl.html reads the injected list");
  ok(!/\{ *key: *'(turnover|fees)'/.test(GL) && !/\[\['rollup'/.test(GL),
     "...and does not hardcode the vocabulary beside it");
  ok(/const showVariantPicker = emailVariantOptions\.length > 1/.test(GL),
     "the picker is ABSENT where there is only one shape to receive");
  ok(/body\.reportVariants = \{ gl: pickedVariants \}/.test(GL),
     "Subscribe sends the ticked shapes");
  ok(/variants: pickedVariants/.test(GL),
     "Send Test sends the same ticked shapes — one payload, two buttons");
  ok(/\(!showVariantPicker \|\| pickedVariants\.length > 0\)/.test(GL),
     "nothing ticked disables both buttons rather than silently mailing the rollup");
  ok(/setEmailVariants\(new Set\(\[currentVariantKey\]\)\); setShowEmailModal\(true\)/.test(GL),
     "opening the modal ticks the document currently ON SCREEN");
  ok(/const currentVariantKey = isTylerActive \? 'turnover' : isFeeActive \? 'fees' : 'rollup'/.test(GL),
     "...and 'on screen' is read from the same state the table renders from");
  ok(/feeDropsFilters/.test(GL),
     "the modal says the fee worksheet ignores the filters it cannot honour");

  ok(/variantBadges\(s\)/.test(ADMIN),
     "the admin card shows which shapes a subscription carries");
  ok(/l\.variant/.test(ADMIN),
     "...and the send log says which one actually went out");
}

/* ── The live half ──────────────────────────────────────────────────────────
   A regex over our own patch is not evidence the SERVER behaves. This boots a
   real one against a fixture store and drives the real routes: subscribe, read
   the row back, re-subscribe with fewer shapes, and run a test send with the
   Resend key unset so each send prints its STUB line. Three named stub lines is
   the whole feature, proven rather than asserted.

   SKIP_LIVE=1 drops it, so the source half can be shown to catch a regression
   on its own — and the live half was in turn seen to catch the spread trap,
   the org gate and a send that produced one email instead of three.
   ────────────────────────────────────────────────────────────────────────── */
function report() {
  if (failures.length) {
    console.error("\n" + passed + " assertions passed, " + failures.length + " FAILED.");
    process.exit(1);
  }
  console.log(passed + " assertions passed.");
}

if (process.env.SKIP_LIVE === "1") { report(); }
else (async () => {
  const { spawn } = require("child_process");
  const os = require("os");
  const http = require("http");
  const PORT = 3993, SLACK_PORT = 3994;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "variants-live-"));
  // Two orgs on purpose. One with every shape switched on, one with turnover
  // flagged off and no fee config — an org that can render only the rollup is
  // the only fixture that can show a gate doing anything.
  fs.writeFileSync(path.join(dataDir, "orgs.json"), JSON.stringify({
    variantfix: { token: "tok-variantfix-1234", orgId: "8ae77057-6bce-4c20-b0f2-366ed5fa14dd", displayName: "Variant Town" },
    plainfix:   { token: "tok-plainfix-1234",   orgId: "8ae77057-6bce-4c20-b0f2-366ed5fa14dd", displayName: "Plain Town" },
  }));
  fs.writeFileSync(path.join(dataDir, "report-settings.json"), JSON.stringify({
    variantfix: { gl: { feeAllocation: true, ccVariableBps: 350, ccFixedCents: 30, cashBps: 100, checkBps: 100, techBps: 100 } },
  }));
  fs.writeFileSync(path.join(dataDir, "tyler-orgs.json"), JSON.stringify({ plainfix: false }));

  /* A FAKE SLACK. notifySlack early-returns on an empty SLACK_WEBHOOK_URL, so
     with the webhook unset "the code mentions the label" is all anyone has
     proved — and every source form of that assertion here was satisfied by dead
     code. This captures the posts instead. */
  const slackPosts = [];
  const slack = http.createServer((rq, rs) => {
    let b = ""; rq.on("data", c => b += c);
    rq.on("end", () => { slackPosts.push(b); rs.writeHead(200); rs.end("ok"); });
  });
  await new Promise(r => slack.listen(SLACK_PORT, "127.0.0.1", r));

  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
           SLACK_WEBHOOK_URL: `http://127.0.0.1:${SLACK_PORT}/hook`,
           // Dead port: fast-fail every outbound call rather than touching
           // production Metabase, and SKIP_PREWARM so booting does not fan ~28
           // orgs out at it.
           METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
           SKIP_PREWARM: "1", PREWARM_STARTUP_SKIP_MS: "999999999", STORE_MODE: "disk" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const req = (method, p, body) => new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } },
      x => { let b = ""; x.on("data", c => b += c); x.on("end", () => res({ status: x.statusCode, body: b })); });
    r.on("error", rej); if (data) r.write(data); r.end();
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Every read goes through this: a mutation that makes a route answer with
  // something unparseable must fail BY NAME rather than killing the run with a
  // bare SyntaxError naming nothing.
  const json = (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } };

  try {
    for (let i = 0; i < 90; i++) {
      try { const r = await req("GET", "/healthz"); if (r.status === 200) break; } catch (_) {}
      await sleep(500);
    }

    const VT = "?token=tok-variantfix-1234", PT = "?token=tok-plainfix-1234";

    // The page is HANDED the shapes its org can render.
    const pg = await req("GET", "/variantfix/gl" + VT);
    const m = /"emailVariants":(\[.*?\])/.exec(pg.body);
    eq((m ? json(m[1], []) : []).map(v => v.key).join(","), "rollup,turnover,fees",
       "the injected config offers every shape this org can render");
    const pg2 = await req("GET", "/plainfix/gl" + PT);
    const m2 = /"emailVariants":(\[.*?\])/.exec(pg2.body);
    eq((m2 ? json(m2[1], []) : []).map(v => v.key).join(","), "rollup",
       "an org with turnover off and no fee config is offered ONE shape, so its picker never renders");

    // Subscribe to all three.
    const sub = await req("POST", "/variantfix/admin/subscribe" + VT, {
      email: "Dan@Rec.US", reports: ["gl"], schedule: "weekly",
      reportDateRanges: { gl: "prior7" }, reportParams: { gl: "desks=Recreation" },
      reportVariants: { gl: ["rollup", "turnover", "fees"] } });
    eq(sub.status, 200, "the subscribe route accepts a multi-shape subscription");
    let rows = json((await req("GET", "/variantfix/admin/subscribers" + VT)).body, {}).subscribers || [];
    eq(rows.length, 1, "ONE row, not one per document");
    eq(JSON.stringify(rows[0].reportVariants), '{"gl":["rollup","turnover","fees"]}',
       "...carrying all three shapes");

    // Coming back and ticking fewer UPDATES that row.
    await req("POST", "/variantfix/admin/subscribe" + VT, {
      email: "dan@rec.us", reports: ["gl"], schedule: "weekly",
      reportDateRanges: { gl: "prior7" }, reportParams: { gl: "desks=Recreation" },
      reportVariants: { gl: ["rollup", "fees"] } });
    rows = json((await req("GET", "/variantfix/admin/subscribers" + VT)).body, {}).subscribers || [];
    eq(rows.length, 1, "changing the picks UPDATES that subscription rather than minting a second");
    eq(JSON.stringify(rows[0].reportVariants), '{"gl":["rollup","fees"]}',
       "...and the old set does not survive the update branch's spread");

    // A shape the org cannot render is refused at the door.
    await req("POST", "/plainfix/admin/subscribe" + PT, {
      email: "dan@rec.us", reports: ["gl"], schedule: "weekly",
      reportDateRanges: { gl: "prior7" }, reportVariants: { gl: ["rollup", "turnover", "fees"] } });
    const prows = json((await req("GET", "/plainfix/admin/subscribers" + PT)).body, {}).subscribers || [];
    eq(JSON.stringify((prows[0] || {}).reportVariants), '{"gl":["rollup"]}',
       "a shape this org cannot render is dropped, not stored and mailed under its name");

    // The send itself. RESEND_API_KEY is unset, so each send prints a STUB line
    // naming the document — which is the assertion that no source test can make.
    log = "";
    const t = await req("POST", "/variantfix/admin/test-send" + VT, {
      email: "dan@rec.us", report: "gl", schedule: "weekly", dateRange: "prior7",
      reportParams: "desks=Recreation", variants: ["rollup", "turnover", "fees"] });
    eq(t.status, 200, "the test send is accepted");
    eq(JSON.stringify(json(t.body, {}).scope?.variants), '["rollup","turnover","fees"]',
       "...and echoes the shapes it is about to send, so the modal can say what it sent");
    for (let i = 0; i < 40 && (log.match(/\[mail\] STUB/g) || []).length < 3; i++) await sleep(250);
    const stubs = [...log.matchAll(/\[mail\] STUB — would send "([^"]+)"/g)].map(x => x[1]);
    eq(stubs.length, 3, "THREE emails go out for three ticked shapes  (" + stubs.join(" / ") + ")");
    eq(new Set(stubs).size, 3, "...each under its own name, so they are tellable apart unopened");

    const sendLog = json((await req("GET", "/variantfix/admin/subscribers" + VT)).body, {}).log || [];
    eq(sendLog.filter(l => l.variant).length, 3,
       "the send log records WHICH document went out  (" + sendLog.map(l => l.variant).join(",") + ")");
    // ── The activity feed ──
    // Three documents to one address in one minute is three sends. The default
    // debounce key would post the first and swallow the other two, and a line
    // reading "emailed gl" three times says nothing about which arrived.
    const emailPosts = slackPosts.filter(p => /emailed|email FAILED/.test(p));
    eq(emailPosts.length, 3, "three documents post THREE Slack lines, not one  (" + emailPosts.length + ")");
    ok(emailPosts.some(p => p.includes("GL Code Rollup"))
       && emailPosts.some(p => p.includes("Treasurer Turnover"))
       && emailPosts.some(p => p.includes("Remittance Fee Allocation")),
       "...each NAMING the document that went out");
  } catch (e) {
    failures.push("the live half THREW: " + e.message);
    console.error("  ✗ the live half THREW: " + e.message);
    console.error(log.slice(-1500));
  } finally {
    child.kill("SIGTERM");
    try { slack.close(); } catch (_) {}
  }
  // The summary print must be the LAST thing that runs, or every assertion
  // above it increments a count nobody sees. Third instance of that in this
  // repo.
  report();
})();
