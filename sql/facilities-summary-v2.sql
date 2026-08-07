-- ============================================================================
-- FACILITIES_SUMMARY v2  — authoritative facility-revenue feed (OPTIMIZED)
-- Powers public/facilities.html. One card, all orgs. Metabase card 19570.
-- Template tags: {{org_id}} (text, required), {{start_date}} + {{end_date}} (DATE).
--
-- Fixes vs the original card, and the perf work that let it ship:
--   1. GRAIN — per reservation (one row per reservation, representative court),
--      not DISTINCT ON (fr.id). The old card counted only each recurring
--      rental's earliest date and dropped the rest (undercounted most orgs
--      3-9x; e.g. a 30-day Watertown field rental read as $130 vs $5,970).
--   2. INVOICE revenue — unions in invoice_v2 manual line items (tournaments,
--      event rentals, deposits, service fees) that carry no reservation_id and
--      were silently dropped ($2.57M across orgs).
--   3. BILLED vs COLLECTED — Billed = applied_pricing finalCents (real charge,
--      NOT order_item.price); Collected/Refunded from confirmed
--      order_item_transactions.
--
-- PERFORMANCE (this is why v1 of the rebuild 502'd under the prewarm storm):
--   - the date window is pushed INTO the reservation scan (`res`), so we never
--     materialize the org's whole history before filtering;
--   - payments/refunds are computed ONLY for the order-items the feed emits
--     (res_pay joins `res`; inv_pay joins `inv`) instead of aggregating the
--     org's entire order_item_transaction ledger.
--   Result: Watertown full-year 54s -> 6s; Apex YTD 54s -> ~37s. Identical rows.
-- ============================================================================
WITH res AS (                         -- one row per in-window reservation, representative court
  SELECT DISTINCT ON (r.id)
    r.id                                        AS reservation_id,
    fr.attendee_count                           AS head_count,
    INITCAP(fr.booking_type)                    AS booking_type,   -- Instant / Managed
    INITCAP(fr.status)                          AS status,         -- Confirmed / In-progress / Canceled
    lower(r.reservation_timestamp_range)::date  AS local_date,
    l.name                                      AS location,
    ct.court_number                             AS facility,
    ct.type                                     AS site_type
  FROM facility_rental fr
  JOIN reservation r        ON r.facility_rental_id = fr.id AND r.deleted_at IS NULL
  JOIN location l           ON l.id = r.location_id
  JOIN reservation_court rc ON rc.reservation_id = r.id
  JOIN court ct             ON ct.id = rc.court_id
  WHERE fr.deleted_at IS NULL
    AND fr.organization_id = {{org_id}}::uuid
    AND ct.type IS NOT NULL
    -- date window pushed down onto the reservation date (the perf fix)
    [[ AND lower(r.reservation_timestamp_range)::date >= {{start_date}} ]]
    [[ AND lower(r.reservation_timestamp_range)::date <= {{end_date}} ]]
    AND (1 = 0 [[ OR {{start_date}} IS NOT NULL ]]
         OR lower(r.reservation_timestamp_range)::date >= date_trunc('month', now()::date)::date)
    AND (1 = 0 [[ OR {{end_date}} IS NOT NULL ]]
         OR lower(r.reservation_timestamp_range)::date <= (date_trunc('month', now()::date) + interval '1 month' - interval '1 day')::date)
  ORDER BY r.id, ct.court_number
),
res_rev AS (                          -- base rental billed per in-window reservation (add-ons excluded)
  SELECT oi.reservation_id,
    SUM(COALESCE((oi.applied_pricing->'result'->>'finalCents')::numeric, 0)) / 100.0 AS billed
  FROM order_item oi
  JOIN res ON res.reservation_id = oi.reservation_id
  WHERE oi.deleted_at IS NULL AND oi.parent_order_item_id IS NULL
  GROUP BY oi.reservation_id
),
res_pay AS (                          -- confirmed collected/refunded, only for in-window reservation items
  SELECT oi.reservation_id,
    SUM(t.amount) FILTER (WHERE t.payment_id IS NOT NULL AND t.confirmed_at IS NOT NULL) / 100.0 AS collected,
    SUM(t.amount) FILTER (WHERE t.refund_id  IS NOT NULL AND t.confirmed_at IS NOT NULL) / 100.0 AS refunded
  FROM order_item oi
  JOIN res ON res.reservation_id = oi.reservation_id
  JOIN order_item_transaction t ON t.order_item_id = oi.id
  WHERE oi.deleted_at IS NULL AND oi.parent_order_item_id IS NULL
  GROUP BY oi.reservation_id
),
inv AS (                              -- invoice_v2 manual line items (no reservation) for this org
  SELECT oi.id AS order_item_id, iv.facility_rental_id AS fr_id, oi.name AS facility,
    (oi.applied_pricing->'result'->>'finalCents')::numeric / 100.0 AS billed,
    oi.created_at::date AS created_date
  FROM invoice_v2 iv
  JOIN invoice_v2_order_item ivoi ON ivoi.invoice_v2_id = iv.id
  JOIN order_item oi              ON oi.id = ivoi.order_item_id AND oi.deleted_at IS NULL
  WHERE iv.facility_rental_id IS NOT NULL
    AND oi.reservation_id IS NULL
    AND oi.organization_id = {{org_id}}::uuid
    AND (oi.applied_pricing->'result'->>'finalCents')::numeric > 0
),
fr_loc AS (                           -- representative location/date for the (few) rentals with invoice lines
  SELECT DISTINCT ON (fr.id)
    fr.id AS fr_id, l.name AS location, ct.type AS site_type,
    lower(r.reservation_timestamp_range)::date AS local_date
  FROM facility_rental fr
  JOIN reservation r        ON r.facility_rental_id = fr.id AND r.deleted_at IS NULL
  JOIN location l           ON l.id = r.location_id
  JOIN reservation_court rc ON rc.reservation_id = r.id
  JOIN court ct             ON ct.id = rc.court_id
  WHERE fr.deleted_at IS NULL
    AND fr.id IN (SELECT DISTINCT fr_id FROM inv)
  ORDER BY fr.id, lower(r.reservation_timestamp_range)
),
inv_pay AS (                          -- confirmed collected/refunded, only for invoice items
  SELECT t.order_item_id,
    SUM(t.amount) FILTER (WHERE t.payment_id IS NOT NULL AND t.confirmed_at IS NOT NULL) / 100.0 AS collected,
    SUM(t.amount) FILTER (WHERE t.refund_id  IS NOT NULL AND t.confirmed_at IS NOT NULL) / 100.0 AS refunded
  FROM order_item_transaction t
  JOIN inv ON inv.order_item_id = t.order_item_id
  GROUP BY t.order_item_id
),
feed AS (
  -- Part A — reservation bookings, per-reservation grain
  SELECT
    res.reservation_id                                     AS "Reservation ID",
    res.local_date                                         AS "Date",
    res.location                                           AS "Location",
    res.facility                                           AS "Facility",
    res.site_type                                          AS "Site Type",
    res.booking_type                                       AS "Booking Type",
    res.status                                             AS "Status",
    res.head_count                                         AS "Head Cnt",
    'Reservation'                                          AS "Source",
    CASE WHEN res.status = 'Canceled' THEN 0 ELSE COALESCE(rr.billed, 0) END AS "Total",
    COALESCE(rr.billed, 0)                                 AS "Billed",
    COALESCE(rp.collected, 0)                              AS "Collected",
    COALESCE(rp.refunded, 0)                               AS "Refunded"
  FROM res
  LEFT JOIN res_rev rr ON rr.reservation_id = res.reservation_id
  LEFT JOIN res_pay rp ON rp.reservation_id = res.reservation_id

  UNION ALL

  -- Part B — invoice_v2 manual line items, attributed to the rental's location
  SELECT
    inv.order_item_id                                      AS "Reservation ID",
    COALESCE(fl.local_date, inv.created_date)              AS "Date",
    COALESCE(fl.location, '—')                             AS "Location",
    inv.facility                                           AS "Facility",
    fl.site_type                                           AS "Site Type",
    'Managed'                                              AS "Booking Type",
    'Confirmed'                                            AS "Status",
    NULL::int                                              AS "Head Cnt",
    'Invoice'                                              AS "Source",
    inv.billed                                             AS "Total",
    inv.billed                                             AS "Billed",
    COALESCE(ip.collected, 0)                              AS "Collected",
    COALESCE(ip.refunded, 0)                               AS "Refunded"
  FROM inv
  LEFT JOIN fr_loc fl   ON fl.fr_id = inv.fr_id
  LEFT JOIN inv_pay ip  ON ip.order_item_id = inv.order_item_id
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
