-- ✅ Programs Schedule — SESSION GRAIN
--
-- The Programs equivalent of card 17294 (the facility rental schedule): one row
-- per MEETING, so a section that runs Mon/Wed/Fri gets three rows a week and a
-- reader can scan a date and a location and see what is on.
--
-- Variables: {{org_id}} Text, {{start_date}} Date, {{end_date}} Date
--
-- WHY A NEW CARD RATHER THAN COLUMNS ON 17295
-- 17295 is SECTION grain — one row per section for the whole window — so it has
-- nowhere to put a per-date row, and it already runs 45-140s at apex and is
-- parked on performance. Card 17298 (calendar) is session grain and carries the
-- date, time, program, section and location, but no instructor and no
-- enrolment count.
--
-- THERE IS NO SITE COLUMN, AND THAT IS THE PLATFORM, NOT AN OMISSION.
-- A facility rental attaches to courts through `reservation_court`, which is
-- what gives the rental schedule its "Facility / Site" column. A program
-- session has no equivalent: `session` carries exactly one location field
-- (`location_id`), there is no session_court join table, and `location` has no
-- parent column. Measured over a live 37-day window: of 24,579 sessions across
-- 90 orgs, **0 resolve to a court and all 24,579 resolve to a location.** So a
-- Site column would be blank for every row of every org — the dead-end this
-- repo keeps writing down. Programs are scheduled to a LOCATION; room-level
-- detail is a product gap, not a reporting one.
--
-- The court branch is therefore GONE from this card, deliberately, even though
-- 17295 and 17298 both carry one. Theirs is dead code for program sessions;
-- copying it here would have shipped a permanently empty column.
--
-- IT IS SCOPED BY CONSTRUCTION, WHICH IS THE WHOLE PERFORMANCE STORY.
-- Every CTE below joins FROM `win`. Cards 17295 and 21286 both computed the
-- org's entire history and then discarded it at a bottom [[ ]] filter — 14.0s
-- against 0.08s for one CTE at Watertown. Here the window is the first thing
-- applied, so nothing is computed for a session nobody asked about.
--
-- THE BOTTOM [[ ]] CLAUSES ARE THE AUTHORITY AND STAY.
-- `win` restricts inputs; the output filter is what governs the row set. That
-- is the sec_win lesson from 17295 — delete either and the two predicates drift
-- apart silently.

WITH cfg AS (
    -- Metabase's report timezone is America/Los_Angeles, so an un-converted
    -- timestamptz renders Pacific for every org. location.timezone is populated
    -- on all 3,099 locations across all 151 orgs; organization.config holds no
    -- timezone key. Majority location timezone, exactly as 17298 does.
    SELECT o.id AS org_id,
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

-- ── The window. Everything else joins from here. ─────────────────────────
win AS (
    SELECT se.id                AS session_id,
           se.section_id,
           se.starts_at,
           se.ends_at,
           se.location_id,
           se.canceled_at       AS session_canceled_at,
           se.capacity          AS session_capacity,
           -- A session carries its OWN registration_mode, so the grain is a
           -- per-row fact rather than a per-section one.
           COALESCE(se.registration_mode, sec.registration_mode) AS reg_mode
    FROM cfg
    JOIN "session" se ON se.organization_id = cfg.org_id
                     AND se.deleted_at IS NULL
    JOIN section sec  ON sec.id = se.section_id
                     AND sec.deleted_at IS NULL
                     AND sec.archived_at IS NULL
                     AND sec.section_code IS DISTINCT FROM 'DNE'
    WHERE TRUE
      -- Sargable: the bound is converted to an instant rather than the column
      -- being wrapped, so session(organization_id, starts_at) stays usable.
      [[ AND se.starts_at >= (DATE({{start_date}})::timestamp AT TIME ZONE (SELECT tz FROM cfg)) ]]
      [[ AND se.starts_at <  ((DATE({{end_date}})::timestamp + interval '1 day') AT TIME ZONE (SELECT tz FROM cfg)) ]]
),

sections AS (
    SELECT DISTINCT section_id FROM win
),

-- ── Confirmed participants, PER SESSION ──────────────────────────────────
-- The two booking types are what make the two registration grains work, and
-- the arithmetic is the same for both — lifted from 17295's `slots` CTE so the
-- two reports cannot disagree about one section:
--   type='section' — one registration for the run, so it counts on EVERY
--                    meeting of that section. This is why a per-section row
--                    repeats its number on each date.
--   type='session' — a registration for one meeting, counting only there.
-- A section may carry both; DISTINCT on the pair keeps a participant counted
-- once per session.
enr AS (
    SELECT x.session_id, COUNT(DISTINCT x.user_id) AS enrolled
    FROM (
        SELECT w.session_id, b.participant_user_id AS user_id
        FROM win w
        JOIN booking b ON b.section_id = w.section_id
                      AND b.deleted_at IS NULL
                      AND b.canceled_at IS NULL
                      AND b.status = 'confirmed'
                      AND b.type = 'section'
        UNION
        SELECT b.session_id, b.participant_user_id
        FROM win w
        JOIN booking b ON b.session_id = w.session_id
                      AND b.deleted_at IS NULL
                      AND b.canceled_at IS NULL
                      AND b.status = 'confirmed'
                      AND b.type = 'session'
    ) x
    GROUP BY x.session_id
),

-- ── Instructor ───────────────────────────────────────────────────────────
-- TWO LEVELS, AND THE SESSION'S OWN WINS. `session_facilitator` is populated
-- on 11,812 of 24,579 sessions in a live window (48%), against 3,320 of 6,109
-- sections (54%) carrying a section-level one — so who teaches is genuinely a
-- per-DATE fact for nearly half of all meetings. Reading the section's list
-- alone would print the regular instructor's name against a date somebody else
-- is covering, which is exactly what a schedule gets read for.
--
-- facilitator_id IS instructor.id, NOT users.id. The obvious users.id join
-- matches 0 of 34,070 rows platform-wide and, being a LEFT JOIN, would render
-- an empty column for every org without erroring. The name expression is
-- lifted verbatim from 17295 / 17755, so Programs, Instructor Payout and this
-- card cannot print different names for one section.
sfac AS (
    SELECT sf.session_id,
           STRING_AGG(DISTINCT BTRIM(REGEXP_REPLACE(CONCAT_WS(' ', u.first_name, u.last_name), '\s+', ' ', 'g')), ', ') AS instructor_names,
           COUNT(DISTINCT i.id)::int AS instructor_count
    FROM win w
    JOIN session_facilitator sf ON sf.session_id = w.session_id
                               AND sf.deleted_at IS NULL
    JOIN instructor i           ON i.id = sf.facilitator_id
                               AND i.deleted_at IS NULL
    JOIN users u                ON u.id = i.user_id
    GROUP BY sf.session_id
),
fac AS (
    SELECT sf.section_id,
           STRING_AGG(DISTINCT BTRIM(REGEXP_REPLACE(CONCAT_WS(' ', u.first_name, u.last_name), '\s+', ' ', 'g')), ', ') AS instructor_names,
           COUNT(DISTINCT i.id)::int AS instructor_count
    FROM cfg
    JOIN sections sx            ON TRUE
    JOIN section_facilitator sf ON sf.section_id = sx.section_id
                               AND sf.organization_id = cfg.org_id
                               AND sf.deleted_at IS NULL
    JOIN instructor i           ON i.id = sf.facilitator_id
                               AND i.organization_id = cfg.org_id
                               AND i.deleted_at IS NULL
    JOIN users u                ON u.id = i.user_id
    GROUP BY sf.section_id
),

-- ── Waitlist. A section-level fact, so it repeats on each date, exactly
--    like a per-section enrolment count. ────────────────────────────────
wl AS (
    SELECT COALESCE(w.section_id, se.section_id) AS section_id,
           COUNT(DISTINCT w.participant_user_id) FILTER (WHERE w.canceled_at IS NULL) AS waitlist_active
    FROM cfg
    JOIN waitlist w      ON w.organization_id = cfg.org_id AND w.deleted_at IS NULL
    LEFT JOIN "session" se ON se.id = w.session_id
                          AND se.organization_id = cfg.org_id
                          AND se.deleted_at IS NULL
    WHERE COALESCE(w.section_id, se.section_id) IN (SELECT section_id FROM sections)
    GROUP BY COALESCE(w.section_id, se.section_id)
),

-- Ages / grades, lifted verbatim from 17298 so the two schedules label
-- eligibility the same way.
elig AS (
    SELECT ergl.section_id,
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
    JOIN eligibility_rule_group erg ON erg.id = ergl.eligibility_rule_group_id
                                   AND erg.deleted_at IS NULL
                                   AND erg.type = 'registration'
    JOIN eligibility_rule er        ON er.eligibility_rule_group_id = erg.id
                                   AND er.deleted_at IS NULL
                                   AND er.type = 'condition'
                                   AND er.attribute_name IN ('age', 'grade')
    WHERE ergl.deleted_at IS NULL
      AND ergl.section_id IN (SELECT section_id FROM sections)
    GROUP BY ergl.section_id
)

SELECT
    (w.starts_at AT TIME ZONE cfg.tz)::date                  AS "Date",
    TO_CHAR((w.starts_at AT TIME ZONE cfg.tz), 'Dy')         AS "Day",
    TO_CHAR((w.starts_at AT TIME ZONE cfg.tz), 'HH12:MI AM') AS "Begin",
    TO_CHAR((w.ends_at   AT TIME ZONE cfg.tz), 'HH12:MI AM') AS "End",
    TO_CHAR((w.starts_at AT TIME ZONE cfg.tz), 'HH24:MI')    AS "Begin Sort",

    COALESCE(loc.name, 'Unassigned')                         AS "Location",

    prog.name                                                AS "Program",
    sec.name                                                 AS "Section",
    sec.id::text                                             AS "Section ID",
    w.session_id::text                                       AS "Session ID",

    COALESCE(sfac.instructor_names, fac.instructor_names)    AS "Instructor",
    COALESCE(sfac.instructor_count, fac.instructor_count, 0)  AS "Instructor Count",
    -- Which level answered, so the page can mark a cover rather than silently
    -- showing a different name than the section's own. NULL when nobody is on
    -- file, which is not the same fact as either.
    CASE WHEN sfac.instructor_names IS NOT NULL THEN 'session'
         WHEN fac.instructor_names  IS NOT NULL THEN 'section'
         ELSE NULL END                                       AS "Instructor Level",

    COALESCE(enr.enrolled, 0)::int                           AS "Enrolled",
    -- NULL, never 0, when no capacity is set: "22 of nothing" is a statement
    -- about the section's configuration, and a 0 would read as "no room".
    COALESCE(w.session_capacity, sec.capacity)               AS "Capacity",
    w.reg_mode                                               AS "Registration Mode",
    COALESCE(wl.waitlist_active, 0)::int                     AS "Waitlist",
    COALESCE(elig.eligibility_label, '')                     AS "Eligibility",

    CASE
        WHEN (sec.pricing_policy->'default'->>'cents') IS NULL THEN NULL
        WHEN w.reg_mode = 'per-session'
            THEN TO_CHAR((sec.pricing_policy->'default'->>'cents')::int / 100.0, 'FM$999,990.00') || '/session'
        ELSE TO_CHAR((sec.pricing_policy->'default'->>'cents')::int / 100.0, 'FM$999,990.00')
    END                                                      AS "Price",

    -- THE STATUS OF THIS MEETING, not of its section's registration window.
    -- A schedule reader wants to know whether the room is in use, so a
    -- cancelled meeting stays on the page and says so — the space is free.
    CASE
        WHEN w.session_canceled_at IS NOT NULL THEN 'Canceled'
        WHEN sec.canceled_at       IS NOT NULL THEN 'Canceled'
        WHEN w.ends_at   < NOW()               THEN 'Ran'
        WHEN w.starts_at <= NOW()              THEN 'In Progress'
        ELSE 'Upcoming'
    END                                                      AS "Status",

    -- 21% of sessions in a live window belong to a section that was never
    -- published (4,867 of 22,955, across 57 orgs). They still hold the room,
    -- so they are emitted and MARKED rather than dropped — excluded is never
    -- hidden. The page decides whether to show them.
    (sec.publish_at IS NOT NULL AND sec.publish_at <= NOW()) AS "Published"

FROM win w
CROSS JOIN cfg
JOIN section sec  ON sec.id = w.section_id
JOIN program prog ON prog.id = sec.program_id AND prog.deleted_at IS NULL
LEFT JOIN enr  ON enr.session_id  = w.session_id
LEFT JOIN sfac ON sfac.session_id = w.session_id
LEFT JOIN fac  ON fac.section_id  = w.section_id
LEFT JOIN wl   ON wl.section_id   = w.section_id
LEFT JOIN elig ON elig.section_id = w.section_id
-- One join, because session.location_id is always a location for a program
-- session — see the header. 17298's `court site` branch is dead here.
LEFT JOIN location loc            ON loc.id = w.location_id AND loc.deleted_at IS NULL
WHERE TRUE
  -- The authority. `win` scopes the inputs; these govern the output.
  [[ AND (w.starts_at AT TIME ZONE cfg.tz)::date >= DATE({{start_date}}) ]]
  [[ AND (w.starts_at AT TIME ZONE cfg.tz)::date <= DATE({{end_date}}) ]]
ORDER BY "Date", "Location", "Begin Sort", "Program", "Section"
