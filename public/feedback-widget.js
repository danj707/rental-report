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

    /* THE BANNER AND EVERY REPORT'S TOOLBAR ARE BOTH `position: sticky; top: 0`,
       and this banner wins on z-index — so the toolbar parked UNDERNEATH it and
       the top of the date fields was cut off the moment the page scrolled. Dan,
       2026-09-03: "we need to 'pin' this top header with all the search stuff.
       scrolling down and having it disappear is super frustrating."

       The banner owns its own height, so it is the only thing that can publish
       it. Every page sticks its toolbar at `var(--rec-banner-h, 0px)`, which
       falls back to 0 wherever this widget is not loaded — so a page that never
       shows the banner is unchanged.

       MEASURED, NOT ASSUMED: the banner WRAPS on a narrow viewport and gets
       taller, so a hardcoded 44px pins the toolbar into it on a laptop and
       leaves a gap on a phone. Re-measured on resize, and through a
       ResizeObserver where there is one, because the message can rewrap without
       the window changing size. */
    var setBannerH = function () {
      var h = banner.offsetHeight || 0;
      document.documentElement.style.setProperty("--rec-banner-h", h + "px");
    };
    setBannerH();
    window.addEventListener("resize", setBannerH);
    if (typeof ResizeObserver === "function") {
      try { new ResizeObserver(setBannerH).observe(banner); } catch (e) {}
    }
  }

  // ── Reaction burst ────────────────────────────────────────────
  // 👍 rains confetti, 👎 rains sad faces. Wired as ONE delegated listener
  // rather than 15 onClick handlers: the thumbs live in this banner and in
  // every report's Rec Insights footer, and they are all plain buttons whose
  // whole label is the emoji. Capture phase, because the insights buttons
  // rewrite their own label to "👍✔" the moment they are clicked.
  var BURST_CSS_ID = "rec-burst-css";
  function injectBurstStyle(){
    if (document.getElementById(BURST_CSS_ID)) return;
    var s = document.createElement("style");
    s.id = BURST_CSS_ID;
    s.textContent = ""
      + ".rec-burst{position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden;}"
      + ".rec-burst i{position:absolute;top:-8vh;display:block;will-change:transform,opacity;"
      + "animation:rec-burst-fall linear forwards;}"
      + ".rec-burst i.c{width:9px;height:14px;border-radius:2px;}"
      + ".rec-burst i.s{font-size:26px;line-height:1;font-style:normal;}"
      + "@keyframes rec-burst-fall{"
      + "0%{transform:translate3d(0,0,0) rotate(0deg);opacity:1}"
      + "100%{transform:translate3d(var(--dx),110vh,0) rotate(var(--rot));opacity:.9}}";
    document.head.appendChild(s);
  }
  var CONFETTI = ["#0d9488","#f59e0b","#dc2626","#2563eb","#7c3aed","#16a34a","#ec4899","#facc15"];
  var SADS = ["😢","😞","☹️","😔","💧"];
  function burst(kind){
    // Someone who asked for less motion gets none.
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    injectBurstStyle();
    var prev = document.querySelector(".rec-burst");
    if (prev) prev.remove();
    var wrap = document.createElement("div");
    wrap.className = "rec-burst";
    wrap.setAttribute("aria-hidden", "true");
    var n = kind === "up" ? 90 : 34;
    for (var i = 0; i < n; i++) {
      var bit = document.createElement("i");
      var dur = 2.4 + Math.random() * 2.2;
      bit.className = kind === "up" ? "c" : "s";
      if (kind === "up") bit.style.background = CONFETTI[i % CONFETTI.length];
      else bit.textContent = SADS[i % SADS.length];
      bit.style.left = (Math.random() * 100).toFixed(2) + "vw";
      bit.style.animationDuration = dur.toFixed(2) + "s";
      bit.style.animationDelay = (Math.random() * 0.8).toFixed(2) + "s";
      bit.style.setProperty("--dx", (Math.random() * 160 - 80).toFixed(0) + "px");
      bit.style.setProperty("--rot", (Math.random() * 900 - 450).toFixed(0) + "deg");
      wrap.appendChild(bit);
    }
    document.body.appendChild(wrap);
    setTimeout(function(){ if (wrap.parentNode) wrap.remove(); }, 6000);
  }
  window.recReactionBurst = burst;   // so a page can fire it directly

  function wireBursts(){
    document.addEventListener("click", function(ev){
      var el = ev.target;
      var btn = el && el.closest ? el.closest("button,[role=button]") : null;
      if (!btn) return;
      var txt = (btn.textContent || "").trim();
      // Only the bare thumb buttons — not a "👍 Positive" stat label or a
      // sentence that happens to contain the emoji.
      if (txt.length > 4) return;
      if (txt.indexOf("\uD83D\uDC4D") === 0) burst("up");
      else if (txt.indexOf("\uD83D\uDC4E") === 0) burst("down");
    }, true);
  }


  // ── Surveys ───────────────────────────────────────────────────────
  /* An admin-authored question set, offered as a card in the corner.
     Dan, 2026-09-11: "lets build the survey tool, i need some feedback" — and
     the hard rule: "just NEVER on a customer facing report ... ONLY on admin
     stuff."

     THAT RULE IS HONOURED BY WHERE THIS CODE LIVES, not by a check inside it.
     The three un-tokened customer pages — calendar, rentalcalendar, campmap —
     do not load feedback-widget.js at all (measured: zero, against 22 admin
     pages that do), so a resident cannot be shown a survey even if every test
     on the server were deleted. The server's PUBLIC_REPORTS gate is the second
     line, not the first.

     A CARD, NEVER A MODAL. These readers are admins mid-task; a dialog over
     the report they came to read is an interruption, and an interruption is
     how a survey gets closed unread. It sits in the corner, it can be ignored,
     and it never covers the page. */
  var SURVEY_SEEN_KEY = "rec_survey_v1";      // { "<id>": "done" | "no" }
  var SURVEY_DELAY_MS = 4000;                 // let them see the report first
  // The org landing page has no second path segment. MUST match
  // SURVEY_ORG_SURFACE in server.js — the spec pins the two together, because
  // two spellings of one surface makes targeting it match nothing, silently.
  var SURVEY_ORG_SURFACE = "org-dashboard";

  function surveySeen(){
    try { return JSON.parse(localStorage.getItem(SURVEY_SEEN_KEY) || "{}") || {}; }
    catch (_) { return {}; }
  }
  function surveyRemember(id, how){
    try {
      var m = surveySeen(); m[id] = how;
      localStorage.setItem(SURVEY_SEEN_KEY, JSON.stringify(m));
    } catch (_) {}
  }
  function surveyWhere(){
    var parts = (window.location.pathname || "").split("/").filter(Boolean);
    var qs = window.location.search || "";
    var m = qs.match(/token=([^&]+)/);
    return {
      org: parts[0] || "",
      report: parts[1] || SURVEY_ORG_SURFACE,
      tokenQS: m ? "?token=" + m[1] : "",
    };
  }

  var SURVEY_CSS = ""
    + ".rec-svy{position:fixed;right:18px;bottom:18px;z-index:99997;width:340px;max-width:calc(100vw - 36px);"
    + "background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 18px 40px rgba(15,23,42,.22);"
    + "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;overflow:hidden;}"
    + "@media (prefers-reduced-motion: no-preference){.rec-svy{animation:recSvyIn .22s cubic-bezier(.16,1,.3,1);}}"
    + "@keyframes recSvyIn{from{transform:translateY(14px);opacity:0}to{transform:translateY(0);opacity:1}}"
    + ".rec-svy-hd{display:flex;align-items:flex-start;gap:8px;padding:14px 14px 0;}"
    + ".rec-svy-hd h3{margin:0;font-size:14px;font-weight:650;line-height:1.3;flex:1;}"
    + ".rec-svy-x{background:none;border:none;cursor:pointer;font-size:17px;line-height:1;color:#9ca3af;padding:0 2px;}"
    + ".rec-svy-x:hover{color:#4b5563;}"
    + ".rec-svy-intro{margin:6px 14px 0;font-size:12px;color:#6b7280;line-height:1.45;}"
    + ".rec-svy-body{padding:12px 14px 4px;max-height:min(60vh,460px);overflow-y:auto;}"
    + ".rec-svy-q{margin:0 0 14px;}"
    + ".rec-svy-q > p{margin:0 0 7px;font-size:13px;font-weight:550;line-height:1.35;}"
    + ".rec-svy-req{color:#dc2626;font-weight:700;margin-left:2px;}"
    + ".rec-svy-scale{display:flex;gap:5px;flex-wrap:wrap;}"
    + ".rec-svy-scale button{flex:1 1 0;min-width:30px;padding:7px 0;border:1px solid #d1d5db;background:#fff;border-radius:6px;"
    + "cursor:pointer;font-size:13px;font-family:inherit;color:#374151;transition:background .1s ease,border-color .1s ease;}"
    + ".rec-svy-scale button:hover{background:#f3f4f6;}"
    + ".rec-svy-scale button.on{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600;}"
    + ".rec-svy-stars{display:flex;gap:2px;}"
    + ".rec-svy-stars button{background:none;border:none;cursor:pointer;font-size:24px;line-height:1;padding:0 2px;"
    + "filter:grayscale(1);opacity:.45;transition:opacity .1s ease,filter .1s ease,transform .1s ease;}"
    + ".rec-svy-stars button.on{filter:none;opacity:1;}"
    + ".rec-svy-stars button:hover{transform:scale(1.14);}"
    + ".rec-svy-opts{display:flex;flex-direction:column;gap:5px;}"
    + ".rec-svy-opts label{display:flex;align-items:flex-start;gap:7px;font-size:13px;line-height:1.35;cursor:pointer;"
    + "padding:5px 7px;border:1px solid #e5e7eb;border-radius:6px;color:#374151;}"
    + ".rec-svy-opts label:hover{background:#f9fafb;}"
    + ".rec-svy-opts input{margin:2px 0 0;flex-shrink:0;}"
    + ".rec-svy-q textarea{width:100%;box-sizing:border-box;min-height:74px;resize:vertical;padding:8px 9px;"
    + "border:1px solid #d1d5db;border-radius:6px;font:inherit;font-size:13px;line-height:1.45;color:#111827;background:#fff;}"
    + ".rec-svy-q textarea:focus,.rec-svy-scale button:focus-visible,.rec-svy-opts label:focus-within"
    + "{outline:2px solid #3b82f6;outline-offset:1px;}"
    + ".rec-svy-ft{display:flex;align-items:center;gap:8px;padding:10px 14px 13px;border-top:1px solid #f3f4f6;}"
    + ".rec-svy-ft .rec-svy-later{background:none;border:none;color:#6b7280;font-size:12px;cursor:pointer;font-family:inherit;padding:4px 2px;}"
    + ".rec-svy-ft .rec-svy-later:hover{color:#374151;text-decoration:underline;}"
    + ".rec-svy-send{margin-left:auto;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 15px;"
    + "font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;}"
    + ".rec-svy-send:hover{background:#1d4ed8;}"
    + ".rec-svy-send:disabled{background:#93c5fd;cursor:not-allowed;}"
    + ".rec-svy-err{margin:0 14px 8px;font-size:12px;color:#dc2626;line-height:1.4;}"
    + ".rec-svy-done{padding:26px 18px;text-align:center;}"
    + ".rec-svy-done h3{margin:0 0 5px;font-size:15px;color:#059669;}"
    + ".rec-svy-done p{margin:0;font-size:13px;color:#6b7280;}"
    + "@media print{.rec-svy{display:none!important;}}"
    + "body.print-mode .rec-svy{display:none!important;}";

  function surveyInjectStyle(){
    if (document.getElementById("rec-svy-css")) return;
    var s = document.createElement("style");
    s.id = "rec-svy-css";
    s.textContent = SURVEY_CSS;
    document.head.appendChild(s);
  }

  // Every prompt and option is set with textContent, never innerHTML — this is
  // admin-authored copy, but it is copy that reaches other people's screens.
  function surveyEl(tag, cls, text){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function surveyRenderQuestion(q, state){
    var wrap = surveyEl("div", "rec-svy-q");
    wrap.setAttribute("data-svy-q", q.id);
    wrap.setAttribute("data-svy-type", q.type);
    var p = surveyEl("p", null, q.prompt);
    if (q.required) { var r = surveyEl("span", "rec-svy-req", "*"); r.title = "Required"; p.appendChild(r); }
    wrap.appendChild(p);

    if (q.type === "stars") {
      var row = surveyEl("div", "rec-svy-stars");
      for (var i = 1; i <= 5; i++) (function(n){
        var b = surveyEl("button", null, "★");
        b.type = "button";
        b.setAttribute("aria-label", n + " of 5");
        b.addEventListener("click", function(){
          state[q.id] = n;
          // Stars FILL UP TO the one clicked — a single lit star in the middle
          // of four grey ones is not how anybody reads a star rating.
          Array.prototype.forEach.call(row.children, function(c, j){
            c.classList.toggle("on", j < n);
          });
        });
        row.appendChild(b);
      })(i);
      wrap.appendChild(row);
      return wrap;
    }

    if (q.type === "rating5" || q.type === "nps") {
      var lo = q.type === "nps" ? 0 : 1, hi = q.type === "nps" ? 10 : 5;
      var scale = surveyEl("div", "rec-svy-scale");
      for (var n2 = lo; n2 <= hi; n2++) (function(n){
        var b = surveyEl("button", null, String(n));
        b.type = "button";
        b.addEventListener("click", function(){
          state[q.id] = n;
          Array.prototype.forEach.call(scale.children, function(c){ c.classList.remove("on"); });
          b.classList.add("on");
        });
        scale.appendChild(b);
      })(n2);
      wrap.appendChild(scale);
      return wrap;
    }

    if (q.type === "yesno" || q.type === "single" || q.type === "multi") {
      var many = q.type === "multi";
      var box = surveyEl("div", "rec-svy-opts");
      (q.options || []).forEach(function(opt){
        var lab = surveyEl("label");
        var inp = document.createElement("input");
        inp.type = many ? "checkbox" : "radio";
        inp.name = "svy_" + q.id;
        inp.value = opt;
        inp.addEventListener("change", function(){
          if (many) {
            var picked = [];
            Array.prototype.forEach.call(box.querySelectorAll("input"), function(x){
              if (x.checked) picked.push(x.value);
            });
            // An empty array is not an answer — drop the key entirely so a
            // required question stays unanswered rather than passing on [].
            if (picked.length) state[q.id] = picked; else delete state[q.id];
          } else {
            state[q.id] = opt;
          }
        });
        lab.appendChild(inp);
        lab.appendChild(surveyEl("span", null, opt));
        box.appendChild(lab);
      });
      wrap.appendChild(box);
      return wrap;
    }

    var ta = document.createElement("textarea");
    ta.placeholder = q.placeholder || "";
    ta.setAttribute("maxlength", "2000");
    ta.addEventListener("input", function(){
      var v = ta.value.trim();
      if (v) state[q.id] = v; else delete state[q.id];
    });
    wrap.appendChild(ta);
    return wrap;
  }

  function surveyMount(survey, where){
    if (document.querySelector(".rec-svy")) return;
    surveyInjectStyle();
    var state = {};
    var card = surveyEl("div", "rec-svy");
    card.setAttribute("data-svy", survey.id);
    card.setAttribute("role", "form");
    card.setAttribute("aria-label", survey.title);

    var hd = surveyEl("div", "rec-svy-hd");
    hd.appendChild(surveyEl("h3", null, survey.title));
    var x = surveyEl("button", "rec-svy-x", "×");
    x.type = "button"; x.setAttribute("aria-label", "Close");
    hd.appendChild(x);
    card.appendChild(hd);
    if (survey.intro) card.appendChild(surveyEl("p", "rec-svy-intro", survey.intro));

    var body = surveyEl("div", "rec-svy-body");
    (survey.questions || []).forEach(function(q){ body.appendChild(surveyRenderQuestion(q, state)); });
    card.appendChild(body);

    var err = surveyEl("div", "rec-svy-err");
    err.style.display = "none";
    card.appendChild(err);

    var ft = surveyEl("div", "rec-svy-ft");
    var later = surveyEl("button", "rec-svy-later", "Not now");
    later.type = "button";
    var send = surveyEl("button", "rec-svy-send", "Send");
    send.type = "button";
    ft.appendChild(later);
    ft.appendChild(send);
    card.appendChild(ft);
    document.body.appendChild(card);

    function dismiss(){
      surveyRemember(survey.id, "no");
      if (where.org) {
        fetch("/" + where.org + "/" + where.report + "/api/survey-dismiss" + where.tokenQS, {
          method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
          body: JSON.stringify({ surveyId: survey.id }),
        }).catch(function(){});
      }
      card.remove();
    }
    x.addEventListener("click", dismiss);
    later.addEventListener("click", dismiss);

    send.addEventListener("click", function(){
      var missing = (survey.questions || []).filter(function(q){
        return q.required && state[q.id] == null;
      });
      if (missing.length) {
        // Name the question rather than saying "fill in the required fields" —
        // on a scrolling card the one they missed may be off screen.
        err.textContent = "Still needed: " + missing.map(function(q){ return "“" + q.prompt + "”"; }).join(", ");
        err.style.display = "block";
        var first = body.querySelector('[data-svy-q="' + missing[0].id + '"]');
        if (first && first.scrollIntoView) first.scrollIntoView({ block: "nearest" });
        return;
      }
      err.style.display = "none";
      send.disabled = true;
      send.textContent = "Sending…";
      fetch("/" + where.org + "/" + where.report + "/api/survey" + where.tokenQS, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surveyId: survey.id, answers: state }),
      }).then(function(r){
        return r.json().catch(function(){ return {}; }).then(function(j){
          if (!r.ok) throw new Error(j.error || ("Send failed (" + r.status + ")"));
          return j;
        });
      }).then(function(){
        // Remembered ONLY on a confirmed send. Marking it done optimistically
        // is how an answer that never landed becomes an answer nobody is ever
        // asked for again.
        surveyRemember(survey.id, "done");
        card.setAttribute("data-svy-done", "1");
        card.innerHTML = "";
        var done = surveyEl("div", "rec-svy-done");
        done.appendChild(surveyEl("h3", null, "Thank you 🙌"));
        done.appendChild(surveyEl("p", null, "That goes straight to the Rec team."));
        card.appendChild(done);
        setTimeout(function(){ if (card.parentNode) card.remove(); }, 2600);
      }).catch(function(e){
        err.textContent = (e && e.message) || "Send failed. Please try again.";
        err.style.display = "block";
        send.disabled = false;
        send.textContent = "Send";
      });
    });
  }

  function surveyInit(){
    var where = surveyWhere();
    if (!where.org) return;
    fetch("/" + where.org + "/" + where.report + "/api/survey" + where.tokenQS)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        var s = d && d.survey;
        if (!s || !s.id || !(s.questions || []).length) return;
        // Asked once per browser. Answered OR dismissed both count — being
        // re-asked something you already declined is worse than never being
        // asked, and it is the fastest way to make the card get ignored.
        if (surveySeen()[s.id]) return;
        setTimeout(function(){ surveyMount(s, where); }, SURVEY_DELAY_MS);
      })
      .catch(function(){});
  }

  function init(){
    injectStyle();
    mountBanner();
    wireBursts();
    surveyInit();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
