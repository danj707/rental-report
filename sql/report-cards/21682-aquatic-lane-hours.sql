-- ════════════════════════════════════════════════════════════════════════════
-- CARD 21682 · REPORT 1 · AQUATIC LANE HOURS
--   https://rec.metabaseapp.com/question/21682        (El Segundo · Joseph Lormans)
--
-- ✅ APPLIED AND VERIFIED LIVE 2026-09-09. This mirror matches the live card.
--   NEVER push it through the API: `update_question` regenerates every template
--   tag as Text and would wipe Dan's Date-typed date tags and the hardcoded
--   org_id default, which the dashboard's own filters bind to. Paste in the UI.
--
-- One row per MONTH × LOCATION × LANE × PROGRAM TYPE × RENTAL × BOOKING TYPE.
--
-- A rental attaches to EACH lane it occupies, so "one row per lane" IS Joseph's
-- own definition of a lane hour ("4 lanes for 1 hour/day, 5 days/week = 20").
--
-- ── FIX A 2026-09-09 · A DATE FLOOR AT GO-LIVE ─────────────────────────────
-- The dashboard's date filter arrives EMPTY, so the first screen Joseph saw was
-- 2026-04 and 2026-06 — El Segundo's pre-cutover configuration and test data,
-- named Block / Swimlane / Hold for Reservation / "Pool Reservation:", every
-- one of them falling to "Unknown - Add User". A report whose landing
-- view is test data telling the reader to go categorise it is worse than one
-- that opens empty. Measured: everything before 2026-08-01 is 33 reservations
-- and 35.0 lane hours across 2026-04 / 06 / 07, against 5,808 reservations and
-- 8,338.5 hours in August alone. The floor removes exactly those 33 rows.
--   ▼ ONE LINE TO EDIT if this card is ever pointed at another org ▼
--
-- ── FIX B 2026-09-09 · STAFF BLOCKS AND CLOSURES GET THEIR OWN BUCKET ──────
-- A pool closed for a holiday is not "a programme awaiting a mapping". In LIVE
-- data this fires on exactly one thing today — "Labor Day Closed", 8
-- reservations / 24.0 hours in September — and every pre-cutover Block, Hold
-- and Swimlane leaves with the floor above. The hours are KEPT rather than
-- netted out, so the bucket is a filter Joseph can apply, not a decision this
-- card makes for him: closed lane time is still lane time that was not sold,
-- and which side of the ratio it belongs on is his call, not ours.
-- The test sits AFTER 'Court Reservation:%' so an auto-generated lane name can
-- never be mis-filed as a block — the ordering-is-load-bearing rule.
--
-- ── FIX C 2026-09-09 · A {{location}} FILTER, AND HILLTOP IS IN IT NOW ─────
-- Joseph asked to filter by facility. A Metabase dashboard filter on a NATIVE
-- card can only bind to a TEMPLATE TAG — it cannot filter a result column — so
-- the tag has to exist in the SQL. `location` is a plain text variable, which
-- takes a SINGLE value; a Field Filter would allow multi-select but cannot bind
-- to a computed CASE expression, so it is not an option here.
-- Wire the dashboard widget to a CUSTOM LIST of the three canonical values, NOT
-- to a live query: the CASE ladders in these cards have to be edited when a
-- pool is added, and a self-updating dropdown would offer a fourth value that
-- silently returns zero rows on every card.
-- Hilltop Park was excluded from this card entirely and now has a published
-- pool site (`Hilltop Pool Semi-Private Party`), so it is included, pool only.
--
-- ── THREE THINGS THIS CARD CANNOT DO, by construction ──────────────────────
--  1. SWIM LESSONS BOOKED AS PROGRAMMES CONTRIBUTE ZERO LANE HOURS. All of El
--     Segundo's program sessions carry a location_id and ZERO carry a court;
--     there is no session->court table. Use report 2 (card 21683) for those.
--  2. DO NOT ADD THESE HOURS TO REPORT 2's SESSION HOURS. Naomi's and Mary's
--     exist on both sides (~301 h of lane rental AND as programme sections).
--     Pick one side per programme and say which.
--  3. NO MONEY COLUMN, deliberately. A reservation spanning two lanes produces
--     two rows here, so revenue at lane grain would double-count. Facility
--     money lives in the Facility Rental report.
--
-- VERIFIED 2026-09-09 by running THIS EXACT TEXT (whole final SELECT, literals
-- for the tags) — see the note at the foot of the file.
-- ════════════════════════════════════════════════════════════════════════════
WITH go_live AS (
  -- ▼▼ El Segundo went live on Rec in August 2026. Anything earlier is
  --    pre-cutover configuration and test data. EDIT THIS for another org. ▼▼
  SELECT DATE '2026-08-01' AS d
),
aquatic_sites AS (
  -- ▼▼ THE OTHER BLOCK TO EDIT when a pool or location is added ▼▼
  -- `loc` is the CANONICAL location and it is what {{location}} matches. All
  -- four cards emit these same values, so one filter setting works across the
  -- whole dashboard:
  --     El Segundo Wiseburn Aquatic Center | Urho Saari Swim Stadium | Hilltop Park
  -- The Competition Pool is a separate location RECORD at the same address, so
  -- it FOLDS into the Aquatic Center rather than becoming a fourth thing to
  -- tick (1 site, ~21 h). Its lane name still identifies it in the Lane column.
  SELECT c.id, c.court_number AS lane,
    CASE
      WHEN l.name ILIKE 'El Segundo Wiseburn Aquatic%' THEN 'El Segundo Wiseburn Aquatic Center'
      WHEN l.name = 'Urho Saari Swim Stadium'          THEN 'Urho Saari Swim Stadium'
      WHEN l.name = 'Hilltop Park'                     THEN 'Hilltop Park'
    END AS loc
  FROM court c
  JOIN location l ON l.id = c.location_id
  WHERE c.organization_id = {{org_id}}::uuid
    AND (
      l.name IN (
        'El Segundo Wiseburn Aquatic Center',
        'Urho Saari Swim Stadium',
        'El Segundo Wiseburn Aquatics Center- Competition Pool'
      )
      -- Hilltop Park is a GENERAL PARK, so take its pool and nothing else: its
      -- other five sites are picnic tables and would otherwise land in a
      -- lane-hours report. Measured 2026-09-09: 5 picnic-table + 1 pool.
      OR (l.name = 'Hilltop Park' AND c.type = 'pool')
    )
)
SELECT
  to_char(lower(res.reservation_timestamp_range), 'YYYY-MM')          AS "Month",
  aq.loc                                                              AS "Location",
  aq.lane                                                             AS "Lane",
  CASE
    -- ORDER MATTERS: the auto-generated name is tested FIRST, or a lane called
    -- "Court Reservation: Lap Lane 3" would be filed as Lap Swim programming.
    WHEN fr.name LIKE 'Court Reservation:%'
      OR fr.name LIKE 'Pool Reservation:%'                            THEN 'Individual Lane Reservation'
    -- ▼▼ STAFF BLOCKS AND CLOSURES · not programming, not unmapped ▼▼
    WHEN fr.name ILIKE '%closed%'
      OR fr.name ILIKE '%closure%'
      OR fr.name ILIKE 'block%'
      OR fr.name ILIKE '%hold for%'
      OR fr.name ILIKE 'swimlane%'
      OR fr.name ILIKE '%unavailable%'
      OR fr.name ILIKE '%not reservable%'
      OR fr.name ILIKE '%maintenance%'                                THEN 'Staff Block / Closure'
    -- ▼▼ THE MAPPING · 31 real rental names cover 59.5% of lane hours ▼▼
    WHEN fr.name ILIKE '%drop in%' OR fr.name ILIKE '%rec swim%'      THEN 'Open / Rec Swim'
    WHEN fr.name ILIKE '%lap swim%'                                   THEN 'Lap Swim'
    WHEN fr.name ILIKE '%lesson%'                                     THEN 'Swim Lessons'
    WHEN fr.name ILIKE '%aerobic%' OR fr.name ILIKE '%water fitness%' THEN 'Water Fitness'
    WHEN fr.name ILIKE '%SCAQ%' OR fr.name ILIKE '%master%'           THEN 'Masters'
    WHEN fr.name ILIKE '%waterpolo%' OR fr.name ILIKE '%water polo%'
                                    OR fr.name ILIKE '%WP%'           THEN 'Youth Water Polo'
    WHEN fr.name ILIKE '%ESHS%' OR fr.name ILIKE '%high school%'      THEN 'High Schools'
    WHEN fr.name ILIKE '%Loyola%' OR fr.name ILIKE '%LMU%'            THEN 'College / University'
    ELSE 'Unknown - Add User'
  END                                                                 AS "Program Type",
  fr.name                                                             AS "Rental Name",
  fr.booking_type                                                     AS "Booking Type",
  COUNT(*)                                                            AS "Reservations",
  ROUND(SUM(EXTRACT(EPOCH FROM (upper(res.reservation_timestamp_range)
                              - lower(res.reservation_timestamp_range)))/3600.0)::numeric, 2)
                                                                      AS "Lane Hours"
FROM reservation res
JOIN reservation_court rc ON rc.reservation_id = res.id
JOIN aquatic_sites aq     ON aq.id = rc.court_id
JOIN facility_rental fr   ON fr.id = res.facility_rental_id
WHERE res.canceled_at IS NULL
  AND fr.canceled_at IS NULL
  AND lower(res.reservation_timestamp_range) >= (SELECT d FROM go_live)
  -- Optional location filter. A plain variable takes ONE value; see the header.
  [[AND aq.loc = {{location}}]]
  -- ::date casts so the bounds parse whether the tag is typed Date or Text
  [[AND lower(res.reservation_timestamp_range) >= {{start_date}}::date]]
  [[AND lower(res.reservation_timestamp_range) <  {{end_date}}::date + 1]]
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 1, 2, 3, 8 DESC
-- ── VERIFICATION · 2026-09-09, THIS EXACT TEXT with literals for the tags ──
-- Run BARE (whole final SELECT, not a summary wrapper — that is how the
-- ORDER BY bug got through the first time), unwindowed, i.e. how the dashboard
-- opens with its date filter empty:
--   2,236 rows · 18,987 reservations · 35,983.50 lane hours
--   months 2026-08 .. 2027-01 — NOTHING before August any more
--   Staff Block / Closure ......    8 resv /    24.00 h  (all "Labor Day Closed")
--   Open / Rec Swim ............ 2,280 resv / 13,996.00 h
--   Individual Lane Reservation  7,868 resv /  8,082.50 h
--   Masters .................... 3,772 resv /  4,084.50 h
--   Unmapped ................... 2,159 resv /  3,692.00 h  (10.3% of hours)
--   College / University ......... 780 resv /  2,340.00 h
--   Youth Water Polo ............. 581 resv /  1,866.00 h
--   Water Fitness .............. 1,138 resv /  1,179.00 h
--   Swim Lessons ................. 384 resv /    685.50 h
--   High Schools .................. 17 resv /     34.00 h
-- August alone is unchanged at 5,808 reservations / 8,338.50 h, which is the
-- figure this card was originally signed off on.
-- Also run bare over a single day (2026-09-07, 245 rows) to prove the column
-- list and the ORDER BY execute outside any wrapper.
--
-- ── AND WITH {{location}} SET, same run, the three values partition it ─────
--   El Segundo Wiseburn Aquatic Center  1,854 rows / 15,670 resv / 21,528.00 h / 51 lanes
--   Urho Saari Swim Stadium               382 rows /  3,330 resv / 14,468.50 h / 16 lanes
--   Hilltop Park                            1 row  /      1 resv /      2.00 h /  1 lane
-- 2,237 rows against the 2,236 above: the extra row is Hilltop, which the old
-- scope excluded. The HOURS also move between reads — 35,983.50 then 35,998.50
-- then 35,998.50 within one afternoon, all on the Wiseburn instant-lane side —
-- because this is an OPEN window and campers keep booking. NEVER diff an open
-- window against itself across two reads; it is the recorded rule and it
-- applies to every figure in this file.
