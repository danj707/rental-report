#!/usr/bin/env node
/* Community Intel — the signup-date window and the signups-over-time chart.
   Needham: "see user signups by date/time period, basically a graph of users
   signing up." LIFTS AND RUNS the page's own helpers: every defect here is a
   comparison about a date or a bucket, and a regex passes on an inverted one.

   Re-execs under America/Los_Angeles (behind UTC): a bare YYYY-MM-DD read with
   new Date() is UTC midnight and lands on the PREVIOUS day there, which is the
   bug this has to be able to see. Under UTC (this sandbox, CI) it hides. */
const { execFileSync } = require("child_process");
if (!process.env.__SG_TZ) {
  try { execFileSync(process.execPath, [__filename], { stdio: "inherit", env: Object.assign({}, process.env, { TZ: "America/Los_Angeles", __SG_TZ: "1" }) }); process.exit(0); }
  catch (e) { process.exit(e.status || 1); }
}
const fs = require("fs"), path = require("path"), assert = require("assert");
const page = fs.readFileSync(path.join(__dirname, "..", "public", "users.html"), "utf8");
const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("✗ " + name + "\n   " + e.message); } }

const a = page.indexOf("var SIGNUP_ISO"), b = page.indexOf("function signupDaysAgo");
const c = page.indexOf("var SG_SERIES"), d = page.indexOf("function SignupsChart(");
t("the helpers are where this expects them", () => { assert.ok(a > 0 && b > a && c > 0 && d > c); });
const src = page.slice(a, page.indexOf("\n", b) + 1) + page.slice(c, d);
const H = new Function(src + "; return { signupParam, signupYmd, signupInWindow, signupSeries, signupWindowLabel, signupChartSeries, SG_SERIES };")();

t("a bare date is its own day, not the day before west of UTC", () => assert.strictEqual(H.signupYmd("2026-09-01"), "2026-09-01"));
t("a timestamp lands on the reader's LOCAL day", () => assert.strictEqual(H.signupYmd("2026-09-02T05:00:00Z"), "2026-09-01"));
t("garbage and blanks have no day", () => { assert.strictEqual(H.signupYmd(""), null); assert.strictEqual(H.signupYmd("nope"), null); });
t("the URL param only takes YYYY-MM-DD", () => { assert.strictEqual(H.signupParam("2026-09-01"), "2026-09-01"); assert.strictEqual(H.signupParam("2026-09-01junk"), ""); assert.strictEqual(H.signupParam("09/01/2026"), ""); });

t("the window is INCLUSIVE at both ends", () => {
  assert.ok(H.signupInWindow("2026-09-01", "2026-09-01", "2026-09-30"));
  assert.ok(H.signupInWindow("2026-09-30", "2026-09-01", "2026-09-30"));
  assert.ok(!H.signupInWindow("2026-08-31", "2026-09-01", "2026-09-30"));
  assert.ok(!H.signupInWindow("2026-10-01", "2026-09-01", "2026-09-30"));
});
t("one-sided windows work", () => { assert.ok(H.signupInWindow("2027-01-01", "2026-09-01", "")); assert.ok(!H.signupInWindow("2026-01-01", "2026-09-01", "")); });
t("no window means everybody, undated included", () => assert.ok(H.signupInWindow("", "", "")));
t("an undated account is OUT of any window", () => assert.ok(!H.signupInWindow("", "2026-01-01", "2026-12-31")));

const rows = [
  { "Created At": "2026-09-01", Role: "Head of Household", "Residency?": "Yes", Email: "a@x.com" },
  { "Created At": "2026-09-01", Role: "Member", "Residency?": "Yes", Email: "" },
  { "Created At": "2026-09-04", Role: "Head of Household", "Residency?": "No", Email: "b@x.com" },
  { "Created At": "2026-09-04", Role: "Head of Household", "Residency?": "Yes", Email: "staff@rec.us" }
];
t("a short window buckets by DAY and fills the quiet days with zeros", () => {
  const s = H.signupSeries(rows.slice(0, 3), "2026-09-01", "2026-09-07");
  assert.strictEqual(s.gran, "day");
  assert.strictEqual(s.points.length, 7);
  assert.deepStrictEqual(s.points.map(p => p.count), [2, 0, 0, 1, 0, 0, 0]);
  assert.strictEqual(s.cumulative[6].cumulative, 3);
});
t("a quarter buckets by WEEK, a year by MONTH", () => {
  assert.strictEqual(H.signupSeries(rows, "2026-06-01", "2026-09-07").gran, "week");
  assert.strictEqual(H.signupSeries(rows, "2025-09-01", "2026-09-07").gran, "month");
});
t("weeks start on Monday", () => {
  const s = H.signupSeries([{ "Created At": "2026-09-06" }], "2026-06-01", "2026-09-07"); // Sun 6 Sep
  const hit = s.points.find(p => p.count === 1);
  assert.strictEqual(hit.key, "2026-08-31");
});
t("no dates, no series", () => assert.strictEqual(H.signupSeries([], "", "").points.length, 0));

t("the chart shares ONE x axis across its lines and drops staff", () => {
  const c = H.signupChartSeries(rows, "2026-09-01", "2026-09-07");
  assert.strictEqual(c.labels.length, 7);
  Object.keys(c.series).forEach(k => assert.strictEqual(c.series[k].length, 7, k));
  assert.strictEqual(c.series.all.reduce((x, y) => x + y, 0), 3, "the @rec.us row is staff");
  assert.strictEqual(c.series.hoh.reduce((x, y) => x + y, 0), 2);
  assert.strictEqual(c.series.member[0], 1);
  assert.strictEqual(c.series.nonres[3], 1);
});
t("a cohort with nobody in it is a flat line, not a missing one", () => {
  const c = H.signupChartSeries(rows.slice(0, 1), "2026-09-01", "2026-09-03");
  assert.deepStrictEqual(c.series.member, [0, 0, 0]);
});
t("the bucket holding today is flagged open, a closed window is not", () => {
  const d = new Date(), ymd = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  assert.strictEqual(H.signupSeries([{ "Created At": ymd }], "", "").open, true);
  assert.strictEqual(H.signupSeries(rows, "2026-09-01", "2026-09-07").open, false);
});
t("per-bucket mode dashes the open bucket", () => assert.match(page, /dashLast = mode === 'daily' && data\.open/));
t("the chart draws at its real width, never a stretched viewBox", () => assert.ok(!/preserveAspectRatio="none"/.test(page.slice(page.indexOf("function SignupsChart(")))));
t("end labels are pulled back above the floor", () => assert.match(page, /ends\[ends\.length - 1\]\.y > floor/));
t("the label reads as a sentence", () => assert.strictEqual(H.signupWindowLabel("2026-09-01", "2026-09-23"), "Sep 1, 2026 – Sep 23, 2026"));

// Wiring
t("the filter runs BEFORE compute, so every tab is scoped", () => {
  assert.match(page, /setS\(compute\(winRows, \{ from: signFrom, to: signTo \}\)\)/);
  assert.ok(!/setS\(compute\(rows\)\)/.test(page), "compute must not read the unscoped rows");
});
t("the window is seeded from and written back to the URL", () => {
  assert.match(page, /urlParams\.get\('signup_from'\)/); assert.match(page, /urlParams\.get\('signup_to'\)/);
  assert.match(page, /q\.set\('signup_from', signFrom\)/);
});
t("the PDF carries the window and the chart toggle", () => {
  assert.match(page, /pq\.push\('signup_from=/); assert.match(page, /pq\.push\('signup_chart=/);
  const fwd = srv.slice(srv.indexOf("const qsObj = {"), srv.indexOf("if (filters.pii !== undefined)"));
  ["signup_from", "signup_to", "signup_chart"].forEach(k => assert.ok(fwd.includes('"' + k + '"'), k + " in generatePdf's forward list"));
});
t("the window is stated in the page, not only the toolbar", () => assert.match(page, /data-signup-scope=/));
t("an empty window has its own state with a way back", () => assert.match(page, /data-signup-empty="1"[\s\S]{0,400}Show all time/));
t("intel-window is on the log route and posts to Slack with its own line", () => {
  const al = srv.slice(srv.indexOf('const ALLOWED = ["excel", "print", "summary"'));
  assert.ok(al.slice(0, al.indexOf("];")).includes('"intel-window"'));
  const sn = srv.slice(srv.indexOf("const SLACK_NOTIFY = new Set(["));
  assert.ok(sn.slice(0, sn.indexOf("]);")).includes('"intel-window"'));
  assert.match(srv, /\} else if \(rec\.event === "intel-window"\) \{/);
  assert.match(srv, /intel-window\|\$\{rec\.from \|\| ""\}\|\$\{rec\.to \|\| ""\}/);
});

console.log(passed + " assertions passed" + (failed ? ", " + failed + " FAILED." : "."));
process.exit(failed ? 1 : 0);
