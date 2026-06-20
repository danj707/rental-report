-- ═══════════════════════════════════════════════════════════════════
-- FAST TRACK REPORT  (v6 — registration pipeline + status)
--
-- FT bookings promote in-place: planned → confirmed, is_fast_track
-- stays TRUE.  Conversion = confirmed FT / total FT.
--
-- v5 adds: UNION ALL user-level rows for Community Intelligence
--   crossover — each FT user's email, household, first FT date,
--   account creation date, and first-ever booking date.
--   Enables first-touch acquisition detection client-side.
--
-- v6 adds: Registration pipeline status per section.
--   Joins section.publish_at and registration_window to classify
--   each section as: draft / scheduled / pipeline / open / closed.
--   "Pipeline" = published + reg not yet open — the presale window
--   where FT wishlists accumulate before registration goes live.
--   Also surfaces early-access (group) registration dates.
--
-- Variables: {{org_id}} Text
-- ═══════════════════════════════════════════════════════════════════

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

/* ─── SESSION CAPACITY (correct denominator for per-session programs) ─── */
session_cap AS (
  SELECT
    sess.section_id,
    COUNT(DISTINCT sess.id)                              AS session_count,
    SUM(COALESCE(sess.capacity, s.capacity, 0))::int     AS total_seat_capacity
  FROM "session" sess
  JOIN section s ON s.id = sess.section_id
  WHERE s.organization_id = (SELECT org_id FROM params)
    AND sess.deleted_at IS NULL
    AND s.deleted_at    IS NULL
    AND s.is_rec_managed IS FALSE
  GROUP BY 1
),

/* ─── ALL FAST TRACK BOOKINGS (session + section, any status) ─── */
ft_raw AS (
  SELECT
    COALESCE(sess.section_id, b.section_id) AS section_id,
    b.id          AS booking_id,
    b.status,
    b.type        AS booking_type,
    b.created_at  AS ft_created_at,
    b.canceled_at
  FROM booking b
  LEFT JOIN "session" sess
    ON sess.id = b.session_id
   AND sess.deleted_at IS NULL
  JOIN section s
    ON s.id = COALESCE(sess.section_id, b.section_id)
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at    IS NULL
    AND b.is_fast_track  = TRUE
    AND s.deleted_at    IS NULL
    AND s.is_rec_managed IS FALSE
),

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
    MAX(ft_created_at)                                  AS latest_ft
  FROM ft_raw
  GROUP BY 1
),

/* ─── NON-FT ENROLLMENTS (organic / direct registrations) ─── */
organic AS (
  SELECT
    COALESCE(sess.section_id, b.section_id) AS section_id,
    COUNT(DISTINCT b.id) AS organic_enrolled
  FROM booking b
  LEFT JOIN "session" sess
    ON sess.id = b.session_id
   AND sess.deleted_at IS NULL
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at   IS NULL
    AND b.canceled_at  IS NULL
    AND b.status       = 'confirmed'
    AND b.is_fast_track IS NOT TRUE
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

/* ─── v6: REGISTRATION WINDOWS (section-level for both reg modes) ─── */
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

/* ═══ v5 additions ═══════════════════════════════════════════════ */

/* ─── FT USERS (per-user aggregation for CI crossover) ─── */
ft_users AS (
  SELECT
    b.customer_user_id                                   AS user_id,
    u.email,
    u.household_id::text                                 AS household_id,
    u.created_at                                         AS user_created_at,
    MIN(b.created_at)                                    AS first_ft_date,
    COUNT(DISTINCT b.id)
      FILTER (WHERE b.canceled_at IS NULL)               AS ft_booking_count
  FROM booking b
  JOIN users u ON u.id = b.customer_user_id
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at    IS NULL
    AND b.is_fast_track  = TRUE
    AND u.deleted_at    IS NULL
    AND u.email NOT LIKE 'guest-user+guest-%'
  GROUP BY 1, 2, 3, 4
),

/* ─── FIRST-EVER CONFIRMED BOOKING per user (FT or not) ─── */
first_ever_booking AS (
  SELECT
    b.customer_user_id,
    MIN(b.created_at) AS first_booking_date
  FROM booking b
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at   IS NULL
    AND b.canceled_at  IS NULL
    AND b.status       = 'confirmed'
  GROUP BY 1
)

/* ─── FINAL OUTPUT: section rows ─── */
SELECT
  'section'::text                                        AS "Row Type",
  COALESCE(sm.season, 'Unassigned')                      AS "Season",
  c.name                                                 AS "Program",
  s.name                                                 AS "Section",
  s.registration_mode                                    AS "Reg Mode",

  ft.ft_total                                            AS "FT Signups",
  ft.ft_converted                                        AS "FT Converted",
  ft.ft_pending                                          AS "FT Pending",
  ft.ft_canceled                                         AS "FT Dropped",

  CASE WHEN ft.ft_total = 0 THEN NULL
       ELSE ROUND(100.0 * ft.ft_converted / ft.ft_total, 1)
  END                                                    AS "Conversion %",

  COALESCE(o.organic_enrolled, 0)                        AS "Direct Enrolled",
  (ft.ft_converted + COALESCE(o.organic_enrolled, 0))    AS "Total Enrolled",

  CASE WHEN s.registration_mode = 'per-session'
       THEN COALESCE(sc.total_seat_capacity, 0)
       ELSE COALESCE(s.capacity, 0)
  END                                                    AS "Capacity",

  COALESCE(sc.session_count, 0)                          AS "Sessions",

  CASE WHEN (
         CASE WHEN s.registration_mode = 'per-session'
              THEN COALESCE(sc.total_seat_capacity, 0)
              ELSE COALESCE(s.capacity, 0)
         END
       ) = 0 THEN NULL
       ELSE ROUND(
         100.0 * (ft.ft_converted + COALESCE(o.organic_enrolled, 0))
         / (CASE WHEN s.registration_mode = 'per-session'
                 THEN sc.total_seat_capacity
                 ELSE s.capacity END), 1)
  END                                                    AS "Fill %",

  CASE WHEN (
         CASE WHEN s.registration_mode = 'per-session'
              THEN COALESCE(sc.total_seat_capacity, 0)
              ELSE COALESCE(s.capacity, 0)
         END
       ) = 0 THEN NULL
       ELSE ROUND(
         100.0 * ft.ft_total
         / (CASE WHEN s.registration_mode = 'per-session'
                 THEN sc.total_seat_capacity
                 ELSE s.capacity END), 1)
  END                                                    AS "Demand %",

  COALESCE(wl.waitlisted, 0)                             AS "Waitlisted",

  ft.earliest_ft::date                                   AS "First FT Signup",
  ft.latest_ft::date                                     AS "Last FT Signup",

  -- v6: Registration pipeline columns
  s.publish_at                                           AS "Publish Date",
  rw.default_opens                                       AS "Reg Opens",
  rw.default_closes                                      AS "Reg Closes",
  rw.group_opens                                         AS "Early Access Opens",
  CASE
    WHEN s.publish_at IS NULL                    THEN 'draft'
    WHEN s.publish_at > now()                    THEN 'scheduled'
    WHEN rw.default_opens IS NULL                THEN 'published'
    WHEN rw.default_opens > now()                THEN 'pipeline'
    WHEN rw.default_closes IS NULL
      OR rw.default_closes >= now()              THEN 'open'
    ELSE 'closed'
  END                                                    AS "Reg Status",

  -- v5 user columns (NULL for section rows)
  NULL::text                                             AS "User Email",
  NULL::text                                             AS "User HH ID",
  NULL::date                                             AS "First FT Date",
  NULL::date                                             AS "User Created At",
  NULL::date                                             AS "First Any Booking",
  NULL::int                                              AS "FT Booking Count"

FROM ft_rollup ft
JOIN section s          ON s.id  = ft.section_id
JOIN class c            ON c.id  = s.class_id
LEFT JOIN season_map sm ON sm.section_id = s.id
LEFT JOIN session_cap sc ON sc.section_id = s.id
LEFT JOIN organic o     ON o.section_id  = s.id
LEFT JOIN waitlist wl   ON wl.section_id = s.id
LEFT JOIN reg_window rw ON rw.section_id = s.id

UNION ALL

/* ─── USER ROWS (one per FT customer, for CI first-touch analysis) ─── */
SELECT
  'user'::text                                           AS "Row Type",
  NULL                                                   AS "Season",
  NULL                                                   AS "Program",
  NULL                                                   AS "Section",
  NULL                                                   AS "Reg Mode",
  NULL::bigint                                           AS "FT Signups",
  NULL::bigint                                           AS "FT Converted",
  NULL::bigint                                           AS "FT Pending",
  NULL::bigint                                           AS "FT Dropped",
  NULL::numeric                                          AS "Conversion %",
  NULL::bigint                                           AS "Direct Enrolled",
  NULL::bigint                                           AS "Total Enrolled",
  NULL::int                                              AS "Capacity",
  NULL::bigint                                           AS "Sessions",
  NULL::numeric                                          AS "Fill %",
  NULL::numeric                                          AS "Demand %",
  NULL::bigint                                           AS "Waitlisted",
  NULL::date                                             AS "First FT Signup",
  NULL::date                                             AS "Last FT Signup",

  -- v6 pipeline columns (NULL for user rows)
  NULL::timestamptz                                      AS "Publish Date",
  NULL::timestamptz                                      AS "Reg Opens",
  NULL::timestamptz                                      AS "Reg Closes",
  NULL::timestamptz                                      AS "Early Access Opens",
  NULL::text                                             AS "Reg Status",

  fu.email                                               AS "User Email",
  fu.household_id                                        AS "User HH ID",
  fu.first_ft_date::date                                 AS "First FT Date",
  fu.user_created_at::date                               AS "User Created At",
  feb.first_booking_date::date                           AS "First Any Booking",
  fu.ft_booking_count::int                               AS "FT Booking Count"

FROM ft_users fu
LEFT JOIN first_ever_booking feb
  ON feb.customer_user_id = fu.user_id

ORDER BY 1 ASC, 2 ASC, 3 ASC, 6 DESC, 4 ASC
