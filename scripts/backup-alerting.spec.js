#!/usr/bin/env node
/* ============================================================================
   A FAILED BACKUP HAS TO PAGE SOMEBODY.

   The daily gist backup is the platform's only off-platform copy since the
   Postgres flip, and it failed silently: `catch` logged to the console, set
   _lastBackup.status = "error", and posted nothing. A dead GITHUB_PAT sat
   unnoticed because nothing was watching the watcher.

   Two defects are pinned here, and the second is the one no amount of reading
   the alert code would have caught:

     1. the failure never reached Slack, and
     2. the saved gist id was read AT MODULE SCOPE — ~17,000 lines before
        storeBoot() connects — so in db mode it came back empty and every run
        took the CREATE path, minting a fresh gist per boot.

   The helpers are LIFTED AND RUN rather than regexed: every defect in the
   freshness check is a comparison, and a regex passes on an inverted one.
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; } else { failed++; console.error("  ✗ " + name); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

/* Slice a named function out of server.js, bounded by its own braces. Skips the
   parameter list first — counting from the first `{` lands on a destructured
   parameter and lifts half a function (the recorded liftFn trap). */
function liftSrc(name) {
  let i = SRC.indexOf(`function ${name}(`);
  if (i < 0) return null;
  // Take the `async ` with it. Slicing from `function` drops the keyword and
  // silently lifts a SYNC copy of an async function, which then fails on
  // .then() rather than on anything to do with the code under test.
  if (SRC.slice(i - 6, i) === "async ") i -= 6;
  const open = SRC.indexOf("{", SRC.indexOf(")", i));
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(i, j + 1);
  }
  return null;
}

/* ── 1. the alert reaches Slack at all ──────────────────────────────────── */
const notifyLine = (SRC.match(/const SLACK_NOTIFY = new Set\(\[[^\]]*\]\)/) || [""])[0];
ok(notifyLine.length > 50, "SLACK_NOTIFY was found (or every assertion below is vacuous)");
ok(/"backup-failed"/.test(notifyLine),
   "backup-failed is in SLACK_NOTIFY — an event missing from it is dropped SILENTLY");
ok(/"backup-failed":\s*6 \* 60 \* 60 \* 1000/.test(SRC),
   "backup-failed carries the 6h watchdog debounce");
ok(/"backup-failed":\s*\{\s*emoji:/.test(SRC),
   "backup-failed has a SLACK_EVENT_META entry");

/* ── 2. it has its OWN message branch ───────────────────────────────────────
   The shared line prints the report type twice and the reason never — the
   defect already fixed once in the `feedback` branch. */
ok(/rec\.event === "backup-failed"/.test(SRC),
   "backup-failed has its own message branch, not the shared line");
const branch = SRC.slice(SRC.indexOf('rec.event === "backup-failed"'),
                         SRC.indexOf('rec.event === "report-down"'));
ok(branch.length > 100, "the branch slice is non-empty");
ok(/rec\.error/.test(branch), "the message names the REASON");
ok(/hoursSinceOk/.test(branch), "the message names how long it has been broken");
ok(/SLACK_MENTION_USER_ID/.test(branch), "the message @-mentions — this is the highest-severity alert here");

/* ── 3. it cannot be switched off ───────────────────────────────────────────
   Same reasoning as `watchdog` itself: the notice that the last line of defence
   is gone must not be silenced by a toggle. */
const flagMap = SRC.slice(SRC.indexOf("const ALERT_FLAG_BY_EVENT"),
                          SRC.indexOf("const WATCHDOG_FLAG_META"));
ok(flagMap.length > 50, "the ALERT_FLAG_BY_EVENT slice is non-empty");
ok(!/backup/.test(flagMap),
   "backup-failed is NOT in ALERT_FLAG_BY_EVENT — it is not switchable off");

/* ── 4. THE MODULE-SCOPE READ IS GONE ───────────────────────────────────────
   In db mode storeBoot() has not connected this far up the file, so a read here
   sees the container's own disk, returns empty, and every backup CREATES a new
   gist rather than appending to the one that exists. */
ok(!/\nlet _backupGistId = "";\ntry \{/.test(SRC),
   "the gist id is NOT read at module scope (the db-mode staleness trap)");
const gistFn = liftSrc("backupGistId");
ok(gistFn && /readJSON\(BACKUP_GIST_ID_KEY/.test(gistFn),
   "backupGistId() does the read itself, lazily");
const perform = SRC.slice(SRC.indexOf("async function performBackup"),
                          SRC.indexOf("cron.schedule(\"0 2 * * *\""));
ok(perform.length > 500, "the performBackup slice is non-empty");
/* Tested LINE BY LINE with comments excluded. A bare regex over the slice is
   satisfied by the call commented out — found by mutation, and the recorded
   lesson: an assertion satisfied by dead code is not guarding what it names. */
ok(perform.split("\n").some(l => /backupGistId\(\)/.test(l) && !l.trim().startsWith("//")),
   "performBackup populates the id at RUN time — a lazy loader nothing calls is worse than none");

/* ── 5. both failure paths alert, and success is recorded durably ────────── */
ok(/alertBackupProblem\("error", err\.message\)/.test(perform),
   "the catch alerts (the bug exactly as it shipped)");
ok(/alertBackupProblem\("skipped"/.test(perform),
   "an unset GITHUB_PAT alerts too — no key means no backups at all");
ok(/writeJSON\(BACKUP_LAST_OK_KEY/.test(perform),
   "a successful backup is recorded durably, or 'how long has this been broken' is unanswerable after a restart");

/* ── 6. LIFT AND RUN the freshness arithmetic ───────────────────────────── */
const hoursSrc = liftSrc("hoursSinceBackup");
ok(!!hoursSrc, "hoursSinceBackup was lifted");
function makeHours(rec) {
  // Inject what the function actually READS (backupLastOk), not what its body
  // looks like it reads. The first draft injected readJSON and the spec DIED
  // with a bare ReferenceError naming nothing — the recorded lift trap.
  return new Function("backupLastOk",
    hoursSrc + "\nreturn hoursSinceBackup;")(() => rec);
}
/* A throw at CALL time must fail by name rather than killing the run; the
   lift's own try/catch only ever covered lift time. */
function guard(fn, fallback) {
  return (...a) => { try { return fn(...a); } catch (e) { failed++; console.error("  \u2717 THREW: " + e.message); return fallback; } };
}
eq(guard(makeHours(null))(), null, "no record at all reports null, never 0 — 'never backed up' is not 'backed up just now'");
eq(guard(makeHours({ at: "not-a-date" }))(), null, "an unreadable timestamp reports null rather than a confident number");
const fiveHoursAgo = new Date(Date.now() - 5 * 3600000).toISOString();
const h5 = guard(makeHours({ at: fiveHoursAgo }), 0)();
ok(h5 > 4.9 && h5 < 5.1, "a real timestamp resolves to its age in hours");

/* ── 7. LIFT AND RUN the staleness gate ─────────────────────────────────── */
const freshSrc = liftSrc("checkBackupFreshness");
ok(!!freshSrc, "checkBackupFreshness was lifted");
function runFresh(hours) {
  const alerts = [];
  const fn = new Function("hoursSinceBackup", "alertBackupProblem", "BACKUP_STALE_HOURS",
    freshSrc + "\nreturn checkBackupFreshness;"
  )(() => hours, (status, err) => alerts.push({ status, err }), 36);
  return fn().then(r => ({ result: r, alerts }));
}
(async () => {
  const fresh = await runFresh(2);
  eq(fresh.result.stale, false, "a 2h-old backup is fresh");
  eq(fresh.alerts.length, 0, "a fresh backup alerts NOBODY — a watchdog that cries wolf gets muted");

  const stale = await runFresh(200);
  eq(stale.result.stale, true, "a 200h-old backup is stale");
  eq(stale.alerts.length, 1, "a stale backup alerts exactly once per check");
  eq(stale.alerts[0].status, "stale", "...and says it is STALE, not that a run failed");

  const never = await runFresh(null);
  eq(never.result.stale, true, "no record on file counts as stale");
  eq(never.alerts[0].status, "never",
     "...and is reported as 'never', which is a different fact from a run that failed");

  /* ── 8. the boundary is the constant, not a literal ──────────────────── */
  const justUnder = await runFresh(35.9);
  eq(justUnder.alerts.length, 0, "35.9h is inside the 36h threshold");
  const justOver = await runFresh(36.1);
  eq(justOver.alerts.length, 1, "36.1h is outside it");

  /* ── 9. the status route answers the real question ──────────────────── */
  const route = SRC.slice(SRC.indexOf('app.get("/api/admin/backup-status"'),
                          SRC.indexOf('app.get("/api/admin/org/:slug"'));
  ok(route.length > 100, "the backup-status route slice is non-empty");
  ok(/hoursSinceSuccess/.test(route) && /stale/.test(route),
     "the status route reports STALENESS, not just this container's last attempt");
  ok(/lastSuccess/.test(route),
     "...and the durable last success, which survives a deploy");

  /* ── 10. the credential diagnostic ──────────────────────────────────────
     A 401 says GitHub rejected the token; it cannot see the other failure
     mode, a live token with no `gist` scope. Both have to be reported, and
     neither may echo the value. */
  const cred = SRC.slice(SRC.indexOf('app.get("/api/admin/backup-credential"'),
                         SRC.indexOf('app.get("/api/admin/org/:slug"'));
  ok(cred.length > 200, "the backup-credential route slice is non-empty");
  ok(/adminPasswordOk\(req\)/.test(cred),
     "the credential check is GATED \u2014 every other /api/admin GET is open, and this one spends a secret");
  ok(/!DASHBOARD_PASSWORD/.test(SRC.slice(SRC.indexOf("function adminPasswordOk"), SRC.indexOf("function adminPasswordOk") + 200)),
     "...and it FAILS CLOSED: no dashboard password means nobody");
  ok(!/BACKUP_PAT\s*\}\)|token:\s*BACKUP_PAT|pat:\s*BACKUP_PAT/.test(cred),
     "the route never returns the token itself");
  ok(/x-oauth-scopes/.test(cred),
     "it reads the scope header \u2014 a valid token with no gist scope fails differently and looks fine");
  ok(/hasGistScope/.test(cred) && /401/.test(cred),
     "it separates 'rejected' from 'valid but cannot write gists'");
  ok(/ok: r\.ok && hasGist/.test(cred),
     "ok means BOTH authenticated and able to write a gist, not merely authenticated");

  /* The button is a dead end if nothing calls it; ci-check-admin-js proves the
     handler resolves, this proves the button is actually on the page. */
  ok(/onclick="checkBackupCred\(\)"/.test(SRC),
     "the dashboard offers the check \u2014 a diagnostic nobody can find does not exist");

  console.log(`\n${passed} assertions passed${failed ? `, ${failed} FAILED` : ""}.`);
  process.exit(failed ? 1 : 0);
})();
