#!/usr/bin/env node
/* ============================================================================
 * report-settings-unlock.spec.js — the gear is VISIBLE and asks for the admin
 * password, and the authorization is still entirely server-side.
 *
 * Dan, 2026-09-01: "lets tie those in with the admin un/pw. So show the settings
 * icon, but require the admin un/pw to be entered when the settings icon is
 * clicked."
 *
 * THIS DELIBERATELY REVERSES the absent-not-greyed rule, for this one control.
 * The gear used to be missing from the DOM for anyone without the derived key,
 * so an org staffer never learned the surface existed. Showing it trades that
 * concealment for discoverability. What must NOT change is the check: the
 * settings routes still require the key, so the prompt is a way to OBTAIN the
 * credential and never a way to skip it. A client that skips the modal and PUTs
 * anyway still gets a 404.
 *
 * WHAT THIS PINS:
 *
 *   1. THE PROMPT IS NOT THE GATE. GET/PUT /api/settings still 404 without the
 *      key, whatever the page renders. This is the assertion that would fail if
 *      someone ever "simplified" the unlock into a client-side reveal.
 *   2. THE RESPONSE CARRIES NO SECRET. Success sets the HttpOnly cookie and
 *      returns {ok:true} — the body must never contain the password or the
 *      derived key, and the cookie must carry the KEY, not the password.
 *   3. IT IS THROTTLED. A password prompt reachable by any org-token holder is
 *      a brute-force surface against ONE shared secret that did not exist while
 *      the gear was hidden. Five tries per IP per window, then 429.
 *   4. ALREADY UNLOCKED DOES NOT BURN AN ATTEMPT. Otherwise a reload storm
 *      locks the real admin out of their own panel.
 *   5. THE REFUSALS ARE MARKED DELIBERATE. No password configured, flag off, or
 *      an unregistered report all 404 — and noteDeadLink alerts on exactly that
 *      shape ("a 404 that arrived with a valid-looking token"), so an unmarked
 *      one pages someone every time a staffer clicks the gear.
 *   6. THE LOCKOUT posts to Slack and a single miss does not. Somebody guessing
 *      the admin password on an org report is a security event; one typo by the
 *      person who set it is not.
 *   7. The username is NOT part of the check, because dashboardAuth does not
 *      check one either — it compares the PASSWORD alone. So the modal asks for
 *      a password and says which one, rather than rendering a decorative
 *      username box.
 *
 * It LIFTS AND RUNS the throttle and the password comparison rather than
 * regexing them — a regex passes on an inverted comparison. SKIP_SOURCE=1 drops
 * the source assertions so the LIVE half can be shown to catch a regression on
 * its own.
 * ==========================================================================*/
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const PAGE = fs.readFileSync(path.join(ROOT, "public", "roster.html"), "utf8");

let n = 0;
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";
const src = (c, w) => { if (SKIP_SOURCE) return; n++; assert.ok(c, w); };
const ok = (c, w) => { n++; assert.ok(c, w); };
const is = (a, b, w) => { n++; assert.deepStrictEqual(a, b, w); };

// ── 1. lift and RUN the throttle ────────────────────────────────────────────
{
  const from = SERVER.indexOf("const RS_UNLOCK_MAX_TRIES");
  const to = SERVER.indexOf("function dashboardPasswordMatches(");
  ok(from > 0 && to > from, "the unlock throttle block is still findable");
  const T = new Function(SERVER.slice(from, to)
    + "\nreturn { rsUnlockThrottle, rsUnlockNoteFailure, rsUnlockClear, RS_UNLOCK_MAX_TRIES };")();

  is(T.rsUnlockThrottle("1.1.1.1").locked, false, "a fresh address is not locked");
  is(T.rsUnlockThrottle("1.1.1.1").left, T.RS_UNLOCK_MAX_TRIES, "…and has every attempt available");

  // Walk it to the limit and one past.
  let last;
  for (let i = 0; i < T.RS_UNLOCK_MAX_TRIES; i++) last = T.rsUnlockNoteFailure("2.2.2.2");
  is(last.locked, true, "the address locks after RS_UNLOCK_MAX_TRIES failures");
  is(T.rsUnlockThrottle("2.2.2.2").locked, true, "…and stays locked on the next look");
  is(T.rsUnlockThrottle("3.3.3.3").locked, false,
     "the lock is PER ADDRESS — one attacker must not lock out the real admin");
  ok((T.rsUnlockThrottle("2.2.2.2").retryInMs || 0) > 0,
     "a locked address is told how long it has to wait, or the message cannot say");

  // A success must clear it, or an admin who mistypes twice carries those
  // strikes for the rest of the window.
  T.rsUnlockClear("2.2.2.2");
  is(T.rsUnlockThrottle("2.2.2.2").locked, false, "a successful unlock clears the address");

  // Below the limit it is not locked — the off-by-one that would lock a first try.
  for (let i = 0; i < T.RS_UNLOCK_MAX_TRIES - 1; i++) T.rsUnlockNoteFailure("4.4.4.4");
  is(T.rsUnlockThrottle("4.4.4.4").locked, false,
     "one attempt short of the limit is NOT locked (an off-by-one here locks the real admin out early)");
  is(T.rsUnlockThrottle("4.4.4.4").left, 1, "…and it reports the single attempt left");
}

// ── 2. lift and RUN the password comparison ─────────────────────────────────
{
  const from = SERVER.indexOf("function dashboardPasswordMatches(");
  const to = SERVER.indexOf("\n}", from) + 2;
  const M = new Function("crypto", "DASHBOARD_PASSWORD",
    SERVER.slice(from, to) + "\nreturn dashboardPasswordMatches;");
  const m = M(crypto, "correct horse");

  is(m("correct horse"), true, "the right password matches");
  is(m("Correct horse"), false, "…and it is case sensitive");
  is(m("correct hors"), false, "a prefix does not match");
  is(m("correct horsey"), false, "nor does a longer string");
  is(m(""), false, "empty does not match");
  is(m(undefined), false, "undefined is survivable and false");
  is(m(null), false, "null is survivable and false");
  is(m(123), false, "a non-string is false rather than coerced");

  // FAIL CLOSED: no password configured means nothing matches, including empty.
  const none = M(crypto, "");
  is(none(""), false, "with no DASHBOARD_PASSWORD set, even an empty password fails — fail closed");
  is(none("anything"), false, "…and so does anything else");
}

// ── 3. lift and RUN the lockable gate ───────────────────────────────────────
{
  const from = SERVER.indexOf("function reportSettingsLockable(");
  const to = SERVER.indexOf("\n}", from) + 2;
  const L = new Function("getFlags", "reportSettingsKeyOk", "reportSettingsAdminKey",
    SERVER.slice(from, to) + "\nreturn reportSettingsLockable;");

  const F = on => () => ({ reportSettings: on });
  is(L(F(true), () => false, () => "k")({}), true,
     "flag on, no key held, a key configured → the gear renders LOCKED");
  is(L(F(false), () => false, () => "k")({}), false,
     "flag OFF → no locked gear: there is nothing to unlock into, and a gear that can never "
     + "work for anybody is the dead end this repo keeps writing down");
  is(L(F(true), () => true, () => "k")({}), false,
     "already holding the key → not lockable, the real gear renders instead");
  is(L(F(true), () => false, () => "")({}), false,
     "no DASHBOARD_PASSWORD means no derived key means nobody can unlock — so no prompt is offered");
}

// ── 4. source invariants ────────────────────────────────────────────────────
src(/app\.post\("\/:org\/:report\/api\/settings-unlock"/.test(SERVER),
    "the unlock route exists");
// The response must never hand a secret back to JS.
{
  const i = SERVER.indexOf('app.post("/:org/:report/api/settings-unlock"');
  const j = SERVER.indexOf('app.get("/:org/:report/api/settings"', i);
  const body = SERVER.slice(i, j);
  src(/setReportSettingsCookie\(req, res\);/.test(body),
      "success sets the cookie — that is how the credential travels");
  src(!/res\.json\([^)]*reportSettingsAdminKey\(\)/.test(body) && !/key:/.test(body),
      "the response body must NOT contain the derived key");
  src(!/password/.test(body.split("res.json({ ok: true }")[1] || ""),
      "…nor echo the password back");
  src(/refuse404\(res\)/.test(body),
      "the refusals go through refuse404 so noteDeadLink does not report them as stale links");
  src(/if \(reportSettingsKeyOk\(req\)\) return res\.json\(\{ ok: true, already: true \}\)/.test(body),
      "an already-unlocked caller short-circuits BEFORE the throttle — a reload storm must not "
      + "lock the real admin out of their own panel");
  src(/status\(429\)/.test(body), "a locked address gets 429, not a generic failure");
  src(/logEvent\(org, report, "settings-locked"/.test(body),
      "the LOCKOUT is logged — that is the security signal");
  src(/if \(after\.locked\)/.test(body),
      "…and only the lockout, not every single miss: one typo by the person who set the password "
      + "is not an event worth posting");
}
// The gate itself is unchanged: the prompt is not the check.
src(/if \(!isReportSettingsAdmin\(req\)\) return refuse404\(res\);/.test(SERVER),
    "GET /api/settings still refuses without the key — the prompt did not become the gate");
is((SERVER.match(/if \(!isReportSettingsAdmin\(req\)\) return refuse404\(res\);/g) || []).length, 2,
   "BOTH settings routes (GET and PUT) still refuse without the key");

src(/"settings-unlock", "settings-locked"/.test(SERVER),
    "both events are in SLACK_NOTIFY, or they are recorded and never reach the channel — "
    + "the trap this repo has hit four times");
src(/"settings-locked": \{ emoji/.test(SERVER), "the lockout has its own message meta");

// The page.
src(/settingsLockable,/.test(SERVER), "settingsLockable is injected into ORG_CONFIG");
src(/function rsLockable\(\)/.test(PAGE), "the page reads it");
src(/data-rs-locked/.test(PAGE), "the locked gear is identifiable in the DOM");
src(/<input type="password"/.test(PAGE),
    "the prompt uses a real password input, so browsers mask it and can store it");
src(/window\.location\.reload\(\)/.test(PAGE),
    "success RELOADS: settingsAdmin is injected server-side and decides the first render, so the "
    + "panel cannot be revealed client-side without lying about what the server authorised");
// The username is not checked anywhere, so it is not asked for.
src(!/type="text"[^>]*username/i.test(PAGE) && !/autoComplete="username"/.test(PAGE),
    "no username field: dashboardAuth compares the PASSWORD alone, and a box that is ignored is a lie");

// ── 5. Live: drive the real route ───────────────────────────────────────────
(async () => {
  const PORT = 3994;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-rsunlock-"));
  fs.writeFileSync(path.join(dataDir, "feature-flags.json"), JSON.stringify({ reportSettings: true }));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: "http://127.0.0.1:9",
      RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "spec-password" }),
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

  const call = (method, p, body, extraHeaders) => new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, timeout: 20000,
      headers: Object.assign({}, body ? { "Content-Type": "application/json" } : {}, extraHeaders || {}) },
      r => { let b = ""; r.on("data", d => b += d); r.on("end", () => {
        let j = null; try { j = JSON.parse(b); } catch {}
        res({ status: r.statusCode, body: b, json: j, headers: r.headers });
      }); });
    req.on("error", rej);
    req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
    req.end(body ? JSON.stringify(body) : undefined);
  });

  const KEY = crypto.createHash("sha256")
    .update("spec-password|report-settings|v1").digest("hex").slice(0, 32);
  const U = `/${org}/roster/api/settings-unlock?token=${encodeURIComponent(token)}`;
  const S = `/${org}/roster/api/settings?token=${encodeURIComponent(token)}`;

  try {
    await new Promise((res, rej) => {
      const t0 = Date.now(), tick = () => {
        if (Date.now() - t0 > 60000) return rej(new Error("server did not start\n" + log.slice(-600)));
        http.get({ host: "127.0.0.1", port: PORT, path: "/healthz", timeout: 2000 },
          r => { r.resume(); res(); }).on("error", () => setTimeout(tick, 400));
      };
      tick();
    });

    // The panel is still shut without a credential, however the page looks.
    {
      const r = await call("GET", S);
      is(r.status, 404, "GET /api/settings still 404s for a token holder with no key");
    }

    // A wrong password: 401, and it says how many tries are left.
    {
      const r = await call("POST", U, { password: "nope" });
      is(r.status, 401, "a wrong password is 401");
      ok(r.json && typeof r.json.left === "number", "…and reports the attempts remaining");
      ok(!/spec-password/.test(r.body) && !new RegExp(KEY).test(r.body),
         "a failed unlock leaks neither the password nor the derived key");
      ok(!(r.headers["set-cookie"] || []).join(";").includes(KEY),
         "…and sets no cookie");
    }

    // The right password: ok, a cookie carrying the KEY, and no secret in the body.
    let cookie = "";
    {
      const r = await call("POST", U, { password: "spec-password" });
      is(r.status, 200, "the right password unlocks");
      is(r.json && r.json.ok, true, "…and says so");
      const sc = (r.headers["set-cookie"] || []).join("\n");
      ok(/rs_admin=/.test(sc), "a cookie is set");
      ok(sc.includes(KEY), "the cookie carries the DERIVED KEY");
      ok(!sc.includes("spec-password"), "…and NEVER the password itself");
      ok(/HttpOnly/i.test(sc), "HttpOnly: no page ever reads it");
      ok(/SameSite=Lax/i.test(sc), "SameSite=Lax is the CSRF defence for the PUT that follows");
      ok(!new RegExp(KEY).test(r.body), "the response BODY does not contain the key");
      cookie = (r.headers["set-cookie"] || [])[0].split(";")[0];
    }

    // And that cookie actually opens the panel — the whole point.
    {
      const r = await call("GET", S, null, { Cookie: cookie });
      is(r.status, 200, "the cookie the unlock set opens the settings API");
      ok(r.json && r.json.settings, "…and returns the settings");
    }

    // Already unlocked: idempotent, and it must not burn an attempt.
    {
      const r = await call("POST", U, { password: "wrong-on-purpose" }, { Cookie: cookie });
      is(r.status, 200, "an already-unlocked caller is not re-checked");
      is(r.json && r.json.already, true, "…and is told it was already unlocked");
    }

    // THE THROTTLE, end to end. Five wrong tries, then 429.
    {
      let last;
      for (let i = 0; i < 5; i++) last = await call("POST", U, { password: "wrong" + i });
      is(last.status, 401, "the fifth wrong try is still 401");
      const sixth = await call("POST", U, { password: "wrong-again" });
      is(sixth.status, 429, "the sixth is 429 — the prompt is throttled");
      // AND THE RIGHT PASSWORD IS ALSO REFUSED while locked, or the throttle is
      // decorative: an attacker who guesses on try six still gets in.
      const right = await call("POST", U, { password: "spec-password" });
      is(right.status, 429,
         "even the CORRECT password is refused while locked out — otherwise the throttle counts "
         + "attempts without actually stopping the next one");
    }

    // DRIVE A REFUSAL PATH, or the zero-deadlink assertion below is vacuous —
    // with the password set and the flag on, none of the refuse404 branches ran.
    // `facility` is not in REPORT_SETTINGS_SCHEMA, so this is the unregistered
    // -report refusal, and it carries a perfectly valid org token: exactly
    // noteDeadLink's trigger shape.
    {
      const r = await call("POST", `/${org}/facility/api/settings-unlock?token=${encodeURIComponent(token)}`,
                           { password: "spec-password" });
      is(r.status, 404, "an unregistered report refuses the unlock");
    }
    {
      const r = await call("GET", `/${org}/facility/api/settings?token=${encodeURIComponent(token)}`);
      is(r.status, 404, "…and so does its settings route");
    }

    // No DEAD LINK alert from any of it: every refusal above carried a real token,
    // which is exactly noteDeadLink's trigger shape.
    {
      const ev = path.join(dataDir, "events.jsonl");
      const lines = fs.existsSync(ev) ? fs.readFileSync(ev, "utf8").trim().split("\n").filter(Boolean) : [];
      const rows = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      is(rows.filter(r => r.event === "deadlink").length, 0,
         "ZERO deadlink events despite every request carrying a valid token — a deliberate refusal "
         + "is not a stale link, and without refuse404 each gear click pages someone");
      is(rows.filter(r => r.event === "settings-unlock").length, 1,
         "the successful unlock was logged exactly once");
      is(rows.filter(r => r.event === "settings-locked").length, 1,
         "the lockout was logged exactly once — not once per failed attempt");
      ok(!fs.readFileSync(ev, "utf8").includes("spec-password"),
         "THE PASSWORD IS NEVER WRITTEN TO THE EVENT LOG — it is echoed to Slack and read on the "
         + "admin dashboard, which is exactly why the org token is not logged either");
    }

    console.log("✓ report-settings-unlock.spec.js — " + n + " assertions passed");
  } catch (e) {
    console.error("\n✗ report-settings-unlock.spec.js\n  " + (e && e.message));
    if (log) console.error("\n--- server log ---\n" + log.slice(-1200));
    process.exitCode = 1;
  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
})();
