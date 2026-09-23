/* ── Inventory: the ledger, the hourly sync, and the reorder rule ───────────
   PURE. No Express, no Metabase, no fs — server.js hands it the org's stored
   state and the feed rows, and stores what comes back. That is what lets
   scripts/inventory.spec.js RUN every rule below rather than regex over it:
   everything that can go wrong here is arithmetic about which sale has already
   been counted, and a regex passes on an inverted comparison.

   THE MODEL IS A LEDGER, NOT A NUMBER WE EDIT. Each item carries a list of
   events and on-hand is replayed from them:

     count    sets the balance outright (a physical count)
     sale     − units, from Rec's item log
     refund   + units, a refund on a sale
     void     + units, a sale that vanished from a later read of the item log
     receive  + units, a delivery somebody logged
     adjust   ± units, anything else a person records

   Two things follow from that and they are the whole design:

   1. ON-HAND IS NULL UNTIL SOMEBODY COUNTS. Before the first physical count we
      do not know what is on the shelf, and "0" would say "sold out" about an
      item that may be fully stocked. The page says "Needs a count" instead.
   2. ONLY WHAT HAPPENS AFTER THE LAST COUNT MOVES THE NUMBER. A sale rung up at
      9am and a count taken at 10am: the candy bar was already gone when they
      counted, so subtracting it again would double-count it. Same for a refund
      or a void of a sale made before the count.

   IDEMPOTENT PER ORDER ITEM. The feed is one row per order item (the unit a
   customer bought). `sold` / `refunded` remember which order items have
   already been applied, so the hourly job can re-read an overlapping window
   as often as it likes and never subtract the same sale twice — which matters
   with two replicas and a leader lock that fails open.
   ────────────────────────────────────────────────────────────────────────── */

"use strict";

// How far back each sync reads the item log. Three days is far more than one
// hour needs, on purpose: a sale the item log materialises late, and a void
// that happens the next morning, both land inside it.
const SYNC_LOOKBACK_DAYS = 3;
// A remembered order item is forgotten once it is older than this. Past the
// lookback it can no longer reappear in a read, so remembering it buys nothing.
const REMEMBER_DAYS = SYNC_LOOKBACK_DAYS + 2;
// Only product.type === "product" is stock. A punch pass, a membership, a fee
// and a gift card are all "products" in Rec and none of them sit on a shelf.
const STOCK_TYPES = new Set(["product"]);
const LEDGER_CAP = 400;           // per item; see trimLedger
// Units sold per day, kept per item for the velocity charts. Deliberately
// SEPARATE from the ledger: the ledger only moves after the last count (rule
// 2 below), but "how fast does this sell" is true whether or not anybody has
// counted the shelf yet, and a velocity line that starts on count day would
// read as the product having just launched.
const DAILY_KEEP_DAYS = 120;
const ALERT_LOG_CAP = 60;

const DAY = 86400000;
// Number(null) is 0 and Number("") is 0, so a plain Number() reads "no reorder
// point set" as "reorder at zero" — the weather card's sunshine bug, again.
// Absent stays absent.
const num = (v) => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const tsOf = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

function emptyState() {
  return { items: {}, sold: {}, refunded: {}, voided: {}, recipients: "", alerts: [], lastSync: null };
}

function normalizeState(st) {
  const s = Object.assign(emptyState(), st && typeof st === "object" ? st : {});
  for (const k of ["items", "sold", "refunded", "voided"]) if (!s[k] || typeof s[k] !== "object") s[k] = {};
  if (!Array.isArray(s.alerts)) s.alerts = [];
  return s;
}

// The last physical count, or null. Everything before it is history.
function lastCount(item) {
  const led = (item && item.ledger) || [];
  for (let i = led.length - 1; i >= 0; i--) if (led[i].type === "count") return { idx: i, ev: led[i] };
  return null;
}

function onHand(item) {
  const c = lastCount(item);
  if (!c) return null;
  let b = c.ev.qty;
  const led = item.ledger;
  for (let i = c.idx + 1; i < led.length; i++) b += led[i].qty;
  return b;
}

// "out" | "low" | "ok" | "uncounted" | "notcarried". A variant Rec marks not
// carried never reads out or low — it is not supposed to be on the shelf. Low means AT or below the reorder point:
// "reorder when you have 12" means 12 is already the signal.
function statusOf(item) {
  const q = onHand(item);
  if (item && item.carried === false) return "notcarried";
  if (q === null) return "uncounted";
  if (q <= 0) return "out";
  if (num(item.reorder) !== null && q <= item.reorder) return "low";
  return "ok";
}

function soldSince(item, sinceMs) {
  let n = 0;
  for (const e of (item.ledger || [])) {
    if (e.type === "sale" && tsOf(e.ts) >= sinceMs) n -= e.qty;
    // A refund or void of a sale in the same window takes it back out of
    // "sold", or the pace figure counts a sale that did not stick.
    if ((e.type === "refund" || e.type === "void") && tsOf(e.ts) >= sinceMs) n -= e.qty;
  }
  return Math.max(0, n);
}

// A count must never be trimmed away — it is what the balance is replayed
// from. Everything before the latest count can go, oldest first.
function trimLedger(item) {
  const led = item.ledger;
  if (led.length <= LEDGER_CAP) return;
  const c = lastCount(item);
  const keepFrom = Math.min(led.length - LEDGER_CAP, c ? c.idx : 0);
  if (keepFrom > 0) item.ledger = led.slice(keepFrom);
}

function push(item, ev) {
  item.ledger = item.ledger || [];
  item.ledger.push(ev);
  trimLedger(item);
}

/* ── Catalogue ingest ───────────────────────────────────────────────────── */

// Upserts every catalogue row. A NEW stock product is tracked by default and a
// new pass/fee/membership is not, which is the "I care about candy bars, not
// passes" rule — and an org can flip either way afterwards, which is why the
// default applies only on first sight and never overwrites a choice.
//
// VARIANTS. Rec is adding item variants: "Candy Bar" as the item, fifty candy
// bars underneath it; "Race Tee" with Navy / S … Heather Gray / XL. A shelf
// holds VARIANTS — nobody counts "candy bars", they count Snickers — so the
// unit of stock is the variant, and the parent item is only a grouping.
//
//   a row with a "Variant ID"     → one stock unit per variant, keyed by that
//                                   id, carrying its parent's id and name
//   a row without one             → the product itself is the stock unit,
//                                   exactly as before variants existed
//
// That is the whole compatibility story: a feed that does not carry the
// variant columns yet ingests byte-for-byte as it always has.
//
// A product that WAS a stock unit and later arrives split into variants keeps
// its history (it is real) but is marked `split`, so the page can say its
// stock now lives on the variants rather than calling it archived.
const unitIdOf = (r) => String(r["Variant ID"] || r["Product ID"] || "");
const cleanCode = (v) => String(v == null ? "" : v).replace(/\s+/g, "");

function ingestCatalogue(state, rows) {
  const seen = new Set();
  const splitParents = new Set();
  const recUpc = {};
  let added = 0;
  for (const r of rows) {
    if (r["Row Kind"] !== "item") continue;
    const pid = String(r["Product ID"] || "");
    const vid = String(r["Variant ID"] || "");
    const id = vid || pid;
    if (!id) continue;
    seen.add(id);
    if (vid && pid) splitParents.add(pid);
    const parentName = String(r.Name || "").trim() || "(unnamed product)";
    const variantName = String(r["Variant Name"] || "").trim() || (vid ? "(unnamed variant)" : "");
    const vCents = num(r["Variant Price Cents"]);
    const cents = vCents !== null ? vCents : num(r["Price Cents"]);
    // "Not carried" is Rec's own flag on a variant the org does not stock
    // (Heather Gray / XL). Absent means carried — a feed that cannot say is
    // not a feed saying no.
    const carried = !(r.Carried === false || r.Carried === "false");
    const existing = state.items[id];
    const base = {
      name: vid ? parentName + " · " + variantName : parentName,
      parentId: vid ? pid : null,
      parentName: vid ? parentName : null,
      variantName: vid ? variantName : null,
      sku: String(r.SKU || "").trim(),
      type: String(r["Product Type"] || ""),
      price: cents === null ? null : cents / 100,
      inStore: r["In Store"] === true || r["In Store"] === "true",
      live: true, carried, split: false,
    };
    if (existing) Object.assign(existing, base);
    else {
      state.items[id] = Object.assign(base, {
        track: STOCK_TYPES.has(base.type) && carried,
        upc: "", reorder: null, par: null, cost: null, ledger: [], alerted: false,
      });
      added++;
    }
    const u = cleanCode(r.UPC);
    if (u) recUpc[id] = u;
  }
  // A product archived in Rec stays in the ledger (its history is real) but is
  // marked, so the page can stop offering it without losing what happened.
  for (const [id, it] of Object.entries(state.items)) {
    if (!seen.has(id)) { it.live = false; if (splitParents.has(id)) it.split = true; }
  }
  // A barcode Rec already knows is adopted — but only into an item that has
  // none, and never one another item holds. Our own link wins, because a
  // person scanned it; one barcode, one item, always.
  const held = new Set(Object.values(state.items).map(it => it.upc).filter(Boolean));
  for (const [id, u] of Object.entries(recUpc)) {
    const it = state.items[id];
    if (it.upc || held.has(u)) continue;
    it.upc = u; held.add(u);
  }
  return added;
}

/* ── The hourly sync ────────────────────────────────────────────────────── */

// `rows` is the card's whole answer for [since, now]; `windowStartMs` is the
// instant from which that answer is COMPLETE, so any order item we recorded
// after it and that is missing now was voided.
function applyMovements(state, rows, nowMs, windowStartMs) {
  const present = new Map();   // orderItemId -> row, with a payment in view
  const agg = {};              // productId -> { sale, refund, void }
  const bump = (pid, k, q) => { (agg[pid] = agg[pid] || { sale: 0, refund: 0, void: 0 })[k] += q; };
  let movementRows = 0;
  // Net units sold, bucketed by the day it happened. The card's own local day
  // ("Sold Day" / "Refunded Day", the org's wall clock) wins; a feed without
  // it falls back to the UTC date of the timestamp.
  const dayOf = (day, ts) => (day && /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : (ts ? String(ts).slice(0, 10) : null));
  const tally = (pid, day, q) => {
    const it = state.items[pid];
    if (!it || !day) return;
    const d = it.daily = it.daily || {};
    d[day] = (d[day] || 0) + q;
    if (d[day] === 0) delete d[day];
  };

  // Does this event land AFTER the item's last count? Only then does it move
  // the number (rule 2 at the top of this file).
  const counts = (pid, tMs) => {
    const it = state.items[pid];
    if (!it || !it.track) return false;
    const c = lastCount(it);
    return !!c && tMs !== null && tMs >= tsOf(c.ev.ts);
  };

  for (const r of rows) {
    if (r["Row Kind"] !== "movement") continue;
    movementRows++;
    // The variant is the stock unit when there is one; a sale rung up before
    // the product had variants still lands on the product itself.
    const oid = r["Order Item ID"], pid = unitIdOf(r);
    if (!oid || !pid) continue;
    const q = Math.max(0, num(r.Quantity) === null ? 1 : num(r.Quantity));
    const soldT = tsOf(r["Sold At"]), refT = tsOf(r["Refunded At"]);
    if (soldT !== null) {
      present.set(oid, r);
      if (!state.sold[oid]) {
        const sd = dayOf(r["Sold Day"], r["Sold At"]);
        state.sold[oid] = { p: pid, q, t: r["Sold At"], d: sd };
        tally(pid, sd, q);
        // It came back after we had called it voided — a late read, not a
        // second sale. Take the void back rather than selling it twice.
        if (state.voided[oid]) {
          if (counts(pid, tsOf(state.voided[oid].vt))) bump(pid, "void", -q);
          // The void took the sale out of its day; the sale is back, and the
          // tally above has already put it back in.
          delete state.voided[oid];
        } else if (counts(pid, soldT)) bump(pid, "sale", q);
      }
    }
    if (refT !== null && !state.refunded[oid]) {
      state.refunded[oid] = { p: pid, q, t: r["Refunded At"] };
      tally(pid, dayOf(r["Refunded Day"], r["Refunded At"]), -q);
      if (counts(pid, refT)) bump(pid, "refund", q);
    }
  }

  // Voids. Guarded: a read that returned no movements at all while we
  // remember sales inside its window is far more likely a broken read than a
  // morning where every sale was voided, and treating it as the latter would
  // put a day's sales back on the shelf. Skip, and try again next hour.
  const inWindow = Object.entries(state.sold).filter(([, s]) => tsOf(s.t) >= windowStartMs);
  const voidOk = !(movementRows === 0 && inWindow.length > 0);
  if (voidOk) {
    for (const [oid, s] of inWindow) {
      if (present.has(oid) || state.refunded[oid]) continue;
      delete state.sold[oid];
      const vt = new Date(nowMs).toISOString();
      state.voided[oid] = { p: s.p, q: s.q, t: s.t, vt };
      tally(s.p, s.d || dayOf(null, s.t), -s.q);
      if (counts(s.p, tsOf(s.t))) bump(s.p, "void", s.q);
    }
  }

  // One ledger line per product per sync, not one per candy bar: an hour at a
  // busy snack bar is dozens of sales, and the history reads as "12 sold".
  const stamp = new Date(nowMs).toISOString();
  const totals = { sales: 0, refunds: 0, voids: 0, products: 0 };
  for (const [pid, a] of Object.entries(agg)) {
    const it = state.items[pid];
    if (!it) continue;
    totals.products++;
    if (a.sale)   { push(it, { ts: stamp, type: "sale",   qty: -a.sale,  note: a.sale + " sold · Rec item log" }); totals.sales += a.sale; }
    if (a.refund) { push(it, { ts: stamp, type: "refund", qty: a.refund, note: a.refund + " refunded · added back" }); totals.refunds += a.refund; }
    if (a.void)   { push(it, { ts: stamp, type: "void",   qty: a.void,   note: Math.abs(a.void) + (a.void > 0 ? " voided · added back" : " void reversed · sale reappeared") }); totals.voids += a.void; }
  }

  // Forget order items too old to reappear.
  const forget = nowMs - REMEMBER_DAYS * DAY;
  for (const k of ["sold", "refunded", "voided"])
    for (const [oid, s] of Object.entries(state[k])) if (tsOf(s.t) !== null && tsOf(s.t) < forget) delete state[k][oid];

  const keepFrom = new Date(nowMs - DAILY_KEEP_DAYS * DAY).toISOString().slice(0, 10);
  for (const it of Object.values(state.items))
    if (it.daily) for (const day of Object.keys(it.daily)) if (day < keepFrom) delete it.daily[day];

  totals.voidCheck = voidOk;
  return totals;
}

/* ── Reorder alerts ─────────────────────────────────────────────────────── */

// ONE alert per crossing. An item is announced when it first drops to its
// reorder point and not again every hour it stays there; the flag clears once
// it is back above, so the next dip announces again. Uncounted items and items
// with no reorder point set never alert — there is nothing to compare.
function reorderCrossings(state) {
  const out = [];
  for (const [id, it] of Object.entries(state.items)) {
    // An archived item was hidden on purpose ("that's a pass, not stock"), so
    // it must never turn up on a shopping list either.
    if (!it.track || !it.live || it.archived) { it.alerted = false; continue; }
    const st = statusOf(it);
    const reorderSet = num(it.reorder) !== null;
    if ((st === "low" || st === "out") && reorderSet) {
      if (!it.alerted) { it.alerted = true; out.push(id); }
    } else it.alerted = false;
  }
  return out;
}

function recordAlert(state, ids, recipients, nowMs, sent) {
  if (!ids.length) return;
  state.alerts.unshift({
    ts: new Date(nowMs).toISOString(),
    items: ids.map(id => ({ id, name: state.items[id].name, onHand: onHand(state.items[id]), reorder: state.items[id].reorder })),
    to: recipients, sent: !!sent,
  });
  state.alerts = state.alerts.slice(0, ALERT_LOG_CAP);
}

// Addresses are free text from a person; only well-formed ones are mailed,
// and a list is capped so a paste accident cannot become a mailing list.
function parseRecipients(s) {
  return Array.from(new Set(String(s || "").split(/[\s,;]+/).map(x => x.trim().toLowerCase())
    .filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))).slice(0, 10);
}

// What to order to get back to par. Null when there is no par to aim at.
function orderToPar(item) {
  const q = onHand(item);
  if (q === null || num(item.par) === null) return null;
  return Math.max(0, item.par - Math.max(0, q));
}

/* ── What the page is handed ────────────────────────────────────────────── */

// The parent row's roll-up, computed here so the page does no stock
// arithmetic. On-hand sums COUNTED tracked variants only and says how many are
// not counted yet: "12 Snickers + an uncounted Twix" is not "12 candy bars".
// On-hand over the last N days, as [iso, balance] points, replayed from the
// ledger the same way onHand() is so the sparkline and the number beside it
// cannot disagree. Starts at the balance going INTO the window (or the first
// count inside it), holds flat to now, and is null before anybody counted.
function onHandSeries(item, nowMs, days = 30) {
  const led = item.ledger || [];
  const c = lastCount(item);
  if (!c) return null;
  const from = nowMs - days * DAY;
  let b = null, start = null;
  const pts = [];
  for (const e of led) {
    const t = tsOf(e.ts);
    if (e.type === "count") b = e.qty; else if (b !== null) b += e.qty; else continue;
    if (t === null || t < from) { start = b; continue; }
    if (!pts.length && start !== null) pts.push([new Date(from).toISOString(), start]);
    pts.push([e.ts, b]);
  }
  if (!pts.length && start !== null) pts.push([new Date(from).toISOString(), start]);
  if (pts.length) pts.push([new Date(nowMs).toISOString(), pts[pts.length - 1][1]]);
  return pts.length > 90 ? pts.slice(-90) : pts;
}

// Units sold per day over the last N days, oldest first, zero-filled. A day
// with no sales is a real zero here — the tally records every sale.
function dailySeries(item, nowMs, days) {
  const out = [];
  const d = item.daily || {};
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(nowMs - i * DAY).toISOString().slice(0, 10);
    out.push(Math.max(0, d[day] || 0));
  }
  return out;
}

function groupsOf(items) {
  const g = {};
  for (const i of items) {
    if (!i.parentId || !i.live) continue;
    const x = g[i.parentId] = g[i.parentId] || { id: i.parentId, name: i.parentName, variants: 0, tracked: 0, notCarried: 0,
      onHand: null, uncounted: 0, low: 0, out: 0, sold7: 0, daily: null };
    x.variants++;
    // The whole family's velocity: every variant that sold, tracked or not —
    // "how fast do candy bars move" does not depend on which ones we count.
    if (i.daily) x.daily = x.daily ? x.daily.map((v, k) => v + (i.daily[k] || 0)) : i.daily.slice();
    if (!i.carried) x.notCarried++;
    if (!i.track) continue;
    x.tracked++;
    x.sold7 += i.sold7;
    if (i.status === "uncounted") x.uncounted++;
    if (i.status === "low") x.low++;
    if (i.status === "out") x.out++;
    if (i.onHand !== null && i.status !== "notcarried") x.onHand = (x.onHand || 0) + Math.max(0, i.onHand);
  }
  return g;
}

function view(state, nowMs, historyLimit = 60) {
  const since7 = nowMs - 7 * DAY;
  const items = Object.entries(state.items).map(([id, it]) => {
    const q = onHand(it);
    const sold7 = soldSince(it, since7);
    const perDay = sold7 / 7;
    const c = lastCount(it);
    return {
      id, name: it.name, parentId: it.parentId || null, parentName: it.parentName || null,
      variantName: it.variantName || null, sku: it.sku || "", carried: it.carried !== false, split: !!it.split,
      type: it.type, price: it.price, inStore: it.inStore, live: it.live,
      track: !!it.track, upc: it.upc || "", reorder: it.reorder, par: it.par, cost: it.cost,
      // ARCHIVED is a person saying "this is not stock" (a pass Rec types as a
      // product). It hides the item without touching `track` or the ledger,
      // so a restore comes back with a balance that kept moving meanwhile.
      archived: !!it.archived, archivedAt: it.archivedAt || null,
      onHand: q, status: it.archived ? "archived" : it.track ? statusOf(it) : "untracked", sold7,
      daysLeft: q === null || perDay <= 0 ? null : Math.max(0, Math.floor(q / perDay)),
      orderToPar: orderToPar(it),
      lastCountAt: c ? c.ev.ts : null,
      history: (it.ledger || []).slice(-historyLimit),
      spark: onHandSeries(it, nowMs, 30),
      daily: dailySeries(it, nowMs, 90),
    };
  });
  const days = []; for (let i = 89; i >= 0; i--) days.push(new Date(nowMs - i * DAY).toISOString().slice(0, 10));
  return { items, groups: groupsOf(items), days, alerts: state.alerts, recipients: state.recipients, lastSync: state.lastSync };
}

module.exports = {
  SYNC_LOOKBACK_DAYS, REMEMBER_DAYS, STOCK_TYPES, LEDGER_CAP,
  emptyState, normalizeState, lastCount, onHand, statusOf, soldSince, push,
  DAILY_KEEP_DAYS, unitIdOf, groupsOf, onHandSeries, dailySeries, ingestCatalogue, applyMovements, reorderCrossings, recordAlert, parseRecipients, orderToPar, view,
};
