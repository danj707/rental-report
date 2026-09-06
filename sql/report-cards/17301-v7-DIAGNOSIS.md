# Card 17301 v7 — why it timed out

Measured 2026-09-06 against `Rec-Prod-ReadReplica`, one probe at a time.

**This is a diagnosis, not a candidate.** The live card is v6
(`17301-memberships.sql`, unchanged). Nothing here has been pushed. Read the
v7 section of `CLAUDE.md` first for how v7 came to ship broken; this file is
only the mechanism and what it costs.

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
