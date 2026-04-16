/**
 * Rental Report Server — Multi-Org
 *
 * Routes:
 *   GET /:org/facility          → serves facility report UI
 *   GET /:org/gl                → serves GL rollup report UI
 *   GET /:org/historic          → serves historic reservations report UI
 *   GET /:org/admin             → serves subscription admin UI
 *   GET /:org/facility/api/data → proxies Metabase facility card
 *   GET /:org/gl/api/data       → proxies Metabase GL card
 *   GET /:org/historic/api/data → proxies Metabase historic card
 *   GET /:org/facility/api/pdf  → Puppeteer PDF of facility report
 *   GET /:org/gl/api/pdf        → Puppeteer PDF of GL report
 *   GET /:org/historic/api/pdf  → Puppeteer PDF of historic report
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

const METABASE_URL  = process.env.METABASE_URL  || "https://rec.metabaseapp.com";
const PORT          = process.env.PORT          || 3100;
const BASE_URL      = process.env.BASE_URL      || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL     = process.env.FROM_EMAIL    || "reports@rec.us";
const FROM_NAME      = process.env.FROM_NAME     || "rec.us Reports";

// ── Org config ───────────────────────────────────────────────────────
const ORGS = {
  clarksville: {
    orgId:   "460566d3-3a51-4387-a7a0-0b010923e40d",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-460566d3-3a51-4387-a7a0-0b010923e40d%2FfullLogo.png%3F1742511257248&w=256&q=75",
    facility: { mbUuid: "21e74d52-f49a-46d6-bc2d-f9348027854f" },
    gl:       { mbUuid: "c6daa914-9ea0-449f-956b-373aa0ac2a8a" },
  },
  norman: {
    orgId:   "574923bd-9e7b-43e0-9e5f-7ce256189cbf",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-574923bd-9e7b-43e0-9e5f-7ce256189cbf%2FfullLogo.png%3F1763816879340&w=256&q=75",
    facility: { mbUuid: "81c43b6d-1776-4a13-9fec-cb6f9e9895bb" },
    gl:       { mbUuid: "46b7e83b-f8ac-4d84-8c5c-4c72ca57cea4" },
  },
  smyrna: {
    orgId:   "efc0724c-8f32-481a-bab3-fc19c724f3a7",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-efc0724c-8f32-481a-bab3-fc19c724f3a7%2FfullLogo.png%3F1771265790459&w=1920&q=75",
    facility: { mbUuid: null },
    historic: { mbUuid: "af3c5388-7deb-4a05-a102-cc31f6c4b9f7" },
    gl:       { mbUuid: null },
  },
  // windham: {
  //   orgId:   "REPLACE_WITH_ORG_UUID",
  //   logoUrl: "https://...",
  //   facility: { mbUuid: "REPLACE_ME" },
  //   gl:       { mbUuid: "REPLACE_ME" },
  // },
};

const REPORT_TYPES = ["facility", "gl", "historic"];

// ── JSON file storage (no native deps) ──────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const LOG_FILE  = path.join(DATA_DIR, "send_log.json");

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// db shim — mimics the sqlite API used below
const db = {
  getSubscriptions(org) {
    return readJSON(SUBS_FILE, []).filter(s => s.org === org && s.active);
  },
  getAllBySchedule(schedule) {
    return readJSON(SUBS_FILE, []).filter(s => s.active && s.schedule === schedule);
  },
  upsertSubscription(org, email, reports, schedule) {
    const subs = readJSON(SUBS_FILE, []);
    const idx  = subs.findIndex(s => s.org === org && s.email === email);
    const now  = new Date().toISOString();
    if (idx >= 0) {
      subs[idx] = { ...subs[idx], reports, schedule, active: 1, updated_at: now };
    } else {
      subs.push({ id: Date.now(), org, email, reports, schedule, active: 1, created_at: now, updated_at: now });
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
    writeJSON(LOG_FILE, log.slice(0, 200)); // keep last 200 entries
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

function getDateRange(schedule) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  if (schedule === "daily") {
    // Yesterday
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return { start: toISO(d), end: toISO(d), label: `Daily — ${toISO(d)}` };
  }
  if (schedule === "weekly") {
    // Last 7 days
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(now); start.setDate(start.getDate() - 7);
    return { start: toISO(start), end: toISO(end), label: `Weekly — ${toISO(start)} to ${toISO(end)}` };
  }
  // monthly — last complete month
  const start = new Date(y, m - 1, 1);
  const end   = new Date(y, m, 0);
  return { start: toISO(start), end: toISO(end), label: `Monthly — ${start.toLocaleString("default",{month:"long",year:"numeric"})}` };
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
async function sendReportEmail(orgSlug, email, reportType, schedule) {
  const { start, end, label } = getDateRange(schedule);
  const orgConfig = ORGS[orgSlug];
  const reportLabel = reportType === "gl"
    ? "GL Code Rollup"
    : reportType === "historic"
      ? "Facility Reservations by Date"
      : "Facility Rental Schedule";
  const filename = `${reportType}-${start}.pdf`;

  let pdfBuffer, status, message;
  try {
    pdfBuffer = await generatePdf(orgSlug, reportType, start, end);
  } catch (err) {
    status = "error"; message = `PDF generation failed: ${err.message}`;
    console.error(`[mail] ${message}`);
    db.appendLog(orgSlug, email, reportType, schedule, status, message);
    return { ok: false, error: message };
  }

  const resend = getResendClient();
  if (!resend) {
    console.log(`[mail] STUB — would send "${reportLabel}" (${label}) to ${email}`);
    db.appendLog(orgSlug, email, reportType, schedule, "sent", "RESEND_API_KEY not configured — stub send");
    return { ok: true, stub: true };
  }

  try {
    const { error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: email,
      subject: `${reportLabel} — ${label}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <img src="${orgConfig.logoUrl}" style="height:40px;margin-bottom:16px" />
          <h2 style="margin:0 0 8px;font-size:18px">${reportLabel}</h2>
          <p style="color:#666;margin:0 0 16px">${label}</p>
          <p style="color:#333">Your scheduled report is attached as a PDF.</p>
          <p style="margin-top:24px">
            <a href="${BASE_URL}/${orgSlug}/${reportType}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;font-weight:600">View Live Report</a>
          </p>
          <p style="margin-top:32px;font-size:11px;color:#aaa">
            You're receiving this because you subscribed at ${BASE_URL}/${orgSlug}/admin.<br>
            To unsubscribe, visit that page and remove your email.
          </p>
        </div>`,
      attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
    });
    if (error) throw new Error(error.message);
    status = "sent"; message = null;
    console.log(`[mail] Sent "${reportLabel}" to ${email}`);
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
    const reports = JSON.parse(sub.reports);
    for (const report of reports) {
      await sendReportEmail(sub.org, sub.email, report, scheduleType);
    }
  }
  console.log(`[cron] ${scheduleType} sends complete — ${subs.length} subscribers`);
}

// ── Cron jobs ────────────────────────────────────────────────────────
// Daily   — 7am every day
// Weekly  — 7am every Monday
// Monthly — 7am on the 1st of each month
cron.schedule("0 7 * * *",   () => runSchedule("daily"));
cron.schedule("0 7 * * 1",   () => runSchedule("weekly"));
cron.schedule("0 7 1 * *",   () => runSchedule("monthly"));

// ── Express setup ────────────────────────────────────────────────────
const app = express();
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
    params.push({ type:"date/single", target:["variable",["template-tag","start_date"]], value:parseToISO(query.start_date) });
  }
  if (query.end_date) {
    params.push({ type:"date/single", target:["variable",["template-tag","end_date"]], value:parseToISO(query.end_date) });
  }
  if (reportType === "facility" || reportType === "historic") {
    if (query.location_name) {
      const locations = query.location_name.split(",").map(s => s.trim());
      params.push({ type:"category", target:["variable",["template-tag","location_name"]], value:locations.length===1?locations[0]:locations });
    }
    if (query.site_type) {
      params.push({ type:"category", target:["variable",["template-tag","site_type"]], value:query.site_type });
    }
  }
  return params;
}

// ── Middleware: validate org ─────────────────────────────────────────
function resolveOrg(req, res, next) {
  const { org, report } = req.params;
  if (!ORGS[org]) return res.status(404).send(`Unknown org: "${org}"`);
  if (report && !REPORT_TYPES.includes(report)) return res.status(404).send(`Unknown report: "${report}"`);
  req.orgConfig = ORGS[org];
  req.orgSlug = org;
  req.reportType = report;
  next();
}

// ── GET /:org/:report/api/data ───────────────────────────────────────
app.get("/:org/:report/api/data", resolveOrg, async (req, res) => {
  try {
    const { orgConfig, orgSlug, reportType } = req;
    const mbUuid = orgConfig[reportType]?.mbUuid;
    if (!mbUuid) return res.status(404).json({ error: `No Metabase question configured for ${orgSlug}/${reportType}` });
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
        start_date: req.query.start_date || null,
        end_date: req.query.end_date || null,
        location_name: req.query.location_name || null,
        site_type: req.query.site_type || null,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[proxy] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /:org/:report/api/pdf ────────────────────────────────────────
app.get("/:org/:report/api/pdf", resolveOrg, async (req, res) => {
  try {
    const { orgSlug, reportType } = req;
    const pdf = await generatePdf(orgSlug, reportType,
      req.query.start_date, req.query.end_date);
    const filename = `${reportType}-report-${req.query.start_date || "report"}.pdf`;
    res.set({ "Content-Type":"application/pdf", "Content-Disposition":`inline; filename="${filename}"`, "Content-Length":pdf.length });
    res.send(pdf);
  } catch (err) {
    console.error("[pdf] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Subscription API ─────────────────────────────────────────────────

// GET /:org/admin/subscribers
app.get("/:org/admin/subscribers", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const rows = db.getSubscriptions(req.params.org);
  const log  = db.getLog(req.params.org);
  res.json({ subscribers: rows, log });
});

// POST /:org/admin/subscribe  { email, reports: ["facility","gl","historic"], schedule: "monthly" }
app.post("/:org/admin/subscribe", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const { email, reports, schedule } = req.body;
  if (!email || !reports?.length || !schedule) return res.status(400).json({ error: "email, reports, and schedule are required" });
  if (!["daily","weekly","monthly"].includes(schedule)) return res.status(400).json({ error: "schedule must be daily, weekly, or monthly" });
  const validReports = reports.filter(r => REPORT_TYPES.includes(r));
  if (!validReports.length) return res.status(400).json({ error: "No valid report types" });

  db.upsertSubscription(req.params.org, email.toLowerCase().trim(), validReports, schedule);

  res.json({ ok: true });
});

// DELETE /:org/admin/subscribe  { email }
app.delete("/:org/admin/subscribe", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  db.deleteSubscription(req.params.org, email.toLowerCase().trim());
  res.json({ ok: true });
});

// POST /:org/admin/test-email — test Resend without PDF
app.post('/:org/admin/test-email', async (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: 'Unknown org' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const resend = getResendClient();
  if (!resend) return res.json({ ok: false, error: 'RESEND_API_KEY not configured' });
  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: email,
      subject: 'rec.us Report Server — Test Email',
      html: '<p>This is a test email from the rec.us report server. Resend is working!</p>',
    });
    if (error) throw new Error(JSON.stringify(error));
    console.log('[test-email] Sent to', email, data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[test-email] Error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// POST /:org/admin/test-send  { email, report, schedule }
// Responds immediately and runs PDF generation + send in background
app.post("/:org/admin/test-send", async (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const { email, report, schedule } = req.body;
  if (!email || !report || !schedule) return res.status(400).json({ error: "email, report, and schedule required" });
  // Respond immediately so the browser doesn't time out
  res.json({ ok: true, message: "Sending in background — check the log in a moment" });
  // Fire and forget
  sendReportEmail(req.params.org, email, report, schedule)
    .catch(err => console.error('[test-send] Error:', err));
});

// ── Serve HTML pages ─────────────────────────────────────────────────
app.get("/:org/facility", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  res.sendFile(path.join(__dirname, "public", "facility.html"));
});

app.get("/:org/gl", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  res.sendFile(path.join(__dirname, "public", "gl.html"));
});

app.get("/:org/historic", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  res.sendFile(path.join(__dirname, "public", "historic.html"));
});

app.get("/:org/admin", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ── Root index ───────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const orgs = Object.keys(ORGS);
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px">
    <h2>rec.us Report Server</h2>
    <ul>
      ${orgs.map(o => {
        const org = ORGS[o];
        const links = [];
        if (org.facility?.mbUuid) links.push(`<a href="/${o}/facility">Facility</a>`);
        if (org.historic?.mbUuid) links.push(`<a href="/${o}/historic">Historic</a>`);
        if (org.gl?.mbUuid)       links.push(`<a href="/${o}/gl">GL Rollup</a>`);
        links.push(`<a href="/${o}/admin">Admin</a>`);
        return `<li style="margin:8px 0"><strong>${o}</strong> — ${links.join(" | ")}</li>`;
      }).join("")}
    </ul>
    </body></html>
  `);
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`\n  🏛️  rec.us Report Server`);
  console.log(`  ├─ Base URL: ${BASE_URL}`);
  Object.keys(ORGS).forEach(slug => {
    const org = ORGS[slug];
    if (org.facility?.mbUuid) console.log(`  ├─ ${slug}/facility  →  ${BASE_URL}/${slug}/facility`);
    if (org.historic?.mbUuid) console.log(`  ├─ ${slug}/historic  →  ${BASE_URL}/${slug}/historic`);
    if (org.gl?.mbUuid)       console.log(`  ├─ ${slug}/gl        →  ${BASE_URL}/${slug}/gl`);
    console.log(`  ├─ ${slug}/admin     →  ${BASE_URL}/${slug}/admin`);
  });
  console.log(`  └─ Metabase: ${METABASE_URL}\n`);
  console.log(`  📧 Resend: ${RESEND_API_KEY ? "configured" : "NOT CONFIGURED (stub mode)"}\n`);
});
