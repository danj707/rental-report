#!/usr/bin/env node
/**
 * WHAT AN ORG CAN SEE WITHOUT DAN SAYING SO.
 *
 * Dan, 2026-09-14: "make sure you add it to each org's dashboard, not
 * viewable. I'll enable viewing for the orgs I want." And then the standing
 * rule: "by default all new reports should be hidden unless I say otherwise."
 *
 * A visibility default is the one kind of change that ships to 29 dashboards
 * the moment it merges and is invisible in review — the diff says
 * `new Set([])`, and the consequence is every org seeing a report nobody
 * asked them to see. So the SET of reports visible by default is FROZEN here:
 * adding one fails this spec rather than appearing on every org page.
 *
 * SKIP_SOURCE=1 drops the source half.
 */
const fs = require("fs");
const path = require("path");

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) passed++; else failures.push(l); };
const eq = (a, b, l) => ok(a === b, l + " — expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ── Lift the real Sets and the real predicate, rather than regexing them.
// A regex over `new Set([...])` passes on an inverted comparison inside
// reportHiddenForOrg, which is where the whole meaning lives.
function lift(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error("marker not found: " + startMarker);
  const j = src.indexOf(endMarker, i);
  return src.slice(i, j);
}
const defaultHidden = new Function(
  lift("const DEFAULT_HIDDEN_REPORTS = new Set(", ";\n") + ";\nreturn DEFAULT_HIDDEN_REPORTS;")();
const hiddenFn = new Function("DEFAULT_HIDDEN_REPORTS", "getHiddenReports",
  lift("function reportHiddenForOrg(slug, rt) {", "\n}") + "\n}\nreturn reportHiddenForOrg;");

/* ── THE INVERSION, RUN ──────────────────────────────────────────────────
   For a default-hidden report, "listed in the org's hidden array" means
   SHOWN. Getting this backwards is not a subtle bug: it shows the report to
   every org that has not opted in, which is all of them. */
{
  const reportHiddenForOrg = hiddenFn(defaultHidden, (slug) => (slug === "optedin" ? ["opportunities"] : []));
  eq(reportHiddenForOrg("nobody", "opportunities"), true,
    "an org that has said nothing does NOT see Opportunities");
  eq(reportHiddenForOrg("optedin", "opportunities"), false,
    "…and an org Dan has turned on does");
  // An ordinary report keeps the ordinary meaning, or this change would have
  // inverted every other toggle on the platform.
  const ordinary = hiddenFn(defaultHidden, (slug) => (slug === "hid" ? ["gl"] : []));
  eq(ordinary("hid", "gl"), true, "a normal report is hidden when it is listed");
  eq(ordinary("nobody", "gl"), false, "…and visible when it is not");
}

/* ── DAN'S STANDING RULE, AS A FROZEN LIST ───────────────────────────────
   "by default all new reports should be hidden unless I say otherwise."
   This is the assertion that fails when somebody ships a report everyone can
   see. It is deliberately a WHITELIST of what may be visible, not a blacklist
   of what must be hidden — a blacklist is satisfied by forgetting to add to
   it, which is exactly how this would go wrong. */
{
  ok(defaultHidden.has("opportunities"), "Opportunities is hidden by default");
  /* Facilities is NOT here, and that is correct: it graduated from opt-in to
     visible-by-default in a recorded one-time migration. The first draft of
     this spec asserted it was still hidden and failed on correct code. */
  ok(!defaultHidden.has("facilities"), "Facilities graduated to visible-by-default and stays that way");
  /* Reports that MAY be visible without Dan asking. Anything not in this list
     must be in DEFAULT_HIDDEN_REPORTS. To add one, get his say-so and add it
     here in the same commit — which is the point: the decision becomes a diff
     somebody has to justify. */
  const MAY_BE_VISIBLE = new Set([
    "gl", "facility", "programs", "programs-schedule", "roster", "memberships",
    "calendar", "fasttrack", "waitlist", "products", "users", "qoq",
    "instructor-payout", "historic", "ice-calendar", "court-utilization",
    "rentalcalendar", "chat", "report-wizard", "directors-report", "lessons", "facilities",
    "section-detail", "selfservice", "program-checkins", "program-demographics",
    "retention", "checkins", "annual-report", "overview", "campmap",
    "aquatic-lane-hours", "aquatics-classes", "aquatics-dropin",
    "aquatic-passes", "all-users", "credit-balances", "credit-ledger",
    "enrollments", "opportunities-legacy",
  ]);
  defaultHidden.forEach(r => ok(!MAY_BE_VISIBLE.has(r),
    r + " is default-hidden, so it must not also be listed as may-be-visible"));
  ok(!MAY_BE_VISIBLE.has("opportunities"),
    "Opportunities is NOT on the may-be-visible list — Dan turns it on per org");
}

if (!process.env.SKIP_SOURCE) {
  /* ── EVERY SURFACE HAS TO AGREE, and they are six different code paths.
     A card hidden on the org page while the cross-project API reports it
     visible is how rec-dashboard starts linking orgs to a report they cannot
     open — the town-of-shrewsbury 404 in a new costume. */

  // The org's own dashboard.
  ok(/if \(!reportHiddenForOrg\(slug, 'opportunities'\)\) available\.push\('opportunities'\);/.test(src),
    "the org dashboard adds the card through the inverted gate");

  // The page, the data route, the PDF and the insights route — ONE switch.
  const gate = src.slice(src.indexOf("const opportunitiesEnabled ="), src.indexOf("function oppWindow"));
  ok(/reportHiddenForOrg\(slug, "opportunities"\)/.test(gate),
    "the PAGE reads the same per-org state the card does, so 'not viewable' means not viewable");
  ok(!/OPPORTUNITIES_ALL_ORGS|OPPORTUNITIES_EXCLUDED/.test(src),
    "the two flags it replaced are GONE, not left unread — two lists is the bug");

  // The toggle Dan actually clicks. Without this the POST 400s and there is
  // no way to turn the report on for anybody.
  /* SCOPED TO THE TOGGLE ROUTE ITSELF. `if (!REPORT_TYPES.includes(report)`
     appears TWICE in server.js — the other is a subscription route — and an
     unanchored indexOf landed on that one, so this assertion was reading code
     it was not about and failed on a correct build. An assertion satisfied (or
     refuted) by different code is not guarding the thing it names. */
  const toggle = src.slice(src.indexOf('app.post("/api/admin/toggle-report"'));
  // Bounded by the allowlist's own end, not a character count: the line is
  // ~400 chars of `report !== "…"` and a fixed slice stopped short of it.
  ok(/report !== "opportunities"/.test(toggle.slice(0, toggle.indexOf("Unknown report type"))),
    "the visibility toggle ACCEPTS opportunities — otherwise Dan cannot enable it at all");

  // The admin grid card that carries that toggle.
  ok(/toggleVis\('\$\{slug\}','opportunities'/.test(src),
    "the admin grid renders a visibility toggle for it");
  ok(/const oppHidden = reportHiddenForOrg\(slug, 'opportunities'\)/.test(src),
    "…and reads the inverted default so a fresh org shows it as hidden");

  // The cross-project visibility API.
  const visApi = src.slice(src.indexOf('app.get("/api/org-visibility/:slug"'),
                           src.indexOf("// ── Token gate"));
  ok(!/visible: !hidden\.has\(rt\)/.test(visApi),
    "the visibility API does not report a default-hidden report as visible");
  ok(/visible: !reportHiddenForOrg\(slug, rt\)/.test(visApi),
    "…it goes through the same predicate every other surface does");

  // The daily job spends ~260 Metabase queries; it must follow the switch.
  ok(/Object\.keys\(ORGS\)\.filter\(opportunitiesEnabled\)/.test(src),
    "the 05:20 job only builds snapshots for orgs that are turned on");
}

/* ── THE LIVE HALF ───────────────────────────────────────────────────────
   NO SOURCE ASSERTION CAN SEE ANY OF THIS. Six code paths have to agree, and
   each of them reads correctly on its own. So this boots a real server and
   drives the real routes: hidden, refused, toggled, opened.

   SKIP_LIVE=1 drops it; the source half still runs on every PR. */
if (!process.env.SKIP_LIVE) {
  const { spawnSync, spawn } = require("child_process");
  const http = require("http"), os = require("os");
  const PORT = 3991 + (process.pid % 40);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oppvis-"));
  const PW = "spec-pw-" + Date.now();
  fs.writeFileSync(path.join(dataDir, "prewarm-state.json"),
    JSON.stringify({ lastCompletedAt: new Date().toISOString() }));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DASHBOARD_PASSWORD: PW,
           METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
           SKIP_PREWARM: "1", PREWARM_STARTUP_SKIP_MS: "999999999" },
    stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});

  /* THE ORG TOKEN, or every page assertion below is VACUOUS — without it the
     org-token middleware 404s the page whatever the visibility gate says,
     which is exactly how the first draft of this check "proved" the page was
     refused while proving nothing. Read from ORGS, never printed. */
  const blk = src.slice(src.indexOf("  apex: {"), src.indexOf("  apex: {") + 400);
  const TOKEN = (blk.match(/token:\s*"([^"]+)"/) || [])[1];
  const q = "?token=" + encodeURIComponent(TOKEN || "");

  const get = (p_) => new Promise(r => {
    http.get({ host: "127.0.0.1", port: PORT, path: p_ }, res => {
      let b = ""; res.on("data", d => b += d); res.on("end", () => r({ status: res.statusCode, body: b }));
    }).on("error", e => r({ status: 0, body: String(e) }));
  });
  const post = (p_, obj) => new Promise(r => {
    const body = JSON.stringify(obj);
    const rq = http.request({ host: "127.0.0.1", port: PORT, path: p_, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      res => { let b = ""; res.on("data", d => b += d); res.on("end", () => r({ status: res.statusCode, body: b })); });
    rq.on("error", e => r({ status: 0, body: String(e) })); rq.write(body); rq.end();
  });

  (async () => {
    for (let i = 0; i < 90; i++) { if ((await get("/")).status) break; await new Promise(s => setTimeout(s, 400)); }
    const slug = "apex";
    ok(!!TOKEN, "the org token was found, or every page assertion here is vacuous");

    const before = JSON.parse((await get("/api/org-visibility/" + slug)).body || "{}");
    const b0 = (before.available || []).find(a => a.type === "opportunities");
    ok(b0 && b0.visible === false, "the visibility API reports it HIDDEN before anyone opts in");

    // WITH a valid token, so the only thing refusing it is the visibility gate.
    const pg = await get("/" + slug + "/opportunities" + q);
    eq(pg.status, 404, "an org that is not turned on cannot reach the page by URL either");

    const t2 = await post("/api/admin/toggle-report", { password: PW, org: slug, report: "opportunities" });
    eq(t2.status, 200, "the toggle ACCEPTS opportunities — without this Dan cannot enable it at all");

    const pg2 = await get("/" + slug + "/opportunities" + q);
    ok(pg2.status !== 404, "…and one switch opens the page as well as the card — got " + pg2.status);

    const after = JSON.parse((await get("/api/org-visibility/" + slug)).body || "{}");
    const a2 = (after.available || []).find(x => x.type === "opportunities");
    ok(a2 && a2.visible === true, "…and every surface then agrees it is visible");

    try { child.kill("SIGKILL"); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    report();
  })();
} else { report(); }

function report() {
if (failures.length) {
  console.error("\n" + failures.length + " FAILED:");
  failures.forEach(f => console.error("  ✗ " + f));
  process.exit(1);
}
console.log(passed + " assertions passed.");
}
