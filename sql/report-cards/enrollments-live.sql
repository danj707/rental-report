-- ✅ Enrollments Live — the signup feed behind "Laurel's Coffee Chart"
--
-- WHY THIS CARD EXISTS. Laurel at Shrewsbury, on the reporting project
-- (2026-09-03): "I'm here in the morning, I have my coffee, I'm going to log in
-- and see what everything looks like... I don't have that umbrella viewpoint
-- that I'm used to having, and I miss it." What she had was Metabase card 3571
-- in her own collection — four columns, newest first, no filters — and it beat
-- our seven-tab Programs report for the one question she asks daily: who just
-- signed up, for what.
--
-- This is that card, made shared and org-parameterized, plus the price Dan
-- asked for. FOUR THINGS ARE DELIBERATELY DIFFERENT FROM 3571, and each one is
-- a defect in the original:
--
--   1. "Signed Up At" READS created_at, NOT updated_at. 3571 selects and sorts
--      on booking.updated_at while its own Date Range filter is bound to
--      booking.created_at — so the column and the filter describe different
--      events, and "newest first" is really "most recently TOUCHED first". A
--      transfer, a status change or a staff note re-dates a months-old signup
--      to today and floats it to the top of the list. created_at is the moment
--      somebody registered, which is the thing being watched.
--   2. THE ORG IS A PARAMETER. 3571 hardcodes Shrewsbury's uuid (while its
--      description says Madison — it was copied), so every org needs its own
--      copy and they drift. One shared card, org_id bound like every other
--      card in this repo.
--   3. THE TIMEZONE COMES FROM THE ORG. 3571 hardcodes America/New_York, which
--      is right for Shrewsbury and wrong for the ~half the platform that is
--      not Eastern — a 9pm signup renders on the wrong DAY in Pacific. Same
--      cfg CTE as card 17295: the org's majority location timezone, falling
--      back to Eastern only when there is nothing to read.
--   4. NO ARBITRARY FLOOR. 3571 carries `updated_at > '2025-04-15'`, a
--      hardcoded date that silently truncates history. The window is the
--      caller's business.
--
-- WHAT IT IS NOT. This is not a revenue report and must not be reconciled
-- against one. `Price` is the item's own charge (applied_pricing finalCents,
-- NOT order_item.price — the rate card, which reads non-zero for a comped
-- booking; that is the mistake already recorded for the facility report), and
-- `Paid` is what has actually succeeded against it. A registration on a
-- payment plan shows its full price with only the first installment paid, so
-- the two columns differ by design and neither is "programme revenue".
--
-- Params: org_id (uuid), start_date, end_date (inclusive, on the SIGNUP date
-- in the org's timezone). Row cap is the caller's — the page asks for the most
-- recent N.
--
-- Mirrored here; THE LIVE CARD IS THE SOURCE OF TRUTH — read it before writing
-- to it (the 17294 mirror was 53 lines stale and a push would have deleted a
-- whole feature). After any API update, re-set Start/End Date variable types
-- to Date in the UI and re-save until the card registers three parameters,
-- not six.
WITH cfg AS (
  SELECT o.id AS org_id,
         COALESCE(
            (SELECT l.timezone
               FROM location l
              WHERE l.organization_id = o.id
                AND l.deleted_at IS NULL
                AND l.timezone <> 'UTC'
              GROUP BY l.timezone
              ORDER BY COUNT(*) DESC
              LIMIT 1),
            'America/New_York'
         ) AS tz
  FROM organization o
  WHERE o.id = {{org_id}}::uuid
),
-- One row per booking. A booking is the registration; its order_item carries
-- the money. LEFT JOIN on purpose: a staff-added registration with no order
-- item is still a registration, and dropping it would make the feed disagree
-- with the roster.
money AS (
  SELECT oi.booking_id,
         SUM(COALESCE((oi.applied_pricing->'result'->>'finalCents')::numeric,0)) AS price_cents,
         SUM(COALESCE(t.succeeded_cents,0)) AS paid_cents
  FROM cfg
  JOIN order_item oi ON oi.organization_id = cfg.org_id
       AND oi.deleted_at IS NULL AND oi.parent_order_item_id IS NULL
       AND oi.booking_id IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT SUM(CASE WHEN pmt.status = 'succeeded' THEN oit.amount ELSE 0 END) AS succeeded_cents
    FROM order_item_transaction oit
    LEFT JOIN payment pmt ON pmt.id = oit.payment_id
    WHERE oit.order_item_id = oi.id AND oit.deleted_at IS NULL
      AND oit.confirmed_at IS NOT NULL AND oit.credit_id IS NULL
  ) t ON TRUE
  GROUP BY oi.booking_id
)
SELECT
  TO_CHAR(b.created_at AT TIME ZONE cfg.tz, 'YYYY-MM-DD"T"HH24:MI:SS')            AS "Signed Up At",
  CONCAT(u.first_name, ' ', u.last_name)                                          AS "Customer Name",
  u.email                                                                         AS "Email",
  -- The participant, which is NOT the buyer: a parent registers a child, and
  -- the roster question is who is IN the class. Null when the booking is for
  -- the account holder themselves.
  NULLIF(TRIM(CONCAT(pu.first_name, ' ', pu.last_name)), '')                      AS "Participant",
  s.name                                                                          AS "Section",
  s.section_code                                                                  AS "Section Code",
  p.name                                                                          AS "Program",
  (SELECT STRING_AGG(DISTINCT a.name, ', ' ORDER BY a.name)
     FROM program_activity pa JOIN activity a ON a.id = pa.activity_id
    WHERE pa.program_id = p.id)                                                   AS "Activity",
  ROUND(COALESCE(m.price_cents,0) / 100.0, 2)                                     AS "Price",
  ROUND(COALESCE(m.paid_cents,0)  / 100.0, 2)                                     AS "Paid",
  b.status                                                                        AS "Status"
FROM cfg
JOIN booking b  ON b.organization_id = cfg.org_id AND b.deleted_at IS NULL
JOIN users u    ON u.id = b.customer_user_id
LEFT JOIN users pu ON pu.id = b.participant_user_id AND pu.id <> b.customer_user_id
LEFT JOIN session se ON se.id = b.session_id AND se.deleted_at IS NULL
JOIN section s  ON s.id = COALESCE(b.section_id, se.section_id) AND s.deleted_at IS NULL
JOIN program p  ON p.id = s.program_id
LEFT JOIN money m ON m.booking_id = b.id
WHERE b.type = 'section'
  AND s.is_rec_managed IS FALSE
  -- Confirmed only. A cancelled registration is not somebody signing up, and
  -- this feed answers "who just registered" — the cancellations question has
  -- its own column on the Programs report.
  AND b.status = 'confirmed'
  -- Windowed on the SIGNUP date in the org's own timezone, so a 9pm signup
  -- lands on the day the registrant experienced.
  [[ AND (b.created_at AT TIME ZONE cfg.tz)::date >= {{start_date}}::date ]]
  [[ AND (b.created_at AT TIME ZONE cfg.tz)::date <= {{end_date}}::date ]]
-- Newest first: the whole point. A stable tie-break on id, or two runs of the
-- same query can disagree about the order of same-second signups.
ORDER BY b.created_at DESC, b.id DESC
