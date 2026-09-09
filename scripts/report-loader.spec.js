/* report-loader.spec.js — one loading state, and a progress bar that cannot lie.
 *
 * Dan, 2026-09-06, retiring the juice animation: "just seems not as professional
 * now that we're pretty robust… I was getting feedback that it was taking
 * forever and no one had any idea how long it would actually take. Someone is
 * more willing to wait for a progress bar than a forever spinner."
 *
 * A bar is only worth more than a spinner if the number under it is real, so
 * most of what is pinned here is about the ESTIMATE being measured rather than
 * invented, and about the bar never making a claim it cannot keep.
 */
const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error("  ✗ " + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + " — got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); }

const ROOT = path.join(__dirname, "..");
const pages = fs.readdirSync(path.join(ROOT, "public")).filter(f => f.endsWith(".html"));
const read = f => fs.readFileSync(path.join(ROOT, "public", f), "utf8");

// ── 1. The juice loader is GONE, everywhere ────────────────────────────────
ok(!fs.existsSync(path.join(ROOT, "public", "juice-loader.js")),
   "public/juice-loader.js is deleted, not merely unreferenced");
// Scoped to the loader's own identifiers, not the word itself: hotdog.html has
// an unrelated emoji lookup for a product NAMED juice, and a bare /juice/ makes
// this fail on correct code — a guard that cries wolf gets deleted.
const JUICE_IDENTS = /JuiceLoader|juice-loader|juice-msg|juice-spinner|juice-loading|juice-fill|juice-bubbles|juice-phrase/;
const offenders = pages.filter(f => JUICE_IDENTS.test(read(f)));
eq(offenders, [], "no page references the juice loader, its CSS or its markup");

// ── 2. LIFT AND RUN the progress curve ─────────────────────────────────────
// A regex over this proves nothing: it is arithmetic, and an inverted
// comparison reads exactly the same.
const src = fs.readFileSync(path.join(ROOT, "public", "report-loader.js"), "utf8");
const sandbox = {
  window: {}, React: { useRef: () => ({}), useState: () => [0, () => {}], useEffect() {}, createElement() {} },
  document: { getElementById: () => ({}), head: { appendChild() {} }, createElement: () => ({}) },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const progress = sandbox.window.loaderProgress;
const note = sandbox.window.loaderEstimateNote;
ok(typeof progress === "function", "loaderProgress is exported so it can be RUN");

const EST = 30000;
ok(progress(0, EST) === 0, "starts at zero");
ok(progress(EST / 2, EST) > 20, "is visibly moving by the halfway mark");

// THE ASSERTION THIS FILE EXISTS FOR. A bar that fills and then sits there is
// worse than no bar: it has told the reader something they can see is false,
// which is the "no idea how long" complaint made concrete.
const forever = [EST, EST * 2, EST * 10, EST * 100, EST * 1000, 864e5];
ok(forever.every(t => progress(t, EST) < 100),
   "NEVER reaches 100% on its own, at any elapsed time");
// The float trap that made that true only up to about 1000x the estimate:
// 1 - 0.5^over underflows to exactly 0, and the curve hit 100. Caught by
// running it, not by reading it.
ok(progress(864e5, EST) < 99.9,
   "...including far past the point where the asymptote underflows in float");

// THE BUG DAN CAUGHT ON THE FIRST SHIP, and the reason the numbers moved.
// A report still running at 40s drew a bar at 98.4%, which is visually
// indistinguishable from finished — so the whole over-estimate regime read as
// "done and stuck", which is the complaint this replaces rather than fixes.
// "Under 100" was never the real requirement: it has to LOOK unfinished.
ok(progress(EST, EST) <= 85,
   "at the estimate the bar is around four fifths, not nearly full — leaving visible room for an overrun");
ok(progress(EST * 3, EST) < 90,
   "3x over the estimate still reads as clearly unfinished (Dan's 40s case drew 98.4%)");
ok(progress(EST * 100, EST) < 96,
   "even an absurd overrun stays visibly short of the end");

// It must keep MOVING while it is over, or it is a stalled bar with extra steps.
ok(progress(EST * 3, EST) > progress(EST * 2, EST),
   "keeps advancing past the estimate, just more slowly");
let mono = true, prev = -1;
for (let t = 0; t <= 600000; t += 250) { const v = progress(t, EST); if (v < prev) mono = false; prev = v; }
ok(mono, "never goes BACKWARDS — a bar that retreats reads as broken");

// A missing or nonsense estimate must still produce a sane bar rather than NaN
// or an instant 92%.
ok(progress(5000, 0) > 0 && progress(5000, 0) < 100, "a zero estimate falls back to the default");
ok(!Number.isNaN(progress(5000, undefined)), "an absent estimate is not NaN");

// ── 3. The wording only claims what was measured ───────────────────────────
ok(/usually/.test(note(30000, "org")),
   "an estimate from real history is worded as history ('usually about 30s')");
eq(note(30000, "default"), "",
   "with NO history the loader claims nothing — a default dressed up as 'about 30s' is a promise we cannot keep");

// ── 4. Every page that USES it must LOAD it ────────────────────────────────
// A ReportLoader reference with no script tag is a ReferenceError, React
// unmounts, and the page serves 200 with a blank body — the failure this repo
// has shipped twice. Nine pages were in exactly that state mid-change.
const usesWithoutScript = pages.filter(f => {
  const s = read(f);
  return /\bReportLoader\b/.test(s) && !/report-loader\.js/.test(s);
});
eq(usesWithoutScript, [], "every page using ReportLoader also loads report-loader.js");
const users = pages.filter(f => /\bReportLoader\b/.test(read(f)));
ok(users.length >= 15, "the loader is actually in wide use (" + users.length + " pages) — or the check above is vacuous");

// ── 5. The estimate is MEASURED, and only from cache MISSES ────────────────
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const rec = server.slice(server.indexOf("function recordLoadTiming"),
                         server.indexOf("// Written on a timer"));
ok(/entry\.cache\s*&&\s*entry\.cache\s*!==\s*"miss"/.test(rec),
   "only cache MISSES are recorded — mixing in ~200ms hits makes the median track the hit rate, not the wait");
ok(/status\s*>=\s*400/.test(rec), "a failed request is not a duration");
ok(/LOAD_TIMING_MAX_MS/.test(rec), "a timeout is not a duration either");

// Durable and shared. REQUEST_LOG is per-process and empties on deploy, and
// since numReplicas went to 2 each container sees only its own half — an
// estimate built from that is wrong twice over.
ok(/readJSON\(loadTimingFile\(\)/.test(server) && /writeJSON\(loadTimingFile\(\)/.test(server),
   "the history goes through the store, so it survives deploys and both replicas share it");

// ...and the LAST MINUTE of it survives too. Samples are batched on a 60s
// timer, so without an explicit flush on the way down a deploy discards up to
// a minute of them, and a container that cycles often would keep none. It has
// to run BEFORE stateStore.close(), because writeJSON only enqueues the upsert
// and close() is what drains that queue.
{
  const sd = server.slice(server.indexOf("function shutdown("), server.indexOf('process.on("SIGTERM"'));
  ok(/flushLoadTimings\(\)/.test(sd), "the timings are flushed on shutdown [source]");
  ok(sd.indexOf("flushLoadTimings()") < sd.indexOf("stateStore.close("),
     "...before the store drains, or the write never leaves the queue [source]");
}

const estFn = server.slice(server.indexOf("function loadEstimateFor"),
                           server.indexOf("// Every page's ORG_CONFIG"));
// The pacing used when there is no history has to cover the reports people
// actually wait on. 12s made every unknown report look stalled within seconds,
// against real misses of 25.4s and 41.1s.
ok(/LOAD_TIMING_DEFAULT_MS = 25000/.test(server),
   "the no-history default is long enough for the reports this actually times");
ok(/var DEFAULT_MS    = 25000/.test(src),
   "...and the client's own fallback agrees with it");

ok(/percentile\(own, 0\.8\)/.test(estFn),
   "the estimate is the 80th percentile, not the median — finishing early snaps to 100%, running out of estimate stalls");
ok(/basis: "org"/.test(estFn) && /basis: "report"/.test(estFn) && /basis: "default"/.test(estFn),
   "it reports WHICH fallback answered, so the client knows how much to trust it");

// LIFT AND RUN the three-step fallback rather than reading it. A text-order
// assertion ("the org branch appears before the pooled one") passed happily on
// a mutation that disabled the org branch entirely — the branches were still in
// the right order, they just never fired. Caught by mutation, fixed in the spec.
{
  const consts = server.slice(server.indexOf("const LOAD_TIMING_DEFAULT_MS"),
                              server.indexOf("function loadEstimateFor"));
  const pctFn  = server.slice(server.indexOf("function percentile"),
                              server.indexOf("// Platform-wide fallback"));
  const box = { history: {} };
  vm.createContext(box);
  vm.runInContext(consts + pctFn + estFn + "\nfunction loadTimings(){return history;}", box);

  // An org with its own history: the answer must come from ITS numbers, not the
  // much faster pool around it.
  box.history = { "apex|programs": [20000, 22000, 24000, 26000, 90000],
                  "tiny|programs": [1600, 1700, 1800] };
  let r = vm.runInContext('loadEstimateFor("apex","programs")', box);
  eq(r.basis, "org", "an org with history is answered from its OWN timings");
  ok(r.ms >= 26000, "...at the 80th percentile, so a slow tail is respected (" + r.ms + "ms)");

  // No history of its own: fall back to everyone's, for this report TYPE only.
  box.history = { "apex|programs": [20000, 22000, 24000],
                  "apex|gl": Array.from({ length: 20 }, (_, i) => 3000 + i) };
  r = vm.runInContext('loadEstimateFor("brandnew","programs")', box);
  eq(r.basis, "report", "an org with no history falls back to the pooled report type");
  ok(r.ms >= 20000,
     "...pooled for THIS report type only — the 20 fast gl samples must not drown out the 3 slow programs ones ("
     + r.ms + "ms)");

  // Nothing anywhere: a flat default, and it says so, so the client can decline
  // to put a number on screen.
  box.history = {};
  r = vm.runInContext('loadEstimateFor("brandnew","programs")', box);
  eq(r.basis, "default", "with nothing at all the basis is 'default'");
  ok(r.ms > 0, "...and still a usable number");

  // A single sample is not a distribution. One unlucky 90s run must not become
  // every future reader's estimate.
  box.history = { "apex|programs": [90000], "other|programs": [5000, 5100, 5200] };
  r = vm.runInContext('loadEstimateFor("apex","programs")', box);
  eq(r.basis, "report", "one sample is below the floor, so it falls through rather than trusting it");
}

// ── Found by WARMING the history on production and reading it back ────────
// Three things that made real samples fail to become real estimates.

// 1. The per-replica memo was never refreshed. clarksville/facility graduated
//    to `basis: org` while clarksville/gl — probed just as often — was still on
//    the default: the samples had landed on whichever replica served that
//    request, and the other kept answering from its empty boot snapshot.
ok(/function mergeLoadTimings/.test(server),
   "the local view is re-read from the store, not memoised at boot forever");
{
  const flush = server.slice(server.indexOf("function flushLoadTimings"),
                             server.indexOf("setInterval(flushLoadTimings"));
  ok(/mergeLoadTimings\(\)/.test(flush),
     "the flush is a read-modify-write, so one replica's write cannot clobber the other's samples");
}
ok(/_loadNew\[key\]/.test(server),
   "this replica's unflushed samples are tracked separately, or the merge has nothing to re-apply");

// 2. The pooled fallback used the 80th percentile of a CROSS-ORG mixture, which
//    is just the largest org's number: pooled `facility` p80 was 95.9s on
//    production, which would tell Pawnee "usually about 96s" for a report that
//    takes about 3s there.
ok(/percentile\(pooled, 0\.5\)/.test(estFn),
   "the pooled fallback is the MEDIAN — a cross-org p80 describes the biggest org, not this one");
ok(/percentile\(own, 0\.8\)/.test(estFn),
   "...while an org's OWN history still uses the pessimistic p80");

// 3. Seven real report pages sent their HTML raw and injected no ORG_CONFIG at
//    all, so the bar on them could never have an estimate. Derived from the
//    routes rather than listed, so a new raw-send page fails this instead of
//    being quietly missed.
{
  const routes = [...server.matchAll(/app\.get\("(\/:org\/[a-z-]+)"[^\n]*\n(?:.*\n){0,25}?\}\);/g)];
  const SKIP = new Set(["admin", "metrics", "calendar", "rentalcalendar", "annual-report"]);
  const missing = routes.filter(m => {
    const b = m[0];
    if (!b.includes("public") || !b.includes(".html")) return false;
    if (SKIP.has(m[1].split("/").pop())) return false;
    return !/orgConfigInject|loadEstimateInject/.test(b);
  }).map(m => m[1]);
  eq(missing, [], "every tokened report route injects a load estimate");
  ok(routes.length > 10, "...and the route scan actually found routes, or the check above is vacuous");
}

// Injected on first paint. A separate endpoint would mean the bar draws before
// it knows its own scale — the guessing this replaces.
ok(/loadEstimate: loadEstimateFor\(slug, rt\)/.test(server),
   "the estimate rides in ORG_CONFIG, so the bar has its scale on first paint");
ok(!/window\.ORG_CONFIG=\$\{JSON\.stringify\(orgConfig\)\}/.test(server),
   "no injection site bypasses orgConfigInject — one that did would ship a bar with no estimate");

// ── 6. THE VANILLA BAR — programs-schedule.html draws its own, and it printed
//    "usually about NaNm NaNs" on screen for three days.
//
//    Dan, 2026-09-09, on Windham: "err this looks like a bug when the page is
//    loading." Root cause: that page read ORG_CONFIG.loadEstimate by hand and
//    passed the whole {ms,basis} OBJECT to loaderEstimateNote(ms, basis). An
//    object is truthy, so the empty guard never fired; basis arrived undefined,
//    so the no-history guard never fired either; and fmtSecs(object) rendered
//    the literal NaN. It also fed loaderProgress SECONDS against an estimate
//    that fell back to 25000ms — 0.26% after forty seconds, i.e. a bar that
//    never visibly moves.
//
//    Nothing here could see any of it: the page parses, the server boots, the
//    curve's own assertions pass, and there was no case that RENDERED the bar.
{
  // (a) The object shape is genuinely fatal, RUN rather than argued — without
  //     this the assertions below are pinning a rule with no teeth.
  ok(/NaN/.test(String(sandbox.window.loaderEstimateNote({ ms: 12345, basis: "org" }))),
     "passing the whole estimate OBJECT to estimateNote really does render NaN (the shipped bug)");
  eq(sandbox.window.loaderEstimateNote(12345, "org"), "usually about 12s",
     "...while (ms, basis) reads as history");
  eq(sandbox.window.loaderEstimateNote(25000, "default"), "",
     "...and a basis of 'default' claims nothing, which is what the undefined basis defeated");

  // (b) ONE reader for the {ms,basis} shape, so no caller can get it wrong again.
  ok(typeof sandbox.window.loaderReadEstimate === "function",
     "report-loader.js exports loaderReadEstimate, so the estimate shape is read in one place");
  ok(typeof sandbox.window.loaderFmtSecs === "function",
     "...and loaderFmtSecs, so a hand-drawn bar need not reimplement the clock");

  // (c) No page reads the raw config and hands it on. This is the actual defect:
  //     a page that reads ORG_CONFIG.loadEstimate itself is one field-name slip
  //     from NaN on screen.
  const rawReaders = pages.filter(f =>
    /ORG_CONFIG\s*&&\s*window\.ORG_CONFIG\.loadEstimate|ORG_CONFIG\.loadEstimate\s*\)\s*\|\|/.test(read(f)));
  eq(rawReaders, [],
     "no page reads ORG_CONFIG.loadEstimate by hand — every caller goes through loaderReadEstimate");

  // (d) The two shared helpers are always called with the right arity/units.
  for (const f of pages) {
    const src = read(f);
    for (const m of src.matchAll(/loaderEstimateNote\s*\(([^)]*)\)/g)) {
      const args = m[1].trim();
      if (!args || args === "est" || args === "estimateNote") continue;   // the definition/alias
      ok(args.includes(","), f + ": loaderEstimateNote is called with (ms, basis), not one object");
    }
    for (const m of src.matchAll(/loaderProgress\s*\(([^)]*)\)/g)) {
      ok(!/\/\s*1000/.test(m[1]),
         f + ": loaderProgress is fed MILLISECONDS — dividing by 1000 flattens the bar to ~0%");
    }
  }

  // (e) BEHAVIOURAL: lift the page's OWN startLoader and read what it writes.
  //     Every assertion above is about source text and would pass on a renderer
  //     that composed the note some fourth wrong way; this one reads the bytes.
  const ps = read("programs-schedule.html");
  const fn = ps.slice(ps.indexOf("function startLoader()"), ps.indexOf("function stopLoader()"));
  ok(/loaderReadEstimate/.test(fn) && fn.length > 200,
     "the startLoader slice was found (or the render assertions below are vacuous)");

  const nodes = {};
  function el(id) {
    return nodes[id] || (nodes[id] = {
      innerHTML: "", className: "", style: {}, setAttribute(k, v) { this[k] = v; },
      get parentNode() { return { parentNode: { setAttribute() {} } }; }
    });
  }
  let ticker = null;
  for (const [basis, cfg, want] of [
    ["org",     { loadEstimate: { ms: 12345, basis: "org" } },   "usually about 12s"],
    ["default", {},                                              null],
  ]) {
    // report-loader.js closed over sandbox.window, so readEstimate reads
    // ORG_CONFIG off THAT object — a copy here would silently test the default
    // branch twice and the org case would prove nothing.
    const w = sandbox.window;
    w.ORG_CONFIG = cfg;
    const ctx = {
      window: w, esc: x => String(x), console,
      document: { getElementById: id => el(id) },
      setInterval: (f) => { ticker = f; return 1; }, clearInterval() {},
      Date: { now: () => Date.__t },
    };
    Object.assign(ctx, w);                       // the page calls the globals bare
    Date.__t = 0;
    vm.createContext(ctx);
    vm.runInContext("var loaderTimer=null,loaderT0=0,loaderShown=false;" +
                    "var LOADER_SHOW_DELAY_MS=350;" + fn + "; startLoader();", ctx);

    // Before the show delay: nothing at all. A bar that flashes on a warm cache
    // reads as a glitch.
    Date.__t = 200; ticker();
    eq(el("loaderMount").innerHTML, "",
       basis + ": nothing renders inside the 350ms show delay");

    Date.__t = 5000; ticker();
    const shown = el("rlNote").innerHTML;
    ok(!/NaN/.test(shown), basis + ": the loading note contains no NaN — got " + JSON.stringify(shown));
    ok(/5s/.test(shown), basis + ": ...and the elapsed count is on screen (5s)");
    if (want) ok(shown.includes(want), basis + ": ...beside the measured estimate");
    else ok(!/usually about/.test(shown),
            basis + ": ...and with no history it claims no 'usually about'");

    // Past the estimate the bar must still be visibly unfinished AND say so.
    Date.__t = 90000; ticker();
    const late = el("rlNote").innerHTML, width = parseFloat(el("rlFill").style.width);
    ok(width > 20 && width < 96,
       basis + ": at 90s the bar is visibly moving and short of full — got " + width + "%");
    ok(/still working/.test(late), basis + ": ...and the overrun says it is still working");
  }
}

if (failed) { console.error("\n" + failed + " assertion(s) FAILED."); process.exit(1); }
console.log(passed + " assertions passed. (" + users.length + " pages on the shared loader)");
