/**
 * Rental Report Server — Multi-Org
 *
 * Routes:
 *   GET /:org/facility          → serves facility report UI
 *   GET /:org/gl                → serves GL rollup report UI
 *   GET /:org/historic          → serves historic reservations report UI
 *   GET /:org/programs          → serves program revenue report UI
 *   GET /:org/memberships       → serves memberships report UI
 *   GET /:org/roster            → serves class roster report UI
 *   GET /:org/admin             → serves subscription admin UI
 *   GET /:org/metrics           → serves usage metrics dashboard
 *   GET /:org/:report/api/data  → proxies Metabase card
 *   GET /:org/:report/api/pdf   → Puppeteer PDF of report
 *   POST /:org/:report/api/log  → log client-side events (excel, print)
 *   GET /:org/metrics/api/data  → usage metrics JSON
 *   POST /:org/admin/subscribe  → add/update email subscription
 *   DELETE /:org/admin/subscribe → remove subscription
 *   GET /:org/admin/subscribers → list all subscribers for org
 *   POST /:org/admin/test-send  → send a test email immediately
 */

const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const cron       = require("node-cron");
const { Resend } = require("resend");
const crypto     = require("crypto");

// Catch anything that slips through
process.on("uncaughtException", err => console.error("[uncaught]", err));
process.on("unhandledRejection", err => console.error("[unhandled]", err));

const METABASE_URL   = process.env.METABASE_URL   || "https://rec.metabaseapp.com";
const PORT           = process.env.PORT           || 3100;
const BASE_URL       = process.env.BASE_URL       || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL     = process.env.FROM_EMAIL     || "reports@rec.us";
const FROM_NAME      = process.env.FROM_NAME      || "rec.us Reports";


// ── Dashboard authentication ─────────────────────────────────────────
// Set DASHBOARD_PASSWORD in Railway env vars.
// /hotdog and /api/hotdog are public (no auth required).
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

function dashboardAuth(req, res, next) {
  // Only protect the root dashboard; all org routes and /hotdog are public
  if (req.path !== '/') return next();

  // No password configured → open access (dev/staging fallback)
  if (!DASHBOARD_PASSWORD) return next();

  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Basic ')) {
    const decoded  = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
    const password = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded;
    if (password === DASHBOARD_PASSWORD) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Rec Reports", charset="UTF-8"');
  return res.status(401).send('Password required');
}

// ── Org config ───────────────────────────────────────────────────────
const ORGS = {
  clarksville: {
    token:   "6JmoTcHxMOV3ugyO",
    orgId:   "460566d3-3a51-4387-a7a0-0b010923e40d",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-460566d3-3a51-4387-a7a0-0b010923e40d%2FfullLogo.png%3F1742511257248&w=256&q=75",
    facility: { mbUuid: "21e74d52-f49a-46d6-bc2d-f9348027854f" },
    gl:       { mbUuid: "c6daa914-9ea0-449f-956b-373aa0ac2a8a" },
    roster:   { mbUuid: "ce13ffa2-2bc5-4764-992d-957b4c3a35f9" },
    products: { mbUuid: "b9cae7d1-ea23-4dca-8854-d8689bc2b247" },
    programs: { mbUuid: "776bb123-3109-48d6-b50b-7f1fd161285f" },
  },
  norman: {
    token:   "RfuFOIz6KrFnSxBK",
    orgId:   "574923bd-9e7b-43e0-9e5f-7ce256189cbf",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-574923bd-9e7b-43e0-9e5f-7ce256189cbf%2FfullLogo.png%3F1763816879340&w=256&q=75",
    facility:    { mbUuid: "81c43b6d-1776-4a13-9fec-cb6f9e9895bb" },
    gl:          { mbUuid: "46b7e83b-f8ac-4d84-8c5c-4c72ca57cea4" },
    programs:    { mbUuid: "73af7196-84c3-4aad-959e-571c39dc23b9" },
    roster:      { mbUuid: "b4fb3c1b-b096-4865-8c32-3dc2635d1264" },
    overview:    { mbUuid: null },
    products:    { mbUuid: '3d0da465-12d7-4009-8cf1-cbf49e166bd2' },
    memberships: { mbUuid: 'c0579813-d8f0-4b0c-8248-ff975129fd31' },
  },
  smyrna: {
    token:   "PeNSGslScErlGLyY",
    orgId:   "efc0724c-8f32-481a-bab3-fc19c724f3a7",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-efc0724c-8f32-481a-bab3-fc19c724f3a7%2FfullLogo.png%3F1771265790459&w=1920&q=75",
    facility: { mbUuid: "d541c91e-bb92-4103-abc5-940b3edb61b9" },
    historic: { mbUuid: "af3c5388-7deb-4a05-a102-cc31f6c4b9f7" },
    gl:       { mbUuid: "45e050fd-10d7-4010-b616-6a2ec6e5f7ed" },
    roster:   { mbUuid: "462000f0-6be1-4e73-b983-0375668c1a1f" },
  },
  watertown: {
    token:   "7qNNXDFo4HGpOh5B",
    orgId:   "d781690b-c5a0-43c5-8443-9ae43899528c",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-d781690b-c5a0-43c5-8443-9ae43899528c%2FfullLogo.png%3F1750270261391&w=1920&q=75",
    facility: { mbUuid: "4b64af10-d57f-41af-aad8-b16d12a8f7b8" },
    gl:       { mbUuid: "e0043550-0ab8-429f-bbb0-35911c1190f6" },
    programs: { mbUuid: "d3a3554f-1232-4803-9cc7-5b0f611360b0" },
    roster:   { mbUuid: "4f9861ef-e8ac-4447-bf88-3648c1e54a8b" },
    calendar: { mbUuid: "70717c4f-9395-4c50-95ac-0622d95567f6" },
  },
  apex: {
    token:   "pcj5Qf0Wts7Wzc7P",
    orgId:   "aeba47d0-c97f-49cb-a0e9-93c5af3a68fa",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-aeba47d0-c97f-49cb-a0e9-93c5af3a68fa%2FfullLogo.png%3F1765923560125&w=1920&q=75",
    facility: { mbUuid: "c876b1d7-df79-48c5-abf5-62917dee3534", defaultDateRange: 8, defaultLocationFilter: "Apex Center" },
    programs: { mbUuid: "dee5b922-303f-47d9-abe3-75597410ad67" },
    "court-utilization": { mbUuid: "82d14a94-78ad-48d6-9531-11e72f53e285" },
    calendar: { mbUuid: "8a3dac9b-6c34-45e1-a7d0-3a177477fe17" },
  },
  theranch: {
    token:   "mXI0BgPPazLu61jl",
    orgId:   "2d147f38-068c-409e-890d-a8acc88d8079",
    displayName: "The Ranch Parks and Recreation",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-2d147f38-068c-409e-890d-a8acc88d8079%2FfullLogo.jpeg%3F1764460109546&w=2048&q=75",
    roster:  { mbUuid: "09707fab-067c-4297-98c1-3c1c39804333" },
  },
  littleton: {
    token:   "reaFHptbqztp_1YB",
    orgId:   "992ee322-4927-4558-827d-7f8768580b85",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-992ee322-4927-4558-827d-7f8768580b85%2FfullLogo.jpeg%3F1776960415666&w=1920&q=75",
    displayName: "Littleton PRCE",
    gl      : { mbUuid: "050d06f6-4c0f-4fce-a643-16352f095636" },
  },
  danvers: {
    token:   "9h_PGT17witUK73g",
    orgId:   "a6aef5df-f742-41a2-9088-1fb6d48c3cb1",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-a6aef5df-f742-41a2-9088-1fb6d48c3cb1%2FfullLogo.png%3F1748866523048&w=1920&q=75",
    displayName: "Town of Danvers",
    gl      : { mbUuid: "f82f6e95-6c18-4c57-a8dc-4fb833537f2c" },
  },
  midland: {
    token:   "2TiwFAhbgFqcnbbT",
    orgId:   "8a8a4fb1-c184-4196-a878-75c775ce6252",
    logoUrl: "https://www.midlandtexas.gov/ImageRepository/Document?documentID=10068",
    displayName: "Midland",
    gl      : { mbUuid: "e0e0d020-f22c-4a79-9cc6-760c6afb9f46" },
  },
  windham: {
    token:   "nbwKKe68jACdPOLE",
    orgId:   "1c80a358-74c2-477d-aa0b-87bb2d0514b3",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-1c80a358-74c2-477d-aa0b-87bb2d0514b3%2FfullLogo.png%3F1755282265506&w=1920&q=75",
    displayName: "Windham Parks and Recreation",
    roster  : { mbUuid: "ff78b207-c015-4bac-80a1-86213cfbad04" },
  },
  joplin: {
    token:   "mJpBoV84IRlCoXPM",
    orgId:   "ac04aa52-d629-435f-84af-0fc95e152e7b",
    logoUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSiZe2Rt3BvXmkRLhW9EzhogtTSXY3SkiaVzA&s",
    displayName: "Joplin",
    gl      : { mbUuid: "01c4658c-cf33-4511-91d8-318ea6fc6f2f" },
  },
};

const REPORT_TYPES = ["facility", "gl", "historic", "programs", "roster", "overview", "products", "memberships", "court-utilization", "calendar"];
// Report types that are valid system-wide but should NOT be offered in the
// dashboard "+ Add report" flow (e.g. not yet ready for self-serve onboarding).
const NON_ADDABLE_REPORTS = new Set(["overview"]);

// ── Dynamic orgs (added via dashboard UI) ────────────────────────────
// Loaded at startup and merged into ORGS; also updated at runtime.
// ── File storage ─────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const ORGS_FILE          = path.join(DATA_DIR, "orgs.json");
const HOTDOG_CLAIMS_FILE = path.join(DATA_DIR, "hotdog_claims.json");
const SUBS_FILE   = path.join(DATA_DIR, "subscriptions.json");
const LOG_FILE    = path.join(DATA_DIR, "send_log.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");

// Merge any dynamically-added orgs from data/orgs.json into ORGS
try {
  const dynamic = JSON.parse(fs.readFileSync(ORGS_FILE, "utf8"));
  Object.assign(ORGS, dynamic);
  console.log(`[orgs] Loaded ${Object.keys(dynamic).length} dynamic org(s) from orgs.json`);
} catch { /* no dynamic orgs yet */ }

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── GitHub push: write new orgs to server.js so they live in code ────
// When the admin dashboard adds a new org, we push the entry to
// danj707/rental-report on GitHub. Railway auto-deploys on push, so
// the org goes from "dynamic" (lives in data/orgs.json) → "in code"
// (lives in server.js) without any manual step.
//
// Requires env var GITHUB_TOKEN with a PAT that has Contents:read/write
// on the repo. Falls back to orgs.json if the push fails.
const GITHUB_REPO = "danj707/rental-report";
const GITHUB_API  = `https://api.github.com/repos/${GITHUB_REPO}/contents/server.js`;

// Serialize one ORGS map entry as JS source matching the existing style.
function buildOrgEntrySource(slug, orgEntry) {
  const lines = [`  ${slug}: {`];
  if (orgEntry.token)       lines.push(`    token:   ${JSON.stringify(orgEntry.token)},`);
  if (orgEntry.orgId)       lines.push(`    orgId:   ${JSON.stringify(orgEntry.orgId)},`);
  if (orgEntry.logoUrl)     lines.push(`    logoUrl: ${JSON.stringify(orgEntry.logoUrl)},`);
  if (orgEntry.displayName) lines.push(`    displayName: ${JSON.stringify(orgEntry.displayName)},`);
  for (const reportType of REPORT_TYPES) {
    if (orgEntry[reportType] && orgEntry[reportType].mbUuid) {
      const padded = reportType.padEnd(8);
      lines.push(`    ${padded}: { mbUuid: ${JSON.stringify(orgEntry[reportType].mbUuid)} },`);
    }
  }
  lines.push(`  },`);
  return lines.join("\n") + "\n";
}

// Fetch server.js from GitHub, insert one or more org entries before the
// ORGS map's closing `};`, and PUT the result back. Returns commit info.
async function pushOrgsToGitHub(entries, commitMessage) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured");
  if (!entries.length) throw new Error("No entries to push");

  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  // 1. Fetch current server.js + SHA
  const getRes = await fetch(GITHUB_API, { headers });
  if (!getRes.ok) throw new Error(`GitHub GET ${getRes.status}: ${await getRes.text()}`);
  const getData = await getRes.json();
  let content = Buffer.from(getData.content, "base64").toString("utf8");
  const sha = getData.sha;

  // 2. Skip entries already present in server.js
  const toInsert = entries.filter(({ slug }) => {
    const re = new RegExp(`^\\s+${slug}:\\s*\\{`, "m");
    return !re.test(content);
  });
  if (!toInsert.length) {
    return { skipped: true, reason: "All entries already in server.js" };
  }

  // 3. Build combined source and insert before ORGS closing `};`
  const insertText = toInsert.map(({ slug, orgEntry }) => buildOrgEntrySource(slug, orgEntry)).join("");
  const closeRe = /\n\};\s*\n+const REPORT_TYPES/;
  const match = content.match(closeRe);
  if (!match) throw new Error("Could not locate ORGS map closing in server.js");
  const insertPos = match.index + 1; // position of `};`
  content = content.slice(0, insertPos) + insertText + content.slice(insertPos);

  // 4. PUT back
  const putRes = await fetch(GITHUB_API, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(content).toString("base64"),
      sha,
    }),
  });
  if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}: ${await putRes.text()}`);
  const putData = await putRes.json();
  return {
    skipped: false,
    pushedSlugs: toInsert.map(e => e.slug),
    commitUrl: putData.commit.html_url,
    commitSha: putData.commit.sha,
  };
}

// ── Update an existing report's Metabase UUID (admin link editor) ─────
// Powers the password-protected "Metabase Links" section of the admin
// dashboard. Performs an anchored, single-occurrence replace of one
// report's mbUuid inside one org block, then pushes to GitHub (Railway
// auto-redeploys). The running instance's ORGS map is also updated.
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pull a UUID from a full Metabase public URL, a bare UUID, or a messy paste.
function extractMbUuidFromInput(input) {
  if (!input) return null;
  const m = String(input).trim().toLowerCase()
    .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  return m ? m[0] : null;
}

// Anchored, single-occurrence replace of one report's mbUuid in source text.
// Returns { content, oldUuid }. Throws on any ambiguity (org/report missing).
function patchReportUuid(content, slug, reportType, newUuid) {
  if (!STRICT_UUID.test(newUuid)) throw new Error("Invalid UUID format");
  // Isolate the org block: from "\n  <slug>: {" to its closing "\n  },".
  const blockRe = new RegExp(`\\n  ${escapeRegExp(slug)}:\\s*\\{[\\s\\S]*?\\n  \\},`);
  const bm = content.match(blockRe);
  if (!bm) throw new Error(`Org "${slug}" not found in server.js`);
  const block = bm[0];
  // Match the report key (bare or quoted) up to its mbUuid value (uuid|null).
  const keyPat = `(?:"${escapeRegExp(reportType)}"|${escapeRegExp(reportType)})`;
  const reportRe = new RegExp(`(${keyPat}\\s*:\\s*\\{[^{}]*?mbUuid:\\s*)("?)(?:[0-9a-f-]{36}|null)("?)`);
  const rm = block.match(reportRe);
  if (!rm) throw new Error(`Report "${reportType}" not found in "${slug}"`);
  const oldUuid = (rm[0].match(/mbUuid:\s*"?([0-9a-f-]{36}|null)/) || [])[1] || null;
  const newBlock = block.replace(reportRe, `$1"${newUuid}"`);
  if (newBlock === block) throw new Error("No change made (UUID may already be set)");
  // Function replacement avoids `$` interpretation in the replacement string.
  const newContent = content.replace(block, () => newBlock);
  return { content: newContent, oldUuid };
}

// GET server.js (+sha) from GitHub, patch one report's uuid, PUT it back.
async function updateReportUuidOnGitHub(slug, reportType, newUuid, commitMessage) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured");
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };
  const getRes = await fetch(GITHUB_API, { headers });
  if (!getRes.ok) throw new Error(`GitHub GET ${getRes.status}: ${await getRes.text()}`);
  const getData = await getRes.json();
  const content = Buffer.from(getData.content, "base64").toString("utf8");
  const sha = getData.sha;

  const { content: patched, oldUuid } = patchReportUuid(content, slug, reportType, newUuid);
  if (patched === content) throw new Error("Patch produced no change");

  const putRes = await fetch(GITHUB_API, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(patched).toString("base64"),
      sha,
    }),
  });
  if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}: ${await putRes.text()}`);
  const putData = await putRes.json();
  return { oldUuid, commitUrl: putData.commit.html_url, commitSha: putData.commit.sha };
}

// Insert-or-replace one report's mbUuid inside an org block. Unlike
// patchReportUuid (which requires the report to already exist), this also
// handles adding a report line that isn't there yet, or replacing a null
// placeholder. Returns { content, mode: "inserted"|"replaced", oldUuid }.
function setReportUuidInSource(content, slug, reportType, newUuid) {
  if (!STRICT_UUID.test(newUuid)) throw new Error("Invalid UUID format");
  const blockRe = new RegExp(`\\n  ${escapeRegExp(slug)}:\\s*\\{[\\s\\S]*?\\n  \\},`);
  const bm = content.match(blockRe);
  if (!bm) throw new Error(`Org "${slug}" not found in server.js`);
  const block = bm[0];

  const keyPat = `(?:"${escapeRegExp(reportType)}"|${escapeRegExp(reportType)})`;
  const reportRe = new RegExp(`(${keyPat}\\s*:\\s*\\{[^{}]*?mbUuid:\\s*)("?)(?:[0-9a-f-]{36}|null)("?)`);
  const rm = block.match(reportRe);

  let newBlock, mode, oldUuid = null;
  if (rm) {
    // Report key already present (possibly a null placeholder) — replace it.
    oldUuid = (rm[0].match(/mbUuid:\s*"?([0-9a-f-]{36}|null)/) || [])[1] || null;
    if (oldUuid === newUuid) throw new Error("No change made (UUID already set)");
    newBlock = block.replace(reportRe, `$1"${newUuid}"`);
    mode = "replaced";
  } else {
    // Report key absent — insert a new line before the block's closing "},".
    const keyToken = /^[a-z]+$/.test(reportType) ? reportType.padEnd(8) : `"${reportType}"`;
    const line = `    ${keyToken}: { mbUuid: ${JSON.stringify(newUuid)} },`;
    newBlock = block.replace(/\n  \},$/, `\n${line}\n  },`);
    mode = "inserted";
  }
  if (newBlock === block) throw new Error("Patch produced no change");
  const newContent = content.replace(block, () => newBlock);
  return { content: newContent, mode, oldUuid };
}

// GET server.js (+sha), insert-or-replace one report's uuid, PUT it back.
async function addReportUuidOnGitHub(slug, reportType, newUuid, commitMessage) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured");
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };
  const getRes = await fetch(GITHUB_API, { headers });
  if (!getRes.ok) throw new Error(`GitHub GET ${getRes.status}: ${await getRes.text()}`);
  const getData = await getRes.json();
  const content = Buffer.from(getData.content, "base64").toString("utf8");
  const sha = getData.sha;

  const { content: patched, mode, oldUuid } = setReportUuidInSource(content, slug, reportType, newUuid);
  if (patched === content) throw new Error("Patch produced no change");

  const putRes = await fetch(GITHUB_API, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(patched).toString("base64"),
      sha,
    }),
  });
  if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}: ${await putRes.text()}`);
  const putData = await putRes.json();
  return { mode, oldUuid, commitUrl: putData.commit.html_url, commitSha: putData.commit.sha };
}

// Validate the dashboard password from a POST body. Returns true if it already
// ended the response (caller should `return`), false to proceed.
function dashboardPasswordBlocked(req, res) {
  if (!DASHBOARD_PASSWORD) {
    res.status(503).json({ error: "Set DASHBOARD_PASSWORD in Railway to enable link editing" });
    return true;
  }
  if ((req.body && req.body.password) !== DASHBOARD_PASSWORD) {
    res.status(401).json({ error: "Incorrect password" });
    return true;
  }
  return false;
}

// Promote any dynamic orgs (from data/orgs.json) into server.js on startup.
// After a successful push, clear the migrated entries from orgs.json so the
// new server.js becomes the source of truth (after Railway redeploys).
async function migrateDynamicOrgs() {
  if (!process.env.GITHUB_TOKEN) return;
  let dynamic;
  try { dynamic = JSON.parse(fs.readFileSync(ORGS_FILE, "utf8")); }
  catch { return; }
  const slugs = Object.keys(dynamic || {});
  if (!slugs.length) return;

  const entries = slugs.map(slug => ({ slug, orgEntry: dynamic[slug] }));
  try {
    const result = await pushOrgsToGitHub(
      entries,
      `Migrate dynamic orgs to server.js (${slugs.join(", ")})`,
    );
    if (result.skipped) {
      console.log(`[migrate] All dynamic orgs already in server.js; clearing orgs.json`);
      writeJSON(ORGS_FILE, {});
      return;
    }
    console.log(`[migrate] Pushed ${result.pushedSlugs.length} org(s) to GitHub: ${result.commitUrl}`);
    // Clear migrated entries from orgs.json (others stay for retry)
    const remaining = { ...dynamic };
    result.pushedSlugs.forEach(slug => delete remaining[slug]);
    writeJSON(ORGS_FILE, remaining);
    console.log(`[migrate] Cleared ${result.pushedSlugs.length} org(s) from orgs.json`);
  } catch (err) {
    console.error(`[migrate] Failed:`, err.message);
  }
}

// ── Analytics: append-only JSONL, no extra dependencies ─────────────
// Schema: { ts, org, report, event, ip }
// event values: "view" | "fetch" | "pdf" | "excel" | "print"
function logEvent(org, report, event, ip, extra) {
  try {
    const rec = {
      ts:     new Date().toISOString(),
      org,
      report,
      event,
      ip:     ip || null,
    };
    if (extra && typeof extra === "object") Object.assign(rec, extra);
    const line = JSON.stringify(rec) + "\n";
    fs.appendFileSync(EVENTS_FILE, line);
  } catch (err) {
    console.warn("[analytics] Failed to log event:", err.message);
  }
}

// Read events file, optionally filtered to last N days
function readEvents(daysBack) {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, "utf8");
    const cutoff = daysBack
      ? new Date(Date.now() - daysBack * 86400000).toISOString()
      : null;
    return raw.trim().split("\n")
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(e => e && (!cutoff || e.ts >= cutoff));
  } catch {
    return [];
  }
}

// Aggregate events into metrics for one org
function buildMetrics(org, daysBack) {
  const events = readEvents(daysBack).filter(e => e.org === org);

  // Summary: { report: { view, fetch, pdf, excel, print } }
  const summary = {};
  events.forEach(e => {
    if (!summary[e.report]) summary[e.report] = { view: 0, fetch: 0, pdf: 0, excel: 0, print: 0 };
    summary[e.report][e.event] = (summary[e.report][e.event] || 0) + 1;
  });

  // Daily view counts for sparklines: { "YYYY-MM-DD": { report: count } }
  const daily = {};
  events.filter(e => e.event === "view").forEach(e => {
    const day = e.ts.substring(0, 10);
    if (!daily[day]) daily[day] = {};
    daily[day][e.report] = (daily[day][e.report] || 0) + 1;
  });

  // Subscription counts per report + cadence breakdown
  const allSubs = readJSON(SUBS_FILE, []).filter(s => s.org === org && s.active);
  const subCounts = {};
  const subByCadence = { daily: 0, weekly: 0, monthly: 0 };
  allSubs.forEach(s => {
    const rpts = Array.isArray(s.reports) ? s.reports : JSON.parse(s.reports);
    rpts.forEach(r => { subCounts[r] = (subCounts[r] || 0) + 1; });
    if (subByCadence[s.schedule] !== undefined) subByCadence[s.schedule]++;
  });

  // AI insights usage + cost (from events that carry token/cost fields)
  const insights = { calls: 0, inTok: 0, outTok: 0, costUsd: 0 };
  events.filter(e => e.event === "insights").forEach(e => {
    insights.calls  += 1;
    insights.inTok  += e.inTok   || 0;
    insights.outTok += e.outTok  || 0;
    insights.costUsd += e.costUsd || 0;
  });

  const configuredReports = REPORT_TYPES.filter(r => ORGS[org]?.[r]?.mbUuid);
  return { summary, daily, subCounts, subByCadence, totalSubscribers: allSubs.length, insights, configuredReports };
}

// ── Subscriptions DB helpers ─────────────────────────────────────────
const db = {
  getSubscriptions(org) {
    return readJSON(SUBS_FILE, []).filter(s => s.org === org && s.active);
  },
  getAllBySchedule(schedule) {
    return readJSON(SUBS_FILE, []).filter(s => s.active && s.schedule === schedule);
  },
  upsertSubscription(org, email, reports, schedule, locationFilter, dateRange, reportParams) {
    const subs = readJSON(SUBS_FILE, []);
    const now  = new Date().toISOString();
    const params = (reportParams && typeof reportParams === "object" && !Array.isArray(reportParams)) ? reportParams : {};
    const sortedReports = [...reports].sort();
    const paramsKey = JSON.stringify(params);
    // Composite dedup: only treat a row as a match if reports, schedule, AND saved params line up.
    // Lets one email have a "general" digest AND any number of saved-view subscriptions.
    const idx = subs.findIndex(s => {
      if (s.org !== org || s.email !== email || s.schedule !== schedule) return false;
      const sr = Array.isArray(s.reports) ? s.reports : (() => { try { return JSON.parse(s.reports); } catch { return []; } })();
      if (JSON.stringify([...sr].sort()) !== JSON.stringify(sortedReports)) return false;
      const sp = (s.reportParams && typeof s.reportParams === "object") ? s.reportParams : {};
      return JSON.stringify(sp) === paramsKey;
    });
    if (idx >= 0) {
      subs[idx] = { ...subs[idx], reports, schedule, locationFilter: locationFilter || null, dateRange: dateRange || null, reportParams: params, active: 1, updated_at: now };
    } else {
      subs.push({ id: Date.now() + Math.floor(Math.random() * 1000), org, email, reports, schedule, locationFilter: locationFilter || null, dateRange: dateRange || null, reportParams: params, active: 1, created_at: now, updated_at: now });
    }
    writeJSON(SUBS_FILE, subs);
  },
  deleteSubscription(org, email, id) {
    // If id is provided, delete only that specific row; otherwise delete all rows for (org, email).
    const subs = readJSON(SUBS_FILE, []);
    const filtered = id
      ? subs.filter(s => !(s.org === org && s.email === email && String(s.id) === String(id)))
      : subs.filter(s => !(s.org === org && s.email === email));
    writeJSON(SUBS_FILE, filtered);
  },
  appendLog(org, email, report, schedule, status, message) {
    const log = readJSON(LOG_FILE, []);
    log.unshift({ id: Date.now(), org, email, report, schedule, status, message: message || null, sent_at: new Date().toISOString() });
    writeJSON(LOG_FILE, log.slice(0, 200));
  },
  getLog(org) {
    return readJSON(LOG_FILE, []).filter(l => l.org === org).slice(0, 50);
  },
};

// ── Resend client ─────────────────────────────────────────────────────
function getResendClient() {
  if (!RESEND_API_KEY) {
    console.warn("[mail] No RESEND_API_KEY configured — emails will be logged but not sent");
    return null;
  }
  return new Resend(RESEND_API_KEY);
}

// ── Date helpers ─────────────────────────────────────────────────────
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function getDateRange(dateRange) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  if (dateRange === "today") {
    return { start: toISO(now), end: toISO(now), label: `Today — ${toISO(now)}` };
  }
  if (dateRange === "next7") {
    const end = new Date(now); end.setDate(end.getDate() + 6);
    return { start: toISO(now), end: toISO(end), label: `${toISO(now)} to ${toISO(end)}` };
  }
  if (dateRange === "next30") {
    const end = new Date(now); end.setDate(end.getDate() + 29);
    return { start: toISO(now), end: toISO(end), label: `${toISO(now)} to ${toISO(end)}` };
  }
  if (dateRange === "last7") {
    const start = new Date(now); start.setDate(start.getDate() - 7);
    const end   = new Date(now); end.setDate(end.getDate() - 1);
    return { start: toISO(start), end: toISO(end), label: `${toISO(start)} to ${toISO(end)}` };
  }
  // lastMonth (default for GL)
  const start = new Date(y, m - 1, 1);
  const end   = new Date(y, m, 0);
  return { start: toISO(start), end: toISO(end), label: start.toLocaleString("default",{month:"long",year:"numeric"}) };
}

// ── PDF generation ───────────────────────────────────────────────────
async function generatePdf(orgSlug, reportType, startDate, endDate, filters = {}) {
  const puppeteer = require("puppeteer");
  const orgTok = ORGS[orgSlug]?.token || "";
  const qsObj = { start_date: startDate, end_date: endDate, _print: "1" };
  // Forward client-side filter selections so the PDF matches the on-screen
  // filtered view. `locations`/`sites` are comma-separated selections from the
  // interactive filter dropdowns; `location_name`/`site_type` are legacy
  // server-side Metabase filters. The print page initializes its filter state
  // from these params before emitting #report-ready, so Puppeteer captures the
  // filtered render rather than the full dataset.
  ["locations", "sites", "location_name", "site_type", "desks", "by_desk", "by_item", "hide_zero", "chart_net", "metric", "programs", "closures", "hrs", "section_name", "status", "questions", "cols", "search"].forEach(k => {
    if (filters[k]) qsObj[k] = filters[k];
  });
  if (orgTok) qsObj.token = orgTok;
  const qs = new URLSearchParams(qsObj);
  const url = `http://localhost:${PORT}/${orgSlug}/${reportType}?${qs}`;
  console.log(`[pdf] Generating for ${orgSlug}/${reportType}: ${url}`);

  const reportLabel = reportType === "gl"
    ? "GL Code Rollup"
    : reportType === "historic"
      ? "Facility Reservations by Date"
      : reportType === "programs"
        ? "Program Revenue"
        : reportType === "roster"
          ? "Class Roster"
          : "Facility Rental Schedule";

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    const isGL = reportType === "gl";
    // GL table is very wide — render at 1600px so layout is natural, then scale to fit Letter landscape.
    if (isGL) {
      await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });
    }
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector("#report-ready", { timeout: 30000 });
    return await page.pdf({
      format: "Letter",
      landscape: true,
      printBackground: true,
      scale: isGL ? 0.6 : 1.0,
      margin: { top: "0.4in", bottom: "0.5in", left: "0.4in", right: "0.4in" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `
        <div style="font-size:9px;width:100%;padding:0 0.4in;display:flex;justify-content:space-between;color:#888;font-family:sans-serif;">
          <span>rec.us — ${reportLabel}</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
    });
  } finally {
    await browser.close();
  }
}

// ── Send report email ────────────────────────────────────────────────
async function sendReportEmail(orgSlug, email, reportType, schedule, locationFilter, dateRange, savedParams) {
  const orgConfig = ORGS[orgSlug];
  const reportLabel = reportType === "gl"
    ? "GL Code Rollup"
    : reportType === "historic"
      ? "Historic Buildings Schedule"
      : reportType === "programs"
        ? "Program Revenue"
        : reportType === "roster"
          ? "Class Roster"
          : reportType === "products"
            ? "Product Sales"
            : reportType === "memberships"
              ? "Memberships"
              : "Facility Rental Schedule";

  // Build the URL. If a saved view was captured, use those params verbatim
  // (after stripping token/_print which we re-add). Otherwise fall back to the
  // legacy cadence-preset behavior.
  let reportUrl;
  let label;
  let viewSuffix = "";
  const tokenParam = orgConfig.token ? `&token=${encodeURIComponent(orgConfig.token)}` : "";
  if (savedParams && typeof savedParams === "string" && savedParams.length) {
    const cleaned = new URLSearchParams(savedParams);
    cleaned.delete("token");
    cleaned.delete("_print");
    if (orgConfig.token) cleaned.set("token", orgConfig.token);
    const qs = cleaned.toString();
    reportUrl = `${BASE_URL}/${orgSlug}/${reportType}${qs ? `?${qs}` : ""}`;
    const sd = cleaned.get("start_date");
    const ed = cleaned.get("end_date");
    if (sd && ed) {
      label = (sd === ed) ? sd : `${sd} to ${ed}`;
    } else {
      label = "Saved view";
    }
    // Count non-date/token filter params for a tiny indicator in the email
    const filterCount = [...cleaned.keys()].filter(k => !["start_date","end_date","token"].includes(k)).length;
    if (filterCount > 0) viewSuffix = ` (${filterCount} filter${filterCount === 1 ? "" : "s"})`;
  } else {
    const resolvedDateRange = dateRange || (reportType === "gl" ? "lastMonth" : "next7");
    const r = getDateRange(resolvedDateRange);
    label = r.label;
    const locationParam = (reportType === "facility" && locationFilter) ? `&location_name=${encodeURIComponent(locationFilter)}` : "";
    reportUrl = `${BASE_URL}/${orgSlug}/${reportType}?start_date=${r.start}&end_date=${r.end}${locationParam}${tokenParam}`;
  }

  const resend = getResendClient();
  if (!resend) {
    console.log(`[mail] STUB — would send "${reportLabel}" (${label}) to ${email}`);
    db.appendLog(orgSlug, email, reportType, schedule, "sent", "RESEND_API_KEY not configured — stub send");
    return { ok: true, stub: true };
  }

  let status, message;
  try {
    const { error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: email,
      subject: `${reportLabel} — ${label}${viewSuffix}`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px 24px">
          <img src="${orgConfig.logoUrl}" style="height:40px;margin-bottom:20px;display:block" />
          <h2 style="margin:0 0 6px;font-size:20px;color:#111">${reportLabel}</h2>
          <p style="color:#888;margin:0 0 24px;font-size:14px">${label}</p>
          <p style="color:#333;margin:0 0 24px;font-size:14px;line-height:1.5">
            Your scheduled report is ready. Click below to open it — the date range is pre-loaded.
          </p>
          <a href="${reportUrl}"
             style="display:inline-block;background:#16a34a;color:#fff;padding:12px 22px;border-radius:5px;text-decoration:none;font-weight:600;font-size:14px">
            View ${reportLabel} →
          </a>
          <p style="margin-top:16px;font-size:12px;color:#aaa">
            Or copy this link:<br>
            <a href="${reportUrl}" style="color:#3b82f6;word-break:break-all">${reportUrl}</a>
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:32px 0" />
          <p style="font-size:11px;color:#bbb;margin:0">
            You're receiving this because you subscribed at
            <a href="${BASE_URL}/${orgSlug}/admin${tokenParam ? `?${tokenParam.slice(1)}` : ""}" style="color:#bbb">${BASE_URL}/${orgSlug}/admin</a>.<br>
            To unsubscribe, visit that page and remove your email.
          </p>
        </div>`,
    });
    if (error) throw new Error(error.message);
    status = "sent"; message = null;
    console.log(`[mail] Sent "${reportLabel}" (${label}) to ${email}`);
  } catch (err) {
    status = "error"; message = err.message;
    console.error(`[mail] Failed to send to ${email}: ${err.message}`);
  }

  db.appendLog(orgSlug, email, reportType, schedule, status, message);
  return { ok: status === "sent", error: message };
}

// ── Run scheduled sends ──────────────────────────────────────────────
async function runSchedule(scheduleType) {
  console.log(`[cron] Running ${scheduleType} sends...`);
  const subs = db.getAllBySchedule(scheduleType);
  for (const sub of subs) {
    const reports = Array.isArray(sub.reports) ? sub.reports : JSON.parse(sub.reports);
    for (const report of reports) {
      const savedParams = (sub.reportParams && typeof sub.reportParams === "object") ? (sub.reportParams[report] || null) : null;
      await sendReportEmail(sub.org, sub.email, report, scheduleType, sub.locationFilter, sub.dateRange, savedParams);
    }
  }
  console.log(`[cron] ${scheduleType} sends complete — ${subs.length} subscribers`);
}

// ── Cron jobs ────────────────────────────────────────────────────────
cron.schedule("0 7 * * *", () => runSchedule("daily"));
cron.schedule("0 7 * * 1", () => runSchedule("weekly"));
cron.schedule("0 7 1 * *", () => runSchedule("monthly"));

// ── Express setup ────────────────────────────────────────────────────
const app = express();
app.use(dashboardAuth);
app.use(express.json());

// ── Token gate: every `/:org/*` route requires `?token=` matching ORGS[org].token ──
// Returns generic 404 on mismatch (no enumeration). Non-org paths fall through.
// Whitelist: `/`, `/api/*` (admin), `/metrics*` (cross-org), `/hotdog*`, static files.
app.use((req, res, next) => {
  // Skip whitelisted paths
  if (req.path === "/" || req.path === "" ) return next();
  if (req.path.startsWith("/api/")) return next();   // /api/admin/* etc.
  if (req.path === "/metrics" || req.path.startsWith("/metrics/")) return next();
  if (req.path === "/hotdog" || req.path.startsWith("/hotdog")) return next();

  // Extract first path segment
  const seg = req.path.split("/").filter(Boolean)[0];
  if (!seg) return next();
  const org = ORGS[seg];
  if (!org) return next();                          // not an org slug — let routing handle (will 404 normally)

  // Calendar is public — no token required
  const segs = req.path.split("/").filter(Boolean);
  if (segs[1] === "calendar") return next();

  if (!org.token) {                                 // fail closed: tokenless org must not be public
    return res.status(404).type("text/plain").send("Not found");
  }

  const supplied = req.query.token || "";
  if (supplied !== org.token) {
    // Generic 404 — do not leak existence of the org
    return res.status(404).type("text/plain").send("Not found");
  }
  next();
});


// ── Parse dates flexibly ─────────────────────────────────────────────
function parseToISO(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${day}`;
  }
  console.warn(`[date] Could not parse "${dateStr}", passing through raw`);
  return s;
}

// ── Build Metabase parameters array ─────────────────────────────────
function buildMetabaseParams(query, reportType) {
  const params = [];
  if (query.start_date) {
    params.push({ type: "date/single", target: ["variable", ["template-tag", "start_date"]], value: parseToISO(query.start_date) });
  }
  if (query.end_date) {
    params.push({ type: "date/single", target: ["variable", ["template-tag", "end_date"]], value: parseToISO(query.end_date) });
  }
  if (reportType === "facility" || reportType === "historic") {
    if (query.location_name) {
      const locations = query.location_name.split(",").map(s => s.trim());
      params.push({ type: "category", target: ["variable", ["template-tag", "location_name"]], value: locations.length === 1 ? locations[0] : locations });
    }
    if (query.site_type) {
      params.push({ type: "category", target: ["variable", ["template-tag", "site_type"]], value: query.site_type });
    }
  }
  // NOTE: roster section filtering is client-side (substring match in the page),
  // not a Metabase template tag. Passing section_name here would make Metabase
  // reject the query (unknown parameter), so it is intentionally not forwarded.
  return params;
}

// ── Middleware: validate org + report ────────────────────────────────
function resolveOrg(req, res, next) {
  const { org, report } = req.params;
  if (!ORGS[org]) return res.status(404).send(`Unknown org: "${org}"`);
  if (report && !REPORT_TYPES.includes(report)) return res.status(404).send(`Unknown report: "${report}"`);
  req.orgConfig = ORGS[org];
  req.orgSlug = org;
  req.reportType = report;
  next();
}

// ── GET /:org/metrics/api/data — usage metrics JSON ──────────────────
app.get("/:org/metrics/api/data", (req, res) => {
  const { org } = req.params;
  if (!ORGS[org]) return res.status(404).json({ error: "Unknown org" });
  const days = parseInt(req.query.days) || 30;
  res.json(buildMetrics(org, days));
});

// ── GET /metrics/api/data — cross-org summary ────────────────────────
app.get("/metrics/api/data", (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const result = {};
  Object.keys(ORGS).forEach(org => {
    result[org] = buildMetrics(org, days);
  });
  res.json(result);
});

// ── POST /:org/:report/api/log — log client-side events ──────────────
// Called by report HTML pages for events the server can't see:
// excel (SheetJS export) and print (window.print())
app.post("/:org/:report/api/log", resolveOrg, (req, res) => {
  const { orgSlug, reportType } = req;
  const { event } = req.query;
  const ALLOWED = ["excel", "print"];
  if (!ALLOWED.includes(event)) return res.status(400).json({ ok: false, error: "Unknown event" });
  logEvent(orgSlug, reportType, event, req.ip);
  res.json({ ok: true });
});


// ── POST /:org/:report/api/share — email a report link ───────────────
app.post("/:org/:report/api/share", resolveOrg, async (req, res) => {
  const { orgSlug, reportType } = req;
  const { email, url, dateLabel } = req.body;

  if (!email || !url) return res.status(400).json({ ok: false, error: "Missing email or url" });

  const orgConfig = ORGS[orgSlug];
  if (!orgConfig) return res.status(404).json({ ok: false, error: "Unknown org" });

  const reportLabel = reportType === "gl"
    ? "GL Code Rollup"
    : reportType === "historic"
      ? "Historic Buildings Schedule"
      : reportType === "programs"
        ? "Program Revenue"
        : "Facility Rental Schedule";

  const resend = getResendClient();
  if (!resend) {
    console.log(`[share] STUB — would share ${reportLabel} (${orgSlug}) to ${email}: ${url}`);
    return res.json({ ok: true, stub: true });
  }

  try {
    const { error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: email,
      subject: `${reportLabel}${dateLabel ? " — " + dateLabel : ""}`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px 24px">
          ${orgConfig.logoUrl ? `<img src="${orgConfig.logoUrl}" style="height:40px;margin-bottom:20px;display:block" />` : ""}
          <h2 style="margin:0 0 6px;font-size:20px;color:#111">${reportLabel}</h2>
          ${dateLabel ? `<p style="color:#888;margin:0 0 24px;font-size:14px">${dateLabel}</p>` : ""}
          <p style="color:#333;margin:0 0 24px;font-size:14px;line-height:1.5">
            A report has been shared with you. Click below to open it — your current filters and date range are pre-loaded.
          </p>
          <a href="${url}"
             style="display:inline-block;background:#16a34a;color:#fff;padding:12px 22px;border-radius:5px;text-decoration:none;font-weight:600;font-size:14px">
            View ${reportLabel} →
          </a>
          <p style="margin-top:16px;font-size:12px;color:#aaa">
            Or copy this link:<br>
            <a href="${url}" style="color:#3b82f6;word-break:break-all">${url}</a>
          </p>
        </div>`,
    });
    if (error) throw new Error(error.message);
    console.log(`[share] Sent ${reportLabel} link to ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[share] Failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /:org/:report/api/insights — AI insights via Claude ─────────
const INSIGHTS_MODEL = process.env.INSIGHTS_MODEL || "claude-haiku-4-5";

// USD per 1M tokens. Used to estimate AI-insights spend for the metrics page.
const MODEL_PRICING = {
  "claude-haiku-4-5":  { in: 1.0,  out: 5.0  },
  "claude-sonnet-4-6": { in: 3.0,  out: 15.0 },
  "claude-opus-4-7":   { in: 5.0,  out: 25.0 },
};
function insightsCostUsd(model, inTok, outTok) {
  const envIn  = parseFloat(process.env.INSIGHTS_PRICE_IN);
  const envOut = parseFloat(process.env.INSIGHTS_PRICE_OUT);
  const p = MODEL_PRICING[model] || { in: 1.0, out: 5.0 };
  const priceIn  = Number.isFinite(envIn)  ? envIn  : p.in;
  const priceOut = Number.isFinite(envOut) ? envOut : p.out;
  return (inTok / 1e6) * priceIn + (outTok / 1e6) * priceOut;
}

const INSIGHTS_SYS_PROMPT = `You are a facilities operations analyst for US municipal parks & recreation departments. You are given aggregate court-utilization statistics for a single reporting period (counts, percentages, and hours — already computed for you; never recompute or do arithmetic the data doesn't support).

Return EXACTLY 4 insights as a JSON array and nothing else — no prose, no preamble, no markdown code fences. Each element is an object with exactly these keys:
{
  "type": "opportunity" | "risk" | "signal",
  "title": short label, 7 words or fewer,
  "detail": one sentence, 22 words or fewer, citing specific numbers, courts, or locations drawn from the data,
  "action": one concrete next step, 12 words or fewer
}

Rules:
- Ground EVERY figure in the data provided. Never invent numbers, courts, or locations.
- NEVER mention revenue, dollars, money, pricing, or fees — that data is not present and is out of scope.
- Prefer non-obvious observations. Name specific courts and locations rather than speaking generally.
- Be terse. No filler. Vary the "type" across the four insights where the data supports it.`;

const PROGRAMS_SYS_PROMPT = `You are a parks & recreation program analyst for US municipal departments. You are given aggregate program revenue and enrollment data for a single reporting period — revenue totals, enrollment counts, fill percentages, cancellation rates, and waitlist counts, all pre-computed.

Return EXACTLY 4 insights as a JSON array and nothing else — no prose, no preamble, no markdown code fences. Each element is an object with exactly these keys:
{
  "type": "opportunity" | "risk" | "signal",
  "title": short label, 7 words or fewer,
  "detail": one sentence, 22 words or fewer, citing specific numbers or program names from the data,
  "action": one concrete next step, 12 words or fewer
}

Rules:
- Ground EVERY figure in the data provided. Never invent numbers or program names.
- Focus on fill rates, cancellation patterns, revenue concentration, enrollment demand (waitlists), and program-level outliers.
- Name specific programs when making observations rather than speaking generally.
- Be terse. No filler. Vary the "type" across the four insights where the data supports it.`;

const SYS_PROMPTS = { programs: PROGRAMS_SYS_PROMPT };

// Extract up to 4 valid insight objects from a model text response.
function salvageInsights(text) {
  if (!text) return [];
  let s = String(text).trim();
  // strip ```json ... ``` or ``` ... ``` fences
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // fast path: whole thing parses
  try {
    const whole = JSON.parse(s);
    const arr = Array.isArray(whole) ? whole : (Array.isArray(whole?.insights) ? whole.insights : null);
    if (arr) return arr.filter(o => o && o.type && o.title).slice(0, 4);
  } catch (_) { /* fall through to brace salvage */ }

  // salvage: brace-count balanced top-level {...} objects
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const chunk = s.slice(start, i + 1);
        try {
          const obj = JSON.parse(chunk);
          if (obj && obj.type && obj.title) out.push(obj);
        } catch (_) { /* skip malformed chunk */ }
        start = -1;
        if (out.length >= 4) break;
      }
    }
  }
  return out.slice(0, 4);
}

// tiny in-memory cache: sha256(org+report+blob) → { ts, insights }
const _insightsCache = new Map();
const INSIGHTS_TTL_MS = 10 * 60 * 1000;
const INSIGHTS_CACHE_MAX = 200;

app.post("/:org/:report/api/insights", resolveOrg, async (req, res) => {
  const { orgSlug, reportType } = req;
  const blob = req.body;

  if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
    return res.status(400).json({ ok: false, error: "Missing or invalid stats payload" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: "AI insights not configured" });
  }

  const key = crypto.createHash("sha256")
    .update(orgSlug + "|" + reportType + "|" + JSON.stringify(blob))
    .digest("hex");

  const hit = _insightsCache.get(key);
  if (hit && Date.now() - hit.ts < INSIGHTS_TTL_MS) {
    return res.json({ ok: true, insights: hit.insights, cached: true });
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: INSIGHTS_MODEL,
        max_tokens: 700,
        system: SYS_PROMPTS[reportType] || INSIGHTS_SYS_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(blob) }],
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error(`[insights] Anthropic ${resp.status}: ${errBody}`);
      return res.status(502).json({ ok: false, error: "Upstream AI request failed" });
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");

    const insights = salvageInsights(text);
    if (!insights.length) {
      console.error(`[insights] Could not parse insights from model output: ${text.slice(0, 300)}`);
      return res.status(502).json({ ok: false, error: "Could not parse AI response" });
    }

    if (_insightsCache.size >= INSIGHTS_CACHE_MAX) {
      const oldest = _insightsCache.keys().next().value;
      _insightsCache.delete(oldest);
    }
    _insightsCache.set(key, { ts: Date.now(), insights });

    const usage  = data.usage || {};
    const inTok  = usage.input_tokens  || 0;
    const outTok = usage.output_tokens || 0;
    const costUsd = insightsCostUsd(INSIGHTS_MODEL, inTok, outTok);
    logEvent(orgSlug, reportType, "insights", req.ip, { inTok, outTok, costUsd });
    res.json({ ok: true, insights, cached: false });
  } catch (err) {
    console.error("[insights] Error:", err);
    res.status(502).json({ ok: false, error: "Upstream AI request failed" });
  }
});

// ── GET /:org/:report/api/data — proxy to Metabase ───────────────────
app.get("/:org/:report/api/data", resolveOrg, async (req, res) => {
  try {
    const { orgConfig, orgSlug, reportType } = req;
    const mbUuid = orgConfig[reportType]?.mbUuid;
    if (!mbUuid) return res.status(404).json({ error: `No Metabase question configured for ${orgSlug}/${reportType}` });

    logEvent(orgSlug, reportType, "fetch", req.ip);

    const params = buildMetabaseParams(req.query, reportType);
    const paramStr = params.length > 0 ? `?parameters=${encodeURIComponent(JSON.stringify(params))}` : "";
    const url = `${METABASE_URL}/api/public/card/${mbUuid}/query/json${paramStr}`;
    console.log(`[proxy] ${orgSlug}/${reportType} → ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      console.error(`[proxy] Metabase returned ${response.status}: ${body}`);
      return res.status(response.status).json({ error: body });
    }

    const data = await response.json();

    // Calendar is a public view — defensively strip any PII columns the
    // Metabase question might surface before returning rows to the browser.
    if (reportType === "calendar" && Array.isArray(data)) {
      const PII = new Set(["reservee","reservee name","customer","customer name","booked by","booker","contact","contact name","notes","note","address","first name","last name","name"]);
      const isPII = (k) => { const t = String(k).toLowerCase().trim(); return PII.has(t) || t.includes("email") || t.includes("phone"); };
      for (const row of data) {
        if (row && typeof row === "object" && !Array.isArray(row)) {
          for (const k of Object.keys(row)) { if (isPII(k)) delete row[k]; }
        }
      }
    }

    res.json({
      rows: data,
      meta: {
        org_slug: orgSlug,
        logo_url: orgConfig.logoUrl,
        report_type: reportType,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[proxy] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /:org/:report/api/pdf — Puppeteer PDF ────────────────────────
app.get("/:org/:report/api/pdf", resolveOrg, async (req, res) => {
  try {
    const { orgSlug, reportType } = req;
    logEvent(orgSlug, reportType, "pdf", req.ip);
    const pdf = await generatePdf(orgSlug, reportType, req.query.start_date, req.query.end_date, req.query);
    const filename = `${reportType}-report-${req.query.start_date || "report"}.pdf`;
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${filename}"`, "Content-Length": pdf.length });
    res.send(pdf);
  } catch (err) {
    console.error("[pdf] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Subscription API ─────────────────────────────────────────────────
app.get("/:org/admin/reports", (req, res) => {
  const org = ORGS[req.params.org];
  if (!org) return res.status(404).json({ error: "Unknown org" });
  const reportLabels = {
    facility: "Facility Rental Schedule",
    gl:       "GL Code Rollup",
    historic: "Historic Buildings",
    programs: "Program Revenue",
    roster:   "Class Roster",
  };
  const available = REPORT_TYPES
    .filter(r => org[r]?.mbUuid)
    .map(r => ({ key: r, label: reportLabels[r] || r }));
  res.json({ reports: available });
});

app.get("/:org/admin/subscribers", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const rows = db.getSubscriptions(req.params.org);
  const log  = db.getLog(req.params.org);
  res.json({ subscribers: rows, log });
});

app.post("/:org/admin/subscribe", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const { email, reports, schedule, locationFilter, dateRange, reportParams } = req.body;
  if (!email || !reports?.length || !schedule) return res.status(400).json({ error: "email, reports, and schedule are required" });
  if (!["daily","weekly","monthly"].includes(schedule)) return res.status(400).json({ error: "schedule must be daily, weekly, or monthly" });
  const validReports = reports.filter(r => REPORT_TYPES.includes(r));
  if (!validReports.length) return res.status(400).json({ error: "No valid report types" });
  const validDateRanges = ["today","next7","next30","last7","lastMonth"];

  // Validate + sanitize reportParams (optional object keyed by report type → URL query string)
  const cleanReportParams = {};
  if (reportParams && typeof reportParams === "object" && !Array.isArray(reportParams)) {
    for (const [key, val] of Object.entries(reportParams)) {
      if (!REPORT_TYPES.includes(key)) continue;
      if (typeof val !== "string") continue;
      const p = new URLSearchParams(val);
      p.delete("token");
      p.delete("_print");
      const filtered = new URLSearchParams();
      for (const [k, v] of p) {
        if (v === "" || v === "null" || v === "undefined") continue;
        filtered.set(k, v);
      }
      const out = filtered.toString();
      if (out.length) cleanReportParams[key] = out;
    }
  }

  db.upsertSubscription(
    req.params.org,
    email.toLowerCase().trim(),
    validReports,
    schedule,
    locationFilter || null,
    validDateRanges.includes(dateRange) ? dateRange : null,
    cleanReportParams,
  );
  res.json({ ok: true });
});

app.delete("/:org/admin/subscribe", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const { email, id } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  db.deleteSubscription(req.params.org, email.toLowerCase().trim(), id || null);
  res.json({ ok: true });
});

app.post("/:org/admin/test-email", async (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const resend = getResendClient();
  if (!resend) return res.json({ ok: false, error: "RESEND_API_KEY not configured" });
  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: email,
      subject: "rec.us Report Server — Test Email",
      html: "<p>This is a test email from the rec.us report server. Resend is working!</p>",
    });
    if (error) throw new Error(JSON.stringify(error));
    console.log("[test-email] Sent to", email, data);
    res.json({ ok: true });
  } catch (err) {
    console.error("[test-email] Error:", err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.post("/:org/admin/test-send", async (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const { email, report, schedule } = req.body;
  if (!email || !report || !schedule) return res.status(400).json({ error: "email, report, and schedule required" });
  res.json({ ok: true, message: "Sending in background — check the log in a moment" });
  sendReportEmail(req.params.org, email, report, schedule)
    .catch(err => console.error("[test-send] Error:", err));
});

// ── Serve HTML report pages ──────────────────────────────────────────
// Report HTML pages must always revalidate so a fresh deploy is picked up
// immediately instead of a heuristically-cached stale copy. ETag/Last-Modified
// still yield cheap 304s when the file is unchanged. (Scoped here: sits below
// the API/PDF routes, above the page handlers, so only HTML pages are affected.)
app.use((req, res, next) => {
  res.set("Cache-Control", "no-cache");
  next();
});

app.get("/:org/facility", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  logEvent(slug, "facility", "view", req.ip);
  const orgConfig = { defaultDateRange: org.facility?.defaultDateRange || "month", defaultLocationFilter: org.facility?.defaultLocationFilter || null };
  const html = require("fs").readFileSync(path.join(__dirname, "public", "facility.html"), "utf8");
  res.send(html.replace("<head>", `<head><script>window.ORG_CONFIG=${JSON.stringify(orgConfig)};</script>`));
});

app.get("/:org/gl", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "gl", "view", req.ip);
  res.sendFile(path.join(__dirname, "public", "gl.html"));
});

app.get("/:org/historic", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "historic", "view", req.ip);
  res.sendFile(path.join(__dirname, "public", "historic.html"));
});

app.get("/:org/programs", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "programs", "view", req.ip);
  res.sendFile(path.join(__dirname, "public", "programs.html"));
});

app.get("/:org/roster", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "roster", "view", req.ip);
  res.sendFile(path.join(__dirname, "public", "roster.html"));
});

app.get("/:org/overview", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "overview", "view", req.ip);
  res.sendFile(path.join(__dirname, "public", "overview.html"));
});

app.get("/:org/products", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org.products?.mbUuid) return res.status(404).send("Products report not configured for this org.");
  logEvent(slug, "products", "view", req.ip);
  res.sendFile(path.join(__dirname, "public", "products.html"));
});

app.get("/:org/memberships", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org.memberships?.mbUuid) return res.status(404).send("Memberships report not configured for this org.");
  logEvent(slug, "memberships", "view", req.ip);
  res.sendFile(path.join(__dirname, "public", "memberships.html"));
});

app.get("/:org/court-utilization", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org["court-utilization"]?.mbUuid) return res.status(404).send("Court Utilization report not configured for this org.");
  logEvent(slug, "court-utilization", "view", req.ip);
  res.sendFile(path.join(__dirname, "public", "court-utilization.html"));
});

app.get("/:org/admin", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/:org/metrics", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  res.sendFile(path.join(__dirname, "public", "metrics.html"));
});

app.get("/:org/calendar", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org.calendar?.mbUuid) return res.status(404).send("Calendar report not configured for this org.");
  logEvent(slug, "calendar", "view", req.ip);
  // Inject org metadata so the frontend can show logo + name
  const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
  const meta = {
    slug,
    displayName: org.displayName || `${slugTitle} Parks & Recreation`,
    logoUrl: org.logoUrl || '',
  };
  const fs = require("fs");
  const html = fs.readFileSync(path.join(__dirname, "public", "calendar.html"), "utf-8");
  const inject = `<script>window.__ORG__=${JSON.stringify(meta)};</script>`;
  res.type("html").send(html.replace("</head>", inject + "</head>"));
});

// ── GET /:org — org landing page ─────────────────────────────────────
// ────────────────────────────────────────────────────────────
// Hot Dog Counter — global concession leaderboard
// ────────────────────────────────────────────────────────────
const HOTDOG_MB_UUID = 'f3ec6929-49a8-4a00-8b72-c4685b6e9f35';
// Column order must match the SELECT list in the Metabase question SQL.
// Metabase /query/json returns a plain array of row-arrays with no header row.
const HOTDOG_COLS = ['Org', 'Product', 'Units Sold', 'Revenue ($)', 'Avg Unit Price ($)'];

// ── GET /api/hotdog/claims — return all current claims ───────────────
app.get('/api/hotdog/claims', (req, res) => {
  const claims = readJSON(HOTDOG_CLAIMS_FILE, {});
  // Return as { product: [{ name, icon, claimedAt }] }
  const byProduct = {};
  Object.values(claims).forEach(c => {
    if (!byProduct[c.product]) byProduct[c.product] = [];
    byProduct[c.product].push({ name: c.name, icon: c.icon, claimedAt: c.claimedAt });
  });
  res.json(byProduct);
});

// ── POST /api/hotdog/claim — lock in a staff member's item pick ───────
app.post('/api/hotdog/claim', (req, res) => {
  const { claimId, name, icon, product } = req.body;
  if (!claimId || !name?.trim() || !product) return res.status(400).json({ error: 'claimId, name, and product are required' });
  const claims = readJSON(HOTDOG_CLAIMS_FILE, {});
  if (claims[claimId]) return res.status(409).json({ error: 'already_claimed', product: claims[claimId].product });
  claims[claimId] = { name: name.trim(), icon: icon || '🌭', product, claimedAt: new Date().toISOString() };
  writeJSON(HOTDOG_CLAIMS_FILE, claims);
  console.log(`[hotdog] ${name.trim()} claimed "${product}" with ${icon}`);
  res.json({ ok: true });
});

app.get('/hotdog', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hotdog.html'));
});

// ── POST /api/feedback — user feedback → dan@rec.us ─────────────────
// Whitelisted by the org token gate (all /api/* paths pass through).
// Body: { message: string, email?: string, page?: string, userAgent?: string }
function escFeedback(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
app.post("/api/feedback", async (req, res) => {
  try {
    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const email   = typeof body.email   === "string" ? body.email.trim()   : "";
    const page    = typeof body.page    === "string" ? body.page.slice(0, 500)    : "";
    const userAgent = typeof body.userAgent === "string" ? body.userAgent.slice(0, 300) : "";

    if (!message)                return res.status(400).json({ error: "Message is required" });
    if (message.length > 5000)   return res.status(400).json({ error: "Message too long (max 5000 chars)" });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    // Infer org slug from the page path for the subject line
    let orgGuess = "";
    if (page) {
      const m = page.match(/^\/([a-z0-9_-]+)\b/i);
      if (m && ORGS[m[1]]) orgGuess = m[1];
    }

    const subject = `rec.us feedback${orgGuess ? ` — ${orgGuess}` : ""}${page ? ` (${page.split("?")[0]})` : ""}`;
    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;color:#111827;">
        <h2 style="margin:0 0 12px;color:#111827;font-size:18px;">New feedback from rec.us</h2>
        <div style="white-space:pre-wrap;background:#f9fafb;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;font-size:14px;line-height:1.5;color:#1f2937;">${escFeedback(message)}</div>
        <h3 style="color:#374151;font-size:13px;margin:24px 0 8px;text-transform:uppercase;letter-spacing:0.04em;">Context</h3>
        <table style="font-size:13px;color:#4b5563;border-collapse:collapse;">
          ${email     ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;"><strong>From:</strong></td><td style="padding:2px 0;">${escFeedback(email)}</td></tr>` : `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;"><strong>From:</strong></td><td style="padding:2px 0;color:#9ca3af;">(anonymous)</td></tr>`}
          ${orgGuess  ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;"><strong>Org:</strong></td><td style="padding:2px 0;">${escFeedback(orgGuess)}</td></tr>` : ""}
          ${page      ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;"><strong>Page:</strong></td><td style="padding:2px 0;font-family:monospace;font-size:12px;">${escFeedback(page)}</td></tr>` : ""}
          ${userAgent ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;vertical-align:top;"><strong>Browser:</strong></td><td style="padding:2px 0;font-family:monospace;font-size:12px;">${escFeedback(userAgent)}</td></tr>` : ""}
          <tr><td style="padding:2px 12px 2px 0;color:#6b7280;"><strong>Time:</strong></td><td style="padding:2px 0;">${new Date().toISOString()}</td></tr>
        </table>
      </div>
    `;

    const resend = getResendClient();
    if (!resend) {
      console.log("[feedback] RESEND_API_KEY not configured — stub log:", { message, email, page });
      return res.json({ ok: true, stub: true });
    }
    const emailPayload = {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: ["dan@rec.us"],
      subject,
      html,
    };
    if (email) emailPayload.replyTo = email;
    await resend.emails.send(emailPayload);
    console.log(`[feedback] sent to dan@rec.us (${orgGuess || "unknown"}, ${message.length} chars)`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[feedback] send failed:", e);
    res.status(500).json({ error: "Failed to send feedback" });
  }
});

// ── Debug: raw Metabase response (remove before prod) ────────────────
app.get('/api/hotdog/debug', async (req, res) => {
  try {
    const { start_date = '', end_date = '', org_filter = '' } = req.query;
    const params = [];
    if (start_date) params.push({ type: 'category', target: ['variable', ['template-tag', 'start_date']], value: parseToISO(start_date) });
    if (end_date)   params.push({ type: 'category', target: ['variable', ['template-tag', 'end_date']],   value: parseToISO(end_date)   });
    if (org_filter) params.push({ type: 'category', target: ['variable', ['template-tag', 'org_filter']], value: org_filter              });
    const mbUrl = `${METABASE_URL}/api/public/card/${HOTDOG_MB_UUID}/query/json`
      + (params.length ? `?parameters=${encodeURIComponent(JSON.stringify(params))}` : '');
    const mbRes = await fetch(mbUrl);
    const raw   = await mbRes.json();
    const isArray = Array.isArray(raw);
    res.json({
      http_status:  mbRes.status,
      params_sent:  params,
      is_array:     isArray,
      row_count:    isArray ? raw.length : (raw?.data?.rows?.length ?? 'n/a'),
      sample_rows:  isArray ? raw.slice(0, 3) : (raw?.data?.rows?.slice(0, 3) || []),
      raw_keys:     isArray ? ['(array)'] : Object.keys(raw || {}),
      error:        raw?.error || null,
      status:       raw?.status || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/hotdog', async (req, res) => {
  try {
    const { start_date = '', end_date = '', org_filter = '' } = req.query;
    const params = [];
    if (start_date) params.push({ type: 'category', target: ['variable', ['template-tag', 'start_date']], value: parseToISO(start_date) });
    if (end_date)   params.push({ type: 'category', target: ['variable', ['template-tag', 'end_date']],   value: parseToISO(end_date)   });
    if (org_filter) params.push({ type: 'category',    target: ['variable', ['template-tag', 'org_filter']], value: org_filter              });

    const mbUrl = `${METABASE_URL}/api/public/card/${HOTDOG_MB_UUID}/query/json`
      + (params.length ? `?parameters=${encodeURIComponent(JSON.stringify(params))}` : '');

    const mbRes = await fetch(mbUrl);
    const raw   = await mbRes.json();

    // Metabase /query/json returns a plain JSON array of row-arrays — no header row.
    // HOTDOG_COLS maps positions to names based on the SQL SELECT order.
    if (!Array.isArray(raw)) {
      console.error('[hotdog] Unexpected format:', JSON.stringify(raw).slice(0, 300));
      return res.status(502).json({ error: raw?.error || 'Unexpected response from Metabase' });
    }

    console.log(`[hotdog] ${raw.length} rows, format=${Array.isArray(raw[0]) ? 'array-of-arrays' : 'array-of-objects'}`);
    // Metabase /query/json returns array-of-arrays when no params, array-of-objects when params sent
    const rows = (raw.length > 0 && Array.isArray(raw[0]))
      ? raw.map(row => Object.fromEntries(HOTDOG_COLS.map((col, i) => [col, row[i]])))
      : raw;  // already named objects
    res.json({ rows, meta: { cols: HOTDOG_COLS } });
  } catch (err) {
    console.error('[/api/hotdog]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/:org", (req, res, next) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  // Fall through to express.static so static assets like /feedback-widget.js
  // can be served. If nothing else matches, Express returns its default 404.
  if (!org) return next();

  const reportMeta = {
    facility: { label: "Facility Rental Schedule", icon: "📅", desc: "Reservations grouped by date and location" },
    gl:       { label: "GL Code Rollup",            icon: "📊", desc: "Payment and refund summary by GL code" },
    programs: { label: "Program Revenue",           icon: "🎯", desc: "Enrollment and revenue by program and section", ai: true },
    historic: { label: "Historic Buildings",        icon: "🏛️",  desc: "Reservations for historic building sites" },
    roster:   { label: "Class Roster",              icon: "📋", desc: "Enrolled and cancelled participants by section" },
    overview:    { label: "Facility Overview",         icon: "📈", desc: "Revenue and activity summary by location" },
    products:    { label: "Product Sales",          icon: "🛒", desc: "Daily revenue, refunds, and net by product" },
    memberships: { label: "Memberships",                icon: "🎫", desc: "Active and lapsed memberships with renewal tracking" },
    "court-utilization": { label: "Court Utilization",  icon: "🎾", desc: "Court utilization % or reserved hours by court, split by customer, program, and closure usage", ai: true },
    calendar:    { label: "Calendar",               icon: "🗓️", desc: "Public class & rental schedule (week / list view)" },
  };

  const tokenQS = org.token ? `?token=${encodeURIComponent(org.token)}` : "";
  const available = REPORT_TYPES.filter(r => org[r]?.mbUuid);

  const cards = available.map(r => {
    const m = reportMeta[r] || { label: r, icon: "📄", desc: "" };
    return `
      <a href="/${slug}/${r}${tokenQS}" class="card">
        <div class="card-icon">${m.icon}</div>
        <div class="card-body">
          <div class="card-label">${m.label}</div>
          <div class="card-desc">${m.desc}</div>
          ${m.ai ? '<span class="ai-pill">✦ AI enhanced</span>' : ''}
        </div>
        <div class="card-arrow">→</div>
      </a>`;
  }).join("");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${slug.charAt(0).toUpperCase() + slug.slice(1)} Reports</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'IBM Plex Sans', system-ui, sans-serif; background: #f5f4f1; color: #1a1a1a; min-height: 100vh; display: flex; flex-direction: column; }
    .topbar { background: #2c2c2c; color: #eee; padding: 12px 32px; display: flex; align-items: center; gap: 16px; }
    .topbar img { height: 36px; object-fit: contain; }
    .topbar-name { font-weight: 700; font-size: 15px; }
    .topbar-sub  { font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-top: 1px; }
    .main { flex: 1; max-width: 700px; margin: 48px auto; padding: 0 24px; width: 100%; }
    .section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; color: #888; margin-bottom: 12px; }
    .cards { display: flex; flex-direction: column; gap: 10px; margin-bottom: 32px; }
    .card { display: flex; align-items: center; gap: 16px; background: #fff; border: 1px solid #e0ddd8; border-radius: 8px; padding: 16px 20px; text-decoration: none; color: inherit; transition: box-shadow .15s, border-color .15s; }
    .card:hover { box-shadow: 0 2px 12px rgba(0,0,0,.1); border-color: #bbb; }
    .card-icon  { font-size: 24px; flex-shrink: 0; width: 36px; text-align: center; }
    .card-body  { flex: 1; }
    .card-label { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
    .card-desc  { font-size: 12px; color: #888; }
    .ai-pill { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 7px; border-radius: 20px; background: linear-gradient(90deg, #6d28d9, #0d9488); color: #fff; margin-top: 5px; }
    .card-arrow { font-size: 18px; color: #ccc; flex-shrink: 0; }
    .card:hover .card-arrow { color: #16a34a; }
    .admin-links { border-top: 1px solid #ddd; padding-top: 16px; display: flex; flex-direction: column; gap: 8px; }
    .admin-link { display: flex; align-items: center; gap: 12px; color: #555; text-decoration: none; font-size: 13px; padding: 8px 0; }
    .admin-link:hover { color: #111; }
    .admin-link span { font-size: 18px; }
    footer { text-align: center; padding: 24px; font-size: 11px; color: #bbb; }
  </style>
</head>
<body>
  <div class="topbar">
    ${org.logoUrl ? `<img src="${org.logoUrl}" alt="" onerror="this.style.display='none'" />` : ""}
    <div>
      <div class="topbar-name">${slug.charAt(0).toUpperCase() + slug.slice(1)} Parks &amp; Recreation</div>
      <div class="topbar-sub">rec.us Reports</div>
    </div>
  </div>
  <div class="main">
    <div class="section-label">Reports</div>
    <div class="cards">${cards}</div>
    <div class="admin-links">
      <a href="/${slug}/admin${tokenQS}" class="admin-link"><span>📧</span> Manage Email Subscriptions</a>
    </div>
  </div>
  <footer>rec.us · ${slug}</footer>
</body>
</html>`);
});

// ── POST /api/admin/links — list every org's reports + current links ──
// Dashboard-level Metabase link editor (all orgs). Whitelisted from the
// per-org token gate via the /api/ prefix; password travels in the body.
app.post("/api/admin/links", (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  const reportLabels = {
    facility: "Facility Rental Schedule",
    gl:       "GL Code Rollup",
    historic: "Historic Buildings",
    programs: "Program Revenue",
    roster:   "Class Roster",
    overview: "Overview",
    products: "Product Revenue",
    memberships: "Membership Revenue",
    "court-utilization": "Court Utilization",
  };
  const orgs = Object.entries(ORGS).map(([slug, org]) => {
    const slugTitle   = slug.charAt(0).toUpperCase() + slug.slice(1);
    const displayName = org.displayName || `${slugTitle} Parks & Recreation`;
    const reports = REPORT_TYPES
      .filter(r => org[r] && org[r].mbUuid)
      .map(r => ({
        key: r,
        label: reportLabels[r] || r,
        mbUuid: org[r].mbUuid,
        publicUrl: `${METABASE_URL}/public/question/${org[r].mbUuid}`,
      }));
    return { slug, displayName, reports };
  }).filter(o => o.reports.length);
  res.json({ ok: true, orgs });
});

// ── POST /api/admin/restart — redeploy the latest build on Railway ───
// Password-protected (same gate as link editing). Uses Railway's GraphQL
// API to redeploy the current service instance (effectively a restart).
// Requires RAILWAY_API_TOKEN to be set; RAILWAY_SERVICE_ID and
// RAILWAY_ENVIRONMENT_ID are auto-injected by Railway at runtime.
app.post("/api/admin/restart", async (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    return res.status(503).json({ error: "Set RAILWAY_API_TOKEN in Railway to enable restarts" });
  }
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!serviceId || !environmentId) {
    return res.status(503).json({ error: "RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID not available in this environment" });
  }
  const query = `mutation Redeploy($environmentId: String!, $serviceId: String!) {
    serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)
  }`;
  try {
    const resp = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables: { environmentId, serviceId } }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && !data.errors) {
      return res.json({ ok: true });
    }
    const msg = (data.errors && data.errors[0] && data.errors[0].message) || `Railway API returned ${resp.status}`;
    console.error("[restart] Railway API error:", msg);
    return res.status(502).json({ error: msg });
  } catch (err) {
    console.error("[restart] Failed to reach Railway API:", err.message);
    return res.status(502).json({ error: "Failed to reach Railway API" });
  }
});

// ── GET /api/admin/railway-status — latest deployment info ───────────
// Returns the most recent deployment's status, timestamp, and service URL.
app.get("/api/admin/railway-status", async (req, res) => {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) return res.json({ ok: false, error: "No RAILWAY_API_TOKEN" });
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!serviceId || !environmentId) return res.json({ ok: false, error: "Missing Railway env vars" });
  const query = `query LatestDeploy($serviceId: String!, $environmentId: String!) {
    deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
      edges {
        node {
          id
          status
          createdAt
          updatedAt
          staticUrl
          meta
        }
      }
    }
  }`;
  try {
    const resp = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ query, variables: { serviceId, environmentId } }),
    });
    const data = await resp.json().catch(() => ({}));
    if (data.errors) return res.json({ ok: false, error: data.errors[0]?.message || "Railway API error" });
    const node = data?.data?.deployments?.edges?.[0]?.node;
    if (!node) return res.json({ ok: false, error: "No deployments found" });
    const uptime = process.uptime();
    const uptimeStr = uptime > 86400
      ? `${Math.floor(uptime/86400)}d ${Math.floor((uptime%86400)/3600)}h`
      : uptime > 3600
        ? `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`
        : `${Math.floor(uptime/60)}m`;
    res.json({
      ok: true,
      status: node.status,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      deployId: node.id?.slice(0,8),
      uptime: uptimeStr,
      memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── POST /api/admin/update-link — change one report's Metabase link ──
// Writes server.js on GitHub (Railway auto-redeploys) and updates the
// in-memory ORGS map immediately. Body: { password, org, report, link }.
app.post("/api/admin/update-link", async (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  const { org: slug, report, link } = req.body || {};
  const org = ORGS[slug];
  if (!org) return res.status(404).json({ error: "Unknown org" });
  if (!report || !REPORT_TYPES.includes(report)) {
    return res.status(400).json({ error: "Valid report type required" });
  }
  if (!org[report] || !org[report].mbUuid) {
    return res.status(400).json({ error: `Org "${slug}" has no "${report}" report to update` });
  }
  const newUuid = extractMbUuidFromInput(link);
  if (!newUuid || !STRICT_UUID.test(newUuid)) {
    return res.status(400).json({ error: "Could not find a valid Metabase UUID in that link" });
  }
  if (newUuid === org[report].mbUuid) {
    return res.status(400).json({ error: "That's already the current link for this report" });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(503).json({ error: "GITHUB_TOKEN not configured on the server" });
  }
  try {
    const result = await updateReportUuidOnGitHub(
      slug, report, newUuid,
      `Update ${slug}/${report} Metabase link -> ${newUuid}`,
    );
    ORGS[slug][report] = { ...ORGS[slug][report], mbUuid: newUuid };
    console.log(`[update-link] ${slug}/${report}: ${result.oldUuid} -> ${newUuid}`);
    res.json({
      ok: true,
      oldUuid: result.oldUuid,
      newUuid,
      commitUrl: result.commitUrl,
      publicUrl: `${METABASE_URL}/public/question/${newUuid}`,
    });
  } catch (err) {
    console.error("[update-link] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// \u2500\u2500 POST /api/admin/add-report \u2014 add a report type to an existing org \u2500
// Inserts the report's mbUuid into the org's block in server.js on GitHub
// (Railway auto-redeploys) and updates the in-memory ORGS map. Use this to
// ADD a report an org is missing; use /update-link to change an existing one.
app.post("/api/admin/add-report", async (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  const { org: slug, report, link } = req.body || {};
  const org = ORGS[slug];
  if (!org) return res.status(404).json({ error: "Unknown org" });
  if (!report || !REPORT_TYPES.includes(report)) {
    return res.status(400).json({ error: "Valid report type required" });
  }
  if (NON_ADDABLE_REPORTS.has(report)) {
    return res.status(400).json({ error: `Report type "${report}" can't be added from the dashboard` });
  }
  if (org[report] && org[report].mbUuid) {
    return res.status(400).json({ error: `Org "${slug}" already has a "${report}" report \u2014 use the link editor to change it` });
  }
  const newUuid = extractMbUuidFromInput(link);
  if (!newUuid || !STRICT_UUID.test(newUuid)) {
    return res.status(400).json({ error: "Could not find a valid Metabase UUID in that link" });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(503).json({ error: "GITHUB_TOKEN not configured on the server" });
  }
  try {
    const result = await addReportUuidOnGitHub(
      slug, report, newUuid,
      `Add ${slug}/${report} report -> ${newUuid}`,
    );
    ORGS[slug][report] = { ...(ORGS[slug][report] || {}), mbUuid: newUuid };
    console.log(`[add-report] ${slug}/${report}: ${result.mode} -> ${newUuid}`);
    res.json({
      ok: true,
      newUuid,
      mode: result.mode,
      commitUrl: result.commitUrl,
      publicUrl: `${METABASE_URL}/public/question/${newUuid}`,
    });
  } catch (err) {
    console.error("[add-report] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/new-org — create a new org dynamically ──────────
// Pushes the new entry to server.js on GitHub (so it lives in code).
// Falls back to data/orgs.json if the GitHub push fails, so the org
// still works until the next deploy or until you can fix the push.
// Generate a 16-char base62 access token (matches existing org token style).
function genToken() {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 16; i++) s += a[crypto.randomInt(a.length)];
  return s;
}

app.post("/api/admin/new-org", dashboardAuth, async (req, res) => {
  const { slug, displayName, orgId, logoUrl, reports } = req.body;

  // Validate slug
  if (!slug || !/^[a-z0-9_-]+$/.test(slug))
    return res.status(400).json({ error: "Slug must be lowercase letters, numbers, hyphens, or underscores" });
  if (ORGS[slug])
    return res.status(400).json({ error: `Org "${slug}" already exists` });
  if (!orgId || !logoUrl)
    return res.status(400).json({ error: "orgId and logoUrl are required" });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId))
    return res.status(400).json({ error: "orgId must be a valid UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)" });
  if (!reports || !Object.keys(reports).length)
    return res.status(400).json({ error: "At least one report is required" });

  // Build the new org entry. Every org MUST have a token: the per-org gate
  // fails closed, so a tokenless org would 404 on all its routes. Generate one
  // here so self-serve orgs are never born tokenless.
  const orgEntry = { token: genToken(), orgId, logoUrl, displayName: displayName || null };
  for (const [reportType, mbUuid] of Object.entries(reports)) {
    if (REPORT_TYPES.includes(reportType) && mbUuid) {
      orgEntry[reportType] = { mbUuid };
    }
  }

  // Update in-memory ORGS immediately so the org works right away
  ORGS[slug] = orgEntry;

  // Try to push to GitHub (preferred path — entry lives in code)
  let github = { pushed: false, commitUrl: null, error: null };
  try {
    const result = await pushOrgsToGitHub(
      [{ slug, orgEntry }],
      `Add ${slug} org via admin dashboard`,
    );
    github.pushed = true;
    github.commitUrl = result.commitUrl;
    console.log(`[new-org] Pushed ${slug} to GitHub: ${result.commitUrl}`);
  } catch (err) {
    github.error = err.message;
    console.warn(`[new-org] GitHub push failed for ${slug}: ${err.message}`);
    // Fall back to orgs.json so the org survives container restart
    const dynamic = readJSON(ORGS_FILE, {});
    dynamic[slug] = orgEntry;
    writeJSON(ORGS_FILE, dynamic);
    console.log(`[new-org] Saved ${slug} to orgs.json as fallback`);
  }

  console.log(`[new-org] Created org: ${slug} with reports: ${Object.keys(reports).join(", ")}`);
  res.json({ ok: true, slug, reports: Object.keys(reports), github });
});

// ── Root index — all orgs dashboard ─────────────────────────────────
app.get("/", (req, res) => {
  const reportMeta = {
    facility: { label: "Facility Rental Schedule", icon: "📅", desc: "Reservations grouped by date and location", color: "#16a34a" },
    gl:       { label: "GL Code Rollup",            icon: "📊", desc: "Payment and refund summary by GL code",   color: "#3b82f6" },
    programs: { label: "Program Revenue",           icon: "🎯", desc: "Enrollment and revenue by program",       color: "#7c3aed", ai: true },
    historic: { label: "Historic Buildings",        icon: "🏛️",  desc: "Reservations for historic building sites", color: "#d97706" },
    roster:   { label: "Class Roster",              icon: "📋", desc: "Enrolled and cancelled participants by section", color: "#0891b2" },
    overview:    { label: "Facility Overview",         icon: "📈", desc: "Revenue and activity summary by location",                 color: "#059669" },
    products:    { label: "Product Sales",          icon: "🛒", desc: "Daily revenue, refunds, and net by product",           color: "#0891b2" },
    memberships: { label: "Memberships",                icon: "🎫", desc: "Active and lapsed memberships with renewal tracking",       color: "#db2777" },
    "court-utilization": { label: "Court Utilization",  icon: "🎾", desc: "Court utilization % or reserved hours by court, split by customer, program, and closure usage", color: "#0d9488", ai: true },
    calendar:    { label: "Calendar",               icon: "🗓️", desc: "Public class & rental schedule (week / list view)", color: "#ea580c" },
  };

  const orgSections = Object.entries(ORGS).map(([slug, org]) => {
    const available    = REPORT_TYPES.filter(r => org[r]?.mbUuid);
    const slugTitle    = slug.charAt(0).toUpperCase() + slug.slice(1);
    const displayName  = org.displayName || `${slugTitle} Parks &amp; Recreation`;
    const tokenQS      = org.token ? `?token=${encodeURIComponent(org.token)}` : "";

    // Standard Metabase-backed report cards
    const cards = available.map(r => {
      const m = reportMeta[r] || { label: r, icon: "📄", desc: "", color: "#888" };
      return `
        <a href="/${slug}/${r}${tokenQS}" class="report-card" style="--accent:${m.color}">
          <span class="report-icon">${m.icon}</span>
          <div class="report-body">
            <div class="report-label">${m.label}</div>
            <div class="report-desc">${m.desc}</div>
            ${m.ai ? '<span class="ai-pill">✦ AI enhanced</span>' : ''}
          </div>
          <span class="report-arrow">→</span>
        </a>`;
    });

    // Append a dashed "add report" tile for any report types this org lacks.
    const missing = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && !(org[r] && org[r].mbUuid));
    if (missing.length) {
      cards.push(`
        <button type="button" class="report-card add-report-card" onclick="openAddReport('${slug}')" title="Add a report to this org">
          <span class="report-icon">＋</span>
          <div class="report-body">
            <div class="report-label">Add report</div>
            <div class="report-desc">${missing.length} more report${missing.length !== 1 ? 's' : ''} available</div>
          </div>
        </button>`);
    }

    // Admin link with subscriber summary
    let adminLink = "";
    if (org.orgId) {
      const subs = db.getSubscriptions(slug);
      const byCadence = { daily: 0, weekly: 0, monthly: 0 };
      subs.forEach(s => { if (byCadence[s.schedule] !== undefined) byCadence[s.schedule]++; });
      const total = subs.length;
      const parts = [
        byCadence.daily   ? `${byCadence.daily}d`   : '',
        byCadence.weekly  ? `${byCadence.weekly}w`  : '',
        byCadence.monthly ? `${byCadence.monthly}m` : '',
      ].filter(Boolean).join(' ');
      const badge = parts ? `<span class="sub-badge">${parts}</span>` : '';
      adminLink = `<a href="/${slug}/admin${tokenQS}" class="org-action-link" title="${total} subscriber${total!==1?'s':''}">📧 Admin${badge}</a>`;
    }
    const headerActions = adminLink ? `<div class="org-header-actions">${adminLink}</div>` : "";

    // Inline metrics toggle (only for orgs with orgId)
    const metricsToggle = org.orgId ? `
        <div class="metrics-toggle-row">
          <button class="metrics-toggle-btn" onclick="toggleMetrics('${slug}', this, '${org.token || ""}')">▸ 📈 Metrics</button>
          <a href="/${slug}/metrics${tokenQS}" class="metrics-full-link">View full metrics →</a>
        </div>
        <div class="metrics-panel" id="metrics-${slug}" style="display:none"></div>` : "";

    const orgNameHtml = org.orgId
      ? `<a href="/${slug}${tokenQS}" class="org-name-link">${displayName}</a>`
      : `<span>${displayName}</span>`;

    const tokenRow = org.token ? `
        <div class="token-row">
          <span class="token-label">🔑 Access token</span>
          <code class="token-value">${org.token}</code>
          <button class="token-copy-btn" onclick="copyTokenURL('${slug}', this)" data-base="/${slug}?token=${encodeURIComponent(org.token)}">Copy landing URL</button>
        </div>` : "";

    return `
      <div class="org-section">
        <div class="org-header">
          ${org.logoUrl ? `<img src="${org.logoUrl}" class="org-logo" alt="" onerror="this.style.display='none'" />` : ""}
          <div class="org-header-text">
            ${orgNameHtml}
            <div class="org-slug">${slug}</div>
          </div>
          ${headerActions}
        </div>
        <div class="report-cards">${cards.join("")}</div>
        ${tokenRow}
        ${metricsToggle}
      </div>`;
  }).join("");

  // Data for the "Add reports" modal: per-org missing report types + labels.
  const addReportMeta = Object.fromEntries(
    Object.entries(reportMeta).map(([k, m]) => [k, { label: m.label, icon: m.icon }])
  );
  const addReportOrgs = Object.fromEntries(
    Object.entries(ORGS).map(([slug, org]) => {
      const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
      const displayName = org.displayName || `${slugTitle} Parks & Recreation`;
      const missing = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && !(org[r] && org[r].mbUuid));
      return [slug, { displayName, missing }];
    })
  );

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>rec.us Reports</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'IBM Plex Sans', system-ui, sans-serif; background: #f5f4f1; color: #1a1a1a; min-height: 100vh; display: flex; flex-direction: column; }
    .topbar { background: #2c2c2c; color: #eee; padding: 14px 32px; display: flex; align-items: center; gap: 12px; }
    .topbar-logo { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; color: #fff; }
    .topbar-logo span { color: #4ade80; }
    .topbar-divider { width: 1px; height: 20px; background: rgba(255,255,255,.2); }
    .topbar-sub { font-size: 12px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; }
    .main { flex: 1; max-width: 860px; margin: 0 auto; padding: 40px 24px; width: 100%; }
    .page-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; color: #888; margin-bottom: 24px; }
    .org-section { background: #fff; border: 1px solid #e0ddd8; border-radius: 10px; margin-bottom: 20px; overflow: hidden; }
    .org-header { display: flex; align-items: center; gap: 14px; padding: 16px 20px; background: #f9f8f6; border-bottom: 1px solid #e8e5df; }
    .org-logo { height: 32px; width: auto; object-fit: contain; flex-shrink: 0; }
    .org-header-text { flex: 1; }
    .org-name { font-weight: 700; font-size: 14px; }
    .org-slug { font-size: 11px; color: #999; margin-top: 1px; }
    .org-header-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .org-action-link { font-size: 12px; color: #888; text-decoration: none; padding: 5px 10px; border: 1px solid #ddd; border-radius: 5px; white-space: nowrap; transition: background .15s, color .15s; }
    .org-action-link:hover { background: #f0f0f0; color: #333; }
    .token-row { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid #f0ede8; background: #fafaf8; font-size: 11px; flex-wrap: wrap; }
    .token-label { color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: .8px; flex-shrink: 0; }
    .token-value { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; background: #fff; border: 1px solid #e0ddd8; padding: 3px 8px; border-radius: 4px; color: #1a1a1a; letter-spacing: 0; user-select: all; }
    .token-copy-btn { margin-left: auto; background: #fff; border: 1px solid #d0cdc8; color: #555; padding: 4px 12px; border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: 600; transition: background .15s, border-color .15s; }
    .token-copy-btn:hover { background: #f0ede8; border-color: #999; }
    .token-copy-btn.copied { background: #16a34a; color: #fff; border-color: #16a34a; }
    .sub-badge { display: inline-block; margin-left: 6px; font-size: 10px; background: #16a34a; color: #fff; border-radius: 3px; padding: 1px 5px; font-weight: 600; letter-spacing: 0.3px; }
    .report-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1px; background: #e8e5df; }
    .report-card { display: flex; align-items: center; gap: 12px; padding: 14px 18px; background: #fff; text-decoration: none; color: inherit; transition: background .15s; border-left: 3px solid transparent; }
    .report-card:hover { background: #fafaf8; border-left-color: var(--accent, #888); }
    .report-icon { font-size: 20px; flex-shrink: 0; width: 28px; text-align: center; }
    .report-body { flex: 1; min-width: 0; }
    .report-label { font-weight: 600; font-size: 13px; }
    .report-desc  { font-size: 11px; color: #999; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ai-pill { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 7px; border-radius: 20px; background: linear-gradient(90deg, #6d28d9, #0d9488); color: #fff; margin-top: 5px; }
    .report-arrow { font-size: 14px; color: #ccc; flex-shrink: 0; }
    .report-card:hover .report-arrow { color: var(--accent, #888); }
    .add-report-card { border: none; border-left: 3px dashed #cbd5c0; background: #fbfbf9; cursor: pointer; font: inherit; text-align: left; width: 100%; }
    .add-report-card:hover { background: #f3f6ef; border-left-color: #16a34a; }
    .add-report-card .report-icon { color: #16a34a; font-weight: 700; }
    .add-report-card .report-label { color: #16a34a; }
    .org-name-link { font-weight: 700; font-size: 14px; color: inherit; text-decoration: none; }
    .org-name-link:hover { color: #16a34a; text-decoration: underline; }
    .metrics-toggle-row { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-top: 1px solid #e8e5df; background: #fafaf8; }
    .metrics-toggle-btn { font-size: 12px; color: #666; background: none; border: 1px solid #ddd; border-radius: 4px; padding: 4px 10px; cursor: pointer; transition: background .15s, color .15s; }
    .metrics-toggle-btn:hover { background: #f0f0f0; color: #111; }
    .metrics-toggle-btn.open { color: #16a34a; border-color: #16a34a; }
    .metrics-full-link { font-size: 11px; color: #aaa; text-decoration: none; margin-left: auto; }
    .metrics-full-link:hover { color: #555; text-decoration: underline; }
    .metrics-panel { padding: 14px 18px; background: #f5f4f1; border-top: 1px solid #e8e5df; }
    .metrics-grid { display: flex; flex-wrap: wrap; gap: 8px; }
    .metrics-stat { background: #fff; border: 1px solid #e0ddd8; border-radius: 6px; padding: 10px 14px; min-width: 110px; }
    .metrics-stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #999; margin-bottom: 3px; }
    .metrics-stat-value { font-size: 20px; font-weight: 700; color: #1a1a1a; }
    .metrics-stat-sub { font-size: 11px; color: #16a34a; font-weight: 600; margin-top: 2px; }
    .metrics-reports { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
    .metrics-report-chip { font-size: 11px; background: #fff; border: 1px solid #e0ddd8; border-radius: 4px; padding: 4px 10px; color: #555; }
    .metrics-report-chip strong { color: #16a34a; }
    .metrics-loading { font-size: 12px; color: #aaa; padding: 4px 0; }
    .metrics-chart-wrap { position: relative; height: 160px; margin-top: 12px; }
    .how-chevron { font-size: 11px; color: #aaa; transition: transform .2s; flex-shrink: 0; }
    .how-chevron.open { transform: rotate(90deg); }
    .how-body { display: none; padding: 18px 20px; font-size: 12.5px; color: #333; line-height: 1.65; }
    .how-body.open { display: block; }
    .how-body h4 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; color: #888; margin: 16px 0 6px; }
    .how-body h4:first-child { margin-top: 0; }
    .how-body p { margin-bottom: 10px; }
    .how-body p:last-child { margin-bottom: 0; }
    .how-body code { font-family: monospace; font-size: 11px; background: #f0ede8; padding: 1px 5px; border-radius: 3px; color: #333; }
    .how-body ul { padding-left: 18px; margin-bottom: 10px; }
    .how-body li { margin-bottom: 4px; }
    .how-arch { display: flex; align-items: center; gap: 6px; font-size: 11.5px; margin-bottom: 6px; font-family: monospace; color: #444; flex-wrap: wrap; }
    .how-arch-box { background: #f5f4f1; border: 1px solid #ddd; border-radius: 4px; padding: 3px 8px; font-size: 11px; white-space: nowrap; }
    .how-arch-arrow { color: #bbb; }
    .mb-org { border-top: 1px solid #f0ede8; }
    .mb-org:first-child { border-top: none; }
    .mb-org-name { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: #16a34a; padding: 12px 20px 6px; }
    .mb-row { display: flex; align-items: center; gap: 12px; padding: 9px 20px; border-top: 1px solid #f6f4f1; }
    .mb-row:hover { background: #fafaf8; }
    .mb-row-info { flex: 1; min-width: 0; }
    .mb-row-label { font-size: 13px; font-weight: 600; color: #222; }
    .mb-row-uuid { font-size: 11px; color: #999; font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mb-edit-btn { flex-shrink: 0; font-size: 12px; padding: 5px 12px; background: #fff; border: 1px solid #d0cdc8; border-radius: 5px; color: #555; cursor: pointer; font-weight: 600; transition: background .15s, border-color .15s; }
    .mb-edit-btn:hover { background: #f0ede8; border-color: #999; }
    .mb-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #16a34a; color: #fff; padding: 12px 22px; border-radius: 8px; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,.2); z-index: 2000; opacity: 0; transition: opacity .25s, transform .25s; pointer-events: none; }
    .mb-toast.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }
    footer { text-align: center; padding: 24px; font-size: 11px; color: #bbb; }
    /* Updates log */
    .updates-count { font-size: 11px; font-weight: 600; color: #888; background: #f0ede8; border-radius: 10px; padding: 1px 8px; margin-left: 6px; }
    .how-body .update-entry { display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid #f3f3f3; }
    .how-body .update-entry:first-child { padding-top: 0; }
    .how-body .update-entry:last-child { border-bottom: none; padding-bottom: 0; }
    .how-body .update-date { flex: 0 0 84px; font-family: monospace; font-size: 11px; color: #999; padding-top: 1px; }
    .how-body .update-title { font-weight: 600; font-size: 12.5px; margin-bottom: 4px; color: #222; }
    .how-body .update-items { margin: 0; padding-left: 16px; }
    .how-body .update-items li { font-size: 12px; color: #555; margin: 2px 0; line-height: 1.45; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="topbar-logo">rec<span>.</span>us</div>
    <div class="topbar-divider"></div>
    <div class="topbar-sub">Report Server</div>
    <div style="flex:1"></div>
    <button onclick="openAddOrg()" style="font-size:12px;padding:6px 14px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);border-radius:5px;color:#eee;cursor:pointer;transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,.22)'" onmouseout="this.style.background='rgba(255,255,255,.12)'">➕ Add Org</button>
  </div>
  <!-- Railway Status Bar -->
  <div id="railway-bar" style="background:#1e1e1e;border-bottom:1px solid #333;padding:6px 20px;display:flex;align-items:center;gap:16px;font-size:11px;color:#999;min-height:28px">
    <span style="color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:10px">Railway</span>
    <span id="rw-dot" style="width:8px;height:8px;border-radius:50%;background:#555;flex-shrink:0"></span>
    <span id="rw-status">Loading…</span>
    <span id="rw-deploy" style="color:#666"></span>
    <span id="rw-uptime" style="color:#666"></span>
    <span id="rw-mem" style="color:#666"></span>
    <span style="flex:1"></span>
    <span id="rw-error" style="color:#e55;font-size:10px"></span>
  </div>
  <script>
  (function fetchRailwayStatus(){
    fetch('/api/admin/railway-status')
      .then(r=>r.json()).then(d=>{
        const dot=document.getElementById('rw-dot'),st=document.getElementById('rw-status'),
              dep=document.getElementById('rw-deploy'),up=document.getElementById('rw-uptime'),
              mem=document.getElementById('rw-mem'),err=document.getElementById('rw-error');
        if(!d.ok){err.textContent=d.error||'Error';st.textContent='Unknown';return;}
        const colors={SUCCESS:'#22c55e',BUILDING:'#f59e0b',DEPLOYING:'#3b82f6',
                      FAILED:'#ef4444',CRASHED:'#ef4444',REMOVED:'#6b7280'};
        dot.style.background=colors[d.status]||'#6b7280';
        st.textContent=d.status;st.style.color=colors[d.status]||'#999';
        if(d.createdAt){
          const ago=Math.round((Date.now()-new Date(d.createdAt).getTime())/60000);
          const agoStr=ago<60?ago+'m ago':Math.round(ago/60)+'h ago';
          dep.textContent='Deploy '+d.deployId+' · '+agoStr;
        }
        if(d.uptime) up.textContent='Up '+d.uptime;
        if(d.memMB) mem.textContent=d.memMB+' MB';
      }).catch(()=>{document.getElementById('rw-status').textContent='Failed to reach API';});
    setTimeout(fetchRailwayStatus,60000);
  })();
  </script>
  <!-- ── Add Org Modal ── -->
  <div id="add-org-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;overflow-y:auto;padding:40px 16px">
    <div id="add-org-modal" style="background:#fff;border-radius:10px;max-width:560px;margin:0 auto;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:20px 24px;background:#2c2c2c;color:#fff;display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-weight:700;font-size:15px" id="modal-title">Add New Organization</div>
          <div style="font-size:11px;color:#aaa;margin-top:2px" id="modal-sub">Step 1 of 2 — Org details</div>
        </div>
        <button onclick="closeAddOrg()" style="background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:4px">✕</button>
      </div>
      <!-- Step 1: Org Details -->
      <div id="step1" style="padding:24px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;display:block;margin-bottom:6px">Org Slug *</label>
            <input id="f-slug" type="text" placeholder="e.g. springfield" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px" oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9_-]/g,'')" />
            <div style="font-size:11px;color:#aaa;margin-top:4px">URL path — lowercase only</div>
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;display:block;margin-bottom:6px">Display Name</label>
            <input id="f-name" type="text" placeholder="e.g. Springfield Parks & Rec" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px" />
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;display:block;margin-bottom:6px">Org UUID *</label>
            <input id="f-orgid" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px;font-family:monospace" />
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;display:block;margin-bottom:6px">Logo URL *</label>
            <input id="f-logo" type="text" placeholder="https://..." style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px" />
          </div>
        </div>
        <div style="margin-top:20px">
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;display:block;margin-bottom:10px">Reports to Enable *</label>
          <div id="report-checkboxes" style="display:flex;flex-wrap:wrap;gap:8px"></div>
        </div>
        <div id="metabase-inputs" style="margin-top:20px;display:flex;flex-direction:column;gap:12px"></div>
        <div id="step1-error" style="margin-top:12px;color:#e55;font-size:12px;display:none"></div>
        <div style="margin-top:24px;display:flex;justify-content:flex-end">
          <button onclick="step1Next()" style="padding:9px 20px;background:#16a34a;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">Review →</button>
        </div>
      </div>
      <!-- Step 2: Confirmation -->
      <div id="step2" style="padding:24px;display:none">
        <div style="background:#f5f4f1;border-radius:6px;padding:16px 18px;margin-bottom:20px">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#888;margin-bottom:10px">New Org Summary</div>
          <div id="confirm-summary" style="font-size:13px;line-height:1.8;color:#333"></div>
        </div>
        <div style="font-size:12px;color:#e55;background:#fff3f3;border:1px solid #fcc;border-radius:5px;padding:10px 14px;margin-bottom:20px">
          ⚠️ This will immediately add the org to the live server. Reports will be accessible at their URLs right away.
        </div>
        <div id="step2-error" style="margin-bottom:12px;color:#e55;font-size:12px;display:none"></div>
        <div style="display:flex;justify-content:space-between">
          <button onclick="backToStep1()" style="padding:9px 16px;background:none;border:1px solid #ddd;border-radius:5px;font-size:13px;cursor:pointer">← Back</button>
          <button id="confirm-btn" onclick="confirmCreate()" style="padding:9px 22px;background:#16a34a;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">✓ Confirm &amp; Create</button>
        </div>
      </div>
    </div>
  </div>
  <div class="main">
    <div class="page-title">Organizations</div>
    ${orgSections}
    <!-- ── Metabase Links editor (all orgs; dashboard-level) ── -->
    <div class="org-section" id="mb-links-section">
      <div class="org-header">
        <div class="org-header-text">
          <div class="org-name">&#128279; Metabase Links</div>
          <div class="org-slug">Update the public Metabase link for any report, on any org</div>
        </div>
      </div>
      <div id="mb-locked" style="padding:16px 20px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input id="mb-pwd" type="password" placeholder="Admin password" onkeydown="if(event.key==='Enter')mbUnlock()" style="flex:1;min-width:220px;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px" />
          <button id="mb-unlock-btn" onclick="mbUnlock()" style="padding:9px 22px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Unlock</button>
        </div>
        <div id="mb-locked-err" style="margin-top:10px;color:#dc2626;font-size:12px;display:none"></div>
        <div style="margin-top:10px;font-size:11.5px;color:#999;line-height:1.5">Update the public Metabase link for any report. Saving commits the change to <code style="font-family:monospace;background:#f0ede8;padding:1px 5px;border-radius:3px">server.js</code> and the Railway app redeploys automatically (~1&ndash;2 min).</div>
      </div>
      <div id="mb-unlocked" style="display:none">
        <div id="mb-links-list"></div>
      </div>
    </div>

    <!-- ── Metabase Link edit modal ── -->
    <div id="mb-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;overflow-y:auto;padding:40px 16px">
      <div style="background:#fff;border-radius:10px;max-width:520px;margin:0 auto;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:18px 22px;background:#2c2c2c;color:#fff;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:700;font-size:15px" id="mb-modal-title">Update Metabase Link</div>
            <div style="font-size:11px;color:#aaa;margin-top:2px" id="mb-modal-sub"></div>
          </div>
          <button onclick="mbCloseModal()" style="background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:4px">&#10005;</button>
        </div>
        <div style="padding:22px">
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;display:block;margin-bottom:6px">Current public link</label>
          <input id="mb-modal-current" type="text" readonly style="width:100%;padding:8px 10px;border:1px solid #eee;background:#f7f7f5;border-radius:5px;font-size:12px;font-family:monospace;color:#666;margin-bottom:16px;box-sizing:border-box" />
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;display:block;margin-bottom:6px">New public link or UUID</label>
          <input id="mb-modal-input" type="text" placeholder="https://rec.metabaseapp.com/public/question/..." style="width:100%;padding:9px 11px;border:1px solid #ddd;border-radius:5px;font-size:12px;font-family:monospace;box-sizing:border-box" />
          <div id="mb-modal-err" style="margin-top:10px;color:#dc2626;font-size:12px;display:none"></div>
        </div>
        <div style="padding:0 22px 22px;display:flex;justify-content:flex-end;gap:10px">
          <button onclick="mbCloseModal()" style="padding:9px 16px;background:none;border:1px solid #ddd;border-radius:5px;font-size:13px;cursor:pointer">Cancel</button>
          <button id="mb-modal-save" onclick="mbSaveLink()" style="padding:9px 22px;background:#16a34a;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">Save &amp; Deploy</button>
        </div>
      </div>
    </div>

    <div id="add-report-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;overflow-y:auto;padding:40px 16px">
      <div style="background:#fff;border-radius:10px;max-width:560px;margin:0 auto;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:18px 22px;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:700;font-size:15px">Add reports</div>
            <div style="font-size:11px;color:#dcfce7;margin-top:2px" id="add-report-sub"></div>
          </div>
          <button onclick="closeAddReport()" style="background:none;border:none;color:#dcfce7;font-size:20px;cursor:pointer;padding:4px">&#10005;</button>
        </div>
        <div style="padding:22px">
          <p style="font-size:12px;color:#666;margin:0 0 16px">Paste the Metabase <strong>public link</strong> (or UUID) for each report you want to add. Leave a field blank to skip it. Existing report links aren&rsquo;t changed.</p>
          <div id="add-report-fields"></div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;display:block;margin:4px 0 6px">Dashboard password</label>
          <input id="add-report-pwd" type="password" placeholder="Dashboard password" style="width:100%;padding:9px 11px;border:1px solid #ddd;border-radius:5px;font-size:13px;box-sizing:border-box" />
          <div id="add-report-err" style="margin-top:10px;color:#dc2626;font-size:12px;display:none"></div>
        </div>
        <div style="padding:0 22px 22px;display:flex;justify-content:flex-end;gap:10px">
          <button onclick="closeAddReport()" style="padding:9px 16px;background:none;border:1px solid #ddd;border-radius:5px;font-size:13px;cursor:pointer">Cancel</button>
          <button id="add-report-save" onclick="submitAddReports()" style="padding:9px 22px;background:#16a34a;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">Add &amp; Deploy</button>
        </div>
      </div>
    </div>

    <div class="org-section" id="app-control-section">
      <div class="org-header" style="cursor:default">
        <div class="org-header-text">
          <div class="org-name">&#9851;&#65039; App Control</div>
          <div style="font-size:12px;color:#999;margin-top:2px">Redeploy the latest build on Railway</div>
        </div>
      </div>
      <div style="padding:14px 18px;background:#f5f4f1;border-top:1px solid #e8e5df">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <input type="password" id="restart-pwd" placeholder="Dashboard password"
                 onkeydown="if(event.key==='Enter')doRestart()"
                 style="padding:8px 12px;border:1px solid #d8d4cc;border-radius:5px;font-size:13px;min-width:200px" />
          <button id="restart-btn" onclick="doRestart()"
                  style="padding:8px 18px;background:#dc2626;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">Restart app</button>
          <span id="restart-status" style="font-size:13px;font-weight:600"></span>
        </div>
        <div style="font-size:11px;color:#999;margin-top:8px">Redeploys the current build (no new code). Requires <code>RAILWAY_API_TOKEN</code> set in Railway. The app will briefly drop connections while it restarts.</div>
      </div>
    </div>

    <div class="org-section">
      <div class="org-header" onclick="toggleHow(this)" style="cursor:pointer;user-select:none">
        <div class="org-header-text">
          <div class="org-name">&#128203; Updates <span class="updates-count" id="updates-count"></span></div>
        </div>
        <span class="how-chevron">&#9658;</span>
      </div>
      <div class="how-body">
        <div class="updates-list" id="updates-list"></div>
      </div>
    </div>

    <div class="org-section">
      <div class="org-header" onclick="toggleHow(this)" style="cursor:pointer;user-select:none">
        <div class="org-header-text">
          <div class="org-name">&#9881;&#65039; How This Works</div>
        </div>
        <span class="how-chevron">&#9658;</span>
      </div>
      <div class="how-body">
        <h4>Architecture</h4>
        <p>This is a lightweight Node.js/Express app deployed on Railway. It sits between your rec.us Metabase instance and your staff, turning flat SQL query results into grouped, printable, interactive reports.</p>
        <div class="how-arch">
          <span class="how-arch-box">Staff browser</span>
          <span class="how-arch-arrow">&#8594;</span>
          <span class="how-arch-box">Railway (this app)</span>
          <span class="how-arch-arrow">&#8594;</span>
          <span class="how-arch-box">Metabase public API</span>
          <span class="how-arch-arrow">&#8594;</span>
          <span class="how-arch-box">rec.us PostgreSQL</span>
        </div>
        <p style="margin-top:8px">The server proxies all Metabase requests server-side &#8212; this avoids CORS issues since Metabase doesn&#39;t send browser-friendly headers. Staff never interact with Metabase directly.</p>

        <h4>Access &amp; Security</h4>
        <p>Two layers of access control protect this deployment:</p>
        <ul>
          <li><strong>Admin dashboard</strong> (this page, at <code>/</code>) is gated by HTTP Basic auth using the <code>DASHBOARD_PASSWORD</code> env var. Only authorized staff see the full org list, subscriber counts, and access tokens.</li>
          <li><strong>Per-org reports</strong> are protected by 16-character access tokens. Every <code>/:org/*</code> URL requires <code>?token=...</code> matching the org&#39;s configured token; a mismatch returns a generic 404 (no info leak about which orgs exist). Tokens are embedded in the URLs each org receives, so staff can bookmark and share without re-authenticating.</li>
        </ul>
        <p>Tokens are visible in the &#129312; <strong>Access Token</strong> row on each org card &#8212; click <strong>Copy landing URL</strong> to grab a tokenized link ready to share. The <code>/api/*</code> admin endpoints, the cross-org <code>/metrics</code> view, and the public <code>/hotdog</code> page are whitelisted from the token gate.</p>

        <h4>Reports</h4>
        <p>Each report type is a self-contained HTML file served from <code>public/</code>. Reports are React apps loaded via CDN &#8212; no build step required. Data is fetched from <code>/:org/:report/api/data?token=...</code>, which proxies to a Metabase public question UUID configured per org.</p>
        <ul>
          <li><strong>Facility Rental</strong> &#8212; reservations grouped by date and location, with table and calendar views, heatmap summary, and location color coding. Used by Clarksville, Norman, Smyrna, Watertown, Apex.</li>
          <li><strong>GL Code Rollup</strong> &#8212; payment method breakdown by GL code, with bar/pie chart views, refund detail toggle, GL location tags, and a dedicated <strong>ACCT CREDIT</strong> column for organization-credit payments. Used by Clarksville, Norman, Smyrna, Watertown, Littleton, Danvers.</li>
          <li><strong>Class Roster</strong> &#8212; enrolled and cancelled participants by program section, with status filters and Excel/PDF export. Used by Clarksville, Norman, Smyrna, Watertown, The Ranch.</li>
          <li><strong>Programs</strong> &#8212; enrollment and revenue by program and section (Norman, Watertown, and Apex).</li>
          <li><strong>Historic Buildings</strong> &#8212; filtered facility view for historic venue locations (Smyrna only).</li>
          <li><strong>Memberships</strong> &#8212; active and lapsed memberships with auto-renew tracking, MRR estimate, and stale-usage detection (Norman only).</li>
          <li><strong>Product Sales</strong> &#8212; daily revenue, refunds, and net by product, with optional desk-location breakdown (Norman only).</li>
          <li><strong>Calendar</strong> &#8212; public week / list view of the upcoming class and rental schedule, color-coded by activity, with cards that link through to the rec.us section page (Apex only).</li>
        </ul>

        <h4>Inline Metrics</h4>
        <p>Each org card on this dashboard has a &#9656; <strong>&#128200; Metrics</strong> toggle that expands inline to show that org&#39;s usage over the last 30 days &#8212; report opens by type, daily activity sparkline, and top viewers. Data comes from a lightweight in-process counter (no Metabase round-trip). The <strong>View full metrics &rarr;</strong> link opens a deeper dashboard at <code>/:org/metrics</code>.</p>

        <h4>PDF Export</h4>
        <p>PDF generation uses Puppeteer with system Chromium inside the Railway Docker container. The server launches a headless browser, navigates to the report with <code>?_print=1</code> (hides the toolbar) and the org&#39;s access token, waits for the <code>#report-ready</code> DOM marker, then renders a Letter-landscape PDF. The PDF always reflects exactly what the browser renders.</p>

        <h4>Email Subscriptions</h4>
        <p>Subscriber data is stored in <code>data/subscriptions.json</code> on the Railway volume. Three cron jobs run on the server &#8212; daily at 7am, weekly on Monday at 7am, and monthly on the 1st at 7am. Each job filters to matching cadences and sends tokenized report links via the Resend API; the unsubscribe link in each email also carries the token. The Email button in reports uses the same integration for one-off share links.</p>

        <h4>Adding a New Org</h4>
        <p>Click <strong>&#10133; Add Org</strong> above to launch the two-step wizard (org details &rarr; Metabase UUID per report), or manually add an entry to the <code>ORGS</code> map in <code>server.js</code> with a token and Metabase public question UUID per report type. No new HTML files needed &#8212; all report templates are shared across orgs.</p>

        <h4>Environment Variables</h4>
        <ul>
          <li><code>METABASE_URL</code> &#8212; base URL for your Metabase instance</li>
          <li><code>BASE_URL</code> &#8212; public URL of this Railway deployment</li>
          <li><code>DASHBOARD_PASSWORD</code> &#8212; Basic-auth password for the admin dashboard at <code>/</code></li>
          <li><code>RESEND_API_KEY</code> &#8212; API key for email delivery via Resend</li>
          <li><code>FROM_EMAIL</code> / <code>FROM_NAME</code> &#8212; sender identity for outbound emails</li>
          <li><code>DATA_DIR</code> &#8212; path to persistent storage for subscriptions.json</li>
          <li><code>PORT</code> &#8212; server port (Railway sets this automatically)</li>
        </ul>

        <h4>Deployment</h4>
        <p>Auto-deploys from the <code>main</code> branch of <code>danj707/rental-report</code> on GitHub. Every push triggers a Railway redeploy &#8212; typically live in 60&#8211;90 seconds. Uses <code>node:20-slim</code> with system Chromium for Puppeteer.</p>
      </div>
    </div>

    <div class="org-section">
      <div class="org-header">
        <div class="org-header-text">
          <div class="org-name">&#9881;&#65039; Claude Skills</div>
          <div class="org-slug">Instructions Claude uses to perform tasks in this project</div>
        </div>
        <div class="org-header-actions">
          <a href="https://github.com/danj707/rental-report/tree/main/docs/skills" target="_blank" class="org-action-link">View on GitHub &#8599;</a>
        </div>
      </div>
      <div style="padding:14px 20px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#f9f8f6;border:1px solid #e8e5df;border-radius:6px">
          <div>
            <div style="font-size:13px;font-weight:600;color:#222">Add New Org</div>
            <div style="font-size:11.5px;color:#888;margin-top:2px">Onboard a new organization to the rental report platform</div>
          </div>
          <a href="https://github.com/danj707/rental-report/blob/main/docs/skills/add-rec-report-org.md" target="_blank" style="font-size:11px;padding:5px 12px;background:#fff;border:1px solid #ddd;border-radius:4px;color:#444;text-decoration:none;white-space:nowrap">Edit skill &#8599;</a>
        </div>
      </div>
    </div>
  </div>
  <footer>rec.us · ${Object.keys(ORGS).length} organizations</footer>
  <script>
    const metricsCache = {};
    function copyTokenURL(slug, btn) {
      const base = btn.dataset.base || '';
      const url  = window.location.origin + base;
      navigator.clipboard.writeText(url).then(() => {
        const original = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1400);
      }).catch(() => { prompt('Copy this URL:', url); });
    }

    async function toggleMetrics(slug, btn, token) {
      const panel = document.getElementById('metrics-' + slug);
      const open  = panel.style.display !== 'none';
      if (open) {
        panel.style.display = 'none';
        btn.textContent = '▸ 📈 Metrics';
        btn.classList.remove('open');
        return;
      }
      panel.style.display = 'block';
      btn.textContent = '▾ 📈 Metrics';
      btn.classList.add('open');
      if (metricsCache[slug]) { renderMetrics(panel, metricsCache[slug]); return; }
      panel.innerHTML = '<div class="metrics-loading">Loading…</div>';
      try {
        const tokenQS = token ? '&token=' + encodeURIComponent(token) : '';
        const data = await fetch('/' + slug + '/metrics/api/data?days=30' + tokenQS).then(r => r.json());
        metricsCache[slug] = data;
        renderMetrics(panel, data);
      } catch(e) {
        panel.innerHTML = '<div class="metrics-loading" style="color:#e55">Failed to load metrics</div>';
      }
    }
    const REPORT_COLORS = { facility:'#16a34a', gl:'#3b82f6', programs:'#7c3aed', historic:'#d97706', roster:'#0891b2', overview:'#059669' };
    const chartInstances = {};
    // ── Add Org modal ────────────────────────────────────────────────
    const REPORT_META = ${JSON.stringify(Object.fromEntries(Object.entries({
      facility: { label: "Facility Rental Schedule", icon: "📅" },
      gl:       { label: "GL Code Rollup",            icon: "📊" },
      programs: { label: "Program Revenue",           icon: "🎯" },
      historic: { label: "Historic Buildings",        icon: "🏛️" },
      roster:   { label: "Class Roster",              icon: "📋" },
      overview: { label: "Facility Overview",         icon: "📈" },
      products: { label: "Product Sales",         icon: "🛒" },
      memberships: { label: "Memberships",            icon: "🎫" },
    })))};

    function openAddOrg() {
      document.getElementById('add-org-overlay').style.display = 'block';
      document.body.style.overflow = 'hidden';
      buildReportCheckboxes();
    }
    function closeAddOrg() {
      document.getElementById('add-org-overlay').style.display = 'none';
      document.body.style.overflow = '';
      // Reset
      ['f-slug','f-name','f-orgid','f-logo'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('step1').style.display = 'block';
      document.getElementById('step2').style.display = 'none';
      document.getElementById('step1-error').style.display = 'none';
      document.getElementById('step2-error').style.display = 'none';
      document.getElementById('modal-sub').textContent = 'Step 1 of 2 — Org details';
      buildReportCheckboxes();
    }
    document.getElementById('add-org-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('add-org-overlay')) closeAddOrg();
    });

    function buildReportCheckboxes() {
      const box = document.getElementById('report-checkboxes');
      box.innerHTML = Object.entries(REPORT_META).map(([key, m]) => \`
        <label style="display:flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid #ddd;border-radius:5px;cursor:pointer;font-size:13px;user-select:none">
          <input type="checkbox" value="\${key}" onchange="updateMetabaseInputs()" style="cursor:pointer;accent-color:#16a34a" />
          \${m.icon} \${m.label}
        </label>\`).join('');
      updateMetabaseInputs();
    }

    function updateMetabaseInputs() {
      const checked = [...document.querySelectorAll('#report-checkboxes input:checked')].map(i => i.value);
      const wrap = document.getElementById('metabase-inputs');
      wrap.innerHTML = checked.length ? \`
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;margin-bottom:4px">Metabase Public Links</div>
        \${checked.map(r => \`
          <div>
            <label style="font-size:12px;color:#555;display:block;margin-bottom:4px">\${REPORT_META[r].icon} \${REPORT_META[r].label}</label>
            <input type="text" id="mb-\${r}" placeholder="https://rec.metabaseapp.com/public/question/..." style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:5px;font-size:12px;font-family:monospace" />
          </div>\`).join('')}\` : '';
    }

    function extractMbUuid(url) {
      if (!url) return null;
      const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return m ? m[0] : null;
    }

    function step1Next() {
      const err = document.getElementById('step1-error');
      err.style.display = 'none';
      const slug    = document.getElementById('f-slug').value.trim();
      const orgId   = document.getElementById('f-orgid').value.trim();
      const logoUrl = document.getElementById('f-logo').value.trim();
      const checked = [...document.querySelectorAll('#report-checkboxes input:checked')].map(i => i.value);
      if (!slug)    return showErr(err, 'Org slug is required');
      if (!orgId)   return showErr(err, 'Org UUID is required');
      if (!logoUrl) return showErr(err, 'Logo URL is required');
      if (!checked.length) return showErr(err, 'Select at least one report');
      const reports = {};
      for (const r of checked) {
        const uuid = extractMbUuid(document.getElementById(\`mb-\${r}\`)?.value || '');
        if (!uuid) return showErr(err, \`Metabase link required for \${REPORT_META[r].label}\`);
        reports[r] = uuid;
      }
      // Build confirmation summary
      const displayName = document.getElementById('f-name').value.trim() || \`\${slug.charAt(0).toUpperCase()+slug.slice(1)} Parks & Recreation\`;
      const rows = [
        \`<div><strong>Slug:</strong> \${slug}</div>\`,
        \`<div><strong>Display Name:</strong> \${displayName}</div>\`,
        \`<div><strong>Org UUID:</strong> <code style="font-size:11px">\${orgId}</code></div>\`,
        \`<div><strong>Logo:</strong> <img src="\${logoUrl}" style="height:24px;vertical-align:middle;margin-left:6px" onerror="this.style.display='none'" /></div>\`,
        \`<div style="margin-top:6px"><strong>Reports:</strong></div>\`,
        ...Object.entries(reports).map(([r, uuid]) =>
          \`<div style="margin-left:12px;font-size:12px">\${REPORT_META[r].icon} \${REPORT_META[r].label} — <code style="font-size:11px">\${uuid}</code></div>\`)
      ];
      document.getElementById('confirm-summary').innerHTML = rows.join('');
      document.getElementById('step1').style.display = 'none';
      document.getElementById('step2').style.display = 'block';
      document.getElementById('modal-sub').textContent = 'Step 2 of 2 — Confirm';
    }

    function backToStep1() {
      document.getElementById('step1').style.display = 'block';
      document.getElementById('step2').style.display = 'none';
      document.getElementById('modal-sub').textContent = 'Step 1 of 2 — Org details';
    }

    function showErr(el, msg) { el.textContent = msg; el.style.display = 'block'; }

    async function confirmCreate() {
      const btn = document.getElementById('confirm-btn');
      const err = document.getElementById('step2-error');
      btn.disabled = true; btn.textContent = 'Creating…';
      err.style.display = 'none';
      const slug      = document.getElementById('f-slug').value.trim();
      const displayName = document.getElementById('f-name').value.trim() || null;
      const orgId     = document.getElementById('f-orgid').value.trim();
      const logoUrl   = document.getElementById('f-logo').value.trim();
      const checked   = [...document.querySelectorAll('#report-checkboxes input:checked')].map(i => i.value);
      const reports   = {};
      checked.forEach(r => { reports[r] = extractMbUuid(document.getElementById(\`mb-\${r}\`)?.value || ''); });
      try {
        const res  = await fetch('/api/admin/new-org', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, displayName, orgId, logoUrl, reports }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Unknown error');
        if (data.github?.pushed) {
          btn.textContent = '✓ Created & deployed';
          console.log('GitHub commit:', data.github.commitUrl);
        } else {
          btn.textContent = '✓ Created (GitHub push failed)';
          if (data.github?.error) console.warn('GitHub error:', data.github.error);
        }
        setTimeout(() => { closeAddOrg(); window.location.reload(); }, 1500);
      } catch(e) {
        showErr(err, 'Error: ' + e.message);
        btn.disabled = false; btn.textContent = '✓ Confirm & Create';
      }
    }

    function renderMetrics(panel, data) {
      const { summary, daily, totalSubscribers, insights, configuredReports } = data;
      const totalViews   = configuredReports.reduce((n, r) => n + (summary[r]?.view  || 0), 0);
      const totalExports = configuredReports.reduce((n, r) => n + (summary[r]?.excel || 0) + (summary[r]?.pdf || 0), 0);
      const slug = panel.id.replace('metrics-', '');
      const ins = insights || { calls: 0, costUsd: 0 };
      const costStr = '$' + (ins.costUsd || 0).toFixed(ins.costUsd >= 1 ? 2 : 4);

      // Build 30-day label array
      const labels = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        labels.push(d.toISOString().slice(0, 10));
      }

      const datasets = configuredReports
        .filter(r => labels.some(d => daily[d]?.[r]))
        .map(r => ({
          label: r,
          data: labels.map(d => daily[d]?.[r] || 0),
          borderColor: REPORT_COLORS[r] || '#888',
          backgroundColor: (REPORT_COLORS[r] || '#888') + '22',
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.3,
          fill: true,
        }));

      panel.innerHTML = \`
        <div class="metrics-grid">
          <div class="metrics-stat"><div class="metrics-stat-label">Views (30d)</div><div class="metrics-stat-value">\${totalViews}</div></div>
          <div class="metrics-stat"><div class="metrics-stat-label">Exports (30d)</div><div class="metrics-stat-value">\${totalExports}</div></div>
          <div class="metrics-stat"><div class="metrics-stat-label">Subscribers</div><div class="metrics-stat-value">\${totalSubscribers}</div></div>
          <div class="metrics-stat"><div class="metrics-stat-label">AI insights (30d)</div><div class="metrics-stat-value">\${ins.calls}</div><div class="metrics-stat-sub">\${costStr}</div></div>
        </div>
        <div class="metrics-chart-wrap"><canvas id="chart-\${slug}"></canvas></div>\`;

      if (chartInstances[slug]) { chartInstances[slug].destroy(); }
      const ctx = document.getElementById(\`chart-\${slug}\`).getContext('2d');
      chartInstances[slug] = new Chart(ctx, {
        type: 'line',
        data: { labels: labels.map(d => d.slice(5)), datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } },
            tooltip: { mode: 'index', intersect: false },
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 10 } },
            y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 }, grid: { color: '#f0f0f0' } },
          },
        },
      });
    }
  </script>
  <script>
    // ── Add reports to an existing org ─────────────────
    const ADD_REPORT_ORGS = ${JSON.stringify(addReportOrgs)};
    const ADD_REPORT_META = ${JSON.stringify(addReportMeta)};
    let addReportSlug = null;

    function openAddReport(slug) {
      const info = ADD_REPORT_ORGS[slug];
      if (!info || !info.missing || !info.missing.length) return;
      addReportSlug = slug;
      document.getElementById('add-report-sub').textContent = info.displayName + ' · ' + slug;
      document.getElementById('add-report-fields').innerHTML = info.missing.map(function(r) {
        const m = ADD_REPORT_META[r] || { label: r, icon: '📄' };
        return '<div style="margin-bottom:14px">'
          + '<label style="font-size:12px;font-weight:600;color:#333;display:block;margin-bottom:6px">'
          +   (m.icon || '📄') + ' ' + m.label
          +   ' <span style="font-weight:400;color:#aaa">(' + r + ')</span></label>'
          + '<input data-report="' + r + '" class="add-report-input" type="text" '
          +   'placeholder="Metabase public link or UUID" '
          +   'style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:5px;font-size:12px;font-family:monospace;box-sizing:border-box" />'
          + '</div>';
      }).join('');
      const pwd = document.getElementById('add-report-pwd');
      if (mbPwd) pwd.value = mbPwd;
      document.getElementById('add-report-err').style.display = 'none';
      document.getElementById('add-report-overlay').style.display = 'block';
      document.body.style.overflow = 'hidden';
    }

    function closeAddReport() {
      document.getElementById('add-report-overlay').style.display = 'none';
      document.body.style.overflow = '';
      addReportSlug = null;
    }

    async function submitAddReports() {
      if (!addReportSlug) return;
      const err = document.getElementById('add-report-err');
      const btn = document.getElementById('add-report-save');
      const pwd = document.getElementById('add-report-pwd').value.trim();
      err.style.display = 'none';
      if (!pwd) { err.textContent = 'Enter the dashboard password'; err.style.display = 'block'; return; }
      const inputs = Array.prototype.slice.call(document.querySelectorAll('#add-report-fields .add-report-input'));
      const jobs = [];
      for (const inp of inputs) {
        const link = inp.value.trim();
        if (!link) continue;
        const mm = link.toLowerCase().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        if (!mm) { err.textContent = 'Could not find a valid UUID for ' + inp.dataset.report; err.style.display = 'block'; return; }
        jobs.push({ report: inp.dataset.report, link: link });
      }
      if (!jobs.length) { err.textContent = 'Paste at least one Metabase link'; err.style.display = 'block'; return; }
      mbPwd = pwd;
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const added = [];
        for (const job of jobs) {
          const res = await fetch('/api/admin/add-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd, org: addReportSlug, report: job.report, link: job.link }),
          });
          const data = await res.json().catch(function(){ return {}; });
          if (!res.ok || !data.ok) throw new Error(job.report + ': ' + (data.error || ('Failed (' + res.status + ')')));
          added.push(job.report);
        }
        closeAddReport();
        mbToast('Added ' + added.join(', ') + ' — Railway is redeploying (~1–2 min)');
        setTimeout(function(){ location.reload(); }, 1500);
      } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
      } finally {
        btn.disabled = false; btn.textContent = 'Add & Deploy';
      }
    }

    function toggleHow(row) {
      row.querySelector('.how-chevron').classList.toggle('open');
      row.nextElementSibling.classList.toggle('open');
    }

    // ── App restart (Railway redeploy) ───────────────────────────────
    function showRestart(msg, color) {
      const el = document.getElementById('restart-status');
      if (el) { el.textContent = msg; el.style.color = color; }
    }
    async function doRestart() {
      const pwd = (document.getElementById('restart-pwd') || {}).value || '';
      if (!pwd) { showRestart('Enter the dashboard password first', '#dc2626'); return; }
      if (!confirm('Restart the app now? It will briefly drop connections while it redeploys.')) return;
      const btn = document.getElementById('restart-btn');
      if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.style.cursor = 'default'; }
      showRestart('Sending restart\u2026', '#999');
      try {
        const r = await fetch('/api/admin/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) {
          showRestart('\u2713 Restart triggered \u2014 back in ~1\u20132 min', '#16a34a');
        } else {
          showRestart('\u2717 ' + (d.error || ('Failed (' + r.status + ')')), '#dc2626');
          if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }
        }
      } catch (err) {
        // The redeploy can kill our own connection before the response lands.
        showRestart('Request sent \u2014 the app may drop this connection; refresh in ~1\u20132 min', '#999');
      }
    }

    // ── Metabase Links editor (all orgs) ─────────────────────────────
    let mbPwd = '';
    let mbData = [];
    let mbEditing = null;

    async function mbUnlock() {
      const err = document.getElementById('mb-locked-err');
      const btn = document.getElementById('mb-unlock-btn');
      const pwd = document.getElementById('mb-pwd').value;
      err.style.display = 'none';
      if (!pwd) { err.textContent = 'Enter the admin password'; err.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = 'Unlocking…';
      try {
        const res = await fetch('/api/admin/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Unlock failed');
        mbPwd = pwd;
        mbData = data.orgs || [];
        document.getElementById('mb-locked').style.display = 'none';
        document.getElementById('mb-unlocked').style.display = 'block';
        mbRenderList();
      } catch(e) {
        err.textContent = e.message;
        err.style.display = 'block';
      } finally {
        btn.disabled = false; btn.textContent = 'Unlock';
      }
    }

    function mbRenderList() {
      const wrap = document.getElementById('mb-links-list');
      if (!mbData.length) { wrap.innerHTML = '<div style="padding:16px 20px;font-size:12px;color:#999">No reports with Metabase links found.</div>'; return; }
      wrap.innerHTML = mbData.map(org => \`
        <div class="mb-org">
          <div class="mb-org-name">\${org.displayName} · \${org.slug}</div>
          \${org.reports.map(rep => \`
            <div class="mb-row">
              <div class="mb-row-info">
                <div class="mb-row-label">\${rep.label}</div>
                <div class="mb-row-uuid">\${rep.mbUuid}</div>
              </div>
              <button class="mb-edit-btn" onclick="mbOpenModal('\${org.slug}','\${rep.key}')">Update Link</button>
            </div>\`).join('')}
        </div>\`).join('');
    }

    function mbOpenModal(slug, reportKey) {
      const org = mbData.find(o => o.slug === slug);
      const rep = org && org.reports.find(r => r.key === reportKey);
      if (!rep) return;
      mbEditing = { org: slug, report: reportKey };
      document.getElementById('mb-modal-title').textContent = rep.label;
      document.getElementById('mb-modal-sub').textContent = org.displayName + ' · ' + slug;
      document.getElementById('mb-modal-current').value = rep.publicUrl;
      document.getElementById('mb-modal-input').value = '';
      document.getElementById('mb-modal-err').style.display = 'none';
      document.getElementById('mb-modal-overlay').style.display = 'block';
      document.body.style.overflow = 'hidden';
      setTimeout(() => document.getElementById('mb-modal-input').focus(), 50);
    }

    function mbCloseModal() {
      document.getElementById('mb-modal-overlay').style.display = 'none';
      document.body.style.overflow = '';
      mbEditing = null;
    }

    async function mbSaveLink() {
      if (!mbEditing) return;
      const err  = document.getElementById('mb-modal-err');
      const btn  = document.getElementById('mb-modal-save');
      const link = document.getElementById('mb-modal-input').value.trim();
      err.style.display = 'none';
      if (!link) { err.textContent = 'Paste a Metabase public link or UUID'; err.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const res = await fetch('/api/admin/update-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: mbPwd, org: mbEditing.org, report: mbEditing.report, link }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Update failed');
        const org = mbData.find(o => o.slug === mbEditing.org);
        const rep = org && org.reports.find(r => r.key === mbEditing.report);
        if (rep) { rep.mbUuid = data.newUuid; rep.publicUrl = data.publicUrl; }
        mbRenderList();
        mbCloseModal();
        mbToast('Saved — Railway is redeploying (~1–2 min)');
      } catch(e) {
        err.textContent = e.message;
        err.style.display = 'block';
      } finally {
        btn.disabled = false; btn.textContent = 'Save & Deploy';
      }
    }

    function mbToast(msg) {
      let t = document.getElementById('mb-toast');
      if (!t) { t = document.createElement('div'); t.id = 'mb-toast'; t.className = 'mb-toast'; document.body.appendChild(t); }
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3200);
    }

    // ── Updates log ───────────────────────────────────────────────────────
    // Newest first. Add a new entry at the TOP for every change we ship.
    // History below back-filled from the GitHub commit log.
    const UPDATES = [
      { date: '2026-06-08', title: 'Product Sales: Total by Item view', items: [
        'New "Total by Item" toggle aggregates all sales by product across the selected date range, with optional desk-location breakdown',
        'Chart switches to a horizontal bar chart of top products by revenue when in item view',
        'Excel and PDF exports respect the item-summary view',
      ] },
      { date: '2026-06-06', title: 'Admin dashboard: Railway status bar', items: [
        'The admin page now shows a live Railway status bar below the header \u2014 deploy status with colored dot (green/yellow/red), deploy ID and age, server uptime, and memory usage',
        'Auto-refreshes every 60 seconds; requires RAILWAY_API_TOKEN env var',
      ] },
      { date: '2026-06-06', title: 'Program Revenue: program-level redesign', items: [
        'Report is now program-level (one row per program) instead of section-level with grouped sub-rows',
        'New columns: Sections (count), Utilization (enrolled / capacity), Charged, Received, Outstanding',
        'Replaces the old Revenue column and Section/Session enrollment breakdown',
        'Summary cards now show Charged, Received, Outstanding, Refunds, Net Revenue, Enrollments, and Programs \u2014 each with a short description of what it measures',
        'AI Insights blob updated to send per-program charged/received/outstanding data',
        'Excel export updated to match new columns',
      ] },
      { date: '2026-06-06', title: 'Calendar: Present mode, shareable links, org branding', items: [
        'Present mode \u2014 add ?present=1 to any calendar URL for an auto-scrolling kiosk/TV view. Toolbar hidden, larger fonts for readability, loops continuously, auto-refreshes data every 5 min. Press Esc to exit. Present \u25B6 button in toolbar opens it in a new tab',
        'Shareable filtered links \u2014 filter dropdowns now sync to the URL via replaceState (?activity=Tennis&location=Apex+Tennis+Center). Copy the URL and the recipient gets the same filtered view',
        'Filter dropdowns populated from a 6-month lookahead so all activities and locations appear regardless of current week',
        'Org banner with logo and display name at the top of the calendar, injected server-side',
        'Event card borders (semi-transparent white) so adjacent same-color events don\u2019t blend',
        '\u201CFrom\u201D pricing prefix added to list view (was already on the popover)',
        'Doubled hour height in week and day views for better readability',
        'High-contrast white pill for +N more chips inside colored event blocks',
        'Close button (x) centered with flexbox',
      ] },
      { date: '2026-06-06', title: 'Calendar: public access, addable from dashboard, collapsed hours', items: [
        'Calendar is now public \u2014 no token required. Direct links like /apex/calendar and /watertown/calendar are shareable without auth',
        'Calendar report type is now available in the \u201CAdd reports\u201D modal for all orgs',
        'Empty hour blocks are collapsed \u2014 the time grid snaps to 1 hour of padding around actual events instead of showing a fixed 6am\u201310pm range',
      ] },
      { date: '2026-06-05', title: 'Calendar: overlap handling, Day view, descriptions, Watertown', items: [
        'Week view now groups sessions that start within 15 minutes of each other \u2014 the first session renders at its time slot and a \u201C+N more\u201D chip expands to show the rest, keeping dense days readable',
        'New Day view toggle gives full-width detail for a single day with side-by-side columns for overlapping sessions',
        'Session popover now shows the section description (HTML-stripped) and prefixes price with \u201CFrom\u201D since pricing varies by group',
        'Calendar report is now live for Watertown',
      ] },
      { date: '2026-06-05', title: 'Class Roster: PDF matches the filtered view', items: [
        'Exporting a roster to PDF now captures exactly what is on screen — the section filter, the enrolled/cancelled status pills, the chosen form-response questions, and which columns you have shown or hidden all carry through to the PDF',
        'Previously the PDF ignored those filters and printed the full roster with the default columns regardless of what you had set up in the browser',
      ] },
      { date: '2026-06-04', title: 'Calendar: single-row events', items: [
        'Week view now renders every reservation as one compact row regardless of session length (long all-day bookings no longer stretch into tall blocks)',
      ] },
      { date: '2026-06-04', title: 'Public Calendar view for Apex', items: [
        'Apex now has a public Calendar report \u2014 a week and list view of the upcoming class and rental schedule, color-coded by activity, with Full and Waitlist badges and cards that link through to the rec.us section page',
        'The calendar is public-safe: reservee names, emails, phone numbers and notes are stripped from the data before it reaches the page',
      ]},
      { date: '2026-06-02', title: 'Self-serve org creation now generates an access token', items: [
        'Adding an org through the dashboard now auto-generates its access token and validates the org UUID format, so a new org can no longer be created without one',
        'Previously a dashboard-created org had no token; with the per-org gate failing closed, every one of its routes returned Not Found until a token was added by hand',
      ]},
      { date: '2026-06-02', title: 'Joplin is live on the platform', items: [
        'Joplin reports were returning Not Found: the org had no access token, and the per-org gate now fails closed, so every Joplin route was blocked',
        'Added a token for Joplin so its dashboard and GL report load normally',
      ]},
      { date: '2026-06-02', title: 'Class Roster: pick which form-response questions show', items: [
        'Form Responses can be long (camp forms carry 20+ questions per registrant); a new Questions dropdown next to the Form Responses toggle lets you check only the questions you want to see',
        'Each option is labeled by position (Q1, Q2, ...) and truncated, with the full question on hover; All / None buttons are included and the button shows a count like 3/24 when a subset is active',
        'Affects the on-screen roster only; the selection falls back to all questions when a roster with a different form is loaded',
      ]},
      { date: '2026-06-02', title: 'Per-org token gate now fails closed', items: [
        'An org with no access token is now treated as not found instead of being served publicly',
        'Hardens the gate so a future tokenless org can never be exposed by accident',
      ]},
      { date: '2026-06-02', title: 'Token auth on Windham and Midland', items: [
        'Windham and Midland dashboards were reachable without an access token \\u2014 both now require ?token= like every other org',
        'Closes a fail-open gap in the per-org gate where a missing token granted open access',
      ]},
      { date: '2026-06-01', title: 'Share Link now captures the live report state', items: [
        'The Share Link button copies a URL that reproduces what you\\u2019re currently looking at \\u2014 the applied date range and filters \\u2014 the same way the PDF export does',
        'Wired per report: GL, Historic (incl. site type), Program Revenue, Roster (incl. section), Facility (locations + sites), Court Utilization (metric, programs/closures, open hours, locations), and Overview (date range, auto-runs on open)',
        'Products already syncs its filters to the URL, so its share link was already accurate; Memberships (snapshot) and Admin (config) share their plain page link',
      ]},
      { date: '2026-06-01', title: 'Share Link on every report', items: [
        'Every report page now has a floating Share Link button (bottom-right, just above Got Feedback) that opens a modal to copy a shareable link',
        'The link keeps the access token and strips the print flag, so recipients open the report directly with no login',
        'Reports can publish a window.recShareLink hook to bake the live date range into the link; otherwise it copies the current view',
      ]},
      { date: '2026-05-31', title: 'Facility Overview removed from the Add-report list', items: [
        'The \u201c\uFF0B Add report\u201d modal no longer offers Facility Overview as an addable report type',
        'Facility Overview remains a valid report system-wide; it is simply excluded from the self-serve add flow via a NON_ADDABLE_REPORTS guard (enforced in the UI count, the modal, and the /api/admin/add-report endpoint)',
      ]},
      { date: '2026-05-31', title: 'Add reports to existing orgs from the dashboard', items: [
        'Each org card now shows a dashed \u201c\uFF0B Add report\u201d tile for any report types that org is missing',
        'Clicking it opens a modal to paste the Metabase public link (or UUID) for one or more missing reports at once',
        'New POST /api/admin/add-report inserts the report into the org\u2019s block in server.js (auto-deploys via Railway) and updates the running config \u2014 existing report links are never touched',
      ]},
      { date: '2026-05-31', title: 'Program Revenue: Reg Mode + Cancellations columns', items: [
        'Added Reg Mode column (Section-based / Session-based) — gated on data presence, auto-hides for orgs whose SQL hasn\\u2019t been updated',
        'Added Cancellations and Cancellation % columns after Waitlist — gated on data presence',
        'Section/session breakdown is now mode-aware per row: section-based rows show only Sec Enroll/Rev, session-based rows show only Sess Enroll/Rev (non-matching cells are blank)',
        'Details toggle is now hidden when breakdown data is absent, so un-updated orgs (e.g. Apex) see no empty columns or orphaned toggle',
        'Excel export mirrors all new columns and mode-aware suppression',
      ]},
      { date: '2026-05-31', title: 'Juice loader polish', items: [
        'Smoothed the juice-glass loading animation \\u2014 the glass now sloshes gently instead of fully draining, with calmer rising bubbles and a cleaner glass outline',
        'Loading text is now centered directly under the glass and cycles through playful messages (Squeezing the oranges, Juicing!, Adding the pulp, Chilling the glass, Pouring it out)',
      ]},
      { date: '2026-05-31', title: 'More Juice! \\uD83E\\uDDC3 + complete metrics breakdown', items: [
        'New loading animation across every report page \\u2014 a glass filling with fresh juice (bubbles and all), retiring the dancing banana',
        'Usage Metrics now lists every report an org actually has configured \\u2014 Product Sales, Memberships, Facility Overview and Court Utilization were previously missing from the By Report Type table, sparklines, and activity chart',
        'Each report type gets its own badge color and chart color so the breakdown reads at a glance',
      ]},
      { date: '2026-05-31', title: 'Dashboard: app restart + AI-insights metric', items: [
        'New App Control card on the dashboard \u2014 password-protected button to redeploy the latest build on Railway (a clean restart, no new code)',
        'Metrics now track AI-insights usage: each org\u2019s panel shows insight calls and estimated spend over the last 30 days, and the per-org metrics page gets a matching summary card',
        'Insight cost is computed from actual token usage at the active model\u2019s pricing (Haiku by default; overridable via env)',
      ]},
      { date: '2026-05-31', title: 'AI insights on Court Utilization', items: [
        '\\u201CGet insights\\u201D button on the Court Utilization report (Apex) \\u2014 AI-generated analysis cards (opportunity / risk / signal) with a concrete next step each',
        'Reads the on-screen filtered view, so insights honor the active location / programs / closures filters',
        'Backed by Claude Haiku; results cached server-side per filtered view; only court/location aggregates leave \\u2014 no PII, no revenue data',
      ]},
      { date: '2026-05-31', title: 'Updates log + Norman product sales', items: [
        'Added this expandable Updates log to the dashboard (history back-filled from git)',
        'Norman: new daily POS product report on its own Metabase question \u2014 aggregate-by-name default, By Desk toggle, Net/Gross buttons, collapsible dates, filter-honoring Excel/PDF exports',
        'Renamed Norman\u2019s \u201CProduct Sales MoM\u201D card to \u201CProduct Sales\u201D',
      ]},
      { date: '2026-05-29', title: 'Metabase link editor, Midland, polish', items: [
        'All-org Metabase Links editor (password-protected) added to the root dashboard',
        'Onboarded Midland',
        'PDF exports now respect the active location/site filters',
        'No-cache headers on report pages so deploys aren\u2019t masked by stale browser cache',
        'Removed the unused pub_*.html root mirrors \u2014 server serves public/*.html only',
        'Dancing banana loading animation across every report page \uD83C\uDF4C',
      ]},
      { date: '2026-05-28', title: 'Token auth, Memberships, Court Utilization, feedback', items: [
        'Per-org token auth across all /:org/* routes',
        'New Memberships report (Norman)',
        'New Court Utilization report (Apex) with per-court and overall utilization %',
        'GL report: Account Credit card/column, # Pmts / # Rfnds count columns, desk-location filter (Clarksville)',
        '\u201CGot Feedback?\u201D widget on every report',
        'Saved-view subscriptions \u2014 subscribe to a specific filtered view',
      ]},
      { date: '2026-05-27', title: 'Self-service orgs, product filters, How This Works', items: [
        'Admin dashboard can now create new orgs (writes to server.js via GitHub) \u2014 onboarded Littleton and Danvers',
        'Program Revenue report added to Norman',
        'Products report: desk-location picker, refund/net toggles, hide-zero rows',
        'Collapsible \u201CHow This Works\u201D card on the dashboard',
        'New add-rec-report-org Claude skill',
      ]},
      { date: '2026-05-24', title: 'Facility calendar + sharing', items: [
        'Calendar view on the facility report (location colors, hover cards, heatmap strip)',
        'This Week / Next Week quick ranges; click-to-expand day detail with Print/PDF',
        'Email share button + share route',
        'Overview report: location filter, per-location membership/pass attribution',
      ]},
      { date: '2026-05-23', title: 'Apex, dashboard metrics, Hot Dog Counter', items: [
        'Onboarded Apex (location filter, rolling default date range)',
        'Dashboard metrics: 30-day Chart.js timeline; cadence decoupled from date range; add-org modal',
        'Site filter on facility report; clickable org names on the dashboard',
        'Hot Dog Counter: staff claims, leaderboard, 15-min auto-refresh \uD83C\uDF2D',
      ]},
      { date: '2026-05-22', title: 'Roster, Overview, analytics, org pages', items: [
        'Class Roster report with form-response sub-rows (all four orgs + The Ranch)',
        'Facility Overview report',
        'Analytics tracking + metrics dashboard',
        'Org landing page at /:org; org logos in report headers',
        'Hot Dog Counter launched',
      ]},
      { date: '2026-05-16', title: 'Subscriptions + Program Revenue', items: [
        'Program Revenue report (Watertown) with program-name search',
        'Subscriptions link in every report toolbar; report checkboxes load dynamically in admin',
        'Subscription emails send report links instead of PDF attachments',
      ]},
      { date: '2026-05-15', title: 'GL charts', items: [
        'Table / Bar / Pie chart toggle on the GL report',
      ]},
      { date: '2026-05-11', title: 'Watertown GL', items: [
        'Enabled the GL Code Rollup report for Watertown',
      ]},
      { date: '2026-04-13', title: 'Initial build', items: [
        'Express proxy + Puppeteer PDF rendering',
        'Facility Rental Schedule, GL Code Rollup, and Historic Buildings reports',
        'Admin subscriptions page',
        'Onboarded Clarksville, Norman, and Smyrna',
      ]},
    ];

    function renderUpdates() {
      const countEl = document.getElementById('updates-count');
      const listEl  = document.getElementById('updates-list');
      if (!listEl) return;
      if (countEl) countEl.textContent = UPDATES.length;
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      listEl.innerHTML = UPDATES.map(u => \`
        <div class="update-entry">
          <div class="update-date">\${esc(u.date)}</div>
          <div class="update-body">
            <div class="update-title">\${esc(u.title)}</div>
            <ul class="update-items">\${u.items.map(i => \`<li>\${esc(i)}</li>\`).join('')}</ul>
          </div>
        </div>
      \`).join('');
    }
    renderUpdates();

    (function(){
      const ov = document.getElementById('mb-modal-overlay');
      if (ov) ov.addEventListener('click', e => { if (e.target === ov) mbCloseModal(); });
    })();

  </script>
</body>
</html>`);
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`\n  🏛️  rec.us Report Server`);
  console.log(`  ├─ Base URL: ${BASE_URL}`);
  Object.keys(ORGS).forEach(slug => {
    const org = ORGS[slug];
    REPORT_TYPES.forEach(r => {
      if (org[r]?.mbUuid) console.log(`  ├─ ${slug}/${r}  →  ${BASE_URL}/${slug}/${r}`);
    });
    console.log(`  ├─ ${slug}/metrics  →  ${BASE_URL}/${slug}/metrics`);
    console.log(`  ├─ ${slug}/admin    →  ${BASE_URL}/${slug}/admin`);
  });
  console.log(`  └─ Metabase: ${METABASE_URL}\n`);
  console.log(`  📧 Resend: ${RESEND_API_KEY ? "configured" : "NOT CONFIGURED (stub mode)"}\n`);
  console.log(`  📊 Analytics: ${EVENTS_FILE}\n`);

  // Promote any orgs from data/orgs.json into server.js on GitHub.
  // Runs after listen() so startup isn't blocked by GitHub latency.
  migrateDynamicOrgs();
});



