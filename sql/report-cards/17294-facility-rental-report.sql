-- Card 17294: ✅ Facility Rental Report — v-next SPEED REFACTOR
-- Changes (output identical):
-- 1. rental_notes was GLOBAL: it aggregated note rows for entity_type
--    'facilityRental' across EVERY org (no index on entity_type → seq scan).
--    Now scoped to this org's facility rentals via the indexed entity_id.
-- 2. The base CTE scanned ALL of the org's reservations; the date window was
--    only applied after the multi-day generate_series expansion. The same
--    window (or the current-month default) is now pushed into base using the
--    overlap condition: a rental matters only if
--    date(upper(range)) >= start AND date(lower(range)) <= end.
--    The day-level filter after expansion is unchanged, so rows are identical.
-- 3. 2026-08-19: added "Paid?" — Yes / Partial / No, NULL when there is no
--    order item to pay for. Unlike Total/Add-On Fees this is a status, not
--    money, so it repeats on every day of a multi-day booking (nothing to
--    double-count) and each row can be read on its own.
--
--    The verdict covers the reservation's own item AND its add-on children,
--    because they are billed together and paid separately: the Jolie Kulik
--    baby shower had a $900 room marked fully paid and $288 of chiavari
--    chairs untouched, and looking only at the parent called that PAID while
--    Rec's billing summary said $288 due. Comped/$0 items carry fully_paid_at
--    (and are treated as settled regardless), so comps stay green.
WITH addons AS (
  SELECT
    STRING_AGG(
      addon.name || ' ($' || 
      TO_CHAR(COALESCE(
        (addon.applied_pricing->'result'->>'finalCents')::numeric,
        addon.price
      ) / 100.0, 'FM999999990.00') || ')',
      ', '
    ) AS names,
    SUM(COALESCE(
      (addon.applied_pricing->'result'->>'finalCents')::numeric,
      addon.price
    )) / 100.0 AS addon_fees,
    addon.parent_order_item_id
  FROM order_item addon
  WHERE addon.parent_order_item_id IS NOT NULL
    AND addon.product_type = 'product'
    AND addon.deleted_at IS NULL
    AND addon.organization_id = {{org_id}}::uuid
  GROUP BY addon.parent_order_item_id
),
res_group AS (
  SELECT g.id
  FROM "group" g
  WHERE g.deleted_at IS NULL
    AND g.organization_id = {{org_id}}::uuid
    -- THE GROUP'S OWN TOGGLE, not a name match. Measured platform-wide
    -- 2026-08-31: the old `OR g.name ILIKE '%residen%'` swept in 96 groups
    -- across 35 orgs that are NOT residency groups — 4,099 live memberships
    -- and 1,446 households — because "Non-Resident" contains "Resident" as a
    -- substring. Among the orgs this card serves: Reading's "Pleasant Street
    -- Center NON-RESIDENT Membership" (38 people) and Euclid's Monthly/Annual
    -- "Non-Resident" Rec Passes were all reported as RESIDENTS, as were
    -- product groups like Tullahoma's "Individual Resident Basketball
    -- Membership (Free)" (43).
    --
    -- It bought nothing in exchange: every residency-typed group was already
    -- matched by the TYPE half of the same condition, since
    -- 'residency' ILIKE '%residen%'. So this is pure false-positive removal —
    -- 0 orgs platform-wide have a residency-NAMED group without a
    -- residency-TYPED one — and no negative guard is needed, because
    -- "Non-Resident Groups" is typed special-group and the toggle cannot
    -- match it.
    --
    -- CONSEQUENCE, measured per org before the push: 7 of the 29 orgs this
    -- card serves see rows move from Yes to No (Tullahoma 43, Reading 38,
    -- Euclid 31, Pawnee 22, Windham 16, Niagara Falls 6, Clarkstown 2). Six
    -- keep a real residency register answering (Windham 1,313 households,
    -- Tullahoma 809, Euclid 797, Reading 469, Niagara Falls 374, Pawnee 15).
    -- CLARKSTOWN HAS NO RESIDENCY-TYPED GROUP AT ALL, so has_res_group goes
    -- false there and this column becomes NULL for every one of their rows —
    -- which is the honest answer for an org that runs no residency register,
    -- and better than today's, where their 2 "NON-RESIDENT VERIFICATION FOR
    -- CAMP" holders read as residents.
    AND g.group_type = 'residency'
),
has_res_group AS (
  SELECT EXISTS (SELECT 1 FROM res_group) AS val
),
resident_households AS (
  SELECT DISTINCT m.household_id
  FROM membership m
  JOIN res_group rg ON rg.id = m.group_id
  WHERE m.deleted_at IS NULL
    AND m.canceled_at IS NULL
    AND m.start_at <= now()
    AND (m.end_at IS NULL OR m.end_at >= now())
    AND m.household_id IS NOT NULL
),
resident_users AS (
  SELECT DISTINCT mu.user_id
  FROM membership m
  JOIN res_group rg ON rg.id = m.group_id
  JOIN membership_user mu ON mu.membership_id = m.id
  WHERE m.deleted_at IS NULL
    AND m.canceled_at IS NULL
    AND m.start_at <= now()
    AND (m.end_at IS NULL OR m.end_at >= now())
),
rental_notes AS (
  SELECT
    n.entity_id,
    STRING_AGG(n.message, ', ') AS notes
  FROM note n
  WHERE n.entity_type = 'facilityRental'
    AND n.entity_id IN (SELECT fr2.id FROM facility_rental fr2
                        WHERE fr2.organization_id = {{org_id}}::uuid
                          AND fr2.deleted_at IS NULL)
  GROUP BY n.entity_id
),
base AS (
  SELECT
    fr.*,
    o.name AS org_name,
    l.name AS location_name,
    ct.court_number,
    ct.type AS site_type,
    u.first_name,
    u.last_name,
    u.email,
    u.phone,
    u.household_id AS customer_household_id,
    oi.id AS order_item_id,
    oi.applied_pricing AS oi_applied_pricing,
    r.admin_instructions_md AS reservation_instructions,
    date(lower(r.reservation_timestamp_range))       AS local_date,
    date(upper(r.reservation_timestamp_range))       AS checkout_date,
    lower(r.reservation_timestamp_range)::time       AS local_start_time,
    upper(r.reservation_timestamp_range)::time       AS local_end_time,
    -- Musco lighting
    rls.id            AS lighting_schedule_id,
    rls.lit_from      AS lighting_lit_from,
    rls.lit_until     AS lighting_lit_until,
    rls.sync_status   AS lighting_sync_status
  FROM facility_rental fr
  JOIN organization o ON o.id = fr.organization_id
  JOIN reservation r ON r.facility_rental_id = fr.id
    AND r.deleted_at IS NULL
    AND r.canceled_at IS NULL
  JOIN location l ON l.id = r.location_id
  JOIN reservation_court rc ON r.id = rc.reservation_id
  JOIN court ct ON rc.court_id = ct.id
  LEFT JOIN users u ON fr.customer_user_id = u.id
  LEFT JOIN order_item oi ON oi.reservation_id = r.id
    AND oi.deleted_at IS NULL
  LEFT JOIN reservation_lighting_schedule rls ON rls.reservation_id = r.id
  WHERE fr.deleted_at IS NULL
    AND fr.organization_id = {{org_id}}::uuid
    -- window pushdown: reservation's [check-in, checkout] must overlap the
    -- requested window (or the current-month default when no dates given)
    [[ AND date(upper(r.reservation_timestamp_range)) >= {{start_date}} ]]
    [[ AND date(lower(r.reservation_timestamp_range)) <= {{end_date}} ]]
    AND (1 = 0 [[ OR {{start_date}} IS NOT NULL ]]
         OR date(upper(r.reservation_timestamp_range)) >= date_trunc('month', now()::date)::date)
    AND (1 = 0 [[ OR {{end_date}} IS NOT NULL ]]
         OR date(lower(r.reservation_timestamp_range)) <= (date_trunc('month', now()::date) + interval '1 month' - interval '1 day')::date)
),
-- Every order item that makes up a booking in this window: the reservation's
-- own item plus its add-on children, keyed back to the parent. Scoped to
-- base's item set rather than the org's whole catalogue — this card is
-- already the slowest in the suite and a full-org scan here is what sank the
-- facilities-summary rebuild.
rental_items AS (
  SELECT DISTINCT b.order_item_id AS root_id, b.order_item_id AS item_id
  FROM base b
  WHERE b.order_item_id IS NOT NULL
  UNION
  SELECT DISTINCT b.order_item_id, ch.id
  FROM base b
  JOIN order_item ch ON ch.parent_order_item_id = b.order_item_id
   AND ch.deleted_at IS NULL
),
-- Confirmed money actually taken against those items. Refunds are stored as
-- positive amounts, so they are subtracted rather than summed.
item_tx AS (
  SELECT t.order_item_id,
         SUM(CASE WHEN t.refund_id IS NOT NULL THEN -t.amount ELSE t.amount END) AS net_cents
  FROM order_item_transaction t
  JOIN rental_items ri ON ri.item_id = t.order_item_id
  WHERE t.confirmed_at IS NOT NULL
    AND t.deleted_at IS NULL
  GROUP BY t.order_item_id
),
paid_rollup AS (
  SELECT
    ri.root_id,
    COUNT(*) AS items,
    -- an item is settled when it is marked fully paid, or when there was
    -- nothing to pay for it in the first place (comped to $0)
    COUNT(*) FILTER (
      WHERE oi.fully_paid_at IS NOT NULL
         OR COALESCE((oi.applied_pricing->'result'->>'finalCents')::numeric, 0) <= 0
    ) AS items_settled,
    COALESCE(SUM(tx.net_cents), 0) AS collected_cents
  FROM rental_items ri
  JOIN order_item oi ON oi.id = ri.item_id
  LEFT JOIN item_tx tx ON tx.order_item_id = ri.item_id
  GROUP BY ri.root_id
)
SELECT
  b.org_name                                AS "Org Name",
  b.id                                      AS "Reservation ID",
  d.day::date                               AS "Date",
  to_char(d.day::date, 'Day')              AS "Day",

  -- Begin: show check-in time on first day only
  CASE
    WHEN b.checkout_date = b.local_date
      THEN to_char(b.local_start_time, 'HH12:MIam')
    WHEN d.day::date = b.local_date
      THEN to_char(b.local_start_time, 'HH12:MIam')
    ELSE NULL
  END                                       AS "Begin",

  -- End: show checkout time on last day only
  CASE
    WHEN b.checkout_date = b.local_date
      THEN to_char(b.local_end_time, 'HH12:MIam')
    WHEN d.day::date = b.checkout_date
      THEN to_char(b.local_end_time, 'HH12:MIam')
    ELSE NULL
  END                                       AS "End",

  b.location_name                           AS "Location",
  b.court_number                            AS "Facility",
  b.site_type                               AS "Site Type",
  b.name                                    AS "Purpose",
  b.attendee_count                          AS "Head Cnt",
  CONCAT(b.first_name, ' ', b.last_name)   AS "Reservee",
  b.email                                   AS "Email",
  b.phone                                   AS "Phone",
  CASE
    WHEN NOT (SELECT val FROM has_res_group) THEN NULL
    WHEN rh.household_id IS NOT NULL THEN 'Yes'
    WHEN ru.user_id IS NOT NULL THEN 'Yes'
    ELSE 'No'
  END                                       AS "Resident?",
  INITCAP(b.booking_type)                   AS "Booking Type",
  b.reservation_instructions                AS "Instructions",
  rn.notes                                  AS "Notes",

  -- Add-ons & fees: show only on first day to avoid double-counting
  CASE WHEN d.day::date = b.local_date
    THEN addons.names ELSE NULL
  END                                       AS "Add Ons",
  CASE WHEN d.day::date = b.local_date
    THEN addons.addon_fees ELSE NULL
  END                                       AS "Add-On Fees",
  CASE WHEN d.day::date = b.local_date
    THEN (b.oi_applied_pricing->'result'->>'finalCents')::numeric / 100.0
    ELSE NULL
  END                                       AS "Total",

  -- Paid?: settled state of everything billed under this booking, on every
  -- day of it. NULL (blank in the report — neither tick nor cross) when there
  -- is no order item: nothing was ever charged for, so 'unpaid' would be a
  -- claim the data does not support.
  CASE
    WHEN b.order_item_id IS NULL                       THEN NULL
    WHEN pr.items_settled = pr.items                   THEN 'Yes'
    WHEN pr.items_settled > 0 OR pr.collected_cents > 0 THEN 'Partial'
    ELSE 'No'
  END                                       AS "Paid?",

  -- Multi-day metadata (NULL for single-day bookings)
  CASE WHEN b.checkout_date > b.local_date
    THEN (b.checkout_date - b.local_date + 1)
    ELSE NULL
  END                                       AS "Multi-Day Days",
  CASE WHEN b.checkout_date > b.local_date
    THEN (d.day::date - b.local_date + 1)
    ELSE NULL
  END                                       AS "Multi-Day Day#",

  -- Musco Lighting
  CASE WHEN b.lighting_schedule_id IS NOT NULL THEN 'Yes' ELSE NULL END AS "Lighting",
  b.lighting_lit_from                       AS "Lit From",
  b.lighting_lit_until                      AS "Lit Until",
  b.lighting_sync_status                    AS "Lighting Sync"

FROM base b
-- Expand multi-day bookings: one row per calendar day
CROSS JOIN LATERAL generate_series(
  b.local_date::timestamp,
  b.checkout_date::timestamp,
  '1 day'::interval
) AS d(day)
LEFT JOIN addons                ON addons.parent_order_item_id = b.order_item_id
LEFT JOIN resident_households rh ON rh.household_id = b.customer_household_id
LEFT JOIN resident_users      ru ON ru.user_id      = b.customer_user_id
LEFT JOIN rental_notes        rn ON rn.entity_id    = b.id
LEFT JOIN paid_rollup         pr ON pr.root_id     = b.order_item_id
WHERE
  b.site_type IS NOT NULL
  AND b.status != 'canceled'
  [[ AND d.day::date >= {{start_date}} ]]
  [[ AND d.day::date <= {{end_date}} ]]
  AND (1 = 0 [[ OR {{start_date}} IS NOT NULL ]]
       OR d.day::date >= date_trunc('month', now()::date)::date)
  AND (1 = 0 [[ OR {{end_date}} IS NOT NULL ]]
       OR d.day::date <= (date_trunc('month', now()::date) + interval '1 month' - interval '1 day')::date)
ORDER BY
  d.day::date, b.location_name, b.local_start_time
