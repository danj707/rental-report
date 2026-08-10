# Report-card SQL — 2026-08-10 speed & accuracy batch

Version-controlled source of truth for the Metabase cards in the
**Base Reports for Ninja Project** collection (3532) that are being updated in
this batch. Full review (methodology, benchmarks, accuracy audit):
https://claude.ai/code/artifact/fcece696-4324-406f-ae82-0ed0078e5ae7

Benchmarks: Apex (heaviest org), 2026-01-01 → 2026-08-10 window, direct DB
execution (cache-bypassed), verified output-identical vs the live card via row
count + order-independent checksum + same-snapshot EXCEPT ALL diffs.

| File | Card | Change | Cold before → after | Warm before → after |
|---|---|---|---|---|
| 17788-historical-buildings.sql | 17788 | org-scope add-ons + notes CTEs (were platform-wide) | 57.9s → 3.2s | 18.7s → 0.3s |
| 17294-facility-rental-report.sql | 17294 | org-scope notes CTE + date-window pushdown | 45.4s → 2.3s | 2.2s → 2.0s |
| 18844-facility-rental-data.sql | 18844 | end-bound pushdown + per-rental revenue lateral + deterministic tie-break | >60s → 1.9s | 4.8s → 1.5s |
| 19570-facilities-summary-v2.sql | 19570 | indexed invoice_v2 path + single billed/collected pass | 34.6s → 15.7s | 40.5s → 1.9s |
| 17300-fast-track.sql | 17300 | one windowed FT booking scan (was 4 org-wide), one session pass | 33.2s → 23.0s | 34.7s → 3.7s |
| 17296-class-roster.sql | 17296 | org-scope emergency-contact / authorized-pickup aggregations | 26.9s → 14.0s | ≈ |
| 17920-transactions-count.sql | 17920 | cast the parameter, not the column (index hygiene) | ≈ | ≈ |
| 17689-user-report.sql | 17689 | **accuracy fix**: "Has Authorized Pickup" was a copy of the emergency-contact EXISTS; now checks `household_contact_user.type='authorizedPickup'`. Apex: 106 emergency vs 17 pickup (old logic: 111 for both). | — | — |
| 19141-revenue-by-stream.HOLD.sql | 19141 | **DO NOT DEPLOY YET** — output-identical rewrite that only wins once `payment`/`refund` get an `(organization_id, created_at)` index. | — | — |

## Deploy runbook (per CLAUDE.md rules)

1. Update each card's SQL — either paste in the Metabase UI (tag types
   preserved), or batch via API/MCP and then **flip every date variable back to
   type Date in the UI** (API saves reset all template tags to Text). 7 of the
   8 cards have Start/End Date variables; 17689 is org-only.
2. Verify each card with a cache-independent live request for the heaviest
   org — a warm-cache render is NOT sign-off:
   `node scripts/verify-report-live.js --manifest scripts/report-cards.manifest.json`
   plus single-card checks for each edited card.
3. Facilities cards (18844/19570) repopulate via prewarm after cutover; prefer
   off-peak.

## Platform index requests (filed separately; not part of this batch)

- `materialized.item_log_report` + `materialized.transaction_report`: no usable
  indexes at all (2.15M rows / 1.2GB and 964k / 976MB) — every org-scoped
  report query seq-scans the whole multi-org view. Want
  `(organization_id, datetime_at_primary_timezone)` on both.
- `payment` / `refund`: `(organization_id, created_at)` — unblocks the 19141
  rewrite and every payment-dated window.
- `order_item_transaction`: `(organization_id, confirmed_at)` — would unblock
  an Instructor Payout (17755) rewrite.
