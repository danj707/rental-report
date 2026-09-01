#!/usr/bin/env node
/**
 * LIVE REPORT SMOKE TEST — verify a Metabase report card actually RETURNS
 * FRESH RESULTS before signing off on a card edit.
 *
 * Why this exists (the 2026-08-06 Fast Track incident):
 *   A shared card was edited and started timing out for large orgs
 *   ("canceling statement due to statement timeout"). The app silently fell
 *   back to a warm/stale cache, so the report kept *looking* fine while every
 *   live refresh failed — and the daily health check was fooled the same way
 *   (it saw a warm cache hit and never probed Metabase). Nobody noticed for 3
 *   days. The missing step was simply confirming the card still returns fresh
 *   rows after the edit.
 *
 * This test is CACHE-INDEPENDENT: it hits the Metabase PUBLIC card endpoint
 * directly (the same URL + parameter shape server.js uses), so no app cache
 * can mask a broken card. It FAILS (exit 1) if any checked card returns an
 * error, an empty result, or times out.
 *
 * Usage:
 *   # single card
 *   node scripts/verify-report-live.js --card <uuid> --org <orgId> \
 *        [--start YYYY-MM-DD --end YYYY-MM-DD] [--timeout 60] [--min-rows 1]
 *
 *   # a batch from a manifest (recommended for sign-off — test the heaviest orgs)
 *   node scripts/verify-report-live.js --manifest scripts/report-cards.manifest.json
 *
 * Env:
 *   METABASE_URL   Metabase base URL (default https://rec.metabaseapp.com)
 */

const fs = require("fs");
const path = require("path");

const METABASE_URL = process.env.METABASE_URL || "https://rec.metabaseapp.com";

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) { a[k.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : true; }
  }
  return a;
}

// The public /query/json endpoint matches each supplied parameter to the
// card's REGISTERED parameter by its `id` — omit `id` and Metabase can't bind
// it and returns "An error occurred." So we fetch the card's public definition
// and merge our value onto its own {id,type,target,slug} entry (matched by
// slug). This keeps the test correct across any card.
const _cardParamCache = new Map();
async function fetchCardParams(card, timeout) {
  if (_cardParamCache.has(card)) return _cardParamCache.get(card);
  const resp = await fetch(`${METABASE_URL}/api/public/card/${card}`, { signal: AbortSignal.timeout(timeout * 1000) });
  if (!resp.ok) throw new Error(`card metadata fetch failed: HTTP ${resp.status}`);
  const def = await resp.json();
  const params = Array.isArray(def.parameters) ? def.parameters : [];
  _cardParamCache.set(card, params);
  return params;
}

// Attach our values to the card's registered parameters, matched by slug.
function buildParams(registered, { org, start, end }) {
  const values = { org_id: org, start_date: start, end_date: end };
  const out = [];
  for (const p of registered) {
    const v = values[p.slug];
    if (v === undefined || v === null) continue; // don't send params we have no value for
    out.push({ id: p.id, type: p.type, target: p.target, slug: p.slug, value: v });
  }
  return out;
}

/* A WINDOW, WHEN A ROW ASKS FOR ONE.
   Every check in the manifest used to run with NO date parameters at all, which
   works only while a card's date tags are OPTIONAL — `[[ ... ]]` blocks simply
   drop out. Card 17295 is the first manifest card that uses {{start_date}}
   OUTSIDE an optional block (inside the item_tx CTE), so Metabase enforces it
   and the card 400s with `missing required parameters` however healthy it is.
   That is the same failure the daily health check had against _shared/programs,
   recorded in CLAUDE.md — a permanent false alarm that no flap protection can
   silence.

   IT CANNOT BE DETECTED FROM THE CARD. The public definition reports
   `required: false` on all three of 17295's parameters; the requirement comes
   from where the tag sits in the SQL, which the definition does not describe. So
   the row declares it, with `days`.

   WHY NOT WINDOW EVERY ROW BY DEFAULT: an empty result is a FAILURE here
   (minRows), and a genuinely quiet week is not a broken card — gl/littleton
   returns 14 rows over all time and douglas-county-nv 66 permits. Windowing
   everything would make this check cry wolf on small orgs, which is how a
   sign-off tool stops being read. Opt-in per row keeps that decision explicit.

   The window ENDS TODAY and is computed at run time, never stored: a hardcoded
   date in a JSON manifest is a check that silently drifts out of the data. */
function relativeWindow(days) {
  const end = new Date();
  const start = new Date(end.getTime() - (Number(days) - 1) * 86400000);
  const ymd = d => d.toISOString().slice(0, 10);
  return { start: ymd(start), end: ymd(end) };
}

async function checkCard({ label, card, org, start, end, days, timeout = 60, minRows = 1 }) {
  // An explicit --start/--end always wins; `days` only fills a gap.
  if (days && !start && !end) ({ start, end } = relativeWindow(days));
  let registered;
  try {
    registered = await fetchCardParams(card, timeout);
  } catch (err) {
    return { label, ok: false, rows: null, ms: 0, reason: `could not read card definition (${err.message})` };
  }
  const params = buildParams(registered, { org, start, end });
  const qs = params.length ? `?parameters=${encodeURIComponent(JSON.stringify(params))}` : "";
  const url = `${METABASE_URL}/api/public/card/${card}/query/json${qs}`;
  const started = Date.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeout * 1000) });
    const ms = Date.now() - started;
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    // Success shape: a JSON array of row objects.
    if (Array.isArray(body)) {
      if (body.length >= minRows) return { label, ok: true, rows: body.length, ms };
      return { label, ok: false, rows: 0, ms, reason: `returned ${body.length} rows (min ${minRows}) — report returned NO results` };
    }
    // Anything else = failure. Metabase public cards return the string
    // "An error occurred." or an {error,...} object on failure.
    const reason = typeof body === "string"
      ? body.slice(0, 160)
      : (body && (body.error || body.error_type)) ? `${body.error_type || ""} ${body.error || ""}`.trim() : `HTTP ${resp.status}`;
    return { label, ok: false, rows: null, ms, reason: `${reason} (HTTP ${resp.status})` };
  } catch (err) {
    const ms = Date.now() - started;
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    return { label, ok: false, rows: null, ms, reason: isTimeout ? `TIMEOUT after ${timeout}s` : err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  let checks = [];

  if (args.manifest) {
    const file = path.isAbsolute(args.manifest) ? args.manifest : path.join(process.cwd(), args.manifest);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const defaults = manifest.defaults || {};
    checks = (manifest.checks || []).map((c) => ({ ...defaults, ...c }));
  } else if (args.card && args.org) {
    checks = [{
      label: args.label || `${args.card.slice(0, 8)}/${args.org.slice(0, 8)}`,
      card: args.card, org: args.org, start: args.start, end: args.end,
      days: args.days ? Number(args.days) : undefined,
      timeout: args.timeout ? Number(args.timeout) : undefined,
      minRows: args["min-rows"] ? Number(args["min-rows"]) : undefined,
    }];
  } else {
    console.error("Usage: --card <uuid> --org <orgId> [--start --end --days --timeout --min-rows]  |  --manifest <file>");
    process.exit(2);
  }

  console.log(`Live report smoke test → ${METABASE_URL}  (${checks.length} card${checks.length === 1 ? "" : "s"})\n`);

  const results = [];
  for (const c of checks) {
    process.stdout.write(`  … ${c.label} `);
    const r = await checkCard(c);
    results.push(r);
    console.log(r.ok
      ? `✓ ${r.rows} rows in ${(r.ms / 1000).toFixed(1)}s`
      : `✗ FAIL — ${r.reason} (${(r.ms / 1000).toFixed(1)}s)`);
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} passed.`);
  if (failures.length) {
    console.error(`\n${failures.length} report(s) did NOT return live results — DO NOT sign off:`);
    for (const f of failures) console.error(`  ✗ ${f.label}: ${f.reason}`);
    process.exit(1);
  }
  console.log("✓ All checked reports return live results.");
}

main().catch((e) => { console.error("verify-report-live crashed:", e); process.exit(1); });
