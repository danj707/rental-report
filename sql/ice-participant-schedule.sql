/* ============================================================
   ICE PARTICIPANT CALENDAR — data card (Metabase 18052,
   public UUID 6f02d09d-6694-462f-9471-7a4cb8b90d01)
   Grain: 1 row per PARTICIPANT per SESSION
   Ice Hockey + Ice Skating, current + confirmed, non-rec-managed
   Column aliases match ice-calendar.html normalizeRow()
   Two marked edit points: [FACILITY SOURCE] and [CHIP LABEL]

   2026-08-22 — BROKEN, then fixed: the whole card was returning
   HTTP 400 (error_type invalid-query) for every request, because
   the product dropped the `class` model. Postgres said:
       ERROR: relation "class" does not exist
   `class` and `class_activity` are gone; `section.class_id` with
   them. The replacement is `section.program_id -> program`, joined
   to the (unchanged) `activity` table through `program_activity`.
   `section.program_id` even carries the pg comment "Program this
   section belongs to (newer model replacing class_id)".
   Verified: 1,328 rows for Apex, August 2026.
   ============================================================ */
SELECT DISTINCT
  org.name AS "Org Name",
  b.participant_user_id AS "Participant Id",          -- hidden key for the dropdown
  u_part.first_name || ' ' || u_part.last_name AS "Reservee",
  COALESCE(NULLIF(u_part.email, ''), u_parent.email) AS "Email",
  TO_CHAR((ses.starts_at AT TIME ZONE tzc.tz)::date, 'YYYY-MM-DD') AS "Date",
  TRIM(TO_CHAR(ses.starts_at AT TIME ZONE tzc.tz, 'Day')) AS "Day",
  TO_CHAR(ses.starts_at AT TIME ZONE tzc.tz, 'HH12:MIam') AS "Start",
  TO_CHAR(ses.ends_at   AT TIME ZONE tzc.tz, 'HH12:MIam') AS "End",
  loc.name    AS "Location",     -- [FACILITY SOURCE] drives chip color + PDF legend
  section.name AS "Site",        -- [CHIP LABEL] text shown on the chip
  section.name AS "Purpose"      -- shown in the day-detail popover
FROM booking b
JOIN organization org
  ON org.id = b.organization_id
CROSS JOIN LATERAL (
  SELECT (org.config #>> '{general,primaryTimezone}')::text AS tz
) tzc
JOIN users u_parent
  ON u_parent.id = b.customer_user_id
JOIN users u_part
  ON u_part.id = b.participant_user_id
/* Expand to real sessions: session-bookings → their session;
   section-bookings → every session in the section */
JOIN "session" ses
  ON (
       (b.session_id IS NOT NULL AND ses.id = b.session_id)
    OR (b.session_id IS NULL     AND ses.section_id = b.section_id)
     )
 AND ses.deleted_at IS NULL
JOIN section
  ON section.id = ses.section_id
 AND section.deleted_at IS NULL
LEFT JOIN location loc
  ON loc.id = ses.location_id      -- [FACILITY SOURCE]: session location = the rink
/* Activity gate. Was class -> class_activity -> activity until the
   `class` model was dropped; now program -> program_activity -> activity. */
JOIN program prog
  ON prog.id = section.program_id
 AND prog.deleted_at IS NULL
JOIN program_activity pa
  ON pa.program_id = prog.id
 AND pa.deleted_at IS NULL
JOIN activity a
  ON a.id = pa.activity_id
 AND a.deleted_at IS NULL
WHERE 1=1
  AND b.organization_id = 'aeba47d0-c97f-49cb-a0e9-93c5af3a68fa'
  AND b.type IN ('session', 'section')
  AND b.deleted_at IS NULL
  AND b.canceled_at IS NULL
  AND b.status = 'confirmed'
  AND section.is_rec_managed IS FALSE
  AND a.name IN ('Ice Hockey', 'Ice Skating')
[[ AND (ses.starts_at AT TIME ZONE tzc.tz)::date >= {{start_date}}::date ]]
  [[ AND (ses.starts_at AT TIME ZONE tzc.tz)::date <= {{end_date}}::date ]]
ORDER BY
  "Reservee", "Date", "Start";
