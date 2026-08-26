// Spec for the Memberships report's activity beacons.
//
// WHY THIS EXISTS. Found 2026-08-24 while wiring the Check-Ins tab's location
// filter: the Memberships page's Excel and Print beacons had NEVER logged
// anything. They POSTed a JSON body — {action:'excel'} — while
// /:org/:report/api/log reads req.query.event, so every call came back
// `400 Unknown event` and nothing reached events.jsonl or Slack. The same shape
// was in instructor-payout.html. Nothing caught it: server.js parses, the server
// boots, the page renders, the export works, and a fire-and-forget beacon never
// complains — the third instance of this failure mode after the campmap and
// Facilities-hub routes (see CLAUDE.md).
//
// So this checks both halves, because either alone would have missed it:
//   1. source shape — every beacon on these pages names its event in the QUERY
//      STRING. A body-only ping is the bug, and it looks identical from here.
//   2. live behaviour — boot the server, POST each event, require a 200 AND a row
//      in events.jsonl. A 200 alone would not prove it recorded, and the
//      body-only form does not even get one.
//
// Run: node scripts/checkin-beacons.spec.js
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
const page = fs.readFileSync(path.join(ROOT, "public", "memberships.html"), "utf8");
const payout = fs.readFileSync(path.join(ROOT, "public", "instructor-payout.html"), "utf8");

(async () => {
  // ── 1. source shape ───────────────────────────────────────────────────────
  await test("no beacon posts its event in the BODY — that is the bug, and it 400s", () => {
    [["memberships.html", page], ["instructor-payout.html", payout]].forEach(([name, txt]) => {
      const bad = txt.match(/api\/log`?\)?,\s*\{[^}]*body:\s*JSON\.stringify\(\s*\{\s*action:/g) || [];
      assert.strictEqual(bad.length, 0,
        name + " still posts {action:…} to the log route; it reads ?event= and rejects this");
    });
  });

  await test("the Memberships page names every event in the query string", () => {
    const urls = page.match(/api\/log\?event=[a-z-]+/g) || [];
    ["event=excel", "event=print"].forEach(ev => {
      assert.ok(urls.some(u => u.indexOf(ev) >= 0), "missing a beacon for " + ev);
    });
    // The check-in pings are built from a URLSearchParams, so they carry the
    // event as a parameter rather than a literal.
    assert.ok(/ciBeacon\('checkin-loc'/.test(page), "the location filter should ping checkin-loc");
    assert.ok((page.match(/ciBeacon\('checkin-member'\)/g) || []).length >= 2,
      "both member links (Top Members and the check-in table) should ping checkin-member");
    assert.ok(/new URLSearchParams\(\{ event: event \}\)/.test(page),
      "ciBeacon should put the event in the query string");
  });

  await test("both new events are in the log route's ALLOWED list", () => {
    const m = /const ALLOWED = (\["excel"[^\]]+\]);/.exec(src);
    assert.ok(m, "the generic log route's ALLOWED list moved");
    const allowed = JSON.parse(m[1]);
    ["checkin-loc", "checkin-member", "checkin-failed", "excel", "print"].forEach(e =>
      assert.ok(allowed.includes(e), e + " is not allowlisted — the beacon 400s"));
  });

  await test("...and in SLACK_NOTIFY, or they record and are never seen", () => {
    const m = /const SLACK_NOTIFY = new Set\((\[[^\]]+\])\)/.exec(src);
    assert.ok(m, "SLACK_NOTIFY not found");
    const notify = JSON.parse(m[1]);
    ["checkin-loc", "checkin-member", "checkin-failed"].forEach(e =>
      assert.ok(notify.includes(e), e + " is missing from SLACK_NOTIFY"));
    assert.ok(/"checkin-loc":\s+\{ emoji:/.test(src), "checkin-loc needs an emoji/verb entry");
    assert.ok(/"checkin-member":\s+\{ emoji:/.test(src), "checkin-member needs an emoji/verb entry");
    assert.ok(/"checkin-failed":\s+\{ emoji:/.test(src), "checkin-failed needs an emoji/verb entry");
  });

  await test("checkin-failed debounces by DESK, same reasoning as checkin-loc", () => {
    assert.ok(/rec\.event === "checkin-failed"\s*\n\s*\?\s*`\$\{rec\.org\}\|\$\{rec\.report\}\|checkin-failed\|\$\{rec\.location \|\| ""\}`/.test(src),
      "checking the north desk's refusals then the south's is two questions, not one");
  });

  await test("the failed-list ping is fired from the page", () => {
    assert.ok(/ciBeacon\('checkin-failed'/.test(page),
      "opening the refused-scan list should ping checkin-failed");
  });

  await test("checkin-loc debounces by DESK, so two branches read as two looks", () => {
    assert.ok(/rec\.event === "checkin-loc"\s*\n\s*\?\s*`\$\{rec\.org\}\|\$\{rec\.report\}\|checkin-loc\|\$\{rec\.location \|\| ""\}`/.test(src),
      "without a location in the key, comparing the north desk then the south posts once");
  });

  // ── 2. live behaviour ─────────────────────────────────────────────────────
  const PORT = 3993;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-beacons-"));
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

  const { org, token } = (() => {
    const i = src.indexOf("const ORGS = {");
    const j = src.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = require("vm").runInNewContext("(" + src.slice(src.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    const slug = Object.keys(ORGS).find(k => ORGS[k] && ORGS[k].token);
    assert.ok(slug, "no org with a token in server.js");
    return { org: slug, token: ORGS[slug].token };
  })();
  const TOK = "token=" + encodeURIComponent(token);

  const post = (qs, body) => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST",
                               path: `/${org}/memberships/api/log?${qs}${qs ? "&" : ""}${TOK}`, timeout: 15000,
                               headers: body ? { "Content-Type": "application/json" } : {} },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res({ status: r.statusCode, body: b })); });
    req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end(body ? JSON.stringify(body) : undefined);
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

    await test("the old body-only shape is rejected — this is what was shipping", async () => {
      const r = await post("", { action: "excel" });
      assert.strictEqual(r.status, 400, "a body-only ping must not be accepted: " + r.body);
      assert.ok(!events().some(x => x.event === "excel"), "and it must not have recorded anything");
    });

    await test("the Excel ping records now that it names its event", async () => {
      const r = await post("event=excel");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "excel");
      assert.ok(rec, "nothing reached events.jsonl — a 200 alone would not prove it");
      assert.strictEqual(rec.report, "memberships");
    });

    await test("filtering check-ins to a desk records the desk AND what it holds", async () => {
      const r = await post("event=checkin-loc&location=North%20Desk&n=412");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().filter(x => x.event === "checkin-loc").pop();
      assert.ok(rec, "checkin-loc not recorded");
      assert.strictEqual(rec.location, "North Desk");
      assert.strictEqual(rec.checkins, 412);
    });

    await test("a nonsense check-in count is dropped rather than recorded", async () => {
      await post("event=checkin-loc&location=North%20Desk&n=-3");
      let rec = events().filter(x => x.event === "checkin-loc").pop();
      assert.strictEqual(rec.checkins, undefined, "a negative count is dropped");
      await post("event=checkin-loc&location=North%20Desk&n=99999999");
      rec = events().filter(x => x.event === "checkin-loc").pop();
      assert.strictEqual(rec.checkins, undefined, "an absurd count is dropped");
    });

    await test("a very long desk name is clamped, not stored whole", async () => {
      await post("event=checkin-loc&location=" + encodeURIComponent("x".repeat(400)));
      const rec = events().filter(x => x.event === "checkin-loc").pop();
      assert.ok(rec.location.length <= 80, "desk name should be clamped to 80 chars");
    });

    await test("opening the refused-scan list records the desk AND how many", async () => {
      const r = await post("event=checkin-failed&location=South%20Desk&n=13");
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().filter(x => x.event === "checkin-failed").pop();
      assert.ok(rec, "checkin-failed not recorded");
      assert.strictEqual(rec.location, "South Desk");
      assert.strictEqual(rec.failed, 13);
    });

    await test("a nonsense refusal count is dropped rather than recorded", async () => {
      await post("event=checkin-failed&location=South%20Desk&n=-3");
      const rec = events().filter(x => x.event === "checkin-failed").pop();
      assert.strictEqual(rec.failed, undefined, "a negative refusal count is dropped");
    });

    await test("clicking through to a member's Rec account records", async () => {
      const r = await post("event=checkin-member");
      assert.strictEqual(r.status, 200, r.body);
      assert.ok(events().some(x => x.event === "checkin-member"), "checkin-member not recorded");
    });

    await test("an unknown event is rejected rather than silently logged", async () => {
      const r = await post("event=checkin-whatever");
      assert.strictEqual(r.status, 400, r.body);
      assert.ok(!events().some(x => x.event === "checkin-whatever"));
    });

    console.log(`\n${passed}/${passed} passing`);
  } finally {
    try { child.kill("SIGKILL"); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error("\n✗ " + e.message); process.exit(1); });
