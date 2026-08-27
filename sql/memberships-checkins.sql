-- Metabase card 18151 — "✅ Memberships Check-In Report" (SHARED)
-- public UUID 574324e0-b5a1-46c5-8770-8c466631fdcf · SHARED_UUIDS['checkins']
-- MIRROR of the live card, byte-identical below this header. The live card is the
-- source of truth: read it (metabase://question/18151) and apply changes to THAT,
-- then mirror the result back here.
--
-- AFTER ANY PROGRAMMATIC PUSH the Start/End Date tags must be flipped back to
-- type Date in the Metabase UI — see sql/program-checkins.sql for why casting the
-- bounds is not enough on its own. A description-only update does NOT re-Text the
-- tags; only a query update does.
-- ─────────────────────────────────────────────────────────────────────────────
-- Memberships Check-In Report — SHARED card
--
-- v3 (2026-08-26): membership/pass check-in DENIALS join the feed, tagged by a
-- new "Status" column ('Checked In' | 'Failed').
--
-- Why a denial fits this card and not the program one: check_in_denied is
-- target_type='organization' (measured: all 58 platform-wide), so it has no
-- session and therefore no program section to attribute it to — a per-section
-- "Failed" column could only ever be a dash. It DOES carry everything this
-- card's row shape needs: all 58 have a participant_user_id whose users row
-- survives the deleted/'[DELETED]' filter, a desk_location_id, and a
-- check_in_method_id, with check_in_method_type of 'membership' (52) or
-- 'pass' (6) — the same two values this card already filters on.
--
-- CONSEQUENCE THE PAGE MUST HANDLE: this widens the row set of an existing
-- feed. Anything counting rows now counts failures as check-ins unless it
-- filters Status — the same shape as the facility Summary counting invoice fee
-- lines as bookings. public/memberships.html therefore derives `ciOk` (Checked
-- In only) and every existing panel reads that; only the Failed figures read the
-- denial rows. scripts/checkins-view.spec.js fails if a panel reads the raw feed.
--
-- Mirrored in the repo at sql/memberships-checkins.sql.
WITH org_tz AS (
  SELECT COALESCE(
           MODE() WITHIN GROUP (ORDER BY timezone),
           'America/Chicago'
         ) AS tz
  FROM location
  WHERE organization_id = {{org_id}}::uuid
    AND timezone IS NOT NULL
    AND timezone <> ''
)
SELECT
  u.rec_id                                            AS "Member ID",
  -- users.id, the uuid the Rec admin URL takes. "Member ID" above is
  -- users.rec_id, the 6-character code staff read out at the desk; a link built
  -- from that looks identical and 404s.
  u.id::text                                          AS "User ID",
  u.first_name                                        AS "First Name",
  u.last_name                                         AS "Last Name",
  u.email                                             AS "Email",
  -- Did the scan let them in? 'Failed' is a membership or pass that was refused
  -- at the desk. Every other column on a Failed row means the same thing it
  -- means on a successful one, which is why they can share a row shape.
  CASE
    WHEN ae.type = 'check_in_denied' THEN 'Failed'
    ELSE 'Checked In'
  END                                                 AS "Status",
  TO_CHAR(
    ae.created_at AT TIME ZONE otz.tz,
    'YYYY-MM-DD'
  )                                                   AS "Date",
  TO_CHAR(
    ae.created_at AT TIME ZONE otz.tz,
    'HH12:MIam'
  )                                                   AS "Time",
  EXTRACT(HOUR FROM ae.created_at AT TIME ZONE otz.tz)
                                                      AS "Hour",
  TO_CHAR(ae.created_at AT TIME ZONE otz.tz, 'Day')
                                                      AS "Day of Week",
  CASE
    WHEN EXTRACT(DOW FROM ae.created_at AT TIME ZONE otz.tz) IN (0, 6)
    THEN 'Weekend' ELSE 'Weekday'
  END                                                 AS "Day Type",
  COALESCE(dl.name, '(No Desk Location)')             AS "Desk Location",
  ae.check_in_method_type                             AS "Check-In Type",
  CASE
    WHEN ae.check_in_method_type = 'membership'
      THEN TRIM(COALESCE(mpr.product_name, '(Unknown Membership)'))
    WHEN ae.check_in_method_type = 'pass'
      THEN TRIM(COALESCE(ps.name, '(Unknown Pass)'))
    ELSE '(Other)'
  END                                                 AS "Product Name",
  COALESCE(admin_u.first_name || ' ' || admin_u.last_name, '')
                                                      AS "Recorded By"
FROM attendance_event ae
CROSS JOIN org_tz otz
JOIN users u
  ON u.id = ae.participant_user_id
 AND u.deleted_at IS NULL
 AND u.first_name != '[DELETED]'
LEFT JOIN users admin_u
  ON admin_u.id = ae.creator_user_id
LEFT JOIN membership m
  ON m.id = ae.check_in_method_id::uuid
 AND ae.check_in_method_type = 'membership'
LEFT JOIN materialized.membership_and_pass_plans_report mpr
  ON mpr.group_id = m.group_id
 AND mpr.organization_id = ae.organization_id
 AND ae.check_in_method_type = 'membership'
LEFT JOIN pass p
  ON p.id = ae.check_in_method_id::uuid
 AND ae.check_in_method_type = 'pass'
LEFT JOIN pass_schema ps
  ON ps.id = p.pass_schema_id
 AND ae.check_in_method_type = 'pass'
LEFT JOIN desk_location dl
  ON dl.id = ae.desk_location_id
 AND dl.organization_id = ae.organization_id
WHERE ae.organization_id = {{org_id}}::uuid  AND ae.type IN ('check_in', 'check_in_denied')
  AND ae.check_in_method_type IN ('membership', 'pass')
  [[AND ae.created_at >= ({{start_date}}::date AT TIME ZONE otz.tz)]]
  [[AND ae.created_at < ({{end_date}}::date AT TIME ZONE otz.tz) + INTERVAL '1 day']]
ORDER BY
  ae.created_at DESC,
  u.last_name,
  u.first_name
