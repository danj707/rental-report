/* inventory.spec.js — the inventory report's ledger, sync and reorder rules.

   Two halves. The UNIT half requires lib/inventory.js and RUNS it: every way
   this report can be wrong is arithmetic about which sale has already been
   counted, and a regex passes on an inverted comparison. The LIVE half boots
   the real server against a stand-in Metabase and drives the real routes,
   because no unit test can see that the routes read and write the store, that
   the page is served, or that a second sync is idempotent end to end.

   SKIP_SOURCE=1 drops the source assertions; SKIP_LIVE=1 drops the live half. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const INV = require("../lib/inventory");

let passed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else failures.push(msg); }
function guard(name, fn) { try { fn(); } catch (e) { failures.push(name + " THREW: " + e.message); } }

const T0 = Date.parse("2026-09-20T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const H = 3600000;
const cat = (id, name, type, cents) => ({ "Row Kind": "item", "Product ID": id, Name: name, "Product Type": type, "Price Cents": cents, "In Store": true });
const mv = (oid, pid, soldMs, refMs, q) => ({ "Row Kind": "movement", "Product ID": pid, "Order Item ID": oid, Quantity: q == null ? 1 : q,
  "Sold At": soldMs == null ? null : iso(soldMs), "Refunded At": refMs == null ? null : iso(refMs) });
const CATALOGUE = [cat("snk", "Snickers", "product", 200), cat("gat", "Gatorade", "product", 300), cat("pp", "10-Visit Punch Pass", "pass", 4000), cat("fee", "Lost Key Fee", "fee", 1500)];

/* ── catalogue ingest: candy in, passes out ─────────────────────────────── */
guard("ingest", () => {
  const st = INV.emptyState();
  const added = INV.ingestCatalogue(st, CATALOGUE);
  ok(added === 4, "every catalogue row is ingested (got " + added + ")");
  ok(st.items.snk.track === true && st.items.gat.track === true, "a merch product is tracked by default");
  ok(st.items.pp.track === false && st.items.fee.track === false, "a pass and a fee are NOT tracked by default — a punch pass is not a candy bar");
  ok(st.items.snk.price === 2, "price comes through in dollars");
  // A choice the org made survives the next ingest.
  st.items.pp.track = true; st.items.snk.track = false;
  INV.ingestCatalogue(st, CATALOGUE);
  ok(st.items.pp.track === true && st.items.snk.track === false, "re-ingesting never overwrites the org's own track choice");
  // Archived in Rec: kept, marked, not deleted.
  INV.ingestCatalogue(st, CATALOGUE.filter(r => r["Product ID"] !== "gat"));
  ok(st.items.gat && st.items.gat.live === false, "a product gone from the catalogue is kept and marked, not deleted");
});

/* ── on-hand is null until counted ───────────────────────────────────────── */
guard("uncounted", () => {
  const st = INV.emptyState(); INV.ingestCatalogue(st, CATALOGUE);
  ok(INV.onHand(st.items.snk) === null, "on-hand is NULL before the first count, never 0");
  ok(INV.statusOf(st.items.snk) === "uncounted", "an uncounted item reads 'uncounted', not 'out'");
  // Sales before any count move nothing — there is no number to move.
  INV.applyMovements(st, [mv("o1", "snk", T0)], T0 + H, T0 - 48 * H);
  ok(INV.onHand(st.items.snk) === null, "a sale before the first count does not invent a balance");
  ok(st.sold.o1, "…but the order item is still remembered, so it can never be applied later");
});

/* ── the sync: sales down, refunds and voids up, never twice ────────────── */
function counted(qty, atMs) {
  const st = INV.emptyState(); INV.ingestCatalogue(st, CATALOGUE);
  INV.push(st.items.snk, { ts: iso(atMs), type: "count", qty, note: "count" });
  st.items.snk.reorder = 10; st.items.snk.par = 48;
  return st;
}
guard("sync", () => {
  const st = counted(40, T0);
  const win = T0 - 24 * H;
  const rows = [mv("a", "snk", T0 + 1 * H), mv("b", "snk", T0 + 2 * H), mv("c", "snk", T0 + 3 * H, null, 2)];
  const t1 = INV.applyMovements(st, rows, T0 + 4 * H, win);
  ok(INV.onHand(st.items.snk) === 36, "sales after the count come off (40 − 1 − 1 − 2 = 36), got " + INV.onHand(st.items.snk));
  ok(t1.sales === 4, "the sync reports 4 units sold (got " + t1.sales + ")");
  // THE IDEMPOTENCE CLAIM: the next hour re-reads an overlapping window.
  INV.applyMovements(st, rows, T0 + 5 * H, win);
  ok(INV.onHand(st.items.snk) === 36, "re-reading the same window subtracts nothing twice (got " + INV.onHand(st.items.snk) + ")");
  // One ledger line per product per sync, not one per candy bar.
  ok(st.items.snk.ledger.filter(e => e.type === "sale").length === 1, "a sync writes ONE sale line per product, not one per unit");

  // A sale rung up before the count: already gone when they counted.
  INV.applyMovements(st, [...rows, mv("early", "snk", T0 - H)], T0 + 6 * H, win);
  ok(INV.onHand(st.items.snk) === 36, "a sale from BEFORE the count does not come off again");

  // Refund: a unit back.
  INV.applyMovements(st, [...rows.slice(0, 2), mv("c", "snk", T0 + 3 * H, T0 + 6 * H, 2)], T0 + 7 * H, win);
  ok(INV.onHand(st.items.snk) === 38, "a refund puts its units back (36 + 2 = 38), got " + INV.onHand(st.items.snk));
  INV.applyMovements(st, [...rows.slice(0, 2), mv("c", "snk", T0 + 3 * H, T0 + 6 * H, 2)], T0 + 8 * H, win);
  ok(INV.onHand(st.items.snk) === 38, "the same refund read twice goes back once");

  // Void: sale "b" vanishes from a later read of the window.
  const without = [mv("a", "snk", T0 + 1 * H), mv("c", "snk", T0 + 3 * H, T0 + 6 * H, 2)];
  const tv = INV.applyMovements(st, without, T0 + 9 * H, win);
  ok(INV.onHand(st.items.snk) === 39, "a sale that vanished from the item log is a void and goes back (38 + 1), got " + INV.onHand(st.items.snk));
  ok(tv.voids === 1, "the sync reports the void");
  INV.applyMovements(st, without, T0 + 10 * H, win);
  ok(INV.onHand(st.items.snk) === 39, "a void is applied once, not every hour it stays missing");
  // …and if it reappears (a late read), the void is reversed, not re-sold twice.
  INV.applyMovements(st, [...without, mv("b", "snk", T0 + 2 * H)], T0 + 11 * H, win);
  ok(INV.onHand(st.items.snk) === 38, "a sale that reappears reverses its void (39 − 1 = 38), got " + INV.onHand(st.items.snk));
});

guard("void guard", () => {
  // A read that came back with NO movements while we remember sales in its
  // window is a broken read, not a morning of voids.
  const st = counted(40, T0);
  const win = T0 - 24 * H;
  INV.applyMovements(st, [mv("a", "snk", T0 + H), mv("b", "snk", T0 + H)], T0 + 2 * H, win);
  const before = INV.onHand(st.items.snk);
  const t = INV.applyMovements(st, CATALOGUE, T0 + 3 * H, win);   // catalogue only
  ok(INV.onHand(st.items.snk) === before, "an empty movement read does not put a day's sales back on the shelf");
  ok(t.voidCheck === false, "…and it says it skipped the void check");
  // Outside the window, a missing sale is just old, not voided.
  const st2 = counted(40, T0);
  INV.applyMovements(st2, [mv("old", "snk", T0 + H)], T0 + 2 * H, T0 - 24 * H);
  INV.applyMovements(st2, [mv("other", "snk", T0 + 50 * H)], T0 + 51 * H, T0 + 40 * H);
  ok(INV.onHand(st2.items.snk) === 38, "a sale older than the read window is not treated as voided (got " + INV.onHand(st2.items.snk) + ")");
});

guard("stock types", () => {
  const st = counted(40, T0);
  st.items.pp.track = true;
  INV.push(st.items.pp, { ts: iso(T0), type: "count", qty: 5, note: "c" });
  INV.applyMovements(st, [mv("x", "pp", T0 + H)], T0 + 2 * H, T0 - H);
  ok(INV.onHand(st.items.pp) === 4, "an item the org chose to track counts down like any other");
  const un = counted(40, T0); un.items.snk.track = false;
  INV.applyMovements(un, [mv("y", "snk", T0 + H)], T0 + 2 * H, T0 - H);
  ok(INV.onHand(un.items.snk) === 40, "an untracked item never moves");
});

/* ── a count replaces the running number ─────────────────────────────────── */
guard("count", () => {
  const st = counted(40, T0);
  INV.applyMovements(st, [mv("a", "snk", T0 + H), mv("b", "snk", T0 + H)], T0 + 2 * H, T0 - H);
  INV.push(st.items.snk, { ts: iso(T0 + 3 * H), type: "count", qty: 30, note: "recount" });
  ok(INV.onHand(st.items.snk) === 30, "a physical count sets the balance outright");
  INV.push(st.items.snk, { ts: iso(T0 + 4 * H), type: "receive", qty: 24, note: "delivery" });
  ok(INV.onHand(st.items.snk) === 54, "a delivery adds on top of the latest count");
  // Trimming must never drop the count the balance is replayed from.
  for (let i = 0; i < INV.LEDGER_CAP + 50; i++) INV.push(st.items.snk, { ts: iso(T0 + 5 * H + i), type: "adjust", qty: 0, note: "x" });
  ok(INV.lastCount(st.items.snk) !== null, "a long ledger is trimmed without losing its last count");
  ok(INV.onHand(st.items.snk) === 54, "…and the balance survives the trim");
});

/* ── reorder: one alert per crossing ─────────────────────────────────────── */
guard("reorder", () => {
  const st = counted(12, T0);
  ok(INV.reorderCrossings(st).length === 0, "12 on hand with a reorder point of 10 does not alert");
  INV.applyMovements(st, [mv("a", "snk", T0 + H), mv("b", "snk", T0 + H)], T0 + 2 * H, T0 - H);
  ok(INV.statusOf(st.items.snk) === "low", "AT the reorder point (10) is 'low' — the point itself is the signal");
  ok(INV.reorderCrossings(st).join() === "snk", "dropping to the reorder point alerts");
  ok(INV.reorderCrossings(st).length === 0, "…once, not every hour it stays there");
  INV.push(st.items.snk, { ts: iso(T0 + 3 * H), type: "receive", qty: 30, note: "d" });
  INV.reorderCrossings(st);
  ok(st.items.snk.alerted === false, "receiving stock above the point clears the alert");
  INV.push(st.items.snk, { ts: iso(T0 + 4 * H), type: "count", qty: 3, note: "c" });
  ok(INV.reorderCrossings(st).join() === "snk", "…so the next dip alerts again");
  const noPoint = counted(0, T0); noPoint.items.snk.reorder = null;
  ok(INV.reorderCrossings(noPoint).length === 0, "an item with no reorder point set never emails");
  ok(INV.orderToPar(st.items.snk) === 45, "order-to-par is par minus on hand (48 − 3)");
});

guard("recipients", () => {
  const r = INV.parseRecipients("Maria@City.gov, ops@city.gov; not-an-email,  maria@city.gov");
  ok(r.join() === "maria@city.gov,ops@city.gov", "recipients are parsed, lower-cased, de-duplicated and junk dropped (got " + r.join() + ")");
});

guard("view", () => {
  const st = counted(40, T0);
  INV.applyMovements(st, [mv("a", "snk", T0 + H, null, 7)], T0 + 2 * H, T0 - H);
  const v = INV.view(st, T0 + 3 * H);
  const s = v.items.find(i => i.id === "snk");
  ok(s.onHand === 33 && s.sold7 === 7, "the view carries on-hand and 7-day sales");
  ok(s.daysLeft === 33, "days left uses the 7-day pace (33 / (7/7) = 33)");
  ok(v.items.find(i => i.id === "pp").status === "untracked", "an untracked item says so");
});

/* ── variants: the variant is the stock unit, the item is the grouping ──── */
const vcat = (pid, vid, name, vname, extra) => Object.assign({ "Row Kind": "item", "Product ID": pid, "Variant ID": vid, Name: name,
  "Variant Name": vname, "Product Type": "product", "Price Cents": 200, "In Store": true }, extra || {});
const vmv = (oid, pid, vid, soldMs, day) => Object.assign(mv(oid, pid, soldMs), { "Variant ID": vid, "Sold Day": day || null });
guard("variants", () => {
  const st = INV.emptyState();
  INV.ingestCatalogue(st, [cat("bar", "Candy Bar", "product", 200)]);
  INV.push(st.items.bar, { ts: iso(T0 - H), type: "count", qty: 40, note: "c" });
  // Rec splits the item into variants: the product row goes, a row per bar arrives.
  const rows = [vcat("bar", "v-snk", "Candy Bar", "Snickers", { SKU: "SNK", UPC: "040000424314" }),
                vcat("bar", "v-twx", "Candy Bar", "Twix", { "Variant Price Cents": 250 }),
                vcat("bar", "v-mnd", "Candy Bar", "Mounds", { Carried: false })];
  const added = INV.ingestCatalogue(st, rows);
  ok(added === 3, "each variant is its own stock unit (got " + added + ")");
  ok(st.items["v-snk"].parentId === "bar" && st.items["v-snk"].name === "Candy Bar · Snickers", "a variant carries its parent and reads 'Item · Variant'");
  ok(st.items["v-twx"].price === 2.5 && st.items["v-snk"].price === 2, "a variant's own price wins, and falls back to the item's");
  ok(st.items["v-snk"].sku === "SNK", "the SKU comes through");
  ok(st.items["v-snk"].upc === "040000424314", "a barcode Rec already knows is adopted");
  ok(st.items["v-mnd"].track === false && st.items["v-snk"].track === true, "a variant Rec marks not carried comes in switched off");
  ok(INV.statusOf(st.items["v-mnd"]) === "notcarried", "…and never reads out or low");
  ok(st.items.bar.live === false && st.items.bar.split === true && st.items.bar.ledger.length === 1,
     "the old item-level unit keeps its history and is marked split, not deleted");
  // Our own link beats Rec's, and a barcode can never land on two items.
  st.items["v-snk"].upc = "MINE"; INV.ingestCatalogue(st, rows);
  ok(st.items["v-snk"].upc === "MINE", "a barcode a person linked is never overwritten by Rec's");
  INV.ingestCatalogue(st, rows.map(r => r["Variant ID"] === "v-twx" ? Object.assign({}, r, { UPC: "MINE" }) : r));
  ok(st.items["v-twx"].upc === "", "Rec's barcode is not adopted when another item already holds it");
  // A sale on a variant moves THAT variant, not the family.
  INV.push(st.items["v-snk"], { ts: iso(T0), type: "count", qty: 20, note: "c" });
  INV.applyMovements(st, [...rows, vmv("s1", "bar", "v-snk", T0 + H), vmv("s2", "bar", "v-snk", T0 + H)], T0 + 2 * H, T0 - 48 * H);
  ok(INV.onHand(st.items["v-snk"]) === 18, "a variant's sale comes off the variant (20 → 18), got " + INV.onHand(st.items["v-snk"]));
  ok(INV.onHand(st.items.bar) === 40, "…and never off the split item-level unit");
  const v = INV.view(st, T0 + 3 * H);
  const g = v.groups.bar;
  ok(g && g.variants === 3 && g.tracked === 2 && g.notCarried === 1, "the family roll-up counts variants, tracked and not carried");
  ok(g.onHand === 18 && g.uncounted === 1, "the roll-up sums COUNTED variants and says how many are not counted (18, +1)");
  // A feed without the variant columns ingests exactly as before.
  const old = INV.emptyState(); INV.ingestCatalogue(old, CATALOGUE);
  ok(old.items.snk.parentId === null && old.items.snk.carried === true && Object.keys(INV.view(old, T0).groups).length === 0,
     "a pre-variant feed is unchanged: no parent, carried, no families");
});

/* ── velocity: a daily tally that does not wait for a count ───────────────── */
guard("daily", () => {
  const st = INV.emptyState(); INV.ingestCatalogue(st, CATALOGUE);
  const day = (ms) => iso(ms).slice(0, 10);
  // Uncounted: the ledger does not move, but the tally does.
  INV.applyMovements(st, [mv("a1", "snk", T0), mv("a2", "snk", T0), Object.assign(mv("a3", "snk", T0 + H), { "Sold Day": "2026-09-19" })], T0 + 2 * H, T0 - 48 * H);
  ok(INV.onHand(st.items.snk) === null, "an uncounted item still has no balance");
  ok(st.items.snk.daily[day(T0)] === 2 && st.items.snk.daily["2026-09-19"] === 1,
     "…but every sale is tallied, and the card's LOCAL 'Sold Day' wins over the UTC date");
  INV.applyMovements(st, [mv("a1", "snk", T0), mv("a2", "snk", T0), mv("a3", "snk", T0 + H)], T0 + 2 * H, T0 - 48 * H);
  ok(st.items.snk.daily[day(T0)] === 2, "re-reading the same window tallies nothing twice");
  // a2 vanishes → void takes it back out of its day; it reappears → back in.
  INV.applyMovements(st, [mv("a1", "snk", T0), mv("a3", "snk", T0 + H)], T0 + 3 * H, T0 - 48 * H);
  ok(st.items.snk.daily[day(T0)] === 1, "a void takes the unit back out of the day it sold");
  INV.applyMovements(st, [mv("a1", "snk", T0), mv("a2", "snk", T0), mv("a3", "snk", T0 + H)], T0 + 4 * H, T0 - 48 * H);
  ok(st.items.snk.daily[day(T0)] === 2, "…and a sale that reappears goes back in, once");
  INV.applyMovements(st, [mv("a1", "snk", T0, T0 + 30 * H), mv("a2", "snk", T0), mv("a3", "snk", T0 + H)], T0 + 31 * H, T0 - 48 * H);
  ok(st.items.snk.daily[day(T0 + 30 * H)] === -1, "a refund comes off the day it happened");
  const series = INV.dailySeries(st.items.snk, T0 + 31 * H, 3);
  ok(series.length === 3 && series.every(n => n >= 0), "the daily series is zero-filled and never negative");
  // Old days are forgotten.
  st.items.snk.daily["2025-01-01"] = 9;
  INV.applyMovements(st, [], T0 + 32 * H, T0 - 48 * H);
  ok(!("2025-01-01" in st.items.snk.daily), "tally days past DAILY_KEEP_DAYS are dropped");
});

guard("spark", () => {
  const st = counted(40, T0);
  ok(INV.onHandSeries(INV.emptyState().items.x || { ledger: [] }, T0) === null, "no count, no sparkline");
  INV.applyMovements(st, [mv("a", "snk", T0 + H, null, 7)], T0 + 2 * H, T0 - H);
  INV.push(st.items.snk, { ts: iso(T0 + 5 * H), type: "receive", qty: 10, note: "d" });
  const pts = INV.onHandSeries(st.items.snk, T0 + 6 * H);
  ok(pts.map(p => p[1]).join() === "40,33,43,43", "the sparkline replays the ledger: count, sale, delivery, holding to now (got " + pts.map(p => p[1]).join() + ")");
  ok(pts[pts.length - 1][1] === INV.onHand(st.items.snk), "its last point IS the on-hand figure beside it");
  const older = counted(40, T0 - 60 * 86400000);
  INV.push(older.items.snk, { ts: iso(T0 - 50 * 86400000), type: "adjust", qty: -5, note: "x" });
  const op = INV.onHandSeries(older.items.snk, T0, 30);
  ok(op.length === 2 && op[0][1] === 35 && Date.parse(op[0][0]) === T0 - 30 * 86400000, "an old count starts the window at the balance going into it");
});

/* ── source: the wiring that ships a report hidden and reachable ────────── */
if (!process.env.SKIP_SOURCE) {
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  ok(/const DEFAULT_HIDDEN_REPORTS = new Set\(\[[^\]]*"inventory"/.test(srv), "inventory ships HIDDEN (DEFAULT_HIDDEN_REPORTS) — Dan's standing rule");
  const toggle = srv.slice(srv.indexOf('app.post("/api/admin/toggle-report"'), srv.indexOf('app.post("/api/admin/toggle-report"') + 3000);
  ok(/report !== "inventory"/.test(toggle), "the admin toggle accepts inventory, or the switch 400s and nobody can turn it on");
  const reg = srv.indexOf('app.get("/:org/inventory/api/state"');
  const generic = srv.indexOf('app.get("/:org/:report/api/data"');
  ok(reg > 0 && generic > 0 && reg < generic, "the inventory routes are registered ABOVE the generic /:org/:report routes");
  const slack = srv.slice(srv.indexOf("const SLACK_NOTIFY = new Set(["), srv.indexOf("]);", srv.indexOf("const SLACK_NOTIFY = new Set([")));
  ["inv-count", "inv-receive", "inv-link", "inv-track", "inv-reorder"].forEach(e => ok(slack.includes('"' + e + '"'), e + " posts to Slack"));
  ok(/cron\.schedule\("\d+ \* \* \* \*", leaderCron\("inventory"/.test(srv), "the sync is HOURLY and leader-locked");
  ok(/Re-read AFTER the fetch/.test(srv) && /const st = readInventory\(slug\);\s*\n\s*const added = INVENTORY\.ingestCatalogue/.test(srv),
    "the sync re-reads state after the slow fetch, so a count typed meanwhile is not overwritten");
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "report-cards", "inventory-feed.sql"), "utf8").replace(/^\s*--.*$/gm, "");
  ok(/ilr\.datetime_at_primary_timezone >= \{\{since\}\}::timestamp/.test(sql), "the card's window is sargable (bare column, cast on the tag)");
  ok(/p\.type = 'product'/.test(sql), "only product.type = 'product' produces movements");
  ok(/ORDER BY 1, 2\s*$/.test(sql.trim() + "\n") || /ORDER BY 1, 2/.test(sql), "the card keeps its trailing ORDER BY");
  // One value per slug: lift and RUN the helper, since the bug it fixes is
  // "sent both copies" and a regex cannot count what a function returns.
  const a0 = srv.indexOf("function inventoryParamSets("), a1 = srv.indexOf("\nasync function fetchInventoryFeed(");
  ok(a0 > 0 && a1 > a0, "inventoryParamSets is where this expects it");
  try {
    const sets = new Function(srv.slice(a0, a1) + "; return inventoryParamSets;")()(
      [{ id: "a", slug: "org_id", type: "string/=" }, { id: "b", slug: "since", type: "date/single" },
       { id: "c", slug: "since", type: "string/=" }, { id: "d", slug: "org_id", type: "string/=" }], { org_id: "o", since: "s" });
    ok(sets.length === 2 && sets.every(ps => ps.length === 2), "a card with duplicated tags yields two candidate sets, one value per slug each");
    ok(sets[0].map(p => p.id).sort().join() === "c,d", "the LAST-registered set goes first — measured to be the one that answers");
    const one = new Function(srv.slice(a0, a1) + "; return inventoryParamSets;")()(
      [{ id: "a", slug: "org_id" }, { id: "b", slug: "since" }], { org_id: "o", since: "s" });
    ok(one.length === 1, "a clean card is asked once");
  } catch (e) { failures.push("inventoryParamSets THREW: " + e.message); }
  const grp = srv.slice(srv.indexOf('app.post("/:org/inventory/api/group"'), srv.indexOf('app.post("/:org/inventory/api/prefs"'));
  ok(/it\.carried === false\) continue/.test(grp), "the whole-item switch never starts tracking a variant Rec says is not carried");
  ok(/Sold Day/.test(sql) && /to_char\(mv\.sold_lts/.test(sql), "the card emits each sale's LOCAL day");
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "inventory.html"), "utf8");
  ok(!/onHand\s*[-+]=/.test(page) && !/ledger\.reduce/.test(page), "the page does no stock arithmetic of its own — lib/inventory.js is the one definition");
  ok(/'\?token=' \+ encodeURIComponent\(TOKEN\)/.test(page), "every page call carries the org token (the gate 404s without it)");
  ok(/window\.RECESS_CAT/.test(page) && /src="\/open-pdf\.js"/.test(page), "the velocity chart reads the ONE shared categorical palette");
  ok(/S\.mvSlot\[id\]/.test(page), "a line's colour follows the product, not its rank");
  const setup = page.slice(page.indexOf("function renderSetup("), page.indexOf("function render()"));
  const alerts = page.slice(page.indexOf("function renderAlerts("), page.indexOf("function renderSetup("));
  ok(/i\.type === 'product' \|\| i\.track/.test(setup), "Items from Rec lists products only (plus anything already switched on, so it can be switched off)");
  ok(!/id="rcpt"/.test(setup) && /id="rcpt"/.test(alerts) && /id="saveRcpt"/.test(alerts), "the reorder-email address lives on the Reorder emails tab, and only there");
}

/* ── live: the real server against a stand-in Metabase ──────────────────── */
async function live() {
  const { spawn } = require("child_process");
  const http = require("http"), os = require("os");
  const PORT = 3700 + (process.pid % 60), MB_PORT = PORT + 100;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-"));
  fs.writeFileSync(path.join(dataDir, "prewarm-state.json"), JSON.stringify({ lastCompletedAt: new Date().toISOString() }));
  const ORG_ID = "aaaaaaaa-1111-2222-3333-444444444444", TOKEN = "specInvToken0001";
  fs.writeFileSync(path.join(dataDir, "orgs.json"), JSON.stringify({ "spec-inv": { token: TOKEN, orgId: ORG_ID, logoUrl: "", displayName: "Spec Snack Bar" } }));

  const now = Date.now();
  const mb = { rows: [...CATALOGUE], calls: [] };
  const mbSrv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (/^\/api\/public\/card\/spec-inv-uuid\/query\/json/.test(req.url)) {
      const p = JSON.parse(new URL(req.url, "http://x").searchParams.get("parameters") || "[]");
      mb.calls.push(p);
      return send(mb.rows);
    }
    if (/^\/api\/public\/card\/spec-inv-uuid/.test(req.url))
      return send({ id: 22144, parameters: [
        { id: "p1", slug: "org_id", type: "category", target: ["variable", ["template-tag", "org_id"]] },
        { id: "p2", slug: "since", type: "category", target: ["variable", ["template-tag", "since"]] }] });
    res.writeHead(404); res.end("{}");
  });
  await new Promise(r => mbSrv.listen(MB_PORT, "127.0.0.1", r));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, METABASE_URL: `http://127.0.0.1:${MB_PORT}`,
           MB_INVENTORY_UUID: "spec-inv-uuid", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "",
           SKIP_PREWARM: "1", PREWARM_STARTUP_SKIP_MS: "999999999" },
    stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
  const safe = (b) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
  const req_ = (method, p_, body) => new Promise(r => {
    const data = body == null ? null : JSON.stringify(body);
    const h = data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {};
    const rq = http.request({ host: "127.0.0.1", port: PORT, path: p_, method, headers: h }, res => {
      let b = ""; res.on("data", d => b += d); res.on("end", () => r({ status: res.statusCode, body: b, json: safe(b) }));
    });
    rq.on("error", e => r({ status: 0, body: String(e), json: {} }));
    if (data) rq.write(data); rq.end();
  });
  const q = "?token=" + TOKEN;
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { await new Promise(r => setTimeout(r, 250)); up = (await req_("GET", "/healthz")).status === 200; }
    ok(up, "the server booted");
    const page = await req_("GET", "/spec-inv/inventory" + q);
    ok(page.status === 200 && /window\.ORG_CONFIG=/.test(page.body), "the page is served with ORG_CONFIG injected, hidden or not");
    ok((await req_("GET", "/spec-inv/inventory/api/state")).status === 404, "the API 404s without the org token");

    const s1 = (await req_("GET", "/spec-inv/inventory/api/state" + q)).json;
    ok(s1.ok && s1.configured === true, "state answers and says the feed is wired");
    ok(Array.isArray(s1.items) && s1.items.length === 4, "first open ingested the catalogue (got " + (s1.items || []).length + ")");
    const snk = (s) => (s.items || []).find(i => i.id === "snk") || {};
    ok(snk(s1).track === true && (s1.items.find(i => i.id === "pp") || {}).track === false, "merch is tracked, the punch pass is not");
    ok(mb.calls.length >= 1 && mb.calls[0].some(p => p.slug === "org_id" && p.value === ORG_ID), "the card is asked for THIS org's id");
    ok(mb.calls[0].some(p => p.slug === "since" && /^\d{4}-\d{2}-\d{2}$/.test(p.value)), "…with a since date");

    ok((await req_("POST", "/spec-inv/inventory/api/receive" + q, { id: "snk", qty: 5 })).status === 409, "receiving into an uncounted item is refused — count it first");
    const c = await req_("POST", "/spec-inv/inventory/api/count" + q, { id: "snk", qty: 13 });
    ok(c.status === 200 && snk(c.json).onHand === 13, "a first count sets on-hand (got " + snk(c.json).onHand + ")");
    await req_("POST", "/spec-inv/inventory/api/item" + q, { id: "snk", reorder: 12, par: 48, upc: "040000424314" });
    ok((await req_("POST", "/spec-inv/inventory/api/item" + q, { id: "gat", upc: "040000424314" })).status === 409, "one barcode cannot be linked to two items");

    // Two sales land after the count; the sync must not be throttled by the
    // first-open sync, so the stand-in's timestamps are "now".
    mb.rows = [...CATALOGUE, mv("o1", "snk", Date.now() + 1000), mv("o2", "snk", Date.now() + 1000)];
    const st = inventoryReadState(dataDir);
    st.lastSync.ts = new Date(now - 10 * 60000).toISOString();   // let the manual sync through
    writeState(dataDir, st);
    const s2 = await req_("POST", "/spec-inv/inventory/api/sync" + q, {});
    ok(s2.status === 200 && snk(s2.json).onHand === 11, "a sync takes two sales off (13 → 11), got " + snk(s2.json).onHand + " · " + s2.body.slice(0, 120));
    ok(snk(s2.json).status === "low", "11 with a reorder point of 12 is at the reorder point");
    ok((s2.json.alerts || []).length === 1 && s2.json.alerts[0].sent === false, "the crossing is logged, and says no email went (no recipients)");
    const s3 = await req_("POST", "/spec-inv/inventory/api/sync" + q, {});
    ok(snk(s3.json).onHand === 11, "an immediate second sync changes nothing");
    // Variants arrive: the whole-item switch tracks the carried ones only.
    mb.rows = [...CATALOGUE, vcat("tee", "tee-s", "Race Tee", "Navy / S"), vcat("tee", "tee-x", "Race Tee", "Gray / XL", { Carried: false })];
    const st4 = inventoryReadState(dataDir); st4.lastSync.ts = new Date(0).toISOString(); writeState(dataDir, st4);
    const s4 = await req_("POST", "/spec-inv/inventory/api/sync" + q, {});
    ok(s4.json.groups && s4.json.groups.tee && s4.json.groups.tee.variants === 2, "a synced item with variants reaches the page as a family");
    const off = await req_("POST", "/spec-inv/inventory/api/group" + q, { parentId: "tee", track: false });
    ok(off.status === 200 && off.json.changed === 1, "switching the item off turns off its one tracked variant (changed " + off.json.changed + ")");
    const on = await req_("POST", "/spec-inv/inventory/api/group" + q, { parentId: "tee", track: true });
    const gx = (on.json.items || []).find(i => i.id === "tee-x") || {};
    ok(on.json.changed === 1 && gx.track === false, "switching it on never starts tracking the variant Rec says is not carried");
    ok((await req_("POST", "/spec-inv/inventory/api/group" + q, { parentId: "nope", track: true })).status === 404, "an unknown item 404s");
    const onDisk = inventoryReadState(dataDir);
    ok(onDisk && onDisk.items && onDisk.items.snk && onDisk.items.snk.upc === "040000424314", "state is persisted through the store");
  } finally {
    child.kill("SIGKILL"); mbSrv.close();
  }
  function inventoryReadState(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, "inventory", "spec-inv.json"), "utf8")); } catch { return null; } }
  function writeState(dir, st) { fs.writeFileSync(path.join(dir, "inventory", "spec-inv.json"), JSON.stringify(st)); }
}

(async () => {
  if (!process.env.SKIP_LIVE) { try { await live(); } catch (e) { failures.push("live half THREW: " + e.message); } }
  if (failures.length) { failures.forEach(f => console.error("✗ " + f)); console.error(passed + " assertions passed, " + failures.length + " FAILED."); process.exit(1); }
  console.log(passed + " assertions passed.");
})();
