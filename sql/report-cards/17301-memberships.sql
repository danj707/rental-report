/* ============================================================
   Memberships & Passes  —  card 17301  ("✅Memberships Report")
   Variables: {{org_id}} Text, {{start_date}} Date (opt), {{end_date}} Date (opt)
   Date filter on created_at (purchase date), America/Chicago, inclusive.
   Price         = finalCents (contract / price of record)
   Net Collected = actual cash (payments - refunds)
     Join: order_item_id when present; fall back to customer+product
     for orphaned rows (null order_item_id, e.g. desk/admin sales).

   ── v2 (2026-08-29) ─────────────────────────────────────────
   Adds FIVE columns and changes nothing else. Every pre-existing
   column keeps its name, position and expression, so a warm 4-hour
   cache entry from v1 and a fresh v2 response are both readable by
   public/memberships.html (see mbHasEconomics / mbIsAutoRenew there).

     "Coverage"          household | individual | group — already on the
                         materialized view; decides whether a membership's
                         people hang off household_id or membership_user.
     "Plan Season End"   group.end_date. Non-null ⇒ a SEASON plan: every
                         member's term ends on the same calendar date, so
                         expiry is the season closing, NOT churn.
     "Plan Term Days"    group.ends_after_seconds in days. Non-null ⇒ a
                         rolling fixed term (365d annual, 28d, …).
                         Both null ⇒ open-ended / subscription.
     "Auto Renew"        membership.stripe_subscription_id IS NOT NULL.
                         This is the TRUTH about auto-renew. The existing
                         "Renewal Type" column infers it from
                         membership_next_renewal_at and is kept unchanged
                         for compatibility, but it is not the same test.
     "Period Start"      membership.current_period_start_at. With
                         "Next Renewal" this gives the billing CYCLE
                         length, which is the only way to turn a per-cycle
                         charge into a monthly figure.

   Both new joins are on primary keys (membership.id, group.id), so
   neither can fan out a row. Verified before push: identical row count
   and a byte-identical sha256 over the 22 original columns.

   WHY the extra joins are to base tables: the materialized purchases
   view carries `coverage` and `group_id` but NOT the plan's term rule
   or the subscription id, and those are what separate "a season ended"
   from "a member left". See CLAUDE.md, "Memberships: the paid book".
   ============================================================ */
WITH tx_oi AS (   -- precise: payments keyed by order_item_id
  SELECT ilr.order_item_id,
    COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='payment'),0) AS paid_cents,
    COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='refund'),0)  AS refund_cents
  FROM materialized.item_log_report ilr
  WHERE ilr.organization_id = {{org_id}}::uuid
    AND ilr.order_item_id IS NOT NULL
  GROUP BY ilr.order_item_id
),
tx_cust AS (      -- fallback: payments keyed by customer + product name
  SELECT ilr.customer_id, ilr.order_item_name,
    COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='payment'),0) AS paid_cents,
    COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='refund'),0)  AS refund_cents
  FROM materialized.item_log_report ilr
  WHERE ilr.organization_id = {{org_id}}::uuid
    AND ilr.order_item_type = 'product'
  GROUP BY ilr.customer_id, ilr.order_item_name
)
SELECT
  mp.customer_user_id           AS "User ID",
  mp.customer_user_first_name   AS "First Name",
  mp.customer_user_last_name    AS "Last Name",
  mp.customer_user_email        AS "Email",
  COALESCE(mp.membership_id::text, mp.pass_id::text) AS "Membership ID",
  mp.product_name               AS "Membership Type",
  COALESCE(mp.group_name, mp.pass_schema_name) AS "Group / Plan",
  COALESCE(mp.membership_status, mp.pass_status) AS "Status",
  CASE WHEN mp.membership_next_renewal_at IS NOT NULL
       THEN 'Auto-renew' ELSE 'One-time' END AS "Renewal Type",
  ROUND(
    COALESCE(
      (mp.membership_applied_pricing->'result'->>'finalCents')::numeric,
      pl.price
    ) / 100.0, 2
  ) AS "Price",
  ROUND(COALESCE(tx_oi.paid_cents, tx_cust.paid_cents, 0)/100.0, 2)      AS "Paid",
  ROUND(COALESCE(tx_oi.refund_cents, tx_cust.refund_cents, 0)/100.0, 2)  AS "Refunded",
  ROUND((
    COALESCE(tx_oi.paid_cents, tx_cust.paid_cents, 0)
    - COALESCE(tx_oi.refund_cents, tx_cust.refund_cents, 0)
  )/100.0, 2)                                                            AS "Net Collected",
  COALESCE(mp.membership_start_at, mp.pass_start_at) AS "Start Date",
  COALESCE(mp.membership_end_at, mp.pass_expires_at) AS "End Date",
  mp.membership_next_renewal_at AS "Next Renewal",
  mp.canceled_at                AS "Canceled At",
  mp.created_at                 AS "Created At",
  COALESCE(mp.membership_last_used_at, mp.pass_last_used_at) AS "Last Used",
  COALESCE(mp.membership_usage_count, mp.pass_usage_count) AS "Usage Count",
  COALESCE(mp.membership_attendance_count, mp.pass_attendance_count) AS "Attendance Count",
  -- ── v2 additions ──
  mp.coverage                   AS "Coverage",
  gg.end_date                   AS "Plan Season End",
  CASE WHEN gg.ends_after_seconds IS NOT NULL
       THEN ROUND(gg.ends_after_seconds / 86400.0)
       ELSE NULL END            AS "Plan Term Days",
  (mm.stripe_subscription_id IS NOT NULL) AS "Auto Renew",
  mm.current_period_start_at    AS "Period Start"
FROM materialized.membership_and_pass_purchases_report mp
LEFT JOIN materialized.membership_and_pass_plans_report pl
  ON pl.id = mp.product_id
  AND pl.organization_id = mp.organization_id
LEFT JOIN tx_oi
  ON tx_oi.order_item_id = mp.order_item_id
LEFT JOIN tx_cust
  ON mp.order_item_id IS NULL
  AND tx_cust.customer_id     = mp.customer_user_id
  AND tx_cust.order_item_name = mp.product_name
LEFT JOIN public.membership mm
  ON mm.id = mp.membership_id
LEFT JOIN public."group" gg
  ON gg.id = mp.group_id
WHERE mp.organization_id = {{org_id}}::uuid
  AND mp.product_type IN ('membership', 'pass')
  [[ AND (mp.created_at AT TIME ZONE 'America/Chicago')::date >= {{start_date}} ]]
  [[ AND (mp.created_at AT TIME ZONE 'America/Chicago')::date <= {{end_date}} ]]
ORDER BY
  COALESCE(mp.membership_status, mp.pass_status),
  mp.product_name,
  mp.customer_user_last_name,
  mp.customer_user_first_name
