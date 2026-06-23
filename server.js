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

// ── Langfuse + OpenTelemetry (must init BEFORE other imports) ────────
const { NodeSDK }                = require("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor, isDefaultExportSpan } = require("@langfuse/otel");
const { AnthropicInstrumentation } = require("@arizeai/openinference-instrumentation-anthropic");
const AnthropicSDK = require("@anthropic-ai/sdk");

const _anthropicInstrumentation = new AnthropicInstrumentation();
_anthropicInstrumentation.manuallyInstrument(AnthropicSDK);

const _langfuseEnabled = !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
let _otelSdk = null;
let _langfuseProcessor = null;
if (_langfuseEnabled) {
  _langfuseProcessor = new LangfuseSpanProcessor({
    publicKey:  process.env.LANGFUSE_PUBLIC_KEY,
    secretKey:  process.env.LANGFUSE_SECRET_KEY,
    baseUrl:    process.env.LANGFUSE_BASE_URL || "https://us.cloud.langfuse.com",
    shouldExportSpan: ({ otelSpan }) =>
      isDefaultExportSpan(otelSpan) ||
      otelSpan.instrumentationScope?.name === "@arizeai/openinference-instrumentation-anthropic",
  });
  _otelSdk = new NodeSDK({
    spanProcessors: [_langfuseProcessor],
    instrumentations: [_anthropicInstrumentation],
  });
  _otelSdk.start();
  console.log("[langfuse] OpenTelemetry tracing enabled — baseUrl:", process.env.LANGFUSE_BASE_URL || "(default US)");
} else {
  console.log("[langfuse] LANGFUSE keys not set — tracing disabled (AI features still work)");
}

// Shared Anthropic client — reads ANTHROPIC_API_KEY from env automatically
const anthropic = process.env.ANTHROPIC_API_KEY ? new AnthropicSDK() : null;

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


// ── Metabase response cache ───────────────────────────────────────────
const CACHE_TTL = 60 * 60 * 1000;  // 60-minute default TTL
const REPORT_CACHE_TTL = {
  facility: 30 * 60 * 1000,               // 30 min — live bookings
  gl: 30 * 60 * 1000,                     // 30 min — daily transactions
  roster: 30 * 60 * 1000,                 // 30 min — enrollments change
  programs: 2 * 60 * 60 * 1000,           // 2 hrs — section-level revenue
  memberships: 2 * 60 * 60 * 1000,        // 2 hrs
  products: 2 * 60 * 60 * 1000,           // 2 hrs
  fasttrack: 4 * 60 * 60 * 1000,          // 4 hrs — very stable
  "court-utilization": 4 * 60 * 60 * 1000, // 4 hrs
  "program-demographics": 4 * 60 * 60 * 1000, // 4 hrs
  calendar: 30 * 60 * 1000,               // 30 min — schedule changes
  historic: 2 * 60 * 60 * 1000,           // 2 hrs
  "instructor-payout": 2 * 60 * 60 * 1000, // 2 hrs — section-level payout
};
const dataCache = new Map();
const cacheStats = { hits: 0, misses: 0, prewarms: 0 };

// Long-lived cache for users report (refreshed daily by cron)
const USERS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const usersCache = new Map(); // key: orgSlug → { data: result, ts: Date.now() }

function getCachedUsers(orgSlug) {
  const entry = usersCache.get(orgSlug);
  if (!entry) return null;
  if (Date.now() - entry.ts > USERS_CACHE_TTL) { usersCache.delete(orgSlug); return null; }
  return entry;
}

function setCacheUsers(orgSlug, data) {
  usersCache.set(orgSlug, { data, ts: Date.now() });
}

function getCached(key) {
  const entry = dataCache.get(key);
  if (!entry) { cacheStats.misses++; return null; }
  const ttl = REPORT_CACHE_TTL[entry.rt] || CACHE_TTL;
  if (Date.now() - entry.ts > ttl) { dataCache.delete(key); cacheStats.misses++; return null; }
  cacheStats.hits++;
  return entry.data;
}

function setCache(key, data, reportType) {
  dataCache.set(key, { data, ts: Date.now(), rt: reportType || '' });
}

// Prune expired entries every 30 minutes to prevent memory creep
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dataCache) {
    const ttl = REPORT_CACHE_TTL[v.rt] || CACHE_TTL;
    if (now - v.ts > ttl) dataCache.delete(k);
  }
}, 30 * 60 * 1000);

// ── Org Pulse: monthly metrics from Metabase with month-over-month deltas ──
const pulseCache = new Map();
const PULSE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — refreshed daily by cron

function getCachedPulse(slug) {
  const entry = pulseCache.get(slug);
  if (!entry) return null;
  if (Date.now() - entry.ts > PULSE_CACHE_TTL) { pulseCache.delete(slug); return null; }
  return entry.data;
}

const pulseFmt = (n) => n >= 10000 ? `${(n/1000).toFixed(1)}k` : n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(Math.round(n));
const pulseFmtMoney = (d) => '$' + Math.round(d).toLocaleString('en-US');

async function refreshOrgPulse(slug, force) {
  // Return cached if still fresh (unless force-refreshing)
  if (!force) { const cached = getCachedPulse(slug); if (cached) return cached; }

  const org = ORGS[slug];
  if (!org) return null;

  const now = new Date();
  const curStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const curEnd   = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);
  const prevStart = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().slice(0,10);
  const prevEnd   = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0,10);
  const monthLabel = now.toLocaleString('en-US', { month: 'long' });

  async function fetchMB(reportType, startDate, endDate) {
    const useShared = reportType === "gl" ? (!org.gl?.mbUuid && !!SHARED_UUIDS.gl) : !!SHARED_UUIDS[reportType];
    const mbUuid = useShared ? SHARED_UUIDS[reportType] : (org[reportType]?.mbUuid || SHARED_UUIDS[reportType]);
    if (!mbUuid) return null;
    try {
      const orgId = useShared ? org.orgId : null;
      const params = buildMetabaseParams({ start_date: startDate, end_date: endDate }, reportType, orgId);
      const qs = params.length ? `?parameters=${encodeURIComponent(JSON.stringify(params))}` : '';
      const resp = await fetch(`${METABASE_URL}/api/public/card/${mbUuid}/query/json${qs}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch(e) { console.warn(`[pulse] fetch failed ${slug}/${reportType}: ${e.message}`); return null; }
  }

  const pulse = { items: [], generated: new Date().toISOString(), month: monthLabel };

  // ── GL: revenue + refunds ──
  const [glCur, glPrev] = await Promise.all([
    fetchMB('gl', curStart, curEnd), fetchMB('gl', prevStart, prevEnd)
  ]);
  function sumGL(rows) {
    if (!rows || !rows.length) return { pay: 0, ref: 0 };
    const sk = Object.keys(rows[0]);
    const payK = sk.find(k => /total.?pay/i.test(k)) || 'Total Payments';
    const refK = sk.find(k => /total.?ref/i.test(k)) || 'Total Refunds';
    let pay = 0, ref = 0;
    for (const r of rows) { pay += parseFloat(r[payK]||0); ref += Math.abs(parseFloat(r[refK]||0)); }
    return { pay, ref };
  }
  if (glCur) {
    const cur = sumGL(glCur), prev = sumGL(glPrev||[]);
    const net = cur.pay - cur.ref, prevNet = prev.pay - prev.ref;
    const pct = prevNet ? Math.round((net - prevNet) / Math.abs(prevNet) * 100) : null;
    pulse.items.push({ key:'revenue', label:'Revenue', value: pulseFmtMoney(net), sub: monthLabel, icon:'💰',
      delta: pct !== null ? (pct >= 0 ? `+${pct}%` : `${pct}%`) : null, direction: pct > 0 ? 'up' : pct < 0 ? 'down' : null });
    pulse.items.push({ key:'refunds', label:'Refunds', value: pulseFmtMoney(cur.ref), sub: `${((cur.ref/(cur.pay||1))*100).toFixed(1)}% of gross`, icon:'↩️',
      delta: null, direction: null });
  }

  // ── Programs: enrollments ──
  const [pgCur, pgPrev] = await Promise.all([
    fetchMB('programs', curStart, curEnd), fetchMB('programs', prevStart, prevEnd)
  ]);
  function sumProg(rows) {
    if (!rows || !rows.length) return { enroll: 0, cancel: 0, progs: 0 };
    const sk = Object.keys(rows[0]);
    const eK = sk.find(k => /^enroll/i.test(k)) || 'Enrollments';
    const cK = sk.find(k => /^cancel/i.test(k)) || 'Cancellations';
    const pK = sk.find(k => /^program$/i.test(k)) || 'Program';
    let e = 0, c = 0; const ps = new Set();
    for (const r of rows) { e += parseInt(r[eK])||0; c += parseInt(r[cK])||0; if (r[pK]) ps.add(r[pK]); }
    return { enroll: e, cancel: c, progs: ps.size };
  }
  if (pgCur) {
    const cur = sumProg(pgCur), prev = sumProg(pgPrev||[]);
    const pct = prev.enroll ? Math.round((cur.enroll - prev.enroll) / Math.abs(prev.enroll) * 100) : null;
    pulse.items.push({ key:'enrollments', label:'Enrollments', value: pulseFmt(cur.enroll), sub: `${cur.progs} programs`, icon:'🎓',
      delta: pct !== null ? (pct >= 0 ? `+${pct}%` : `${pct}%`) : null, direction: pct > 0 ? 'up' : pct < 0 ? 'down' : null });
  }

  // ── Facility: bookings ──
  const [facCur, facPrev] = await Promise.all([
    fetchMB('facility', curStart, curEnd), fetchMB('facility', prevStart, prevEnd)
  ]);
  if (facCur) {
    const locs = new Set();
    for (const r of facCur) { const l = r['Location']||r['location']||r['location_name']; if(l) locs.add(l); }
    const cc = facCur.length, pc = facPrev ? facPrev.length : 0;
    const pct = pc ? Math.round((cc - pc) / Math.abs(pc) * 100) : null;
    pulse.items.push({ key:'bookings', label:'Bookings', value: pulseFmt(cc), sub: `${locs.size} locations`, icon:'📅',
      delta: pct !== null ? (pct >= 0 ? `+${pct}%` : `${pct}%`) : null, direction: pct > 0 ? 'up' : pct < 0 ? 'down' : null });
  }

  // ── Products: POS ──
  const [prodCur, prodPrev] = await Promise.all([
    fetchMB('products', curStart, curEnd), fetchMB('products', prevStart, prevEnd)
  ]);
  function sumProd(rows) {
    if (!rows || !rows.length) return 0;
    const sk = Object.keys(rows[0]);
    const gK = sk.find(k => /gross.?rev|net.?rev/i.test(k)) || 'Gross Revenue';
    let t = 0; for (const r of rows) { t += parseFloat(r[gK]||0); } return t;
  }
  if (prodCur) {
    const cur = sumProd(prodCur), prev = sumProd(prodPrev||[]);
    if (cur > 0) {
      const pct = prev ? Math.round((cur - prev) / Math.abs(prev) * 100) : null;
      pulse.items.push({ key:'productRev', label:'Product Sales', value: pulseFmtMoney(cur), sub: `${prodCur.length} line items`, icon:'🛒',
        delta: pct !== null ? (pct >= 0 ? `+${pct}%` : `${pct}%`) : null, direction: pct > 0 ? 'up' : pct < 0 ? 'down' : null });
    }
  }

  // ── Households (snapshot, no date range) ──
  const ue = getCachedUsers(slug);
  if (ue && ue.data && ue.data.rows) {
    const hh = new Set();
    for (const r of ue.data.rows) { const h = r['Household ID']||r['household_id']; if (h) hh.add(h); }
    if (hh.size > 0) pulse.items.push({ key:'households', label:'Households', value: pulseFmt(hh.size), sub: `${pulseFmt(ue.data.rows.length)} people`, icon:'🏠', delta: null, direction: null });
  }

  console.log(`[pulse] ${slug}: ${pulse.items.length} items, ${monthLabel}`);
  pulseCache.set(slug, { data: pulse, ts: Date.now() });
  return pulse;
}

// ── Cache pre-warm on startup ─────────────────────────────────────────
async function prewarmCache() {
  console.log(`[cache] Pre-warming default reports…`);
  let warmed = 0;

  // Build "this month" parameterized cache key so explicit date requests also hit cache
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const monthEnd   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const monthParams = [
    { type: "date/single", target: ["variable", ["template-tag", "start_date"]], value: monthStart },
    { type: "date/single", target: ["variable", ["template-tag", "end_date"]],   value: monthEnd },
  ];
  const monthParamStr = `?parameters=${encodeURIComponent(JSON.stringify(monthParams))}`;

  for (const slug of Object.keys(ORGS)) {
    const org = ORGS[slug];
    if (!org.token) continue;
    for (const rt of REPORT_TYPES) {
      const useShared = rt === "gl" ? (!org.gl?.mbUuid && !!SHARED_UUIDS.gl) : !!SHARED_UUIDS[rt];
      const mbUuid = useShared ? SHARED_UUIDS[rt] : (org[rt]?.mbUuid || SHARED_UUIDS[rt]);
      if (!mbUuid) continue;
      // Only pre-warm reports with no required params (default = current month)
      const cacheKey = `${slug}:${rt}:`;
      if (getCached(cacheKey)) continue; // already warm
      try {
        const timeoutMs = org.healthTimeoutMs || 120000;
        const orgIdParam = useShared && org.orgId
          ? `?parameters=${encodeURIComponent(JSON.stringify([{ type: "string/=", target: ["variable", ["template-tag", "org_id"]], value: org.orgId }]))}`
          : '';
        const url = `${METABASE_URL}/api/public/card/${mbUuid}/query/json${orgIdParam}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (resp.ok) {
          let data = await resp.json();
          // Strip PII for calendar
          if (rt === "calendar" && Array.isArray(data)) {
            const PII = new Set(["reservee","reservee name","customer","customer name","booked by","booker","contact","contact name","notes","note","address","first name","last name","name"]);
            const isPII = (k) => { const t = String(k).toLowerCase().trim(); return PII.has(t) || t.includes("email") || t.includes("phone"); };
            for (const row of data) {
              if (row && typeof row === "object" && !Array.isArray(row)) {
                for (const k of Object.keys(row)) { if (isPII(k)) delete row[k]; }
              }
            }
          }
          const result = {
            rows: data,
            meta: { org_slug: slug, logo_url: org.logoUrl, report_type: rt, generated_at: new Date().toISOString() },
          };
          setCache(cacheKey, result, rt);
          // Also store under the explicit "This Month" cache key so users who
          // click This Month (which sends start_date + end_date params) get a
          // cache hit instead of re-querying Metabase.
          setCache(`${slug}:${rt}:${monthParamStr}`, result, rt);
          warmed++;
          console.log(`[cache] Warmed ${slug}/${rt} (${data.length} rows)`);
        }
      } catch (e) {
        const label = e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message;
        console.warn(`[cache] Pre-warm failed for ${slug}/${rt}: ${label}`);
      }
    }
  }
  cacheStats.prewarms++;
  console.log(`[cache] Pre-warm complete: ${warmed} reports cached (cycle #${cacheStats.prewarms})`);
}

// ── Dashboard authentication ─────────────────────────────────────────
// Set DASHBOARD_PASSWORD in Railway env vars.
// /hotdog and /api/hotdog are public (no auth required).
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const RECOMMEND_ENABLED  = process.env.RECOMMEND_ENABLED === 'true'; // off until rec.us domain is verified in Resend; set RECOMMEND_ENABLED=true to re-enable

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
    roster:   { mbUuid: "ce13ffa2-2bc5-4764-992d-957b4c3a35f9" },
    products: { mbUuid: "b9cae7d1-ea23-4dca-8854-d8689bc2b247" },
    programs: { mbUuid: "776bb123-3109-48d6-b50b-7f1fd161285f" },
    users   : { mbUuid: "4c0f0103-6614-4917-b5da-f09e6a9bef38" },
    memberships: { mbUuid: "df1b17fa-8eee-441a-91f2-97206cbc76b1" },
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
    users   : { mbUuid: "d41e6819-ad60-4709-9323-6f6b5bb32268" },
    fasttrack: { mbUuid: "22aede50-381f-4c0f-935b-730bb3ca35b4" },
  },
  smyrna: {
    token:   "PeNSGslScErlGLyY",
    orgId:   "efc0724c-8f32-481a-bab3-fc19c724f3a7",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-efc0724c-8f32-481a-bab3-fc19c724f3a7%2FfullLogo.png%3F1771265790459&w=1920&q=75",
    facility: { mbUuid: "d541c91e-bb92-4103-abc5-940b3edb61b9" },
    historic: { mbUuid: "66e39b77-199e-4c6f-947d-588ab472720f" },
    roster:   { mbUuid: "462000f0-6be1-4e73-b983-0375668c1a1f" },
    programs: { mbUuid: "ebe20297-455d-4603-aa22-b5560bd5c502" },
    users   : { mbUuid: "f6defe8c-a7bd-418c-8089-160c5fd0cccc" },
    fasttrack: { mbUuid: "9dd20df0-62a7-4016-bbef-51949874431b" },
  },
  watertown: {
    token:   "7qNNXDFo4HGpOh5B",
    orgId:   "d781690b-c5a0-43c5-8443-9ae43899528c",
    calendarPublicUrl: "https://www.watertown-ma.gov/1425/Recreation",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-d781690b-c5a0-43c5-8443-9ae43899528c%2FfullLogo.png%3F1750270261391&w=1920&q=75",
    facility: { mbUuid: "4b64af10-d57f-41af-aad8-b16d12a8f7b8" },
    programs: { mbUuid: "d3a3554f-1232-4803-9cc7-5b0f611360b0" },
    roster:   { mbUuid: "4f9861ef-e8ac-4447-bf88-3648c1e54a8b" },
    calendar: { mbUuid: "70717c4f-9395-4c50-95ac-0622d95567f6" },
    "court-utilization": { mbUuid: "35862f6e-6494-4e6e-89a1-40fee8fbc872" },
    users: { mbUuid: "aa678f93-0099-4677-a2ad-b6eb7724e2d7" },
    fasttrack: { mbUuid: "27005b9e-47c9-42be-9c14-fa2d31099651" },
  },
  apex: {
    token:   "pcj5Qf0Wts7Wzc7P",
    orgId:   "aeba47d0-c97f-49cb-a0e9-93c5af3a68fa",
    healthTimeoutMs: 120000,
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-aeba47d0-c97f-49cb-a0e9-93c5af3a68fa%2FfullLogo.png%3F1765923560125&w=1920&q=75",
    facility: { mbUuid: "c641a437-49c7-49f8-82bd-3417a7e3754b", defaultDateRange: 8, defaultLocationFilter: "Apex Center" },
    programs: { mbUuid: "dee5b922-303f-47d9-abe3-75597410ad67" },
    "court-utilization": { mbUuid: "82d14a94-78ad-48d6-9531-11e72f53e285" },
    calendar: { mbUuid: "8a3dac9b-6c34-45e1-a7d0-3a177477fe17" },
    products: { mbUuid: "b7d1ed06-6df2-4d74-aea2-68d4e2428aec" },
    memberships: { mbUuid: "1e539837-b437-4a12-b1bb-11498b12808b" },
    fasttrack: { mbUuid: "10e8dcdd-2913-4880-b093-d407fc357d76" },
    users   : { mbUuid: "d3b160b8-9da2-4ad1-bbf6-2e5ff67261e9" },
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
  },
  danvers: {
    token:   "9h_PGT17witUK73g",
    orgId:   "a6aef5df-f742-41a2-9088-1fb6d48c3cb1",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-a6aef5df-f742-41a2-9088-1fb6d48c3cb1%2FfullLogo.png%3F1748866523048&w=1920&q=75",
    displayName: "Town of Danvers",
    roster  : { mbUuid: "483df1ab-8e6b-4004-b532-de28bd28c477" },
  },
  midland: {
    token:   "2TiwFAhbgFqcnbbT",
    orgId:   "8a8a4fb1-c184-4196-a878-75c775ce6252",
    logoUrl: "https://www.midlandtexas.gov/ImageRepository/Document?documentID=10068",
    displayName: "Midland",
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
    products: { mbUuid: "2a38a516-a618-40ad-8b30-a26081548389" },
    calendar: { mbUuid: "2b6e6819-2fe5-420e-af6f-4cb39b5736cc" },
  },
  shrewsbury: {
    token:   "17hO58KgKgNVauE5",
    orgId:   "0a9c47af-b4c3-4601-ab0f-d2f401bb787a",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-0a9c47af-b4c3-4601-ab0f-d2f401bb787a%2FfullLogo.png%3F1760543186527&w=2048&q=75",
    displayName: "Shrewsbury",
    facility: { mbUuid: "9a027e73-cd3b-49ff-8b02-49e09a6ceeeb" },
    programs: { mbUuid: "f7863975-f44c-4143-abe8-2ca8c6cdfa07" },
    roster  : { mbUuid: "f79ce808-e7ab-48dc-b2b9-56491f3b01fc" },
    calendar: { mbUuid: "f4e55dd3-f16d-4da7-9112-de0515980ae4" },
    users   : { mbUuid: "d081b9cc-b47e-443c-b97a-dbac97bab249" },
    fasttrack: { mbUuid: "337487eb-7d8d-4def-afec-7ba27f152478" },
    memberships: { mbUuid: "0e5fdd43-c44f-44ec-bb36-73d9306fd61f" },
  },
  westsacramento: {
    token:   "nZMjcPTrSmCSnqqt",
    orgId:   "7d22bf62-060a-4881-9821-9dea6a0538d6",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-7d22bf62-060a-4881-9821-9dea6a0538d6%2FfullLogo.png%3F1764542866233&w=1920&q=75",
    displayName: "City of West Sacramento",
  },
  boerne: {
    token:   "VgvWxiyKNso1x2EB",
    orgId:   "71bf9bc4-cd62-482a-aee5-5d790cdba811",
    logoUrl: "https://www.rec.us/_next/image?url=https%3A%2F%2Fprod-rec-tech-img-bucket-8656aa2.s3.us-west-1.amazonaws.com%2Forganization-71bf9bc4-cd62-482a-aee5-5d790cdba811%2FfullLogo.png%3F1765481856685&w=1920&q=75",
    displayName: "Boerne",
  },
};

const REPORT_TYPES = ["facility", "gl", "historic", "programs", "roster", "overview", "products", "memberships", "court-utilization", "calendar", "fasttrack", "users", "program-demographics", "directors-report", "instructor-payout"];

// ── Shared Metabase UUIDs (one query per report type, parameterized by org_id) ──
// When a report type has an entry here, the server uses this UUID + passes the
// org's orgId as {{org_id}}, instead of using the per-org mbUuid.
// Migrate report types here one at a time; per-org mbUuid is the fallback.
const SHARED_UUIDS = {
  facility: "f6787f45-3a36-4501-8a5f-b0f647451a85",
  programs: "e35f2b47-87c9-40e3-8507-3d9b56f9ce62",
  calendar: "d77a2171-6cc8-4c11-b014-a6ad45491bf4",
  "court-utilization": "7b0fca20-8fe0-4720-9653-7e15c30176b2",
  fasttrack: "9d38ab95-8562-42ca-b6c2-2582b7452457",
  roster: "31bdf26f-0b2e-4ac2-ae31-69edbefd894c",
  memberships: "f4496307-d965-4637-b048-ecc703f2d37f",
  products: "b9678f5f-b5fb-48f7-96da-f22a1b4e8d8a",
  "instructor-payout": "a8db6d86-eddc-4511-a28c-ad4bf636859e",
  users: "0aa0f55d-738f-4df7-837a-eb21f3ee1793",
  gl: "4374b344-06a7-42c5-996c-e1845bda3ff1",
  "program-demographics": "67b77142-19ab-49bd-9d4b-1db8223a3616",
};

// Report types that are valid system-wide but should NOT be offered in the
// dashboard "+ Add report" flow (e.g. not yet ready for self-serve onboarding).
const NON_ADDABLE_REPORTS = new Set(["overview", "program-demographics", "directors-report"]);

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
const SHOWCASE_FILE = path.join(DATA_DIR, "showcase.json");
const VISIBILITY_FILE = path.join(DATA_DIR, "report-visibility.json");
const VOTES_FILE = path.join(DATA_DIR, "votes.json");
const FLAGS_FILE = path.join(DATA_DIR, "feature-flags.json");
const HEALTH_FILE = path.join(DATA_DIR, "health-check.json");
const HEALTH_CONFIG_FILE = path.join(DATA_DIR, "health-config.json");
const QUOTES_FILE = path.join(DATA_DIR, "quotes.json");

// ── Health check tiers ───────────────────────────────────────────────
// Interval in minutes per tier.  "critical" is public-facing (calendar),
// "standard" is the bread-and-butter reports, "low" is niche.
const HEALTH_TIERS = { critical: 60, standard: 360, low: 1440 };

// Default tier per report type (admin can override per org/report)
const DEFAULT_REPORT_TIER = {
  calendar:            "critical",
  facility:            "critical",
  gl:                  "standard",
  programs:            "standard",
  products:            "standard",
  "court-utilization": "standard",
  users:               "standard",
  fasttrack:           "standard",
  memberships:         "standard",
  historic:            "low",
  roster:              "low",
  overview:            "low",
  hotdog:              "low",
};

function loadHealthConfig() {
  try { return JSON.parse(fs.readFileSync(HEALTH_CONFIG_FILE, "utf8")); } catch { return {}; }
}
function saveHealthConfig(cfg) {
  fs.writeFileSync(HEALTH_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Resolve tier for a specific org/report.  Config can override at
// org level ("clarksville": { "_default": "critical" }) or per-report
// ("clarksville": { "gl": "critical" }).
function getTier(slug, report) {
  const cfg = loadHealthConfig();
  const orgCfg = cfg[slug] || {};
  return orgCfg[report] || orgCfg._default || DEFAULT_REPORT_TIER[report] || "standard";
}

function getTierMinutes(tier) {
  return HEALTH_TIERS[tier] || HEALTH_TIERS.standard;
}


// ── Vote tracker ──────────────────────────────────────────────────────
function loadVotes() {
  try { return JSON.parse(fs.readFileSync(VOTES_FILE, "utf8")); } catch (_) { return {}; }
}
function saveVotes(votes) {
  fs.writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2));
}
function recordVote(org, report, sentiment) {
  const votes = loadVotes();
  const key = `${org}:${report}`;
  if (!votes[key]) votes[key] = { up: 0, down: 0 };
  if (sentiment === "up") votes[key].up++;
  else if (sentiment === "down") votes[key].down++;
  saveVotes(votes);
  return votes[key];
}

// ── Health check system ──────────────────────────────────────────────
function loadHealthResults() {
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf8")); } catch { return null; }
}
function saveHealthResults(results) {
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(results, null, 2));
}

async function runHealthCheck(forceAll) {
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const existing = loadHealthResults() || { timestamp: ts, reports: {}, failures: [] };

  // Build list of (slug, report) pairs that are due for a check
  const toCheck = [];
  for (const slug of Object.keys(ORGS)) {
    const org = ORGS[slug];
    if (!org.token) continue;
    for (const rt of REPORT_TYPES) {
      if (!org[rt]?.mbUuid && !SHARED_UUIDS[rt]) continue;
      if (forceAll) { toCheck.push({ slug, rt }); continue; }
      const prev = existing.reports?.[slug]?.[rt];
      const tier = getTier(slug, rt);
      const intervalMs = getTierMinutes(tier) * 60000;
      const lastCheck = prev?.checkedAt ? new Date(prev.checkedAt).getTime() : 0;
      if (now - lastCheck >= intervalMs) toCheck.push({ slug, rt, tier });
    }
  }

  if (toCheck.length === 0) return existing;

  const tierLabel = forceAll ? "manual" : [...new Set(toCheck.map(t => t.tier || "all"))].join("/");
  console.log(`[health] Checking ${toCheck.length} report(s) [${tierLabel}]…`);

  const newFailures = [];

  for (const { slug, rt } of toCheck) {
    const org = ORGS[slug];
    const useSharedHC = rt === "gl" ? (!org.gl?.mbUuid && !!SHARED_UUIDS.gl) : !!SHARED_UUIDS[rt];
    const mbUuid = useSharedHC ? SHARED_UUIDS[rt] : (org[rt]?.mbUuid || SHARED_UUIDS[rt]);
    if (!mbUuid) continue;
    if (!existing.reports[slug]) existing.reports[slug] = {};

    const entry = { status: "ok", rows: 0, checkedAt: ts };
    try {
      const controller = new AbortController();
      const timeoutMs = org.healthTimeoutMs || 60000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const orgIdParamHC = useSharedHC && org.orgId
        ? `?parameters=${encodeURIComponent(JSON.stringify([{ type: "string/=", target: ["variable", ["template-tag", "org_id"]], value: org.orgId }]))}`
        : '';
      const url = `${METABASE_URL}/api/public/card/${mbUuid}/query/json${orgIdParamHC}`;
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!resp.ok) {
        entry.status = "error";
        entry.error = `HTTP ${resp.status}`;
      } else {
        const data = await resp.json();
        entry.rows = Array.isArray(data) ? data.length : 0;
        if (entry.rows === 0) entry.status = "empty";
      }
    } catch (err) {
      entry.status = "error";
      entry.error = err.name === "AbortError" ? `Timeout (${(org.healthTimeoutMs||60000)/1000}s)` : err.message;
    }

    // Carry forward tier info for display
    entry.tier = getTier(slug, rt);

    // Detect NEW failure (wasn't failing before, or was alerted >6h ago)
    if (entry.status === "error") {
      const prev = existing.reports[slug]?.[rt];
      const prevWasError = prev?.status === "error";
      const lastAlerted = prev?.lastAlertedAt ? new Date(prev.lastAlertedAt).getTime() : 0;
      const suppressWindow = 6 * 3600000; // don't re-alert same failure within 6h
      if (!prevWasError || (now - lastAlerted >= suppressWindow)) {
        newFailures.push({ org: slug, report: rt, error: entry.error, tier: entry.tier });
        entry.lastAlertedAt = ts;
      } else {
        entry.lastAlertedAt = prev.lastAlertedAt; // carry forward
      }
    }

    existing.reports[slug][rt] = entry;
  }

  existing.timestamp = ts;
  // Rebuild global failures list from all current results
  existing.failures = [];
  for (const [slug, reports] of Object.entries(existing.reports)) {
    for (const [rt, e] of Object.entries(reports)) {
      if (e.status === "error") existing.failures.push({ org: slug, report: rt, error: e.error });
    }
  }

  saveHealthResults(existing);
  console.log(`[health] Done — ${newFailures.length} new failure(s), ${existing.failures.length} total failing`);

  // Email only for NEW failures (deduped)
  if (newFailures.length > 0) {
    const resend = getResendClient();
    if (resend) {
      const lines = newFailures.map(f => {
        const tierBadge = f.tier === "critical" ? "🔴" : f.tier === "standard" ? "🟡" : "⚪";
        return `${tierBadge} <strong>${f.org}/${f.report}</strong> [${f.tier}]: ${f.error}`;
      }).join("<br>");
      const totalFailing = existing.failures.length;
      try {
        await resend.emails.send({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to: "dan@rec.us",
          subject: `⚠️ ${newFailures.length} new report failure(s) — ${totalFailing} total failing`,
          html: `<p><strong>${newFailures.length}</strong> new failure(s) detected:</p>`
            + `<p style="font-family:monospace;font-size:13px;line-height:1.8">${lines}</p>`
            + (totalFailing > newFailures.length ? `<p style="color:#6b7280;font-size:12px">${totalFailing} report(s) still failing overall</p>` : "")
            + `<p style="color:#6b7280;font-size:12px">Tier schedule: critical=hourly, standard=6h, low=daily<br>Checked at ${ts}</p>`,
        });
        console.log(`[health] Alert email sent (${newFailures.length} new failures)`);
      } catch (e) {
        console.error("[health] Failed to send alert email:", e.message);
      }
    }
  }

  return existing;
}

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

// ── Feature Flags ────────────────────────────────────────────────────
const DEFAULT_FLAGS = { emailSubscriptions: false };
function getFlags() { return Object.assign({}, DEFAULT_FLAGS, readJSON(FLAGS_FILE, {})); }
function setFlag(key, value) { const f = getFlags(); f[key] = value; writeJSON(FLAGS_FILE, f); return f; }

// ── Report visibility (per-org hidden reports) ───────────────────────
function getHiddenReports(slug) {
  const all = readJSON(VISIBILITY_FILE, {});
  return Array.isArray(all[slug]) ? all[slug] : [];
}
function setHiddenReports(slug, list) {
  const all = readJSON(VISIBILITY_FILE, {});
  if (list.length) all[slug] = list; else delete all[slug];
  writeJSON(VISIBILITY_FILE, all);
}
function getAllHiddenReports() {
  return readJSON(VISIBILITY_FILE, {});
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
function logEvent(org, report, event, reqOrIp, extra) {
  try {
    const isReq = reqOrIp && typeof reqOrIp === "object" && reqOrIp.headers;
    const rec = {
      ts:     new Date().toISOString(),
      org,
      report,
      event,
      ip:     isReq ? (reqOrIp.headers["x-forwarded-for"]?.split(",")[0]?.trim() || reqOrIp.ip || null) : (reqOrIp || null),
      ua:     isReq ? (reqOrIp.headers["user-agent"] || null) : null,
      ref:    isReq ? (reqOrIp.headers["referer"] || null) : null,
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
  ["locations", "sites", "location_name", "site_type", "desks", "by_desk", "by_item", "hide_zero", "chart_net", "metric", "programs", "closures", "hrs", "section_name", "status", "questions", "cols", "search", "tab", "instructor", "split"].forEach(k => {
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
        ? "Programs"
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
        ? "Programs"
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
  if (!getFlags().emailSubscriptions) { console.log(`[cron] ${scheduleType} skipped — emailSubscriptions flag is OFF`); return; }
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

// ── Daily pre-warm for users report (runs at 5am) ────────────────────
async function prewarmUsersCache() {
  console.log("[users-cache] Pre-warming users report data…");
  for (const slug of Object.keys(ORGS)) {
    const org = ORGS[slug];
    if (!org.token || !org.users?.mbUuid) continue;
    try {
      const url = `${METABASE_URL}/api/public/card/${org.users.mbUuid}/query/json`;
      console.log(`[users-cache] Fetching ${slug}/users…`);
      const resp = await fetch(url);
      if (!resp.ok) { console.warn(`[users-cache] ${slug} HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      const result = {
        rows: data,
        meta: { org_slug: slug, logo_url: org.logoUrl, report_type: "users", generated_at: new Date().toISOString() },
      };
      setCacheUsers(slug, result);
      console.log(`[users-cache] Cached ${slug}/users (${data.length} rows)`);
    } catch (e) {
      console.warn(`[users-cache] Failed ${slug}: ${e.message}`);
    }
  }
  console.log("[users-cache] Pre-warm complete");
}
cron.schedule("0 5 * * *", prewarmUsersCache); // 5am daily
cron.schedule("10 5 * * *", prewarmPulseCache); // 5:10am daily (after users cache is warm)
cron.schedule("5 * * * *", () => runHealthCheck());  // every hour at :05, checks only what's due per tier

// ── Daily Backup to GitHub Gist ──────────────────────────────────────
const BACKUP_PAT = process.env.GITHUB_PAT || "";
const BACKUP_GIST_ID_FILE = path.join(DATA_DIR, "backup-gist-id.txt");
let _lastBackup = { ts: null, status: "never", size: 0, files: 0, gistUrl: null, error: null };

// Load saved gist ID if it exists
let _backupGistId = "";
try { _backupGistId = fs.existsSync(BACKUP_GIST_ID_FILE) ? fs.readFileSync(BACKUP_GIST_ID_FILE, "utf8").trim() : ""; } catch (_) {}

async function performBackup(manual = false) {
  if (!BACKUP_PAT) {
    console.log("[backup] Skipped — no GITHUB_PAT env var");
    _lastBackup = { ts: new Date().toISOString(), status: "skipped", size: 0, files: 0, gistUrl: null, error: "GITHUB_PAT not set" };
    return _lastBackup;
  }

  console.log(`[backup] Starting ${manual ? "manual" : "scheduled"} backup...`);
  const started = Date.now();

  try {
    // Collect all data files
    const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json") || f.endsWith(".jsonl") || f.endsWith(".txt"));
    const gistFiles = {};
    let totalSize = 0;

    for (const fname of dataFiles) {
      if (fname === "backup-gist-id.txt") continue; // skip the gist ID file itself
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, fname), "utf8");
        gistFiles[fname] = { content };
        totalSize += content.length;
      } catch (e) {
        console.warn(`[backup] Skipped ${fname}: ${e.message}`);
      }
    }

    // Add a metadata file
    gistFiles["_backup_meta.json"] = {
      content: JSON.stringify({
        timestamp: new Date().toISOString(),
        manual,
        fileCount: Object.keys(gistFiles).length,
        totalBytes: totalSize,
        orgCount: Object.keys(ORGS).length,
      }, null, 2)
    };

    const fileCount = Object.keys(gistFiles).length;
    const payload = JSON.stringify({
      description: `rec.us backup — ${new Date().toISOString().split("T")[0]}`,
      public: false,
      files: gistFiles,
    });

    let gistUrl;

    if (_backupGistId) {
      // Update existing gist
      const resp = await fetch(`https://api.github.com/gists/${_backupGistId}`, {
        method: "PATCH",
        headers: {
          Authorization: `token ${BACKUP_PAT}`,
          "Content-Type": "application/json",
          "User-Agent": "rec-backup",
        },
        body: payload,
      });
      if (resp.ok) {
        const data = await resp.json();
        gistUrl = data.html_url;
      } else if (resp.status === 404) {
        // Gist was deleted, create new
        _backupGistId = "";
      } else {
        throw new Error(`Gist update failed: ${resp.status}`);
      }
    }

    if (!_backupGistId) {
      // Create new gist
      const resp = await fetch("https://api.github.com/gists", {
        method: "POST",
        headers: {
          Authorization: `token ${BACKUP_PAT}`,
          "Content-Type": "application/json",
          "User-Agent": "rec-backup",
        },
        body: payload,
      });
      if (!resp.ok) throw new Error(`Gist create failed: ${resp.status}`);
      const data = await resp.json();
      _backupGistId = data.id;
      gistUrl = data.html_url;
      fs.writeFileSync(BACKUP_GIST_ID_FILE, _backupGistId, "utf8");
      console.log(`[backup] Created new gist: ${_backupGistId}`);
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    _lastBackup = {
      ts: new Date().toISOString(),
      status: "ok",
      size: totalSize,
      files: fileCount,
      gistUrl,
      error: null,
      elapsed: `${elapsed}s`,
    };
    console.log(`[backup] Complete — ${fileCount} files, ${(totalSize / 1024).toFixed(1)}KB, ${elapsed}s`);
    return _lastBackup;
  } catch (err) {
    console.error(`[backup] Failed:`, err.message);
    _lastBackup = {
      ts: new Date().toISOString(),
      status: "error",
      size: 0,
      files: 0,
      gistUrl: _lastBackup.gistUrl,
      error: err.message,
    };
    return _lastBackup;
  }
}

// Daily backup at 2am
cron.schedule("0 2 * * *", () => performBackup(false));
// Backup on startup (after 45s)
setTimeout(() => performBackup(false), 45000);


// Also pre-warm on startup (after a short delay to let server settle)
setTimeout(prewarmUsersCache, 15000);
setTimeout(prewarmPulseCache, 30000); // pulse after users (needs users cache for households)

async function prewarmPulseCache() {
  console.log("[pulse] Pre-warming all orgs…");
  let warmed = 0;
  for (const slug of Object.keys(ORGS)) {
    if (!ORGS[slug].token) continue;
    try {
      await refreshOrgPulse(slug, true);
      warmed++;
      console.log(`[pulse] Warmed ${slug}`);
    } catch(e) { console.warn(`[pulse] Failed ${slug}: ${e.message}`); }
  }
  console.log(`[pulse] Pre-warm complete: ${warmed} orgs`);
}

// ── Express setup ────────────────────────────────────────────────────
const app = express();
app.use(dashboardAuth);
app.use(express.json({ limit: "50mb" }));

// ── Backup API routes ──
app.post("/api/admin/backup", async (req, res) => {
  const result = await performBackup(true);
  res.json(result);
});
app.get("/api/admin/backup-status", (req, res) => {
  res.json(_lastBackup);
});

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

  // Calendar + rental calendar are public — no token required
  const segs = req.path.split("/").filter(Boolean);
  if (segs[1] === "calendar" || segs[1] === "rentalcalendar") return next();

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
function buildMetabaseParams(query, reportType, orgId) {
  const params = [];
  if (orgId) {
    params.push({ type: "string/=", target: ["variable", ["template-tag", "org_id"]], value: orgId });
  }
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
  logEvent(orgSlug, reportType, event, req);
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
        ? "Programs"
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

The data contains a "programNames" array listing EVERY program in this dataset. You may ONLY reference program names that appear in that array — no others exist. If the dataset has only 1-3 programs, all 4 insights MUST be about those programs (different angles: revenue, fill rate, refunds, enrollment trends, etc.).

Return EXACTLY 4 insights as a JSON array and nothing else — no prose, no preamble, no markdown code fences. Each element is an object with exactly these keys:
{
  "type": "opportunity" | "risk" | "signal",
  "title": short label, 7 words or fewer,
  "detail": one sentence, 22 words or fewer, citing specific numbers or program names from the data,
  "action": one concrete next step, 12 words or fewer
}

Rules:
- Ground EVERY figure in the data provided. Never invent numbers or program names.
- ONLY reference programs listed in "programNames". If a program name is not in that array, do not mention it.
- Focus on fill rates, cancellation patterns, revenue concentration, enrollment demand (waitlists), and program-level outliers.
- Name specific programs when making observations rather than speaking generally.
- Be terse. No filler. Vary the "type" across the four insights where the data supports it.`;

const FASTTRACK_SYS_PROMPT = `You are a parks & recreation demand analyst for US municipal departments. You are given Fast Track (pre-registration wishlist) data — FT signups, conversion rates, pending counts, enrollment, capacity, fill rates, and demand ratios, all pre-computed.

The data contains a "programNames" array listing EVERY program in this dataset. You may ONLY reference program names that appear in that array — no others exist.

Return EXACTLY 4 insights as a JSON array and nothing else — no prose, no preamble, no markdown code fences. Each element is an object with exactly these keys:
{
  "type": "opportunity" | "risk" | "signal",
  "title": short label, 7 words or fewer,
  "detail": one sentence, 22 words or fewer, citing specific numbers or program names from the data,
  "action": one concrete next step, 12 words or fewer
}

Rules:
- Ground EVERY figure in the data provided. Never invent numbers or program names.
- ONLY reference programs listed in "programNames". If a program name is not in that array, do not mention it.
- Focus on: conversion rate outliers, high-demand/low-capacity mismatches, programs with many pending signups (opportunity to convert), programs with high drop-off, and demand signals that suggest adding capacity or sessions.
- Name specific programs when making observations rather than speaking generally.
- Be terse. No filler. Vary the "type" across the four insights where the data supports it.`;

const USERS_SYS_PROMPT = `You are a parks & recreation demographic analyst for US municipal departments. You are given aggregate HOUSEHOLD demographic data for a single organization \u2014 total people (head-of-household + members/dependents), household sizes, residency rates, age distribution split by role (HoH adults vs member children), gender, grade distribution, signup velocity, geographic distribution, and data completeness metrics, all pre-computed.

Respond ONLY with a valid JSON array of 4\u20136 objects. Each object: {"type":"opportunity|risk|signal","title":"short headline","detail":"1\u20132 sentence explanation with specific numbers","action":"one concrete next step"}.

Focus on: household composition patterns (family size, age mix between parents and children), youth vs adult programming balance based on actual member ages, data quality issues worth addressing, growth patterns, residency implications for pricing, grade-level program opportunities (which grades are most represented), geographic reach, and underserved demographic segments. Be specific with numbers from the data. Do not invent numbers not in the input.`;

const DIRECTORS_SYS_PROMPT = `You are an executive analyst for US municipal parks & recreation departments. You receive a JSON summary of one month's operational metrics: revenue, program enrollment, community demographics, and self-service (Fast Track) adoption.

Return a JSON array of 3-4 insight objects. Each object has:
- "type": one of "positive", "warning", "action", "neutral"
- "title": bold 4-8 word headline
- "body": 1-2 sentence explanation with specific numbers from the data

Focus on: standout achievements worth celebrating, areas needing attention, and one concrete recommended action. Be specific — cite the exact numbers. Write for a department director who will share this with their city council.

Example output:
[{"type":"positive","title":"Strong enrollment momentum","body":"575 enrollments across 51 programs shows healthy community engagement, with a 41.5% overall fill rate leaving room to grow."},{"type":"action","title":"Boost Fast Track promotion","body":"Only 8.2% of enrollments come through self-service. Increasing FT adoption for high-demand programs like Swim Lessons could reduce front-desk workload by 15+ hours/month."}]`;

const SYS_PROMPTS = { programs: PROGRAMS_SYS_PROMPT, fasttrack: FASTTRACK_SYS_PROMPT, users: USERS_SYS_PROMPT, "directors-report": DIRECTORS_SYS_PROMPT };

// ── Program Finder AI ────────────────────────────────────────────────
const RECOMMEND_SYS_PROMPT = `You are a friendly, helpful recreation program advisor for a municipal parks & recreation department. A resident has described what they're looking for, and you have the department's upcoming schedule of programs and activities.

Your job: recommend the 5–8 best-matching programs from the data provided. Be warm, encouraging, and specific about why each program is a great fit.

Respond with ONLY a JSON array (no markdown fences, no preamble). Each element:
{
  "name": "Program or activity name",
  "datetime": "Human-readable schedule (e.g. 'Tuesdays & Thursdays, 6:00–7:30 PM, Jun 17 – Jul 24')",
  "location": "Facility and location name",
  "description": "1-2 sentence description of the program (from data or inferred from name/activity type)",
  "price": "$XX or 'Free' or 'See website' if unknown",
  "match_reason": "1-2 sentence personalized reason this matches what the resident described",
  "url": "Section URL if available, otherwise null"
}

Rules:
- Only recommend programs that genuinely match the resident's description. Don't pad the list.
- If fewer than 5 match well, that's fine — quality over quantity.
- If a program is Full or has a Waitlist, mention that in the description but still include it if relevant.
- Group related sessions (same program, different days) into one recommendation.
- Sort by relevance to the resident's request, best matches first.
- Keep it concise and actionable.`;

// Simple per-IP rate limiter for public endpoints
const _rateBuckets = new Map();
function rateLimit(key, maxPerHour) {
  const now = Date.now();
  const bucket = _rateBuckets.get(key) || [];
  const recent = bucket.filter(ts => now - ts < 3600000);
  if (recent.length >= maxPerHour) return false;
  recent.push(now);
  _rateBuckets.set(key, recent);
  return true;
}
// Prune old rate-limit entries every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets) {
    const recent = v.filter(ts => now - ts < 3600000);
    if (recent.length === 0) _rateBuckets.delete(k);
    else _rateBuckets.set(k, recent);
  }
}, 30 * 60 * 1000);

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
  if (!anthropic) {
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
    const data = await anthropic.messages.create({
      model: INSIGHTS_MODEL,
      max_tokens: 700,
      system: SYS_PROMPTS[reportType] || INSIGHTS_SYS_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(blob) }],
    });

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
    logEvent(orgSlug, reportType, "insights", req, { inTok, outTok, costUsd });
    if (_langfuseProcessor) _langfuseProcessor.forceFlush().then(() => console.log("[langfuse] flush OK")).catch(e => console.error("[langfuse] flush error:", e.message));
    res.json({ ok: true, insights, cached: false });
  } catch (err) {
    console.error("[insights] Error:", err);
    res.status(502).json({ ok: false, error: "Upstream AI request failed" });
  }
});

// ── Rec AI Chat — conversational data assistant ──────────────────────
const CHAT_MODEL   = process.env.CHAT_MODEL || "claude-sonnet-4-6";
const CHAT_MAX_TOK = 2500;

// Data cache: orgSlug → { ts, data }
const _chatDataCache = new Map();
const CHAT_DATA_TTL  = 15 * 60 * 1000; // 15 min
const CHAT_DATA_MAX  = 30;

// Report type human labels for context
const CHAT_REPORT_LABELS = {
  facility: "Facility Rental Schedule", gl: "GL Code Rollup",
  programs: "Programs & Enrollment", products: "Product Sales",
  memberships: "Memberships", "court-utilization": "Court Utilization",
  roster: "Class Roster", fasttrack: "Fast Track Demand",
  historic: "Historic Buildings", calendar: "Calendar",
};

async function fetchOrgChatData(orgSlug, orgConfig) {
  const hit = _chatDataCache.get(orgSlug);
  if (hit && Date.now() - hit.ts < CHAT_DATA_TTL) return hit.data;

  const reports = REPORT_TYPES.filter(r => orgConfig[r]?.mbUuid);
  const results = {};

  await Promise.allSettled(reports.map(async (rt) => {
    try {
      const uuid = orgConfig[rt].mbUuid;
      const url = `${METABASE_URL}/api/public/card/${uuid}/query/json`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!resp.ok) return;
      const rows = await resp.json();
      if (!Array.isArray(rows) || !rows.length) return;

      // Calendar: strip PII before including in chat context
      if (rt === "calendar") {
        const PII = new Set(["reservee","reservee name","customer","customer name","booked by","booker","contact","contact name","notes","note","address","first name","last name","name"]);
        const isPII = (k) => { const t = String(k).toLowerCase().trim(); return PII.has(t) || t.includes("email") || t.includes("phone"); };
        for (const row of rows) {
          if (row && typeof row === "object") {
            for (const k of Object.keys(row)) { if (isPII(k)) delete row[k]; }
          }
        }
      }

      // Limit rows and truncate long values to keep context manageable
      const limited = rows.slice(0, 75).map(row => {
        const trimmed = {};
        for (const [k, v] of Object.entries(row)) {
          trimmed[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 117) + '...' : v;
        }
        return trimmed;
      });
      const cols = Object.keys(limited[0]);
      results[rt] = { label: CHAT_REPORT_LABELS[rt] || rt, cols, rows: limited, totalRows: rows.length };
      console.log(`[chat] ✓ ${orgSlug}/${rt}: ${rows.length} rows`);
    } catch (e) {
      console.error(`[chat] ✗ ${orgSlug}/${rt}: ${e.message}`);
    }
  }));

  if (_chatDataCache.size >= CHAT_DATA_MAX) {
    const oldest = _chatDataCache.keys().next().value;
    _chatDataCache.delete(oldest);
  }
  _chatDataCache.set(orgSlug, { ts: Date.now(), data: results });
  return results;
}

function buildChatSystemPrompt(orgName, data) {
  const loaded = Object.keys(data);
  const inventory = loaded.map(rt => `  ✓ ${data[rt].label} (${data[rt].totalRows} rows)`).join("\n");

  const sections = Object.entries(data).map(([rt, d]) => {
    const header = `## ${d.label} (${d.totalRows} total rows, showing first ${d.rows.length})`;
    const colLine = `Columns: ${d.cols.join(", ")}`;
    // Compact JSON rows
    const rowLines = d.rows.map(r => JSON.stringify(r)).join("\n");
    return `${header}\n${colLine}\n${rowLines}`;
  });

  return `You are Rec AI, an intelligent data assistant for ${orgName}, a parks and recreation department.

DATA INVENTORY — you have the following ${loaded.length} report(s) loaded with live data:
${inventory}

IMPORTANT: You DO have access to all the reports listed above. Analyze and answer from this data directly — do not say you lack data for a report that appears in the inventory. If a report is listed above, its full data is provided below.

YOUR DATA:
${sections.join("\n\n")}

RULES:
- Ground every claim in the data above. Never invent numbers, names, or facilities.
- Be concise and specific — name facilities, programs, GL codes, products by name.
- Format currency as $X,XXX.XX, percentages as X.X%.
- Use markdown tables, bold, and lists when they help readability.
- If asked about data not covered by ANY of the reports in the inventory above, say so and suggest what report type might help. But if the data IS in the inventory, use it.
- When asked for trends or comparisons, cite the specific numbers.
- Keep responses focused — 2-4 paragraphs unless a longer answer is clearly needed.
- Never expose PII (emails, phone numbers, names of individual reservees/customers).`;
}

app.post("/:org/chat/api/message", async (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).json({ error: "Unknown org" });
  if (!org.token) return res.status(404).json({ error: "Unauthorized" });

  // Token check
  const qToken = req.query.token || req.headers["x-token"];
  if (qToken !== org.token) return res.status(403).json({ error: "Invalid token" });

  if (!anthropic) {
    return res.status(503).json({ error: "AI not configured" });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "Messages array required" });
  }

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  try {
    // Signal data loading
    res.write("data: [DATA_LOADING]\n\n");

    const orgSlugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
    const orgName = org.displayName || `${orgSlugTitle} Parks & Recreation`;
    const data = await fetchOrgChatData(slug, org);

    res.write("data: [DATA_READY]\n\n");

    const systemPrompt = buildChatSystemPrompt(orgName, data);
    console.log(`[chat] ${slug}: system prompt ${(systemPrompt.length / 1024).toFixed(0)}KB, ${Object.keys(data).length} reports`);

    // Clean messages — only role + content
    const cleanMsgs = messages.map(m => ({ role: m.role, content: m.content }));

    const stream = anthropic.messages.stream({
      model: CHAT_MODEL,
      max_tokens: CHAT_MAX_TOK,
      system: systemPrompt,
      messages: cleanMsgs,
    });

    stream.on("text", (text) => {
      res.write("data: " + JSON.stringify({ t: text }) + "\n\n");
    });

    stream.on("error", (err) => {
      console.error("[chat] Anthropic stream error:", err.message);
      res.write("data: [ERROR] AI service error: " + err.message + "\n\n");
    });

    const finalMessage = await stream.finalMessage();
    const inputTokens  = finalMessage.usage?.input_tokens  || 0;
    const outputTokens = finalMessage.usage?.output_tokens || 0;

    const costUsd = insightsCostUsd(CHAT_MODEL, inputTokens, outputTokens);
    logEvent(slug, "chat", "message", req, { inTok: inputTokens, outTok: outputTokens, costUsd });
    if (_langfuseProcessor) _langfuseProcessor.forceFlush().catch(() => {});

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[chat] Error:", err);
    try {
      res.write(`data: [ERROR] ${err.message}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (_) { /* response may already be closed */ }
  }
});


// ── GET /:org/:report/api/data — proxy to Metabase ───────────────────
// ── Report Wizard — AI config generator ─────────────────────────────
const WIZARD_MODEL = process.env.WIZARD_MODEL || "claude-sonnet-4-6";
const WIZARD_MAX_TOKENS = 3000;
const _wizardSchemaCache = new Map();
const WIZARD_SCHEMA_TTL = 30 * 60 * 1000;

async function fetchWizardSchemas(orgSlug, orgConfig) {
  const hit = _wizardSchemaCache.get(orgSlug);
  if (hit && Date.now() - hit.ts < WIZARD_SCHEMA_TTL) return hit.schemas;
  const reportTypes = REPORT_TYPES.filter(r =>
    !NON_ADDABLE_REPORTS.has(r) && (orgConfig[r]?.mbUuid || SHARED_UUIDS[r])
  );
  const schemas = {};
  await Promise.allSettled(reportTypes.map(async (rt) => {
    try {
      const useShared = rt === "gl" ? (!orgConfig.gl?.mbUuid && !!SHARED_UUIDS.gl) : !!SHARED_UUIDS[rt];
      const mbUuid = useShared ? SHARED_UUIDS[rt] : (orgConfig[rt]?.mbUuid || SHARED_UUIDS[rt]);
      if (!mbUuid) return;
      const orgId = useShared ? orgConfig.orgId : null;
      const params = buildMetabaseParams({}, rt, orgId);
      const paramStr = params.length > 0 ? `?parameters=${encodeURIComponent(JSON.stringify(params))}` : "";
      const url = `${METABASE_URL}/api/public/card/${mbUuid}/query/json${paramStr}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return;
      const rows = await resp.json();
      if (!Array.isArray(rows) || !rows.length) return;
      const sample = rows.slice(0, 5);
      const fields = Object.keys(sample[0]).map(k => {
        const vals = sample.map(r => r[k]).filter(v => v != null);
        const isNum = vals.length > 0 && vals.every(v => typeof v === 'number' || /^-?[d,.]+%?$/.test(String(v).replace(/[$,]/g, '')));
        const unique = [...new Set(vals.map(v => String(v).slice(0, 40)))].slice(0, 3);
        return { name: k, type: isNum ? 'number' : 'string', samples: unique };
      });
      schemas[rt] = { fields, rowCount: rows.length };
      console.log(`[wizard] schema ${orgSlug}/${rt}: ${fields.length} fields, ${rows.length} rows`);
    } catch (e) { console.error(`[wizard] schema ${orgSlug}/${rt}: ${e.message}`); }
  }));
  if (_wizardSchemaCache.size > 50) { const oldest = _wizardSchemaCache.keys().next().value; _wizardSchemaCache.delete(oldest); }
  _wizardSchemaCache.set(orgSlug, { ts: Date.now(), schemas });
  return schemas;
}

// Source-level descriptions to help the AI pick the right data source
const WIZARD_SOURCE_HINTS = {
  programs: 'Aggregated program/section-level data: revenue, enrollment counts, capacity, cancellations. ONE ROW PER SECTION. Use for revenue totals, fill rates, program comparisons.',
  'program-demographics': 'Individual participant-level rows: one row per enrolled person with their gender, age, city, grade. Use for demographic breakdowns (gender, age, geography). Does NOT contain revenue or financial data — use programs source for revenue.',
  gl: 'General ledger / accounting data: revenue and refunds grouped by GL account code. Use for financial breakdowns by account category.',
  facility: 'Facility rental bookings with dates, times, locations, reservees, totals. Use for utilization, booking patterns, facility revenue.',
  users: 'Community/household-level data: demographics, revenue per household, membership status. Use for community analytics.',
  fasttrack: 'Fast Track (self-service) data: FT wishlists, conversions, demand signals. Use for FT adoption analysis.',
  products: 'Product sales: daily revenue, units sold, refunds by product. Use for merchandise/concession analysis.',
  memberships: 'Membership/pass data: active members, plan types, renewal dates. Use for membership retention analysis.',
  'court-utilization': 'Court/field utilization: reserved hours, usage percentages. Use for facility utilization rates.',
  roster: 'Class roster: enrolled and cancelled participants by section.',
};

const WIZARD_SYS_PROMPT = `You are a report configuration generator for a municipal parks & recreation analytics platform.

You receive a natural language description of a desired report and a schema of available data sources with their field names, types, and sample values.

Return ONLY a valid JSON object (no markdown fences, no explanation) with this structure:

{
  "title": "Report Title",
  "description": "One-line description",
  "dataSources": ["programs", "program-demographics"],
  "widgets": [...]
}

WIDGET TYPES:

1. kpi-row: Row of summary metric cards (use 3-5 items)
{"type":"kpi-row","items":[{"label":"Total Revenue","source":"programs","field":"Net Amount","compute":"sum","format":"currency"}]}

2. bar-chart: Grouped bar chart
{"type":"bar-chart","title":"Revenue by Gender","source":"program-demographics","groupBy":"Gender","metric":{"field":"Net Amount","compute":"sum"},"format":"currency","limit":10}

3. pie-chart: Donut/pie chart
{"type":"pie-chart","title":"Enrollment by Gender","source":"program-demographics","groupBy":"Gender","metric":{"field":"Gender","compute":"count"},"format":"number"}

4. table: Sortable data table
{"type":"table","title":"Program Details","source":"programs","columns":[{"field":"Program Name","label":"Program"},{"field":"Net Amount","label":"Revenue","format":"currency"},{"field":"Registrations","label":"Enrolled","format":"number"}],"sort":{"field":"Net Amount","dir":"desc"},"limit":20}

Tables can also aggregate with groupBy + compute:
{"type":"table","title":"Revenue by Gender","source":"program-demographics","groupBy":"Gender","columns":[{"field":"Gender","label":"Gender"},{"field":"Net Amount","label":"Revenue","format":"currency"}],"compute":"sum"}

AVAILABLE FILTER in any widget (optional):
"filter": [{"field":"Gender","op":"neq","value":"Unknown"}]
Ops: eq, neq, contains, gt, lt

COMPUTE METHODS: sum, avg, count, countDistinct, min, max

FORMAT OPTIONS: currency (no decimals), currency2 (2 decimals), number, percent

CRITICAL DATA SOURCE RULES:
- ONLY reference field names that ACTUALLY APPEAR in the schema for that specific source
- "program-demographics" has participant rows (gender, age, city) but NO revenue fields — use "programs" for revenue
- "programs" has section-level aggregates (Net Amount, Registrations, Capacity) but NO gender/age fields — use "program-demographics" for demographics
- "gl" has accounting data — use for revenue-by-account breakdowns
- Read the DESCRIPTION line for each source to understand what data it contains
- If a field doesn't exist in a source, DO NOT reference it — the widget will show 0/blank

PII RULES (CRITICAL — NEVER VIOLATE):
- NEVER include these fields as table columns: First Name, Last Name, Email, Phone, email, phone, first_name, last_name
- Tables should show AGGREGATED data (grouped by program, gender, city, etc.) — never individual person rows

COUNTING ROWS — THIS IS CRITICAL:
- program-demographics has ONE ROW PER PARTICIPANT. There is NO "Enrollment Count" or "Total Enrolled" field.
- To count enrollments: use compute:"count" with field set to ANY field that exists (e.g. "Gender")
- To count by category: use groupBy + compute:"count" with field = the groupBy field
- NEVER reference fields that don't exist in the schema. If you need a count, use "count" compute on a real field.

COMPLETE WORKING EXAMPLE — gender enrollment report:
{
  "title": "Gender Enrollment Report",
  "description": "Enrollment by gender across all programs",
  "dataSources": ["program-demographics", "programs"],
  "widgets": [
    {"type": "kpi-row", "items": [
      {"label": "Total Enrolled", "source": "program-demographics", "field": "Gender", "compute": "count", "format": "number"},
      {"label": "Female", "source": "program-demographics", "field": "Gender", "compute": "count", "format": "number", "filter": [{"field": "Gender", "op": "eq", "value": "female"}]},
      {"label": "Male", "source": "program-demographics", "field": "Gender", "compute": "count", "format": "number", "filter": [{"field": "Gender", "op": "eq", "value": "male"}]},
      {"label": "Total Programs", "source": "programs", "field": "Program Name", "compute": "countDistinct", "format": "number"}
    ]},
    {"type": "pie-chart", "title": "Gender Distribution", "source": "program-demographics", "groupBy": "Gender", "metric": {"field": "Gender", "compute": "count"}, "format": "number"},
    {"type": "bar-chart", "title": "Enrollment by Gender", "source": "program-demographics", "groupBy": "Gender", "metric": {"field": "Gender", "compute": "count"}, "format": "number"},
    {"type": "table", "title": "Gender Enrollment by Program", "source": "program-demographics", "groupBy": "Program", "columns": [{"field": "Program", "label": "Program"}, {"field": "Gender", "label": "Participants", "format": "number"}], "compute": "count", "sort": {"field": "Gender", "dir": "desc"}, "limit": 25},
    {"type": "table", "title": "Program Details", "source": "programs", "columns": [{"field": "Program Name", "label": "Program"}, {"field": "Section Name", "label": "Section"}, {"field": "Registrations", "label": "Enrolled", "format": "number"}, {"field": "Capacity", "label": "Capacity", "format": "number"}, {"field": "Net Amount", "label": "Revenue", "format": "currency"}], "sort": {"field": "Registrations", "dir": "desc"}, "limit": 25}
  ]
}

Adapt this pattern for other requests. The key insight: program-demographics rows ARE the enrollments — count them, don't look for a count field.

LAYOUT RULES:
- dataSources must list every source key used by widgets
- Start with a kpi-row for the most important metrics (3-5 cards)
- Use 3-6 widgets total
- Prefer bar-chart for categorical comparisons, pie-chart for proportions
- Use table for AGGREGATED drill-down (grouped by program, category, etc. — never individual people)
- For "count" computations, set the metric field to the groupBy field (or any existing field)
- Return ONLY the JSON object, nothing else`;

app.post("/:org/report-wizard/api/generate", async (req, res) => {
  const slug = req.params.org;
  const org = ORGS[slug];
  if (!org) return res.status(404).json({ error: "Unknown org" });

  const qToken = req.query.token || req.headers["x-token"];
  if (org.token && qToken !== org.token) return res.status(403).json({ error: "Invalid token" });

  if (!anthropic) {
    return res.status(503).json({ error: "AI not configured" });
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Prompt required" });
  }

  try {
    const schemas = await fetchWizardSchemas(slug, org);
    const sourceCount = Object.keys(schemas).length;
    if (!sourceCount) {
      return res.status(500).json({ error: "No data sources available for this org" });
    }

    const schemaText = Object.entries(schemas).map(([rt, s]) => {
      const hint = WIZARD_SOURCE_HINTS[rt] || '';
      const fieldList = s.fields.map(f =>
        `  - ${f.name} (${f.type})${f.samples && f.samples.length ? ` examples: ${f.samples.map(v => '"' + v + '"').join(', ')}` : ""}`
      ).join("\n");
      return `SOURCE: "${rt}" (${s.rowCount} rows)${hint ? '\n  DESCRIPTION: ' + hint : ''}\n${fieldList}`;
    }).join("\n\n");

    const userMsg = `DATA SOURCES AVAILABLE:\n\n${schemaText}\n\nUSER REQUEST: ${prompt}\n\nRemember: respond with ONLY the JSON config object, no explanation or markdown.`;

    console.log(`[wizard] ${slug}: generating config, ${sourceCount} sources, prompt: "${prompt.slice(0, 80)}"`);

    const data = await anthropic.messages.create({
      model: WIZARD_MODEL,
      max_tokens: WIZARD_MAX_TOKENS,
      system: WIZARD_SYS_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const text = (data.content || [])
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");

    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let config;
    try {
      config = JSON.parse(cleaned);
    } catch (parseErr) {
      // Try extracting the first JSON object from the response (AI may add preamble)
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          config = JSON.parse(jsonMatch[0]);
        } catch (e2) {
          console.error(`[wizard] JSON parse failed (both attempts): ${parseErr.message}\n${cleaned.slice(0, 500)}`);
          return res.status(502).json({ error: "AI returned invalid config - try a shorter, simpler prompt" });
        }
      } else {
        console.error(`[wizard] No JSON object found in response:\n${cleaned.slice(0, 500)}`);
        return res.status(502).json({ error: "AI returned invalid config - try a shorter, simpler prompt" });
      }
    }

    if (!config.title || !config.widgets || !Array.isArray(config.widgets)) {
      return res.status(502).json({ error: "AI returned incomplete config - try rephrasing" });
    }
    if (!config.dataSources || !Array.isArray(config.dataSources)) {
      const srcs = new Set();
      config.widgets.forEach(w => {
        if (w.source) srcs.add(w.source);
        if (w.items) w.items.forEach(it => { if (it.source) srcs.add(it.source); });
      });
      config.dataSources = Array.from(srcs);
    }

    const usage = data.usage || {};
    const costUsd = insightsCostUsd(WIZARD_MODEL, usage.input_tokens || 0, usage.output_tokens || 0);
    if (_langfuseProcessor) _langfuseProcessor.forceFlush().catch(() => {});
    logEvent(slug, "report-wizard", "generate", req, {
      inTok: usage.input_tokens || 0,
      outTok: usage.output_tokens || 0,
      costUsd,
      prompt: prompt.slice(0, 120),
    });

    console.log(`[wizard] ${slug}: generated "${config.title}" with ${config.widgets.length} widgets, ${config.dataSources.length} sources`);
    res.json(config);
  } catch (err) {
    console.error("[wizard] Error:", err);
    res.status(500).json({ error: "Report generation failed: " + err.message });
  }
});

// ── Report Wizard — feedback endpoint ──
app.post("/:org/report-wizard/api/feedback", (req, res) => {
  const slug = req.params.org;
  const org = ORGS[slug];
  if (!org) return res.status(404).json({ error: "Unknown org" });
  const qToken = req.query.token || req.headers["x-token"];
  if (org.token && qToken !== org.token) return res.status(403).json({ error: "Invalid token" });
  const { vote, prompt, title, widgetCount } = req.body || {};
  logEvent(slug, "report-wizard", "feedback", req, { vote, prompt: (prompt || "").slice(0, 200), title, widgetCount });
  console.log(`[wizard] ${slug}: feedback ${vote} for "${(title || "").slice(0, 60)}"`);
  res.json({ ok: true });
});

// ── Report Wizard — admin activity log ──
app.get("/api/admin/wizard-log", (req, res) => {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return res.json([]);
    const lines = fs.readFileSync(EVENTS_FILE, "utf8").trim().split("\n").filter(Boolean);
    const wizardEvents = [];
    for (let i = lines.length - 1; i >= 0 && wizardEvents.length < 100; i--) {
      try {
        const evt = JSON.parse(lines[i]);
        if (evt.report === "report-wizard" && (evt.action === "generate" || evt.action === "feedback")) {
          wizardEvents.push(evt);
        }
      } catch (_) {}
    }
    res.json(wizardEvents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get("/:org/:report/api/data", resolveOrg, async (req, res) => {
  try {
    const { orgConfig, orgSlug, reportType } = req;
    // GL: per-org UUID takes priority (e.g. Norman has custom gl_map); shared fallback.
    // All other reports: shared first, per-org fallback.
    const useShared = reportType === "gl"
      ? (!orgConfig.gl?.mbUuid && !!SHARED_UUIDS.gl)
      : !!SHARED_UUIDS[reportType];
    const mbUuid = useShared ? SHARED_UUIDS[reportType] : (orgConfig[reportType]?.mbUuid || SHARED_UUIDS[reportType]);
    if (!mbUuid) return res.status(404).json({ error: `No Metabase question configured for ${orgSlug}/${reportType}` });

    logEvent(orgSlug, reportType, "fetch", req);

    const orgId = useShared ? orgConfig.orgId : null;
    const params = buildMetabaseParams(req.query, reportType, orgId);
    const paramStr = params.length > 0 ? `?parameters=${encodeURIComponent(JSON.stringify(params))}` : "";

    // ── Cache check (skip with _nocache=1) ──
    const cacheKey = `${orgSlug}:${reportType}:${paramStr}`;

    // Users report: check daily pre-warmed cache first
    if (reportType === "users" && req.query._nocache !== "1") {
      const uc = getCachedUsers(orgSlug);
      if (uc) {
        console.log(`[users-cache] HIT ${orgSlug}/users (${uc.data.rows.length} rows, cached ${new Date(uc.ts).toISOString()})`);
        const result = Object.assign({}, uc.data, { meta: Object.assign({}, uc.data.meta, { cached_at: new Date(uc.ts).toISOString() }) });
        return res.json(result);
      }
    }

    if (req.query._nocache !== "1") {
      const cached = getCached(cacheKey);
      if (cached) {
        console.log(`[cache] HIT ${orgSlug}/${reportType} (${dataCache.size} entries)`);
        return res.json(cached);
      }
    }

    const url = `${METABASE_URL}/api/public/card/${mbUuid}/query/json${paramStr}`;
    console.log(`[proxy] ${orgSlug}/${reportType} → ${url}`);

    const fetchTimeoutMs = orgConfig.healthTimeoutMs || 120000;
    const response = await fetch(url, { signal: AbortSignal.timeout(fetchTimeoutMs) });
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

    const result = {
      rows: data,
      meta: {
        org_slug: orgSlug,
        logo_url: orgConfig.logoUrl,
        report_type: reportType,
        generated_at: new Date().toISOString(),
      },
    };

    setCache(cacheKey, result, reportType);
    // Also populate the daily users cache for subsequent requests
    if (reportType === "users") setCacheUsers(orgSlug, result);
    console.log(`[cache] STORE ${orgSlug}/${reportType} (${data.length} rows, ${dataCache.size} entries)`);

    res.json(result);
  } catch (err) {
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    const msg = isTimeout
      ? `Metabase query timed out after ${(orgConfig.healthTimeoutMs || 120000) / 1000}s — try a shorter date range`
      : err.message;
    console.error(`[proxy] Error${isTimeout ? " (timeout)" : ""}:`, err.message);
    res.status(isTimeout ? 504 : 500).json({ error: msg });
  }
});

// ── GET /:org/:report/api/pdf — Puppeteer PDF ────────────────────────
app.get("/:org/:report/api/pdf", resolveOrg, async (req, res) => {
  try {
    const { orgSlug, reportType } = req;
    logEvent(orgSlug, reportType, "pdf", req);
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
    programs: "Programs",
    roster:   "Class Roster",
  };
  const available = REPORT_TYPES
    .filter(r => !NON_ADDABLE_REPORTS.has(r) && (org[r]?.mbUuid || SHARED_UUIDS[r]))
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
  if (!getFlags().emailSubscriptions) return res.status(503).json({ error: "Email subscriptions are currently disabled" });
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
  logEvent(slug, "facility", "view", req);
  const orgConfig = { defaultDateRange: org.facility?.defaultDateRange || "month", defaultLocationFilter: org.facility?.defaultLocationFilter || null };
  const html = require("fs").readFileSync(path.join(__dirname, "public", "facility.html"), "utf8");
  res.send(html.replace("<head>", `<head><script>window.ORG_CONFIG=${JSON.stringify(orgConfig)};</script>`));
});

app.get("/:org/gl", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "gl", "view", req);
  res.sendFile(path.join(__dirname, "public", "gl.html"));
});

app.get("/:org/historic", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "historic", "view", req);
  res.sendFile(path.join(__dirname, "public", "historic.html"));
});

app.get("/:org/programs", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  logEvent(slug, "programs", "view", req);
  const PARTICIPANTS_ENABLED_ALL = true; // Enabled for all orgs — shared UUID 67b77142
  const orgConfig = {
    slug,
    displayName: org.displayName || (slug.charAt(0).toUpperCase() + slug.slice(1) + " Parks & Recreation"),
    logoUrl: org.logoUrl || "",
    token: org.token || "",
    participantsTab: PARTICIPANTS_ENABLED_ALL,
  };
  const html = require("fs").readFileSync(path.join(__dirname, "public", "programs.html"), "utf8");
  const inject = `<script>window.ORG_CONFIG=${JSON.stringify(orgConfig)};</script>`;
  res.type("html").send(html.replace("</head>", inject + "</head>"));
});

app.get("/:org/roster", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "roster", "view", req);
  res.sendFile(path.join(__dirname, "public", "roster.html"));
});

app.get("/:org/directors-report", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  logEvent(slug, "directors-report", "view", req);
  const orgConfig = {
    slug,
    displayName: org.displayName || (slug.charAt(0).toUpperCase() + slug.slice(1) + " Parks & Recreation"),
    logoUrl: org.logoUrl || "",
    token: org.token || "",
  };
  const html = require("fs").readFileSync(path.join(__dirname, "public", "directors-report.html"), "utf8");
  const inject = `<script>window.ORG_CONFIG=${JSON.stringify(orgConfig)};</script>`;
  res.type("html").send(html.replace("</head>", inject + "</head>"));
});

app.get("/:org/overview", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).send("Unknown org");
  logEvent(req.params.org, "overview", "view", req);
  res.sendFile(path.join(__dirname, "public", "overview.html"));
});

app.get("/:org/products", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org.products?.mbUuid && !SHARED_UUIDS.products) return res.status(404).send("Products report not configured for this org.");
  logEvent(slug, "products", "view", req);
  res.sendFile(path.join(__dirname, "public", "products.html"));
});

app.get("/:org/memberships", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org.memberships?.mbUuid && !SHARED_UUIDS.memberships) return res.status(404).send("Memberships report not configured for this org.");
  logEvent(slug, "memberships", "view", req);
  res.sendFile(path.join(__dirname, "public", "memberships.html"));
});

app.get("/:org/court-utilization", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org["court-utilization"]?.mbUuid && !SHARED_UUIDS["court-utilization"]) return res.status(404).send("Court Utilization report not configured for this org.");
  logEvent(slug, "court-utilization", "view", req);
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
  if (!org.calendar?.mbUuid && !SHARED_UUIDS.calendar) return res.status(404).send("Calendar report not configured for this org.");
  logEvent(slug, "calendar", "view", req);
  // Inject org metadata so the frontend can show logo + name
  const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
  const meta = {
    slug,
    displayName: org.displayName || `${slugTitle} Parks & Recreation`,
    logoUrl: org.logoUrl || '',
    recommendEnabled: RECOMMEND_ENABLED && !!(org.calendar?.mbUuid || SHARED_UUIDS.calendar || org.programs?.mbUuid || SHARED_UUIDS.programs),
  };
  const fs = require("fs");
  const html = fs.readFileSync(path.join(__dirname, "public", "calendar.html"), "utf-8");
  const inject = `<script>window.__ORG__=${JSON.stringify(meta)};</script>`;
  res.type("html").send(html.replace("</head>", inject + "</head>"));
});

// ── POST /:org/calendar/api/click — track View Session clicks ────────
app.post("/:org/calendar/api/click", express.json(), (req, res) => {
  const slug = req.params.org;
  const org = ORGS[slug];
  if (!org) return res.status(404).end();
  const { section, url } = req.body || {};
  logEvent(slug, "calendar", "click", req, { section: section || null, url: url || null });
  res.status(204).end();
});

// ── POST /:org/calendar/api/recommend — AI program finder + email ────
app.post("/:org/calendar/api/recommend", express.json(), async (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).json({ ok: false, error: "Unknown org" });
  if (!RECOMMEND_ENABLED) return res.status(503).json({ ok: false, error: "Program recommendations are temporarily unavailable" });
  if (!org.calendar?.mbUuid && !SHARED_UUIDS.calendar && !org.programs?.mbUuid && !SHARED_UUIDS.programs) {
    return res.status(404).json({ ok: false, error: "No calendar or program data for this org" });
  }

  const { description, email } = req.body || {};
  if (!description || typeof description !== "string" || description.trim().length < 5) {
    return res.status(400).json({ ok: false, error: "Please describe what you're looking for (at least a few words)" });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "Please enter a valid email address" });
  }
  if (description.length > 1000) {
    return res.status(400).json({ ok: false, error: "Description too long (max 1000 characters)" });
  }

  // Rate limit: 3 per IP per hour
  const clientIP = req.ip || req.connection?.remoteAddress || "unknown";
  if (!rateLimit(`recommend:${clientIP}`, 3)) {
    return res.status(429).json({ ok: false, error: "You\u2019ve sent a few requests recently. Please try again in an hour." });
  }

  if (!anthropic) {
    return res.status(503).json({ ok: false, error: "AI service not configured" });
  }

  const resend = getResendClient();
  if (!resend) {
    return res.status(503).json({ ok: false, error: "Email service not configured" });
  }

  try {
    // Fetch upcoming schedule data (next 30 days)
    const today = new Date();
    const future = new Date(today); future.setDate(future.getDate() + 30);
    const startDate = toISO(today);
    const endDate   = toISO(future);

    let rows = [];
    const calUseShared = !!SHARED_UUIDS.calendar;
    const mbUuid = calUseShared ? SHARED_UUIDS.calendar : org.calendar?.mbUuid;
    if (mbUuid) {
      const orgId = calUseShared ? org.orgId : null;
      const params = buildMetabaseParams({ start_date: startDate, end_date: endDate }, "calendar", orgId);
      const paramStr = params.length > 0 ? `?parameters=${encodeURIComponent(JSON.stringify(params))}` : "";
      const url = `${METABASE_URL}/api/public/card/${mbUuid}/query/json${paramStr}`;
      const resp = await fetch(url);
      if (resp.ok) rows = await resp.json();
    }

    // Also try programs data for richer info
    let programRows = [];
    if (org.programs?.mbUuid) {
      const pUrl = `${METABASE_URL}/api/public/card/${org.programs.mbUuid}/query/json`;
      const pResp = await fetch(pUrl);
      if (pResp.ok) programRows = await pResp.json();
    }

    if (rows.length === 0 && programRows.length === 0) {
      return res.status(404).json({ ok: false, error: "No upcoming programs found. Check back soon!" });
    }

    // Build a condensed program list for AI (strip PII, deduplicate)
    const seen = new Set();
    const programs = [];
    for (const r of rows) {
      const label = r["Section"] || r["Purpose"] || r["Activity"] || r["Program"] || r["Site Type"] || "Activity";
      const key = `${label}|${r["Location"] || ""}|${r["Activity"] || ""}`;
      if (seen.has(key) && programs.length > 80) continue; // allow some dupes for schedule variety
      seen.add(key);
      programs.push({
        program: r["Program"] || r["Activity"] || "",
        section: r["Section"] || r["Purpose"] || label,
        activity: r["Activity"] || r["Site Type"] || "",
        date: r["Date"] || r["Begin Sort"] || "",
        start: r["Begin"] || r["Start"] || r["Start Time"] || "",
        end: r["End"] || r["End Time"] || "",
        location: r["Location"] || r["Facility Location"] || "",
        facility: r["Facility"] || r["Court"] || "",
        description: r["Description"] || r["description"] || "",
        price: r["Price"] || r["Total"] || r["price"] || "",
        status: r["Status"] || r["status"] || "",
        url: r["Section URL"] || r["Url"] || r["url"] || r["sectionUrl"] || "",
      });
    }

    // Add program revenue data for additional context
    for (const r of programRows) {
      const name = r["Program Template"] || r["Program"] || r["program_template_name"] || "";
      const section = r["Section"] || r["section_name"] || "";
      if (!name) continue;
      const key = `prog:${name}|${section}`;
      if (seen.has(key)) continue;
      seen.add(key);
      programs.push({
        program: name,
        section: section,
        activity: r["Activity"] || r["Category"] || "",
        date: r["Start Date"] || r["start_date"] || "",
        end: r["End Date"] || r["end_date"] || "",
        location: r["Location"] || "",
        description: r["Description"] || "",
        enrolled: r["Enrolled"] || r["Enrollments"] || "",
        capacity: r["Capacity"] || "",
        price: r["Price"] || r["Revenue Per Enrollment"] || "",
        url: r["Section URL"] || r["section_url"] || "",
      });
    }

    // Cap at 200 items to keep tokens reasonable
    const condensed = programs.slice(0, 200);

    const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
    const orgName = org.displayName || `${slugTitle} Parks & Recreation`;

    // Call Claude
    const aiData = await anthropic.messages.create({
      model: INSIGHTS_MODEL,
      max_tokens: 1500,
      system: RECOMMEND_SYS_PROMPT.replace(/a municipal parks & recreation department/, orgName),
      messages: [{ role: "user", content: "RESIDENT'S REQUEST:\n" + description.trim() + "\n\nAVAILABLE PROGRAMS (next 30 days):\n" + JSON.stringify(condensed) }],
    });

    let aiText = (aiData.content || []).filter(c => c.type === "text").map(c => c.text).join("");

    // Parse JSON response
    aiText = aiText.replace(/```json|```/g, "").trim();
    let recommendations;
    try {
      recommendations = JSON.parse(aiText);
      if (!Array.isArray(recommendations)) recommendations = [recommendations];
    } catch {
      console.error("[recommend] Failed to parse AI response:", aiText.slice(0, 500));
      return res.status(502).json({ ok: false, error: "Could not parse program recommendations" });
    }

    // Log AI cost
    const usage = aiData.usage || {};
    const costUsd = insightsCostUsd(INSIGHTS_MODEL, usage.input_tokens || 0, usage.output_tokens || 0);
    logEvent(slug, "calendar", "recommend", clientIP, { costUsd, email: email.split("@")[0] + "@***", count: recommendations.length });

    // Build branded HTML email
    const logoHtml = org.logoUrl ? `<img src="${org.logoUrl}" alt="${orgName}" style="height:40px;max-width:200px;object-fit:contain" />` : "";
    const calendarUrl = org.calendarPublicUrl || `${BASE_URL}/${slug}/calendar${org.token ? "?token=" + encodeURIComponent(org.token) : ""}`;

    const recCards = recommendations.map((r, i) => `
      <tr><td style="padding:16px 0;border-bottom:1px solid #e5e7eb">
        <div style="font-weight:700;font-size:16px;color:#1f2937">${i + 1}. ${r.name || "Program"}</div>
        ${r.datetime ? `<div style="margin-top:4px;color:#4b5563;font-size:14px">\u{1F4C5} ${r.datetime}</div>` : ""}
        ${r.location ? `<div style="color:#4b5563;font-size:14px">\u{1F4CD} ${r.location}</div>` : ""}
        ${r.price ? `<div style="color:#4b5563;font-size:14px">\u{1F4B2} ${r.price}</div>` : ""}
        ${r.description ? `<div style="margin-top:8px;color:#374151;font-size:14px">${r.description}</div>` : ""}
        <div style="margin-top:8px;padding:8px 12px;background:#f0fdf4;border-radius:8px;font-size:13px;color:#166534">\u2728 <strong>Why this is a great match:</strong> ${r.match_reason || ""}</div>
        ${r.url ? `<div style="margin-top:8px"><a href="${r.url}" style="color:#2563eb;font-weight:600;font-size:14px;text-decoration:none">View &amp; Register \u2192</a></div>` : ""}
      </td></tr>
    `).join("");

    const emailHtml = `
    <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
      <div style="padding:24px;background:linear-gradient(135deg,#f0f9ff 0%,#f5f3ff 100%);border-radius:12px 12px 0 0;text-align:center">
        ${logoHtml}
        <h1 style="margin:12px 0 4px;font-size:22px;color:#1f2937">Your Personalized Program Picks</h1>
        <p style="margin:0;color:#6b7280;font-size:14px">Curated just for you by ${orgName}</p>
      </div>
      <div style="padding:20px 24px;background:#fff">
        <p style="color:#374151;font-size:14px;line-height:1.6">You asked: <em>\u201C${description.trim().replace(/</g, "&lt;").slice(0, 200)}\u201D</em></p>
        <p style="color:#374151;font-size:14px;line-height:1.6">Based on what you\u2019re looking for, here are our top recommendations:</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px">
          ${recCards}
        </table>
      </div>
      <div style="padding:20px 24px;background:#f9fafb;border-radius:0 0 12px 12px;text-align:center">
        <a href="${calendarUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;text-decoration:none">Browse Full Calendar</a>
        <p style="margin:16px 0 0;color:#9ca3af;font-size:12px">Powered by rec.us \u00B7 ${orgName}</p>
      </div>
    </div>`;

    const { data: sendData, error: sendError } = await resend.emails.send({
      from: `${orgName} <${FROM_EMAIL}>`,
      to: email.trim(),
      subject: `\u2728 Your Personalized Program Recommendations from ${orgName}`,
      html: emailHtml,
    });

    if (sendError) {
      console.error("[recommend] Resend error:", JSON.stringify(sendError));
      return res.status(502).json({ ok: false, error: "Email delivery failed: " + (sendError.message || "unknown Resend error") });
    }

    console.log(`[recommend] Sent ${recommendations.length} recommendations to ${email.split("@")[0]}@*** for ${slug} (id: ${sendData?.id || "?"})`);
    res.json({ ok: true, count: recommendations.length });

  } catch (err) {
    console.error("[recommend] Error:", err);
    res.status(500).json({ ok: false, error: "Something went wrong. Please try again." });
  }
});

// ── Rental Calendar (public facility availability) ─────────────────
// Public-facing page — no token required. Uses cached site data from
// rec.us MCP API (refreshed manually). Live API integration pending
// REST endpoint discovery from Rec engineering team.

app.get("/:org/rentalcalendar", (req, res) => {
  const slug = req.params.org;
  const org = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org.orgId) return res.status(404).send("Rental calendar requires orgId configuration.");
  logEvent(slug, "rentalcalendar", "view", req);
  const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
  const meta = {
    slug,
    orgId: org.orgId,
    displayName: org.displayName || slugTitle + ' Parks & Recreation',
    logoUrl: org.logoUrl || '',
    locationId: req.query.locationId || '',
    locationName: req.query.locationName || '',
  };
  const fs = require("fs");
  const html = fs.readFileSync(path.join(__dirname, "public", "rentalcalendar.html"), "utf-8");
  const inject = '<script>window.__RC__=' + JSON.stringify(meta) + ';</script>';
  res.type("html").send(html.replace("</head>", inject + "</head>"));
});

// Cached site data for Arsenal Park (Watertown) — fetched via rec.us MCP 2026-06-22
const RC_SITES_CACHE = {}; // Live MCP fetch for all orgs (provides rich data: photos, pricing, duration)

app.get("/:org/rentalcalendar/api/sites", async (req, res) => {
  const slug = req.params.org;
  const org = ORGS[slug];
  if (!org || !org.orgId) return res.status(404).json({ error: "Unknown org" });
  const locationId = req.query.locationId || '';
  const cacheKey = org.orgId + ':' + locationId;
  // Check hardcoded cache first
  const orgSites = RC_SITES_CACHE[org.orgId];
  if (orgSites) {
    const sites = locationId && orgSites[locationId] ? orgSites[locationId] : Object.values(orgSites).flat();
    return res.json({ sites });
  }
  // Live fetch via MCP SDK for orgs not in cache
  try {
    const client = await getRecMcpClient();
    if (!client) throw new Error('MCP client not available');
    const result = await client.callTool({ name: 'list_sites', arguments: { organizationId: org.orgId, pageSize: 100 } });
    let sites = [];
    for (const block of (result.content || [])) {
      if (block.type === 'text' && block.text) {
        try { const p = JSON.parse(block.text); sites = p.results || p; } catch {}
      }
    }
    if (locationId) sites = sites.filter(s => s.locationId === locationId);
    const clean = sites.map(s => ({
      id: s.id, name: s.name || s.courtNumber, courtNumber: s.courtNumber,
      type: s.type, capacity: s.capacity, locationId: s.locationId,
      locationName: s.locationName, bookingUrl: s.bookingUrl,
      bookingFlow: s.bookingFlow, isInstantBookable: s.isInstantBookable,
      imageUrl: (s.images && s.images.mainGallery && s.images.mainGallery[0]) ? s.images.mainGallery[0].url : null,
      priceCents: s.config && s.config.pricing && s.config.pricing.default ? s.config.pricing.default.cents : null,
      residentPriceCents: (() => { try { const gc = s.config.pricing.default.groupCents; const vals = Object.values(gc).filter(v => v > 0); return vals.length ? Math.min(...vals) : null; } catch(e) { return null; } })(),
      durationMinutes: s.allowedReservationDurations ? s.allowedReservationDurations.minutes : null,
    }));
    res.json({ sites: clean });
  } catch (e) {
    console.error('[rentalcalendar] live sites error:', e.message);
    res.json({ sites: [], note: 'Live fetch failed: ' + e.message });
  }
});

// Availability: use MCP SDK to call rec.us MCP server directly
const rcAvailCache = {};
const RC_AVAIL_TTL = 5 * 60 * 1000; // 5 minutes
let mcpClientReady = null; // lazy-initialized promise

async function getRecMcpClient() {
  if (mcpClientReady) return mcpClientReady;
  mcpClientReady = (async () => {
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 'rec-rental-calendar', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL('https://api.rec.us/mcp'));
      await client.connect(transport);
      console.log('[rentalcalendar] MCP client connected (Streamable HTTP)');
      return client;
    } catch (e1) {
      console.warn('[rentalcalendar] Streamable HTTP failed:', e1.message, '— trying SSE...');
      try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
        const client = new Client({ name: 'rec-rental-calendar', version: '1.0.0' });
        const transport = new SSEClientTransport(new URL('https://api.rec.us/mcp'));
        await client.connect(transport);
        console.log('[rentalcalendar] MCP client connected (SSE)');
        return client;
      } catch (e2) {
        console.error('[rentalcalendar] MCP SSE also failed:', e2.message);
        mcpClientReady = null; // allow retry
        return null;
      }
    }
  })();
  return mcpClientReady;
}

async function fetchSiteAvailability(siteId) {
  const cached = rcAvailCache[siteId];
  if (cached && Date.now() - cached.ts < RC_AVAIL_TTL) return cached.data;
  try {
    const client = await getRecMcpClient();
    if (!client) throw new Error('MCP client not available');
    const result = await client.callTool({ name: 'get_site_availability', arguments: { siteId } });
    let data = {};
    for (const block of (result.content || [])) {
      if (block.type === 'text' && block.text) {
        try { const parsed = JSON.parse(block.text); data = parsed.data || parsed; } catch {}
      }
    }
    rcAvailCache[siteId] = { data, ts: Date.now() };
    console.log('[rentalcalendar] Live availability for', siteId, '(' + Object.keys(data).length + ' dates)');
    return data;
  } catch (e) {
    console.error('[rentalcalendar] availability error:', e.message);
    if (cached) return cached.data;
    return {};
  }
}

app.get("/:org/rentalcalendar/api/availability/:siteId", async (req, res) => {
  const slug = req.params.org;
  const org = ORGS[slug];
  if (!org) return res.status(404).json({ error: "Unknown org" });
  const data = await fetchSiteAvailability(req.params.siteId);
  res.json({ data });
});


app.get("/:org/fasttrack", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org.fasttrack?.mbUuid && !SHARED_UUIDS.fasttrack) return res.status(404).send("Fast Track report not configured for this org.");
  logEvent(slug, "fasttrack", "view", req);
  res.sendFile(path.join(__dirname, "public", "fasttrack.html"));
});

app.get("/:org/instructor-payout", (req, res) => {
  const slug = req.params.org;
  const org = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  if (!org['instructor-payout']?.mbUuid && !SHARED_UUIDS['instructor-payout']) return res.status(404).send("Instructor Payout report not configured for this org.");
  logEvent(slug, "instructor-payout", "view", req);
  res.sendFile(path.join(__dirname, "public", "instructor-payout.html"));
});

app.get("/:org/users", (req, res) => {
  const slug = req.params.org;
  const org = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  logEvent(slug, "users", "view", req);
  const available = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && (org[r]?.mbUuid || SHARED_UUIDS[r]));
  const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
  const orgConfig = {
    slug,
    displayName: org.displayName || `${slugTitle} Parks & Recreation`,
    logoUrl: org.logoUrl || "",
    reports: available,
    token: org.token || "",
  };
  const html = require("fs").readFileSync(path.join(__dirname, "public", "users.html"), "utf8");
  const inject = `<script>window.ORG_CONFIG=${JSON.stringify(orgConfig)};</script>`;
  res.type("html").send(html.replace("</head>", inject + "</head>"));
});

app.get("/:org/chat", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  logEvent(slug, "chat", "view", req);
  const available = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && (org[r]?.mbUuid || SHARED_UUIDS[r]));
  const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
  const orgConfig = {
    slug,
    displayName: org.displayName || `${slugTitle} Parks & Recreation`,
    logoUrl: org.logoUrl || "",
    reports: available,
    token: org.token || "",
  };
  const html = require("fs").readFileSync(path.join(__dirname, "public", "chat.html"), "utf8");
  const inject = `<script>window.ORG_CONFIG=${JSON.stringify(orgConfig)};</script>`;
  res.type("html").send(html.replace("</head>", inject + "</head>"));
});


// ── Report Wizard — HTML serving ──
app.get("/:org/report-wizard", (req, res) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  if (!org) return res.status(404).send("Unknown org");
  logEvent(slug, "report-wizard", "view", req);
  const available = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && (org[r]?.mbUuid || SHARED_UUIDS[r]));
  const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
  const orgConfig = {
    slug,
    displayName: org.displayName || `${slugTitle} Parks & Recreation`,
    logoUrl: org.logoUrl || "",
    reports: available,
    token: org.token || "",
  };
  const html = require("fs").readFileSync(path.join(__dirname, "public", "report-wizard.html"), "utf8");
  const inject = `<script>window.ORG_CONFIG=${JSON.stringify(orgConfig)};</script>`;
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

// ── POST /:org/:report/api/vote — quick thumbs up/down ──────────────
app.post("/:org/:report/api/vote", (req, res) => {
  const org = req.params.org;
  const report = req.params.report;
  const { sentiment } = req.body || {};
  if (!ORGS[org]) return res.status(404).json({ error: "Unknown org" });
  if (!["up", "down"].includes(sentiment)) return res.status(400).json({ error: "sentiment must be up or down" });
  const counts = recordVote(org, report, sentiment);
  console.log(`[vote] ${org}/${report} ${sentiment} → ${JSON.stringify(counts)}`);
  res.json({ ok: true, counts });
});

// ── GET /:org/admin/votes — vote counts for admin dashboard ─────────
app.get("/:org/admin/votes", (req, res) => {
  if (!ORGS[req.params.org]) return res.status(404).json({ error: "Unknown org" });
  const votes = loadVotes();
  const orgVotes = {};
  for (const [key, counts] of Object.entries(votes)) {
    if (key.startsWith(req.params.org + ":")) {
      const report = key.split(":")[1];
      orgVotes[report] = counts;
    }
  }
  res.json(orgVotes);
});

// ── GET /admin/votes — all vote counts (cross-org) ──────────────────
app.get("/admin/votes", (req, res) => {
  res.json(loadVotes());
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

// ── GET /:org/api/pulse — executive summary from cached report data ──
app.get("/:org/api/pulse", async (req, res) => {
  const slug = req.params.org;
  if (!ORGS[slug]) return res.status(404).json({ error: "Unknown org" });
  try {
    const pulse = await refreshOrgPulse(slug);
    if (!pulse) return res.json({ items: [], generated: null });
    res.json(pulse);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/:org", async (req, res, next) => {
  const slug = req.params.org;
  const org  = ORGS[slug];
  // Fall through to express.static so static assets like /feedback-widget.js
  // can be served. If nothing else matches, Express returns its default 404.
  if (!org) return next();

  const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
  const allAvailable = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && (org[r]?.mbUuid || SHARED_UUIDS[r]));
  const orgHidden = new Set(getHiddenReports(slug));
  const available = allAvailable.filter(r => !orgHidden.has(r));
  const orgConfig = {
    slug,
    displayName: org.displayName || `${slugTitle} Parks & Recreation`,
    logoUrl: org.logoUrl || "",
    reports: available,
    token: org.token || "",
    chatVisible: !orgHidden.has("chat"),
    wizardVisible: !orgHidden.has("report-wizard"),
  };
  // Attach latest health-check results for this org's reports
  const hc = loadHealthResults();
  if (hc && hc.reports && hc.reports[slug]) {
    orgConfig.healthCheck = { timestamp: hc.timestamp, reports: hc.reports[slug] };
  }
  // Attach 30-day usage metrics for org portal header
  try {
    const m = buildMetrics(slug, 30);
    const cr = m.configuredReports || [];
    orgConfig.metrics = {
      views:   cr.reduce((n, r) => n + (m.summary[r]?.view  || 0), 0),
      exports: cr.reduce((n, r) => n + (m.summary[r]?.excel || 0) + (m.summary[r]?.pdf || 0), 0),
      clicks:  Object.values(m.summary).reduce((n, s) => n + (s.click || 0), 0),
      subscribers: m.totalSubscribers,
      aiInsights:  m.insights.calls,
      reports: cr.length,
    };
  } catch(e) { orgConfig.metrics = null; }
  // Inject executive pulse summary from cached data
  try { orgConfig.pulse = await refreshOrgPulse(slug); } catch(e) { orgConfig.pulse = null; }
  const html = require("fs").readFileSync(path.join(__dirname, "public", "org.html"), "utf8");
  const inject = `<script>window.ORG_CONFIG=${JSON.stringify(orgConfig)};</script>`;
  res.type("html").send(html.replace("</head>", inject + "</head>"));
});

// ── POST /api/admin/toggle-report — show/hide a report on the org page ──
app.post("/api/admin/toggle-report", express.json(), (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  const { org: slug, report } = req.body || {};
  if (!ORGS[slug]) return res.status(404).json({ error: "Unknown org" });
  if (!REPORT_TYPES.includes(report) && report !== "chat" && report !== "report-wizard") return res.status(400).json({ error: "Unknown report type" });
  const hidden = getHiddenReports(slug);
  const idx = hidden.indexOf(report);
  if (idx >= 0) hidden.splice(idx, 1); else hidden.push(report);
  setHiddenReports(slug, hidden);
  res.json({ ok: true, hidden });
});

// ── GET /api/health-check — latest health check results ──────────────
app.get("/api/health-check", (req, res) => {
  const results = loadHealthResults();
  if (!results) return res.json({ timestamp: null, reports: {}, failures: [] });
  res.json(results);
});

// ── POST /api/health-check/run — trigger health check manually ───────
app.post("/api/health-check/run", express.json(), async (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  try {
    const results = await runHealthCheck(true);  // forceAll
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/health-config — current tier configuration ──────────────
app.get("/api/health-config", (req, res) => {
  res.json({
    tiers: HEALTH_TIERS,
    defaults: DEFAULT_REPORT_TIER,
    overrides: loadHealthConfig(),
  });
});

// ── POST /api/health-config — update tier for org/report ─────────────
// Body: { org, report?, tier } — sets tier for a specific report, or
//        org-wide default if report is "_default" or omitted.
// Tier must be "critical", "standard", or "low".
app.post("/api/health-config", express.json(), (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  const { org, report, tier } = req.body || {};
  if (!ORGS[org]) return res.status(404).json({ error: "Unknown org" });
  if (!HEALTH_TIERS[tier]) return res.status(400).json({ error: "Tier must be critical, standard, or low" });
  const cfg = loadHealthConfig();
  if (!cfg[org]) cfg[org] = {};
  cfg[org][report || "_default"] = tier;
  saveHealthConfig(cfg);
  res.json({ ok: true, config: cfg[org] });
});

// ── DELETE /api/health-config — remove tier override ─────────────────
app.delete("/api/health-config", express.json(), (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  const { org, report } = req.body || {};
  if (!org) return res.status(400).json({ error: "org required" });
  const cfg = loadHealthConfig();
  if (cfg[org]) {
    delete cfg[org][report || "_default"];
    if (Object.keys(cfg[org]).length === 0) delete cfg[org];
    saveHealthConfig(cfg);
  }
  res.json({ ok: true, config: cfg[org] || {} });
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
    programs: "Programs",
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

// ── GET /api/admin/flags — read feature flags ───────────────────────
app.get("/api/admin/flags", (req, res) => { res.json(getFlags()); });

// Audit log viewer
app.get("/api/admin/audit-log", (req, res) => {
  const days = parseInt(req.query.days) || 3;
  const orgFilter = (req.query.org || '').trim().toLowerCase();
  const reportFilter = (req.query.report || '').trim().toLowerCase();
  let events = readEvents(days).reverse(); // newest first
  if (orgFilter) events = events.filter(e => (e.org || '').toLowerCase().includes(orgFilter));
  if (reportFilter) events = events.filter(e => (e.report || '').toLowerCase().includes(reportFilter));
  res.json({ total: events.length, events: events.slice(0, 500) });
});

// Cache performance stats
app.get("/api/admin/cache-stats", (req, res) => {
  const entries = [];
  for (const [k, v] of dataCache) {
    const ttl = REPORT_CACHE_TTL[v.rt] || CACHE_TTL;
    const ageMin = Math.round((Date.now() - v.ts) / 60000);
    const ttlMin = Math.round(ttl / 60000);
    entries.push({ key: k, report: v.rt, ageMin, ttlMin, rows: v.data?.rows?.length || 0 });
  }
  const hitRate = (cacheStats.hits + cacheStats.misses) > 0
    ? ((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(1)
    : '0';
  res.json({
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    hitRate: hitRate + '%',
    prewarms: cacheStats.prewarms,
    entries: entries.length,
    usersCache: usersCache.size,
    pulseCache: pulseCache.size,
    detail: entries.sort((a, b) => a.ageMin - b.ageMin),
  });
});

// ── POST /api/admin/flags — update a feature flag ───────────────────
app.post("/api/admin/flags", express.json(), (req, res) => {
  const { password, key, value } = req.body || {};
  if (!password || password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  if (!key || typeof value !== "boolean") {
    return res.status(400).json({ error: "Provide key (string) and value (boolean)" });
  }
  const flags = setFlag(key, value);
  console.log(`[flags] ${key} set to ${value}`);
  res.json({ ok: true, flags });
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
// ── POST /api/admin/update-shared-link — change a shared base report UUID ──
app.post("/api/admin/update-shared-link", async (req, res) => {
  if (dashboardPasswordBlocked(req, res)) return;
  const { report, link } = req.body || {};
  if (!report || !SHARED_UUIDS[report]) {
    return res.status(400).json({ error: '"' + report + '" is not a shared report' });
  }
  const newUuid = extractMbUuidFromInput(link);
  if (!newUuid || !STRICT_UUID.test(newUuid)) {
    return res.status(400).json({ error: "Could not find a valid Metabase UUID in that link" });
  }
  if (newUuid === SHARED_UUIDS[report]) {
    return res.status(400).json({ error: "That's already the current shared UUID for this report" });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(503).json({ error: "GITHUB_TOKEN not configured on the server" });
  }
  try {
    const token = process.env.GITHUB_TOKEN;
    const repo = "danj707/rental-report";
    const filePath = "server.js";
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
    });
    if (!getRes.ok) throw new Error("Failed to fetch server.js from GitHub");
    const fileData = await getRes.json();
    const src = Buffer.from(fileData.content, "base64").toString("utf8");
    const keyPat = report.includes("-") ? `"${report}"` : report;
    const re = new RegExp('(' + keyPat + ':\\s*")([0-9a-f-]{36})(")');
    if (!re.test(src)) throw new Error("Could not find " + report + " UUID in SHARED_UUIDS block");
    const oldUuid = (src.match(re) || [])[2];
    const newSrc = src.replace(re, '$1' + newUuid + '$3');
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
      method: "PUT",
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Update shared ${report} UUID -> ${newUuid}`,
        content: Buffer.from(newSrc).toString("base64"),
        sha: fileData.sha,
      }),
    });
    if (!putRes.ok) { const e = await putRes.json(); throw new Error(e.message || "GitHub push failed"); }
    const putData = await putRes.json();
    SHARED_UUIDS[report] = newUuid;
    console.log(`[update-shared-link] ${report}: ${oldUuid} -> ${newUuid}`);
    res.json({ ok: true, oldUuid, newUuid, commitUrl: putData.commit?.html_url || null, publicUrl: `${METABASE_URL}/public/question/${newUuid}` });
  } catch (err) {
    console.error("[update-shared-link] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

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

// ── Showcase gallery API (server-persisted) ─────────────────────────
function showcaseLoad() {
  try { return JSON.parse(fs.readFileSync(SHOWCASE_FILE, "utf8")); }
  catch(e) { return []; }
}
function showcaseSave(imgs) {
  fs.writeFileSync(SHOWCASE_FILE, JSON.stringify(imgs, null, 2));
}

app.post("/api/admin/showcase", express.json({ limit: "50mb" }), (req, res) => {
  const { data, caption } = req.body || {};
  if (!data) return res.status(400).json({ error: "Image data required" });
  const imgs = showcaseLoad();
  imgs.push({ data, caption: caption || "" });
  showcaseSave(imgs);
  res.json({ ok: true, count: imgs.length });
});

app.delete("/api/admin/showcase/:index", (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const imgs = showcaseLoad();
  if (isNaN(idx) || idx < 0 || idx >= imgs.length) return res.status(400).json({ error: "Invalid index" });
  imgs.splice(idx, 1);
  showcaseSave(imgs);
  res.json({ ok: true, count: imgs.length });
});

// ── Partner quotes persistence ──────────────────────────────────────
const DEFAULT_QUOTES = [
  { text: "Amazing!", author: "Kaz, Watertown" },
  { text: "This is incredible! It takes so much of the guesswork from running custom reports, since this is the info we are looking for most of the time anyway. My year end reporting will be much more detailed now, and I can see this feature supporting us in making program and policy decisions.", author: "Laurel, Shrewsbury" },
];
function quotesLoad() {
  try { return JSON.parse(fs.readFileSync(QUOTES_FILE, "utf8")); }
  catch(e) { return [...DEFAULT_QUOTES]; }
}
function quotesSave(arr) {
  fs.writeFileSync(QUOTES_FILE, JSON.stringify(arr, null, 2));
}

app.get("/api/admin/quotes", (req, res) => {
  res.json(quotesLoad());
});
app.post("/api/admin/quotes", express.json(), (req, res) => {
  const { text, author } = req.body || {};
  if (!text || !author) return res.status(400).json({ error: "text and author required" });
  const quotes = quotesLoad();
  quotes.push({ text: text.trim(), author: author.trim() });
  quotesSave(quotes);
  res.json({ ok: true, count: quotes.length });
});
app.delete("/api/admin/quotes/:index", (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const quotes = quotesLoad();
  if (isNaN(idx) || idx < 0 || idx >= quotes.length) return res.status(400).json({ error: "Invalid index" });
  quotes.splice(idx, 1);
  quotesSave(quotes);
  res.json({ ok: true, count: quotes.length });
});

// ── Root index — all orgs dashboard ─────────────────────────────────

// ── GET /api/admin/ai-analytics — AI usage metrics for dashboard ─────
app.get("/api/admin/ai-analytics", (req, res) => {
  try {
    const events = readEvents();
    const now = Date.now();
    const d7  = 7  * 86400000;
    const d30 = 30 * 86400000;

    // AI features: insights, message (chat), generate (wizard), recommend
    const aiActions = new Set(["insights", "message", "generate"]);
    const aiEvents = events.filter(e => aiActions.has(e.event) || e.report === "calendar" && e.event === "recommend");

    // By feature
    const byFeature = {};
    const byOrg = {};
    let total7d = 0, total30d = 0, totalCost7d = 0, totalCost30d = 0;
    let totalIn = 0, totalOut = 0;

    for (const e of aiEvents) {
      const age = now - new Date(e.ts).getTime();
      const feature = e.event === "insights" ? "insights"
                    : e.event === "message"  ? "chat"
                    : e.event === "generate" ? "wizard"
                    : "recommend";

      if (!byFeature[feature]) byFeature[feature] = { calls: 0, cost: 0, calls7d: 0 };
      byFeature[feature].calls++;
      byFeature[feature].cost += e.costUsd || 0;
      if (age < d7) byFeature[feature].calls7d++;

      const org = e.org || "unknown";
      if (!byOrg[org]) byOrg[org] = { calls: 0, cost: 0 };
      byOrg[org].calls++;
      byOrg[org].cost += e.costUsd || 0;

      if (age < d7)  { total7d++;  totalCost7d  += e.costUsd || 0; }
      if (age < d30) { total30d++; totalCost30d += e.costUsd || 0; }
      totalIn  += e.inTok  || 0;
      totalOut += e.outTok || 0;
    }

    // Feedback from wizard + chat votes
    const feedbackEvents = events.filter(e => e.event === "feedback" && e.vote);
    let thumbsUp = 0, thumbsDown = 0;
    feedbackEvents.forEach(e => {
      if (e.vote === "up") thumbsUp++;
      else if (e.vote === "down") thumbsDown++;
    });

    // Top 5 orgs by calls
    const topOrgs = Object.entries(byOrg)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 8)
      .map(([org, d]) => ({ org, calls: d.calls, cost: d.cost }));

    res.json({
      totalCalls: aiEvents.length,
      calls7d: total7d,
      calls30d: total30d,
      cost7d: totalCost7d,
      cost30d: totalCost30d,
      totalTokensIn: totalIn,
      totalTokensOut: totalOut,
      byFeature,
      topOrgs,
      feedback: { up: thumbsUp, down: thumbsDown },
    });
  } catch (err) {
    console.error("[ai-analytics]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  // Compute AI spend from events log
  const allEvents = readEvents();
  const aiEvents = allEvents.filter(e => e.event === "insights" || e.event === "message");
  const aiSpend = { total: 0, last7d: 0, last24h: 0, calls: 0 };
  const now = Date.now();
  aiEvents.forEach(e => {
    const cost = e.costUsd || 0;
    aiSpend.total += cost;
    aiSpend.calls += 1;
    const age = now - new Date(e.ts).getTime();
    if (age < 7 * 86400000) aiSpend.last7d += cost;
    if (age < 86400000) aiSpend.last24h += cost;
  });

  const reportMeta = {
    facility: { label: "Facility Rental Schedule", icon: "📅", desc: "Reservations grouped by date and location", color: "#16a34a" },
    gl:       { label: "GL Code Rollup",            icon: "📊", desc: "Payment and refund summary by GL code",   color: "#3b82f6" },
    programs: { label: "Programs",           icon: "🎯", desc: "Enrollment and revenue by program",       color: "#7c3aed", ai: true },
    historic: { label: "Historic Buildings",        icon: "🏛️",  desc: "Reservations for historic building sites", color: "#d97706" },
    roster:   { label: "Class Roster",              icon: "📋", desc: "Enrolled and cancelled participants by section", color: "#0891b2" },
    overview:    { label: "Facility Overview",         icon: "📈", desc: "Revenue and activity summary by location",                 color: "#059669" },
    products:    { label: "Product Sales",          icon: "🛒", desc: "Daily revenue, refunds, and net by product",           color: "#0891b2" },
    memberships: { label: "Memberships",                icon: "🎫", desc: "Active and lapsed memberships with renewal tracking",       color: "#db2777" },
    "court-utilization": { label: "Court Utilization",  icon: "🎾", desc: "Court utilization % or reserved hours by court, split by customer, program, and closure usage", color: "#0d9488", ai: true },
    calendar:    { label: "Calendar",               icon: "🗓️", desc: "Public class & rental schedule (week / list view)", color: "#ea580c", wcag: true },
    fasttrack:   { label: "Fast Track",             icon: "⚡", desc: "Pre-registration demand signal with conversion tracking", color: "#6366f1", ai: true },
    users:       { label: "Community Intel",            icon: "👥", desc: "Demographics, revenue, and strategy intelligence across your community", color: "#7c3aed", ai: true },
    "instructor-payout": { label: "Instructor Payout", icon: "💰", desc: "Revenue splits and payout calculations by instructor", color: "#6366f1" },
  };

  const hiddenReports = getAllHiddenReports();
  const allVotes = loadVotes();
  const healthData = loadHealthResults();
  const healthCfg = loadHealthConfig();

  const orgSections = Object.entries(ORGS).sort((a, b) => {
    const nameA = (a[1].displayName || a[0]).toLowerCase();
    const nameB = (b[1].displayName || b[0]).toLowerCase();
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  }).map(([slug, org]) => {
    const available    = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && (org[r]?.mbUuid || SHARED_UUIDS[r]));
    const slugTitle    = slug.charAt(0).toUpperCase() + slug.slice(1);
    const displayName  = org.displayName || `${slugTitle} Parks &amp; Recreation`;
    const tokenQS      = org.token ? `?token=${encodeURIComponent(org.token)}` : "";

    // Standard Metabase-backed report cards
    const orgHidden = hiddenReports[slug] || [];
    const cards = available.map(r => {
      const m = reportMeta[r] || { label: r, icon: "\u{1F4C4}", desc: "", color: "#888" };
      const isHidden = orgHidden.indexOf(r) >= 0;
      const dimCls = isHidden ? ' report-card-hidden' : '';
      return `
        <a href="/${slug}/${r}${tokenQS}" class="report-card${dimCls}" style="--accent:${m.color}" data-org="${slug}" data-report="${r}">
          <span class="report-icon">${m.icon}</span>
          <div class="report-body">
            <div class="report-label">${m.label}${m.ai ? ' <span class="ai-pill-inline">AI</span>' : ''}${m.wcag ? ' <span class="wcag-pill-inline">AA</span>' : ''}</div>
            <div class="report-desc">${m.desc}</div>
          </div>
          <div class="report-right">
            ${(() => { const v = allVotes[slug + ':' + r]; return v && v.up ? '<span class="vote-count" title="' + (v.up||0) + ' up / ' + (v.down||0) + ' down">' + v.up + ' \uD83D\uDC4D</span>' : ''; })()}
            ${(() => {
              const tier = getTier(slug, r);
              const tierFreq = {critical:'hourly',standard:'6h',low:'daily'}[tier];
              const h = healthData?.reports?.[slug]?.[r];
              let dotCls = 'health-dot';
              let tipParts = ['Monitoring: ' + tier + ' (' + tierFreq + ')'];
              if (h) {
                const d = new Date(h.checkedAt); const ds = d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
                if (h.status === 'ok') { dotCls += ' dot-ok'; tipParts.unshift('Verified ' + ds + ' (' + h.rows + ' rows)'); }
                else if (h.status === 'empty') { dotCls += ' dot-warn'; tipParts.unshift('Empty ' + ds); }
                else { dotCls += ' dot-err'; tipParts.unshift('Failed ' + ds + (h.error ? ': ' + h.error : '')); }
              } else { dotCls += ' dot-none'; }
              return '<span class="' + dotCls + '" title="' + tipParts.join('\n') + '" data-org="' + slug + '" data-report="' + r + '" data-tier="' + tier + '" onclick="event.preventDefault();event.stopPropagation();cycleTier(this)"></span>';
            })()}
          </div>
          <button type="button" class="vis-toggle" onclick="event.preventDefault();event.stopPropagation();toggleVis('${slug}','${r}',this)" title="${isHidden ? 'Hidden from org page' : 'Visible on org page'}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:${isHidden ? 'none' : 'block'}"><path d="M8 3C3 3 1 8 1 8s2 5 7 5 7-5 7-5-2-5-7-5z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:${isHidden ? 'block' : 'none'}"><path d="M8 3C3 3 1 8 1 8s2 5 7 5 7-5 7-5-2-5-7-5z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
        </a>`;
    });

    // Rec AI Chat card — toggleable like other reports
    if (available.length > 0) {
      const chatHidden = orgHidden.indexOf('chat') >= 0;
      const chatDim = chatHidden ? ' report-card-hidden' : '';
      cards.push(`
        <a href="/${slug}/chat${tokenQS}" class="report-card${chatDim}" style="border-left:3px solid #6366f1;background:linear-gradient(135deg,#f5f3ff 0%,#eef2ff 100%)" data-org="${slug}" data-report="chat">
          <span class="report-icon">\u2726</span>
          <div class="report-body">
            <div class="report-label" style="color:#312e81">Rec AI Chat <span class="ai-pill-inline">AI</span></div>
            <div class="report-desc">Ask anything about your data across all reports</div>
          </div>
          <button type="button" class="vis-toggle" onclick="event.preventDefault();event.stopPropagation();toggleVis('${slug}','chat',this)" title="${chatHidden ? 'Hidden from org page' : 'Visible on org page'}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:${chatHidden ? 'none' : 'block'}"><path d="M8 3C3 3 1 8 1 8s2 5 7 5 7-5 7-5-2-5-7-5z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:${chatHidden ? 'block' : 'none'}"><path d="M8 3C3 3 1 8 1 8s2 5 7 5 7-5 7-5-2-5-7-5z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
        </a>`);

      // Report Wizard card
      const wizHidden = orgHidden.indexOf('report-wizard') >= 0;
      const wizDim = wizHidden ? ' report-card-hidden' : '';
      cards.push(`
        <a href="/${slug}/report-wizard${tokenQS}" class="report-card${wizDim}" style="border-left:3px solid #7c3aed;background:linear-gradient(135deg,#faf5ff 0%,#f3e8ff 100%)" data-org="${slug}" data-report="report-wizard">
          <span class="report-icon">&#x1FA84;</span>
          <div class="report-body">
            <div class="report-label" style="color:#581c87">Report Wizard <span class="ai-pill-inline">AI</span></div>
            <div class="report-desc">Build custom dashboards from plain English prompts</div>
          </div>
          <button type="button" class="vis-toggle" onclick="event.preventDefault();event.stopPropagation();toggleVis('${slug}','report-wizard',this)" title="${wizHidden ? 'Hidden from org page' : 'Visible on org page'}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:${wizHidden ? 'none' : 'block'}"><path d="M8 3C3 3 1 8 1 8s2 5 7 5 7-5 7-5-2-5-7-5z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:${wizHidden ? 'block' : 'none'}"><path d="M8 3C3 3 1 8 1 8s2 5 7 5 7-5 7-5-2-5-7-5z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
        </a>`);
    }

    // Append a dashed "add report" tile for any report types this org lacks.
    const missing = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && !SHARED_UUIDS[r] && !(org[r] && org[r].mbUuid));
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

    // Build pulse metrics strip from cached data
    const pulse = getCachedPulse(slug);
    const pulseStrip = (pulse && pulse.items.length > 0)
      ? `<div class="org-pulse-strip">${pulse.items.map(it => {
          const deltaHtml = it.delta
            ? `<div class="pulse-delta ${it.direction === 'up' ? 'delta-up' : it.direction === 'down' ? 'delta-down' : ''}">${it.direction === 'up' ? '↑' : it.direction === 'down' ? '↓' : ''} ${it.delta}</div>`
            : '';
          return `<div class="pulse-item"><div class="pulse-val">${it.value}</div><div class="pulse-label">${it.label}</div><div class="pulse-sub">${it.sub}</div>${deltaHtml}</div>`;
        }).join("")}</div>` : "";

    const tokenRow = org.token ? `
        <div class="token-row">
          <span class="token-label">🔑 Access token</span>
          <code class="token-value">${org.token}</code>
          <button class="token-copy-btn" onclick="copyTokenURL('${slug}', this)" data-base="/${slug}?token=${encodeURIComponent(org.token)}">Copy landing URL</button>
        </div>` : "";

    return `
      <div class="org-section" id="org-${slug}">
        <div class="org-header">
          ${org.logoUrl ? `<img src="${org.logoUrl}" class="org-logo" alt="" onerror="this.style.display='none'" />` : ""}
          <div class="org-header-text">
            ${orgNameHtml}
            <div class="org-slug">${slug}</div>
          </div>
          ${headerActions}
        </div>
        ${pulseStrip}
        <div class="report-cards">${cards.join("")}</div>
        ${tokenRow}
        ${metricsToggle}
      </div>`;
  }).join("");

  // Org navigation bar (alphabetical, matching orgSections sort order)
  const orgNav = Object.entries(ORGS).sort((a, b) => {
    const nameA = (a[1].displayName || a[0]).toLowerCase();
    const nameB = (b[1].displayName || b[0]).toLowerCase();
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  }).map(([slug, org]) => {
    const label = org.displayName || (slug.charAt(0).toUpperCase() + slug.slice(1));
    return `<a href="#org-${slug}" style="color:#4f46e5;text-decoration:none;white-space:nowrap;font-weight:500" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${label}</a>`;
  }).join(' <span style="color:#d1d5db">&middot;</span> ');

  // Data for the "Add reports" modal: per-org missing report types + labels.
  const addReportMeta = Object.fromEntries(
    Object.entries(reportMeta).map(([k, m]) => [k, { label: m.label, icon: m.icon }])
  );
  const addReportOrgs = Object.fromEntries(
    Object.entries(ORGS).map(([slug, org]) => {
      const slugTitle = slug.charAt(0).toUpperCase() + slug.slice(1);
      const displayName = org.displayName || `${slugTitle} Parks & Recreation`;
      const missing = REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && !SHARED_UUIDS[r] && !(org[r] && org[r].mbUuid));
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
    /* ── Showcase hero card ── */
    .showcase-card {
      background: linear-gradient(135deg, #1e1b4b 0%, #312e81 40%, #4338ca 100%);
      border-radius: 14px; margin-bottom: 24px; overflow: hidden;
      box-shadow: 0 4px 24px rgba(30,27,75,.25);
    }
    .showcase-top { padding: 36px 40px 28px; }
    .showcase-badge {
      display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #a5b4fc; background: rgba(165,180,252,.12);
      padding: 4px 12px; border-radius: 20px; margin-bottom: 14px;
    }
    .showcase-title {
      font-size: 30px; font-weight: 800; color: #fff; line-height: 1.2; margin: 0 0 14px;
    }
    .showcase-desc {
      font-size: 14.5px; color: #c7d2fe; line-height: 1.65; max-width: 640px; margin: 0 0 24px;
    }
    .showcase-stats {
      display: flex; gap: 28px; flex-wrap: wrap;
    }
    .showcase-stat { text-align: center; }
    .showcase-stat-num {
      font-size: 26px; font-weight: 800; color: #fff; font-variant-numeric: tabular-nums;
    }
    .showcase-stat-label {
      font-size: 10px; color: #a5b4fc; text-transform: uppercase; letter-spacing: .06em; margin-top: 2px;
    }
    .ticker-wrap {
      margin-top: 20px; overflow: hidden; position: relative;
      mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
      -webkit-mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
    }
    .ticker {
      display: flex; gap: 32px; white-space: nowrap;
      animation: ticker-scroll 50s linear infinite;
    }
    .ticker-item {
      font-size: 12px; color: #c7d2fe; display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
    }
    .ticker-dot { width: 5px; height: 5px; border-radius: 50%; background: #818cf8; flex-shrink: 0; }
    @keyframes ticker-scroll {
      0% { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }
    /* Gallery */
    .showcase-gallery {
      display: flex; gap: 12px; overflow-x: auto; padding: 0 40px 0;
      scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch;
    }
    .showcase-gallery:empty { display: none; }
    .showcase-gallery .sg-item {
      flex: 0 0 auto; width: 320px; scroll-snap-align: start;
      border-radius: 10px; overflow: hidden; background: #000;
      position: relative; cursor: pointer; transition: transform .15s;
    }
    .showcase-gallery .sg-item:hover { transform: scale(1.02); }
    .showcase-gallery .sg-item img {
      width: 100%; display: block; object-fit: cover; max-height: 200px;
    }
    .showcase-gallery .sg-caption {
      position: absolute; bottom: 0; left: 0; right: 0;
      background: linear-gradient(transparent, rgba(0,0,0,.7));
      color: #fff; font-size: 12px; font-weight: 600; padding: 20px 12px 10px;
    }
    .showcase-gallery .sg-remove {
      position: absolute; top: 6px; right: 6px; width: 22px; height: 22px;
      border-radius: 50%; background: rgba(0,0,0,.5); color: #fff;
      border: none; font-size: 13px; cursor: pointer; display: none;
      align-items: center; justify-content: center; line-height: 1;
    }
    .showcase-gallery .sg-item:hover .sg-remove { display: flex; }
    .showcase-upload {
      padding: 16px 40px 28px; display: flex; align-items: center; gap: 12px;
    }
    .showcase-upload-btn {
      font-size: 12px; font-weight: 600; color: #a5b4fc; background: rgba(255,255,255,.08);
      border: 1px dashed rgba(165,180,252,.3); border-radius: 8px;
      padding: 8px 16px; cursor: pointer; transition: background .15s;
    }
    .showcase-upload-btn:hover { background: rgba(255,255,255,.14); }
    .showcase-upload-hint { font-size: 11px; color: rgba(165,180,252,.5); }
    /* Partner quotes */
    .partner-quotes { padding: 0 0 28px; }
    .partner-quotes-label {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
      color: #818cf8; padding: 0 40px 10px;
    }
    .pq-track-wrap {
      overflow: hidden; position: relative;
      mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
      -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
    }
    .pq-track {
      display: flex; gap: 20px; padding: 0 40px;
      animation: pq-scroll 28s linear infinite;
    }
    .pq-track:hover { animation-play-state: paused; }
    .pq-card {
      flex: 0 0 auto; max-width: 420px; background: rgba(255,255,255,.07);
      border: 1px solid rgba(165,180,252,.15); border-radius: 10px;
      padding: 16px 20px; position: relative;
    }
    .pq-card::before {
      content: "\\201C"; position: absolute; top: 8px; left: 12px;
      font-size: 32px; color: rgba(165,180,252,.25); font-family: Georgia, serif; line-height: 1;
    }
    .pq-text {
      font-size: 13px; color: #e0e7ff; line-height: 1.55; font-style: italic;
      margin: 0 0 8px; padding-left: 16px;
    }
    .pq-author {
      font-size: 11px; font-weight: 700; color: #a5b4fc; padding-left: 16px;
    }
    .pq-card .pq-del {
      position: absolute; top: 6px; right: 6px; width: 20px; height: 20px;
      border-radius: 50%; background: rgba(0,0,0,.35); color: #e0e7ff;
      border: none; font-size: 12px; cursor: pointer; display: none;
      align-items: center; justify-content: center; line-height: 1;
    }
    .pq-card:hover .pq-del { display: flex; }
    @keyframes pq-scroll {
      0% { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }
    /* Lightbox */
    .sg-lightbox {
      position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 2000;
      display: flex; align-items: center; justify-content: center; cursor: zoom-out;
    }
    .sg-lightbox img { max-width: 92vw; max-height: 88vh; border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,.5); }
    .sg-lightbox .sg-lb-caption { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      color: #fff; font-size: 14px; font-weight: 600; text-shadow: 0 2px 8px rgba(0,0,0,.6); }

        .org-section { background: #fff; border: 1px solid #e0ddd8; border-radius: 10px; margin-bottom: 20px; overflow: hidden; }
    .org-header { display: flex; align-items: center; gap: 14px; padding: 16px 20px; background: #f9f8f6; border-bottom: 1px solid #e8e5df; }
    .org-pulse-strip { display: flex; gap: 0; background: linear-gradient(135deg, #312e81 0%, #4338ca 50%, #4f46e5 100%); padding: 0; overflow-x: auto; }
    .pulse-item { flex: 1; min-width: 0; padding: 12px 16px; text-align: center; border-right: 1px solid rgba(255,255,255,0.1); }
    .pulse-item:last-child { border-right: none; }
    .pulse-val { font-size: 18px; font-weight: 700; color: #fff; white-space: nowrap; }
    .pulse-label { font-size: 11px; font-weight: 600; color: #a5b4fc; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .pulse-sub { font-size: 10px; color: rgba(165,180,252,0.7); margin-top: 1px; white-space: nowrap; }
    .pulse-delta { font-size: 10px; font-weight: 600; margin-top: 2px; white-space: nowrap; }
    .delta-up { color: #4ade80; }
    .delta-down { color: #f87171; }
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
    .ai-pill-inline { font-size: 9px; font-weight: 700; letter-spacing: 0.03em; padding: 1px 6px; border-radius: 10px; background: linear-gradient(90deg, #6d28d9, #0d9488); color: #fff; vertical-align: 1px; margin-left: 4px; }
    .wcag-pill-inline { font-size: 9px; font-weight: 700; letter-spacing: 0.03em; padding: 1px 6px; border-radius: 10px; background: linear-gradient(90deg, #0e7490, #2563eb); color: #fff; vertical-align: 1px; margin-left: 4px; }
    .report-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
    .vote-count { font-size: 10px; color: #888; white-space: nowrap; }
    .health-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; cursor: pointer; transition: transform .15s; background: #ddd; }
    .health-dot:hover { transform: scale(1.4); }
    .dot-ok { background: #22c55e; }
    .dot-warn { background: #f59e0b; }
    .dot-err { background: #ef4444; }
    .dot-none { background: #ddd; }
    .report-card-hidden { opacity: 0.4; }
    .report-card-hidden:hover { opacity: 0.7; }
    .report-card-hidden .report-label { text-decoration: line-through; }
    .vis-toggle { background: none; border: none; cursor: pointer; padding: 4px; border-radius: 4px; flex-shrink: 0; opacity: 0; transition: opacity .15s; color: #999; line-height: 0; }
    .report-card:hover .vis-toggle { opacity: 0.5; }
    .report-card-hidden .vis-toggle { opacity: 0.5; }
    .vis-toggle:hover { opacity: 1 !important; background: rgba(0,0,0,.05); color: #333; }
        .add-report-card { border: none; border-left: 3px dashed #cbd5c0; background: #fbfbf9; cursor: pointer; font: inherit; text-align: left; width: 100%; }
    .add-report-card:hover { background: #f3f6ef; border-left-color: #16a34a; }
    .add-report-card .report-icon { color: #16a34a; font-weight: 700; }
    .add-report-card .report-label { color: #16a34a; }
    /* health-dot and tier styles are in .health-dot/.dot-ok/.dot-warn/.dot-err above */
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
    /* ── Updates heat map ── */
    .updates-heatmap { background: #fff; border: 1px solid #e8e6e0; border-radius: 6px; padding: 14px 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
    .updates-heatmap .uhm-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.7px; color: #888; margin-bottom: 10px; }
    .updates-heatmap .uhm-grid { display: flex; gap: 0; overflow-x: auto; }
    .updates-heatmap .uhm-day-labels { display: flex; flex-direction: column; gap: 2px; margin-right: 4px; }
    .updates-heatmap .uhm-day-label { height: 13px; font-size: 9px; color: #999; display: flex; align-items: center; justify-content: flex-end; padding-right: 2px; }
    .updates-heatmap .uhm-weeks { display: flex; gap: 2px; }
    .updates-heatmap .uhm-week { display: flex; flex-direction: column; gap: 2px; }
    .updates-heatmap .uhm-cell { width: 13px; height: 13px; border-radius: 2px; }
    .updates-heatmap .uhm-months { display: flex; gap: 2px; margin-left: 22px; margin-bottom: 4px; }
    .updates-heatmap .uhm-month { font-size: 9px; color: #999; }
    .updates-heatmap .uhm-legend { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 9px; color: #aaa; }
    .updates-heatmap .uhm-legend-cells { display: flex; gap: 2px; }
    .updates-heatmap .uhm-legend-cell { width: 13px; height: 13px; border-radius: 2px; }
    .updates-heatmap .uhm-stats { display: flex; gap: 16px; margin-top: 10px; font-size: 11px; color: #666; flex-wrap: wrap; }
    .updates-heatmap .uhm-stat-val { font-weight: 700; color: #222; }
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
    <img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCADIAMgDASIAAhEBAxEB/8QAHAABAAMBAQEBAQAAAAAAAAAAAAYHCAUDAgQB/8QARhAAAQMCAgYECgQMBwAAAAAAAAECAwQFBhEHEiExUXETQWGBFBYiMjdSg5GhszZCdLIVFyMkQ0RicpKTorEmNFNUVYLS/8QAGwEBAAIDAQEAAAAAAAAAAAAAAAMEAQUGAgf/xAAwEQACAgIAAwUHBAMBAAAAAAAAAQIDBBEFEiEGEzFBcSIyM1FhsdE0cpHhgaHB8P/aAAwDAQACEQMRAD8AsIAHyg6UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEQ0o+jm7ex+cwmxqu+ujVvW2l/J5nLki5fIl4Mfoq8Tu4KX/G1k2/rsX3kOks7NKMHLvPD6f2UI5+2ly/7NRgo3SDpIr6y51Fqs9S+mooHLG+WJ2T5nJsXyupvLeVu2rqY5+nZUStmzz6RHqjveQ43ZyyytTsnyt+WtnqzPjF6S2a6BUOjPSJV1lwjsd6mWd0uymqHr5Wt6rl68+pd+fHMtySRkUbpJHNYxqZuc5ckanFTT5mDbiW91Pr8vqWqro2R5kfQKlxZphbBI+jw5GyVyZtWslTNv/RvXzX3FYXLFF8uz1dXXWqmRfqLIqNTk1Nie42eL2fyLlzWPlX+/4K9mdCL0upqkGQWyyMfrNkc13FFyUkNox3iSyyNWmuk740/RTu6RipwyXd3ZFqzszNL2LNv01+SOPEFv2kadBBMF6S6HE720VYxtHcl81mt5Ev7qr19i/EnZz2TjW40+7tWmXq7I2LcWACH4w0hWvCbVg/zdxVM0p43Zava931eW880Y9mRPkqW2ZnOMFuTJgDNl50k4mvL3Z3B9JCu6Kl/JonenlL3qRaapnnfrzTSSO4vcqqdDV2asa3ZNL/G/wUZcQivdRrwGTaK83O3PR9FcKmnVP9KVzf7KaPwJcau7YKttdXTLNUytfryKiIrsnuRN3YiFHiXB5YUFZzbTeiajKVr5daJGADTFoAAAAAAEP0peji7ex+cwmBD9KXo4u3sfnMLnD/1dX7l9yK/4cvRmbUO5g9HLjKzoxcnrVx6q9ushxDu4K+m9k+2RfeQ+j3PVcn9GaGHvI400b45nskarXtcqORd6L1nmXXj3RdPdK+W72LU6eVdaalcurrO63NXdmvWildM0f4sfP0KWOqR2eWaoiN/iVcipjcSxrq1NSS+ab8CWzHnGWtH4cKRzS4ttDIM+k8MiVuXV5SbSfaWcaSVNY/DtBLlTwr+duavnv9TknX28jsYXwN4i2utxJdnRS3CnpnviibtbF5K9fW5d3eu8pWeaSonkmlcr5JHK97l3qq7VUgr7nNye9j1UOi9X+D3Lmpr5X4s8ztWHCl5xJI5tronzNauT5VVGsbzcuzu3nPt8EFTcKeGqnSnp3yNSSZUz1G57V9xoK2Y2wLaLdDQUN1gip4W6rWpG/wB6+TtXtJOI5luPFKmDlJ/Tojzj1Rm/bekVrLobxPHCr2uoZHb+jbMufxRE+JCrnaq6z1rqS40slNO3ex6dXFOKdqGivxk4Q/5uL+W//wAkQ0i3/B+JsNyJT3SGS40/l0ypG9FX1m56u5U+KIa7C4nmytUMip6fnp9Ce7HpUdwl19SmopHwyskjerJGKjmuauSoqblRTSOjzFXjTh1JJ3ItfTKkVR+16r+9PiimaywNEF0dRY0SkV2UdbC6NU6tZqayL8FTvLvGsSORiyfnHqv+kWJa4WJeTLS0hYvTClj/ADdUW41WbKdF26vF68s071QzlPPLUzvnnkdJLI5XPe9c1cq71VSX6Ubu+6Y4rGa2cVHlTxpw1fO/qVxCzPCMKONjJ69qXVmMq1zsa8kDvW/BeI7pCk1JZ6p8Tkza9zNRHclXLMsfRTgalkoGYhuUDZpJHL4LG9M2tRFy11TjnnlyzLc5lHiHHlRY6qo7a8WyajC5480mZXuWE7/aIllr7VVQxJvkVmbU5uTYX3oy9Hdo/dk+a8ljmo5qtVEc1diovWeNJSU9DTNp6WFkMDVVWxsTJG5qqrknNVNLn8YebQq5R009/ct04qqnzJnuADSlsAAAAAAEP0peji7ex+cwmBD9KXo4u3sfnMLnD/1dX7l9yK/4cvRmbTvYJ+m9k+2RfeQ4J3sE/TeyfbIvvIfRr/hS9H9jRV++jUgAPlz8ToiMaQ9bxAvGrv6FPdrJmZlNZ3m3tu1lrre5UTwmB8Wa9SqmSKZRnhkpqiSCVqskjerHtXeiouSodj2amnTOHnvf/v4NVxCPtpnkMl4HTw/dfwLfqO4rE2VsMiK+NyZ6zdzk9yqabtq2a72+GuoYaWanmbrNe2NvuXgvYbHiPEnhabhtPz2QUY6u310ZRyXgoyXga4/B1F/s6f8AltOXf62yYctMtwr6emaxieQxI260jupre011faNWSUIVNt/X+id4HKtuRlzLsJDgR7o8dWZzc8/Cmp79hauEtIlgvsjaS5UNJb61y5MzY3opOSruXsUsJlDSRvR7KWBrk2oqRoioes3jM6U6raWtr5/0KcRS1KMjLuKdbxtvGv53hs2fPXU5HWTPSjaX2vHFY/VVIqzKojXjred/UjiGG9xrFZTGcfNIpWRcZtM1PhHo/E2ydFlq+BQ7uOomfxzO0VHopxxSx0LMO3OdsUkbl8EkeuTXIq56irxz3e4tw+fcSxrKMmSmvF9PqbzHsjOtaAP4qo1qucqIibVVTxo6ymr6ZtTSTsngcqo2Ri5tdqqrVyXmilHleubXQm2t6PcAHkAAAAAAAh+lL0cXb2PzmEwIfpS9HF29j85hc4f+rq/cvuRXfDl6Mzad7BP03sn2yL7yHCyXgp3sFIvjvZNn65F95D6Nf8KXo/saKv30ajAB8tfidECltLOCZIKuTEVvhV0Eu2rY1PMd6/Jevt5l0ny9jZI3Me1HMcmq5rkzRU4F3AzZ4dysj4ea+aIrqlbHlZkA7FjxRecOSK+11skCO2uZscx3Nq7O8tHFeh6OplfWYdkZA5drqSVcmL+47q5L70KvueFL9aHubXWmqiRv1+jVzP4kzT4ndUZuLmQ0mnvyf4NNOm2p7JO7TFil0Wo3wJrvXSDb/fL4ERu99ud+qvCbnWSVMnVrLsb2IibETkfgSKRz9VGOV3BE2nbteDMRXd6JR2mpc1f0j2ajP4nZISxpxcb20lH69EYc7bOjbZwTQmiunv0eGulu1RI6mky8DhlTNzWcc9+S9Sdnac7COiOltk0ddfXx1dQ1dZlOxM4mr+1n53LdzLO3JsQ5rjXFqrodxV1+v4/JfxMaUHzyIhpCwgmK7FlTtalwpc306rs1uLO/L3ohnGeCWmnkgnjdHLG5WvY9Mlaqb0VDXpD8YaPbZitFqM/BLiiZJUMbnr8EenXz3kXB+MLHXc3e79v6PWVi957cPEzcd6340xJa4UhpLxVMibsaxz9dE5IueR0Lzo2xNZnuV1A+rhRdktJ+URe5PKTvQi01PPTv1ZoZI3cHtVFOuU8fJj01Jf4ZrGp1v5HUueK79eI1ir7tVTRLvjV+TV7k2F8aLfRxafbfOeZ9orNc7jIjKK31NQ5eqKJXf2Q0bgC21lnwRbaGuhWGpjSRXxqqKrdaRzk3dioaLtB3UMRVw0uvgvRlzB5nY3L5ElABxhtQAAAAAAAAAADPM/mNIAAwAAAAAAAADO2NAAGAAAAAAZTaAABjbYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//Z" style="height:26px;border-radius:5px;margin-right:2px" alt="rec" /><div class="topbar-logo">rec<span>.</span>us</div>
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
    <span style="color:#444;margin:0 4px">│</span>
    <span style="color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:10px">AI Spend</span>
    <span style="color:#4ade80;font-weight:700">$${aiSpend.total.toFixed(2)}</span>
    <span style="color:#666">24h: $${aiSpend.last24h.toFixed(2)}</span>
    <span style="color:#666">7d: $${aiSpend.last7d.toFixed(2)}</span>
    <span style="color:#666">${aiSpend.calls} calls</span>
    <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener"
       style="color:#a78bfa;text-decoration:none;font-size:10px;font-weight:600;margin-left:4px"
       onmouseover="this.style.color='#c4b5fd'" onmouseout="this.style.color='#a78bfa'">↗ Add Credits</a>
    <span style="color:#444;margin:0 4px">|</span>
    <span style="color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:10px">Health</span>
    <span style="color:#555;font-size:9px" title="critical=hourly, standard=6h, low=daily">(tiered)</span>
    ${(() => {
      const hc = healthData;
      if (!hc || !hc.timestamp) return '<span style="color:#999">No check yet</span>';
      const d = new Date(hc.timestamp);
      const ds = d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' + d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      const fc = hc.failures?.length || 0;
      if (fc === 0) return '<span style="color:#22c55e;font-weight:700">✅ All passing</span><span style="color:#666">' + ds + '</span>';
      return '<span style="color:#ef4444;font-weight:700">❌ ' + fc + ' failing</span><span style="color:#666">' + ds + '</span>';
    })()}
    <button onclick="runHealthCheck(this)" style="font-size:10px;color:#3b82f6;background:none;border:1px solid #3b82f6;border-radius:4px;padding:2px 8px;cursor:pointer;margin-left:2px" onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background='none'">Run Now</button>
    <span style="color:#444;margin:0 4px">|</span>
    <span style="color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:10px">Backup</span>
    <span id="bk-dot" style="width:8px;height:8px;border-radius:50%;background:#555;flex-shrink:0;display:inline-block"></span>
    <span id="bk-status" style="color:#999;font-size:11px">...</span>
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
    // Fetch backup status too
    fetch('/api/admin/backup-status')
      .then(r=>r.json()).then(b=>{
        const dot=document.getElementById('bk-dot'),st=document.getElementById('bk-status');
        if(!dot||!st) return;
        if(b.status==='ok'){
          const ago=Math.round((Date.now()-new Date(b.ts).getTime())/3600000);
          const color=ago<25?'#22c55e':ago<49?'#f59e0b':'#ef4444';
          dot.style.background=color;
          st.style.color=color;
          st.textContent=ago<1?'Just now':ago+'h ago';
          st.title='Last: '+new Date(b.ts).toLocaleString()+' · '+b.files+' files · '+(b.size/1024).toFixed(1)+'KB';
        } else if(b.status==='never'){
          dot.style.background='#f59e0b'; st.textContent='Pending'; st.style.color='#f59e0b';
        } else if(b.status==='error'){
          dot.style.background='#ef4444'; st.textContent='Failed'; st.style.color='#ef4444';
          st.title=b.error||'Unknown error';
        } else if(b.status==='skipped'){
          dot.style.background='#f59e0b'; st.textContent='No PAT'; st.style.color='#f59e0b';
        }
      }).catch(()=>{});
    setTimeout(fetchRailwayStatus,60000);
  })();
  // Cache dashboard password for the session so admins aren't prompted repeatedly
  function getDashPwd(actionLabel) {
    var cached = sessionStorage.getItem('_dpwd');
    if (cached) return cached;
    var pwd = prompt((actionLabel ? actionLabel + '\\n' : '') + 'Dashboard password:');
    if (pwd) sessionStorage.setItem('_dpwd', pwd);
    return pwd;
  }
  function clearDashPwd() { sessionStorage.removeItem('_dpwd'); }

  async function runHealthCheck(btn) {
    var pwd = getDashPwd();
    if (!pwd) return;
    btn.textContent = 'Running…'; btn.disabled = true;
    try {
      const r = await fetch('/api/health-check/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) });
      const d = await r.json();
      if (!r.ok) { clearDashPwd(); btn.textContent = d.error || 'Auth failed'; return; }
      const fc = d.failures?.length || 0;
      btn.textContent = fc === 0 ? '\u2705 Done' : '\u274C ' + fc + ' failed';
      setTimeout(() => location.reload(), 1500);
    } catch(e) { btn.textContent = 'Error'; }
  }
  async function cycleTier(el) {
    var tiers = ['critical', 'standard', 'low'];
    var cur = el.dataset.tier;
    var next = tiers[(tiers.indexOf(cur) + 1) % tiers.length];
    var pwd = getDashPwd('Set ' + el.dataset.org + '/' + el.dataset.report + ' \u2192 ' + next);
    if (!pwd) return;
    try {
      var r = await fetch('/api/health-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd, org: el.dataset.org, report: el.dataset.report, tier: next }) });
      if (!r.ok) { clearDashPwd(); var d = await r.json(); alert(d.error || 'Failed'); return; }
      location.reload();
    } catch(e) { alert('Error: ' + e.message); }
  }
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

    <!-- ── Showcase Hero — hackathon demo card ── -->
    <div class="showcase-card" id="showcase">
      <div class="showcase-top">
        <div class="showcase-text">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px"><img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCADIAMgDASIAAhEBAxEB/8QAHAABAAMBAQEBAQAAAAAAAAAAAAYHCAUDAgQB/8QARhAAAQMCAgYECgQMBwAAAAAAAAECAwQFBhEHEiExUXETQWGBFBYiMjdSg5GhszZCdLIVFyMkQ0RicpKTorEmNFNUVYLS/8QAGwEBAAIDAQEAAAAAAAAAAAAAAAMEAQUGAgf/xAAwEQACAgIAAwUHBAMBAAAAAAAAAQIDBBEFEiEGEzFBcSIyM1FhsdE0cpHhgaHB8P/aAAwDAQACEQMRAD8AsIAHyg6UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEQ0o+jm7ex+cwmxqu+ujVvW2l/J5nLki5fIl4Mfoq8Tu4KX/G1k2/rsX3kOks7NKMHLvPD6f2UI5+2ly/7NRgo3SDpIr6y51Fqs9S+mooHLG+WJ2T5nJsXyupvLeVu2rqY5+nZUStmzz6RHqjveQ43ZyyytTsnyt+WtnqzPjF6S2a6BUOjPSJV1lwjsd6mWd0uymqHr5Wt6rl68+pd+fHMtySRkUbpJHNYxqZuc5ckanFTT5mDbiW91Pr8vqWqro2R5kfQKlxZphbBI+jw5GyVyZtWslTNv/RvXzX3FYXLFF8uz1dXXWqmRfqLIqNTk1Nie42eL2fyLlzWPlX+/4K9mdCL0upqkGQWyyMfrNkc13FFyUkNox3iSyyNWmuk740/RTu6RipwyXd3ZFqzszNL2LNv01+SOPEFv2kadBBMF6S6HE720VYxtHcl81mt5Ev7qr19i/EnZz2TjW40+7tWmXq7I2LcWACH4w0hWvCbVg/zdxVM0p43Zava931eW880Y9mRPkqW2ZnOMFuTJgDNl50k4mvL3Z3B9JCu6Kl/JonenlL3qRaapnnfrzTSSO4vcqqdDV2asa3ZNL/G/wUZcQivdRrwGTaK83O3PR9FcKmnVP9KVzf7KaPwJcau7YKttdXTLNUytfryKiIrsnuRN3YiFHiXB5YUFZzbTeiajKVr5daJGADTFoAAAAAAEP0peji7ex+cwmBD9KXo4u3sfnMLnD/1dX7l9yK/4cvRmbUO5g9HLjKzoxcnrVx6q9ushxDu4K+m9k+2RfeQ+j3PVcn9GaGHvI400b45nskarXtcqORd6L1nmXXj3RdPdK+W72LU6eVdaalcurrO63NXdmvWildM0f4sfP0KWOqR2eWaoiN/iVcipjcSxrq1NSS+ab8CWzHnGWtH4cKRzS4ttDIM+k8MiVuXV5SbSfaWcaSVNY/DtBLlTwr+duavnv9TknX28jsYXwN4i2utxJdnRS3CnpnviibtbF5K9fW5d3eu8pWeaSonkmlcr5JHK97l3qq7VUgr7nNye9j1UOi9X+D3Lmpr5X4s8ztWHCl5xJI5tronzNauT5VVGsbzcuzu3nPt8EFTcKeGqnSnp3yNSSZUz1G57V9xoK2Y2wLaLdDQUN1gip4W6rWpG/wB6+TtXtJOI5luPFKmDlJ/Tojzj1Rm/bekVrLobxPHCr2uoZHb+jbMufxRE+JCrnaq6z1rqS40slNO3ex6dXFOKdqGivxk4Q/5uL+W//wAkQ0i3/B+JsNyJT3SGS40/l0ypG9FX1m56u5U+KIa7C4nmytUMip6fnp9Ce7HpUdwl19SmopHwyskjerJGKjmuauSoqblRTSOjzFXjTh1JJ3ItfTKkVR+16r+9PiimaywNEF0dRY0SkV2UdbC6NU6tZqayL8FTvLvGsSORiyfnHqv+kWJa4WJeTLS0hYvTClj/ADdUW41WbKdF26vF68s071QzlPPLUzvnnkdJLI5XPe9c1cq71VSX6Ubu+6Y4rGa2cVHlTxpw1fO/qVxCzPCMKONjJ69qXVmMq1zsa8kDvW/BeI7pCk1JZ6p8Tkza9zNRHclXLMsfRTgalkoGYhuUDZpJHL4LG9M2tRFy11TjnnlyzLc5lHiHHlRY6qo7a8WyajC5480mZXuWE7/aIllr7VVQxJvkVmbU5uTYX3oy9Hdo/dk+a8ljmo5qtVEc1diovWeNJSU9DTNp6WFkMDVVWxsTJG5qqrknNVNLn8YebQq5R009/ct04qqnzJnuADSlsAAAAAAEP0peji7ex+cwmBD9KXo4u3sfnMLnD/1dX7l9yK/4cvRmbTvYJ+m9k+2RfeQ4J3sE/TeyfbIvvIfRr/hS9H9jRV++jUgAPlz8ToiMaQ9bxAvGrv6FPdrJmZlNZ3m3tu1lrre5UTwmB8Wa9SqmSKZRnhkpqiSCVqskjerHtXeiouSodj2amnTOHnvf/v4NVxCPtpnkMl4HTw/dfwLfqO4rE2VsMiK+NyZ6zdzk9yqabtq2a72+GuoYaWanmbrNe2NvuXgvYbHiPEnhabhtPz2QUY6u310ZRyXgoyXga4/B1F/s6f8AltOXf62yYctMtwr6emaxieQxI260jupre011faNWSUIVNt/X+id4HKtuRlzLsJDgR7o8dWZzc8/Cmp79hauEtIlgvsjaS5UNJb61y5MzY3opOSruXsUsJlDSRvR7KWBrk2oqRoioes3jM6U6raWtr5/0KcRS1KMjLuKdbxtvGv53hs2fPXU5HWTPSjaX2vHFY/VVIqzKojXjred/UjiGG9xrFZTGcfNIpWRcZtM1PhHo/E2ydFlq+BQ7uOomfxzO0VHopxxSx0LMO3OdsUkbl8EkeuTXIq56irxz3e4tw+fcSxrKMmSmvF9PqbzHsjOtaAP4qo1qucqIibVVTxo6ymr6ZtTSTsngcqo2Ri5tdqqrVyXmilHleubXQm2t6PcAHkAAAAAAAh+lL0cXb2PzmEwIfpS9HF29j85hc4f+rq/cvuRXfDl6Mzad7BP03sn2yL7yHCyXgp3sFIvjvZNn65F95D6Nf8KXo/saKv30ajAB8tfidECltLOCZIKuTEVvhV0Eu2rY1PMd6/Jevt5l0ny9jZI3Me1HMcmq5rkzRU4F3AzZ4dysj4ea+aIrqlbHlZkA7FjxRecOSK+11skCO2uZscx3Nq7O8tHFeh6OplfWYdkZA5drqSVcmL+47q5L70KvueFL9aHubXWmqiRv1+jVzP4kzT4ndUZuLmQ0mnvyf4NNOm2p7JO7TFil0Wo3wJrvXSDb/fL4ERu99ud+qvCbnWSVMnVrLsb2IibETkfgSKRz9VGOV3BE2nbteDMRXd6JR2mpc1f0j2ajP4nZISxpxcb20lH69EYc7bOjbZwTQmiunv0eGulu1RI6mky8DhlTNzWcc9+S9Sdnac7COiOltk0ddfXx1dQ1dZlOxM4mr+1n53LdzLO3JsQ5rjXFqrodxV1+v4/JfxMaUHzyIhpCwgmK7FlTtalwpc306rs1uLO/L3ohnGeCWmnkgnjdHLG5WvY9Mlaqb0VDXpD8YaPbZitFqM/BLiiZJUMbnr8EenXz3kXB+MLHXc3e79v6PWVi957cPEzcd6340xJa4UhpLxVMibsaxz9dE5IueR0Lzo2xNZnuV1A+rhRdktJ+URe5PKTvQi01PPTv1ZoZI3cHtVFOuU8fJj01Jf4ZrGp1v5HUueK79eI1ir7tVTRLvjV+TV7k2F8aLfRxafbfOeZ9orNc7jIjKK31NQ5eqKJXf2Q0bgC21lnwRbaGuhWGpjSRXxqqKrdaRzk3dioaLtB3UMRVw0uvgvRlzB5nY3L5ElABxhtQAAAAAAAAAADPM/mNIAAwAAAAAAAADO2NAAGAAAAAAZTaAABjbYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//Z" style="height:42px;border-radius:8px" alt="rec" /><div class="showcase-badge" style="margin-bottom:0">Rec Technologies — Intelligent Reporting</div></div>
          <h1 class="showcase-title">Beautiful reports for<br>Parks &amp; Recreation<br><span style="font-size:22px;font-weight:600;color:#c7d2fe">Now with more 🧃</span></h1>
          <p class="showcase-desc">
            A multi-org reporting platform that transforms raw Metabase data into interactive, grouped reports
            with PDF exports, AI-powered insights, email subscriptions, real-time dashboards, and a
            Daily Pulse executive summary with month-over-month trends &mdash;
            purpose-built for parks &amp; rec departments.
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:8px 16px;margin:12px 0 4px 0">
            <span style="background:rgba(165,180,252,.15);color:#c7d2fe;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:500">Partners don't know what to ask for — we give them the answers</span>
            <span style="background:rgba(165,180,252,.15);color:#c7d2fe;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:500">AI reads the data so admins don't have to</span>
            <span style="background:rgba(165,180,252,.15);color:#c7d2fe;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:500">Schema changes? Reports don't break.</span>
            <span style="background:rgba(165,180,252,.15);color:#c7d2fe;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:500">Not a CSV — a product</span>
          </div>
          <div class="showcase-stats">
            <div class="showcase-stat">
              <div class="showcase-stat-num" data-count="${Object.keys(ORGS).length}">0</div>
              <div class="showcase-stat-label">Organizations</div>
            </div>
            <div class="showcase-stat">
              <div class="showcase-stat-num" data-count="${REPORT_TYPES.length}">0</div>
              <div class="showcase-stat-label">Report Types</div>
            </div>
            <div class="showcase-stat">
              <div class="showcase-stat-num" data-count="${Object.keys(ORGS).reduce((s,k) => s + REPORT_TYPES.filter(r => !NON_ADDABLE_REPORTS.has(r) && (ORGS[k][r]?.mbUuid || SHARED_UUIDS[r])).length, 0)}">0</div>
              <div class="showcase-stat-label">Live Reports</div>
            </div>
            <div class="showcase-stat">
              <div class="showcase-stat-num" data-text="AI">AI</div>
              <div class="showcase-stat-label">Insights & Chat</div>
            </div>
            <div class="showcase-stat">
              <div class="showcase-stat-num" data-text="PDF">PDF</div>
              <div class="showcase-stat-label">Export & Email</div>
            </div>
            <div class="showcase-stat">
              <div class="showcase-stat-num" data-text="📊">📊</div>
              <div class="showcase-stat-label">Daily Pulse</div>
            </div>
          </div>
          <div class="ticker-wrap">
            <div class="ticker" id="feature-ticker"></div>
          </div>
        </div>
      </div>
      <div class="showcase-gallery" id="showcase-gallery">${showcaseLoad().map((img, i) => `
          <div class="sg-item" onclick="sgLightbox(${i})">
            <img src="${img.data}" alt="" />
            ${img.caption ? `<div class="sg-caption">${img.caption}</div>` : ""}
            <button class="sg-remove" onclick="event.stopPropagation();sgRemove(${i})" title="Remove">&times;</button>
          </div>`).join("")}</div>
      <div class="showcase-upload" id="showcase-upload">
        <label class="showcase-upload-btn">
          + Add photos
          <input type="file" accept="image/*" multiple style="display:none"
            onchange="handleShowcaseUpload(this.files)" />
        </label>
        <span class="showcase-upload-hint">Drag &amp; drop or click to add before/after screenshots for the demo</span>
      </div>

      <div class="partner-quotes">
        <div class="partner-quotes-label">\u2764\uFE0F What Partners Are Saying</div>
        <div class="pq-track-wrap">
          <div class="pq-track" id="pq-track"></div>
        </div>
        <div style="padding:10px 40px 0;display:flex;align-items:center;gap:10px" id="pq-add-row">
          <input id="pq-input" type="text" placeholder="\u201CGreat reports!\u201D - Name, Org" style="flex:1;padding:8px 14px;font-size:12px;background:rgba(255,255,255,.08);border:1px solid rgba(165,180,252,.25);border-radius:8px;color:#e0e7ff;outline:none;" />
          <button onclick="pqAdd()" style="padding:8px 16px;font-size:12px;font-weight:600;color:#a5b4fc;background:rgba(255,255,255,.08);border:1px solid rgba(165,180,252,.25);border-radius:8px;cursor:pointer;white-space:nowrap;">+ Add quote</button>
        </div>
      </div>
    </div>

    <div class="page-title">Organizations</div>
    <div style="margin:-14px 0 18px;padding:10px 16px;background:#f9f8f6;border:1px solid #e8e5df;border-radius:8px;font-size:12.5px;line-height:2">${orgNav}</div>
    ${orgSections}
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
          <p style="font-size:12px;color:#666;margin:0 0 16px">Most reports use shared queries and are available automatically. The reports below require a <strong>per-org Metabase link</strong>. Leave a field blank to skip it.</p>
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
      <div style="padding:14px 18px;background:#f9f8f6;border-top:1px solid #e8e5df">
        <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:10px">Feature Flags</div>
        <div style="display:flex;align-items:center;gap:12px">
          <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
            <input type="checkbox" id="flag-email" onchange="toggleFlag('emailSubscriptions',this.checked)"
                   style="opacity:0;width:0;height:0" />
            <span id="flag-email-track" style="position:absolute;top:0;left:0;right:0;bottom:0;background:#cbd5e1;border-radius:12px;transition:background .2s"></span>
            <span id="flag-email-thumb" style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>
          </label>
          <div>
            <div style="font-size:13px;font-weight:600;color:#111827">Email Subscriptions</div>
            <div id="flag-email-status" style="font-size:11px;color:#999">Loading...</div>
          </div>
        </div>
      </div>
      <div style="padding:14px 18px;background:#f5f4f1;border-top:1px solid #e8e5df">
        <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:10px">&#128279; Metabase Links</div>
        <div id="mb-locked">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input id="mb-pwd" type="password" placeholder="Admin password" onkeydown="if(event.key==='Enter')mbUnlock()" style="flex:1;min-width:180px;padding:8px 12px;border:1px solid #d8d4cc;border-radius:5px;font-size:13px" />
            <button id="mb-unlock-btn" onclick="mbUnlock()" style="padding:8px 18px;background:#16a34a;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">Unlock</button>
          </div>
          <div id="mb-locked-err" style="margin-top:8px;color:#dc2626;font-size:12px;display:none"></div>
        </div>
        <div id="mb-unlocked" style="display:none">
          <div style="margin-top:10px;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:10px">
            <div style="font-size:12px;font-weight:700;color:#065f46;margin-bottom:6px">&#9989; Shared Base Reports</div>
            <table style="width:100%;font-size:11px;border-collapse:collapse">
              <tr style="text-align:left;color:#6b7280;border-bottom:1px solid #d1fae5"><th style="padding:3px 6px">Report</th><th style="padding:3px 6px">UUID</th><th style="padding:3px 6px"></th></tr>
              ${Object.entries(SHARED_UUIDS).map(([k,v]) =>
                '<tr style="border-bottom:1px solid #ecfdf5"><td style="padding:4px 6px;font-weight:600;color:#111827">'+k+'</td><td style="padding:4px 6px;font-family:monospace;color:#059669;font-size:10px">'+v+'</td><td style="padding:4px 6px;text-align:right"><button class="mb-edit-btn" onclick="mbOpenSharedModal(\''+k+'\',\''+v+'\')">Update Link</button></td></tr>'
              ).join('')}
            </table>
          </div>
          <div id="mb-links-list"></div>
        </div>
      <div style="padding:14px 18px;background:#f9f8f6;border-top:1px solid #e8e5df">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:12px;font-weight:700;color:#374151">&#128270; Audit Log</div>
          <div style="display:flex;gap:6px;align-items:center">
            <select id="audit-days" style="padding:4px 8px;border:1px solid #d8d4cc;border-radius:4px;font-size:11px">
              <option value="1">Last 24h</option><option value="3" selected>Last 3 days</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
            </select>
            <input id="audit-org-filter" placeholder="Org" style="width:80px;padding:4px 8px;border:1px solid #d8d4cc;border-radius:4px;font-size:11px" />
            <input id="audit-report-filter" placeholder="Report" style="width:80px;padding:4px 8px;border:1px solid #d8d4cc;border-radius:4px;font-size:11px" />
            <button onclick="loadAuditLog()" style="padding:4px 12px;background:#374151;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer">Load</button>
          </div>
        </div>
        <div id="audit-log-body" style="font-size:11px;color:#666">Click Load to fetch recent events</div>
      </div>

      <!-- Wizard Activity -->
      <div style="padding:14px 18px;background:#faf5ff;border-top:1px solid #e9d5ff">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:12px;font-weight:700;color:#581c87">&#x1FA84; Report Wizard Activity</div>
          <button onclick="loadWizardLog()" style="padding:4px 12px;background:#7c3aed;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer">Load</button>
        </div>
        <div id="wizard-log-body" style="font-size:11px;color:#666">Click Load to see recent wizard prompts &amp; feedback</div>
      </div>

      <!-- Backups -->
      <div style="padding:14px 18px;background:#f0fdf4;border-top:1px solid #bbf7d0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:12px;font-weight:700;color:#166534">&#128190; Daily Backups</div>
          <div style="display:flex;gap:6px;align-items:center">
            <span id="backup-status" style="font-size:11px;color:#999">Loading...</span>
            <button onclick="triggerBackup()" id="backup-btn" style="padding:4px 12px;background:#16a34a;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer">Backup Now</button>
          </div>
        </div>
        <div id="backup-detail" style="font-size:11px;color:#666">Backups run daily at 2am and on startup. Data files are saved to a private GitHub Gist.</div>
      </div>
    </div>

    <div class="org-section" id="ai-analytics-section">
      <div class="org-header" onclick="toggleHow(this)" style="cursor:pointer;user-select:none">
        <div class="org-header-text">
          <div class="org-name">&#129302; AI Analytics</div>
          <div class="org-slug">Langfuse-traced usage across all AI features</div>
        </div>
        <span class="how-chevron" style="transform:rotate(90deg)">&#9658;</span>
      </div>
      <div class="how-body" style="display:block">
        <div id="ai-analytics-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">
          <div style="color:#888;font-size:13px">Loading AI analytics...</div>
        </div>
        <div id="ai-analytics-detail" style="display:grid;grid-template-columns:1fr 1fr;gap:16px"></div>
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
        <p>rec.us Reports is a Node.js/Express application deployed on Railway Pro. It acts as an intelligent middleware layer between the rec.us platform database and partner staff, transforming raw SQL results into interactive, AI-narrated dashboards with PDF export, email subscriptions, and cross-org intelligence.</p>

        <!-- Architecture Diagram -->
        <div style="margin:16px 0 20px;overflow-x:auto">
          <svg viewBox="0 0 820 520" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:820px;font-family:IBM Plex Sans,system-ui,sans-serif">
            <!-- Background -->
            <rect width="820" height="520" rx="12" fill="#f9f8f6" stroke="#e4e4e0" stroke-width="1"/>
            <!-- Title -->
            <text x="410" y="30" text-anchor="middle" font-size="13" font-weight="600" fill="#2c2c2c">rec.us Reports &#8212; System Architecture</text>

            <!-- Row 1: Entry Points -->
            <text x="28" y="62" font-size="9" fill="#888" font-weight="600" letter-spacing="1">ENTRY POINTS</text>
            <!-- Rec Admin direct link -->
            <rect x="28" y="72" width="170" height="62" rx="8" fill="#fff" stroke="#e4e4e0" stroke-width="1.5"/>
            <text x="113" y="92" text-anchor="middle" font-size="19">&#127760;</text>
            <text x="113" y="110" text-anchor="middle" font-size="10.5" font-weight="600" fill="#2c2c2c">rec.us Admin Portal</text>
            <text x="113" y="122" text-anchor="middle" font-size="8.5" fill="#888">Direct link in Metabase</text>
            <!-- Direct link -->
            <rect x="218" y="72" width="170" height="62" rx="8" fill="#fff" stroke="#e4e4e0" stroke-width="1.5"/>
            <text x="303" y="92" text-anchor="middle" font-size="19">&#128279;</text>
            <text x="303" y="110" text-anchor="middle" font-size="10.5" font-weight="600" fill="#2c2c2c">Direct Token URL</text>
            <text x="303" y="122" text-anchor="middle" font-size="8.5" fill="#888">Bookmarkable staff links</text>
            <!-- Public calendar -->
            <rect x="408" y="72" width="170" height="62" rx="8" fill="#fff" stroke="#e4e4e0" stroke-width="1.5"/>
            <text x="493" y="92" text-anchor="middle" font-size="19">&#128197;</text>
            <text x="493" y="110" text-anchor="middle" font-size="10.5" font-weight="600" fill="#2c2c2c">Public Calendar</text>
            <text x="493" y="122" text-anchor="middle" font-size="8.5" fill="#888">Iframe-embeddable, no token</text>
            <!-- Rental Calendar (NEW) -->
            <rect x="598" y="72" width="190" height="62" rx="8" fill="#FFF3E0" stroke="#FF9800" stroke-width="1.5"/>
            <text x="693" y="92" text-anchor="middle" font-size="19">&#127966;</text>
            <text x="693" y="110" text-anchor="middle" font-size="10.5" font-weight="600" fill="#E65100">Rental Calendar</text>
            <text x="693" y="122" text-anchor="middle" font-size="8.5" fill="#BF360C">Live MCP data, public, no token</text>

            <!-- Arrows down -->
            <line x1="113" y1="134" x2="113" y2="162" stroke="#ccc" stroke-width="1.5" marker-end="url(#arrowhead)"/>
            <line x1="303" y1="134" x2="303" y2="162" stroke="#ccc" stroke-width="1.5" marker-end="url(#arrowhead)"/>
            <line x1="493" y1="134" x2="493" y2="162" stroke="#ccc" stroke-width="1.5" marker-end="url(#arrowhead)"/>
            <line x1="693" y1="134" x2="693" y2="222" stroke="#FF9800" stroke-width="1.5" stroke-dasharray="4 2" marker-end="url(#arrowhead)"/>

            <!-- Row 2: Token Gate -->
            <rect x="28" y="164" width="560" height="38" rx="6" fill="#FFF3E0" stroke="#FFB74D" stroke-width="1"/>
            <text x="308" y="187" text-anchor="middle" font-size="10.5" font-weight="600" fill="#E65100">&#128274; Token Gate Middleware &#8212; 16-char tokens, fail-closed (generic 404 on mismatch)</text>

            <!-- Arrow down -->
            <line x1="308" y1="202" x2="308" y2="222" stroke="#ccc" stroke-width="1.5" marker-end="url(#arrowhead)"/>

            <!-- Row 3: Railway App (main box) -->
            <rect x="28" y="224" width="770" height="130" rx="10" fill="#EDE7F6" stroke="#9575CD" stroke-width="1.5"/>
            <text x="413" y="244" text-anchor="middle" font-size="11" font-weight="700" fill="#4527A0">&#9881;&#65039; Railway Pro &#8212; Node.js / Express</text>

            <!-- Sub-boxes inside Railway -->
            <rect x="44" y="256" width="148" height="48" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="118" y="276" text-anchor="middle" font-size="9.5" font-weight="600" fill="#4527A0">React/Babel CDN</text>
            <text x="118" y="290" text-anchor="middle" font-size="8" fill="#888">15 report HTML files</text>

            <rect x="204" y="256" width="148" height="48" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="278" y="276" text-anchor="middle" font-size="9.5" font-weight="600" fill="#4527A0">Metabase Proxy</text>
            <text x="278" y="290" text-anchor="middle" font-size="8" fill="#888">Server-side, no CORS</text>

            <rect x="364" y="256" width="148" height="48" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="438" y="276" text-anchor="middle" font-size="9.5" font-weight="600" fill="#4527A0">AI Insights Engine</text>
            <text x="438" y="290" text-anchor="middle" font-size="8" fill="#888">Claude API narratives</text>

            <rect x="524" y="256" width="128" height="48" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="588" y="276" text-anchor="middle" font-size="9.5" font-weight="600" fill="#4527A0">Puppeteer PDF</text>
            <text x="588" y="290" text-anchor="middle" font-size="8" fill="#888">Headless Chromium</text>

            <rect x="664" y="256" width="122" height="48" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="725" y="276" text-anchor="middle" font-size="9.5" font-weight="600" fill="#4527A0">PII Stripper</text>
            <text x="725" y="290" text-anchor="middle" font-size="8" fill="#888">Emails, phones, names</text>

            <!-- Sub-row 2 inside Railway -->
            <rect x="44" y="312" width="148" height="32" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="118" y="332" text-anchor="middle" font-size="9" font-weight="600" fill="#4527A0">Report Wizard</text>

            <rect x="204" y="312" width="148" height="32" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="278" y="332" text-anchor="middle" font-size="9" font-weight="600" fill="#4527A0">Email Subscriptions</text>

            <rect x="364" y="312" width="148" height="32" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="438" y="332" text-anchor="middle" font-size="9" font-weight="600" fill="#4527A0">Nightly Backups</text>

            <rect x="524" y="312" width="128" height="32" rx="6" fill="#fff" stroke="#D1C4E9" stroke-width="1"/>
            <text x="588" y="332" text-anchor="middle" font-size="9" font-weight="600" fill="#4527A0">Usage Analytics</text>

            <rect x="664" y="312" width="122" height="32" rx="6" fill="#FFF3E0" stroke="#FF9800" stroke-width="1"/>
            <text x="725" y="332" text-anchor="middle" font-size="9" font-weight="600" fill="#E65100">MCP SDK Client</text>

            <!-- Arrows from Railway down to data layer -->
            <line x1="278" y1="354" x2="278" y2="382" stroke="#ccc" stroke-width="1.5" marker-end="url(#arrowhead)"/>
            <line x1="438" y1="354" x2="438" y2="382" stroke="#ccc" stroke-width="1.5" marker-end="url(#arrowhead)"/>
            <line x1="630" y1="354" x2="630" y2="382" stroke="#ccc" stroke-width="1.5" marker-end="url(#arrowhead)"/>

            <!-- Row 4: Data Layer -->
            <text x="28" y="396" font-size="9" fill="#888" font-weight="600" letter-spacing="1">DATA LAYER</text>
            <rect x="28" y="404" width="235" height="56" rx="8" fill="#E3F2FD" stroke="#64B5F6" stroke-width="1.5"/>
            <text x="145" y="426" text-anchor="middle" font-size="16">&#128202;</text>
            <text x="145" y="442" text-anchor="middle" font-size="10.5" font-weight="600" fill="#1565C0">Metabase (Public Card API)</text>
            <text x="145" y="454" text-anchor="middle" font-size="8" fill="#888">12 shared + per-org parameterized queries</text>

            <rect x="283" y="404" width="235" height="56" rx="8" fill="#E8F5E9" stroke="#81C784" stroke-width="1.5"/>
            <text x="400" y="426" text-anchor="middle" font-size="16">&#128024;</text>
            <text x="400" y="442" text-anchor="middle" font-size="10.5" font-weight="600" fill="#2E7D32">rec.us PostgreSQL</text>
            <text x="400" y="454" text-anchor="middle" font-size="8" fill="#888">Platform database (all orgs)</text>

            <rect x="538" y="404" width="260" height="56" rx="8" fill="#FFF8E1" stroke="#FFD54F" stroke-width="1.5"/>
            <text x="668" y="426" text-anchor="middle" font-size="16">&#9729;&#65039;</text>
            <text x="668" y="442" text-anchor="middle" font-size="10.5" font-weight="600" fill="#F57F17">External Services</text>
            <text x="668" y="454" text-anchor="middle" font-size="8" fill="#888">Anthropic API &#183; rec.us MCP &#183; GitHub Gists &#183; Resend</text>

            <!-- Connecting line Metabase to Postgres -->
            <line x1="263" y1="432" x2="283" y2="432" stroke="#B0BEC5" stroke-width="1.2" marker-end="url(#arrowhead)"/>

            <!-- Row 5: Legend -->
            <text x="28" y="492" font-size="8" fill="#aaa">&#9679; Server-side proxy eliminates CORS &#8212; staff browsers never hit Metabase directly</text>
            <text x="28" y="506" font-size="8" fill="#aaa">&#9679; Shared UUID architecture: add a new org with just slug + orgId + logo + token &#8212; 12 report types light up automatically</text>
            <text x="430" y="506" font-size="8" fill="#E65100">&#9679; Rental Calendar: live availability via MCP SDK &#8594; rec.us MCP server (no REST API needed)</text>

            <!-- Arrowhead marker -->
            <defs>
              <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#ccc"/>
              </marker>
            </defs>
          </svg>
        </div>

        <p>The server proxies all Metabase requests server-side &#8212; staff browsers never interact with Metabase directly. This eliminates CORS issues (Metabase OSS doesn&#x27;t send browser-friendly headers) and keeps database query UUIDs hidden from the client.</p>

        <h4>Access &amp; Security</h4>
        <p>Multiple layers of access control protect this deployment:</p>
        <ul>
          <li><strong>Admin dashboard</strong> (this page, at <code>/</code>) is gated by HTTP Basic auth using the <code>DASHBOARD_PASSWORD</code> env var. Only authorized rec.us staff see the full org list, subscriber counts, and access tokens.</li>
          <li><strong>Per-org reports</strong> are protected by 16-character access tokens. Every <code>/:org/*</code> URL requires <code>?token=...</code> matching the org&#x27;s configured token; a mismatch returns a generic 404 (no info leak about which orgs exist). Tokens are embedded in the URLs each org receives, so staff can bookmark and share without re-authenticating.</li>
          <li><strong>PII protection</strong> &#8212; API responses strip email addresses, phone numbers, and full names before reaching the browser. CSV exports are disabled; data requests route through a Partner Support modal.</li>
        </ul>
        <p>Tokens are visible in the &#129312; <strong>Access Token</strong> row on each org card &#8212; click <strong>Copy landing URL</strong> to grab a tokenized link ready to share. The <code>/api/*</code> admin endpoints, the cross-org <code>/metrics</code> view, and the public <code>/hotdog</code> page are whitelisted from the token gate.</p>

        <h4 style="margin-top:20px">&#128373;&#65039; Access via Metabase</h4>
        <p>In production, partner staff access rec.us Reports through a <strong>direct link</strong> placed inside their existing Metabase reporting dashboard within the rec.us admin panel:</p>
        <div style="background:#f5f4f1;border:1px solid #e4e4e0;border-radius:8px;padding:14px 18px;margin:10px 0 14px;font-size:12px;line-height:1.7">
          <strong>rec.us Admin</strong> &#8594; Reporting Tab &#8594; Metabase Dashboard &#8594; <strong>Direct Link</strong> &#8594; <strong>rec.us Reports</strong> (opens in new tab)<br>
          <span style="color:#888">The tokenized URL is embedded in the Metabase dashboard &#8212; staff click through without needing to know it.</span>
        </div>
        <p>We moved away from iframe embedding because interactive elements (buttons, dropdowns, date pickers, PDF downloads) don&#x27;t work reliably inside iframes. The direct-link approach opens reports in a full browser tab where everything works natively, while still funneling access through Metabase so staff discover reports in the same place they already look. A partner staff member must be:</p>
        <ul>
          <li>Authenticated in the <strong>rec.us admin portal</strong> (session-based auth with role permissions)</li>
          <li>Authorized to view the <strong>Reporting tab</strong> in their organization&#x27;s admin panel</li>
          <li>Holding a valid <strong>16-character access token</strong> embedded in the link URL</li>
        </ul>
        <p style="margin-top:6px">The Railway URL is visible in the browser address bar once they click through, but the token gate ensures that even if someone discovers or shares a URL, they still need the org-specific token to access any data. Without it, the server returns a generic 404 &#8212; no information about which orgs exist or what reports are available.</p>

        <h4>Reports</h4>
        <p>Each report type is a self-contained HTML file served from <code>public/</code>. Reports are React apps loaded via CDN (no build step). Data is fetched from <code>/:org/:report/api/data?token=...</code>, which proxies to either a shared Metabase question (with <code>org_id</code> injected automatically) or a per-org UUID as fallback.</p>
        <ul>
          <li><strong>Facility Rental</strong> &#8212; reservations grouped by date and location, with table and calendar views, heatmap summary, location color coding, and resident detection.</li>
          <li><strong>GL Code Rollup</strong> &#8212; payment method breakdown by GL code, with bar/pie chart views, refund detail toggle, and account credit column.</li>
          <li><strong>Class Roster</strong> &#8212; enrolled and cancelled participants by program section, with form responses, session dates, status filters, and Excel/PDF export.</li>
          <li><strong>Programs</strong> &#8212; two-tab layout (Revenue + Participants). Section-grain enrollment, capacity fill rates, charged/received/outstanding financials, plan-aware pending calculations, and per-program demographic accordion with gender breakdown.</li>
          <li><strong>Product Sales (POS)</strong> &#8212; daily revenue, refunds, and net by product, with desk-location breakdown and weekly trend charts.</li>
          <li><strong>Memberships</strong> &#8212; active and lapsed memberships/passes with auto-renew tracking, pricing, and usage counts.</li>
          <li><strong>Fast Track</strong> &#8212; pre-registration pipeline: signups, conversions, pending, dropped, with season/program hierarchy and demand/fill metrics. AI-powered insights.</li>
          <li><strong>Court Utilization</strong> &#8212; court-level booking hours and usage patterns by facility and date range. AI-powered insights.</li>
          <li><strong>Calendar</strong> &#8212; public-facing week/month/day/list schedule with activity color coding, session click tracking, and iframe-embeddable URLs (no token required, WCAG accessible).</li>
          <li><strong>Community Intelligence</strong> &#8212; 6-tab analytics hub: Demographics, Revenue, Strategy, Guests, Fast Track crossover, Products. AI-powered insights, data completeness rings, and household-level revenue analysis.</li>
          <li><strong>Director&#x27;s Report</strong> &#8212; one-click monthly executive summary. Parallel data fetches (GL, programs, users, Fast Track), AI executive insights, top/bottom programs, revenue mix charts, community profile, and data completeness scoring.</li>
          <li><strong>Instructor Payout</strong> &#8212; per-participant revenue splits by instructor, with configurable split ratios (65/35), base-price-split mode (calculates on resident rate so non-resident surcharges stay with org), and cancelled/refunded participant exclusion.</li>
          <li><strong>Historic Buildings</strong> &#8212; filtered facility view for historic venue locations (per-org only).</li>
        </ul>

        <h4>AI-Powered Features</h4>
        <ul>
          <li><strong>Report Wizard</strong> &#8212; plain-English natural language queries generate live dashboard widgets. Schema discovery with caching, structured system prompts, PII stripping, thumbs up/down feedback logging, and an admin activity panel for tracking wizard usage across orgs.</li>
          <li><strong>AI Insights</strong> &#8212; Programs, Fast Track, Court Utilization, Community Intel, and Director&#x27;s Report include Claude-generated narrative analysis tailored to each org&#x27;s data. Insights are generated via the Anthropic API with report-specific system prompts.</li>
        </ul>

        <p style="margin-top:8px"><strong>Shared Metabase queries:</strong> 12 of 15 report types use a single parameterized Metabase question with <code>org_id</code> passed at query time &#8212; no per-org SQL duplication. Only Historic remains as a per-org UUID. Adding a new org lights up all 12 shared reports automatically.</p>

        <h4>Inline Metrics</h4>
        <p>Each org card on this dashboard has a &#9656; <strong>&#128200; Metrics</strong> toggle that expands inline to show that org&#x27;s usage over the last 30 days &#8212; report opens by type, daily activity sparkline, and top viewers. Data comes from a lightweight in-process counter (no Metabase round-trip). The <strong>View full metrics &rarr;</strong> link opens a deeper dashboard at <code>/:org/metrics</code>.</p>

        <h4>PDF Export</h4>
        <p>PDF generation uses Puppeteer with system Chromium inside the Railway Docker container. The server launches a headless browser, navigates to the report with <code>?_print=1</code> (hides the toolbar) and the org&#x27;s access token, waits for the <code>#report-ready</code> DOM marker, then renders a Letter-landscape PDF. The PDF always reflects exactly what the browser renders.</p>

        <h4>Email Subscriptions</h4>
        <p>Gated by the <strong>Email Subscriptions</strong> feature flag in the App Control section above &#8212; when OFF (default), all email cron jobs skip and the subscription API returns 503. When ON, subscriber data is stored in <code>data/subscriptions.json</code> on the Railway volume. Three cron jobs run &#8212; daily at 7am, weekly on Monday at 7am, and monthly on the 1st at 7am. Each job filters to matching cadences and sends tokenized report links via the Resend API.</p>

        <h4>Daily Backups</h4>
        <p>A nightly cron job (2am) and a 45-second startup job back up all server configuration and subscriber data to private GitHub Gists via the GitHub API. A manual <strong>Backup Now</strong> button is available in the admin header. The backup status dot (green/yellow/red) in the header reflects backup freshness.</p>

        <h4>Adding a New Org</h4>
        <p>Click <strong>&#10133; Add Org</strong> above to launch the onboarding wizard. New orgs only need a slug, <code>orgId</code>, logo URL, and access token &#8212; all 12 shared Metabase queries light up automatically. Per-org Metabase UUIDs are only needed for Historic (the sole remaining per-org report). No new HTML files needed &#8212; all report templates are shared across orgs.</p>

        <h4>Environment Variables</h4>
        <ul>
          <li><code>METABASE_URL</code> &#8212; base URL for your Metabase instance</li>
          <li><code>BASE_URL</code> &#8212; public URL of this Railway deployment</li>
          <li><code>DASHBOARD_PASSWORD</code> &#8212; Basic-auth password for the admin dashboard at <code>/</code></li>
          <li><code>RESEND_API_KEY</code> &#8212; API key for email delivery via Resend</li>
          <li><code>FROM_EMAIL</code> / <code>FROM_NAME</code> &#8212; sender identity for outbound emails</li>
          <li><code>DATA_DIR</code> &#8212; path to persistent storage (subscriptions, health checks, feature flags)</li>
          <li><code>GITHUB_PAT</code> &#8212; GitHub Personal Access Token for nightly Gist backups</li>
          <li><code>ANTHROPIC_API_KEY</code> &#8212; API key for Claude AI insights and Report Wizard</li>
          <li><code>PORT</code> &#8212; server port (Railway sets this automatically)</li>
        </ul>

        <h4>Deployment</h4>
        <p>Auto-deploys from the <code>main</code> branch of <code>danj707/rental-report</code> on GitHub. Every push triggers a Railway Pro redeploy &#8212; typically live in 60&#8211;90 seconds. Uses <code>node:20-slim</code> with system Chromium for Puppeteer. Railway persistent volume at <code>/data</code> stores subscriptions, feature flags, and health check results across deploys.</p>
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
      programs: { label: "Programs",           icon: "🎯" },
      historic: { label: "Historic Buildings",        icon: "🏛️" },
      roster:   { label: "Class Roster",              icon: "📋" },
      overview: { label: "Facility Overview",         icon: "📈" },
      products: { label: "Product Sales",             icon: "🛒" },
      memberships: { label: "Memberships",            icon: "🎫" },
      "court-utilization": { label: "Court Utilization", icon: "🎾" },
      calendar: { label: "Calendar",                  icon: "🗓️" },
      fasttrack: { label: "Fast Track",               icon: "⚡" },
    })))};
    const SHARED_UUIDS_CLIENT = ${JSON.stringify(SHARED_UUIDS)};

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
      const needsUuid = checked.filter(r => !SHARED_UUIDS_CLIENT[r]);
      const shared = checked.filter(r => SHARED_UUIDS_CLIENT[r]);
      let html = '';
      if (shared.length) {
        html += '<div style="margin-top:4px;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:12px;color:#065f46"><strong>\\u2705 Shared base query:</strong> ' + shared.map(r => REPORT_META[r].icon + ' ' + REPORT_META[r].label).join(', ') + '<br><span style="font-size:11px;color:#6b7280">No Metabase link needed \\u2014 org_id injected automatically</span></div>';
      }
      if (needsUuid.length) {
        html += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;margin-top:12px;margin-bottom:4px">Per-Org Metabase Links (required)</div>';
        needsUuid.forEach(r => { html += '<div><label style="font-size:12px;color:#555;display:block;margin-bottom:4px">' + REPORT_META[r].icon + ' ' + REPORT_META[r].label + '</label><input type="text" id="mb-' + r + '" placeholder="https://rec.metabaseapp.com/public/question/..." style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:5px;font-size:12px;font-family:monospace" /></div>'; });
      }
      wrap.innerHTML = html;
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
        if (SHARED_UUIDS_CLIENT[r]) { reports[r] = null; continue; }
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
          \`<div style="margin-left:12px;font-size:12px">\${REPORT_META[r].icon} \${REPORT_META[r].label} — \${uuid ? '<code style="font-size:11px">' + uuid + '</code>' : '<span style="color:#059669;font-weight:600">shared base query</span>'}</div>\`)
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
      const totalClicks  = Object.values(summary).reduce((n, s) => n + (s.click || 0), 0);
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
          <div class="metrics-stat"><div class="metrics-stat-label">Session Clicks (30d)</div><div class="metrics-stat-value">\${totalClicks}</div></div>
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
    // ── Animated counters ─────────────────────────────────
    (function(){
      function animateCounters(){
        document.querySelectorAll('[data-count]').forEach(function(el){
          var target = parseInt(el.getAttribute('data-count'));
          var duration = 1200;
          var start = performance.now();
          function tick(now){
            var elapsed = now - start;
            var progress = Math.min(elapsed / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = Math.round(eased * target);
            if (progress < 1) requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        });
      }
      // Feature ticker
      var features = [
        'Rec AI Chat \u2014 Streaming Claude','Daily 5am Auto-Cache with 24hr TTL',
        'Report Health Monitoring','Token-Gated Multi-Tenant Security',
        'PDF Export via Puppeteer','Email Subscription Scheduling',
        'Facility Rental Schedules','GL Revenue Breakdown','Program Revenue by Section',
        'Court Utilization Heatmaps','Product Sales Analytics','Membership Tracking',
        'Roster Management','User Demographics & Strategy','Spend Tier Analysis',
        'Geographic Heatmaps via Leaflet','Cross-Sell Opportunity Analysis',
        'Guest Detection Toggle','Tab-Specific AI Insights','Conversion Funnels',
        'Lapsing Household Alerts','Revenue Levers with CSV Export',
        'Fast Track Bookings & Conversion','Historic Site Rentals',
        'Pareto Revenue Curves','Signup Velocity Tracking','Resident vs Non-Resident',
        'Who\u2019s Not Buying Analysis','Revenue by Age Cohort','Grade Gap Detection',
        'Excel Export via SheetJS','Refund Breakdown Toggle','Acct Credit Tracking',
        'Desk Location Filtering','Cancellation Rate Tracking',
        'Section vs Session Reg Modes','Present Mode \u2014 Kiosk/TV Display',
        'Thumbs Up/Down Vote Tracking','AI Spend Monitoring',
        'Animated Admin Dashboard','Real-Time Streaming Dashboards'
      ];
      var ticker = document.getElementById('feature-ticker');
      if (ticker) {
        var html = '';
        // Duplicate for seamless loop
        for (var i = 0; i < 2; i++) {
          features.forEach(function(f){
            html += '<span class="ticker-item"><span class="ticker-dot"></span>' + f + '</span>';
          });
        }
        ticker.innerHTML = html;
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', animateCounters);
      } else {
        setTimeout(animateCounters, 100);
      }
    })();

    // ── Add reports to an existing org ─────────────────
    const ADD_REPORT_ORGS = ${JSON.stringify(addReportOrgs)};
    const ADD_REPORT_META = ${JSON.stringify(addReportMeta)};
    const HIDDEN_REPORTS = ${JSON.stringify(hiddenReports)};
    let addReportSlug = null;

    async function toggleVis(slug, report, btn) {
      if (!mbPwd) {
        mbPwd = getDashPwd();
        if (!mbPwd) return;
      }
      btn.style.opacity = '0.2';
      try {
        const res = await fetch('/api/admin/toggle-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: mbPwd, org: slug, report: report }),
        });
        const data = await res.json().catch(function(){ return {}; });
        if (!res.ok || !data.ok) {
          if (res.status === 401) { mbPwd = ''; clearDashPwd(); }
          throw new Error(data.error || 'Failed');
        }
        HIDDEN_REPORTS[slug] = data.hidden;
        const card = btn.closest('.report-card');
        const isNowHidden = data.hidden.indexOf(report) >= 0;
        card.classList.toggle('report-card-hidden', isNowHidden);
        // Toggle SVG icons (first = eye-open, second = eye-slash)
        var svgs = btn.querySelectorAll('svg');
        svgs[0].style.display = isNowHidden ? 'none' : 'block';
        svgs[1].style.display = isNowHidden ? 'block' : 'none';
        btn.title = isNowHidden ? 'Hidden from org page' : 'Visible on org page';
        mbToast(isNowHidden ? report + ' hidden from ' + slug + ' org page' : report + ' visible on ' + slug + ' org page');
      } catch (e) {
        alert('Toggle failed: ' + e.message);
      }
      btn.style.opacity = '';
    }

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

    // ── Feature Flags ──
    async function loadFlags() {
      try {
        const r = await fetch('/api/admin/flags');
        const flags = await r.json();
        updateFlagUI('email', flags.emailSubscriptions);
      } catch(e) { console.warn('[flags] load failed', e); }
    }
    function updateFlagUI(name, on) {
      const cb = document.getElementById('flag-'+name);
      const track = document.getElementById('flag-'+name+'-track');
      const thumb = document.getElementById('flag-'+name+'-thumb');
      const status = document.getElementById('flag-'+name+'-status');
      if (cb) cb.checked = on;
      if (track) track.style.background = on ? '#059669' : '#cbd5e1';
      if (thumb) thumb.style.transform = on ? 'translateX(20px)' : 'translateX(0)';
      if (status) { status.textContent = on ? 'Enabled — email signups and subscriptions are active' : 'Disabled — email features are hidden from all orgs'; status.style.color = on ? '#059669' : '#999'; }
    }
    async function toggleFlag(key, value) {
      const pwd = prompt('Enter dashboard password to change feature flags:');
      if (!pwd) { loadFlags(); return; }
      try {
        const r = await fetch('/api/admin/flags', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ password: pwd, key: key, value: value })
        });
        const j = await r.json();
        if (j.ok) { updateFlagUI('email', j.flags.emailSubscriptions); }
        else { alert(j.error || 'Failed'); loadFlags(); }
      } catch(e) { alert('Error: ' + e.message); loadFlags(); }
    }
    loadFlags();

    async function loadAuditLog() {
      var body = document.getElementById('audit-log-body');
      var days = document.getElementById('audit-days').value;
      var org = document.getElementById('audit-org-filter').value;
      var report = document.getElementById('audit-report-filter').value;
      body.innerHTML = '<div style="color:#999;padding:8px">Loading...</div>';
      try {
        var qs = 'days=' + days;
        if (org) qs += '&org=' + encodeURIComponent(org);
        if (report) qs += '&report=' + encodeURIComponent(report);
        var resp = await fetch('/api/admin/audit-log?' + qs);
        var data = await resp.json();
        if (!data.events || data.events.length === 0) {
          body.innerHTML = '<div style="color:#999;padding:8px">No events found</div>';
          return;
        }
        var parseUA = function(ua) {
          if (!ua) return '—';
          if (ua.includes('Puppeteer') || ua.includes('HeadlessChrome')) return '🤖 PDF';
          if (ua.includes('iPhone') || ua.includes('iPad')) return '📱 iOS';
          if (ua.includes('Android')) return '📱 Android';
          if (ua.includes('Chrome')) return '💻 Chrome';
          if (ua.includes('Firefox')) return '💻 Firefox';
          if (ua.includes('Safari')) return '💻 Safari';
          return ua.substring(0, 20) + '…';
        };
        var html = '<div style="max-height:400px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px">';
        html += '<table style="width:100%;border-collapse:collapse;font-size:10.5px">';
        html += '<thead><tr style="background:#f9fafb;position:sticky;top:0"><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb">Time</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb">Org</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb">Report</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb">Event</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb">IP</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb">Device</th></tr></thead><tbody>';
        data.events.forEach(function(e) {
          var t = e.ts ? new Date(e.ts) : null;
          var timeStr = t ? (t.getMonth()+1) + '/' + t.getDate() + ' ' + t.getHours() + ':' + String(t.getMinutes()).padStart(2,'0') : '—';
          var evtColor = e.event === 'view' ? '#059669' : e.event === 'fetch' ? '#6366f1' : e.event === 'pdf' ? '#d97706' : e.event === 'insights' ? '#dc2626' : '#666';
          html += '<tr style="border-bottom:1px solid #f3f4f6">';
          html += '<td style="padding:4px 8px;white-space:nowrap;color:#999">' + timeStr + '</td>';
          html += '<td style="padding:4px 8px;font-weight:600">' + (e.org||'—') + '</td>';
          html += '<td style="padding:4px 8px">' + (e.report||'—') + '</td>';
          html += '<td style="padding:4px 8px;color:' + evtColor + ';font-weight:600">' + (e.event||'—') + '</td>';
          html += '<td style="padding:4px 8px;font-family:monospace;font-size:9.5px;color:#999">' + (e.ip||'—') + '</td>';
          html += '<td style="padding:4px 8px" title="' + (e.ua||'').replace(/"/g,'&quot;') + '">' + parseUA(e.ua) + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        html += '<div style="margin-top:6px;color:#999;font-size:10px">' + data.total + ' events (showing ' + Math.min(data.events.length,500) + ')</div>';
        body.innerHTML = html;
      } catch(err) {
        body.innerHTML = '<div style="color:#dc2626;padding:8px">Error: ' + err.message + '</div>';
      }
    }

    async function loadWizardLog() {
      var body = document.getElementById('wizard-log-body');
      body.innerHTML = '<div style="color:#999;padding:8px">Loading\u2026</div>';
      try {
        var resp = await fetch('/api/admin/wizard-log');
        var events = await resp.json();
        if (!events.length) {
          body.innerHTML = '<div style="color:#999;padding:8px">No wizard activity yet</div>';
          return;
        }
        var html = '<div style="max-height:400px;overflow-y:auto;border:1px solid #e9d5ff;border-radius:6px">';
        html += '<table style="width:100%;border-collapse:collapse;font-size:10.5px">';
        html += '<thead><tr style="background:#faf5ff;position:sticky;top:0"><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e9d5ff">Time</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e9d5ff">Org</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e9d5ff">Type</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e9d5ff">Prompt</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e9d5ff">Cost</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e9d5ff">Vote</th></tr></thead><tbody>';
        events.forEach(function(e) {
          var t = e.ts ? new Date(e.ts) : null;
          var timeStr = t ? (t.getMonth()+1) + '/' + t.getDate() + ' ' + t.getHours() + ':' + String(t.getMinutes()).padStart(2,'0') : '\u2014';
          var isGen = e.action === 'generate';
          var isFb = e.action === 'feedback';
          var typeBadge = isGen ? '<span style="background:#7c3aed;color:#fff;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600">generate</span>' : '<span style="background:' + ((e.extra||{}).vote === 'up' ? '#16a34a' : '#dc2626') + ';color:#fff;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600">' + ((e.extra||{}).vote === 'up' ? '\uD83D\uDC4D up' : '\uD83D\uDC4E down') + '</span>';
          var prompt = (e.extra||{}).prompt || (e.extra||{}).title || '\u2014';
          var cost = isGen && (e.extra||{}).costUsd ? '$' + (e.extra.costUsd).toFixed(3) : '\u2014';
          html += '<tr style="border-bottom:1px solid #f5f0ff">';
          html += '<td style="padding:4px 8px;white-space:nowrap;color:#999">' + timeStr + '</td>';
          html += '<td style="padding:4px 8px;font-weight:600">' + (e.org||'\u2014') + '</td>';
          html += '<td style="padding:4px 8px">' + typeBadge + '</td>';
          html += '<td style="padding:4px 8px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + prompt.replace(/"/g,'&quot;') + '">' + prompt + '</td>';
          html += '<td style="padding:4px 8px;font-family:monospace;font-size:9.5px;color:#999">' + cost + '</td>';
          html += '<td style="padding:4px 8px">' + (isFb ? ((e.extra||{}).vote === 'up' ? '\uD83D\uDC4D' : '\uD83D\uDC4E') : '\u2014') + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        html += '<div style="margin-top:6px;color:#999;font-size:10px">' + events.length + ' events</div>';
        body.innerHTML = html;
      } catch(err) {
        body.innerHTML = '<div style="color:#dc2626;padding:8px">Error: ' + err.message + '</div>';
      }
    }

    // Backup functions
    async function loadBackupStatus() {
      try {
        var resp = await fetch('/api/admin/backup-status');
        var b = await resp.json();
        var el = document.getElementById('backup-status');
        var det = document.getElementById('backup-detail');
        if (b.status === 'never') {
          el.innerHTML = '<span style="color:#f59e0b">&#9679;</span> No backups yet';
        } else if (b.status === 'ok') {
          var ago = Math.round((Date.now() - new Date(b.ts).getTime()) / 3600000);
          var color = ago < 25 ? '#16a34a' : ago < 49 ? '#f59e0b' : '#dc2626';
          el.innerHTML = '<span style="color:'+color+'">&#9679;</span> ' + (ago < 1 ? 'Just now' : ago + 'h ago');
          det.innerHTML = 'Last: ' + new Date(b.ts).toLocaleString() + ' &middot; ' + b.files + ' files &middot; ' + (b.size/1024).toFixed(1) + 'KB' + (b.gistUrl ? ' &middot; <a href="'+b.gistUrl+'" target="_blank" style="color:#16a34a">View Gist</a>' : '') + (b.elapsed ? ' &middot; ' + b.elapsed : '');
        } else if (b.status === 'error') {
          el.innerHTML = '<span style="color:#dc2626">&#9679;</span> Failed';
          det.innerHTML = 'Error: ' + (b.error || 'Unknown') + (b.ts ? ' &middot; ' + new Date(b.ts).toLocaleString() : '');
        } else if (b.status === 'skipped') {
          el.innerHTML = '<span style="color:#f59e0b">&#9679;</span> Skipped (no PAT)';
          det.innerHTML = 'Set GITHUB_PAT env var in Railway to enable backups.';
        }
      } catch(e) { console.error('Backup status:', e); }
    }
    loadBackupStatus();

    async function triggerBackup() {
      var btn = document.getElementById('backup-btn');
      var el = document.getElementById('backup-status');
      btn.disabled = true; btn.textContent = 'Backing up\u2026';
      el.innerHTML = '<span style="color:#f59e0b">&#9679;</span> Running\u2026';
      try {
        var resp = await fetch('/api/admin/backup', { method: 'POST' });
        var b = await resp.json();
        loadBackupStatus();
      } catch(e) {
        el.innerHTML = '<span style="color:#dc2626">&#9679;</span> Failed: ' + e.message;
      }
      btn.disabled = false; btn.textContent = 'Backup Now';
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
      // Filter to only show reports that DON'T have shared UUIDs
      const filtered = mbData.map(org => ({
        ...org,
        reports: org.reports.filter(rep => !SHARED_UUIDS_CLIENT[rep.key])
      })).filter(org => org.reports.length > 0);
      if (!filtered.length) { wrap.innerHTML = '<div style="padding:16px 20px;font-size:12px;color:#999">All reports use shared base queries. No per-org overrides needed.</div>'; return; }
      wrap.innerHTML = filtered.map(org => \`
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
      mbEditing = { org: slug, report: reportKey, shared: false };
      document.getElementById('mb-modal-title').textContent = rep.label;
      document.getElementById('mb-modal-sub').textContent = org.displayName + ' · ' + slug;
      document.getElementById('mb-modal-current').value = rep.publicUrl;
      document.getElementById('mb-modal-input').value = '';
      document.getElementById('mb-modal-err').style.display = 'none';
      document.getElementById('mb-modal-overlay').style.display = 'block';
      document.body.style.overflow = 'hidden';
      setTimeout(() => document.getElementById('mb-modal-input').focus(), 50);
    }

    function mbOpenSharedModal(reportKey, currentUuid) {
      mbEditing = { report: reportKey, shared: true };
      document.getElementById('mb-modal-title').textContent = reportKey + ' (shared base report)';
      document.getElementById('mb-modal-sub').textContent = 'Applies to ALL orgs using this report';
      document.getElementById('mb-modal-current').value = currentUuid;
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
        const endpoint = mbEditing.shared ? '/api/admin/update-shared-link' : '/api/admin/update-link';
        const body = mbEditing.shared
          ? { password: mbPwd, report: mbEditing.report, link }
          : { password: mbPwd, org: mbEditing.org, report: mbEditing.report, link };
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Update failed');
        if (!mbEditing.shared) {
          const org = mbData.find(o => o.slug === mbEditing.org);
          const rep = org && org.reports.find(r => r.key === mbEditing.report);
          if (rep) { rep.mbUuid = data.newUuid; rep.publicUrl = data.publicUrl; }
        }
        mbRenderList();
        mbCloseModal();
        mbToast(mbEditing.shared ? 'Shared UUID updated for all orgs — redeploying (~1–2 min)' : 'Saved — Railway is redeploying (~1–2 min)');
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
    
    // ── AI Analytics widget ──
    (async function loadAiAnalytics() {
      try {
        const resp = await fetch("/api/admin/ai-analytics");
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const d = resp.ok ? await resp.json() : null;
        if (!d) return;

        const fmt = (n) => typeof n === "number" ? (n >= 1000 ? (n/1000).toFixed(1) + "k" : String(n)) : "0";
        const fmtUsd = (n) => "$" + (n || 0).toFixed(2);
        const pct = d.feedback.up + d.feedback.down > 0
          ? Math.round(100 * d.feedback.up / (d.feedback.up + d.feedback.down)) + "%"
          : "\u2014";

        const cards = [
          { label: "Total AI Calls", value: fmt(d.totalCalls), sub: fmt(d.calls7d) + " last 7d", color: "#6366f1" },
          { label: "AI Spend (30d)", value: fmtUsd(d.cost30d), sub: fmtUsd(d.cost7d) + " last 7d", color: "#10b981" },
          { label: "Tokens (In/Out)", value: fmt(d.totalTokensIn) + " / " + fmt(d.totalTokensOut), sub: "cumulative", color: "#3b82f6" },
          { label: "Feedback Score", value: pct, sub: "\u{1F44D}" + d.feedback.up + " \u{1F44E}" + d.feedback.down, color: "#f59e0b" },
        ];

        var grid = document.getElementById("ai-analytics-grid");
        grid.innerHTML = cards.map(function(c) {
          return '<div style="background:#fff;border-radius:8px;padding:14px 16px;border-left:3px solid ' + c.color + '">'
            + '<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">' + c.label + '</div>'
            + '<div style="font-size:22px;font-weight:700;color:#111">' + c.value + '</div>'
            + '<div style="font-size:11px;color:#999;margin-top:2px">' + c.sub + '</div>'
            + '</div>';
        }).join("");

        // Feature breakdown + top orgs
        var detail = document.getElementById("ai-analytics-detail");
        var featureNames = { insights: "AI Insights", chat: "Rec AI Chat", wizard: "Report Wizard", recommend: "Program Finder" };
        var featureColors = { insights: "#7c3aed", chat: "#3b82f6", wizard: "#6366f1", recommend: "#f59e0b" };

        var featureHtml = '<div style="background:#fff;border-radius:8px;padding:14px 16px">'
          + '<div style="font-size:12px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px">By Feature</div>';
        Object.entries(d.byFeature).sort(function(a,b){ return b[1].calls - a[1].calls; }).forEach(function(entry) {
          var k = entry[0], v = entry[1];
          var maxCalls = Math.max.apply(null, Object.values(d.byFeature).map(function(x){ return x.calls; }));
          var barW = maxCalls > 0 ? Math.max(4, Math.round(100 * v.calls / maxCalls)) : 0;
          featureHtml += '<div style="margin-bottom:8px">'
            + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">'
            + '<span style="color:#333">' + (featureNames[k] || k) + '</span>'
            + '<span style="color:#666">' + v.calls + ' calls \u00B7 ' + fmtUsd(v.cost) + '</span></div>'
            + '<div style="background:#f0f0f0;border-radius:3px;height:6px;overflow:hidden">'
            + '<div style="width:' + barW + '%;height:100%;background:' + (featureColors[k] || '#888') + ';border-radius:3px"></div>'
            + '</div></div>';
        });
        featureHtml += '</div>';

        var orgHtml = '<div style="background:#fff;border-radius:8px;padding:14px 16px">'
          + '<div style="font-size:12px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px">Top Orgs by AI Usage</div>';
        d.topOrgs.forEach(function(o) {
          var maxC = d.topOrgs[0] ? d.topOrgs[0].calls : 1;
          var barW = Math.max(4, Math.round(100 * o.calls / maxC));
          orgHtml += '<div style="margin-bottom:8px">'
            + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">'
            + '<span style="color:#333">' + o.org + '</span>'
            + '<span style="color:#666">' + o.calls + ' calls \u00B7 ' + fmtUsd(o.cost) + '</span></div>'
            + '<div style="background:#f0f0f0;border-radius:3px;height:6px;overflow:hidden">'
            + '<div style="width:' + barW + '%;height:100%;background:#6366f1;border-radius:3px"></div>'
            + '</div></div>';
        });
        if (!d.topOrgs.length) orgHtml += '<div style="color:#999;font-size:12px">No AI usage yet</div>';
        orgHtml += '</div>';

        detail.innerHTML = featureHtml + orgHtml;

      } catch(e) {
        var el = document.getElementById("ai-analytics-grid");
        if (el) el.innerHTML = '<div style="color:#c66;font-size:12px">Could not load AI analytics</div>';
      }
    })();

    const UPDATES = [
  { date: '2026-06-23', title: 'Langfuse AI Observability', items: [
    '\u{1F50D} LANGFUSE INTEGRATION \u2014 All 4 AI features (Insights, Chat, Wizard, Program Finder) now traced via Langfuse + OpenTelemetry. Every Claude call captures full input/output, token usage, latency, and cost. Auto-instrumented via @arizeai/openinference-instrumentation-anthropic.',
    '\u{1F4E6} Migrated from raw fetch() to official @anthropic-ai/sdk for all AI endpoints. Chat streaming uses SDK stream() API with event-driven text forwarding. Cleaner error handling, automatic retries.',
    '\u{1F4CA} New AI Analytics section on root dashboard \u2014 total calls, spend (7d/30d), token usage, feedback score, breakdown by feature and org. Powered by /api/admin/ai-analytics endpoint reading from events.jsonl.',
    '\u{1F6E1}\uFE0F Graceful degradation: if LANGFUSE env vars not set, tracing is silently disabled but all AI features continue working normally.',
  ] },
  { date: '2026-06-23', title: 'How This Works doc update', items: ['Updated entry point diagram and security section to reflect direct-link approach (replacing iframe embed) — interactive elements like buttons, date pickers, and PDF downloads broke inside iframes, so reports now open in a full browser tab via links inside Metabase dashboards'] },
      { date: "2026-06-23", title: "Smyrna Historic Report", items: ["Recreated Metabase SQL for Smyrna historic facility rental report", "Updated Metabase public UUID to new question"] },
      { date: '2026-06-22', title: 'Public Facility Rental Calendar (Early Access)', items: [
        '\u{1F4C5} New public-facing facility availability calendar at /:org/rentalcalendar?locationId=X \u2014 no token required, fully public',
        '\u{1F4E1} LIVE REAL-TIME DATA via @modelcontextprotocol/sdk calling rec.us MCP server (api.rec.us/mcp). Node.js MCP client tries Streamable HTTP, falls back to SSE. 5-min availability cache, 10-min site list cache.',
        '\u{1F3AF} Validated 100% against Watertown internal calendar: all 22 Arsenal Park sites (5 courts, 2 fields, 3 pavilions, 12 picnic tables) match perfectly including back-to-back bookings and multi-table events.',
        '\u{1F7E2}\u{1F7E0}\u2B1C Three visual states: green=Available, orange=Reserved (real bookings), gray=Closed (outside site operating hours).',
        '\u23F0 Per-site operating hours derived from each site\u2019s own availability data (e.g. fields close at 6pm, courts run until 10pm). Duration-aware coverage: a 4pm start with 2hr duration shows 4-6pm as available, not just 4pm.',
        '\u{1F9E9} Auto-groups sites by type when \u22653 (12 picnic tables collapse into one expandable row). Emoji icons, hour gridlines, Book/Request CTA buttons deep-linking to rec.us booking pages.',
        '\u{1F4A1} KEY FINDING: Anthropic API mcp_servers param is artifact-only (not server-side). Raw HTTP POST to MCP endpoint returns Not Found. But @modelcontextprotocol/sdk npm package works perfectly as a standalone Node.js MCP client.',
      ] },
  { date: '2026-06-22', title: 'GL Desk Location support for shared query', items: [
    'Shared GL query now includes Desk Location dimension \u2014 all shared-GL orgs get the \u{1F5C4}\uFE0F Desk filter dropdown automatically when their data has 2+ desk locations.',
    'GL proxy logic updated: per-org GL UUID takes priority over shared (Norman keeps its custom gl_map query with Locations column). All other report types still prefer shared.',
    'Removed 9 dead per-org GL UUIDs (clarksville, smyrna, watertown, littleton, danvers, midland, joplin, shrewsbury, westsacramento) \u2014 all now use shared GL.',
  ]},
  { date: '2026-06-22', title: '\u{1F4D0} How This Works Overhaul + Architecture Diagram', items: [
    '\u{1F3D7}\uFE0F ARCHITECTURE DIAGRAM \u2014 New inline SVG architecture diagram in the How This Works section showing the full system: entry points (rec.us admin iframe, direct token URLs, public calendar), token gate middleware, Railway app internals (React/Babel, Metabase proxy, AI engine, Puppeteer, PII stripper, wizard, email, backups, analytics, health checks), and data layer (Metabase, PostgreSQL, external services).',
    '\u{1F50F} SECURITY BY OBFUSCATION \u2014 New section documenting how the reports portal is embedded as an iframe inside the rec.us admin Metabase dashboard. Partner staff never see the direct Railway URL \u2014 three-layer auth: rec.us admin session + Reporting tab access + 16-char token.',
    '\u{1F4CB} REPORTS LIST UPDATED \u2014 Added Director\u2019s Report, Instructor Payout, and AI-Powered Features section (Report Wizard + AI Insights). Updated Programs description (two-tab layout, demographics). Updated shared query count to 12 of 15.',
    '\u{1F527} ENV VARS + BACKUPS \u2014 Added GITHUB_PAT, ANTHROPIC_API_KEY to env var docs. New Daily Backups section. Updated Adding a New Org to reflect only Historic as remaining per-org report. Updated Deployment section for Railway Pro + persistent volume.',
  ]},
  { date: '2026-06-22', title: 'Report Wizard toggle fix', items: ['Fixed "Unknown report type" error when toggling Report Wizard visibility from admin dashboard'] },
      { date: '2026-06-21', title: '🔧 Platform Fixes & Enhancements', items: [
        '📊 WIZARD TABLE FIX — Grouped tables now correctly show count columns when the field name matches the groupBy field. Uses indexed column keys to avoid collision between group label and aggregate value.',
        '🎭 ACTIVITY + CATEGORY — Programs shared SQL now includes activity_name and category_name via class_activity join table. Wizard can filter by activity type (e.g. Camp, Aquatics, Fitness) instead of guessing from program names.',
        '💾 DAILY BACKUPS — GitHub Gist backup system: daily cron at 2am + startup. All data/ files snapshotted to a private Gist. Manual Backup Now button in App Control. Status indicator in header bar (green/yellow/red dot with age).',
        '⬆️ RAILWAY PRO — Upgraded to Railway Pro tier: 1TB storage, 99.99% availability, persistent volumes, 30-day logs.',
        '🐛 APOSTROPHE FIX — Straight apostrophes in template literal JS strings were killing the entire admin script block. All converted to curly apostrophes (’). Documented in project memory.',
      ]},
      { date: '2026-06-21', title: '💰 Instructor Payout — 65/35 Split, Base Price Toggle & Participant Drill-Down', items: [
        '💰 65/35 SPLIT — Added 65/35 to the split bar alongside existing 90/10, 80/20, 70/30, 60/40, 50/50 options.',
        '🎯 BASE PRICE SPLIT — New toggle calculates instructor payout on the resident/base rate instead of the amount actually paid. Non-resident surcharges stay entirely with the org. Tooltip explains the feature.',
        '👥 PARTICIPANT DRILL-DOWN — Click any section row to expand per-participant detail: name, signup date, base vs actual price, GRP/STD badge, and per-person split amounts.',
        '❌ CANCELED HANDLING — Refunded/canceled participants show in red with strikethrough and CANCELED badge. Split = $0 for canceled — excluded from enrolled count and payout calculations.',
        '🔍 SEARCH FIX — Search now splits into words and matches across section + program + instructor names. "austin ritter basketball" finds "Austin Ritter’s Basketball Clinic".',
        '📊 RESIDENT RATE LOGIC — Base price split derives the resident rate from Group/Resident participants’ actual price (not the sticker price), ensuring the instructor split base is always the lower contracted rate.',
        '📥 SQL UPGRADE — Metabase query now returns per-participant rows with applied_pricing decomposition (base, final, list prices, price type). Canceled bookings with refunds included.',
      ]},
  { date: '2026-06-21', title: 'Instructor Payout Report', items: ['New report: revenue splits and payout calculations by instructor', 'Split selector (90/10 through 50/50) with instant KPI updates', 'Grouped by instructor with subtotals and grand total', 'Fill rate bars, refund tracking, top instructor chart', 'Excel export with split calculations'] },
      { date: '2026-06-21', title: '🪄 Rec AI Report Wizard — Custom AI-Generated Dashboards', items: [
        '🪄 REPORT WIZARD — Describe a report in plain English, get an AI-generated dashboard with KPI cards, charts, and tables. Available at /:org/report-wizard for ALL orgs. Card added to every org dashboard and org landing page.',
        '✨ AI CONFIG ENGINE — Claude analyzes available data sources (programs, demographics, GL, facility, products, etc.), auto-discovers field names/types, and designs a widget layout. Source descriptions prevent cross-source field confusion.',
        '📊 WIDGET LIBRARY — KPI row (with per-category filters), bar charts, pie/donut charts, and sortable aggregated tables. Count/countDistinct work on string fields (gender, program names). PII columns auto-stripped.',
        '💾 SAVE & RELOAD — Save generated reports to localStorage with one click. Reload re-fetches live data. Debug config panel with Copy button for sharing configs.',
        '👍 FEEDBACK — Thumbs up/down on every generated report, logged to events. Admin dashboard Wizard Activity panel shows all prompts, costs, and feedback votes.',
        '🎯 50 JUICE PHRASES — Custom juicing-themed loading messages: Centrifuging the spreadsheets, Deglazing the GL codes, Torching the crème brûlée chart, etc.',
        '🛡️ PII PREVENTION — System prompt bans individual names/emails/phones from tables. Client-side strips PII columns even if AI includes them. Tables show aggregated data only.',
      ]},
      { date: '2026-06-20', title: '\uD83D\uDE80 Fast Track Pipeline Tab \u2014 Pre-Registration Demand Forecasting', items: [
        '\uD83D\uDE80 PIPELINE TAB \u2014 FT report now has four tabs: Overview, Revenue, Demographics, Pipeline. Pipeline shows sections that are published but registration hasn\u2019t opened yet \u2014 the presale window where FT wishlists accumulate.',
        '\uD83D\uDCCA DEMAND HEAT \u2014 Pipeline table shows FT wishlists, pending count, capacity, demand ratio with color-coded heat (green/amber/red), countdown to reg opens, and early access dates.',
        '\uD83D\uDCC5 SCHEDULED \u2014 Also surfaces sections with FT activity that aren\u2019t published yet (scheduled state), so partners can see what\u2019s coming.',
        '\uD83D\uDD04 ZERO-FT PIPELINE \u2014 SQL v6 adds a third UNION block for published sections with future reg windows but NO FT signups yet. Partners can see which programs need promotion.',
        '\uD83D\uDCC6 EMPTY STATE \u2014 Friendly message when no pipeline sections exist, explaining when they\u2019ll appear (new seasons publishing with future reg windows).',
      ]},
      { date: '2026-06-20', title: '\uD83D\uDCB0 Fast Track Revenue Tab \u2014 Financial Impact Analysis', items: [
        '\uD83D\uDCB0 REVENUE TAB \u2014 FT report now has three tabs: Overview, Revenue, and Demographics. Revenue tab lazy-fetches CI data and shows total FT revenue, revenue per HH, revenue per conversion, cost savings, and total FT value (revenue + savings).',
        '\uD83D\uDCCA REVENUE BY TYPE \u2014 Breaks down FT household revenue by source: Programs, Facility, Fees, Products. Bar charts for revenue distribution and household spend buckets ($0, $1-100, $101-300, etc).',
        '\u2696\uFE0F FT VS NON-FT \u2014 Side-by-side spending comparison showing average spend per household for FT vs non-FT, with dollar and percentage differences.',
        '\uD83C\uDFC6 TOP PROGRAMS \u2014 Programs ranked by FT conversion volume. Revenue insights narrative auto-generated with top drivers and efficiency metrics.',
        '\uD83E\uDDF9 DEMOGRAPHICS CLEANUP \u2014 Revenue/spending metrics moved from Demographics \u2192 Revenue tab. Demographics now focused purely on who FT users are (age, residency, geography, first-touch).',
      ]},
      { date: '2026-06-20', title: '\uD83D\uDC65 Fast Track Demographics Tab \u2014 Moved to FT Report', items: [
        '\u26A1 DEMOGRAPHICS TAB \u2014 FT report now has a two-tab layout: Overview (existing section/program data) and Demographics (community crossover analysis). Demographics tab lazy-fetches CI data on click.',
        '\uD83D\uDD17 CROSS-REFERENCE \u2014 Matches FT users to community households by email/HH ID. Shows first-touch acquisition, FT vs non-FT spending, residency rates, age distribution, and geographic breakdown.',
        '\uD83D\uDCC8 IMPACT METRICS \u2014 Admin hours saved, estimated cost savings, and self-service rate now live in the Demographics tab alongside the household-level analysis.',
        '\uD83D\uDEAE REMOVED FROM CI \u2014 Fast Track tab removed from Community Intelligence report. FT story belongs in the FT report, not buried in a 6-tab hub.',
      ]},
      { date: '2026-06-20', title: '\uD83D\uDCCB Director\u2019s Monthly Report \u2014 One-Click Executive Summary', items: [
        '\u2728 ONE-CLICK REPORT \u2014 New /:org/directors-report generates a polished monthly executive summary. Fetches GL revenue, programs, community demographics, and Fast Track data in parallel (all cached). Single button press, instant results.',
        '\uD83E\uDD16 AI EXECUTIVE INSIGHTS \u2014 Anthropic-powered narrative generates 3-4 actionable insight cards citing specific numbers: achievements, concerns, and recommended actions. Custom system prompt tuned for council presentations.',
        '\uD83D\uDCCA REVENUE MIX \u2014 Horizontal stacked bar showing Programs/Facility/Products/Fees split with percentages from all-time household revenue data.',
        '\u26A0\uFE0F PROGRAMS AT RISK \u2014 Bottom 5 programs by fill rate (capacity >10). Red/orange indicators for underperforming programs with actionable guidance.',
        '\uD83D\uDCCB DATA COMPLETENESS \u2014 Progress bars for Age, Gender, Grade, Phone profile completeness. Highlights missing data counts for compliance reporting.',
        '\uD83D\uDCC4 PDF EXPORT \u2014 Download as a polished 2-page PDF via existing Puppeteer pipeline. Auto-generates in print mode with report-ready signal.',
      ]},
      { date: '2026-06-19', title: '\uD83D\uDD12 Audit Logging + API Cache Overhaul', items: [
        '\uD83D\uDD0D AUDIT LOGGING \u2014 Every report view, PDF export, AI insight, and chat message now captures user-agent and referer alongside IP. Enables device fingerprinting and shared-token detection. All 19 route-level event loggers upgraded.',
        '\u26A1 PER-REPORT CACHE TTLs \u2014 Replaced flat 5-minute TTL with tuned per-report durations: 30min for live data (facility, GL, roster, calendar), 2hrs for stable reports (programs, memberships, products), 4hrs for very stable (fast track, court utilization, program demographics). 96% reduction in Metabase API calls.',
        '\uD83D\uDCCA CACHE STATS \u2014 New GET /api/admin/cache-stats endpoint: hit rate %, miss count, pre-warm cycles, per-entry age vs TTL, row counts. Monitor cache performance from the admin dashboard.',
        '\uD83D\uDD04 PRE-WARM TUNED \u2014 Cache pre-warm interval changed from every 4 minutes to every 60 minutes, aligned with the new TTL windows. Data stays warm without hammering Metabase.',
      ]},
      { date: '2026-06-19', title: '\uD83C\uDF1F Shared Report Architecture + Programs Demographics + Platform Hardening', items: [
        '\uD83D\uDE80 SHARED UUID ARCHITECTURE \u2014 All report availability checks now include SHARED_UUIDS fallback. Org landing pages, admin dashboard, CI cross-tabs, and HTML page routes (Products, Memberships, Court Utilization, Fast Track) all correctly serve shared reports. Adding a new org is now: slug + orgId + logo + token \u2014 done. All 12 shared reports light up automatically.',
        '\uD83D\uDC65 PROGRAMS PARTICIPANTS TAB \u2014 Two-tab Programs report (Revenue + Participants). Per-program demographics with dedicated Male/Female/NB/Unknown columns for Fair Play Act compliance. Section drill-down accordion. Visual profile cards (gender stacked bar, age/city/grade horizontal bars). Search filter updates all sections. PDF export threads active tab + filter state.',
        '\uD83C\uDF31 FIRST-TOUCH ACQUISITION \u2014 CI Fast Track tab identifies households whose first-ever booking was via FT (48hr window match). FT vs non-FT avg household spend comparison. FT SQL v5 with user-level UNION ALL including First FT Date, User Created At, First Any Booking.',
        '\uD83D\uDD2C CI SQL UPGRADE \u2014 Shared users query upgraded from HoH-only/no-revenue to full household membership with Role column, HoH Name, and complete revenue breakdown (Gross/Net/Refunds + Program/Facility/Fee/Product splits from materialized.item_log_report). Dynamic residency group lookup. All orgs get full CI experience.',
        '\uD83D\uDC1B NULL EMAIL FIX \u2014 Discovered that household member participants (kids) have NULL emails in users table. SQL NOT LIKE on NULL evaluates to NULL (falsy), silently dropping all youth program enrollments. Fixed program-demographics SQL by removing guest filters (guests can\u2019t register for programs anyway).',
        '\uD83C\uDF4A SHARED JUICE LOADER \u2014 Extracted loading animation into /juice-loader.js with pool of 50 fun randomized phrases. Drop-in React component for any report. Used in Programs and Fast Track.',
        '\u2705 ROSTER SIGNATURES \u2014 Digital signature base64 blobs replaced with \u201C\u2713 Signed\u201D. Fixes layout blowout from waiver form responses.',
        '\uD83D\uDD27 ADD-REPORT MODAL + RENAME \u2014 Modal only shows per-org reports (just Historic). Program Revenue \u2192 Programs across all UI surfaces.',
      ]},
      { date: '2026-06-19', title: '\uD83D\uDC65 Programs Report: Participants Demographics Tab', items: [
        '\u2728 PARTICIPANTS TAB \u2014 New tab on Programs report showing per-program demographic breakdown: enrollment counts, avg age, Youth/Adult/Senior percentages, gender split, household count. Lazy-loaded on tab click from a dedicated Metabase query.',
        '\uD83D\uDCCA SUMMARY KPIs \u2014 Total enrollments, unique participants, unique households, avg/median age, age bracket distribution, Fast Track enrollment percentage.',
        '\uD83D\uDD12 ROLLOUT CONTROL \u2014 Participants tab enabled per-org via server-side flag (PARTICIPANTS_ENABLED set). Currently live for West Sacramento; locked with \uD83D\uDD12 badge for other orgs.',
      ]},
      { date: '2026-06-19', title: '\uD83C\uDF31 Fast Track First-Touch Acquisition Analytics', items: [
        '\u2728 FIRST-TOUCH ACQUISITION \u2014 New section on Community Intelligence FT tab identifies households whose very first booking was via Fast Track. These are net-new customers FT brought through the door, not existing users choosing convenience.',
        '\uD83D\uDCB8 FT vs NON-FT SPEND \u2014 Side-by-side average household spend comparison between Fast Track users and non-FT users. Answers the question: are FT-acquired customers higher-value?',
        '\uD83D\uDCC8 FT SQL v5 \u2014 User-level UNION ALL now includes First FT Date, User Created At, and First Any Booking columns. First-touch detection compares first FT date against first-ever confirmed booking within 48hr window.',
      ]},
      { date: '2026-06-19', title: '\uD83D\uDE80 Major Architecture Overhaul: Shared Queries + New Analytics + Admin Controls', items: [
        '\u2728 SHARED QUERY MIGRATION \u2014 9 of 12 report types now run from a single parameterized Metabase question each. No more per-org SQL duplication. Onboarding a new org is now: slug + UUID + logo \u2014 done.',
        '\uD83D\uDED2 PRODUCTS ANALYTICS \u2014 Full Products tab on Community Intelligence: KPIs, top 12 products by revenue, weekly trend chart, desk location breakdown with progress bars.',
        '\uD83D\uDD12 PII SECURITY \u2014 CSV exports replaced with Request CSV modal routing to Partner Support. No more direct download of user data.',
        '\uD83D\uDCC5 CALENDAR \u2014 Today indicator on week view. Today button on all views. Public embed-ready URLs (no token). Session click tracking with admin dashboard metric.',
        '\uD83D\uDCCA DATA COMPLETENESS \u2014 Phone + Emergency Contact completeness rings on Demographics. Enhanced users SQL with profile demographics, household size, and completeness flags.',
        '\uD83C\uDFAF REVENUE BY GENDER \u2014 Demographic revenue breakdown on Revenue tab with coverage-aware caveats for low sample sizes.',
        '\u2699\uFE0F APP CONTROL CENTER \u2014 Feature flags (Email Subscriptions toggle). Metabase Links consolidated into App Control. Add-org wizard auto-detects shared reports.',
      ]},
      { date: '2026-06-18', title: 'Partner quotes on admin hero', items: [
        'Scrolling testimonial strip below the photo upload section on the admin dashboard hero card',
        'Auto-scrolling marquee with pause-on-hover; duplicated cards for seamless loop',
        'Add quotes inline: type in one line like \\u201CGreat reports!\\u201D - Name, Org and hit Enter or click + Add quote',
        'Quotes persisted to data/quotes.json on Railway volume; hover any card to reveal \\u00D7 delete button',
        'API: GET/POST/DELETE /api/admin/quotes',
      ] },
      { date: '2026-06-17', title: 'Community Intelligence \u2014 cross-report intelligence hub', items: [
        'Fast Track tab on CI: fetches FT data lazily on click, shows conversion funnel, top programs by demand, KPI row (signups/converted/pending/dropped/FT share), and Key Observations',
        'FT demographic crossover: v5 SQL adds per-user rows via UNION ALL; CI matches FT customers against demographic data by email/household ID for age distribution, residency rate, geographic concentration vs general population',
        'Locked tab teasers: reports not enabled for an org show a lock icon with "Contact Partner Success to unlock [X] analytics" \u2014 clean upsell surface',
        'Products tab placeholder in cross-tab config, ready for analytics computation when needed',
        'Progressive loading: compute() deferred to next frame via setTimeout so the page shell renders instantly with "Crunching N records\u2026" spinner, then KPIs and charts fill in',
      ] },
      { date: '2026-06-17', title: 'Guests tab \u2014 dedicated analytics replacing the toggle button', items: [
        'New Guests tab on Community Intelligence with pre-aggregated analytics: KPI row (guest count, gross/net revenue, avg transaction, items per guest, share of total revenue), Key Observations (product/program/facility split, volume alerts, upsell opportunity), charts (revenue by category, spend distribution, monthly account creation trend)',
        'Removed the Guests ON/OFF toggle button that froze the browser with 34K+ rows \u2014 guests are now always excluded from Demographics/Revenue/Strategy tabs with zero performance penalty',
        'Export CSV button added to the cross-sell "both programs and facilities" card on the Strategy tab',
      ] },
      { date: '2026-06-17', title: 'Navigation breadcrumb on all reports', items: [
        'New shared nav-breadcrumb.js auto-injects a "\u2190 OrgName" link at the start of every report toolbar for one-click return to the org dashboard',
        'Uses ORG_CONFIG.displayName when available, falls back to capitalizing the slug; preserves token in the link; hides in print/PDF mode',
        'Skipped on customer-facing calendar page and admin/metrics pages',
      ] },
      { date: '2026-06-17', title: 'Community Intelligence \u2014 guest detection fix + report rename', items: [
        'Fixed critical guest detection bug: 34,000+ guest accounts at Apex (and similar counts at other orgs) were being misclassified as staff because guest emails (guest-user+*@rec.us) matched the @rec.us staff filter. isStaff now excludes guest-user+ prefixed emails',
        'Report renamed from "Users Report" to "Community Intelligence" \u2014 reflects the report\u2019s evolution into a demographics + revenue + strategy dashboard, not just a user list',
        'Guest accounts now correctly counted and displayed in the toggle \u2014 $525K gross revenue in Apex alone was previously invisible, 98.7% of it product/concession sales',
      ] },
      { date: '2026-06-17', title: 'Memberships report visual overhaul', items: [
        'Added white page wrapper, report header with org logo/name/title, and footer with run date \u2014 matches programs, facility, GL, and all other reports',
        'Summary cards restyled from grid-of-colored-border cards to standard beige flex row with colored values (green/red/amber/blue/pink/purple)',
        'Print and PDF export now renders the same clean page layout with no toolbar or box shadow',
      ] },
      { date: '2026-06-17', title: 'Facility report \u2014 per-section column headers + performance', items: [
        'Column header row (Begin, End, Facility/Site, etc.) now repeats at the top of every date/location section so headers are always visible on page 10+ of a long report',
        'Default Metabase health-check timeout bumped from 30s to 60s; data proxy route now has a 120s timeout with clear 504 error message instead of hanging silently',
        'Cache pre-warm now stores results under explicit This Month cache key so clicking This Month hits warm cache instead of cold Metabase',
        'Optimized facility SQL for all 6 orgs \u2014 replaced two correlated per-row subqueries (Resident? and Notes) with pre-computed CTEs and LEFT JOINs, cutting Apex monthly from ~2 min to seconds',
        'PDF export now shows only the rental schedule table \u2014 heatmaps, residency revenue analysis, and booking channel analysis are hidden in print mode',
      ] },
      { date: '2026-06-16', title: 'Daily Pulse \u2014 executive summary with month-over-month trends', items: [
        'Daily Pulse on org landing page \u2014 blue gradient cards showing current-month revenue, refunds, enrollments, bookings, product sales, and households. Fetches from Metabase with explicit date filters (not default cache)',
        'Month-over-month delta arrows \u2014 green \u2191 / red \u2193 with percentage change vs prior month on every metric',
        'Admin dashboard: indigo metrics strip on each org section showing same pulse KPIs at a glance with MoM deltas',
        '24-hour pulse cache pre-warmed daily at 5:10am (after users cache at 5am) and on startup at 30s \u2014 org pages load instantly',
        'New API endpoint GET /:org/api/pulse returns monthly aggregated metrics with delta data',
        'Value-prop callouts added to admin hero section \u2014 four pill badges below tagline',
      ] },
      { date: '2026-06-16', title: 'Admin cards cleanup + org metrics bar redesign', items: [
        'Admin cards: replaced stacked health/tier/vote badges with compact layout \u2014 AI tag inline with label, health status as single colored dot (green/yellow/red) with full details in tooltip, votes as right-aligned count',
        'Tier cycling preserved: click the health dot to cycle critical/standard/low (tooltip shows current tier + frequency)',
        'Org landing page: metrics bar now uses indigo gradient (matching admin hero) with white numbers and #a5b4fc labels',
      ] },
      { date: '2026-06-15', title: 'Program Finder \u2014 AI-curated program recommendations via email', items: [
        'New: \u2728 Find Programs for Me \u2014 floating CTA on the public calendar lets residents describe what they\u2019re looking for and receive a personalized, AI-curated list of matching programs via email',
        'Pulls live calendar + programs data (next 30 days), sends condensed schedule to Claude, generates ranked recommendations with personalized match reasons',
        'Branded HTML email with org logo, program details (schedule, location, price), \u201CWhy this is a great match\u201D blurbs, direct register links, and Browse Full Calendar CTA',
        'Rate limited: 3 requests per IP per hour. Email used once (no storage, no spam). Description capped at 1000 chars',
        'POST /:org/calendar/api/recommend endpoint. AI cost tracked in events log alongside other insights spend',
      ] },
      { date: '2026-06-15', title: 'Daily Health Check \u2014 automated report monitoring', items: [
        'New: Daily health check cron (6am) hits every configured Metabase report across all orgs, verifies HTTP 200 + valid JSON response',
        'Alert email sent to dan@rec.us when any report fails (timeout, HTTP error, or Metabase query error)',
        'Health badges on org landing page cards and admin dashboard \u2014 green \u2705 Verified with date, yellow \u26A0\uFE0F Empty, red \u274C Failed',
        'Manual Run Now button on admin dashboard status bar triggers immediate health check',
        'API endpoints: GET /api/health-check (latest results), POST /api/health-check/run (manual trigger)',
        'Results persisted in data/health-check.json on Railway volume. Auto-seeds on first startup if no prior check exists',
      ] },
      { date: '2026-06-14', title: 'Users Report \u2014 3-tab demographic + revenue + strategy intelligence', items: [
        'New report: Users \u2014 full household demographic, revenue, and strategic intelligence dashboard with 3 tabs',
        'Demographics tab: KPIs (households, people, residents%, median age, grade coverage), Key Observations with emojis (stripped in PDF), Rec AI Insights, HH size distribution, residency & completeness rings, data quality alerts, signups by month, cumulative growth, age by role (stacked), gender donut, residency by age, grade distribution, city breakdown',
        'Revenue tab: KPIs (net revenue, median/HH, conversion%, unbooked count, refund rate), spend tier labels (Low Spender/Typical/Active/Power User/Super Fan), Key Observations, Rec AI Insights, revenue distribution histogram, resident vs non-resident comparison, revenue by HH size, Pareto concentration curve, conversion funnel, revenue by category (Programs/Facilities/Fees/Products with donut + breakdown)',
        'Strategy tab: Geographic heatmap (Leaflet + zippopotam.us geocoding, Households/Revenue toggle, color gradient circles, cached in localStorage), Key Observations, Rec AI Insights, Revenue Levers with dollar amounts + CSV export (unbooked conversion, non-resident parity, solo HH activation), Who\u2019s Not Buying comparison table, Lapsing Households (90+ days), Revenue by Member Age, Grade Gap Analysis, Cross-Sell Opportunities (programs-only vs facility-only HH with CSV export)',
        'Guest detection: first_name=Guest or email starts with guest-user+guest-. Toolbar toggle (OFF by default), excluded from demographics but included in revenue. High guest volume triggers POS recommendation',
        'Staff filtering: @rec.us emails silently stripped from all analysis',
        'Daily 5am pre-cache cron with 24h TTL. Cache banner shows date/time with Refresh Now button. Startup pre-warm after 15s',
        'Tab-specific AI insights: switching tabs clears previous insights, each tab sends different data blob (demographic/revenue/strategy focused)',
        'PDF export via Puppeteer. Emojis in observations wrapped in <span class=emoji> hidden via print-mode CSS',
        'Dark toolbar matching other reports. Juice glass loading animation on all loading states',
        'SQL: org_households CTE via organization_association, template tags moved to outer WHERE for Metabase compatibility. Revenue from materialized.item_log_report with 4-way category split (reservation-enrollment, site-reservation, transaction-fee, product)',
        'Deployed to Watertown, Clarksville, Norman, Apex. Empty Household ID guard prevents phantom mega-households',
      ] },
      { date: '2026-06-14', title: 'Platform updates', items: [
        'Dashboard title rebranded to Rec Technologies \u2014 Intelligent Reporting',
        'Feedback widget: Goes straight to Rec Partner Success (was Dan). Thumbs up/down quick vote buttons with server-side tracking (data/votes.json). Vote counts shown on admin dashboard report cards',
        'Report visibility toggles on admin dashboard \u2014 eye icon to hide/show reports on org landing page',
      ] },
      { date: '2026-06-12', title: 'Rec AI Chat — ask anything about your data', items: [
        'New: Rec AI Chat — a conversational AI assistant that can answer questions across all of an org\u2019s reports. Pulls live data from every configured Metabase report, streams responses in real time, and supports follow-up questions with full conversation context',
        'Suggested questions adapt to each org\u2019s available reports (facility schedules, GL codes, programs, products, memberships, court utilization, Fast Track)',
        'Available from the org landing page and the root dashboard; requires org token',
      ] },
      { date: '2026-06-11', title: 'Fast Track report, pinnable dashboards, and fixes', items: [
        'New report: Fast Track \u2014 pre-registration wishlist demand with true conversion tracking. FT bookings promote in-place (planned \u2192 confirmed with is_fast_track intact), enabling accurate conversion %, demand %, and fill % by program and section. Includes season and program filters, collapsible program \u2192 section drill-down, horizontal bar chart with per-segment tooltips (converted / pending / dropped), and Rec Insights AI analysis',
        'Org dashboard pages now support pinnable reports \u2014 click the \ud83d\udccc icon on any report card to keep it at the top of your list (saved per browser)',
        'Products: Net/Gross toggle now controls the entire page \u2014 table sort order, column emphasis (green for gross, blue for net), summary card order, and Best Day card all switch with the toggle',
        'AI insights button renamed from \u201CGet Insights\u201D to \u201CRec Insights\u201D across all reports (Court Utilization, Program Revenue, Fast Track)',
      ] },
      { date: '2026-06-09', title: 'Program Revenue: clearer chart + filter-aware insights', items: [
        'Chart program names now wrap to two lines instead of being cut off, so similarly-named programs are easy to tell apart',
        'Hovering a bar shows a tooltip with the full breakdown \u2014 Charged, Received, Outstanding, Waived/adj., Refunds, and Net Revenue',
        'Bars now note any "waived/adj." amount \u2014 money charged but neither collected nor still collectible (e.g. waived installments, or balances on canceled registrations) \u2014 alongside the existing amount due',
        'AI Insights now scope to the active program filter: insights clear when you change the program filter or date range, so they always describe exactly what is on the page',
      ] },
      { date: '2026-06-09', title: 'Calendar: schedule titles, availability at a glance, correct local times', items: [
        'Events now show the session / section title as the headline (the activity type moves to a secondary line), so each item is identifiable at a glance',
        'Full and Waitlist pills now appear directly on the day, week, and list views \u2014 not only in the event details',
        'New Availability filter \u2014 show only Open Availability, or only Waitlist Available, alongside the Activities and Locations filters',
        'Session-based programs now reflect Full / Waitlist correctly, using the individual session capacity rather than the section',
        'Event times now display in the local timezone of the venue',
        'Uncategorized events (such as private lessons) are hidden from the calendar and from its activity filter',
        'The selected week is part of the page link, and Present mode opens on the week and filters currently in view',
      ] },
      { date: '2026-06-08', title: 'Program Revenue: section breakout + corrected balances', items: [
        'Program Revenue now expands each program into its sections \u2014 click a program row, or use the "Breakout sections" toggle, to drill into per-section figures',
        'Received corrected: reversed or retried card charges that a successful payment already covers are no longer double-counted',
        'Outstanding now reflects the balance still collectible \u2014 unpaid, un-waived installments (or the uncollected balance for pay-in-full); waived installments and canceled registrations are excluded',
        'Reconciled to the verified Program Revenue Summary by Section report',
      ] },
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

      // ── Build heat map data ──
      const counts = {};
      let totalItems = 0;
      UPDATES.forEach(u => {
        counts[u.date] = (counts[u.date] || 0) + 1;
        totalItems += u.items.length;
      });
      const allDates = Object.keys(counts).sort();
      const firstDate = new Date(allDates[0] + 'T12:00:00');
      const today = new Date(); today.setHours(12,0,0,0);

      // Start on the Monday of the week containing firstDate
      const start = new Date(firstDate);
      const dow = start.getDay();
      start.setDate(start.getDate() - ((dow + 6) % 7));

      // End on Sunday of current week
      const end = new Date(today);
      const edow = end.getDay();
      end.setDate(end.getDate() + (edow === 0 ? 0 : 7 - edow));

      // Build weeks array
      const weeks = [];
      const cursor = new Date(start);
      let currentWeek = [];
      while (cursor <= end) {
        const iso = cursor.toISOString().slice(0, 10);
        currentWeek.push({ date: iso, count: counts[iso] || 0, future: cursor > today });
        if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = []; }
        cursor.setDate(cursor.getDate() + 1);
      }
      if (currentWeek.length) weeks.push(currentWeek);

      const maxCount = Math.max(1, ...Object.values(counts));

      // Month labels
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      let monthLabels = '';
      let lastMonth = -1;
      weeks.forEach((w, wi) => {
        const m = new Date(w[0].date + 'T12:00:00').getMonth();
        if (m !== lastMonth) {
          const span = weeks.slice(wi).filter(wk => new Date(wk[0].date + 'T12:00:00').getMonth() === m).length;
          monthLabels += '<span class="uhm-month" style="width:' + (span * 15 - 2) + 'px">' + monthNames[m] + '</span>';
          lastMonth = m;
        }
      });

      // Color function
      function hc(count, future) {
        if (future) return '#f9f8f6';
        if (count === 0) return '#f0ede8';
        var t = count / maxCount;
        if (t <= 0.25) return '#c6e48b';
        if (t <= 0.5)  return '#7bc96f';
        if (t <= 0.75) return '#239a3b';
        return '#196127';
      }

      // Stats
      const activeDays = allDates.length;
      const uniqueDates = allDates.slice().sort();
      let maxStreak = 0, streak = 0;
      for (let i = 0; i < uniqueDates.length; i++) {
        if (i === 0) { streak = 1; }
        else {
          const prev = new Date(uniqueDates[i-1] + 'T12:00:00');
          const cur  = new Date(uniqueDates[i] + 'T12:00:00');
          streak = ((cur - prev) === 86400000) ? streak + 1 : 1;
        }
        if (streak > maxStreak) maxStreak = streak;
      }

      const dayLabels = ['Mon','','Wed','','Fri','',''];
      var dayLabelHtml = dayLabels.map(function(l) { return '<div class="uhm-day-label">' + l + '</div>'; }).join('');

      var weeksHtml = weeks.map(function(w) {
        return '<div class="uhm-week">' + w.map(function(d) {
          var tip = d.future ? '' : d.date + ': ' + d.count + ' update' + (d.count !== 1 ? 's' : '');
          return '<div class="uhm-cell" style="background:' + hc(d.count, d.future) + '" title="' + tip + '"></div>';
        }).join('') + '</div>';
      }).join('');

      var legendSteps = [0, 1, Math.ceil(maxCount * 0.5), maxCount];
      var legendHtml = legendSteps.map(function(n) { return '<div class="uhm-legend-cell" style="background:' + hc(n, false) + '"></div>'; }).join('');

      var heatmapHtml = '<div class="updates-heatmap">'
        + '<div class="uhm-title">Shipping Activity</div>'
        + '<div class="uhm-months">' + monthLabels + '</div>'
        + '<div class="uhm-grid">'
        + '<div class="uhm-day-labels">' + dayLabelHtml + '</div>'
        + '<div class="uhm-weeks">' + weeksHtml + '</div>'
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:8px">'
        + '<div class="uhm-legend"><span>Less</span><div class="uhm-legend-cells">' + legendHtml + '</div><span>More</span></div>'
        + '<div class="uhm-stats">'
        + '<span><span class="uhm-stat-val">' + UPDATES.length + '</span> updates</span>'
        + '<span><span class="uhm-stat-val">' + totalItems + '</span> changes</span>'
        + '<span><span class="uhm-stat-val">' + activeDays + '</span> active days</span>'
        + '<span><span class="uhm-stat-val">' + maxStreak + '</span> day streak</span>'
        + '</div></div></div>';

      listEl.innerHTML = heatmapHtml + UPDATES.map(u => \`
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
<script>
  // ── Partner quotes ─────────────────────────────────────────────────
  function pqRender(quotes) {
    var track = document.getElementById('pq-track');
    if (!quotes.length) { track.innerHTML = ''; track.style.animation = 'none'; return; }
    // Build cards, duplicate set for seamless loop
    var cards = quotes.map(function(q, i) {
      return '<div class="pq-card">'
        + '<button class="pq-del" onclick="event.stopPropagation();pqDel(' + i + ')" title="Remove">&times;</button>'
        + '<div class="pq-text">' + q.text.replace(/</g,'&lt;') + '</div>'
        + '<div class="pq-author">&mdash; ' + q.author.replace(/</g,'&lt;') + '</div>'
        + '</div>';
    }).join('');
    track.innerHTML = cards + cards;
    // Restart animation
    track.style.animation = 'none';
    track.offsetHeight;
    track.style.animation = '';
  }
  function pqLoad() {
    fetch('/api/admin/quotes').then(function(r){return r.json();}).then(pqRender).catch(function(){});
  }
  function pqAdd() {
    var input = document.getElementById('pq-input');
    var raw = (input.value || '').trim();
    if (!raw) return;
    // Parse "quote text - Author, Org" format
    // Try splitting on last " - " pattern
    var dashIdx = raw.lastIndexOf(' - ');
    var text, author;
    if (dashIdx > 0) {
      text = raw.substring(0, dashIdx).replace(/^[\u201C\u201D"']+|[\u201C\u201D"']+$/g, '').trim();
      author = raw.substring(dashIdx + 3).trim();
    } else {
      text = raw.replace(/^[\u201C\u201D"']+|[\u201C\u201D"']+$/g, '').trim();
      author = 'Partner';
    }
    if (!text) return;
    fetch('/api/admin/quotes', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text: text, author: author })
    }).then(function() { input.value = ''; pqLoad(); }).catch(function(e) { alert('Failed: ' + e.message); });
  }
  function pqDel(idx) {
    if (!confirm('Remove this quote?')) return;
    fetch('/api/admin/quotes/' + idx, { method: 'DELETE' })
      .then(function() { pqLoad(); }).catch(function(e) { alert('Failed: ' + e.message); });
  }
  // Enter key in input
  document.addEventListener('DOMContentLoaded', function() {
    var inp = document.getElementById('pq-input');
    if (inp) inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') pqAdd(); });
    pqLoad();
  });

  // Showcase gallery — server-persisted via /api/admin/showcase
  function sgRemove(idx) {
    if (!confirm('Remove this image?')) return;
    fetch('/api/admin/showcase/' + idx, { method: 'DELETE' })
      .then(function() { window.location.reload(); })
      .catch(function(e) { alert('Remove failed: ' + e.message); });
  }

  function sgLightbox(idx) {
    var items = document.querySelectorAll('#showcase-gallery .sg-item img');
    if (!items[idx]) return;
    var imgSrc = items[idx].src;
    var parent = items[idx].parentElement;
    var capEl = parent.querySelector('.sg-caption');
    var cap = capEl ? capEl.textContent : '';
    var lb = document.createElement('div');
    lb.className = 'sg-lightbox';
    lb.onclick = function() { lb.remove(); };
    lb.innerHTML = '<img src="' + imgSrc + '" />' + (cap ? '<div class="sg-lb-caption">' + cap + '</div>' : '');
    document.body.appendChild(lb);
  }

  function handleShowcaseUpload(files) {
    Array.from(files).forEach(function(file) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var caption = prompt('Caption (e.g. "Before: Flat Metabase table"):', '');
        fetch('/api/admin/showcase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: e.target.result, caption: caption || '' })
        }).then(function() { window.location.reload(); })
          .catch(function(err) { alert('Upload failed: ' + err.message); });
      };
      reader.readAsDataURL(file);
    });
  }

  var sc = document.getElementById('showcase');
  if (sc) {
    sc.addEventListener('dragover', function(e) { e.preventDefault(); sc.style.outline = '2px dashed #a5b4fc'; });
    sc.addEventListener('dragleave', function() { sc.style.outline = ''; });
    sc.addEventListener('drop', function(e) {
      e.preventDefault(); sc.style.outline = '';
      if (e.dataTransfer.files.length) handleShowcaseUpload(e.dataTransfer.files);
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

  // Pre-warm cache after a brief delay to let startup complete
  setTimeout(prewarmCache, 3000);

  // Run initial health check on startup (after cache is warm)
  if (!loadHealthResults()) setTimeout(runHealthCheck, 60000);

  // Re-warm every 4 minutes to keep cache perpetually hot
  setInterval(prewarmCache, 60 * 60 * 1000);

  // Promote any orgs from data/orgs.json into server.js on GitHub.
  // Runs after listen() so startup isn't blocked by GitHub latency.
  migrateDynamicOrgs();
});











