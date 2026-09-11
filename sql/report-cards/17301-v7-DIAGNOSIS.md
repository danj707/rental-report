# Card 17301 v7 — why it timed out

Measured 2026-09-06 against `Rec-Prod-ReadReplica`, one probe at a time.

**SUPERSEDED 2026-09-11 — v7.1 IS LIVE.** The fix this file describes as
"proven faster but NOT built" was built, proved and pushed; the card is now
`17301-memberships.sql` v7.1 and `scripts/memberships-card-base-tables.spec.js`
guards the shape. **This file stays because the MECHANISM is the expensive part**
— it is why the two arms must never share a CTE, and it is what a future
"simplification" would undo. The "what a v7.1 still owes" list at the bottom is
kept as written, with what was actually done recorded under it.

Read the v7 section of `CLAUDE.md` first for how v7 came to ship broken; this
file is only the mechanism and what it costs.

## The mechanism: the OR spanned three tables, so the window never reached the plan

v7's `tx` CTE OR'd two predicates that do not live on the same table:

| arm | predicate | lives on |
|---|---|---|
| 1 | `oit.order_item_id IN (win)` | `order_item_transaction` — and separately **indexed** |
| 2 | `oi.product_type = 'product' AND (o.customer_user_id, oi.name) IN (win orphans)` | two **joined** tables |

Postgres cannot evaluate an OR until every column in it is available, so
**both** index-usable predicates were demoted into a `Join Filter` on the
outermost nested loop. `EXPLAIN (COSTS OFF)` at clarksville says it outright:

```
Nested Loop
  Join Filter: ((hashed SubPlan 2) OR ((oi.product_type = 'product')
                                       AND (hashed SubPlan 3)))
  ->  Gather
        ->  Nested Loop
              ->  Parallel Bitmap Heap Scan on order_item_transaction oit
                    Recheck Cond: (organization_id = ...)   <-- the WHOLE ledger
              ->  Index Scan using order_item_pkey on order_item oi
  ->  Index Scan using order_pkey on "order" o
  SubPlan 2 -> CTE Scan on win
  SubPlan 3 -> CTE Scan on win
```

So the plan reads **every one of the org's transactions**, index-joins
`order_item` and then `order` to each, and only *then* applies the filter.
`win` appears solely as the two hashed SubPlans, evaluated last.

**That is why narrowing the window narrowed nothing**, and exactly why a
one-month norman still timed out past 170s — the decisive observation at the
time, now explained rather than merely recorded.
`order_item_transaction_order_item_id_index` is never touched.

## The cost ladder

clarksville, unwindowed, 95,988 transactions / 25,971 purchases / **0 orphans**
(so arm 2's subquery matches an empty set and it *still* timed out):

| shape | time |
|---|---|
| arm 1 alone, no joins | **2.7 s** |
| arm 1 alone, with the two joins | **45.9 s** |
| the shipped OR of both | **timeout past 200 s** |

The joins alone are a 17x; the OR takes it the rest of the way.

## Why the two earlier diagnoses cleared it

Both were **right about what they looked at**. `orphan_items` really does not
scan the org, and the subplans really are hashed behind a bitmap index scan.
What neither noticed is that the bitmap index scan is on `organization_id`
**alone** — the whole ledger — and that the selective predicate sits *above*
two nested-loop joins.

A cost estimate cannot show that. The plan **shape** can.
**Read `EXPLAIN (COSTS OFF)` for shape before reading any cost**, and prefer
`BUFFERS` over wall clock on this replica, whose load varies enough that a
catalog query timed out at 60s in the middle of this session.

## The fix, proven faster but NOT built

Never OR them. Give each arm its own CTE, and drive `tx_oi` **from the window
into the `order_item_id` index** rather than from the ledger.

`tx_oi` needs **no joins at all** — `order_item_id` and `amount` are both
columns on `order_item_transaction`.

```sql
FROM win w
JOIN public.order_item_transaction oit
  ON oit.order_item_id = w.order_item_id
WHERE oit.organization_id = {{org_id}}::uuid
```

Measured at **norman** (the heaviest org) over the thirteen-month window:

| | |
|---|---|
| v6, the whole card | 25.8 s |
| this shape, the payment aggregate | **3.5 s** — 20,487 index lookups |

and the plan uses `order_item_transaction_order_item_id_index`, as intended.

The fallback belongs in its own CTE driven from the orphan pairs, and it is
trivially cheap: re-measured 2026-09-06, **10 orphan rows on the entire
platform across 2 orgs, out of 131,498**.

## Same numbers, not just faster — the precise arm is PROVEN

Speed was measured first and equivalence second, deliberately: v7 shipped broken
because a proof of one shape was read as a proof of another, so this shape got
its own proof rather than inheriting v7's.

`FULL OUTER JOIN` per `order_item_id`, item-log side against base-table side,
over the thirteen-month window:

| | clarksville | norman (heaviest) |
|---|---|---|
| groups compared | **12,213** | **20,448** |
| only in base tables | 0 | 0 |
| only in the item log | 0 | 0 |
| paid diffs | **0** | **0** |
| refund diffs | **0** | **0** |
| paid, item log / base | $124,889.29 / **$124,889.29** | $406,353.50 / **$406,353.50** |
| refunded, item log / base | $95.00 / **$95.00** | $6,698.00 / **$6,698.00** |

**The three filters are load-bearing and were confirmed, not guessed.** The base
side applies `deleted_at IS NULL AND confirmed_at IS NOT NULL AND credit_id IS
NULL`, taken from the partial predicate on
`order_item_transaction_item_log_period_index` — i.e. the item log's own notion
of a countable transaction. Zero diffs over 32,661 groups across two orgs is the
evidence that reading is right. Drop any of the three and this stops being a
proof of anything.

**WHAT THIS DOES NOT PROVE**, and the list matters more than the table:

* only `tx_oi`, the **precise** arm. The customer/product fallback rebuilt on
  base tables is untested here.
* two orgs and one window. Not the platform, and not the unwindowed shape
  prewarm actually sends.
* the aggregate, not the **card** — no end-to-end row-for-row comparison of
  17301's own output has been run against this shape.

## What a v7.1 still owes

- The full equivalence gate again — the value proof was sound for v7's text,
  not for this one, and the whole reason v7 shipped broken is that a proof of
  one shape was read as a proof of another.
- `deleted_at` / `confirmed_at` / `credit_id` semantics re-derived rather than
  copied: `order_item.deleted_at` is deliberately NOT filtered (settled
  empirically over 157k groups), and the item-log index is partial on
  `deleted_at IS NULL AND confirmed_at IS NOT NULL AND credit_id IS NULL`.
- A push and a **date-tag flip**, which takes the Memberships report down for
  every org until a human re-types both tags and re-saves until the parameter
  list is three.

The shape is no longer the unknown. Only the proof is.

## WHAT v7.1 ACTUALLY DID, against that list (2026-09-11)

- **The full equivalence gate, over the NEW text.** Not inherited. An md5 over
  every `(order_item_id : paid : refunded)` group, item log against base tables:
  pawnee 2025-09-04..2026-09-30 **96 groups identical**, apex-sandbox
  **UNWINDOWED** — the shape prewarm sends — **17,369 groups identical**,
  $660,341.55 paid / $26,111.59 refunded either way. Plus a textual proof that
  the change cannot reach anything else: outside the three replaced CTEs, and
  including `win` itself, v6 and v7.1 are **byte-identical**.
- **The fallback, on money that exists.** Re-measured, there are 10 orphan rows
  platform-wide and the item log finds **zero** transactions for any of them, so
  a real orphan can only ever prove 0 = 0. `tx_cust` was instead fed all 102 of
  pawnee's real (customer, product) pairs as if each were an orphan: **66
  groups, $5,750.00 paid, $610.00 refunded, identical md5 both ways.**
- **The whole final SELECT was RUN** with literals, not wrapped in a summary
  probe: pawnee 13mo returns 100 rows (the figure recorded for v6 over that
  window), apex September 727.
- **The three filters re-derived, and one correction.**
  `order_item_transaction.amount` is documented "negative for refunds" and is
  **positive** — measured, 134 of 134 refund rows at pawnee. The refund
  aggregate therefore stays a plain `SUM`.
- **The push and the flip.** Pushed 2026-09-11, read back byte-identical, three
  tags — all `text`, so both dates need the UI flip. The report is down for all
  29 orgs until then (`An error occurred. (HTTP 400)` in 0.1s).
- **The flip, and the sign-off.** Both tags flipped 2026-09-11. Through the
  public endpoint with the app's own parameter shape: pawnee 13mo **100 rows in
  10.9s** (the figure recorded for v6 over that window), **norman over the
  window the page actually sends 275 rows in 3.8s**, apex September 730 rows in
  24.2s. The 13-month norman probe reads 88.5s and 196.2s on identical input —
  that is JSON transfer of 20,546 rows, not the query: the card's whole final
  SELECT with literals, inside a counting wrapper, is **3.6s**.

**A method note worth keeping.** Any query touching `materialized.item_log_report`
costs one full seq scan — 31.9s for pawnee alone on this replica — so the
60-second MCP ceiling makes a FULL OUTER JOIN across both implementations
unrunnable for most orgs. The gate was run as **one md5 fingerprint per side**
instead, each side in its own query, compared outside the database.
