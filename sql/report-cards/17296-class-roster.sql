/* Card 17296: Class Roster — v-next SPEED REFACTOR
   Change (output identical): the Emergency Contacts and Authorized Pickups
   subqueries aggregated household_contact_user for EVERY user on the platform
   before joining. Both are now scoped to this org's booking participants.
*/
/* ============================================================
   Class Roster
   Grain: 1 row per PARTICIPANT per SESSION (or SECTION)
   Includes ENROLLED + CANCELLED participants
   Variables: {{org_id}} Text, {{start_date}} Date, {{end_date}} Date, {{section_name}} Text
   ============================================================ */
SELECT
  u_part.rec_id                                                          AS "Rec ID",
  u_part.first_name                                                      AS "First Name",
  u_part.last_name                                                       AS "Last Name",
  p_part.date_of_birth                                                   AS "Date of Birth",
  CASE WHEN p_part.date_of_birth IS NOT NULL
    THEN DATE_PART('year', AGE(p_part.date_of_birth))::int END           AS "Age",
  p_part.grade                                                           AS "Grade",
  p_part.gender                                                          AS "Gender",
  COALESCE(NULLIF(u_part.phone, ''), u_parent.phone)                     AS "Phone",
  COALESCE(NULLIF(u_part.email, ''), u_parent.email)                     AS "Email",
  TRIM(COALESCE(u_parent.first_name, '') || ' ' || COALESCE(u_parent.last_name, '')) AS "Household Owner",
  u_parent.email                                                         AS "Owner Email",
  u_parent.phone                                                         AS "Owner Phone",
  ec.val                                                                 AS "Emergency Contacts",
  ap.val                                                                 AS "Authorized Pickups",
  c.name                                                                 AS "Class",
  section.name                                                           AS "Section",
  TO_CHAR(
    COALESCE(
      (sess.starts_at          AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text)::date,
      (first_session.starts_at AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text)::date
    ),
    'MM/DD/YYYY'
  )                                                                      AS "Session Date",
  TO_CHAR(
    (COALESCE(sess.starts_at, first_session.starts_at)
     AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text)::time,
    'HH12:MIam'
  )                                                                      AS "Session Start",
  TO_CHAR(
    (COALESCE(sess.ends_at, first_session.ends_at)
     AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text)::time,
    'HH12:MIam'
  )                                                                      AS "Session End",
  CASE WHEN b.canceled_at IS NOT NULL THEN 'Cancelled' ELSE 'Enrolled' END AS "Status",
  TO_CHAR(b.created_at AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text, 'MM/DD/YYYY') AS "Registered",
  (
    SELECT json_build_object(
      'submission', fs.submission,
      'schema', f.schema->'pages'->0->'elements'
    )
    FROM form_submission fs
    JOIN form_submission_booking fsb ON fsb.form_submission_id = fs.id
    JOIN form f ON f.id = fs.form_id
    WHERE fsb.booking_id = b.id
      AND fs.deleted_at IS NULL
    LIMIT 1
  )                                                                      AS "Form Responses"

FROM booking b
JOIN organization org
  ON org.id = b.organization_id
JOIN users u_parent
  ON u_parent.id = b.customer_user_id
JOIN users u_part
  ON u_part.id = b.participant_user_id
LEFT JOIN profile p_part
  ON p_part.user_id = u_part.id
 AND p_part.deleted_at IS NULL
LEFT JOIN "session" sess
  ON sess.id = b.session_id
 AND sess.deleted_at IS NULL
JOIN section
  ON section.id = COALESCE(sess.section_id, b.section_id)
 AND section.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT starts_at, ends_at
  FROM "session" s
  WHERE s.section_id = section.id
    AND s.deleted_at IS NULL
  ORDER BY s.starts_at ASC
  LIMIT 1
) first_session ON TRUE
JOIN class c
  ON c.id = section.class_id
 AND c.deleted_at IS NULL

/* ── Emergency contacts per participant (pre-aggregated) ───── */
LEFT JOIN (
  SELECT hcu.user_id, STRING_AGG(
    COALESCE(
      uc.first_name || ' ' || uc.last_name,
      jsonb_extract_path_text(CAST(hc.contact_info AS jsonb), 'firstName')
        || ' ' || jsonb_extract_path_text(CAST(hc.contact_info AS jsonb), 'lastName')
    )
    || ' (' || hcu.relationship || ') '
    || COALESCE(uc.phone, jsonb_extract_path_text(CAST(hc.contact_info AS jsonb), 'phone'), ''),
    ' | ' ORDER BY hcu.created_at
  ) AS val
  FROM household_contact_user hcu
  JOIN household_contact hc ON hc.id = hcu.household_contact_id
  LEFT JOIN users uc ON uc.id = hc.reference_user_id AND uc.deleted_at IS NULL
  WHERE hcu.type = 'emergencyContact'
    AND hcu.user_id IN (SELECT b2.participant_user_id FROM booking b2
                        WHERE b2.organization_id = {{org_id}}::uuid
                          AND b2.deleted_at IS NULL
                          AND b2.participant_user_id IS NOT NULL)
  GROUP BY hcu.user_id
) ec ON ec.user_id = u_part.id

/* ── Authorized pickups per participant (pre-aggregated) ───── */
LEFT JOIN (
  SELECT hcu.user_id, STRING_AGG(
    COALESCE(
      uc.first_name || ' ' || uc.last_name,
      jsonb_extract_path_text(CAST(hc.contact_info AS jsonb), 'firstName')
        || ' ' || jsonb_extract_path_text(CAST(hc.contact_info AS jsonb), 'lastName')
    )
    || ' (' || hcu.relationship || ') '
    || COALESCE(uc.phone, jsonb_extract_path_text(CAST(hc.contact_info AS jsonb), 'phone'), ''),
    ' | ' ORDER BY hcu.created_at
  ) AS val
  FROM household_contact_user hcu
  JOIN household_contact hc ON hc.id = hcu.household_contact_id
  LEFT JOIN users uc ON uc.id = hc.reference_user_id AND uc.deleted_at IS NULL
  WHERE hcu.type = 'authorizedPickup'
    AND hcu.user_id IN (SELECT b2.participant_user_id FROM booking b2
                        WHERE b2.organization_id = {{org_id}}::uuid
                          AND b2.deleted_at IS NULL
                          AND b2.participant_user_id IS NOT NULL)
  GROUP BY hcu.user_id
) ap ON ap.user_id = u_part.id

WHERE
  b.organization_id = {{org_id}}::uuid
  AND b.type IN ('session', 'section')
  AND b.deleted_at IS NULL
  AND b.status IN ('confirmed', 'cancelled')
  AND section.is_rec_managed IS FALSE
  [[ AND COALESCE(
      (sess.starts_at          AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text)::date,
      (first_session.starts_at AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text)::date
    ) >= {{start_date}} ]]
  [[ AND COALESCE(
      (sess.starts_at          AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text)::date,
      (first_session.starts_at AT TIME ZONE (org.config #>> '{general,primaryTimezone}')::text)::date
    ) <= {{end_date}} ]]
  [[ AND section.name ILIKE '%' || {{section_name}} || '%' ]]

ORDER BY
  section.name,
  "Session Date",
  u_part.last_name,
  u_part.first_name
