// Spec for the Data Reports card in the ADMIN per-org report grid.
//
// WHY THIS EXISTS. Dan, 2026-09-11, with a screenshot of El Segundo's admin
// view: "add the el segundo 'data reports' card onto the admin org view for el
// segundo, it's missing from there so I can turn it on or off."
//
// It was missing because the admin grid is built from REPORT_TYPES, and the
// custom data reports are a SEPARATE registry (CUSTOM_REPORTS) that never
// enters it. The org page draws them as ONE card with a chip per report; the
// admin had no row at all, so the only surface that can hide a report could not
// see the one card an org actually looks at.
//
// THE CARD IS N KEYS BEHIND ONE SWITCH, which is the whole reason this needs a
// guard rather than a line of markup:
//   * the stored hidden list holds the individual report keys, never the card's,
//   * so "is the card hidden" is a SET question (org.html renders the card iff
//     at least one survives), and
//   * the toggle has to flip the whole set, or the org page is left showing a
//     card with some chips missing, which is a state nobody asked for.
//
// Both halves are checked, because either alone would miss it: the source
// wiring, and the REAL route driven against a booted server with a real org.
//
// Run: node scripts/admin-data-reports-toggle.spec.js
//      SKIP_SOURCE=1 node scripts/admin-data-reports-toggle.spec.js   (live only)
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
const test = (name, fn) => Promise.resolve(fn()).then(() => { console.log(`  ✓ ${name}`); passed++; });

/* The El Segundo org id, read from server.js rather than pasted — a literal
   here would keep passing after the constant moved. */
const EL_SEGUNDO = (/elSegundo:\s*"([0-9a-f-]+)"/.exec(src) || [])[1];
/* A PORT PER RUN. A fixed one collides with the previous run's server while it
   is still draining - back-to-back runs then fail with "socket hang up", which
   reads as a code failure and is the stray-server trap this project already
   records. A flaky guard is not a guard. */
const PORT = 3900 + Math.floor(Math.random() * 90);
const PWD = "data-reports-spec";
const ORG = "spec-aquatics";
const TOKEN = "spec-aquatics-token";

(async () => {
  if (!process.env.SKIP_SOURCE) {
    await test("there is a synthetic key for the card, and it is not a report type", () => {
      assert.ok(/const DATA_REPORTS_KEY = "data-reports";/.test(src), "DATA_REPORTS_KEY is gone");
      const types = JSON.parse(/const REPORT_TYPES = (\[[^\]]+\])/.exec(src)[1]);
      assert.ok(!types.includes("data-reports"),
        "if this ever becomes a real report type it gets a route, a card and a feed — " +
        "it is a stand-in for a SET and must not look like one report");
    });

    await test("the admin grid offers it, and only to orgs that have one", () => {
      assert.ok(/if \(customReportsForOrg\(slug\)\.length\) available\.push\(DATA_REPORTS_KEY\);/.test(src),
        "the admin available list no longer gates the row on the org having any custom reports — " +
        "an org with none would get a row it can never switch on");
    });

    await test("it has a label, and the description is the card's own wording", () => {
      const m = /\[DATA_REPORTS_KEY\]:\s*\{([^}]+)\}/.exec(src);
      assert.ok(m, "no reportMeta entry — the grid would render the raw key as its label");
      assert.ok(/label: "Data Reports"/.test(m[1]), "the label must match the card on the org page");
      const page = fs.readFileSync(path.join(ROOT, "public", "org.html"), "utf8");
      const desc = /desc: "([^"]+)"/.exec(m[1])[1];
      assert.ok(page.includes(desc),
        "the admin description has drifted from the card org.html actually draws: " + desc);
      /* THE REPORT META MAP LIVES INSIDE THE GIANT TEMPLATE LITERAL. One
         apostrophe there collapses a 201KB script and every button on the admin
         page silently stops working — it has shipped once already. */
      assert.ok(!/'/.test(m[1]), "no apostrophes in this map; reword rather than escape");
    });

    await test("the card opens a REAL report rather than the synthetic key", () => {
      assert.ok(/customReportsForOrg\(slug\)\[0\]\}\$\{tokenQS\}/.test(src),
        "`/:slug/data-reports` is not a route — the tile would 404, which is the dead-end " +
        "pattern this project keeps writing down");
    });

    await test("the client takes the server's answer instead of re-deriving it", () => {
      assert.ok(/typeof data\.hiddenNow === 'boolean'/.test(src),
        "the client re-derives hidden state from the stored list — that list holds the " +
        "individual report keys and never the card's, so the card would read as visible " +
        "the instant it was hidden");
    });
  }

  // ── live: the real route, a real org, a real store ────────────────────────
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-toggle-"));
  /* A DYNAMIC ORG, written BEFORE the spawn. El Segundo is not in server.js's
     ORGS map, and loadDynamicOrgs() runs at module scope, so an org written
     after the boot is never seen. The orgId is what CUSTOM_REPORTS gates on. */
  fs.writeFileSync(path.join(dataDir, "orgs.json"), JSON.stringify({
    [ORG]: { token: TOKEN, orgId: EL_SEGUNDO, logoUrl: "", displayName: "Spec Aquatics" },
  }));
  fs.writeFileSync(path.join(dataDir, "prewarm-state.json"),
    JSON.stringify({ lastCompletedAt: Date.now() }));

  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
           METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
           SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: PWD, SKIP_PREWARM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const basic = "Basic " + Buffer.from("admin:" + PWD).toString("base64");
  const req = (method, p, body) => new Promise((res, rej) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: basic };
    if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 20000, headers },
      x => { let b = ""; x.on("data", d => b += d); x.on("end", () => res({ status: x.statusCode, body: b })); });
    r.on("error", rej); r.on("timeout", () => { r.destroy(); rej(new Error("timeout " + p)); });
    if (payload) r.write(payload);
    r.end();
  });
  const toggle = (org, report) => req("POST", "/api/admin/toggle-report", { password: PWD, org, report })
    .then(r => ({ status: r.status, json: (() => { try { return JSON.parse(r.body); } catch { return {}; } })() }));
  const orgReports = async () => {
    const r = await req("GET", `/${ORG}?token=${TOKEN}`);
    const m = /ORG_CONFIG\s*=\s*(\{[\s\S]*?\});/.exec(r.body);
    assert.ok(m, "no ORG_CONFIG in the org page");
    return JSON.parse(m[1]).reports || [];
  };

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 90000) return rej(new Error("server did not boot\n" + log.slice(-800)));
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/healthz", timeout: 3000 },
          x => { x.resume(); res(); });
        r.on("error", () => setTimeout(tick, 400));
        r.on("timeout", () => { r.destroy(); setTimeout(tick, 400); });
      }; tick();
    });

    let custom = [];
    await test("the fixture org really has custom reports — without this the rest is vacuous", async () => {
      custom = (await orgReports()).filter(r => /^(aquatic-|all-users)/.test(r));
      assert.ok(custom.length >= 2,
        "expected El Segundo's data reports on the org page, got " + JSON.stringify(custom));
    });

    /* THE GRID IS THE THING DAN LOOKED AT. Every assertion above is about the
       route and the org page; a row that never renders would pass all of them,
       which is precisely the shape of the bug being fixed. So read the admin
       HTML and require the tile, with a real href and the card's label. */
    await test("the admin grid actually RENDERS a Data Reports tile for the org", async () => {
      const r = await req("GET", "/");
      assert.strictEqual(r.status, 200, "admin page did not render: " + r.status);
      const open = new RegExp(
        '<a href="/' + ORG + '/([a-z0-9-]+)[^"]*"[^>]*data-report="data-reports"'
      ).exec(r.body);
      assert.ok(open, "no Data Reports tile in the admin grid for " + ORG);
      assert.ok(custom.includes(open[1]),
        "the tile links to " + open[1] + ", which is not one of this org's reports");
      /* SCOPED TO THE TILE - everything from its opening tag to the next card's.
         A bare body.includes("Data Reports") passes on the string appearing
         anywhere else on a 200KB admin page, and it survived its own mutation,
         which is the only reason that was found. */
      const rest = r.body.slice(open.index + open[0].length);
      const nxt = rest.indexOf('data-report="');
      const tile = nxt >= 0 ? rest.slice(0, nxt) : rest;
      assert.ok(/report-label">Data Reports/.test(tile),
        "the tile renders without the card's label: " + tile.slice(0, 260));
    });

    await test("turning the card OFF hides EVERY report behind it, not just one", async () => {
      const r = await toggle(ORG, "data-reports");
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.hiddenNow, true, "the server must report the card as hidden");
      assert.strictEqual(r.json.label, "Data Reports", "the toast would name the raw key");
      const after = await orgReports();
      const left = custom.filter(k => after.includes(k));
      assert.deepStrictEqual(left, [],
        "the org page still shows " + JSON.stringify(left) + " — a card with some chips missing " +
        "is the half state this flips as a set to avoid");
    });

    await test("...and the card is gone from the org page, not merely emptied", async () => {
      const after = await orgReports();
      assert.ok(after.length > 0, "the whole report list vanished — this should touch only the card");
      assert.ok(after.includes("facility"), "an unrelated report was hidden too");
    });

    await test("turning it back ON restores every one of them", async () => {
      const r = await toggle(ORG, "data-reports");
      assert.strictEqual(r.json.hiddenNow, false, "the server must report the card as visible again");
      const after = await orgReports();
      custom.forEach(k => assert.ok(after.includes(k), k + " did not come back"));
    });

    /* THE MIXED STATE IS THE ONE THAT DECIDES WHAT "HIDDEN" MEANS. org.html
       renders the card iff at least one report survives, so with six of seven
       hidden the card IS still on screen and reporting it hidden would be a
       statement the reader can see is false. */
    await test("one report hidden by itself leaves the card VISIBLE", async () => {
      /* ASSERT THE SETUP TOOK. This step used to 400 silently - the route
         rejected individual custom keys - so the mixed state was never created
         and the whole case passed on a build that got the rule backwards.
         Mutation testing is what surfaced that, not review. */
      const setup = await toggle(ORG, custom[0]);
      assert.strictEqual(setup.status, 200,
        "could not hide one report on its own, so there is no mixed state to test: " +
        JSON.stringify(setup.json));
      assert.strictEqual(setup.json.hiddenNow, true, "the single report did not go hidden");
      const r = await toggle(ORG, "data-reports");   // flips from visible -> hidden
      assert.strictEqual(r.json.hiddenNow, true,
        "with one of several hidden the card is still drawn, so the switch had to be reading it " +
        "as visible and is not");
      const after = await orgReports();
      assert.deepStrictEqual(custom.filter(k => after.includes(k)), [],
        "hiding from a mixed state must still clear ALL of them");
      await toggle(ORG, "data-reports");             // leave it as we found it
    });

    await test("an org with no data reports is refused rather than given an empty switch", async () => {
      /* Any org from the code ORGS map: none of them carries El Segundo's orgId,
         so none has a custom report. Read rather than hardcoded, so this keeps
         testing what it names if that org is ever renamed. */
      const plain = (/\n  "([a-z0-9-]+)": \{\n\s+token:/.exec(src) || [])[1];
      assert.ok(plain && plain !== ORG, "no plain org found in server.js to test against");
      const r = await toggle(plain, "data-reports");
      assert.strictEqual(r.status, 400,
        "a toggle that stores nothing and reports success is worse than an error");
    });

    await test("the password still gates it", async () => {
      const r = await req("POST", "/api/admin/toggle-report",
        { password: "wrong", org: ORG, report: "data-reports" });
      assert.ok(r.status === 401 || r.status === 403, "expected a refusal, got " + r.status);
    });

    await test("an unknown key is still rejected", async () => {
      const r = await toggle(ORG, "not-a-report");
      assert.strictEqual(r.status, 400);
    });
  } finally {
    child.kill("SIGTERM");
  }

  console.log(`\n✓ admin-data-reports-toggle.spec.js — ${passed} checks passed.`);
})().catch(e => { console.error("\n✗ " + e.message); process.exit(1); });
