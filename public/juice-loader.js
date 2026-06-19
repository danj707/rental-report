/* ══════════════════════════════════════════════════════════════
   Juice Loader — shared loading animation for rec.us reports
   
   Usage:
     <script src="/juice-loader.js"></script>
     Then in JSX: <JuiceLoader />
     Or with custom messages: <JuiceLoader messages={['Loading…','Almost…']} />
     Optional style prop: <JuiceLoader style={{height:300}} />
   ══════════════════════════════════════════════════════════════ */
(function() {
  // ── Inject CSS (once) ────────────────────────────────────────
  if (!document.getElementById('juice-loader-css')) {
    var s = document.createElement('style');
    s.id = 'juice-loader-css';
    s.textContent = [
      '.juice-loading { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; text-align:center; padding:60px 16px; color:#888; font-size:14px; }',
      '.juice-loading .juice-spinner {',
      '  position:relative; display:inline-block; width:34px; height:44px; margin:0 auto;',
      '  box-sizing:border-box; border:2px solid #e07b1a; border-top-color:#f7b96b;',
      '  border-radius:4px 4px 14px 14px; background:rgba(255,248,240,0.5);',
      '  overflow:hidden; box-shadow:inset -4px 0 0 rgba(255,255,255,0.35);',
      '}',
      '.juice-loading .juice-spinner::before {',
      '  content:""; position:absolute; left:0; right:0; bottom:0; height:60%;',
      '  background:linear-gradient(180deg,#ffb24d 0%,#ff8c1f 55%,#f2710a 100%);',
      '  box-shadow:inset 0 2px 0 rgba(255,255,255,0.45);',
      '  animation:juice-fill 2s ease-in-out infinite;',
      '}',
      '.juice-loading .juice-spinner::after {',
      '  content:""; position:absolute; left:50%; bottom:6px; width:3px; height:3px; margin-left:-1.5px;',
      '  border-radius:50%; background:rgba(255,255,255,0.85);',
      '  box-shadow:-5px 7px 0 0 rgba(255,255,255,0.65), 5px 12px 0 -0.5px rgba(255,255,255,0.5);',
      '  animation:juice-bubbles 2.2s ease-out infinite;',
      '}',
      '@keyframes juice-fill { 0%{height:42%} 50%{height:80%} 100%{height:42%} }',
      '@keyframes juice-bubbles { 0%{transform:translateY(2px) scale(0.5);opacity:0} 30%{opacity:0.9} 70%{opacity:0.6} 100%{transform:translateY(-22px) scale(1);opacity:0} }',
      '.juice-msg { position:relative; height:1.4em; line-height:1.4em; min-width:200px; margin:0 auto; }',
      '.juice-msg span { position:absolute; left:0; right:0; text-align:center; opacity:0; animation:juice-phrase 10s infinite; }',
      '.juice-msg span:nth-child(1) { animation-delay:0s; }',
      '.juice-msg span:nth-child(2) { animation-delay:2s; }',
      '.juice-msg span:nth-child(3) { animation-delay:4s; }',
      '.juice-msg span:nth-child(4) { animation-delay:6s; }',
      '.juice-msg span:nth-child(5) { animation-delay:8s; }',
      '@keyframes juice-phrase { 0%{opacity:0;transform:translateY(5px)} 2%{opacity:1;transform:translateY(0)} 18%{opacity:1;transform:translateY(0)} 20%{opacity:0;transform:translateY(-5px)} 100%{opacity:0} }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── React component ──────────────────────────────────────────
  var DEFAULT_MSGS = [
    'Squeezing the oranges\u2026',
    'Juicing!',
    'Adding the pulp\u2026',
    'Chilling the glass\u2026',
    'Pouring it out\u2026',
  ];

  window.JuiceLoader = function JuiceLoader(props) {
    var msgs = (props && props.messages) || DEFAULT_MSGS;
    return React.createElement('div',
      { className: 'juice-loading', style: (props && props.style) || {} },
      React.createElement('div', { className: 'juice-spinner' }),
      React.createElement('div', { className: 'juice-msg' },
        msgs.map(function(m, i) { return React.createElement('span', { key: i }, m); })
      )
    );
  };
})();
