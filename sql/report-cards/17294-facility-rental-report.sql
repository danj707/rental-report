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
--
-- 4. 2026-09-10: MUSCO LIGHTING — a removed schedule is no longer lighting,
--    and the lit window is emitted in the FACILITY'S timezone.
--
--    Dan, on a Midland rental: "the midland rental schedule shows this
--    facility rental with musco lighting. but the rental itself doesn't have
--    musco lighting on it, where did this come from?"
--
--    reservation_lighting_schedule is APPEND-ONLY in the sense that matters
--    here: taking the lighting off a rental writes sync_status = 'removed'
--    rather than deleting the row (that Midland row was created 13:24 and
--    updated 13:27 the same afternoon). The card selected sync_status all
--    along and then tested only whether the ROW EXISTED, so every removed
--    schedule kept rendering a 💡 on the schedule and kept the rental inside
--    the "Lit Only" filter. Measured 2026-09-10: all 9 lighting schedules on
--    the platform are 'removed', so this column has never been right for
--    anybody — it was simply too rare to be noticed until Midland asked.
--
--    It is a DENYLIST on the one status observed, not an allowlist: an
--    unknown or NULL sync_status still shows, because a schedule we cannot
--    classify is more likely live than removed and the failure direction
--    should be "tell someone" rather than "hide it".
--
--    THE TIMEZONE IS THE FACILITY'S, NOT THE READER'S. lit_from/lit_until are
--    timestamptz, so shipping them raw made the page render them in whatever
--    zone the browser sits in — Dan read Midland's 6:00pm Central as 7:00pm
--    Eastern, directly under a Begin/End that IS facility-local (those come
--    off reservation_timestamp_range, a tsrange, i.e. already local). So
--    "Lit Window" is emitted PRE-FORMATTED the same way Begin/End are, and
--    nothing downstream parses an instant.
--
--    Proven rather than assumed: converting with the schedule's own timezone
--    reproduces the reservation's own wall clock to the minute on all 8 of
--    the 9 rows whose lighting derives from the reservation (the ninth is a
--    set_time 23:00 end, which correctly does not match the reservation).
--    rls.timezone equals location.timezone on all 9, which is why the
--    location is a safe fallback for a schedule that carries none.
--
--    Lit From / Lit Until are KEPT unchanged beside it. They are in the Excel
--    export, and feeds cache four hours — so a pre-push response and a
--    post-push one are both live at once and the page has to be able to fall
--    back to them.
--
-- 5. 2026-09-11: THE SCHEDULE'S OWN RULE, AND WHETHER MUSCO TOOK IT.
--
--    Dan, with Midland about to go live: "what are we doing for the facility
--    rental report when an actual musco lighting is connected, not just the
--    rec 'add on'?"
--
--    Measured the same day, and the timing is the point: Midland was wired
--    for Musco on 2026-09-09/10 — site_lighting_configuration holds 73 sites
--    across 6 locations and 6 CLC facilities, the ONLY org on the platform
--    with any. 1,230 of their next 1,408 reservations (87%) sit on one of
--    those sites, over 184 rentals. So this column is about to matter for
--    nearly every row of that org's schedule, having never mattered anywhere.
--
--    A SUNSET SCHEDULE HAS NO START INSTANT, and that is what made this
--    urgent rather than cosmetic. start_source is 'sunset' on 2 of the 9
--    schedules ever written (musco_start_value is the literal string 'suns'),
--    and lit_from is NULL on BOTH — there is no fixed time to store, because
--    the switch-on tracks the sun and moves every day of a recurring rental.
--    CONCAT_WS then yields the end alone, so the page would print
--    "Lit: 11:00pm" for a field that comes on at dusk and goes off at 11.
--    Emitting start_source/end_source lets it say "Sunset - 11:00pm" instead.
--    Deliberately NOT composed into "Lit Window" here: the word is
--    presentation, and the page already owns one definition of how a time is
--    displayed (litWindowLabel -> formatTime). The card ships the rule; the
--    page words it.
--
--    "Lighting Sync" WAS ALREADY ON THIS CARD AND READ BY NOTHING — selected
--    here, mapped in public/facility.html, and rendered on no surface. It is
--    the only column that can say whether the lights will actually come on,
--    and without it an errored push draws the same confident 💡 as a healthy
--    one, i.e. a booked team at a dark field. "Lighting Error" carries the
--    vendor's own message beside it, which is the difference between
--    "something failed" and "Musco rejected this field id".
--
--    NOT YET OBSERVABLE, said plainly so nobody reads the page's vocabulary
--    as measured: synced_at is NULL on all 9 rows, last_error is NULL on all
--    9, and sync_status has only ever held 'removed'. 'synced' and 'error'
--    come from the staff MCP tool's own documentation, not from data. Revisit
--    the mapping once Midland has a live one.
WITH addons AS (
  SELECT
    STRING_AGG(
      addon.name || ' ($' || 
      TO_CHAR(COALESCE(
        (addon.applied_pricing->'result'->>'finalCents')::numeric,
        (addon.applied_pricing->'result'->>'finalCents')::numeric
      ) / 100.0, 'FM999999990.00') || ')',
      ', '
    ) AS names,
    SUM(COALESCE(
      (addon.applied_pricing->'result'->>'finalCents')::numeric,
      (addon.applied_pricing->'result'->>'finalCents')::numeric
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
    l.timezone AS location_timezone,
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
    rls.sync_status   AS lighting_sync_status,
    rls.timezone      AS lighting_timezone,
    -- THE RULE, NOT ONLY THE CLOCK. start_source is 'reservation' or 'sunset'
    -- (end_source adds 'set_time'), and a SUNSET-anchored schedule carries NO
    -- lit_from at all — measured, NULL on both such rows of the 9 on the
    -- platform, because there is no fixed instant to store: the switch-on
    -- tracks the sun. Without these two the page can only print the end and
    -- would say "Lit: 11:00pm", which reads as ON at 11 when it means OFF at
    -- 11. last_error is the vendor's own message, which is the difference
    -- between "something failed" and "Musco rejected this field id".
    rls.start_source  AS lighting_start_source,
    rls.end_source    AS lighting_end_source,
    rls.last_error    AS lighting_last_error
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
  -- A REMOVED SCHEDULE IS NOT LIGHTING. Taking Musco off a rental writes
  -- sync_status = 'removed' rather than deleting the row, so joining on
  -- existence alone kept every un-lit rental flagged. Filtered in the JOIN so
  -- all five lighting columns go NULL together — a row cannot be half-lit.
  -- Cannot fan out: 0 reservations on the platform carry more than one
  -- schedule, measured before this was written.
  LEFT JOIN reservation_lighting_schedule rls ON rls.reservation_id = r.id
    AND rls.sync_status IS DISTINCT FROM 'removed'
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

  -- Musco Lighting. The base CTE has already dropped removed schedules, so
  -- all four of these are NULL together for a rental whose lighting was
  -- taken off.
  CASE WHEN b.lighting_schedule_id IS NOT NULL THEN 'Yes' ELSE NULL END AS "Lighting",
  b.lighting_lit_from                       AS "Lit From",
  b.lighting_lit_until                      AS "Lit Until",
  b.lighting_sync_status                    AS "Lighting Sync",
  b.lighting_start_source                   AS "Lit Start Source",
  b.lighting_end_source                     AS "Lit End Source",
  b.lighting_last_error                     AS "Lighting Error",

  -- Lit Window: the same instants, PRE-FORMATTED in the facility's own
  -- timezone, in the same 'HH12:MIam' shape as Begin/End two columns up so
  -- the three read as one clock. The schedule carries its own timezone on
  -- every row measured; the location is the fallback for one that does not.
  -- CONCAT_WS skips a NULL side rather than making the whole string NULL, so a
  -- sunset-anchored schedule prints the end alone instead of "- 11:00pm".
  -- THAT IS NOT A TIME THE PAGE MAY PRINT ON ITS OWN: a lone "11:00pm" reads
  -- as lights ON at 11 when it means OFF at 11. "Lit Start Source" above is
  -- what lets the page say "Sunset - 11:00pm" instead, and it is why the
  -- source columns ship with this one rather than after it.
  NULLIF(CONCAT_WS(' - ',
    to_char(b.lighting_lit_from  AT TIME ZONE COALESCE(b.lighting_timezone, b.location_timezone), 'HH12:MIam'),
    to_char(b.lighting_lit_until AT TIME ZONE COALESCE(b.lighting_timezone, b.location_timezone), 'HH12:MIam')
  ), '')                                    AS "Lit Window"

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
