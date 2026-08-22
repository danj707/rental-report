/* open-pdf.js — open a server-rendered PDF in its own window.
   Shared by every report page's PDF button. No deps. Idempotent.

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
