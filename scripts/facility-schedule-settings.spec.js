// facility-schedule-settings.spec.js — Douglas County's reporting sync (2026-09-23).
//
// Three per-org settings on the Facility Rental Schedule (REPORT_SETTINGS_SCHEMA
// .facility): multi-day rentals shown every day or as arrivals + departures only,
// rows ordered by start time or by site number, and the posting sheet's QR code.
//
// The row logic is LIFTED AND RUN out of public/facility.html, because every
// defect here is a comparison (which day is a middle day, which row of a stay
// that spans the window survives) and a regex passes on an inverted one.
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0; const failures = [];
const ok = (c, m) => { c ? pass++ : failures.push(m); };
const eq = (g, w, m) => ok(JSON.stringify(g) === JSON.stringify(w), m + " — got " + JSON.stringify(g) + ", want " + JSON.stringify(w));

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "public", "facility.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const permitSrc = fs.readFileSync(path.join(root, "lib", "permit.js"), "utf8");

// ── lift the helpers ────────────────────────────────────────────────────────
const a = page.indexOf("function scheduleSettings()");
const b = page.indexOf("function formatMoney(v)");
ok(a > 0 && b > a, "found the schedule helpers in facility.html");
let H = {};
try {
  H = new Function("window", page.slice(a, b)
    + "\nreturn { scheduleSettings, stayRole, scheduleEndpointRows, siteCompare };")(
    { ORG_CONFIG: { settings: {} } });
} catch (e) { failures.push("lifting the schedule helpers THREW: " + e.message); }
const guard = (fn, ...args) => { try { return fn(...args); } catch (e) { failures.push("threw: " + e.message); return undefined; } };

if (H.stayRole) {
  eq(guard(H.stayRole, {}), "single", "a booking with no multi-day fields is single");
  eq(guard(H.stayRole, { multiDayDays: "4", multiDayNum: "1" }), "arrival", "day 1 is the arrival");
  eq(guard(H.stayRole, { multiDayDays: "4", multiDayNum: "4" }), "departure", "the last day (the checkout day the card emits) is the departure");
  eq(guard(H.stayRole, { multiDayDays: "4", multiDayNum: "2" }), "middle", "day 2 of 4 is a middle day");
  eq(guard(H.stayRole, { multiDayDays: "2", multiDayNum: "2" }), "departure", "a one-night stay has no middle day");
}

if (H.scheduleEndpointRows) {
  const stay = (resId, site, days, from, to) => {
    const out = [];
    for (let n = from; n <= to; n++) out.push({ resId, site, multiDayDays: String(days), multiDayNum: String(n), date: "2026-09-" + String(10 + n).padStart(2, "0") });
    return out;
  };
  // Gail: a 4-day stay fully in view → arrival + departure, middles dropped.
  const gail = stay("gail", "Site 12", 4, 1, 4);
  let out = guard(H.scheduleEndpointRows, gail) || [];
  eq(out.map(r => r.multiDayNum), ["1", "4"], "a stay in view keeps its arrival and departure rows only");

  // A stay that arrived before the window and leaves after it: only middle days
  // are in view. It must NOT vanish — the site is occupied.
  const through = stay("long", "Site 30", 10, 3, 6);
  out = guard(H.scheduleEndpointRows, through) || [];
  eq(out.length, 1, "a stay spanning the whole window keeps exactly one row, or an occupied site reads empty");
  ok(out[0] && out[0].multiDayNum === "3" && out[0]._midStay === true,
     "…the FIRST row in view, marked _midStay");
  ok(!("_midStay" in through[0]), "and the source row is not mutated");

  // Arrived before the window, departs inside it: the departure row alone.
  out = guard(H.scheduleEndpointRows, stay("dep", "Site 3", 5, 3, 5)) || [];
  eq(out.map(r => r.multiDayNum), ["5"], "a stay leaving inside the window shows its departure, not a mid-stay row");

  // Single-day rentals pass through untouched.
  out = guard(H.scheduleEndpointRows, [{ resId: "x", site: "Pavilion", date: "2026-09-12" }]) || [];
  eq(out.length, 1, "single-day bookings are untouched");

  // Two sites on one reservation are two stays.
  out = guard(H.scheduleEndpointRows, stay("pair", "Site 1", 3, 1, 3).concat(stay("pair", "Site 2", 3, 2, 2))) || [];
  eq(out.map(r => r.site + ":" + r.multiDayNum), ["Site 1:1", "Site 1:3", "Site 2:2"],
     "the key is reservation AND site — one booking holding two sites keeps each site's own rows");
}

if (H.siteCompare) {
  const sites = ["Site 20", "Site 15", "Site 9", "Site 33", "Site 1"];
  eq(sites.slice().sort(H.siteCompare), ["Site 1", "Site 9", "Site 15", "Site 20", "Site 33"],
     "site order is NATURAL — Site 9 before Site 15, which a string sort gets wrong");
}

if (H.scheduleSettings) {
  eq(guard(H.scheduleSettings), { multiDayDisplay: "every", siteOrder: "time", permitQr: true },
     "an unconfigured org renders exactly as the report always has");
}

// ── the page wiring ─────────────────────────────────────────────────────────
const fr = page.slice(page.indexOf("const filteredRows = useMemo"), page.indexOf("const grouped = useMemo"));
ok(fr.length > 100, "found the filteredRows memo");
ok(/multiDayDisplay === 'endpoints'\) result = scheduleEndpointRows\(result\)/.test(fr),
   "filteredRows applies the endpoints filter — every downstream reader (count, Excel, PDF, permits) goes through it");
ok(fr.indexOf("scheduleEndpointRows") > fr.indexOf("muscoLit"),
   "…LAST, so a stay's endpoints are asked of the rows that survived every other filter");
const gr = page.slice(page.indexOf("const grouped = useMemo"), page.indexOf("const sortedDates"));
ok(/siteOrder === 'site'[\s\S]*siteCompare\(a\.site, b\.site\)/.test(gr), "the site-number sort is applied in grouped");
ok(/dayNum: r\.multiDayNum/.test(page), "the permit payload carries the row's place in the stay");
const cnt = page.slice(page.indexOf("function permitSheetCount"), page.indexOf("function exportPermits"));
ok(/arrivalOnly && parseInt\(r\.multiDayNum, 10\) > 1\) continue/.test(cnt),
   "the Export Permits count mirrors the server's arrival-only rule, or the button promises sheets it will not print");
ok(/<ScheduleSettings \/>\s*<\/div>/.test(page), "the settings gear is the LAST item in the toolbar");
ok(/href="\/report-settings\.css"/.test(page), "the page loads the shared settings sheet CSS");

// ── the server ──────────────────────────────────────────────────────────────
const schema = server.slice(server.indexOf("const REPORT_SETTINGS_SCHEMA = {"));
ok(/multiDayDisplay:\s*\{ kind: "enum", values: \["every", "endpoints"\], def: "every" \}/.test(schema),
   "multiDayDisplay defaults to every day — no other org's schedule changes");
ok(/siteOrder:\s*\{ kind: "enum", values: \["time", "site"\], def: "time" \}/.test(schema), "siteOrder defaults to start time");
ok(/permitQr:\s*\{ kind: "bool", def: true \}/.test(schema), "the QR code stays ON by default — other orgs want it");
const seeds = server.slice(server.indexOf("const REPORT_SETTINGS_SEEDS = {"), server.indexOf("function seedReportSettings"));
ok(/"douglas-county-nv"[\s\S]*multiDayDisplay: "endpoints", siteOrder: "site", permitQr: false/.test(seeds),
   "Douglas County is seeded to arrivals/departures, site order and no QR");
const route = server.slice(server.indexOf('app.get("/:org/facility", (req, res)'), server.indexOf('app.get("/:org/facilities", (req, res)'));
ok(/settings: reportSettings\(slug, "facility"\)/.test(route), "the rental schedule route injects the facility settings");
const pdf = server.slice(server.indexOf('app.post("/:org/facility/permits.pdf"'), server.indexOf("// ── GET /:org/gl/tyler"));
ok(/arrivalOnly && Number\(r\.dayNum\) > 1\) continue/.test(pdf), "permits.pdf prints on arrival only in endpoints mode");
ok(/fset\.permitQr === false \? null/.test(pdf), "permits.pdf skips the QR when the org switched it off");

// ── the sheet ───────────────────────────────────────────────────────────────
const permit = require(path.join(root, "lib", "permit.js"));
const base = { org: "Douglas County", dept: "Parks", title: "Campsite", site: "Site 12", date: "2026-09-12", begin: "1:00pm", end: "11:00am" };
const withQr = permit.toHtml([Object.assign({ qr: "data:image/png;base64,AAAA" }, base)]);
const noQr = permit.toHtml([Object.assign({ qr: null }, base)]);
ok(/class="qrbox"/.test(withQr) && /SCAN TO VERIFY/.test(withQr), "a sheet with a QR renders the code");
ok(!/class="qrbox"/.test(noQr) && !/SCAN TO VERIFY/.test(noQr) && !/<img src="null"/.test(noQr),
   "a sheet without one renders no code box at all — not an empty frame or a broken image");
ok(/Site 12/.test(noQr), "…and still carries the site");

// ── the campground address ──────────────────────────────────────────────────
const seedsJson = fs.readFileSync(path.join(root, "campmap-seeds.json"), "utf8");
ok(/3700 Topaz Park Rd/.test(seedsJson) && !/3800 Topaz Park Rd/.test(seedsJson),
   "Topaz Lake's map address is 3700 Topaz Park Rd (Douglas County, 2026-09-23)");

if (failures.length) {
  console.log("✗ facility-schedule-settings.spec.js — " + failures.length + " failure(s):");
  failures.forEach(f => console.log("  ✗ " + f));
  console.log(pass + " passed, " + failures.length + " failed.");
  process.exit(1);
}
console.log("✓ facility-schedule-settings.spec.js — " + pass + " assertions passed.");
