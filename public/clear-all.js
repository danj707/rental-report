/* ═══════════════════════════════════════════════════════════════════════
   THE NUCLEAR OPTION — one dialog, N reports
   ═══════════════════════════════════════════════════════════════════════
   Dan, 2026-09-23: *"we need a 'clear all data' nuclear option for each
   report. Button option somewhere at the top, has a confirmation, 'type
   DELETE to delete all data' type double confirmation box."*

   ONE IMPLEMENTATION, NOT ONE PER PAGE. Cost Recovery and Inventory both
   write, so both need this — and two copies of a destructive dialog is how
   one of them ends up missing the typed word, or clearing on the first
   button rather than the second. Same rule that put `saveTextViaPopup` and
   `csvFromRows` in open-pdf.js.

   THE DIALOG IS NOT THE GATE. The server checks the typed word itself
   (`confirm: "DELETE"`), so this file is what stops a misclick, and the route
   is what stops everything else. Neither is a substitute for the other.

   IT IS PORTALLED TO <body>, deliberately. Both toolbars set
   `text-transform`, colour and `flex-direction` on their own labels and
   buttons, and a dialog rendered inside one inherits all three — the recorded
   failure that made the aquatics settings sheet render uppercase, grey and
   stacked, and its Save button look inert. Getting out of the toolbar fixes
   every one of those at once.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  var WORD = "DELETE";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    // Text is set as TEXT, never as markup: this dialog prints an org's own
    // account and item names back at them.
    if (text != null) n.textContent = text;
    return n;
  }

  function injectCss() {
    if (document.getElementById("clrAllCss")) return;
    var st = el("style"); st.id = "clrAllCss";
    st.textContent = [
      ".clr-btn{background:#3a1212;border:1px solid #7f1d1d;color:#fca5a5;border-radius:6px;",
      "  padding:5px 11px;font-size:12px;font-family:inherit;cursor:pointer}",
      ".clr-btn:hover{background:#7f1d1d;color:#fff}",
      ".clr-back{position:fixed;inset:0;background:rgba(15,15,15,.62);z-index:99999;",
      "  display:flex;align-items:center;justify-content:center;padding:16px}",
      ".clr-box{background:#fff;color:#1a1a1a;border-radius:10px;max-width:440px;width:100%;",
      "  box-shadow:0 18px 50px rgba(0,0,0,.35);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
      ".clr-box h2{margin:0;padding:16px 18px 10px;font-size:16px;border-bottom:1px solid #eee}",
      ".clr-body{padding:14px 18px}",
      ".clr-body p{margin:0 0 10px}",
      ".clr-what{margin:0 0 12px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;",
      "  border-radius:0 6px 6px 0;font-weight:600;color:#7f1d1d}",
      ".clr-body ul{margin:0 0 12px;padding-left:20px}",
      ".clr-body li{margin:2px 0}",
      ".clr-note{color:#666;font-size:12.5px}",
      ".clr-body label{display:block;margin:0 0 6px;font-size:12.5px;color:#444;text-transform:none}",
      ".clr-body input{width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;",
      "  border:1px solid #ccc;border-radius:6px;letter-spacing:.06em}",
      ".clr-err{color:#b91c1c;font-size:12.5px;margin:8px 0 0;min-height:1em}",
      ".clr-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 18px 16px}",
      ".clr-foot button{padding:8px 14px;font:inherit;border-radius:6px;cursor:pointer;border:1px solid #ccc;background:#fff}",
      ".clr-foot .go{background:#dc2626;border-color:#dc2626;color:#fff;font-weight:600}",
      ".clr-foot .go:disabled{opacity:.45;cursor:default}",
      "@media print{.clr-btn,.clr-back{display:none !important}}"
    ].join("");
    document.head.appendChild(st);
  }

  /* opts: { mount, report, label, token, slug, describe(), beforeClear(), onCleared(res) }
     `describe()` is called EACH TIME the dialog opens, never once at mount —
     the counts have to be what is on the page now, not what it held when the
     button was drawn. */
  function mount(opts) {
    injectCss();
    var btn = el("button", "clr-btn", "☢ Clear all data");
    btn.type = "button";
    btn.id = "clearAllBtn";
    btn.title = "Permanently delete everything this organization has entered into " + opts.label;
    btn.addEventListener("click", function () { open(opts); });
    opts.mount.appendChild(btn);
    return btn;
  }

  function open(opts) {
    var lines = [];
    try { lines = opts.describe() || []; } catch (e) { lines = []; }
    var total = lines.reduce(function (a, l) { return a + (Number(l.n) || 0); }, 0);

    var back = el("div", "clr-back");
    back.id = "clrBack";
    var box  = el("div", "clr-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.appendChild(el("h2", null, "☢ Clear all " + opts.label + " data"));

    var body = el("div", "clr-body");

    /* WHAT IT DESTROYS, COUNTED, BEFORE THE WORD IS ASKED FOR. "Are you sure?"
       over an unnamed amount is a dialog people learn to click through; a line
       reading "12 program costs and 30 overhead rows" is one they read. */
    var what = el("p", "clr-what",
      total ? "This deletes " + lines.map(function (l) { return l.n + " " + l.label + (l.n === 1 ? "" : "s"); }).join(" and ") + "."
            : "There is nothing stored for this organization yet.");
    body.appendChild(what);

    if (opts.note) { var nb = el("p", "clr-note", opts.note); body.appendChild(nb); }

    body.appendChild(el("p", null, "It cannot be undone, and it applies to everyone at this organization — not just this browser."));

    var lab = el("label", null, "Type " + WORD + " to confirm");
    lab.setAttribute("for", "clrWord");
    body.appendChild(lab);
    var inp = el("input"); inp.id = "clrWord"; inp.type = "text";
    inp.setAttribute("autocomplete", "off"); inp.setAttribute("spellcheck", "false");
    inp.placeholder = WORD;
    body.appendChild(inp);
    var err = el("p", "clr-err", ""); err.id = "clrErr"; body.appendChild(err);
    box.appendChild(body);

    var foot = el("div", "clr-foot");
    var cancel = el("button", null, "Cancel"); cancel.type = "button"; cancel.id = "clrCancel";
    var go = el("button", "go", "Delete all data"); go.type = "button"; go.id = "clrGo";
    /* DISABLED UNTIL THE WORD IS RIGHT — that is the second confirmation.
       Case-sensitive on purpose: "delete" is a word people type by reflex. */
    go.disabled = true;
    foot.appendChild(cancel); foot.appendChild(go);
    box.appendChild(foot);
    back.appendChild(box);
    document.body.appendChild(back);

    function close() {
      document.removeEventListener("keydown", onKey);
      if (back.parentNode) back.parentNode.removeChild(back);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    cancel.addEventListener("click", close);
    // Clicking the backdrop closes; clicking INSIDE the box must not.
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    box.addEventListener("click", function (e) { e.stopPropagation(); });

    inp.addEventListener("input", function () { go.disabled = inp.value !== WORD; });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && !go.disabled) go.click(); });

    go.addEventListener("click", function () {
      if (inp.value !== WORD) return;         // belt and braces; the server checks too
      /* THE PAGE'S OWN SAVE QUEUE HAS TO BE DROPPED FIRST, and this is not
         tidiness: Cost Recovery debounces saves by 700ms, so a figure typed a
         moment before the confirmation is still queued — and it would land
         AFTER the wipe and write itself straight back. `beforeClear` is where
         a page cancels its timer and empties its dirty queues. */
      if (opts.beforeClear) { try { opts.beforeClear(); } catch (e) {} }
      go.disabled = true; go.textContent = "Deleting…"; err.textContent = "";
      var url = "/" + opts.slug + "/" + opts.report + "/api/clear-all"
              + (opts.token ? "?token=" + encodeURIComponent(opts.token) : "");
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: WORD, token: opts.token || "" })
      }).then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); })
        .then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || "Could not clear the data");
          close();
          if (opts.onCleared) opts.onCleared(d);
        })
        .catch(function (e) {
          /* A FAILED CLEAR MUST SAY SO. Closing on an error would leave a
             reader believing their data is gone while it is still there —
             the worst outcome this dialog can produce. */
          go.disabled = false; go.textContent = "Delete all data";
          err.textContent = e.message || "Could not clear the data";
        });
    });

    setTimeout(function () { inp.focus(); }, 0);
    return back;
  }

  window.RecClearAll = { mount: mount, open: open, WORD: WORD };
})();
