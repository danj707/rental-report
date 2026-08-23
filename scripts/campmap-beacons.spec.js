// Spec for the campsite map's activity beacons.
//
// WHY THIS EXISTS. The share beacon shipped in PR #140 never worked. It returned
// `404 Unknown report: "campmap"` for every call from the day it merged, so the
// Copy-link Slack ping that PR described has never fired. Nothing caught it:
// server.js parses, the server boots, the page renders, the client code is
// correct, and the beacon is fire-and-forget so the browser never complains.
//
// The cause is Express route ordering. `/:org/:report/api/log` matches
// `/douglas-county-nv/campmap/api/log`, and it runs resolveOrg, which rejects any
// report outside REPORT_TYPES — campmap is deliberately not one. A campmap route
// declared BELOW that generic route is dead code that looks alive.
//
// So this checks two different things, because either alone would have missed it:
//   1. the source order — campmap routes must be registered before the generic
//      ones. Cheap, and it is the actual invariant.
//   2. the live behaviour — boot the server, POST each beacon, and require both
//      a 200 AND a row in events.jsonl. A 200 alone would not prove it recorded.
//
// Run: node scripts/campmap-beacons.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
let passed = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { console.log(`  ✓ ${name}`); passed++; }); }

// ── 1. registration order, straight from the source ─────────────────────────
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
function at(needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `server.js no longer contains ${needle}`);
  return i;
}

const GENERIC = [
  'app.post("/:org/:report/api/log", resolveOrg,',
  'app.post("/:org/:report/api/share", resolveOrg,',
];
const CAMPMAP = [
  'app.post("/:org/campmap/api/share",',
  'app.post("/:org/campmap/api/log",',
];

(async () => {
  await test("campmap routes are registered BEFORE the generic /:org/:report ones", () => {
    for (const c of CAMPMAP) {
      for (const g of GENERIC) {
        assert.ok(at(c) < at(g),
          `${c} is declared after ${g} — Express will match the generic route first and ` +
          `resolveOrg will 404 it, exactly as the PR #140 share beacon did`);
      }
    }
  });

  // ── 2. live behaviour ─────────────────────────────────────────────────────
  const PORT = 3999 - Math.floor(Math.random() * 0); // fixed; nothing else binds it in CI
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "beacons-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
           METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
           SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const post = qs => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST",
                               path: `/douglas-county-nv/campmap/api/${qs}`, timeout: 15000 },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res({ status: r.statusCode, body: b })); });
    req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end();
  });

  try {
    // wait for boot
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("server did not boot\n" + log.slice(-600)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 },
          x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });

    const events = () => {
      const f = path.join(dataDir, "events.jsonl");
      if (!fs.existsSync(f)) return [];
      return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return {}; } })
        .filter(r => String(r.event || "").startsWith("campmap-"));
    };

    await test("a campsite open is recorded with the site, its state and the stay length", async () => {
      const r = await post("log?event=campmap-site&site=Site%2012&state=partial&nights=3");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "campmap-site");
      assert.ok(rec, "nothing reached events.jsonl — a 200 alone does not prove it recorded");
      assert.strictEqual(rec.report, "campmap");
      assert.strictEqual(rec.site, "Site 12");
      assert.strictEqual(rec.state, "partial");
      assert.strictEqual(rec.nights, 3);
    });

    await test("a Book-on-rec.us click is recorded against the site", async () => {
      const r = await post("log?event=campmap-book&site=Site%2012&nights=3");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "campmap-book" && x.site);
      assert.ok(rec, "book-through not recorded");
      assert.strictEqual(rec.site, "Site 12");
      assert.strictEqual(rec.nights, 3);
    });

    await test("the past-the-window hand-off is its own kind, not a link copy", async () => {
      // It used to POST /api/share?kind=book-ahead, which normalises kind to
      // embed|link — so a booking hand-off was recorded as someone copying a link.
      const r = await post("log?event=campmap-book&kind=later-dates");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "campmap-book" && x.kind);
      assert.ok(rec, "hand-off not recorded");
      assert.strictEqual(rec.kind, "later-dates");
    });

    await test("a campsite-type filter is recorded with what it narrowed to", async () => {
      const r = await post("log?event=campmap-filter&type=rv&sites=5&open=3");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "campmap-filter");
      assert.ok(rec, "filter not recorded");
      assert.strictEqual(rec.filterType, "rv");
      assert.strictEqual(rec.sites, 5);
      assert.strictEqual(rec.open, 3);
    });

    await test("the share beacon works — it 404'd from PR #140 until the routes moved", async () => {
      const r = await post("share?kind=embed");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "campmap-share");
      assert.ok(rec, "share not recorded");
      assert.strictEqual(rec.kind, "embed");
    });

    await test("an unknown event is rejected rather than silently logged", async () => {
      const r = await post("log?event=whatever");
      assert.strictEqual(r.status, 400, r.body);
      assert.ok(!events().some(x => x.event === "whatever"));
    });

    await test("hostile input is clamped, not trusted — this route is public", async () => {
      const long = "x".repeat(500);
      const r = await post(`log?event=campmap-site&site=${long}&nights=99999&state=${long}`);
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().filter(x => x.event === "campmap-site").pop();
      assert.ok(rec.site.length <= 80, `site not clamped: ${rec.site.length}`);
      assert.ok(rec.state.length <= 20, `state not clamped: ${rec.state.length}`);
      assert.strictEqual(rec.nights, undefined, "an absurd stay length is dropped, not recorded");
    });

    await test("filter counts are bounded too — they come from the page, not from us", async () => {
      const r = await post(`log?event=campmap-filter&type=${"y".repeat(200)}&sites=-4&open=999999`);
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().filter(x => x.event === "campmap-filter").pop();
      assert.ok(rec.filterType.length <= 24, `type not clamped: ${rec.filterType.length}`);
      assert.strictEqual(rec.sites, undefined, "a negative count is dropped");
      assert.strictEqual(rec.open, undefined, "an absurd count is dropped");
    });

    console.log(`\n${passed}/${passed} passing`);
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error("✗ " + e.message); process.exit(1); });
