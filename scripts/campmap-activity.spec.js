// Spec for the Camping tab's "Public map activity" row.
//
// The campmap is a PUBLIC page whose traffic, until now, only ever surfaced in
// OUR Slack feed. This hands the same events back to the org that owns the
// campground: map views, sites opened, book click-throughs, searches narrowed,
// link shares — one row, per org, last 30 days with a delta.
//
// WHAT THIS PINS, and every one of them is a way to be confidently wrong:
//
// 1. SCOPED TO THIS ORG AND THIS REPORT. The events log is shared by every org
//    and every report. Counting another org's views, or this org's `facility`
//    views, would inflate a number a parks department may take to a council
//    meeting.
// 2. THE PRIOR WINDOW IS THE PRIOR WINDOW. Deltas read 2x the range and must not
//    let the older half leak into the current totals.
// 3. AN EMPTY LOG IS NOT "NOBODY USES YOUR MAP". A fresh volume, a rotated log
//    or a PR preview would otherwise render 0 views over 30 days, which an admin
//    reads as a verdict on their campground rather than an absence of data. The
//    route says how far back it can actually see (`covers` / `logStartsAt`).
// 4. BOTH FILTER EVENTS ARE ONE SIGNAL. `campmap-filter` (type) and
//    `campmap-amenity` count together — "campers narrowed the map" is one thing,
//    and splitting it makes two thin numbers out of one.
// 5. NO RATE ON A HANDFUL OF VIEWS. 6 views and 0 clicks is not 0% conversion,
//    it is not enough traffic to say — so the tile withholds the rate rather
//    than printing a number that reads like a failure.
//
// Run: node scripts/campmap-activity.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ORG = "douglas-county-nv";
const OTHER = "pleasant-hill";
const PORT = 4610 + (process.pid % 300);

let passed = 0;
function ok(name) { console.log(`  ✓ ${name}`); passed++; }

// ── the client half: read the rules out of the page, not out of my memory ────
const PAGE = fs.readFileSync(path.join(ROOT, "public", "facilities.html"), "utf8");
const comp = (() => {
  const i = PAGE.indexOf("function CampMapStats()");
  assert.ok(i > 0, "CampMapStats not found in facilities.html");
  const j = PAGE.indexOf("\n    function PublicMapLink", i);
  return PAGE.slice(i, j > i ? j : i + 6000);
})();

function sourceChecks() {
  assert.ok(/RATE_MIN_VIEWS/.test(comp) && /t\.views >= RATE_MIN_VIEWS/.test(comp),
    "the book-click rate must require a real denominator, or 6 views and 0 clicks prints \"0%\"");
  ok("the rate withholds itself on a thin denominator");

  assert.ok(/d\.covers/.test(comp) && /logStartsAt/.test(comp),
    "the row must label its window from what the log can actually see");
  ok("the window is labelled from the log's real reach");

  // Mounted once per section, not once per location: the events carry no
  // location, so N locations would render N identical rows.
  const mounts = PAGE.match(/e\(CampMapStats\b/g) || [];
  assert.strictEqual(mounts.length, 1,
    `CampMapStats is mounted ${mounts.length} times; it must appear exactly once`);
  // It has to sit OUTSIDE the per-location loop, or N locations render N
  // identical rows and imply each location earned those numbers. The loop's last
  // child is PublicMapLink, so a section-level mount is preceded by that call and
  // the parens that close the loop — never by a comma inside the arrow body.
  const at = PAGE.indexOf("e(CampMapStats");
  const before = PAGE.slice(Math.max(0, at - 90), at);
  assert.ok(/PublicMapLink[\s\S]*\}\)\)\),\s*$/.test(before),
    "CampMapStats must be mounted after the locs.map(...) call closes, not inside it; "
    + "saw: " + JSON.stringify(before.slice(-60)));
  ok("mounted once per section, not once per location");

  assert.ok(/if \(!CFG\.token\) return/.test(comp),
    "a read-only viewer with no token must not fetch analytics");
  ok("no token, no fetch");
}

// ── the behavioural half: boot the server against a known log ───────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "campmap-act-"));
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

// A log built so every trap above would show as a wrong number.
const rows = [];
const ev = (org, report, event, daysAgo, extra) =>
  rows.push(Object.assign({ ts: iso(daysAgo), org, report, event }, extra || {}));

for (let i = 0; i < 40; i++) ev(ORG, "campmap", "view", 1 + (i % 25));           // current: 40
for (let i = 0; i < 25; i++) ev(ORG, "campmap", "view", 31 + (i % 25));          // prior:   25
// 14 site opens with an UNAMBIGUOUS winner: a tie would make topSite depend on
// insertion order, which is a flaky assertion rather than a real one.
for (let i = 0; i < 6; i++) ev(ORG, "campmap", "campmap-site", 2 + i, { site: "Site 07" });
for (let i = 0; i < 4; i++) ev(ORG, "campmap", "campmap-site", 3 + i, { site: "Site 02" });
for (let i = 0; i < 3; i++) ev(ORG, "campmap", "campmap-site", 4 + i, { site: "Site 03" });
for (let i = 0; i < 1; i++) ev(ORG, "campmap", "campmap-site", 5 + i, { site: "Site 04" });
for (let i = 0; i < 5;  i++) ev(ORG, "campmap", "campmap-book", 3 + i, { kind: i % 2 ? "site-page" : "dated" });
for (let i = 0; i < 3;  i++) ev(ORG, "campmap", "campmap-filter", 4 + i, { filterType: "tent" });
for (let i = 0; i < 2;  i++) ev(ORG, "campmap", "campmap-amenity", 6 + i, { amenities: "Fire Pit" });
for (let i = 0; i < 2;  i++) ev(ORG, "campmap", "campmap-share", 5 + i, { kind: "link" });
// Traps: another org's map traffic, and this org's traffic on a DIFFERENT report.
for (let i = 0; i < 99; i++) ev(OTHER, "campmap", "view", 2);
for (let i = 0; i < 50; i++) ev(ORG, "facility", "view", 2);
// And an event outside both windows entirely.
for (let i = 0; i < 77; i++) ev(ORG, "campmap", "view", 200);

rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
fs.writeFileSync(path.join(dataDir, "events.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");

const TOKEN = (() => {
  const s = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const i = s.indexOf(`"${ORG}"`);
  const m = /token:\s*"([^"]+)"/.exec(s.slice(i, i + 400));
  return m ? m[1] : "";
})();
assert.ok(TOKEN, `could not resolve the ${ORG} token`);

const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
         METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
         SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", d => { log += d; });
child.stderr.on("data", d => { log += d; });

function stop(good, msg) {
  try { child.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  if (!good) {
    console.error("\n✗ " + msg);
    if (log) console.error(log.split("\n").slice(-10).join("\n"));
    process.exit(1);
  }
  console.log(`\n${passed}/${passed} passing`);
  process.exit(0);
}

const get = (qs) => fetch(`http://127.0.0.1:${PORT}/${ORG}/facilities/api/campmap-activity?${qs}`)
  .then(async r => ({ status: r.status, body: await r.text() }));

(async () => {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 90000) return stop(false, "server did not start");
    try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; }
    catch (_) { await new Promise(r => setTimeout(r, 500)); }
  }

  try {
    sourceChecks();

    const r = await get(`days=30&token=${encodeURIComponent(TOKEN)}`);
    assert.strictEqual(r.status, 200, "activity route did not answer: " + r.body.slice(0, 120));
    const d = JSON.parse(r.body);

    assert.strictEqual(d.totals.views, 40,
      `views should be this org's campmap views in window; got ${d.totals.views} `
      + `(99 belong to ${OTHER}, 50 to this org's facility report, 77 are older)`);
    assert.strictEqual(d.totals.sites, 14);
    assert.strictEqual(d.totals.books, 5);
    assert.strictEqual(d.totals.shares, 2);
    ok("counts only this org's campmap events, inside the window");

    assert.strictEqual(d.totals.filters, 5,
      "type and amenity filters are one signal — expected 3 + 2");
    ok("both filter events count as one signal");

    assert.strictEqual(d.prior.views, 25,
      "the prior window must hold the older half only");
    assert.strictEqual(d.prior.books, 0);
    ok("the prior window is separate, so the delta is real");

    assert.deepStrictEqual(d.bookKinds, { dated: 3, "site-page": 2 },
      "the book split says which route campers took");
    assert.strictEqual(d.topSite.name, "Site 07", "the most-opened site is the one with 6 opens");
    assert.strictEqual(d.topSite.opens, 6);
    ok("names the most-opened site and the route split");

    assert.strictEqual(d.covers, true, "a log reaching back 200 days covers a 30-day window");
    ok("reports that the window is covered");

    // A tokenless caller gets the global gate's generic 404, not a 403 — that
    // gate exists so a stranger cannot enumerate orgs, and this route must not
    // become the exception that does.
    const bare = await get("days=30");
    assert.strictEqual(bare.status, 404,
      "a tokenless caller must not be able to read an org's traffic");
    const wrong = await get("days=30&token=definitely-not-it");
    assert.strictEqual(wrong.status, 404, "a wrong token must not read it either");
    ok("an org's traffic is not readable without its token");

    stop(true);
  } catch (e) {
    stop(false, e.message);
  }
})();
