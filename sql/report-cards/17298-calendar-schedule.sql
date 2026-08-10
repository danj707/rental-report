-- 2026-08-10 TABLE-DROP MIGRATION: class/class_activity are being dropped
-- (replaced by program/program_activity, same UUIDs; section.program_id is
-- populated 1:1 with section.class_id). This file is the live card SQL with
-- ONLY that mechanical rename applied - no logic or output changes.
-- Card 17298: ✅Calendar Schedule
-- 2026-08-05: replaced section_price join with section.pricing_policy jsonb
-- (section_price table being dropped by Long Nguyen)
WITH cfg AS (
    SELECT
        o.id AS organization_id,
        COALESCE(
            (SELECT l.timezone
               FROM location l
              WHERE l.organization_id = o.id
                AND l.deleted_at IS NULL
                AND l.timezone <> 'UTC'
              GROUP BY l.timezone
              ORDER BY COUNT(*) DESC
              LIMIT 1),
            'UTC'
        ) AS tz
    FROM organization o
    WHERE o.id = {{org_id}}::uuid
),
section_registration AS (
    SELECT
        rw.section_id,
        MIN(rw.opens_at)  AS reg_opens_at,
        MAX(rw.closes_at) AS reg_closes_at
    FROM registration_window rw
    WHERE rw.deleted_at IS NULL
      AND rw.type = 'default'
      AND rw.section_id IS NOT NULL
    GROUP BY rw.section_id
),
program_activities AS (
    SELECT
        ca.program_id,
        STRING_AGG(DISTINCT act.name, ', ' ORDER BY act.name) AS activity_names
    FROM program_activity ca
    JOIN activity act ON act.id = ca.activity_id AND act.deleted_at IS NULL
    WHERE ca.deleted_at IS NULL
    GROUP BY ca.program_id
),
section_eligibility AS (
    SELECT
        ergl.section_id,
        STRING_AGG(DISTINCT
            CASE
                WHEN er.attribute_name = 'age' AND er.attribute_type = 'numberRange'
                    THEN 'Ages '
                         || ROUND(SPLIT_PART(TRIM(BOTH '[]' FROM er.attribute_value), ',', 1)::numeric / 365.25)::int
                         || '-'
                         || ROUND(TRIM(SPLIT_PART(TRIM(BOTH '[]' FROM er.attribute_value), ',', 2))::numeric / 365.25)::int
                WHEN er.attribute_name = 'age' AND er.comparison_operator = 'greaterThanOrEqual'
                    THEN 'Ages '
                         || ROUND(er.attribute_value::numeric / 365.25)::int || '+'
                WHEN er.attribute_name = 'grade' AND er.attribute_type = 'stringArray'
                    THEN 'Grades: '
                         || REPLACE(REPLACE(REPLACE(er.attribute_value, '["', ''), '"]', ''), '","', ', ')
                ELSE NULL
            END
        , ' | ') AS eligibility_label
    FROM eligibility_rule_group_lookup ergl
    JOIN eligibility_rule_group erg
        ON erg.id = ergl.eligibility_rule_group_id
        AND erg.deleted_at IS NULL
        AND erg.type = 'registration'
    JOIN eligibility_rule er
        ON er.eligibility_rule_group_id = erg.id
        AND er.deleted_at IS NULL
        AND er.type = 'condition'
        AND er.attribute_name IN ('age', 'grade')
    WHERE ergl.deleted_at IS NULL
      AND ergl.section_id IS NOT NULL
    GROUP BY ergl.section_id
)
SELECT
    (s.starts_at AT TIME ZONE cfg.tz)::date                  AS "Date",
    TO_CHAR((s.starts_at AT TIME ZONE cfg.tz), 'Dy')         AS "Day",
    TO_CHAR((s.starts_at AT TIME ZONE cfg.tz), 'HH12:MI AM') AS "Begin",
    TO_CHAR((s.ends_at   AT TIME ZONE cfg.tz), 'HH12:MI AM') AS "End",
    TO_CHAR((s.starts_at AT TIME ZONE cfg.tz), 'HH24:MI')    AS "Begin Sort",
    c.name                                                   AS "Program",
    sec.name                                                 AS "Section",
    CASE
        WHEN (sec.pricing_policy->'default'->>'cents') IS NULL THEN NULL
        WHEN sec.registration_mode = 'per-session'
            THEN TO_CHAR((sec.pricing_policy->'default'->>'cents')::int / 100.0, 'FM$999,990.00') || '/session'
        ELSE TO_CHAR((sec.pricing_policy->'default'->>'cents')::int / 100.0, 'FM$999,990.00')
    END                                                      AS "Price",
    COALESCE(ca_agg.activity_names, 'Uncategorized')         AS "Activity",
    COALESCE(loc_from_site.name, loc_direct.name, 'Unassigned') AS "Location",
    CASE
        WHEN sr.reg_closes_at IS NOT NULL
             AND (sr.reg_closes_at AT TIME ZONE cfg.tz) < (NOW() AT TIME ZONE cfg.tz)
        THEN
            CASE
                WHEN COALESCE(s.capacity_reached_at, sec.capacity_reached_at) IS NOT NULL
                     AND COALESCE(COALESCE(s.waitlist_config, sec.waitlist_config) ->> 'mode', 'off') <> 'off'
                THEN 'Closed - Full - Waitlist'
                WHEN COALESCE(s.capacity_reached_at, sec.capacity_reached_at) IS NOT NULL
                THEN 'Closed - Full'
                ELSE 'Closed'
            END
        WHEN sr.reg_opens_at IS NOT NULL
             AND (sr.reg_opens_at AT TIME ZONE cfg.tz) > (NOW() AT TIME ZONE cfg.tz)
        THEN 'Not Yet Open'
        WHEN COALESCE(s.capacity_reached_at, sec.capacity_reached_at) IS NOT NULL
             AND COALESCE(COALESCE(s.waitlist_config, sec.waitlist_config) ->> 'mode', 'off') <> 'off'
        THEN 'Full - Waitlist Open'
        WHEN COALESCE(s.capacity_reached_at, sec.capacity_reached_at) IS NOT NULL
        THEN 'Full'
        ELSE 'Open'
    END                                                      AS "Status",
    ('https://www.rec.us/sections/' || sec.id)               AS "Section URL",
    LEFT(COALESCE(sec.description, c.description, ''), 300)   AS "Description",
    COALESCE(se.eligibility_label, '')                        AS "Eligibility"
FROM "session" s
CROSS JOIN cfg
JOIN section sec ON sec.id = s.section_id AND sec.deleted_at IS NULL
JOIN program c     ON c.id = sec.program_id   AND c.deleted_at IS NULL
LEFT JOIN program_activities ca_agg ON ca_agg.program_id = sec.program_id
LEFT JOIN section_registration sr ON sr.section_id = sec.id
LEFT JOIN section_eligibility se  ON se.section_id = sec.id
LEFT JOIN court site             ON site.id = s.location_id             AND site.deleted_at IS NULL
LEFT JOIN location loc_from_site ON loc_from_site.id = site.location_id AND loc_from_site.deleted_at IS NULL
LEFT JOIN location loc_direct    ON loc_direct.id = s.location_id       AND loc_direct.deleted_at IS NULL
WHERE sec.organization_id = cfg.organization_id
  AND s.deleted_at IS NULL
  AND sec.canceled_at IS NULL
  AND sec.section_code IS DISTINCT FROM 'DNE'
  AND sec.publish_at IS NOT NULL
  AND (sec.publish_at AT TIME ZONE cfg.tz) <= (NOW() AT TIME ZONE cfg.tz)
  [[ AND s.starts_at >= (DATE({{start_date}})::timestamp AT TIME ZONE (SELECT tz FROM cfg)) ]]
  [[ AND s.starts_at <  ((DATE({{end_date}})::timestamp + interval '1 day') AT TIME ZONE (SELECT tz FROM cfg)) ]]
ORDER BY "Date", "Begin Sort", "Location"
