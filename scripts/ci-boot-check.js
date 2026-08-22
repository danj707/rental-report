#!/usr/bin/env node
/**
 * CI guard: actually BOOT the server and confirm it answers a request.
 *
 * Why this exists: `node --check` proves a file PARSES, and the specs prove
 * individual functions behave — neither of them runs server.js. On 2026-08-22 a
 * change registered two `app.get(...)` routes above `const app = express()`.
 * That is valid syntax and every spec passed, so CI went green, the PR merged,
 * and the production deploy failed on:
 *
 *     ReferenceError: Cannot access 'app' before initialization
 *
 * Only Railway caught it. The CI file has always claimed to exist so "a syntax
 * error can't reach prod (see the boot-crash incidents this was added to
 * prevent)" — this closes the gap between a syntax error and an actual crash.
 *
 * Hermetic on purpose: METABASE_URL points at a dead port so booting CI never
 * reaches out to production Metabase. Every outbound call in server.js is
 * wrapped, so failing fetches must not stop it from serving.
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const PORT = 3987;
const DEADLINE_MS = 45000;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-check-"));

const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    // Dead port: fast-fail every outbound call instead of touching prod.
    METABASE_URL: "http://127.0.0.1:9",
    RESEND_API_KEY: "",
    SLACK_WEBHOOK_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", d => { out += d; });
child.stderr.on("data", d => { out += d; });

let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal }; });

function done(ok, why) {
  try { child.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  if (ok) {
    console.log("✓ " + why);
    process.exit(0);
  }
  console.error("✗ " + why);
  const tail = out.split("\n").slice(-40).join("\n");
  if (tail.trim()) console.error("\n--- server output (last 40 lines) ---\n" + tail);
  process.exit(1);
}

function poll(started) {
  if (exited) {
    return done(false, `server exited before answering (code ${exited.code}, signal ${exited.signal})`);
  }
  // server.js installs an uncaughtException handler, so a fatal boot error
  // LOGS and the process stays alive without ever listening. Without this the
  // check would sit out the full deadline for the most likely failure.
  if (/\[uncaught\]/.test(out)) {
    return done(false, "server logged an uncaught exception during boot");
  }
  if (Date.now() - started > DEADLINE_MS) {
    return done(false, `server did not answer on :${PORT} within ${DEADLINE_MS / 1000}s`);
  }
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, res => {
    res.resume();
    // Any HTTP status means Express is up and routing. A 401 from the dashboard
    // password gate is just as good a proof of life as a 200.
    done(true, `server booted and answered / with HTTP ${res.statusCode}`);
  });
  req.on("error", () => setTimeout(() => poll(started), 500));
  req.on("timeout", () => { req.destroy(); setTimeout(() => poll(started), 500); });
}

setTimeout(() => poll(Date.now()), 500);
