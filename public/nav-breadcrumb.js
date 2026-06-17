/* rec.us — Nav breadcrumb widget
   Auto-injects a breadcrumb link at the start of every report toolbar
   so users can navigate back to the org dashboard without the browser
   back button. Self-disables in print mode. No deps. Idempotent. */
(function(){
  if (window.__recNavLoaded) return;
  window.__recNavLoaded = true;

  // Skip in print/PDF mode
  try {
    var qs = window.location.search || "";
    if (qs.indexOf("_print=1") !== -1) return;
    if (document.body && document.body.classList && document.body.classList.contains("print-mode")) return;
  } catch (_) {}

  // Parse URL: /:org/:report
  var parts = window.location.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return; // not a report page (e.g. root dashboard, org landing)
  var orgSlug = parts[0];
  var reportSlug = parts[1];
  if (reportSlug === "admin" || reportSlug === "metrics" || reportSlug === "calendar") return; // skip non-reports and public pages

  // Get token from URL
  var token = "";
  try { token = new URLSearchParams(window.location.search).get("token") || ""; } catch (_) {}

  // Nice org display name
  var orgDisplay = orgSlug.charAt(0).toUpperCase() + orgSlug.slice(1);
  // ORG_CONFIG injected by server may have a displayName
  try { if (window.ORG_CONFIG && window.ORG_CONFIG.displayName) orgDisplay = window.ORG_CONFIG.displayName; } catch (_) {}

  // Build the dashboard URL
  var dashUrl = "/" + orgSlug + (token ? "?token=" + encodeURIComponent(token) : "");

  // Inject CSS
  var style = document.createElement("style");
  style.textContent = ""
    + ".nav-crumb{display:inline-flex;align-items:center;gap:6px;margin-right:10px;padding-right:12px;"
    + "border-right:1px solid rgba(255,255,255,.15);white-space:nowrap;}"
    + ".nav-crumb a{color:#93c5fd;text-decoration:none;font-size:12px;font-weight:600;"
    + "display:inline-flex;align-items:center;gap:5px;transition:color .15s;}"
    + ".nav-crumb a:hover{color:#fff;}"
    + ".nav-crumb svg{width:14px;height:14px;flex-shrink:0;}"
    + "@media print{.nav-crumb{display:none !important;}}";
  document.head.appendChild(style);

  // Wait for toolbar to exist (Babel/React renders async)
  function inject() {
    var toolbar = document.querySelector(".toolbar");
    if (!toolbar) return setTimeout(inject, 200);
    if (toolbar.querySelector(".nav-crumb")) return; // already injected

    var crumb = document.createElement("span");
    crumb.className = "nav-crumb";
    crumb.innerHTML = '<a href="' + dashUrl.replace(/"/g, "&quot;") + '">'
      + '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clip-rule="evenodd"/></svg>'
      + orgDisplay
      + '</a>';
    toolbar.insertBefore(crumb, toolbar.firstChild);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function(){ setTimeout(inject, 100); });
  } else {
    setTimeout(inject, 100);
  }
})();
