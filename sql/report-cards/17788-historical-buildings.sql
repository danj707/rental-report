-- Card 17788: ✅ Historical Buildings — v-next SPEED REFACTOR
-- Baseline: 58s cold / 19s warm for 5 rows. Two CTEs were scanning the WHOLE
-- platform, not this org:
-- 1. addons aggregated add-on order_items for EVERY org (missing the
--    organization_id filter that the shared Facility Rental Report card has).
-- 2. rental_notes aggregated note rows for entity_type 'facilityRental' across
--    every org (no entity_type index → seq scan).
-- Both now scoped to the card's org. Output identical — the outer query only
-- consumes this org's three historical-building rentals.
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
    AND addon.organization_id = 'efc0724c-8f32-481a-bab3-fc19c724f3a7'
  GROUP BY addon.parent_order_item_id
),
res_group AS (
  SELECT g.id
  FROM "group" g
  WHERE g.deleted_at IS NULL
    AND g.organization_id = 'efc0724c-8f32-481a-bab3-fc19c724f3a7'
    -- THE GROUP'S OWN TOGGLE, not a name match. Measured platform-wide
    -- 2026-08-31: the old `OR g.name ILIKE '%residen%'` swept in 96 groups
    -- across 35 orgs that are not residency groups — 4,099 live memberships
    -- and 1,446 households — because "Non-Resident" contains "Resident" as a
    -- substring. 516 people on "2026 Summer/Annual Pool Pass (Non-residents)"
    -- were reported as RESIDENTS, and product groups like "El Segundo Resident
    -- ID Card - Adult" (1,088) counted too. It bought nothing in exchange:
    -- every residency-typed group was already matched by the type half, since
    -- 'residency' ILIKE '%residen%'. No org loses coverage (0 orgs have a
    -- residency-NAMED group without a residency-TYPED one), and no negative
    -- guard is needed — "Non-Resident Groups" is typed special-group, which
    -- the toggle cannot match.
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
                        WHERE fr2.organization_id = 'efc0724c-8f32-481a-bab3-fc19c724f3a7'
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
    lower(r.reservation_timestamp_range)::time       AS local_start_time,
    upper(r.reservation_timestamp_range)::time       AS local_end_time
  FROM facility_rental fr
  JOIN organization o ON o.id = fr.organization_id
  JOIN reservation r ON r.facility_rental_id = fr.id
    AND r.deleted_at IS NULL
  JOIN location l ON l.id = r.location_id
  JOIN reservation_court rc ON r.id = rc.reservation_id
  JOIN court ct ON rc.court_id = ct.id
  LEFT JOIN users u ON fr.customer_user_id = u.id
  LEFT JOIN order_item oi ON oi.reservation_id = r.id
    AND oi.deleted_at IS NULL
  WHERE fr.deleted_at IS NULL
    AND fr.organization_id = 'efc0724c-8f32-481a-bab3-fc19c724f3a7'
AND l.name IN ('Brawner Hall', 'Reed House', 'Taylor-Brawner House'))
SELECT
  b.org_name                                AS "Org Name",
  b.local_date                              AS "Date",
  to_char(b.local_date, 'Day')             AS "Day",
  b.location_name                           AS "Location",
  b.court_number                            AS "Site",
  b.site_type                               AS "Site Type",
  b.location_name || ' – ' || b.court_number AS "Location/Facility",
  to_char(b.local_date, 'MM/DD/YYYY') || ' '
    || to_char(b.local_start_time, 'HH12:MIam') || ' - '
    || to_char(b.local_end_time, 'HH12:MIam') AS "Rental Date/Time",
  b.name                                    AS "Event Title",
  CONCAT(b.first_name, ' ', b.last_name)   AS "Renter",
  b.phone                                   AS "Phone",
  b.email                                   AS "Email",
  b.attendee_count                          AS "Head Cnt",
  CASE
    WHEN NOT (SELECT val FROM has_res_group) THEN NULL
    WHEN rh.household_id IS NOT NULL THEN 'Yes'
    WHEN ru.user_id IS NOT NULL THEN 'Yes'
    ELSE 'No'
  END                                       AS "Resident?",
  INITCAP(b.booking_type)                   AS "Booking Type",
  b.reservation_instructions                AS "Instructions",
  rn.notes                                  AS "Notes",
  addons.names                              AS "Add Ons",
  addons.addon_fees                         AS "Add-On Fees",
  (b.oi_applied_pricing->'result'->>'finalCents')::numeric / 100.0 AS "Total"
FROM base b
LEFT JOIN addons                ON addons.parent_order_item_id = b.order_item_id
LEFT JOIN resident_households rh ON rh.household_id = b.customer_household_id
LEFT JOIN resident_users      ru ON ru.user_id      = b.customer_user_id
LEFT JOIN rental_notes        rn ON rn.entity_id    = b.id
WHERE
  b.site_type IS NOT NULL
  AND b.status != 'canceled'
  [[ AND b.location_name = {{location_name}} ]]
  [[ AND b.site_type::text = {{site_type}}::text ]]
  [[ AND b.local_date >= {{start_date}} ]]
  [[ AND b.local_date <= {{end_date}} ]]
  AND (1 = 0 [[ OR {{start_date}} IS NOT NULL ]]
       OR b.local_date >= date_trunc('month', now()::date)::date)
  AND (1 = 0 [[ OR {{end_date}} IS NOT NULL ]]
       OR b.local_date <= (date_trunc('month', now()::date) + interval '1 month' - interval '1 day')::date)
ORDER BY
  b.local_date, b.location_name, b.local_start_time
