#!/usr/bin/env node
/**
 * CI guard: the report pages must actually RENDER in a browser.
 *
 * Why this exists — two blank-page incidents on 2026-08-22/23, both mine:
 *
 *   A derived value was computed in an IIFE that referenced a `const` declared
 *   further down the same function. In source that is a temporal dead zone, but
 *   Babel compiles `const` to `var`, so it did not throw a tidy
 *   ReferenceError — the identifier was simply `undefined`, and
 *
 *       TypeError: Cannot read properties of undefined (reading 'map')
 *
 *   took the whole React tree down. The page served HTTP 200 with a complete
 *   HTML document and rendered a blank white area under the banner.
 *
 * Nothing already in CI could see it, and this is the important part:
 *   - `node --check` passes: the file is syntactically valid.
 *   - `ci-check-html.js` passes: the block PARSES; it just throws when run.
 *   - `ci-boot-check.js` passes: the server boots and serves the page happily.
 *   - `ci-check-admin-js.js` passes: it checks the ADMIN page, not these.
 *   - every spec passes: none of them mount a component.
 *
 * A page can only be proven to render by rendering it. So: boot the server,
 * drive a real Chromium at each page, and fail on any uncaught exception or a
 * page that comes up empty.
 *
 * Hermetic. Every `/api/` request is intercepted and answered from the fixtures
 * below, so this never touches Metabase, never varies with live data, and cannot
 * fail because a card is slow. METABASE_URL points at a dead port as well.
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const PORT = 3989;
const BOOT_DEADLINE_MS = 45000;
const PAGE_TIMEOUT_MS = 45000;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-check-"));

// ── Fixtures ────────────────────────────────────────────────────────────────
// Column names copied from a real facility feed. Two campsites, one of them a
// multi-night stay with an add-on, spanning a weekend and a weekday so the
// day-of-week and stay-length derivations all have something to chew on.
function campsiteRows() {
  const rows = [];
  const push = (site, date, dayNum, totDays, addOns, total) => rows.push({
    "Org Name": "Test Parks", "Reservation ID": site + "-" + date, "Date": date,
    "Day": "Friday", "Begin": "01:00pm", "End": null,
    "Location": "Topaz Lake Recreation Area", "Facility": "Topaz Lake Recreation Area - " + site,
    "Site Type": "campsite", "Purpose": "Camping", "Head Cnt": 4,
    "Reservee": "Test Camper", "Email": "t@example.com", "Phone": null, "Resident?": "Yes",
    "Booking Type": "Managed", "Instructions": null, "Notes": null,
    "Add Ons": addOns, "Add-On Fees": addOns ? 10 : 0, "Total": total, "Paid?": "Paid",
    "Multi-Day Days": totDays, "Multi-Day Day#": dayNum,
    "Lighting": null, "Lit From": null, "Lit Until": null, "Lighting Sync": null,
  });
  // A 3-night stay and a 1-nighter, on dates in the past so the trend arrows
  // have settled days to work with.
  const d = n => { const t = new Date(Date.now() - n * 86400000); return t.toISOString().slice(0, 10); };
  push("Site 01", d(30), 1, 3, "Topaz Holiday Surcharge ($10.00)", 90);
  push("Site 01", d(29), 2, 3, "Topaz Holiday Surcharge ($10.00)", 0);
  push("Site 01", d(28), 3, 3, "Topaz Holiday Surcharge ($10.00)", 0);
  push("Site 02", d(3), 1, 1, "", 45);
  push("Site 02", d(20), 1, 2, "Firewood ($10.00)", 60);
  push("Site 02", d(19), 2, 2, "Firewood ($10.00)", 0);
  return rows;
}

// Outdoor event spaces — the Outdoor Events tab's fixture. Shaped to exercise
// the three things that tab gets wrong if the hour math regresses:
//   · two same-day bookings that OVERLAP at 10am (10a–2p and 8a–12p), so the
//     peak hour is 10am by coverage and 8am if only start times are counted;
//   · a multi-day booking carrying Begin on day 1 and End on day 2, which must
//     be excluded from every hour figure (4 timed bookings, not 5);
//   · an add-on, a head count, and two locations, so the panels have content.
function outdoorRows() {
  const rows = [];
  const push = (site, type, loc, date, begin, endT, dayNum, totDays, addOns, total, head) => rows.push({
    "Org Name": "Test Parks", "Reservation ID": site + "-" + date, "Date": date,
    "Day": "Saturday", "Begin": begin, "End": endT,
    "Location": loc, "Facility": loc + " - " + site,
    "Site Type": type, "Purpose": "Birthday party", "Head Cnt": head,
    "Reservee": "Test Renter", "Email": "t@example.com", "Phone": null, "Resident?": "Yes",
    "Booking Type": "Managed", "Instructions": null, "Notes": null,
    "Add Ons": addOns, "Add-On Fees": addOns ? 25 : 0, "Total": total, "Paid?": "Paid",
    "Multi-Day Days": totDays, "Multi-Day Day#": dayNum,
    "Lighting": null, "Lit From": null, "Lit Until": null, "Lighting Sync": null,
  });
  const d = n => { const t = new Date(Date.now() - n * 86400000); return t.toISOString().slice(0, 10); };
  push("Oak Pavilion",  "outdoor-event-space", "Riverside Park", d(21), "10:00am", "02:00pm", 1, 1, "Alcohol Permit ($25.00)", 120, 60);
  push("Oak Pavilion",  "outdoor-event-space", "Riverside Park", d(14), "08:00am", "12:00pm", 1, 1, "", 120, 40);
  push("Elm Shelter",   "outdoor-event-space", "Riverside Park", d(10), "09:00am", "05:00pm", 1, 1, "Alcohol Permit ($25.00)", 200, 90);
  push("Picnic Area 3", "picnic-table",        "Lakeview Park",  d(7),  "11:00am", "01:00pm", 1, 1, "", 45, 12);
  // Multi-day: hours are unknowable per day, so this must not reach the grid.
  push("Big Field Tent", "bounce-house",       "Lakeview Park",  d(5),  "08:00am", null,     1, 2, "", 300, 150);
  push("Big Field Tent", "bounce-house",       "Lakeview Park",  d(4),  null,      "06:00pm", 2, 2, "", 0, 150);
  return rows;
}

// Racket-sport courts — the Court Utilization payload shape (snake_case), used
// by the Racket Sports tab. Court names carry a racket keyword so isRacketCourt()
// matches them and the tab does not fall back to "all court-type sites".
function racketRows() {
  const rows = [];
  const d = n => { const t = new Date(Date.now() - n * 86400000); return t.toISOString().slice(0, 10); };
  const push = (court, loc, day, start, end, hours, cat) => rows.push({
    court_name: court, location_name: loc, facility_rental_id: court + "-" + day + "-" + start,
    usage_category: cat || "Customer Booking", booking_source: "Instant",
    local_date: d(day), local_start: start, local_end: end, duration_hours: hours,
  });
  push("Tennis Court 1", "Riverside Park", 12, "09:00", "10:30", 1.5);
  push("Tennis Court 1", "Riverside Park", 9,  "18:00", "19:00", 1);
  push("Pickleball Court 2", "Riverside Park", 8, "10:00", "11:00", 1);
  push("Pickleball Court 2", "Riverside Park", 5, "17:00", "19:00", 2, "Program");
  push("Padel Court A", "Lakeview Park", 4, "12:00", "13:00", 1);
  return rows;
}

const campsitesGeo = {
  locations: [{
    id: "topaz", name: "Topaz Lake Recreation Area",
    center: { lat: 38.6956, lng: -119.5198 },
    sites: [
      { id: "s1", name: "Site 01", area: "Main", lat: 38.6957, lng: -119.5199, capacity: 6 },
      { id: "s2", name: "Site 02", area: "Main", lat: 38.6958, lng: -119.5200, capacity: 4 },
    ],
    markers: [],
  }],
};

// The campmap availability feed: { data: { siteId: { checkInDates: {...} } } }.
// Keyed by CHECK-IN date and carrying the allowed checkout window, same as
// rec.us — a flat "available" map would let the stay reducer pass while the
// window logic went unexercised. siteIds come off the query string so the reply
// covers exactly the sites the page asked about.
function availabilityFor(url) {
  const m = /siteIds=([^&]*)/.exec(url);
  const ids = m ? decodeURIComponent(m[1]).split(",").filter(Boolean) : [];
  const day = n => { const t = new Date(Date.now() + n * 86400000); return t.toISOString().slice(0, 10); };
  const data = {};
  ids.forEach((id, i) => {
    const checkInDates = {};
    for (let n = 0; n < 30; n++) {
      // A deterministic mix so every branch is hit: free nights, a real booking
      // conflict, and a stay-rule block that must NOT read as booked.
      const slot = (i + n) % 7;
      if (slot === 3) checkInDates[day(n)] = { available: false, reason: "conflict" };
      else if (slot === 5) checkInDates[day(n)] = { available: false, reason: "minimum-stay" };
      else checkInDates[day(n)] = { available: true, earliestCheckout: day(n + 1), latestCheckout: day(n + 4) };
    }
    data[id] = { checkInDates };
  });
  return { data };
}

// The campmap's live site feed. Ids come from the campmap seed so the overlay
// actually matches (loadSites() discards a reply that matches nothing), and each
// site is given one of rec.us's real sub_type values — the field the Campsite
// Type filter is built from. Deliberately DIFFERENT from the seed's own `kind`,
// so the check proves Rec's value wins over the seed's guess rather than merely
// that some options rendered.
const SUB_TYPES = ["tent", "rv", "tent-and-rv"];
function campmapSites(org) {
  const seeds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "campmap-seeds.json"), "utf8"));
  const sites = ((seeds[org] || {}).sites || []);
  return sites.map((x, i) => ({
    id: x.id, name: x.name, courtNumber: x.name, type: "campsite",
    capacity: 6, locationId: "loc", locationName: (seeds[org] || {}).locationName || "Campground",
    bookingUrl: "https://www.rec.us/sites/" + x.id, description: "",
    imageUrl: null, gallery: [], priceCents: 2500, residentPriceCents: 2000,
    durationMinutes: null, pricingType: "perNight", bookingUnit: "nightly",
    subType: SUB_TYPES[i % SUB_TYPES.length], amenities: [],
  }));
}

// Anything under /api/ that a page fetches. `match` is tested against the path.
// ── Fast Track fixture ──────────────────────────────────────────────────────
// Smyrna's Concert Series, which is what exposed the bug: four birthday-concert
// tables opening over the next few days with 114 fast-trackers between them, in
// the SAME program as two summer concerts that already happened. The old
// "Launching Soon" test asked whether EVERY section in the program was still in
// the future, so this program — the one with 120 people waiting — was excluded,
// while a program with 3 fast-trackers opening in 29 days was featured.
//
// The dates are deliberately date-only strings (the card emits ::date) so the
// off-by-one is exercised too: new Date('2026-10-03') is UTC midnight, which a
// US browser renders as Oct 2.
function fasttrackRows() {
  const iso = d => new Date(Date.now() + d * 86400000).toISOString();
  const table = (name, ft, pending, cap, opensInDays) => ({
    "Row Type": "section", "Season": "Fall", "Program": "Concert Series", "Section": name,
    "Reg Mode": "per-section", "Section ID": "sec-" + name.replace(/\W+/g, "-").toLowerCase(),
    "Org ID": "org-1", "Program ID": "prog-concert",
    "FT Total": ft, "FT Converted": 0, "FT Pending": pending, "FT Dropped": 0, "FT Families": pending,
    "Conversion %": 0, "Direct Enrolled": 0, "Total Enrolled": 0,
    "Capacity": cap, "Sessions": 1, "Fill %": 0, "Demand %": Math.round(ft / cap * 1000) / 10,
    "Waitlisted": 0, "Publish Date": iso(-30),
    // Two windows, as Smyrna really has them: a group/early-access window that
    // opens first, and a general window a week later. The page used to read only
    // the general one and announce "Reg opens Aug 31" for a section whose first
    // families could register the next morning.
    "Early Access Opens": iso(opensInDays), "Reg Opens": iso(opensInDays + 7), "Reg Closes": iso(45),
    "Reg Status": "pipeline",
    "Section Start": "2026-10-03", "Section End": "2026-10-03",
    "Section Day": "Sat", "Section Time": "05:00pm\u201310:00pm",
    "FT Revenue": 0, "Section Price": 25, "Left on Table": 0, "Over Demand $": 0,
  });
  const past = (name, ft, conv) => Object.assign(table(name, ft, 0, 100, -60), {
    "Early Access Opens": null, "Reg Opens": iso(-90), "Reg Closes": iso(-70), "Reg Status": "closed",
    "FT Converted": conv, "FT Pending": 0, "Conversion %": 71.4,
    "Section Start": "2026-07-11", "Section End": "2026-07-11",
  });
  // The cold end of the heat scale: Smyrna's Girls Night Out — 3 fast-trackers
  // against 400 spots, opening in 29 days. It used to get the same flame
  // treatment as the concert; it must now render banked and silent.
  const cold = Object.assign(table("Girls Night Out", 3, 3, 400, 29), {
    "Program": "Girls Night Out", "Program ID": "prog-gno",
    "Section ID": "sec-girls-night-out", "FT Families": 3,
    "Demand %": 0.8,
  });
  return [
    table("Premier Table", 54, 54, 25, 1),
    table("Select Table", 18, 18, 45, 2),
    table("Preferred Table", 21, 21, 30, 3),
    table("General Table", 21, 21, 50, 4),
    past("Summer Concert: Yacht Rock Schooner", 14, 10),
    past("Summer Concert: Guardian of the Jukebox", 8, 6),
    cold,
  ];
}

const STUBS = [
  { match: /\/facilities\/api\/campsites/, body: () => campsitesGeo },
  // One feed, both tabs: Camping filters it to campsite rows and Outdoor Events
  // to its three types, so each tab has to do its own scoping.
  { match: /\/facility\/api\/data/,        body: () => ({ rows: campsiteRows().concat(outdoorRows()), meta: {} }) },
  { match: /\/api\/permits/,               body: () => ({ permits: {} }) },
  { match: /\/api\/availability-batch/,     body: url => availabilityFor(url) },
  { match: /\/rentalcalendar\/api\/sites/, body: (url, org) => ({ sites: campmapSites(org) }) },
  { match: /\/api\/sites/,                  body: () => ({ sites: [] }) },
  { match: /\/fasttrack\/api\/data/,       body: () => ({ rows: fasttrackRows(), meta: {} }) },
  { match: /\/court-utilization\/api\/data/, body: () => ({ rows: racketRows(), meta: {} }) },
  { match: /\/api\/data/,                   body: () => ({ rows: campsiteRows(), meta: {} }) },
  { match: /\/api\/pulse/,                  body: () => ({ items: [], generated: null }) },
  { match: /\/api\/goals/,                  body: () => ({}) },
  { match: /\/api\/views/,                  body: () => ({ views: [] }) },
  { match: /\/api\//,                       body: () => ({ ok: true, rows: [] }) },
];

// ── Off-host assets (React, Babel, Leaflet, xlsx) ───────────────────────────
// Every report page loads React and compiles JSX in the browser via
// babel-standalone from cdnjs. If those scripts do not arrive, EVERY page comes
// up blank — which looks exactly like the bug this check exists to catch, so a
// network hiccup would read as a code defect (and a blocked egress makes the
// check useless rather than red). So: no request leaves the browser. Off-host
// assets are served out of a local cache, fetched once with curl (which honours
// the proxy env) and reused on every later run.
const VENDOR_DIR = path.join(__dirname, "..", "node_modules", ".cache", "render-check");
const vendorMisses = [];

function vendorPath(url) {
  return path.join(VENDOR_DIR, url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "_"));
}

function vendorFetch(url) {
  const dest = vendorPath(url);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const r = require("child_process").spawnSync("curl",
    ["-sSfL", "--max-time", "60", "-o", dest + ".part", url], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(dest + ".part") || fs.statSync(dest + ".part").size === 0) {
    try { fs.rmSync(dest + ".part", { force: true }); } catch (_) {}
    return null;
  }
  fs.renameSync(dest + ".part", dest);
  return dest;
}

const CTYPE = { js: "application/javascript", css: "text/css", json: "application/json",
                png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", woff2: "font/woff2" };

function serveVendored(req) {
  const url = req.url();
  const ext = (url.split("?")[0].match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
  // Only code matters for rendering; images and fonts can be blanked safely.
  // Some pages load these with `crossorigin`, so the reply needs CORS headers or
  // the browser rejects the script before it runs.
  const cors = { "access-control-allow-origin": "*" };
  if (!/^(js|css|json)$/.test(ext)) {
    return req.respond({ status: 200, contentType: "text/plain", headers: cors, body: "" });
  }
  const file = vendorFetch(url);
  if (!file) {
    vendorMisses.push(url);
    return req.respond({ status: 502, contentType: "text/plain", headers: cors, body: "" });
  }
  return req.respond({ status: 200, contentType: CTYPE[ext] || "application/octet-stream",
                       headers: cors, body: fs.readFileSync(file) });
}

// ── Pages to prove ──────────────────────────────────────────────────────────
// `needs` is a selector that only exists once the page has really rendered, so
// a blank page fails instead of passing on "no errors thrown".
const CASES = [
  { name: "facilities · camping",  path: "/{org}/facilities?tab=camping", needs: ".camp-cal .cc-hd" },
  { name: "facilities · summary",  path: "/{org}/facilities?tab=summary", needs: ".sum-cards, .aqua-sec, .fac-banner" },
  { name: "org landing",           path: "/{org}",                        needs: ".card" },
  { name: "gl report",             path: "/{org}/gl",                     needs: ".toolbar" },
  // The public campground map. No token on purpose — this is the one view a
  // camper reaches, so a blank page here is the most costly of the lot.
  // `#departPick[max]` rather than the input itself: the element is in the static
  // HTML, but its `max` is written only inside setStay(), from rec.us's own
  // latestCheckout. So this fails if the stay logic throws, which a selector for
  // the markup would not. (The night strip this used to assert on is gone — the
  // date fields replaced it.)
  // Launching Soon must feature the program whose sections open in the next few
  // days, even though the same program also has sections that already ran.
  // `[data-launch-section]` exists only if that program reached the bucket AND
  // the card named its launching sections, so the old program-level test fails
  // this case rather than passing on "nothing threw".
  { name: "fasttrack · launching soon", path: "/{org}/fasttrack",         needs: "[data-launch-section]" },
  // ...and go-live must come from the EARLY-ACCESS window when that is the one
  // that opens first. Reading only "Reg Opens" yields data-golive="general",
  // which is how the report came to say "opens in 8 days" about a section going
  // live the next morning.
  { name: "fasttrack · early access",   path: "/{org}/fasttrack",         needs: "[data-golive=\"early\"]" },
  // Both ends of the heat scale in one render: the concert (76% of capacity,
  // opening tomorrow) must be inferno, and Girls Night Out (3 of 400 spots, 29
  // days out) must be banked. The old clock-only ladder gave the second one an
  // amber rail and a flame, which is what made the panel unreadable.
  { name: "fasttrack · heat: inferno",  path: "/{org}/fasttrack",         needs: "[data-heat=\"inferno\"]" },
  { name: "fasttrack · heat: banked",   path: "/{org}/fasttrack",         needs: "[data-heat=\"banked\"]" },
  // Outdoor Event Spaces. Three cases, because "the tab rendered" is the weakest
  // claim available: the peak hour must come from hour COVERAGE — the fixture's
  // four bookings each start in a different hour and overlap at 11am, so
  // start-times-only reports 8a instead of 11a — and the timed count must exclude
  // the multi-day booking (5 instead of 4 if it leaks in).
  { name: "facilities · outdoor events",   path: "/{org}/facilities?tab=outdoor", needs: "[data-oe-heat]" },
  { name: "facilities · outdoor peak hour", path: "/{org}/facilities?tab=outdoor", needs: "[data-oe-peak=\"11a\"]" },
  { name: "facilities · outdoor multi-day", path: "/{org}/facilities?tab=outdoor", needs: "[data-oe-timed=\"4\"]" },
  // Racket Sports had no render coverage at all, which is how its duplicate
  // header went unnoticed. `.court-native .sum-cards` only exists once the
  // Court Utilization pipeline ran inside the tab, so an empty state or a throw
  // fails this rather than passing on "nothing rendered".
  { name: "facilities · racket sports",    path: "/{org}/facilities?tab=racket",  needs: ".court-native .sum-cards" },
  { name: "campmap · stay search", path: "/{org}/campmap",                needs: "#departPick[max]" },
  // The Campsite Type filter. `option[value="tent-and-rv"]` is only there if the
  // LIVE site feed landed and buildTypeFilter() re-ran off its subType — the
  // seed's own kinds are electric/primitive — so this covers the overlay path as
  // well as the control rendering at all. It is the code path being covered: the
  // real Rec feed omits subType, so in production the options come from the seed.
  { name: "campmap · type filter", path: "/{org}/campmap",                needs: "#typePick option[value=\"tent-and-rv\"]" },
];

const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
         METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
         DASHBOARD_PASSWORD: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", d => { out += d; });
child.stderr.on("data", d => { out += d; });
let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal }; });

function stop(ok, why, detail) {
  try { child.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  if (ok) { console.log("✓ " + why); process.exit(0); }
  console.error("✗ " + why);
  if (detail) console.error("\n" + detail);
  process.exit(1);
}

function waitForServer(started) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (exited) return reject(new Error(`server exited (code ${exited.code})`));
      if (/\[uncaught\]/.test(out)) return reject(new Error("server logged an uncaught exception"));
      if (Date.now() - started > BOOT_DEADLINE_MS) return reject(new Error("server did not boot in time"));
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, res => { res.resume(); resolve(); });
      req.on("error", () => setTimeout(tick, 400));
      req.on("timeout", () => { req.destroy(); setTimeout(tick, 400); });
    };
    tick();
  });
}

(async () => {
  try { await waitForServer(Date.now()); }
  catch (e) { return stop(false, e.message, out.split("\n").slice(-25).join("\n")); }

  let puppeteer;
  try { puppeteer = require("puppeteer"); }
  catch (_) { return stop(false, "puppeteer is not installed — run npm install"); }

  // A browser binary, without downloading one. CI installs puppeteer with
  // PUPPETEER_SKIP_DOWNLOAD (server.js only needs it lazily, for PDFs), so
  // puppeteer's own Chrome is usually absent — but the runner and this sandbox
  // both already ship one. Deliberately NOT a skip if none is found: a check
  // that can quietly opt out of running is the failure mode this exists to stop.
  const chrome = (() => {
    const tried = [];
    const ok = p_ => { if (!p_) return false; tried.push(p_); return fs.existsSync(p_); };
    if (ok(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    let bundled = null;
    try { bundled = puppeteer.executablePath(); } catch (_) {}
    if (ok(bundled)) return bundled;
    for (const c of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
                     "/usr/bin/chromium", "/usr/bin/chromium-browser",
                     "/opt/pw-browsers/chromium", "/snap/bin/chromium"]) {
      if (ok(c)) return c;
    }
    for (const dir of ["/opt/pw-browsers"]) {
      let kids = [];
      try { kids = fs.readdirSync(dir); } catch (_) {}
      for (const k of kids) {
        const c = path.join(dir, k, "chrome-linux", "chrome");
        if (ok(c)) return c;
      }
    }
    stop(false, "no browser to render with — set CHROME_PATH or run: npx puppeteer browsers install chrome",
      "looked at:\n" + tried.map(t => "  " + t).join("\n"));
    return null;
  })();

  // First org with a token, so the pages are reachable and campsite-seeded.
  let org = null;
  try {
    const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const seeds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "campmap-seeds.json"), "utf8"));
    const i = src.indexOf("const ORGS = {");
    const j = src.indexOf("\nconst REPORT_TYPES", i);
    const ORGS = require("vm").runInNewContext("(" + src.slice(src.indexOf("{", i), j).trim().replace(/;$/, "") + ")");
    org = Object.keys(seeds).find(s => ORGS[s] && ORGS[s].token) || Object.keys(ORGS).find(s => ORGS[s].token);
    var token = ORGS[org].token;
  } catch (e) { return stop(false, "could not resolve a test org: " + e.message); }

  const browser = await puppeteer.launch({ headless: true, executablePath: chrome,
                                           args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const failures = [];

  for (const c of CASES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    const errs = [];
    page.on("pageerror", e => errs.push(String(e.message).split("\n")[0].slice(0, 200)));
    page.on("console", m => {
      if (m.type() !== "error") return;
      const t = m.text();
      // Network noise from the dead Metabase port is expected and not a defect.
      if (/ERR_|Failed to load resource|net::/.test(t)) return;
      errs.push("console: " + t.slice(0, 200));
    });
    await page.setRequestInterception(true);
    page.on("request", async req => {
      const u = req.url();
      if (u.includes("/api/")) {
        const stub = STUBS.find(s => s.match.test(u));
        return req.respond({ status: 200, contentType: "application/json",
                             body: JSON.stringify(stub ? stub.body(u, org) : { ok: true }) });
      }
      if (!u.startsWith(`http://127.0.0.1:${PORT}`)) return serveVendored(req);
      req.continue();
    });

    const url = `http://127.0.0.1:${PORT}` + c.path.replace("{org}", org)
      + (c.path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    let found = false, bodyLen = 0;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      try { await page.waitForSelector(c.needs, { timeout: PAGE_TIMEOUT_MS }); found = true; } catch (_) {}
      bodyLen = await page.evaluate(() => document.body.innerText.trim().length);
    } catch (e) {
      errs.push("navigation: " + e.message.split("\n")[0].slice(0, 160));
    }
    await page.close();

    if (errs.length) failures.push(`${c.name}: ${errs.length} uncaught error(s)\n      ` + errs.slice(0, 3).join("\n      "));
    else if (!found) failures.push(`${c.name}: rendered no "${c.needs}" (body text ${bodyLen} chars) — the page came up blank`);
    else console.log(`  ✓ ${c.name}`);
  }

  await browser.close();
  if (vendorMisses.length) {
    return stop(false, "could not fetch the pages' own libraries — this check proves nothing without them",
      [...new Set(vendorMisses)].map(u => "  " + u).join("\n"));
  }
  if (failures.length) {
    return stop(false, `${failures.length} of ${CASES.length} page(s) did not render`,
      failures.map((f, i) => `  ${i + 1}. ${f}`).join("\n"));
  }
  stop(true, `${CASES.length} page(s) render with no uncaught errors`);
})();
