// ── Facility rental "posting sheet" ──────────────────────────────────────────
//
// The one-pager maintenance prints and hangs at the pavilion/field/gym.
//
// Deliberately NOT a copy of Rec's own permit PDF. That document is the whole
// rental — a Goodyear example ran 60+ occurrences across 4 pages — and it is
// built for the permit holder to carry. This is one site, one day, in type you
// can read from across a pavilion, and the QR is the path back to the permit
// rather than a reprint of it.
//
// Pure functions: no Express, no Metabase, no fs. The QR arrives as a data URI
// from the caller so this module stays testable without a render pass.

"use strict";

const esc = s => String(s == null ? "" : s)
  .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

// The card emits times already formatted ("05:30pm"); tidy the leading zero so
// the biggest text on the page doesn't read as a serial number.
const tidyTime = t => String(t || "").replace(/^0/, "").toUpperCase().toLowerCase();

function timeRange(begin, end) {
  const b = tidyTime(begin), e = tidyTime(end);
  if (b && e) return `${b} – ${e}`;
  return b || e || "All day";
}

const CSS = `
  @page { size: Letter portrait; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color:#000; margin:0;
         -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .sheet { page-break-after: always; height: 10in; display:flex; flex-direction:column; }
  .sheet:last-child { page-break-after: auto; }

  .top { display:flex; justify-content:space-between; align-items:center; gap:16px;
         border-bottom:3px solid #000; padding-bottom:12px; }
  .brand { display:flex; align-items:center; gap:12px; min-width:0; }
  .logo { height:46px; width:auto; max-width:2.2in; object-fit:contain; display:block; }
  .org { font-size:16px; font-weight:700; letter-spacing:.01em; }
  .dept { font-size:12px; color:#333; }
  .kicker { font-size:11px; font-weight:700; letter-spacing:.16em; text-align:right; white-space:nowrap; }
  .code { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:14px; font-weight:700;
          letter-spacing:.06em; text-align:right; margin-top:3px; }

  .body { flex:1; display:flex; gap:30px; padding-top:24px; align-items:flex-start; }
  .left { flex:1; min-width:0; }
  .right { width:2.7in; text-align:center; }

  .label { font-size:10px; font-weight:700; letter-spacing:.16em; color:#666; margin-bottom:5px; }
  .rental { font-size:52px; line-height:1.04; font-weight:800; letter-spacing:-.025em; margin:0 0 6px;
            word-wrap:break-word; }
  .holder { font-size:19px; color:#222; margin-bottom:24px; }

  .site { font-size:34px; font-weight:700; line-height:1.12; margin:0 0 3px; }
  .loc  { font-size:19px; color:#333; margin-bottom:24px; }

  .when { border:3px solid #000; padding:18px 20px; margin-bottom:20px; }
  .date { font-size:22px; font-weight:700; }
  .time { font-size:56px; font-weight:800; letter-spacing:-.025em; line-height:1.05; }

  .meta { font-size:15px; color:#222; line-height:1.6; }
  .meta b { color:#000; }

  .qrbox { border:2px solid #000; padding:12px; }
  .qrbox img { width:100%; display:block; }
  .qrcap { font-size:11px; font-weight:700; letter-spacing:.14em; margin-top:9px; }
  .qrsub { font-size:10px; color:#555; margin-top:4px; line-height:1.4; }

  .stamp { text-align:center; font-size:30px; font-weight:800; letter-spacing:.10em;
           border-top:3px solid #000; border-bottom:3px solid #000; padding:14px 0; margin-bottom:12px; }
  .foot { border-top:2px solid #000; padding-top:8px; font-size:10px; color:#444;
          display:flex; justify-content:space-between; }
`;

// One sheet. `s` carries the merged facility row + permit row; `qr` is a data URI.
//
// The permit holder's phone is deliberately left off. Rec's permit prints
// "Name · (510) 999-8756" because that document lives in the holder's bag; this
// one is taped to a post in a public park, which is a different exposure.
function sheet(s, qr) {
  const holder = s.holder ? `Permit holder: ${esc(s.holder)}` : "";
  return '<div class="sheet">'
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
          + `<div class="date">${esc(longDate(s.date))}</div>`
          + `<div class="time">${esc(timeRange(s.begin, s.end))}</div>`
        + '</div>'
        + '<div class="meta">'
          + (s.headcount ? `<b>Expected attendance:</b> ${esc(s.headcount)}<br>` : "")
          + (s.purpose ? `<b>Purpose:</b> ${esc(s.purpose)}<br>` : "")
          + (s.details ? `<b>Conditions:</b> ${esc(s.details)}` : "")
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

module.exports = { toHtml, sheet, longDate, timeRange, esc };
