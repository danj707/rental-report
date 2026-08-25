// Spec for the dead-link watch in server.js.
//
// THE INCIDENT: /town-of-shrewsbury/users?token=… had been returning 404 since
// the duplicate Shrewsbury slug was removed on 2026-07-20 (the org is served as
// `shrewsbury`). Nothing here could see it. The daily health check probes orgs
// that EXIST, so an org that was renamed or removed is not looked at at all,
// while its URL keeps circulating in emails and bookmarks. It was found by a
// human clicking a link, roughly five weeks late.
//
// TWO THINGS THIS PINS, and both are the difference between an alert and noise:
//
// 1. THE TOKEN IS THE DISCRIMINATOR. This server is scanned constantly. An alert
//    on every 404 would fire on bot traffic, get muted inside a day, and leave us
//    worse off than with no alert. A scanner does not know our token shape; a
//    stale internal link carries the token it was minted with. So a tokenless 404
//    must stay silent, and a tokened one must not.
//
// 2. THE TOKEN MUST NEVER BE RECORDED. It is a share credential, and the events
//    log is read by the admin dashboard and echoed to Slack. Logging the thing
//    that proves the link was real would leak it into both.
//
// Run: node scripts/deadlink-alert.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 4200 + (process.pid % 900);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadlink-"));
const EVENTS = path.join(dataDir, "events.jsonl");

let passed = 0;
function test(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── the source-level half: registration and the copy ────────────────────────
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

test("deadlink is in SLACK_NOTIFY, or the alert is silent", () => {
  const line = /const SLACK_NOTIFY = new Set\(\[(.*?)\]\)/s.exec(src);
  assert.ok(line, "SLACK_NOTIFY not found");
  assert.ok(/"deadlink"/.test(line[1]), "deadlink missing — logged but never posted");
});

test("it debounces for hours, not the 60s default", () => {
  const m = /const SLACK_DEBOUNCE_MS = \{(.*?)\};/s.exec(src);
  assert.ok(m && /deadlink:\s*6 \* 60 \* 60 \* 1000/.test(m[1]),
    "one forwarded email would otherwise post once per recipient");
});

test("the Slack copy never interpolates the token", () => {
  const i = src.indexOf('rec.event === "deadlink"');
  const block = src.slice(i, src.indexOf("} else if", i + 10));
  assert.ok(/rec\.path/.test(block), "the path is the useful part");
  assert.ok(!/rec\.token|req\.query\.token/.test(block), "must not print the token");
});

// ── the behavioural half: boot it and drive real requests ────────────────────
const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
         METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
         SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", d => { out += d; });
child.stderr.on("data", d => { out += d; });

function stop(ok, msg) {
  try { child.kill("SIGKILL"); } catch (_) {}
  if (!ok) {
    console.error("\n✗ " + msg);
    console.error(out.split("\n").slice(-20).join("\n"));
    process.exit(1);
  }
  console.log(`\n${passed}/${passed} passing`);
  process.exit(0);
}

const events = () => (fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, "utf8") : "");
const rows = () => events().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });

(async () => {
  // Wait for the port.
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 90000) return stop(false, "server did not start");
    try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; }
    catch (_) {
      try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch (__) {}
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const TOKEN = "WcAyo1FVtpVmXXA2";   // the shape a real share link carries
  const get = u => fetch(`http://127.0.0.1:${PORT}${u}`).then(r => r.status).catch(() => 0);

  try {
    // 1. the incident itself
    const before = rows().length;
    const st = await get(`/town-of-shrewsbury/users?token=${TOKEN}`);
    assert.strictEqual(st, 404, "the dead URL should still 404 — this watches, it does not rewrite");
    await new Promise(r => setTimeout(r, 250));
    const fresh = rows().slice(before).filter(r => r.event === "deadlink");
    assert.strictEqual(fresh.length, 1, "the incident produced no deadlink row");
    console.log("  ✓ a tokened 404 on a removed org slug is recorded");
    passed++;

    const rec = fresh[0];
    assert.strictEqual(rec.reason, "unknown-org");
    assert.strictEqual(rec.path, "/town-of-shrewsbury/users");
    console.log("  ✓ it records the path and which half did not resolve");
    passed++;

    // 2. the near-miss suggestion turns the alert into the fix
    assert.strictEqual(rec.suggest, "shrewsbury",
      "the surviving slug is the whole answer; without it the alert is a puzzle");
    console.log("  ✓ it names the surviving slug (town-of-shrewsbury → shrewsbury)");
    passed++;

    // 3. the token must not be anywhere in the log
    assert.ok(!events().includes(TOKEN), "the token leaked into events.jsonl");
    assert.ok(!JSON.stringify(rec).includes(TOKEN), "the token leaked into the record");
    console.log("  ✓ the token is never recorded, only that there was one");
    passed++;

    // 4. a tokenless 404 stays silent — this is what keeps the alert usable
    const b2 = rows().length;
    await get(`/definitely-not-an-org/users`);
    await get(`/another-bot-probe`);
    await new Promise(r => setTimeout(r, 250));
    const noisy = rows().slice(b2).filter(r => r.event === "deadlink");
    assert.strictEqual(noisy.length, 0, "tokenless 404s must not alert — that is bot traffic");
    console.log("  ✓ a tokenless 404 is ignored, so scanners cannot drown the signal");
    passed++;

    // 5. scanner paths are ignored even if they carry something token-shaped
    const b3 = rows().length;
    await get(`/wp-admin/setup-config.php?token=${TOKEN}`);
    await get(`/.env?token=${TOKEN}`);
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(rows().slice(b3).filter(r => r.event === "deadlink").length, 0,
      "known scanner paths must stay silent");
    console.log("  ✓ scanner paths stay silent even with a token attached");
    passed++;

    // 6. a request that WORKS must not be reported as dead
    const b4 = rows().length;
    const okStatus = await get(`/`);
    assert.ok(okStatus < 400, "the dashboard should serve");
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(rows().slice(b4).filter(r => r.event === "deadlink").length, 0,
      "only 404s are dead links");
    console.log("  ✓ a successful request is never reported as a dead link");
    passed++;

    stop(true);
  } catch (e) {
    stop(false, e.message);
  }
})();
