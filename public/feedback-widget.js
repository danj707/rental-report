/* rec.us — Early Access banner + Got Feedback + Thumbs
   Injects a sticky top banner with early access notice, thumbs up/down,
   and Got Feedback button. Feedback POSTs to /api/feedback.
   Self-disables in print mode. No deps. Idempotent. */
(function(){
  if (window.__recFeedbackLoaded) return;
  window.__recFeedbackLoaded = true;

  try {
    var qs = window.location.search || "";
    if (qs.indexOf("_print=1") !== -1) return;
    if (document.body && document.body.classList && document.body.classList.contains("print-mode")) return;
  } catch (_) {}

  var CSS = ""
    + ".rec-banner{position:sticky;top:0;z-index:99998;background:#f97316;color:#fff;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 16px;font-size:13px;font-weight:500;letter-spacing:0.2px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}"
    + ".rec-banner a{color:#fff;text-decoration:underline;font-weight:600;}"
    + ".rec-banner-msg{flex:1;text-align:center;}"
    + ".rec-banner-thumbs{display:inline-flex;gap:4px;flex-shrink:0;}"
    + ".rec-banner-thumb{background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.35);cursor:pointer;padding:4px 8px;border-radius:999px;font-size:15px;line-height:1;transition:background .12s ease,transform .1s ease;}"
    + ".rec-banner-thumb:hover{background:rgba(255,255,255,0.35);transform:scale(1.1);}"
    + ".rec-banner-thumb.voted{opacity:0.5;pointer-events:none;}"
    + ".rec-banner-fb{background:rgba(0,0,0,0.25);color:#fff;border:1px solid rgba(255,255,255,0.3);cursor:pointer;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:600;font-family:inherit;display:inline-flex;align-items:center;gap:5px;transition:background .12s ease,transform .1s ease;flex-shrink:0;}"
    + ".rec-banner-fb:hover{background:rgba(0,0,0,0.4);transform:translateY(-1px);}"
    + ".fb-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99999;"
    + "display:flex;align-items:center;justify-content:center;padding:20px;"
    + "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;animation:fbFade .15s ease;}"
    + "@keyframes fbFade{from{opacity:0}to{opacity:1}}"
    + ".fb-modal{background:#fff;border-radius:12px;padding:24px 26px;width:100%;max-width:460px;"
    + "box-shadow:0 24px 48px rgba(0,0,0,0.25);box-sizing:border-box;animation:fbPop .18s cubic-bezier(.16,1,.3,1);}"
    + "@keyframes fbPop{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}"
    + ".fb-modal h2{margin:0 0 4px;font-size:18px;color:#111827;font-weight:600;}"
    + ".fb-modal .fb-sub{margin:0 0 16px;font-size:13px;color:#6b7280;line-height:1.4;}"
    + ".fb-modal label{display:block;font-size:12px;color:#374151;margin:0 0 4px;font-weight:500;}"
    + ".fb-modal input,.fb-modal textarea{width:100%;padding:9px 11px;border:1px solid #d1d5db;border-radius:6px;"
    + "font-size:14px;font-family:inherit;box-sizing:border-box;margin:0 0 12px;color:#111827;background:#fff;}"
    + ".fb-modal textarea{min-height:110px;resize:vertical;line-height:1.45;}"
    + ".fb-modal input:focus,.fb-modal textarea:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,0.18);}"
    + ".fb-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px;}"
    + ".fb-actions button{padding:9px 16px;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600;font-family:inherit;border:none;transition:background .12s ease;}"
    + ".fb-cancel{background:#f3f4f6;color:#374151;}"
    + ".fb-cancel:hover{background:#e5e7eb;}"
    + ".fb-send{background:#3b82f6;color:#fff;}"
    + ".fb-send:hover{background:#2563eb;}"
    + ".fb-send:disabled{background:#93c5fd;cursor:not-allowed;}"
    + ".fb-err{color:#dc2626;font-size:12px;margin:-6px 0 10px;display:none;}"
    + ".fb-ok{text-align:center;padding:14px 0 6px;}"
    + ".fb-ok h2{color:#059669;margin:0 0 6px;}"
    + ".fb-ok p{color:#6b7280;font-size:14px;margin:0;}"
    + "@media print{.rec-banner,.fb-overlay{display:none!important;}}"
    + "body.print-mode .rec-banner,body.print-mode .fb-overlay{display:none!important;}";

  function injectStyle(){
    var s = document.createElement("style");
    s.setAttribute("data-rec-feedback","1");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function openModal(){
    if (document.querySelector(".fb-overlay")) return;
    var overlay = document.createElement("div");
    overlay.className = "fb-overlay";
    overlay.setAttribute("role","dialog");
    overlay.setAttribute("aria-modal","true");
    overlay.setAttribute("aria-label","Send feedback");

    var modal = document.createElement("div");
    modal.className = "fb-modal";
    modal.innerHTML = ''
      + '<h2>Got feedback?</h2>'
      + '<p class="fb-sub">Tell us what\u2019s working, what\u2019s broken, or what you\u2019d love to see. Goes straight to Rec Partner Success.</p>'
      + '<label for="fb-email">Your email <span style="color:#9ca3af;font-weight:400;">(optional, so we can follow up)</span></label>'
      + '<input id="fb-email" type="email" placeholder="you@example.com" autocomplete="email" />'
      + '<label for="fb-message">Feedback</label>'
      + '<textarea id="fb-message" placeholder="What\u2019s on your mind?" required></textarea>'
      + '<div class="fb-err" id="fb-err"></div>'
      + '<div class="fb-actions">'
      +   '<button type="button" class="fb-cancel">Cancel</button>'
      +   '<button type="button" class="fb-send">Send</button>'
      + '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var $msg = modal.querySelector("#fb-message");
    var $email = modal.querySelector("#fb-email");
    var $err = modal.querySelector("#fb-err");
    var $send = modal.querySelector(".fb-send");
    var $cancel = modal.querySelector(".fb-cancel");

    setTimeout(function(){ $msg.focus(); }, 30);

    function close(){
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e){ if (e.key === "Escape") close(); }

    overlay.addEventListener("click", function(e){ if (e.target === overlay) close(); });
    $cancel.addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    async function send(){
      var message = ($msg.value || "").trim();
      var email = ($email.value || "").trim();
      if (!message){
        $err.textContent = "Please add some feedback before sending.";
        $err.style.display = "block";
        $msg.focus();
        return;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
        $err.textContent = "That email doesn\u2019t look right \u2014 leave it blank or fix it up.";
        $err.style.display = "block";
        $email.focus();
        return;
      }
      $err.style.display = "none";
      $send.disabled = true;
      $send.textContent = "Sending\u2026";

      try {
        var r = await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: message,
            email: email,
            page: window.location.pathname + window.location.search,
            userAgent: navigator.userAgent
          })
        });
        if (!r.ok){
          var data = {};
          try { data = await r.json(); } catch(_){}
          throw new Error(data.error || ("Server error " + r.status));
        }
        modal.innerHTML = '<div class="fb-ok">'
          + '<h2>Thanks! \uD83C\uDF89</h2>'
          + '<p>Your feedback is on its way to Rec Partner Success.</p>'
          + '</div>';
        setTimeout(close, 2200);
      } catch(e){
        $err.textContent = e && e.message ? e.message : "Send failed. Please try again.";
        $err.style.display = "block";
        $send.disabled = false;
        $send.textContent = "Send";
      }
    }
    $send.addEventListener("click", send);
    $msg.addEventListener("keydown", function(e){
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
    });
  }

  function mountBanner(){
    if (document.querySelector(".rec-banner")) return;
    var banner = document.createElement("div");
    banner.className = "rec-banner";

    // Thumbs
    var thumbs = document.createElement("div");
    thumbs.className = "rec-banner-thumbs";
    var up = document.createElement("button");
    up.type = "button"; up.className = "rec-banner-thumb"; up.innerHTML = "\uD83D\uDC4D";
    up.title = "This report is helpful";
    var down = document.createElement("button");
    down.type = "button"; down.className = "rec-banner-thumb"; down.innerHTML = "\uD83D\uDC4E";
    down.title = "This report needs work";
    function vote(sentiment, btn, otherBtn){
      btn.classList.add("voted");
      otherBtn.classList.add("voted");
      var parts = window.location.pathname.split("/").filter(Boolean);
      var org = parts[0] || "";
      var report = parts[1] || "";
      var qs = window.location.search || "";
      var tokenMatch = qs.match(/token=([^&]+)/);
      var tokenQS = tokenMatch ? "?token=" + tokenMatch[1] : "";
      if (org && report) {
        fetch("/" + org + "/" + report + "/api/vote" + tokenQS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sentiment: sentiment })
        }).catch(function(){});
      }
      btn.innerHTML = sentiment === "up" ? "\uD83D\uDC4D\u2714" : "\uD83D\uDC4E\u2714";
    }
    up.addEventListener("click", function(){ vote("up", up, down); });
    down.addEventListener("click", function(){ vote("down", down, up); });
    thumbs.appendChild(up);
    thumbs.appendChild(down);

    // Center message
    var msg = document.createElement("div");
    msg.className = "rec-banner-msg";
    msg.innerHTML = 'Enhanced Reports in Early Access \u2014 Contact <a href="mailto:dan@rec.us">dan@rec.us</a> with Feedback or Questions';

    // Got Feedback button
    var fbBtn = document.createElement("button");
    fbBtn.type = "button";
    fbBtn.className = "rec-banner-fb";
    fbBtn.innerHTML = '<span aria-hidden="true">\uD83D\uDCAC</span><span>Got Feedback?</span>';
    fbBtn.addEventListener("click", openModal);

    banner.appendChild(thumbs);
    banner.appendChild(msg);
    banner.appendChild(fbBtn);

    document.body.insertBefore(banner, document.body.firstChild);
  }

  function init(){
    injectStyle();
    mountBanner();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
