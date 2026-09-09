-- ════════════════════════════════════════════════════════════════════════════
-- CARD 21684 · REPORT 3 · AQUATICS DROP-IN ADMISSIONS
--   https://rec.metabaseapp.com/question/21684        (El Segundo · Joseph Lormans)
--
-- ⚠ THE LIVE CARD DOES NOT HAVE THE TENDER FIX BELOW. Apply it IN THE UI —
--   Dan has flipped both date tags to Date and set org_id's default, and an
--   API save regenerates every template tag as Text and wipes both.
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
SELECT
  to_char(il.datetime_at_primary_timezone, 'YYYY-MM')                 AS "Month",
  CASE
    WHEN il.order_item_name ILIKE 'AC %'
      OR il.order_item_name ILIKE 'Aquatic Center%'                   THEN 'Aquatic Center'
    WHEN il.order_item_name ILIKE 'Plunge%'                           THEN 'Plunge'
    WHEN il.order_item_name ILIKE 'Hilltop%'                          THEN 'Hilltop'
    WHEN il.order_item_name ILIKE 'Wiseburn%'                         THEN 'Wiseburn'
    ELSE 'Other'
  END                                                                 AS "Facility",
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
FROM materialized.item_log_report il
WHERE il.organization_id = {{org_id}}::uuid
  AND il.order_item_type = 'product'
  AND (il.order_item_name ILIKE '%Lap Swim%' OR il.order_item_name ILIKE '%Rec Swim%')
  -- ::date casts so the bounds parse whether the tag is typed Date or Text
  [[AND il.datetime_at_primary_timezone >= {{start_date}}::date]]
  [[AND il.datetime_at_primary_timezone <  {{end_date}}::date + 1]]
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 1, 2, 3, 7 DESC
