#!/usr/bin/env node
// ── The store, through a REAL server ───────────────────────────────────────
//
// scripts/store.spec.js proves the module. This proves the WIRING, which is a
// different claim and the one that actually decides whether the flip works:
// that server.js reads its config, its event log and its feed cache through the
// store rather than around it.
//
// It boots server.js twice — once in disk mode and once in db mode — and drives
// the real routes. No source assertion can stand in for this. Every bug this
// change could introduce (a store that is configured but never read, a settings
// write that lands on the volume and nowhere else, an event that is logged
// twice) leaves code that reads perfectly.
//
// Hermetic apart from Postgres: METABASE_URL points at a dead port, so booting
// never reaches production. With no STORE_TEST_URL the db half SKIPS and the
// disk half still runs — because "disk mode is unchanged" is the claim that
// matters on every PR, and it needs no database to check.
//
//   STORE_TEST_URL=postgres://store@127.0.0.1:55432/storelive?sslmode=disable \
//     node scripts/store-live.spec.js

"use strict";

const { spawn } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");

const URL = process.env.STORE_TEST_URL || "";
const PASSWORD = "store-spec-password";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error("  ✗ " + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + " — got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(port, method, p, headers, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const h = Object.assign({}, headers);
  if (payload) { h["Content-Type"] = "application/json"; h["Content-Length"] = payload.length; }
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h, timeout: 15000 }, res => {
      let body = "";
      res.on("data", d => { body += d; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, body, json });
      });
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    if (payload) r.write(payload);
    r.end();
  });
}

const basic = "Basic " + Buffer.from("admin:" + PASSWORD).toString("base64");

// A spec-only org, created through the real route. It is deliberately NOT a
// production slug and NOT a production token: the beacon route needs a token to
// resolve an org, and a credential in a spec is a credential in git.
const ORG  = "store-spec-org";
const TOKEN = "storeSpecToken123";
const addOrg = (port) => req(port, "POST", "/api/admin/add-org", {},
  { slug: ORG, token: TOKEN, orgId: "00000000-0000-0000-0000-000000000000", displayName: "Store Spec Org" });
const beacon = (port) => req(port, "POST", "/" + ORG + "/gl/api/log?event=print&token=" + TOKEN);

async function boot(port, dataDir, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      METABASE_URL: "http://127.0.0.1:9",   // dead port — never touch production
      RESEND_API_KEY: "",
      SLACK_WEBHOOK_URL: "",
      DASHBOARD_PASSWORD: PASSWORD,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  const deadline = Date.now() + 45000;
  for (;;) {
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("server did not answer on :" + port + "\n" + out.split("\n").slice(-30).join("\n")); }
    try {
      const r = await req(port, "GET", "/healthz");
      if (r.status === 200) break;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return { child, log: () => out };
}

// SIGTERM, not SIGKILL: server.js drains its write queue on the signal, and a
// deploy replaces containers exactly that way. Killing it outright would skip
// the very path a rolling deploy depends on.
async function stop(s) {
  try { s.child.kill("SIGTERM"); } catch {}
  for (let i = 0; i < 40 && s.child.exitCode === null && s.child.signalCode === null; i++) await sleep(100);
  try { s.child.kill("SIGKILL"); } catch {}
}

function readFlagFile(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "feature-flags.json"), "utf8")); } catch { return null; }
}
function eventLines(dir) {
  try { return fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
}

function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "store-live-"));
  fs.mkdirSync(path.join(d, "cache"), { recursive: true });
  return d;
}

async function wipe() {
  const { Pool } = require("pg");
  const p = new Pool({ connectionString: URL, ssl: false });
  await p.query("DROP TABLE IF EXISTS kv_store, events, feed_cache");
  await p.query("DROP SEQUENCE IF EXISTS store_rev_seq");
  await p.end();
}
async function q(sql, args) {
  const { Pool } = require("pg");
  const p = new Pool({ connectionString: URL, ssl: false });
  const r = await p.query(sql, args || []);
  await p.end();
  return r;
}

(async function main() {

  // ── disk mode is what it always was ──────────────────────────────────────
  {
    const dir = freshDir();
    const s = await boot(41101, dir);
    try {
      // THE GATE FIRST. dashboardAuth returns next() for every path except "/",
      // so route middleware here is decorative — the first version of these two
      // routes answered 200 with no credentials on the PR preview while / was
      // correctly 401'ing. The read leaks internal state and the POST next door
      // kicks off a full import against the platform's config.
      const open = await req(41101, "GET", "/api/admin/store");
      eq(open.status, 401, "the store route refuses a caller with no password");
      const openImport = await req(41101, "POST", "/api/admin/store/import", {}, {});
      eq(openImport.status, 401, "...and so does the import");
      const wrong = await req(41101, "GET", "/api/admin/store", {}, undefined);
      eq(wrong.status, 401, "a request with no Authorization header is refused");
      const badPw = await req(41101, "GET", "/api/admin/store?password=nope");
      eq(badPw.status, 401, "a wrong password is refused");

      const st = await req(41101, "GET", "/api/admin/store", { Authorization: basic });
      eq(st.status, 200, "the right password is accepted");
      eq(st.json && st.json.mode, "disk", "with no DATABASE_URL the server runs in disk mode");
      ok(!/postgres:\/\//.test(JSON.stringify(st.json)), "and the response never carries a connection string");
      ok(!/\[store\] \{"mode":"d/.test(s.log()), "and never announces a database connection");

      // A flag write must land on the volume, exactly as before.
      const set = await req(41101, "POST", "/api/admin/flags", {}, { password: PASSWORD, key: "reportSettings", value: true });
      eq(set.status, 200, "the flags route accepted the change");
      await sleep(300);
      // The file legitimately carries every default alongside the change.
      eq((readFlagFile(dir) || {}).reportSettings, true, "disk mode writes the flag to feature-flags.json on the volume");

      // An org added through the route must land on the volume too.
      const add = await addOrg(41101);
      eq(add.status, 200, "the add-org route accepted the org");
      await sleep(200);
      const orgs = JSON.parse(fs.readFileSync(path.join(dir, "orgs.json"), "utf8"));
      ok(orgs[ORG] && orgs[ORG].token === TOKEN, "disk mode writes orgs.json to the volume");

      // ...and an event must reach events.jsonl.
      const b = await beacon(41101);
      eq(b.status, 200, "the beacon route accepted the event");
      await sleep(400);
      eq(eventLines(dir), 1, "disk mode appends the event to events.jsonl");
    } finally { await stop(s); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ── no password configured means NOBODY, not everybody ───────────────────
  //
  // The asymmetry against dashboardAuth, which treats an unset password as open
  // access — right for a root page in dev, wrong for a route that reports
  // internal state and kicks off an import. And it is not hypothetical: a PR
  // preview is a fresh environment, so an unset DASHBOARD_PASSWORD there is the
  // normal case rather than the exotic one.
  {
    const dir = freshDir();
    const s = await boot(41110, dir, { DASHBOARD_PASSWORD: "" });
    try {
      eq((await req(41110, "GET", "/api/admin/store")).status, 401,
         "with no password configured the store route refuses everyone");
      eq((await req(41110, "POST", "/api/admin/store/import", {}, {})).status, 401,
         "...and so does the import");
      eq((await req(41110, "GET", "/api/admin/store", { Authorization: basic })).status, 401,
         "...including a caller presenting the password the spec normally uses");
    } finally { await stop(s); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  if (!URL) {
    console.log("SKIP the db half — set STORE_TEST_URL to a scratch Postgres to run it.");
    if (failed) { console.error("\n" + failed + " assertion(s) FAILED."); process.exit(1); }
    console.log(passed + " assertions passed (disk half only).");
    return;
  }

  // ── the import moves the volume in, once ─────────────────────────────────
  {
    await wipe();
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "feature-flags.json"), JSON.stringify({ reportSettings: true }));
    fs.writeFileSync(path.join(dir, "events.jsonl"),
      JSON.stringify({ ts: "2026-09-01T00:00:00Z", org: "apex", report: "gl", event: "view" }) + "\n" +
      JSON.stringify({ ts: "2026-09-02T00:00:00Z", org: "apex", report: "gl", event: "pdf" }) + "\n");

    const s = await boot(41102, dir, {
      STORE_DATABASE_URL: URL, STORE_MODE: "db", STORE_IMPORT: "1"
    });
    try {
      const st = await req(41102, "GET", "/api/admin/store", { Authorization: basic });
      eq(st.json && st.json.mode, "db", "STORE_MODE=db is honoured through a real boot");
      ok(st.json && st.json.ready, "the store reports ready");
      ok(/STORE_IMPORT=1/.test(s.log()), "the boot log records the import");

      const kv = await q("SELECT count(*)::int AS n FROM kv_store");
      ok(kv.rows[0].n >= 1, "the config blobs landed in kv_store (" + kv.rows[0].n + ")");
      const ev = await q("SELECT count(*)::int AS n FROM events");
      eq(ev.rows[0].n, 2, "the event log landed in events");
    } finally { await stop(s); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ── a SECOND container, with an EMPTY volume, sees the first one's state ──
  //
  // This is the whole point of the exercise, and nothing else in the suite
  // makes the claim: a replacement container must serve the platform's config
  // and its warm cache, not its own blank disk.
  {
    const dirA = freshDir(), dirB = freshDir();
    const A = await boot(41103, dirA, { STORE_DATABASE_URL: URL, STORE_MODE: "db" });
    try {
      // Add an org and set a flag through real routes on A.
      await addOrg(41103);
      await req(41103, "POST", "/api/admin/flags", {}, { password: PASSWORD, key: "reportSettings", value: true });
      await sleep(600);

      const B = await boot(41104, dirB, { STORE_DATABASE_URL: URL, STORE_MODE: "db" });
      try {
        // B's own volume is empty. If it can answer for this org, it did so
        // from the shared store — which is the whole claim.
        eq(readFlagFile(dirB), null, "the second container's own volume holds no flags");

        const st = await req(41104, "GET", "/api/admin/store", { Authorization: basic });
        ok(st.json && st.json.keys >= 2, "the second container loaded the shared config (" + (st.json && st.json.keys) + " keys)");

        const flags = await req(41104, "GET", "/api/admin/flags", {});
        eq(flags.json && flags.json.reportSettings, true, "...and serves the flag the first container set");

        // An org added on one replica and unknown to another is exactly the
        // "Unknown org" this repo has already had once, from a slug that was
        // renamed in one place and not the other.
        const b = await beacon(41104);
        eq(b.status, 200, "an org added on the first container resolves on the second");
      } finally { await stop(B); }
    } finally { await stop(A); fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true }); }
  }

  // ── an event logged on one container is counted ONCE ─────────────────────
  {
    await wipe();
    const dirA = freshDir(), dirB = freshDir();
    const A = await boot(41105, dirA, { STORE_DATABASE_URL: URL, STORE_MODE: "db" });
    const B = await boot(41106, dirB, { STORE_DATABASE_URL: URL, STORE_MODE: "db" });
    try {
      await addOrg(41105);
      await sleep(6000);                 // one poll cycle on B (default 4s) plus slack
      const before = (await q("SELECT count(*)::int AS n FROM events")).rows[0].n;
      eq((await beacon(41105)).status, 200, "the beacon was accepted on the first container");
      eq((await beacon(41106)).status, 200, "the beacon was accepted on the second container");
      await sleep(1500);
      const after = (await q("SELECT count(*)::int AS n FROM events")).rows[0].n;
      eq(after - before, 2, "two beacons on two containers are two rows, not four");

      // ...and neither container wrote it to its own volume as well. Both would
      // be double-counted the day the volume is read back.
      eq(eventLines(dirA) + eventLines(dirB), 0, "and nothing was appended to events.jsonl as well");

      // The rows existing is only half of it. readEvents() is what the admin
      // dashboard, the digest and every watchdog gate read through, so a store
      // that is written and never READ leaves all of them looking at an empty
      // log on a platform that is being used.
      const act = await req(41105, "GET", "/api/admin/report-activity?refresh=1");
      ok(act.json && act.json.usageEvents >= 2,
         "readEvents() serves the stored log (usageEvents=" + (act.json && act.json.usageEvents) + ")");
      ok(act.json && act.json.failsafe === false,
         "...so the watchdogs are not in fail-safe, which is what an empty log looks like");
    } finally { await stop(A); await stop(B); fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true }); }
  }

  // ── a new container starts on the PLATFORM's warm cache ──────────────────
  //
  // The reason a rolling deploy is safe at all. Without this a replacement
  // container joins the rotation cold and prewarm fans out across ~28 orgs
  // against production Metabase — the storm that 502'd the facility Summary.
  {
    await wipe();
    {
      const seed = await boot(41108, freshDir(), { STORE_DATABASE_URL: URL, STORE_MODE: "db" });
      await stop(seed);                  // just to create the tables
    }
    // Written as if by another replica, which is exactly what it would be.
    await q(`INSERT INTO feed_cache (k, v, updated_at) VALUES ($1, $2::jsonb, now())`, [
      ORG + ":gl:v1:seeded",
      JSON.stringify({ key: ORG + ":gl:v1:seeded", data: { rows: [[1]] }, ts: Date.now(), rt: "gl" })
    ]);

    const dir = freshDir();              // an EMPTY volume — no disk cache at all
    const s = await boot(41109, dir, { STORE_DATABASE_URL: URL, STORE_MODE: "db" });
    try {
      const st = await req(41109, "GET", "/api/admin/cache-stats");
      ok(st.json && st.json.entries >= 1,
         "a container with an empty volume hydrates the shared cache (" + (st.json && st.json.entries) + " entries)");
      ok(/Hydrated from the store/.test(s.log()), "...and says so in the boot log");
    } finally { await stop(s); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ── a write in flight survives SIGTERM ───────────────────────────────────
  //
  // A rolling deploy stops the old container the moment the new one is healthy.
  // A settings change made in that second must not be the thing that is lost.
  {
    await wipe();
    const dir = freshDir();
    const s = await boot(41107, dir, { STORE_DATABASE_URL: URL, STORE_MODE: "db" });

    // SEVERAL writes, not one, so this is at least the shape a deploy
    // interrupts. Be clear about what it does and does not prove: an HTTP round
    // trip is long enough that the upserts usually land anyway, so this case
    // passes on a build with NO drain at all — verified by mutation. What it
    // establishes is that a graceful stop does not LOSE writes end to end; the
    // drain itself is pinned by scripts/store.spec.js ("closing the store
    // drains every queued write, not just the first"), which controls the
    // timing, plus the source assertion below that SIGTERM reaches it.
    const writes = [
      req(41107, "POST", "/api/admin/flags", {}, { password: PASSWORD, key: "reportSettings", value: true }),
      req(41107, "POST", "/api/admin/flags", {}, { password: PASSWORD, key: "maintenanceMode", value: true }),
      addOrg(41107),
      req(41107, "POST", "/api/admin/toggle-public-mode", {}, { password: PASSWORD, slug: ORG, enabled: true })
    ];
    await Promise.all(writes);
    await stop(s);                       // SIGTERM, immediately after the burst
    const kv = await q("SELECT k FROM kv_store ORDER BY k");
    const keys = kv.rows.map(r => r.k);
    ok(keys.includes("feature-flags.json"), "a flag written moments before SIGTERM is drained, not dropped");
    ok(keys.includes("orgs.json"), "...and so is the org added in the same burst");

    // The half the live harness cannot time. Without this the two guards
    // together would still miss a server that simply never calls close().
    {
      const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
      const sd = src.slice(src.indexOf("function shutdown(signal)"), src.indexOf("process.on(\"SIGINT\""));
      ok(/stateStore\.close\(/.test(sd), "SIGTERM drains through the store before exiting [source]");
      ok(/process\.on\("SIGTERM"/.test(src), "...and SIGTERM is actually handled [source]");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── the cache WRITE path, as a source assertion, and why ─────────────────
  //
  // Every /api/ call in this harness fast-fails against a dead port, so no feed
  // is ever fetched and setCache is never reached — driving it for real needs a
  // Metabase stub this harness does not have. The unit spec proves the store's
  // side of it (a cache entry round-trips); this proves the server calls it,
  // which is the only part a source assertion CAN establish. Labelled rather
  // than dressed up as behaviour.
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const setCacheBody = src.slice(src.indexOf("function setCache("), src.indexOf("// Return cached data even if TTL-expired"));
    ok(/stateStore\.cacheSet\(/.test(setCacheBody), "setCache writes through to the store [source]");
    const getDiskBody = src.slice(src.indexOf("async function getDiskCached("), src.indexOf("// Persist / restore learned popularity"));
    ok(/stateStore\.cacheGet\(/.test(getDiskBody), "the L2 read asks the store [source]");
  }

  await wipe();

  if (failed) { console.error("\n" + failed + " assertion(s) FAILED."); process.exit(1); }
  console.log(passed + " assertions passed.");
})().catch(e => { console.error(e); process.exit(1); });
