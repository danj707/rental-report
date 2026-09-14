-- ═══════════════════════════════════════════════════════════════════
-- LESSON RETENTION & LTV (v1.0 — 2026-09-14)
-- Metabase card 21848 · Retention tab of the Instructor Lessons report
-- (public/lessons.html, SF pilot). Mirrored at
-- sql/report-cards/21848-lessons-retention.sql — the LIVE CARD is the truth.
--
-- ONE ROW PER LESSON BOOKING, ALL-TIME, keyed on customer_user_id.
-- Card 17755 is keyed on the participant's NAME and windowed by payment
-- date, so a customer's lifetime cannot be assembled from it. Measured at
-- SF 2026-09-14: 5,832 bookings, 5,792 carrying money, $792,154 net.
--
-- ───────────────────────────────────────────────────────────────────
-- WHY TWO CARDS AND NOT ONE
--
-- The first build was one card with a UNION of inquiry and booking rows,
-- and it TIMED OUT past 60s three times. Localised one probe at a time:
-- the inquiry half is 1.4s and the booking half is 21.6s (31.2s in a
-- set-based form) — the money aggregate is simply expensive at SF, where
-- order_item carries 158,855 facility bookings alongside the lessons.
-- Together they exceed the budget; apart, each is comfortably inside it,
-- they cache separately, and THE HALF CARRYING THE FINDING NEVER WAITS ON
-- THE HALF CARRYING THE MONEY. The page fetches both in parallel and
-- renders whichever arrives.
--
-- Variables: {{org_id}} Text. NO DATE TAGS on either card — so
-- buildMetabaseParams sends org_id alone, each card registers ONE Text
-- tag, and there is no date-tag flip and no push→flip outage. A lifetime
-- value is a POSITION (current whatever the toolbar says) and the funnel
-- needs a trailing series wider than the window on screen; the page
-- labels both "all-time" out loud rather than letting a reader infer
-- that the date pickers moved them.
--
-- ───────────────────────────────────────────────────────────────────
-- WHAT COUNTS AS A LESSON
--
-- A booking on a section that has a FACILITATOR — the structural test,
-- which is what card 17755 already requires through its INNER JOIN
-- LATERAL. Deliberately NOT the page's old
-- `/lesson|clinic|coaching|private/` name regex: a name match is the trap
-- this repo keeps recording (`/ball ?field/` inside "Football Field").
--
-- Measured at SF before choosing, so this is a no-op rather than a
-- redefinition: over Sep 2025–Aug 2026 the two rules select the SAME
-- 3,640 bookings — 0 dropped either way.
--
-- The booking predicate is 17755's, character for character, so the two
-- cards cannot disagree about which bookings exist:
--     (status='confirmed' AND canceled_at IS NULL) OR canceled_at IS NOT NULL
-- That matters: SF has 98 live `planned` bookings on facilitated
-- sections, which a bare `canceled_at IS NULL` folds in and which 17755
-- has never counted.
--
-- ───────────────────────────────────────────────────────────────────
-- NO `cfg` CTE FOR THE ORG ID, and that is a measurement not a style
--
-- Written 17755's way — `b.organization_id = cfg.org_id` — every
-- predicate is a join against a CTE column rather than a constant.
-- Metabase substitutes {{org_id}} as a literal, so repeating the tag at
-- each predicate is what the fast probes actually measured. Only the
-- timezone stays a CTE: one row, read once, in the final SELECT.
-- ═══════════════════════════════════════════════════════════════════

WITH org_tz AS (
  SELECT COALESCE(
           (SELECT l.timezone FROM location l
            WHERE l.organization_id = {{org_id}}::uuid AND l.deleted_at IS NULL
              AND l.timezone <> 'UTC'
            GROUP BY l.timezone ORDER BY COUNT(*) DESC LIMIT 1),
           'America/Los_Angeles') AS tz
),

-- Every lesson booking this org has ever taken, with its section.
lesson_bk AS (
  SELECT b.id, b.customer_user_id, b.creator_user_id, b.created_at,
         b.canceled_at, b.is_fast_track, s.id AS section_id
  FROM booking b
  LEFT JOIN session bses ON bses.id = b.session_id
                         AND bses.organization_id = {{org_id}}::uuid
  JOIN section s ON s.id = COALESCE(b.section_id, bses.section_id)
                 AND s.organization_id = {{org_id}}::uuid
                 AND s.deleted_at IS NULL
  WHERE b.organization_id = {{org_id}}::uuid
    AND b.deleted_at IS NULL
    AND b.type IN ('section', 'session')
    AND ((b.status = 'confirmed' AND b.canceled_at IS NULL)
         OR b.canceled_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM section_facilitator sf
                WHERE sf.section_id = s.id
                  AND sf.organization_id = {{org_id}}::uuid
                  AND sf.deleted_at IS NULL)
),

-- One instructor string per section. STRING_AGG and the whitespace
-- normalisation are lifted verbatim from card 17755 so a name renders
-- identically on the payout report, the lessons leaderboard and here —
-- two spellings of one instructor is two entries in the filter dropdown,
-- and this page's whole toolbar is that dropdown.
sec_fac AS (
  SELECT sf.section_id,
         STRING_AGG(DISTINCT BTRIM(REGEXP_REPLACE(CONCAT_WS(' ', u.first_name, u.last_name), '\s+', ' ', 'g')), ', ') AS instructor
  FROM section_facilitator sf
  JOIN instructor i ON i.id = sf.facilitator_id
                    AND i.organization_id = {{org_id}}::uuid
                    AND i.deleted_at IS NULL
  JOIN users u ON u.id = i.user_id
  WHERE sf.organization_id = {{org_id}}::uuid
    AND sf.deleted_at IS NULL
    AND sf.section_id IN (SELECT section_id FROM lesson_bk)
  GROUP BY sf.section_id
),

-- Net money per booking: succeeded payments less succeeded refunds.
-- All-time, because a lifetime value is.
--
-- DRIVEN FROM THE BOOKINGS INTO order_item_bookingid_index, as a LATERAL.
-- The first shape joined order_item to the booking set carrying
-- `oi.organization_id = …`, which sends the planner at SF's ENTIRE
-- order_item table — 158,855 facility bookings' worth — before the
-- selective predicate applies, and it timed out past 60s. A set-based
-- rewrite driving through the order items measured 31.2s; this LATERAL
-- measured 21.6s for the identical answer, so the lateral stays.
-- `oi.booking_id = lb.id` is the selective predicate and it is indexed;
-- the org filter inside is redundant, since the booking is already
-- org-scoped and a booking_id belongs to exactly one org.
bk_money AS (
  SELECT lb.id AS booking_id, m.net_cents
  FROM lesson_bk lb
  LEFT JOIN LATERAL (
    SELECT SUM(CASE WHEN pmt.status = 'succeeded' AND oit.refund_id IS NULL THEN oit.amount
                    WHEN rf.status = 'succeeded' THEN -ABS(oit.amount)
                    ELSE 0 END) AS net_cents
    FROM order_item oi
    JOIN order_item_transaction oit ON oit.order_item_id = oi.id
                                    AND oit.deleted_at IS NULL
    LEFT JOIN payment pmt ON pmt.id = oit.payment_id AND pmt.deleted_at IS NULL
    LEFT JOIN refund  rf  ON rf.id  = oit.refund_id  AND rf.deleted_at IS NULL
    WHERE oi.booking_id = lb.id
      AND oi.deleted_at IS NULL
      AND oi.parent_order_item_id IS NULL
  ) m ON TRUE
),

-- Who pressed the button. `creator_user_id` vs `customer_user_id` is the
-- only channel signal the schema has, and it is a real one.
--
-- Measured at SF over Sep 2025–Aug 2026: self 3,615 (99.3%), staff 25,
-- instructor 0. The instructor arm is EMPTY and is emitted anyway — SF
-- instructors create 7,912 facility reservations (they book the COURT)
-- and zero lesson registrations, so "instructor booked" is a real channel
-- nobody uses, and a row that appears at zero is a row somebody can
-- watch. Omitting it is how a channel stays unmeasurable.
--
-- Membership is hashed once rather than tested per booking: two EXISTS
-- inside the CASE is two index probes for every one of 5,832 rows.
instr_users AS (
  SELECT i.user_id FROM instructor i WHERE i.organization_id = {{org_id}}::uuid
),
staff_users AS (
  SELECT ou.user_id
  FROM organization_user ou
  JOIN organization_user_role our ON our.organization_user_id = ou.id
                                  AND our.deleted_at IS NULL
  WHERE ou.organization_id = {{org_id}}::uuid AND ou.deleted_at IS NULL
),
bk_channel AS (
  SELECT lb.id,
         CASE
           WHEN lb.creator_user_id IS NULL THEN 'unknown'
           WHEN lb.creator_user_id = lb.customer_user_id THEN 'self'
           WHEN lb.creator_user_id IN (SELECT user_id FROM instr_users) THEN 'instructor'
           WHEN lb.creator_user_id IN (SELECT user_id FROM staff_users)  THEN 'staff'
           ELSE 'other'
         END AS channel
  FROM lesson_bk lb
)

SELECT
  COALESCE(sf.instructor, 'Unassigned')             AS "Instructor",
  TO_CHAR(lb.created_at AT TIME ZONE org_tz.tz, 'YYYY-MM-DD') AS "Date",
  CASE WHEN lb.canceled_at IS NOT NULL THEN 'Canceled' ELSE 'Active' END AS "Status",
  -- The customer KEY, not their name. Retention is per person and two
  -- different children really do share a name on this platform (apex has
  -- two Bridger Walls), so a name key silently merges two families.
  lb.customer_user_id::text                         AS "Customer",
  ROUND(COALESCE(bm.net_cents, 0) / 100.0, 2)       AS "Net",
  bc.channel                                        AS "Channel",
  COALESCE(lb.is_fast_track, FALSE)                 AS "Fast Track"
FROM org_tz
JOIN lesson_bk lb ON TRUE
LEFT JOIN sec_fac sf ON sf.section_id = lb.section_id
LEFT JOIN bk_money bm ON bm.booking_id = lb.id
LEFT JOIN bk_channel bc ON bc.id = lb.id

ORDER BY "Date", "Instructor"
