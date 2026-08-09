-- v16 2026-08-09: COLD-PERFORMANCE optimization (output identical to v15).
--   The v15 card ran ~1.3s warm but timed out COLD for large orgs (Apex:
--   ~46K rows, ~170K random index probes) — Postgres killed it with
--   "canceling statement due to statement timeout", so the app served stale
--   cache and the report showed zeros. Three output-preserving changes remove
--   the dominant cold cost (per-booking user/section probes):
--     1. ft_users  — aggregate bookings first, join users ONCE per distinct
--        customer (was 1 users probe per FT booking: ~41.6K → ~3.3K).
--     2. ft_person — resolve customer/participant identity for the ft_booking
--        rows via one users scan + hash lookups (was 2 users probes per FT
--        booking: ~75K → hash).
--     3. first_ever_booking — scope to FT customers only (was a full-org
--        confirmed-booking scan).
--   No row types, columns, filters, or aggregates change — verified row-for-row
--   equivalent to card 17300 for apex + westsacramento before shipping.
-- NOTE: API updates reset template-tag types — re-set Start/End Date to type Date in the UI.
/* ============================================================
   FAST TRACK REPORT  (v16 — cold-optimized v15)

   Row types (unchanged from v15):
     section    — one row per section that has FT bookings
     pipeline   — published, reg-not-open, no FT yet
     ft_daily   — one row per section per FT-signup day (fill-rate curve)
     user       — one row per FT customer (demographics)
     ft_booking — one row per non-canceled FT booking (customer drill-down)
   ============================================================ */

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

/* ─── SECTION BASE (capacity + schedule in one pass) ─── */
section_base AS (
  SELECT
    s.id                                                 AS section_id,
    s.class_id,
    s.name                                               AS section_name,
    s.registration_mode,
    s.capacity                                           AS section_capacity,
    s.publish_at,
    s.organization_id,
    CASE WHEN s.registration_mode = 'per-session'
         THEN COALESCE(sc.total_seat_capacity, 0)
         ELSE COALESCE(s.capacity, 0)
    END                                                  AS eff_capacity,
    COALESCE(sc.session_count, 0)                        AS session_count,
    sch.section_start,
    sch.section_end,
    sch.section_day,
    sch.section_time
  FROM section s
  LEFT JOIN (
    SELECT
      sess.section_id,
      COUNT(DISTINCT sess.id)                            AS session_count,
      SUM(COALESCE(sess.capacity, sec.capacity, 0))::int AS total_seat_capacity
    FROM "session" sess
    JOIN section sec ON sec.id = sess.section_id
    WHERE sec.organization_id = (SELECT org_id FROM params)
      AND sess.deleted_at  IS NULL
      AND sess.canceled_at IS NULL
      AND sec.deleted_at   IS NULL
      AND sec.canceled_at  IS NULL
      AND sec.is_rec_managed IS FALSE
    GROUP BY 1
  ) sc ON sc.section_id = s.id
  LEFT JOIN (
    SELECT DISTINCT ON (sess.section_id)
      sess.section_id,
      MIN(sess.starts_at) OVER (PARTITION BY sess.section_id)::date AS section_start,
      MAX(sess.starts_at) OVER (PARTITION BY sess.section_id)::date AS section_end,
      to_char(sess.starts_at, 'Dy')                                 AS section_day,
      to_char(sess.starts_at, 'HH12:MIam') || chr(8211) || to_char(sess.ends_at, 'HH12:MIam') AS section_time
    FROM "session" sess
    JOIN section sec ON sec.id = sess.section_id
    WHERE sec.organization_id = (SELECT org_id FROM params)
      AND sess.deleted_at IS NULL
      AND sec.deleted_at  IS NULL
      AND sec.canceled_at IS NULL
      AND sec.is_rec_managed IS FALSE
    ORDER BY sess.section_id, sess.starts_at
  ) sch ON sch.section_id = s.id
  WHERE s.organization_id = (SELECT org_id FROM params)
    AND s.deleted_at IS NULL
    AND s.canceled_at IS NULL
    AND s.is_rec_managed IS FALSE
),

/* ─── FT PAYMENT TOTALS (pre-aggregated, one scan) ─── */
ft_payments AS (
  SELECT
    oi.booking_id,
    SUM(oit.amount) AS paid_cents
  FROM order_item_transaction oit
  JOIN order_item oi
    ON oi.id = oit.order_item_id
   AND oi.parent_order_item_id IS NULL
   AND oi.deleted_at IS NULL
   AND oi.organization_id = (SELECT org_id FROM params)
  JOIN booking b
    ON b.id = oi.booking_id
   AND b.organization_id = (SELECT org_id FROM params)
   AND b.deleted_at IS NULL
   AND b.is_fast_track = TRUE
   AND b.status = 'confirmed'
   AND b.canceled_at IS NULL
  WHERE oit.payment_id IS NOT NULL
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
  FROM booking b
  LEFT JOIN "session" sess
    ON sess.id = b.session_id
   AND sess.deleted_at IS NULL
  JOIN section s
    ON s.id = COALESCE(sess.section_id, b.section_id)
   AND s.organization_id = (SELECT org_id FROM params)
   AND s.canceled_at IS NULL
  LEFT JOIN ft_payments fp ON fp.booking_id = b.id
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at    IS NULL
    AND b.is_fast_track  = TRUE
    AND s.deleted_at    IS NULL
    AND s.is_rec_managed IS FALSE
    [[ AND b.created_at >= {{start_date}}::timestamp ]]
    [[ AND b.created_at < ({{end_date}}::date + interval '1 day') ]]
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

/* ─── FT BOOKING AGGREGATES PER CUSTOMER (v16: booking-side only, no users join) ─── */
ft_user_agg AS (
  SELECT
    b.customer_user_id                                   AS user_id,
    MIN(b.created_at)                                    AS first_ft_date,
    COUNT(DISTINCT b.id)
      FILTER (WHERE b.canceled_at IS NULL)               AS ft_booking_count
  FROM booking b
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at    IS NULL
    AND b.is_fast_track  = TRUE
    [[ AND b.created_at >= {{start_date}}::timestamp ]]
    [[ AND b.created_at < ({{end_date}}::date + interval '1 day') ]]
  GROUP BY 1
),

/* ─── FT USERS (v16: join users ONCE per distinct customer, not per booking) ─── */
ft_users AS (
  SELECT
    a.user_id,
    u.email,
    u.household_id::text                                 AS household_id,
    u.created_at                                         AS user_created_at,
    a.first_ft_date,
    a.ft_booking_count
  FROM ft_user_agg a
  JOIN users u ON u.id = a.user_id
  WHERE u.deleted_at IS NULL
    AND (u.email IS NULL OR u.email NOT LIKE 'guest-user+guest-%')
),

/* ─── FIRST-EVER CONFIRMED BOOKING (v16: scoped to FT customers) ─── */
first_ever_booking AS (
  SELECT
    b.customer_user_id,
    MIN(b.created_at) AS first_booking_date
  FROM booking b
  WHERE b.organization_id = (SELECT org_id FROM params)
    AND b.deleted_at   IS NULL
    AND b.canceled_at  IS NULL
    AND b.status       = 'confirmed'
    AND b.customer_user_id IN (SELECT user_id FROM ft_user_agg)
  GROUP BY 1
),

/* ─── FT PERSON IDENTITY (v16: one users scan for the ft_booking rows) ─── */
ft_person AS (
  SELECT
    u.id                                                 AS user_id,
    u.email,
    u.household_id::text                                 AS household_id,
    NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS full_name,
    u.deleted_at
  FROM users u
  WHERE u.id IN (
    SELECT customer_user_id    FROM ft_raw WHERE canceled_at IS NULL
    UNION
    SELECT participant_user_id FROM ft_raw WHERE canceled_at IS NULL AND participant_user_id IS NOT NULL
  )
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
JOIN class c            ON c.id = sb.class_id AND c.deleted_at IS NULL
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
JOIN class c            ON c.id = sb.class_id AND c.deleted_at IS NULL
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
JOIN class c            ON c.id = sb.class_id AND c.deleted_at IS NULL
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
  cu.household_id                                        AS "User HH ID",
  NULL::date                                             AS "First FT Date",
  NULL::date                                             AS "User Created At",
  NULL::date                                             AS "First Any Booking",
  NULL::int                                              AS "FT Booking Count",

  fr.ft_created_at::date                                 AS "Signup Date",
  NULL::bigint                                           AS "Daily FT",
  NULL::bigint                                           AS "Cumulative FT",

  fr.customer_user_id::text                              AS "User ID",
  cu.full_name                                           AS "User Name",
  pu.full_name                                           AS "Participant Name",
  CASE WHEN fr.status = 'confirmed' THEN 'Converted' ELSE 'Pending' END             AS "FT Status"

FROM ft_raw fr
JOIN section_base sb    ON sb.section_id = fr.section_id
JOIN class c            ON c.id = sb.class_id AND c.deleted_at IS NULL
LEFT JOIN season_map sm ON sm.section_id = sb.section_id
JOIN ft_person cu       ON cu.user_id = fr.customer_user_id AND cu.deleted_at IS NULL
LEFT JOIN ft_person pu  ON pu.user_id = fr.participant_user_id AND pu.deleted_at IS NULL
WHERE fr.canceled_at IS NULL
  AND (cu.email IS NULL OR cu.email NOT LIKE 'guest-user+guest-%')

ORDER BY 1 ASC, 2 ASC, 3 ASC, 9 DESC, 4 ASC
