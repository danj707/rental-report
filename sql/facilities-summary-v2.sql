-- ============================================================================
-- FACILITIES_SUMMARY v2.2  — authoritative facility-revenue feed
-- Powers public/facilities.html. One card, all orgs. Metabase card 19570.
-- Public UUID 4c070d95-ab02-4b9d-ac43-ac86257162d5 (FACILITIES_SUMMARY_UUID).
-- Template tags: {{org_id}} (text, required), {{start_date}} + {{end_date}} (DATE).
--
-- THIS FILE IS A MIRROR OF THE LIVE CARD. It had drifted before 2026-08-23 — the
-- card carried a v2.1 speed refactor this file did not, so pushing this file
-- would have silently reverted it. Read the card before writing to it.
--
-- Fixes vs the original card:
--   1. GRAIN — per reservation (one row per reservation, representative court),
--      not DISTINCT ON (fr.id). The old card counted only each recurring
--      rental's earliest date and dropped the rest (undercounted most orgs
--      3-9x; e.g. a 30-day Watertown field rental read as $130 vs $5,970).
--   2. INVOICE revenue — unions in invoice_v2 manual line items (tournaments,
--      event rentals, deposits, service fees) that carry no reservation_id and
--      were silently dropped ($2.57M across orgs). An invoice row is MONEY, not
--      a booking and not a site — see the v2.2 notes below and aggregate() in
--      facilities.html.
--   3. BILLED vs COLLECTED — Billed = applied_pricing finalCents (real charge,
--      NOT order_item.price); Collected/Refunded from confirmed
--      order_item_transactions.
-- ============================================================================
-- Card 19570: Facilities Summary v2 — v2.2 (v2.1 speed refactor + correctness)
-- v2.2 changes (2026-08-23), both about counts, neither about speed:
-- 1. STATUS reads r.canceled_at, not just fr.status. A reservation can be
--    canceled on its own while the RENTAL stays Confirmed or In-progress (one
--    night dropped from a recurring stay). 8 such reservations in Douglas
--    County/Aug-2026 and 6 of them were reported as live bookings, putting $60
--    of canceled charges into Charged and reading the cancellation rate as
--    2 of 254 instead of 8 of 206. The client zeroes a row whose Status says
--    Canceled, so labelling them correctly is the whole fix.
-- 2. "Site ID" (ct.id) is emitted, NULL on invoice rows, so counting sites is
--    counting identities and not display names. On an invoice row "Facility" is
--    the FEE'S NAME — 5 fee names were being counted as 5 campsites.
--
-- v2.1 EXPLAIN-driven speed work, unchanged (output identical):
-- 1. inv: was seq-scanning ALL 2.6M order_items + 535k invoice_v2_order_item
--    rows because invoice_v2 was only filtered on facility_rental_id IS NOT
--    NULL. Now filtered on invoice_v2.organization_id (indexed) so the join
--    walks only this org's invoices.
-- 2. res_rev + res_pay merged into one res_fin CTE: one order_item probe per
--    reservation instead of two (EXPLAIN showed two separate x32k index-scan
--    passes, ~3.2s+4.4s of cold I/O).
WITH res AS (
  SELECT DISTINCT ON (r.id)
    r.id AS reservation_id, fr.attendee_count AS head_count,
    INITCAP(fr.booking_type) AS booking_type,
    CASE WHEN r.canceled_at IS NOT NULL THEN 'Canceled'
         ELSE INITCAP(fr.status) END AS status,
    lower(r.reservation_timestamp_range)::date AS local_date,
    l.name AS location, ct.id AS site_id, ct.court_number AS facility, ct.type AS site_type
  FROM facility_rental fr
  JOIN reservation r ON r.facility_rental_id = fr.id AND r.deleted_at IS NULL
  JOIN location l ON l.id = r.location_id
  JOIN reservation_court rc ON rc.reservation_id = r.id
  JOIN court ct ON ct.id = rc.court_id
  WHERE fr.deleted_at IS NULL AND fr.organization_id = {{org_id}}::uuid AND ct.type IS NOT NULL
    [[ AND lower(r.reservation_timestamp_range)::date >= {{start_date}} ]]
    [[ AND lower(r.reservation_timestamp_range)::date <= {{end_date}} ]]
    AND (1 = 0 [[ OR {{start_date}} IS NOT NULL ]]
         OR lower(r.reservation_timestamp_range)::date >= date_trunc('month', now()::date)::date)
    AND (1 = 0 [[ OR {{end_date}} IS NOT NULL ]]
         OR lower(r.reservation_timestamp_range)::date <= (date_trunc('month', now()::date) + interval '1 month' - interval '1 day')::date)
  ORDER BY r.id, ct.court_number
),
res_fin AS (  -- billed + collected/refunded in ONE order_item pass per reservation
  SELECT oi.reservation_id,
    SUM(COALESCE((oi.applied_pricing->'result'->>'finalCents')::numeric, 0)) / 100.0 AS billed,
    SUM(t.collected) / 100.0 AS collected,
    SUM(t.refunded)  / 100.0 AS refunded
  FROM order_item oi
  JOIN res ON res.reservation_id = oi.reservation_id
  LEFT JOIN LATERAL (
    SELECT SUM(t.amount) FILTER (WHERE t.payment_id IS NOT NULL AND t.confirmed_at IS NOT NULL) AS collected,
           SUM(t.amount) FILTER (WHERE t.refund_id  IS NOT NULL AND t.confirmed_at IS NOT NULL) AS refunded
    FROM order_item_transaction t
    WHERE t.order_item_id = oi.id
  ) t ON TRUE
  WHERE oi.deleted_at IS NULL AND oi.parent_order_item_id IS NULL
  GROUP BY oi.reservation_id
),
inv AS (
  SELECT oi.id AS order_item_id, iv.facility_rental_id AS fr_id, oi.name AS facility,
    (oi.applied_pricing->'result'->>'finalCents')::numeric / 100.0 AS billed, oi.created_at::date AS created_date
  FROM invoice_v2 iv
  JOIN invoice_v2_order_item ivoi ON ivoi.invoice_v2_id = iv.id
  JOIN order_item oi ON oi.id = ivoi.order_item_id AND oi.deleted_at IS NULL
  WHERE iv.organization_id = {{org_id}}::uuid
    AND iv.facility_rental_id IS NOT NULL AND oi.reservation_id IS NULL
    AND oi.organization_id = {{org_id}}::uuid
    AND (oi.applied_pricing->'result'->>'finalCents')::numeric > 0
),
fr_loc AS (
  SELECT DISTINCT ON (fr.id)
    fr.id AS fr_id, l.name AS location, ct.type AS site_type,
    lower(r.reservation_timestamp_range)::date AS local_date
  FROM facility_rental fr
  JOIN reservation r ON r.facility_rental_id = fr.id AND r.deleted_at IS NULL
  JOIN location l ON l.id = r.location_id
  JOIN reservation_court rc ON rc.reservation_id = r.id
  JOIN court ct ON ct.id = rc.court_id
  WHERE fr.deleted_at IS NULL AND fr.id IN (SELECT DISTINCT fr_id FROM inv)
  ORDER BY fr.id, lower(r.reservation_timestamp_range)
),
inv_pay AS (
  SELECT t.order_item_id,
    SUM(t.amount) FILTER (WHERE t.payment_id IS NOT NULL AND t.confirmed_at IS NOT NULL) / 100.0 AS collected,
    SUM(t.amount) FILTER (WHERE t.refund_id  IS NOT NULL AND t.confirmed_at IS NOT NULL) / 100.0 AS refunded
  FROM order_item_transaction t JOIN inv ON inv.order_item_id = t.order_item_id
  GROUP BY t.order_item_id
),
feed AS (
  SELECT
    res.reservation_id AS "Reservation ID", res.local_date AS "Date", res.location AS "Location",
    res.site_id::text AS "Site ID",
    res.facility AS "Facility", res.site_type AS "Site Type", res.booking_type AS "Booking Type",
    res.status AS "Status", res.head_count AS "Head Cnt", 'Reservation' AS "Source",
    CASE WHEN res.status = 'Canceled' THEN 0 ELSE COALESCE(rr.billed, 0) END AS "Total",
    COALESCE(rr.billed, 0) AS "Billed", COALESCE(rr.collected, 0) AS "Collected", COALESCE(rr.refunded, 0) AS "Refunded"
  FROM res
  LEFT JOIN res_fin rr ON rr.reservation_id = res.reservation_id
  UNION ALL
  SELECT
    inv.order_item_id, COALESCE(fl.local_date, inv.created_date), COALESCE(fl.location, '—'),
    NULL::text,   -- "Site ID": an invoice line is money, not a site. "Facility" below is the FEE'S NAME.
    inv.facility, fl.site_type, 'Managed', 'Confirmed', NULL::int, 'Invoice',
    inv.billed, inv.billed, COALESCE(ip.collected, 0), COALESCE(ip.refunded, 0)
  FROM inv
  LEFT JOIN fr_loc fl ON fl.fr_id = inv.fr_id
  LEFT JOIN inv_pay ip ON ip.order_item_id = inv.order_item_id
)
SELECT *
FROM feed
WHERE 1 = 1
  [[ AND "Date" >= {{start_date}} ]]
  [[ AND "Date" <= {{end_date}} ]]
  AND (1 = 0 [[ OR {{start_date}} IS NOT NULL ]]
       OR "Date" >= date_trunc('month', now()::date)::date)
  AND (1 = 0 [[ OR {{end_date}} IS NOT NULL ]]
       OR "Date" <= (date_trunc('month', now()::date) + interval '1 month' - interval '1 day')::date)
ORDER BY "Date", "Location", "Facility"
