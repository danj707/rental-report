-- ─────────────────────────────────────────────────────────────────────────────
-- Account Credit Balances — what this organisation owes its customers today.
--
-- Served through the reporting project as a base data report (CUSTOM_REPORTS
-- key `credit-balances`). Portable to any org: the only parameter is {{org_id}}.
--
-- IT CARRIES A WINDOW, AND THE WINDOW MOVES THE LEDGER COLUMNS ONLY (Dan,
-- 2026-09-10: "those reports should have the same date range filters as the
-- others for consistency"). A balance is a POSITION, not a flow, so it cannot
-- honestly be windowed — the org owes what it owes today whatever range is in
-- the toolbar. The two are separated by the column NAMES rather than left to be
-- inferred: `Balance` is current and all-time, and everything windowed says
-- "in Period" on its own header.
--
-- That split is the treatment this repo already landed on for the Programs
-- summary, where "NET REVENUE" turned out to be lifetime sitting beside a
-- period figure under one date range and read as a bug for weeks. The lesson
-- there was that the arithmetic was fine and the LABELS were the defect, so the
-- labels do that work here from the start.
--
-- CONSEQUENCE WORTH KNOWING: the grand total of `Balance` is the organisation's
-- whole credit liability and does NOT move when the window does. That is
-- correct — it is the number the report exists to produce — and it is why the
-- windowed columns are named the way they are.
--
-- The date bounds are cast, so this runs under a Date or a Text tag alike.
--
-- WHAT A BALANCE IS. `credit_account.balance` is the live figure the product
-- spends against, one account per user per org. `credit` is its ledger, and it
-- records BOTH directions — measured platform-wide: 42,706 positive rows and
-- 38,245 negative, and never soft-deleted (0 of 80,951 carry deleted_at).
--
-- Ledger sign convention, measured by source and perfectly consistent:
--     refund_id set            → always POSITIVE  (37,079 of 37,079) — refunded as credit
--     payment_id set           → always NEGATIVE  (33,061 of 33,061) — credit spent on a purchase
--     order_adjustment_id set  → always NEGATIVE  (4,250 of 4,250)   — credit applied to an order
--     none of the three        → MIXED (5,627 + / 934 −)             — a staff grant or clawback
--
-- SO `balance` AND THE LEDGER ARE TWO INDEPENDENT NUMBERS, and they do not
-- always agree: 487 accounts across 36 orgs differ, by $76,672.79 in total, and
-- only 139 of those have a non-zero balance. Including soft-deleted ledger rows
-- does not close the gap (there are none), so it is real drift rather than a
-- filtering artifact. The report therefore ships BOTH and their difference: the
-- balance leads because it is what a customer can actually spend, and
-- `Ledger Difference` is the cross-check. It is hidden by default in the
-- registry — one tick away, present when someone needs it, never presented as
-- the point of the report.
--
-- NEGATIVE BALANCES ARE REAL AND ARE KEPT. 49 accounts platform-wide are below
-- zero — the org has let more out than it granted. Filtering them away would
-- hide the one state that certainly needs a human.
--
-- Zero-balance accounts are excluded: 143,118 of 160,224 accounts platform-wide
-- have never carried a credit, and a report of empty accounts is not a report.
-- ─────────────────────────────────────────────────────────────────────────────
WITH acct AS (
  SELECT ca.id, ca.user_id, ca.balance
  FROM credit_account ca
  WHERE ca.organization_id = {{org_id}}::uuid
    AND ca.deleted_at IS NULL
    AND ca.balance <> 0
),
-- ALL-TIME, and it stays that way: `Ledger Difference` compares the live
-- balance against the WHOLE ledger, so windowing this CTE would make every
-- account look like it had drifted by whatever fell outside the range.
all_time AS (
  SELECT c.credit_account_id AS account_id, SUM(c.amount) AS net_cents
  FROM credit c
  JOIN acct a ON a.id = c.credit_account_id
  WHERE c.deleted_at IS NULL
  GROUP BY 1
),
-- WINDOWED. Everything this feeds is named "in Period" on the report.
led AS (
  SELECT c.credit_account_id                                  AS account_id,
         COALESCE(SUM(c.amount) FILTER (WHERE c.amount > 0), 0) AS issued_cents,
         COALESCE(-SUM(c.amount) FILTER (WHERE c.amount < 0), 0) AS used_cents,
         COUNT(*)                                             AS entries,
         MIN(c.created_at)                                    AS first_at,
         MAX(c.created_at)                                    AS last_at
  FROM credit c
  JOIN acct a ON a.id = c.credit_account_id
  WHERE c.deleted_at IS NULL
    [[ AND c.created_at >= {{start_date}}::date ]]
    [[ AND c.created_at <  {{end_date}}::date + 1 ]]
  GROUP BY 1
)
SELECT
  COALESCE(NULLIF(BTRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), '(no name on file)')
                                                        AS "Member",
  u.email                                               AS "Email",
  u.rec_id                                              AS "Rec ID",
  -- CURRENT, never windowed. The org owes this today whatever the toolbar says.
  ROUND(a.balance / 100.0, 2)                           AS "Balance",
  ROUND(COALESCE(l.issued_cents, 0) / 100.0, 2)         AS "Issued in Period",
  ROUND(COALESCE(l.used_cents,   0) / 100.0, 2)         AS "Used in Period",
  COALESCE(l.entries, 0)                                AS "Entries in Period",
  l.first_at::date                                      AS "First in Period",
  l.last_at::date                                       AS "Last in Period",
  -- Should be zero, and is not always — see the note above. All-time on BOTH
  -- sides, or the window itself would manufacture a difference.
  ROUND((a.balance - COALESCE(t.net_cents, 0)) / 100.0, 2) AS "Ledger Difference",
  1                                                     AS "Accounts"
FROM acct a
LEFT JOIN led      l ON l.account_id = a.id
LEFT JOIN all_time t ON t.account_id = a.id
LEFT JOIN users    u ON u.id = a.user_id
ORDER BY a.balance DESC, 1
