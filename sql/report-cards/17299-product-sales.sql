-- ============================================================================
-- Card 17299 — ✅ Product Sales / POS / Concessions      v2 — 2026-09-12
-- https://rec.metabaseapp.com/question/17299
--
-- Mirror of the Metabase card. THE LIVE CARD IS THE SOURCE OF TRUTH: read it
-- before writing to it, then mirror the result back here. There was no mirror
-- at all before this; the live card was the only copy.
--
-- PASTE THIS IN THE UI. Do NOT push it through the API. The card registers
-- three correctly-typed tags a human has already configured — start_date and
-- end_date as Date, org_id as Text — and `update_question` regenerates every
-- tag as Text, which takes the Product Sales report down for the org until
-- somebody re-flips them by hand.
--
-- ── WHAT CHANGED, AND WHY (v1 -> v2) ───────────────────────────────────────
-- Dan, 2026-09-11, with norman/products on screen: "the report you pointed me
-- to never loads" — HTTP 504.
--
-- IT WAS NOT AN APP PROBLEM. Measured through the public endpoint: norman over
-- 8.5 months ran past 300s, and over ONE MONTH took 106.7s against the app's
-- 60s first try and 120s retry. The report was one busy minute from a 504 on
-- every load and past it on most.
--
-- THE CAUSE IS TWO CHARACTERS. v1 filtered
--
--     ilr.datetime_at_primary_timezone::date >= {{start_date}}
--
-- and the platform has since granted the index this file's own CLAUDE.md
-- section has asked for since 2026-08-21:
--
--     item_log_report_organization_id_datetime_index
--       ON materialized.item_log_report (organization_id, datetime_at_primary_timezone)
--
-- WRAPPING THE COLUMN IN ::date MAKES THE PREDICATE NON-SARGABLE, so Postgres
-- cannot use the index's second column at all: it matched on organization_id
-- alone and then read and discarded every row of the org's history for the
-- eleven months nobody asked about. The date moves from `Filter` to
-- `Index Cond` once the cast comes off the column.
--
--   norman, August 2026:   106.7s  ->  1.9s
--
-- THAT 1.9s IS THIS FILE'S OWN TEXT, RUN. The whole final SELECT, literals
-- substituted, wrapped in a counting outer query so the column list and the
-- trailing ORDER BY execute without shipping 498 rows through a tool:
-- **498 rows, $81,772.22 net, 10,137 sold, 1.9s.** That step is here because
-- its absence is what let card 21682 ship with "ORDER BY position 9 is not in
-- select list" — a summary probe around the CTEs proves the CTEs and never
-- runs the card.
--
-- THE THREE JOINS ARE NOT THE COST, measured rather than assumed: over the
-- same month they drop NOTHING — 11,105 rows in, 11,105 after order_item,
-- 11,105 after product_purchase — and only `p.type='product'` filters, to
-- 10,210 (8%). So this is a semi-join written as inner joins, and all four
-- arms together run in 2.1s.
--
-- THE TWO FORMS ARE EXACTLY EQUIVALENT, and that is a property of the type
-- rather than of this month's data: datetime_at_primary_timezone is
-- `timestamp WITHOUT time zone` (the view has already localised it — which is
-- why nothing here writes AT TIME ZONE), so `x::date >= S` is `x >= S at
-- midnight` and `x::date <= E` is `x < E+1 at midnight`. Proven row by row
-- rather than by comparing two totals, which can agree while individual rows
-- differ: over ALL 119,488 of norman's item-log rows the two predicates
-- disagree on ZERO, with 0 null timestamps and 15,071 rows inside the window
-- on both sides.
--
-- THE OUTPUT CAST ON LINE 1 OF THE SELECT STAYS. That one is not a predicate —
-- it is what groups the rows by day — and removing it would change the answer.
-- The rule is about the WHERE clause, not about the column.
--
-- THE BOUND IS HALF-OPEN (`< end + 1`) rather than `<= end`, because the
-- column is a timestamp and `<= {{end_date}}` would stop at midnight and drop
-- the whole of the last day. `[[ ]]` on both, because blank-both is a shipped
-- state and the server's own backstop fills a half-open window in.
-- ============================================================================

/* ============================================================
   POS / Concessions (Product Sales)
   Variables: {{org_id}} Text, {{start_date}} Date, {{end_date}} Date
   Timezone handled by materialized view (datetime_at_primary_timezone)
   ============================================================ */
SELECT
  ilr.datetime_at_primary_timezone::date                AS "Date",
  ilr.order_item_name                                   AS "Product Name",
  COALESCE(ilr.desk_location_name,'(No desk location)') AS "Desk Location",
  COUNT(DISTINCT ilr.order_item_id) FILTER (WHERE ilr.transaction_type='payment') AS "Qty Sold",
  COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='payment'),0)/100.0 AS "Revenue ($)",
  COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='refund'),0)/100.0  AS "Refunds ($)",
  (COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='payment'),0)
   - COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='refund'),0))/100.0 AS "Net Revenue ($)"
FROM materialized.item_log_report ilr
JOIN order_item oi       ON oi.id = ilr.order_item_id
JOIN product_purchase pp ON pp.id = oi.product_purchase_id
JOIN product p           ON p.id = pp.product_id
WHERE ilr.organization_id = {{org_id}}::uuid
  AND ilr.order_item_type = 'product'
  AND p.type = 'product'
  -- v2: the column is bare on both sides, so the org+datetime index can be
  -- used. `::date` on the COLUMN is what made this a 106-second query.
  [[ AND ilr.datetime_at_primary_timezone >= {{start_date}}::timestamp ]]
  [[ AND ilr.datetime_at_primary_timezone <  ({{end_date}}::date + 1)::timestamp ]]
GROUP BY 1,2,3
ORDER BY "Date" DESC, "Net Revenue ($)" DESC NULLS LAST
