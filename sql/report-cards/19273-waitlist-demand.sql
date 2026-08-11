-- 2026-08-10 TABLE-DROP MIGRATION: class/class_activity are being dropped
-- (replaced by program/program_activity, same UUIDs; section.program_id is
-- populated 1:1 with section.class_id). This file is the live card SQL with
-- ONLY that mechanical rename applied - no logic or output changes.
-- ✅ Waitlist Demand Report (rental-report shared card) — v5 2026-08-05
-- v5: replaced section_price lateral join with section.pricing_policy jsonb
-- (section_price table being dropped by Long Nguyen).
-- Section-grain waitlist demand for one org ({{org_id}}). Scope: sections not
-- deleted/canceled/archived. Optional date overlap filter on session range.
-- NOTE for future edits: API updates reset template-tag types — re-set
-- Start/End Date variables to type Date in the UI afterward.
WITH cfg AS (
  SELECT o.id AS org_id,
         COALESCE(
            (SELECT l.timezone FROM location l
              WHERE l.organization_id = o.id AND l.deleted_at IS NULL AND l.timezone <> 'UTC'
              GROUP BY l.timezone ORDER BY COUNT(*) DESC LIMIT 1),
            'America/New_York'
         ) AS tz
  FROM organization o
  WHERE o.id = {{org_id}}::uuid
),
wl AS (
  SELECT COALESCE(w.section_id, se.section_id) AS section_id,
         COUNT(DISTINCT w.participant_user_id) FILTER (WHERE w.canceled_at IS NULL) AS waitlist_active,
         COUNT(DISTINCT w.participant_user_id) AS waitlist_total,
         COUNT(DISTINCT w.participant_user_id) FILTER (
           WHERE EXISTS (SELECT 1 FROM booking b2
                         LEFT JOIN session se2 ON se2.id = b2.session_id AND se2.deleted_at IS NULL
                         WHERE b2.organization_id = cfg.org_id AND b2.deleted_at IS NULL AND b2.canceled_at IS NULL
                           AND b2.status = 'confirmed' AND b2.participant_user_id = w.participant_user_id
                           AND COALESCE(b2.section_id, se2.section_id) = COALESCE(w.section_id, se.section_id)
                           AND b2.created_at >= w.created_at)) AS waitlist_converted,
         MIN(w.created_at) FILTER (WHERE w.canceled_at IS NULL) AS oldest_active_join
  FROM cfg
  JOIN waitlist w ON w.organization_id = cfg.org_id AND w.deleted_at IS NULL
  LEFT JOIN session se ON se.id = w.session_id AND se.organization_id = cfg.org_id AND se.deleted_at IS NULL
  WHERE COALESCE(w.section_id, se.section_id) IS NOT NULL
  GROUP BY COALESCE(w.section_id, se.section_id)
),
offers AS (
  SELECT t.section_id,
         COUNT(*) AS offers_sent,
         COUNT(DISTINCT t.participant_user_id) AS people_offered,
         COUNT(*) FILTER (WHERE t.consumed) AS offers_claimed,
         COUNT(DISTINCT t.participant_user_id) FILTER (WHERE t.consumed) AS claimants,
         COUNT(*) FILTER (WHERE t.untouched AND t.expired) AS offers_expired,
         COUNT(*) FILTER (WHERE t.untouched AND NOT t.expired) AS offers_outstanding,
         ROUND(AVG(t.hrs) FILTER (WHERE t.consumed)::numeric, 2) AS avg_claim_hours,
         ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.hrs) FILTER (WHERE t.consumed))::numeric, 2) AS median_claim_hours,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs <= 1)                 AS claim_1h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 1  AND t.hrs <= 4)  AS claim_4h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 4  AND t.hrs <= 8)  AS claim_8h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 8  AND t.hrs <= 24) AS claim_24h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 24 AND t.hrs <= 48) AS claim_48h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 48)                 AS claim_more
  FROM (
    SELECT COALESCE(w.section_id, se.section_id) AS section_id,
           w.participant_user_id,
           (tg.updated_at > tg.created_at AND ABS(EXTRACT(EPOCH FROM tg.updated_at - tg.expires_at)) <= 2) AS consumed,
           (tg.updated_at = tg.created_at) AS untouched,
           (tg.expires_at <= NOW()) AS expired,
           EXTRACT(EPOCH FROM tg.updated_at - tg.created_at)/3600.0 AS hrs
    FROM cfg
    JOIN waitlist w ON w.organization_id = cfg.org_id AND w.deleted_at IS NULL AND w.temporary_grant_id IS NOT NULL
    LEFT JOIN session se ON se.id = w.session_id AND se.organization_id = cfg.org_id AND se.deleted_at IS NULL
    JOIN temporary_grant tg ON tg.id = w.temporary_grant_id
    WHERE COALESCE(w.section_id, se.section_id) IS NOT NULL
  ) t
  GROUP BY t.section_id
),
enrolled AS (
  SELECT bs.section_id, COUNT(DISTINCT bs.participant_user_id) AS enrolled_people
  FROM (SELECT b.participant_user_id, COALESCE(b.section_id, se.section_id) AS section_id
        FROM cfg
        JOIN booking b ON b.organization_id = cfg.org_id AND b.deleted_at IS NULL
                       AND b.canceled_at IS NULL AND b.status = 'confirmed'
        LEFT JOIN session se ON se.id = b.session_id AND se.organization_id = cfg.org_id AND se.deleted_at IS NULL) bs
  WHERE bs.section_id IS NOT NULL
  GROUP BY bs.section_id
)
SELECT
  o.name AS "Org Name",
  p.name AS "Program",
  s.id   AS "Section Id",
  s.name AS "Section",
  COALESCE(si.season_name,'No Season') AS "Season",
  CASE WHEN sd.first_start IS NULL THEN 'Upcoming'
       WHEN sd.first_start > NOW() THEN 'Upcoming'
       WHEN sd.last_end   < NOW() THEN 'Past'
       ELSE 'In Progress' END AS "Section Status",
  TO_CHAR(sd.first_start AT TIME ZONE cfg.tz,'YYYY-MM-DD') AS "Start Date",
  TO_CHAR(sd.last_end    AT TIME ZONE cfg.tz,'YYYY-MM-DD') AS "End Date",
  COALESCE(ca.activity_name,'Uncategorized') AS "Activity",
  COALESCE(s.waitlist_config->>'mode', sm.session_mode) AS "Waitlist Mode",
  CASE WHEN s.waitlist_config IS NOT NULL THEN 'section'
       WHEN sm.session_mode IS NOT NULL THEN 'session'
       ELSE 'none' END AS "Mode Source",
  COALESCE((s.waitlist_config->>'linkExpirationMinutes')::int, sm.session_link_min) AS "Link Expiration Min",
  s.capacity AS "Capacity",
  COALESCE(en.enrolled_people,0) AS "Enrolled",
  ROUND(COALESCE((s.pricing_policy->'default'->>'cents')::int,0)/100.0,2) AS "Price",
  COALESCE(wl.waitlist_active,0) AS "Waitlisted",
  COALESCE(wl.waitlist_total,0) AS "Waitlist All-Time",
  COALESCE(wl.waitlist_converted,0) AS "Waitlist Converted",
  ROUND(COALESCE(wl.waitlist_active,0) * COALESCE((s.pricing_policy->'default'->>'cents')::int,0)/100.0, 2) AS "Est Demand",
  CASE WHEN COALESCE(s.capacity,0) > 0
       THEN ROUND(COALESCE(wl.waitlist_active,0)::numeric / s.capacity * 100, 0) END AS "Pressure %",
  TO_CHAR(wl.oldest_active_join AT TIME ZONE cfg.tz,'YYYY-MM-DD') AS "Oldest Active Join",
  COALESCE(cl.offers_sent,0) AS "Offers Sent",
  COALESCE(cl.people_offered,0) AS "People Offered",
  COALESCE(cl.offers_claimed,0) AS "Offers Claimed",
  COALESCE(cl.claimants,0) AS "Claimants",
  COALESCE(cl.offers_expired,0) AS "Offers Expired",
  COALESCE(cl.offers_outstanding,0) AS "Offers Outstanding",
  cl.avg_claim_hours AS "Avg Claim Hours",
  cl.median_claim_hours AS "Median Claim Hours",
  COALESCE(cl.claim_1h,0)   AS "Claim 1h",
  COALESCE(cl.claim_4h,0)   AS "Claim 4h",
  COALESCE(cl.claim_8h,0)   AS "Claim 8h",
  COALESCE(cl.claim_24h,0)  AS "Claim 24h",
  COALESCE(cl.claim_48h,0)  AS "Claim 48h",
  COALESCE(cl.claim_more,0) AS "Claim 48h Plus"
FROM cfg
JOIN section s ON s.organization_id = cfg.org_id AND s.deleted_at IS NULL
             AND s.canceled_at IS NULL AND s.archived_at IS NULL
JOIN program p ON p.id = s.program_id AND p.organization_id = cfg.org_id AND p.deleted_at IS NULL
JOIN organization o ON o.id = cfg.org_id
LEFT JOIN wl       ON wl.section_id = s.id
LEFT JOIN offers cl ON cl.section_id = s.id
LEFT JOIN enrolled en ON en.section_id = s.id
LEFT JOIN LATERAL (SELECT MIN(se.starts_at) AS first_start, MAX(se.ends_at) AS last_end
                   FROM session se WHERE se.section_id = s.id AND se.organization_id = cfg.org_id
                     AND se.deleted_at IS NULL AND se.canceled_at IS NULL) sd ON TRUE
LEFT JOIN LATERAL (SELECT season.name AS season_name
                   FROM section_season ss JOIN season ON season.id = ss.season_id
                        AND season.organization_id = cfg.org_id AND season.deleted_at IS NULL
                   WHERE ss.section_id = s.id AND ss.organization_id = cfg.org_id AND ss.deleted_at IS NULL
                   ORDER BY season.name LIMIT 1) si ON TRUE
LEFT JOIN LATERAL (SELECT se.waitlist_config->>'mode' AS session_mode,
                          (se.waitlist_config->>'linkExpirationMinutes')::int AS session_link_min
                   FROM session se WHERE se.section_id = s.id AND se.organization_id = cfg.org_id
                     AND se.deleted_at IS NULL AND se.waitlist_config IS NOT NULL
                   LIMIT 1) sm ON TRUE
LEFT JOIN LATERAL (SELECT COALESCE(STRING_AGG(DISTINCT a.name, ', ' ORDER BY a.name),'Uncategorized') AS activity_name
                   FROM program_activity cca JOIN activity a ON a.id = cca.activity_id AND a.deleted_at IS NULL
                   WHERE cca.program_id = s.program_id AND cca.deleted_at IS NULL) ca ON TRUE
WHERE s.organization_id = cfg.org_id
  [[ AND (sd.first_start IS NULL OR (sd.first_start AT TIME ZONE cfg.tz)::date <= {{end_date}}::date) ]]
  [[ AND (sd.last_end   IS NULL OR (sd.last_end   AT TIME ZONE cfg.tz)::date >= {{start_date}}::date) ]]
ORDER BY COALESCE(wl.waitlist_active,0) DESC, p.name, s.name