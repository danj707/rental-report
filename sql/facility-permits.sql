/* ============================================================
   Facility Rental Permits — Metabase card 20230
   ("✅ Facility Rental Permits (posting sheets)")
   Collection 3532, database 4 (Rec-Prod-ReadReplica).
   Variable: {{org_id}}

   Powers the per-row permit button and the "Export Permits" posting sheets on
   the facility rental report.

   WHY THIS IS A SEPARATE CARD: it joins to the facility feed on
   "Reservation ID" — card 17294 emits facility_rental.id under that name, and
   facility_rental_permit.facility_rental_id is the same key. So permits attach
   to schedule rows with NO change to 17294, and therefore no date-tag reset and
   no risk to the most-used report in the app.

   Tag type doesn't matter here: the route echoes back the card's own registered
   parameter types (same approach as card 20197), so an API edit needs no
   re-flip in the Metabase UI.

   ISSUED ONLY. A rental can hold several permit rows — a draft alongside the
   issued one (Goodyear rental 3c61382f has exactly that) — and a draft has no
   working public page, so posting a sheet for one would send staff to a dead
   link. Revoked permits are excluded for the same reason: revoking is precisely
   what turns the public page off.

   The permit code Rec prints is the LAST 8 hex of the permit id, not the first
   — verified against Goodyear permit da1f3fb2-…-50d967747eb8, printed as
   67747EB8.

   The public permit URL takes no auth, which is what makes it safe as a QR on a
   fence post. Confirmed by decoding the QR out of Rec's own permit PDF:
   https://www.rec.us/permits/da1f3fb2-d426-4a8e-926c-50d967747eb8

   THE SCHEDULE (added 2026-08-20, per Dan): one permit covers the WHOLE rental,
   often many dates across several sites — Pawnee has a permit spanning 40 dates
   on two fields. A posting sheet goes up once at the start of a run, so it has
   to carry every date it is good for; a sheet showing one date reads to a parks
   team as a single-day booking. There is no per-occurrence public URL to point
   a QR at, so the dates have to travel on the sheet itself.

   "Schedule" is JSON rather than a pre-formatted string so the sheet can do the
   layout: it filters to the site the sheet is being hung at (a sheet on the
   Multipurpose Field should not list the Kitchen booking) and groups runs that
   share a time. The site key matches card 17294's "Facility" column — both are
   court.court_number.

   TWO SHAPES OF MULTI-DAY, and they are not the same thing:
     recurring — many occurrences of one day each (every Friday until September)
     stay      — ONE occurrence spanning days (campsite, 9/15 3:00pm → 9/17 11:00am)
   Each schedule entry therefore carries both ends, `d`/`ed` plus `s`/`e`, and
   "Date Count" counts calendar days COVERED rather than occurrences. Gating on
   occurrences is what made overnight sites print as single-day bookings.

   ORDERING MATTERS AND IS EASY TO GET WRONG: aggregating formatted labels with
   string_agg(DISTINCT …) sorts them as TEXT, which yields
   "Aug 13, Aug 20, Aug 27, Aug 6, Jul 16" — chronological nonsense on a printed
   sheet. The dates are de-duplicated first, then aggregated ORDER BY the date
   itself.

   ADD-ONS CARRY NO QUANTITY on purpose. Add-ons are billed per occurrence, so a
   recurring rental multiplies them: Pawnee's 40-date permit holds 79 rows of
   "Alcohol Permit". "Alcohol Permit ×79" on a fence would be nonsense, and the
   sheet's job is to say what is authorised at the site, not what was invoiced.
   Distinct names only.
   ============================================================ */
WITH permits AS (
  SELECT frp.*
  FROM facility_rental_permit frp
  WHERE frp.organization_id = {{org_id}}::uuid
    AND frp.status = 'issued'
    AND frp.deleted_at IS NULL
    AND frp.revoked_at IS NULL
),
-- One row per (permit, occurrence, site): the grain a posting sheet lists.
-- DISTINCT collapses the multi-court fan-out of a single booking.
--
-- occ_end_date is NOT decoration. A campsite or shelter booked overnight is ONE
-- reservation whose range spans days — Pawnee's Kumeyaay Lake site runs
-- 9/15 3:00pm to 9/17 11:00am as a single row, and Douglas County's campsites
-- are all like this. Reading only the start date counts that as a single-day
-- booking, which is how these sheets ended up printing one date and a lone
-- check-in time. Nightly sites need both ends of the stay.
occ AS (
  SELECT DISTINCT
    p.id                                                         AS permit_id,
    date(lower(r.reservation_timestamp_range))                   AS occ_date,
    date(upper(r.reservation_timestamp_range))                   AS occ_end_date,
    to_char(lower(r.reservation_timestamp_range), 'FMHH12:MIam') AS starts,
    to_char(upper(r.reservation_timestamp_range), 'FMHH12:MIam') AS ends,
    ct.court_number                                              AS site,
    ct.capacity                                                  AS site_capacity
  FROM permits p
  JOIN reservation r
    ON r.facility_rental_id = p.facility_rental_id
   AND r.deleted_at IS NULL
   AND r.canceled_at IS NULL
  LEFT JOIN reservation_court rc ON rc.reservation_id = r.id
  LEFT JOIN court ct             ON ct.id = rc.court_id
),
-- Every calendar day any occurrence touches, so "how many days is this permit
-- good for" is one number whether the permit is a weekly recurrence (many
-- one-day occurrences) or one continuous stay (one occurrence, many days).
covered AS (
  SELECT DISTINCT o.permit_id, g.d::date AS day
  FROM occ o,
       LATERAL generate_series(o.occ_date::timestamp,
                               o.occ_end_date::timestamp,
                               interval '1 day') g(d)
),
day_counts AS (
  SELECT permit_id, COUNT(*) AS date_count FROM covered GROUP BY permit_id
),
sched AS (
  SELECT
    o.permit_id,
    dc.date_count                                               AS date_count,
    MIN(o.occ_date)                                             AS first_date,
    MAX(o.occ_end_date)                                         AS last_date,
    MAX(o.site_capacity)                                        AS capacity,
    -- Only permits covering more than one day need a schedule; a single-day
    -- permit's sheet already shows its one date, and emitting the array anyway
    -- would ship a JSON blob per permit for the ~99% that cannot use it
    -- (Watertown: 17 of 1,212). Gated on days COVERED, not on the number of
    -- occurrences, so a single overnight stay still gets one.
    CASE WHEN dc.date_count > 1
      THEN json_agg(json_build_object('d',  o.occ_date, 'ed', o.occ_end_date,
                                      's',  o.starts,   'e',  o.ends,
                                      'site', o.site)
                    ORDER BY o.occ_date, o.starts)
    END                                                         AS schedule
  FROM occ o
  JOIN day_counts dc ON dc.permit_id = o.permit_id
  GROUP BY o.permit_id, dc.date_count
),
-- Add-ons hang off the rental's order_item as children, exactly as card 17294
-- reads them (parent_order_item_id + product_type 'product').
addon_rows AS (
  SELECT DISTINCT p.id AS permit_id, ai.id AS addon_id, ai.name AS addon_name
  FROM permits p
  JOIN reservation r
    ON r.facility_rental_id = p.facility_rental_id
   AND r.deleted_at IS NULL
   AND r.canceled_at IS NULL
  JOIN order_item oi ON oi.reservation_id = r.id AND oi.deleted_at IS NULL
  JOIN order_item ai ON ai.parent_order_item_id = oi.id
   AND ai.product_type   = 'product'
   AND ai.deleted_at IS NULL
   AND ai.organization_id = {{org_id}}::uuid
),
addons AS (
  SELECT permit_id,
         string_agg(DISTINCT NULLIF(BTRIM(addon_name), ''), ', '
                    ORDER BY NULLIF(BTRIM(addon_name), '')) AS addon_names
  FROM addon_rows
  GROUP BY permit_id
)
SELECT
  p.facility_rental_id                                AS "Reservation ID",
  p.id                                                AS "Permit ID",
  UPPER(RIGHT(p.id::text, 8))                         AS "Permit Code",
  'https://www.rec.us/permits/' || p.id::text         AS "Permit URL",
  -- Rec's own permit page shows a holder line even when the column is null: it
  -- falls back to the rental's customer. Goodyear permit da1f3fb2 stores NULL
  -- and displays "Ramada Rental Club", which is the customer. Resolving it here
  -- rather than in the app keeps the posting sheet identical to the permit.
  COALESCE(
    NULLIF(BTRIM(p.permit_holder_name), ''),
    NULLIF(BTRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '')
  )                                                   AS "Permit Holder",
  NULLIF(BTRIM(p.purpose_of_use), '')                 AS "Purpose",
  NULLIF(BTRIM(p.details), '')                        AS "Details",
  fr.name                                             AS "Rental Name",
  fr.attendee_count                                   AS "Attendees",
  COALESCE(s.date_count, 0)                           AS "Date Count",
  s.first_date                                        AS "First Date",
  s.last_date                                         AS "Last Date",
  s.capacity                                          AS "Capacity",
  a.addon_names                                       AS "Add Ons",
  s.schedule                                          AS "Schedule",
  p.issued_at                                         AS "Issued At"
FROM permits p
JOIN facility_rental fr ON fr.id = p.facility_rental_id
LEFT JOIN users u       ON u.id = fr.customer_user_id
LEFT JOIN sched s       ON s.permit_id = p.id
LEFT JOIN addons a      ON a.permit_id = p.id
ORDER BY p.issued_at DESC NULLS LAST
