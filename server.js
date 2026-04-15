/**
 * Rental Report Server — Multi-Org
 *
 * Routes:
 *   GET /:org/facility          → serves facility report UI
 *   GET /:org/gl                → serves GL rollup report UI
 *   GET /:org/facility/api/data → proxies Metabase facility card
 *   GET /:org/gl/api/data       → proxies Metabase GL card
 *   GET /:org/facility/api/pdf  → Puppeteer PDF of facility report
 *   GET /:org/gl/api/pdf        → Puppeteer PDF of GL report
 *
 * Add new orgs to the ORGS map below.
 */

const express = require("express");
const path = require("path");

const METABASE_URL = process.env.METABASE_URL || "https://rec.metabaseapp.com";
const PORT = process.env.PORT || 3100;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Org config ───────────────────────────────────────────────────────
// Each org slug maps to:
//   orgId   — rec.us organization UUID (passed to Metabase as {{org_id}})
//   logoUrl — displayed in report header
//   facility/gl mbUuid — Metabase public question UUID for each report type
//
// The org *name* comes from the data ("Org Name" column), not from here.
const ORGS = {
  clarksville: {
    orgId:   "460566d3-3a51-4387-a7a0-0b010923e40d",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-460566d3-3a51-4387-a7a0-0b010923e40d%2FfullLogo.png%3F1742511257248&w=256&q=75",
    facility: { mbUuid: "21e74d52-f49a-46d6-bc2d-f9348027854f" },
    gl:       { mbUuid: "c6daa914-9ea0-449f-956b-373aa0ac2a8a" },
  },
    norman: {
    orgId:   "574923bd-9e7b-43e0-9e5f-7ce256189cbf",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-574923bd-9e7b-43e0-9e5f-7ce256189cbf%2FfullLogo.png%3F1763816879340&w=1920&q=75",
    facility: { mbUuid: "81c43b6d-1776-4a13-9fec-cb6f9e9895bb" },
    gl:       { mbUuid: "46b7e83b-f8ac-4d84-8c5c-4c72ca57cea4" },
  },
  // windham: {
  //   orgId:   "REPLACE_WITH_ORG_UUID",
  //   logoUrl: "https://...",
  //   facility: { mbUuid: "REPLACE_ME" },
  //   gl:       { mbUuid: "REPLACE_ME" },
  // },
};

const REPORT_TYPES = ["facility", "gl"];

const app = express();

// ── Parse dates flexibly ─────────────────────────────────────────────
function parseToISO(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  console.warn(`[date] Could not parse "${dateStr}", passing through raw`);
  return s;
}

// ── Build Metabase parameters array ─────────────────────────────────
function buildMetabaseParams(query, reportType, orgId) {
  const params = [];

  // Pass org ID so parameterized Metabase questions can filter by org.
  // Requires {{org_id}} template variable in the SQL. Safe to include even
  // for questions with org_id hardcoded — Metabase ignores unknown params.
  if (orgId) {
    params.push({
      type: 'category',
      target: ['variable', ['template-tag', 'org_id']],
      value: orgId,
    });
  }

  if (query.start_date) {
    params.push({
      type: "date/single",
      target: ["variable", ["template-tag", "start_date"]],
      value: parseToISO(query.start_date),
    });
  }
  if (query.end_date) {
    params.push({
      type: "date/single",
      target: ["variable", ["template-tag", "end_date"]],
      value: parseToISO(query.end_date),
    });
  }

  // Facility-only filters
  if (reportType === "facility") {
    if (query.location_name) {
      const locations = query.location_name.split(",").map((s) => s.trim());
      params.push({
        type: "category",
        target: ["variable", ["template-tag", "location_name"]],
        value: locations.length === 1 ? locations[0] : locations,
      });
    }
    if (query.site_type) {
      params.push({
        type: "category",
        target: ["variable", ["template-tag", "site_type"]],
        value: query.site_type,
      });
    }
  }

  return params;
}

// ── Validate org + report middleware ────────────────────────────────
function resolveOrg(req, res, next) {
  const { org, report } = req.params;
  if (!ORGS[org]) {
    return res.status(404).send(`Unknown org: "${org}". Valid orgs: ${Object.keys(ORGS).join(", ")}`);
  }
  if (!REPORT_TYPES.includes(report)) {
    return res.status(404).send(`Unknown report type: "${report}". Valid types: ${REPORT_TYPES.join(", ")}`);
  }
  req.orgConfig = ORGS[org];
  req.orgSlug = org;
  req.reportType = report;
  next();
}

// ── GET /:org/:report/api/data ───────────────────────────────────────
app.get("/:org/:report/api/data", resolveOrg, async (req, res) => {
  try {
    const { orgConfig, orgSlug, reportType } = req;
    const mbUuid = orgConfig[reportType].mbUuid;
    const params = buildMetabaseParams(req.query, reportType, orgConfig.orgId);

    const paramStr = params.length > 0
      ? `?parameters=${encodeURIComponent(JSON.stringify(params))}`
      : "";

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
  let browser;
  try {
    const puppeteer = require("puppeteer");
    const { orgSlug, reportType } = req;

    const qs = new URLSearchParams(req.query).toString();
    const reportUrl = `http://localhost:${PORT}/${orgSlug}/${reportType}?${qs}&_print=1`;

    console.log(`[pdf] Rendering: ${reportUrl}`);

    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.goto(reportUrl, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector("#report-ready", { timeout: 30000 });

    const isGL = reportType === "gl";

    const pdf = await page.pdf({
      format: "Letter",
      landscape: !isGL,   // GL report fits nicely in portrait; facility needs landscape
      printBackground: true,
      margin: { top: "0.4in", bottom: "0.5in", left: "0.4in", right: "0.4in" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `
        <div style="font-size:9px; width:100%; padding:0 0.4in; display:flex; justify-content:space-between; color:#888; font-family:sans-serif;">
          <span>rec.us — ${reportType === "gl" ? "GL Code Rollup" : "Facility Rental Schedule"}</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>
      `,
    });

    const filename = `${reportType}-report-${req.query.start_date || "report"}.pdf`;
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": pdf.length,
    });
    res.send(pdf);
  } catch (err) {
    console.error("[pdf] Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Serve report HTML files ──────────────────────────────────────────
app.get("/:org/facility", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  res.sendFile(path.join(__dirname, "public", "facility.html"));
});

app.get("/:org/gl", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  res.sendFile(path.join(__dirname, "public", "gl.html"));
});

// ── Root redirect ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const orgs = Object.keys(ORGS);
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px">
    <h2>rec.us Report Server</h2>
    <ul>
      ${orgs.map(o => `
        <li style="margin:8px 0"><strong>${o}</strong>
          — <a href="/${o}/facility">Facility Report</a>
          | <a href="/${o}/gl">GL Rollup</a>
        </li>`).join("")}
    </ul>
    </body></html>
  `);
});

// ── Static assets ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`\n  🏛️  rec.us Report Server`);
  console.log(`  ├─ Base URL: ${BASE_URL}`);
  Object.keys(ORGS).forEach(slug => {
    console.log(`  ├─ ${slug}/facility  →  ${BASE_URL}/${slug}/facility`);
    console.log(`  ├─ ${slug}/gl        →  ${BASE_URL}/${slug}/gl`);
  });
  console.log(`  └─ Metabase: ${METABASE_URL}\n`);
});
