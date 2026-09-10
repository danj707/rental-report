// Spec for saved views on the Facility Rental Schedule.
//
// Dan, 2026-09-10, on the site-type filter: "needs likely a new column, and a
// new filter with all the baking into the saved filter view, pdf, etc." — and,
// asked whether saved views should be their own change: "Include saved views in
// the same change."
//
// THE THIRD REPORT TO GET THEM, and the split between what is shared and what
// is copied is deliberate rather than laziness. The DATE half lives in
// /saved-views.js and is shared by all three: a resolver that disagrees with
// the server's getDateRange is SILENT — a view named "Next 7 days" would open
// on one week on screen and report another in the emailed PDF. The chrome is
// duplicated, because a dropdown that disagrees is visible the moment you look
// at it. That decision is already recorded in CLAUDE.md; this spec pins the
// half that must not drift.
//
// Two things here are silent when wrong:
//
//   1. KEY ORDER. cleanViewParams emits in SAVED_VIEW_PARAMS.facility's order
//      and currentFilterParams builds in the page's, and the "edited" marker is
//      a string comparison between the two. A different order makes every
//      freshly-saved view read as dirty the instant it is applied.
//
//   2. WHAT A VIEW DOES TO A DIMENSION IT DOES NOT NAME. A view that could only
//      narrow could never widen, so opening an unfiltered view after a filtered
//      one would silently keep the old narrowing — and a view naming values
//      this window has no rows for must fall back to everything rather than
//      blanking the report, out loud.
//
// Run: node scripts/facility-saved-views.spec.js
// SKIP_SOURCE=1 drops the source half, so the live half can be shown to catch a
// regression on its own — a regex over our own patch is not evidence the server
// behaves.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PAGE = fs.readFileSync(path.join(ROOT, "public", "facility.html"), "utf8");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }
function src(cond, msg) { if (SKIP_SOURCE) return; ok(cond, msg); }

// ── Lift and RUN the two reconcilers ────────────────────────────────────────
// A regex over facViewSelection passes on an inverted comparison and on a
// version that returns an empty set, which is the report going blank.
function liftFn(name) {
  const at = PAGE.indexOf("function " + name + "(");
  assert.ok(at > 0, "facility.html should declare " + name + " at module scope");
  const bodyAt = PAGE.indexOf("{", PAGE.indexOf(")", at));
  let depth = 0, i = bodyAt;
  for (; i < PAGE.length; i++) {
    if (PAGE[i] === "{") depth++;
    else if (PAGE[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return PAGE.slice(at, i);
}
const lifted = new Function(
  liftFn("facViewSelection") + "\n" + liftFn("facViewMisses") + "\n" +
  liftFn("siteTypeLabel") + "\n" + liftFn("parseViewParams") + "\n" +
  "const SITE_TYPE_NONE = '(no type)';\n" +
  liftFn("viewFilterSummary") + "\n" +
  "return { facViewSelection, facViewMisses, parseViewParams, viewFilterSummary };")();
const { facViewSelection, facViewMisses, parseViewParams, viewFilterSummary } = lifted;

const POOLS = ["Aquatic Center", "Hilltop Park", "Urho Saari"];
const sorted = s => [...s].sort();

// ── 1. A dimension the view does not name RESETS to everything ──────────────
eq(sorted(facViewSelection(POOLS, null)).join("|"), POOLS.slice().sort().join("|"),
  "a view that names nothing for a dimension must RESET it to everything. A "
  + "view that could only narrow could never widen, so opening an unfiltered "
  + "view after a filtered one would silently keep the old narrowing");

// ── 2. A named subset is exactly that subset ────────────────────────────────
eq(sorted(facViewSelection(POOLS, ["Hilltop Park"])).join("|"), "Hilltop Park",
  "a view names its own subset");
eq(facViewSelection(POOLS, ["Hilltop Park", "Aquatic Center"]).size, 2,
  "and more than one of them");

// ── 3. A STALE view shows everything, never nothing ─────────────────────────
eq(sorted(facViewSelection(POOLS, ["Closed Lido"])).join("|"), POOLS.slice().sort().join("|"),
  "a view naming only values this window has no rows for must fall back to "
  + "EVERYTHING rather than blanking the report — a blank report reads as 'this "
  + "week is empty', which is a different and wrong answer");
eq(sorted(facViewSelection(POOLS, ["Closed Lido", "Hilltop Park"])).join("|"), "Hilltop Park",
  "but a PARTIAL match keeps what matched — the fallback is for nothing "
  + "surviving, not for one value having gone");
eq(facViewSelection([], ["Hilltop Park"]).size, 0,
  "and with nothing available at all it selects nothing rather than throwing");

// ── 4. The fallback is never silent ─────────────────────────────────────────
eq(facViewMisses(POOLS, ["Closed Lido"]).join(""), "Closed Lido",
  "the caller must be able to NAME what was dropped — a filter that quietly "
  + "did nothing is the failure this warning exists for");
eq(facViewMisses(POOLS, null).length, 0, "a dimension the view does not name misses nothing");
eq(facViewMisses(POOLS, ["Hilltop Park"]).length, 0, "and a value that is present is not a miss");
src(/setViewWarn\(missed\.length/.test(PAGE),
  "applyView must surface the misses — facViewMisses with no reader is a "
  + "function that computes a warning nobody sees");
src(/className="view-warn"/.test(PAGE), "and there must be somewhere to render it");

// ── 5. KEY ORDER: the page and the server must agree ────────────────────────
const allowRe = /facility: \["([^\]]+)\]/.exec(SERVER.slice(SERVER.indexOf("const SAVED_VIEW_PARAMS")));
ok(allowRe, "server.js should register SAVED_VIEW_PARAMS.facility");
const allow = ('["' + allowRe[1] + "]").match(/"([^"]+)"/g).map(s => s.slice(1, -1));
eq(allow.join(","), "locations,sites,site_types,book_type,addons",
  "the server's allowlist, in order. Got: " + allow.join(","));

// The page's own list, and the order currentFilterParams actually emits in.
const pageListRe = /const FACILITY_VIEW_PARAMS = \[([^\]]+)\]/.exec(PAGE);
src(pageListRe, "facility.html should declare FACILITY_VIEW_PARAMS");
if (pageListRe) {
  const pageList = pageListRe[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  ok(pageList.join(",") === allow.join(","),
    "FACILITY_VIEW_PARAMS must mirror the server's allowlist IN ORDER. "
    + "cleanViewParams emits in the server's order and the page compares the "
    + "result as a STRING, so a different order makes every freshly-saved view "
    + "read as 'edited' the instant it is applied. page=" + pageList.join(",")
    + " server=" + allow.join(","));
}
const cfp = PAGE.slice(PAGE.indexOf("const currentFilterParams = useMemo"),
                       PAGE.indexOf("const activeView = useMemo"));
src(cfp.length > 200, "currentFilterParams should be sliceable");
const emitted = (cfp.match(/qs\.set\('([a-z_]+)'/g) || []).map(s => /'([a-z_]+)'/.exec(s)[1]);
ok(emitted.join(",") === allow.join(","),
  "currentFilterParams must SET the params in the allowlist's order — this is "
  + "the string the 'edited' marker compares. Got: " + emitted.join(","));

// ── 6. A view carries the FILTERS and not the columns ───────────────────────
["pii", "sitetype", "cols", "hide"].forEach(k => {
  ok(allow.indexOf(k) === -1,
    "`" + k + "` is display state and must NOT be in a saved view: it already "
    + "persists per browser, and a shared view that overwrote it would change "
    + "what a colleague's screen shows because they opened somebody's filter. "
    + "For `pii` that means putting phone numbers back on their screen");
});
ok(allow.indexOf("site_types") !== -1,
  "the site-type FILTER is part of the question the report answers, so it IS "
  + "saved — the line runs between `site_types` and `sitetype`, one field apart");

// ── 7. Every offered range is one the server will store ─────────────────────
const offerBlk = SERVER.slice(SERVER.indexOf("const SAVED_VIEW_RELATIVE_OFFER"));
const facOffer = /facility: \[([\s\S]*?)\],\n\};/.exec(offerBlk);
ok(facOffer, "server.js should register SAVED_VIEW_RELATIVE_OFFER.facility");
const offered = (facOffer[1].match(/\["([a-zA-Z0-9]+)",/g) || []).map(s => /\["([^"]+)"/.exec(s)[1]);
ok(offered.length >= 4, "the rental schedule should offer several ranges. Got: " + offered.join(","));
const acceptBlk = SERVER.slice(SERVER.indexOf("const SAVED_VIEW_RELATIVE_ACCEPT"));
const facAccept = /facility: \[([^\]]+)\]/.exec(acceptBlk);
ok(facAccept, "server.js should register SAVED_VIEW_RELATIVE_ACCEPT.facility");
const accepted = facAccept[1].match(/"([^"]+)"/g).map(s => s.slice(1, -1));
offered.forEach(t => {
  ok(accepted.indexOf(t) !== -1,
    "the dialog offers `" + t + "` but the server will not STORE it — that is "
    + "exactly how gl.html came to offer 'Today', which failed every save with "
    + "a message about 7am email sends");
});

// THE FIRST OFFERED RANGE IS THE DIALOG'S DEFAULT, so it has to be the window
// the report itself opens on. The rental schedule defaults to today + 6 days,
// which is what next7 resolves to.
eq(offered[0], "next7",
  "the rental schedule reads FORWARD and opens on today + 6 days, so `next7` "
  + "must lead — the first offered range is what the save dialog pre-selects, "
  + "and a default that disagrees with the report's own window is a view that "
  + "silently re-ranges the report when it is applied. Got: " + offered[0]);
src(/const end   = new Date\(today\);\s*\n\s*end\.setDate\(today\.getDate\(\) \+ 6\);/.test(PAGE),
  "...and the page's own default really is today + 6 days");

// ── 8. The dialog's list comes from the SERVER ──────────────────────────────
src(/savedViewRanges: SAVED_VIEW_RELATIVE_OFFER\.facility/.test(SERVER),
  "the offered ranges must be injected into ORG_CONFIG, not hardcoded in the "
  + "page — that is the gl.html bug");
src(/function savedViewRanges\(\) \{[\s\S]{0,200}ORG_CONFIG \|\| \{\}\)\.savedViewRanges/.test(PAGE),
  "and the page must read them from ORG_CONFIG");
src(/relativeRange: defaultSavedRange\(\)/.test(PAGE),
  "the dialog's pre-selected range must come from the offered list, never a "
  + "token named in the page");

// ── 9. ONE filter builder, shared with the email subscription ───────────────
// This had already drifted before saved views existed: the subscription built
// its own string, predating the site-type filter and omitting it, so a
// subscriber's emailed PDF carried site types excluded from the screen.
src(/function buildFilterParams\(\) \{ return currentFilterParams; \}/.test(PAGE),
  "the email subscription must reuse currentFilterParams rather than building "
  + "its own filter string — two builders drift, and this pair already had");
src(!/p\.set\('locations', \[\.\.\.selectedLocations\]/.test(PAGE),
  "no second builder may come back");

// ── 10. ONE date resolver, shared across all three reports ──────────────────
src(/function resolveSavedRange\(token\) \{ return RecSavedViews\.resolveSavedRange\(token\); \}/.test(PAGE),
  "facility.html must DELEGATE the date resolver. A per-page mirror of the "
  + "server's getDateRange drifts silently: the view opens on one window on "
  + "screen and reports another in the emailed PDF");
src(/<script src="\/saved-views\.js" defer><\/script>/.test(PAGE),
  "...and load the shared script, or every one of those wrappers throws");
src(!/function resolveSavedRange\(token, now\)/.test(PAGE),
  "the page must not grow its own copy of the resolver");

// ── 11. Applying a view is client-side EXCEPT the range ─────────────────────
const apply = PAGE.slice(PAGE.indexOf("function applyView(v, announce) {"),
                         PAGE.indexOf("function clearView() {"));
ok(apply.length > 400, "applyView should be sliceable");
["setSelectedLocations", "setSelectedSites", "setSelectedSiteTypes", "setSelectedAddOns"].forEach(fn => {
  ok(apply.indexOf(fn + "(facViewSelection(") !== -1,
    "applyView must set " + fn + " through facViewSelection — a caller that "
    + "intersects by hand is a second reconciler, and one of them will keep a "
    + "narrowing the view did not ask for");
});
ok(/setBookTypeFilter\(f\.bookType \|\| 'all'\)/.test(apply),
  "the booking-type mode must be set UNCONDITIONALLY, like the multi-selects: "
  + "a view that could only turn it on could never turn it off");
ok(/if \(range\.start !== loadedStart \|\| range\.end !== loadedEnd\) fetchData\(/.test(apply),
  "a view that moves the RANGE has to re-run the query — every other filter "
  + "here is client-side over rows already loaded, so the range is the only "
  + "thing that touches the network");
const clear = PAGE.slice(PAGE.indexOf("function clearView() {"),
                         PAGE.indexOf("async function submitView(form) {"));
ok(/setBookTypeFilter\('all'\)/.test(clear) && /setSelectedSiteTypes\(new Set\(allSiteTypes\)\)/.test(clear),
  "Default view must clear EVERY dimension, the new one included — 'no "
  + "filters' has to mean no filters");
ok(!/setStartDate/.test(clear),
  "clearView must NOT reset the dates: clearing a filter is not a request to "
  + "jump back to the report's default week");

// ── 12. The restore waits for the feed ──────────────────────────────────────
// Every option here is a value taken FROM the rows, so before the first
// response there is nothing to intersect a view against and facViewSelection
// would correctly fall back to "everything" — leaving the view looking as
// though it had done nothing. Same lesson as the roster's `loaded` argument.
src(/if \(isPrint \|\| viewsRestored \|\| !rows\) return;/.test(PAGE),
  "the restore effect must wait for `rows`. A feed that has not answered is "
  + "not an empty answer, and applying a view against no options silently "
  + "resolves every dimension to 'all'");
src(/if \(FACILITY_VIEW_PARAMS\.some\(k => urlQs\.get\(k\)\)\) return;/.test(PAGE),
  "a URL carrying its own filters is a deliberate link and must not be "
  + "overridden by whatever this browser last looked at");
src(/useEffect\(\(\) => \{ if \(!isPrint\) loadViews\(\); \}, \[\]\);/.test(PAGE),
  "the LIST should still load at mount, so the picker is populated while the "
  + "report is still fetching");

// ── 13. The picker is hidden in print, and the overlays render everywhere ───
src(/body\.print-mode \.view-wrap/.test(PAGE),
  "the picker must be hidden in print mode — the server-rendered PDF is this "
  + "page under ?_print=1 and a toolbar control has no business on the sheet");
eq((PAGE.match(/\{renderSaveDialog\(\)\}/g) || []).length, 3,
  "the save dialog is a fixed-position overlay and must render on ALL THREE "
  + "return paths (error, loading, loaded) — it can be open while a re-run is "
  + "in flight");
eq((PAGE.match(/\{renderUndoToast\(\)\}/g) || []).length, 3,
  "and so must the Undo toast: a delete can leave the page in the loading "
  + "state, and an Undo that vanishes is not an undo");

// ── 14. The beacon names the view, in the QUERY STRING ──────────────────────
src(/logClientEvent\('view-apply', '&view=' \+ encodeURIComponent/.test(PAGE),
  "applying a view should beacon `view-apply` carrying the view's NAME — "
  + "'somebody applied a view' says nothing about which one");
src(/"view-apply"/.test(SERVER),
  "and `view-apply` must be on the log route's ALLOWED list, or the beacon "
  + "400s and, being fire-and-forget, never complains");

// ── 15. Live: drive the real routes ─────────────────────────────────────────
(async () => {
  const PORT = 3987;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-facviews-"));
  // Skip the startup prewarm, or booting this fans ~28 orgs out against
  // PRODUCTION Metabase — the self-inflicted load this repo has recorded twice.
  fs.writeFileSync(path.join(dataDir, "prewarm-state.json"),
    JSON.stringify({ lastCompletedAt: new Date().toISOString() }));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: "http://127.0.0.1:9",
      SKIP_PREWARM: "1", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const { org, token } = (() => {
    const i = SERVER.indexOf("const ORGS = {");
    const j = SERVER.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = vm.runInNewContext("(" + SERVER.slice(SERVER.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    const slug = Object.keys(ORGS).filter(k => ORGS[k] && ORGS[k].token)[0];
    return { org: slug, token: ORGS[slug].token };
  })();

  const call = (method, p, body) => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 20000,
      headers: Object.assign({ "x-token": token }, body ? { "Content-Type": "application/json" } : {}) },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => {
        let j = null; try { j = JSON.parse(b); } catch {}
        res({ status: r.statusCode, body: b, json: j });
      }); });
    req.on("error", rej);
    req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end(body ? JSON.stringify(body) : undefined);
  });

  const V = s => `/${org}/facility/api/views${s || ""}?token=${encodeURIComponent(token)}`;

  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("server did not boot in 60s:\n" + log)), 60000);
      const tick = () => call("GET", "/healthz").then(() => { clearTimeout(t); res(); })
                                                .catch(() => setTimeout(tick, 300));
      setTimeout(tick, 500);
    });

    // The route exists at all — this is what 404s until a report is registered.
    const list0 = await call("GET", V());
    eq(list0.status, 200,
      "GET the facility views route must serve — it 404s for any report not in "
      + "SAVED_VIEW_PARAMS, which is what registering `facility` buys");
    ok(Array.isArray(list0.json && list0.json.views), "and answer with a list");
    ok(Array.isArray(list0.json && list0.json.ranges) && list0.json.ranges.length > 0,
      "and with the ranges this report offers, so the dialog cannot invent one");

    // A view carrying every allowed filter survives the server's allowlist
    // BYTE FOR BYTE. The order is the allowlist's own, so this also proves the
    // round trip a freshly-saved view makes cannot mark itself edited.
    // Built the way currentFilterParams builds it — through URLSearchParams,
    // in the allowlist's order — because that is the exact string the page
    // compares against. Hand-writing the encoding here would test a string the
    // page never produces (%20 against the +, which is where this first failed).
    const qs = new URLSearchParams();
    qs.set("locations", "Aquatic Center");
    qs.set("sites", "Lane 1");
    qs.set("site_types", "pool");
    qs.set("book_type", "managed");
    qs.set("addons", "Lifeguard");
    const filters = qs.toString();
    const made = await call("POST", V(), {
      name: "Pools this week", params: filters, dateMode: "relative", relativeRange: "next7",
    });
    eq(made.status, 200, "a view naming every allowed filter must save. Got: " + made.body);
    eq(made.json.view.params, filters,
      "and survive the server's allowlist byte for byte — a param the server "
      + "strips, reorders or re-encodes is one the page will then see as "
      + "'edited' forever, because the marker is a string comparison. Got: "
      + made.json.view.params);
    eq(made.json.view.relativeRange, "next7", "the forward range must be stored");

    // ...and the round trip is IDEMPOTENT. Byte-identity on one pass can still
    // hide a normalisation that only bites the second time.
    const again = await call("POST", V(), {
      name: "Pools this week (2)", params: made.json.view.params, dateMode: "current",
    });
    eq(again.json.view.params, made.json.view.params,
      "feeding the server its own output back must return it unchanged");

    // The display state must be REFUSED, not quietly stored: the allowlist is
    // the thing that stops a shared view rewriting a colleague's columns.
    const dirty = await call("POST", V(), {
      name: "Sneaky", params: "locations=Aquatic%20Center&pii=phone,email&sitetype=1&token=nope",
      dateMode: "current",
    });
    eq(dirty.status, 200, "the save itself should succeed");
    eq(dirty.json.view.params, new URLSearchParams({ locations: "Aquatic Center" }).toString(),
      "the server must STRIP display state and plumbing from a view's params — "
      + "`pii` in a saved view puts phone numbers on a colleague's screen "
      + "because they opened somebody's filter. Got: " + dirty.json.view.params);

    // A range this report does not accept is refused rather than stored.
    const bad = await call("POST", V(), {
      name: "Bad range", params: "", dateMode: "relative", relativeRange: "yesterday",
    });
    eq(bad.status, 400,
      "a relative range outside SAVED_VIEW_RELATIVE_ACCEPT.facility must be "
      + "REFUSED — storing it means a view that resolves to a window the "
      + "report will not serve. Got " + bad.status + ": " + bad.body);

    // Delete is soft, so the Undo in the toast is a restore.
    const del = await call("DELETE", V("/" + made.json.view.id));
    eq(del.status, 200, "a view must delete. Got: " + del.body);
    const afterDel = await call("GET", V());
    ok(!afterDel.json.views.some(v => v.id === made.json.view.id),
      "and leave the list");
    const restored = await call("PATCH", V("/" + made.json.view.id), { restore: true });
    eq(restored.status, 200,
      "and RESTORE, or the Undo in the toast is a lie. Got: " + restored.body);
    const afterRestore = await call("GET", V());
    ok(afterRestore.json.views.some(v => v.id === made.json.view.id),
      "the restored view is back in the list");

    // The page itself serves, and carries the injected range list — the dialog
    // reads it, so a page that shipped without it offers nothing to pick.
    const page = await call("GET", `/${org}/facility?token=${encodeURIComponent(token)}`);
    eq(page.status, 200, "the report page must still serve");
    ok(/savedViewRanges/.test(page.body),
      "and inject savedViewRanges, or the save dialog's relative-range select "
      + "renders empty");
    ok(/"next7"/.test(page.body),
      "with the forward ranges this report actually offers");

    console.log(`✓ facility-saved-views.spec.js — ${n} assertions passed`
      + (SKIP_SOURCE ? " (source half skipped)" : ""));
  } catch (e) {
    console.error("FAILED: " + (e && e.message));
    if (log) console.error("--- server log ---\n" + log.slice(-2000));
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  }
})();
