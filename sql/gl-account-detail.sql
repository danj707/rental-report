/* ============================================================
   GL Account Detail (Munis / Tyler "glgatddt" format)
   Metabase card <TBD> — collection 3532, database 4 (Rec-Prod-ReadReplica).
   Variables: {{org_id}} Text, {{start_date}} Text, {{end_date}} Text

   THIS FILE is the source of truth for the card SQL.

   WHY ALL THREE TAGS ARE **TEXT**, NOT DATE (deliberate):
   applying a card through the Metabase API regenerates every template tag as
   Text, which breaks any card whose params the server sends as `date/single`
   (see CLAUDE.md — it has bitten the facility and GL cards). This card sidesteps
   that permanently: the tags are Text by design, the dates are cast here in SQL,
   and the export route sends them as `category` params. Editing this card via
   the API therefore needs NO follow-up flip in the Metabase UI.

   Grain: ONE ROW PER TRANSACTION (cash-receipts basis — actual payment dates).
   That is the difference from card 17293 ("GL Code Report"), which aggregates to
   one row per gl_code + desk and so cannot produce line-level detail. Both read
   the same source table; this card does not change or depend on that one.

   Payments post as Credit, refunds as Debit (both are stored positive in
   item_log_report). Balance is a running per-account credit-minus-debit.
   ============================================================ */
WITH base AS (
  SELECT
    NULLIF(TRIM(ilr.order_item_transaction_gl_code), '')        AS gl_code,
    ilr.datetime_at_primary_timezone::date                      AS post_date,
    ilr.order_item_transaction_id                               AS txn_id,
    ilr.transaction_event_batch_id                              AS batch_id,
    ilr.order_item_name                                         AS description,
    ilr.transaction_method                                      AS method,
    ilr.transaction_type                                        AS txn_type,
    BTRIM(COALESCE(ilr.customer_first_name, '') || ' ' || COALESCE(ilr.customer_last_name, '')) AS customer,
    ilr.order_item_transaction_amount::numeric / 100.0          AS amount,
    ilr.organization_id
  FROM materialized.item_log_report ilr
  WHERE ilr.organization_id = {{org_id}}::uuid
    AND ilr.order_item_transaction_amount <> 0
    -- datetime_at_primary_timezone is ALREADY localized — cast bare, never AT TIME ZONE
    [[ AND ilr.datetime_at_primary_timezone::date >= {{start_date}}::date ]]
    [[ AND ilr.datetime_at_primary_timezone::date <= {{end_date}}::date ]]
),
j AS (
  SELECT
    b.*,
    -- Three distinct states, deliberately NOT collapsed into one "UNMAPPED":
    --   1. code + account on file      → the account's name
    --   2. code but no gl_account row  → the code still posts, we just have no
    --      name for it. Pawnee has two of these (3334, 886554). Lumping them in
    --      with the unmapped bucket would misreport coded revenue as uncoded.
    --   3. no code at all              → genuinely unmapped; sorts last.
    CASE
      WHEN b.gl_code IS NULL  THEN 'UNMAPPED — no GL code assigned'
      WHEN ga.name IS NOT NULL THEN ga.name
      ELSE '(no account name on file)'
    END                                                          AS account_name,
    CASE WHEN b.txn_type = 'refund'  THEN b.amount ELSE 0 END    AS debit,
    CASE WHEN b.txn_type = 'payment' THEN b.amount ELSE 0 END    AS credit,
    CASE WHEN b.txn_type = 'refund'  THEN 'RF' ELSE 'CR' END     AS src
  FROM base b
  LEFT JOIN gl_account ga
    ON  ga.gl_code         = b.gl_code
    AND ga.organization_id = b.organization_id
    AND ga.archived_at IS NULL          -- same archive rule as card 17293, so the
                                        -- two reports never disagree on a name
)
SELECT
  COALESCE(gl_code, '(none)')     AS "GL Code",
  account_name                    AS "Account",
  post_date                       AS "Effective",
  UPPER(LEFT(txn_id::text, 8))    AS "Journal Ref",
  UPPER(LEFT(batch_id::text, 8))  AS "Batch",
  src                             AS "Src",
  method                          AS "Method",
  LEFT(description, 40)           AS "Description",
  customer                        AS "Customer",
  ROUND(debit, 2)                 AS "Debit",
  ROUND(credit, 2)                AS "Credit",
  ROUND(SUM(credit - debit) OVER (
    PARTITION BY COALESCE(gl_code, '~~unmapped')
    ORDER BY post_date, txn_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ), 2)                           AS "Balance"
FROM j
ORDER BY (gl_code IS NULL), gl_code, post_date, txn_id
