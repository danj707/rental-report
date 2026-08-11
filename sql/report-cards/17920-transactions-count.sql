-- Card 17920: ✅ Transactions Count — v2 SPEED REFACTOR
-- Change: was `tr.organization_id::text = {{org_id}}` — casting the COLUMN to
-- text defeats any index/partition pruning on organization_id. Cast the
-- parameter instead. Output identical.
SELECT
  COUNT(DISTINCT tr.transaction_event_id) AS "Transaction Count"
FROM "materialized"."transaction_report" tr
WHERE tr.organization_id = {{org_id}}::uuid
  AND tr.datetime_at_primary_timezone::date BETWEEN {{start_date}} AND {{end_date}}
