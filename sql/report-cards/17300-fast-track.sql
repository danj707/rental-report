-- Card 17300: ✅ Fast Track Utilization Report — v18 EARLY ACCESS STATUS
-- v18 (2026-08-28): "Reg Status" gains 'early-access'. A section whose GROUP
-- registration window has opened while its DEFAULT window has not is a real,
-- distinct phase: some families can register and others cannot yet. It used to
-- report 'pipeline' (registration has not started), which is false for everyone
-- in the group and kept those sections off every surface gated on open/closed.
-- Measured before pushing, live: 179 sections move pipeline -> early-access and
-- NOTHING else changes (draft 32942, open 14647, closed 2545, scheduled 560,
-- pipeline 518, published 503 all identical). Both UNION arms carry the rule —
-- the second arm's WHERE already scopes to default_opens > now(), so its test is
-- the short form. They must agree or one section reads two ways.
--
-- v17 (2026-08-24): section_start / section_end / section_day / section_time are
-- now computed in the SECTION'S timezone (session location) instead of Metabase's
-- report timezone. See the comment on the schedule block below for the numbers.
-- Output is byte-identical for Pacific orgs; everything else was wrong before.
-- Measured on apex (heaviest, 5,189 sections): 926ms -> 558ms, no regression.
--
-- v16 SPEED REFACTOR
-- EXPLAIN-driven changes vs v15 (output identical):
-- 1. ONE windowed scan of the org's fast-track bookings (ft_b), reused by
--    ft_raw, ft_users and ft_payments. v15 bitmap-scanned the org's 144k
--    bookings four separate times.
-- 2. ft_payments now only aggregates payments for bookings in the window
--    (v15 aggregated ALL FT bookings ever, then discarded the out-of-window
--    ones on join).
-- 3. first_ever_booking is restricted to the FT customers the user rows
--    actually display (v15 grouped every confirmed booking in the org).
-- 4. section_base computes schedule + capacity in ONE session pass (v15
--    scanned session twice: once for counts, once for first-session day/time).
--    Canceled sessions still count toward schedule (as in v15's sch) but not
--    toward capacity/session_count (as in v15's sc).
-- Variables: {{org_id}} Text, {{start_date}} Date, {{end_date}} Date
-- ⚠ PASTE IN THE METABASE UI, NOT VIA THE API (Date variable types reset).

WITH params AS (
  SELECT {{org_id}}::uuid AS org_id
),

/* ─── SEASON MAP ─── */
season_map AS (
  SELECT DISTINCT ON (ss.section_id)
         ss.section_id,
         se.name AS season
  FROM section_season ss
  JOIN season se  ON se.id = ss.season_id AND se.deleted_at IS NULL
  JOIN section s  ON s.id  = ss.section_id
  WHERE ss.deleted_at IS NULL
    AND s.organization_id = (SELECT org_id FROM params)
  ORDER BY ss.section_id,
           ss.updated_at DESC NULLS LAST,
           ss.created_at DESC NULLS LAST,
           ss.id DESC
),

/* ─── SECTION BASE (capacity + schedule in one session pass) ─── */
section_base AS (
  SELECT
    s.id                                                 AS section_id,
    s.program_id,
    s.name                                               AS section_name,
    s.registration_mode,
    s.capacity                                           AS section_capacity,
    s.publish_at,
    s.organization_id,
    CASE WHEN s.registration_mode = 'per-session'
         THEN COALESCE(sx.total_seat_capacity, 0)
         ELSE COALESCE(s.capacity, 0)
    END                                                  AS eff_capacity,
    COALESCE(sx.session_count, 0)                        AS session_count,
    sx.section_start,
    sx.section_end,
    sx.section_day,
    sx.section_time
  FROM section s
  LEFT JOIN (
    SELECT
      sess.section_id,
      -- capacity/counts: non-canceled sessions only (as v15's sc)
      COUNT(*) FILTER (WHERE sess.canceled_at IS NULL)   AS session_count,
      SUM(COALESCE(sess.capacity, sec.capacity, 0))
        FILTER (WHERE sess.canceled_at IS NULL)::int     AS total_seat_capacity,
      -- schedule: all non-deleted sessions incl. canceled (as v15's sch)
      -- ⚠ IN THE SECTION'S OWN TIMEZONE, not Metabase's. starts_at/ends_at are
      -- timestamptz, and ::date / to_char() on a timestamptz are evaluated in the
      -- SESSION TimeZone — which for this Metabase is America/Los_Angeles
      -- (current_setting('TimeZone') confirms it). So an Eastern org's 5pm concert
      -- was emitted as 02:00pm and, for an early-morning event, on the day before.
      -- Smyrna's 154th Birthday Concert read "Oct 2 · 02:00pm–07:00pm" against
      -- Rec's own "Oct 3, 5:00–10:00pm" (2026-08-24). Measured platform-wide:
      -- 17,769 of 30,408 sections across 63 orgs had a wrong time, 56 across 8
      -- orgs a wrong date, and all 12,180 already-Pacific sections are unchanged.
      -- location.timezone is populated on 235,037 of 235,037 sessions, so the
      -- join always resolves; the COALESCE only keeps a future NULL from turning
      -- these columns into NULL (AT TIME ZONE NULL yields NULL), degrading to
      -- today's behaviour rather than to blanks.
      MIN(sess.starts_at AT TIME ZONE z.tz)::date        AS section_start,
      MAX(sess.starts_at AT TIME ZONE z.tz)::date        AS section_end,
      (ARRAY_AGG(to_char(sess.starts_at AT TIME ZONE z.tz, 'Dy')
                 ORDER BY sess.starts_at))[1]            AS section_day,
      (ARRAY_AGG(to_char(sess.starts_at AT TIME ZONE z.tz, 'HH12:MIam') || chr(8211)
                 || to_char(sess.ends_at AT TIME ZONE z.tz, 'HH12:MIam')
                 ORDER BY sess.starts_at))[1]            AS section_time
    FROM "session" sess
    JOIN section sec ON sec.id = sess.section_id
    -- Each session's OWN location: a section can move rooms, and 12 sections
    -- platform-wide genuinely span two zones. The day/time strings describe the
    -- first session, so the first session's zone is the honest one to use.
    LEFT JOIN location loc ON loc.id = sess.location_id
    CROSS JOIN LATERAL (SELECT COALESCE(loc.timezone, current_setting('TimeZone')) AS tz) z
    WHERE sec.organization_id = (SELECT org_id FROM params)
      AND sess.deleted_at  IS NULL
      AND sec.deleted_at   IS NULL
      AND sec.canceled_at  IS NULL
      AND sec.is_rec_managed IS FALSE
    GROUP BY sess.section_id
  ) sx ON sx.section_id = s.id
  WHERE s.organization_id = (SELECT org_id FROM params)
    AND s.deleted_at IS NULL
    AND s.canceled_at IS NULL
    AND s.is_rec_managed IS FALSE
),

/* ─── ALL FT BOOKINGS IN WINDOW (single scan, reused below) ─── */
ft_b AS (
  SELECT b.id, b.customer_user_id, b.participant_user_id, b.status,
         b.created_at, b.canceled_at, b.section_id, b.session_id
  FROM booking b
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at    IS NULL
    AND b.is_fast_track  = TRUE
    [[ AND b.created_at >= {{start_date}}::timestamp ]]
    [[ AND b.created_at < ({{end_date}}::date + interval '1 day') ]]
),

/* ─── FT PAYMENT TOTALS (only for windowed, countable bookings) ─── */
ft_payments AS (
  SELECT
    oi.booking_id,
    SUM(oit.amount) AS paid_cents
  FROM ft_b b
  JOIN order_item oi
    ON oi.booking_id = b.id
   AND oi.parent_order_item_id IS NULL
   AND oi.deleted_at IS NULL
   AND oi.organization_id = (SELECT org_id FROM params)
  JOIN order_item_transaction oit
    ON oit.order_item_id = oi.id
   AND oit.payment_id IS NOT NULL
  WHERE b.status = 'confirmed'
    AND b.canceled_at IS NULL
  GROUP BY oi.booking_id
),

/* ─── ALL FAST TRACK BOOKINGS ─── */
ft_raw AS (
  SELECT
    COALESCE(sess.section_id, b.section_id) AS section_id,
    b.id                                    AS booking_id,
    b.customer_user_id,
    b.participant_user_id,
    b.status,
    b.created_at                            AS ft_created_at,
    b.canceled_at,
    COALESCE(fp.paid_cents, 0)              AS paid_cents
  FROM ft_b b
  LEFT JOIN "session" sess
    ON sess.id = b.session_id
   AND sess.deleted_at IS NULL
  JOIN section s
    ON s.id = COALESCE(sess.section_id, b.section_id)
   AND s.organization_id = (SELECT org_id FROM params)
   AND s.canceled_at IS NULL
  LEFT JOIN ft_payments fp ON fp.booking_id = b.id
  WHERE s.deleted_at    IS NULL
    AND s.is_rec_managed IS FALSE
),
/* ─── FT ROLLUP (includes revenue + unique users) ─── */
ft_rollup AS (
  SELECT
    section_id,
    COUNT(DISTINCT booking_id)
      FILTER (WHERE canceled_at IS NULL)                AS ft_total,
    COUNT(DISTINCT booking_id)
      FILTER (WHERE status = 'confirmed'
              AND canceled_at IS NULL)                  AS ft_converted,
    COUNT(DISTINCT booking_id)
      FILTER (WHERE status = 'planned'
              AND canceled_at IS NULL)                  AS ft_pending,
    COUNT(DISTINCT booking_id)
      FILTER (WHERE canceled_at IS NOT NULL)            AS ft_canceled,
    MIN(ft_created_at)                                  AS earliest_ft,
    MAX(ft_created_at)                                  AS latest_ft,
    COUNT(DISTINCT customer_user_id)
      FILTER (WHERE canceled_at IS NULL)                AS ft_unique_users,
    COALESCE(SUM(paid_cents) FILTER (WHERE status = 'confirmed' AND canceled_at IS NULL), 0) / 100.0 AS ft_rev
  FROM ft_raw
  GROUP BY 1
),

/* ─── FT DAILY SIGNUP COUNTS (for pipeline fill-rate curve) ─── */
ft_daily AS (
  SELECT
    section_id,
    ft_created_at::date                                  AS signup_date,
    COUNT(DISTINCT booking_id)
      FILTER (WHERE canceled_at IS NULL)                 AS daily_signups,
    SUM(COUNT(DISTINCT booking_id)
      FILTER (WHERE canceled_at IS NULL))
      OVER (PARTITION BY section_id
            ORDER BY ft_created_at::date)                AS cumulative_signups
  FROM ft_raw
  GROUP BY section_id, ft_created_at::date
),

/* ─── NON-FT ENROLLMENTS ─── */
organic AS (
  SELECT
    COALESCE(sess.section_id, b.section_id) AS section_id,
    COUNT(DISTINCT b.id) AS organic_enrolled
  FROM booking b
  LEFT JOIN "session" sess
    ON sess.id = b.session_id
   AND sess.deleted_at IS NULL
  JOIN section s
    ON s.id = COALESCE(sess.section_id, b.section_id)
   AND s.organization_id = (SELECT org_id FROM params)
   AND s.deleted_at IS NULL
   AND s.canceled_at IS NULL
   AND s.is_rec_managed IS FALSE
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at   IS NULL
    AND b.canceled_at  IS NULL
    AND b.status       = 'confirmed'
    AND b.is_fast_track IS NOT TRUE
    [[ AND b.created_at >= {{start_date}}::timestamp ]]
    [[ AND b.created_at < ({{end_date}}::date + interval '1 day') ]]
  GROUP BY 1
),

/* ─── WAITLIST ─── */
waitlist AS (
  SELECT
    COALESCE(w.section_id, sess.section_id) AS section_id,
    COUNT(DISTINCT w.id) AS waitlisted
  FROM waitlist w
  LEFT JOIN "session" sess
    ON sess.id = w.session_id
   AND sess.deleted_at IS NULL
  JOIN section s
    ON s.id = COALESCE(w.section_id, sess.section_id)
  WHERE s.organization_id = (SELECT org_id FROM params)
    AND w.deleted_at  IS NULL
    AND w.canceled_at IS NULL
    AND s.deleted_at  IS NULL
  GROUP BY 1
),

/* ─── REGISTRATION WINDOWS ─── */
reg_window AS (
  SELECT
    rw.section_id,
    MIN(rw.opens_at)  FILTER (WHERE rw.type = 'default')  AS default_opens,
    MIN(rw.closes_at) FILTER (WHERE rw.type = 'default')  AS default_closes,
    MIN(rw.opens_at)  FILTER (WHERE rw.type = 'group')    AS group_opens
  FROM registration_window rw
  WHERE rw.organization_id = (SELECT org_id FROM params)
    AND rw.deleted_at IS NULL
  GROUP BY rw.section_id
),

/* ─── FT USERS (from the shared windowed scan) ─── */
ft_users AS (
  SELECT
    b.customer_user_id                                   AS user_id,
    u.email,
    u.household_id::text                                 AS household_id,
    u.created_at                                         AS user_created_at,
    MIN(b.created_at)                                    AS first_ft_date,
    COUNT(DISTINCT b.id)
      FILTER (WHERE b.canceled_at IS NULL)               AS ft_booking_count
  FROM ft_b b
  JOIN users u ON u.id = b.customer_user_id
  WHERE u.deleted_at IS NULL
    AND (u.email IS NULL OR u.email NOT LIKE 'guest-user+guest-%')
  GROUP BY 1, 2, 3, 4
),

/* ─── FIRST-EVER CONFIRMED BOOKING (FT customers only) ─── */
first_ever_booking AS (
  SELECT
    b.customer_user_id,
    MIN(b.created_at) AS first_booking_date
  FROM booking b
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at   IS NULL
    AND b.canceled_at  IS NULL
    AND b.status       = 'confirmed'
    AND b.customer_user_id IN (SELECT customer_user_id FROM ft_b)
  GROUP BY 1
)

/* ═══════════════════════════════════════════════════════════
   SECTION ROWS
   ═══════════════════════════════════════════════════════════ */
SELECT
  'section'::text                                        AS "Row Type",
  COALESCE(sm.season, 'Unassigned')                      AS "Season",
  c.name                                                 AS "Program",
  sb.section_name                                        AS "Section",
  sb.registration_mode                                   AS "Reg Mode",
  sb.section_id::text                                    AS "Section ID",
  sb.organization_id::text                               AS "Org ID",
  c.id::text                                             AS "Program ID",

  ft.ft_total                                            AS "FT Total",
  ft.ft_converted                                        AS "FT Converted",
  ft.ft_pending                                          AS "FT Pending",
  ft.ft_canceled                                         AS "FT Dropped",
  ft.ft_unique_users                                     AS "FT Families",

  CASE WHEN ft.ft_total = 0 THEN NULL
       ELSE ROUND(100.0 * ft.ft_converted / ft.ft_total, 1)
  END                                                    AS "Conversion %",

  COALESCE(o.organic_enrolled, 0)                        AS "Direct Enrolled",
  (ft.ft_converted + COALESCE(o.organic_enrolled, 0))    AS "Total Enrolled",

  sb.eff_capacity                                        AS "Capacity",
  sb.session_count                                       AS "Sessions",

  CASE WHEN sb.eff_capacity = 0 THEN NULL
       ELSE ROUND(100.0 * (ft.ft_converted + COALESCE(o.organic_enrolled, 0))
                  / sb.eff_capacity, 1)
  END                                                    AS "Fill %",

  CASE WHEN sb.eff_capacity = 0 THEN NULL
       ELSE ROUND(100.0 * ft.ft_total / sb.eff_capacity, 1)
  END                                                    AS "Demand %",

  COALESCE(wl.waitlisted, 0)                             AS "Waitlisted",

  ft.earliest_ft::date                                   AS "First FT",
  ft.latest_ft::date                                     AS "Last FT",

  sb.publish_at                                          AS "Publish Date",
  rw.default_opens                                       AS "Reg Opens",
  rw.default_closes                                      AS "Reg Closes",
  rw.group_opens                                         AS "Early Access Opens",
  CASE
    WHEN sb.publish_at IS NULL                   THEN 'draft'
    WHEN sb.publish_at > now()                   THEN 'scheduled'
    WHEN rw.default_opens IS NULL                THEN 'published'
    /* EARLY ACCESS IS ITS OWN PHASE (2026-08-28). A group window that has opened
       means some families can register while others cannot yet. Calling that
       'pipeline' says registration has not started, which is false for everyone
       in the group; calling it 'open' hides that a second phase is still to
       come. Fast Track sections routinely have both. */
    WHEN rw.group_opens IS NOT NULL
      AND rw.group_opens <= now()
      AND rw.default_opens > now()               THEN 'early-access'
    WHEN rw.default_opens > now()                THEN 'pipeline'
    WHEN rw.default_closes IS NULL
      OR rw.default_closes >= now()              THEN 'open'
    ELSE 'closed'
  END                                                    AS "Reg Status",

  sb.section_start                                       AS "Section Start",
  sb.section_end                                         AS "Section End",
  sb.section_day                                         AS "Section Day",
  sb.section_time                                        AS "Section Time",

  COALESCE(ft.ft_rev, 0)                                AS "FT Revenue",
  COALESCE(sp.price, 0) / 100.0                         AS "Section Price",

  CASE WHEN ft.ft_pending > 0 AND sp.price > 0
       THEN ROUND(ft.ft_pending * sp.price / 100.0, 2)
       ELSE 0
  END                                                    AS "Left on Table",

  CASE WHEN ft.ft_total > sb.eff_capacity
       AND sb.eff_capacity > 0
       AND sp.price > 0
       THEN ROUND((ft.ft_total - sb.eff_capacity) * sp.price / 100.0, 2)
       ELSE 0
  END                                                    AS "Over Demand $",

  NULL::text                                             AS "User Email",
  NULL::text                                             AS "User HH ID",
  NULL::date                                             AS "First FT Date",
  NULL::date                                             AS "User Created At",
  NULL::date                                             AS "First Any Booking",
  NULL::int                                              AS "FT Booking Count",

  NULL::date                                             AS "Signup Date",
  NULL::bigint                                           AS "Daily FT",
  NULL::bigint                                           AS "Cumulative FT",

  NULL::text                                             AS "User ID",
  NULL::text                                             AS "User Name",
  NULL::text                                             AS "Participant Name",
  NULL::text                                             AS "FT Status"

FROM ft_rollup ft
JOIN section_base sb    ON sb.section_id = ft.section_id
JOIN program c          ON c.id = sb.program_id AND c.deleted_at IS NULL
LEFT JOIN season_map sm ON sm.section_id = sb.section_id
LEFT JOIN organic o     ON o.section_id  = sb.section_id
LEFT JOIN waitlist wl   ON wl.section_id = sb.section_id
LEFT JOIN reg_window rw ON rw.section_id = sb.section_id
LEFT JOIN LATERAL (SELECT (sec.pricing_policy->'default'->>'cents')::int AS price
                   FROM section sec WHERE sec.id = sb.section_id) sp ON TRUE

UNION ALL

/* ═══════════════════════════════════════════════════════════
   PIPELINE ROWS (published, reg not open, no FT yet)
   ═══════════════════════════════════════════════════════════ */
SELECT
  'pipeline'::text                                       AS "Row Type",
  COALESCE(sm.season, 'Unassigned')                      AS "Season",
  c.name                                                 AS "Program",
  sb.section_name                                        AS "Section",
  sb.registration_mode                                   AS "Reg Mode",
  sb.section_id::text                                    AS "Section ID",
  sb.organization_id::text                               AS "Org ID",
  c.id::text                                             AS "Program ID",

  0                                                      AS "FT Total",
  0                                                      AS "FT Converted",
  0                                                      AS "FT Pending",
  0                                                      AS "FT Dropped",
  0                                                      AS "FT Families",
  NULL::numeric                                          AS "Conversion %",

  COALESCE(o.organic_enrolled, 0)                        AS "Direct Enrolled",
  COALESCE(o.organic_enrolled, 0)                        AS "Total Enrolled",

  sb.eff_capacity                                        AS "Capacity",
  sb.session_count                                       AS "Sessions",

  CASE WHEN sb.eff_capacity = 0 THEN NULL
       ELSE ROUND(100.0 * COALESCE(o.organic_enrolled, 0) / sb.eff_capacity, 1)
  END                                                    AS "Fill %",

  0::numeric                                             AS "Demand %",

  COALESCE(wl.waitlisted, 0)                             AS "Waitlisted",

  NULL::date                                             AS "First FT",
  NULL::date                                             AS "Last FT",

  sb.publish_at                                          AS "Publish Date",
  rw.default_opens                                       AS "Reg Opens",
  rw.default_closes                                      AS "Reg Closes",
  rw.group_opens                                         AS "Early Access Opens",
  CASE
    /* Same rule as the main branch — this arm is sections with no Fast Track
       interest, and the two must agree or one section reads two ways depending
       on which side of the UNION it came down. */
    WHEN rw.group_opens IS NOT NULL
      AND rw.group_opens <= now()                THEN 'early-access'
    WHEN rw.default_opens > now()                THEN 'pipeline'
    WHEN sb.publish_at > now()                   THEN 'scheduled'
    ELSE 'upcoming'
  END                                                    AS "Reg Status",

  sb.section_start                                       AS "Section Start",
  sb.section_end                                         AS "Section End",
  sb.section_day                                         AS "Section Day",
  sb.section_time                                        AS "Section Time",

  0                                                      AS "FT Revenue",
  COALESCE(sp.price, 0) / 100.0                         AS "Section Price",
  0                                                      AS "Left on Table",
  0                                                      AS "Over Demand $",

  NULL::text                                             AS "User Email",
  NULL::text                                             AS "User HH ID",
  NULL::date                                             AS "First FT Date",
  NULL::date                                             AS "User Created At",
  NULL::date                                             AS "First Any Booking",
  NULL::int                                              AS "FT Booking Count",

  NULL::date                                             AS "Signup Date",
  NULL::bigint                                           AS "Daily FT",
  NULL::bigint                                           AS "Cumulative FT",

  NULL::text                                             AS "User ID",
  NULL::text                                             AS "User Name",
  NULL::text                                             AS "Participant Name",
  NULL::text                                             AS "FT Status"

FROM section_base sb
JOIN program c          ON c.id = sb.program_id AND c.deleted_at IS NULL
JOIN reg_window rw      ON rw.section_id = sb.section_id
LEFT JOIN season_map sm ON sm.section_id = sb.section_id
LEFT JOIN organic o     ON o.section_id  = sb.section_id
LEFT JOIN waitlist wl   ON wl.section_id = sb.section_id
LEFT JOIN ft_rollup ft  ON ft.section_id = sb.section_id
LEFT JOIN LATERAL (SELECT (sec.pricing_policy->'default'->>'cents')::int AS price
                   FROM section sec WHERE sec.id = sb.section_id) sp ON TRUE
WHERE sb.publish_at IS NOT NULL
  AND sb.publish_at <= now()
  AND rw.default_opens > now()
  AND ft.section_id IS NULL

UNION ALL

/* ═══════════════════════════════════════════════════════════
   FT DAILY ROWS (for fill-rate curve)
   ═══════════════════════════════════════════════════════════ */
SELECT
  'ft_daily'::text                                       AS "Row Type",
  COALESCE(sm.season, 'Unassigned')                      AS "Season",
  c.name                                                 AS "Program",
  sb.section_name                                        AS "Section",
  sb.registration_mode                                   AS "Reg Mode",
  sb.section_id::text                                    AS "Section ID",
  sb.organization_id::text                               AS "Org ID",
  c.id::text                                             AS "Program ID",

  NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
  NULL::numeric,
  NULL::bigint, NULL::bigint,
  NULL::int, NULL::bigint,
  NULL::numeric, NULL::numeric,
  NULL::bigint,
  NULL::date, NULL::date,
  NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
  NULL::text,
  NULL::date, NULL::date, NULL::text, NULL::text,
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
  NULL::text, NULL::text, NULL::date, NULL::date, NULL::date, NULL::int,

  fd.signup_date                                         AS "Signup Date",
  fd.daily_signups                                       AS "Daily FT",
  fd.cumulative_signups                                  AS "Cumulative FT",

  NULL::text                                             AS "User ID",
  NULL::text                                             AS "User Name",
  NULL::text                                             AS "Participant Name",
  NULL::text                                             AS "FT Status"

FROM ft_daily fd
JOIN section_base sb    ON sb.section_id = fd.section_id
JOIN program c          ON c.id = sb.program_id AND c.deleted_at IS NULL
LEFT JOIN season_map sm ON sm.section_id = sb.section_id

UNION ALL

/* ═══════════════════════════════════════════════════════════
   USER ROWS (per-FT-customer, for demographics)
   ═══════════════════════════════════════════════════════════ */
SELECT
  'user'::text                                           AS "Row Type",
  NULL, NULL, NULL, NULL,
  NULL::text, NULL::text, NULL::text,
  NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
  NULL::numeric,
  NULL::bigint, NULL::bigint,
  NULL::int, NULL::bigint,
  NULL::numeric, NULL::numeric,
  NULL::bigint,
  NULL::date, NULL::date,
  NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
  NULL::text,
  NULL::date, NULL::date, NULL::text, NULL::text,
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,

  fu.email                                               AS "User Email",
  fu.household_id                                        AS "User HH ID",
  fu.first_ft_date::date                                 AS "First FT Date",
  fu.user_created_at::date                               AS "User Created At",
  feb.first_booking_date::date                           AS "First Any Booking",
  fu.ft_booking_count::int                               AS "FT Booking Count",

  NULL::date, NULL::bigint, NULL::bigint,

  NULL::text                                             AS "User ID",
  NULL::text                                             AS "User Name",
  NULL::text                                             AS "Participant Name",
  NULL::text                                             AS "FT Status"

FROM ft_users fu
LEFT JOIN first_ever_booking feb
  ON feb.customer_user_id = fu.user_id

UNION ALL

/* ═══════════════════════════════════════════════════════════
   FT BOOKING ROWS (one row per non-canceled FT booking; the
   individual customers who fast-tracked each section)
   ═══════════════════════════════════════════════════════════ */
SELECT
  'ft_booking'::text                                     AS "Row Type",
  COALESCE(sm.season, 'Unassigned')                      AS "Season",
  c.name                                                 AS "Program",
  sb.section_name                                        AS "Section",
  sb.registration_mode                                   AS "Reg Mode",
  sb.section_id::text                                    AS "Section ID",
  sb.organization_id::text                               AS "Org ID",
  c.id::text                                             AS "Program ID",

  NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
  NULL::numeric,
  NULL::bigint, NULL::bigint,
  NULL::int, NULL::bigint,
  NULL::numeric, NULL::numeric,
  NULL::bigint,
  NULL::date, NULL::date,
  NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
  NULL::text,
  NULL::date, NULL::date, NULL::text, NULL::text,
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,

  cu.email                                               AS "User Email",
  cu.household_id::text                                  AS "User HH ID",
  NULL::date                                             AS "First FT Date",
  NULL::date                                             AS "User Created At",
  NULL::date                                             AS "First Any Booking",
  NULL::int                                              AS "FT Booking Count",

  fr.ft_created_at::date                                 AS "Signup Date",
  NULL::bigint                                           AS "Daily FT",
  NULL::bigint                                           AS "Cumulative FT",

  fr.customer_user_id::text                              AS "User ID",
  NULLIF(TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')), '')  AS "User Name",
  NULLIF(TRIM(COALESCE(pu.first_name,'') || ' ' || COALESCE(pu.last_name,'')), '')  AS "Participant Name",
  CASE WHEN fr.status = 'confirmed' THEN 'Converted' ELSE 'Pending' END             AS "FT Status"

FROM ft_raw fr
JOIN section_base sb    ON sb.section_id = fr.section_id
JOIN program c          ON c.id = sb.program_id AND c.deleted_at IS NULL
LEFT JOIN season_map sm ON sm.section_id = sb.section_id
JOIN users cu           ON cu.id = fr.customer_user_id AND cu.deleted_at IS NULL
LEFT JOIN users pu      ON pu.id = fr.participant_user_id AND pu.deleted_at IS NULL
WHERE fr.canceled_at IS NULL
  AND (cu.email IS NULL OR cu.email NOT LIKE 'guest-user+guest-%')

ORDER BY 1 ASC, 2 ASC, 3 ASC, 9 DESC, 4 ASC
