-- Card 18844: ✅Facility Rental Data — v-next SPEED REFACTOR
-- Changes (output identical):
-- 1. End-bound pushdown into the booking CTE's reservation join. Dropping
--    reservations that start after the window end can never change which
--    reservation is a rental's EARLIEST (min <= any member), and rentals whose
--    earliest is after the window end were discarded by the final WHERE anyway.
--    (The start bound is NOT pushed down — that could promote a later
--    reservation to "earliest" and wrongly include a rental.)
-- 2. rev was an org-wide aggregate over every order_item with a reservation_id;
--    now a LATERAL per surviving rental using the (reservation_id) partial index.
/* Facility Summary feed — one row per facility rental (booking).
   Reuses ✅ Facility Rental Report (17294): revenue = base order_item finalCents/100,
   site_type from court, booking_type instant/managed. Adds Status and INCLUDES
   canceled bookings (canceled = $0 revenue) so the hub can show cancellation rate
   + per-status filters. Org-scoped; date window defaults to current month, matching
   the platform's other reports. */
WITH booking AS (                         -- one primary (earliest) reservation per rental, with its court/site
  SELECT DISTINCT ON (fr.id)
    fr.id                                        AS reservation_id,
    INITCAP(fr.booking_type)                     AS booking_type,   -- Instant / Managed
    INITCAP(fr.status)                           AS status,         -- Confirmed / In-progress / Canceled
    fr.attendee_count                            AS head_count,
    r.id                                         AS res_id,
    lower(r.reservation_timestamp_range)::date   AS local_date,
    l.name                                       AS location,
    ct.court_number                              AS facility,
    ct.type                                      AS site_type
  FROM facility_rental fr
  JOIN reservation r        ON r.facility_rental_id = fr.id AND r.deleted_at IS NULL
  JOIN location l           ON l.id = r.location_id
  JOIN reservation_court rc ON rc.reservation_id = r.id
  JOIN court ct             ON ct.id = rc.court_id
  WHERE fr.deleted_at IS NULL
    AND fr.organization_id = {{org_id}}::uuid
    AND ct.type IS NOT NULL
    -- end-bound pushdown (see header): safe for earliest-reservation semantics
    [[ AND lower(r.reservation_timestamp_range)::date <= {{end_date}} ]]
    AND (1 = 0 [[ OR {{end_date}} IS NOT NULL ]]
         OR lower(r.reservation_timestamp_range)::date <= (date_trunc('month', now()::date) + interval '1 month' - interval '1 day')::date)
  -- deterministic tie-break: 1,424 Apex rentals have multiple reservations at
  -- the same earliest start; without r.id the picked court/Total is plan-dependent
  ORDER BY fr.id, lower(r.reservation_timestamp_range), r.id, ct.court_number
)
SELECT
  b.reservation_id                              AS "Reservation ID",
  b.local_date                                  AS "Date",
  b.location                                    AS "Location",
  b.facility                                    AS "Facility",
  b.site_type                                   AS "Site Type",
  b.booking_type                                AS "Booking Type",
  b.status                                      AS "Status",
  b.head_count                                  AS "Head Cnt",
  CASE WHEN b.status = 'Canceled' THEN 0
       ELSE COALESCE(rev.amount, 0) END         AS "Total"
FROM booking b
LEFT JOIN LATERAL (                  -- base rental revenue for this reservation (add-ons excluded, like the report's "Total")
  SELECT SUM((oi.applied_pricing->'result'->>'finalCents')::numeric) / 100.0 AS amount
  FROM order_item oi
  WHERE oi.reservation_id = b.res_id
    AND oi.deleted_at IS NULL
    AND oi.parent_order_item_id IS NULL
    AND oi.organization_id = {{org_id}}::uuid
    AND (oi.applied_pricing->'result'->>'finalCents') IS NOT NULL
) rev ON TRUE
WHERE 1 = 1
  [[ AND b.local_date >= {{start_date}} ]]
  [[ AND b.local_date <= {{end_date}} ]]
  AND (1 = 0 [[ OR {{start_date}} IS NOT NULL ]]
       OR b.local_date >= date_trunc('month', now()::date)::date)
  AND (1 = 0 [[ OR {{end_date}} IS NOT NULL ]]
       OR b.local_date <= (date_trunc('month', now()::date) + interval '1 month' - interval '1 day')::date)
ORDER BY b.local_date, b.location, b.facility
