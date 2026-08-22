/* open-pdf.js — get an export out of a sandboxed iframe.
   Shared by every report page's PDF and Excel buttons. No deps. Idempotent.
   (Filename is historical: it started as the PDF fix.)

   WHY THIS EXISTS
   Report pages run inside a sandboxed iframe, and a download started by that
   frame is silently dropped — no error, no file, nothing for the user to react
   to. Every PDF button used to do:

       fetch(url) -> blob -> <a download>.click()

   …and that click is exactly the thing the sandbox blocks. (XLSX.writeFile()
   does the same internally, which is why Excel is broken the same way.)

   A top-level popup navigating to a URL is NOT a download, so it isn't
   blocked — the same reason the pay-slip windows in instructor-payout.html
   have always worked. Every /api/pdf route already serves the file with
   `Content-Disposition: inline`, so the popup renders it in the browser's own
   PDF viewer and the reader saves or prints from there, outside the frame.

   TWO RULES FOR CALLERS
   1. Call this straight from the click handler. A popup opened after an await
      or a .then() has lost the user gesture and the browser blocks it — which
      is why we navigate the window rather than fetching first.
   2. Pass the fully-built URL, token included (withToken(...) on most pages).

   The proper fix is `allow-downloads` on the embedding iframe's sandbox
   attribute, which lives in the embedder, not here. This makes exports work in
   the meantime and stays harmless afterwards.
*/
(function () {
  if (window.openReportPdf) return;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // A PDF can take 20s+ to render (Puppeteer + a live Metabase query), so the
  // new window says what it is doing instead of sitting blank. It also carries
  // a plain link as a backstop in case the scripted navigation is refused.
  function placeholder(label, url) {
    return '<!doctype html><html><head><meta charset="utf-8">'
      + '<title>' + esc(label) + '</title>'
      + '<style>'
      + 'html,body{margin:0;height:100%;background:#1a1a1a;color:#eee;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'
      + 'div{height:100%;display:flex;flex-direction:column;align-items:center;'
      + 'justify-content:center;gap:14px;text-align:center;padding:24px;}'
      + '.s{width:26px;height:26px;border:3px solid rgba(255,255,255,.2);'
      + 'border-top-color:#fff;border-radius:50%;animation:r .7s linear infinite;}'
      + '@keyframes r{to{transform:rotate(360deg)}}'
      + 'p{margin:0;font-size:14px;} small{color:#888;font-size:12px;}'
      + 'a{color:#93c5fd;font-size:12px;}'
      + '</style></head><body><div>'
      + '<div class="s"></div>'
      + '<p>Building your PDF…</p>'
      + '<small>' + esc(label) + ' — this can take a few seconds.</small>'
      + '<a href="' + esc(url) + '">Open it directly if this window stays blank</a>'
      + '</div></body></html>';
  }

  /* openReportPdf(url, opts?) -> true if a window was opened.
     opts.label: what to call the document in the placeholder + tab title. */
  window.openReportPdf = function (url, opts) {
    opts = opts || {};
    var label = opts.label || "Report";
    var w = null;
    try { w = window.open("", "_blank"); } catch (_) { w = null; }
    if (!w) {
      // Worth an alert: the old failure mode was total silence, and that is the
      // thing being fixed. Say what to do about it.
      alert("Your browser blocked the PDF window.\n\nAllow pop-ups for this page, then click PDF again.");
      return false;
    }
    try {
      w.document.write(placeholder(label, url));
      w.document.close();
    } catch (_) { /* if we can't write into it, the navigation below still runs */ }
    try { w.location.replace(url); }
    catch (_) { try { w.location.href = url; } catch (__) {} }
    return true;
  };
})();

/* ── Excel ──────────────────────────────────────────────────────────────
   saveWorkbookViaPopup(XLSX, wb, filename)

   The PDF above works because a PDF can be RENDERED: the popup navigates to a
   URL, the browser's viewer displays it, and nothing is ever a "download" for
   the sandbox to block.

   A spreadsheet cannot be rendered, so this path has to end in a download
   somewhere. The open question is whether a download started inside the POPUP
   escapes the frame's sandbox — that depends on `allow-popups-to-escape-sandbox`
   on the embedder, which we do not control. So this builds the file bytes here,
   hands them to a popup, and lets the popup do the saving.

   A blocked download cannot be detected from script — there is no error and no
   event. So the popup never claims success: it always shows the file, tries the
   save once, and offers two things a sandbox cannot block:

     1. a real link the USER clicks (a genuine user gesture in a top-level
        window is the best odds available), and
     2. copy-to-clipboard as TSV, which pastes straight into Excel and involves
        no file at all.

   Either way the reader ends up with their data, instead of the current
   behaviour where the button silently does nothing.
*/
(function () {
  if (window.saveWorkbookViaPopup) return;

  var XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  function popupDoc() {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Export</title>'
      + '<style>'
      + 'html,body{margin:0;min-height:100%;background:#1a1a1a;color:#eee;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'
      + '.w{min-height:100vh;display:flex;flex-direction:column;align-items:center;'
      + 'justify-content:center;gap:16px;text-align:center;padding:32px 24px;}'
      + 'h1{font-size:17px;font-weight:600;margin:0;}'
      + 'p{margin:0;font-size:13px;color:#aaa;max-width:44ch;line-height:1.55;}'
      + 'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#ddd;}'
      + '.btn{display:inline-block;padding:10px 20px;border-radius:6px;font-size:13.5px;'
      + 'font-weight:600;text-decoration:none;cursor:pointer;border:none;font-family:inherit;}'
      + '.primary{background:#1d7a4f;color:#fff;}'
      + '.secondary{background:transparent;color:#93c5fd;border:1px solid rgba(147,197,253,.4);}'
      + '.row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}'
      + '#note{font-size:12px;color:#7dd3a0;min-height:18px;}'
      + 'textarea{position:absolute;left:-9999px;top:0;}'
      + '</style></head><body><div class="w">'
      + '<h1>Your spreadsheet is ready</h1>'
      + '<p><code id="fname"></code></p>'
      + '<div class="row">'
      + '<a class="btn primary" id="dl" href="#">Download</a>'
      + '<button class="btn secondary" id="copy" type="button">Copy for Excel</button>'
      + '</div>'
      + '<p id="hint">If the download did not start on its own, use the button above — '
      + 'some embedded views block automatic downloads. "Copy for Excel" puts the rows '
      + 'on your clipboard instead, ready to paste into a sheet.</p>'
      + '<div id="note"></div>'
      + '<textarea id="tsv" readonly></textarea>'
      + '</div><script>'
      + 'window.__recExportStart = function () {'
      + '  var p = window.__recExport; if (!p) return;'
      + '  var link = document.getElementById("dl");'
      + '  document.getElementById("fname").textContent = p.filename;'
      + '  document.getElementById("tsv").value = p.tsv || "";'
      + '  try {'
      + '    var url = URL.createObjectURL(new Blob([p.bytes], { type: p.mime }));'
      + '    link.href = url; link.download = p.filename;'
      + '    link.click();'   /* one automatic attempt; silently ignored if blocked */
      + '  } catch (e) {'
      + '    document.getElementById("hint").textContent = "This browser would not build the file. Use Copy for Excel instead.";'
      + '  }'
      + '  document.getElementById("copy").onclick = function () {'
      + '    var note = document.getElementById("note");'
      + '    var ta = document.getElementById("tsv");'
      + '    function ok() { note.textContent = "Copied — paste into Excel or Sheets."; }'
      + '    if (navigator.clipboard && navigator.clipboard.writeText) {'
      + '      navigator.clipboard.writeText(ta.value).then(ok, legacy);'
      + '    } else { legacy(); }'
      + '    function legacy() {'
      + '      try { ta.select(); document.execCommand("copy"); ok(); }'
      + '      catch (e) { note.textContent = "Could not copy automatically — press Ctrl/Cmd+C."; ta.select(); }'
      + '    }'
      + '  };'
      + '};'
      /* The parent calls the function above right after it sets the payload, but
         poll too: whether an inline script has run by the time document.close()
         returns is not something to bet an export on. */
      + '(function tick(){ if (window.__recExport && !window.__recStarted) { window.__recStarted = 1; window.__recExportStart(); } else if (!window.__recStarted) { setTimeout(tick, 30); } })();'
      + '<\/script></body></html>';
  }

  window.saveWorkbookViaPopup = function (XLSX, wb, filename, opts) {
    opts = opts || {};
    if (!XLSX || !wb) return false;
    // Synchronously, before any work — see the PDF notes above.
    var w = null;
    try { w = window.open("", "_blank"); } catch (_) { w = null; }
    if (!w) {
      alert("Your browser blocked the export window.\n\nAllow pop-ups for this page, then click Excel again.");
      return false;
    }
    var payload;
    try {
      var sheet = wb.Sheets[wb.SheetNames[0]];
      payload = {
        bytes: XLSX.write(wb, { bookType: "xlsx", type: "array" }),
        tsv: sheet ? XLSX.utils.sheet_to_csv(sheet, { FS: "\t" }) : "",
        filename: filename || "export.xlsx",
        mime: XLSX_MIME,
      };
    } catch (e) {
      try { w.close(); } catch (_) {}
      alert("Could not build the spreadsheet: " + e.message);
      return false;
    }
    try {
      w.document.write(popupDoc());
      w.document.close();
    } catch (_) { /* the payload + poller below still drive it */ }
    w.__recExport = payload;
    try { if (typeof w.__recExportStart === "function" && !w.__recStarted) { w.__recStarted = 1; w.__recExportStart(); } } catch (_) {}
    return true;
  };
})();
