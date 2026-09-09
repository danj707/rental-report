-- ════════════════════════════════════════════════════════════════════════════
-- CARD 21685 · REPORT 4 · AQUATIC PASSES AND MEMBERSHIPS
--   https://rec.metabaseapp.com/question/21685        (El Segundo · Joseph Lormans)
--
-- ⚠ THE LIVE CARD DOES NOT HAVE THE SCOPE FIX BELOW. Apply it IN THE UI —
--   Dan has flipped both date tags to Date and set org_id's default, and an
--   API save regenerates every template tag as Text and wipes both.
--
-- One row per MONTH × FACILITY × CATEGORY × ITEM × TIER × RESIDENCY × DESK.
-- Reads materialized.item_log_report; the only base-table touch is users, for
-- the buyer's zip, which the item log does not carry.
--
-- ── FIX 2026-09-09 · THE SCOPE WAS A PARTITION, NOT A DEFINITION ───────────
-- The card used to take every 'product' item EXCEPT Lap Swim / Rec Swim, so
-- that reports 3 and 4 partitioned the catalogue with no overlap and no gap.
-- That is a fine property and the wrong objective: "everything that is not a
-- drop-in swim" is not "aquatic passes", it is the rest of the city. It let in
-- Farmers' Market fees, cooking-class materials, Dial-A-Ride, Outreach
-- Donations, a Red Cross certificate and a Per Player Fee — 19 rows of 3,221
-- in August (0.6% by count) but about a QUARTER of the card's money, one
-- `Per Player Fee- Non Resident` row alone carrying $3,695.
--
-- The fix is NOT "filter to aquatic", which would delete the Rec ID cards —
-- those are legitimately Joseph's report C (2,203 rows in August). It is
-- AQUATIC-NAMED **OR** REC ID, and nothing else. A PARTITION IS ONLY WORTH
-- HAVING OVER A SET THAT IS ALREADY THE RIGHT SET.
--
-- ── RESIDENCY COMES FROM THE BUYER'S ZIP, NOT THE PRODUCT NAME ─────────────
-- CivicRec's Passes report carries a Zip column and its resident discount only
-- appears on 90245 buyers. users.zip_code is populated on 2,719 of El Segundo's
-- 2,990 buyers (91%) and on 791 of 793 pass rows (99.7%), so this reproduces
-- it. The product name ALSO labels non-residents explicitly, and both are
-- emitted — they should agree, and a row where they disagree is worth a look.
-- NOTE users has NO organization_id; it is scoped through customer_id.
-- Better still: residency_zipcode_group exists platform-wide (820 zips, 46
-- orgs) and EL SEGUNDO HAS ZERO ROWS IN IT. Adding 90245 there would make this
-- a first-class flag instead of a join.
--
-- ── THE TENDER SPLIT IS A ONE-TO-ONE MAP, SIGN INCLUDED ────────────────────
-- Cash -> cash | Check -> check | Credit/Debit -> card-online + card-present |
-- User Credit -> organization-credit (negative in both systems). Signed, so the
-- four columns sum to Net Revenue. Card 21684 now matches this.
--
-- ── TRAP: TWO CATALOGUE NAMES FOR ONE PRODUCT ──────────────────────────────
-- "Aquatic Center 30 Punch Pass - Adult" (122) and "AC 30 Punch Pass - Adult"
-- (63) are the same thing and list twice. Same for the 10/20-punch and Annual
-- Membership families, and for "El Segundo Recreation ID Card - Adult" (1)
-- against "El Segundo Resident ID Card - Adult" (1,209). Facility+Category+Tier
-- collapses them; the raw Item column deliberately does not, so the duplication
-- stays visible until the catalogue is tidied. Fixing the catalogue beats
-- maintaining a CASE forever.
--
-- Expect August to look like explosive growth and say that it is NOT: 171 Rec
-- IDs in July against 2,635 in August is everyone re-registering at cutover.
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  to_char(il.datetime_at_primary_timezone, 'YYYY-MM')                 AS "Month",
  CASE
    WHEN il.order_item_name ILIKE 'AC %'
      OR il.order_item_name ILIKE 'Aquatic Center%'                   THEN 'Aquatic Center'
    WHEN il.order_item_name ILIKE 'Plunge%'                           THEN 'Plunge'
    WHEN il.order_item_name ILIKE 'Hilltop%'                          THEN 'Hilltop'
    WHEN il.order_item_name ILIKE 'Wiseburn%'                         THEN 'Wiseburn'
    -- A Rec ID card is city-wide, not one pool's. Tested AFTER the facility
    -- names, so "Wiseburn Rec ID - Adult" stays filed under Wiseburn.
    WHEN il.order_item_name ILIKE '%ID Card%'
      OR il.order_item_name ILIKE '%Rec ID%'                          THEN 'City-wide (Rec ID)'
    -- Unreachable under the scope rule below; left visible rather than silent
    -- so anything new that slips in is obvious instead of mislabelled.
    ELSE 'Other - check the scope rule'
  END                                                                 AS "Facility",
  CASE
    WHEN il.order_item_name ILIKE '%Punch Pass%'                      THEN 'Punch Pass'
    WHEN il.order_item_name ILIKE '%Annual Membership%'               THEN 'Annual Membership'
    WHEN il.order_item_name ILIKE '%Resident ID%'
      OR il.order_item_name ILIKE '%Recreation ID%'
      OR il.order_item_name ILIKE '%Rec ID%'                          THEN 'Rec ID Card'
    WHEN il.order_item_name ILIKE '%Pass%'                            THEN 'Other Pass'
    ELSE 'Other Product'
  END                                                                 AS "Category",
  CASE
    WHEN il.order_item_name ILIKE '%Adult%'                           THEN 'Adult'
    WHEN il.order_item_name ILIKE '%Youth%'                           THEN 'Youth'
    WHEN il.order_item_name ILIKE '%Senior%'                          THEN 'Senior'
    WHEN il.order_item_name ILIKE '%Infant%'                          THEN 'Infant'
    WHEN il.order_item_name ILIKE '%Family%'                          THEN 'Family'
    WHEN il.order_item_name ILIKE '%Military%'                        THEN 'Military'
    ELSE '(no tier in name)'
  END                                                                 AS "Tier",
  CASE
    WHEN u.zip_code = '90245'                                         THEN 'Resident (90245)'
    WHEN u.zip_code IS NULL OR u.zip_code = ''                        THEN 'Unknown - no zip on buyer'
    ELSE 'Non-resident'
  END                                                                 AS "Residency (buyer zip)",
  COALESCE(NULLIF(u.zip_code, ''), '(none)')                          AS "Buyer Zip",
  CASE
    WHEN il.order_item_name ILIKE '%Non-Resident%'                    THEN 'Non-Resident'
    ELSE 'Resident / Standard'
  END                                                                 AS "Residency (item name)",
  il.order_item_name                                                  AS "Item",
  COALESCE(il.desk_location_name, '(no desk - sold online)')          AS "Receipt Location",
  COUNT(*) FILTER (WHERE il.transaction_type = 'payment')             AS "Sold",
  COUNT(*) FILTER (WHERE il.transaction_type = 'refund')              AS "Refunds",
  ROUND((COALESCE(SUM(il.order_item_transaction_amount)
           FILTER (WHERE il.transaction_type = 'payment'), 0)
       - COALESCE(SUM(il.order_item_transaction_amount)
           FILTER (WHERE il.transaction_type = 'refund'),  0))/100.0, 2)
                                                                      AS "Net Revenue",
  ROUND(COALESCE(SUM(il.order_item_transaction_amount * CASE WHEN il.transaction_type = 'refund' THEN -1 ELSE 1 END)
          FILTER (WHERE il.transaction_method = 'cash'), 0)/100.0, 2)  AS "Cash",
  ROUND(COALESCE(SUM(il.order_item_transaction_amount * CASE WHEN il.transaction_type = 'refund' THEN -1 ELSE 1 END)
          FILTER (WHERE il.transaction_method = 'check'), 0)/100.0, 2) AS "Check",
  ROUND(COALESCE(SUM(il.order_item_transaction_amount * CASE WHEN il.transaction_type = 'refund' THEN -1 ELSE 1 END)
          FILTER (WHERE il.transaction_method IN ('card-online','card-present')), 0)/100.0, 2)
                                                                      AS "Credit / Debit",
  ROUND(COALESCE(SUM(il.order_item_transaction_amount * CASE WHEN il.transaction_type = 'refund' THEN -1 ELSE 1 END)
          FILTER (WHERE il.transaction_method = 'organization-credit'), 0)/100.0, 2)
                                                                      AS "User Credit"
FROM materialized.item_log_report il
LEFT JOIN users u ON u.id = il.customer_id
WHERE il.organization_id = {{org_id}}::uuid
  AND il.order_item_type = 'product'
  AND NOT (il.order_item_name ILIKE '%Lap Swim%' OR il.order_item_name ILIKE '%Rec Swim%')
  -- ▼▼ THE SCOPE · an aquatic facility's own product, OR a Rec ID card ▼▼
  AND (
       il.order_item_name ILIKE 'AC %'
    OR il.order_item_name ILIKE 'Aquatic Center%'
    OR il.order_item_name ILIKE 'Plunge%'
    OR il.order_item_name ILIKE 'Hilltop%'
    OR il.order_item_name ILIKE 'Wiseburn%'
    OR il.order_item_name ILIKE '%Resident ID Card%'
    OR il.order_item_name ILIKE '%Recreation ID Card%'
    OR il.order_item_name ILIKE '%Rec ID%'
  )
  -- ::date casts so the bounds parse whether the tag is typed Date or Text
  [[AND il.datetime_at_primary_timezone >= {{start_date}}::date]]
  [[AND il.datetime_at_primary_timezone <  {{end_date}}::date + 1]]
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
ORDER BY 1, 2, 3, 10 DESC
-- ── VERIFICATION · 2026-09-09, THIS EXACT TEXT with literals for the tags ──
-- Run BARE (whole final SELECT, not a summary wrapper — that is how the
-- ORDER BY bug got through the first time), El Segundo, August 2026:
--   424 rows · 3,196 sold · 7 refunds · $13,144.00 net · 55 distinct items
--   the four tenders sum to Net Revenue on ALL 424 ROWS
--   ZERO rows fall to 'Other - check the scope rule'
--   4 rows carry no buyer zip
-- WHAT THE SCOPE FIX REMOVED, measured over the same window:
--   17 rows of 3,213 (0.5% by count) but $6,413.00 of $19,557.00 — 32.8% OF
--   THE CARD'S MONEY — across 7 items: Farmers' Market Prepared Food /
--   Produce / Craft fees, Cooking Class Materials, Sue Carter kitchen fee,
--   Per Player Fee- Non Resident, American Red Cross Certificate Fee.
--   The 2,203 Rec ID card rows STAY: they are Joseph's report C.
-- JUDGEMENT CALLS worth knowing, both excluded:
--   "El Segundo Training Material" (27 rows all-time, $54) and "Adult Helper"
--   (1, $5) are unlabelled — they may be lifeguard training. Say so rather
--   than guessing them in.
--   "Wiseburn Facility Reservation" (2 rows, $0) IS included: it is named for
--   the aquatic centre, and the inclusion rule is by facility name.
-- ALSO CHANGED: a Military tier. There are ~90 Military-priced pass rows and
-- the old CASE had no branch for them, so every one read '(no tier in name)'.
