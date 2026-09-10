-- ─────────────────────────────────────────────────────────────────────────────
-- Facility Rental Refunds Due — money collected on a booking that was later
-- cancelled, and never refunded.
--
-- Base data report `rental-refunds-due`. Portable to any org: {{org_id}} only.
--
-- Dan, 2026-09-10: "when someone cancels a facility rental, they are typically
-- owed a refund, but no place in the product surfaces this."
--
-- THE WINDOW IS ON THE CANCELLATION DATE (Dan, 2026-09-10: "those reports
-- should have the same date range filters as the others for consistency").
--
-- SAY THIS OUT LOUD TO WHOEVER READS IT, because it is the one way this report
-- can mislead: it is a WORK QUEUE, and the oldest unrefunded items are the ones
-- most likely to have been missed — so the default month is exactly the range
-- that hides them. Clearing the dates returns the whole outstanding queue, and
-- that is the reading the report is for. The window is for answering "what did
-- we cancel in March", which is a different and also real question.
--
-- Dated on the CANCELLATION rather than the booking, because the cancellation
-- is the event that creates the obligation. A booking date window would sweep
-- in next season's cancellations and miss last week's.
--
-- THE GRAIN IS THE RESERVATION, NOT THE RENTAL, and that is what makes a
-- partly-cancelled booking answerable. `order_item.reservation_id` links the
-- money to the individual date, so a recurring rental that lost one Tuesday
-- reports that Tuesday rather than the whole run.
--
-- BOTH CANCELLATION PATHS COUNT. A reservation can be cancelled on its own while
-- the rental stays Confirmed (the case card 19570 already handles), and a rental
-- can be cancelled without its reservations being individually marked — measured,
-- the second path adds 12 rows and $934.75 platform-wide. Small, real, and
-- invisible if you test only `reservation.canceled_at`.
--
-- WHAT "OWED" MEANS HERE, stated plainly because the column name cannot carry
-- it: this is money COLLECTED AND NOT REFUNDED on a cancelled booking. It is not
-- a claim that the org owes it — a retained cancellation fee is legitimate and
-- looks identical in the data. The report surfaces the position and a human
-- decides. Hence the column is `Unrefunded`, never `Refund Due`.
--
-- THE TRANSACTION FILTER IS THE ITEM LOG'S OWN NOTION OF A COUNTABLE PAYMENT
-- (deleted_at IS NULL AND confirmed_at IS NOT NULL AND credit_id IS NULL), taken
-- from the partial predicate on order_item_transaction_item_log_period_index.
--
-- EXCLUDING credit_id WAS CHECKED RATHER THAN ASSUMED, because it could have cut
-- both ways: a refund paid out as store credit would be invisible and the report
-- would tell staff to refund someone already made whole. Measured — credit_id is
-- set on 2,205 of 2,744,498 transactions (0.08%) and on ZERO of the ones touching
-- a cancelled facility reservation. And separately, all 11,122 refund rows on
-- cancelled-rental items have a matching transaction, including every
-- organization-credit one, so nothing is missed by reading transactions alone.
--
-- THE SITE COMES FROM `reservation_court`, NOT `reservation.court_id`. That
-- column is legacy-NULL — 0 of El Segundo's 24,415 facility reservations carry
-- one, and the same is already recorded for SF's 557,367 — so reading it renders
-- "(no site on file)" on every row of every org while the site is perfectly well
-- known. `reservation.location_id` IS populated (24,415 of 24,415) and points at
-- `location`, so the location and the site come from two different places.
--
-- AND IT IS AGGREGATED, NEVER JOINED. A reservation may occupy more than one
-- court, and joining the table would multiply the row — and its MONEY — once per
-- court. El Segundo happens to be 1:1 today (max 1 court), which is exactly why
-- this has to be written for the general case rather than the org in front of
-- us: SF has multi-court reservations, and a report that double-counts a refund
-- is worse than one that does not exist. `Sites` carries the count beside the
-- name so a multi-court booking is legible rather than silently truncated.
--
-- Platform-wide as at 2026-09-10: 11,761 reservations across 54 orgs holding
-- $97,893.76 — against 70,702 cancelled reservations already fully refunded, so
-- the product does handle most of this and the report is the residue.
--
-- `Days Waiting` EXISTS BECAUSE THE RAW LIST IS NOT A WORK QUEUE, and this is
-- the measurement that decides how to read the whole report. When a refund does
-- happen it happens FAST — over the 11,022 cancelled reservations that were
-- refunded: 62.7% the same day, 84.0% within three days, 95.0% within SEVEN,
-- 98.9% within thirty, median 0.5 days, p95 7.0 days.
--
-- So seven days is a MEASURED threshold rather than a guess: past it, the
-- normal process was never going to catch the item. And almost everything here
-- is past it — of the 11,761 outstanding, only 377 ($3,831.75) are under a week
-- old, while 8,184 ($62,888.27) are three months to a year old and 82 are over
-- a year. Median age 155 days.
--
-- WHAT THIS REPORT STILL CANNOT TELL YOU, said plainly because the median
-- outstanding amount is $5.00: it cannot separate money DELIBERATELY retained
-- (a cancellation fee, a de-minimis policy on a $5 court booking) from money
-- somebody simply missed. Both look identical in the data — there is no
-- cancellation-policy signal on the reservation to read. The age column is what
-- makes the list workable anyway: sort by it and the old, LARGE items are the
-- ones worth a human, which is a different and much shorter list than "$97,894
-- outstanding".
--
-- Ordered biggest-first within each location for that reason — a refund queue
-- is worked by amount, not by date.
-- ─────────────────────────────────────────────────────────────────────────────
WITH cx AS (
  SELECT r.id                                    AS reservation_id,
         COALESCE(r.canceled_at, fr.canceled_at) AS canceled_at,
         r.starts_at,
         r.location_id,
         fr.id                                   AS rental_id,
         fr.name                                 AS rental_name,
         fr.customer_user_id
  FROM reservation r
  JOIN facility_rental fr ON fr.id = r.facility_rental_id AND fr.deleted_at IS NULL
  WHERE r.organization_id = {{org_id}}::uuid
    AND r.deleted_at IS NULL
    AND (r.canceled_at IS NOT NULL OR fr.canceled_at IS NOT NULL)
    -- Scoped HERE rather than at the output, so `site` and `money` are only
    -- computed for reservations that can survive — the same shape as `win` on
    -- card 21649. The bound is the same COALESCE the row reports, or a rental
    -- cancelled at rental level would fall outside its own window.
    [[ AND COALESCE(r.canceled_at, fr.canceled_at) >= {{start_date}}::date ]]
    [[ AND COALESCE(r.canceled_at, fr.canceled_at) <  {{end_date}}::date + 1 ]]
),
site AS (
  SELECT rc.reservation_id,
         STRING_AGG(DISTINCT NULLIF(BTRIM(ct.court_number), ''), ', ') AS site_names,
         COUNT(DISTINCT rc.court_id)                                   AS site_count
  FROM reservation_court rc
  JOIN cx ON cx.reservation_id = rc.reservation_id
  LEFT JOIN court ct ON ct.id = rc.court_id
  GROUP BY 1
),
money AS (
  SELECT oi.reservation_id,
         COALESCE(SUM(oit.amount) FILTER (WHERE oit.payment_id IS NOT NULL), 0) AS paid_cents,
         COALESCE(SUM(oit.amount) FILTER (WHERE oit.refund_id  IS NOT NULL), 0) AS refunded_cents,
         MAX(oit.confirmed_at) FILTER (WHERE oit.refund_id IS NOT NULL)         AS last_refund_at
  FROM order_item oi
  JOIN cx ON cx.reservation_id = oi.reservation_id
  JOIN order_item_transaction oit
    ON oit.order_item_id = oi.id
   AND oit.deleted_at IS NULL
   AND oit.confirmed_at IS NOT NULL
   AND oit.credit_id IS NULL
  WHERE oi.deleted_at IS NULL
  GROUP BY 1
)
SELECT
  COALESCE(NULLIF(BTRIM(l.name), ''), '(no location on file)')       AS "Location",
  COALESCE(NULLIF(BTRIM(sc.site_names), ''), '(no site on file)')    AS "Site",
  COALESCE(sc.site_count, 0)                                         AS "Sites",
  cx.starts_at::date                                                 AS "Booking Date",
  cx.canceled_at::date                                               AS "Cancelled",
  COALESCE(NULLIF(BTRIM(cx.rental_name), ''), '(unnamed rental)')    AS "Rental",
  COALESCE(NULLIF(BTRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), '(no name on file)')
                                                                     AS "Customer",
  u.email                                                            AS "Email",
  ROUND(m.paid_cents     / 100.0, 2)                                 AS "Collected",
  ROUND(m.refunded_cents / 100.0, 2)                                 AS "Refunded",
  ROUND((m.paid_cents - m.refunded_cents) / 100.0, 2)                AS "Unrefunded",
  m.last_refund_at::date                                             AS "Last Refund",
  -- NOT additive: an age is a property of one row and summing it down the
  -- column adds up nothing anyone wants, so it is deliberately absent from the
  -- registry's `numeric` map — the same treatment as `Sites`.
  (CURRENT_DATE - cx.canceled_at::date)                              AS "Days Waiting",
  cx.rental_id::text                                                 AS "Rental ID",
  1                                                                  AS "Bookings"
FROM cx
JOIN money m ON m.reservation_id = cx.reservation_id
LEFT JOIN site     sc ON sc.reservation_id = cx.reservation_id
LEFT JOIN location l  ON l.id  = cx.location_id
LEFT JOIN users    u  ON u.id  = cx.customer_user_id
WHERE m.paid_cents - m.refunded_cents > 0
ORDER BY 1, (m.paid_cents - m.refunded_cents) DESC, cx.canceled_at DESC
