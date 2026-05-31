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
  },
  apex: {
    token:   "pcj5Qf0Wts7Wzc7P",
    orgId:   "aeba47d0-c97f-49cb-a0e9-93c5af3a68fa",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-aeba47d0-c97f-49cb-a0e9-93c5af3a68fa%2FfullLogo.png%3F1765923560125&w=1920&q=75",
    facility: { mbUuid: "c876b1d7-df79-48c5-abf5-62917dee3534", defaultDateRange: 8, defaultLocationFilter: "Apex Center" },
    programs: { mbUuid: "bf520bbd-4d8d-42ab-9538-37ad630bf58e" },
    "court-utilization": { mbUuid: "82d14a94-78ad-48d6-9531-11e72f53e285" },
  },
  theranch: {
    token:   "mXI0BgPPazLu61jl",
    orgId:   "2d147f38-068c-409e-890d-a8acc88d8079",
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
    orgId:   "8a8a4fb1-c184-4196-a878-75c775ce6252",
    logoUrl: "https://www.midlandtexas.gov/ImageRepository/Document?documentID=10068",
    displayName: "Midland",
    gl      : { mbUuid: "e0e0d020-f22c-4a79-9cc6-760c6afb9f46" },
  },
};

const REPORT_TYPES = ["facility", "gl", "historic", "programs", "roster", "overview", "products", "memberships", "court-utilization"];

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
function logEvent(org, report, event, ip) {
  try {
    const line = JSON.stringify({
      ts:     new Date().toISOString(),
      org,
      report,
      event,
      ip:     ip || null,
    }) + "\n";
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

  const configuredReports = REPORT_TYPES.filter(r => ORGS[org]?.[r]?.mbUuid);
  return { summary, daily, subCounts, subByCadence, totalSubscribers: allSubs.length, configuredReports };
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
  ["locations", "sites", "location_name", "site_type", "desks", "by_desk", "hide_zero", "chart_net", "metric", "programs", "closures", "hrs"].forEach(k => {
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
  if (!org.token) return next();                    // org has no token yet — open access

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
  if (reportType === "roster" && query.section_name) {
    params.push({ type: "text", target: ["variable", ["template-tag", "section_name"]], value: query.section_name });
  }
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
        system: INSIGHTS_SYS_PROMPT,
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

    logEvent(orgSlug, reportType, "insights", req.ip);
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
    programs: { label: "Program Revenue",           icon: "🎯", desc: "Enrollment and revenue by program and section" },
    historic: { label: "Historic Buildings",        icon: "🏛️",  desc: "Reservations for historic building sites" },
    roster:   { label: "Class Roster",              icon: "📋", desc: "Enrolled and cancelled participants by section" },
    overview:    { label: "Facility Overview",         icon: "📈", desc: "Revenue and activity summary by location" },
    products:    { label: "Product Sales",          icon: "🛒", desc: "Daily revenue, refunds, and net by product" },
    memberships: { label: "Memberships",                icon: "🎫", desc: "Active and lapsed memberships with renewal tracking" },
    "court-utilization": { label: "Court Utilization",  icon: "🎾", desc: "Court utilization % or reserved hours by court, split by customer, program, and closure usage" },
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

// ── POST /api/admin/new-org — create a new org dynamically ──────────
// Pushes the new entry to server.js on GitHub (so it lives in code).
// Falls back to data/orgs.json if the GitHub push fails, so the org
// still works until the next deploy or until you can fix the push.
app.post("/api/admin/new-org", dashboardAuth, async (req, res) => {
  const { slug, displayName, orgId, logoUrl, reports } = req.body;

  // Validate slug
  if (!slug || !/^[a-z0-9_-]+$/.test(slug))
    return res.status(400).json({ error: "Slug must be lowercase letters, numbers, hyphens, or underscores" });
  if (ORGS[slug])
    return res.status(400).json({ error: `Org "${slug}" already exists` });
  if (!orgId || !logoUrl)
    return res.status(400).json({ error: "orgId and logoUrl are required" });
  if (!reports || !Object.keys(reports).length)
    return res.status(400).json({ error: "At least one report is required" });

  // Build the new org entry
  const orgEntry = { orgId, logoUrl, displayName: displayName || null };
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
    programs: { label: "Program Revenue",           icon: "🎯", desc: "Enrollment and revenue by program",       color: "#7c3aed" },
    historic: { label: "Historic Buildings",        icon: "🏛️",  desc: "Reservations for historic building sites", color: "#d97706" },
    roster:   { label: "Class Roster",              icon: "📋", desc: "Enrolled and cancelled participants by section", color: "#0891b2" },
    overview:    { label: "Facility Overview",         icon: "📈", desc: "Revenue and activity summary by location",                 color: "#059669" },
    products:    { label: "Product Sales",          icon: "🛒", desc: "Daily revenue, refunds, and net by product",           color: "#0891b2" },
    memberships: { label: "Memberships",                icon: "🎫", desc: "Active and lapsed memberships with renewal tracking",       color: "#db2777" },
    "court-utilization": { label: "Court Utilization",  icon: "🎾", desc: "Court utilization % or reserved hours by court, split by customer, program, and closure usage", color: "#0d9488" },
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
          </div>
          <span class="report-arrow">→</span>
        </a>`;
    });

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
    .report-arrow { font-size: 14px; color: #ccc; flex-shrink: 0; }
    .report-card:hover .report-arrow { color: var(--accent, #888); }
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
      const { summary, daily, totalSubscribers, configuredReports } = data;
      const totalViews   = configuredReports.reduce((n, r) => n + (summary[r]?.view  || 0), 0);
      const totalExports = configuredReports.reduce((n, r) => n + (summary[r]?.excel || 0) + (summary[r]?.pdf || 0), 0);
      const slug = panel.id.replace('metrics-', '');

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
    function toggleHow(row) {
      row.querySelector('.how-chevron').classList.toggle('open');
      row.nextElementSibling.classList.toggle('open');
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



