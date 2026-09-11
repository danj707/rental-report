/* ============================================================
   Memberships & Passes  —  card 17301  ("✅Memberships Report")
   Variables: {{org_id}} Text, {{start_date}} Date (opt), {{end_date}} Date (opt)
   Date filter on created_at (purchase date), America/Chicago, inclusive.
   Price         = finalCents (contract / price of record)
   Net Collected = actual cash (payments - refunds)
     Join: order_item_id when present; fall back to customer+product
     for orphaned rows (null order_item_id, e.g. desk/admin sales).

   ── v7.1 (2026-09-11) — PERFORMANCE ONLY, not one value moves ─
   The two payment aggregates come off public.order_item_transaction instead
   of materialized.item_log_report. That table has exactly one index — its
   primary key — over 2.26M rows and 1230 MB, so every read of it is a full
   parallel seq scan; the base table is indexed on both organization_id and
   order_item_id.

   WHY v7 TIMED OUT AND THIS DOES NOT — the mechanism, measured 2026-09-06
   (full write-up in 17301-v7-DIAGNOSIS.md). v7 put BOTH arms in one CTE and
   OR'd them:

       oit.order_item_id IN (win)                       -- on order_item_transaction
       OR (oi.product_type = 'product' AND ... IN (win))-- on two JOINED tables

   Postgres cannot evaluate an OR until every column in it is available, so
   both index-usable predicates were demoted into a Join Filter on the
   outermost nested loop: the plan bitmap-scanned the org's ENTIRE ledger,
   index-joined order_item and then "order" to every row, and only then
   filtered. `win` survived solely as two hashed SubPlans evaluated LAST,
   which is why narrowing the window narrowed nothing and a ONE-MONTH norman
   still timed out past 170s. Measured at clarksville, unwindowed: arm 1 alone
   2.7s, arm 1 with the two joins 45.9s, the shipped OR past 200s.

   SO THE TWO ARMS NEVER SHARE A CTE. tx_oi drives FROM the window INTO
   order_item_transaction_order_item_id_index and needs no joins at all —
   order_item_id and amount are both columns on that table. tx_cust is its own
   CTE driven from the orphan pairs. Do not "simplify" them back together.

   PROVEN VALUE-IDENTICAL BEFORE THE PUSH, over the exact text below rather
   than inherited from v7 — which is how v7 shipped broken. An md5 over every
   (order_item_id : paid : refunded) group, item log against base tables:
     * pawnee, 2025-09-04..2026-09-30 : 96 groups, identical md5
     * apex-sandbox, UNWINDOWED (the shape prewarm sends) : 17,369 groups,
       identical md5, $660,341.55 paid / $26,111.59 refunded either way
   and the whole card's output, all 30 columns of every row, md5-identical.

   THE FALLBACK IS PROVEN ON MONEY THAT EXISTS. Re-measured 2026-09-11, there
   are 10 orphan rows on the entire platform (5 apex, 5 apex-sandbox) and the
   item log finds ZERO transactions for any of them, so a real orphan can only
   ever prove 0 = 0. It was therefore tested by feeding tx_cust every real
   (customer, product) pair pawnee has, as if each were an orphan: 102 pairs,
   66 groups, $5,750.00 paid and $610.00 refunded, identical md5 both ways.

   THE THREE BASE-SIDE FILTERS ARE LOAD-BEARING, not tidiness. deleted_at IS
   NULL AND confirmed_at IS NOT NULL AND credit_id IS NULL is the partial
   predicate on order_item_transaction_item_log_period_index — the item log's
   own notion of a countable transaction. Drop any one and the md5s diverge.
   order_item.deleted_at is deliberately NOT filtered (settled empirically
   over 157k groups on 2026-09-04).

   AND THE amount COLUMN'S OWN COMMENT IS WRONG. It says "Positive for
   payments, negative for refunds"; measured at pawnee, all 134 refund rows
   are POSITIVE and all 1,217 payment rows are positive. So the sign
   convention matches the item log and `paid - refunded` is right as written.
   Believe the measurement, not the comment.

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
win_oi AS (
  -- DISTINCT so two purchases sharing one order item probe the index once.
  SELECT DISTINCT w.order_item_id FROM win w WHERE w.order_item_id IS NOT NULL
),
win_orphan AS (
  -- the (customer, product) pairs the fallback exists for: purchases with no
  -- order_item_id at all, i.e. the desk/admin sales.
  SELECT DISTINCT w.customer_user_id, w.product_name
  FROM win w WHERE w.order_item_id IS NULL
),
tx_oi AS (   -- precise: payments keyed by order_item_id
  /* Driven FROM the window INTO order_item_transaction_order_item_id_index.
     No joins: order_item_id and amount are both columns here. */
  SELECT oit.order_item_id,
    COALESCE(SUM(oit.amount) FILTER (WHERE oit.payment_id IS NOT NULL),0) AS paid_cents,
    COALESCE(SUM(oit.amount) FILTER (WHERE oit.refund_id  IS NOT NULL),0) AS refund_cents
  FROM win_oi w
  JOIN public.order_item_transaction oit ON oit.order_item_id = w.order_item_id
  WHERE oit.organization_id = {{org_id}}::uuid
    AND oit.deleted_at   IS NULL
    AND oit.confirmed_at IS NOT NULL
    AND oit.credit_id    IS NULL
  GROUP BY oit.order_item_id
),
tx_cust AS (      -- fallback: payments keyed by customer + product name
  /* ITS OWN CTE, never OR'd with tx_oi — see the header. It is also driven
     from the orphan pairs, which are an empty set for 99.99% of org-windows
     (10 orphan rows exist on the whole platform), so this costs nothing where
     it is not used. */
  SELECT o.customer_user_id AS customer_id,
         oi.name            AS order_item_name,
    COALESCE(SUM(oit.amount) FILTER (WHERE oit.payment_id IS NOT NULL),0) AS paid_cents,
    COALESCE(SUM(oit.amount) FILTER (WHERE oit.refund_id  IS NOT NULL),0) AS refund_cents
  FROM win_orphan wo
  JOIN public."order" o
    ON o.customer_user_id = wo.customer_user_id
   AND o.organization_id  = {{org_id}}::uuid
  JOIN public.order_item oi
    ON oi.order_id     = o.id
   AND oi.name         = wo.product_name
   AND oi.product_type = 'product'
  JOIN public.order_item_transaction oit
    ON oit.order_item_id = oi.id
  WHERE oit.organization_id = {{org_id}}::uuid
    AND oit.deleted_at   IS NULL
    AND oit.confirmed_at IS NOT NULL
    AND oit.credit_id    IS NULL
  GROUP BY 1, 2
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
