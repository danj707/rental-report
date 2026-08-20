// ── Facility rental "posting sheet" ──────────────────────────────────────────
//
// The one-pager maintenance prints and hangs at the pavilion/field/gym.
//
// Deliberately NOT a copy of Rec's own permit PDF. That document is the whole
// rental — a Goodyear example ran 60+ occurrences across 4 pages — and it is
// built for the permit holder to carry. This is one site, in type you can read
// from across a pavilion, and the QR is the path back to the permit rather than
// a reprint of it.
//
// It is not one DAY, though. A permit covers the whole rental, and a sheet goes
// up once at the start of a run and stays up: printing only the exported row's
// date tells a parks crew the field is booked for a single afternoon when it is
// actually booked every Friday until September. Multi-date permits get the full
// list of authorised dates, scoped to the site the sheet is hung at.
//
// Pure functions: no Express, no Metabase, no fs. The QR arrives as a data URI
// from the caller so this module stays testable without a render pass.

"use strict";

const esc = s => String(s == null ? "" : s)
  .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Conditions text is org-authored and unbounded — Pawnee's runs five numbered
// paragraphs of terms, which overflowed the sheet and painted over the next
// page. The full text lives on the permit the QR opens; this sheet only needs
// enough of it to be recognisable.
function clamp(str, max) {
  const t = String(str == null ? "" : str).replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, "") + "\u2026";
}

// "2026-09-05" → "Saturday, September 5, 2026". Parsed by hand rather than
// through Date so a bare ISO date can't be shifted a day by the server's zone.
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const y = +m[1], mo = +m[2], d = +m[3];
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${MONTHS[mo - 1]} ${d}, ${y}`;
}

const DOW3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-09-05" → "Sat Sep 5" (or "Sat Sep 5 '26" when a run crosses new year).
// Same hand-parse as longDate, for the same reason.
function shortDate(iso, withYear) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const y = +m[1], mo = +m[2], d = +m[3];
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${DOW3[dow]} ${MON3[mo - 1]} ${d}` + (withYear ? ` '${m[1].slice(2)}` : "");
}

// "Aug 7 – Sep 25, 2026", or both years spelled out when the run crosses one.
function dateSpan(first, last) {
  const fy = String(first).slice(0, 4), ly = String(last).slice(0, 4);
  const plain = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? `${MON3[+m[2] - 1]} ${+m[3]}` : String(iso || "");
  };
  if (first === last) return `${plain(first)}, ${fy}`;
  return fy === ly
    ? `${plain(first)} \u2013 ${plain(last)}, ${fy}`
    : `${plain(first)}, ${fy} \u2013 ${plain(last)}, ${ly}`;
}

// The card emits times already formatted ("05:30pm"); tidy the leading zero so
// the biggest text on the page doesn't read as a serial number.
const tidyTime = t => String(t || "").replace(/^0/, "").toUpperCase().toLowerCase();

function timeRange(begin, end) {
  const b = tidyTime(begin), e = tidyTime(end);
  if (b && e) return `${b} – ${e}`;
  return b || e || "All day";
}

// A permit's whole run, reduced to what a sheet on ONE post should say.
//
// `s.schedule` is the card's JSON array of {d, s, e, site} for every occurrence
// of the permit — every date, at every site it covers. Two reductions happen
// here:
//
//   1. Scope to this sheet's site. A permit that books the Multipurpose Field
//      every Friday and the Kitchen once should not put the Kitchen date on the
//      field's sheet — someone reading it at the fence would count a date that
//      does not apply to the space in front of them. The site key is
//      court.court_number, the same value the schedule feed calls "Facility".
//   2. Group by time. Recurring rentals almost always keep one time, so the run
//      collapses to a single line of dates; when the times genuinely differ,
//      each time gets its own line rather than a date list you cannot read.
//
// Returns null for single-date permits (and when the card sends no schedule):
// their sheet already states the one date, and the caller falls back to it.
const MAX_DATE_CHIPS = 32;

const normSite = v => String(v == null ? "" : v).replace(/\s+/g, " ").trim().toLowerCase();

function buildSchedule(s) {
  let rows = s && s.schedule;
  if (typeof rows === "string") { try { rows = JSON.parse(rows); } catch (e) { rows = null; } }
  if (!Array.isArray(rows) || !rows.length) return null;

  const mine = s.site ? rows.filter(r => normSite(r.site) === normSite(s.site)) : [];
  // No match means the sheet's site never appears in the permit's own rows
  // (a renamed court, or a booking with no court attached). Falling back to the
  // full run is the safe read: too many dates is a staffer double-checking,
  // whereas silently dropping to one date is the bug this exists to prevent.
  const use = mine.length ? mine : rows;
  const oneSite = mine.length > 0 || new Set(use.map(r => String(r.site || ""))).size <= 1;

  const dates = Array.from(new Set(use.map(r => String(r.d)))).sort();
  if (dates.length < 2) return null;
  const withYear = new Set(dates.map(d => d.slice(0, 4))).size > 1;

  const groups = new Map();
  for (const r of use) {
    const key = oneSite ? `${r.s}|${r.e}` : `${r.s}|${r.e}|${r.site || ""}`;
    if (!groups.has(key)) {
      groups.set(key, { time: timeRange(r.s, r.e), site: oneSite ? "" : String(r.site || ""), dates: [] });
    }
    const g = groups.get(key);
    const d = String(r.d);
    if (!g.dates.includes(d)) g.dates.push(d);
  }
  const list = Array.from(groups.values());
  list.forEach(g => g.dates.sort());
  list.sort((a, b) => (a.dates[0] < b.dates[0] ? -1 : a.dates[0] > b.dates[0] ? 1 : 0));

  // Hard cap in JS rather than CSS clipping: a sheet that quietly loses its
  // last rows to overflow looks complete and is not. Anything past the cap is
  // announced, and the QR still opens the full permit.
  let budget = MAX_DATE_CHIPS, dropped = 0;
  const out = [];
  for (const g of list) {
    const take = g.dates.slice(0, Math.max(budget, 0));
    dropped += g.dates.length - take.length;
    budget -= take.length;
    if (take.length) out.push({ time: g.time, site: g.site, dates: take });
  }

  return {
    count: dates.length,
    span: dateSpan(dates[0], dates[dates.length - 1]),
    commonTime: list.length === 1 ? list[0].time : "",
    groups: out, dropped, withYear,
  };
}

const CSS = `
  @page { size: Letter portrait; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color:#000; margin:0;
         -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .sheet { page-break-after: always; break-after: page;
           page-break-inside: avoid; break-inside: avoid;
           height: 9.9in; overflow: hidden; display:flex; flex-direction:column; }
  .sheet:last-child { page-break-after: auto; break-after: auto; }

  .top { display:flex; justify-content:space-between; align-items:center; gap:16px;
         border-bottom:3px solid #000; padding-bottom:12px; }
  .brand { display:flex; align-items:center; gap:12px; min-width:0; }
  .logo { height:46px; width:auto; max-width:2.2in; object-fit:contain; display:block; }
  .org { font-size:16px; font-weight:700; letter-spacing:.01em; }
  .dept { font-size:12px; color:#333; }
  .kicker { font-size:11px; font-weight:700; letter-spacing:.16em; text-align:right; white-space:nowrap; }
  .code { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:14px; font-weight:700;
          letter-spacing:.06em; text-align:right; margin-top:3px; }

  .body { flex:1 1 auto; min-height:0; overflow:hidden;
          display:flex; gap:30px; padding-top:24px; align-items:flex-start; }
  .left { flex:1; min-width:0; min-height:0; overflow:hidden; }
  .right { flex:0 0 auto; }
  .right { width:2.7in; text-align:center; }

  .label { font-size:10px; font-weight:700; letter-spacing:.16em; color:#666; margin-bottom:5px; }
  .rental { font-size:52px; line-height:1.04; font-weight:800; letter-spacing:-.025em; margin:0 0 6px;
            word-wrap:break-word; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;
            overflow:hidden; }
  .holder { font-size:19px; color:#222; margin-bottom:24px; }

  .site { font-size:34px; font-weight:700; line-height:1.12; margin:0 0 3px;
          display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .loc  { font-size:19px; color:#333; margin-bottom:24px; }

  .when { border:3px solid #000; padding:18px 20px; margin-bottom:20px; }
  .date { font-size:22px; font-weight:700; }
  .time { font-size:56px; font-weight:800; letter-spacing:-.025em; line-height:1.05; }
  /* Multi-date sheets spend their height on the date list instead. */
  .multi .rental { -webkit-line-clamp:2; font-size:44px; }
  .multi .holder, .multi .loc { margin-bottom:16px; }
  .multi .site { font-size:30px; }
  .multi .when { margin-bottom:14px; padding:14px 18px; }
  .multi .time { font-size:40px; }
  .time.vary { font-size:22px; font-weight:700; letter-spacing:0; }

  .meta { font-size:15px; color:#222; line-height:1.6; overflow:hidden; }
  .multi .meta { font-size:14px; line-height:1.5; }
  .meta b { color:#000; }
  /* Org-authored conditions are unbounded prose. The character clamp keeps the
     block roughly the right size; line-clamp is what stops a sheet ending on
     half a sliced word, which reads as a printing fault rather than a summary. */
  .cond { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .multi .cond { -webkit-line-clamp:2; }

  /* Authorized dates: full page width, below the QR column, so a long run gets
     8 dates to a line instead of 3. flex:0 0 auto — the body above it shrinks,
     this block never does. */
  .multi .body  { flex:0 1 auto; }
  .multi .stamp { margin-top:auto; }
  .dates { flex:0 0 auto; border-top:2px solid #000; padding-top:10px; margin-bottom:12px;
           margin-top:22px;
           max-height:2.1in; overflow:hidden; }
  .drow { display:flex; gap:12px; align-items:baseline; margin-top:6px; }
  .dtime { flex:0 0 auto; font-size:14px; font-weight:700; white-space:nowrap; }
  .dlist { font-size:15px; line-height:1.55; font-weight:600; }
  .dmore { font-size:12px; color:#444; margin-top:6px; }

  .qrbox { border:2px solid #000; padding:12px; }
  .qrbox img { width:100%; display:block; }
  .qrcap { font-size:11px; font-weight:700; letter-spacing:.14em; margin-top:9px; }
  .qrsub { font-size:10px; color:#555; margin-top:4px; line-height:1.4; }

  .multi .stamp { font-size:26px; padding:11px 0; }
  .stamp { text-align:center; font-size:30px; font-weight:800; letter-spacing:.10em;
           border-top:3px solid #000; border-bottom:3px solid #000; padding:14px 0; margin-bottom:12px; }
  .foot { border-top:2px solid #000; padding-top:8px; font-size:10px; color:#444;
          display:flex; justify-content:space-between; }
`;

function datesBlock(run) {
  const rows = run.groups.map(g => {
    const lead = [g.time, g.site].filter(Boolean).join(" \u00b7 ");
    const list = g.dates.map(d => esc(shortDate(d, run.withYear))).join(" &nbsp;&middot;&nbsp; ");
    // With one time for the whole run it is already stated above the fold, so
    // the line is dates only and gets the full width.
    return '<div class="drow">'
      + (run.commonTime ? "" : `<span class="dtime">${esc(lead)}</span>`)
      + `<span class="dlist">${list}</span>`
    + '</div>';
  }).join("");
  return '<div class="dates">'
    + '<div class="label">AUTHORIZED DATES</div>'
    + rows
    + (run.dropped
        ? `<div class="dmore">+ ${run.dropped} more date${run.dropped === 1 ? "" : "s"} \u2014 scan the QR for the full permit.</div>`
        : "")
  + '</div>';
}

// One sheet. `s` carries the merged facility row + permit row; `qr` is a data URI.
//
// The permit holder's phone is deliberately left off. Rec's permit prints
// "Name · (510) 999-8756" because that document lives in the holder's bag; this
// one is taped to a post in a public park, which is a different exposure.
function sheet(s, qr) {
  const holder = s.holder ? `Permit holder: ${esc(s.holder)}` : "";
  const run = buildSchedule(s);

  // Single date: the row's own day, as big as it will go. Multi-date: the run,
  // with the dates themselves carried in the block below the fold.
  const dateLine = run ? `${run.count} DATES &middot; ${esc(run.span)}` : esc(longDate(s.date));
  const timeLine = run
    ? (run.commonTime ? esc(run.commonTime) : "Times vary \u2014 see dates below")
    : esc(timeRange(s.begin, s.end));
  const timeCls = run && !run.commonTime ? "time vary" : "time";

  // "163 max" on its own reads as an expected headcount someone typed. When
  // there is no expected count — most instant bookings — the number is the
  // room's, and it gets the room's label.
  const attendance = s.headcount
    ? esc(s.headcount) + (s.capacity ? ` &middot; ${esc(s.capacity)} max` : "")
    : "";
  const capacityOnly = !s.headcount && s.capacity ? esc(s.capacity) : "";

  return `<div class="sheet${run ? " multi" : ""}">`
    + '<div class="top">'
      + '<div class="brand">'
        + (s.logo ? `<img class="logo" src="${s.logo}" alt="" />` : "")
        + `<div><div class="org">${esc(s.org)}</div><div class="dept">${esc(s.dept)}</div></div>`
      + '</div>'
      + '<div><div class="kicker">RESERVED &middot; FACILITY USE PERMIT</div>'
        + (s.code ? `<div class="code">PERMIT ${esc(s.code)}</div>` : "")
      + '</div>'
    + '</div>'
    + '<div class="body">'
      + '<div class="left">'
        + '<div class="label">RESERVED FOR</div>'
        + `<h1 class="rental">${esc(s.title)}</h1>`
        + (holder ? `<div class="holder">${holder}</div>` : "")
        + '<div class="label">LOCATION</div>'
        + `<div class="site">${esc(s.site)}</div>`
        + (s.location ? `<div class="loc">${esc(s.location)}</div>` : "")
        + '<div class="when">'
          + `<div class="date">${dateLine}</div>`
          + `<div class="${timeCls}">${timeLine}</div>`
        + '</div>'
        + '<div class="meta">'
          + (attendance ? `<b>Expected attendance:</b> ${attendance}<br>` : "")
          + (capacityOnly ? `<b>Site capacity:</b> ${capacityOnly}<br>` : "")
          + (s.addons ? `<b>Add-ons:</b> ${esc(clamp(s.addons, 120))}<br>` : "")
          + (s.purpose ? `<b>Purpose:</b> ${esc(s.purpose)}<br>` : "")
          + (s.details ? `<div class="cond"><b>Conditions:</b> ${esc(clamp(s.details, 200))}</div>` : "")
        + '</div>'
      + '</div>'
      + '<div class="right">'
        + '<div class="qrbox">'
          + `<img src="${qr}" alt="Permit QR code" />`
          + '<div class="qrcap">SCAN TO VERIFY</div>'
          + '<div class="qrsub">Opens the live permit in Rec.<br>Anyone can scan &mdash; no login.</div>'
        + '</div>'
      + '</div>'
    + '</div>'
    + (run ? datesBlock(run) : "")
    + '<div class="stamp">THIS SPACE IS RESERVED</div>'
    + '<div class="foot"><span>Questions? Contact the Parks &amp; Recreation office.</span>'
      + '<span>Posted from Rec &middot; rec.us</span></div>'
  + '</div>';
}

// sheets: [{...row, qr}] — caller supplies each QR data URI.
function toHtml(sheets) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Facility rental permits</title>'
    + `<style>${CSS}</style></head><body>`
    + (sheets || []).map(s => sheet(s, s.qr)).join("")
    + '</body></html>';
}

module.exports = { toHtml, sheet, longDate, shortDate, dateSpan, timeRange, buildSchedule, esc, clamp };
