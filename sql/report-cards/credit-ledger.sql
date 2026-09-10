-- ─────────────────────────────────────────────────────────────────────────────
-- Account Credit Ledger — every credit granted or spent, who did it, and why.
--
-- Base data report `credit-ledger`. Portable to any org: {{org_id}} plus an
-- optional date window on the entry's own timestamp.
--
-- This is the grant-grain half of the pair; `credit-balances` is the position.
-- Apex's own "Adds and Subtracts by Admin" saved question is this shape, and it
-- has been copied into three of the five org collections sampled.
--
-- THE DIRECTION IS READ FROM THE SIGN, NOT GUESSED FROM THE SOURCE. `amount` is
-- positive for a grant and negative for a spend, and it is never zero (measured:
-- 0 of 80,951 rows). `Direction` is therefore derived from the sign alone, and
-- `Amount` keeps the signed value so the column sums to the net movement over
-- the window — which is the figure that reconciles against the balances report.
--
-- SOURCE IS STRUCTURAL, and the order of the CASE is load-bearing. A row can
-- carry more than one link (33,061 rows carry payment_id and 37,079 carry
-- refund_id), so the branches are tested most-specific first. Measured, each
-- source has one consistent sign:
--     Refunded as credit   refund_id            37,079 rows, all positive
--     Spent on a purchase  payment_id           33,061 rows, all negative
--     Applied to an order  order_adjustment_id   4,250 rows, all negative
--     Staff adjustment     none of the above     6,561 rows, 5,627 + / 934 −
--
-- `Granted By` IS THE ACTING USER AND IS USUALLY PRESENT — 79,753 of 80,951
-- rows (98.5%) carry creator_user_id. The 1.5% that do not are left blank
-- rather than attributed to anyone.
--
-- THE NOTE IS MOSTLY EMPTY AND THAT IS NOT A BUG: only 4,731 of 80,951 rows
-- (5.8%) carry an admin_note, because the automatic sources do not write one.
-- It is the single most useful column on a staff adjustment, which is exactly
-- where it IS filled in, so it stays — blank on the automated rows.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  TO_CHAR(c.created_at, 'YYYY-MM')                      AS "Month",
  c.created_at::date                                    AS "Date",
  COALESCE(NULLIF(BTRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), '(no name on file)')
                                                        AS "Member",
  u.email                                               AS "Email",
  CASE WHEN c.amount > 0 THEN 'Issued' ELSE 'Used' END  AS "Direction",
  CASE
    WHEN c.refund_id           IS NOT NULL THEN 'Refunded as credit'
    WHEN c.payment_id          IS NOT NULL THEN 'Spent on a purchase'
    WHEN c.order_adjustment_id IS NOT NULL THEN 'Applied to an order'
    ELSE 'Staff adjustment'
  END                                                   AS "Source",
  ROUND(c.amount / 100.0, 2)                            AS "Amount",
  COALESCE(NULLIF(BTRIM(CONCAT_WS(' ', g.first_name, g.last_name)), ''), '')
                                                        AS "Granted By",
  COALESCE(NULLIF(BTRIM(c.admin_note), ''), '')         AS "Note",
  1                                                     AS "Entries"
FROM credit c
LEFT JOIN credit_account ca ON ca.id = c.credit_account_id
LEFT JOIN users u ON u.id = ca.user_id
LEFT JOIN users g ON g.id = c.creator_user_id
WHERE c.organization_id = {{org_id}}::uuid
  AND c.deleted_at IS NULL
  [[ AND c.created_at >= {{start_date}}::date ]]
  [[ AND c.created_at <  {{end_date}}::date + 1 ]]
ORDER BY 1 DESC, c.created_at DESC, 3
