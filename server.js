/**
 * Rental Report Server — Multi-Org
 *
 * Routes:
 *   GET /:org/facility          → serves facility report UI
 *   GET /:org/gl                → serves GL rollup report UI
 *   GET /:org/historic          → serves historic reservations report UI
 *   GET /:org/programs          → serves program revenue report UI
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
    orgId:   "460566d3-3a51-4387-a7a0-0b010923e40d",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-460566d3-3a51-4387-a7a0-0b010923e40d%2FfullLogo.png%3F1742511257248&w=256&q=75",
    facility: { mbUuid: "21e74d52-f49a-46d6-bc2d-f9348027854f" },
    gl:       { mbUuid: "c6daa914-9ea0-449f-956b-373aa0ac2a8a" },
    roster:   { mbUuid: "ce13ffa2-2bc5-4764-992d-957b4c3a35f9" },
  },
  norman: {
    orgId:   "574923bd-9e7b-43e0-9e5f-7ce256189cbf",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-574923bd-9e7b-43e0-9e5f-7ce256189cbf%2FfullLogo.png%3F1763816879340&w=256&q=75",
    facility: { mbUuid: "81c43b6d-1776-4a13-9fec-cb6f9e9895bb" },
    gl:       { mbUuid: "46b7e83b-f8ac-4d84-8c5c-4c72ca57cea4" },
    roster:   { mbUuid: "b4fb3c1b-b096-4865-8c32-3dc2635d1264" },
    overview: { mbUuid: 'b9b9c665-689a-4158-88ea-1f4512497f58' },
  },
  smyrna: {
    orgId:   "efc0724c-8f32-481a-bab3-fc19c724f3a7",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-efc0724c-8f32-481a-bab3-fc19c724f3a7%2FfullLogo.png%3F1771265790459&w=1920&q=75",
    facility: { mbUuid: "d541c91e-bb92-4103-abc5-940b3edb61b9" },
    historic: { mbUuid: "af3c5388-7deb-4a05-a102-cc31f6c4b9f7" },
    gl:       { mbUuid: "45e050fd-10d7-4010-b616-6a2ec6e5f7ed" },
    roster:   { mbUuid: "462000f0-6be1-4e73-b983-0375668c1a1f" },
  },
  watertown: {
    orgId:   "d781690b-c5a0-43c5-8443-9ae43899528c",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-d781690b-c5a0-43c5-8443-9ae43899528c%2FfullLogo.png%3F1750270261391&w=1920&q=75",
    facility: { mbUuid: "4b64af10-d57f-41af-aad8-b16d12a8f7b8" },
    gl:       { mbUuid: "e0043550-0ab8-429f-bbb0-35911c1190f6" },
    programs: { mbUuid: "d3a3554f-1232-4803-9cc7-5b0f611360b0" },
    roster:   { mbUuid: "4f9861ef-e8ac-4447-bf88-3648c1e54a8b" },
  },
  apex: {
    orgId:   "aeba47d0-c97f-49cb-a0e9-93c5af3a68fa",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-aeba47d0-c97f-49cb-a0e9-93c5af3a68fa%2FfullLogo.png%3F1765923560125&w=1920&q=75",
    facility: { mbUuid: "c876b1d7-df79-48c5-abf5-62917dee3534", defaultDateRange: 8, defaultLocationFilter: "Apex Center" },
  },
  theranch: {
    orgId:   "2d147f38-068c-409e-890d-a8acc88d8079",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-2d147f38-068c-409e-890d-a8acc88d8079%2FfullLogo.jpeg%3F1764460109546&w=2048&q=75",
    roster:  { mbUuid: "09707fab-067c-4297-98c1-3c1c39804333" },
  },
  rec: {
    orgId:       null,
    logoUrl:     null,
    displayName: 'rec.us',
    hotdog: { href: '/hotdog' },
  },
};

const REPORT_TYPES = ["facility", "gl", "historic", "programs", "roster", "overview", "products"];

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
  upsertSubscription(org, email, reports, schedule, locationFilter, dateRange) {
    const subs = readJSON(SUBS_FILE, []);
    const idx  = subs.findIndex(s => s.org === org && s.email === email);
    const now  = new Date().toISOString();
    if (idx >= 0) {
      subs[idx] = { ...subs[idx], reports, schedule, locationFilter: locationFilter || null, dateRange: dateRange || null, active: 1, updated_at: now };
    } else {
      subs.push({ id: Date.now(), org, email, reports, schedule, locationFilter: locationFilter || null, dateRange: dateRange || null, active: 1, created_at: now, updated_at: now });
    }
    writeJSON(SUBS_FILE, subs);
  },
  deleteSubscription(org, email) {
    const subs = readJSON(SUBS_FILE, []).filter(s => !(s.org === org && s.email === email));
    writeJSON(SUBS_FILE, subs);
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
async function generatePdf(orgSlug, reportType, startDate, endDate) {
  const puppeteer = require("puppeteer");
  const qs = new URLSearchParams({ start_date: startDate, end_date: endDate, _print: "1" });
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
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector("#report-ready", { timeout: 30000 });
    const isGL = reportType === "gl";
    return await page.pdf({
      format: "Letter",
      landscape: !isGL,
      printBackground: true,
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
async function sendReportEmail(orgSlug, email, reportType, schedule, locationFilter, dateRange) {
  const resolvedDateRange = dateRange || (reportType === "gl" ? "lastMonth" : "next7");
  const { start, end, label } = getDateRange(resolvedDateRange);
  const orgConfig = ORGS[orgSlug];
  const reportLabel = reportType === "gl"
    ? "GL Code Rollup"
    : reportType === "historic"
      ? "Historic Buildings Schedule"
      : reportType === "programs"
        ? "Program Revenue"
        : reportType === "roster"
          ? "Class Roster"
          : "Facility Rental Schedule";

  const locationParam = (reportType === "facility" && locationFilter) ? `&location_name=${encodeURIComponent(locationFilter)}` : "";
  const reportUrl = `${BASE_URL}/${orgSlug}/${reportType}?start_date=${start}&end_date=${end}${locationParam}`;

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
      subject: `${reportLabel} — ${label}`,
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
            <a href="${BASE_URL}/${orgSlug}/admin" style="color:#bbb">${BASE_URL}/${orgSlug}/admin</a>.<br>
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
      await sendReportEmail(sub.org, sub.email, report, scheduleType, sub.locationFilter, sub.dateRange);
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
    const pdf = await generatePdf(orgSlug, reportType, req.query.start_date, req.query.end_date);
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
  const { email, reports, schedule, locationFilter, dateRange } = req.body;
  if (!email || !reports?.length || !schedule) return res.status(400).json({ error: "email, reports, and schedule are required" });
  if (!["daily","weekly","monthly"].includes(schedule)) return res.status(400).json({ error: "schedule must be daily, weekly, or monthly" });
  const validReports = reports.filter(r => REPORT_TYPES.includes(r));
  if (!validReports.length) return res.status(400).json({ error: "No valid report types" });
  const validDateRanges = ["today","next7","next30","last7","lastMonth"];
  db.upsertSubscription(req.params.org, email.toLowerCase().trim(), validReports, schedule, locationFilter || null, validDateRanges.includes(dateRange) ? dateRange : null);
  res.json({ ok: true });
});

app.delete("/:org/admin/subscribe", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  db.deleteSubscription(req.params.org, email.toLowerCase().trim());
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

app.get("/:org", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");

  const reportMeta = {
    facility: { label: "Facility Rental Schedule", icon: "📅", desc: "Reservations grouped by date and location" },
    gl:       { label: "GL Code Rollup",            icon: "📊", desc: "Payment and refund summary by GL code" },
    programs: { label: "Program Revenue",           icon: "🎯", desc: "Enrollment and revenue by program and section" },
    historic: { label: "Historic Buildings",        icon: "🏛️",  desc: "Reservations for historic building sites" },
    roster:   { label: "Class Roster",              icon: "📋", desc: "Enrolled and cancelled participants by section" },
    overview: { label: "Facility Overview",         icon: "📈", desc: "Revenue and activity summary by location" },
  };

  const available = REPORT_TYPES.filter(r => org[r]?.mbUuid);

  const cards = available.map(r => {
    const m = reportMeta[r] || { label: r, icon: "📄", desc: "" };
    return `
      <a href="/${slug}/${r}" class="card">
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
      <a href="/${slug}/admin" class="admin-link"><span>📧</span> Manage Email Subscriptions</a>
    </div>
  </div>
  <footer>rec.us · ${slug}</footer>
</body>
</html>`);
});

// ── POST /api/admin/new-org — create a new org dynamically ──────────
app.post("/api/admin/new-org", dashboardAuth, (req, res) => {
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

  // Update in-memory ORGS
  ORGS[slug] = orgEntry;

  // Persist to data/orgs.json
  const dynamic = readJSON(ORGS_FILE, {});
  dynamic[slug] = orgEntry;
  writeJSON(ORGS_FILE, dynamic);

  console.log(`[new-org] Created org: ${slug} with reports: ${Object.keys(reports).join(", ")}`);
  res.json({ ok: true, slug, reports: Object.keys(reports) });
});

// ── Root index — all orgs dashboard ─────────────────────────────────
app.get("/", (req, res) => {
  const reportMeta = {
    facility: { label: "Facility Rental Schedule", icon: "📅", desc: "Reservations grouped by date and location", color: "#16a34a" },
    gl:       { label: "GL Code Rollup",            icon: "📊", desc: "Payment and refund summary by GL code",   color: "#3b82f6" },
    programs: { label: "Program Revenue",           icon: "🎯", desc: "Enrollment and revenue by program",       color: "#7c3aed" },
    historic: { label: "Historic Buildings",        icon: "🏛️",  desc: "Reservations for historic building sites", color: "#d97706" },
    roster:   { label: "Class Roster",              icon: "📋", desc: "Enrolled and cancelled participants by section", color: "#0891b2" },
    overview: { label: "Facility Overview",         icon: "📈", desc: "Revenue and activity summary by location",        color: "#059669" },
  };

  const orgSections = Object.entries(ORGS).map(([slug, org]) => {
    const available    = REPORT_TYPES.filter(r => org[r]?.mbUuid);
    const slugTitle    = slug.charAt(0).toUpperCase() + slug.slice(1);
    const displayName  = org.displayName || `${slugTitle} Parks &amp; Recreation`;

    // Standard Metabase-backed report cards
    const cards = available.map(r => {
      const m = reportMeta[r] || { label: r, icon: "📄", desc: "", color: "#888" };
      return `
        <a href="/${slug}/${r}" class="report-card" style="--accent:${m.color}">
          <span class="report-icon">${m.icon}</span>
          <div class="report-body">
            <div class="report-label">${m.label}</div>
            <div class="report-desc">${m.desc}</div>
          </div>
          <span class="report-arrow">→</span>
        </a>`;
    });

    // Custom direct-link cards (not org-scoped)
    if (org.hotdog) cards.push(`
        <a href="${org.hotdog.href}" class="report-card" style="--accent:#f97316">
          <span class="report-icon">🌭</span>
          <div class="report-body">
            <div class="report-label">Hot Dog Counter</div>
            <div class="report-desc">Food &amp; concession sales leaderboard</div>
          </div>
          <span class="report-arrow">→</span>
        </a>`);

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
      adminLink = `<a href="/${slug}/admin" class="org-action-link" title="${total} subscriber${total!==1?'s':''}">📧 Admin${badge}</a>`;
    }
    const headerActions = adminLink ? `<div class="org-header-actions">${adminLink}</div>` : "";

    // Inline metrics toggle (only for orgs with orgId)
    const metricsToggle = org.orgId ? `
        <div class="metrics-toggle-row">
          <button class="metrics-toggle-btn" onclick="toggleMetrics('${slug}', this)">▸ 📈 Metrics</button>
          <a href="/${slug}/metrics" class="metrics-full-link">View full metrics →</a>
        </div>
        <div class="metrics-panel" id="metrics-${slug}" style="display:none"></div>` : "";

    const orgNameHtml = org.orgId
      ? `<a href="/${slug}" class="org-name-link">${displayName}</a>`
      : `<span>${displayName}</span>`;

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
    footer { text-align: center; padding: 24px; font-size: 11px; color: #bbb; }
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
  </div>
  <footer>rec.us · ${Object.keys(ORGS).length} organizations</footer>
  <script>
    const metricsCache = {};
    async function toggleMetrics(slug, btn) {
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
        const data = await fetch('/' + slug + '/metrics/api/data?days=30').then(r => r.json());
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
        closeAddOrg();
        window.location.reload();
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
});
