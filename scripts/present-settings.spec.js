"use strict";
/* Present-mode settings on the public Session Schedule (calendar.html).

   The schedule is PUBLIC — the org-token middleware never runs on it — so the
   settings routes carry their own gate, and that gate is the whole security
   claim here. A render case cannot prove it: every /api/ request in
   ci-check-render.js is answered from STUBS. So this spec LIFTS AND RUNS the
   normaliser and boots a real server to drive the real routes. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const page = fs.readFileSync(path.join(ROOT, "public", "calendar.html"), "utf8");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓ " + name); passed++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + e.message); failed++; }
}

/* ── unit: the normaliser, lifted and RUN ─────────────────────────────── */
function lift(startMarker, endMarker) {
  const a = src.indexOf(startMarker), b = src.indexOf(endMarker, a);
  assert.ok(a >= 0 && b > a, "could not find " + startMarker);
  return src.slice(a, b);
}
const block = lift("const PRESENT_SPEED_MIN", "function presentSettingsFor");
const norm = new Function(block + "; return normalizePresentSettings;")();

test("defaults: weather off, 0.6 speed, everything shown", () => {
  assert.deepStrictEqual(norm({}), { weather: false, scrollSpeed: 0.6, locations: [], activities: [] });
});
test("a null speed is the default, never 0 (Number(null) is 0 — a stopped screen)", () => {
  assert.strictEqual(norm({ scrollSpeed: null }).scrollSpeed, 0.6);
  assert.strictEqual(norm({ scrollSpeed: "" }).scrollSpeed, 0.6);
});
test("speed is clamped both ways", () => {
  assert.strictEqual(norm({ scrollSpeed: 0 }).scrollSpeed, 0.2);
  assert.strictEqual(norm({ scrollSpeed: 99 }).scrollSpeed, 3);
});
test("weather is on only for a real true", () => {
  assert.strictEqual(norm({ weather: "yes" }).weather, false);
  assert.strictEqual(norm({ weather: true }).weather, true);
});
test("lists are trimmed, de-duplicated, blanks dropped", () => {
  assert.deepStrictEqual(norm({ locations: [" Pool ", "Pool", "", null, "Gym"] }).locations, ["Pool", "Gym"]);
  assert.deepStrictEqual(norm({ activities: "Swim" }).activities, []);
});

/* ── source: what a regex CAN say ─────────────────────────────────────── */
test("present-settings posts to Slack", () => {
  const m = /const SLACK_NOTIFY = new Set\(\[(.*?)\]\)/s.exec(src);
  assert.ok(m && /"present-settings"/.test(m[1]), "logged but never posted");
  assert.ok(/rec\.event === "present-settings"\) \{/.test(src), "needs its own message branch naming what changed");
});
test("the page's injected config escapes <, since it carries free-text names on a PUBLIC page", () => {
  const r = src.indexOf('app.get("/:org/calendar", (req, res)');
  const i = src.indexOf("window.__ORG__=${JSON.stringify(meta)", r);
  assert.ok(r > 0 && i > r, "the calendar route's inject was not found");
  assert.ok(/\.replace\(\/<\/g/.test(src.slice(i, i + 120)), "a </script> in a location name ends the tag");
});
test("the gear is gated on settingsAdmin, which the server decides", () => {
  assert.ok(/settingsAdmin && <button className="ps-gear"/.test(page));
  assert.ok(/settingsAdmin: presentTokenOk\(req, org\)/.test(src));
});
test("present mode reads the scroll speed from the settings, not a constant", () => {
  assert.ok(!/const SPEED=0\.6/.test(page), "the hardcoded speed is back");
  assert.ok(/acc\+=speedRef\.current/.test(page));
});
test("the present filter only applies in present mode", () => {
  assert.ok(/if\(isPresent&&!presentAllows\(presentCfg,e\)\) return false;/.test(page));
});

/* ── live: the real routes ────────────────────────────────────────────── */
const PORT = 4300 + (process.pid % 600);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "present-"));
const TOKEN = "psTOKEN0000fixture";
fs.writeFileSync(path.join(dataDir, "orgs.json"), JSON.stringify({
  "fixture-present": { token: TOKEN, orgId: "11111111-2222-3333-4444-555555555555", logoUrl: "", displayName: "Fixture Present" },
}));
fs.writeFileSync(path.join(dataDir, "prewarm-state.json"), JSON.stringify({ lastCompletedAt: new Date().toISOString() }));

const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SKIP_PREWARM: "1",
         METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", d => { out += d; });
child.stderr.on("data", d => { out += d; });

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, timeout: 20000,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, res => {
      let b = ""; res.on("data", d => { b += d; });
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: b, json: j || {} }); });
    });
    r.on("error", reject); r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    if (data) r.write(data);
    r.end();
  });
}
const waitUp = () => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    if (Date.now() - t0 > 45000) return reject(new Error("server did not boot:\n" + out.split("\n").slice(-15).join("\n")));
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/healthz", timeout: 2000 }, res => { res.resume(); resolve(); });
    r.on("error", () => setTimeout(tick, 400));
    r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
  };
  tick();
});
const events = () => {
  try { return fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
};
const injected = (html) => {
  const m = /window\.__ORG__=(\{.*?\});<\/script>/s.exec(html);
  return m ? JSON.parse(m[1]) : null;
};

(async () => {
  try { await waitUp(); } catch (e) { console.error("✗ " + e.message); child.kill("SIGKILL"); process.exit(1); }
  const base = "/fixture-present/calendar";
  const results = {};
  results.noTokGet = await req("GET", base + "/api/present-settings");
  results.badTokGet = await req("GET", base + "/api/present-settings?token=psWRONG000fixture");
  results.noTokPut = await req("PUT", base + "/api/present-settings", { settings: { weather: true } });
  results.goodPut = await req("PUT", base + "/api/present-settings?token=" + TOKEN,
    { settings: { weather: true, scrollSpeed: 1.5, locations: ["Pool", "</script><b>x"], activities: ["Swim"] } });
  results.goodGet = await req("GET", base + "/api/present-settings?token=" + TOKEN);
  results.state = await req("GET", base + "/api/present-state");
  results.pagePublic = await req("GET", base);
  results.pageAdmin = await req("GET", base + "?token=" + TOKEN);
  child.kill("SIGKILL");

  test("[live] no token: the GET is refused", () => assert.strictEqual(results.noTokGet.status, 404));
  test("[live] a wrong token: refused", () => assert.strictEqual(results.badTokGet.status, 404));
  test("[live] no token: the PUT is refused and stores nothing", () => {
    assert.strictEqual(results.noTokPut.status, 404);
  });
  test("[live] the org token saves", () => {
    assert.strictEqual(results.goodPut.status, 200);
    assert.strictEqual(results.goodPut.json.settings.scrollSpeed, 1.5);
  });
  test("[live] and reads back", () => {
    assert.deepStrictEqual(results.goodGet.json.settings.locations, ["Pool", "</script><b>x"]);
    assert.strictEqual(results.goodGet.json.weatherAvailable, false, "a dynamic fixture org carries no coords");
  });
  test("[live] the kiosk's public poll carries the settings", () => {
    assert.strictEqual(results.state.status, 200);
    assert.deepStrictEqual(results.state.json.settings.activities, ["Swim"]);
  });
  test("[live] the public page gets the settings but NOT the gear", () => {
    const cfg = injected(results.pagePublic.body);
    assert.ok(cfg, "no __ORG__ injected");
    assert.strictEqual(cfg.settingsAdmin, false);
    assert.strictEqual(cfg.present.scrollSpeed, 1.5);
  });
  test("[live] a </script> in a saved name cannot end the tag", () => {
    assert.ok(!/<\/script><b>x/.test(results.pagePublic.body), "the raw name reached the HTML");
  });
  test("[live] the token URL gets the gear", () => {
    assert.strictEqual((injected(results.pageAdmin.body) || {}).settingsAdmin, true);
  });
  test("[live] the save is in the event log, carrying what changed", () => {
    const e = events().find(x => x.event === "present-settings");
    assert.ok(e, "no present-settings event");
    assert.strictEqual(e.weather, "on");
    assert.strictEqual(Number(e.locations), 2);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
