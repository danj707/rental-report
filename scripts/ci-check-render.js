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
    // 62 holds against 25 seats at $25 => 37 * 25 = $925 with nowhere to sit.
    // `Left on Table` carries a SENTINEL that could never be the right answer
    // for a capacity headline, so a card reading the wrong column fails loudly
    // rather than rendering a plausible number. (On a section exactly at
    // capacity the two are genuinely equal, which is why the fixture has to
    // force them apart to discriminate at all.)
    "Over Demand $": 925, "Left on Table": 999999,
  });
  // Smaller and MORE RECENT than launchedEarly. Pure recency ordering puts this
  // first, which is what buried a section with 62 fast-trackers behind sections
  // with one or two of them on a busy launch morning.
  const launchedSmall = Object.assign(table("Tiny Section", 2, 1, 20, -1), {
    "Section ID": "sec-tiny", "Program": "Tumbling",
    "Early Access Opens": iso(-0.02), "Reg Opens": iso(6), "Reg Closes": iso(45),
    "FT Total": 2, "FT Converted": 1, "FT Pending": 1, "Conversion %": 50,
  });
  /* ── The program the capacity tests used to swallow ──────────────────────
     Smyrna's Birthday Concert, in its real proportions (measured 2026-08-26):
     two tables about to open carrying 203 and 111 fast-trackers against 45 and
     50 seats, plus two SPENT summer concerts at 100 seats each. Program-wide
     that is 336 FT over 295 capacity — 113.9% demand with 314 pending against
     295 spots left — so it trips "demand over 90% with more pending than spots
     left" and, while `_launch` was tested third, was filed under Needs Capacity
     and never reached Launching Soon at all.

     THE EXISTING Concert Series FIXTURE DOES NOT REPRODUCE THIS: its 198 FT over
     375 capacity is 52.8% demand, comfortably under the threshold, which is why
     the `launching soon` case above passed happily on the broken build. The
     spent 100-seat sections are load-bearing here — they are two thirds of the
     capacity and none of the pre-launch demand, which is exactly how a program's
     history used to decide whether its pre-launch card rendered.

     Its Select Table opens in ~15 minutes, sooner than any other launching
     section in the fixture, so it must also be the FIRST card. */
  const birthday = (name, ft, cap, opensInDays) => Object.assign(table(name, ft, ft, cap, opensInDays), {
    "Program": "Birthday Concert", "Program ID": "prog-birthday",
    "Section ID": "sec-birthday-" + name.replace(/\W+/g, "-").toLowerCase(),
  });
  const birthdaySpent = (name, ft, conv) => Object.assign(past(name, ft, conv), {
    "Program": "Birthday Concert", "Program ID": "prog-birthday",
    "Section ID": "sec-birthday-" + name.replace(/\W+/g, "-").toLowerCase(),
  });
  /* ── THE CACHE INVARIANT, in a browser ────────────────────────────────────
     Card 17300 v18 emits 'early-access' directly; every pre-v18 response — and
     every warm 4-hour cache entry holding one — still says 'pipeline' with an
     open early window. Both shapes are live at once, so the page must render
     them IDENTICALLY. launchedEarly is the pre-v18 shape; this is the same
     section as v18 describes it, and the render case requires both to print
     Early Access. Nothing but a browser proves the two agree once the value has
     been through normalizeRow, ftEffectiveStatus and the table cell. */
  const launchedEarlyV18 = Object.assign(table("Premier Table Early v18", 62, 37, 25, -1), {
    "Section ID": "sec-premier-early-v18",
    "Early Access Opens": iso(-1), "Reg Opens": iso(6), "Reg Closes": iso(45),
    "Reg Status": "early-access",   // what the v18 card reports for this shape
    "FT Converted": 25, "FT Pending": 37, "Capacity": 25,
    "Direct Enrolled": 0, "Total Enrolled": 25, "Fill %": 100, "Conversion %": 40.3,
    // Deliberately carries NO blocked revenue: this row exists to pin the status
    // LABEL, and giving it money would silently double the Conversions KPI that
    // `conversions missed-revenue KPI` asserts is 925.
    "Over Demand $": 0, "Left on Table": 0,
  });
  return [
    launchedSmall,
    launchedEarly,
    launchedEarlyV18,
    birthday("Select Table 45", 203, 45, 0.01),
    birthday("General Table 50", 111, 50, 1),
    birthdaySpent("Birthday Summer: June", 14, 10),
    birthdaySpent("Birthday Summer: July", 8, 6),
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
  const at = (date, hour, min, who, desk, type, status) => ({
    "Member ID": who.rec, "User ID": who.id, "First Name": who.first, "Last Name": who.last,
    "Email": who.first.toLowerCase() + "@example.com",
    "Date": date, "Time": ((hour % 12) || 12) + ":" + String(min).padStart(2, "0") + (hour < 12 ? "am" : "pm"),
    "Hour": hour, "Day of Week": ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(
      +date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)).getDay()],
    "Day Type": [0, 6].includes(new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)).getDay()) ? "Weekend" : "Weekday",
    "Desk Location": desk, "Check-In Type": type,
    // Card 18151 v3 tags every row. A FAILED row is a denied membership/pass
    // scan: same shape as a success, which is why it has to be filtered out of
    // every count rather than trusted to look different.
    "Status": status || "Checked In",
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
    // Two denials, on DIFFERENT desks. Nine successes + two failures: a tab that
    // counts rows reports 11 check-ins, which is the regression. The split across
    // desks is what makes the Failed tile's location scoping observable.
    at("2026-08-24", 18, 2,  alan, "North Desk", "membership", "Failed"),
    at("2026-08-23", 11, 47, emmy, "South Desk", "pass",       "Failed"),
  ];
}

// ── Programs report ────────────────────────────────────────────────────────
// The Programs page had NO render case before 2026-08-26, so its Check-Ins band
// was never driven in a browser. Two feeds: the section-grain programs card, and
// the per-section attendance card.
function programRows() {
  const sec = (prog, name, sid, enrolled, capacity) => ({
    "Program": prog, "Program Id": "prog-" + prog.toLowerCase().replace(/\W+/g, "-"),
    "Section": name, "Section Id": sid, "Section Status": "Open",
    "Start Date": "2026-08-01", "End Date": "2026-09-30",
    "Enrolled": enrolled, "Capacity": capacity, "Utilized": enrolled,
    "Charged": enrolled * 40, "Received": enrolled * 40, "Refunds": 0,
    "Activity": "Aquatics", "Category": "Fitness",
  });
  return [
    sec("Aquatic Exercise",  "Aquatic Stations with Pearlena", "sec-aq-1", 21, 24),
    sec("Aquatic Exercise",  "Water Waves with Yvette",        "sec-aq-2", 20, 24),
    sec("Water Walking",     "Water Walking August 24",        "sec-ww-1", 12, 16),
  ];
}

// Per-section attendance. Card 18547 v2 also emits Absent/Absentees, resolved by
// "latest mark or undo wins" — so a section whose only mark was UNDONE reads 0
// here, not 1. sec-ww-1 is that case; sec-aq-2 carries no absences at all.
function programCheckinRows() {
  return [
    { "Program": "Aquatic Exercise", "Section Id": "sec-aq-1", "Section": "Aquatic Stations with Pearlena",
      "Section Code": "AQ1", "Check Ins": 21, "Check Outs": 1, "Attendees In": 21, "Attendees Out": 1,
      "Absent": 4, "Absentees": 3 },
    { "Program": "Aquatic Exercise", "Section Id": "sec-aq-2", "Section": "Water Waves with Yvette",
      "Section Code": "AQ2", "Check Ins": 17, "Check Outs": 0, "Attendees In": 17, "Attendees Out": 0,
      "Absent": 0, "Absentees": 0 },
    { "Program": "Water Walking", "Section Id": "sec-ww-1", "Section": "Water Walking August 24",
      "Section Code": "WW1", "Check Ins": 12, "Check Outs": 0, "Attendees In": 12, "Attendees Out": 0,
      "Absent": 2, "Absentees": 2 },
  ];
}

// Memberships fixture. Carries the card 17301 v2 columns (Coverage, Plan Season
// End, Plan Term Days, Auto Renew, Period Start) so the Auto-Renew and Sales &
// Mix tabs have something real to compute from, and spreads purchases over three
// months so the month series and the price/volume decomposition are exercised.
//
// The proportions are the shape measured on prod, not invented:
//   · a SEASON plan nobody auto-renews (all season plans on prod are 0%)
//   · a MONTHLY open-ended plan where every member auto-renews (100%, as on prod)
//   · an ANNUAL plan priced at exactly 12x that monthly, which almost nobody buys
// The last one is the finding the Sales & Mix plan table exists to surface.
//
// stubMode "prev2" drops the five v2 columns, i.e. a warm pre-v2 cache entry.
// Both feed shapes are live at once for four hours after the card ships, so the
// page has to be correct on either — see mbHasEconomics / mbIsAutoRenew.
function membershipRows() {
  const V2 = STUB_MODE !== "prev2";
  const row = (o) => {
    const r = {
      "Paid": o["Price"], "Refunded": 0, "Net Collected": o["Price"],
      "Usage Count": 4, "Attendance Count": 4,
      "Email": (o["First Name"] || "x").toLowerCase() + "@example.com",
      "Canceled At": "", "Last Used": "",
    };
    Object.assign(r, o);
    if (!V2) {
      delete r["Coverage"]; delete r["Plan Season End"]; delete r["Plan Term Days"];
      delete r["Auto Renew"]; delete r["Period Start"];
    }
    return r;
  };
  const rows = [];
  // Season pass — 6 sold in May at $240, none auto-renewing.
  for (let i = 0; i < 6; i++) {
    rows.push(row({
      "User ID": "24d709e5-675b-4d7e-91e3-f7b18daeb41c", "First Name": "Ada", "Last Name": "Lovelace " + i,
      "Membership ID": "m-s" + i, "Membership Type": "Aquatic Season", "Group / Plan": "Summer Season Pass",
      "Status": "active", "Renewal Type": "One-time", "Price": 240,
      "Start Date": "2026-05-01", "End Date": "2026-09-30", "Created At": "2026-05-1" + i,
      "Next Renewal": "", "Coverage": "group", "Plan Season End": "2026-09-30",
      "Plan Term Days": null, "Auto Renew": false, "Period Start": "",
    }));
  }
  // Monthly fitness — 4 sold in June at $20, every one auto-renewing on a 31-day
  // cycle, so the tab can compute a real monthly figure and an ARPU.
  for (let i = 0; i < 4; i++) {
    rows.push(row({
      "User ID": "a37fea14-be38-46db-96da-40e61ccca25a", "First Name": "Emmy", "Last Name": "Noether " + i,
      "Membership ID": "m-m" + i, "Membership Type": "Fitness Monthly", "Group / Plan": "Monthly Individual",
      "Status": "active", "Renewal Type": "Auto-renew", "Price": 20,
      "Start Date": "2026-06-01", "End Date": "", "Created At": "2026-06-0" + (i + 1),
      "Next Renewal": "2026-09-29", "Coverage": "individual", "Plan Season End": null,
      "Plan Term Days": null, "Auto Renew": true, "Period Start": "2026-08-29",
    }));
  }
  // Annual fitness at 12x the monthly — one buyer, renewing by hand. This is the
  // conversion candidate AND the unpopular-plan case, in one row.
  rows.push(row({
    "User ID": "b48fea14-be38-46db-96da-40e61ccca25b", "First Name": "Grace", "Last Name": "Hopper",
    "Membership ID": "m-a1", "Membership Type": "Fitness Annual", "Group / Plan": "Annual Individual",
    "Status": "active", "Renewal Type": "One-time", "Price": 240,
    "Start Date": "2026-07-01", "End Date": "2027-06-30", "Created At": "2026-07-05",
    "Next Renewal": "", "Coverage": "individual", "Plan Season End": null,
    "Plan Term Days": null, "Auto Renew": false, "Period Start": "",
  }));
  return rows;
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
    // Fast Track, in the shape dirFastTrack() returns. Proportions are
    // Watertown's real ones so the case is meaningful: the capacity-aware rate
    // (90.5%) and the of-signups rate (76.6%) DIFFER, which is what makes the
    // "which denominator" assertion discriminating — equal values would pass
    // either way round. 219 converted x 2 min = 7.3 hours.
    fasttrack: {
      total: 1523, converted: 1318, revenue: 187620, rate: 76.6, capRate: 90.5,
      leftOnTable: 25398, oversub: 2, minutesPerReg: 2,
      quarter:     { signups: 286, converted: 219, pending: 67, households: 107, sections: 93, revenue: 14073, repeatHh: 50 },
      prevQuarter: { signups: 125, converted: 106, pending: 19, households: 74,  sections: 72, revenue: 14712, repeatHh: 21 },
      top: [
        { program: "Adult Pickleball Open Play", section: "Intermediate", signups: 67, converted: 61, capacity: 144, share: 46.5 },
        { program: "Adult Pickleball Skills", section: "Advanced Beginner", signups: 14, converted: 8, capacity: 8, share: 175 },
      ],
    },
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

// The Class Roster, at the grain card 17296 actually emits: one row per
// participant PER SESSION. Every row here is a case for the ePACT export:
//
//   - Ana appears TWICE on 07/06 (two sessions that day). Her SQL's SELECT
//     DISTINCT collapses those, so the CSV must carry her once for that date.
//   - Ana has her OWN email while her household owner has another. The export's
//     `Household Owner Email` is COALESCE(participant, owner), so hers must win —
//     and the owner's must not appear at all.
//   - Cass is Cancelled: never uploaded to a camp health vendor.
//   - Camp Cancelled has NOTHING but cancellations, so it gets a section header
//     and no ePACT button. A button that yields an empty file is a dead end.
function rosterRows() {
  const r = (o) => Object.assign({
    "Rec ID": "", "First Name": "", "Last Name": "", "Email": "", "Owner Email": "",
    "Household Owner": "", "Section": "", "Class": "", "Session Date": "",
    "Session Start": "09:00am", "Session End": "03:00pm", "Status": "Enrolled",
  }, o);
  return [
    r({ "Rec ID": "5OLLPM", "First Name": "Ana", "Last Name": "Reyes",
        "Email": "ana@example.com", "Owner Email": "parent-reyes@example.com",
        "Section": "Camp Blue", "Class": "Summer Day Camp", "Session Date": "07/06/2026" }),
    r({ "Rec ID": "5OLLPM", "First Name": "Ana", "Last Name": "Reyes",
        "Email": "ana@example.com", "Owner Email": "parent-reyes@example.com",
        "Section": "Camp Blue", "Class": "Summer Day Camp", "Session Date": "07/06/2026",
        "Session Start": "01:00pm" }),
    r({ "Rec ID": "5OLLPM", "First Name": "Ana", "Last Name": "Reyes",
        "Email": "ana@example.com", "Owner Email": "parent-reyes@example.com",
        "Section": "Camp Blue", "Class": "Summer Day Camp", "Session Date": "07/07/2026" }),
    r({ "Rec ID": "9ZZQ21", "First Name": "Bo", "Last Name": "Adams",
        "Email": "owner-adams@example.com", "Owner Email": "owner-adams@example.com",
        "Section": "Camp Blue", "Class": "Summer Day Camp", "Session Date": "07/06/2026" }),
    r({ "Rec ID": "3XCANCEL", "First Name": "Cass", "Last Name": "Nolan",
        "Email": "nolan@example.com", "Owner Email": "nolan@example.com",
        "Section": "Camp Blue", "Class": "Summer Day Camp", "Session Date": "07/06/2026",
        "Status": "Cancelled" }),
    r({ "Rec ID": "8ONLYX", "First Name": "Dev", "Last Name": "Marsh",
        "Email": "marsh@example.com", "Owner Email": "marsh@example.com",
        "Section": "Camp Cancelled", "Class": "Spring Clinic", "Session Date": "07/06/2026",
        "Status": "Cancelled" }),
  ];
}

// Set per case via `stubMode`, so a case can drive a feed's failure path. The
// stubs see the API request URL, not the page's, so a query flag on the page
// cannot reach them.
let STUB_MODE = "";

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

  // Two of the three fixture rentals have Required Information; the third has
  // none, which is the 62%-of-a-week case that must render as nothing.
  // `?feedfail=1` on the page URL makes both after-render feeds soft-fail, which
  // is how the "could not load" state gets driven. A soft failure answers 200
  // with error:true — the shape the routes actually return.
  { match: /\/facility\/api\/forms/,       body: () => STUB_MODE === "feedfail"
      ? ({ forms: {}, error: true }) : ({ forms: { "res-forms": 2, "res-addons": 1 } }) },
  { match: /\/facility\/api\/permits/,     body: () => STUB_MODE === "feedfail"
      ? ({ permits: {}, error: true })
      : ({ permits: { "res-addons": { code: "ABCD1234", url: "https://www.rec.us/permits/x", id: "x", multi: false } } }) },
  { match: /\/api\/availability-batch/,     body: url => availabilityFor(url) },
  { match: /\/rentalcalendar\/api\/sites/, body: (url, org) => ({ sites: campmapSites(org) }) },
  { match: /\/api\/sites/,                  body: () => ({ sites: [] }) },
  { match: /\/fasttrack\/api\/data/,       body: () => ({ rows: fasttrackRows(), meta: {} }) },
  { match: /\/court-utilization\/api\/data/, body: () => ({ rows: racketRows(), meta: {} }) },
  // org_id is what the member links are built from — without it the cells fall
  // back to plain text, which is the behaviour before the card ships the uuid.
  // `nofail` keeps the Status column but drops the two denials — a real window
  // where nobody was turned away. Distinct from a feed with NO Status column
  // (which hides the tile entirely): here the tile shows 0 and the toggle must
  // still not render, because a Failed button over an empty list is a dead end.
  { match: /\/checkins\/api\/data/,     body: () => ({
      rows: STUB_MODE === "nofail"
        ? checkinRows().filter(r => r["Status"] !== "Failed")
        // `failonly` is a window where EVERY scan was refused. There are no
        // successful check-ins, so the aggregate block does not render at all —
        // the list has to come from somewhere else, which is why it is its own
        // function. A desk misconfigured for a day looks exactly like this.
        : STUB_MODE === "failonly"
        ? checkinRows().map(r => ({ ...r, "Status": "Failed" }))
        : checkinRows(),
      meta: { org_id: "org-uuid-1" } }) },
  // Must precede /api/data. `stubMode` lets one case ask for the feed WITHOUT
  // the Absent column — the shape every warm 4-hour cache entry still has — so
  // the degradation is driven in a browser rather than reasoned about.
  { match: /\/program-checkins\/api\/data/, body: () => ({
      rows: STUB_MODE === "noabsent"
        ? programCheckinRows().map(r => { const c = Object.assign({}, r); delete c["Absent"]; delete c["Absentees"]; return c; })
        : programCheckinRows(), meta: {} }) },
  // The window matters here too: the Report Wizard reads `programs` as a source
  // and prints the range the feed covers, so a stub without one silently breaks
  // that case rather than this one.
  { match: /\/programs\/api\/data/,   body: () => ({ rows: programRows(),
      meta: { window: { start: "2026-08-19", end: "2026-08-26" } } }) },
  { match: /\/directors-report\/api\/quarters/, body: () => ({ ok: true, quarters: [{ year: 2026, q: 2, key: "2026-Q2", label: "Q2 2026", stored: true }] }) },
  { match: /\/directors-report\/api\/quarter/,  body: () => directorsQuarter() },
  { match: /\/memberships\/api\/data/,  body: () => ({ rows: membershipRows(), meta: { org_id: "org-uuid-1" } }) },
  // Must precede the catch-all /api/data below.
  { match: /\/roster\/api\/data/,      body: () => ({ rows: rosterRows(), meta: {} }) },
  // `window` is what the real feed now echoes back: the date range it actually
  // covers, read off the parameters that were sent. The wizard prints it, so the
  // case below asserts the formatted string rather than merely that a chip drew.
  { match: /\/api\/data/,                   body: () => ({ rows: campsiteRows(),
      meta: { window: { start: "2026-08-19", end: "2026-08-26" } } }) },
  { match: /\/api\/pulse/,                  body: () => ({ items: [], generated: null }) },
  { match: /\/api\/goals/,                  body: () => ({}) },
  // Saved views, shaped per report — a roster view carries section_name/status,
  // a GL view carries desks/methods, and handing one report the other's filters
  // would prove nothing. `ranges` is deliberately NOT stubbed: the save dialog
  // reads the offered list from ORG_CONFIG, which the real server injects, so
  // the case for it covers the injection rather than a fixture.
  { match: /\/api\/views/, body: url => {
      const v = (id, name, extra) => Object.assign({
        id, name, dateMode: "current", relativeRange: null, params: "",
        fixedStart: null, fixedEnd: null, owner: null,
        createdAt: "2026-08-01T00:00:00.000Z", updatedAt: null, deletedAt: null,
      }, extra);
      const views = /\/roster\//.test(url)
        ? [v("v_camp", "Hackberry Hill", { dateMode: "relative", relativeRange: "next7",
                                           params: "section_name=Camp Blue&status=enrolled" }),
           v("v_cancels", "Cancellations", { params: "status=cancelled" })]
        : [];
      return { max: 25, views };
    } },
  // The Report Wizard's generator. Stubbed rather than reaching Anthropic (the
  // real route needs an API key and would be non-deterministic), and shaped like
  // a real reply: a summary, notes, and widgets over a source the data stub can
  // answer. The narrative cases below key off THIS payload, so a page that
  // renders the wrong field fails rather than passing on "a box appeared".
  { match: /\/report-wizard\/api\/generate/, body: () => ({
      title: "Program Revenue Overview",
      description: "Revenue and enrollment by program",
      summary: "This report ranks programs by net revenue and pairs each with its enrollment and capacity, so you can see which offerings earn and which merely fill. Each row of the programs source is one section, so a program running four sections contributes four rows.",
      notes: ["Cancelled registrations are excluded.", "Revenue is net of refunds."],
      dataSources: ["programs"],
      widgets: [
        { type: "kpi-row", items: [{ label: "Total", source: "programs", field: "Total", compute: "sum", format: "currency" }] },
        { type: "table", title: "Programs", source: "programs",
          columns: [{ field: "Facility", label: "Program" }, { field: "Total", label: "Revenue", format: "currency" }],
          sort: { field: "Total", dir: "desc" }, limit: 10 },
      ] }) },
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

// Reaching the Programs Check-Ins band. The tab is a div with an onClick, not a
// link, and the page resets `tab` to 'summary' when its data lands — so the click
// has to come after the summary has rendered.
const clickCheckinsTab = async page => {
  await page.waitForSelector(".tab", { timeout: 45000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".tab")].some(t => /Check-Ins/.test(t.textContent)),
    { timeout: 45000 });
  await page.evaluate(() => {
    const t = [...document.querySelectorAll(".tab")].find(x => /Check-Ins/.test(x.textContent));
    if (t) t.click();
  });
};

// The report-settings panel is behind a feature flag AND a super-admin key
// derived from DASHBOARD_PASSWORD (see the boot below, which sets both). Declared
// here because CASES needs it.
const RENDER_ADMIN_PW = "render-check-password";
const RENDER_ADMIN_KEY = require("crypto").createHash("sha256")
  .update(RENDER_ADMIN_PW + "|report-settings|v1").digest("hex").slice(0, 32);

// ── Pages to prove ──────────────────────────────────────────────────────────
// `needs` is a selector that only exists once the page has really rendered, so
// a blank page fails instead of passing on "no errors thrown".
const CASES = [
  { name: "facilities · camping",  path: "/{org}/facilities?tab=camping", needs: ".camp-cal .cc-hd" },

  // ── The rental schedule: add-ons in the note line, Forms in the column ────
  // This page had NO render case at all, and it is the one most orgs open.
  { name: "facility · schedule",   path: "/{org}/facility",               needs: ".data-row" },
  // A permit chip renders from the feed — this is the column Dan found empty.
  { name: "facility · permit chip", path: "/{org}/facility",               needs: ".cell.col-permit button" },
  // AND a feed that could not load must say so rather than rendering blank:
  // blank is indistinguishable from "these rentals have no permits", which is
  // exactly how a healthy report came to look broken.
  { name: "facility · failed feed is not blank", path: "/{org}/facility",
    stubMode: "feedfail", needs: ".cell.col-permit .feed-failed" },
  { name: "facility · failed forms feed too",    path: "/{org}/facility",
    stubMode: "feedfail", needs: ".cell.col-forms .feed-failed" },
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
  // The flames are individual spans so each can flicker on its own clock. A
  // static string renders the same glyphs and would pass "a flame is present",
  // so the case keys on the SPAN, and the one below proves it is actually
  // moving — getAnimations() is the only thing that can tell those apart.
  // Launching Soon leads the Overview. Asserted by DOM ORDER, not by presence:
  // both sections existed before, and "both render" passed on the old order.
  // Launching Soon leads the Overview. Asserted by DOM ORDER, not presence:
  // both sections existed before and "both render" passed on the old order.
  // Keyed on data attributes rather than scraping text — the two headings are
  // different element types, which is exactly what broke the first version.
  { name: "fasttrack · launching soon leads", path: "/{org}/fasttrack",
    needs: "body[data-launch-first=\"1\"]",
    act: async page => {
      await page.waitForSelector("[data-launch-heading]", { timeout: 45000 });
      await page.evaluate(() => {
        const soon = document.querySelector("[data-launch-heading]");
        const just = document.querySelector("[data-justlaunched-heading]");
        if (!soon) return;
        // No Just Launched in this window still proves nothing regressed.
        if (!just || (soon.compareDocumentPosition(just) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          document.body.setAttribute("data-launch-first", "1");
        }
      });
    } },
  { name: "fasttrack · pin is a real control", path: "/{org}/fasttrack",
    needs: "[data-launch-list] .pin-toggle.pin-labelled[data-pinned=\"0\"] .pin-word" },
  { name: "fasttrack · flames are spans", path: "/{org}/fasttrack",
    needs: "[data-heat=\"inferno\"] .ft-flames .ft-flame" },
  // ...and they are RUNNING, with the positions out of phase. getAnimations()
  // reads the live animation from the browser, so this fails on a flame that is
  // present but static and on a row whose flames all share a clock — neither of
  // which any source assertion can tell apart from real fire.
  // ...and they are RUNNING, each on its own clock. Deterministic on purpose:
  // the first version compared currentTime % 10, which two flames can collide
  // on by chance — it passed one run and failed the next. Computed duration is
  // stable, and "all durations distinct" IS the invariant (same-duration flames
  // drift back into sync and read as one object flashing).
  { name: "fasttrack · flames actually burn", path: "/{org}/fasttrack",
    needs: "body[data-flames-burning=\"1\"]",
    act: async page => {
      await page.waitForSelector("[data-heat=\"inferno\"] .ft-flame", { timeout: 45000 });
      await page.evaluate(() => {
        // PER ROW. Durations repeat ACROSS rows by design — every row runs the
        // same 1..n ladder — so a global uniqueness test is wrong and fails on
        // a perfectly good page (it did: 11 flames, 4 durations).
        const rows = [...document.querySelectorAll('[data-heat="inferno"] .ft-flames')];
        const ok = rows.filter(row => {
          const els = [...row.querySelectorAll(".ft-flame")];
          if (els.length < 2) return false;
          const running = els.filter(e => (e.getAnimations ? e.getAnimations() : [])
            .some(a => a.playState === "running" && a.animationName === "ftFlicker"));
          const durs = new Set(els.map(e => getComputedStyle(e).animationDuration));
          return running.length === els.length && durs.size === els.length;
        });
        if (rows.length > 0 && ok.length === rows.length) {
          document.body.setAttribute("data-flames-burning", "1");
        }
      });
    } },
  { name: "fasttrack · pre-launch beats capacity", path: "/{org}/fasttrack",
    needs: "[data-launch-list] > *:first-child[data-launch-program=\"prog-birthday\"]" },
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
  // ── Class Roster: the ePACT export ──────────────────────────────────────
  // This page had NO render case at all, and it is the one an admin runs before
  // every camp.
  { name: "roster · renders", path: "/{org}/roster", needs: ".section-hdr .sec-name" },
  // The default window. `needs` reads the toolbar's own span, so a revert to the
  // calendar month fails here — "a date input rendered" would pass on either.
  { name: "roster · 14-day default", path: "/{org}/roster", needs: ".toolbar[data-roster-days=\"14\"]" },
  // Three ePACT rows out of five enrolled feed rows for Camp Blue: Ana's two
  // same-day sessions collapse and Cass's cancellation is dropped. The COUNT is
  // the assertion — "a button rendered" passes on both regressions.
  { name: "roster · epact per section", path: "/{org}/roster",
    needs: "[data-epact-section=\"Camp Blue\"][data-epact-rows=\"3\"]" },
  { name: "roster · epact toolbar count", path: "/{org}/roster",
    needs: ".btn-epact[data-epact-rows=\"3\"]" },
  // A section with nothing but cancellations gets its header and NO button.
  // Asserted as ABSENT from the DOM: "renders a 0" and "renders nothing" are
  // different claims, and a button that produces an empty file is a dead end.
  { name: "roster · no epact where all cancelled", path: "/{org}/roster",
    needs: ".section-hdr .sec-name",
    absent: "[data-epact-section=\"Camp Cancelled\"]" },
  // The CSV itself, built by the real click path in a real browser. Every
  // source assertion in roster-epact.spec.js passes on a button wired to the
  // wrong row set; this is what proves the bytes.
  { name: "roster · epact csv is her output", path: "/{org}/roster",
    needs: "body[data-ep-hdr=\"1\"][data-ep-lines=\"3\"][data-ep-email=\"1\"][data-ep-label=\"1\"]"
         + "[data-ep-nocancel=\"1\"][data-ep-bom=\"1\"][data-ep-tsv=\"1\"]",
    act: async page => {
      await page.waitForSelector("[data-epact-section=\"Camp Blue\"]", { timeout: 45000 });
      // Stub window.open, NOT saveTextViaPopup: a headless browser has nowhere
      // to put a download, but stubbing the writer would skip the whole delivery
      // path — which is where the BOM lives. This way the case reads the bytes
      // the popup is actually handed.
      await page.evaluate(() => {
        window.__payload = null;
        window.open = () => ({
          document: { write() {}, close() {} },
          set __recExport(v) { window.__payload = v; },
          get __recExport() { return window.__payload; },
        });
      });
      await page.click("[data-epact-section=\"Camp Blue\"]");
      await page.evaluate(() => {
        const p = window.__payload;
        if (!p) return;   // the button never reached the writer at all
        const set = (k, v) => { if (v) document.body.setAttribute(k, v); };
        // Checked on the BYTES, not on a decoded string: TextDecoder strips the
        // BOM by default, so decoding first would silently pass either way — and
        // the bytes are what Excel sniffs.
        const b = p.bytes;
        set("data-ep-bom", b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? "1" : "");
        const body = new TextDecoder().decode(b);   // BOM removed by the decoder
        const lines = body.replace(/\r\n$/, "").split("\r\n");
        set("data-ep-hdr", lines[0] === "Rec ID,First Name,Last Name,Household Owner Email,Session Date - Section Name" ? "1" : "");
        document.body.setAttribute("data-ep-lines", String(lines.length - 1));
        // Her COALESCE takes the participant's own address; the owner's must not
        // appear for a participant who has one.
        set("data-ep-email", body.includes("ana@example.com") && !body.includes("parent-reyes@example.com") ? "1" : "");
        set("data-ep-label", body.includes("2026-07-06 - Camp Blue") ? "1" : "");
        set("data-ep-nocancel", body.includes("3XCANCEL") ? "" : "1");
        // The clipboard copy is TAB-separated and carries NO BOM — pasted into a
        // sheet a BOM shows up as a stray character in the first cell, and a
        // comma-separated paste drops the whole row into one column.
        set("data-ep-tsv", p.tsv
          && p.tsv.charCodeAt(0) !== 0xFEFF
          && p.tsv.split("\n")[0] === "Rec ID\tFirst Name\tLast Name\tHousehold Owner Email\tSession Date - Section Name"
          ? "1" : "");
      });
    } },

  // ── Class Roster: saved views ───────────────────────────────────────────
  // The picker lists what the feed returned. Keyed on a view NAME from the stub,
  // so a picker that renders an empty list still fails.
  { name: "roster · saved views listed", path: "/{org}/roster",
    needs: "[data-view-row=\"Hackberry Hill\"]",
    act: async page => {
      await page.waitForSelector(".btn-view", { timeout: 45000 });
      await page.click(".btn-view");
    } },
  // Applying one has to put its filters ON SCREEN and name itself in the URL.
  // "a row was clickable" would pass on an apply that did nothing.
  { name: "roster · applying a view sets its filters", path: "/{org}/roster",
    needs: "body[data-applied=\"1\"]",
    act: async page => {
      await page.waitForSelector(".btn-view", { timeout: 45000 });
      await page.click(".btn-view");
      await page.waitForSelector("[data-view-row=\"Hackberry Hill\"]", { timeout: 45000 });
      await page.click("[data-view-row=\"Hackberry Hill\"]");
      // The apply re-runs the query — a roster's section filter goes to the CARD,
      // unlike the GL report's client-side filters. Wait for that round trip.
      await page.waitForFunction(
        () => document.querySelector(".toolbar[data-roster-days=\"7\"]")
           && !document.querySelector(".btn-run .btn-spinner"),
        { timeout: 45000 });
      await page.evaluate(() => {
        const sec = document.querySelector('.toolbar input[type="text"]');
        const pill = document.querySelector(".status-pill-enrolled.active");
        const named = new URLSearchParams(window.location.search).get("view") === "v_camp";
        // next7, not next14: the view has to MOVE the window off the report's own
        // 14-day default, or a missing re-fetch would be invisible here.
        const days = document.querySelector(".toolbar").getAttribute("data-roster-days");
        // The Run button rings green while the on-screen range differs from the
        // LOADED one. No ring ⇒ the query actually re-ran for the new window.
        const run = document.querySelector(".btn-run");
        const requeried = run && getComputedStyle(run).boxShadow === "none";
        if (sec && sec.value === "Camp Blue" && pill && named && days === "7" && requeried) {
          document.body.setAttribute("data-applied", "1");
        }
      });
    } },
  // THE BUG THIS REGISTRY EXISTS FOR: the dialog's range list is injected by the
  // server, so it cannot offer something the server refuses. Asserted on the
  // FIRST option, which is also the dialog's default.
  { name: "roster · save dialog offers the server's ranges", path: "/{org}/roster",
    needs: "body[data-ranges=\"1\"]",
    act: async page => {
      await page.waitForSelector(".btn-view", { timeout: 45000 });
      // Save is disabled until something is filtered — set a filter first, the
      // way a person would. THEN WAIT for the button to actually enable: typing
      // resolves before React commits the state that enables it, and a click on
      // a disabled button is a silent no-op. Without this wait the case passed
      // in isolation and failed inside a full run, which is not a guard.
      await page.type('.toolbar input[type="text"]', "Camp");
      await page.waitForFunction(
        () => { const b = document.querySelector(".btn-save-view"); return b && !b.disabled; },
        { timeout: 45000 });
      await page.click(".btn-save-view");
      await page.waitForFunction(() => !!document.querySelector('input[type="radio"]'), { timeout: 45000 });
      await page.evaluate(() => {
        const radios = [...document.querySelectorAll('input[type="radio"]')];
        if (radios[1]) radios[1].click();     // "Save a relative range"
      });
      await page.waitForFunction(() => !!document.querySelector("select"), { timeout: 45000 });
      await page.evaluate(() => {
        const sel = document.querySelector("select");
        const opts = [...sel.options].map(o => o.value);
        // The dialog must offer EXACTLY the list the server injected — that is
        // what stops it showing a range the server would refuse to store.
        // (Whether a listed range is storable is checked in saved-views.spec.js,
        // which can read REPORT_BLOCKED_RANGES; here the point is provenance.)
        const injected = ((window.ORG_CONFIG || {}).savedViewRanges || []).map(r => r[0]);
        const sameList = injected.length > 3 && injected.join(",") === opts.join(",");
        // A roster reads forward, so the fortnight it opens on comes first. The
        // pre-SELECTED value is deliberately not asserted: updating an existing
        // relative view legitimately pre-selects that view's own range, and the
        // preceding case leaves one applied (localStorage survives between cases
        // in this check — worth knowing before adding another).
        const forwardFirst = opts[0] === "next14";
        if (sameList && forwardFirst) document.body.setAttribute("data-ranges", "1");
      });
    } },

  // ── Class Roster: the settings panel ────────────────────────────────────
  // THE DOOR FIRST. An org staffer holds a valid token — that is what the report
  // link is — and must not even see the gear. Asserted as ABSENT from the DOM
  // rather than disabled: "renders a greyed button" and "renders nothing" are
  // different claims, and only one of them keeps the power away from an org user.
  { name: "roster · no gear without the admin key", path: "/{org}/roster",
    needs: ".toolbar", absent: "[data-rs-open]" },
  // The gear sits at the far right of the toolbar (Dan: "a standard gear wheel
  // settings looking icon in the upper right corner").
  { name: "roster · settings gear is last in the toolbar", path: "/{org}/roster?admin=" + RENDER_ADMIN_KEY,
    needs: "body[data-gear-last=\"1\"]",
    act: async page => {
      await page.waitForSelector("[data-rs-open]", { timeout: 45000 });
      await page.evaluate(() => {
        const tb = document.querySelector(".toolbar");
        const gear = document.querySelector("[data-rs-open]");
        const btns = [...tb.querySelectorAll("button")];
        // Last button in the toolbar, and further right than the exports.
        const epact = document.querySelector(".btn-epact");
        const rightOfExports = !epact
          || gear.getBoundingClientRect().left > epact.getBoundingClientRect().left;
        if (btns[btns.length - 1] === gear && rightOfExports) {
          document.body.setAttribute("data-gear-last", "1");
        }
      });
    } },
  // The panel opens and carries all three groups, in blast-radius order.
  { name: "roster · settings panel opens", path: "/{org}/roster?admin=" + RENDER_ADMIN_KEY,
    needs: "[data-rs-group=\"safe\"] , [data-rs-group=\"warn\"]",
    act: async page => {
      await page.waitForSelector("[data-rs-open]", { timeout: 45000 });
      await page.click("[data-rs-open]");
      await page.waitForSelector(".rs-sheet", { timeout: 45000 });
    } },
  // The ePACT drift banner: green on the verified five, and it must flip the
  // moment a column is added. A panel that let you leave the verified template
  // silently is the one thing this group exists to prevent.
  { name: "roster · epact drift is never silent", path: "/{org}/roster?admin=" + RENDER_ADMIN_KEY,
    needs: "body[data-drift=\"1\"]",
    act: async page => {
      await page.waitForSelector("[data-rs-open]", { timeout: 45000 });
      await page.click("[data-rs-open]");
      await page.waitForSelector("[data-rs-verified]", { timeout: 45000 });
      const before = await page.$eval("[data-rs-verified]", el => el.getAttribute("data-rs-verified"));
      await page.select("[data-rs-epact-add]", "Age");
      await page.waitForFunction(
        () => document.querySelector("[data-rs-verified]")?.getAttribute("data-rs-verified") === "0",
        { timeout: 45000 });
      const after = await page.$eval("[data-rs-verified]", el => el.textContent);
      await page.evaluate(([b, a]) => {
        if (b === "1" && /no longer the Apex-verified/.test(a)) document.body.setAttribute("data-drift", "1");
      }, [before, after]);
    } },
  // The cache dial prices itself: the shared-card total has to MOVE, or the
  // guardrail is a caption nobody reads.
  { name: "roster · cache dial shows what it costs", path: "/{org}/roster?admin=" + RENDER_ADMIN_KEY,
    needs: "body[data-priced=\"1\"]",
    act: async page => {
      await page.waitForSelector("[data-rs-open]", { timeout: 45000 });
      await page.click("[data-rs-open]");
      await page.waitForSelector("[data-rs-cost]", { timeout: 45000 });
      const at2h = await page.$eval("[data-rs-cost]", el => el.getAttribute("data-rs-cost"));
      // Driven by the KEYBOARD rather than by assigning .value: React tracks a
      // controlled input's value internally, so a direct assignment plus a
      // synthetic event is ignored and the case would fail on a working dial.
      // Three steps left is 2 hours → 30 minutes, the floor.
      await page.focus(".rs-meter input[type=range]");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(
        (was) => document.querySelector("[data-rs-cost]")?.getAttribute("data-rs-cost") !== was,
        { timeout: 45000 }, at2h);
      await page.evaluate((was) => {
        const now = Number(document.querySelector("[data-rs-cost]").getAttribute("data-rs-cost"));
        // A shorter cache must cost MORE, not just differently.
        if (now > Number(was)) document.body.setAttribute("data-priced", "1");
      }, at2h);
    } },

  // SIGN IN, THEN NAVIGATE — the flow Dan actually used, and the one that was
  // broken: basic auth is scoped to "/" by the browser, so nothing carried the
  // credential to a report and the gear could only be reached by pasting a key
  // onto the URL. No ?admin= on this path; the cookie is the whole test.
  { name: "roster · signed in, then navigated", path: "/{org}/roster",
    needs: "[data-rs-open]",
    pre: async page => {
      await page.setCookie({ name: "rs_admin", value: RENDER_ADMIN_KEY,
                             domain: "127.0.0.1", path: "/" });
    } },

  // Flag off, credential good. Absent-not-greyed is right for someone who may
  // never hold the control; for a proven super-admin it is a dead end with no
  // exit — which is exactly how "not seeing it" got reported. Runs LAST of the
  // settings cases and restores the flag in a finally, because the flag is
  // server state every earlier case depends on.
  { name: "roster · flag off says where the switch is", path: "/{org}/roster?admin=" + RENDER_ADMIN_KEY,
    needs: "[data-rs-flagoff]", absent: "[data-rs-open]",
    pre: async page => {
      await page.setCookie({ name: "rs_admin", value: RENDER_ADMIN_KEY,
                             domain: "127.0.0.1", path: "/" });
    },
    act: async page => {
      // Flipped from NODE, not from the page: every /api/ request the browser
      // makes is intercepted and answered from STUBS, so an in-page fetch would
      // return a stub and never reach the server.
      const flip = (v) => new Promise((res, rej) => {
        const body = JSON.stringify({ password: RENDER_ADMIN_PW, key: "reportSettings", value: v });
        const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST",
          path: "/api/admin/flags", headers: { "Content-Type": "application/json" } },
          r => { r.resume(); r.on("end", res); });
        req.on("error", rej);
        req.end(body);
      });
      await flip(false);
      await page.reload({ waitUntil: "domcontentloaded" });
      try {
        await page.waitForSelector("[data-rs-flagoff]", { timeout: 45000 });
      } finally {
        await flip(true);
      }
    } },

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
  // ── Fast Track section (Dan, 2026-08-26: "lets add that to the current
  // directors report"). The section had NO render coverage before this.
  { name: "directors · fast track section", path: "/{org}/directors-report", needs: "[data-dir-ft]" },
  // The capacity-aware rate leads, not the of-signups one. Both are in the
  // fixture and they differ, so this fails if the wrong one is promoted.
  { name: "directors · ft conversion denominator", path: "/{org}/directors-report",
    needs: "[data-ft-conv=\"90.5\"]" },
  // An assumed figure must be visibly assumed. 219 x 2min = 7.3h.
  { name: "directors · ft hours marked assumed", path: "/{org}/directors-report",
    needs: ".ft-assumed[data-ft-hours=\"7.3\"]" },
  { name: "directors · ft quarter delta", path: "/{org}/directors-report",
    needs: "[data-ft-delta=\"signups\"]" },
  { name: "directors · fields panel",  path: "/{org}/directors-report", needs: "[data-dr-fields]" },
  // The hub's verticals are two clicks deep behind a card that just says
  // "Facilities". The chips are how Fields and Outdoor Events are findable at
  // all from the org landing page.
  // THE WIZARD IS DISABLED FOR EVERY ORG (Dan: "they should not be able to see or
  // click it"). Asserted as ABSENT FROM THE DOM, because org.html builds its
  // cards client-side — the card BUILDER is in the served JS on every load, so
  // grepping the HTML proves nothing. Only a browser can say the card is not
  // there. Note this case runs against a server that ENABLES the wizard for its
  // routes (see WIZARD_ENABLED_ORGS above), so it is the RETIRED_REPORTS half
  // being proved here, which is the half a reader actually sees.
  { name: "org landing · no wizard card", path: "/{org}",
    needs: ".card", absent: 'a.card[href*="/report-wizard"]' },

  { name: "org landing · hub tab chips", path: "/{org}",
    needs: ".card-tab[href*=\"tab=fields\"]" },
  { name: "org landing · checkins chip", path: "/{org}",
    needs: ".card-tab[href*=\"tab=checkins\"]" },
  // Programs and Community Intel chips (Dan: "roll that out for the programs
  // report and the community intelligence report cards too"). Keyed on the HREF,
  // so a chip pointing at the wrong tab fails rather than "a chip rendered".
  { name: "org landing · programs chips", path: "/{org}",
    needs: ".card-tab[href*=\"/programs?\"][href*=\"tab=fillrate\"]" },
  { name: "org landing · community intel chips", path: "/{org}",
    needs: ".card-tab[href*=\"/users?\"][href*=\"tab=strategy\"]" },
  { name: "org landing · fast track chips", path: "/{org}",
    needs: ".card-tab[href*=\"/fasttrack?\"][href*=\"tab=conversions\"]" },

  // AND THE LINKS HAVE TO LAND. A chip is a link, and both pages were unable to
  // honour one: programs read ?tab= into initial state and then fetchData()
  // destroyed it on mount, and users.html never read it at all. Keyed on the
  // ACTIVE tab, because the page renders a tab strip either way — landing on the
  // wrong tab looks identical to landing on the right one unless you check which
  // is lit.
  { name: "programs · deep link lands on the tab", path: "/{org}/programs?tab=fillrate",
    needs: ".tab.active", act: async page => {
      await page.waitForFunction(
        () => /Fill Rate/.test(document.querySelector(".tab.active")?.textContent || ""),
        { timeout: 45000 });
    } },
  // The lazy feed too: Participants with demoRows null and demoLoading false
  // renders NOTHING, so "the tab is active" is not enough — something from the
  // feed has to appear.
  { name: "programs · deep link fetches its feed", path: "/{org}/programs?tab=participants",
    needs: ".summary-cards .card-value" },
  // An unknown tab must not leave a blank body under the strip.
  { name: "programs · unknown tab falls back", path: "/{org}/programs?tab=nonsense",
    needs: ".tab.active", act: async page => {
      await page.waitForFunction(
        () => /Summary/.test(document.querySelector(".tab.active")?.textContent || ""),
        { timeout: 45000 });
    } },
  { name: "users · deep link lands on the tab", path: "/{org}/users?tab=strategy",
    needs: ".tab.active", act: async page => {
      await page.waitForFunction(
        () => /Strategy/.test(document.querySelector(".tab.active")?.textContent || ""),
        { timeout: 45000 });
    } },
  // Guests renders only when the feed has guests, and the feed has not answered
  // at mount — so the URL must not be able to strand a reader on a blank tab.
  { name: "users · guests is not a URL destination", path: "/{org}/users?tab=guests",
    needs: ".tab.active", act: async page => {
      await page.waitForFunction(
        () => /Demographics/.test(document.querySelector(".tab.active")?.textContent || ""),
        { timeout: 45000 });
    } },

  /* Fast Track's chips. Keyed on WHICH tab is LIT, not on "a tab strip
     rendered" — landing on the wrong tab looks identical otherwise, and that is
     exactly what the page did before it read ?tab=. `.tab-btn.active` is the
     Fast Track strip's own class. */
  { name: "fasttrack · deep link lands on the tab", path: "/{org}/fasttrack?tab=conversions",
    needs: ".tab-btn.active", act: async page => {
      await page.waitForFunction(
        () => /Conversions/.test(document.querySelector(".tab-btn.active")?.textContent || ""),
        { timeout: 45000 });
    } },
  // The lazy feed too. Revenue/Conversions/Demographics all read the Community
  // Intel feed and only switchTab asked for it, so a deep link used to land on a
  // permanently empty body — "the tab is lit" is not enough.
  // Asserted on the browser's own resource timeline rather than on rendered
  // text: the harness answers /users/api/data from a generic stub, so the panel
  // looks much the same either way — what actually regressed is that the
  // REQUEST was never made. Reverting the mount effect leaves this entry absent.
  { name: "fasttrack · deep link fetches its feed", path: "/{org}/fasttrack?tab=demographics",
    needs: "body[data-ft-feed-ok=\"1\"]", act: async page => {
      await page.waitForFunction(
        () => /Demographics/.test(document.querySelector(".tab-btn.active")?.textContent || ""),
        { timeout: 45000 });
      await page.waitForFunction(
        () => performance.getEntriesByType("resource")
                .some(e => /\/users\/api\/data/.test(e.name)),
        { timeout: 45000 });
      await page.evaluate(() => document.body.setAttribute("data-ft-feed-ok", "1"));
    } },
  // An unknown tab must fall back rather than blanking the body.
  { name: "fasttrack · unknown tab falls back", path: "/{org}/fasttrack?tab=nonsense",
    needs: ".tab-btn.active", act: async page => {
      await page.waitForFunction(
        () => /Overview/.test(document.querySelector(".tab-btn.active")?.textContent || ""),
        { timeout: 45000 });
    } },
  /* THE WRITE-BACK MUST NOT DESTROY THE LINK IT JUST HONOURED. The share-link
     effect rebuilds the whole query string and runs on mount; before this change
     it carried only token/season/search, so ?tab= survived being read and was
     erased a millisecond later. Asserting the URL still says conversions after
     the page settles is the only way to see that — the tab would be lit either
     way on the very first paint. */
  { name: "fasttrack · deep link survives the write-back", path: "/{org}/fasttrack?tab=conversions",
    needs: "body[data-ft-url-ok=\"1\"]", act: async page => {
      await page.waitForFunction(
        () => /Conversions/.test(document.querySelector(".tab-btn.active")?.textContent || ""),
        { timeout: 45000 });
      await new Promise(r => setTimeout(r, 1200));   // let the effect run
      await page.evaluate(() => {
        const t = new URLSearchParams(window.location.search).get("tab");
        const lit = document.querySelector(".tab-btn.active")?.textContent || "";
        if (t === "conversions" && /Conversions/.test(lit)) {
          document.body.setAttribute("data-ft-url-ok", "1");
        }
      });
    } },
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
  // ── Report Wizard ──────────────────────────────────────────────────────────
  // The build screen. The quick-prompt chips are what makes it usable, so the
  // selector is one of them rather than the panel: a panel with no chips renders
  // just as happily.
  { name: "wizard · build screen", path: "/{org}/report-wizard",           needs: ".prompt-panel .example-chip" },
  // The placeholder has to actually TYPE. `data-rw-typed="1"` flips only once a
  // character has been written into it, so "a textarea rendered" — which passes
  // on a dead animation — is not enough.
  { name: "wizard · typed placeholder", path: "/{org}/report-wizard",      needs: "#rwPrompt[data-rw-typed=\"1\"]" },
  // Generate a report and prove the write-up rendered. `act` drives the click,
  // and the generate POST is answered by the stub above.
  { name: "wizard · report write-up", path: "/{org}/report-wizard",        needs: "[data-rw-summary]",
    act: async page => { await page.click(".example-chip"); await page.click(".btn-generate"); } },
  // The GROUNDED half, and the half that can carry a number: the row count comes
  // from the rows that actually arrived, not from the model. Keyed to the source
  // the stub declares, so a page that prints the widget's source or a hardcoded
  // name fails.
  { name: "wizard · built-from line", path: "/{org}/report-wizard",        needs: "[data-rw-grain=\"programs\"]",
    act: async page => { await page.click(".example-chip"); await page.click(".btn-generate"); } },
  { name: "wizard · caveat notes",    path: "/{org}/report-wizard",        needs: "[data-rw-note]",
    act: async page => { await page.click(".example-chip"); await page.click(".btn-generate"); } },
  // The date window the feed covers. Keyed on the FORMATTED string, because the
  // formatting is where the bug lives: new Date("2026-08-19") is UTC midnight and
  // renders as Aug 18 in every US timezone. A report with no period on it is not
  // a document a finance office can check, which is how this was found.
  // ── Programs · Check-Ins band ──────────────────────────────────────────────
  // This page had no render case at all before 2026-08-26.
  // fetchData() calls setTab('summary') on mount, so ?tab=checkins is overridden
  // and the band can only be reached by clicking — which is what `act` is for.
  { name: "programs · check-ins band", path: "/{org}/programs", needs: "[data-ci-checkins-total=\"50\"]", act: clickCheckinsTab },
  // The Absent column, keyed to a section's own figure — 4 marks on sec-aq-1.
  // "a column rendered" would pass on a column of zeros, which is the failure
  // mode when the feed's Absent is read as a number instead of as maybe-absent.
  { name: "programs · absent column",  path: "/{org}/programs", needs: "[data-ci-absent=\"4\"]", act: clickCheckinsTab },
  // Undone marks must not count: 6 total marks across the fixture, 6 surviving,
  // and the tile is the sum the SQL's latest-wins rule produces.
  { name: "programs · absent total",   path: "/{org}/programs", needs: "[data-ci-absent-total=\"6\"]", act: clickCheckinsTab },
  // And against a feed with NO Absent column — every warm cache entry, until the
  // card ships — the band must render its old self rather than a wall of dashes
  // or a confident zero. Asserting the total is ABSENT from the DOM.
  { name: "programs · absent column hidden pre-card", path: "/{org}/programs",
    stubMode: "noabsent", needs: "[data-ci-checkins-total=\"50\"]", absent: "[data-ci-absent-total]", act: clickCheckinsTab },
  // ── Memberships · failed check-ins ─────────────────────────────────────────
  // 9 successes + 2 denials in the fixture. The tile reads 2; Total Check-Ins
  // must still read 9, or denials are being counted as attendance.
  { name: "memberships · failed tile", path: "/{org}/memberships?tab=checkins", needs: "[data-ci-failed=\"2\"]" },
  { name: "memberships · failures excluded from total", path: "/{org}/memberships?tab=checkins",
    needs: "[data-ci-total=\"9\"]" },
  // The two denials sit on different desks, so picking one must move the tile.
  { name: "memberships · failed scoped to desk", path: "/{org}/memberships?tab=checkins&ci_loc=South%20Desk",
    needs: "[data-ci-failed=\"1\"]" },
  // ── The refused-scan list (Dan: "no failed? need a way to filter failed
  // memberships here"). The tile was a count with nowhere to go.
  //
  // Driven through the TILE, because the tile being the way in is the fix. The
  // toggle is asserted separately below.
  { name: "memberships · failed list via tile", path: "/{org}/memberships?tab=checkins",
    needs: "[data-ci-list-set=\"failed\"]",
    act: async page => {
      await page.waitForSelector("[data-ci-failed-tile=\"clickable\"]", { timeout: 45000 });
      await page.click("[data-ci-failed-tile=\"clickable\"]");
    } },
  // ...and the list really holds the 2 denials, not the 9 successes. Keyed on the
  // row count so a title that flips while the rows do not still fails.
  { name: "memberships · failed rows", path: "/{org}/memberships?tab=checkins&ci_rows=failed",
    needs: "[data-ci-row=\"failed\"]:nth-of-type(2)",
    absent: "[data-ci-row=\"failed\"]:nth-of-type(3)" },
  { name: "memberships · failed note", path: "/{org}/memberships?tab=checkins&ci_rows=failed",
    needs: "[data-ci-failed-note=\"1\"]" },
  // The toggle exists where there are failures...
  { name: "memberships · rowset toggle", path: "/{org}/memberships?tab=checkins",
    needs: "[data-ci-rowset-toggle] [data-ci-rowset=\"failed\"]" },
  // ...and is ABSENT on a feed with none, rather than a button leading nowhere.
  // "renders a disabled button" and "renders nothing" are different claims.
  { name: "memberships · no toggle without failures", path: "/{org}/memberships?tab=checkins",
    stubMode: "nofail", needs: "[data-ci-total=\"9\"]", absent: "[data-ci-rowset-toggle]" },
  // THE STRAND. A ci_rows=failed link into a window with no failures must land
  // on the accepted list, not an empty table whose toggle is gone.
  // ── Auto-Renew and Sales & Mix (card 17301 v2) ──────────────────────────
  // Keyed on COMPUTED VALUES, not on "a panel rendered": every one of these
  // passes on a tab that renders the wrong number.
  { name: "memberships · auto-renew count", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-count=\"4\"]" },
  { name: "memberships · auto-renew monthly revenue", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-mrr=\"79\"]" },
  // Only the annual plan qualifies: it is open-ended and renewing by hand. The
  // six season passes must NOT be here — a season pass expiring is the season
  // closing, and offering it as a conversion candidate sends an admin chasing
  // churn that does not exist.
  { name: "memberships · season passes are not conversion candidates", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-cands=\"1\"]" },
  { name: "memberships · auto-renew is per plan", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-plan=\"Monthly Individual\"] [data-ar-plan-pct=\"100\"]" },
  { name: "memberships · season plan reads 0% auto-renew", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-plan=\"Summer Season Pass\"] [data-ar-plan-pct=\"0\"]" },
  // A pre-v2 cache entry still knows WHO auto-renews (from Renewal Type), so the
  // count must be identical across both feed shapes — the cache invariant. What
  // it cannot know is the billing cycle, so the monthly figure hides rather than
  // rendering a $0 that would read as "this org earns nothing".
  { name: "memberships · auto-renew count survives a pre-v2 feed", path: "/{org}/memberships?tab=autorenew",
    stubMode: "prev2", needs: "[data-ar-count=\"4\"]" },
  { name: "memberships · no invented monthly on a pre-v2 feed", path: "/{org}/memberships?tab=autorenew",
    stubMode: "prev2", needs: "[data-ar-pending=\"1\"]", absent: "[data-ar-mrr]" },
  // Without the plan columns the shape is unknown, so nothing may be offered as
  // a conversion candidate — guessing "open-ended" would file every season pass
  // as churn.
  { name: "memberships · no candidates guessed without plan terms", path: "/{org}/memberships?tab=autorenew",
    stubMode: "prev2", needs: "[data-ar-cands=\"0\"]" },

  // Jun (4 units / $80) → Jul (1 unit / $240): units DOWN, revenue UP, and the
  // whole move is price. A revenue line alone would read as growth; a unit line
  // alone as collapse. Both parts are asserted because the bridge must sum.
  { name: "memberships · sales decomposition", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-decomp] [data-sm-volume=\"-60\"]" },
  { name: "memberships · price half of the bridge", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-decomp] [data-sm-price=\"220\"]" },
  { name: "memberships · units fell", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-unit-delta=\"-3\"]" },
  { name: "memberships · revenue rose in the same month", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-rev-delta=\"160\"]" },
  { name: "memberships · plan mix ranks by units", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-plan=\"Summer Season Pass\"] [data-sm-plan-units=\"6\"]" },
  { name: "memberships · the unpopular annual is on the table", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-plan=\"Annual Individual\"] [data-sm-plan-units=\"1\"]" },

  { name: "memberships · failed link cannot strand", path: "/{org}/memberships?tab=checkins&ci_rows=failed",
    stubMode: "nofail", needs: "[data-ci-list-set=\"ok\"]" },
  // A window where every scan failed: the reader used to be told "11 scans were
  // turned away" with no table under it, because the aggregates never render.
  { name: "memberships · failures only shows the list", path: "/{org}/memberships?tab=checkins",
    stubMode: "failonly", needs: "[data-ci-list-set=\"failed\"]" },
  { name: "memberships · failures only has rows", path: "/{org}/memberships?tab=checkins",
    stubMode: "failonly", needs: "[data-ci-row=\"failed\"]:nth-of-type(11)" },
  // ...and no toggle there, because there is nothing to switch back to.
  { name: "memberships · failures only hides the toggle", path: "/{org}/memberships?tab=checkins",
    stubMode: "failonly", needs: "[data-ci-list-set=\"failed\"]", absent: "[data-ci-rowset-toggle]" },
  // ── Money left on the table for want of capacity, and the Conversions tab
  // finally showing early-access sections (Dan, 2026-08-27).
  //
  // 925 is the fixture's over-demand (62 holds - 25 seats at $25). Left on Table
  // carries the sentinel 999999, so a card reading the wrong column fails here
  // instead of rendering a plausible number.
  { name: "fasttrack · launch card blocked revenue", path: "/{org}/fasttrack",
    needs: "[data-blocked-rev=\"925\"]",
    absent: "[data-blocked-rev=\"999999\"]" },
  // THE BUG DAN HIT: the section is in early access, the card calls it
  // 'pipeline', and the tab filtered it out — so clicking through landed on a
  // tab that did not contain it. #aq-<id> is the scroll target jumpToConversions
  // looks for, so its presence IS "you can find the section".
  // SPACING. Dan: "small fix on the FT cards, see the spacing issues" — the fifth
  // stat squeezed the row, clipping "$39,025" to "$3" and breaking a two-word
  // label over three lines. Only a browser can measure this: it is not a value
  // being wrong, it is a box being too small for the text inside it. Driven at a
  // NARROW viewport, because the cards are a min-240px auto-fill grid and the
  // bug only appears once they are actually narrow.
  { name: "fasttrack · launch card stats do not clip", path: "/{org}/fasttrack",
    needs: "body[data-stats-fit=\"1\"]", viewport: { width: 900, height: 1200 },
    act: async page => {
      await page.waitForSelector(".launch-stat .ls-v", { timeout: 45000 });
      await page.evaluate(() => {
        const bad = [];
        document.querySelectorAll(".launch-stat").forEach(st => {
          const v = st.querySelector(".ls-v"), l = st.querySelector(".ls-l");
          [v, l].forEach(el => {
            if (!el) return;
            // horizontal clipping: the text is wider than the box showing it
            if (el.scrollWidth > el.clientWidth + 1) bad.push("clipped: " + el.textContent.trim());
            // a label that wrapped: taller than one line of its own font
            const lh = parseFloat(getComputedStyle(el).fontSize) * 2.2;
            if (el.getBoundingClientRect().height > lh) bad.push("wrapped: " + el.textContent.trim());
          });
        });
        // ...and no card may overflow its own grid column.
        document.querySelectorAll(".launch-card").forEach(c => {
          if (c.scrollWidth > c.clientWidth + 1) bad.push("card overflows");
        });
        if (!bad.length) document.body.setAttribute("data-stats-fit", "1");
        else console.error("STATS DO NOT FIT: " + bad.slice(0, 6).join(" | "));
      });
    } },
  { name: "fasttrack · conversions finds early-access section", path: "/{org}/fasttrack",
    needs: "#aq-sec-premier-early",
    act: async page => {
      await page.waitForSelector(".tab-btn", { timeout: 45000 });
      await page.evaluate(() => {
        const t = [...document.querySelectorAll(".tab-btn")].find(b => /Conversion/i.test(b.textContent));
        if (t) t.click();
      });
      await new Promise(r => setTimeout(r, 2200));  // switchTab shows a ~1.5s loader
    } },
  { name: "fasttrack · conversions missed-revenue KPI", path: "/{org}/fasttrack",
    needs: "[data-conv-blocked=\"925\"]",
    act: async page => {
      await page.waitForSelector(".tab-btn", { timeout: 45000 });
      await page.evaluate(() => {
        const t = [...document.querySelectorAll(".tab-btn")].find(b => /Conversion/i.test(b.textContent));
        if (t) t.click();
      });
      await new Promise(r => setTimeout(r, 2200));
    } },
  /* EARLY ACCESS IS ITS OWN LABEL, and both feed shapes must print it.
     Dan: "A new label, I like 'Early Access' if one group can register but
     others cant."

     The case asserts THREE things a source check cannot: that the pre-v18 row
     (Reg Status 'pipeline' + an open early window) and the v18 row (Reg Status
     'early-access') land on the SAME label — the cache invariant, end to end —
     that both rows are on the tab at all, and that a genuinely closed section
     still reads Closed. Keyed on the resolved status via data-conv-status
     rather than on the text, so a relabel fails in the spec and a MIS-resolve
     fails here. Before this change the cell printed "Open" for both rows, which
     is what makes the assertion discriminating rather than decorative. */
  { name: "fasttrack · early access has its own label", path: "/{org}/fasttrack",
    needs: "body[data-ea-ok=\"1\"]",
    act: async page => {
      await page.waitForSelector(".tab-btn", { timeout: 45000 });
      await page.evaluate(() => {
        const t = [...document.querySelectorAll(".tab-btn")].find(b => /Conversion/i.test(b.textContent));
        if (t) t.click();
      });
      await new Promise(r => setTimeout(r, 2200));
      await page.evaluate(() => {
        // The status cell is in the Conversion Detail TABLE. `#aq-<id>` is the
        // FLOW CARD's id — querying that finds no cell and the case would fail
        // on a perfectly good page.
        const cell = id => {
          const row = document.querySelector("[data-conv-row='" + id + "']");
          return row && row.querySelector("[data-conv-status]");
        };
        const pre = cell("sec-premier-early");        // 'pipeline' + open early window
        const v18 = cell("sec-premier-early-v18");    // the card's own 'early-access'
        const closed = [...document.querySelectorAll("[data-conv-status='closed']")];
        if (pre && v18 &&
            pre.dataset.convStatus === "early-access" &&
            v18.dataset.convStatus === "early-access" &&
            pre.textContent.trim() === "Early Access" &&
            v18.textContent.trim() === pre.textContent.trim() &&
            closed.length > 0) {
          document.body.setAttribute("data-ea-ok", "1");
        }
      });
    } },
  // Most recently launched first. sec-tiny opened ~30 min ago, sec-premier-early
  // a day ago, so tiny leads — and asserting the FIRST card is what makes this
  // about order rather than mere presence.
  { name: "fasttrack · conversions most recent first", path: "/{org}/fasttrack",
    needs: "body[data-flow-order-ok=\"1\"]",
    act: async page => {
      await page.waitForSelector(".tab-btn", { timeout: 45000 });
      await page.evaluate(() => {
        const t = [...document.querySelectorAll(".tab-btn")].find(b => /Conversion/i.test(b.textContent));
        if (t) t.click();
      });
      await new Promise(r => setTimeout(r, 2200));
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll("[data-flow-section]")];
        if (cards.length >= 2 && cards[0].dataset.flowSection === "sec-tiny") {
          document.body.setAttribute("data-flow-order-ok", "1");
        }
      });
    } },
  { name: "wizard · feed date window", path: "/{org}/report-wizard",
    needs: "[data-rw-window=\"Aug 19 \u2013 Aug 26\"]",
    act: async page => { await page.click(".example-chip"); await page.click(".btn-generate"); } },
];

// The report-settings panel is behind TWO gates: a feature flag (default off)
// and a super-admin key derived from DASHBOARD_PASSWORD. So this check boots
// with a password and pre-enables the flag — otherwise the gear does not render
// and the panel cases would be testing the closed door rather than the panel.
// One case deliberately drops the key, to prove the door.
try {
  fs.writeFileSync(path.join(dataDir, "feature-flags.json"),
                   JSON.stringify({ reportSettings: true }));
} catch (_) {}

const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
         METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "", SLACK_WEBHOOK_URL: "",
         DASHBOARD_PASSWORD: RENDER_ADMIN_PW,
         // The Report Wizard is DISABLED for every org in production. Its six
         // render cases still have to run — a switched-off feature whose guards
         // stop running comes back broken — so this server enables it. `org` is
         // resolved after the spawn, hence the slug list read from server.js.
         WIZARD_ENABLED_ORGS: (() => {
           try {
             const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
             const i = src.indexOf("const ORGS = {");
             const j = src.indexOf("\nconst REPORT_TYPES", i);
             return Object.keys(require("vm").runInNewContext(
               "(" + src.slice(src.indexOf("{", i), j).trim().replace(/;$/, "") + ")")).join(",");
           } catch (_) { return ""; }
         })() },
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
    // Per-case viewport: a layout bug that only appears in a narrow column
    // cannot be reproduced at the default width.
    await page.setViewport(c.viewport || { width: 1280, height: 1000 });
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

    STUB_MODE = c.stubMode || "";
    // Optional: set up the BROWSER before the first navigation. A cookie set in
    // `act` is set too late — the page it decides has already been served.
    if (c.pre) await c.pre(page);
    const url = `http://127.0.0.1:${PORT}` + c.path.replace("{org}", org)
      + (c.path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    let found = false, bodyLen = 0;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      // Optional: drive the page before asserting. Some states are only reachable
      // by interacting (the wizard's report screen exists only after a Generate
      // click), and a case that cannot reach them can only ever prove the
      // landing screen renders.
      if (c.act) {
        await page.waitForSelector(".prompt-panel, .toolbar, .card", { timeout: PAGE_TIMEOUT_MS });
        await c.act(page);
      }
      try { await page.waitForSelector(c.needs, { timeout: PAGE_TIMEOUT_MS }); found = true; } catch (_) {}
      // `absent` asserts a selector is NOT in the DOM. Needed for the cases that
      // prove a figure is HIDDEN rather than zeroed — "renders a 0" and "renders
      // nothing" are different claims and only one of them is honest when the
      // feed cannot answer.
      if (found && c.absent) {
        const stillThere = await page.$(c.absent);
        if (stillThere) { found = false; errs.push('"' + c.absent + '" should NOT be present, but it is'); }
      }
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
