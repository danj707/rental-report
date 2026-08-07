-- ============================================================================
-- FACILITIES_SUMMARY v2  — authoritative facility-revenue feed
-- Powers public/facilities.html (the "Facilities" hub report), one card, all orgs.
-- Template tags: {{org_id}} (text, required), {{start_date}} + {{end_date}} (DATE).
--
-- Fixes two problems in the previous card and adds the billed/collected split:
--
--   1. GRAIN. The old feed used DISTINCT ON (fr.id) — it collapsed each booking
--      to its earliest reservation, dropping every recurring date's revenue and
--      mis-attributing court/location/date. This is per-reservation grain: one
--      row per reservation (representative court), revenue attributed per date.
--
--   2. INVOICE REVENUE. The old feed only saw order_items joined by
--      reservation_id, so it silently dropped every manual invoice_v2 line item
--      (tournament flat fees, event rentals, deposits, janitorial/security/timing
--      fees) — $2.57M across 74 orgs. Part B unions those back in, attributed to
--      their facility_rental's location.
--
--   3. BILLED vs COLLECTED. "Billed" = applied_pricing finalCents (the real
--      charge — NOT order_item.price, which is the rate card and is inflated by
--      comped-to-$0 bookings). "Collected"/"Refunded" come from
--      order_item_transaction, gated on confirmed_at IS NOT NULL. Validated at
--      Apex: instant bookings read 100% collected (billed == collected exactly);
--      managed premium facilities read ~36% (the rest invoiced / settled offline).
--
-- "Total" is kept = billed-when-not-canceled for backward compatibility with the
-- report's existing revenue column; Billed/Collected/Refunded/Source are additive.
-- ============================================================================
WITH oit AS (                         -- confirmed payments / refunds per order_item (org-scoped for speed)
  SELECT t.order_item_id,
    SUM(t.amount) FILTER (WHERE t.payment_id IS NOT NULL AND t.confirmed_at IS NOT NULL) AS collected,
    SUM(t.amount) FILTER (WHERE t.refund_id  IS NOT NULL AND t.confirmed_at IS NOT NULL) AS refunded
  FROM order_item_transaction t
  JOIN order_item oi2 ON oi2.id = t.order_item_id AND oi2.organization_id = {{org_id}}::uuid
  GROUP BY t.order_item_id
),
res AS (                              -- one row per reservation, representative court
  SELECT DISTINCT ON (r.id)
    r.id                                        AS reservation_id,
    fr.attendee_count                           AS head_count,
    INITCAP(fr.booking_type)                    AS booking_type,     -- Instant / Managed
    INITCAP(fr.status)                          AS status,           -- Confirmed / In-progress / Canceled
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
  ORDER BY r.id, ct.court_number
),
res_rev AS (                          -- base rental revenue per reservation (add-ons excluded)
  SELECT oi.reservation_id,
    SUM(COALESCE((oi.applied_pricing->'result'->>'finalCents')::numeric, 0)) / 100.0 AS billed,
    SUM(COALESCE(t.collected, 0)) / 100.0 AS collected,
    SUM(COALESCE(t.refunded, 0))  / 100.0 AS refunded
  FROM order_item oi
  LEFT JOIN oit t ON t.order_item_id = oi.id
  WHERE oi.deleted_at IS NULL
    AND oi.reservation_id IS NOT NULL
    AND oi.parent_order_item_id IS NULL
    AND oi.organization_id = {{org_id}}::uuid
  GROUP BY oi.reservation_id
),
fr_loc AS (                           -- representative location/date per rental, for attributing manual invoice lines
  SELECT DISTINCT ON (fr.id)
    fr.id                                       AS fr_id,
    l.name                                      AS location,
    ct.type                                     AS site_type,
    lower(r.reservation_timestamp_range)::date  AS local_date
  FROM facility_rental fr
  JOIN reservation r        ON r.facility_rental_id = fr.id AND r.deleted_at IS NULL
  JOIN location l           ON l.id = r.location_id
  JOIN reservation_court rc ON rc.reservation_id = r.id
  JOIN court ct             ON ct.id = rc.court_id
  WHERE fr.deleted_at IS NULL
    AND fr.organization_id = {{org_id}}::uuid
  ORDER BY fr.id, lower(r.reservation_timestamp_range)
),
feed AS (
  -- Part A — reservation bookings (instant + managed), per-reservation grain
  SELECT
    res.reservation_id                                    AS "Reservation ID",
    res.local_date                                        AS "Date",
    res.location                                          AS "Location",
    res.facility                                          AS "Facility",
    res.site_type                                         AS "Site Type",
    res.booking_type                                      AS "Booking Type",
    res.status                                            AS "Status",
    res.head_count                                        AS "Head Cnt",
    'Reservation'                                         AS "Source",
    CASE WHEN res.status = 'Canceled' THEN 0 ELSE COALESCE(rr.billed, 0) END AS "Total",
    COALESCE(rr.billed, 0)                                AS "Billed",
    COALESCE(rr.collected, 0)                             AS "Collected",
    COALESCE(rr.refunded, 0)                              AS "Refunded"
  FROM res
  LEFT JOIN res_rev rr ON rr.reservation_id = res.reservation_id

  UNION ALL

  -- Part B — manual invoice_v2 line items with no reservation (tournaments, event
  -- rentals, deposits, service fees), attributed to the rental's location.
  SELECT
    oi.id                                                 AS "Reservation ID",
    COALESCE(fl.local_date, oi.created_at::date)          AS "Date",
    COALESCE(fl.location, '—')                            AS "Location",
    oi.name                                               AS "Facility",
    fl.site_type                                          AS "Site Type",
    'Managed'                                             AS "Booking Type",
    'Confirmed'                                           AS "Status",
    NULL::int                                             AS "Head Cnt",
    'Invoice'                                             AS "Source",
    (oi.applied_pricing->'result'->>'finalCents')::numeric / 100.0 AS "Total",
    (oi.applied_pricing->'result'->>'finalCents')::numeric / 100.0 AS "Billed",
    COALESCE(t.collected, 0) / 100.0                      AS "Collected",
    COALESCE(t.refunded, 0)  / 100.0                      AS "Refunded"
  FROM invoice_v2 iv
  JOIN invoice_v2_order_item ivoi ON ivoi.invoice_v2_id = iv.id
  JOIN order_item oi              ON oi.id = ivoi.order_item_id AND oi.deleted_at IS NULL
  LEFT JOIN fr_loc fl             ON fl.fr_id = iv.facility_rental_id
  LEFT JOIN oit t                 ON t.order_item_id = oi.id
  WHERE iv.facility_rental_id IS NOT NULL
    AND oi.reservation_id IS NULL
    AND oi.organization_id = {{org_id}}::uuid
    AND (oi.applied_pricing->'result'->>'finalCents')::numeric > 0
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
