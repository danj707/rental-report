-- ════════════════════════════════════════════════════════════════════════════
-- CARD 21683 · REPORT 2 · AQUATICS CLASSES BY MONTH AND INSTRUCTOR
-- El Segundo · Joseph Lormans        https://rec.metabaseapp.com/question/21683
--
-- ✅ APPLIED AND VERIFIED LIVE 2026-09-09. This mirror matches the live card.
--   NEVER push it through the API: `update_question` regenerates every template
--   tag as Text and would wipe Dan's Date-typed date tags and the hardcoded
--   org_id default, which the dashboard's own filters bind to. Paste in the UI.
--
-- ── FIX 1 · SCOPE. The card had NO aquatics filter at all, only an
--    organization_id, so it returned all 396 El Segundo sections — Lego Club,
--    cooking classes, tap dancing. Scope is now the org's own taxonomy:
--    program_activity -> activity -> category, category = 'Pool Programming'.
--    83 sections. 100% of El Segundo sections carry an activity, which is what
--    makes this usable; the instructor field, by contrast, is empty on every
--    aquatics section. Do NOT filter on activity.name = 'Aquatics' alone — that
--    is 61 sections and misses 22, because Swim Lessons (71) is a bigger
--    sibling activity under the same category.
--    EXISTS, not a join: the tag is multi-valued and 3 sections carry two
--    categories (Lego Club, mis-tagged), which a join would fan out.
--
-- ── FIX 2 · LOCATION. It read "(no location on sessions)" on sections whose
--    location is perfectly well known. The old code resolved the location from
--    THAT MONTH'S sessions, so a month with money and no sessions had nowhere
--    to read it from — and the label then blamed the data. Measured: "Level 1-
--    Tadpoles: Tue/Thurs 4:00pm-4:25pm" has 8 sessions, all at Urho Saari, ALL
--    IN SEPTEMBER; its August row is registration money, so August rendered as
--    "(no location on sessions)" while the admin UI shows Urho Saari on every
--    date. A section's location does not change month to month, so it is
--    resolved from the SECTION across all its sessions.
--    NOTE this is NOT the court-vs-location ambiguity recorded elsewhere in
--    CLAUDE.md for card 17295 — that was checked here and does not apply:
--    all 2,067 live El Segundo sessions resolve as a location, none as a court.
--
-- VERIFIED 2026-09-09 by running THIS TEXT, whole final SELECT included, against
-- production over Aug-Sep 2026 — not a summary wrapper over its CTEs, which is
-- how card 21682 shipped with a broken ORDER BY. 97 rows (was 685), every one
-- aquatic; 3 locations and ZERO "(no location on file)"; "Level 1- Tadpoles:
-- Tue/Thurs 4:00pm-4:25pm" now reads Urho Saari on its August money row, which
-- is what Dan's admin screenshot shows.
--
-- ── FIX 3 · A {{location}} FILTER, CANONICALISED ───────────────────────────
--    A Metabase dashboard filter on a NATIVE card binds to a TEMPLATE TAG, not
--    to a result column, so the tag has to be in the SQL. All four cards emit
--    the same three values and take the same `location` variable:
--        El Segundo Wiseburn Aquatic Center | Urho Saari Swim Stadium | Hilltop Park
--    Measured 2026-09-09, aquatic sessions land at exactly three locations and
--    nowhere else: Urho Saari 373, Wiseburn AC 110, Competition Pool 32 — so
--    the ladder is complete and the fold leaves 142 at the Aquatic Center.
--
-- Everything below this line is unchanged from the live card.
-- ════════════════════════════════════════════════════════════════════════════
WITH aquatic_sections AS (
  -- FIX 1 · the org's own taxonomy, not a name regex
  SELECT sec.id
  FROM section sec
  WHERE sec.organization_id = {{org_id}}::uuid
    AND EXISTS (
      SELECT 1
      FROM program_activity pa
      JOIN activity a  ON a.id  = pa.activity_id AND a.deleted_at IS NULL
      JOIN category cat ON cat.id = a.category_id
      WHERE pa.program_id = sec.program_id
        AND pa.deleted_at IS NULL
        AND cat.name = 'Pool Programming'
    )
),
sec_loc AS (
  -- FIX 2 · the section's location, over ALL its sessions, not this month's
  -- FIX 3 · CANONICAL location, so {{location}} means the same thing on all
  -- four cards. The Competition Pool is a separate location record at the same
  -- address and folds into the Aquatic Center (32 of 515 aquatic sessions).
  SELECT s.section_id,
         MIN(CASE WHEN l.name ILIKE 'El Segundo Wiseburn Aquatic%'
                  THEN 'El Segundo Wiseburn Aquatic Center'
                  ELSE l.name END) AS loc
  FROM session s
  JOIN aquatic_sections aq ON aq.id = s.section_id
  JOIN location l ON l.id = s.location_id
  WHERE s.deleted_at IS NULL AND s.canceled_at IS NULL
  GROUP BY 1
),
sess AS (
  SELECT s.section_id,
         to_char(s.starts_at AT TIME ZONE COALESCE(l.timezone, 'America/Los_Angeles'), 'YYYY-MM') AS ym,
         COUNT(*) AS sessions,
         ROUND(SUM(EXTRACT(EPOCH FROM (s.ends_at - s.starts_at))/3600.0)::numeric, 2) AS session_hours
  FROM session s
  JOIN aquatic_sections aq ON aq.id = s.section_id
  LEFT JOIN location l ON l.id = s.location_id
  WHERE s.deleted_at IS NULL AND s.canceled_at IS NULL
    AND s.starts_at IS NOT NULL          -- a NULL start yields a NULL month and
                                          -- can never match the money side
    [[AND s.starts_at >= {{start_date}}::date]]
    [[AND s.starts_at <  {{end_date}}::date + 1]]
  GROUP BY 1, 2
),
money AS (
  SELECT br.section_id,
         to_char(il.datetime_at_primary_timezone, 'YYYY-MM') AS ym,
         ROUND(COALESCE(SUM(il.order_item_transaction_amount)
                 FILTER (WHERE il.transaction_type = 'payment'), 0)/100.0, 2) AS collected,
         ROUND(COALESCE(SUM(il.order_item_transaction_amount)
                 FILTER (WHERE il.transaction_type = 'refund'),  0)/100.0, 2) AS refunded
  FROM materialized.item_log_report il
  JOIN order_item oi                  ON oi.id = il.order_item_id
  JOIN materialized.booking_report br ON br.id = oi.booking_id
  JOIN aquatic_sections aq            ON aq.id = br.section_id
  WHERE il.organization_id = {{org_id}}::uuid
    AND il.order_item_type = 'reservation-enrollment'
    [[AND il.datetime_at_primary_timezone >= {{start_date}}::date]]
    [[AND il.datetime_at_primary_timezone <  {{end_date}}::date + 1]]
  GROUP BY 1, 2
),
fac AS (
  SELECT sf.section_id,
         string_agg(DISTINCT NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), ', ') AS instructor
  FROM section_facilitator sf
  JOIN instructor i ON i.id = sf.facilitator_id
  JOIN users u      ON u.id = i.user_id
  GROUP BY 1
),
enr AS (
  SELECT br.section_id, COUNT(DISTINCT br.participant_user_id) AS participants
  FROM materialized.booking_report br
  WHERE br.organization_id = {{org_id}}::uuid
    AND br.canceled_at IS NULL AND br.deleted_at IS NULL AND br.status = 'confirmed'
  GROUP BY 1
)
SELECT
  COALESCE(sess.ym, money.ym)                                AS "Month",
  COALESCE(sec_loc.loc, '(no location on file)')             AS "Location",
  p.name                                                     AS "Program",
  sec.name                                                   AS "Section",
  sec.id::text                                               AS "Section ID",
  COALESCE(fac.instructor, '(no instructor on file)')        AS "Instructor",
  COALESCE(enr.participants, 0)                              AS "Participants (section total)",
  COALESCE(sess.sessions, 0)                                 AS "Sessions in Month",
  COALESCE(sess.session_hours, 0)                            AS "Session Hours",
  COALESCE(money.collected, 0)                               AS "Collected",
  COALESCE(money.refunded, 0)                                AS "Refunded",
  COALESCE(money.collected, 0) - COALESCE(money.refunded, 0) AS "Net Revenue"
FROM sess
FULL OUTER JOIN money ON money.section_id = sess.section_id AND money.ym = sess.ym
JOIN section sec ON sec.id = COALESCE(sess.section_id, money.section_id)
JOIN program p   ON p.id   = sec.program_id
LEFT JOIN sec_loc ON sec_loc.section_id = sec.id
LEFT JOIN fac     ON fac.section_id = sec.id
LEFT JOIN enr     ON enr.section_id = sec.id
-- WHERE TRUE so the only clause can be optional; see the header on {{location}}.
-- A section with no location on file drops out when the filter is set, which is
-- correct — it cannot be claimed for a location nobody recorded.
WHERE TRUE
  [[AND sec_loc.loc = {{location}}]]
ORDER BY 1, 3, 4
-- ── {{location}} VERIFIED · 2026-09-09, this exact text, unwindowed ────────
--   Urho Saari Swim Stadium              93 rows / 373 sessions / $13,828 / 54 sections
--   El Segundo Wiseburn Aquatic Center   31 rows / 142 sessions /  $4,435 / 14 sections
--   (no location on file)                 1 row  /   0 sessions /      $0 /  1 section
-- That one unresolved section is a section with no session on record at all,
-- so it has no location to read — and it correctly drops out when the filter
-- is set. The Aug-Sep windowed run recorded ZERO such rows; this run is
-- unwindowed, which is a different question, not a regression.
