/* ============================================================
   Item Log — shared, org-parameterized card ("✅ Item Log Report")
   Database 4 (Rec-Prod-ReadReplica).
   Variables: {{org_id}} Text, {{start_date}} Date, {{end_date}} Date

   THIS FILE is the source of truth for the card SQL. Applying it via the
   Metabase API/MCP regenerates ALL template tags as Text — after saving,
   re-flip Start Date / End Date back to type Date in the Metabase UI, or the
   server's date/single params stop matching and the report errors/serves stale
   (see CLAUDE.md).

   WHAT THIS IS: a byte-for-byte reproduction of the "Item Log" CSV that the
   product exports (Admin → Reports → Item Log → filter a date range → Export).
   Finance re-ran that export by hand once per billing period, for every org;
   this card is the automatable source behind /:org/itemlog and the remittance
   dashboard.

   Column names, ordering, value formatting (Date as MM/DD/YYYY h:mm AM/PM,
   Item Value as $#,##0.00, "None" for a missing desk location, 8-char
   uppercase Transaction ID) all match the product export exactly, so the
   downloaded CSV is a drop-in replacement for the manual one. Validated
   row-for-row against CARD's 2026-08-08 → 2026-08-15 manual export (1,180
   rows, 0 diffs).

   Grain: one row per order_item_transaction — same as the product export.
   Refund amounts stay POSITIVE (the product does not sign-flip); the "Type"
   column is what distinguishes payment from refund.

   The date window is INCLUSIVE of end_date (a "August 8-15" billing period
   means 08-08 00:00:00 through 08-15 23:59:59 in the org's primary timezone).
   datetime_at_primary_timezone is already local wall-clock time, so the
   comparison is plain timestamp math with no timezone conversion.
   ============================================================ */
SELECT
  TO_CHAR(ilr.datetime_at_primary_timezone, 'MM/DD/YYYY FMHH12:MI AM')  AS "Date",

  COALESCE(NULLIF(TRIM(ilr.desk_location_name), ''), 'None')            AS "Location",

  /* The product shows the last 8 hex chars of the transaction event BATCH id,
     uppercased. Batch and event id share that suffix for the overwhelming
     majority of rows (623/630 in the validation window) — but not always, and
     where they diverge the export follows the batch. Don't "simplify" this to
     transaction_event_id. */
  UPPER(RIGHT(ilr.transaction_event_batch_id::text, 8))                 AS "Transaction ID",

  COALESCE(ilr.customer_first_name, '') || ' ' ||
  COALESCE(ilr.customer_last_name, '')                                  AS "Customer Name",

  ilr.transaction_type                                                  AS "Type",

  CASE ilr.transaction_method
    WHEN 'card-online'          THEN 'Card'
    WHEN 'card-present'         THEN 'Card'
    WHEN 'cash'                 THEN 'Cash'
    WHEN 'check'                THEN 'Check'
    WHEN 'free'                 THEN 'Free'
    WHEN 'organization-credit'  THEN 'Account Credit'
    WHEN 'scholarship'          THEN 'Scholarship'
    WHEN 'gift-card'            THEN 'Gift Card'
    ELSE INITCAP(REPLACE(ilr.transaction_method, '-', ' '))
  END                                                                   AS "Method",

  /* Zero renders as a bare "$0" in the product export — NOT "$0.00" (comped /
     scholarship / $0 recurring lines are common, so this is not an edge case).
     Everything else is $#,##0.00 with thousands separators. */
  CASE WHEN ilr.order_item_transaction_amount = 0 THEN '$0'
       ELSE '$' || TO_CHAR(ilr.order_item_transaction_amount / 100.0,
                           'FM999,999,990.00')
  END                                                                   AS "Item Value",

  ilr.order_item_type                                                   AS "Item Type",
  COALESCE(ilr.order_item_fee_category, '')                             AS "Fee Category",
  ilr.order_item_name                                                   AS "Item Name",
  COALESCE(ilr.order_item_transaction_gl_code, '')                      AS "GL Code",
  COALESCE(ilr.customer_email, '')                                      AS "Customer Email",

  /* Machine-readable companions — the app sorts/filters/sums on these instead
     of re-parsing the display strings above. Hidden from the CSV download so
     the exported file matches the product export column-for-column. */
  ilr.datetime_at_primary_timezone                                      AS "_sort_at",
  ilr.order_item_transaction_amount                                     AS "_amount_cents",
  ilr.transaction_method                                                AS "_method_raw",
  ilr.transaction_event_id                                              AS "_transaction_event_id"

FROM materialized.item_log_report ilr
WHERE
  ilr.organization_id = {{org_id}}::uuid
  [[AND ilr.datetime_at_primary_timezone >= {{start_date}}]]
  [[AND ilr.datetime_at_primary_timezone <  {{end_date}} + INTERVAL '1 day']]
ORDER BY
  ilr.datetime_at_primary_timezone DESC,
  ilr.order_item_transaction_id
