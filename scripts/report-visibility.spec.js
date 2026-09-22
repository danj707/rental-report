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
  /* ── THE SEED APPLIES ONCE, AND THAT IS THE WHOLE POINT ────────────────
     Dan: "enable the observations report for Watertown too." A seed is an
     INITIAL VALUE. Without a marker every deploy would re-enable a report he
     had since switched off — the switch works, then silently un-works
     overnight, which is worse than it never having worked. */
  const seedBlk = src.slice(src.indexOf("const REPORT_VISIBILITY_SEEDS = {"),
                            src.indexOf("})();", src.indexOf("function seedReportVisibility")));
  ok(/"opportunities:2026-09-14":[\s\S]*orgs: \["watertown"\]/.test(seedBlk),
    "Watertown is seeded to see Opportunities");
  ok(/if \(applied\[key\]\) continue;/.test(seedBlk),
    "…ONCE — an applied seed never runs again, so hiding it later sticks");
  ok(/writeJSON\(seedFile, applied\)/.test(seedBlk),
    "…and the marker is written, or 'once' is a comment rather than a fact");
  ok(/if \(!ORGS\[slug\]\)/.test(seedBlk),
    "…and an org this server does not serve gets no phantom entry");

  /* ── A SEED FOR AN ORG NOT HERE YET MUST WAIT, NOT BURN ────────────────
     Madison is not onboarded in this project, so its inventory seed is keyed on
     the orgId and marked PER ORG. A per-key marker records it applied on the
     first boot that cannot see the org, and the report then never appears. */
  ok(/"inventory:2026-09-22-madison":[\s\S]*orgIds: \["14e26ada-ac6c-48ec-ad75-0590daaa4d71"\]/.test(seedBlk),
    "Madison's inventory seed is keyed on its orgId, not a guessed slug");
  ok(/const mark = key \+ "\|" \+ orgId;[\s\S]*if \(!slug\) \{[^}]*continue; \}/.test(seedBlk),
    "…marked per org, and an org this server cannot see is skipped UNMARKED so it retries");
  const addOrgBlk = src.slice(src.indexOf('app.post("/api/admin/add-org"'), src.indexOf('action: "created"'));
  ok(/seedReportVisibility\(\)/.test(addOrgBlk),
    "…and an org added via sync applies its waiting seed now, not on the next deploy");

  /* ── EVERY SURFACE HAS TO AGREE, and they are six different code paths.
     A card hidden on the org page while the cross-project API reports it
     visible is how rec-dashboard starts linking orgs to a report they cannot
     open — the town-of-shrewsbury 404 in a new costume. */

  // The org's own dashboard.
  ok(/if \(!reportHiddenForOrg\(slug, 'opportunities'\)\) available\.push\('opportunities'\);/.test(src),
    "the org dashboard adds the card through the inverted gate");

  /* THE EYE HIDES, IT DOES NOT LOCK. Dan: "i should still be able to click on
     it and view it, just the eye 'hides' it from them." The first build gated
     the page on the toggle too and he could not open his own admin card — so
     this asserts the OPPOSITE of what it used to, deliberately. */
  const gate = src.slice(src.indexOf("const opportunitiesEnabled ="), src.indexOf("function oppWindow"));
  ok(!/reportHiddenForOrg\(slug, "opportunities"\)/.test(gate),
    "the PAGE is NOT gated on the visibility toggle — hiding a card must not lock the report");

  /* …but the nightly fan-out still follows visibility. Nine feeds across ~29
     orgs is ~260 queries; spending them on a report an org cannot see is the
     storm this job is paced to avoid. */
  ok(/filter\(sl => !reportHiddenForOrg\(sl, "opportunities"\)\)/.test(src),
    "the nightly job still only builds for orgs that can see it");
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

  /* THE EYE THE GRID DRAWS AFTER A CLICK. The initial render above was always
     right; what was wrong is the answer the toggle POSTs back, which the grid
     then draws. `hidden.includes(report)` is the RAW membership test, and for a
     default-hidden report the store's meaning inverts — so the click that
     turned Opportunities ON drew a CLOSED eye, and the next click (turning it
     off) drew an OPEN one over a card the org page does not render. Scoped to
     the toggle route, because `hidden.includes(` appears elsewhere. */
  ok(/hiddenNow: reportHiddenForOrg\(slug, report\)/.test(toggle),
    "the toggle answers through reportHiddenForOrg, so the eye it draws is not inverted");
  ok(!/hiddenNow: hidden\.includes\(report\)/.test(toggle),
    "…and never re-derives that answer from raw list membership");

  /* The client's own fallback, for a caller that answers without hiddenNow.
     It was a hand-kept [] whose comment still described an inversion it no
     longer did — emptied when facilities graduated to visible-by-default, and
     never updated for the reports that have shipped hidden since. */
  ok(/const DEFAULT_HIDDEN = \$\{JSON\.stringify\(\[\.\.\.DEFAULT_HIDDEN_REPORTS\]\)\}/.test(src),
    "the admin grid's DEFAULT_HIDDEN is injected from the server's set, not typed by hand");

  /* ── THE SEED'S CALL SITE IS THE WHOLE OF ITS CORRECTNESS ──────────────
     At module scope readJSON/writeJSON see the container's own disk, because
     the store is not configured until storeBoot(). The seed therefore read an
     empty file, wrote the visibility row AND its own applied-marker to a
     filesystem that is thrown away, and logged "shown for watertown" on every
     boot of every replica while the org stayed hidden. Only a source assertion
     can see this: in disk mode — which is what the live half below runs — the
     two orderings are indistinguishable, and the live seed assertion passed
     throughout. Same lesson loadDynamicOrgs already carries. */
  ok(/\}\s*finally\s*\{[\s\S]{0,600}?seedReportVisibility\(\);/.test(src),
    "the visibility seed runs from storeBoot's finally, past every early return");
  ok(!/\(function seedReportVisibility\(\)/.test(src),
    "…and NOT as a module-scope IIFE, which writes into a store that has not answered yet");
  {
    /* The two org-CREATION routes also call it, deliberately: they run at
       request time, i.e. after boot, so they cannot reintroduce the
       module-scope write. Every OTHER call site is what this counts. */
    let rest = src;
    for (const r of ['app.post("/api/admin/add-org"', 'app.post("/api/admin/new-org"']) {
      const i = rest.indexOf(r), j = rest.indexOf("\n});", i);
      if (i >= 0 && j > i) rest = rest.slice(0, i) + rest.slice(j);
    }
    const callSites = (rest.match(/seedReportVisibility\(\);/g) || []).length;
    eq(callSites, 1, "…called from exactly one place at boot, so the ordering cannot drift");
  }

  // The cross-project visibility API.
  const visApi = src.slice(src.indexOf('app.get("/api/org-visibility/:slug"'),
                           src.indexOf("// ── Token gate"));
  ok(!/visible: !hidden\.has\(rt\)/.test(visApi),
    "the visibility API does not report a default-hidden report as visible");
  ok(/visible: !reportHiddenForOrg\(slug, rt\)/.test(visApi),
    "…it goes through the same predicate every other surface does");

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
  /* READ THROUGH A SAFE PARSE. A mutation that stops the server booting made
     JSON.parse throw on "Error: connect ECONNREFUSED", and the spec DIED with a
     SyntaxError naming nothing instead of failing on the assertion that
     provoked it. Nth instance in this repo of a guard that dies rather than
     reporting. */
  const json = (body) => { try { return JSON.parse(body || "{}"); } catch (_) { return {}; } };
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

    /* THE SEED, ON A REAL BOOT. This server started on an empty DATA_DIR, so
       Watertown is visible here only if the seed actually ran. */
    const wt = json((await get("/api/org-visibility/watertown")).body);
    const w0 = (wt.available || []).find(a => a.type === "opportunities");
    ok(w0 && w0.visible === true, "the seed made Opportunities visible for Watertown on a fresh boot");
    /* Shrewsbury rides a SECOND dated key rather than being added to the first.
       A seed applies once and the org's own toggle owns it forever after, so
       editing an applied key is how a report Dan has since switched off comes
       back on its own. */
    const sh = json((await get("/api/org-visibility/shrewsbury")).body);
    const s0 = (sh.available || []).find(a => a.type === "opportunities");
    ok(s0 && s0.visible === true, "…and for Shrewsbury, which Dan asked for and the inverted eye undid");

    /* MADISON: absent at boot, so the seed must NOT be marked — then adding the
       org applies it on the spot. Both halves, or "waits" is a comment. */
    const seeds0 = json(fs.existsSync(path.join(dataDir, "report-seeds.json")) ? fs.readFileSync(path.join(dataDir, "report-seeds.json"), "utf8") : "{}");
    ok(!Object.keys(seeds0).some(k => k.startsWith("inventory:2026-09-22-madison")),
      "Madison's seed was not burned on a boot that could not see Madison");
    const add = await post("/api/admin/add-org", { password: PW, slug: "spec-madison",
      token: "specMadisonTok1234", orgId: "14e26ada-ac6c-48ec-ad75-0590daaa4d71", displayName: "Madison" });
    ok(add.status === 200, "…the org can be added (" + add.status + ")");
    const md = json((await get("/api/org-visibility/spec-madison")).body);
    const m0 = (md.available || []).find(a => a.type === "inventory");
    ok(m0 && m0.visible === true, "…and inventory is visible for it the moment it arrives");
    const seeds1 = json(fs.readFileSync(path.join(dataDir, "report-seeds.json"), "utf8"));
    ok(!!seeds1["inventory:2026-09-22-madison|14e26ada-ac6c-48ec-ad75-0590daaa4d71"],
      "…and the per-org marker is written, so a toggle-off afterwards sticks");

    const before = json((await get("/api/org-visibility/" + slug)).body);
    const b0 = (before.available || []).find(a => a.type === "opportunities");
    ok(b0 && b0.visible === false, "the visibility API reports it HIDDEN before anyone opts in");

    /* HIDDEN, BUT STILL OPENABLE. This is the assertion Dan's correction
       turned around: with the card hidden he must still be able to click it
       from the admin grid and read it. WITH a valid token, so the only thing
       that could refuse it is the visibility gate. */
    const pg = await get("/" + slug + "/opportunities" + q);
    ok(pg.status !== 404, "a hidden report is still openable by URL — the eye hides it from the org, it does not lock it — got " + pg.status);

    /* …and the org's own dashboard does NOT carry the card while it is hidden.
       READ OUT OF THE INJECTED ORG_CONFIG, not by grepping the HTML for a link:
       org.html builds its cards client-side from `reports`, so the markup never
       contains one and a grep for it is satisfied by every build. That is the
       vacuous-absence trap this file already records twice. */
    const landReports = (body) => {
      const m = (body || "").match(/window\.ORG_CONFIG\s*=\s*(\{[\s\S]*?\});/);
      try { return JSON.parse(m[1]).reports || []; } catch (_) { return null; }
    };
    const land = await get("/" + slug + q);
    const r0 = landReports(land.body);
    ok(Array.isArray(r0) && r0.length > 0, "the org page injects its report list, or the two assertions on it are vacuous");
    ok(!(r0 || []).includes("opportunities"), "…while the org's dashboard does not offer it");

    const t2 = await post("/api/admin/toggle-report", { password: PW, org: slug, report: "opportunities" });
    eq(t2.status, 200, "the toggle ACCEPTS opportunities — without this Dan cannot enable it at all");

    /* THE ANSWER THE GRID DRAWS ITS EYE FROM. This is the bug Dan hit: the
       click that turned the report ON came back saying it was hidden, so the
       grid drew a closed eye, and his next click turned it back off while the
       grid then claimed it was visible. Only the live half can see that the
       route's answer agrees with what the org page actually renders. */
    const t2b = json(t2.body);
    eq(t2b.hiddenNow, false, "…and answers hiddenNow:false once it is SHOWN, so the eye opens");
    const land2 = await get("/" + slug + q);
    ok((landReports(land2.body) || []).includes("opportunities"),
      "…and the org's dashboard now actually carries the card the eye claims");

    const t3 = await post("/api/admin/toggle-report", { password: PW, org: slug, report: "opportunities" });
    eq(json(t3.body).hiddenNow, true, "…and hiddenNow:true when it is hidden again");
    await post("/api/admin/toggle-report", { password: PW, org: slug, report: "opportunities" });

    const pg2 = await get("/" + slug + "/opportunities" + q);
    ok(pg2.status !== 404, "…and it stays openable once shown — got " + pg2.status);

    const after = json((await get("/api/org-visibility/" + slug)).body);
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
