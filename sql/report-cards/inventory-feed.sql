-- ── Inventory feed ──────────────────────────────────────────────────────────
-- ONE card, two kinds of row, told apart by "Row Kind":
--
--   item      every live product the org has in Rec — the catalogue the
--             inventory report ingests. Emitted whatever the window.
--   movement  one row per ORDER ITEM that took a payment or a refund since
--             {{since}}, resolved to its product and quantity.
--
-- WHY ORDER-ITEM GRAIN. The report keeps a ledger and must never subtract the
-- same sale twice. An order item is the unit a customer bought; its payment and
-- its refund are separate transactions on it. So the server records "sold" and
-- "refunded" once per order item, and re-reading an overlapping window changes
-- nothing. A payment that VANISHES from a later read of the same window is a
-- void, and the server puts that unit back.
--
-- THE PATH. The item log carries no product id and no quantity:
--   item_log_report.order_item_id -> order_item.product_purchase_id
--     -> product_purchase.product_id + quantity
-- Measured 2026-09-22 at city-of-madison, July: 23,243 merch rows, every one
-- resolving to a product, every quantity exactly 1.
--
-- ONLY product.type = 'product' MOVES STOCK. fee / pass / membership / giftCard
-- are listed as catalogue rows so the page can offer them (switched off), and
-- never produce movements — a punch pass is not a candy bar.
--
-- SARGABLE. The window filter is on the bare datetime_at_primary_timezone
-- column, which rides item_log_report_organization_id_datetime_index. Casting
-- the column instead puts the date in a Filter and scans the org's history.
--
-- TIMESTAMPS ARE EMITTED AS UTC ISO TEXT, because Metabase renders every
-- timestamptz in America/Los_Angeles and the server compares these against
-- its own clock.
--
-- {{since}} is a TEXT tag on purpose (a date string, cast here). The server
-- echoes the card's own registered parameter types back, so no Date flip is
-- ever needed after an API save.
WITH win AS (
  SELECT ilr.order_item_id,
         ilr.transaction_type,
         ilr.order_item_transaction_confirmed_at AS ts
  FROM materialized.item_log_report ilr
  WHERE ilr.organization_id = {{org_id}}::uuid
    AND ilr.datetime_at_primary_timezone >= {{since}}::timestamp
    AND ilr.order_item_type = 'product'
),
mv AS (
  SELECT w.order_item_id,
         pp.product_id,
         COALESCE(pp.quantity, 1) AS qty,
         MIN(w.ts) FILTER (WHERE w.transaction_type = 'payment') AS sold_at,
         MIN(w.ts) FILTER (WHERE w.transaction_type = 'refund')  AS refunded_at
  FROM win w
  JOIN order_item oi       ON oi.id = w.order_item_id
  JOIN product_purchase pp ON pp.id = oi.product_purchase_id
  JOIN product p           ON p.id = pp.product_id AND p.type = 'product'
  GROUP BY 1, 2, 3
)
SELECT 'item'                                   AS "Row Kind",
       p.id::text                               AS "Product ID",
       p.name                                   AS "Name",
       p.type                                   AS "Product Type",
       NULLIF(p.pricing_strategy->>'cents', '')::int AS "Price Cents",
       p.display_in_store                       AS "In Store",
       NULL::text                               AS "Order Item ID",
       NULL::numeric                            AS "Quantity",
       NULL::text                               AS "Sold At",
       NULL::text                               AS "Refunded At"
FROM product p
WHERE p.organization_id = {{org_id}}::uuid
  AND p.deleted_at IS NULL
  AND p.archived_at IS NULL
UNION ALL
SELECT 'movement',
       mv.product_id::text,
       NULL::text,
       NULL::text,
       NULL::int,
       NULL::boolean,
       mv.order_item_id::text,
       mv.qty::numeric,
       to_char(mv.sold_at     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
       to_char(mv.refunded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
FROM mv
ORDER BY 1, 2
