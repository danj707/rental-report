#!/usr/bin/env node
/**
 * CI guard: the admin dashboard's inline JavaScript must PARSE, and every
 * inline on*="handler()" must name a function that exists.
 *
 * Why this exists — the 2026-08-22 dead-admin incident, which I shipped:
 *
 *   The watchdog toggles added a status string written in server.js as
 *       'Watching — alerts if a card\'s Start/End Date tag …'
 *   Inside server.js that text lives in a TEMPLATE LITERAL, and a template
 *   literal eats one level of escaping: `\'` collapses to a bare `'`. So the
 *   HTML sent to the browser contained
 *       'Watching — alerts if a card's Start/End Date tag …'
 *   — an unterminated single-quoted string. The browser threw a SyntaxError and
 *   discarded the ENTIRE 201KB <script> block, so every function declared in it
 *   was undefined and every button on the admin dashboard did nothing. The only
 *   visible symptom was
 *       Uncaught ReferenceError: clearAllDrift is not defined
 *   on whichever button you happened to click first.
 *
 * Nothing else in CI could see it. `node --check server.js` passes, because
 * server.js itself is valid — the broken code is a STRING inside it. The specs
 * pass, because none of them render the page. ci-boot-check passes, because the
 * server boots fine and serves the page happily. The bug only exists in the
 * browser, in generated code, which nothing was looking at.
 *
 * So this renders the real page from a real boot and checks the generated JS:
 *
 *   1. every inline <script> block parses (catches the escaping class of bug)
 *   2. every on*= handler resolves to a declared function (catches a button
 *      wired to a function that was renamed or deleted)
 *
 * Hermetic: METABASE_URL points at a dead port, like ci-boot-check.
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");

const PORT = 3988;
const DEADLINE_MS = 45000;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-js-check-"));

const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    METABASE_URL: "http://127.0.0.1:9",
    RESEND_API_KEY: "",
    SLACK_WEBHOOK_URL: "",
    DASHBOARD_PASSWORD: "",   // unset ⇒ the dashboard renders without the gate
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", d => { out += d; });
child.stderr.on("data", d => { out += d; });
let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal }; });

function finish(ok, why, detail) {
  try { child.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  if (ok) { console.log("✓ " + why); process.exit(0); }
  console.error("✗ " + why);
  if (detail) console.error("\n" + detail);
  process.exit(1);
}

// Identifiers a handler may call that are not page functions.
const BROWSER_GLOBALS = new Set([
  "alert", "confirm", "prompt", "fetch", "setTimeout", "setInterval", "parseInt",
  "parseFloat", "encodeURIComponent", "decodeURIComponent", "String", "Number",
  "Boolean", "Array", "Object", "JSON", "Date", "Math", "RegExp", "Error",
  "isNaN", "console", "window", "document", "location", "navigator", "event",
  "this", "return", "if", "else", "typeof", "new", "function", "void", "true",
  "false", "null", "undefined", "Promise", "localStorage", "sessionStorage",
  "URLSearchParams", "FormData", "Set", "Map", "requestAnimationFrame",
]);

function checkHtml(html) {
  const problems = [];

  // ── 1. every inline block must parse ──────────────────────────────────────
  const blocks = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/type\s*=\s*["'](?!text\/javascript|application\/javascript)/.test(m[1])) continue;
    blocks.push({ code: m[2], index: m.index });
  }
  if (blocks.length === 0) problems.push("no inline <script> blocks found — has the dashboard moved?");

  const parsed = [];
  blocks.forEach((b, i) => {
    try {
      new vm.Script(b.code, { filename: `admin-inline-${i}.js` });
      parsed.push(b.code);
    } catch (e) {
      // Point at the offending source line — the message alone ("Invalid or
      // unexpected token") does not tell you which string broke.
      const lineNo = Number((/admin-inline-\d+\.js:(\d+)/.exec(e.stack || "") || [])[1]);
      const line = lineNo ? (b.code.split("\n")[lineNo - 1] || "").trim().slice(0, 220) : "";
      problems.push(
        `inline <script> block ${i} (${b.code.length} chars) does not parse: ${e.message}` +
        (line ? `\n      at line ${lineNo}: ${line}` : "") +
        `\n      Every function declared in this block is undefined in the browser,` +
        `\n      so every button that calls one silently does nothing.` +
        `\n      Common cause: an escape that server.js's template literal ate` +
        `\n      (write \\\\' not \\' for an apostrophe inside emitted JS — or reword it).`
      );
    }
  });

  // ── 2. every inline handler must resolve ──────────────────────────────────
  const declared = new Set();
  const addAll = (src, rx, g = 1) => { let x; while ((x = rx.exec(src)) !== null) declared.add(x[g]); };
  for (const code of parsed) {
    addAll(code, /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g);
    addAll(code, /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g);
    addAll(code, /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g);
  }

  const handlerRe = /\son([a-z]+)\s*=\s*"([^"]*)"/g;
  const missing = new Map();
  let h;
  while ((h = handlerRe.exec(html)) !== null) {
    // Strip string literals first: an inline handler that sets a style carries
    // CSS functions inside quotes (rgba(...), rotate(...)) which are not calls.
    const body = h[2].replace(/'(?:\\.|[^'\\])*'/g, "''");
    const callRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(body)) !== null) {
      const name = c[2];
      if (BROWSER_GLOBALS.has(name) || declared.has(name)) continue;
      if (!missing.has(name)) missing.set(name, `on${h[1]}="${h[2].slice(0, 120)}"`);
    }
  }
  for (const [name, where] of missing) {
    problems.push(`handler calls ${name}(), which is not declared in any inline block\n      ${where}`);
  }

  return { problems, blocks: blocks.length, parsedOk: parsed.length, declared: declared.size };
}

function poll(started) {
  if (exited) return finish(false, `server exited before serving the dashboard (code ${exited.code})`);
  if (/\[uncaught\]/.test(out)) return finish(false, "server logged an uncaught exception during boot");
  if (Date.now() - started > DEADLINE_MS) {
    return finish(false, `server did not serve / on :${PORT} within ${DEADLINE_MS / 1000}s`);
  }
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 8000 }, res => {
    if (res.statusCode !== 200) {
      res.resume();
      return finish(false, `GET / returned HTTP ${res.statusCode} — expected the dashboard (200)`);
    }
    let html = "";
    res.setEncoding("utf8");
    res.on("data", d => { html += d; });
    res.on("end", () => {
      const r = checkHtml(html);
      if (r.problems.length) {
        return finish(false,
          `admin dashboard JS is broken (${r.problems.length} problem(s))`,
          r.problems.map((p, i) => `  ${i + 1}. ${p}`).join("\n"));
      }
      finish(true, `admin dashboard JS OK — ${r.blocks} inline block(s) parse, ` +
                   `${r.declared} functions declared, every on*= handler resolves`);
    });
  });
  req.on("error", () => setTimeout(() => poll(started), 500));
  req.on("timeout", () => { req.destroy(); setTimeout(() => poll(started), 500); });
}

setTimeout(() => poll(Date.now()), 500);
