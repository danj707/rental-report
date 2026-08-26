// Spec for moving add-ons out of their own column and into the note line, and
// for the Forms column that replaced them.
//
// Two things here are load-bearing and silent when wrong:
//
//   1. THE ADD-ON MONEY. Card 17294's "Total" is the reservation's own
//      order_item; add-on fees are a SEPARATE sum and are not folded into it.
//      So the note line is now the only place that money appears on screen, and
//      a fragment that renders without its total has quietly dropped revenue
//      from the page while still looking perfectly fine.
//
//   2. THE TOTAL MUST MATCH THE LIST BESIDE IT. The toolbar can filter add-ons.
//      Printing the row's whole add-on fee next to a filtered list puts a number
//      beside items that do not add up to it — the same disagreement that made
//      the facility Summary's chips untrustworthy for a week.
//
// Run: node scripts/facility-addons-forms.spec.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "public", "facility.html");
const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(PAGE, "utf8");
const srv = fs.readFileSync(SERVER, "utf8");

// Slice the module-scope helpers and evaluate just those: the page builds a
// React tree at module scope, so the file as a whole cannot run here.
const start = src.indexOf("function stripAddonPrice(s)");
assert.ok(start > 0, "facility.html should declare stripAddonPrice at module scope");
const end = src.indexOf("const NO_ADDONS_KEY", start);
assert.ok(end > start, "NO_ADDONS_KEY should follow the add-on helpers");

const sandbox = {
  // The fragment prints money and picks icons; both live further up the file.
  formatMoney: v => {
    const n = parseFloat(v);
    return isNaN(n) ? "" : "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  },
  getAddOnEmoji: name => (/alcohol/i.test(name) ? "🍺" : /light/i.test(name) ? "💡" : "🏷️"),
};
vm.createContext(sandbox);
vm.runInContext(src.slice(start, end), sandbox);

const { stripAddonPrice, parseAddOnItems, addonItemPrice,
        visibleAddonItems, addonNoteFragment, addonItemsTotalLabel } = sandbox;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// The real shape card 17294 emits: name, then its own price in parentheses.
const TWO = "Alcohol Permit ($25.00), Field Light Fee ($15.50)";
const ONE = "Alcohol Permit ($25.00)";
// No thousands separator: card 17294 formats with FM999999990.00. That matters
// more than it looks — see the mask assertion at the end of this file.
const BIG = "Tournament Fee ($1250.00)";
const FREE = "Comped Table ($0.00)";

/* ── 1. Prices parse off the card's own format ───────────────────────────── */

eq(addonItemPrice("Alcohol Permit ($25.00)"), 25, "a price parses off the item");
eq(addonItemPrice("Tournament Fee ($1250.00)"), 1250, "a four-figure price parses");
eq(addonItemPrice("Tournament Fee ($1,250.00)"), 1250,
  "a separated price would still parse IF one ever arrived whole");
eq(addonItemPrice("Comped Table ($0.00)"), 0, "$0.00 is a real price — a comped add-on");
eq(addonItemPrice("Alcohol Permit"), null, "an item with no price yields null, not 0");
eq(addonItemPrice(""), null, "empty yields null");
eq(addonItemPrice(null), null, "null yields null");
eq(stripAddonPrice("Alcohol Permit ($25.00)"), "Alcohol Permit", "the name strips cleanly");

/* ── 2. The total is summed from the VISIBLE items ───────────────────────── */

const all = parseAddOnItems(TWO);
eq(all.length, 2, "two add-ons parse into two items");
eq(addonItemsTotalLabel(all), "$40.50", "the total sums the items: 25.00 + 15.50");

// Filtered to one add-on, the total must follow the list down.
const filtered = visibleAddonItems(TWO, new Set(["Alcohol Permit"]), 2);
eq(filtered.length, 1, "the add-on filter narrows the items");
eq(addonItemsTotalLabel(filtered), "$25.00",
  "the total must match the FILTERED list — printing the row's whole fee beside "
  + "one item is a number that does not add up to what is shown");

// A filter that selects everything is not a filter.
eq(visibleAddonItems(TWO, new Set(["Alcohol Permit", "Field Light Fee"]), 2).length, 2,
  "selecting every add-on shows every add-on");
eq(visibleAddonItems(TWO, null, 2).length, 2, "no filter shows everything");

eq(addonItemsTotalLabel([]), undefined, "no items means no total, not $0.00");
eq(addonItemsTotalLabel(parseAddOnItems("Alcohol Permit")), undefined,
  "items with no parseable price yield no total rather than a wrong one");
eq(addonItemsTotalLabel(parseAddOnItems(FREE)), "$0.00",
  "a genuinely comped add-on totals $0.00 — that is a real answer");
eq(addonItemsTotalLabel(parseAddOnItems(BIG)), "$1,250.00",
  "a four-figure total is displayed with a separator even though the card sends none");

/* ── 3. The fragment keeps the money, the icons and the structure ────────── */

const frag = addonNoteFragment(all);
ok(frag.indexOf("$40.50") !== -1, "THE MONEY SURVIVES the column's removal — Total excludes add-on fees");
ok(frag.indexOf("🍺") !== -1, "the alcohol icon survives");
ok(frag.indexOf("💡") !== -1, "the light icon survives");
ok(frag.indexOf("Alcohol Permit ($25.00)") !== -1,
  "the card's own 'Name ($0.00)' structure is preserved, not rebuilt");
ok(frag.indexOf("Field Light Fee ($15.50)") !== -1, "...for every item");
eq(addonNoteFragment([]), "", "no add-ons produces no fragment, so no empty note line");
eq(addonNoteFragment(null), "", "null is safe");

// The label and the printed text come from ONE implementation, so they cannot
// drift — the attribute a render check asserts on is the number on screen.
ok(frag.indexOf(addonItemsTotalLabel(all)) !== -1,
  "the exposed total is the same string the line prints");

/* ── 4. The column is gone, and the toggles are separate ─────────────────── */

ok(!/col-addon-fees/.test(src), "the Add-On $ column is REMOVED, not merely hidden");
ok(!/showAddonFees/.test(src), "...and its old state is gone with it");
ok(/const \[showAddons, setShowAddons\]/.test(src), "add-ons keep a checkbox of their own");
ok(/localStorage\.getItem\('col_addon_fees'\)/.test(src),
  "the old localStorage key is reused, so nobody's saved preference flips on deploy");
// Add-ons used to ride on the Notes checkbox, so turning notes off silently
// took the add-on money with it. Either checkbox alone must produce the line.
ok(/\(showNotes \|\| showAddons\)/.test(src),
  "notes and add-ons are gated SEPARATELY — either alone produces the note line");
ok(/if \(showAddons\) headers\.push\('Add-On Fees'\)/.test(src),
  "Excel keeps the add-on fee as a column: an export is a data file, not a schedule");

/* ── 5. The Forms column links out, and only when there is something there ── */

ok(/tab=requiredInformation/.test(src), "the Forms link points at Required Information");
ok(/facility-rentals\/\$\{r\.resId\}\?tab=requiredInformation/.test(src),
  "...for THIS reservation, not the org's rental list");
ok(/data-forms-empty/.test(src),
  "a rental with no forms renders nothing — a link to an empty tab is a dead end");
ok(/const hasAnyForms = /.test(src),
  "the column only exists where forms do, so an org collecting none never sees it");

/* ── 6. The feed counts and nothing else ─────────────────────────────────── */

const cStart = srv.indexOf("function countFormRows(");
ok(cStart > 0, "server.js should expose countFormRows");
const cEnd = srv.indexOf("async function fetchFormCounts(", cStart);
const box = {}; vm.createContext(box);
vm.runInContext(srv.slice(cStart, cEnd), box);
const { countFormRows } = box;

// Real wire shape: jsonb columns arrive as STRINGS, and the answers carry an S3
// URL and a base64 signature. None of it may reach the browser — the column is
// a link, so a count is the whole job.
const wire = [
  { "Reservation ID": "r1", "Form ID": "picnic", "Answers": JSON.stringify({
      question1: [{ name: "License.jpg", fileId: "x",
                    content: "https://prod-rec-tech-img-bucket.s3.amazonaws.com/secret.jpg" }] }) },
  { "Reservation ID": "r1", "Form ID": "waiver", "Answers": JSON.stringify({
      question4: "data:image/png;base64," + "A".repeat(25000) }) },
  { "Reservation ID": "r2", "Form ID": "picnic", "Answers": "{}" },
  { "Reservation ID": "",   "Form ID": "picnic", "Answers": "{}" },   // no id: skipped
];
const counts = countFormRows(wire);
eq(counts.r1, 2, "two submissions on one rental count as two forms");
eq(counts.r2, 1, "one counts as one");
eq(counts[""], undefined, "a row with no reservation id is skipped, not counted under ''");
eq(Object.keys(counts).length, 2, "only real rentals appear");
const out = JSON.stringify(counts);
ok(!out.includes("base64"), "no signature reaches the browser — one is 25 KB of base64");
ok(!/s3[.-]/.test(out), "no S3 URL either — it 403s and cannot be displayed anyway");
ok(!out.includes("License"), "no filename — they are rarely neutral and this report is mailed");
eq(countFormRows(null).r1, undefined, "a non-array degrades to an empty map rather than throwing");

// The route soft-fails and self-disables, same contract as permits.
ok(/app\.get\("\/:org\/facility\/api\/forms"/.test(srv), "the counts route exists");
ok(/if \(!FORMS_UUID\) return res\.json\(\{ forms: \{\}, disabled: true \}\)/.test(srv),
  "unset env means the column never appears — nothing to switch on per org");
ok(/forms: \{\}, error: true/.test(srv), "a failed feed is a degraded schedule, not a broken one");
ok(/"form-open"/.test(srv), "opening a rental's forms pings the activity feed");
ok(/rec\.event === "form-open"[\s\S]{0,140}rec\.rental/.test(srv),
  "...debounced by rental, so three bookings read as three looks");

/* ── 7. The cross-file invariant the comma-split depends on ──────────────────
   The card joins a rental's add-ons into ONE string with ", ", and the client
   splits that string on commas. So a price containing a thousands separator
   would split mid-number: "Tournament Fee ($1" + "250.00)". Card 17294 formats
   with FM999999990.00, which emits no separator, and that is the only reason
   the split is safe. Nothing else in the repo checks it, and the failure would
   be silent — every multi-add-on row quietly mis-parsed. */

const CARD = fs.readFileSync(
  path.join(__dirname, "..", "sql", "report-cards", "17294-facility-rental-report.sql"), "utf8");
const masks = CARD.match(/FM[0-9G,.]+/g) || [];
ok(masks.length > 0, "card 17294 should format add-on prices with TO_CHAR");
ok(masks.every(m => !m.includes("G") && !m.includes(",")),
  "the add-on price mask must NOT emit a thousands separator: the client splits "
  + "the joined add-on string on commas, so '$1,250.00' would split mid-number. "
  + "Found: " + masks.join(" "));
// And the separator that does reach the screen comes from formatMoney, after the
// split — which is why the total above can display one safely.
ok(/', '/.test(CARD) || /', '\)/.test(CARD), "the card joins add-ons with a comma and space");

console.log(`✓ facility-addons-forms.spec.js — ${n} assertions passed`);
