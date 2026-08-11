// report-refresh.js — shared "Data as of HH:MM · Refresh" badge for all reports.
//
// Reports are served from a server-side cache (up to 4h depending on report
// type), which isn't obvious to admins comparing against the live rec.us
// admin. This widget makes freshness visible and refresh one click:
//
//   1. Patches window.fetch: every response from a /api/data route carries
//      X-Report-Data-As-Of + X-Report-Cache headers (see server.js) — the
//      badge renders/updates from those, so pages need no per-page wiring.
//   2. "Refresh" click sets a one-shot sessionStorage flag and reloads; on
//      the next load the patch appends _refresh=1 to /api/data requests so
//      the server bypasses its cache. ?_refresh=1 / ?_nocache=1 on the page
//      URL work too (power-user path).
//
// Include AFTER the page's own scripts is fine as long as it's before the
// first fetch — report pages fetch from React effects post-Babel, so a
// deferred include is always early enough.
(function () {
  if (/[?&]_print=1\b/.test(location.search)) return;

  var wantRefresh = /[?&](_refresh|_nocache)=1\b/.test(location.search);
  try {
    if (sessionStorage.getItem('recRefreshOnce') === '1') {
      wantRefresh = true;
      sessionStorage.removeItem('recRefreshOnce');
    }
  } catch (e) { /* sessionStorage unavailable — URL param path still works */ }

  var badge = null, labelEl = null, linkEl = null;

  function fmtAsOf(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
  }

  function ensureBadge() {
    if (badge) return;
    var style = document.createElement('style');
    style.textContent =
      '#rec-data-asof{position:fixed;left:14px;bottom:14px;z-index:9998;display:flex;align-items:center;gap:7px;' +
      'background:#fff;border:1px solid #e2e8f0;border-radius:999px;padding:6px 13px;' +
      'font:500 11.5px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#64748b;' +
      'box-shadow:0 2px 8px rgba(15,23,42,.08);}' +
      '#rec-data-asof a{color:#3b82f6;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap;}' +
      '#rec-data-asof a:hover{text-decoration:underline;}' +
      '#rec-data-asof .rec-asof-stale{color:#b45309;font-weight:600;}' +
      '@media print{#rec-data-asof{display:none !important;}}' +
      'body.print-mode #rec-data-asof{display:none !important;}';
    document.head.appendChild(style);

    badge = document.createElement('div');
    badge.id = 'rec-data-asof';
    labelEl = document.createElement('span');
    linkEl = document.createElement('a');
    linkEl.textContent = '⟳ Refresh';
    linkEl.title = 'Re-query the database now, bypassing the report cache';
    linkEl.addEventListener('click', function () {
      try { sessionStorage.setItem('recRefreshOnce', '1'); } catch (e) {}
      linkEl.textContent = 'Refreshing…';
      location.reload();
    });
    badge.appendChild(labelEl);
    badge.appendChild(linkEl);
    document.body.appendChild(badge);
  }

  function update(asOfIso, cacheState) {
    var t = fmtAsOf(asOfIso);
    if (!t) return;
    ensureBadge();
    if (cacheState === 'stale') {
      labelEl.innerHTML = '<span class="rec-asof-stale">⚠ Data as of ' + t + '</span>';
      labelEl.title = 'The database was unreachable — showing the last saved copy.';
    } else if (cacheState === 'live') {
      labelEl.textContent = 'Data as of ' + t;
      labelEl.title = 'Fresh from the database.';
    } else {
      labelEl.textContent = 'Data as of ' + t;
      labelEl.title = 'Served from the report cache — click Refresh to re-query the database.';
    }
  }

  var isReportData = function (url) { return /\/api\/data(\?|$)/.test(String(url || '')); };

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var reportData = isReportData(url);
    if (reportData && wantRefresh && !/[?&](_refresh|_nocache)=/.test(url)) {
      url += (url.indexOf('?') >= 0 ? '&' : '?') + '_refresh=1';
      input = (typeof input === 'string') ? url : new Request(url, input);
    }
    var p = origFetch.call(this, input, init);
    if (reportData) {
      p.then(function (resp) {
        try {
          var asOf = resp.headers.get('X-Report-Data-As-Of');
          if (asOf) update(asOf, resp.headers.get('X-Report-Cache') || '');
        } catch (e) {}
      }, function () {});
    }
    return p;
  };
})();
