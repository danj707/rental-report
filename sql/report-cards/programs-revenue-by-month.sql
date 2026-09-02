-- ============================================================================
-- Programs Revenue by Month — v1 — 2026-09-01
--
-- Mirror of the Metabase card. THE LIVE CARD IS THE SOURCE OF TRUTH: read it
-- before writing to it, then mirror the result back here. This file drifting is
-- how pushing a repo copy nearly deleted the facility card's whole Paid? feature.
--
-- WHY THIS CARD EXISTS AT ALL. Card 17295 (the Programs report) returns ONE
-- period figure for the whole selected window — `period_succeeded_cents` — not a
-- series, and it is section-grain so it has nowhere to put a series. The
-- Programs Summary "by month" panel needs twelve numbers, so it needs its own
-- month-grain source. Deliberately a SEPARATE card rather than columns on 17295:
-- 17295 already runs 104s at apex and is parked on performance, and a new card
-- cannot regress the report every org opens.
--
-- ── WHY item_log_report AND NOT THE BASE TABLES ────────────────────────────
-- Measured 2026-09-01, and the base-table version is simply not shippable:
--
--   base tables (payment → order_item_transaction → order_item → booking,
--   filtered to program bookings)      apex, ONE month  → TIMEOUT past 60s
--   materialized.item_log_report       apex, ALL time   → 21.4s
--                                      el-segundo       →  1.7s
--
-- That inverts the usual advice in CLAUDE.md — which recommends base tables for
-- the Tyler export because they carry the index this schema lacks — and the
-- reason is the join, not the scan. The Tyler export needs ONE org-month of rows
-- and can ride `order_item_transaction (organization_id, confirmed_at)`. This
-- card needs a whole year aggregated, and reaching `booking` to decide whether a
-- transaction is programme revenue means joining four tables before it can
-- group. The item log has already done that join.
--
-- Note this card's read is a full seq scan of a 1230 MB table with exactly one
-- index (its primary key) — see "The `materialized` schema has no secondary
-- indexes" in CLAUDE.md. 21s is survivable behind the app's 4-hour feed cache
-- and would not be survivable per-request.
--
-- ── THE PROGRAM FILTER IS `order_item_type = 'reservation-enrollment'` ──────
-- The five values present at apex, and what each is:
--
--   reservation-enrollment   202,910   programme registrations  ← this card
--   product                  148,315   memberships, passes, merchandise
--   site-reservation           5,491   facility rentals
--   event-ticket                 164
--   deposit                       69
--
-- VERIFIED AGAINST THE OTHER PATH RATHER THAN ASSUMED. El Segundo Recreation,
-- monthly, this card's figures against an independent query over
-- payment → order_item_transaction → order_item → booking scoped to bookings
-- carrying a section:
--
--   month     this card    base tables
--   2026-06        $149           $149   ✓
--   2026-07      $5,967         $5,967   ✓
--   2026-08     $77,813        $77,813   ✓
--   2026-09      $4,173         $3,959   ← the OPEN month, read 40 min apart
--
-- Three closed months identical to the dollar. The September gap is the
-- open-window trap from the Clarksville backcheck — never diff an open window
-- against itself across two reads — not a discrepancy in the filter.
--
-- ── TIMEZONE: THERE IS NOTHING TO CONVERT, AND THAT IS A FEATURE ───────────
-- `datetime_at_primary_timezone` is ALREADY localized to the org, so this card
-- casts it bare and never writes AT TIME ZONE. Metabase renders timestamptz in
-- America/Los_Angeles whatever the org's own zone is (see the PACIFIC section in
-- CLAUDE.md — it made Smyrna's 5pm concert print as 2pm), and a monthly rollup
-- is exactly where that lands a boundary payment in the wrong month. Using the
-- pre-localized column removes the whole class of bug.
--
-- ── THE BASIS IS THE TRANSACTION, NOT payment.created_at ───────────────────
-- The item log stamps its datetime from the transaction's confirmation, while
-- card 17295's own "Period Received" comes off `payment.created_at`. Measured
-- platform-wide over the last 12 months: 2,008,894 transactions, of which
-- **33 across 8 orgs** fall in a different MONTH under the two bases (max gap
-- 98 days). 0.0016%, and the El Segundo tie-out above shows they agree where it
-- matters — but it is a real difference, so this panel is labelled as collection
-- activity and is never presented as reconciling to Period Received.
--
-- ── EVERY MONTH IN THE WINDOW GETS A ROW ───────────────────────────────────
-- generate_series, so a month with no money comes back as 0 rather than being
-- absent. The page must not have to do date arithmetic to build an axis:
-- `new Date("2026-08-01")` is UTC midnight and renders as July 31 across the US,
-- which is the bug already recorded for fasttrack dates, checkins and the ePACT
-- export. `Month` is emitted as a bare 'YYYY-MM' STRING for the same reason —
-- there is nothing for the page to parse.
--
-- A zero from this card means "no money moved". It does NOT mean "this month has
-- not happened yet" — the page decides that from its own clock and marks those
-- months differently, because a future month rendered flat next to a real zero
-- reads as a collapse in demand.
--
-- Template tags: org_id (string/=), start_date, end_date (date/single).
-- The bounds are CAST explicitly so the SQL holds under either tag type — an API
-- push regenerates every tag as Text, and `{{end_date}} + INTERVAL` only parses
-- while the tag is a Date. See the check-in cards for the failure this avoids.
-- It does NOT remove the need for the UI flip: a pushed card registers six
-- parameters until a human re-saves it.
-- ============================================================================
WITH cfg AS (
  SELECT o.id AS org_id
  FROM organization o
  WHERE o.id = {{org_id}}::uuid
),
months AS (
  SELECT generate_series(
           date_trunc('month', {{start_date}}::date),
           date_trunc('month', {{end_date}}::date),
           INTERVAL '1 month'
         )::date AS mo
),
tx AS (
  SELECT date_trunc('month', ilr.datetime_at_primary_timezone)::date AS mo,
         SUM(CASE WHEN ilr.transaction_type = 'payment'
                  THEN ilr.order_item_transaction_amount ELSE 0 END) AS collected_cents,
         SUM(CASE WHEN ilr.transaction_type = 'refund'
                  THEN ilr.order_item_transaction_amount ELSE 0 END) AS refund_cents
  FROM cfg
  JOIN materialized.item_log_report ilr
    ON ilr.organization_id = cfg.org_id
  WHERE ilr.order_item_type = 'reservation-enrollment'
    AND ilr.order_item_transaction_amount <> 0
    -- Already localized, so cast bare — never AT TIME ZONE. The ::date on the
    -- bound is a no-op for a Date tag and the real conversion for a Text one.
    AND ilr.datetime_at_primary_timezone::date >= date_trunc('month', {{start_date}}::date)::date
    AND ilr.datetime_at_primary_timezone::date <= {{end_date}}::date
  GROUP BY 1
)
SELECT
  to_char(m.mo, 'YYYY-MM')                                    AS "Month",
  ROUND(COALESCE(t.collected_cents, 0) / 100.0, 2)            AS "Collected",
  ROUND(COALESCE(t.refund_cents, 0)    / 100.0, 2)            AS "Refunds",
  ROUND((COALESCE(t.collected_cents, 0)
       - COALESCE(t.refund_cents, 0))  / 100.0, 2)            AS "Net"
FROM months m
LEFT JOIN tx t ON t.mo = m.mo
ORDER BY 1
