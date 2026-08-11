/* ============================================================
   Community Intelligence — Full Household + Revenue
   Variables: {{org_id}} Text
   Dynamic residency group lookup (no hardcoded group_id)
   ============================================================ */

WITH params AS (
  SELECT {{org_id}}::uuid AS org_id
),

res_group AS (
  SELECT g.id
  FROM "group" g
  WHERE g.deleted_at IS NULL
    AND g.organization_id = (SELECT org_id FROM params)
    AND (g.group_type ILIKE '%residen%' OR g.name ILIKE '%residen%')
),

org_households AS (
  SELECT DISTINCT
    h.id          AS household_id,
    h.owner_id    AS hoh_user_id
  FROM organization_association oa
  JOIN users hoh
    ON hoh.id = oa.user_id
   AND hoh.deleted_at IS NULL
  JOIN household h
    ON h.owner_id = hoh.id
   AND h.deleted_at IS NULL
  WHERE oa.organization_id = (SELECT org_id FROM params)
),

hh_revenue AS (
  SELECT
    u.household_id,
    SUM(CASE WHEN ilr.transaction_type = 'payment'
         THEN ilr.order_item_transaction_amount ELSE 0 END) / 100.0  AS gross_revenue,
    SUM(CASE WHEN ilr.transaction_type = 'refund'
         THEN ilr.order_item_transaction_amount ELSE 0 END) / 100.0  AS total_refunds,
    COUNT(DISTINCT ilr.order_item_id)                                 AS item_count,
    MIN(ilr.datetime_at_primary_timezone)                             AS first_txn,
    MAX(ilr.datetime_at_primary_timezone)                             AS last_txn,
    SUM(CASE WHEN ilr.transaction_type = 'payment' AND ilr.order_item_type = 'reservation-enrollment'
         THEN ilr.order_item_transaction_amount ELSE 0 END) / 100.0  AS program_revenue,
    SUM(CASE WHEN ilr.transaction_type = 'payment' AND ilr.order_item_type = 'site-reservation'
         THEN ilr.order_item_transaction_amount ELSE 0 END) / 100.0  AS facility_revenue,
    SUM(CASE WHEN ilr.transaction_type = 'payment' AND ilr.order_item_type = 'transaction-fee'
         THEN ilr.order_item_transaction_amount ELSE 0 END) / 100.0  AS fee_revenue,
    SUM(CASE WHEN ilr.transaction_type = 'payment' AND ilr.order_item_type = 'product'
         THEN ilr.order_item_transaction_amount ELSE 0 END) / 100.0  AS product_revenue
  FROM materialized.item_log_report ilr
  JOIN users u ON u.id = ilr.customer_id
  WHERE ilr.organization_id = (SELECT org_id FROM params)
  GROUP BY u.household_id
)

SELECT
  oh.household_id                                  AS "Household ID",
  CASE
    WHEN u.id = oh.hoh_user_id THEN 'Head of Household'
    ELSE 'Member'
  END                                              AS "Role",
  hoh.first_name || ' ' || hoh.last_name           AS "HoH Name",
  u.created_at                                     AS "Created At",
  u.rec_id                                         AS "Rec ID",
  u.first_name                                     AS "First Name",
  u.last_name                                      AS "Last Name",
  COALESCE(NULLIF(u.email, ''), hoh.email)         AS "Email",
  COALESCE(
    NULLIF(
      REGEXP_REPLACE(
        REGEXP_REPLACE(u.phone, '[^0-9]', '', 'g'),
        '^(\d{3})(\d{3})(\d{4})$', '\1-\2-\3'
      ), ''
    ),
    REGEXP_REPLACE(
      REGEXP_REPLACE(hoh.phone, '[^0-9]', '', 'g'),
      '^(\d{3})(\d{3})(\d{4})$', '\1-\2-\3'
    )
  )                                                AS "Phone",
  hoh.street_number                                AS "Street Number",
  hoh.street_name                                  AS "Street Name",
  hoh.city                                         AS "City",
  hoh.state                                        AS "State",
  hoh.zip_code                                     AS "Zip Code",
  TO_CHAR(p.date_of_birth, 'MM/DD/YYYY')          AS "Date of Birth",
  DATE_PART('year', AGE(p.date_of_birth))          AS "Age",
  p.grade                                          AS "Grade",
  p.gender                                         AS "Gender",
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM res_group) THEN NULL
    WHEN res_m.id IS NOT NULL THEN 'Yes'
    ELSE 'No'
  END                                              AS "Residency?",

  /* ── Contact completeness ──
     v-fix 2026-08-10: the two columns were identical copies of the same
     EXISTS ("household has ANY contact record"). Contact designation lives
     on household_contact_user.type ('emergencyContact' / 'authorizedPickup'),
     so each column now checks its own type. Validated on Apex: 106 households
     have an emergency contact, 17 have an authorized pickup (old logic
     reported 111 for both). */
  CASE WHEN EXISTS (
    SELECT 1 FROM household_contact hc
    JOIN household_contact_user hcu
      ON hcu.household_contact_id = hc.id
     AND hcu.type = 'emergencyContact'
    WHERE hc.household_id = oh.household_id
  ) THEN true ELSE false END                       AS "Has Emergency Contact",

  CASE WHEN EXISTS (
    SELECT 1 FROM household_contact hc
    JOIN household_contact_user hcu
      ON hcu.household_contact_id = hc.id
     AND hcu.type = 'authorizedPickup'
    WHERE hc.household_id = oh.household_id
  ) THEN true ELSE false END                       AS "Has Authorized Pickup",

  (u.confirmed_at IS NOT NULL)                     AS "Account Confirmed",

  /* ── Revenue ── */
  COALESCE(rev.gross_revenue, 0)                   AS "Gross Revenue",
  COALESCE(rev.total_refunds, 0)                   AS "Refunds",
  COALESCE(rev.gross_revenue, 0)
    - COALESCE(rev.total_refunds, 0)               AS "Net Revenue",
  COALESCE(rev.item_count, 0)                      AS "Items Purchased",
  rev.first_txn                                    AS "First Transaction",
  rev.last_txn                                     AS "Last Transaction",
  COALESCE(rev.program_revenue, 0)                 AS "Program Revenue",
  COALESCE(rev.facility_revenue, 0)                AS "Facility Revenue",
  COALESCE(rev.fee_revenue, 0)                     AS "Fee Revenue",
  COALESCE(rev.product_revenue, 0)                 AS "Product Revenue"

FROM org_households oh
JOIN users hoh
  ON hoh.id = oh.hoh_user_id
JOIN users u
  ON u.household_id = oh.household_id
 AND u.deleted_at IS NULL
LEFT JOIN profile p
  ON p.user_id = u.id
 AND p.deleted_at IS NULL
LEFT JOIN membership res_m
  ON res_m.household_id = oh.household_id
 AND res_m.group_id IN (SELECT id FROM res_group)
 AND res_m.deleted_at IS NULL
 AND res_m.canceled_at IS NULL
 AND res_m.start_at <= now()
 AND (res_m.end_at IS NULL OR res_m.end_at >= now())
LEFT JOIN hh_revenue rev
  ON rev.household_id = oh.household_id

WHERE 1=1

ORDER BY oh.household_id,
         CASE WHEN u.id = oh.hoh_user_id THEN 0 ELSE 1 END,
         u.first_name