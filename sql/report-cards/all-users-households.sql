/* ============================================================================
   All Users and Households  —  Metabase card (El Segundo / any org)
   ----------------------------------------------------------------------------
   One row per PERSON, sequenced so a household's owner leads and its members
   follow, then the next household. The reporting page groups on "Household",
   so each block gets a heading and a subtotal, and `People` makes that subtotal
   the household's size.

   Built from Dan's base query, with four changes — each of them a correctness
   fix rather than a preference:

   1. RESIDENCY COMES FROM group_type = 'residency', NOT A HARDCODED GROUP ID.
      The id in the original ('45accedc-…') is Watertown's own "Watertown
      Residents" group, and it IS residency-typed — so this returns the
      identical answer there and a correct one everywhere else. A hardcoded id
      makes the report silently wrong for every other org.
      It is also NOT a name ILIKE: "Non-Resident" CONTAINS "Resident", and that
      exact mistake reported 4,099 live memberships across 35 orgs as residents
      (see CLAUDE.md). The toggle is the truth; the name is not.

   2. IT AGGREGATES RATHER THAN JOINING. Measured 2026-09-09: one org has TWO
      residency-typed groups, so a plain LEFT JOIN fans out and duplicates that
      org's people. MIN(created_at) over the matching memberships keeps one row
      per person and answers "since when" with the earliest.

   3. EVERY ORG USER IS RETURNED, not only heads of household. The original
      INNER JOINs household on owner_id, which is 3,444 of Watertown's 5,704
      people — the other 2,260 are the children and partners a camp roster is
      actually about. `Household Role` is a column, so ticking
      "Head of Household" in the report's own filter reproduces the original
      row set exactly.

   4. THE DATE WINDOW TESTS THE HOUSEHOLD OWNER, so a household is wholly in or
      wholly out. Filtering each person by their own created_at would cut
      households in half, and half a household under a household heading is
      worse than either. Each person's own "Created At" is still a column, so
      the page can narrow further.

   organization_association has NO deleted_at (columns: id, created_at,
   updated_at, user_id, organization_id, source) — checked, not assumed.

   Tags: org_id (text), start_date / end_date (date). Both dates are written
   ::date so the card runs correctly even while a tag is typed Text — which is
   what every programmatic save regenerates them as.
   ========================================================================== */

WITH org_users AS (
  SELECT DISTINCT u.id, u.household_id
  FROM organization_association oa
  JOIN users u
    ON u.id = oa.user_id
   AND u.deleted_at IS NULL
  WHERE oa.organization_id = {{org_id}}::uuid
),

-- The household's owner, and the window's subject. A household with no owner
-- row still appears; its heading falls back to "(no household owner on file)"
-- rather than vanishing, because a person we cannot attribute is still a person.
hh AS (
  SELECT h.id                AS household_id,
         h.owner_id,
         ow.rec_id           AS owner_rec_id,
         ow.first_name       AS owner_first,
         ow.last_name        AS owner_last,
         ow.created_at       AS owner_created_at
  FROM household h
  LEFT JOIN users ow ON ow.id = h.owner_id AND ow.deleted_at IS NULL
  WHERE h.deleted_at IS NULL
    AND h.id IN (SELECT household_id FROM org_users WHERE household_id IS NOT NULL)
),

-- Residency at HOUSEHOLD level, aggregated so two residency groups cannot
-- duplicate a person. Scoped to this org's own groups: a household can belong
-- to another org's residency group and that says nothing here.
res AS (
  SELECT m.household_id, MIN(m.created_at) AS joined_at
  FROM membership m
  JOIN "group" g
    ON g.id = m.group_id
   AND g.group_type = 'residency'
   AND g.deleted_at IS NULL
   AND g.organization_id = {{org_id}}::uuid
  WHERE m.deleted_at IS NULL
    AND m.household_id IS NOT NULL
  GROUP BY m.household_id
)

SELECT
  -- The grouping level. Owner name plus Rec ID, because two households can
  -- share a surname and a heading that merges them is a wrong answer.
  COALESCE(
    NULLIF(TRIM(COALESCE(hh.owner_last, '') || ', ' || COALESCE(hh.owner_first, '')), ','),
    '(no household owner on file)'
  ) || COALESCE(' · ' || hh.owner_rec_id, '')       AS "Household",
  CASE WHEN u.id = hh.owner_id THEN 'Head of Household' ELSE 'Member' END
                                                     AS "Household Role",
  u.rec_id                                           AS "Rec ID",
  u.first_name                                       AS "First Name",
  u.last_name                                        AS "Last Name",
  u.email                                            AS "Email",
  u.phone                                            AS "Phone",
  u.street_number                                    AS "Street Number",
  u.street_name                                      AS "Street Name",
  u.city                                             AS "City",
  u.state                                            AS "State",
  u.zip_code                                         AS "Zip Code",
  u.created_at                                       AS "Created At",
  CASE WHEN res.household_id IS NOT NULL THEN 'Yes' ELSE 'No' END
                                                     AS "Residency?",
  res.joined_at                                      AS "Date Added to Residency Group",
  -- Makes the household subtotal the household's SIZE and the grand total the
  -- number of people — otherwise the roll-up has nothing to say.
  1                                                  AS "People"
FROM org_users ou
JOIN users u ON u.id = ou.id
LEFT JOIN hh  ON hh.household_id = ou.household_id
LEFT JOIN res ON res.household_id = ou.household_id
WHERE TRUE
  -- The window is the HOUSEHOLD's signup, not the person's. See note 4.
  [[ AND hh.owner_created_at >= {{start_date}}::date ]]
  [[ AND hh.owner_created_at <  {{end_date}}::date + INTERVAL '1 day' ]]
ORDER BY
  -- Households contiguous, newest first, matching the original's created_at
  -- DESC intent. The reporting page walks these rows in order and never
  -- re-sorts, so THIS is the hierarchy.
  hh.owner_created_at DESC NULLS LAST,
  hh.household_id,
  -- The owner leads its own household, then members by name.
  CASE WHEN u.id = hh.owner_id THEN 0 ELSE 1 END,
  u.last_name, u.first_name, u.rec_id
