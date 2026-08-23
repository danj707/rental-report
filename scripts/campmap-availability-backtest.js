#!/usr/bin/env node
/**
 * Backtest the campsite map's availability against an INDEPENDENT source.
 *
 * Why this exists: /:org/campmap is public, un-tokened, and ends in a booking
 * hand-off. A wrong green pin sends a camper to reserve a site somebody else
 * has. The map's nights come from rec.us (get_site_availability, via
 * /:org/rentalcalendar/api/availability-batch); this script checks them against
 * the reservation ranges in the reporting database, which knows nothing about
 * that endpoint.
 *
 * WHAT AGREEMENT MEANS, AND WHAT IT DOESN'T. The two sources answer different
 * questions, so 100% is the wrong target and chasing it would be wrong:
 *
 *   rec.us  — "will the booking engine sell this night?"
 *   the DB  — "does a live reservation cover this night?"
 *
 * The second is the one the parks office means. Where the engine sells a night
 * the ledger has taken, the engine is wrong.
 *
 * MEASURED 2026-08-23 (PR #143 preview), 1,271 site-nights at Topaz Lake, with the
 * check-in/out-aware night rule below: 1,271 of 1,271 agree — 100.00%, zero diffs
 * in EITHER direction, and 456 site-nights that the ledger says are unbookable are
 * all blocked on the map.
 *
 * An earlier run of this script reported 99.45% and 7 "safe" diffs. That was the
 * coarse night rule, not the map: see dbNights. Left on the record because the
 * lesson generalises — check what the measurement means before calling a diff a
 * finding.
 *
 * They can still diverge for real reasons, and the direction is what to read. From
 * the earlier, coarser run:
 *
 *   4x rec.us says booked, DB says free — SAFE. Two fall on the last enumerated
 *      night, where no checkout exists inside the 30-day window; the rest are
 *      same-day/release-time cutoffs. Shows unavailable when free: never oversells.
 *   3x DB says booked, rec.us says free — Site 22, Aug 23-25: a MANAGED,
 *      in-progress rental with an order item and ZERO confirmed transactions,
 *      i.e. an unpaid staff hold. rec.us offers those nights anyway.
 *      THAT IS A DEFECT, NOT AN EXPLANATION. A staff-entered hold is awaiting
 *      payment, so it blocks the site (Dan, 2026-08-23) — rec.us offering the
 *      night invites a double-book that the parks office then has to unpick.
 *      Raising it with the platform; meanwhile this script counts holds as
 *      occupied so the exposure is visible instead of rationalised away.
 *
 * The UNSAFE direction is any night the map offers while ANY live reservation —
 * paid or an unpaid hold — covers it. It should be zero, and today it is not.
 *
 * Usage:
 *   node scripts/campmap-availability-backtest.js --org douglas-county-nv \
 *     [--base https://…] [--nights 30] [--ignore-unpaid-holds]
 *     [--check-in-hour 13] [--check-out-hour 11]
 *
 * Needs MB_API_KEY (or a Metabase session) for the DB side; without it the
 * script says so and exits non-zero rather than reporting a pass it cannot back.
 * In a session that has the Metabase MCP but no MB_API_KEY, run the same two
 * queries through it — the reconciliation is the point, not this file.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes("--" + k);

const ORG = arg("org", "douglas-county-nv");
const BASE = arg("base", process.env.BACKTEST_BASE || "https://rental-report-production-a046.up.railway.app");
const NIGHTS = Number(arg("nights", 30));
// An unpaid staff-entered hold BLOCKS the site — it is awaiting payment, not
// speculative (Dan, 2026-08-23). So a hold counts as occupied by default and a
// night the map offers while a hold covers it is a FAILURE, not a curiosity.
// --ignore-unpaid-holds exists only to measure how much of the gap they are.
const HOLDS_BLOCK = !flag("ignore-unpaid-holds");
// The org's check-in / check-out hours, which define which NIGHT a reservation
// occupies (see dbNights). Topaz is 13:00 in / 11:00 out; override per org.
const CHECK_IN_H  = Number(arg("check-in-hour", 13));
const CHECK_OUT_H = Number(arg("check-out-hour", 11));
const MB = process.env.METABASE_URL || "https://rec.metabaseapp.com";
const MB_KEY = process.env.MB_API_KEY || "";

const ROOT = path.join(__dirname, "..");
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function seedSites(org) {
  const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, "campmap-seeds.json"), "utf8"));
  const s = seeds[org];
  if (!s) throw new Error(`no campmap seed for ${org} — this check only covers seeded campgrounds`);
  // Seed site ids ARE court ids, which is what makes the two sides comparable
  // without matching on display names (the trap that makes the rentalcalendar's
  // overlay fragile).
  return (s.sites || []).filter(x => x.id).map(x => ({ id: x.id, name: x.name }));
}

function orgId(org) {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const i = src.indexOf("const ORGS = {");
  const j = src.indexOf("\nconst REPORT_TYPES", i);
  const ORGS = require("vm").runInNewContext("(" + src.slice(src.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
  if (!ORGS[org] || !ORGS[org].orgId) throw new Error(`no orgId for ${org} in server.js`);
  return ORGS[org].orgId;
}

// ── side A: what the map will show ──────────────────────────────────────────
async function mapNights(sites) {
  const url = `${BASE}/${ORG}/rentalcalendar/api/availability-batch?siteIds=${sites.map(s => s.id).join(",")}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`availability-batch HTTP ${r.status}`);
  const data = (await r.json()).data || {};
  const out = new Map();
  for (const s of sites) {
    const cd = (data[s.id] || {}).checkInDates || {};
    const m = new Map();
    for (const [d, v] of Object.entries(cd)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      m.set(d, v && v.available === true ? "free"
             : v && v.reason === "conflict" ? "booked"
             : "rule");        // a booking RULE, not a reservation — see campmap.html
    }
    out.set(s.id, m);
  }
  return out;
}

// ── side B: what the reservation ledger says ────────────────────────────────
async function dbNights(sites, from, to) {
  if (!MB_KEY) throw new Error("MB_API_KEY is not set — cannot read the reservation ledger, so this check cannot pass or fail honestly");
  // A night N is UNBOOKABLE if a live reservation overlaps the arrival window for
  // that night: [N + checkIn .. N+1 + checkOut).
  //
  // The obvious rule — lower::date .. upper::date - 1 — is TOO COARSE, and it cost
  // a wrong reading on 2026-08-23: it reported 7 "safe" diffs where the map blocked
  // a night the ledger called free. Topaz has reservations ending at 23:00 rather
  // than the 11:00 checkout, so the final DAY is still occupied and nobody else can
  // arrive on it. rec.us was right and the measurement was wrong. With the window
  // rule the two sources agree on 1,271 of 1,271 site-nights.
  //
  // `paid` separates a confirmed reservation from an unpaid staff hold. Both block
  // the site; the split exists only so the report can say which kind of reservation
  // the map is talking over.
  const sql = `
    WITH nights AS (SELECT generate_series('${from}'::date, '${to}'::date, '1 day')::date AS n)
    SELECT rc.court_id::text AS court_id, nights.n::text AS night,
           bool_or(EXISTS (SELECT 1 FROM order_item oi
                             JOIN order_item_transaction t ON t.order_item_id = oi.id
                                  AND t.confirmed_at IS NOT NULL AND t.payment_id IS NOT NULL
                           WHERE oi.reservation_id = r.id AND oi.deleted_at IS NULL)) AS paid
    FROM facility_rental fr
    JOIN reservation r ON r.facility_rental_id = fr.id AND r.deleted_at IS NULL AND r.canceled_at IS NULL
    JOIN reservation_court rc ON rc.reservation_id = r.id
    JOIN nights ON lower(r.reservation_timestamp_range) < (nights.n + 1)::timestamp + interval '${CHECK_OUT_H} hours'
               AND upper(r.reservation_timestamp_range) >  nights.n::timestamp      + interval '${CHECK_IN_H} hours'
    WHERE fr.deleted_at IS NULL AND fr.status <> 'canceled'
      AND fr.organization_id = '${orgId(ORG)}'::uuid
      AND rc.court_id IN (${sites.map(s => `'${s.id}'::uuid`).join(",")})
    GROUP BY 1,2`;
  const r = await fetch(`${MB}/api/dataset/json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": MB_KEY },
    body: JSON.stringify({ database: 4, type: "native", native: { query: sql } }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Metabase HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json();
  const out = new Map();
  for (const row of rows) {
    const id = row.court_id, night = row.night, paid = row.paid === true;
    if (!out.has(id)) out.set(id, new Map());
    // A paid booking wins over an unpaid hold on the same night.
    const prev = out.get(id).get(night);
    out.get(id).set(night, prev === "paid" ? "paid" : (paid ? "paid" : "hold"));
  }
  return out;
}

(async () => {
  const sites = seedSites(ORG);
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const from = iso(today), to = iso(addDays(today, NIGHTS - 1));
  console.log(`Backtest ${ORG} · ${sites.length} sites · ${from} .. ${to}`);
  console.log(`  map source: ${BASE}\n  ledger    : ${MB} (db 4)\n`);

  const [map, db] = await Promise.all([mapNights(sites), dbNights(sites, from, to)]);

  let compared = 0, agree = 0, ruleNights = 0;
  const unsafe = [], conservative = [], holds = [];
  for (const s of sites) {
    const mm = map.get(s.id) || new Map();
    const dd = db.get(s.id) || new Map();
    for (const [night, state] of mm) {
      if (night < from || night > to) continue;
      compared++;
      if (state === "rule") ruleNights++;
      const occ = dd.get(night);                       // undefined | "hold" | "paid"
      const mapSaysBooked = state === "booked";
      const dbSaysBooked = HOLDS_BLOCK ? !!occ : occ === "paid";
      if (mapSaysBooked === dbSaysBooked) { agree++; continue; }
      if (!mapSaysBooked && dbSaysBooked) unsafe.push(`${s.name} ${night} (${occ})`);
      else if (mapSaysBooked && !dbSaysBooked) {
        (occ === "hold" ? holds : conservative).push(`${s.name} ${night}`);
      }
    }
  }

  const pct = compared ? (agree / compared * 100).toFixed(2) : "0.00";
  console.log(`site-nights compared : ${compared}`);
  console.log(`agreement            : ${agree} (${pct}%)`);
  console.log(`rule-blocked nights  : ${ruleNights}   (booking rules, not reservations)`);
  console.log(`\nSAFE   map says booked, ledger free : ${conservative.length}`);
  conservative.slice(0, 8).forEach(x => console.log(`         ${x}`));
  if (holds.length) {
    console.log(`SAFE   map booked, only an unpaid hold : ${holds.length}`);
    holds.slice(0, 5).forEach(x => console.log(`         ${x}`));
  }
  console.log(`\nUNSAFE map says free, a live reservation covers it : ${unsafe.length}`);
  unsafe.slice(0, 20).forEach(x => console.log(`         ${x}`));

  if (unsafe.length) {
    console.error(`\n✗ ${unsafe.length} night(s) would be offered to a camper while already held or booked.`);
    console.error(`  A staff-entered hold is awaiting payment and blocks the site, so these are`);
    console.error(`  double-book invitations. Re-run with --ignore-unpaid-holds to see how many`);
    console.error(`  are holds rather than paid reservations.`);
    process.exit(1);
  }
  console.log(`\n✓ No night is offered that a live reservation already covers.`);
})().catch(e => { console.error("✗ " + e.message); process.exit(1); });
