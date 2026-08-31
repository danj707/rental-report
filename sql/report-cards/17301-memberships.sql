/* ============================================================
   Memberships & Passes  —  card 17301  ("✅Memberships Report")
   Variables: {{org_id}} Text, {{start_date}} Date (opt), {{end_date}} Date (opt)
   Date filter on created_at (purchase date), America/Chicago, inclusive.
   Price         = finalCents (contract / price of record)
   Net Collected = actual cash (payments - refunds)
     Join: order_item_id when present; fall back to customer+product
     for orphaned rows (null order_item_id, e.g. desk/admin sales).

   ── v5 (2026-08-31) ─────────────────────────────────────────
   Adds ONE column, "Resident?", and changes nothing else. It is appended at
   the END of the select list, so a warm 4-hour v4 cache entry and a v5
   response are both readable by public/memberships.html, which gates on the
   PRESENCE of the column (mbHasResidency) and never on its value.

   RESIDENCY IS READ FROM THE GROUP'S OWN TOGGLE — group_type = 'residency' —
   and deliberately NOT from a name match. Cards 17294 and 17788 currently use
   `group_type ILIKE '%residen%' OR name ILIKE '%residen%'`, and that name
   clause is wrong in both directions. Measured platform-wide:

     * it sweeps in 96 groups across 35 orgs that are NOT residency groups —
       4,099 live memberships, 1,446 households. Among them are products
       ("El Segundo Resident ID Card - Adult", 1,088) and, worse, groups whose
       names contain "Non-Resident" as a substring: 516 people currently on
       "2026 Summer Pool Pass (Non-residents)" and "2026 Annual Pool Pass
       (Non-residents)" are reported as RESIDENTS today.
     * it gains nothing. Every residency-typed group is already matched by the
       type half of that condition, because 'residency' ILIKE '%residen%'.

   Switching to the toggle costs no org any coverage (measured: 0 orgs have a
   residency-NAMED group without also having a residency-TYPED one) and needs
   no negative guard, because "Non-Resident Groups" is typed special-group and
   the toggle simply cannot match it.

   THERE ARE THREE WAYS TO REACH A RESIDENT AND ALL THREE ARE REQUIRED. This
   was measured, and the obvious two-path version was WRONG — it returned
   'No' on all 3,132 El Segundo rows while 1,317 resident households existed:

     1. the PURCHASED PRODUCT's household — membership_household_id /
        pass_household_id on the view. These are NULL unless the product
        itself is household-coverage: at El Segundo every one of the 3,132
        rows is coverage='individual', so both columns are null on every row.
        (Note the view splits this id in two and has no single
        customer_household_id, unlike the facility card's booking view.)
     2. the BUYER's own household — users.household_id, reached through
        customer_user_id. THIS is the path that carries the answer for most
        orgs; 2,610 of El Segundo's buyers have it populated, and the
        residency group attaches at household level.
     3. the buyer as an individual — membership_user. Zero rows at El Segundo,
        because a household-coverage residency membership has no per-user
        rows, but it is the path for orgs that enrol residents individually.

   Each covers a real shape and none subsumes the others, so the test
   COALESCEs 1 and 2 and then falls through to 3. Getting this wrong is
   silent: every join is a LEFT JOIN and a miss renders a confident 'No'.

   NULL, NEVER 'No', WHEN THE ORG HAS NO RESIDENCY GROUP AT ALL. An org that
   does not run residency pricing must not be told every member is a
   non-resident — that is a confident answer to a question its data cannot
   address. Same rule as hasAbsent / ciHasStatus / mbHasProductKind.

   WORTH KNOWING BEFORE RECONCILING A CLOSED FISCAL YEAR: this test is
   evaluated at query time against CURRENT membership. It answers "is this
   person a resident today", not "were they a resident when they bought".

   ── v4 (2026-08-30) ─────────────────────────────────────────
   Adds "Cancel Scheduled At" and "Cancel Reason". Both come off the
   `membership` join v2 already made, so this adds no joins and cannot
   move a row count.

     "Cancel Scheduled At"  membership.cancel_scheduled_at. A cancellation
                            already booked for the end of the current period —
                            the membership is live, is counted in the book, and
                            WILL NOT renew. It is the only forward-looking churn
                            signal in this schema, and nothing else exposes it:
                            City of Norman has 126. `canceled_at` is the past,
                            this is the future.
     "Cancel Reason"        membership.cancel_reason. Carried so the page can
                            show it where it exists, but do not build a "why
                            they left" panel on it — the vocabulary is only
                            other/schedule/cost and 94.2% say "other".

   WHAT IS *NOT* HERE, and why. There is no renewal-event history anywhere in
   this database: `public.subscription` is a marketing opt-in table, and
   `membership` keeps only the CURRENT period. Renewals are therefore DERIVED
   on the page as (Period Start − Start Date) ÷ cycle. Verified sound against
   prod rather than assumed — over City of Norman's auto-renewers the elapsed
   time divides into whole cycles: weekly (58 memberships) is exact, monthly
   (137) sits 0.06 off a whole number, which is calendar months of unequal
   length against a fixed 31-day cycle. Note the derivation only works while a
   membership is LIVE: next_renewal_at is cleared on cancellation, so a
   cancelled membership has no cycle to divide by and contributes tenure
   instead of a renewal count.

   ── v3 (2026-08-30) ─────────────────────────────────────────
   Adds "Product Kind" and joins pass_schema. WHY: v2 read the plan
   term rule only from `group`, and A PASS HAS NO GROUP — its
   group_id is NULL, so both plan columns came back NULL and the page
   concluded "no season end, no term days, therefore an open-ended
   subscription". Every day pass and gate fee on the platform was
   classified as a subscription and offered as an auto-renew
   conversion candidate. Norman alone: 16,940 of 20,341 rows are
   passes and 10,669 of those carried neither term rule, including
   4,518 "League Tournament Gate Adult $5" admissions at ~$6.

   Absence of a group term rule is not evidence of a subscription.
   "Product Kind" states what the row IS instead of inferring it, and
   the pass_schema join gives a pass its own term rule rather than
   leaving it to look like an absent one.

   Additive, verified against prod before this push: City of Norman,
   20,341 rows with and without the pass_schema join. It is on that
   table's primary key, so it cannot fan out.

   ── v2 (2026-08-29) ─────────────────────────────────────────
   Adds FIVE columns and changes nothing else. Every pre-existing
   column keeps its name, position and expression, so a warm 4-hour
   cache entry from v1 and a fresh v2 response are both readable by
   public/memberships.html (see mbHasEconomics / mbIsAutoRenew there).

     "Coverage"          household | individual | group — already on the
                         materialized view; decides whether a membership's
                         people hang off household_id or membership_user.
     "Plan Season End"   the plan's fixed end date — group.end_date for a
                         membership, pass_schema.end_date for a pass.
                         Non-null ⇒ a SEASON plan: every member's term ends
                         on the same calendar date, so expiry is the season
                         closing, NOT churn.
     "Plan Term Days"    the plan's ends_after_seconds in days, from the same
                         two sources. Non-null ⇒ a rolling fixed term
                         (365d annual, 28d, …).
                         Both null on a MEMBERSHIP ⇒ open-ended / subscription.
                         Both null on a PASS means nothing — see "Product
                         Kind" below, and do not read it as open-ended.
     "Auto Renew"        membership.stripe_subscription_id IS NOT NULL.
                         This is the TRUTH about auto-renew. The existing
                         "Renewal Type" column infers it from
                         membership_next_renewal_at and is kept unchanged
                         for compatibility, but it is not the same test:
                         over ACTIVE memberships, 1,760 carry both, 88
                         carry a subscription with no renewal date, and
                         none carry a renewal date without a subscription.
     "Product Kind"      'membership' | 'pass'. Already on the view and
                         previously read only in the WHERE clause. A PASS
                         CANNOT AUTO-RENEW AT ALL — the `pass` table has no
                         stripe_subscription_id and no next_renewal_at — so
                         this is what keeps 13,802 active paid passes out of
                         the auto-renew denominator and out of the
                         conversion list.
     "Period Start"      membership.current_period_start_at. With
                         "Next Renewal" this gives the billing CYCLE
                         length, which is the only way to turn a per-cycle
                         charge into a monthly figure.

   All three added joins are on primary keys (membership.id, group.id,
   pass_schema.id), so none can fan out a row. Verified against prod:
   City of Norman, 20,341 rows with and without them, and an identical
   md5 over (epsio_id, customer_user_id, product_name, created_at) —
   the row identity — in both directions.

   WHY the extra joins are to base tables: the materialized purchases
   view carries `coverage` and `group_id` but NOT the plan's term rule
   or the subscription id, and those are what separate "a season ended"
   from "a member left". See CLAUDE.md, "Memberships: the paid book".
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
tx_oi AS (   -- precise: payments keyed by order_item_id
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
