-- 2026-08-10 TABLE-DROP MIGRATION: class/class_activity are being dropped
-- (replaced by program/program_activity, same UUIDs; section.program_id is
-- populated 1:1 with section.class_id). This file is the live card SQL with
-- ONLY that mechanical rename applied - no logic or output changes.
-- ✅ Waitlist Demand Report (rental-report shared card) — v6 2026-09-01
--
-- v6 FIXES A NUMBER THAT WAS WRONG SINCE THE OFFERS CTE WAS WRITTEN, and adds
-- "Waitlist Type" (automated vs manual).
--
-- THE BUG: a claim was inferred from timestamps —
--     (tg.updated_at > tg.created_at
--      AND ABS(EXTRACT(EPOCH FROM tg.updated_at - tg.expires_at)) <= 2)
-- i.e. "the grant was written to at its expiry moment". That is what an EXPIRY
-- SWEEP does, not what a claim does.
--
-- The clinching evidence, measured 2026-09-01 over 8,529 invites platform-wide:
-- of the 5,371 grants that test called consumed, **5,371 were already expired
-- and ZERO were still open**. A real claim signal would catch some invites
-- inside their window. Supporting: the average created→updated gap on those
-- rows is 114h against an average invite window of 105.8h, while an actual
-- registration lands at a median of 5.3h.
--
--   heuristic said claimed             5,371  (63.0%)
--   actually booked in the window      3,628  (42.5%)   <- the truth
--   both agree                         3,483
--   heuristic only, no registration    1,888             <- pure over-count
--   booked but heuristic missed it       145
--
-- So the report overstated waitlist conversion by ~20 points, and every
-- claim-time figure (Avg/Median Claim Hours and the six Claim buckets) was
-- really describing invite-window LENGTHS.
--
-- v6 defines a claim DIRECTLY: a confirmed booking by that participant on that
-- section between the grant's created_at and expires_at. Cost is not a concern —
-- the whole per-section aggregate measured 658ms at apex.
--
-- AND THE THREE OUTCOMES NOW PARTITION EXACTLY. offers_expired and
-- offers_outstanding used to key on `untouched` (updated_at = created_at), so
-- claimed + expired + outstanding did NOT add up to offers_sent — a grant that
-- was touched but not claimed fell into no bucket at all. They are now
-- claimed / not-claimed-and-expired / not-claimed-and-still-open.
--
-- DO NOT ADD AN OPEN RATE: temporary_grant.first_viewed_at is populated on 66
-- of 8,529 invites (0.8%), dead like memberships.last_used_at.
--
-- v5 2026-08-05
-- replaced section_price lateral join with section.pricing_policy jsonb
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
         -- NOT `untouched` any more: these three now partition offers_sent
         -- exactly, so the parts add up to the whole.
         COUNT(*) FILTER (WHERE NOT t.consumed AND t.expired) AS offers_expired,
         COUNT(*) FILTER (WHERE NOT t.consumed AND NOT t.expired) AS offers_outstanding,
         ROUND(AVG(t.hrs) FILTER (WHERE t.consumed)::numeric, 2) AS avg_claim_hours,
         ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.hrs) FILTER (WHERE t.consumed))::numeric, 2) AS median_claim_hours,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs <= 1)                 AS claim_1h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 1  AND t.hrs <= 4)  AS claim_4h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 4  AND t.hrs <= 8)  AS claim_8h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 8  AND t.hrs <= 24) AS claim_24h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 24 AND t.hrs <= 48) AS claim_48h,
         COUNT(*) FILTER (WHERE t.consumed AND t.hrs > 48)                 AS claim_more
  FROM (
    -- A CLAIM IS A REGISTRATION, not a timestamp shape. `bk.booked_at` is the
    -- first confirmed booking this participant made on this section INSIDE the
    -- invite's own window, so `hrs` is the real time from invite to sign-up
    -- rather than the time until the row was swept.
    SELECT COALESCE(w.section_id, se.section_id) AS section_id,
           w.participant_user_id,
           (bk.booked_at IS NOT NULL) AS consumed,
           (tg.expires_at <= NOW()) AS expired,
           EXTRACT(EPOCH FROM bk.booked_at - tg.created_at)/3600.0 AS hrs
    FROM cfg
    JOIN waitlist w ON w.organization_id = cfg.org_id AND w.deleted_at IS NULL AND w.temporary_grant_id IS NOT NULL
    LEFT JOIN session se ON se.id = w.session_id AND se.organization_id = cfg.org_id AND se.deleted_at IS NULL
    JOIN temporary_grant tg ON tg.id = w.temporary_grant_id
    LEFT JOIN LATERAL (
      SELECT MIN(b2.created_at) AS booked_at
      FROM booking b2
      LEFT JOIN session se2 ON se2.id = b2.session_id AND se2.deleted_at IS NULL
      WHERE b2.organization_id = cfg.org_id AND b2.deleted_at IS NULL AND b2.canceled_at IS NULL
        AND b2.status = 'confirmed'
        AND b2.participant_user_id = w.participant_user_id
        AND COALESCE(b2.section_id, se2.section_id) = COALESCE(w.section_id, se.section_id)
        -- STRICTLY INSIDE THE WINDOW. Dropping the upper bound counts people
        -- who came back weeks later by other means: 641 of 4,269 platform-wide,
        -- which is the difference between 42.5% and 50.1% conversion.
        AND b2.created_at >= tg.created_at
        AND b2.created_at <= tg.expires_at
    ) bk ON TRUE
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
  -- v6. 'automated' | 'manual'. Falls back to the session config exactly like
  -- Mode does, so the two can never disagree about which row they describe.
  COALESCE(s.waitlist_config->>'type', sm.session_type) AS "Waitlist Type",
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
                          se.waitlist_config->>'type' AS session_type,
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