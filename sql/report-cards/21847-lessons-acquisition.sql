-- ═══════════════════════════════════════════════════════════════════
-- LESSON ACQUISITION FUNNEL (v1.0 — 2026-09-14)
-- Metabase card 21847 · Acquisition tab of the Instructor Lessons report
-- (public/lessons.html, SF pilot). Mirrored at
-- sql/report-cards/21847-lessons-acquisition.sql — the LIVE CARD is the truth.
--
-- ONE ROW PER INQUIRY — a customer messaging an instructor to ask for a
-- lesson. `instructor_reservation_request` is read by NOTHING else in
-- this repo. SF alone runs ~1,800 a year and is ~85% of all such traffic
-- on the platform; measured over Sep 2025–Aug 2026, 216 of 1,801 were
-- ACCEPTED (12.0%) and 988 (54.9%) were never answered at all.
--
-- ───────────────────────────────────────────────────────────────────
-- WHY TWO CARDS AND NOT ONE
--
-- The first build was one card with a UNION of inquiry and booking rows,
-- and it TIMED OUT past 60s three times. Localised one probe at a time:
-- the inquiry half is 1.4s and the booking half is 21.6s (31.2s in a
-- set-based form) — the money aggregate is simply expensive at SF, where
-- order_item carries 158,855 facility bookings alongside the lessons.
-- Together they exceed the budget; apart, each is comfortably inside it,
-- they cache separately, and THE HALF CARRYING THE FINDING NEVER WAITS ON
-- THE HALF CARRYING THE MONEY. The page fetches both in parallel and
-- renders whichever arrives.
--
-- Variables: {{org_id}} Text. NO DATE TAGS on either card — so
-- buildMetabaseParams sends org_id alone, each card registers ONE Text
-- tag, and there is no date-tag flip and no push→flip outage. A lifetime
-- value is a POSITION (current whatever the toolbar says) and the funnel
-- needs a trailing series wider than the window on screen; the page
-- labels both "all-time" out loud rather than letting a reader infer
-- that the date pickers moved them.
--
-- ───────────────────────────────────────────────────────────────────
-- THE TRAP THIS CARD IS BUILT AROUND
--
-- `instructor_reservation_request.organization_id` IS NULL ON EVERY ROW
-- SINCE 2026-05. Measured 2026-09-14: 169/169 in May, 164/164 June,
-- 198/198 July, 206/206 August, 131/131 September — while SF's own
-- volume (resolved through the instructor) ran 118–175 a month
-- throughout. A card scoped on that column reports the whole inquiry
-- funnel as ZERO for the most recent five months, on data that never
-- stopped arriving.
--
-- So the org is resolved through `instructor.organization_id`, which is
-- populated on every row. lessons-funnel.spec.js fails if
-- `r.organization_id` appears anywhere in this file.
--
-- ───────────────────────────────────────────────────────────────────
-- WHAT COUNTS AS A LESSON
--
-- A booking on a section that has a FACILITATOR — the structural test,
-- which is what card 17755 already requires through its INNER JOIN
-- LATERAL. Deliberately NOT the page's old
-- `/lesson|clinic|coaching|private/` name regex: a name match is the trap
-- this repo keeps recording (`/ball ?field/` inside "Football Field").
--
-- Measured at SF before choosing, so this is a no-op rather than a
-- redefinition: over Sep 2025–Aug 2026 the two rules select the SAME
-- 3,640 bookings — 0 dropped either way.
--
-- The booking predicate is 17755's, character for character, so the two
-- cards cannot disagree about which bookings exist:
--     (status='confirmed' AND canceled_at IS NULL) OR canceled_at IS NOT NULL
-- That matters: SF has 98 live `planned` bookings on facilitated
-- sections, which a bare `canceled_at IS NULL` folds in and which 17755
-- has never counted.
--
-- ───────────────────────────────────────────────────────────────────
-- NO `cfg` CTE FOR THE ORG ID, and that is a measurement not a style
--
-- Written 17755's way — `b.organization_id = cfg.org_id` — every
-- predicate is a join against a CTE column rather than a constant.
-- Metabase substitutes {{org_id}} as a literal, so repeating the tag at
-- each predicate is what the fast probes actually measured. Only the
-- timezone stays a CTE: one row, read once, in the final SELECT.
-- ═══════════════════════════════════════════════════════════════════

WITH org_tz AS (
  SELECT COALESCE(
           (SELECT l.timezone FROM location l
            WHERE l.organization_id = {{org_id}}::uuid AND l.deleted_at IS NULL
              AND l.timezone <> 'UTC'
            GROUP BY l.timezone ORDER BY COUNT(*) DESC LIMIT 1),
           'America/Los_Angeles') AS tz
),

-- Every lesson booking this org has ever taken, with its section.
lesson_bk AS (
  SELECT b.id, b.customer_user_id, b.creator_user_id, b.created_at,
         b.canceled_at, b.is_fast_track, s.id AS section_id
  FROM booking b
  LEFT JOIN session bses ON bses.id = b.session_id
                         AND bses.organization_id = {{org_id}}::uuid
  JOIN section s ON s.id = COALESCE(b.section_id, bses.section_id)
                 AND s.organization_id = {{org_id}}::uuid
                 AND s.deleted_at IS NULL
  WHERE b.organization_id = {{org_id}}::uuid
    AND b.deleted_at IS NULL
    AND b.type IN ('section', 'session')
    AND ((b.status = 'confirmed' AND b.canceled_at IS NULL)
         OR b.canceled_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM section_facilitator sf
                WHERE sf.section_id = s.id
                  AND sf.organization_id = {{org_id}}::uuid
                  AND sf.deleted_at IS NULL)
),

-- Inquiries, scoped through the INSTRUCTOR (see the trap note above).
-- Cancelled, rejected and pending are all kept: a funnel is only honest
-- if every outcome is on it, and "never answered" is the finding.
inq AS (
  SELECT r.id, r.created_at, r.status, r.user_id, r.instructor_id,
         BTRIM(REGEXP_REPLACE(CONCAT_WS(' ', u.first_name, u.last_name), '\s+', ' ', 'g')) AS instructor
  FROM instructor i
  JOIN instructor_reservation_request r ON r.instructor_id = i.id
                                        AND r.deleted_at IS NULL
  JOIN users u ON u.id = i.user_id
  WHERE i.organization_id = {{org_id}}::uuid AND i.deleted_at IS NULL
),

-- CONVERSION IS ONE HASH JOIN, NOT FOUR CORRELATED EXISTS. The first
-- shape wrote each answer as its own EXISTS over `lesson_bk`, which is
-- referenced enough times that Postgres materialises it — so every
-- inquiry rescanned the whole 5,832-row CTE and the card timed out.
-- Joining on the customer key builds one hash and probes it once per
-- inquiry: 1.4s for all 3,527 SF inquiries.
--
-- The join to section_facilitator can multiply a booking row; that is
-- harmless because every output is a BOOL_OR. COALESCE is not decoration
-- either — BOOL_OR over zero rows is NULL, and an inquiry from somebody
-- who has never booked must read FALSE, not "unknown".
inq_conv AS (
  SELECT inq.id,
    COALESCE(BOOL_OR(lb.created_at >= inq.created_at
                 AND lb.created_at <  inq.created_at + INTERVAL '30 days'), FALSE) AS booked_30d,
    COALESCE(BOOL_OR(lb.created_at >= inq.created_at
                 AND lb.created_at <  inq.created_at + INTERVAL '90 days'), FALSE) AS booked_90d,
    COALESCE(BOOL_OR(sf2.facilitator_id IS NOT NULL
                 AND lb.created_at >= inq.created_at
                 AND lb.created_at <  inq.created_at + INTERVAL '30 days'), FALSE) AS booked_same_30d,
    COALESCE(BOOL_OR(lb.created_at < inq.created_at), FALSE)                       AS prior_customer
  FROM inq
  LEFT JOIN lesson_bk lb ON lb.customer_user_id = inq.user_id
                         AND lb.canceled_at IS NULL
  LEFT JOIN section_facilitator sf2 ON sf2.section_id = lb.section_id
                                    AND sf2.deleted_at IS NULL
                                    AND sf2.facilitator_id = inq.instructor_id
  GROUP BY inq.id
)

SELECT
  inq.instructor                                    AS "Instructor",
  TO_CHAR(inq.created_at AT TIME ZONE org_tz.tz, 'YYYY-MM-DD') AS "Date",
  inq.status::text                                  AS "Status",
  -- Booked ANY lesson in the window, with any instructor.
  ic.booked_30d                                     AS "Booked 30d",
  ic.booked_90d                                     AS "Booked 90d",
  -- ...and specifically with the instructor they asked. Both are emitted
  -- because they answer different questions: the org wants to know
  -- whether the inquiry produced a customer at all; an instructor
  -- filtered to themselves wants to know whether it produced one of
  -- THEIRS. One number under one label is wrong for whichever reader the
  -- label did not mean.
  ic.booked_same_30d                                AS "Booked Same 30d",
  -- Already a lesson customer when they sent it, so a conversion rate can
  -- be split into "won a new customer" and "an existing one asked for
  -- another lesson". Those are not the same event.
  ic.prior_customer                                 AS "Prior Customer"
FROM org_tz, inq
JOIN inq_conv ic ON ic.id = inq.id

ORDER BY "Date", "Instructor"
