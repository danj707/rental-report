// Spec for the Report Wizard's activity in the Slack feed.
//
// WHY THIS EXISTS. The wizard is the highest-signal surface on the platform —
// someone described a report in English and the platform built it — and until
// 2026-08-26 the feed could not see a single run. `generate` has been written to
// events.jsonl since the wizard shipped and was never in SLACK_NOTIFY, so it
// landed in the log and posted nothing. That is the same shape as the campmap and
// Facilities-hub beacon bugs (see CLAUDE.md): the code was correct, the event was
// recorded, and nothing ever reached the channel.
//
// Two halves, because either alone would miss a real regression:
//
//   1. the message + debounce logic, by extracting the REAL SLACK block from
//      server.js and running notifySlack() against a mock webhook. This is where
//      the debounce KEYS are proven: a default org|report|event key silently
//      throws away the second of two different prompts a minute apart, which is
//      exactly the interesting case.
//   2. live behaviour: boot the server, POST the save beacon, and require a 200
//      AND a row in events.jsonl. `report-wizard` is NOT in REPORT_TYPES, so the
//      beacon needs its own route registered ABOVE the generic
//      /:org/:report/api/log — moving it below is the fourth instance of that
//      bug and this spec fails on it by name.
//
// Run: node scripts/wizard-activity.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");

// The wizard is PARKED for every org in production (WIZARD_ENABLED_ORGS empty).
// Its behaviour still has to be guarded, or un-parking it later is a leap of
// faith — so the servers these specs boot enable it explicitly. Every org slug
// this repo serves, comma-joined, is overkill by design: a spec should not have
// to know which org it picked.
const WIZ_ORGS = (() => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const i = src.indexOf("const ORGS = {");
  const j = src.indexOf("\nconst REPORT_TYPES", i);
  return Object.keys(require("vm").runInNewContext(
    "(" + src.slice(src.indexOf("{", i), j).trim().replace(/;$/, "") + ")")).join(",");
})();
const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const page = fs.readFileSync(path.join(ROOT, "public", "report-wizard.html"), "utf8");

let passed = 0;
const test = (name, fn) => Promise.resolve(fn()).then(() => { console.log("  ✓ " + name); passed++; });

function at(needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `server.js no longer contains ${needle}`);
  return i;
}

// ── The real notifySlack, with a mock webhook ────────────────────────────────
// Same extraction the email spec uses. `alertEnabled` is defined further up
// server.js than the block, so it is injected — it gates the watchdog alerts and
// returns true for every activity event.
const blockStart = src.indexOf("const SLACK_NOTIFY = new Set(");
const blockEnd = src.indexOf("// Read events file");
assert.ok(blockStart !== -1 && blockEnd > blockStart, "could not locate the SLACK block in server.js");
const SLACK_BLOCK = src.slice(blockStart, blockEnd);

function harness(opts) {
  const posts = [];
  const deps = {
    SLACK_WEBHOOK_URL: "https://hooks.slack/test",
    SLACK_MENTION_USER_ID: (opts && opts.mention) || "",
    ORGS: { pawnee: { displayName: "City of Pawnee", token: "tok" } },
    BASE_URL: "https://reports.example",
    fetch: (url, o) => { posts.push(JSON.parse(o.body).text); return Promise.resolve(); },
    AbortSignal: { timeout: () => undefined },
    alertEnabled: () => true,
  };
  const names = Object.keys(deps);
  const { notifySlack } = new Function(...names, SLACK_BLOCK + "\nreturn { notifySlack };")
    (...names.map(n => deps[n]));
  return { notifySlack, posts };
}

const RUN = { org: "pawnee", report: "report-wizard", event: "generate",
              title: "Top 10 Programs by Revenue", widgets: 4, sources: "programs, gl",
              prompt: "Top 10 programs by revenue with enrollment details" };

(async () => {
  // ── 1. the events reach Slack at all ──────────────────────────────────────
  await test("generate is a notifiable event — it was logged and never posted before this", () => {
    const m = /const SLACK_NOTIFY = new Set\((\[[^\]]+\])\)/.exec(src);
    assert.ok(m, "SLACK_NOTIFY not found");
    const set = JSON.parse(m[1]);
    ["generate", "wizard-save", "feedback"].forEach(e => assert.ok(set.includes(e),
      `${e} is missing from SLACK_NOTIFY — it lands in events.jsonl and posts nothing`));
  });

  await test("a wizard run posts the TITLE, the widget count, the sources and the prompt", () => {
    const { notifySlack, posts } = harness();
    notifySlack(RUN);
    assert.strictEqual(posts.length, 1, "a generate should post");
    assert.match(posts[0], /City of Pawnee \(`pawnee`\)/);
    assert.match(posts[0], /\*Top 10 Programs by Revenue\*/, "the title is the readable part");
    assert.match(posts[0], /4 widgets/);
    assert.match(posts[0], /from programs, gl/, "which data it drew on");
    assert.match(posts[0], /Top 10 programs by revenue with enrollment details/,
      "the PROMPT is the whole event — it is the only place we learn what reports orgs wish they had");
  });

  await test("the prompt is clamped, so a pasted essay cannot flood the channel", () => {
    const { notifySlack, posts } = harness();
    notifySlack(Object.assign({}, RUN, { prompt: "x".repeat(4000) }));
    assert.ok(posts[0].length < 400, "message length " + posts[0].length);
  });

  // ── 2. debounce keys — the part a default key gets wrong ───────────────────
  await test("TWO DIFFERENT prompts a minute apart post twice, not once", () => {
    const { notifySlack, posts } = harness();
    notifySlack(RUN);
    notifySlack(Object.assign({}, RUN, { title: "Fill Rates by Location",
      prompt: "fill rates by location" }));
    assert.strictEqual(posts.length, 2,
      "keyed by org|report|event these collapse, and someone exploring three questions " +
      "reads as one — the questions asked ARE the signal");
  });

  await test("the same prompt re-run inside the cooldown is a retry, and is debounced", () => {
    const { notifySlack, posts } = harness();
    notifySlack(RUN); notifySlack(RUN);
    assert.strictEqual(posts.length, 1);
  });

  await test("a thumbs-down then a thumbs-up on the same report posts BOTH", () => {
    const { notifySlack, posts } = harness();
    const fb = v => ({ org: "pawnee", report: "report-wizard", event: "feedback", vote: v,
                       title: "Top 10 Programs by Revenue", prompt: "top 10 programs" });
    notifySlack(fb("down"));
    notifySlack(fb("up"));
    assert.strictEqual(posts.length, 2,
      "a reader who changes their mind has told us two things; keyed by org|report|event " +
      "only whichever landed first survives");
    assert.ok(posts[0].indexOf("👎") === 0, "first line is the thumbs-down: " + posts[0]);
    assert.ok(posts[1].indexOf("👍") === 0, "second line is the thumbs-up: " + posts[1]);
  });

  await test("the same vote twice in a row is debounced", () => {
    const { notifySlack, posts } = harness();
    const fb = { org: "pawnee", report: "report-wizard", event: "feedback", vote: "up", title: "T" };
    notifySlack(fb); notifySlack(fb);
    assert.strictEqual(posts.length, 1);
  });

  await test("a wizard thumb names the REPORT that was rated, not the report type twice", () => {
    const { notifySlack, posts } = harness();
    notifySlack({ org: "pawnee", report: "report-wizard", event: "feedback", vote: "down",
                  title: "Top 10 Programs by Revenue", comment: "the revenue column is empty",
                  prompt: "top 10 programs by revenue" });
    assert.match(posts[0], /\*Top 10 Programs by Revenue\*/,
      "the old shared branch printed 'Report Wizard on *report-wizard*' — the type twice " +
      "and the report itself never");
    assert.match(posts[0], /the revenue column is empty/,
      "the comment is the entire reason a thumbs-down is worth reading");
    assert.ok(posts[0].indexOf("on *report-wizard*") < 0, "still the old shape: " + posts[0]);
  });

  await test("saving a generated report posts its own line", () => {
    const { notifySlack, posts } = harness();
    notifySlack({ org: "pawnee", report: "report-wizard", event: "wizard-save",
                  title: "Fill Rates by Location", widgets: 5 });
    assert.match(posts[0], /saved \*Fill Rates by Location\*/);
    assert.match(posts[0], /5 widgets/);
  });

  await test("saving two DIFFERENT reports posts twice", () => {
    const { notifySlack, posts } = harness();
    notifySlack({ org: "pawnee", report: "report-wizard", event: "wizard-save", title: "A", widgets: 3 });
    notifySlack({ org: "pawnee", report: "report-wizard", event: "wizard-save", title: "B", widgets: 3 });
    assert.strictEqual(posts.length, 2);
  });

  await test("the other feedback surfaces are untouched by the wizard's own branch", () => {
    const { notifySlack, posts } = harness();
    notifySlack({ org: "pawnee", report: "gl", event: "insights-feedback", score: 1 });
    assert.strictEqual(posts[0], "👍 City of Pawnee (`pawnee`) AI Insights on *gl*");
    const h2 = harness();
    h2.notifySlack({ org: "pawnee", report: "facility", event: "chat-feedback", vote: "down" });
    assert.strictEqual(h2.posts[0], "👎 City of Pawnee (`pawnee`) Rec AI Chat on *facility*");
    const h3 = harness();
    h3.notifySlack({ org: "pawnee", report: "gl", event: "vote", sentiment: "up" });
    assert.strictEqual(h3.posts[0], "👍 City of Pawnee (`pawnee`) Report on *gl*");
  });

  await test("a wizard page view still reads as a plain view (no regression)", () => {
    const { notifySlack, posts } = harness();
    notifySlack({ org: "pawnee", report: "report-wizard", event: "view" });
    assert.strictEqual(posts[0], "👀 City of Pawnee (`pawnee`) viewed *report-wizard*");
  });

  // ── 3. the save beacon's route ─────────────────────────────────────────────
  // SKIP_SOURCE=1 turns the source half off so the LIVE half below can be shown
  // to catch a route moved under the generic one on its own. A regex over our own
  // patch is not evidence the beacon reaches the server.
  const SOURCE = !process.env.SKIP_SOURCE;
  if (SOURCE) await test("the wizard log route is registered BEFORE the generic /:org/:report one", () => {
    assert.ok(at('app.post("/:org/report-wizard/api/log",') < at('app.post("/:org/:report/api/log", resolveOrg,'),
      "declared after the generic route — Express matches that one first and resolveOrg " +
      "404s it, which is exactly how the campmap share ping and every Facilities-hub " +
      "beacon died. A fire-and-forget beacon never complains.");
  });

  if (SOURCE) await test("`report-wizard` really is not a report type — the reason the route has to exist", () => {
    const m = /const REPORT_TYPES = (\[[^\]]+\])/.exec(src);
    assert.ok(m, "REPORT_TYPES not found");
    assert.ok(!JSON.parse(m[1]).includes("report-wizard"),
      "if it ever becomes one the generic route would serve this, but do not delete this " +
      "route without checking — it would then log under a second name");
  });

  if (SOURCE) await test("the page's save beacon uses ?event= in the QUERY STRING, not a JSON body", () => {
    // The Memberships and Instructor-Payout beacons POSTed {action:'excel'} as a
    // body to a route that reads req.query.event, so every call came back
    // 400 Unknown event from the day each shipped (CLAUDE.md, third instance).
    assert.match(page, /\/report-wizard\/api\/log\?event=wizard-save/,
      "the convention is ?event=<name> in the query string");
  });

  // ── 4. live behaviour ─────────────────────────────────────────────────────
  const PORT = 3993;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-activity-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
           METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
           SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "",
           // The wizard is PARKED for every org in production. Its behaviour
           // still has to be guarded, or un-parking it later is a leap of
           // faith — so this spec's server enables it explicitly.
           WIZARD_ENABLED_ORGS: WIZ_ORGS },
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

  const post = (p) => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: p, timeout: 20000 },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res({ status: r.statusCode, body: b })); });
    req.on("error", rej); req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end();
  });

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("server did not boot\n" + log.slice(-600)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, x => { x.resume(); res(); });
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

    await test("the save beacon answers 200 AND records a row", async () => {
      const r = await post(`/${org}/report-wizard/api/log?event=wizard-save&title=Fill%20Rates&n=5&${TOK}`);
      assert.strictEqual(r.status, 200, r.body);
      const rec = events().find(x => x.event === "wizard-save");
      assert.ok(rec, "nothing reached events.jsonl — a 200 alone does not prove it recorded");
      assert.strictEqual(rec.report, "report-wizard");
      assert.strictEqual(rec.title, "Fill Rates");
      assert.strictEqual(rec.widgets, 5);
    });

    await test("an unknown event is rejected rather than silently logged", async () => {
      const r = await post(`/${org}/report-wizard/api/log?event=whatever&${TOK}`);
      assert.strictEqual(r.status, 400, r.body);
      assert.ok(!events().some(x => x.event === "whatever"));
    });

    await test("an absurd widget count is dropped, not recorded", async () => {
      await post(`/${org}/report-wizard/api/log?event=wizard-save&title=X&n=9999&${TOK}`);
      const rec = events().filter(x => x.event === "wizard-save").pop();
      assert.strictEqual(rec.widgets, undefined);
    });

    await test("a tokenless caller gets a 404 and writes nothing", async () => {
      const before = events().length;
      const r = await post(`/${org}/report-wizard/api/log?event=wizard-save&title=X`);
      assert.strictEqual(r.status, 404, "the global org-token gate 404s rather than 403s, by design");
      assert.strictEqual(events().length, before);
    });

    await test("an unknown org is a 404, not a row", async () => {
      const r = await post(`/not-a-real-org/report-wizard/api/log?event=wizard-save&${TOK}`);
      assert.strictEqual(r.status, 404, r.body);
    });

    console.log(`\n${passed}/${passed} passing`);
  } finally {
    try { child.kill("SIGKILL"); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error("\n✗ " + e.message); process.exit(1); });
