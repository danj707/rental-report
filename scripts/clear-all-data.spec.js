/* clear-all-data.spec.js — the nuclear option on the two reports that WRITE.

   Dan, 2026-09-23: *"we need a 'clear all data' nuclear option for each
   report. Button option somewhere at the top, has a confirmation, 'type
   DELETE to delete all data' type double confirmation box."*

   THE LIVE HALF IS THE POINT. Every claim worth making here is about what a
   ROUTE does when it is driven — that it refuses without the typed word, that
   it refuses without the token, that it actually empties the store, and that
   the destruction reaches Slack. A regex over our own patch is not evidence
   the server behaves, and this is the one feature on the platform whose
   failure mode is an org's data being gone when it should not be, or still
   there when a reader has been told it is not.

   IT STANDS UP A FAKE SLACK, for the recorded reason: notifySlack early-returns
   on an empty SLACK_WEBHOOK_URL, so with the webhook unset "the code mentions
   the event" is all anyone has proved. The Slack record is what PAYS for this
   being gated on the org token alone, so it is asserted on the captured post.

   SKIP_SOURCE=1 drops the source assertions; SKIP_LIVE=1 drops the live half. */
"use strict";
const fs = require("fs");
const path = require("path");

let passed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else failures.push(msg); }
function guard(name, fn) { try { fn(); } catch (e) { failures.push(name + " THREW: " + e.message); } }

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

/* ── source: the wiring no live request can see ─────────────────────────── */
if (!process.env.SKIP_SOURCE) guard("source", () => {
  const srv  = read("server.js");
  const dlg  = read("public/clear-all.js");
  const cr   = read("public/cost-recovery.html");
  const inv  = read("public/inventory.html");

  /* THE TYPED WORD IS A SERVER GATE. A dialog stops a misclick; it cannot stop
     a replayed POST, a script holding the org token, or a build shipped with
     the dialog removed. The live half drives this; the source assertion is
     what names it as deliberate. */
  ok(/const CLEAR_WORD = "DELETE";/.test(srv), "the confirmation word is DELETE, declared once on the server");
  const route = srv.slice(srv.indexOf("function clearAllRoute("), srv.indexOf('app.post("/:org/cost-recovery/api/clear-all"'));
  ok(route.length > 200, "clearAllRoute was found (or every assertion below is vacuous)");
  ok(/!== CLEAR_WORD/.test(route) && /status\(400\)/.test(route), "the route REFUSES without the typed word — the dialog is not the gate");
  ok(/ORGS\[slug\]\.token && supplied !== ORGS\[slug\]\.token/.test(route), "…and refuses without the org token");
  ok(route.indexOf("spec.count(slug)") < route.indexOf("spec.clear(slug)"),
     "the counts are taken BEFORE the clear — counted after, every figure it reports is zero");

  /* ONE ROUTE FACTORY, TWO REPORTS. Two hand-written handlers is how one of
     them ends up missing the typed word. */
  ok(/app\.post\("\/:org\/cost-recovery\/api\/clear-all",[^\n]*clearAllRoute\("cost-recovery"\)\)/.test(srv),
     "cost-recovery's clear route goes through the shared factory");
  ok(/app\.post\("\/:org\/inventory\/api\/clear-all",[^\n]*clearAllRoute\("inventory"\)\)/.test(srv),
     "inventory's clear route goes through the shared factory");

  const clearable = srv.slice(srv.indexOf("const CLEARABLE = {"), srv.indexOf("function clearAllRoute("));
  ok(clearable.length > 200, "the CLEARABLE registry was found");
  /* COST RECOVERY HAS TWO STORES AND ONE BUTTON. "Clear all data" has to mean
     all of it; clearing only the costs leaves the reader doing arithmetic
     about what survived the nuclear option. */
  ok(/writeCostStore\(/.test(clearable) && /writeLedgerStore\(/.test(clearable),
     "clearing Cost Recovery clears BOTH stores — the program costs and the overhead ledger");
  ok(/writeInventory\(slug, INVENTORY\.emptyState\(\)\)/.test(clearable),
     "clearing Inventory writes the empty state, so the catalogue re-ingests on the next sync");

  /* NEVER DEBOUNCED. Every other key collapses a burst into one line, which is
     right for a save and wrong for a destruction. */
  ok(/rec\.event === "data-cleared"\s*\n\s*\? `\$\{rec\.org\}\|\$\{rec\.report\}\|data-cleared\|\$\{rec\.ts\}`/.test(srv),
     "the Slack debounce key carries the record's own timestamp, so a clear is never swallowed");
  const notify = srv.slice(srv.indexOf("const SLACK_NOTIFY = new Set(["), srv.indexOf("]);", srv.indexOf("const SLACK_NOTIFY = new Set([")));
  ok(notify.length > 200 && /"data-cleared"/.test(notify), "data-cleared is in SLACK_NOTIFY (a logged event that posts nothing is the trap this repo has hit five times)");
  ok(/} else if \(rec\.event === "data-cleared"\) {/.test(srv),
     "…with its OWN message branch — the shared line prints the report type and never what was destroyed");

  /* ONE DIALOG, TWO PAGES. */
  ok(/<script src="\/clear-all\.js"><\/script>/.test(cr), "cost-recovery.html loads the shared dialog");
  ok(/<script src="\/clear-all\.js"><\/script>/.test(inv), "inventory.html loads the shared dialog");
  ok(/id="clearAllSlot"/.test(cr) && /id="clearAllSlot"/.test(inv), "both pages carry the mount point");
  ok(/window\.RecClearAll\.mount\(/.test(cr) && /window\.RecClearAll\.mount\(/.test(inv), "…and both mount through it rather than growing their own");
  // The mount point is inside the TOOLBAR on both pages — Dan asked for the
  // button at the top, and the toolbar is the top.
  const crBar = cr.slice(cr.indexOf('<div class="toolbar">'), cr.indexOf('<div class="page">'));
  const inBar = inv.slice(inv.indexOf('<div class="toolbar">'), inv.indexOf('<div class="page">'));
  ok(crBar.length > 100 && /id="clearAllSlot"/.test(crBar), "cost-recovery's button is IN the toolbar, at the top of the report");
  ok(inBar.length > 100 && /id="clearAllSlot"/.test(inBar), "inventory's button is IN the toolbar, at the top of the report");

  /* THE DIALOG'S OWN RULES. */
  /* SCOPED TO THE FOOTER IT IS ABOUT. A bare /go\.disabled = true/ is also
     satisfied by the click handler's own line, so "the button is enabled from
     the start" — the single most important behaviour here — SURVIVED this
     assertion. Found by mutation. And no source assertion can settle it
     anyway: a disabled button and a live one are the same markup until a
     browser renders them, which is what
     `cost-recovery · the nuclear option asks twice` is for. */
  const foot = dlg.slice(dlg.indexOf('var foot = el("div", "clr-foot");'), dlg.indexOf("box.appendChild(foot);"));
  ok(foot.length > 100, "the dialog's footer block was found (or the assertion below is vacuous)");
  ok(/go\.disabled = true;/.test(foot), "the delete button is rendered DISABLED — the typed word is the second confirmation");
  ok(/go\.disabled = inp\.value !== WORD;/.test(dlg), "…and only the exact word enables it");
  ok(/if \(inp\.value !== WORD\) return;/.test(dlg), "…and the handler re-checks it");
  ok(/document\.body\.appendChild\(back\)/.test(dlg),
     "the dialog is portalled to <body> — inside a toolbar it inherits text-transform, colour and flex-direction (the recorded aquatics-sheet failure)");
  ok(/opts\.beforeClear/.test(dlg),
     "there is a beforeClear hook — a save queued 700ms ago would land AFTER the wipe and write the data straight back");
  ok(/err\.textContent = e\.message/.test(dlg) && /go\.disabled = false/.test(dlg),
     "a FAILED clear says so and stays open — closing on an error tells a reader their data is gone when it is not");
  ok(!/innerHTML/.test(dlg), "the dialog writes text with textContent, never innerHTML");

  // The page that has a debounced save queue must use the hook.
  const crMount = cr.slice(cr.indexOf("window.RecClearAll.mount({"), cr.indexOf("\n  load();", cr.indexOf("window.RecClearAll.mount({")));
  ok(crMount.length > 200, "cost-recovery's mount call was found");
  // NOTE the slice bound is "\n  load();" and not "load();": the latter is a
  // SUBSTRING of "location.reload();", so it cut the slice short and made the
  // reload assertion below fail on correct code. Nth instance of a slice
  // pinned to a neighbour's spelling.
  ok(/beforeClear:/.test(crMount) && /clearTimeout\(saveTimer\)/.test(crMount) && /dirty = \{\}/.test(crMount) && /ledgerDirty = \{\}/.test(crMount),
     "cost-recovery cancels its save timer and drops BOTH dirty queues before clearing");
  ok(/location\.reload\(\)/.test(crMount), "…and reloads rather than re-deriving the page's state by hand");
});

/* ── live: drive the real routes on both reports ────────────────────────── */
async function live() {
  const { spawn } = require("child_process");
  const http = require("http"), os = require("os");
  const PORT = 3860 + (process.pid % 50), MB_PORT = PORT + 60, SLACK_PORT = PORT + 120;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearall-"));
  fs.writeFileSync(path.join(dataDir, "prewarm-state.json"), JSON.stringify({ lastCompletedAt: new Date().toISOString() }));
  const ORG_ID = "bbbbbbbb-1111-2222-3333-555555555555", TOKEN = "specClearToken01";
  fs.writeFileSync(path.join(dataDir, "orgs.json"), JSON.stringify({
    "spec-clear": { token: TOKEN, orgId: ORG_ID, logoUrl: "", displayName: "Spec Clear Parks" },
  }));

  const posts = [];
  const slack = http.createServer((req, res) => {
    let b = ""; req.on("data", d => b += d);
    req.on("end", () => { try { posts.push(JSON.parse(b)); } catch (_) {} res.writeHead(200); res.end("ok"); });
  });
  await new Promise(r => slack.listen(SLACK_PORT, "127.0.0.1", r));

  const CAT = [
    { "Row Kind": "item", "Product ID": "snk", Name: "Snickers", "Product Type": "product", "Price Cents": 200, "In Store": true },
    { "Row Kind": "item", "Product ID": "gat", Name: "Gatorade", "Product Type": "product", "Price Cents": 300, "In Store": true },
  ];
  const mbSrv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (/^\/api\/public\/card\/spec-clr-uuid\/query\/json/.test(req.url)) return send(CAT);
    if (/^\/api\/public\/card\/spec-clr-uuid/.test(req.url))
      return send({ id: 22144, parameters: [
        { id: "p1", slug: "org_id", type: "category", target: ["variable", ["template-tag", "org_id"]] },
        { id: "p2", slug: "since",  type: "category", target: ["variable", ["template-tag", "since"]] }] });
    res.writeHead(404); res.end("{}");
  });
  await new Promise(r => mbSrv.listen(MB_PORT, "127.0.0.1", r));

  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: `http://127.0.0.1:${MB_PORT}`,
           MB_INVENTORY_UUID: "spec-clr-uuid", RESEND_API_KEY: "", DASHBOARD_PASSWORD: "",
           SLACK_WEBHOOK_URL: "http://127.0.0.1:" + SLACK_PORT + "/hook",
           RAILWAY_ENVIRONMENT_NAME: "production",
           SKIP_PREWARM: "1", PREWARM_STARTUP_SKIP_MS: "999999999" },
    stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);

  const safe = (b) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
  const req_ = (method, p_, body) => new Promise(r => {
    const data = body == null ? null : JSON.stringify(body);
    const h = data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {};
    const rq = http.request({ host: "127.0.0.1", port: PORT, path: p_, method, headers: h }, res => {
      let b = ""; res.on("data", d => b += d); res.on("end", () => r({ status: res.statusCode, body: b, json: safe(b) }));
    });
    rq.on("error", e => r({ status: 0, body: String(e), json: {} }));
    if (data) rq.write(data); rq.end();
  });
  const q = "?token=" + TOKEN;
  const settle = () => new Promise(r => setTimeout(r, 350));

  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { await new Promise(r => setTimeout(r, 250)); up = (await req_("GET", "/healthz")).status === 200; }
    ok(up, "the server booted" + (up ? "" : " — log: " + log.slice(-400)));

    /* ── Cost Recovery ──────────────────────────────────────────────── */
    await req_("PUT", "/spec-clear/cost-recovery/api/costs" + q, {
      costs: { "p1|Fall '26": { instructors: 50000, tier: 2 }, "p2|Fall '26": { supplies: 1200 } } });
    await req_("PUT", "/spec-clear/cost-recovery/api/ledger" + q, {
      rows: { r1: { account: "Admin", label: "Insurance", amount: 90000, kind: "expense" } } });
    const before = (await req_("GET", "/spec-clear/cost-recovery/api/costs" + q)).json;
    ok(before.count === 2, "two program costs are stored to begin with (got " + before.count + ")");
    ok((await req_("GET", "/spec-clear/cost-recovery/api/ledger" + q)).json.count === 1, "…and one ledger row");

    // THE REFUSALS, each proven to leave the data alone.
    /* TOKENLESS IS A 404, NOT A 403, and that is the org-token middleware
       ahead of every /:org/* path — it answers a generic 404 rather than
       leaking that the org exists. A wrong token is the same 404 for the same
       reason. The route carries its own token check underneath as a backstop
       (source-asserted above); the middleware reads the QUERY only, so the
       body's copy of the token can never be what gets a caller in. */
    ok((await req_("POST", "/spec-clear/cost-recovery/api/clear-all", { confirm: "DELETE", token: TOKEN })).status === 404,
       "no token in the URL is a 404 — the org's existence is not leaked, and the body's token does not let a caller past");
    ok((await req_("POST", "/spec-clear/cost-recovery/api/clear-all?token=wrongtoken00001", { confirm: "DELETE" })).status === 404,
       "a wrong token is the same generic 404");
    const noWord = await req_("POST", "/spec-clear/cost-recovery/api/clear-all" + q, {});
    ok(noWord.status === 400, "…and refuses with no confirmation word (got " + noWord.status + ")");
    const lower = await req_("POST", "/spec-clear/cost-recovery/api/clear-all" + q, { confirm: "delete" });
    ok(lower.status === 400, "…and refuses the lower-case word — 'delete' is what somebody types by reflex");
    ok((await req_("GET", "/spec-clear/cost-recovery/api/costs" + q)).json.count === 2,
       "after three refusals the costs are STILL THERE — a refusal that half-cleared would be the worst outcome here");

    posts.length = 0;
    const cleared = await req_("POST", "/spec-clear/cost-recovery/api/clear-all" + q, { confirm: "DELETE" });
    ok(cleared.status === 200 && cleared.json.ok === true, "the typed word clears it (got " + cleared.status + ")");
    ok(cleared.json.destroyed === 3, "…and reports what it destroyed: 2 costs + 1 ledger row = 3 (got " + cleared.json.destroyed + ")");
    ok(/2 program costs/.test(cleared.json.what || "") && /1 overhead & other row\b/.test(cleared.json.what || ""),
       "…named, and singular/plural right: " + JSON.stringify(cleared.json.what));
    ok((await req_("GET", "/spec-clear/cost-recovery/api/costs" + q)).json.count === 0, "the program costs are gone");
    ok((await req_("GET", "/spec-clear/cost-recovery/api/ledger" + q)).json.count === 0,
       "AND the overhead ledger is gone — one button, both stores");

    await settle();
    const p1 = posts.map(p => p.text || "").filter(t => /CLEARED ALL DATA/.test(t));
    ok(p1.length === 1, "the clear posted to Slack exactly once (got " + p1.length + ")");
    ok(/spec-clear/.test(p1[0] || ""), "…naming the org");
    ok(/Cost Recovery/.test(p1[0] || ""), "…naming the report by its LABEL, not its slug");
    ok(/2 program costs/.test(p1[0] || ""), "…and saying what was destroyed: " + JSON.stringify((p1[0] || "").slice(0, 160)));

    // Idempotent, and a second press is NOT swallowed by the debounce.
    posts.length = 0;
    const again = await req_("POST", "/spec-clear/cost-recovery/api/clear-all" + q, { confirm: "DELETE" });
    ok(again.status === 200 && again.json.destroyed === 0, "clearing an already-empty report is a no-op that still answers ok");
    await settle();
    ok(posts.filter(p => /CLEARED ALL DATA/.test(p.text || "")).length === 1,
       "…and it STILL posts — a destructive event is never debounced away");

    // The store survives it: a save after a clear works normally.
    await req_("PUT", "/spec-clear/cost-recovery/api/costs" + q, { costs: { "p9|Winter '26": { staff: 7700 } } });
    ok((await req_("GET", "/spec-clear/cost-recovery/api/costs" + q)).json.count === 1,
       "the report still works after being cleared — a wipe is not a one-way door for the org");

    /* ── Inventory ──────────────────────────────────────────────────── */
    const s1 = (await req_("GET", "/spec-clear/inventory/api/state" + q)).json;
    ok((s1.items || []).length === 2, "inventory ingested its catalogue (got " + (s1.items || []).length + ")");
    await req_("POST", "/spec-clear/inventory/api/count" + q, { id: "snk", qty: 14 });
    await req_("POST", "/spec-clear/inventory/api/item" + q, { id: "snk", reorder: 6, upc: "040000424314" });
    // A second ledger line, so the plural is exercised as well as the singular.
    await req_("POST", "/spec-clear/inventory/api/receive" + q, { id: "snk", qty: 6 });
    const s2 = (await req_("GET", "/spec-clear/inventory/api/state" + q)).json;
    const snk2 = (s2.items || []).find(i => i.id === "snk") || {};
    ok(snk2.onHand === 20 && snk2.upc === "040000424314", "…with a count, a delivery and a barcode on it (14 + 6 = 20, got " + snk2.onHand + ")");

    ok((await req_("POST", "/spec-clear/inventory/api/clear-all" + q, { confirm: "nope" })).status === 400,
       "inventory refuses the wrong word too — the gate is the factory's, not one handler's");
    posts.length = 0;
    const ic = await req_("POST", "/spec-clear/inventory/api/clear-all" + q, { confirm: "DELETE" });
    ok(ic.status === 200 && ic.json.destroyed >= 3, "inventory clears, reporting items AND ledger lines (got " + ic.json.destroyed + ")");
    ok(/2 items/.test(ic.json.what || "") && /ledger lines/.test(ic.json.what || "") && !/entrys|deliverys/.test(ic.json.what || ""),
       "…named, and the plural is a word: " + JSON.stringify(ic.json.what));
    const onDisk = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, "inventory", "spec-clear.json"), "utf8")); } catch { return null; } })();
    ok(onDisk && Object.keys(onDisk.items || {}).length === 0, "the stored state is empty on disk, not merely hidden from the view");
    await settle();
    ok(posts.filter(p => /CLEARED ALL DATA/.test(p.text || "") && /Inventory/.test(p.text || "")).length === 1,
       "…and Slack names Inventory");

    /* THE CATALOGUE COMES BACK; THE COUNT DOES NOT. This is the asymmetry the
       typed word exists to protect, and it is only visible end to end. */
    const s3 = (await req_("GET", "/spec-clear/inventory/api/state" + q)).json;
    const snk3 = (s3.items || []).find(i => i.id === "snk") || {};
    ok((s3.items || []).length === 2, "re-opening re-ingests the catalogue from Rec (got " + (s3.items || []).length + ")");
    ok(snk3.onHand === null, "…but the physical count is GONE — on-hand is null, not 14");
    ok(!snk3.upc, "…and so are the barcode and the reorder point");
  } finally {
    child.kill("SIGKILL"); mbSrv.close(); slack.close();
  }
}

(async () => {
  if (!process.env.SKIP_LIVE) { try { await live(); } catch (e) { failures.push("live half THREW: " + e.message); } }
  if (failures.length) { failures.forEach(f => console.error("✗ " + f)); console.error(passed + " assertions passed, " + failures.length + " FAILED."); process.exit(1); }
  console.log(passed + " assertions passed.");
})();
