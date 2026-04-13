/**
 * Rental Report Server
 *
 * Routes:
 *   GET /                → serves the report UI (public/index.html)
 *   GET /api/data        → proxies Metabase public card API (solves CORS)
 *   GET /api/pdf         → renders the report with Puppeteer, returns PDF
 *
 * Query params accepted on all routes (passed through to Metabase):
 *   start_date, end_date, location_name, site_type
 */

const express = require("express");
const path = require("path");

// ── Config (use env vars or defaults) ───────────────────────────────
const METABASE_URL = process.env.METABASE_URL || "https://your-metabase.com";
const METABASE_PUBLIC_UUID = process.env.METABASE_PUBLIC_UUID || "REPLACE_ME";
const PORT = process.env.PORT || 3100;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ORG_NAME = process.env.ORG_NAME || "Clarksville Parks and Recreation";

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// ── Parse dates flexibly ─────────────────────────────────────────────
// Handles: "March 1, 2026", "2026-03-01", "03/01/2026", "Mar 1, 2026"
function parseToISO(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();

  // Already ISO? (2026-03-01)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Try native Date parse — works for "March 1, 2026", "Mar 1, 2026", etc.
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Fallback: return as-is and let Metabase try
  console.warn(`[date] Could not parse "${dateStr}", passing through raw`);
  return s;
}

// ── Build Metabase parameters array from query string ───────────────
function buildMetabaseParams(query) {
  const params = [];

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
  if (query.location_name) {
    // Supports comma-separated values for multi-select
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

  return params;
}

// ── GET /api/data — proxy to Metabase public API ────────────────────
app.get("/api/data", async (req, res) => {
  try {
    const params = buildMetabaseParams(req.query);
    const paramStr =
      params.length > 0
        ? `?parameters=${encodeURIComponent(JSON.stringify(params))}`
        : "";

    const url = `${METABASE_URL}/api/public/card/${METABASE_PUBLIC_UUID}/query/json${paramStr}`;

    console.log(`[proxy] Fetching: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      console.error(`[proxy] Metabase returned ${response.status}: ${body}`);
      return res.status(response.status).json({ error: body });
    }

    const data = await response.json();

    // Also pass along the org name and filter context
    res.json({
      rows: data,
      meta: {
        org_name: ORG_NAME,
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

// ── GET /api/pdf — render report with Puppeteer, return PDF ─────────
app.get("/api/pdf", async (req, res) => {
  let browser;
  try {
    const puppeteer = require("puppeteer");

    // Build the report URL with the same query params
    const qs = new URLSearchParams(req.query).toString();
    const reportUrl = `${BASE_URL}/?${qs}&_print=1`;

    console.log(`[pdf] Rendering: ${reportUrl}`);

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.goto(reportUrl, { waitUntil: "networkidle0", timeout: 30000 });

    // Wait for the report to signal it's done loading
    await page.waitForSelector("#report-ready", { timeout: 15000 });

    const pdf = await page.pdf({
      format: "Letter",
      landscape: true,
      printBackground: true,
      margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `
        <div style="font-size:9px; width:100%; padding:0 0.4in; display:flex; justify-content:space-between; color:#888;">
          <span>${ORG_NAME}</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>
      `,
    });

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="rental-schedule-${
        req.query.start_date || "report"
      }.pdf"`,
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

// ── Serve index.html for the root and any unmatched routes ──────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n  🏛️  Rental Report Server`);
  console.log(`  ├─ Report UI:  ${BASE_URL}/`);
  console.log(`  ├─ Data API:   ${BASE_URL}/api/data`);
  console.log(`  ├─ PDF API:    ${BASE_URL}/api/pdf`);
  console.log(`  └─ Metabase:   ${METABASE_URL}/api/public/card/${METABASE_PUBLIC_UUID}\n`);
});
