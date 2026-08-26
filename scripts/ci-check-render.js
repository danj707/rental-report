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

// Ball fields — the Fields tab's fixture. Built to the shape the platform
// actually has: staff-booked (only one instant), evening league blocks, a light
// fee as the top add-on, and one field named for no sport at all.
function fieldRows() {
  const rows = [];
  const d = n => { const t = new Date(Date.now() - n * 86400000); return t.toISOString().slice(0, 10); };
  const push = (site, loc, day, begin, endT, total, addOns, bookingType, head) => rows.push({
    "Org Name": "Test Parks", "Reservation ID": site + "-" + day + "-" + begin, "Date": d(day),
    "Day": "Tuesday", "Begin": begin, "End": endT,
    "Location": loc, "Facility": loc + " - " + site,
    "Site Type": "field", "Purpose": "League practice", "Head Cnt": head,
    "Reservee": "Test League", "Email": "t@example.com", "Phone": null, "Resident?": "Yes",
    "Booking Type": bookingType || "Managed", "Instructions": null, "Notes": null,
    "Add Ons": addOns, "Add-On Fees": addOns ? 45 : 0, "Total": total, "Paid?": "Paid",
    "Multi-Day Days": 1, "Multi-Day Day#": 1,
    "Lighting": null, "Lit From": null, "Lit Until": null, "Lighting Sync": null,
  });
  // Evening league blocks on the diamonds — 6-9pm, overlapping at 7pm.
  push("Diamond 1", "Riverside Sports Complex", 14, "06:00pm", "09:00pm", 180, "Field Light Fee ($45.00)", "Managed", 24);
  push("Diamond 1", "Riverside Sports Complex", 7,  "06:00pm", "09:00pm", 180, "Field Light Fee ($45.00)", "Managed", 22);
  push("Diamond 2", "Riverside Sports Complex", 14, "05:00pm", "08:00pm", 180, "Field Light Fee ($45.00), Field Prep & Lining ($30.00)", "Managed", 18);
  push("Soccer Field 3", "Riverside Sports Complex", 10, "07:00pm", "09:00pm", 120, "", "Managed", 30);
  push("Soccer Field 4", "Riverside Sports Complex", 10, "07:00pm", "09:00pm", 120, "", "Managed", 28);
  // A tournament day: the 8h+ tail.
  push("Diamond 1", "Riverside Sports Complex", 21, "08:00am", "07:00pm", 600, "Rental-Facility Attendant Fee ($120.00)", "Managed", 150);
  // The one instant booking, and a field whose name says nothing about a sport.
  push("Upper Field", "Northside Park", 4, "10:00am", "12:00pm", 60, "", "Instant", 12);
  push("Upper Field", "Northside Park", 3, "04:00pm", "06:00pm", 60, "", "Managed", 14);
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

// The campmap availability feed: { data: { siteId: { checkInDates: {...} } } },
// plus the per-site `sources` map that says WHICH feed answered.
// Keyed by CHECK-IN date and carrying the allowed checkout window, same as
// rec.us — a flat "available" map would let the stay reducer pass while the
// window logic went unexercised. siteIds come off the query string so the reply
// covers exactly the sites the page asked about.
//
// Shaped like the real 210-day nightly feed since 2026-08-24, which means it has
// to carry the thing that only exists out there: a TRAILING RUN of
// `outside-window` marking where each site's booking window ends. Site 0 stops
// at day 120, and every later site stops earlier, so the page's "furthest site
// in view" bound has something to actually choose between — a fixture where
// every site agreed would pass just as well on a park-wide floor.
const CAMPMAP_FEED_DAYS = 210;
const CAMPMAP_HORIZON_DAYS = 120;     // site 0's window; asserted by the render case
function availabilityFor(url) {
  const m = /siteIds=([^&]*)/.exec(url);
  const ids = m ? decodeURIComponent(m[1]).split(",").filter(Boolean) : [];
  const nightly = /[?&]days=/.test(url);
  const span = nightly ? CAMPMAP_FEED_DAYS : 30;
  const day = n => { const t = new Date(Date.now() + n * 86400000); return t.toISOString().slice(0, 10); };
  const data = {}, sources = {};
  ids.forEach((id, i) => {
    const checkInDates = {};
    const horizon = nightly ? Math.max(30, CAMPMAP_HORIZON_DAYS - i * 10) : Infinity;
    for (let n = 0; n < span; n++) {
      // Past this site's window rec.us reports `outside-window` — the same string
      // a staff hold uses, which is why the page may only read the trailing run
      // as a horizon.
      if (n >= horizon) { checkInDates[day(n)] = { available: false, reason: "outside-window" }; continue; }
      // A deterministic mix so every branch is hit: free nights, a real booking
      // conflict, and a stay-rule block that must NOT read as booked.
      const slot = (i + n) % 7;
      if (slot === 3) checkInDates[day(n)] = { available: false, reason: "conflict" };
      else if (slot === 5) checkInDates[day(n)] = { available: false, reason: "minimum-stay" };
      // A mid-feed hold, well inside the window: it must stay "not available"
      // rather than being swept up as "not open yet".
      else if (slot === 6 && n > 8) checkInDates[day(n)] = { available: false, reason: "outside-window" };
      else checkInDates[day(n)] = { available: true, earliestCheckout: day(n + 1), latestCheckout: day(n + 4) };
    }
    data[id] = { checkInDates };
    sources[id] = nightly ? "nightly" : "mcp";
  });
  return { data, sources };
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
    subType: SUB_TYPES[i % SUB_TYPES.length],
    // Topaz's real shape, which is what makes the amenity cases discriminating:
    // two tags on EVERY site (so a tick is a visible no-op with a 'n/n' count),
    // and two that split the campground with ZERO overlap — the pair that empties
    // the map under rec.us's AND, and must therefore be named rather than left as
    // a blank map. `amenities` deliberately omits the unknown tag that
    // `amenityTags` keeps, so anything zipping those two by index mislabels.
    amenities: ["Tables", "Fire Pit"].concat(i % 3 === 0 ? ["Tent Site"] : ["Water Hookup"]),
    amenityTagIds: ["tag-tables", "tag-firepit", "tag-unknown"]
      .concat(i % 3 === 0 ? ["tag-tent"] : ["tag-water"]),
    amenityTags: [
      { id: "tag-tables",  name: "Tables" },
      { id: "tag-firepit", name: "Fire Pit" },
      { id: "tag-unknown", name: "Other amenity" },
    ].concat(i % 3 === 0 ? [{ id: "tag-tent", name: "Tent Site" }]
                         : [{ id: "tag-water", name: "Water Hookup" }]),
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
  // Just Launched's case: early access opened YESTERDAY, general registration is
  // still a week out. Reading only "Reg Opens" leaves this section out of the
  // bucket for the whole week it is actually converting — which is what Dan hit
  // on 2026-08-24. Dates are relative, so it can never drift into a different
  // bucket with the clock.
  const launchedEarly = Object.assign(table("Premier Table Early", 62, 40, 25, -1), {
    "Section ID": "sec-premier-early",
    "Early Access Opens": iso(-1), "Reg Opens": iso(6), "Reg Closes": iso(45),
    "Reg Status": "pipeline",     // exactly what the card reports for this shape
    // Smyrna's real shape: 62 holds chasing 25 seats, all 25 won by Fast Track,
    // zero direct. The card's own "Conversion %" is holds-based and says 40.3%;
    // the page must read 100%, because 25 of the 25 seats open to FT went to FT.
    "FT Converted": 25, "FT Pending": 37, "Capacity": 25,
    "Direct Enrolled": 0, "Total Enrolled": 25, "Fill %": 100,
    "Conversion %": 40.3,
  });
  // Smaller and MORE RECENT than launchedEarly. Pure recency ordering puts this
  // first, which is what buried a section with 62 fast-trackers behind sections
  // with one or two of them on a busy launch morning.
  const launchedSmall = Object.assign(table("Tiny Section", 2, 1, 20, -1), {
    "Section ID": "sec-tiny", "Program": "Tumbling",
    "Early Access Opens": iso(-0.02), "Reg Opens": iso(6), "Reg Closes": iso(45),
    "FT Total": 2, "FT Converted": 1, "FT Pending": 1, "Conversion %": 50,
  });
  return [
    launchedSmall,
    launchedEarly,
    table("Premier Table", 54, 54, 25, 1),
    table("Select Table", 18, 18, 45, 2),
    table("Preferred Table", 21, 21, 30, 3),
    table("General Table", 21, 21, 50, 4),
    past("Summer Concert: Yacht Rock Schooner", 14, 10),
    past("Summer Concert: Guardian of the Jukebox", 8, 6),
    cold,
  ];
}

// ── Memberships check-in fixture ────────────────────────────────────────────
// Shaped to pin the three things the Check-Ins tab can get wrong silently:
//   · the time-of-day curve's peak (5pm carries four check-ins, more than any
//     other hour, so a peak read off the wrong series or the wrong key moves),
//   · the weekday letters on the daily chart (Sat 22nd, Sun 23rd, Mon 24th of
//     August 2026 — a UTC parse of "2026-08-24" slides Monday back to Sunday in
//     any US timezone, which is why the letters are asserted and not just drawn),
//   · and the desk-location filter, which needs more than one desk to exist at
//     all. Every row carries BOTH ids: "Member ID" is users.rec_id (the code read
//     out at the desk) and "User ID" is users.id, the only one the Rec admin URL
//     accepts.
function checkinRows() {
  const at = (date, hour, min, who, desk, type) => ({
    "Member ID": who.rec, "User ID": who.id, "First Name": who.first, "Last Name": who.last,
    "Email": who.first.toLowerCase() + "@example.com",
    "Date": date, "Time": ((hour % 12) || 12) + ":" + String(min).padStart(2, "0") + (hour < 12 ? "am" : "pm"),
    "Hour": hour, "Day of Week": ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(
      +date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)).getDay()],
    "Day Type": [0, 6].includes(new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)).getDay()) ? "Weekend" : "Weekday",
    "Desk Location": desk, "Check-In Type": type,
    "Product Name": type === "pass" ? "10-Visit Pool Pass" : "Annual Family Membership",
    "Recorded By": "Front Desk",
  });
  const ada  = { rec: "5OLLPM", id: "24d709e5-675b-4d7e-91e3-f7b18daeb41c", first: "Ada",  last: "Lovelace" };
  const emmy = { rec: "O0H6B3", id: "a37fea14-be38-46db-96da-40e61ccca25a", first: "Emmy", last: "Noether" };
  const alan = { rec: "5773E2", id: "7faca1c4-d409-4bf7-b29a-f675b6369a73", first: "Alan", last: "Turing" };
  return [
    at("2026-08-24", 17, 5,  ada,  "North Desk", "membership"),
    at("2026-08-24", 17, 22, emmy, "North Desk", "membership"),
    at("2026-08-24", 17, 41, alan, "South Desk", "pass"),
    at("2026-08-24",  8, 12, ada,  "North Desk", "membership"),
    at("2026-08-24", 12, 30, emmy, "South Desk", "membership"),
    at("2026-08-23", 10, 15, ada,  "North Desk", "membership"),
    at("2026-08-23", 16, 40, alan, "North Desk", "pass"),
    at("2026-08-22", 17, 8,  ada,  "North Desk", "membership"),
    at("2026-08-22",  9, 55, emmy, "North Desk", "membership"),
  ];
}

// Enough of the memberships feed for the tab underneath to render; the Check-Ins
// tab is what the cases assert on.
function membershipRows() {
  return [
    { "User ID": "24d709e5-675b-4d7e-91e3-f7b18daeb41c", "First Name": "Ada", "Last Name": "Lovelace",
      "Email": "ada@example.com", "Membership ID": "m-1", "Membership Type": "Annual Family",
      "Group / Plan": "Family", "Status": "active", "Renewal Type": "Auto-renew",
      "Price": 240, "Paid": 240, "Refunded": 0, "Net Collected": 240,
      "Start Date": "2026-01-01", "End Date": "2026-12-31", "Created At": "2026-01-01",
      "Usage Count": 12, "Attendance Count": 12 },
    { "User ID": "a37fea14-be38-46db-96da-40e61ccca25a", "First Name": "Emmy", "Last Name": "Noether",
      "Email": "emmy@example.com", "Membership ID": "m-2", "Membership Type": "Adult",
      "Group / Plan": "Adult", "Status": "active", "Renewal Type": "One-time",
      "Price": 120, "Paid": 120, "Refunded": 0, "Net Collected": 120,
      "Start Date": "2026-03-01", "End Date": "2027-02-28", "Created At": "2026-03-01",
      "Usage Count": 4, "Attendance Count": 4 },
  ];
}

// ── Director's Report fixture ───────────────────────────────────────────────
// Only what the two new sections need. The AGGREGATION is pinned by
// scripts/directors-facilities.spec.js against the client's own hour helpers;
// this case exists because a panel can compute perfectly and still throw while
// rendering — which is how two Camping tabs shipped blank.
function directorsQuarter() {
  return {
    ok: true,
    quarter: { year: 2026, q: 2, label: "Q2 2026", start: "2026-04-01", end: "2026-06-30", partial: false },
    prevLabel: "Q1 2026",
    generatedAt: "2026-07-01T12:00:00.000Z",
    gl: { gross: 412000, refunds: 8000, net: 404000, payments: 3100, refundCount: 60,
          accounts: [{ name: "Facility Rentals", net: 120000, prevNet: 100000 }],
          prev: { gross: 380000, refunds: 7000, net: 373000, payments: 2900 } },
    transactions: { cur: 3100, prev: 2900 },
    facility: { n: 1840, rev: 262000, residentPct: 71.2, managed: 1500, instant: 340,
                topLocs: [{ name: "Community Park", n: 900, rev: 140000 }],
                prevN: 1700, prevRev: 240000 },
    // Hourly rentals, and the panels have to say which peak-hour rule they used.
    outdoor: { bookings: 312, hours: 2480, timed: 300, multiDay: 12, avgBlock: 8.3,
               revenue: 41000, addOnFees: 3100, sites: 46,
               topSites: [{ name: "Oak Pavilion", location: "Community Park", bookings: 60, hours: 520, rev: 9000, days: 48 },
                          { name: "Picnic Area A", location: "Community Park", bookings: 40, hours: 300, rev: 4000, days: 33 }],
               types: [{ type: "outdoor-event-space", label: "Pavilions & event spaces", bookings: 220, hours: 1900, rev: 33000 },
                       { type: "picnic-table", label: "Picnic areas", bookings: 80, hours: 520, rev: 6500 },
                       { type: "bounce-house", label: "Bounce houses", bookings: 12, hours: 60, rev: 1500 }],
               peakHour: "11am", peakBookings: 38, instant: 40, managed: 272, managedPct: 87.2,
               eveningPct: 12.5, lights: { bookings: 0, pct: 0 }, prep: { bookings: 20, pct: 6.4 },
               withAddOn: 90, addOnPct: 28.8, topAddOns: [{ name: "Alcohol Permit", n: 40 }] },
    fields: { bookings: 640, hours: 3760, timed: 600, multiDay: 40, avgBlock: 6.3,
              revenue: 88000, addOnFees: 12000, sites: 22,
              topSites: [{ name: "Diamond 1", location: "Community Park", bookings: 120, hours: 700, rev: 18000, days: 61 },
                         { name: "Multipurpose Field", location: "North Park", bookings: 90, hours: 540, rev: 12000, days: 44 }],
              types: [{ type: "field", label: "field", bookings: 640, hours: 3760, rev: 88000 }],
              peakHour: "7pm", peakBookings: 96, instant: 29, managed: 611, managedPct: 95.5,
              eveningPct: 61.4, lights: { bookings: 210, pct: 32.8 }, prep: { bookings: 88, pct: 13.8 },
              withAddOn: 300, addOnPct: 46.9,
              topAddOns: [{ name: "Field Light Fee", n: 160 }, { name: "Attendant", n: 60 }] },
  };
}

// ── Add-ons in the note line, and the Forms link ────────────────────────────
// Site Type is deliberately "gym": the facilities-hub tabs count campsite,
// field and the three outdoor types, so these rows stay invisible to them and
// cannot shift [data-oe-peak] / [data-fld-peak].
function addonFormRows() {
  const d = n => { const t = new Date(Date.now() - n * 86400000); return t.toISOString().slice(0, 10); };
  const mk = (resId, site, addOns, addonFees) => ({
    "Org Name": "Test Parks", "Reservation ID": resId, "Date": d(3),
    "Day": "Sunday", "Begin": "10:00am", "End": "02:00pm",
    "Location": "Arsenal Park", "Facility": "Arsenal Park - " + site,
    "Site Type": "gym", "Purpose": "Birthday party", "Head Cnt": 30,
    "Reservee": "Test Renter", "Email": "t@example.com", "Phone": null, "Resident?": "Yes",
    "Booking Type": "Managed", "Instructions": null, "Notes": null,
    "Add Ons": addOns, "Add-On Fees": addonFees, "Total": 50, "Paid?": "Paid",
    "Multi-Day Days": null, "Multi-Day Day#": null,
    "Lighting": null, "Lit From": null, "Lit Until": null, "Lighting Sync": null,
  });
  return [
    // Two add-ons, so the note line has a total to sum: 25 + 15.50 = $40.50.
    mk("res-addons", "Pavilion B", "Alcohol Permit ($25.00), Field Light Fee ($15.50)", 40.5),
    mk("res-forms",  "Pavilion C", "", 0),
    mk("res-plain",  "Picnic Table 11", "", 0),
  ];
}

const STUBS = [
  { match: /\/facilities\/api\/campsites/, body: () => campsitesGeo },
  // Must precede the catch-all /api/ stub. Realistic enough that the case below
  // asserts a NUMBER off the payload rather than merely that a strip appeared.
  { match: /\/facilities\/api\/campmap-activity/, body: () => ({
      days: 30, covers: true, logStartsAt: new Date(Date.now() - 90 * 86400000).toISOString(),
      totals: { views: 128, sites: 44, books: 11, shares: 3, filters: 9 },
      prior:  { views: 100, sites: 30, books: 8, shares: 1, filters: 4 },
      bookKinds: { dated: 7, "site-page": 4 }, shareKinds: { link: 2, embed: 1 },
      topSite: { name: "Site 12", opens: 9 } }) },
  // One feed, both tabs: Camping filters it to campsite rows and Outdoor Events
  // to its three types, so each tab has to do its own scoping.
  { match: /\/facility\/api\/data/,        body: () => ({ rows: campsiteRows().concat(outdoorRows()).concat(fieldRows()).concat(addonFormRows()), meta: { org_id: "org-uuid-1" } }) },
  { match: /\/api\/permits/,               body: () => ({ permits: {} }) },
  // Two of the three fixture rentals have Required Information; the third has
  // none, which is the 62%-of-a-week case that must render as nothing.
  { match: /\/facility\/api\/forms/,       body: () => ({ forms: { "res-forms": 2, "res-addons": 1 } }) },
  { match: /\/api\/availability-batch/,     body: url => availabilityFor(url) },
  { match: /\/rentalcalendar\/api\/sites/, body: (url, org) => ({ sites: campmapSites(org) }) },
  { match: /\/api\/sites/,                  body: () => ({ sites: [] }) },
  { match: /\/fasttrack\/api\/data/,       body: () => ({ rows: fasttrackRows(), meta: {} }) },
  { match: /\/court-utilization\/api\/data/, body: () => ({ rows: racketRows(), meta: {} }) },
  // org_id is what the member links are built from — without it the cells fall
  // back to plain text, which is the behaviour before the card ships the uuid.
  { match: /\/checkins\/api\/data/,     body: () => ({ rows: checkinRows(), meta: { org_id: "org-uuid-1" } }) },
  { match: /\/directors-report\/api\/quarters/, body: () => ({ ok: true, quarters: [{ year: 2026, q: 2, key: "2026-Q2", label: "Q2 2026", stored: true }] }) },
  { match: /\/directors-report\/api\/quarter/,  body: () => directorsQuarter() },
  { match: /\/memberships\/api\/data/,  body: () => ({ rows: membershipRows(), meta: { org_id: "org-uuid-1" } }) },
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

  // ── The rental schedule: add-ons in the note line, Forms in the column ────
  // This page had NO render case at all, and it is the one most orgs open.
  { name: "facility · schedule",   path: "/{org}/facility",               needs: ".data-row" },
  // The add-on money must survive losing its column: card 17294's "Total" is
  // the reservation's own order_item and does NOT include add-on fees, so if
  // this total goes missing the page has quietly dropped revenue.
  { name: "facility · add-on total in note", path: "/{org}/facility",
    needs: "[data-addon-total=\"$40.50\"]" },
  // ...with its icons, which is the structure Dan asked to keep.
  { name: "facility · add-on icons",  path: "/{org}/facility",            needs: "[data-addon-icons=\"2\"]" },
  // The Forms column links to the rental's Required Information tab.
  { name: "facility · forms link",    path: "/{org}/facility",
    needs: "a[href$=\"tab=requiredInformation\"]" },
  // A rental with no forms gets NOTHING — a link to an empty tab is a dead end,
  // and 62% of a typical week has no form at all.
  { name: "facility · no forms, no link", path: "/{org}/facility",
    needs: "[data-forms-empty=\"1\"]" },

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
  // Just Launched must count a section whose EARLY-ACCESS window opened, not
  // only one whose general window did. `[data-launched-kind="early"]` exists
  // solely on that path, so reading "Reg Opens" alone fails this case.
  { name: "fasttrack · just launched",  path: "/{org}/fasttrack",         needs: "[data-launched-kind=\"early\"]" },
  // ...and its conversion figure must be measured against the seats that were
  // open to Fast Track, not against every hold. 25 of 25 seats = 100%; the
  // card's holds-based column says 40.3%, which is what the page used to show.
  { name: "fasttrack · conv vs capacity", path: "/{org}/fasttrack",        needs: "[data-conv-pct=\"100\"]" },
  // Just Launched leads with the biggest Fast Track stake, not the most recent
  // open. sec-premier-early carries 62 holds; sec-tiny carries 2 and opened
  // later, so recency ordering makes it first and fails this case.
  { name: "fasttrack · launch order",   path: "/{org}/fasttrack",
    needs: ".launch-grid [data-just-launched]:first-child[data-section-id=\"sec-premier-early\"]" },
  // Pinning belongs on what has NOT launched. The pin lives on the Launching
  // Soon section rows now; a just-launched card carries none (verified in the
  // browser — a selector cannot assert an absence).
  { name: "fasttrack · pin pre-launch", path: "/{org}/fasttrack",         needs: "[data-launch-section] .pin-toggle" },
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
  // Fields. The heat map must peak at 7pm — five evening league blocks are in
  // use in that hour — and that only holds if hours are counted as COVERED.
  // Counting start times instead peaks at 6pm on this fixture, so the case
  // discriminates. The sport note must also render, since it is what keeps a
  // name-derived sport mix honest.
  { name: "facilities · fields",           path: "/{org}/facilities?tab=fields",  needs: "[data-fld-heat]" },
  { name: "facilities · fields peak hour", path: "/{org}/facilities?tab=fields",  needs: "[data-fld-peak=\"7p\"]" },
  { name: "facilities · fields sport note", path: "/{org}/facilities?tab=fields", needs: "[data-fld-sport-note]" },
  { name: "facilities · racket sports",    path: "/{org}/facilities?tab=racket",  needs: ".court-native .sum-cards" },
  // Memberships → Check-Ins. Six things, none of which "the page rendered"
  // would cover: the time-of-day curve exists and peaks where the data does; the
  // daily chart carries weekday letters (Monday the 24th must read M — a UTC
  // parse of the date string makes it S); the desk filter was built from the feed;
  // a member's name links to their Rec account; and the monthly bars carry a
  // clickable month header.
  { name: "memberships · check-ins",      path: "/{org}/memberships?tab=checkins", needs: "[data-ci-hour-line]" },
  { name: "memberships · peak hour",      path: "/{org}/memberships?tab=checkins", needs: "[data-ci-hour-line=\"5p\"]" },
  { name: "memberships · weekday marks",  path: "/{org}/memberships?tab=checkins", needs: "[data-ci-dow=\"M\"]" },
  { name: "memberships · location filter", path: "/{org}/memberships?tab=checkins", needs: "#ciLocPick option[value=\"South Desk\"]" },
  // ...and the filter must be APPLIED, not merely offered: South Desk holds 2 of
  // the fixture's 9 check-ins, so a tab that renders every panel off the
  // unfiltered rows reports 9 here and fails. This is the facility-Summary bug
  // (chips that scope some panels and not others) asserted in a browser.
  { name: "memberships · location applied", path: "/{org}/memberships?tab=checkins&ci_loc=South%20Desk",
    needs: "[data-ci-total=\"2\"]" },
  // The link has to carry users.id. Building it from "Member ID" (users.rec_id,
  // the code read out at the desk) renders an identical-looking link to a 404,
  // so the case pins the uuid rather than the anchor.
  { name: "memberships · rec user link",  path: "/{org}/memberships?tab=checkins",
    needs: "a[data-ci-user-link][href$=\"/users/24d709e5-675b-4d7e-91e3-f7b18daeb41c\"]" },
  { name: "memberships · month bars",     path: "/{org}/memberships?tab=checkins", needs: "[data-ci-mo=\"2026-08\"]" },
  { name: "memberships · month header",   path: "/{org}/memberships?tab=checkins", needs: "[data-ci-mo-head=\"2026-08\"]" },
  // The Director's Report's two newest sections. Outdoor spaces and fields are
  // HOURLY rentals sliced out of the same facility feed the report already
  // fetches, so the panels are free to render — and each must state the rule
  // behind its peak hour, because "busiest at 7pm" means two different things
  // depending on whether hours are counted as covered or started.
  { name: "directors · outdoor panel", path: "/{org}/directors-report", needs: "[data-dr-outdoor]" },
  { name: "directors · fields panel",  path: "/{org}/directors-report", needs: "[data-dr-fields]" },
  // The hub's verticals are two clicks deep behind a card that just says
  // "Facilities". The chips are how Fields and Outdoor Events are findable at
  // all from the org landing page.
  { name: "org landing · hub tab chips", path: "/{org}",
    needs: ".card-tab[href*=\"tab=fields\"]" },
  { name: "org landing · checkins chip", path: "/{org}",
    needs: ".card-tab[href*=\"tab=checkins\"]" },
  { name: "campmap · stay search", path: "/{org}/campmap",                needs: "#departPick[max]" },
  // The Campsite Type filter. `option[value="tent-and-rv"]` is only there if the
  // LIVE site feed landed and buildTypeFilter() re-ran off its subType — the
  // seed's own kinds are electric/primitive — so this covers the overlay path as
  // well as the control rendering at all. It is the code path being covered: the
  // real Rec feed omits subType, so in production the options come from the seed.
  { name: "campmap · type filter", path: "/{org}/campmap",                needs: "#typePick option[value=\"tent-and-rv\"]" },
  // The 210-day nightly feed, end to end. `data-days-ahead="119"` is site 0's
  // 120-day window (day 0 .. day 119) surviving the whole path: the page asked
  // for days=210, the server answered `sources: nightly`, bookingHorizon read the
  // TRAILING outside-window run rather than the mid-feed hold the fixture also
  // plants, and maxArrival took the FURTHEST site in view rather than a park-wide
  // floor. Any of those regressing lands on 29 (the 30-day fallback) or on one of
  // the shorter sites' windows, and this fails by name. "An Arrive field
  // rendered" is the assertion that would not have caught the bug.
  { name: "campmap · 210-day horizon", path: "/{org}/campmap",            needs: "#arrivePick[data-days-ahead=\"119\"]" },
  // The amenity control must be built from the LIVE feed's tags: the baked seed
  // carries no amenities whatsoever, so any chip at all proves the overlay landed
  // and was read through the aligned {id,name} pairs. Both cases together are the
  // discriminating part — a universal amenity (a tick that moves nothing, which
  // its count exists to explain) AND one that actually narrows the campground.
  // Either alone would pass on a control that only ever renders one kind.
  { name: "campmap · amenity chips", path: "/{org}/campmap",
    needs: "#amenRow .amchk[data-am-universal]" },
  // Semantic, not numeric: this check runs against whichever seed org is first,
  // so a hard-coded count would break on a seed reorder rather than on a bug.
  { name: "campmap · amenity splits", path: "/{org}/campmap",
    needs: "#amenRow .amchk[data-am-split]" },
  // The Camping tab hands the org its own public-map traffic. Keyed to the view
  // count from the payload, so a strip that renders but reads the wrong field —
  // or throws and unmounts the tab — fails rather than passing on "something
  // appeared".
  { name: "facilities · campmap activity", path: "/{org}/facilities?tab=camping",
    needs: "[data-campmap-stats=\"128\"]" },
  // Depart must reach the horizon too (Dan, 2026-08-25): the last bookable
  // arrival (day 119) PLUS a full stay. The check org is the first campmap seed,
  // pleasant-hill, whose configured maximum is 5 nights — so 119 + 5 = 124.
  // Two regressions land elsewhere: reverting to the old rec.us latestCheckout
  // cap gives a number in the single digits, and bounding at the horizon ITSELF
  // gives 120, which is the tail-decay bug that makes the final arrival a
  // one-night stay.
  { name: "campmap · depart reaches the horizon", path: "/{org}/campmap",  needs: "#departPick[data-days-ahead=\"124\"]" },
  // The landing state (Dan, 2026-08-25): Depart says which field to fill first,
  // in red, and the map claims nothing until it has been asked. "A Depart field
  // rendered" passes either way — this pins the prompt itself.
  { name: "campmap · depart prompts first", path: "/{org}/campmap",       needs: "#departLbl.prompt" },
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

  // Optional filter so one page's cases can be iterated without paying for all
  // of them: `node scripts/ci-check-render.js "facility ·"`
  const only = process.argv.slice(2).join(" ").trim();
  for (const c of (only ? CASES.filter(c => c.name.includes(only)) : CASES)) {
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
    if (process.env.SHOT_DIR && found) {
      try {
        // Scroll the thing that was asserted into view, or the shot is just the
        // top of the page and shows nothing about what passed.
        await page.evaluate(sel => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ block: "center" });
        }, c.needs);
        await new Promise(r => setTimeout(r, 250));
        await page.screenshot({ path: require("path").join(process.env.SHOT_DIR,
          c.name.replace(/[^a-z0-9]+/gi, "-") + ".png"), fullPage: false });
      } catch (_) {}
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
