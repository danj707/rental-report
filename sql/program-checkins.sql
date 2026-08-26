-- Metabase card 18547 — "✅ Program Check In/Out Sections" (SHARED)
-- public UUID cb6fd909-72d3-446b-930b-c0382da02d62 · SHARED_UUIDS['program-checkins']
-- MIRROR of the live card. The live card is the source of truth: read it
-- (metabase://question/18547) and apply changes to THAT, then mirror back here.
-- Program Check-Ins (session attendance) — SHARED card
-- Aggregated to one row per section. No participant-level rows.
--
-- v2 (2026-08-26): adds "Absent" / "Absentees" from the same attendance_event
-- log. Three things about that are load-bearing:
--
--  1. attendance_event is APPEND-ONLY — there is no deleted_at — so an admin
--     undoing a mark writes a `marked_absent_undone` row and the original stays.
--     A naive COUNT(*) FILTER (WHERE type='marked_absent') therefore counts
--     absences that were taken back: measured platform-wide, that is Chico 13
--     instead of 12 and Apex 6 instead of 5. So absence is a STATE, resolved by
--     taking the LATEST event per (session, participant) and keeping only the
--     pairs whose latest event is the mark.
--  2. The state is resolved over ALL history, then the surviving mark's own date
--     is what gets filtered into the window. Resolving inside the window instead
--     would count a mark whose undo happens to fall the other side of the range.
--  3. The check-in/check-out aggregate is lifted into its own CTE UNCHANGED, and
--     the section list is the UNION of sections with attendance and sections with
--     surviving absences — so a section where everyone was marked absent and
--     nobody scanned in still gets a row, and no existing figure moves.
WITH att AS (
  SELECT
    ss.section_id,
    COUNT(*) FILTER (WHERE ae.type = 'check_in')                                AS check_ins,
    COUNT(*) FILTER (WHERE ae.type = 'check_out')                               AS check_outs,
    COUNT(DISTINCT ae.participant_user_id) FILTER (WHERE ae.type = 'check_in')   AS attendees_in,
    COUNT(DISTINCT ae.participant_user_id) FILTER (WHERE ae.type = 'check_out')  AS attendees_out
  FROM public.attendance_event ae
  JOIN public.session ss ON ss.id = ae.target_id AND ae.target_type = 'session'
    AND ss.organization_id = {{org_id}}::uuid
  WHERE ae.organization_id = {{org_id}}::uuid
    AND ae.type IN ('check_in','check_out')
    AND ss.deleted_at IS NULL AND ss.canceled_at IS NULL
    [[AND ae.created_at >= {{start_date}}]]
    [[AND ae.created_at <  {{end_date}} + INTERVAL '1 day']]
  GROUP BY ss.section_id
),
-- Current absence STATE per (session, participant): the latest mark/undo wins.
absent_state AS (
  SELECT DISTINCT ON (ae.target_id, ae.participant_user_id)
    ae.target_id           AS session_id,
    ae.participant_user_id AS participant_user_id,
    ae.type                AS type,
    ae.created_at          AS created_at
  FROM public.attendance_event ae
  WHERE ae.organization_id = {{org_id}}::uuid
    AND ae.target_type = 'session'
    AND ae.type IN ('marked_absent','marked_absent_undone')
  ORDER BY ae.target_id, ae.participant_user_id, ae.created_at DESC, ae.id DESC
),
abs AS (
  SELECT
    ss.section_id,
    COUNT(*)                                    AS absent_marks,
    COUNT(DISTINCT a.participant_user_id)        AS absentees
  FROM absent_state a
  JOIN public.session ss ON ss.id = a.session_id
    AND ss.organization_id = {{org_id}}::uuid
  WHERE a.type = 'marked_absent'
    AND ss.deleted_at IS NULL AND ss.canceled_at IS NULL
    [[AND a.created_at >= {{start_date}}]]
    [[AND a.created_at <  {{end_date}} + INTERVAL '1 day']]
  GROUP BY ss.section_id
),
secs AS (
  SELECT section_id FROM att
  UNION
  SELECT section_id FROM abs
)
SELECT
  prog.name        AS "Program",
  sec.id           AS "Section Id",
  sec.name         AS "Section",
  sec.section_code AS "Section Code",
  COALESCE(att.check_ins,     0) AS "Check Ins",
  COALESCE(att.check_outs,    0) AS "Check Outs",
  COALESCE(att.attendees_in,  0) AS "Attendees In",
  COALESCE(att.attendees_out, 0) AS "Attendees Out",
  -- Sessions missed, after undone marks are removed. One per participant per
  -- session, so it is comparable with "Check Ins" rather than with enrollment.
  COALESCE(abs.absent_marks,  0) AS "Absent",
  -- Distinct people with at least one surviving absence, comparable with
  -- "Attendees In".
  COALESCE(abs.absentees,     0) AS "Absentees"
FROM secs
JOIN public.section sec  ON sec.id = secs.section_id
  AND sec.organization_id = {{org_id}}::uuid
  AND sec.deleted_at IS NULL AND sec.canceled_at IS NULL AND sec.archived_at IS NULL
JOIN public.program prog ON prog.id = sec.program_id
  AND prog.organization_id = {{org_id}}::uuid
  AND prog.deleted_at IS NULL
LEFT JOIN att ON att.section_id = secs.section_id
LEFT JOIN abs ON abs.section_id = secs.section_id
ORDER BY "Check Ins" DESC;
