// Spec for the Send Test button in the subscribe modal.
//
// WHY THIS EXISTS. /admin/test-send was written for the Test button beside an
// EXISTING subscriber, so it read the report's filters and date range out of the
// saved subscription. The modal on a report page has no subscription yet — that
// is the point of the button, you test before you commit — so wiring it straight
// to the old route would have sent an unfiltered, default-window email and
// reported success. A test that passes without testing the thing is worse than
// no test at all: the reader checks their inbox, sees a report, subscribes, and
// gets something else every morning.
//
// So the route takes explicit reportParams/dateRange, cleaned by the SAME helper
// /admin/subscribe uses, and this spec pins:
//   1. an override with no subscription present reaches the send,
//   2. the saved subscription still wins when no override is sent (the admin
//      Test button must keep working),
//   3. the validation a real outbound email needs — a valid address, a known
//      report, a real cadence, and no date range the scheduler itself refuses,
//   4. and, in source, that each page's two buttons build ONE payload.
//
// Run: node scripts/test-send.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
let passed = 0;
const test = (name, fn) => Promise.resolve(fn()).then(() => { console.log("  ✓ " + name); passed++; });

(async () => {
  // ── 1. Source: one payload per page, not two ────────────────────────────
  await test("each modal builds one payload for both buttons", () => {
    for (const [file, report] of [["gl.html", "gl"], ["facility.html", "facility"]]) {
      const page = fs.readFileSync(path.join(ROOT, "public", file), "utf8");
      assert.ok(/function subscribePayload\(\)/.test(page),
        file + " should build the subscribe payload in one place");
      assert.ok((page.match(/subscribePayload\(\)/g) || []).length >= 3,
        file + ": both handlers should call the shared builder");
      assert.ok(page.indexOf("/admin/test-send?token=") > 0, file + " should call the test-send route");
      // The test must carry the SAME filter string the subscription would save.
      assert.ok(new RegExp("body\\.reportParams && body\\.reportParams\\." + report).test(page),
        file + ": the test send should reuse the payload's own filters, not rebuild them");
      assert.ok(/Send yourself a test first/.test(page), file + " should explain the order on screen");
      assert.ok(/emailValid/.test(page), file + " should gate both buttons on a valid address");
    }
    const ft = fs.readFileSync(path.join(ROOT, "public", "fasttrack.html"), "utf8");
    assert.ok(/function digestPayload\(/.test(ft), "fasttrack should share its digest payload");
    // digest=1 is what makes the email a digest instead of a PDF, so a test
    // that dropped it would preview a different email entirely.
    assert.ok(/reportParams: p\.reportParams\.fasttrack/.test(ft),
      "the fasttrack test send must carry digest=1 from the shared payload");
  });

  await test("the route and the subscribe form clean filters with the same helper", () => {
    assert.ok(/function cleanReportParamString\(val\)/.test(src), "the shared sanitizer should exist");
    // Two copies of the cleaning loop would drift, and the drift would be
    // invisible: the test email and the saved subscription would differ by a
    // stripped parameter nobody looks at.
    assert.strictEqual((src.match(/p\.delete\("_print"\)/g) || []).length, 1,
      "only the shared helper may strip page state from a filter string");
  });

  // ── 2. Live behaviour ───────────────────────────────────────────────────
  const PORT = 3991;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-send-"));
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

  const post = (p, body) => new Promise((res, rej) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: p, timeout: 20000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: r.statusCode, body: b, json: j }); }); });
    req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end(payload);
  });
  const testSend = body => post(`/${org}/admin/test-send?token=${encodeURIComponent(token)}`, body);

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("server did not boot\n" + log.slice(-600)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });

    await test("filters set on screen reach the send, with no subscription in existence", async () => {
      const r = await testSend({ email: "nobody@example.gov", report: "gl", schedule: "daily",
                                 dateRange: "yesterday", reportParams: "desks=north,south&methods=cash" });
      assert.strictEqual(r.status, 200, r.body);
      assert.ok(r.json.scope, "the route should echo the scope it used");
      assert.strictEqual(r.json.scope.filters, "desks=north%2Csouth&methods=cash",
        "the typed filters must be what gets sent — this is the whole feature");
      assert.strictEqual(r.json.scope.dateRange, "yesterday");
    });

    await test("page state is stripped from the filters, exactly as a subscription would be", async () => {
      const r = await testSend({ email: "nobody@example.gov", report: "gl", schedule: "daily",
                                 dateRange: "prior7", reportParams: "desks=north&token=secret&_print=1&methods=" });
      assert.strictEqual(r.status, 200, r.body);
      assert.strictEqual(r.json.scope.filters, "desks=north",
        "token, _print and empty values do not belong in a saved filter string");
    });

    await test("no filters on screen means no filters in the test", async () => {
      const r = await testSend({ email: "nobody@example.gov", report: "gl", schedule: "daily",
                                 dateRange: "yesterday", reportParams: "" });
      assert.strictEqual(r.status, 200, r.body);
      assert.strictEqual(r.json.scope.filters, null, "an unfiltered report must not look filtered");
    });

    await test("the keyed object shape works too, so the page can send either", async () => {
      const r = await testSend({ email: "nobody@example.gov", report: "facility", schedule: "weekly",
                                 reportDateRanges: { facility: "next7" }, reportParams: { facility: "location=Main" } });
      assert.strictEqual(r.status, 200, r.body);
      assert.strictEqual(r.json.scope.filters, "location=Main");
      assert.strictEqual(r.json.scope.dateRange, "next7");
    });

    await test("a saved subscription still wins when nothing is overridden", async () => {
      const sub = await post(`/${org}/admin/subscribe?token=${encodeURIComponent(token)}`, {
        email: "saved@example.gov", reports: ["gl"], schedule: "daily",
        reportDateRanges: { gl: "prior30" }, reportParams: { gl: "desks=west" },
      });
      assert.strictEqual(sub.status, 200, sub.body);
      // This is the admin Test button's path, and it must not regress.
      const r = await testSend({ email: "saved@example.gov", report: "gl", schedule: "daily" });
      assert.strictEqual(r.status, 200, r.body);
      assert.strictEqual(r.json.scope.filters, "desks=west", "the saved filters should still be used");
      assert.strictEqual(r.json.scope.dateRange, "prior30");
    });

    await test("an override beats the saved subscription for the same address", async () => {
      const r = await testSend({ email: "saved@example.gov", report: "gl", schedule: "daily",
                                 dateRange: "yesterday", reportParams: "desks=east" });
      assert.strictEqual(r.status, 200, r.body);
      assert.strictEqual(r.json.scope.filters, "desks=east",
        "the modal is showing east — testing west would preview the wrong report");
      assert.strictEqual(r.json.scope.dateRange, "yesterday");
    });

    await test("a real email address is required", async () => {
      for (const email of ["", "   ", "nope", "no@domain", "two words@x.gov"]) {
        const r = await testSend({ email, report: "gl", schedule: "daily", dateRange: "yesterday" });
        assert.strictEqual(r.status, 400, `"${email}" should be rejected, got ${r.status} ${r.body}`);
      }
    });

    await test("a date range the scheduler itself refuses is refused here", async () => {
      // A GL rollup covering today leaves at 7am, before the day has any
      // postings. Sending that as a "test" would teach the reader the report is
      // broken, so it is blocked in the same place the schedule blocks it.
      const r = await testSend({ email: "nobody@example.gov", report: "gl", schedule: "daily", dateRange: "today" });
      assert.strictEqual(r.status, 400, r.body);
      assert.ok(/today|postings|backward/i.test(r.json.error || ""), "the error should say why: " + r.body);
    });

    await test("unknown report types and cadences are rejected", async () => {
      const bad = await testSend({ email: "nobody@example.gov", report: "not-a-report", schedule: "daily" });
      assert.strictEqual(bad.status, 400, bad.body);
      const cadence = await testSend({ email: "nobody@example.gov", report: "gl", schedule: "hourly", dateRange: "yesterday" });
      assert.strictEqual(cadence.status, 400, cadence.body);
    });

    await test("an unknown org is a 404, not a send", async () => {
      const r = await post(`/not-a-real-org/admin/test-send?token=x`, { email: "nobody@example.gov", report: "gl", schedule: "daily" });
      assert.strictEqual(r.status, 404, r.body);
    });

    console.log(`\n${passed}/${passed} passing`);
  } finally {
    try { child.kill("SIGKILL"); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error("\n✗ " + e.message); process.exit(1); });
