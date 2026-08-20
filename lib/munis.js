// ── Tyler/Munis "GL Account Detail" (program glgatddt) ───────────────────────
//
// Turns the line-level rows of Metabase card 20197 into the two shapes a
// finance office asks for: the flat CSV they load, and the print-style account
// detail they read. Pure functions — no Express, no Metabase, no fs — so the
// layout can be exercised without a network round trip.
//
// The format contract is the mock Dan supplied (GL_Account_Detail_export_MOCK
// .pdf). Where this code and that document disagree, the document wins.
//
// Accounting convention, inherited from the card: payments post as Credit,
// refunds as Debit, both stored positive. Balance is a running credit-minus-
// debit within an account, so a net-refunded account goes negative and prints
// with Munis' trailing minus (`50.00-`), not a leading one.

"use strict";

// Column order of the flat CSV. Verbatim from the format contract — the card
// emits exactly these names, so the CSV is a straight passthrough of its rows.
const CSV_COLUMNS = [
  "GL Code", "Account", "Effective", "Journal Ref", "Batch", "Src",
  "Method", "Description", "Customer", "Debit", "Credit", "Balance",
];

const UNMAPPED_CODE = "(none)";

// ── formatting ───────────────────────────────────────────────────────────────

// Money for the Debit/Credit columns: blank when zero, so the eye lands only on
// the side of the ledger that actually moved.
function money(n) {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return "";
  return Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Balance: always printed (0.00 included — a beginning balance of zero is a
// line Munis prints), negatives with the trailing minus.
function balance(n) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? s + "-" : s;
}

// MM/DD/YYYY from an ISO date. Parsed by hand rather than through Date so a
// bare "2026-07-01" can't be shifted a day by the server's timezone.
function mdy(iso) {
  const s = String(iso || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Fiscal year containing `iso`, given the month the year starts in (1-12).
// A July-start FY dated 2026-07-01 belongs to FY2027; 2026-06-30 to FY2026.
function fiscalYearOf(iso, startMonth) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = Number(startMonth) || 7;
  if (start === 1) return year;                 // calendar-year FY
  return month >= start ? year + 1 : year;
}

// ── grouping ─────────────────────────────────────────────────────────────────

// One entry per GL account, in the card's order (which already sorts the
// unmapped bucket last). Each carries its lines plus the account's own totals.
//
// Totals are summed here rather than read off the card's last running balance:
// a per-account SUM is right even if rows arrive re-ordered or filtered.
function groupAccounts(rows) {
  const out = [];
  const byCode = new Map();
  for (const r of rows || []) {
    const code = r["GL Code"] == null ? UNMAPPED_CODE : String(r["GL Code"]);
    let acct = byCode.get(code);
    if (!acct) {
      acct = {
        glCode: code,
        accountName: String(r["Account"] || ""),
        unmapped: code === UNMAPPED_CODE,
        lines: [],
        debit: 0,
        credit: 0,
      };
      byCode.set(code, acct);
      out.push(acct);
    }
    const debit = Number(r["Debit"]) || 0;
    const credit = Number(r["Credit"]) || 0;
    acct.debit += debit;
    acct.credit += credit;
    acct.lines.push({
      effective: r["Effective"],
      journalRef: r["Journal Ref"] || "",
      batch: r["Batch"] || "",
      src: r["Src"] || "",
      method: r["Method"] || "",
      description: r["Description"] || "",
      customer: r["Customer"] || "",
      debit,
      credit,
      balance: Number(r["Balance"]) || 0,
    });
  }
  for (const a of out) a.balance = a.credit - a.debit;
  return out;
}

// The banner the landing view and the PDF both show. Unmapped money is the
// single most consequential thing about this export — on Pawnee it is the
// majority of the ledger — so it gets counted, not buried.
function unmappedSummary(rows) {
  const un = (rows || []).filter(r => (r["GL Code"] == null ? UNMAPPED_CODE : String(r["GL Code"])) === UNMAPPED_CODE);
  const net = un.reduce((n, r) => n + (Number(r["Credit"]) || 0) - (Number(r["Debit"]) || 0), 0);
  return { count: un.length, net, total: (rows || []).length };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Flat file: header row then the card's rows, unchanged. Amounts stay raw
// numbers (no thousands separators) — this file is loaded, not read.
function toCsv(rows) {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const r of rows || []) lines.push(CSV_COLUMNS.map(c => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ── print layout ─────────────────────────────────────────────────────────────

const TYLER_VERSION = "Tyler Munis Version: 2024.7.0.1167";

// Munis' own program id for this report. Kept literal because finance staff
// search for it by name when filing.
const PROGRAM_ID = "glgatddt";

function lineRow(l) {
  return '<tr>'
    + '<td class="c-eff">' + esc(mdy(l.effective)) + '</td>'
    + '<td class="c-jrn">' + esc(l.journalRef) + '</td>'
    + '<td class="c-src">' + esc(l.src) + '</td>'
    + '<td class="c-mth">' + esc(String(l.method).slice(0, 9)) + '</td>'
    + '<td class="c-dsc">' + esc(l.description) + '</td>'
    + '<td class="c-cus">' + esc(String(l.customer).slice(0, 15)) + '</td>'
    + '<td class="c-amt">' + money(l.debit) + '</td>'
    + '<td class="c-amt">' + money(l.credit) + '</td>'
    + '<td class="c-amt">' + balance(l.balance) + '</td>'
    + '</tr>';
}

function accountBlock(a) {
  const flag = a.unmapped ? '   <span class="review">*** REVIEW: assign GL codes ***</span>' : "";
  return '<tbody class="acct">'
    + '<tr class="acct-head"><td colspan="9">Account:&nbsp; ' + esc(a.glCode) + '&nbsp;&nbsp; ' + esc(a.accountName) + flag + '</td></tr>'
    + '<tr class="begin"><td colspan="8">Beginning Balance</td><td class="c-amt">0.00</td></tr>'
    + a.lines.map(lineRow).join("")
    + '<tr class="acct-total"><td colspan="6">Account Total</td>'
      + '<td class="c-amt">' + money(a.debit) + '</td>'
      + '<td class="c-amt">' + money(a.credit) + '</td>'
      + '<td class="c-amt">' + balance(a.balance) + '</td></tr>'
    + '</tbody>';
}

// A complete standalone HTML document, rendered to PDF by Puppeteer's
// setContent (no server round trip, no React, no token). Courier throughout —
// the format is a fixed-pitch mainframe report and looks wrong in anything else.
//
// meta: { entity, department, fromDate, toDate, fiscalYear, user, generatedAt }
function toHtml(rows, meta) {
  const m = meta || {};
  const accounts = groupAccounts(rows);
  const grand = accounts.reduce((t, a) => ({ debit: t.debit + a.debit, credit: t.credit + a.credit }), { debit: 0, credit: 0 });
  const gen = m.generatedAt instanceof Date ? m.generatedAt : new Date();
  const stamp = String(gen.getMonth() + 1).padStart(2, "0") + "/" + String(gen.getDate()).padStart(2, "0") + "/" + gen.getFullYear()
    + " " + String(gen.getHours()).padStart(2, "0") + ":" + String(gen.getMinutes()).padStart(2, "0");

  const head = '<tr class="pagehead-row"><td colspan="9"><div class="pagehead">'
    + '<div class="hl">'
      + '<div>Report generated: ' + esc(stamp) + '</div>'
      + '<div>User:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;' + esc(m.user || "") + '</div>'
      + '<div>Program ID:&nbsp; ' + PROGRAM_ID + '</div>'
    + '</div>'
    + '<div class="hc">'
      + '<div class="entity">' + esc(String(m.entity || "").toUpperCase()) + '</div>'
      + '<div>' + esc(m.department || "") + '</div>'
      + '<div class="title">GENERAL LEDGER - ACCOUNT DETAIL</div>'
    + '</div>'
    + '</div>'
    + '<div class="params">Fiscal Year: ' + esc(m.fiscalYear || "") + '&nbsp;&nbsp;&nbsp;&nbsp;'
      + 'From Date: ' + esc(mdy(m.fromDate)) + '&nbsp;&nbsp;&nbsp;&nbsp;'
      + 'To Date: ' + esc(mdy(m.toDate)) + '&nbsp;&nbsp;&nbsp;&nbsp;'
      + 'Basis: Cash Receipts</div>'
    + '</td></tr>';

  return '<!doctype html><html><head><meta charset="utf-8"><title>GL Account Detail</title><style>'
    + '@page { size: Letter landscape; margin: 0.4in 0.45in 0.55in; }'
    + 'body { font-family: "Courier New", Courier, monospace; font-size: 8.5px; color: #000; margin: 0; }'
    + '.pagehead { display: flex; justify-content: space-between; align-items: flex-start; }'
    + '.hl div { line-height: 1.45; }'
    + '.hc { text-align: center; flex: 1; }'
    + '.hc .entity { font-weight: bold; font-size: 10px; }'
    + '.hc .title { font-weight: bold; margin-top: 2px; }'
    + '.params { margin: 10px 0 6px; }'
    + 'table { width: 100%; border-collapse: collapse; table-layout: fixed; }'
    + 'thead th { text-align: left; border-bottom: 1px solid #000; padding: 2px 4px 3px 0; font-weight: bold; }'
    + '.pagehead-row > td { padding: 0 0 2px; border: 0; }'
    + 'thead { display: table-header-group; }'   /* repeat the column strip on every page */
    + 'td { padding: 1px 4px 1px 0; vertical-align: top; }'
    + 'tbody.acct { page-break-inside: auto; }'
    + '.acct-head td { padding-top: 9px; font-weight: bold; }'
    + '.acct-total td { border-top: 1px solid #000; padding-top: 2px; }'
    + '.begin td, .acct-total td { font-weight: bold; }'
    + '.review { font-weight: bold; }'
    + '.c-amt { text-align: right; }'
    + 'td, th { white-space: nowrap; overflow: hidden; }'
    + 'tr { page-break-inside: avoid; }'
    + '.grand { margin-top: 14px; }'
    + '.grand .lbl { font-weight: bold; border-top: 1px solid #000; padding-top: 3px; }'
    + '</style></head><body>'
    + '<table>'
      // With table-layout:fixed the widths come from the table's FIRST row,
      // which here is the full-width page-header row — so per-cell widths get
      // ignored and every column lands equal. A colgroup states them once,
      // ahead of any row. Percentages, not pixels, so the layout follows the
      // paper instead of assuming a width for Letter landscape.
      + '<colgroup>'
        + '<col style="width:7.5%"><col style="width:7.5%"><col style="width:3%"><col style="width:7%">'
        + '<col style="width:31%"><col style="width:13%">'
        + '<col style="width:10%"><col style="width:10%"><col style="width:11%">'
      + '</colgroup>'
      + '<thead>'
      + head
      + '<tr class="colhead">'
        + '<th class="c-eff">Effective</th><th class="c-jrn">Journal</th><th class="c-src">Src</th>'
        + '<th class="c-mth">Method</th><th class="c-dsc">Description</th><th class="c-cus">Customer</th>'
        + '<th class="c-amt">Debit</th><th class="c-amt">Credit</th><th class="c-amt">Balance</th>'
      + '</tr></thead>'
      + accounts.map(accountBlock).join("")
      + '<tbody class="grand"><tr><td colspan="9" class="lbl">REPORT TOTALS</td></tr>'
        + '<tr><td colspan="6">Grand Total (all accounts)</td>'
        + '<td class="c-amt">' + money(grand.debit) + '</td>'
        + '<td class="c-amt">' + money(grand.credit) + '</td>'
        + '<td class="c-amt">' + balance(grand.credit - grand.debit) + '</td></tr>'
      + '</tbody>'
    + '</table>'
    + '</body></html>';
}

module.exports = {
  CSV_COLUMNS, UNMAPPED_CODE, TYLER_VERSION, PROGRAM_ID,
  money, balance, mdy, fiscalYearOf,
  groupAccounts, unmappedSummary, toCsv, toHtml,
};
