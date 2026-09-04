/* ============================================================
   Memberships & Passes  —  card 17301  ("✅Memberships Report")
   Variables: {{org_id}} Text, {{start_date}} Date (opt), {{end_date}} Date (opt)
   Date filter on created_at (purchase date), America/Chicago, inclusive.
   Price         = finalCents (contract / price of record)
   Net Collected = actual cash (payments - refunds)
     Join: order_item_id when present; fall back to customer+product
     for orphaned rows (null order_item_id, e.g. desk/admin sales).

   ── ROLLED BACK TO v6 (2026-09-04) ──────────────────────────
   This is v6's executable SQL restored byte for byte. v7 moved the payment
   aggregates onto public.order_item_transaction and TIMED OUT for every org
   tested except Pawnee — norman past 200s unwindowed, past 200s over thirteen
   months and past 170s over ONE MONTH; clarksville past 200s. v6 does those
   in 25.8s and 3.9s. The one-month norman result is the one that matters: a
   one-month `win` is tiny, so v7's cost is not proportional to the window and
   v6's scoping win did not carry over to the base tables.

   HOW v7 SHIPPED BROKEN, so it is not repeated: its equivalence proof was
   sound (157k groups, zero diffs, re-run against the shipped OR shape), but
   the 2.3s TIMING was measured on tx_oi alone with a single IN, while the
   shipped tx filtered on an OR of two IN subqueries and was never timed.
   Prove the speed of the exact text being pushed, not of the fragment it was
   developed from. The v7 mechanism is still UNKNOWN — orphan_items (cost
   20,709) and the OR defeating the index (cost 97,210) were both checked and
   both cleared, and every plan prices cheap while the card times out. The
   next attempt belongs on a SCRATCH card compared through the public
   endpoint, so it costs no downtime.

   ── v6 (2026-09-04) — PERFORMANCE ONLY, not one value moves ─
   The two payment CTEs are scoped to the window and share ONE pass over
   materialized.item_log_report instead of scanning it twice, unwindowed.

   WHY, measured against prod on 2026-09-04 (Pawnee):
     * everything in this card EXCEPT the two payment CTEs, over a
       thirteen-month window, is 559ms for 100 output rows.
     * ONE scan of materialized.item_log_report for that org is 39.9s. The
       table has exactly one index — its primary key — over 2.26M rows and
       1230 MB, so every read is a full parallel seq scan.
     * the card did TWO of them, unwindowed, to decorate those 100 rows.
   So 99.3% of the report was computing the org's entire payment history and
   throwing nearly all of it away: a thirteen-month window TIMED OUT past 300s
   and a one-month window with ZERO output rows still cost 55s.

   PROVEN VALUE-IDENTICAL BEFORE THE PUSH, not assumed. Pawnee,
   2025-09-04..2026-09-30, candidate vs deployed: 0 presence diffs, 0 value
   diffs on paid/refund for every one of the window's order items, 0 diffs on
   the customer fallback, and identical dollar totals.

   Every output column keeps its name, position and expression, so a warm
   4-hour v5/v6/v7 cache entry and this response are indistinguishable to
   public/memberships.html.

   NOTE: after any API update, re-set Start/End Date variable types to Date
   in the UI, and re-save until the parameter list is THREE.
   ============================================================ */
WITH res_group AS (   -- the org's residency groups, by the group's own toggle
  SELECT g.id
  FROM public."group" g
  WHERE g.deleted_at IS NULL
    AND g.organization_id = {{org_id}}::uuid
    AND g.group_type = 'residency'
),
has_res_group AS (
  -- presence, not count: an org with no residency group gets NULL below,
  -- never 'No'.
  SELECT EXISTS (SELECT 1 FROM res_group) AS val
),
resident_households AS (
  SELECT DISTINCT m.household_id
  FROM public.membership m
  JOIN res_group rg ON rg.id = m.group_id
  WHERE m.deleted_at IS NULL
    AND m.canceled_at IS NULL
    AND m.start_at <= now()
    AND (m.end_at IS NULL OR m.end_at >= now())
    AND m.household_id IS NOT NULL
),
resident_users AS (
  SELECT DISTINCT mu.user_id
  FROM public.membership m
  JOIN res_group rg ON rg.id = m.group_id
  JOIN public.membership_user mu ON mu.membership_id = m.id
  WHERE m.deleted_at IS NULL
    AND m.canceled_at IS NULL
    AND m.start_at <= now()
    AND (m.end_at IS NULL OR m.end_at >= now())
),
win AS (
  /* THE CARD'S OWN OUTPUT FILTER, LIFTED — not a new one. Its only job is to
     tell the payment aggregates below which order items and customers can
     possibly be looked up. The authoritative filter is still the one at the
     bottom of this query; deleting either is how two predicates drift apart
     silently (the same rule as sec_win on card 17295).

     WHY: measured on 2026-09-04 against Pawnee. Everything in this card EXCEPT
     the two payment CTEs, over a thirteen-month window, is 559ms for 100 rows.
     ONE scan of materialized.item_log_report for that org is 39.9s — the table
     has exactly one index, its primary key, over 2.26M rows and 1230 MB — and
     the card did TWO of them, unwindowed, to decorate those 100 rows. So 99.3%
     of the report was computing the org's entire payment history and throwing
     nearly all of it away, and a thirteen-month window timed out past 300s
     while a one-month window with ZERO output rows still cost 55s. */
  SELECT mp.order_item_id, mp.customer_user_id, mp.product_name
  FROM materialized.membership_and_pass_purchases_report mp
  WHERE mp.organization_id = {{org_id}}::uuid
    AND mp.product_type IN ('membership', 'pass')
    [[ AND (mp.created_at AT TIME ZONE 'America/Chicago')::date >= {{start_date}} ]]
    [[ AND (mp.created_at AT TIME ZONE 'America/Chicago')::date <= {{end_date}} ]]
),
org_ilr AS MATERIALIZED (
  /* ONE PASS, NOT TWO. tx_oi and tx_cust each used to scan this table; without
     MATERIALIZED Postgres inlines the CTE and scans it once per reader again,
     so the keyword is load-bearing rather than a hint.

     The OR is the union of exactly what the two aggregates below can consume:
     the window's order items, and — for rows with NO order_item_id, which are
     the desk/admin sales the fallback exists for — every 'product' row for
     those (customer, product name) pairs. A pair's rows are matched
     irrespective of order_item_id, so the fallback still sees the whole group
     it would have seen before. */
  SELECT ilr.order_item_id, ilr.customer_id, ilr.order_item_name,
         ilr.order_item_type, ilr.transaction_type, ilr.order_item_transaction_amount
  FROM materialized.item_log_report ilr
  WHERE ilr.organization_id = {{org_id}}::uuid
    AND (
      ilr.order_item_id IN (SELECT w.order_item_id FROM win w WHERE w.order_item_id IS NOT NULL)
      OR (ilr.order_item_type = 'product'
          AND (ilr.customer_id, ilr.order_item_name) IN
              (SELECT w.customer_user_id, w.product_name FROM win w WHERE w.order_item_id IS NULL))
    )
),
tx_oi AS (   -- precise: payments keyed by order_item_id
  SELECT ilr.order_item_id,
    COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='payment'),0) AS paid_cents,
    COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='refund'),0)  AS refund_cents
  FROM org_ilr ilr
  WHERE ilr.order_item_id IS NOT NULL
  GROUP BY ilr.order_item_id
),
tx_cust AS (      -- fallback: payments keyed by customer + product name
  SELECT ilr.customer_id, ilr.order_item_name,
    COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='payment'),0) AS paid_cents,
    COALESCE(SUM(ilr.order_item_transaction_amount) FILTER (WHERE ilr.transaction_type='refund'),0)  AS refund_cents
  FROM org_ilr ilr
  WHERE ilr.order_item_type = 'product'
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
  -- COALESCEd across both product families: a membership's rule lives on
  -- `group`, a pass's on `pass_schema`. Reading only the group side is what
  -- made every pass look like an open-ended subscription in v2.
  COALESCE(gg.end_date, pss.end_date)  AS "Plan Season End",
  CASE WHEN COALESCE(gg.ends_after_seconds, pss.ends_after_seconds) IS NOT NULL
       THEN ROUND(COALESCE(gg.ends_after_seconds, pss.ends_after_seconds) / 86400.0)
       ELSE NULL END            AS "Plan Term Days",
  mp.product_type               AS "Product Kind",
  (mm.stripe_subscription_id IS NOT NULL) AS "Auto Renew",
  mm.current_period_start_at    AS "Period Start",
  -- ── v4 additions ──
  -- Both off the `membership` join v2 already made, so v4 adds NO joins and
  -- cannot change a row count.
  mm.cancel_scheduled_at        AS "Cancel Scheduled At",
  mm.cancel_reason              AS "Cancel Reason",
  -- ── v5 addition ──
  CASE WHEN NOT (SELECT val FROM has_res_group) THEN NULL
       WHEN rh.household_id IS NOT NULL THEN 'Yes'
       WHEN ru.user_id      IS NOT NULL THEN 'Yes'
       ELSE 'No' END          AS "Resident?"
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
LEFT JOIN public.pass_schema pss
  ON pss.id = mp.pass_schema_id
-- The BUYER's own household. This join is the one that actually carries the
-- answer for most orgs: see the v5 note on why the product's household is not
-- enough. users.id is the primary key, so it cannot fan out.
LEFT JOIN public.users cu
  ON cu.id = mp.customer_user_id
LEFT JOIN resident_households rh
  ON rh.household_id = COALESCE(mp.membership_household_id, mp.pass_household_id, cu.household_id)
LEFT JOIN resident_users ru
  ON ru.user_id = mp.customer_user_id
WHERE mp.organization_id = {{org_id}}::uuid
  AND mp.product_type IN ('membership', 'pass')
  [[ AND (mp.created_at AT TIME ZONE 'America/Chicago')::date >= {{start_date}} ]]
  [[ AND (mp.created_at AT TIME ZONE 'America/Chicago')::date <= {{end_date}} ]]
ORDER BY
  COALESCE(mp.membership_status, mp.pass_status),
  mp.product_name,
  mp.customer_user_last_name,
  mp.customer_user_first_name
