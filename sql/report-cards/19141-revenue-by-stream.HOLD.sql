-- Card 19141: Org Dashboard — Revenue by Stream (payment-dated) — v2 SPEED REFACTOR
-- Change: drive from org-scoped payment/refund rows in the window, then fetch
-- their order_item_transactions by payment_id/refund_id (partial indexes), instead
-- of scanning the org's ENTIRE order_item_transaction ledger and joining every row
-- to payment+refund just to discard everything outside the window.
-- Every oit row has exactly one of payment_id/refund_id (verified in prod), so the
-- two UNION ALL branches reproduce the original OR-filter with no double counting.
-- Stream classification and output columns are unchanged.
WITH tx AS (
  SELECT oit.order_item_id, oit.amount, TRUE AS is_payment
  FROM payment p
  JOIN order_item_transaction oit
    ON oit.payment_id = p.id
   AND oit.deleted_at IS NULL
   AND oit.organization_id = {{org_id}}::uuid
  WHERE p.organization_id = {{org_id}}::uuid
    AND p.status = 'succeeded'
    AND p.created_at >= {{start_date}}::date
    AND p.created_at < {{end_date}}::date + INTERVAL '1 day'
  UNION ALL
  SELECT oit.order_item_id, oit.amount, FALSE AS is_payment
  FROM refund r
  JOIN order_item_transaction oit
    ON oit.refund_id = r.id
   AND oit.deleted_at IS NULL
   AND oit.organization_id = {{org_id}}::uuid
  WHERE r.organization_id = {{org_id}}::uuid
    AND r.status = 'succeeded'
    AND r.created_at >= {{start_date}}::date
    AND r.created_at < {{end_date}}::date + INTERVAL '1 day'
)
SELECT
  CASE
    WHEN oi.product_type = 'reservation-enrollment' THEN 'programs'
    WHEN oi.product_type IN ('site-reservation','court-reservation') THEN 'facility'
    WHEN oi.product_type = 'event-ticket' THEN 'events'
    WHEN oi.product_type = 'deposit' THEN 'deposits'
    WHEN oi.product_type IN ('transaction-fee','fee','tax') THEN 'fees_tax'
    WHEN pr.type = 'membership' THEN 'memberships'
    WHEN pr.type = 'pass' THEN 'passes'
    WHEN oi.product_type = 'product' THEN 'products'
    ELSE 'other'
  END AS stream,
  ROUND(SUM(CASE WHEN tx.is_payment THEN tx.amount ELSE 0 END) / 100.0, 2) AS payments,
  ROUND(SUM(CASE WHEN NOT tx.is_payment THEN tx.amount ELSE 0 END) / 100.0, 2) AS refunds,
  ROUND(SUM(CASE WHEN tx.is_payment THEN tx.amount ELSE -tx.amount END) / 100.0, 2) AS net
FROM tx
JOIN order_item oi ON oi.id = tx.order_item_id
LEFT JOIN product_purchase pp ON pp.id = oi.product_purchase_id
LEFT JOIN product pr ON pr.id = pp.product_id
GROUP BY 1
ORDER BY payments DESC
