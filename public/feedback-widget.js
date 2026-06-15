/* rec.us — Got Feedback widget
   Floating button + modal, POSTs to /api/feedback which emails dan@rec.us.
   Self-disables in print mode. No deps. Idempotent (won't double-init). */
(function(){
  if (window.__recFeedbackLoaded) return;
  window.__recFeedbackLoaded = true;

  // Skip in print/PDF mode
  try {
    var qs = window.location.search || "";
    if (qs.indexOf("_print=1") !== -1) return;
    if (document.body && document.body.classList && document.body.classList.contains("print-mode")) return;
  } catch (_) {}

  var CSS = ""
    + ".fb-btn{position:fixed;bottom:20px;right:20px;z-index:99998;background:#111827;color:#fff;"
    + "border:none;cursor:pointer;padding:11px 16px;border-radius:999px;font-size:13px;font-weight:600;"
    + "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.18);"
    + "display:inline-flex;align-items:center;gap:7px;transition:transform .15s ease,box-shadow .15s ease,background .15s ease;}"
    + ".fb-btn:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,0.24);background:#1f2937;}"
    + ".fb-btn:focus-visible{outline:3px solid rgba(59,130,246,.45);outline-offset:2px;}"
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
    + "@media print{.fb-btn,.fb-overlay{display:none!important;}}"
    + ".fb-thumbs{position:fixed;bottom:20px;right:200px;z-index:99998;display:inline-flex;gap:4px;}"
    + ".fb-thumb{background:#fff;border:1px solid #e5e7eb;cursor:pointer;padding:6px 10px;border-radius:999px;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,0.08);transition:transform .12s ease,box-shadow .12s ease,background .12s ease;line-height:1;}"
    + ".fb-thumb:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.15);}"
    + ".fb-thumb.voted{opacity:0.5;pointer-events:none;}"
    + "@media print{.fb-thumbs{display:none!important;}}"
    + "body.print-mode .fb-thumbs{display:none!important;}"
    + "body.print-mode .fb-btn,body.print-mode .fb-overlay{display:none!important;}";

  function injectStyle(){
    var s = document.createElement("style");
    s.setAttribute("data-rec-feedback","1");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function mountButton(){
    if (document.querySelector(".fb-btn")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "fb-btn";
    b.setAttribute("aria-label","Send feedback");
    b.innerHTML = '<span aria-hidden="true">💬</span><span>Got Feedback?</span>';
    b.addEventListener("click", openModal);
    document.body.appendChild(b);
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
    // Cmd/Ctrl+Enter to submit from the textarea
    $msg.addEventListener("keydown", function(e){
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
    });
  }

  function mountThumbs(){
    if (document.querySelector(".fb-thumbs")) return;
    var wrap = document.createElement("div");
    wrap.className = "fb-thumbs";
    var up = document.createElement("button");
    up.type = "button"; up.className = "fb-thumb"; up.innerHTML = "\uD83D\uDC4D";
    up.title = "This report is helpful";
    var down = document.createElement("button");
    down.type = "button"; down.className = "fb-thumb"; down.innerHTML = "\uD83D\uDC4E";
    down.title = "This report needs work";
    function vote(sentiment, btn){
      btn.classList.add("voted");
      fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: sentiment === "up" ? "\uD83D\uDC4D Report is helpful" : "\uD83D\uDC4E Report needs work",
          email: "",
          page: window.location.pathname + window.location.search,
          userAgent: navigator.userAgent,
          quickVote: sentiment
        })
      }).catch(function(){});
    }
    up.addEventListener("click", function(){ vote("up", up); });
    down.addEventListener("click", function(){ vote("down", down); });
    wrap.appendChild(up);
    wrap.appendChild(down);
    document.body.appendChild(wrap);
  }

  function init(){
    injectStyle();
    mountButton();
    mountThumbs();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
