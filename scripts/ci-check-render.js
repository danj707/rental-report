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
    // STATUS IS NOT OPTIONAL, and leaving it off is why the three lane cases
    // failed while the outdoor and field ones passed on the same rows. Card
    // 17294 always emits it, and AquaticsView scopes on
    // `statusSel.has(lc(r['Status']))` — so an undefined Status reads as "" ,
    // matches no chip, and every lane row is dropped before the panel ever
    // computes an hour. The tab then renders its "no bookings in this range"
    // empty state, which looks exactly like a blank page in the check output.
    // The outdoor and field views do not apply the status filter, so the same
    // missing field was invisible there.
    "Status": "Confirmed",
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
  // ── Swim lanes, typed `court` and named with no pool/swim word ──────────
  // This is El Segundo's real shape: the lanes only reach the Aquatics tab if
  // refineSiteType's lane branch recovers them from the LOCATION, and the panel
  // only counts them if it refines BEFORE filtering. A fixture typed 'pool'
  // would pass on the broken build and prove nothing.
  push("North Lane 1 - A", "court", "Wiseburn Aquatic Center", d(9), "06:00am", "09:00am", 1, 1, "", 90, 8);
  push("North Lane 1 - A", "court", "Wiseburn Aquatic Center", d(8), "06:00am", "09:00am", 1, 1, "", 90, 8);
  push("North Lane 2 - B", "court", "Wiseburn Aquatic Center", d(8), "06:00am", "08:00am", 1, 1, "", 60, 6);
  // A road-named court at a NON-aquatic location — must stay a court.
  push("Johnson Lane Tennis Court", "court", "Johnson Lane Park", d(8), "06:00am", "09:00am", 1, 1, "", 90, 4);
  // ── A court-typed lane with NO aquatic word anywhere ────────────────────
  // The three rows above are recovered by refineSiteType's NAME branch, because
  // the fixture builds Facility as "<location> - <site>" and their location says
  // "Aquatic". That makes them useless for testing the per-org scope: they reach
  // the tab either way. THIS one is the discriminating row — nothing in its name
  // or its location is aquatic, so it counts only when the org has configured
  // `court` as an aquatics type. 2h.
  push("Lap Lane 7", "court", "Wiseburn Center", d(8), "06:00am", "08:00am", 1, 1, "", 40, 4);
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
  /* ── Needham's shape: SAME DAY, DIFFERENT TIMES ─────────────────────────
     Measured on production 2026-08-31. Three of Needham's programs go live
     Sep 2 09:00 ET on their early-access windows; Adult Badminton — carrying 19
     fast-trackers against their 4, 4 and 2 — goes live Sep 2 12:00 ET on its
     general one, three hours later. Launching Soon sorts on the go-live INSTANT
     with headcount only as a tie-break, so Badminton correctly ranks BELOW the
     smaller cohorts — but every chip printed calendar days, so all four read
     "OPENS IN 2 DAYS" and the ordering looked arbitrary. Dan read it as a broken
     sort, which is the only thing the screen let him conclude.

     THE HOURS ARE PINNED TO A LOCAL CALENDAR DAY, not derived from `iso()`.
     iso(2.125) is "now plus two and an eighth days", so what calendar day it
     lands on — and whether the two rows even share one — depends on the hour the
     check happens to run at. Two instants that stopped sharing a day would make
     this fixture prove something else entirely, silently.

     The pair opens LATER than Birthday Concert's Select Table (~15 min out), so
     `pre-launch beats capacity` still owns first place. */
  const atLocalHour = (daysAhead, hour) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const needham = (program, id, section, ft, cap, hour, kind) =>
    Object.assign(table(section, ft, ft, cap, 2), {
      "Program": program, "Program ID": id,
      "Section ID": "sec-" + id + "-" + section.replace(/\W+/g, "-").toLowerCase(),
      // `kind: early` mirrors the senior programs (an early window that opens
      // first, general a week later); `general` mirrors Badminton, which has NO
      // early window at all — that difference is why the two instants differ.
      "Early Access Opens": kind === "early" ? atLocalHour(2, hour) : null,
      "Reg Opens": kind === "early" ? atLocalHour(9, 12) : atLocalHour(2, hour),
    });
  /* ── ft_booking rows: the people who fast-tracked ───────────────────────
     ESSEX JUNCTION'S REAL SHAPE, measured 2026-09-01. A per-session vacation
     camp over 9 days makes one hold per child per DAY, and one of the accounts
     carries TWO children — which is exactly why the export is per PARTICIPANT
     and the section badge (which counts ACCOUNTS) cannot answer "who".
     Alyssa Callan holds 3 across two kids; the badge says 2 people and the CSV
     has to say 3 rows.

     Attached to sec-premier-early, a launched section on the Overview flow
     board, so the CSV button is reachable without navigating a tab. */
  const ftBooking = (account, email, participant, status, day, secId) => ({
    "Row Type": "ft_booking", "Season": "Fall",
    "Program": "Concert Series", "Section": "Premier Table Early", "Reg Mode": "per-session",
    "Section ID": secId || "sec-premier-early", "Org ID": "org-1", "Program ID": "prog-concert",
    "User ID": "acct-" + account.toLowerCase().replace(/\W+/g, "-"),
    "User Name": account, "User Email": email,
    "Participant Name": participant, "FT Status": status,
    "Signup Date": "2026-08-" + String(day).padStart(2, "0"),
  });
  const ftBookings = [
    ftBooking("Aislyn Allen", "allenaislynm@gmail.com", "Carter Allen", "Pending", 12),
    ftBooking("Aislyn Allen", "allenaislynm@gmail.com", "Carter Allen", "Pending", 11),
    ftBooking("Aislyn Allen", "allenaislynm@gmail.com", "Carter Allen", "Pending", 14),
    // TWO CHILDREN ON ONE ACCOUNT — the row the badge hides.
    ftBooking("Alyssa Callan", "acallan@ejrp.org", "Layla Callan", "Converted", 13),
    ftBooking("Alyssa Callan", "acallan@ejrp.org", "Layla Callan", "Pending", 13),
    ftBooking("Alyssa Callan", "acallan@ejrp.org", "Tiger Callan", "Pending", 13),
    // A DIFFERENT section's hold, so a per-section export that forgot to filter
    // exports a stranger — and the render case can see it.
    ftBooking("Wrong Section", "wrong@example.com", "Nope Nobody", "Pending", 10, "sec-tiny"),
  ];
  return [
    ...ftBookings,
    launchedSmall,
    launchedEarly,
    launchedEarlyV18,
    birthday("Select Table 45", 203, 45, 0.01),
    birthday("General Table 50", 111, 50, 1),
    birthdaySpent("Birthday Summer: June", 14, 10),
    birthdaySpent("Birthday Summer: July", 8, 6),
    // 4 FT opening 09:00 local, and 19 FT opening 12:00 local the SAME day.
    needham("Needham Senior Yoga", "prog-needham-early", "Fall 2026 Fridays", 4, 60, 9, "early"),
    needham("Needham Adult Badminton", "prog-needham-late", "2026-2027 Mondays", 19, 120, 12, "general"),
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
  // stubMode "prev7" drops the four v7 payment-plan columns, i.e. a warm
  // pre-v7 cache entry. Both shapes are live at once for four hours after the
  // card ships, so the page has to be right on either — and the pre-v7 one must
  // HIDE the card rather than render 0%.
  const V7 = STUB_MODE !== "prev7";
  // stubMode "prev8" drops the four v8 columns; "badsplit" keeps them but makes
  // them NOT add up to Outstanding, which is the one thing the breakdown must
  // refuse to hide.
  const V8 = STUB_MODE !== "prev8";
  // stubMode "previnstr" drops the instructor column — a pre-v6 cache entry, on
  // which the columns must be ABSENT rather than a row of dashes claiming
  // nobody teaches anything.
  const VINSTR = STUB_MODE !== "previnstr";
  const sec = (prog, name, sid, enrolled, capacity, season, loc, ap, out, instr, dates) => ({
    "Program": prog, "Program Id": "prog-" + prog.toLowerCase().replace(/\W+/g, "-"),
    "Section": name, "Section Id": sid, "Section Status": "Open",
    // PER-SECTION SPANS, so the by-month activity chart has a shape to find.
    // They run Jul->Dec with the overlap deliberately peaking in SEPTEMBER,
    // while the money stub peaks in AUGUST — the whole point of the panel is
    // that those two months differ, and a fixture where they coincide cannot
    // tell a correct panel from one drawing the same series twice.
    "Start Date": (dates && dates[0]) || "2026-08-01",
    "End Date":   (dates && dates[1]) || "2026-09-30",
    "Enrolled": enrolled, "Capacity": capacity, "Utilized": enrolled,
    "Charged": enrolled * 40, "Received": enrolled * 40, "Refunds": 0,
    "Activity": "Aquatics", "Category": "Fitness",
    // v6. The location filter shipped unable to render because NOTHING mapped
    // this onto a row, and no fixture carried it — so no render case could have
    // caught it either. `location` is deliberately null on one section so the
    // "No location set" option is a real option rather than a special case.
    "location": loc, "location_count": loc ? 1 : 0,
    // v6 instructor. `instr` is [name, count]; a null name is a section with
    // NOBODY on file, which at El Segundo is 155 of 286 sections and therefore
    // a real filter option rather than an edge case. sec-aq-2 carries a count
    // of 2 so the "+1" marker has something to mark.
    ...(VINSTR ? { "instructor": instr && instr[0], "instructor_count": (instr && instr[1]) || 0 } : {}),
    // v7. The two readings DISAGREE ON PURPOSE: one $2,400 auto-pay plan
    // against nineteen small manual ones is 54.5% of plan DOLLARS and 5% of
    // plan REGISTRATIONS. A card computing the wrong one renders a plausible
    // number, so only a fixture where they differ can tell them apart.
    ...(V7 ? {
      "autopay_plan_items": ap[0], "autopay_plan_value": ap[1],
      "manual_plan_items":  ap[2], "manual_plan_value":  ap[3],
    } : {}),
    // v8. `out` is [outstanding, past due, scheduled on auto-pay, scheduled
    // manual, no-plan balance] and the last four SUM to the first — that is the
    // card's own invariant, so the fixture has to honour it or the page would be
    // right to complain. The four org-wide totals are deliberately all
    // DIFFERENT (175 / 550 / 500 / 100), so swapping any two labels fails a
    // case rather than rendering four plausible numbers.
    "Outstanding": out[0],
    ...(V8 ? {
      "past_due_value":          STUB_MODE === "badsplit" ? 1 : out[1],
      "scheduled_autopay_value": out[2],
      "scheduled_manual_value":  out[3],
      "no_plan_balance_value":   out[4],
    } : {}),
    // SEASON NAMES ARE SHREWSBURY'S REAL ONES, apostrophe included: "Fall '26"
    // is what an org actually types, and a value that has to survive a URL
    // round-trip and an attribute selector should not be a tidy invented one.
    // The third season is deliberately the card's own COALESCE value so the
    // "No Season" checkbox is exercised as a real option rather than a special
    // case bolted on in the page.
    "program_season": season,
  });
  const URHO = "Urho Saari Swim Stadium", GORDON = "George E. Gordon Clubhouse";
  return [
    // AQUATIC EXERCISE SPANS TWO LOCATIONS, and that is the whole point: 11.6%
    // of programs on prod do. Filtering to Urho must keep only sec-aq-1, so the
    // auto-pay share reads 100% — filtering whole PROGRAMS keeps sec-aq-2's
    // $800 of manual plans too and reads 75%. One number separates the two.
    sec("Aquatic Exercise",  "Aquatic Stations with Pearlena", "sec-aq-1", 21, 24, "Fall '26",           URHO,   [1, 2400, 0,    0], [600, 100, 500,   0,   0], ["Pearlena Sok", 1],                 ["2026-08-01", "2026-10-31"]),
    sec("Aquatic Exercise",  "Water Waves with Yvette",        "sec-aq-2", 20, 24, "Fall '26",           GORDON, [0,    0, 8,  800], [250,  50,   0, 200,   0], ["Eric Stenberg, Penny Finders", 2], ["2026-09-01", "2026-12-31"]),
    sec("Water Walking",     "Water Walking August 24",        "sec-ww-1", 12, 16, "Spring/Summer 26",   GORDON, [0,    0, 10, 1000], [400,   0,   0, 300, 100], ["Pearlena Sok", 1],                 ["2026-07-01", "2026-09-30"]),
    // One unseasoned section, so ticking "No Season" has something to find and
    // the option is not vacuous — and with no location, so "No location set" is
    // a real option.
    sec("Lap Swim",          "Open Lap Swim",                  "sec-ls-1",  9, 20, "No Season",          null,   [0,    0, 1,  200], [ 75,  25,   0,  50,   0], null,                                ["2026-09-01", "2026-09-30"]),
  ];
}

// The GL report had NO render case at all before 2026-09-01, despite being the
// report a treasurer reads. Four GL codes so a subset is a real subset, one of
// them UNMAPPED (no code) so that option is exercised rather than special-cased,
// and deliberately DIFFERENT amounts so a filtered total is distinguishable
// from an unfiltered one.
function glRows() {
  const row = (code, name, cash) => ({
    "GL Code": code, "Account Name": name, "Account Number": code,
    "Desk Location": "Front Desk",
    "Credit Card Payments": 0, "Cash Payments": cash, "Check Payments": 0,
    "Free Payments": 0, "Organization Credit Payments": 0,
    "Refunds": 0, "Number of Payments": 1, "Number of Refunds": 0,
  });
  return [
    row("4100", "Program Revenue", 1000),
    row("4200", "Facility Rentals", 200),
    row("4300", "Memberships", 30),
    row("", "Unmapped receipts", 7),
  ];
}

// The Waitlist report had NO render case at all before 2026-09-01 — the report
// whose central number was wrong for months.
//
// stubMode "prev6" drops "Waitlist Type", i.e. a warm pre-v6 cache entry: the
// `auto` tag must then be ABSENT rather than defaulting to manual, because
// "we cannot tell" and "a person does this by hand" are different facts.
//
// THE FOUR ROWS ARE THE FOUR STATES, and their conversion figures are all
// different so a swapped cell fails rather than looking plausible:
//   auto-1   automated, 20 sent / 15 claimed  -> 75%
//   man-1    manual,    20 sent /  4 claimed  -> 20%
//   thin-1   manual,     2 sent /  2 claimed  -> under the floor, "2 of 2"
//   none-1   manual,     0 sent               -> a dash
function waitlistRows() {
  const V6 = STUB_MODE !== "prev6";
  const row = (id, name, type, sent, claimed, waitlisted) => ({
    "Org Name": "Test Org", "Program": name, "Section": name, "Section Id": id,
    "Season": "Fall '26", "Section Status": "Upcoming",
    "Start Date": "2026-10-01", "End Date": "2026-12-15",
    "Activity": "Aquatics",
    "Waitlist Mode": "remain-active", "Mode Source": "section",
    ...(V6 ? { "Waitlist Type": type } : {}),
    "Link Expiration Min": 1440,
    "Capacity": 20, "Enrolled": 20, "Price": 40,
    "Waitlisted": waitlisted, "Waitlist All-Time": waitlisted + claimed,
    "Waitlist Converted": claimed,
    "Est Demand": waitlisted * 40,
    "Pressure %": Math.round((waitlisted / 20) * 100),
    "Oldest Active Join": "2026-08-01",
    "Offers Sent": sent, "People Offered": sent,
    "Offers Claimed": claimed, "Claimants": claimed,
    // v6 partitions offers_sent exactly, so the fixture honours that invariant
    // — the card guarantees it and a fixture that breaks it would be testing
    // something the feed can never produce.
    "Offers Expired": sent - claimed, "Offers Outstanding": 0,
    "Avg Claim Hours": claimed ? 6.2 : null, "Median Claim Hours": claimed ? 5.3 : null,
    "Claim 1h": 0, "Claim 4h": claimed, "Claim 8h": 0,
    "Claim 24h": 0, "Claim 48h": 0, "Claim 48h Plus": 0,
  });
  return [
    row("auto-1", "Automated Swim Lessons", "automated", 20, 15, 12),
    row("man-1",  "Manual Yoga",            "manual",    20,  4,  9),
    row("thin-1", "Tiny Tots",              "manual",     2,  2,  1),
    row("none-1", "Nobody Invited Yet",     "manual",     0,  0,  5),
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
      delete r["Auto Renew"]; delete r["Period Start"]; delete r["Product Kind"];
      delete r["Cancel Scheduled At"]; delete r["Cancel Reason"];
    }
    // stubMode "prev5" is a warm cache entry from before card 17301 v5 — the
    // Resident? column simply is not there. Distinct from "nores", which KEEPS
    // the column and fills it with NULL, i.e. an org that runs no residency
    // group. The page must hide the residency surfaces in BOTH cases, and they
    // are different states, so both are driven.
    if (STUB_MODE === "prev5") delete r["Resident?"];
    else if (STUB_MODE === "nores") r["Resident?"] = null;
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
      "Product Kind": "membership",
      // 6 season-pass holders, all residents.
      "Resident?": "Yes",
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
      "Product Kind": "membership",
      // 4 monthly auto-renewers, all NON-residents. The two families differ on
      // residency AND on auto-renew, so a split that read the wrong field, or
      // the wrong row set, produces a different number rather than the same one.
      "Resident?": "No",
    }));
  }
  // ── A FREE RESIDENCY REGISTER, which is what most residency records are ──
  // El Segundo: 2,337 of 3,275 records priced at $0, 1,989 of them resident.
  // Folding these into the split reads 14 of 18 = 77.8% resident on a book
  // where residents paid $1,440 of $2,320 — the shape that made the panel look
  // broken. The paid split is 6 of 10 = 60%, so `data-mb-res-pct` is the one
  // number that separates the two and the existing case now discriminates.
  for (let i = 0; i < 8; i++) {
    rows.push(row({
      "User ID": "b81fea14-be38-46db-96da-40e61ccca25b", "First Name": "Grace", "Last Name": "Hopper " + i,
      "Membership ID": "m-r" + i, "Membership Type": "Residency", "Group / Plan": "El Segundo Residents",
      "Status": "active", "Renewal Type": "One-time", "Price": 0,
      "Start Date": "2026-01-01", "End Date": "", "Created At": "2026-01-0" + (i % 9),
      "Next Renewal": "", "Coverage": "household", "Plan Season End": null,
      "Plan Term Days": null, "Auto Renew": false, "Period Start": "",
      "Product Kind": "membership",
      "Resident?": "Yes",
    }));
  }
  // A second auto-renewing plan that CHURNS — 2 still billing, 3 cancelled, so
  // the per-plan cancel rate is 60% against Monthly Individual's 0%. Without a
  // cancelled row every plan reads 0% and the column proves nothing. One of the
  // live pair is scheduled to cancel at period end, which is a different state
  // from already cancelled and must not be added to it.
  for (let i = 0; i < 5; i++) {
    const gone = i >= 2;
    rows.push(row({
      "User ID": "d60fea14-be38-46db-96da-40e61ccca25d", "First Name": "Katherine", "Last Name": "Johnson " + i,
      "Membership ID": "m-f" + i, "Membership Type": "Fitness Monthly", "Group / Plan": "Monthly Family",
      "Status": gone ? "canceled" : "active", "Renewal Type": "Auto-renew", "Price": 40,
      "Start Date": "2026-06-01", "End Date": "", "Created At": "2026-07-0" + (i + 1),
      // A cancelled membership loses next_renewal_at, so it has no cycle and
      // contributes NO renewal count — reporting it as 0 would say someone who
      // renewed three times then left never renewed at all.
      "Next Renewal": gone ? "" : "2026-09-29",
      "Canceled At": gone ? "2026-08-1" + i : "",
      "Coverage": "household", "Plan Season End": null,
      "Plan Term Days": null, "Auto Renew": true,
      "Period Start": gone ? "" : "2026-08-29",
      "Cancel Scheduled At": (!gone && i === 0) ? "2026-09-29" : "",
      "Product Kind": "membership",
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
    "Product Kind": "membership",
  }));
  // ── PASSES ──
  // The shape that broke v2: a pass has no group, so both plan-term columns are
  // NULL and "no season end, no term days" read as "open-ended subscription".
  // 12 gate admissions at $5 — they must NOT appear as conversion candidates,
  // must NOT be in the auto-renew denominator, and must NOT be in the plan table.
  for (let i = 0; i < 12; i++) {
    rows.push(row({
      "User ID": "c59fea14-be38-46db-96da-40e61ccca25c", "First Name": "Alan", "Last Name": "Turing " + i,
      "Membership ID": "p-" + i, "Membership Type": "Gate Admission", "Group / Plan": "Tournament Gate Adult $5",
      "Status": "active", "Renewal Type": "One-time", "Price": 5,
      "Start Date": "2026-08-01", "End Date": "", "Created At": "2026-08-0" + ((i % 9) + 1),
      "Next Renewal": "", "Coverage": "individual", "Plan Season End": null,
      "Plan Term Days": null, "Auto Renew": false, "Period Start": "",
      "Product Kind": "pass",
    }));
  }
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
  { match: /\/waitlist\/api\/data/, body: () => ({ rows: waitlistRows(), meta: { org_id: "org-uuid-1" } }) },
  { match: /\/gl\/api\/data/, body: () => ({ rows: glRows(), meta: { org_id: "org-uuid-1" } }) },
  /* Card 21055, the money half of the by-month panel. MUST PEAK IN A DIFFERENT
     MONTH FROM THE ACTIVITY SERIES — August here against September in
     programRows() — because that disagreement is the entire reason the panel
     draws two charts. A fixture where both peak in the same month cannot tell a
     correct panel from one that drew the same series twice.
     stubMode "nomonthly" answers 404, i.e. the card has no public link yet: the
     money chart must then be ABSENT rather than a row of confident $0 bars. */
  { match: /\/programs-monthly\/api\/data/,
    status: () => (STUB_MODE === "nomonthly" ? 404 : 200),
    body: () => (STUB_MODE === "nomonthly" ? { error: true } : { rows: [
      { Month: "2026-07", Collected:  1200, Refunds:   0, Net:  1200 },
      { Month: "2026-08", Collected: 18400, Refunds: 400, Net: 18000 },
      { Month: "2026-09", Collected:  2600, Refunds: 100, Net:  2500 },
      { Month: "2026-10", Collected:     0, Refunds:   0, Net:     0 },
      { Month: "2026-11", Collected:     0, Refunds:   0, Net:     0 },
      { Month: "2026-12", Collected:     0, Refunds:   0, Net:     0 },
    ], meta: { org_id: "org-uuid-1" } }) },
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
  /* THE HUB'S OWN FEED (card 19570), and it was never stubbed — it fell through
     to the catch-all /api/ and got `rows: []`. So every vertical badge on the
     Facilities hub read 0 and the Aquatics tab short-circuited to its "no
     bookings in this range" empty state before AquaticsHours could mount. The
     three lane cases COULD NOT HAVE PASSED, and I reported them green off a run
     whose filter matched nothing.
     It answers the same reservations as 17294 on purpose: the hub summary and
     the rental schedule describe one set of bookings, and a fixture where they
     disagree would let a tab pass on rows the hub says do not exist. The page
     applies refineRows() to this feed, which is what recovers the court-typed
     swim lanes into the aquatics vertical. */
  { match: /\/facilities\/api\/summary/, body: () => ({
      rows: campsiteRows().concat(outdoorRows()).concat(fieldRows()).concat(addonFormRows()),
      meta: { org_id: "org-uuid-1" } }) },

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
  // THE UNLOCK ALWAYS REFUSES HERE, and that is deliberate. Every /api/ request
  // in this harness is answered from these stubs, so the browser never reaches
  // the real route — which means a render case CANNOT prove the server refuses a
  // wrong password (report-settings-unlock.spec.js drives that for real, against
  // a booted server). What only a browser can show is that the page SURFACES the
  // refusal instead of silently reloading as though it worked, so this stub
  // answers 401 the way the real route does.
  { match: /\/api\/settings-unlock/, status: 401,
    body: () => ({ error: "That password is not right. 4 attempts left.", left: 4 }) },
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
// Picks Resident in the residency filter. React tracks a controlled select's
// value internally, so the change event has to come from a real interaction —
// assigning .value and dispatching a synthetic event is ignored (the range-input
// lesson from the report-settings cases).
async function selectResident(page) {
  await page.waitForSelector("[data-mb-residency]", { timeout: 15000 });
  await page.select("[data-mb-residency]", "resident");
  await new Promise(r => setTimeout(r, 400));
}

// Season-filter act helpers. At module scope, not inside CASES — the array is a
// literal and a declaration inside it is a syntax error.
const openSeasons = async page => {
  await page.waitForSelector('[data-prog-season-btn]', { timeout: 15000 });
  await page.click('[data-prog-season-btn]');
  await page.waitForSelector('[data-prog-season-menu]', { timeout: 5000 });
};
// Stamp the menu's COMPUTED styles onto the body so a `needs` selector can
// assert them. No source assertion can tell a white popover from a dark one,
// and the bug Dan reported was half colour and half inheritance: `.toolbar
// label` sets text-transform:uppercase / color:#aaa / flex-direction:column for
// the date captions, and the option rows are <label>s inside .toolbar, so they
// rendered UPPERCASE, grey and STACKED until the resets landed.
const stampSeasonStyle = async page => {
  await openSeasons(page);
  await page.evaluate(() => {
    const menu = document.querySelector('[data-prog-season-menu]');
    const opt  = document.querySelector('[data-prog-season-opt]');
    const b = document.body;
    if (menu) b.setAttribute('data-sm-bg', getComputedStyle(menu).backgroundColor);
    if (opt) {
      const cs = getComputedStyle(opt);
      b.setAttribute('data-sm-transform', cs.textTransform);
      b.setAttribute('data-sm-dir', cs.flexDirection);
    }
  });
};

// Pick a location in the top-level filter. The control is a <select>, so the
// value is set with select() rather than a click; React reads the change event.
const pickLocation = async (page, value) => {
  await page.waitForSelector('[data-prog-loc]', { timeout: 15000 });
  await page.select('[data-prog-loc]', value);
  await new Promise(r => setTimeout(r, 400));
};

// Expand a Fast Track program group. The section rows are rendered behind
// `isOpen && p.sections.map(...)`, so nothing under a collapsed group exists in
// the DOM — the first draft of the CSV cases waited 45s on a selector that could
// never appear, and the render check is what said so.
const openFtProgram = async (page, program) => {
  await page.waitForSelector(`[data-ft-progrow="${program}"]`, { timeout: 45000 });
  await page.click(`[data-ft-progrow="${program}"]`);
  await page.waitForSelector("[data-ft-secrow]", { timeout: 10000 });
};

// Expand a program group on the Revenue tab. Section rows live behind
// `isOpen && r._sections.map(...)`, so nothing under a collapsed program is in
// the DOM at all — the same trap the Fast Track CSV cases hit, where four cases
// waited 45s on a selector that could never appear.
// BY NAME, not "the first row": filteredRows is sorted, so clicking whichever
// program happens to sort first makes the case depend on the sort rather than on
// the column it is meant to be testing.
const openProgram = async (page, name) => {
  await page.waitForSelector(`[data-prog-progrow="${name}"]`, { timeout: 30000 });
  await page.click(`[data-prog-progrow="${name}"]`);
  await page.waitForSelector("tr.section-row", { timeout: 10000 });
};

// Ticked BY ITS VISIBLE LABEL, because the option's value is not always its
// label — "No instructor on file" is the label for INSTR_NONE, which is a
// \u0000-prefixed sentinel and cannot go in an attribute selector.
const pickInstructor = async (page, label) => {
  await page.waitForSelector("[data-prog-instructor-btn]", { timeout: 15000 });
  await page.click("[data-prog-instructor-btn]");
  await page.waitForSelector("[data-prog-instructor-menu] .sm-opt", { timeout: 5000 });
  const clicked = await page.evaluate(t => {
    const rows = Array.from(document.querySelectorAll("[data-prog-instructor-menu] .sm-opt"));
    const row = rows.find(r => (r.querySelector(".sm-name") || {}).textContent === t);
    if (!row) return false;
    row.querySelector('input[type="checkbox"]').click();
    return true;
  }, label);
  if (!clicked) throw new Error('no instructor option labelled "' + label + '"');
  await new Promise(r => setTimeout(r, 400));
};

const openGlCodes = async (page) => {
  await page.waitForSelector("[data-glcode-btn]", { timeout: 20000 });
  await page.click("[data-glcode-btn]");
  await page.waitForSelector("[data-glcode-opt]", { timeout: 5000 });
};

const tickSeason = async (page, value) => {
  await page.waitForSelector(`[data-prog-season-opt="${value}"] input`, { timeout: 5000 });
  await page.click(`[data-prog-season-opt="${value}"] input`);
  await new Promise(r => setTimeout(r, 400));
};

// Opening the aquatics scope sheet — six cases below drive it, and the sheet is
// portalled to <body>, so waiting on the sheet rather than the gear is what
// proves it left the toolbar.
const openPanel = async page => {
  await page.click("[data-aqrs-open]");
  await page.waitForSelector("[data-aqrs-sheet]", { timeout: 20000 });
};

// Expand a location that actually HAS a pickable (non-pool) site, and return its
// name. Keying on "the first row" is what broke two of these cases the moment
// pool locations were sorted to the top — an all-pool location has nothing to
// tick, so a case that clicks it is asserting against the wrong row.
const openPickableLoc = async page => {
  const names = await page.evaluate(() => Array.from(
    document.querySelectorAll("[data-aqrs-loc]"), b => b.getAttribute("data-aqrs-loc")));
  for (const n of names) {
    const sel = `[data-aqrs-loc="${n.replace(/"/g, '\\"')}"]`;
    await page.click(sel);
    await page.waitForSelector("[data-aqrs-site]", { timeout: 20000 });
    const open = await page.evaluate(
      l => document.querySelectorAll("[data-aqrs-site]:not(.locked)").length > 0
           && !!document.querySelector(`[data-aqrs-locbox="${l.replace(/"/g, '\\"')}"]`), n);
    if (open) return n;
    await page.click(sel);   // collapse and try the next one
  }
  throw new Error("no location in the tree has a pickable site — the case would prove nothing");
};

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
  /* THE ORDER IS ON THE INSTANT, AND THE CARD NOW SAYS SO.
     Needham's pair: 4 fast-trackers opening 09:00 local and 19 opening 12:00 the
     SAME local day. Two things have to hold together, and neither alone is the
     bug Dan hit:
       · the 4 ranks ABOVE the 19 (the sort reads the instant, not the headcount)
       · and both chips print a TIME, and the two times DIFFER — so a reader can
         see WHY the bigger cohort is second.
     A source assertion cannot reach this: it passes on a page that sorts
     correctly and still prints "OPENS IN 2 DAYS" on both, which is exactly the
     state that got reported as a broken sort. */
  { name: "fasttrack · same day, different times", path: "/{org}/fasttrack",
    needs: "body[data-golive-time-ok=\"1\"]",
    act: async page => {
      await page.waitForSelector("[data-launch-list] [data-launch-golive]", { timeout: 45000 });
      await page.evaluate(() => {
        const card = id => document.querySelector('[data-launch-program="' + id + '"]');
        const early = card("prog-needham-early");
        const late  = card("prog-needham-late");
        if (!early || !late) return;
        // Document order: the smaller-but-sooner cohort must come first.
        const sooner = early.compareDocumentPosition(late) & Node.DOCUMENT_POSITION_FOLLOWING;
        const label = el => {
          const n = el.querySelector("[data-launch-golive]");
          return n ? n.textContent.trim() : "";
        };
        const a = label(early), b = label(late);
        const hasTime = t => /\d{1,2}:\d{2}\s?(AM|PM)/i.test(t);
        // Same calendar day is the whole premise of the fixture: if the two
        // instants stopped sharing a day this case would be proving something
        // else, so it is asserted rather than assumed.
        const day = t => (t.match(/[A-Z][a-z]{2} \d{1,2}/) || [""])[0];
        if (sooner && hasTime(a) && hasTime(b) && a !== b && day(a) && day(a) === day(b)) {
          document.body.setAttribute("data-golive-time-ok", "1");
        }
      });
    } },
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
  // ── Fast Track · per-section CSV export ───────────────────────────────────
  // Dan: "add an 'export CSV' button/link to each Fast Track section in this
  // bottom table." The button only renders where there are fast-trackers, so its
  // presence is a real assertion; the bytes are what proves it exports the right
  // people, and every source assertion in fasttrack-export.spec.js passes on a
  // button wired to the wrong row set.
  { name: "fasttrack · a section with fast-trackers offers a CSV", path: "/{org}/fasttrack",
    needs: '[data-ft-export="sec-premier-early"]',
    act: page => openFtProgram(page, "Concert Series") },
  // ...and a section with NOBODY does not. sec-select-table is in the SAME
  // program and carries FT totals on its section row but no ft_booking rows.
  // `needs` is the ROW, not just any button: asserting only the absence would
  // pass on a row that never rendered at all — the vacuous-assertion trap
  // already recorded for the zero-deadlink check.
  { name: "fasttrack · no CSV where there is nobody to export", path: "/{org}/fasttrack",
    needs: '[data-ft-secrow="sec-select-table"]', absent: '[data-ft-export="sec-select-table"]',
    act: page => openFtProgram(page, "Concert Series") },
  { name: "fasttrack · the CSV is the people, not the accounts", path: "/{org}/fasttrack",
    needs: 'body[data-ftx-hdr="1"][data-ftx-lines="3"][data-ftx-sibling="1"]'
         + '[data-ftx-scoped="1"][data-ftx-bom="1"][data-ftx-tsv="1"]',
    act: async page => {
      await openFtProgram(page, "Concert Series");
      await page.waitForSelector('[data-ft-export="sec-premier-early"]', { timeout: 45000 });
      // Stub window.open, NOT saveTextViaPopup: a headless browser has nowhere to
      // put a download, but stubbing the writer would skip the delivery path —
      // which is where the BOM lives. This reads the bytes the popup is handed.
      await page.evaluate(() => {
        window.__payload = null;
        window.open = () => ({
          document: { write() {}, close() {} },
          set __recExport(v) { window.__payload = v; },
          get __recExport() { return window.__payload; },
        });
      });
      await page.click('[data-ft-export="sec-premier-early"]');
      await page.evaluate(() => {
        const p = window.__payload;
        if (!p) return;   // the button never reached the writer at all
        const set = (k, v) => { if (v) document.body.setAttribute(k, v); };
        // On the BYTES, not a decoded string: TextDecoder strips the BOM by
        // default, so decoding first passes either way — and bytes are what
        // Excel sniffs.
        const b = p.bytes;
        set("data-ftx-bom", b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? "1" : "");
        const body = new TextDecoder().decode(b);
        const lines = body.replace(/\r\n$/, "").split("\r\n");
        set("data-ftx-hdr", lines[0] === "Program,Section,Season,Reg Mode,Participant,Account Name,Account Email,Fast Tracks,Converted,Pending,First Signup" ? "1" : "");
        // THREE data rows from TWO accounts. Per-account grouping gives 2, which
        // is the bug this export exists to avoid — the badge already says 2.
        document.body.setAttribute("data-ftx-lines", String(lines.length - 1));
        // Each sibling carries its OWN hold count: Layla 2, Tiger 1. A shared
        // per-account count would print 3 for both.
        set("data-ftx-sibling",
          lines.some(l => l.indexOf("Layla Callan") >= 0 && l.indexOf(",2,1,1,") >= 0) &&
          lines.some(l => l.indexOf("Tiger Callan") >= 0 && l.indexOf(",1,0,1,") >= 0) ? "1" : "");
        // Scoped to THIS section — another section's holder must not be in it.
        set("data-ftx-scoped", body.indexOf("Nope Nobody") < 0 ? "1" : "");
        // The clipboard copy is TAB-separated and carries NO BOM: pasted into a
        // sheet a BOM is a stray character in the first cell, and a
        // comma-separated paste drops the whole row into one column.
        set("data-ftx-tsv", p.tsv && p.tsv.charCodeAt(0) !== 0xFEFF
          && p.tsv.split("\n")[0].indexOf("\tParticipant\t") >= 0 ? "1" : "");
      });
    } },
  // Clicking the export must NOT also open the expander — the row's own onClick
  // toggles it, and two things happening on one click reads as a bug.
  { name: "fasttrack · exporting does not open the panel", path: "/{org}/fasttrack",
    needs: '[data-ft-export="sec-premier-early"]', absent: ".sec-users-row",
    act: async page => {
      await openFtProgram(page, "Concert Series");
      await page.waitForSelector('[data-ft-export="sec-premier-early"]', { timeout: 45000 });
      await page.evaluate(() => {
        window.open = () => ({ document: { write() {}, close() {} }, set __recExport(v) {}, get __recExport() { return null; } });
      });
      await page.click('[data-ft-export="sec-premier-early"]');
      await new Promise(r => setTimeout(r, 300));
    } },

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
  // THE DOOR FIRST, and its rule CHANGED on 2026-09-01. The gear used to be
  // absent from the DOM for a token holder so nobody learned the surface
  // existed. Dan reversed that: "show the settings icon, but require the admin
  // un/pw to be entered when the settings icon is clicked." So a staffer now
  // sees a LOCKED gear — and what still must not appear is the working one,
  // because that is the control that edits an org's defaults.
  { name: "roster · no WORKING gear without the admin key", path: "/{org}/roster",
    needs: "[data-rs-locked]", absent: "[data-rs-open]" },
  // Clicking it asks for a password rather than opening the panel. The settings
  // sheet must be ABSENT here: if it opened, the prompt would be decorative and
  // the reveal client-side.
  { name: "roster · the locked gear asks for a password", path: "/{org}/roster",
    needs: "[data-rs-unlock] input[type=\"password\"]",
    absent: "[aria-label=\"Class Roster settings\"]",
    act: async page => {
      await page.waitForSelector("[data-rs-locked]", { timeout: 15000 });
      await page.click("[data-rs-locked]");
      await page.waitForSelector("[data-rs-unlock]", { timeout: 5000 });
    } },
  // A REFUSAL REACHES THE READER. The stub answers 401 (see its note above — the
  // browser cannot reach the real route in this harness), so what this pins is
  // the page's half: the error is shown, and the panel does NOT open. Without
  // it, a page that ignored the status would reload and look like it worked.
  { name: "roster · a refused password is surfaced, not swallowed", path: "/{org}/roster",
    needs: "[data-rs-unlock-err]",
    absent: "[aria-label=\"Class Roster settings\"]",
    act: async page => {
      await page.waitForSelector("[data-rs-locked]", { timeout: 15000 });
      await page.click("[data-rs-locked]");
      await page.waitForSelector("[data-rs-unlock-pw]", { timeout: 5000 });
      await page.type("[data-rs-unlock-pw]", "definitely-not-the-password");
      await page.waitForFunction(
        () => { const b = document.querySelector("[data-rs-unlock-go]"); return b && !b.disabled; },
        { timeout: 5000 });
      await page.click("[data-rs-unlock-go]");
      await page.waitForSelector("[data-rs-unlock-err]", { timeout: 8000 });
    } },
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
  { name: "roster · flag off says where the switch is, ON SCREEN", path: "/{org}/roster?admin=" + RENDER_ADMIN_KEY,
    needs: "[data-rs-flagnote]", absent: "[data-rs-open]",
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
        // IT HAS TO BE CLICKABLE. It shipped as a DISABLED button whose only
        // explanation was a title attribute, and Dan clicked it, got nothing,
        // and reported the feature as broken — the explanation was behind a
        // hover. So the case now clicks it and requires the notice on screen; a
        // disabled button makes this fail, which is the whole point.
        await page.click("[data-rs-flagoff]");
        await page.waitForSelector("[data-rs-flagnote]", { timeout: 8000 });
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
  // ── Residency (card 17301 v5) ────────────────────────────────────────────
  // Keyed on the COMPUTED counts, not on "a panel rendered": the fixture has 6
  // residents and 4 non-residents, and every regression worth catching here
  // produces a different number rather than an empty page.
  // ── Aquatics lane hours ──────────────────────────────────────────────────
  // 3h + 3h + 2h = 8 lane hours over 3 bookings on 2 lanes. The Johnson Lane
  // TENNIS court is 3 more hours at a non-aquatic location: if it were counted
  // this reads 11 and 3 lanes, so the number itself is the guard.
  //
  // WHAT THESE THREE ACTUALLY PROVE, since the lane branch was removed: their
  // rows reach the tab through refineSiteType's NAME branch, because the fixture
  // builds Facility as "<location> - <site>" and the location says "Aquatic".
  // That is the org's own word and is still recovered. They are the hour-math
  // guard — coverage not start times, multi-day excluded — and NOT a guard on
  // the per-org scope. `Lap Lane 7` is that, in the two cases below.
  { name: "facilities · lane hours", path: "/{org}/facilities?tab=aquatics",
    needs: "[data-aq-hours=\"8\"]" },
  { name: "facilities · lanes in use", path: "/{org}/facilities?tab=aquatics",
    needs: "[data-aq-lanes=\"2\"]" },
  // Coverage, not start times: all three lane bookings start at 6am, but 6am,
  // 7am and 8am are all covered. A start-times grid peaks at 6a either way, so
  // the discriminating assertion is the TIMED count, which excludes nothing
  // here but changes the moment a multi-day row leaks in.
  { name: "facilities · lane heat is coverage", path: "/{org}/facilities?tab=aquatics",
    needs: "[data-aq-timed=\"3\"]" },

  // ── The per-org aquatics scope ───────────────────────────────────────────
  // "Pools can be courts, but courts can never be pools" (Dan). `Lap Lane 7` is
  // typed `court` and carries no aquatic word anywhere, so an UNCONFIGURED org
  // must not count it: 8 hours, not 10. This is the case that fails if anyone
  // reinstates the name-and-location guess.
  { name: "facilities · an unconfigured org counts no courts", path: "/{org}/facilities?tab=aquatics",
    needs: "[data-aq-hours=\"8\"]" },
  // THE GEAR GOES LAST IN THE TOOLBAR, upper right, "same as on every main page
  // of every report" (Dan). It first shipped inside a footnote under the last
  // panel and he reported it missing from the live tab while it was rendering
  // perfectly, four panels below the fold — a control nobody can find is a
  // control that does not exist. Keyed on POSITION, because "a gear rendered"
  // passes just as happily on the version nobody could find.
  //
  // This case was itself wrong once: it asserted the gear sat in the scope bar,
  // which is where it lived for one revision before the toolbar move, and CI
  // caught the stale assertion. When you move a control, move the case that
  // pins where it is.
  { name: "facilities · the aquatics gear is last in the toolbar", path: "/{org}/facilities?tab=aquatics",
    needs: "[data-aqrs-open],[data-aqrs-locked],[data-aqrs-flagoff]",
    act: async page => {
      const where = await page.evaluate(() => {
        const gear = document.querySelector("[data-aqrs-open],[data-aqrs-locked],[data-aqrs-flagoff]");
        const bar = gear && gear.closest(".toolbar");
        if (!bar) return "not in the toolbar";
        // Last interactive thing in the bar — its own wrapper is the final child.
        const kids = Array.from(bar.children);
        const holder = gear.closest(".aqrs-gear") || gear;
        if (kids[kids.length - 1] !== holder) return "in the toolbar but not last";
        return "ok";
      });
      if (where !== "ok") throw new Error("the aquatics gear is " + where);
    } },

  // ── The panel: a location/site tree ──────────────────────────────────────
  // Dan: "the goal here is to choose locations and sites that are NOT aquatics,
  // to include in the aquatics tab." Type-as-a-filter was the wrong shape; this
  // is an inclusion tree, and these cases replace the three that keyed on the
  // old type list.
  // The tree is built from the FEED, so a location can never be unpickable —
  // and the counts must be real. This is where "0 sites in view" showed up.
  //
  // `Wiseburn Center` is the load-bearing name: nothing about it or its sites is
  // aquatic, so it is exactly the location an admin has to be able to find and
  // tick. And at rest — nothing ticked — the tally must equal the POOL sites and
  // nothing else, which is the claim the panel makes on screen.
  { name: "facilities · the scope tree lists the org's locations",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: "[data-aqrs-open]",
    act: async page => {
      await openPanel(page);
      const seen = await page.evaluate(() => Array.from(
        document.querySelectorAll("[data-aqrs-loc]"), t => t.getAttribute("data-aqrs-loc")));
      if (!seen.length) throw new Error("the tree listed no locations");
      if (!seen.some(n => /Wiseburn Center/.test(n)))
        throw new Error("the non-aquatic location is missing from the tree: " + seen.join(" | "));
      // Expand everything so the locked sites are countable.
      for (const l of await page.$$("[data-aqrs-loc]")) await l.click();
      const { total, locked } = await page.evaluate(() => ({
        total: Number(document.querySelector("[data-aqrs-counted]").getAttribute("data-aqrs-counted")),
        locked: document.querySelectorAll("[data-aqrs-site].locked").length,
      }));
      if (!locked) throw new Error("the fixture has no pool site, so this case proves nothing");
      if (total !== locked)
        throw new Error(`at rest the tally must be the ${locked} pool site(s), and it read ${total}`);
    } },

  // Expanding a location shows its individual sites — the whole ask.
  { name: "facilities · a location expands to its sites",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: "[data-aqrs-open]",
    act: async page => {
      await openPanel(page);
      const before = await page.evaluate(() => document.querySelectorAll("[data-aqrs-site]").length);
      await page.click("[data-aqrs-loc]");
      await page.waitForSelector("[data-aqrs-site]", { timeout: 20000 });
      const after = await page.evaluate(() => document.querySelectorAll("[data-aqrs-site]").length);
      if (!(after > before)) throw new Error("expanding a location showed no sites");
    } },

  // TICKING ONE SITE MAKES ITS LOCATION PARTIAL. A partly-picked location that
  // read as fully in or fully out is the thing three states exist to prevent.
  { name: "facilities · one site makes its location partial",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: "[data-aqrs-open]",
    act: async page => {
      await openPanel(page);
      const loc = await openPickableLoc(page);
      // A location with only ONE pickable site goes straight to 'on', so the
      // partial state needs at least two.
      const n = await page.evaluate(() => document.querySelectorAll("[data-aqrs-site]:not(.locked)").length);
      if (n < 2) throw new Error(`"${loc}" has ${n} pickable site(s) — 'some' is unreachable, so this case would prove nothing`);
      await page.click("[data-aqrs-site]:not(.locked)");
      await page.waitForSelector('[data-aqrs-locbox] [data-aqrs-box="some"]', { timeout: 20000 });
    } },

  // Pool sites are shown LOCKED, not hidden — leaving them out is what makes an
  // admin wonder whether the pool is in the number.
  { name: "facilities · pool sites are shown but locked",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: "[data-aqrs-open]",
    act: async page => {
      await openPanel(page);
      const locs = await page.$$("[data-aqrs-loc]");
      for (const l of locs) await l.click();
      const locked = await page.evaluate(() =>
        document.querySelectorAll('[data-aqrs-site].locked [data-aqrs-box="lock"]').length);
      if (!locked) throw new Error("no pool site rendered as locked");
    } },

  // UNTICKING ONE SITE OF A WHOLE-LOCATION PICK HAS TO DROP THE COUNT. A whole
  // location is stored as the LOCATION NAME, so unticking a site under it does
  // nothing unless the pick is first expanded into its sites — and the tally is
  // the only place that shows it: the box goes unticked either way.
  { name: "facilities · unticking one site of a whole location drops the count",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: "[data-aqrs-open]",
    act: async page => {
      await openPanel(page);
      const loc = await openPickableLoc(page);
      await page.click(`[data-aqrs-locbox="${loc.replace(/"/g, '\\"')}"]`);
      await page.waitForSelector('[data-aqrs-save][data-aqrs-dirty="1"]', { timeout: 20000 });
      const read = () => page.evaluate(() =>
        Number(document.querySelector("[data-aqrs-counted]").getAttribute("data-aqrs-counted")));
      const whole = await read();
      const pickable = await page.$$("[data-aqrs-site]:not(.locked)");
      if (!pickable.length) throw new Error("this location has no unlockable site, so the case proves nothing");
      await pickable[0].click();
      const after = await read();
      if (!(after === whole - 1))
        throw new Error(`unticking one site of ${whole} must leave ${whole - 1} counted, and it read ${after}`);
    } },

  // The sheet escapes .toolbar, whose own `label` rule would render these rows
  // uppercase, grey and stacked. The season-menu bug, one component over.
  { name: "facilities · the scope panel escapes the toolbar's label rule",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: "[data-aqrs-open]",
    act: async page => {
      await openPanel(page);
      await openPickableLoc(page);
      const bad = await page.evaluate(() => {
        const sheet = document.querySelector("[data-aqrs-sheet]");
        if (sheet.closest(".toolbar")) return "the sheet is still inside .toolbar";
        const row = sheet.querySelector("[data-aqrs-site]");
        const cs = getComputedStyle(row);
        if (cs.textTransform === "uppercase") return "the site rows are UPPERCASE";
        if (cs.flexDirection === "column") return "the site rows are STACKED";
        return null;
      });
      if (bad) throw new Error(bad);
    } },

  // Save is off with nothing to save, and on after a tick.
  { name: "facilities · Save is off until something changes",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: "[data-aqrs-open]",
    act: async page => {
      await openPanel(page);
      await page.waitForSelector('[data-aqrs-save][data-aqrs-dirty="0"]', { timeout: 20000 });
      if (!(await page.evaluate(() => document.querySelector("[data-aqrs-save]").disabled)))
        throw new Error("Save is offered with nothing to save");
      const loc = await openPickableLoc(page);
      await page.click(`[data-aqrs-locbox="${loc.replace(/"/g, '\\"')}"]`);
      await page.waitForSelector('[data-aqrs-save][data-aqrs-dirty="1"]', { timeout: 20000 });
      const on = await page.evaluate(() => {
        const b = document.querySelector("[data-aqrs-save]");
        return !b.disabled && getComputedStyle(b).backgroundColor === "rgb(37, 99, 235)"
               && b.textContent.trim() === "Save";
      });
      if (!on) throw new Error("after a tick, Save must be enabled, blue and read 'Save'");
    } },

  // The CONFIGURED path is proven in aquatics-scope.spec.js, which lifts and
  // RUNS vertRowMatch over all four combinations of extra types and scope. It is
  // deliberately not a render case: driving it in the browser needs the server's
  // settings store changed mid-run, and that store is memoised on first read.
  { name: "memberships · residency split", path: "/{org}/memberships",
    needs: "[data-mb-res-count=\"6\"]" },
  { name: "memberships · residency non-resident count", path: "/{org}/memberships",
    needs: "[data-mb-nonres-count=\"4\"]" },
  // 6 of 10 known = 60%. A split taken from `filtered` would read 6 of 7 (the
  // status filter defaults to active and 3 rows are cancelled), i.e. 85.7% —
  // so this one number separates the two row sets.
  { name: "memberships · split is the whole book, not the active view", path: "/{org}/memberships",
    needs: "[data-mb-res-pct=\"60\"]" },
  // The free register is REPORTED beside the split, never folded in and never
  // dropped — the same rule as the unknown bucket.
  { name: "memberships · the free residency register is named", path: "/{org}/memberships",
    needs: "[data-mb-res-free=\"8\"]" },
  // The filter must scope the WHOLE report, so picking Resident has to move a
  // panel that is not the split — the header count is the cheapest proof.
  { name: "memberships · residency filter scopes the page", path: "/{org}/memberships",
    needs: "[data-mb-res-count=\"6\"]", act: selectResident },
  // Absent, not zeroed, on a feed that predates the column…
  { name: "memberships · no residency surfaces pre-v5", path: "/{org}/memberships",
    stubMode: "prev5", needs: ".summary-cards",
    absent: "[data-mb-residency-split]" },
  { name: "memberships · no residency control pre-v5", path: "/{org}/memberships",
    stubMode: "prev5", needs: ".summary-cards", absent: "[data-mb-residency]" },
  // …and on an org that HAS the column but runs no residency group, which is a
  // different state and would otherwise render "0% resident".
  { name: "memberships · no residency surfaces without a residency group", path: "/{org}/memberships",
    stubMode: "nores", needs: ".summary-cards", absent: "[data-mb-residency-split]" },
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
  // Memberships (Dan: "make sure you're adding the membership sub-tabs to the
  // main cards on the org page, similar to the other cards with tabs"). Auto-
  // Renew and Sales & Mix shipped as tabs with no way to reach them from the
  // dashboard. Scoped to /memberships? because `tab=checkins` alone also matches
  // the Programs card's own chip.
  { name: "org landing · memberships autorenew chip", path: "/{org}",
    needs: ".card-tab[href*=\"/memberships?\"][href*=\"tab=autorenew\"]" },
  { name: "org landing · memberships salesmix chip", path: "/{org}",
    needs: ".card-tab[href*=\"/memberships?\"][href*=\"tab=salesmix\"]" },
  // The label carries an ampersand and goes out through innerHTML, so this is
  // the case that fails if it is ever double-escaped into "Sales &amp; Mix" on
  // screen. (The global unrendered-escape guard catches the entity form; this
  // pins the text itself.)
  { name: "org landing · salesmix chip reads as text", path: "/{org}",
    needs: ".card-tab[href*=\"tab=salesmix\"]", act: async page => {
      await page.waitForFunction(
        () => (document.querySelector('.card-tab[href*="tab=salesmix"]')?.textContent || "")
          .includes("Sales & Mix"),
        { timeout: 45000 });
    } },

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
  // ── The tables behind the charts are downloadable ────────────────────────
  // Dan: "they are pretty to look at, but harder to get the actual data out."
  // These read the BYTES the popup is handed, not "a link rendered" — a link
  // wired to the wrong table renders identically.
  { name: "facilities · a panel offers its own table as CSV",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: 'body[data-pcsv-hdr="1"][data-pcsv-bom="1"][data-pcsv-lane="1"]',
    until: "HOURS BOOKED",
    act: async page => {
      await page.waitForSelector('[data-panel-csv="lane-hours-by-lane"]', { timeout: 45000 });
      // Stub window.open rather than the writer: the BOM is added in the
      // delivery path, so stubbing saveTextViaPopup would skip the thing most
      // worth checking.
      await page.evaluate(() => {
        window.__payload = null;
        window.open = () => ({
          document: { write() {}, close() {} },
          set __recExport(v) { window.__payload = v; },
          get __recExport() { return window.__payload; },
        });
      });
      await page.click('[data-panel-csv="lane-hours-by-lane"]');
      await page.evaluate(() => {
        const p = window.__payload;
        if (!p) return;
        const set = (k, v) => { if (v) document.body.setAttribute(k, v); };
        const b = p.bytes;
        set("data-pcsv-bom", b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? "1" : "");
        const lines = new TextDecoder().decode(b).replace(/\r\n$/, "").split("\r\n");
        set("data-pcsv-hdr",
          lines[0] === "Lane,Location,Hours booked,Bookings,Avg block (hours)" ? "1" : "");
        // A REAL LANE NAME, quoted where it has to be. The fixture's lanes are
        // "<location> - <site>", so this also proves the file carries the lane
        // rather than the sublane letter the old label rule kept.
        set("data-pcsv-lane", lines.slice(1).some(l => /Lane/.test(l)) ? "1" : "");
      });
    } },

  // The day-part grid comes out LONG — 7 x 24 unpivoted — because a grid has to
  // be unpivoted by hand before it pivots.
  { name: "facilities · the day-part grid downloads unpivoted",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: 'body[data-pcsv-rows="168"][data-pcsv-dow="1"]',
    until: "HOURS BOOKED",
    act: async page => {
      await page.waitForSelector('[data-panel-csv="lane-hours-by-day-part"]', { timeout: 45000 });
      await page.evaluate(() => {
        window.__payload = null;
        window.open = () => ({ document: { write() {}, close() {} },
          set __recExport(v) { window.__payload = v; },
          get __recExport() { return window.__payload; } });
      });
      await page.click('[data-panel-csv="lane-hours-by-day-part"]');
      await page.evaluate(() => {
        const p = window.__payload;
        if (!p) return;
        const lines = new TextDecoder().decode(p.bytes).replace(/\r\n$/, "").split("\r\n");
        document.body.setAttribute("data-pcsv-rows", String(lines.length - 1));
        if (lines.some(l => l.startsWith("Wed,13,1p,"))) document.body.setAttribute("data-pcsv-dow", "1");
      });
    } },

  // Revenue by site downloads EVERY site, not the twelve the chart draws — the
  // chart is capped for legibility and a file has no such reason.
  { name: "facilities · revenue by site downloads every site, not the top 12",
    path: "/{org}/facilities?tab=aquatics&admin=" + RENDER_ADMIN_KEY,
    needs: 'body[data-pcsv-sites="1"]',
    act: async page => {
      await page.waitForSelector('[data-panel-csv="revenue-by-site"]', { timeout: 45000 });
      await page.evaluate(() => {
        window.__payload = null;
        window.open = () => ({ document: { write() {}, close() {} },
          set __recExport(v) { window.__payload = v; },
          get __recExport() { return window.__payload; } });
      });
      await page.click('[data-panel-csv="revenue-by-site"]');
      await page.evaluate(() => {
        const p = window.__payload;
        if (!p) return;
        const lines = new TextDecoder().decode(p.bytes).replace(/\r\n$/, "").split("\r\n");
        const shown = document.querySelectorAll('[data-panel-csv="revenue-by-site"]').length;
        // The file must have at least as many rows as the chart has bars, and
        // carry the header this builder writes.
        if (shown && lines[0] === "Site,Location,Bookings,Canceled,Revenue,Guests recorded"
            && lines.length - 1 >= 1) document.body.setAttribute("data-pcsv-sites", "1");
      });
    } },

  // A panel with nothing to show offers no link: "downloads a header and
  // nothing else" and "offers nothing" are different claims.
  { name: "facilities · no CSV link on a tab with no bookings",
    path: "/{org}/facilities?tab=golf", needs: ".empty",
    absent: "[data-panel-csv]" },

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
  // ── The multi-select Season filter ───────────────────────────────────────
  // The fixture is 4 sections over 3 programs: Aquatic Exercise ×2 in "Fall '26",
  // Water Walking in "Spring/Summer 26", Lap Swim in "No Season". So the
  // PROGRAM COUNT discriminates every case below — 3 unfiltered, 1 for Fall '26,
  // 2 for a two-season union. Keying on "a checkbox rendered" would pass on a
  // filter that filters nothing, which is the whole failure mode here.
  { name: "programs · season options are CHECKBOXES", path: "/{org}/programs",
    // Dan: "make the season filter a checkbox, multiselectable. I hate single
    // item selections in pull down menus." A <select> renders a control too, so
    // the assertion is on the input TYPE, not on the control existing.
    needs: '[data-prog-season-menu] input[type="checkbox"]',
    act: openSeasons },
  // Dan: "make the menu look like the other menu styles. not the white
  // background menu." #2c2c2c is the toolbar's own background, so this fails if
  // the popover goes back to white — which is a thing only a browser can see.
  { name: "programs · the season menu matches the toolbar", path: "/{org}/programs",
    needs: '[data-sm-bg="rgb(44, 44, 44)"]', act: stampSeasonStyle },
  // The inheritance half of the same bug, and the more interesting one: these
  // rows are <label>s inside .toolbar, which uppercases and stacks its labels.
  { name: "programs · season rows escape the toolbar label rule", path: "/{org}/programs",
    needs: '[data-sm-transform="none"][data-sm-dir="row"]', act: stampSeasonStyle },
  { name: "programs · the season menu is CLOSED until asked for", path: "/{org}/programs",
    // An always-open menu is a different and noisier control. Absence before the
    // click is the only thing that distinguishes the two.
    needs: "[data-prog-season-btn]", absent: "[data-prog-season-menu]" },
  { name: "programs · unfiltered shows every program", path: "/{org}/programs",
    needs: '[data-prog-count="3"]' },
  { name: "programs · a ticked season scopes the report", path: "/{org}/programs",
    // 3 programs -> 1. This is the case that fails if the funnel ignores the tick.
    needs: '[data-prog-count="1"]',
    act: async page => { await openSeasons(page); await tickSeason(page, "Fall '26"); } },
  // ── The Location filter, which SHIPPED UNABLE TO RENDER ──────────────────
  // normalizeRow never mapped `location` and rollupToPrograms never carried it,
  // so progHasLocation was false on every feed and the select was gated out at
  // locOptions.length > 1. programs-location.spec.js fed the reducer rows that
  // already had `location` on them and there was no render case at all, so
  // nothing in CI could see it. This is that case.
  { name: "programs · the location filter EXISTS", path: "/{org}/programs",
    needs: "[data-prog-loc]" },
  { name: "programs · a picked location scopes the report", path: "/{org}/programs",
    // 3 programs -> 1: only Aquatic Exercise has a section at Urho.
    needs: '[data-prog-count="1"]',
    act: page => pickLocation(page, "Urho Saari Swim Stadium") },
  // AND IT FILTERS SECTIONS, NOT PROGRAMS. Aquatic Exercise runs at both sites;
  // 100% is the share over sec-aq-1 alone, while keeping the whole program
  // drags in sec-aq-2's $800 of manual plans and reads 75%. Measured on prod:
  // 659 of 5,699 programs (11.6%) span locations, so this is a main case.
  { name: "programs · location filters SECTIONS, not whole programs", path: "/{org}/programs",
    needs: '[data-prog-autopay-pct="100"]',
    act: page => pickLocation(page, "Urho Saari Swim Stadium") },
  // ...and the auto-pay share adds its sections up: ticking Fall '26 keeps BOTH
  // of Aquatic Exercise's sections, $2,400 auto-pay against $800 manual = 75%.
  { name: "programs · a program's share sums its surviving sections", path: "/{org}/programs",
    needs: '[data-prog-autopay-pct="75"]',
    act: async page => { await openSeasons(page); await tickSeason(page, "Fall '26"); } },
  // ...AND THE SURVIVORS ARE RE-ROLLED UP, which the share above CANNOT prove:
  // progAutopayShare sums whatever rows it is handed, so section rows and their
  // rollup give the same percentage. What breaks without the re-rollup is the
  // Summary tab's own progMap, which is keyed by program and therefore
  // OVERWRITTEN once per section — the program keeps only its LAST section, so
  // Fall '26 reads 20 participants instead of 21 + 20. Verified to fail on that
  // exact mutation; two earlier attempts at this case did not discriminate.
  { name: "programs · a filtered program keeps ALL its surviving sections", path: "/{org}/programs",
    needs: '[data-prog-participants="41"]',
    act: async page => { await openSeasons(page); await tickSeason(page, "Fall '26"); } },

  // ── On Auto-Pay ──────────────────────────────────────────────────────────
  // Dan: "% on Auto-Pay vs % on manual collection". The fixture makes the two
  // readings differ 11x, so a card computing the wrong one still renders a
  // plausible number and only the VALUE can tell them apart.
  { name: "programs · auto-pay share is by DOLLARS", path: "/{org}/programs",
    // $2,400 of $4,400. By registrations it would read 5.
    needs: '[data-prog-autopay-pct="54.5"]' },
  { name: "programs · ...and the count reading is printed too", path: "/{org}/programs",
    // 1 of 20. Both are on screen because either alone reads as the whole answer.
    needs: '[data-prog-autopay-items="5"]' },
  // PRESENCE, NOT VALUE: a warm pre-v7 cache entry must HIDE the card. A 0%
  // there says "nobody uses auto-pay" when the truth is "this feed cannot tell
  // us" — and "renders a 0" and "renders nothing" are different claims.
  { name: "programs · no auto-pay card on a pre-v7 feed", path: "/{org}/programs",
    stubMode: "prev7", needs: ".sum-cards", absent: "[data-prog-autopay-pct]" },

  // ── Outstanding, split by WHY ─────────────────────────────────────────────
  // Dan: "we'd like to have past-due from scheduled and on autopay". One
  // Outstanding figure hides the only actionable part — at apex it was 96%
  // not-yet-due money with $24,728 genuinely late inside it. All four org-wide
  // totals differ (175 / 550 / 500 / 100), so a swapped label fails a case
  // rather than rendering a plausible number.
  { name: "programs · Outstanding says how much is PAST DUE", path: "/{org}/programs?tab=revenue",
    needs: '[data-out-pastdue="175"]' },
  { name: "programs · ...and how much is merely scheduled", path: "/{org}/programs?tab=revenue",
    needs: '[data-out-sched="550"]' },
  { name: "programs · ...and how much collects itself", path: "/{org}/programs?tab=revenue",
    needs: '[data-out-autopay="500"]' },
  // A balance with no payment plan has no due date, so it can be neither late
  // nor scheduled. Its row renders only where there is one.
  { name: "programs · a no-plan balance gets its own row", path: "/{org}/programs?tab=revenue",
    needs: '[data-out-noplan="100"]' },
  // THE PARTS ADD BACK UP, and the page says so when they do not. This is the
  // only case that can catch a breakdown quietly failing to sum, which is how a
  // number stops being trusted.
  { name: "programs · a breakdown that does not sum SAYS SO", path: "/{org}/programs?tab=revenue",
    stubMode: "badsplit", needs: "[data-out-residual]" },
  { name: "programs · ...and stays quiet when it does", path: "/{org}/programs?tab=revenue",
    needs: "[data-out-split]", absent: "[data-out-residual]" },
  // PRESENCE, NOT VALUE: a warm pre-v8 cache entry keeps the old single figure
  // rather than four confident zeros.
  { name: "programs · no Outstanding split on a pre-v8 feed", path: "/{org}/programs?tab=revenue",
    stubMode: "prev8", needs: ".summary-cards", absent: "[data-out-split]" },

  // ── Location + Instructor columns, and the instructor filter ─────────────
  // Card 17295 has emitted `instructor` since v6 and the page mapped it at line
  // 957 and rendered it NOWHERE for a day — the same shape as the location
  // filter that shipped unable to render. A case keyed on the CELL is the only
  // thing that catches a mapped-but-never-displayed column.
  // ── GL: the code checkboxes ──────────────────────────────────────────────
  // Dan: "everything starts as selected/checked, there's an unselect all,
  // select all, and individual checkboxes." This report had NO render case at
  // all before today.
  { name: "gl · the rollup renders", path: "/{org}/gl", needs: "[data-glcode-btn]" },
  // EVERYTHING STARTS CHECKED, so there is no badge — the badge only appears
  // once a real subset is picked. Keyed on the badge's ABSENCE, which is the
  // only thing that distinguishes all-checked from a filter left over from
  // somewhere else.
  { name: "gl · every code starts checked", path: "/{org}/gl",
    needs: "[data-glcode-btn]", absent: "[data-glcode-badge]" },
  { name: "gl · the menu lists each code", path: "/{org}/gl",
    act: openGlCodes, needs: '[data-glcode-opt="4100"]' },
  // The unmapped bucket is a real option, not a special case — without it those
  // rows vanish silently the moment anyone picks a code.
  { name: "gl · unmapped receipts are their own option", path: "/{org}/gl",
    act: openGlCodes, needs: '[data-glcode-opt="(Unmapped — no GL code)"]' },
  // None must STICK. An empty selection used to be re-widened back to all,
  // which is what made the None button look broken — see
  // reconcileFilterSelection. The badge reading 0 is the proof it held.
  { name: "gl · None sticks", path: "/{org}/gl",
    act: async p => { await openGlCodes(p); await p.click("[data-glcode-none]"); },
    needs: '[data-glcode-badge="0"]' },
  { name: "gl · All puts them back", path: "/{org}/gl",
    act: async p => { await openGlCodes(p); await p.click("[data-glcode-none]"); await p.click("[data-glcode-all]"); },
    needs: "[data-glcode-btn]", absent: "[data-glcode-badge]" },

  // ── Waitlist: the auto tag, and a conversion rate that is not a lie ──────
  // This report had NO render case at all, and its central number — how many
  // claim links became registrations — was measuring the EXPIRY SWEEP until
  // card 19273 v6. 63% platform-wide where the truth was 42.5%.
  { name: "waitlist · the table renders", path: "/{org}/waitlist", needs: "table tbody tr" },
  // Keyed on the VALUE. 20 sent / 15 claimed is 75%; reading the wrong pair of
  // columns gives a different number rather than an obviously broken one.
  { name: "waitlist · invite conversion is a real rate", path: "/{org}/waitlist",
    needs: '[data-wl-conv="75"]' },
  { name: "waitlist · ...and a poor one reads poor", path: "/{org}/waitlist",
    needs: '[data-wl-conv="20"]' },
  // A RATE OVER TWO INVITES IS NOT A RATE. Under the floor the cell shows the
  // counts, and the percentage must be ABSENT — "100%" over one invite is the
  // thin-denominator lie this floor exists to prevent.
  { name: "waitlist · a thin denominator shows counts, not a rate", path: "/{org}/waitlist",
    needs: "[data-wl-convthin]", absent: '[data-wl-conv="100"]' },
  // The auto tag, on the automated section only.
  { name: "waitlist · an automated section is tagged", path: "/{org}/waitlist",
    needs: '[data-wl-auto="auto-1"]' },
  // ...and NOT on a manual one. A tag on every row is 28,161 rows of noise
  // platform-wide and stops meaning anything.
  { name: "waitlist · a manual section is not", path: "/{org}/waitlist",
    needs: '[data-wl-auto="auto-1"]', absent: '[data-wl-auto="man-1"]' },
  // PRESENCE, NOT VALUE: a warm pre-v6 cache entry has no type at all, so the
  // tag is absent rather than defaulting to manual.
  { name: "waitlist · no auto tag on a pre-v6 feed", path: "/{org}/waitlist",
    stubMode: "prev6", needs: "table tbody tr", absent: "[data-wl-auto]" },

  // Dan, on the live page: "not seeing instructor names and info on the program
  // pages. filter works, but doesn't show the data we need." The names were on
  // the SECTION rows only, so finding out who teaches a program meant expanding
  // it. The All Programs table carries the distinct set now. Keyed on the CELL's
  // count, not on a column existing: a column of dashes renders just as happily.
  { name: "programs · the program table names the instructor", path: "/{org}/programs?tab=summary",
    needs: "[data-prog-instrcell]",
    act: async page => {
      const seen = await page.evaluate(() => Array.from(
        document.querySelectorAll("[data-prog-instrcell]"), t => t.textContent.trim()));
      if (!seen.some(t => /[A-Za-z]{3}/.test(t) && !/instructors$/.test(t)))
        throw new Error("no program row printed an instructor NAME: " + JSON.stringify(seen.slice(0, 8)));
    } },
  // A program whose sections span two instructors must not print one of them as
  // though it were the answer.
  { name: "programs · a multi-instructor program says so", path: "/{org}/programs?tab=summary",
    needs: "[data-prog-instrcell=\"2\"]" },
  // stubMode is a per-CASE field, not a URL parameter — the harness answers the
  // browser's /api/ requests itself, so a query flag on the page URL never
  // reaches the stub. Passing it in the URL is why this case first reported the
  // column present on a pre-v6 feed.
  { name: "programs · no instructor CELL on a pre-v6 feed", path: "/{org}/programs?tab=summary",
    stubMode: "previnstr", needs: ".sum-prog-table", absent: "[data-prog-instrcell]" },

  // Dan, on Essex Junction: "I think the autopay icon is supposed to be on
  // here, no?" It was not — card 17295 v7's columns were mapped, rolled up per
  // program, and displayed nowhere but the summary KPI. Keyed on the CELL's
  // computed VALUE, because a column of dashes renders just as happily.
  { name: "programs · the revenue table shows the auto-pay share", path: "/{org}/programs?tab=revenue",
    needs: "[data-prog-autopay]",
    act: async page => {
      const v = await page.evaluate(() => Array.from(
        document.querySelectorAll("[data-prog-autopay]"), t => t.getAttribute("data-prog-autopay")));
      if (!v.some(x => x && Number(x) > 0))
        throw new Error("no program row reported an auto-pay share: " + JSON.stringify(v.slice(0, 8)));
    } },
  // The Grand Total row has to grow with the column or every figure after it
  // shifts a column left — the exact fault the last two column additions caused.
  { name: "programs · the grand total keeps its columns", path: "/{org}/programs?tab=revenue",
    needs: "[data-prog-autopaytotal]",
    act: async page => {
      const ok = await page.evaluate(() => {
        var head = document.querySelectorAll(".prog-table thead th").length;
        var foot = document.querySelectorAll(".prog-table tfoot td");
        var span = 0;
        foot.forEach(function (td) { span += td.colSpan || 1; });
        return span === head;
      });
      if (!ok) throw new Error("the Grand Total row does not span the same number of columns as the header");
    } },
  // A program with no payment plans reads a dash, never a confident 0%.
  { name: "programs · no auto-pay column on a pre-v7 feed", path: "/{org}/programs?tab=revenue",
    stubMode: "prev7", needs: ".prog-table", absent: "[data-prog-autopay]" },
  // A section row is ONE section. A dash there put a parent reading "2" over
  // two rows reading nothing, which is what read as the numbers not matching.
  { name: "programs · a section row counts itself", path: "/{org}/programs?tab=revenue",
    needs: '[data-prog-seccount="1"]',
    act: async page => {
      await page.click("[data-prog-progrow] td");
      await page.waitForSelector('[data-prog-seccount="1"]', { timeout: 20000 });
    } },

  { name: "programs · the section rows name their location", path: "/{org}/programs?tab=revenue",
    act: p => openProgram(p, "Aquatic Exercise"), needs: '[data-prog-seccell-location="Urho Saari Swim Stadium"]' },
  { name: "programs · ...and who teaches them", path: "/{org}/programs?tab=revenue",
    act: p => openProgram(p, "Aquatic Exercise"), needs: '[data-prog-seccell-instructor="Pearlena Sok"]' },
  // A section with more than one facilitator says so. Printing only the primary
  // is a confident half-truth, which is why location_count shipped beside
  // location in the first place.
  { name: "programs · a second facilitator is marked", path: "/{org}/programs?tab=revenue",
    act: p => openProgram(p, "Aquatic Exercise"), needs: '[data-prog-secmore-instructor="2"]' },
  // PRESENCE, NOT VALUE: on a pre-v6 feed the columns are ABSENT, not a column
  // of dashes claiming nobody teaches anything.
  { name: "programs · no instructor column on a pre-v6 feed", path: "/{org}/programs?tab=revenue",
    stubMode: "previnstr", needs: ".summary-cards", absent: "[data-prog-seccell-instructor]" },
  // The filter itself. Keyed on the PROGRAM COUNT, not on the control existing —
  // "a checkbox rendered" passes on a filter that filters nothing. Pearlena
  // teaches sec-aq-1 and sec-ww-1, which are two DIFFERENT programs, so ticking
  // her reads 2 of 3; an ignored tick reads 3 and an over-eager one reads 1.
  { name: "programs · an instructor filter EXISTS", path: "/{org}/programs",
    needs: "[data-prog-instructor-btn]" },
  { name: "programs · a ticked instructor scopes the report", path: "/{org}/programs",
    act: p => pickInstructor(p, "Pearlena Sok"), needs: '[data-prog-count="2"]' },
  // "No instructor on file" is an option because it is the largest bucket most
  // orgs have — 155 of 286 sections at El Segundo. Without it those sections
  // vanish the moment anyone ticks a name and nothing says they were dropped.
  { name: "programs · unassigned sections are their own option", path: "/{org}/programs",
    act: p => pickInstructor(p, "No instructor on file"), needs: '[data-prog-count="1"]' },

  // ── By month: two readings, and they must peak in DIFFERENT months ────────
  // The whole design claim is that programming and money peak apart — measured
  // at El Segundo, September against August. The fixture forces that gap, so a
  // panel drawing one series twice fails rather than looking plausible.
  { name: "programs · the activity peak is its own month", path: "/{org}/programs?start_date=2026-07-01&end_date=2026-12-31",
    needs: '[data-prog-peak-activity="2026-09"]' },
  { name: "programs · the money peak is a DIFFERENT month", path: "/{org}/programs?start_date=2026-07-01&end_date=2026-12-31",
    needs: '[data-prog-peak-money="2026-08"]' },
  // A feed that has not answered is not a month that earned nothing. Until card
  // 21055 has a public link the route 404s, and the money chart must be ABSENT
  // while the activity chart still draws.
  { name: "programs · no money chart without its card", path: "/{org}/programs?start_date=2026-07-01&end_date=2026-12-31",
    stubMode: "nomonthly", needs: "[data-prog-peak-activity]", absent: "[data-prog-peak-money]" },
  // One month is not a series. A single bar labelled "by month" is noise, so the
  // panel hides itself rather than drawing it.
  { name: "programs · no by-month panel in a one-month window", path: "/{org}/programs?start_date=2026-09-01&end_date=2026-09-30",
    // .sum-cards, not .summary-cards: this lands on the SUMMARY tab and the
    // latter is the Revenue tab's class. An absent-assertion whose `needs`
    // never matches proves nothing at all, so getting this right is the whole
    // difference between a guard and a vacuous pass.
    needs: ".sum-cards", absent: "[data-prog-bymonth]" },
  // Card 21055 is org-wide and month-grain — there is no location, season or
  // instructor on it to filter by. So a filtered page WITHDRAWS the money chart
  // rather than leaving it beside an activity chart describing a different
  // population. Two panels disagreeing is the facility Summary bug.
  { name: "programs · a filter withdraws the unscopeable chart", path: "/{org}/programs?start_date=2026-07-01&end_date=2026-12-31",
    act: p => pickInstructor(p, "Pearlena Sok"),
    needs: "[data-prog-peak-activity]", absent: "[data-prog-peak-money]" },

  { name: "programs · two ticks are a UNION", path: "/{org}/programs",
    // 2, not 0. An intersection — the obvious wrong reducer — empties the report,
    // and an ignored second tick leaves it at 1, so this number separates all three.
    needs: '[data-prog-count="2"]',
    act: async page => {
      await openSeasons(page);
      await tickSeason(page, "Fall '26");
      await tickSeason(page, "Spring/Summer 26");
    } },
  { name: "programs · No Season is a real option", path: "/{org}/programs",
    // The card COALESCEs to this literal, and one fixture section carries it.
    // If seasonKey stopped folding empty/null into it this would read 0.
    needs: '[data-prog-count="1"]',
    act: async page => { await openSeasons(page); await tickSeason(page, "No Season"); } },
  { name: "programs · ?season= deep link lands scoped", path: "/{org}/programs?season=Fall%20%2726",
    // The apostrophe is the point: a real season name has to survive the URL
    // round-trip. Landing unscoped reads [data-prog-count="3"], so this fails
    // both when the parameter is not whitelisted and when it is dropped on mount.
    needs: '[data-prog-count="1"]' },

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
  // Both readings of "by month" in one file, because they peak eight weeks
  // apart — a file with one series invites the confusion the panel prevents.
  { name: "programs · by-month downloads both series",
    // The same window the peak cases use — the panel hides itself under two
    // months, and correctly so.
    path: "/{org}/programs?tab=summary&start_date=2026-07-01&end_date=2026-12-31",
    needs: 'body[data-pcsv-hdr="1"][data-pcsv-future="1"]',
    act: async page => {
      await page.waitForSelector('[data-panel-csv="programs-by-month"]', { timeout: 45000 });
      await page.evaluate(() => {
        window.__payload = null;
        window.open = () => ({ document: { write() {}, close() {} },
          set __recExport(v) { window.__payload = v; },
          get __recExport() { return window.__payload; } });
      });
      await page.click('[data-panel-csv="programs-by-month"]');
      await page.evaluate(() => {
        const p = window.__payload;
        if (!p) return;
        const set = (k, v) => { if (v) document.body.setAttribute(k, v); };
        const lines = new TextDecoder().decode(p.bytes).replace(/\r\n$/, "").split("\r\n");
        set("data-pcsv-hdr",
          lines[0] === "Month,Sections running,Money collected,Month in the future" ? "1" : "");
        // A future month is MARKED, so a reader cannot mistake unsold inventory
        // for a month that earned nothing.
        set("data-pcsv-future", lines.slice(1).some(l => /,(yes|no)$/.test(l)) ? "1" : "");
      });
    } },

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
    needs: "[data-ar-count=\"6\"]" },
  { name: "memberships · auto-renew monthly revenue", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-mrr=\"157\"]" },
  // Only the annual plan qualifies: it is open-ended and renewing by hand. The
  // six season passes must NOT be here — a season pass expiring is the season
  // closing, and offering it as a conversion candidate sends an admin chasing
  // churn that does not exist.
  { name: "memberships · season passes are not conversion candidates", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-cands=\"1\"]" },

  // A pre-v2 cache entry still knows WHO auto-renews (from Renewal Type), so the
  // count must be identical across both feed shapes — the cache invariant. What
  // it cannot know is the billing cycle, so the monthly figure hides rather than
  // rendering a $0 that would read as "this org earns nothing".
  { name: "memberships · auto-renew count survives a pre-v2 feed", path: "/{org}/memberships?tab=autorenew",
    stubMode: "prev2", needs: "[data-ar-count=\"6\"]" },
  { name: "memberships · no invented monthly on a pre-v2 feed", path: "/{org}/memberships?tab=autorenew",
    stubMode: "prev2", needs: "[data-ar-pending=\"1\"]", absent: "[data-ar-mrr]" },
  // ── Passes are not subscriptions ────────────────────────────────────────
  // The v2 bug in a browser: 12 gate admissions at $5 with no group, which the
  // old shape test called open-ended subscriptions and offered for conversion.
  { name: "memberships · gate passes are not conversion candidates", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-cands=\"1\"]" },
  // Keyed on the DENOMINATOR, not on the auto-renew count: nothing excluded here
  // ever auto-renews, so leaving them in moves the base and nothing else — the
  // count reads 4 whatever the rule, and cannot discriminate.
  //
  // The fixture is 6 season + 4 monthly + 1 annual + 12 gate passes, all active
  // and paid. Only the 5 subscription-shaped ones can carry auto-renew, so 5 is
  // the base and the rate is 4/5 = 80%. Counting every paid row gives 23 and a
  // rate of 17% — which is the shape of the bug: Norman read 7.1% when it was
  // really at 97.6%.
  // THE TABLE IS THE AUTO-RENEW BOOK. Of the fixture's four plans only "Monthly
  // Individual" has anybody enrolled, so it is the only row. The Annual plan is
  // the discriminator this case exists for: it is subscription-shaped and
  // eligible, so every earlier rule would have listed it at 0% — it belongs on
  // the Could Convert card instead.
  { name: "memberships · the plan table is the auto-renew book", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-plans=\"2\"]", absent: "[data-ar-plan=\"Annual Individual\"]" },
  // ── Is this plan working out? ──────────────────────────────────────────
  // 4 Monthly Individual (all live) + 5 Monthly Family (2 live, 3 cancelled).
  // Renewals: start 2026-06-01, period start 2026-08-29, 31-day cycle → 89/31
  // rounds to 3 each, over the 6 memberships that still have a cycle → 18.
  { name: "memberships · renewals are derived from the period dates", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-renewals=\"18\"]" },
  // 3 of 9 ever-auto-renewing memberships have cancelled. Counting only ACTIVE
  // rows, as every earlier version of this table did, makes this unmeasurable.
  // CHURN PER RENEWAL, not lifetime-cancelled. The two differ on this fixture --
  // 3 of 9 have ever cancelled (33%) but those 3 cancellations sit against 18
  // renewals, so the hazard rate is 14.3%. A case keyed on 33.3 would pass on
  // the old lifetime figure, which is exactly the number that read as a crisis.
  { name: "memberships · churn is per renewal, not lifetime", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-churn=\"14.3\"]" },
  // The two plans must read DIFFERENTLY, or the column cannot answer "which
  // one is working out".
  // 3 cancellations against 6 renewals on this plan.
  { name: "memberships · a churning plan is visibly worse than a healthy one", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-plan=\"Monthly Family\"] [data-ar-cancel-rate=\"33.3\"]" },
  { name: "memberships · a healthy plan reads zero churn", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-plan=\"Monthly Individual\"] [data-ar-cancel-rate=\"0\"]" },
  // Averaged over the memberships that CAN answer. Folding the 3 cancelled
  // rows in as 0 would drag this to 1.2 and punish the plan for retaining
  // people long enough to have renewals at all.
  { name: "memberships · a cancelled row contributes tenure, not a zero renewal", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-plan=\"Monthly Family\"] [data-ar-plan-renew=\"3\"]" },
  // Scheduled-to-cancel is a different state from cancelled: still billing,
  // still in the book, will not renew.
  { name: "memberships · a pending cancellation is not a cancellation", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-pending-cancel=\"1\"]" },
  { name: "memberships · no false zero for pending cancels pre-v4", path: "/{org}/memberships?tab=autorenew",
    stubMode: "prev2", needs: "[data-ar-nosched=\"1\"]", absent: "[data-ar-pending-cancel]" },
  // THE COHORT CHART IS FED THE AUTO-RENEW SUBSET, not the feed. The fixture
  // spans four purchase months (May season, Jun monthly, Jul family, Aug
  // passes); only two of them contain auto-renewers, so 2 proves the scoping
  // and 4 would prove it was handed everything.
  { name: "memberships · the retention chart covers auto-renewers only", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-cohorts=\"2\"]" },

  // ── WHO is leaving, not just how many ──────────────────────────────────
  // A count with nowhere to go is the dead end the Failed check-ins tile had.
  // The list must be ABSENT until asked for -- an always-open list is a
  // different (and noisier) feature from an expander.
  { name: "memberships · the leaving-soon list is closed until asked for", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-pending-toggle=\"Monthly Family\"]", absent: "[data-ar-pending-list]" },
  { name: "memberships · expanding it names the member", path: "/{org}/memberships?tab=autorenew",
    act: async (page) => {
      await page.click('[data-ar-pending-toggle="Monthly Family"]');
      await new Promise(r => setTimeout(r, 250));
    },
    needs: "[data-ar-pending-list=\"Monthly Family\"] [data-ar-pending-member]" },
  // The name has to LINK to the member's Rec account, built from the uuid --
  // an anchor alone passes on a link built from the wrong id.
  { name: "memberships · and links them through to Rec", path: "/{org}/memberships?tab=autorenew",
    act: async (page) => {
      await page.click('[data-ar-pending-toggle="Monthly Family"]');
      await new Promise(r => setTimeout(r, 250));
    },
    needs: "[data-ar-pending-list] a[href$=\"/users/d60fea14-be38-46db-96da-40e61ccca25d\"]" },

  // ── Retention, per plan ────────────────────────────────────────────────
  // A blended curve answers "does this org retain", which is a different
  // question from "does THIS plan retain".
  // ── The three plain-language highlights ────────────────────────────────
  // Monthly Family is 5 x $40 = $200 a cycle against Monthly Individual's
  // 4 x $20 = $80, so it is the biggest earner even though it is the one that
  // churns. Revenue ranks over every plan; no rate is being claimed.
  { name: "memberships · the biggest earner is named", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-hl=\"revenue\"] [data-ar-hl-plan=\"Monthly Family\"]" },
  // NEITHER fixture plan reaches the 20-member floor, so there is no honest
  // best or worst to crown. A 4-member plan at 0% is four people who have not
  // left yet. Absence is the assertion -- "renders a winner" would pass on a
  // build that happily ranks a 3-member plan.
  { name: "memberships · no best/worst crowned on a thin book", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-hl=\"revenue\"]", absent: "[data-ar-hl=\"best\"]" },
  { name: "memberships · and no worst either", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-hl=\"revenue\"]", absent: "[data-ar-hl=\"worst\"]" },

  // Rec Insights has to be OFFERED on this tab -- the section is shared across
  // tabs and was gated to three of them, so the button was simply absent here.
  { name: "memberships · rec insights is offered on the auto-renew tab", path: "/{org}/memberships?tab=autorenew",
    needs: ".insights-section .insights-btn" },
  // ABOVE the tab body, not stranded under a full-height cohort chart. Keyed on
  // document order rather than "a button rendered", because the button rendered
  // perfectly well at the bottom of the page.
  { name: "memberships · rec insights sits near the top", path: "/{org}/memberships?tab=autorenew",
    needs: ".insights-section",
    act: async (page) => {
      await page.waitForSelector(".insights-section .insights-btn", { timeout: 30000 });
      const above = await page.evaluate(() => {
        const ins = document.querySelector(".insights-section");
        const body = document.querySelector("[data-ar-count-note]");
        if (!ins || !body) return false;
        return !!(ins.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      if (!above) throw new Error("Rec Insights renders BELOW the tab content");
    } },
  { name: "memberships · retention opens on the whole book", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-ret-scope=\"all\"]" },
  // Picking a plan must RESCOPE the chart, not just light a pill. Monthly
  // Individual is 4 members created in one month, so one cohort -- against two
  // for the whole book. A pill that lit without filtering would still read 2.
  { name: "memberships · a plan pill rescopes the cohorts", path: "/{org}/memberships?tab=autorenew",
    act: async (page) => {
      await page.click('[data-ar-ret-pill="Monthly Individual"]');
      await new Promise(r => setTimeout(r, 250));
    },
    needs: "[data-ar-cohorts=\"1\"] [data-ar-ret-scope=\"Monthly Individual\"]" },
  // A four-member slice is individual departures, not a trend, and the panel
  // has to say so rather than drawing a confident staircase.
  { name: "memberships · a thin slice says so", path: "/{org}/memberships?tab=autorenew",
    act: async (page) => {
      await page.click('[data-ar-ret-pill="Monthly Individual"]');
      await new Promise(r => setTimeout(r, 250));
    },
    needs: "[data-ar-ret-thin=\"1\"]" },
  { name: "memberships · and the candidate plan is NAMED, not just counted", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-cand-plan=\"Annual Individual\"]" },
  // Named and counted, not silently dropped — "6 season plans ($1,440)" is
  // itself worth reading, and a silent exclusion is how a number stops being
  // trusted.
  { name: "memberships · the excluded shapes are named on screen", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-excl=\"season\"][data-ar-excl-n=\"6\"]" },
  { name: "memberships · and so are the passes", path: "/{org}/memberships?tab=autorenew",
    needs: "[data-ar-excl=\"pass\"][data-ar-excl-n=\"12\"]" },
  // A season plan sitting at 0% is not a misconfiguration, and six of them
  // filled the top of Norman's table and buried the two cash plans that were
  // the actual finding.
  { name: "memberships · a season plan is not in the book", path: "/{org}/memberships?tab=autorenew",
    absent: "[data-ar-plan=\"Summer Season Pass\"]", needs: "[data-ar-plan=\"Monthly Individual\"]" },
  { name: "memberships · a pass plan is not in the config table", path: "/{org}/memberships?tab=autorenew",
    absent: "[data-ar-plan=\"Tournament Gate Adult $5\"]", needs: "[data-ar-plan=\"Monthly Individual\"]" },
  // Without Product Kind nothing may be called open-ended, so the card must say
  // so rather than render a confident zero.
  { name: "memberships · no conversion count without Product Kind", path: "/{org}/memberships?tab=autorenew",
    stubMode: "prev2", needs: "[data-ar-nokind=\"1\"]", absent: "[data-ar-cands]" },

  // ── Sales & Mix reads in plain language ─────────────────────────────────
  { name: "memberships · month bars carry unit counts", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-mo-units=\"6\"]" },
  // Both keyed on the COMPUTED branch, not on presence: a headline that says
  // "more" about a month that fell, or a verdict that blames volume for a mix
  // shift, renders exactly like a correct one.
  { name: "memberships · the change has a plain-language headline", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-headline=\"down\"]" },
  { name: "memberships · and a verdict that names the cause", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-verdict=\"mix\"]" },

  // Jul (1 unit / $240) → Aug (12 units / $60): units UP 11, revenue DOWN $180,
  // because a $240 membership was replaced by twelve $5 gate passes. That is
  // exactly the mix shift the panel exists to name — a unit line alone reads as
  // a boom, a revenue line alone as a collapse. Both halves asserted, because
  // the bridge must sum: +2,640 volume and −2,820 price give −180.
  //
  // Passes ARE counted here, unlike on the Auto-Renew tab. They are real sales;
  // what they cannot do is auto-renew.
  { name: "memberships · sales decomposition", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-decomp] [data-sm-volume=\"960\"]" },
  { name: "memberships · price half of the bridge", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-decomp] [data-sm-price=\"-1220\"]" },
  { name: "memberships · units rose", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-unit-delta=\"9\"]" },
  { name: "memberships · revenue fell in the same month", path: "/{org}/memberships?tab=salesmix",
    needs: "[data-sm-rev-delta=\"-260\"]" },
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
  const running = only ? CASES.filter(c => c.name.includes(only)) : CASES;
  for (const c of running) {
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
        // A stub may declare a STATUS. Needed because some page behaviour only
        // exists on a failure — the settings unlock renders its error from a
        // 401, and a stub that always says 200 makes the page look like it
        // succeeded and reload, which is indistinguishable from working.
        // A status may also be a FUNCTION, for the same reason `body` is one:
        // STUBS is built once at module load, so a status that depends on
        // STUB_MODE has to be evaluated per request or every case gets whatever
        // mode happened to be set when the file was required.
        const st = stub && stub.status;
        return req.respond({ status: (typeof st === "function" ? st() : st) || 200, contentType: "application/json",
                             body: JSON.stringify(stub ? stub.body(u, org) : { ok: true }) });
      }
      if (!u.startsWith(`http://127.0.0.1:${PORT}`)) return serveVendored(req);
      req.continue();
    });

    STUB_MODE = c.stubMode || "";
    // Optional: set up the BROWSER before the first navigation. A cookie set in
    // `act` is set too late — the page it decides has already been served.
    // Hooks get the resolved org: a case that writes SERVER state (a settings
    // record, a flag) has to key it by slug, and the slug is not known at
    // case-definition time.
    if (c.pre) await c.pre(page, { org, dataDir, token });
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

      // AN ESCAPE SEQUENCE THAT REACHED THE SCREEN. Checked on EVERY case, not
      // per-selector, because it is a class of bug rather than one panel's
      // problem — and because every existing case would sail past it.
      //
      // JSX text is not a JS string: `\uD83D\uDD01` written as bare markup is
      // eight literal characters, not an emoji. That shipped to production in
      // the Auto-Renew scope note, and the case covering that very line passed
      // because it asserted a data- attribute rather than what a person reads.
      // Assert on rendered TEXT when the thing you changed is text.
      const rawEscapes = await page.evaluate(() => {
        const t = document.body.innerText || "";
        const m = t.match(/\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|&[a-z]+;|&#\d+;/);
        return m ? m[0] + "  in: " + t.slice(Math.max(0, t.indexOf(m[0]) - 40), t.indexOf(m[0]) + 40).replace(/\s+/g, " ") : null;
      });
      if (rawEscapes) errs.push("an unrendered escape reached the screen: " + rawEscapes);
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
    // Server state a case changed is restored here, whether it passed or not —
    // a case that leaves a settings record behind silently reconfigures every
    // case after it.
    if (c.after) { try { await c.after({ org, dataDir, token }); } catch (_) {} }

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
  // Report what RAN, not CASES.length — a filtered run that matched nothing
  // printed "238 page(s) render" and read as a full clean pass.
  stop(true, `${running.length} page(s) render with no uncaught errors`);
})();
