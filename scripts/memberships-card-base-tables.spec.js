#!/usr/bin/env node
/* ============================================================================
 * memberships-card-base-tables.spec.js — card 17301 v7.1.
 *
 * WHAT IT GUARDS. v7.1 moves the two payment aggregates off
 * materialized.item_log_report (2.26M rows, 1230 MB, exactly one index — its
 * primary key, so every read is a full parallel seq scan) and onto
 * public.order_item_transaction, which is indexed on organization_id AND on
 * order_item_id.
 *
 * THE SHAPE IS THE WHOLE THING, and v7 is why. v7 made the same move and TIMED
 * OUT for every org tested except Pawnee, because it put both arms in ONE CTE
 * and OR'd them:
 *
 *     oit.order_item_id IN (win)                          -- order_item_transaction
 *     OR (oi.product_type = 'product' AND ... IN (win))   -- two JOINED tables
 *
 * Postgres cannot evaluate an OR until every column in it is available, so both
 * index-usable predicates were demoted into a Join Filter on the outermost
 * nested loop: the plan read the org's ENTIRE ledger, index-joined order_item
 * and then "order" to every row, and filtered last. Measured at clarksville,
 * unwindowed: arm 1 alone 2.7s, arm 1 WITH those two joins 45.9s, the shipped
 * OR past 200s. Every assertion below exists to stop one of those three shapes
 * coming back, because none of them changes a single value on screen — the card
 * simply stops answering.
 *
 * AND THE SIGN. order_item_transaction.amount carries a column comment saying
 * "Positive for payments, negative for refunds". It is WRONG — measured at
 * pawnee, all 134 refund rows and all 1,217 payment rows are positive — so the
 * refund aggregate must stay a plain SUM. A well-meant ABS() or unary minus
 * added on the strength of that comment would flip every Net Collected figure
 * on the report, silently. Pinned here.
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "sql", "report-cards", "17301-memberships.sql");
const raw  = fs.readFileSync(file, "utf8");

// The header quotes the shapes this guards against on purpose, so every
// structural assertion runs over a comment-stripped copy. LINE COMMENTS FIRST:
// this repo has been bitten by a stray `/*` inside a `//` comment swallowing
// thousands of lines when block comments were stripped first.
const sql = raw.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0; const failures = [];
const ok = (c, m) => { if (c) pass++; else failures.push(m); };

// Slice a top-level CTE body by name. Quote-aware brace/paren counting is
// overkill here — every CTE in this card opens `name AS (` and closes with
// `\n),` or `\n)\n` at column 0 — but the slice is still bounded by the NEXT
// top-level CTE rather than by the first `)`, or a nested subquery ends it.
function cte(name) {
  const m = new RegExp(name + "\\s+AS\\s*(?:MATERIALIZED\\s*)?\\(").exec(sql);
  if (!m) return "";
  let i = sql.indexOf("(", m.index + name.length), depth = 0;
  for (let k = i; k < sql.length; k++) {
    if (sql[k] === "(") depth++;
    else if (sql[k] === ")") { depth--; if (depth === 0) return sql.slice(i + 1, k); }
  }
  return "";
}

const txOi   = cte("tx_oi");
const txCust = cte("tx_cust");
const win    = cte("win");

// --- 1. the item log is gone from this card entirely ----------------------
ok(!/item_log_report/.test(sql),
   "17301: materialized.item_log_report is back — that table has one index (its pkey) so every read is a full seq scan of 1230 MB");
ok(!/org_ilr/.test(sql),
   "17301: org_ilr is back — the shared item-log pass v7.1 exists to delete");

// --- 2. the two arms are separate CTEs, and neither OTHER'd together ------
ok(txOi.length > 0,   "17301: tx_oi is missing");
ok(txCust.length > 0, "17301: tx_cust is missing");
ok(!/\bOR\b/.test(txOi),
   "17301: tx_oi contains an OR — that is exactly what demoted both index predicates into a Join Filter and made v7 time out past 200s");
ok(!/\bOR\b/.test(txCust),
   "17301: tx_cust contains an OR — the two arms must never share a predicate");
ok(!/customer_user_id|order_item_name|product_name/.test(txOi),
   "17301: tx_oi has grown the fallback's customer/product predicate — keep the arms in separate CTEs");

// --- 3. tx_oi drives FROM the window INTO the order_item_id index ---------
ok(/FROM\s+win_oi\s+w\s+JOIN\s+public\.order_item_transaction\s+oit\s+ON\s+oit\.order_item_id\s*=\s*w\.order_item_id/.test(txOi.replace(/\s+/g, " ")),
   "17301: tx_oi no longer drives from win_oi into order_item_transaction on order_item_id — driving from the ledger instead is the 45.9s shape");
// The joins are the 17x. order_item_id and amount are both columns on
// order_item_transaction, so tx_oi needs none.
ok(!/order_item\b(?!_id|_transaction)/.test(txOi) && !/"order"/.test(txOi),
   "17301: tx_oi has grown a join to order_item or \"order\" — measured at clarksville that alone took arm 1 from 2.7s to 45.9s");

// --- 4. the three base-side filters, on BOTH aggregates -------------------
// These are the partial predicate on order_item_transaction_item_log_period_index,
// i.e. the item log's own notion of a countable transaction. Drop any one and
// the money moves.
for (const [name, body] of [["tx_oi", txOi], ["tx_cust", txCust]]) {
  ok(/oit\.deleted_at\s+IS NULL/.test(body),
     "17301: " + name + " lost `deleted_at IS NULL` — deleted transactions would be counted as money");
  ok(/oit\.confirmed_at\s+IS NOT NULL/.test(body),
     "17301: " + name + " lost `confirmed_at IS NOT NULL` — unsettled transactions would be counted as collected");
  ok(/oit\.credit_id\s+IS NULL/.test(body),
     "17301: " + name + " lost `credit_id IS NULL` — store-credit movements would be counted as cash");
  ok(/oit\.organization_id\s*=\s*\{\{org_id\}\}::uuid/.test(body),
     "17301: " + name + " lost its organization_id filter — the ledger is shared and this is what makes the scan an index scan");
}

// order_item.deleted_at is deliberately NOT filtered: settled empirically over
// 157k groups on 2026-09-04, matching the item log means not filtering it.
ok(!/oi\.deleted_at/.test(txCust),
   "17301: tx_cust filters order_item.deleted_at — the item log does not, and adding it moves money");

// --- 5. the sign convention -----------------------------------------------
// The amount column's own comment claims refunds are negative. Measured, they
// are not. An ABS() or unary minus here flips every Net Collected on the page.
for (const [name, body] of [["tx_oi", txOi], ["tx_cust", txCust]]) {
  ok(/SUM\(oit\.amount\) FILTER \(WHERE oit\.payment_id IS NOT NULL\)/.test(body.replace(/\s+/g, " ")),
     "17301: " + name + "'s paid aggregate is not a plain SUM(amount) over payment rows");
  ok(/SUM\(oit\.amount\) FILTER \(WHERE oit\.refund_id\s+IS NOT NULL\)/.test(body.replace(/\s+/g, " ").replace(/oit\.refund_id  /g, "oit.refund_id ")),
     "17301: " + name + "'s refund aggregate is not a plain SUM(amount) over refund rows — refunds are stored POSITIVE despite the column comment, so ABS() or a minus sign would flip Net Collected");
  ok(!/ABS\s*\(/i.test(body) && !/-\s*SUM\(/.test(body),
     "17301: " + name + " negates or ABSes an amount — the column comment says refunds are negative and the data says otherwise");
}

// --- 6. the fallback still reaches the same rows the item log did ---------
ok(/oi\.product_type\s*=\s*'product'/.test(txCust),
   "17301: tx_cust lost `product_type = 'product'` — that is the item log's order_item_type filter it stands in for");
ok(/o\.customer_user_id\s*=\s*wo\.customer_user_id/.test(txCust),
   "17301: tx_cust no longer keys on order.customer_user_id — that is the column the item log's customer_id equals");
ok(/oi\.name\s*=\s*wo\.product_name/.test(txCust),
   "17301: tx_cust no longer keys on order_item.name — that is the item log's order_item_name");

// --- 7. the two driving sets ---------------------------------------------
const winOi = cte("win_oi"), winOrphan = cte("win_orphan");
ok(/SELECT DISTINCT/.test(winOi) && /order_item_id IS NOT NULL/.test(winOi),
   "17301: win_oi is not a DISTINCT list of the window's non-null order items");
ok(/SELECT DISTINCT/.test(winOrphan) && /order_item_id IS NULL/.test(winOrphan),
   "17301: win_orphan is not a DISTINCT list of the window's ORPHAN pairs — the fallback must only ever be consulted for purchases with no order item");

// --- 8. win is still the card's own filter, lifted ------------------------
ok((win.match(/\[\[/g) || []).length === 2,
   "17301: win's date clauses are not both optional [[ ]] — an unparameterised run (prewarm) would restrict to a window nobody asked for");
ok(/mp\.product_type IN \('membership', 'pass'\)/.test(win),
   "17301: win no longer matches the card's own product filter");
// The bottom [[ ]] pair is the AUTHORITY; win is an optimisation. Deleting
// either is how two predicates drift apart silently.
const tail = sql.slice(sql.lastIndexOf("FROM materialized.membership_and_pass_purchases_report mp"));
ok((tail.match(/\[\[\s*AND \(mp\.created_at AT TIME ZONE 'America\/Chicago'\)::date/g) || []).length === 2,
   "17301: the final [[ ]] date filter is gone — win restricts inputs, the bottom filter governs the output");

// --- 9. nothing was lost in transcription --------------------------------
ok(/ORDER BY\s+COALESCE\(mp\.membership_status, mp\.pass_status\),\s+mp\.product_name,\s+mp\.customer_user_last_name,\s+mp\.customer_user_first_name\s*$/.test(sql.trimEnd()),
   "17301: the trailing ORDER BY is gone — the exact thing that silently vanished on card 17300");

// v7.1 changes INPUTS only, so every output column must survive. The page reads
// these by name off a 4-hour-cached response, so a lost one is a blank column.
const COLS = ["User ID","First Name","Last Name","Email","Membership ID","Membership Type",
  "Group / Plan","Status","Renewal Type","Price","Paid","Refunded","Net Collected",
  "Start Date","End Date","Next Renewal","Canceled At","Created At","Last Used",
  "Usage Count","Attendance Count","Coverage","Plan Season End","Plan Term Days",
  "Product Kind","Auto Renew","Period Start","Cancel Scheduled At","Cancel Reason","Resident?"];
for (const c of COLS) {
  ok(sql.includes('AS "' + c + '"'),
     '17301: output column "' + c + '" is missing — v7.1 restricts inputs and must change no output');
}
ok(COLS.length === 30, "17301: the spec's own column list is not the card's 30 columns");

// The three money columns must still read tx_oi first and fall back to tx_cust.
ok(/COALESCE\(tx_oi\.paid_cents, tx_cust\.paid_cents, 0\)/.test(sql),
   "17301: Paid no longer prefers the precise arm over the fallback");
ok(/COALESCE\(tx_oi\.refund_cents, tx_cust\.refund_cents, 0\)/.test(sql),
   "17301: Refunded no longer prefers the precise arm over the fallback");
ok(/LEFT JOIN tx_cust\s+ON mp\.order_item_id IS NULL/.test(sql),
   "17301: tx_cust is joined for rows that HAVE an order item — the fallback exists only for orphans and would otherwise double-answer");

if (failures.length) {
  console.error("\n✗ memberships-card-base-tables.spec.js — " + failures.length + " failure(s):\n");
  for (const f of failures) console.error("  • " + f);
  console.error("\n" + pass + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
console.log("✓ memberships-card-base-tables.spec.js — " + pass + " assertions passed");
