/* rec.us — Share Link widget
   Floating button + modal to copy a shareable link to the current report.
   Link source: window.recShareLink (string or fn -> string) if a report defines
   one (so it can capture live filters); otherwise the current URL. The token is
   preserved (it lives in the query string); _print is stripped.
   Self-disables in print mode. No deps. Idempotent. Pairs with feedback-widget.js
   (sits just above it, bottom-right). */
(function(){
  if (window.__recShareLoaded) return;
  window.__recShareLoaded = true;

  // Skip in print/PDF mode
  try {
    var qs = window.location.search || "";
    if (qs.indexOf("_print=1") !== -1) return;
    if (document.body && document.body.classList && document.body.classList.contains("print-mode")) return;
  } catch (_) {}

  var CSS = ""
    + ".sl-btn{position:fixed;bottom:72px;right:20px;z-index:99997;background:#3b82f6;color:#fff;"
    + "border:none;cursor:pointer;padding:11px 16px;border-radius:999px;font-size:13px;font-weight:600;"
    + "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.18);"
    + "display:inline-flex;align-items:center;gap:7px;transition:transform .15s ease,box-shadow .15s ease,background .15s ease;}"
    + ".sl-btn:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,0.24);background:#2563eb;}"
    + ".sl-btn:focus-visible{outline:3px solid rgba(59,130,246,.45);outline-offset:2px;}"
    + ".sl-btn svg{display:block;}"
    + ".sl-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:100000;"
    + "display:flex;align-items:center;justify-content:center;padding:20px;"
    + "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;animation:slFade .15s ease;}"
    + "@keyframes slFade{from{opacity:0}to{opacity:1}}"
    + ".sl-modal{background:#fff;border-radius:12px;padding:24px 26px;width:100%;max-width:480px;"
    + "box-shadow:0 24px 48px rgba(0,0,0,0.25);box-sizing:border-box;animation:slPop .18s cubic-bezier(.16,1,.3,1);}"
    + "@keyframes slPop{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}"
    + ".sl-modal h2{margin:0 0 4px;font-size:18px;color:#111827;font-weight:600;}"
    + ".sl-modal .sl-sub{margin:0 0 16px;font-size:13px;color:#6b7280;line-height:1.45;}"
    + ".sl-row{display:flex;gap:8px;align-items:stretch;}"
    + ".sl-row input{flex:1;min-width:0;padding:9px 11px;border:1px solid #d1d5db;border-radius:6px;"
    + "font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-sizing:border-box;"
    + "color:#111827;background:#f9fafb;}"
    + ".sl-row input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,0.18);background:#fff;}"
    + ".sl-copy{flex:0 0 auto;padding:9px 16px;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600;"
    + "font-family:inherit;border:none;background:#3b82f6;color:#fff;transition:background .12s ease;white-space:nowrap;}"
    + ".sl-copy:hover{background:#2563eb;}"
    + ".sl-copy.sl-done{background:#059669;}"
    + ".sl-foot{display:flex;align-items:center;justify-content:space-between;margin-top:14px;gap:12px;}"
    + ".sl-open{font-size:12px;color:#3b82f6;text-decoration:none;font-weight:600;}"
    + ".sl-open:hover{text-decoration:underline;}"
    + ".sl-close{padding:9px 16px;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600;font-family:inherit;"
    + "border:none;background:#f3f4f6;color:#374151;transition:background .12s ease;}"
    + ".sl-close:hover{background:#e5e7eb;}"
    + "@media print{.sl-btn,.sl-overlay{display:none!important;}}"
    + "body.print-mode .sl-btn,body.print-mode .sl-overlay{display:none!important;}";

  function injectStyle(){
    var s = document.createElement("style");
    s.setAttribute("data-rec-share","1");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // Resolve the link to share. Reports may set window.recShareLink (string or
  // function returning a string) to capture live filters; otherwise use the
  // current URL. Always strip _print; the token rides along in the query string.
  function shareUrl(){
    var custom = null;
    try {
      custom = (typeof window.recShareLink === "function") ? window.recShareLink() : window.recShareLink;
    } catch (_) {}
    var href = (custom && typeof custom === "string") ? custom : window.location.href;
    try {
      var u = new URL(href, window.location.origin);
      u.searchParams.delete("_print");
      return u.toString();
    } catch (_) {
      return href;
    }
  }

  var SHARE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle>'
    + '<circle cx="18" cy="19" r="3"></circle>'
    + '<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>'
    + '<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>';

  function mountButton(){
    if (document.querySelector(".sl-btn")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "sl-btn";
    b.setAttribute("aria-label","Share link to this report");
    b.innerHTML = SHARE_SVG + '<span>Share Link</span>';
    b.addEventListener("click", openModal);
    document.body.appendChild(b);
  }

  function openModal(){
    if (document.querySelector(".sl-overlay")) return;
    var url = shareUrl();

    var overlay = document.createElement("div");
    overlay.className = "sl-overlay";
    overlay.setAttribute("role","dialog");
    overlay.setAttribute("aria-modal","true");
    overlay.setAttribute("aria-label","Share this report");

    var modal = document.createElement("div");
    modal.className = "sl-modal";
    modal.innerHTML = ''
      + '<h2>Share this report</h2>'
      + '<p class="sl-sub">Copy the link below. Anyone with it can view this report \u2014 no login needed.</p>'
      + '<div class="sl-row">'
      +   '<input id="sl-url" type="text" readonly />'
      +   '<button type="button" class="sl-copy">Copy</button>'
      + '</div>'
      + '<div class="sl-foot">'
      +   '<a class="sl-open" target="_blank" rel="noopener">Open in new tab \u2197</a>'
      +   '<button type="button" class="sl-close">Close</button>'
      + '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var $input = modal.querySelector("#sl-url");
    var $copy = modal.querySelector(".sl-copy");
    var $open = modal.querySelector(".sl-open");
    var $close = modal.querySelector(".sl-close");

    $input.value = url;
    $open.href = url;

    setTimeout(function(){ $input.focus(); $input.select(); }, 30);

    function close(){
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e){ if (e.key === "Escape") close(); }

    overlay.addEventListener("click", function(e){ if (e.target === overlay) close(); });
    $close.addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    async function doCopy(){
      var ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText($input.value);
          ok = true;
        }
      } catch (_) {}
      if (!ok) {
        try { $input.focus(); $input.select(); ok = document.execCommand("copy"); } catch (_) {}
      }
      if (ok) {
        $copy.textContent = "Copied!";
        $copy.classList.add("sl-done");
        setTimeout(function(){ $copy.textContent = "Copy"; $copy.classList.remove("sl-done"); }, 1800);
      } else {
        // Last resort: leave it selected so the user can hit Cmd/Ctrl+C
        $input.focus(); $input.select();
      }
    }
    $copy.addEventListener("click", doCopy);
  }

  function init(){
    injectStyle();
    mountButton();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
