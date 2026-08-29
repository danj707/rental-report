#!/usr/bin/env node
/**
 * slack-production-only.spec.js — Slack posts ONLY from production.
 *
 * THE BUG, as Dan saw it (2026-08-29): three contradictory "Daily activity —
 * Fri, Aug 28" digests arrived in #reporting-events within minutes of each
 * other, each reporting different numbers for the same day.
 *
 *   production            429 views across 19 orgs      ← the real one
 *   rental-report-pr-169   15 views, "report-wizard 15"  ← a parked branch
 *   rental-report-pr-159   "Quiet day: nothing logged."  ← a parked branch
 *
 * CAUSE: Railway PR previews inherit the SERVICE's variables — SLACK_WEBHOOK_URL
 * included — and each preview gets its OWN volume. So every preview ran the
 * midnight cron against its own tiny events.jsonl and posted the result to the
 * live channel. Confirmed against Railway: the project has exactly three
 * environments and there were exactly three digests.
 *
 * The digest is only the visible half. `notifySlack` reads the same constant, so
 * every view / generate / export driven on a preview has been landing in the
 * feed Dan reads to judge real usage — and nothing in the message says which
 * environment sent it, so it is indistinguishable from production traffic.
 *
 * THE FIX is one gate at the source: SLACK_WEBHOOK_URL resolves to "" unless
 * this is production. Both post sites already degrade to a log line when it is
 * empty, so nothing else had to change.
 *
 * IT FAILS OPEN ON PURPOSE. An unset RAILWAY_ENVIRONMENT_NAME means we are not
 * on Railway (local, CI) — the webhook is essentially never set there, and if
 * Railway ever stopped injecting the name, posting twice is a nuisance whereas a
 * silently dead activity feed is the failure this repo keeps being bitten by.
 * Only a NAMED non-production environment is muted. That asymmetry is asserted
 * below, because "mute everything we are not sure about" is the tempting change
 * and it is the wrong one.
 *
 * Run: node scripts/slack-production-only.spec.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
let n = 0;
const ok = (c, w) => { n++; assert.ok(c, w); };
const is = (a, b, w) => { n++; assert.strictEqual(a, b, w); };

// ── Lift the real gate and RUN it under each environment ────────────────────
// Regexing the constant would pass on an inverted comparison; running it cannot.
const m = /const RAILWAY_ENV_NAME = [\s\S]*?const SLACK_WEBHOOK_URL = [^\n]*\n/.exec(SERVER);
assert.ok(m, "the Slack environment gate should be findable at module scope");

function resolve(envName, webhook) {
  const sandbox = { process: { env: {} }, console: { log() {} } };
  if (envName !== undefined) sandbox.process.env.RAILWAY_ENVIRONMENT_NAME = envName;
  if (webhook !== undefined) sandbox.process.env.SLACK_WEBHOOK_URL = webhook;
  vm.createContext(sandbox);
  vm.runInContext(m[0] + "\n;globalThis.__hook = SLACK_WEBHOOK_URL;", sandbox);
  return sandbox.__hook;
}

const HOOK = "https://hooks.slack.com/services/REAL";

// ── 1. Production posts ─────────────────────────────────────────────────────
is(resolve("production", HOOK), HOOK, "production posts — this is the feed Dan actually reads");

// ── 2. The three environments that caused the bug ───────────────────────────
is(resolve("rental-report-pr-169", HOOK), "",
   'the wizard preview must be muted — it is what posted "top reports: report-wizard 15"');
is(resolve("rental-report-pr-159", HOOK), "",
   'the other parked preview must be muted — it is what posted "Quiet day: nothing logged."');
is(resolve("rental-report-pr-9999", HOOK), "", "and so must any future preview, without configuration");
is(resolve("staging", HOOK), "", "a named non-production environment of any kind is muted");

// ── 3. THE FAIL-OPEN ASYMMETRY ──────────────────────────────────────────────
// Muting an unknown environment is the tempting stricter rule. It is wrong: it
// makes a silently dead production feed the failure mode, and nobody notices a
// feed that stops.
is(resolve(undefined, HOOK), HOOK,
   "NOT on Railway (no env name) still posts — muting here would make a dead production feed " +
   "the failure mode if Railway ever stopped injecting the name");
is(resolve("", HOOK), HOOK, "an empty env name is the same case as an absent one");

// ── 4. No webhook is still no webhook ───────────────────────────────────────
is(resolve("production", undefined), "", "production with no webhook configured stays inert");
is(resolve("rental-report-pr-1", undefined), "", "and so does a preview");

// ── 5. One gate, both post sites ────────────────────────────────────────────
// notifySlack and postDailyActivitySummary both read the constant. If a third
// posting site ever reads process.env directly it bypasses the gate entirely.
const posts = SERVER.match(/fetch\(SLACK_WEBHOOK_URL/g) || [];
is(posts.length, 2, "both Slack post sites go through the gated constant (notifySlack + the daily digest)");
const rawEnvReads = SERVER.match(/fetch\(\s*process\.env\.SLACK_WEBHOOK_URL/g) || [];
is(rawEnvReads.length, 0, "nothing posts straight from process.env, which would sidestep the gate");
is((SERVER.match(/const SLACK_WEBHOOK_URL =/g) || []).length, 1,
   "the constant is defined exactly once — a second definition is a second, ungated truth");

// ── 6. The state is observable ──────────────────────────────────────────────
// A muted preview and a broken production feed look identical from the outside,
// so the admin route has to say which one this is.
ok(/environment: RAILWAY_ENV_NAME \|\| "\(not on Railway\)"/.test(SERVER),
   "/api/admin/report-activity reports which environment this instance is");
ok(/slackPostingEnabled: !!SLACK_WEBHOOK_URL/.test(SERVER),
   "…and whether it may post at all — otherwise a muted preview is indistinguishable from a dead feed");

console.log("✓ slack-production-only.spec.js — " + n + " assertions");
