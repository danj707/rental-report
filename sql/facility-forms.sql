/* ============================================================
   Facility Rental Forms — Metabase card 20626
   ("✅ Facility Rental Forms (required information)")
   Collection 3532, database 4 (Rec-Prod-ReadReplica).
   Variable: {{org_id}}

   Powers the "Requests" column + the inline form panel on the facility rental
   report (public/facility.html), and the same panel printed into the PDF.

   WHY THIS IS A SEPARATE CARD — same argument as card 20230 (permits): it keys
   on "Reservation ID", which is facility_rental.id, exactly what card 17294
   already emits under that name. So forms attach to schedule rows with NO
   change to 17294 — no date-tag reset, and no risk to the most-used report in
   the app. Tag type does not matter here either: the route echoes the card's
   own registered parameter types back, so an API edit needs no UI re-flip.

   -- The join ---------------------------------------------------------------
   form_submission_lookup is polymorphic (booking_id, facility_rental_id,
   rental_application_id, product_purchase_id). Rentals hang off
   facility_rental_id. Measured 2026-08-25: 10,870 submissions platform-wide are
   linked that way, across 93 orgs.

   -- Why the schema travels with the answers ---------------------------------
   The submission is keyed by each element's MACHINE NAME, and those names are
   frequently meaningless: every question on Watertown's "Field/ Court/ Track/
   Rink Permit Application 2026" is named question1..question9, and the picnic
   form's `question2` is silently "Grill Request". Without the schema the
   answers cannot be labelled at all. jsonb also does not preserve key order, so
   the schema is the ONLY source of question order.

   -- PANELS MUST BE FLATTENED, or 665 questions disappear --------------------
   A `panel` element nests its real questions in its own `elements` array, while
   their ANSWERS are stored FLAT at the top level of the submission (verified on
   "Leader in Training Application": panel child `high-school-name` answers as
   submission->>'high-school-name'). Reading only the top-level elements array
   therefore drops them: 212 panels across 103 forms hold 665 child questions,
   and on that form a flat read resolves 0 of 11 answers versus 11 of 11 here.
   They are flattened in this card so every consumer gets one flat, correctly
   ordered question list. Panels with no children carry no question and fall out
   on their own.
   All 1,212 forms on the platform are single-page, so pages->0 is safe -- the
   same assumption card 17296 (roster) already makes.

   -- "Schema" is emitted ONCE PER FORM, not once per submission --------------
   A waiver's single question carries 3,257 characters of legalese, and Watertown
   alone has 484 submissions of that one form -- repeating the schema on every row
   would be ~1.6 MB of pure duplication (measured: 17 KB this way). So it rides
   only on the first row of each form (row_number() = 1) and is NULL elsewhere;
   the server reassembles a {formId -> elements} map. Consumers must therefore
   read the schema from the whole result set, never from a single row.

   -- Deliberately NOT here: forms requested but not returned -----------------
   form_lookup records which forms were ASKED of a rental. Measured at Watertown:
   1,137 requested vs 1,136 returned -- exactly ONE outstanding. An "outstanding
   form" state would be a red flag that fires on ~0.1% of rentals while implying
   the 62% of rentals with no form at all are incomplete. They are not: no form
   was ever requested of them. A blank Requests cell is legitimately blank.

   SQL of record: sql/facility-forms.sql in danj707/rental-report.
   ============================================================ */
WITH subs AS (
  SELECT
    fsl.facility_rental_id                       AS rental_id,
    fs.id                                        AS submission_id,
    fs.form_id                                   AS form_id,
    f.name                                       AS form_name,
    fs.created_at                                AS created_at,
    fs.submission                                AS submission
  FROM form_submission_lookup fsl
  JOIN form_submission fs
    ON fs.id = fsl.form_submission_id
   AND fs.deleted_at IS NULL
  JOIN form f
    ON f.id = fs.form_id
   AND f.deleted_at IS NULL
  WHERE fsl.deleted_at IS NULL
    AND fsl.organization_id = {{org_id}}::uuid
    AND fsl.facility_rental_id IS NOT NULL
),

/* Top-level elements of every form actually used by this org's rentals.
   Scoped to those forms rather than all of the org's forms: Watertown has 27
   forms but only 9 ever reach a rental, and the unused ones include the
   6,225-character flag-football rules. */
elems AS (
  SELECT
    f.id       AS form_id,
    e.el       AS el,
    e.ord      AS ord
  FROM form f
  CROSS JOIN LATERAL jsonb_array_elements(f.schema -> 'pages' -> 0 -> 'elements')
       WITH ORDINALITY AS e(el, ord)
  WHERE f.deleted_at IS NULL
    AND f.id IN (SELECT DISTINCT form_id FROM subs)
    AND jsonb_typeof(f.schema -> 'pages' -> 0 -> 'elements') = 'array'
),

/* Flatten panels one level. ord/sub_ord preserve the on-screen order of the
   original form: a panel's children sort inside their parent's slot. */
flat AS (
  SELECT form_id, ord, 0 AS sub_ord, el
  FROM elems
  WHERE COALESCE(el ->> 'type', '') <> 'panel'

  UNION ALL

  SELECT e.form_id, e.ord, c.ord AS sub_ord, c.el
  FROM elems e
  CROSS JOIN LATERAL jsonb_array_elements(e.el -> 'elements')
       WITH ORDINALITY AS c(el, ord)
  WHERE e.el ->> 'type' = 'panel'
    AND jsonb_typeof(e.el -> 'elements') = 'array'
),

/* One compact element list per form. `choices` is carried verbatim because a
   choice ANSWER is an opaque value ("Item 1"), and only choices[].value ->
   choices[].text turns it back into "I Agree". The values are arbitrary and not
   in positional order, so the array cannot be reconstructed from position.
   jsonb_strip_nulls keeps absent keys out of the payload. */
schema_json AS (
  SELECT
    form_id,
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'name',     el ->> 'name',
        'title',    el ->> 'title',
        'type',     el ->> 'type',
        'required', CASE WHEN (el ->> 'isRequired') = 'true' THEN true END,
        'choices',  el -> 'choices'
      ))
      ORDER BY ord, sub_ord
    ) AS elements
  FROM flat
  GROUP BY form_id
)

SELECT
  s.rental_id                                    AS "Reservation ID",
  s.form_id                                      AS "Form ID",
  s.form_name                                    AS "Form Name",
  /* Preformatted on purpose. A bare YYYY-MM-DD is parsed by new Date() as UTC
     midnight and renders as the PREVIOUS day in every US timezone -- the Fast
     Track bug. The client never parses this string. */
  to_char(
    s.created_at AT TIME ZONE COALESCE(
      NULLIF(org.config #>> '{general,primaryTimezone}', ''), 'UTC'
    ),
    'Mon FMDD, YYYY'
  )                                              AS "Submitted",
  s.submission                                   AS "Answers",
  CASE
    WHEN ROW_NUMBER() OVER (PARTITION BY s.form_id ORDER BY s.submission_id) = 1
    THEN sj.elements
  END                                            AS "Schema"
FROM subs s
JOIN organization org
  ON org.id = {{org_id}}::uuid
LEFT JOIN schema_json sj
  ON sj.form_id = s.form_id
ORDER BY s.rental_id, s.created_at, s.submission_id
