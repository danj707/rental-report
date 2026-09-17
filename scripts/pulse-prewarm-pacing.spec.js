#!/usr/bin/env node
/**
 * THE PULSE PRE-WARM MUST PACE ITSELF, BACK OFF, AND RUN ON ONE REPLICA.
 *
 * On 2026-09-17 four cold boots inside thirty minutes left the read replica in
 * a state where `SELECT 1` took 52s and then timed out past 60s. The report
 * pre-warm was correctly standing aside the whole time — "aborted — replica
 * degraded (0 timeouts, avg 53946ms)", i.e. nothing was FAILING, everything was
 * queued — while prewarmPulseCache walked 40 orgs for 87 minutes, twice, once
 * per replica. Metabase recovered within two minutes of it finishing.
 *
 * Each org is 24 Metabase queries (4 report types x 6 trailing months), so that
 * walk is ~960 queries per replica with no pacing and no ability to stop.
 *
 * THE BEHAVIOURAL HALF IS THE GUARD. A regex over `prewarmPace()` passes on an
 * implementation that calls it and ignores the answer, and every defect here is
 * a comparison or an ordering. So the walk is LIFTED AND RUN against injected
 * dependencies, and the assertions read what it actually did.
 *
 * SKIP_SOURCE=1 drops the source half, so the behavioural half can be shown to
 * catch a regression on its own.
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
let passed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed++; return true; }
  failures.push(name);
  console.error("  ✗ " + name);
  return false;
}
// A guard that DIES instead of failing has not told anyone what broke — the
// lesson CLAUDE.md records for the waitlist and facility-lighting specs.
function guard(name, fn) {
  try { return fn(); } catch (e) { ok(false, name + " — THREW: " + e.message); return undefined; }
}

// ── Lift ────────────────────────────────────────────────────────────────────
// Brace-count from the declaration. Skipping the parameter list first is the
// recorded liftFn trap: counting from the first "{" lands on a destructured
// parameter and cuts the function in half.
function liftFn(src, decl) {
  const start = src.indexOf(decl);
  if (start < 0) throw new Error("could not find " + decl);
  const bodyStart = src.indexOf("{", start + decl.length);
  let depth = 0, i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const walkSrc = guard("prewarmPulseCache can be lifted", () =>
  liftFn(SRC, "async function prewarmPulseCache()"));
ok(walkSrc && walkSrc.length > 200, "the lifted walk is non-empty (or every assertion below is vacuous)");

function makeWalk(deps) {
  const factory = new Function(
    "getFlags", "ORGS", "refreshOrgPulse", "prewarmPace", "sleepMs", "console",
    walkSrc + "; return prewarmPulseCache;"
  );
  return factory(deps.getFlags, deps.ORGS, deps.refreshOrgPulse, deps.prewarmPace,
                 deps.sleepMs, deps.console);
}

// Four tokened orgs plus one without a token, which must never be walked.
const ORGS_FIXTURE = {
  alpha:   { token: "t1" },
  bravo:   { token: "t2" },
  charlie: { token: "t3" },
  delta:   { token: "t4" },
  notoken: {},
};

function harness(paceSeq) {
  const walked = [];
  const sleeps = [];
  const logs = [];
  let call = 0;
  return {
    walked, sleeps, logs,
    deps: {
      getFlags: () => ({ cachingEnabled: true }),
      ORGS: ORGS_FIXTURE,
      refreshOrgPulse: async (slug) => { walked.push(slug); },
      prewarmPace: () => paceSeq[Math.min(call++, paceSeq.length - 1)],
      sleepMs: async (ms) => { sleeps.push(ms); },
      console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
    },
  };
}

const HEALTHY  = { abort: false, delayMs: 3000,  timeouts: 0, avgMs: 900 };
const DEGRADED = { abort: false, delayMs: 12000, timeouts: 1, avgMs: 20000 };
const UNHEALTHY= { abort: true,  delayMs: 0,     timeouts: 2, avgMs: 54000 };

(async () => {
  // ── 1. Healthy: every tokened org, and the tokenless one is skipped ───────
  {
    const h = harness([HEALTHY]);
    await guard("healthy walk runs", async () => makeWalk(h.deps)());
    ok(h.walked.join(",") === "alpha,bravo,charlie,delta",
       "a healthy replica walks every tokened org, and only those (got: " + h.walked.join(",") + ")");
    ok(!h.walked.includes("notoken"), "an org with no token is never walked");
  }

  // ── 2. It GAPS between orgs, and does not pay a gap before the first ──────
  {
    const h = harness([HEALTHY]);
    await guard("paced walk runs", async () => makeWalk(h.deps)());
    ok(h.sleeps.length === 3,
       "4 orgs means 3 gaps — the walk waits BETWEEN orgs (got " + h.sleeps.length + ")");
    ok(h.sleeps.every(ms => ms === 3000),
       "each gap is the pace's own delayMs, not a hardcoded number (got " + h.sleeps.join(",") + ")");
  }
  {
    const h = harness([DEGRADED]);
    await guard("degraded-pace walk runs", async () => makeWalk(h.deps)());
    ok(h.sleeps.every(ms => ms === 12000),
       "a degraded-but-survivable replica gets the LONGER gap, read from the pace (got " + h.sleeps.join(",") + ")");
    ok(h.walked.length === 4, "degraded-but-survivable still completes the walk");
  }

  // ── 3. Unhealthy mid-walk: it STOPS, and the tripping org is not walked ───
  {
    // healthy, healthy, then the replica goes under
    const h = harness([HEALTHY, HEALTHY, UNHEALTHY]);
    await guard("aborting walk runs", async () => makeWalk(h.deps)());
    ok(h.walked.join(",") === "alpha,bravo",
       "an unhealthy replica abandons the REST of the cycle (got: " + h.walked.join(",") + ")");
    ok(!h.walked.includes("charlie"),
       "the org whose health check tripped the abort is NOT walked — the check is BEFORE the work, not after");
    ok(h.logs.some(l => /aborted/i.test(l) && /degraded/i.test(l)),
       "the abort says why, naming the replica as degraded");
    ok(h.logs.some(l => /54000/.test(l) || /avg/.test(l)),
       "the abort log carries the health figures that caused it");
  }

  // ── 4. Unhealthy from the start: ZERO orgs ───────────────────────────────
  {
    const h = harness([UNHEALTHY]);
    await guard("fully-aborted walk runs", async () => makeWalk(h.deps)());
    ok(h.walked.length === 0,
       "a replica already degraded at the start of the cycle gets NO pulse queries at all (got " + h.walked.length + ")");
  }

  // ── 5. The completion line must not claim a full walk after an abort ──────
  {
    const h = harness([HEALTHY, UNHEALTHY]);
    await guard("abort-wording walk runs", async () => makeWalk(h.deps)());
    const done = h.logs.filter(l => /Pre-warm (complete|aborted)/.test(l)).join(" | ");
    ok(/aborted/.test(done) && !/complete:/.test(done),
       "an aborted cycle does NOT log 'Pre-warm complete' — a partial walk reported as complete is how this went unnoticed (got: " + done + ")");
  }
  {
    const h = harness([HEALTHY]);
    await guard("complete-wording walk runs", async () => makeWalk(h.deps)());
    ok(h.logs.some(l => /Pre-warm complete: 4 orgs/.test(l)),
       "a full cycle still reports complete, with its count");
  }

  // ── 6. One org failing does not stop the walk (pre-existing behaviour) ────
  {
    const h = harness([HEALTHY]);
    h.deps.refreshOrgPulse = async (slug) => {
      h.walked.push(slug);
      if (slug === "bravo") throw new Error("boom");
    };
    await guard("throwing-org walk runs", async () => makeWalk(h.deps)());
    ok(h.walked.length === 4,
       "one org throwing does not abandon the other three (got " + h.walked.length + ")");
  }

  // ── 7. The caching flag still switches it off entirely ───────────────────
  {
    const h = harness([HEALTHY]);
    h.deps.getFlags = () => ({ cachingEnabled: false });
    await guard("flag-off walk runs", async () => makeWalk(h.deps)());
    ok(h.walked.length === 0, "caching OFF means no pulse walk at all");
  }

  // ── Source half ──────────────────────────────────────────────────────────
  if (!process.env.SKIP_SOURCE) {
    // The startup call is the one that was not leader-locked. The 5:10am cron
    // always was — which is exactly why this was easy to miss.
    const startupCall = /setTimeout\(\s*leaderCron\(\s*["'][^"']*pulse[^"']*["']\s*,\s*prewarmPulseCache\s*\)/.test(SRC);
    ok(startupCall,
       "the STARTUP pulse walk is wrapped in leaderCron — without it both replicas walk every org on every deploy");
    ok(!/setTimeout\(\s*prewarmPulseCache\s*,/.test(SRC),
       "no bare setTimeout(prewarmPulseCache, …) remains (the bug as it shipped)");
    ok(/cron\.schedule\([^)]*leaderCron\(\s*["']prewarm-pulse["']/.test(SRC),
       "the daily pulse cron is still leader-locked too");

    // Both halves of the fetch fix. Scoped to refreshOrgPulse, because the data
    // route has its own timed fetch and a file-wide test passes on that alone.
    const pulseFn = guard("refreshOrgPulse can be lifted", () =>
      liftFn(SRC, "async function refreshOrgPulse(slug, force)")) || "";
    ok(pulseFn.length > 200, "the lifted refreshOrgPulse is non-empty");
    ok(/AbortSignal\.timeout\(\s*PULSE_FETCH_TIMEOUT_MS\s*\)/.test(pulseFn),
       "a pulse fetch carries a timeout — a bare fetch() let one hung card stall the whole walk");
    ok(/recordMbSample\(/.test(pulseFn),
       "a pulse fetch records a health sample — otherwise the walk cannot see the load it is itself creating");
    const samples = (pulseFn.match(/recordMbSample\(/g) || []).length;
    ok(samples >= 2,
       "health is recorded on BOTH the success and the failure path (got " + samples + ") — recording only successes hides exactly the timeouts the pace exists to react to");
    ok(/const PULSE_FETCH_TIMEOUT_MS\s*=\s*\d+/.test(SRC),
       "the pulse timeout is a named constant");

    // The walk must read the shared pace helper rather than growing its own rule.
    ok(/prewarmPace\(\)/.test(walkSrc || ""),
       "the walk consults the SHARED prewarmPace() — two definitions of 'degraded' is how the two pre-warms start disagreeing");
    ok(/sleepMs\(/.test(walkSrc || ""),
       "the walk sleeps between orgs");
  }

  // The summary print must be the LAST thing that runs — the recorded lesson
  // about a spec that reports before its assertions have been made.
  if (failures.length) {
    console.error("\n" + failures.length + " assertion(s) failed.");
    process.exit(1);
  }
  console.log(passed + " assertions passed.");
})();
