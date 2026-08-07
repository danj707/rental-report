/* ============================================================
   GL Code Rollup — Metabase card 17293 ("✅ GL Code Report")
   Collection 3532, database 4 (Rec-Prod-ReadReplica).
   Variables: {{org_id}} Text, {{start_date}} Date, {{end_date}} Date

   THIS FILE is the source of truth for the card SQL. Applying it via the
   Metabase API/MCP regenerates ALL template tags as Text — after saving,
   re-flip Start Date / End Date back to type Date in the Metabase UI, or the
   server's date/single params stop matching and the report errors/serves stale
   (see CLAUDE.md).

   CHANGE (2026-08): fix the TOTALS row / summary-box payment & refund COUNTS.
   The per-GL "Number of Payments" (COUNT DISTINCT transaction_event_id within a
   gl_code+desk group) is correct per row but NOT additive: one payment fans out
   across multiple GL codes (e.g. a card payment books the item to one GL and its
   `Transaction Fees for card-*` line to another), so summing the column app-side
   double-counts (Lewisburg Jul 23-31 2026: 1,993 shown vs 1,281 true).
   Fix: expose per-desk distinct counts. A transaction_event_id has exactly one
   desk, so per-desk distinct counts ARE additive across desks — the app sums
   them once per desk (dedup) for a correct grand/ filtered total.
   ============================================================ */
WITH base AS (
  SELECT
    ilr.organization_id,
    ilr.datetime_at_primary_timezone::date AS tx_date,

    ilr.order_item_transaction_gl_code AS gl_code_raw,

    CASE
      WHEN ilr.order_item_transaction_gl_code ~ '^[0-9]+$'
        THEN ilr.order_item_transaction_gl_code::bigint
      ELSE NULL
    END AS gl_code,

    COALESCE(NULLIF(TRIM(ilr.desk_location_name), ''), '(No desk location)') AS desk_location,

    ilr.transaction_method,
    ilr.transaction_type,
    ilr.transaction_event_id,
    ilr.order_item_transaction_amount AS raw_amount_cents,

    CASE
      WHEN LOWER(ilr.transaction_type) = 'refund'
        THEN -1 * ilr.order_item_transaction_amount
      ELSE ilr.order_item_transaction_amount
    END AS adjusted_amount_cents,

    CASE
      WHEN LOWER(ilr.transaction_type) = 'refund'
        THEN -1 * ilr.order_item_transaction_amount / 100.0
      ELSE ilr.order_item_transaction_amount / 100.0
    END AS adjusted_amount_dollars

  FROM materialized.item_log_report ilr
  WHERE
    ilr.organization_id = {{org_id}}::uuid
    [[AND ilr.datetime_at_primary_timezone >= {{start_date}}]]
    [[AND ilr.datetime_at_primary_timezone <  {{end_date}} + INTERVAL '1 day']]
),

agg AS (
  SELECT
    base.gl_code_raw,
    base.gl_code,
    base.desk_location,

    COUNT(DISTINCT CASE
          WHEN base.transaction_type ILIKE 'payment%'
          THEN base.transaction_event_id
        END) AS number_of_payments,

    SUM(CASE
          WHEN base.transaction_method IN ('card-online', 'card-present')
           AND base.transaction_type ILIKE 'payment%'
          THEN base.adjusted_amount_dollars ELSE 0
        END) AS credit_card_payments,

    SUM(CASE
          WHEN base.transaction_method = 'cash'
           AND base.transaction_type ILIKE 'payment%'
          THEN base.adjusted_amount_dollars ELSE 0
        END) AS cash_payments,

    SUM(CASE
          WHEN base.transaction_method ILIKE 'check%'
           AND base.transaction_type ILIKE 'payment%'
          THEN base.adjusted_amount_dollars ELSE 0
        END) AS check_payments,

    SUM(CASE
          WHEN base.transaction_method = 'free'
           AND base.transaction_type ILIKE 'payment%'
          THEN base.adjusted_amount_dollars ELSE 0
        END) AS free_payments,

    SUM(CASE
          WHEN base.transaction_method = 'organization-credit'
           AND base.transaction_type ILIKE 'payment%'
          THEN base.adjusted_amount_dollars ELSE 0
        END) AS org_credit_payments,

    SUM(CASE
          WHEN base.transaction_method = 'scholarship'
           AND base.transaction_type ILIKE 'payment%'
          THEN base.adjusted_amount_dollars ELSE 0
        END) AS scholarship_payments,

    SUM(CASE
          WHEN base.transaction_method = 'gift-card'
           AND base.transaction_type ILIKE 'payment%'
          THEN base.adjusted_amount_dollars ELSE 0
        END) AS gift_card_payments,

    -- catch-all: any payment method not explicitly bucketed above
    SUM(CASE
          WHEN base.transaction_type ILIKE 'payment%'
           AND base.transaction_method NOT IN
               ('card-online','card-present','cash','organization-credit','scholarship','free','gift-card')
           AND base.transaction_method NOT ILIKE 'check%'
          THEN base.adjusted_amount_dollars ELSE 0
        END) AS other_payments,

    -- ── Refunds by method ─────────────────────────────────────────────

    COUNT(DISTINCT CASE
          WHEN base.transaction_type ILIKE 'refund%'
          THEN base.transaction_event_id
        END) AS number_of_refunds,

    SUM(CASE
          WHEN base.transaction_type ILIKE 'refund%'
           AND base.transaction_method IN ('card-online', 'card-present')
          THEN ABS(base.adjusted_amount_dollars) ELSE 0
        END) AS cc_refunds,

    SUM(CASE
          WHEN base.transaction_type ILIKE 'refund%'
           AND base.transaction_method = 'cash'
          THEN ABS(base.adjusted_amount_dollars) ELSE 0
        END) AS cash_refunds,

    SUM(CASE
          WHEN base.transaction_type ILIKE 'refund%'
           AND base.transaction_method ILIKE 'check%'
          THEN ABS(base.adjusted_amount_dollars) ELSE 0
        END) AS check_refunds,

    SUM(CASE
          WHEN base.transaction_type ILIKE 'refund%'
           AND base.transaction_method = 'organization-credit'
          THEN ABS(base.adjusted_amount_dollars) ELSE 0
        END) AS org_credit_refunds,

    SUM(CASE
          WHEN base.transaction_type ILIKE 'refund%'
           AND base.transaction_method NOT IN ('card-online', 'card-present', 'cash', 'organization-credit', 'scholarship')
           AND base.transaction_method NOT ILIKE 'check%'
          THEN ABS(base.adjusted_amount_dollars) ELSE 0
        END) AS other_refunds

  FROM base
  GROUP BY
    base.gl_code_raw,
    base.gl_code,
    base.desk_location
),

-- NEW: true distinct transaction counts per desk. Additive across desks (each
-- transaction_event_id has exactly one desk), so the app sums these once per
-- desk to get the correct grand total instead of summing the per-GL column.
totals_by_desk AS (
  SELECT
    base.desk_location,
    COUNT(DISTINCT CASE WHEN base.transaction_type ILIKE 'payment%'
          THEN base.transaction_event_id END) AS desk_distinct_payments,
    COUNT(DISTINCT CASE WHEN base.transaction_type ILIKE 'refund%'
          THEN base.transaction_event_id END) AS desk_distinct_refunds
  FROM base
  GROUP BY base.desk_location
)

SELECT
  agg.gl_code_raw                                      AS "GL Code",
  COALESCE(gla.name, 'none')                           AS "Account Name",
  agg.desk_location                                    AS "Desk Location",

  ROUND(agg.credit_card_payments::numeric, 2)          AS "Credit Card Payments",
  ROUND(agg.cash_payments::numeric, 2)                 AS "Cash Payments",
  ROUND(agg.check_payments::numeric, 2)                AS "Check Payments",
  ROUND(agg.free_payments::numeric, 2)                 AS "Free Payments",
  ROUND(agg.org_credit_payments::numeric, 2)           AS "Organization Credit Payments",
  ROUND(agg.scholarship_payments::numeric, 2)          AS "Scholarship Payments",
  ROUND(agg.gift_card_payments::numeric, 2)            AS "Gift Card Payments",
  ROUND(agg.other_payments::numeric, 2)                AS "Other Payments",
  ROUND((agg.credit_card_payments
       + agg.cash_payments
       + agg.check_payments
       + agg.free_payments
       + agg.org_credit_payments
       + agg.scholarship_payments
       + agg.gift_card_payments
       + agg.other_payments)::numeric, 2)              AS "Total Payments",
  agg.number_of_payments                               AS "Number of Payments",

  ROUND(agg.cc_refunds::numeric, 2)                    AS "CC Refunds",
  ROUND(agg.cash_refunds::numeric, 2)                  AS "Cash Refunds",
  ROUND(agg.check_refunds::numeric, 2)                 AS "Check Refunds",
  ROUND(agg.org_credit_refunds::numeric, 2)            AS "Org Credit Refunds",
  ROUND(agg.other_refunds::numeric, 2)                 AS "Other Refunds",
  ROUND((agg.cc_refunds
       + agg.cash_refunds
       + agg.check_refunds
       + agg.org_credit_refunds
       + agg.other_refunds)::numeric, 2)               AS "Total Refunds",
  agg.number_of_refunds                                AS "Number of Refunds",

  ROUND((agg.credit_card_payments
       + agg.cash_payments
       + agg.check_payments
       + agg.free_payments
       + agg.org_credit_payments
       + agg.scholarship_payments
       + agg.gift_card_payments
       + agg.other_payments
       - (agg.cc_refunds
        + agg.cash_refunds
        + agg.check_refunds
        + agg.org_credit_refunds
        + agg.other_refunds))::numeric, 2)             AS "Net Amount",

  -- NEW: per-desk true distinct counts (repeated across the desk's GL rows).
  -- The app dedups by desk and sums for the correct TOTALS row / summary boxes.
  td.desk_distinct_payments                            AS "Desk Distinct Payments",
  td.desk_distinct_refunds                             AS "Desk Distinct Refunds"

FROM agg
LEFT JOIN gl_account gla
  ON gla.gl_code = agg.gl_code_raw
  AND gla.organization_id = {{org_id}}::uuid
  AND gla.archived_at IS NULL
LEFT JOIN totals_by_desk td
  ON td.desk_location = agg.desk_location
ORDER BY
  agg.gl_code_raw,
  agg.desk_location
