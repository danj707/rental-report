-- Card 16897: Session Schedule - Watertown
-- Changed: replaced (COALESCE(s.waitlist_config, sec.waitlist_config) ->> 'enabled') = 'true'
--          with COALESCE(COALESCE(s.waitlist_config, sec.waitlist_config) ->> 'mode', 'off') <> 'off' (1 occurrence); no other changes.
-- Date: 2026-08-03
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
    WHERE o.id = 'd781690b-c5a0-43c5-8443-9ae43899528c'   -- Watertown
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
        WHEN sp.price IS NULL THEN NULL
        WHEN sec.registration_mode = 'per-session'
            THEN TO_CHAR(sp.price / 100.0, 'FM$999,990.00') || '/session'
        ELSE TO_CHAR(sp.price / 100.0, 'FM$999,990.00')
    END                                                      AS "Price",
    COALESCE(
        (SELECT STRING_AGG(DISTINCT act.name, ', ' ORDER BY act.name)
           FROM class_activity ca
           JOIN activity act ON act.id = ca.activity_id AND act.deleted_at IS NULL
          WHERE ca.class_id = sec.class_id AND ca.deleted_at IS NULL),
        'Uncategorized'
    )                                                        AS "Activity",
    COALESCE(loc_from_site.name, loc_direct.name, 'Unassigned') AS "Location",
    CASE
        WHEN COALESCE(s.capacity_reached_at, sec.capacity_reached_at) IS NOT NULL
             AND COALESCE(COALESCE(s.waitlist_config, sec.waitlist_config) ->> 'mode', 'off') <> 'off' THEN 'Full - Waitlist Open'
        WHEN COALESCE(s.capacity_reached_at, sec.capacity_reached_at) IS NOT NULL           THEN 'Full'
        ELSE 'Open'
    END                                                      AS "Status",
    ('https://www.rec.us/sections/' || sec.id)               AS "Section URL",
    LEFT(COALESCE(sec.description, c.description, ''), 300)   AS "Description"
FROM "session" s
CROSS JOIN cfg
JOIN section sec ON sec.id = s.section_id AND sec.deleted_at IS NULL
JOIN class c     ON c.id = sec.class_id   AND c.deleted_at IS NULL
LEFT JOIN section_price sp       ON sp.section_id = sec.id AND sp.type = 'default' AND sp.deleted_at IS NULL
LEFT JOIN court site             ON site.id = s.location_id             AND site.deleted_at IS NULL
LEFT JOIN location loc_from_site ON loc_from_site.id = site.location_id AND loc_from_site.deleted_at IS NULL
LEFT JOIN location loc_direct    ON loc_direct.id = s.location_id       AND loc_direct.deleted_at IS NULL
WHERE sec.organization_id = cfg.organization_id
  AND s.deleted_at IS NULL
  AND sec.canceled_at IS NULL
  AND sec.section_code IS DISTINCT FROM 'DNE'
  AND sec.publish_at IS NOT NULL
  AND (sec.publish_at AT TIME ZONE cfg.tz) <= (NOW() AT TIME ZONE cfg.tz)
  [[ AND (s.starts_at AT TIME ZONE cfg.tz)::date >= DATE({{start_date}}) ]]
  [[ AND (s.starts_at AT TIME ZONE cfg.tz)::date <= DATE({{end_date}}) ]]
ORDER BY "Date", "Begin Sort", "Location"
