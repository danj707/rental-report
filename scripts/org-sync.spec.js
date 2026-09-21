// Spec for the cross-project org sync, and for the credential leak found while
// building it.
//
// THE LEAK (confirmed against production, 2026-09-21). All three sync routes
// were completely open. `GET /api/admin/org/:slug` answered an unauthenticated
// caller with the org's ACCESS TOKEN — the only thing standing in front of every
// report that org has: rosters carrying children's names and their parents'
// email addresses, GL revenue, resident contact lists. Slugs are city names.
// `POST /api/admin/add-org` would, to anyone, mint an org carrying any rec.us
// orgId with a token of the caller's own choosing; `POST /api/admin/new-org`
// would create one AND push a commit to main, and a push to main is a deploy.
//
// WHAT THIS PINS:
//
// 1. A TOKEN IS NEVER HANDED TO AN UNAUTHENTICATED CALLER, on either lookup.
//    Existence, slug and orgId still are — that is what rec-dashboard's
//    slug-drift repair reads, none of it is a credential, and keeping it open is
//    what lets the leak close on deploy without an environment variable being
//    set first and without anything over there breaking.
// 2. EVERY WRITE IS GATED, AND FAILS CLOSED. An unset secret authorises nothing.
// 3. THE orgId IS THE IDENTITY. add-org adopts it when we hold none — it used to
//    silently DROP it, which left a wrong orgId unrepairable — and REFUSES to
//    change one it already holds, because repointing a slug serves another
//    organisation's reports under this name.
// 4. THE PUSH RECONCILES ON THE orgId, NEVER THE SLUG. The two projects name the
//    same organisation differently; a by-slug check says "not there" for an org
//    that is, and the push then mints the duplicate that broke Shrewsbury.
// 5. A FAILED PUSH IS QUEUED, NOT LOST. Fire-and-forget would leave the two
//    projects out of step forever and silently — the bug this feature exists to
//    fix, arriving by a different door.
//
// SKIP_SOURCE=1 drops the source half; SKIP_LIVE=1 drops the live half. Each
// alone was seen to catch the leak.
//
// Run: node scripts/org-sync.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); } }
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); } }

// Slice a region so an assertion is about the thing it names. A file-wide regex
// over a 24,000-line server passes on any other occurrence — the recurring
// "satisfied by different code" defect in this repo.
function slice(a, b) {
  const i = src.indexOf(a);
  assert.ok(i > 0, `server.js should contain ${a}`);
  const j = src.indexOf(b, i + a.length);
  assert.ok(j > i, `could not find the end of ${a}`);
  return src.slice(i, j);
}

if (!process.env.SKIP_SOURCE) {
  console.log("\n— source —");

  test("the token is gated behind orgSyncAuthOk, in ONE payload builder", () => {
    const f = slice("function orgLookupPayload(", "\n}");
    ok(/if \(authed\) out\.token = org\.token;/.test(f),
      "orgLookupPayload must only attach the token when authed");
    ok(/tokenWithheld/.test(f),
      "a withheld token must say so — absent and forbidden are different facts");
    // Both lookups must go through it. Two copies is two chances to leak.
    const n = (src.match(/orgLookupPayload\(slug, org, orgSyncAuthOk\(req\)\)/g) || []).length;
    ok(n === 2, `both lookups must build their reply through orgLookupPayload (found ${n})`);
    ok(!/res\.json\(\{\s*\n?\s*exists: true,[\s\S]{0,300}?token: org\.token/.test(src),
      "no lookup may hand back org.token directly any more");
  });

  test("orgSyncAuthOk fails closed and cannot throw on a wrong-length secret", () => {
    const f = slice("function orgSyncAuthOk(req) {", "\n}");
    ok(/if \(!ORG_SYNC_SECRET\) return false;/.test(f),
      "an unset secret must authorise nothing");
    // timingSafeEqual throws on a length mismatch; without the length test a
    // wrong-length secret is a 500 rather than a 401.
    ok(/got\.length === want\.length && crypto\.timingSafeEqual/.test(f),
      "the length test must come before timingSafeEqual");
    ok(/adminPasswordOk\(req\)/.test(f),
      "the admin password must also work, or a by-hand repair is impossible");
  });

  test("every write route is gated", () => {
    const add = slice('app.post("/api/admin/add-org"', "\n});");
    ok(/if \(!orgSyncAuthOk\(req\)\)/.test(add), "add-org must check orgSyncAuthOk");
    const neworg = slice('app.post("/api/admin/new-org"', "const { slug, displayName");
    ok(/if \(!adminPasswordOk\(req\)\)/.test(neworg),
      "new-org must check the password itself — dashboardAuth only guards \"/\"");
  });

  test("add-org adopts a missing orgId and refuses to repoint one it holds", () => {
    const add = slice('app.post("/api/admin/add-org"', "\n});");
    ok(/ORGS\[slug\]\.orgId && ORGS\[slug\]\.orgId !== orgId/.test(add) && /409/.test(add),
      "a conflicting orgId must be refused, not overwritten");
    ok(/if \(!ORGS\[slug\]\.orgId\) \{\s*\n\s*ORGS\[slug\]\.orgId = orgId;/.test(add),
      "a missing orgId must be adopted — dropping it is the bug this fixes");
    // The dynamic write dropped orgId too, so a restart undid the adoption.
    ok(/Object\.assign\(dynamic\[slug\], \{ token, orgId,/.test(add),
      "the persisted copy must carry orgId, or the adoption is lost on restart");
    // A STATIC org must not be written to orgs.json: loadDynamicOrgs does
    // Object.assign(ORGS, dynamic), so this partial copy would shadow the code
    // entry on the next boot and take every per-report mbUuid with it.
    ok(/if \(dynamic && dynamic\[slug\]\)/.test(add),
      "only an org already in orgs.json may be written back");
  });

  test("the push reconciles on the orgId, never the slug", () => {
    const f = slice("async function syncOrgToDashboard(", "\n}");
    ok(/org-by-id\/\$\{encodeURIComponent\(org\.orgId\)\}/.test(f),
      "the existence probe must be by orgId");
    ok(!/admin\/org\/\$\{encodeURIComponent\(slug\)\}/.test(f),
      "a by-slug probe is what mints the duplicate");
    ok(/if \(found && found\.exists\) return \{ action: "already-there"/.test(f),
      "an org already there must not be added again");
    ok(/AbortSignal\.timeout/.test(f),
      "a create must not hang on the other project being slow or gone");
  });

  test("a failed push is queued and retried under the leader lock", () => {
    const f = slice("async function pushOrgToDashboard(", "\n}");
    ok(/queueDashboardSync\(slug, e\.message\)/.test(f), "a failure must be queued");
    ok(/unqueueDashboardSync\(slug\)/.test(f), "a success must clear the queue");
    const cron = slice('cron.schedule("*/20 * * * *", leaderCron("dashboard-org-sync"', "\n}));");
    ok(/leaderCron\("dashboard-org-sync"/.test(cron),
      "two replicas retrying the same queue is two pushes of the same org");
    ok(/if \(!org\) \{ unqueueDashboardSync\(slug\); continue; \}/.test(cron),
      "an org deleted since it was queued must be dropped, not pushed");
  });

  test("new-org awaits the push and reports it, and cannot be failed by it", () => {
    const f = slice("console.log(`[new-org] Created org:", "\n});");
    ok(/const dashboardSync = await pushOrgToDashboard\(slug, orgEntry\)/.test(f),
      "the push must be awaited — the person who clicked is the watcher");
    ok(/res\.json\(\{ ok: true, slug, reports: [^}]*dashboardSync \}\)/.test(f),
      "the outcome must reach whoever pressed the button");
    // pushOrgToDashboard swallows its own errors, so the create cannot fail.
    ok(/catch \(e\) \{\s*\n\s*queueDashboardSync/.test(slice("async function pushOrgToDashboard(", "\n}")),
      "the push must never be the reason an org creation fails");
  });

  test("the Slack event is wired on BOTH lists, and is not counted as usage", () => {
    ok(/const SLACK_NOTIFY = new Set\(\[[^\]]*"org-synced"/.test(src),
      "org-synced missing from SLACK_NOTIFY is logged and never posted");
    ok(/"org-synced": \{ emoji:/.test(src), "org-synced needs its own message meta");
    const nu = slice("const NON_USAGE_EVENTS = new Set([", "]);");
    ok(/"org-synced"/.test(nu),
      "syncing an org is not somebody reading a report");
  });
}

// ── LIVE ────────────────────────────────────────────────────────────────────
// A regex over our own patch is not evidence the server behaves. This boots the
// real server against a STAND-IN rec-dashboard and drives the real routes.
if (!process.env.SKIP_LIVE) {
  const { spawn } = require("child_process");
  const http = require("http"), os = require("os");
  const PORT = 3860 + (process.pid % 60);
  const DASH_PORT = PORT + 1;
  const SECRET = "spec-secret-" + Date.now();
  const PW = "spec-pw-" + Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orgsync-"));
  fs.writeFileSync(path.join(dataDir, "prewarm-state.json"),
    JSON.stringify({ lastCompletedAt: new Date().toISOString() }));

  /* A dynamic org carrying NO orgId — the shape add-org used to be unable to
     repair, because it dropped the field and new-org refuses a taken slug. It
     has to be seeded on disk: there is no route that can create one. */
  fs.writeFileSync(path.join(dataDir, "orgs.json"), JSON.stringify({
    "spec-noid": { token: "specTokenNoId01", logoUrl: "", displayName: "Spec No Id" },
    "spec-other": { token: "specTokenOther1", orgId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
                    logoUrl: "", displayName: "Spec Other" },
  }, null, 2));

  // ── the stand-in rec-dashboard ──
  const dash = { orgs: {}, addCalls: [], probeCalls: [], secrets: [], fail: false };
  const dashSrv = http.createServer((req, res) => {
    const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (dash.fail) return send(500, { error: "dashboard is down" });
    dash.secrets.push(req.headers["x-org-sync-secret"] || null);
    let bySlug = /^\/api\/admin\/org\/([^/?]+)/.exec(req.url);
    if (bySlug) {
      const slug = decodeURIComponent(bySlug[1]);
      const o = dash.orgs[slug];
      return send(200, o ? { exists: true, slug, orgId: o.orgId, token: o.token } : { exists: false });
    }
    let m = /^\/api\/admin\/org-by-id\/([^/?]+)/.exec(req.url);
    if (m) {
      const orgId = decodeURIComponent(m[1]);
      dash.probeCalls.push(orgId);
      const hit = Object.entries(dash.orgs).find(([, o]) => o.orgId === orgId);
      return send(200, hit ? { exists: true, slug: hit[0], orgId, token: hit[1].token } : { exists: false });
    }
    if (req.url.startsWith("/api/admin/add-org")) {
      let b = ""; req.on("data", d => b += d);
      return req.on("end", () => {
        const o = JSON.parse(b || "{}");
        dash.addCalls.push(o);
        dash.orgs[o.slug] = o;
        send(200, { ok: true, action: "created", slug: o.slug });
      });
    }
    send(404, { error: "no" });
  });

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
           DASHBOARD_PASSWORD: PW, ORG_SYNC_SECRET: SECRET,
           DASHBOARD_BASE_URL: `http://127.0.0.1:${DASH_PORT}`,
           METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
           SKIP_PREWARM: "1", PREWARM_STARTUP_SKIP_MS: "999999999" },
    stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});

  const req_ = (method, p_, { headers = {}, body = null } = {}) => new Promise(r => {
    const data = body == null ? null : JSON.stringify(body);
    const h = { ...headers };
    if (data) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    const rq = http.request({ host: "127.0.0.1", port: PORT, path: p_, method, headers: h }, res => {
      let b = ""; res.on("data", d => b += d);
      res.on("end", () => r({ status: res.statusCode, body: b, json: safe(b) }));
    });
    rq.on("error", e => r({ status: 0, body: String(e), json: {} }));
    if (data) rq.write(data);
    rq.end();
  });
  /* Read through a SAFE parse: a mutation that stops the server booting makes
     JSON.parse throw on "connect ECONNREFUSED" and the spec DIES naming nothing
     instead of failing on the assertion that provoked it. */
  const safe = (b) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
  const get = (p_, headers) => req_("GET", p_, { headers });
  const post = (p_, body, headers) => req_("POST", p_, { body, headers });
  const withSecret = { "x-org-sync-secret": SECRET };
  const withPw = { authorization: "Basic " + Buffer.from("admin:" + PW).toString("base64") };

  (async () => {
    await new Promise(r => dashSrv.listen(DASH_PORT, "127.0.0.1", r));
    for (let i = 0; i < 120; i++) { if ((await get("/healthz")).status) break; await new Promise(s => setTimeout(s, 400)); }
    console.log("\n— live —");

    // ── 1. THE LEAK ──
    const anon = await get("/api/admin/org/spec-other");
    ok(anon.json.exists === true, "the lookup still answers for an unauthenticated caller");
    ok(anon.json.token === undefined,
      `THE LEAK: /api/admin/org/:slug handed a token to an unauthenticated caller (${anon.json.token})`);
    ok(anon.json.tokenWithheld === true, "a withheld token must say so");
    ok(anon.json.orgId === "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "orgId stays open — it is not a credential and slug-drift repair reads it");
    console.log("  ✓ an unauthenticated lookup gets existence and orgId but NO token");

    const byId = await get("/api/admin/org-by-id/cccccccc-cccc-cccc-cccc-cccccccccccc");
    ok(byId.json.exists === true && byId.json.token === undefined,
      "THE LEAK: org-by-id handed a token to an unauthenticated caller");
    console.log("  ✓ org-by-id withholds the token too");

    const auth1 = await get("/api/admin/org/spec-other", withSecret);
    ok(auth1.json.token === "specTokenOther1", "the secret must unlock the token");
    const auth2 = await get("/api/admin/org/spec-other", withPw);
    ok(auth2.json.token === "specTokenOther1", "the admin password must unlock it too");
    console.log("  ✓ the secret and the admin password each unlock the token");

    // ── 2. WRITES ARE GATED ──
    const NEWID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const refused = await post("/api/admin/add-org",
      { slug: "spec-intruder", token: "attackerToken01", orgId: NEWID });
    ok(refused.status === 401, `add-org must refuse an unauthenticated write (got ${refused.status})`);
    ok((await get("/api/admin/org/spec-intruder")).json.exists === false,
      "the refused org must not exist — a 401 that still wrote would be worse than none");
    console.log("  ✓ add-org refuses an unauthenticated write, and writes nothing");

    const created = await post("/api/admin/add-org",
      { slug: "spec-new", token: "specTokenNew001", orgId: NEWID }, withSecret);
    ok(created.status === 200 && created.json.action === "created", "add-org with the secret creates");
    console.log("  ✓ add-org with the secret creates the org");

    // ── 3. THE orgId IS THE IDENTITY ──
    const adopted = await post("/api/admin/add-org",
      { slug: "spec-noid", token: "specTokenNoId01", orgId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" }, withSecret);
    ok(adopted.status === 200, "an org holding no orgId must be repairable");
    ok((await get("/api/admin/org/spec-noid")).json.orgId === "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "THE RECORDED GAP: add-org silently dropped orgId, leaving a wrong one unrepairable");
    console.log("  ✓ a missing orgId is adopted");

    const repoint = await post("/api/admin/add-org",
      { slug: "spec-other", token: "specTokenOther1", orgId: NEWID }, withSecret);
    ok(repoint.status === 409, `repointing a slug at another organisation must be refused (got ${repoint.status})`);
    ok((await get("/api/admin/org/spec-other")).json.orgId === "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "the refused repoint must not have taken effect");
    console.log("  ✓ repointing an existing org at a different organisation is refused");

    // ── 4. THE PUSH ──
    const nAdds = dash.addCalls.length;
    const nOrg = await post("/api/admin/new-org", {
      slug: "spec-pushed", displayName: "Spec Pushed",
      orgId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      logoUrl: "https://example.test/logo.png", reports: { gl: "11111111-2222-3333-4444-555555555555" },
    }, withPw);
    ok(nOrg.status === 200, `new-org with the password must work (got ${nOrg.status} ${nOrg.body.slice(0,120)})`);
    ok(dash.addCalls.length === nAdds + 1,
      "THE ASK: an org created here must be created in rec-dashboard too");
    const pushed = dash.addCalls[dash.addCalls.length - 1];
    ok(pushed && pushed.slug === "spec-pushed" && pushed.orgId === "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "the push must carry the slug and orgId");
    ok(!!pushed.token, "the push must carry the token, or the org is born unreachable over there");
    ok(dash.secrets.filter(Boolean).length > 0, "the push must be authenticated");
    ok(nOrg.json.dashboardSync && nOrg.json.dashboardSync.action === "created",
      "the outcome must be reported to whoever pressed the button");
    console.log("  ✓ creating an org here creates it in rec-dashboard, and says so");

    const unauthNew = await post("/api/admin/new-org", {
      slug: "spec-nope", orgId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      logoUrl: "x", reports: { gl: "11111111-2222-3333-4444-555555555555" } });
    ok(unauthNew.status === 401,
      `new-org must refuse an unauthenticated caller — it pushes a commit to main (got ${unauthNew.status})`);
    console.log("  ✓ new-org refuses an unauthenticated caller");

    // ── 5. NO DUPLICATE: the dashboard already has it under ANOTHER slug ──
    // This is Shrewsbury. A by-slug probe says "not there" and the push mints a
    // second identity for the same organisation.
    const DRIFT = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    dash.orgs["their-name-for-it"] = { orgId: DRIFT, token: "theirToken00001" };
    const before = dash.addCalls.length;
    const drifted = await post("/api/admin/new-org", {
      slug: "our-name-for-it", displayName: "Drifted", orgId: DRIFT,
      logoUrl: "x", reports: { gl: "11111111-2222-3333-4444-555555555555" },
    }, withPw);
    ok(drifted.status === 200, "the create must still succeed");
    ok(dash.addCalls.length === before,
      "SHREWSBURY: the org is already there under another slug — pushing it again mints a duplicate");
    ok(drifted.json.dashboardSync && drifted.json.dashboardSync.action === "already-there",
      "and the outcome must say so rather than claiming a create");
    console.log("  ✓ an org already there under another slug is not added again");

    // ── 6. A FAILED PUSH IS QUEUED, NOT LOST ──
    dash.fail = true;
    const offline = await post("/api/admin/new-org", {
      slug: "spec-queued", displayName: "Queued", orgId: "99999999-9999-9999-9999-999999999999",
      logoUrl: "x", reports: { gl: "11111111-2222-3333-4444-555555555555" },
    }, withPw);
    ok(offline.status === 200 && offline.json.ok === true,
      "the other project being down must never fail the create here");
    ok((await get("/api/admin/org/spec-queued")).json.exists === true,
      "the org must exist here regardless");
    const q = (await get("/api/admin/org-sync")).json;
    ok((q.pending || []).some(p => p.slug === "spec-queued"),
      "a failed push must be QUEUED — fire-and-forget leaves the two projects out of step silently");
    ok(q.configured === true, "the endpoint must say whether the sync is configured at all");
    console.log("  ✓ a failed push is queued and visible, and never fails the create");

    // ── 7. AN UNCONFIGURED DEPLOY MUST NOT FALL OPEN ──
    const PORT2 = PORT + 2;
    const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "orgsync2-"));
    fs.writeFileSync(path.join(dataDir2, "prewarm-state.json"),
      JSON.stringify({ lastCompletedAt: new Date().toISOString() }));
    const child2 = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT2), DATA_DIR: dataDir2,
             DASHBOARD_PASSWORD: PW, ORG_SYNC_SECRET: "",
             METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
             SKIP_PREWARM: "1", PREWARM_STARTUP_SKIP_MS: "999999999" },
      stdio: ["ignore", "pipe", "pipe"] });
    child2.stdout.on("data", () => {}); child2.stderr.on("data", () => {});
    const on2 = (method, p_, headers, body) => new Promise(r => {
      const data = body == null ? null : JSON.stringify(body);
      const h = { ...(headers || {}) };
      if (data) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
      const rq = http.request({ host: "127.0.0.1", port: PORT2, path: p_, method, headers: h }, res => {
        let b = ""; res.on("data", d => b += d);
        res.on("end", () => r({ status: res.statusCode, body: b, json: safe(b) }));
      });
      rq.on("error", e => r({ status: 0, body: String(e), json: {} }));
      if (data) rq.write(data); rq.end();
    });
    for (let i = 0; i < 120; i++) { if ((await on2("GET", "/healthz")).status) break; await new Promise(s => setTimeout(s, 400)); }

    const u1 = await on2("POST", "/api/admin/add-org", { "x-org-sync-secret": "anything-at-all" },
      { slug: "spec-open", token: "t", orgId: NEWID });
    ok(u1.status === 401,
      `with no ORG_SYNC_SECRET configured the route must FAIL CLOSED, not fall open (got ${u1.status})`);
    ok(/ORG_SYNC_SECRET/.test(u1.json.error || ""),
      "the refusal must name the variable to set — 'not configured' is a task, 'bad secret' is an incident");
    const u2 = await on2("GET", "/api/admin/org/spec-other", { "x-org-sync-secret": "anything-at-all" });
    ok(u2.json.token === undefined, "an unconfigured server must still withhold the token");
    const u3 = await on2("POST", "/api/admin/add-org", withPw,
      { slug: "spec-byhand", token: "t0000000000000x", orgId: NEWID });
    ok(u3.status === 200, "the admin password must still work, or a by-hand repair is impossible");
    console.log("  \u2713 an unconfigured deploy fails closed, and the password path still repairs it");
    child2.kill();
    fs.rmSync(dataDir2, { recursive: true, force: true });

    child.kill(); dashSrv.close();
    finish();
  })().catch(e => { failed++; console.error("  ✗ live half threw:", e.message); child.kill(); dashSrv.close(); finish(); });
} else { finish(); }

function finish() {
  console.log(`\n${passed} assertions passed${failed ? `, ${failed} FAILED` : ""}.`);
  process.exit(failed ? 1 : 0);
}
