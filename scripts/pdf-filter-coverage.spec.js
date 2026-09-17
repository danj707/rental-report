// THE HARNESS: every filter a report page offers must reach its PDF.
//
// Dan, 2026-09-17, after the site filter was found missing from the rental
// schedule's PDF: "can you build this out as a future harness. Literally EVERY
// FILTER NEEDS TO MAKE IT INTO THE PDF WHEN YOU CLICK PDF."
//
// ── WHY A HARNESS AND NOT ANOTHER PER-FILTER SPEC ──────────────────────────
//
// This is the FOURTH filter to ship reaching the screen and not the PDF, and
// every one of them was written by someone who had just read the comment about
// the last one. `gl_codes`, `refunds`, `pii`, and now `sites`. Each was fixed
// with a spec naming that filter, and each of those specs is satisfied by a
// FIFTH filter that nobody adds to it. A guard you have to remember to extend
// is the thing that failed here four times.
//
// So the filter list is DERIVED, not written down: it is whatever the page's
// own parameter reader returns. Add `?foo=` to getParams and `foo` is in this
// harness on the next run, failing until it is wired through all four gates or
// explicitly classified. A hand-kept list is satisfied by forgetting to add to
// it; this one cannot be.
//
// ── THE FOUR GATES, AND WHY PASSING THREE LOOKS EXACTLY LIKE WORKING ───────
//
//   1. DECLARED   — the page reads the parameter at all.
//   2. SENT       — downloadPdf puts it in the URL it opens.
//   3. FORWARDED  — generatePdf copies it onto the print page's URL. THIS IS
//                   THE SERVER GATE, and it is the one every recorded instance
//                   failed: the screen is right, the browser's own Print is
//                   right, and only the Puppeteer-rendered PDF is wrong, so
//                   nothing a reader or a reviewer looks at disagrees.
//   4. HONOURED   — the print page, which has no localStorage and has never
//                   seen this reader, actually applies it. The URL is its only
//                   channel.
//
// ── THE EMPTY VALUE IS THE ONE THAT BREAKS ────────────────────────────────
//
// generatePdf forwards on truthiness, which is right for a parameter that is
// meaningless when blank and WRONG for a list, whose empty value is its most
// important one: "the reader ticked None". `pii` shipped broken twice for this
// and `site_types` once. So each filter declares whether its empty value is
// real, and gate 3 drives that case explicitly.
//
// Run: node scripts/pdf-filter-coverage.spec.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const srv = fs.readFileSync(path.join(root, "server.js"), "utf8");

let n = 0;
const fails = [];
function ok(cond, msg) { n++; try { assert.ok(cond, msg); } catch (e) { fails.push(e.message); } }
function eq(a, b, msg) { n++; try { assert.strictEqual(a, b, msg); } catch (e) { fails.push(e.message); } }

// ── HOW A FILTER REACHES THE PRINT PAGE ────────────────────────────────────
// Four channels, and which one a filter uses decides what gate 4 checks.
//
//   print-scope : an ASYNC-reconciled React set (seeded from the URL when the
//                 feed lands, then merged into by anything that answers
//                 afterwards). Whatever answers last wins and the URL is not
//                 it, so these need printScopeRows re-applying the URL in print
//                 mode. This is the class the site filter belonged to.
//   sync        : seeded SYNCHRONOUSLY from the URL in useState and never
//                 reconciled from a feed, so nothing can overwrite it. Safe by
//                 construction — and the classification is the assertion: the
//                 day one of these grows a reconcile effect it changes class
//                 and needs print-scope.
//   server      : a LEGACY Metabase parameter. It never reaches the print
//                 page's filter state at all; it narrows the CARD, so the PDF
//                 gets it through buildMetabaseParams. Gate 4 is therefore
//                 about the server, not the page.
//   window      : the date range. generatePdf's own first two arguments.
//   mode        : not a filter (`_print` itself).
//
// `empty` marks a filter whose EMPTY value is a real answer, so gate 3 requires
// presence-forwarding rather than truthiness.
// ── WHY ONLY `facility` IS REGISTERED TODAY ────────────────────────────────
// Adding a report is one entry. The rental schedule is registered because it is
// the one that broke; `gl` was CHECKED rather than assumed and does not share
// the class: its filter selections reconcile off the single main feed
// (`dataChanged`), and its only `setTimeout` dismisses an undo toast — there is
// no second fetch answering later to overwrite a URL-seeded selection, which is
// what gate 5 is about. It is still worth registering for gates 1–4 when
// somebody wants belt-and-braces there; `roster` and `programs` likewise.
const REPORTS = [{
  report: "facility",
  label: "the rental schedule",
  page: "public/facility.html",
  paramsFn: "getParams",
  downloadFn: "downloadPdf",
  scopeFn: "printScopeRows",
  filters: {
    start_date:    { channel: "window" },
    end_date:      { channel: "window" },
    _print:        { channel: "mode" },
    location_name: { channel: "server" },
    site_type:     { channel: "server" },
    locations:     { channel: "print-scope" },
    sites:         { channel: "print-scope" },
    site_types:    { channel: "print-scope", empty: true },
    addons:        { channel: "print-scope" },
    book_type:     { channel: "sync", state: /useState\(params\.book_type \|\| 'all'\)/ },
    musco:         { channel: "sync", state: /useState\(params\.musco === '1'\)/ },
    // Column toggles rather than row filters, but they are on exactly the same
    // four gates and `pii` is the recorded instance that proves it.
    pii:           { channel: "sync", empty: true, state: /piiInitial\(/ },
    sitetype:      { channel: "sync", state: /p\.get\('sitetype'\)|params\.sitetype/ },
  },
}];

// ── generatePdf's query builder, LIFTED AND RUN ────────────────────────────
// A render case at ?_print=1&sites=… proves the PAGE reads the parameter and
// says nothing about whether the SERVER sends it. That gap is the gate every
// recorded instance failed, so it is driven rather than grepped.
const gp = srv.slice(srv.indexOf("async function generatePdf("));
const qsStart = gp.indexOf("const qsObj = {");
const qsEnd = gp.indexOf("const qs = new URLSearchParams(qsObj);");
ok(qsStart > 0 && qsEnd > qsStart, "generatePdf's query block should be liftable");
const qsBlock = gp.slice(qsStart, qsEnd + "const qs = new URLSearchParams(qsObj);".length);
const buildQs = new Function("startDate", "endDate", "orgTok", "filters",
  qsBlock + "\nreturn qs.toString();");

REPORTS.forEach(R => {
  const src = fs.readFileSync(path.join(root, R.page), "utf8");
  const where = " [" + R.report + "]";

  // ── Slice the page's own parameter reader ────────────────────────────────
  function sliceFn(name) {
    const at = src.indexOf("function " + name + "(");
    if (at < 0) return null;
    const bodyAt = src.indexOf("{", src.indexOf(")", at));
    let depth = 0, i = bodyAt;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(at, i);
  }

  const paramsBody = sliceFn(R.paramsFn);
  ok(paramsBody, R.paramsFn + " should be declared at module scope" + where);
  if (!paramsBody) return;

  // THE DERIVATION. Every `key: p.get('key')` line in the page's own parameter
  // reader. This is the whole point of the harness: the vocabulary comes from
  // the page, so it cannot go stale, and a filter added without being
  // classified below fails loudly rather than being silently uncovered.
  const declared = [...paramsBody.matchAll(/^\s*([A-Za-z_][\w]*)\s*:\s*p\.get\(/gm)].map(m => m[1]);
  ok(declared.length > 5,
    "the derivation should find the page's parameters — if this collapses to a "
    + "handful the regex has stopped matching and every assertion below is "
    + "vacuous. Found: " + JSON.stringify(declared) + where);

  // ── GATE 1: DECLARED ─────────────────────────────────────────────────────
  // The failure message is the point. Somebody adding a filter reads this.
  declared.forEach(k => {
    ok(R.filters[k],
      "`" + k + "` is read by " + R.paramsFn + " and is NOT classified in this "
      + "harness. Add it to REPORTS[" + R.report + "].filters saying how it "
      + "reaches the PDF — `print-scope` if it lives in an async-reconciled "
      + "React set, `sync` if useState seeds it straight from the URL, "
      + "`server` if it narrows the Metabase card, `window`/`mode` if it is "
      + "not a filter. Then make the three gates below pass. THIS IS THE STEP "
      + "THAT WAS SKIPPED FOUR TIMES" + where);
  });
  // ...and the other direction, or the table rots into a description of a page
  // that no longer exists.
  Object.keys(R.filters).forEach(k => {
    ok(declared.includes(k),
      "`" + k + "` is classified here but " + R.paramsFn + " no longer reads "
      + "it — drop it from the table rather than leaving an assertion about a "
      + "parameter nothing produces" + where);
  });

  const real = declared.filter(k => {
    const c = R.filters[k] && R.filters[k].channel;
    return c && c !== "window" && c !== "mode";
  });
  ok(real.length >= 6,
    "the harness should be covering the report's real filters, not two of "
    + "them. Covering: " + JSON.stringify(real) + where);

  // ── GATE 2: THE PAGE SENDS IT ────────────────────────────────────────────
  const dl = sliceFn(R.downloadFn)
    || (() => { const at = src.indexOf("function " + R.downloadFn + "()"); return at < 0 ? null : src.slice(at, src.indexOf("\n  }", at)); })();
  ok(dl, R.downloadFn + " should be declared" + where);
  real.forEach(k => {
    const sends = new RegExp("qs\\.set\\('" + k + "'|qs\\.set\\(\"" + k + "\"").test(dl || "");
    ok(sends,
      "GATE 2 — " + R.downloadFn + " must put `" + k + "` in the PDF URL. The "
      + "screen being right says nothing about a PDF rendered server-side in a "
      + "browser that has never seen this reader" + where);
  });

  // ── GATE 3: THE SERVER FORWARDS IT ───────────────────────────────────────
  const probe = {};
  real.forEach(k => { probe[k] = "PROBE-" + k; });
  const allQs = buildQs("2026-09-16", "2026-09-22", "tok", probe);
  real.forEach(k => {
    ok(new RegExp("(^|&)" + k + "=PROBE-" + k + "(&|$)").test(allQs),
      "GATE 3 — generatePdf must forward `" + k + "` onto the print page's URL, "
      + "carrying its VALUE. This is the gate `gl_codes`, `refunds`, `pii` and "
      + "`sites` each failed, and it is invisible from the browser. Got: "
      + allQs + where);
  });

  // The empty case, which the truthy forward loop structurally cannot express.
  real.forEach(k => {
    const f = R.filters[k];
    const one = buildQs("2026-09-16", "2026-09-22", "tok", { [k]: "" });
    if (f.empty) {
      ok(new RegExp("(^|&)" + k + "=(&|$)").test(one),
        "GATE 3 — `" + k + "` is marked `empty: true`, so its EMPTY value is a "
        + "real answer (\"the reader ticked None\") and generatePdf must "
        + "forward it on PRESENCE, not truthiness. Dropped, the print page "
        + "falls back to its default and the PDF carries what the screen does "
        + "not show. Got: " + one + where);
    }
  });

  // An ABSENT parameter must never be invented — absent means "the caller is
  // not speaking about this", which is a different answer from "none".
  const absent = buildQs("2026-09-16", "2026-09-22", "tok", {});
  real.forEach(k => {
    ok(!new RegExp("(^|&)" + k + "=").test(absent),
      "GATE 3 — an ABSENT `" + k + "` must not be invented by generatePdf. "
      + "Got: " + absent + where);
  });

  // ── GATE 4: THE PRINT PAGE HONOURS IT ────────────────────────────────────
  const scopeBody = R.scopeFn ? sliceFn(R.scopeFn) : null;
  if (R.scopeFn) ok(scopeBody, R.scopeFn + " should be declared at module scope" + where);

  real.forEach(k => {
    const f = R.filters[k];
    if (f.channel === "print-scope") {
      ok(scopeBody && scopeBody.includes("params." + k),
        "GATE 4 — `" + k + "` is an ASYNC-reconciled selection, so " + R.scopeFn
        + " must re-apply it from the URL in print mode. Without that, whatever "
        + "feed answers last overwrites the reader's filter and the PDF carries "
        + "rows their screen does not" + where);
    } else if (f.channel === "sync") {
      ok(f.state && f.state.test(src),
        "GATE 4 — `" + k + "` is classified `sync`, meaning useState seeds it "
        + "straight from the URL and no feed reconciles it. That is no longer "
        + "true, or the initializer was renamed. If it now comes from a feed it "
        + "has changed class and needs `print-scope`" + where);
    } else if (f.channel === "server") {
      ok(new RegExp("query\\." + k).test(srv),
        "GATE 4 — `" + k + "` is classified `server`, so buildMetabaseParams "
        + "must read it and narrow the card. If it stopped doing that the "
        + "parameter reaches the print page and nothing applies it" + where);
    }
  });

  // ── AND THE GUARD MAY NOT NAME ONE FILTER ────────────────────────────────
  // The shape of the bug: `grouped` re-applied `params.locations` by hand and
  // nothing else, so locations held in the PDF and sites did not.
  if (R.scopeFn) {
    const scoped = real.filter(k => R.filters[k].channel === "print-scope");
    scoped.forEach(k => {
      ok(scopeBody && scopeBody.includes("params." + k),
        "every print-scope filter must go through " + R.scopeFn + " — `" + k
        + "` does not, and a guard covering three of four is how this shipped"
        + where);
    });
    ok(/params\._print !== '1'/.test(scopeBody || ""),
      R.scopeFn + " must be INERT outside print mode: on the interactive page "
      + "the URL is a seed, not the authority, and re-applying it would pin the "
      + "filters a reader is trying to change" + where);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error("\n" + fails.length + " of " + n + " assertions FAILED:\n");
  fails.forEach(f => console.error("  ✗ " + f + "\n"));
  process.exit(1);
}
console.log(n + " assertions passed.");
