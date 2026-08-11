-- ═══════════════════════════════════════════════════════════════════
-- INSTRUCTOR PAYOUT REPORT (v2.1 — 2026-08-11)
-- Metabase card 17755 · public UUID a8db6d86-eddc-4511-a28c-ad4bf636859e
-- Feeds: Instructor Payout report + Instructor Lessons report (SF pilot)
--
-- v2.1 CHANGES (Douglas County: missing sections & instructors)
--   1. DROP-IN BOOKINGS INCLUDED. A drop-in registration is a booking row
--      with type='session' and section_id NULL (only session_id is set).
--      v2.0's b.type='section' filter made every drop-in class invisible —
--      Douglas County was missing 5 sections, 4 instructors and $305 in
--      the Jun–Oct 2026 window (e.g. Jill Hartman's Valley Yoga drop-ins).
--      The section join now goes through COALESCE(b.section_id,
--      bses.section_id). Each paid drop-in visit is one participant row.
--   2. ROSTER ROWS. One extra row per non-deleted org instructor with
--      booking_status='Roster', NULL section fields and $0 amounts, so the
--      report UI can list EVERY instructor in the filter dropdown
--      regardless of payment activity in the window. Consumers MUST
--      exclude booking_status='Roster' rows from money/enrollment math —
--      rental-report does (instructor-payout.html, lessons + director's
--      report pipelines in server.js).
--   3. Instructor names are whitespace-normalized in both branches
--      ("Jill  Hartman" had a double space from a trailing space in
--      first_name; normalization also keeps roster names identical to
--      payout-row names so the dropdown filter matches).
--
-- v2.0 (retained): window = payments CONFIRMED in range (not signups);
--      timezone-correct date bounds via cfg.tz; window-bounded refunds;
--      section_start_date/section_end_date columns.
-- v1.2 (retained): section.pricing_policy jsonb replaces the dropped
--      section_price table. Mirrors cards 17295, 17298, 19273.
--
-- Variables: {{org_id}} Text, {{start_date}} Date, {{end_date}} Date
--
-- ⚠ PASTE THIS IN THE METABASE UI, NOT VIA THE API.
--   API updates reset template-tag types; the Date variables silently
--   become Text and every public embed in rental-report breaks. Pasting in
--   the UI preserves them.
--
-- ⚠ DEPLOY ORDER: ship the rental-report frontend/server changes FIRST
--   (they ignore Roster rows and are a no-op against the v2.0 card), THEN
--   paste this SQL. The old frontend would count Roster rows as $0
--   participants. After pasting, verify with:
--   node scripts/verify-report-live.js --manifest scripts/report-cards.manifest.json
-- ═══════════════════════════════════════════════════════════════════

WITH cfg AS (
  SELECT o.id AS org_id,
         COALESCE(
           (SELECT l.timezone FROM location l
            WHERE l.organization_id = o.id AND l.deleted_at IS NULL
              AND l.timezone <> 'UTC'
            GROUP BY l.timezone ORDER BY COUNT(*) DESC LIMIT 1),
           'America/New_York') AS tz
  FROM organization o WHERE o.id = {{org_id}}::uuid
)
SELECT
  p.name                                            AS program_name,
  s.name                                            AS section_name,
  s.id                                              AS section_id,
  sd.sec_start                                      AS section_start_date,
  sd.sec_end                                        AS section_end_date,
  fn.facilitator_names                              AS instructor,
  COALESCE(part.first_name || ' ' || part.last_name, 'Unknown') AS participant_name,
  TO_CHAR(b.created_at AT TIME ZONE cfg.tz, 'MM/DD/YYYY')      AS signup_date,
  ROUND(COALESCE((s.pricing_policy->'default'->>'cents')::int, 0) / 100.0, 2) AS base_price,
  COALESCE((oi.applied_pricing->'result'->>'finalCents')::numeric, 0) / 100.0 AS final_price,
  COALESCE((oi.applied_pricing->'result'->>'defaultCents')::numeric, 0) / 100.0 AS list_price,
  CASE WHEN (oi.applied_pricing->'result'->>'finalCents')::numeric
            < (oi.applied_pricing->'result'->>'defaultCents')::numeric
       THEN 'Group/Resident' ELSE 'Standard' END   AS price_type,
  ROUND(COALESCE(tx.paid_cents, 0) / 100.0, 2)     AS amount_paid,
  ROUND(COALESCE(tx.refund_cents, 0) / 100.0, 2)   AS amount_refunded,
  CASE WHEN b.canceled_at IS NOT NULL THEN 'Canceled' ELSE 'Active' END AS booking_status
FROM cfg
-- NOTE: the b.created_at window filter from v1.2 is deliberately gone.
-- The window is applied to transactions in the tx lateral below.
JOIN booking b ON b.organization_id = cfg.org_id
               AND b.deleted_at IS NULL
               AND b.type IN ('section', 'session')
               AND (
                 (b.status = 'confirmed' AND b.canceled_at IS NULL)
                 OR b.canceled_at IS NOT NULL
               )
-- Drop-in (type='session') bookings carry no section_id; resolve the
-- section through the booked session instead.
LEFT JOIN session bses ON bses.id = b.session_id
                       AND bses.organization_id = cfg.org_id
JOIN section s ON s.id = COALESCE(b.section_id, bses.section_id)
               AND s.organization_id = cfg.org_id AND s.deleted_at IS NULL
JOIN program p ON p.id = s.program_id
               AND p.organization_id = cfg.org_id AND p.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT MIN((ses.starts_at AT TIME ZONE cfg.tz)::date) AS sec_start,
         MAX((ses.ends_at   AT TIME ZONE cfg.tz)::date) AS sec_end
  FROM session ses
  WHERE ses.section_id = s.id
    AND ses.deleted_at IS NULL AND ses.canceled_at IS NULL
) sd ON TRUE
INNER JOIN LATERAL (
  SELECT STRING_AGG(DISTINCT BTRIM(REGEXP_REPLACE(CONCAT_WS(' ', u.first_name, u.last_name), '\s+', ' ', 'g')), ', ') AS facilitator_names
  FROM section_facilitator sf
  JOIN instructor i ON i.id = sf.facilitator_id
                    AND i.organization_id = cfg.org_id AND i.deleted_at IS NULL
  JOIN users u ON u.id = i.user_id
  WHERE sf.section_id = s.id
    AND sf.organization_id = cfg.org_id AND sf.deleted_at IS NULL
  HAVING COUNT(*) > 0
) fn ON TRUE
LEFT JOIN users part ON part.id = b.participant_user_id
JOIN order_item oi ON oi.booking_id = b.id
                   AND oi.organization_id = cfg.org_id
                   AND oi.deleted_at IS NULL
                   AND oi.parent_order_item_id IS NULL
LEFT JOIN LATERAL (
  SELECT
    SUM(CASE WHEN pmt.status = 'succeeded' AND oit.refund_id IS NULL THEN oit.amount ELSE 0 END) AS paid_cents,
    SUM(CASE WHEN r.status = 'succeeded' THEN ABS(oit.amount) ELSE 0 END) AS refund_cents
  FROM order_item_transaction oit
  LEFT JOIN payment pmt ON pmt.id = oit.payment_id
                        AND pmt.organization_id = cfg.org_id AND pmt.deleted_at IS NULL
  LEFT JOIN refund r ON r.id = oit.refund_id
                     AND r.organization_id = cfg.org_id AND r.deleted_at IS NULL
  WHERE oit.order_item_id = oi.id
    AND oit.organization_id = cfg.org_id AND oit.deleted_at IS NULL
    -- The reporting window now lives here.
    [[ AND (oit.confirmed_at AT TIME ZONE cfg.tz)::date >= {{start_date}} ]]
    [[ AND (oit.confirmed_at AT TIME ZONE cfg.tz)::date <= {{end_date}} ]]
) tx ON TRUE
WHERE COALESCE(tx.paid_cents, 0) <> 0
   OR COALESCE(tx.refund_cents, 0) <> 0

UNION ALL

-- Roster branch: every non-deleted org instructor, unconditionally.
-- $0 / NULL-section rows tagged booking_status='Roster' so the UI can fill
-- the instructor dropdown without them entering payout or enrollment math.
SELECT
  NULL::text                                        AS program_name,
  NULL::text                                        AS section_name,
  NULL::uuid                                        AS section_id,
  NULL::date                                        AS section_start_date,
  NULL::date                                        AS section_end_date,
  BTRIM(REGEXP_REPLACE(CONCAT_WS(' ', u.first_name, u.last_name), '\s+', ' ', 'g')) AS instructor,
  NULL::text                                        AS participant_name,
  NULL::text                                        AS signup_date,
  0::numeric                                        AS base_price,
  0::numeric                                        AS final_price,
  0::numeric                                        AS list_price,
  'Standard'                                        AS price_type,
  0::numeric                                        AS amount_paid,
  0::numeric                                        AS amount_refunded,
  'Roster'                                          AS booking_status
FROM cfg
JOIN instructor i ON i.organization_id = cfg.org_id AND i.deleted_at IS NULL
JOIN users u ON u.id = i.user_id

ORDER BY instructor, section_start_date, program_name, section_name, participant_name
