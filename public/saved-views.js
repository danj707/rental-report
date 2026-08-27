/* saved-views.js — the date half of saved views, shared by every report that
   has them. No deps. Idempotent. Loaded with `defer`, which runs before Babel
   processes the pages' text/babel blocks.

   WHY THIS IS ITS OWN FILE
   A saved view stores a date INTENT ("last month", "next 14 days") rather than a
   pair of dates, and something has to turn that intent back into a range. The
   server already does, in getDateRange(), because an email subscription resolves
   the same vocabulary at 7am. The page has to do it too, on open.

   That makes the client resolver a hand-written mirror of the server's, and a
   divergence is silent: a view named "Last month" would open on one window on
   screen and report a different one in the emailed PDF, with nothing to error.
   One mirror is a risk worth taking and pinning. TWO mirrors — one per report
   page — is the same risk multiplied, and it drifts the first time a token is
   added to one page and not the other. So there is one, here, and
   scripts/saved-views.spec.js checks it against the real getDateRange() for
   every token in RANGE_LABELS.

   WHAT IS *NOT* HERE
   Which ranges a given report OFFERS. That is the server's call (a GL rollup
   only looks backwards, a class roster reads forwards) and it arrives on the
   page as ORG_CONFIG.savedViewRanges. A page that hardcodes its own list can
   offer a range the server refuses to store — gl.html did, for "Today".
*/
(function () {
  if (window.RecSavedViews) return;

  function toISO(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
         + "-" + String(d.getDate()).padStart(2, "0");
  }

  /* Every token getDateRange() understands, with the wording a picker shows.
     A token missing from here is a token the spec cannot check, so add both
     together. */
  var RANGE_LABELS = {
    today:     "Today",
    yesterday: "Yesterday",
    prior7:    "Prior 7 days",
    prior30:   "Prior 30 days",
    last7:     "Prior 7 days",      // same window as prior7; kept for stored views
    lastMonth: "Last month",
    next7:     "Next 7 days",
    next14:    "Next 14 days",
    next30:    "Next 30 days",
  };

  /* Client mirror of the server's getDateRange(). `now` is injectable so a spec
     can pin a fixed instant rather than racing the clock across midnight. */
  function resolveSavedRange(token, now) {
    var base = now || new Date();
    var shift = function (d) {
      var x = new Date(base);
      x.setDate(x.getDate() + d);
      return x;
    };
    if (token === "today")     return { start: toISO(base),      end: toISO(base) };
    if (token === "yesterday") return { start: toISO(shift(-1)), end: toISO(shift(-1)) };
    if (token === "prior7")    return { start: toISO(shift(-7)),  end: toISO(shift(-1)) };
    if (token === "last7")     return { start: toISO(shift(-7)),  end: toISO(shift(-1)) };
    if (token === "prior30")   return { start: toISO(shift(-30)), end: toISO(shift(-1)) };
    if (token === "next7")     return { start: toISO(base), end: toISO(shift(6)) };
    if (token === "next14")    return { start: toISO(base), end: toISO(shift(13)) };
    if (token === "next30")    return { start: toISO(base), end: toISO(shift(29)) };
    // lastMonth — the server's fall-through, so this one is too.
    var first = new Date(base.getFullYear(), base.getMonth() - 1, 1);
    var last  = new Date(base.getFullYear(), base.getMonth(), 0);
    return { start: toISO(first), end: toISO(last) };
  }

  /* Built from the date's PARTS. new Date("2026-09-01") is UTC midnight, which
     formats as Aug 31 across the US — the Fast Track bug, and a saved view's
     pinned dates are exactly where it would be least noticed. */
  function fmtShortDate(iso) {
    if (!iso) return "";
    var p = String(iso).split("-").map(Number);
    if (p.length !== 3) return String(iso);
    return new Date(p[0], p[1] - 1, p[2])
      .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  /* What a picker prints under a view's name. A PINNED range shows its dates: a
     fixed view must never be mistaken for one that follows the calendar. */
  function viewDateLabel(v) {
    if (!v) return "";
    if (v.dateMode === "fixed") {
      return "📌 " + fmtShortDate(v.fixedStart) + " – " + fmtShortDate(v.fixedEnd);
    }
    if (v.dateMode === "relative") return RANGE_LABELS[v.relativeRange] || v.relativeRange;
    return "current range";
  }

  window.RecSavedViews = {
    RANGE_LABELS: RANGE_LABELS,
    resolveSavedRange: resolveSavedRange,
    fmtShortDate: fmtShortDate,
    viewDateLabel: viewDateLabel,
  };
})();
