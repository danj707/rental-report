-- 2026-08-10 TABLE-DROP MIGRATION: class/class_activity are being dropped
-- (replaced by program/program_activity, same UUIDs; section.program_id is
-- populated 1:1 with section.class_id). This file is the live card SQL with
-- ONLY that mechanical rename applied - no logic or output changes.
-- ═══════════════════════════════════════════════════════════════════
-- PROGRAM PARTICIPANT DEMOGRAPHICS  (v4 — audit fixes)
--
-- Changes from v3:
-- - Added org_id to program_activity_map, section, program joins
-- - Added deleted_at checks on users part, program c
-- ═══════════════════════════════════════════════════════════════════
WITH params AS (
  SELECT {{org_id}}::uuid AS org_id
),
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
program_activity_map AS (
  SELECT DISTINCT ON (ca.program_id)
         ca.program_id,
         act.name AS activity_name
  FROM program_activity ca
  JOIN activity act ON act.id = ca.activity_id
    AND act.organization_id = (SELECT org_id FROM params)
    AND act.deleted_at IS NULL
  WHERE ca.deleted_at IS NULL
  ORDER BY ca.program_id, act.name
)
SELECT
  c.name                                                 AS "Program",
  s.name                                                 AS "Section",
  COALESCE(cam.activity_name, 'Uncategorized')           AS "Activity",
  COALESCE(sm.season, 'Unassigned')                      AS "Season",
  s.registration_mode                                    AS "Reg Mode",
  COALESCE(b.participant_user_id, b.customer_user_id)::text AS "Participant ID",
  part.first_name                                        AS "First Name",
  part.last_name                                         AS "Last Name",
  part.email                                             AS "Participant Email",
  p.date_of_birth::date                                  AS "Date of Birth",
  CASE WHEN p.date_of_birth IS NOT NULL
       THEN EXTRACT(YEAR FROM age(CURRENT_DATE, p.date_of_birth))::int
  END                                                    AS "Age",
  p.gender                                               AS "Gender",
  p.grade                                                AS "Grade",
  payer.household_id::text                               AS "Household ID",
  payer.city                                             AS "City",
  payer.state                                            AS "State",
  payer.zip_code                                         AS "Zip Code",
  b.created_at::date                                     AS "Enrolled Date",
  b.is_fast_track                                        AS "Is FT"
FROM booking b
LEFT JOIN "session" sess
  ON sess.id = b.session_id
 AND sess.deleted_at IS NULL
 AND sess.organization_id = (SELECT org_id FROM params)
JOIN section s
  ON s.id = COALESCE(sess.section_id, b.section_id)
 AND s.organization_id = (SELECT org_id FROM params)
 AND s.deleted_at IS NULL
JOIN program c
  ON c.id = s.program_id
 AND c.deleted_at IS NULL
LEFT JOIN program_activity_map cam
  ON cam.program_id = c.id
LEFT JOIN season_map sm
  ON sm.section_id = s.id
JOIN users part
  ON part.id = COALESCE(b.participant_user_id, b.customer_user_id)
 AND part.deleted_at IS NULL
LEFT JOIN profile p
  ON p.user_id = COALESCE(b.participant_user_id, b.customer_user_id)
 AND p.deleted_at IS NULL
LEFT JOIN users payer
  ON payer.id = b.customer_user_id
WHERE b.organization_id = (SELECT org_id FROM params)
  AND b.deleted_at   IS NULL
  AND b.canceled_at  IS NULL
  AND b.status       = 'confirmed'
ORDER BY c.name, s.name, part.last_name, part.first_name