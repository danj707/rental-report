-- ════════════════════════════════════════════════════════════════════════════
-- CARD 21684 · REPORT 3 · AQUATICS DROP-IN ADMISSIONS
--   https://rec.metabaseapp.com/question/21684        (El Segundo · Joseph Lormans)
--
-- ✅ APPLIED AND VERIFIED LIVE 2026-09-09. This mirror matches the live card.
--   NEVER push it through the API: `update_question` regenerates every template
--   tag as Text and would wipe Dan's Date-typed date tags and the hardcoded
--   org_id default, which the dashboard's own filters bind to. Paste in the UI.
--
-- One row per MONTH × FACILITY × CATEGORY × ITEM × RECEIPT LOCATION.
-- Reads materialized.item_log_report only.
--
-- ── FIX 2026-09-09 · THE TENDER COLUMNS DID NOT TIE TO THE CARD'S OWN TOTAL ─
-- The four tender aggregates filtered transaction_type = 'payment', so they
-- were GROSS, while "Revenue (net of refunds)" subtracts refunds. Measured at
-- El Segundo over August 2026:
--     Cash + Check + Credit/Debit + User Credit   $6,027.00
--     Revenue (net of refunds)                    $5,976.00
--     gap                                            $51.00  = August's refunds
-- Every row with Refunds = 0 reconciled to the cent and every row with a refund
-- was over by exactly that refund. EVERY CivicRec money report has its tender
-- columns sum to its total, so this is a real defect, not a definition.
-- Card 21685 already signs its tenders; this now matches it, so the two cards
-- stop disagreeing about what a tender column means inside one dashboard.
-- CivicRec's own User Credit is negative, so signed is also the shape that
-- reproduces theirs.
--
--
-- ── LOCATION COMES FROM THE GL CODE, NOT THE ITEM NAME ─────────────────────
-- Joseph asked to filter by location. `materialized.item_log_report` HAS NO
-- LOCATION COLUMN, so there are only two candidates on this card, and they are
-- not close:
--     desk_location_name        100% populated here, but see card 21685
--     order_item_transaction_gl_code  100% populated, on every row
-- The GL code is also STRUCTURED and El Segundo maintains it in their own
-- finance system, so it needs no list of item-name prefixes kept up to date.
-- Measured 2026-09-09, the full code is a 1:1 location key with zero
-- cross-contamination in either direction:
--     001-505-5213-3-43869  El Segundo Wiseburn Aquatic Center
--     001-505-5202-3-43869  Urho Saari Swim Stadium   (staff call it the Plunge)
--     001-505-5214-3-43860  Hilltop Park
--     001-505-5201-3-43863  El Segundo Resident ID    -- city-wide, not a pool
--     001-505-5213-3-43882 / -43885  Wiseburn Rec ID  -- city-wide, not a pool
-- DO NOT read the first three segments and conclude the field is useless: every
-- El Segundo row starts `001-505-5`, and truncating to that is exactly how this
-- column got written off once already.
-- The values match card 21682's location records exactly, so ONE {{location}}
-- setting works across the dashboard. A dashboard filter on a native card binds
-- to a TEMPLATE TAG, never to a result column — hence the tag. Use a CUSTOM
-- LIST for the widget, not a live query: these CASE ladders must be edited when
-- a pool is added, and a self-updating dropdown would offer a value that
-- silently returns nothing.
--
-- ── TWO COLUMNS, NOT ONE. THIS IS THE WHOLE POINT. ─────────────────────────
-- "Admissions" counts EVERY paid row INCLUDING transaction_method = 'free'.
-- "Revenue" excludes them. Those free rows are membership-holder swipes and
-- punch redemptions — real attendance sitting in the ledger shaped exactly
-- like a sale (8,261 of El Segundo's 20,201 August transactions). CivicRec
-- lists them as their own line with a real quantity and a $0.00 total, which
-- is the correct treatment. Counting rows as sales overstates by ~40%;
-- dropping them understates attendance. Report both.
--
-- "Receipt Location" is desk_location_name — 100% populated on drop-in rows at
-- El Segundo (1,375 of 1,375), so CivicRec's column reproduces exactly. The
-- org-wide "72% have no desk" figure is online PROGRAMME registrations
-- dragging the average and does not apply to counter-sold drop-in.
--
-- Scope is Lap Swim + Rec Swim items, which is what CivicRec's Drop In report
-- lists. Passes, punch cards, memberships and Rec IDs are report 4.
--
-- VERIFIED 2026-09-09 by running THIS EXACT TEXT (whole final SELECT, literals
-- for the tags) over Aug 2026: 19 rows, 1,354 admissions of which 323 free,
-- 9 refunds, $5,976.00 revenue — and the four tenders sum to the revenue on
-- ALL NINETEEN ROWS, refunded rows included. Under the gross tenders they came
-- to $6,027.00.  NOTE the card's older comment claimed 24 rows / 1,380 / $6,061
-- for the same window; those figures do not reproduce and came from a summary
-- probe rather than from the card's own SELECT. Today's are the measured ones.
-- ════════════════════════════════════════════════════════════════════════════
WITH scoped AS (
  -- The location is derived ONCE here so the SELECT and the {{location}} filter
  -- read the same expression; two copies is how two predicates drift apart.
  SELECT il.*,
         CASE il.order_item_transaction_gl_code
           WHEN '001-505-5213-3-43869' THEN 'El Segundo Wiseburn Aquatic Center'
           WHEN '001-505-5202-3-43869' THEN 'Urho Saari Swim Stadium'
           WHEN '001-505-5214-3-43860' THEN 'Hilltop Park'
           ELSE '(unmapped GL ' || COALESCE(il.order_item_transaction_gl_code, '- none') || ')'
         END AS location_name
  FROM materialized.item_log_report il
  WHERE il.organization_id = {{org_id}}::uuid
    AND il.order_item_type = 'product'
    AND (il.order_item_name ILIKE '%Lap Swim%' OR il.order_item_name ILIKE '%Rec Swim%')
    -- ::date casts so the bounds parse whether the tag is typed Date or Text
    [[AND il.datetime_at_primary_timezone >= {{start_date}}::date]]
    [[AND il.datetime_at_primary_timezone <  {{end_date}}::date + 1]]
)
SELECT
  to_char(il.datetime_at_primary_timezone, 'YYYY-MM')                 AS "Month",
  il.location_name                                                    AS "Location",
  CASE
    WHEN il.order_item_name ILIKE '%Lap Swim%'                        THEN 'Lap Swim'
    WHEN il.order_item_name ILIKE '%Rec Swim%'                        THEN 'Rec Swim'
    ELSE 'Other Drop-In'
  END                                                                 AS "Category",
  CASE
    WHEN il.order_item_name ILIKE '%Non-Resident%'                    THEN 'Non-Resident'
    ELSE 'Resident / Standard'
  END                                                                 AS "Residency (item name)",
  il.order_item_name                                                  AS "Item",
  COALESCE(il.desk_location_name, '(no desk - sold online)')          AS "Receipt Location",
  COUNT(*) FILTER (WHERE il.transaction_type = 'payment')             AS "Admissions",
  COUNT(*) FILTER (WHERE il.transaction_type = 'payment'
                     AND il.transaction_method = 'free')              AS "Of which free (member swipes)",
  COUNT(*) FILTER (WHERE il.transaction_type = 'refund')              AS "Refunds",
  ROUND((COALESCE(SUM(il.order_item_transaction_amount)
           FILTER (WHERE il.transaction_type = 'payment'), 0)
       - COALESCE(SUM(il.order_item_transaction_amount)
           FILTER (WHERE il.transaction_type = 'refund'),  0))/100.0, 2)
                                                                      AS "Revenue (net of refunds)",
  -- ▼▼ SIGNED, so the four tenders sum to "Revenue (net of refunds)" ▼▼
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
FROM scoped il
WHERE TRUE
  [[AND il.location_name = {{location}}]]
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 1, 2, 3, 7 DESC
-- ── {{location}} VERIFIED · 2026-09-09, this exact text ────────────────────
-- August 2026, no location set: 19 rows across 3 locations, ZERO unmapped GL.
-- With location = 'Urho Saari Swim Stadium': 8 rows, every one Urho Saari, and
-- the four tenders still tie to Revenue on all 8.
-- The `Facility` column (parsed out of the item name) was REPLACED by
-- `Location` at the same position, so the ORDER BY is unchanged. The item name
-- still carries the facility, so nothing is lost.
