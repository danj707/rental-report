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

const estFn = server.slice(server.indexOf("function loadEstimateFor"),
                           server.indexOf("// Every page's ORG_CONFIG"));
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

// Injected on first paint. A separate endpoint would mean the bar draws before
// it knows its own scale — the guessing this replaces.
ok(/loadEstimate: loadEstimateFor\(slug, rt\)/.test(server),
   "the estimate rides in ORG_CONFIG, so the bar has its scale on first paint");
ok(!/window\.ORG_CONFIG=\$\{JSON\.stringify\(orgConfig\)\}/.test(server),
   "no injection site bypasses orgConfigInject — one that did would ship a bar with no estimate");

if (failed) { console.error("\n" + failed + " assertion(s) FAILED."); process.exit(1); }
console.log(passed + " assertions passed. (" + users.length + " pages on the shared loader)");
