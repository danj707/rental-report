// Spec for the Facilities hub's activity beacons.
//
// WHY THIS EXISTS. Found 2026-08-24 while wiring the Outdoor Events tab's ping:
// every beacon this page sends was returning `404 Unknown report: "facilities"`,
// and had been since each one shipped — the hidden banner game ping and the lite
// Summary export ping included. The hub lives at /:org/facilities, but
// `facilities` is NOT in REPORT_TYPES (the report type is `facility`, the rental
// schedule), so the generic /:org/:report/api/log route matched first and
// resolveOrg rejected it.
//
// This is the campmap bug again, verbatim — see the campmap section of CLAUDE.md
// and scripts/campmap-beacons.spec.js. Nothing caught it either time: server.js
// parses, the server boots, the page renders, the client code is correct, and a
// fire-and-forget beacon never complains about a 404.
//
// So this checks both halves, because either alone would have missed it:
//   1. source order — the facilities route must be registered ABOVE the generic
//      /:org/:report ones. That is the actual invariant.
//   2. live behaviour — boot the server, POST each beacon, require a 200 AND a
//      row in events.jsonl. A 200 alone would not prove it recorded.
//
// Run: node scripts/facilities-beacons.spec.js
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

const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const page = fs.readFileSync(path.join(ROOT, "public", "facilities.html"), "utf8");
function at(needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `server.js no longer contains ${needle}`);
  return i;
}

(async () => {
  // ── 1. registration order ─────────────────────────────────────────────────
  await test("the facilities log route is registered BEFORE the generic /:org/:report one", () => {
    assert.ok(at('app.post("/:org/facilities/api/log",') < at('app.post("/:org/:report/api/log", resolveOrg,'),
      'the hub route is declared after the generic one — Express matches the generic route ' +
      'first and resolveOrg 404s it, which is exactly how the game and summary pings died');
  });

  await test("`facilities` really is not a report type — the reason the route has to exist", () => {
    const m = /const REPORT_TYPES = (\[[^\]]+\])/.exec(src);
    assert.ok(m, "REPORT_TYPES not found");
    const types = JSON.parse(m[1]);
    assert.ok(types.includes("facility"), "the rental schedule is `facility`");
    assert.ok(!types.includes("facilities"),
      "if the hub ever becomes a report type, this route stops being necessary — but do not " +
      "delete it without checking, because the generic route would then start logging the hub " +
      "under a second name");
  });

  await test("the page's beacons all point at the hub route", () => {
    const urls = page.match(/\/facilities\/api\/log\?event=[a-z-]+/g) || [];
    assert.ok(urls.length >= 3, "expected the game, summary and outdoor beacons, found " + urls.length);
    ["event=game", "event=summary", "event=outdoor"].forEach(ev => {
      assert.ok(urls.some(u => u.indexOf(ev) >= 0), "missing a beacon for " + ev);
    });
  });

  // ── 2. live behaviour ─────────────────────────────────────────────────────
  const PORT = 3997;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fac-beacons-"));
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

  // First org in the config with a token — any org reaches this route, but the
  // hub is behind the org token gate (unlike the public campmap), so the beacon
  // has to carry it, exactly as the page does.
  const { org, token } = (() => {
    const i = src.indexOf("const ORGS = {");
    const j = src.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = require("vm").runInNewContext("(" + src.slice(src.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    const slug = Object.keys(ORGS).find(k => ORGS[k] && ORGS[k].token);
    assert.ok(slug, "no org with a token in server.js");
    return { org: slug, token: ORGS[slug].token };
  })();
  const TOK = "token=" + encodeURIComponent(token);

  const post = qs => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST",
                               path: `/${org}/facilities/api/log?${qs}&${TOK}`, timeout: 15000 },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res({ status: r.statusCode, body: b })); });
    req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end();
  });

  try {
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
        .map(l => { try { return JSON.parse(l); } catch { return {}; } });
    };

    await test("opening the Outdoor Events tab records the tab AND what it had to show", async () => {
      const r = await post("event=outdoor&n=412");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "outdoor");
      assert.ok(rec, "nothing reached events.jsonl — a 200 alone does not prove it recorded");
      assert.strictEqual(rec.report, "facility", "logged against a report type that exists");
      assert.strictEqual(rec.bookings, 412);
    });

    await test("the hidden banner game ping works — it 404'd until this route existed", async () => {
      const r = await post("event=game&game=Bounce%20House");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "game");
      assert.ok(rec, "game not recorded");
      assert.strictEqual(rec.game, "Bounce House");
    });

    await test("the lite Summary export ping works too", async () => {
      const r = await post("event=summary");
      assert.strictEqual(r.status, 200, r.body);
      assert.ok(events().some(x => x.event === "summary"), "summary not recorded");
    });

    await test("an unknown event is rejected rather than silently logged", async () => {
      const r = await post("event=whatever");
      assert.strictEqual(r.status, 400, r.body);
      assert.ok(!events().some(x => x.event === "whatever"));
    });

    await test("an unknown org is a 404, not a row", async () => {
      const r = await new Promise((res, rej) => {
        const q = http.request({ host: "127.0.0.1", port: PORT, method: "POST",
                                 path: `/not-a-real-org/facilities/api/log?event=outdoor&${TOK}`, timeout: 15000 },
          x => { let b = ""; x.on("data", d => b += d); x.on("end", () => res({ status: x.statusCode, body: b })); });
        q.on("error", rej); q.end();
      });
      assert.strictEqual(r.status, 404, r.body);
    });

    await test("a nonsense booking count is dropped, not recorded", async () => {
      await post("event=outdoor&n=-5");
      let rec = events().filter(x => x.event === "outdoor").pop();
      assert.strictEqual(rec.bookings, undefined, "a negative count is dropped");
      await post("event=outdoor&n=99999999");
      rec = events().filter(x => x.event === "outdoor").pop();
      assert.strictEqual(rec.bookings, undefined, "an absurd count is dropped");
    });

    await test("the event is in SLACK_NOTIFY, or the ping is recorded and never seen", async () => {
      const m = /const SLACK_NOTIFY = new Set\((\[[^\]]+\])\)/.exec(src);
      assert.ok(m, "SLACK_NOTIFY not found");
      assert.ok(JSON.parse(m[1]).includes("outdoor"),
        "an event missing from SLACK_NOTIFY lands in events.jsonl and posts nothing");
      assert.ok(/outdoor: \{ emoji:/.test(src), "and it needs an emoji/verb entry to read properly");
    });

    await test("the new banner game is a real leaderboard game on both sides", async () => {
      // The client offers to submit a score for any LB_GAMES entry; the server
      // rejects a game it does not know, so a one-sided entry means a player
      // sees a Submit button that always fails.
      assert.ok(/bounce:\s+\{ label: "Bounce House"/.test(src), "server LEADERBOARD_GAMES is missing bounce");
      assert.ok(/bounce:\s+\{ label: 'Bounce House'/.test(page), "client LB_GAMES is missing bounce");
      const r = await new Promise((res, rej) => {
        const q = http.request({ host: "127.0.0.1", port: PORT, method: "POST",
                                 path: `/${org}/api/games/score?${TOK}`, timeout: 15000,
                                 headers: { "Content-Type": "application/json" } },
          x => { let b = ""; x.on("data", d => b += d); x.on("end", () => res({ status: x.statusCode, body: b })); });
        q.on("error", rej);
        q.end(JSON.stringify({ game: "bounce", score: 9, initials: "DAN" }));
      });
      assert.strictEqual(r.status, 200, r.body);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.ok, true);
      assert.strictEqual(j.top[0].score, 9);
    });

    console.log(`\n${passed}/${passed} passing`);
  } finally {
    try { child.kill("SIGKILL"); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error("\n✗ " + e.message); process.exit(1); });
