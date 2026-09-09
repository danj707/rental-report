/* ══════════════════════════════════════════════════════════════════════════
   report-loader.js — the one loading state for every rec.us report.

   Replaces juice-loader.js. Dan, 2026-09-06: "I think it's time to retire it
   across all the reports, just seems not as professional now that we're pretty
   robust… With the juicing animation, I was getting feedback that it was taking
   forever and no one had any idea how long it would actually take. Someone is
   more willing to wait for a progress bar than a forever spinner."

   Usage:
     <script src="/report-loader.js"></script>
     <ReportLoader />                       // uses ORG_CONFIG.loadEstimate
     <ReportLoader label="Building the roster" />
     <ReportLoader estimateMs={30000} />    // override, e.g. a known-heavy panel

   ── WHAT MAKES IT "SMART", and what it deliberately does not claim ─────────

   The estimate is MEASURED, not invented: server.js keeps the last 20 cache
   MISS durations per org + report in the durable store, takes the 80th
   percentile, and injects it as ORG_CONFIG.loadEstimate before first paint. So
   the bar knows roughly how long THIS org's THIS report has actually taken.

   It still cannot know how long THIS run will take — nobody can, the query has
   not finished. So the bar is honest about the difference:

     · Under the estimate it advances smoothly toward 92%.
     · It NEVER reaches 100% on its own. A bar that fills and then sits there is
       worse than no bar, because it has told the reader a lie they can see.
     · Past the estimate it keeps moving but asymptotically, and SAYS SO
       ("longer than usual"). Still-moving-but-slower is the honest picture of
       "we are over, and still going".
     · The elapsed seconds are always on screen. That is the number the reader
       actually wanted, and it is the one thing here that is not an estimate.

   ── A FAST LOAD MUST SHOW NOTHING ─────────────────────────────────────────

   A warm cache answers in ~200ms. Flashing a progress bar for a fifth of a
   second is worse than a blank pause: it reads as a glitch, and it makes a fast
   report feel slow. Nothing renders for the first SHOW_DELAY_MS, so a cache hit
   is silent and only a real wait draws anything.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  var SHOW_DELAY_MS = 350;    // below this, a load is "instant" and shows nothing
  var TICK_MS       = 100;
  // THESE NUMBERS WERE WRONG ON FIRST SHIP, and Dan caught it: a report still
  // running at 40s showed a bar at 98.4%, which is visually indistinguishable
  // from finished. The old shape reached 92% AT the estimate and then spent the
  // remaining 8% over the whole rest of the wait — but 92% and 99% look the
  // same, so the entire over-estimate regime read as "done, and stuck".
  //
  // The fix is to reserve a lot more visible room for the overrun. The estimate
  // is now four fifths of the way along, not eleven twelfths, and the tail
  // decays over TWICE the estimate rather than once, so being 3x over reads as
  // "most of the way, still going" instead of "finished".
  var CAP_BEFORE    = 80;     // where the bar sits when the estimate is spent
  // A HARD CEILING BELOW 100, and it is load-bearing rather than tidy. The
  // asymptote is 1 - 0.5^over, which underflows to exactly 0 in float once
  // `over` passes ~1000 — so on a genuinely long wait the "never reaches 100"
  // curve reaches 100, fills the bar, and sits there: the precise lie this is
  // built to avoid. Caught by running the function, not by reading it.
  var CAP_ABSOLUTE  = 95;
  // The pacing used when the server has no history to offer. 12s was far too
  // short: the real misses this recorded on its first afternoon ran 1.6s, 2.4s,
  // 8.6s, 13.4s, 25.4s and 41.1s. A default under the common case makes every
  // unknown report look stalled within seconds, and too-slow reads as "working"
  // where too-fast reads as "lying" — the same asymmetry that picks the 80th
  // percentile over the median. Keep in step with LOAD_TIMING_DEFAULT_MS.
  var DEFAULT_MS    = 25000;

  if (!document.getElementById('report-loader-css')) {
    var s = document.createElement('style');
    s.id = 'report-loader-css';
    s.textContent = [
      '.rl-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;',
      '  gap:12px;padding:56px 16px;text-align:center;color:#5b6472;font-size:13px;}',
      '.rl-label{font-size:14px;color:#374151;font-weight:500;letter-spacing:.01em;}',
      '.rl-track{position:relative;width:min(420px,72vw);height:6px;border-radius:999px;',
      '  background:#e8ebef;overflow:hidden;}',
      '.rl-bar{position:absolute;inset:0 auto 0 0;width:0;border-radius:999px;',
      '  background:linear-gradient(90deg,#3b82f6,#2563eb);',
      '  transition:width .28s cubic-bezier(.4,0,.2,1);}',
      /* A moving sheen, so a slow-but-healthy load still looks alive. It is the
         only animation here and it is decoration, never information. */
      '.rl-bar::after{content:"";position:absolute;inset:0;border-radius:999px;',
      '  background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);',
      '  animation:rl-sheen 1.6s linear infinite;}',
      '@keyframes rl-sheen{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}',
      '.rl-meta{font-variant-numeric:tabular-nums;font-size:12px;color:#8a93a0;}',
      '.rl-over{color:#b45309;}',
      /* Reduced motion keeps the BAR (it is information) and drops the sheen. */
      '@media (prefers-reduced-motion: reduce){',
      '  .rl-bar::after{animation:none;display:none}',
      '  .rl-bar{transition:none}',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // Exported so a spec can RUN it rather than regex over it — the same reason
  // nightStateFrom and ftEffectiveStatus sit at module scope. A regex passes on
  // an inverted comparison; this is arithmetic and has to be executed.
  //
  // Two regimes, and the join between them is the whole design:
  //   elapsed <= estimate : ease out toward CAP_BEFORE, decelerating, so it
  //                         looks like progress rather than a constant crawl.
  //   elapsed  > estimate : keep going, but halve the REMAINING gap on each
  //                         further estimate-length, so it can never arrive and
  //                         never quite stops.
  function loaderProgress(elapsedMs, estimateMs) {
    var est = Number(estimateMs) > 0 ? Number(estimateMs) : DEFAULT_MS;
    var t = Math.max(0, Number(elapsedMs) || 0);
    if (t <= est) {
      // 1 - (1-x)^2 : quick off the mark, easing as it approaches the cap.
      var x = t / est;
      return CAP_BEFORE * (1 - Math.pow(1 - x, 2));
    }
    // Halve the remaining gap every TWO estimate-lengths, not every one, and
    // toward 95 rather than 100. At 3x the estimate that is ~88% — clearly
    // unfinished — where the old curve was at 98%.
    var over = (t - est) / est;
    return Math.min(CAP_ABSOLUTE,
      CAP_BEFORE + (CAP_ABSOLUTE - CAP_BEFORE) * (1 - Math.pow(0.5, over / 2)));
  }

  function fmtSecs(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  }

  // "about 30s" is a promise; "usually about 30s" is a description of history.
  // Only the second one is true, and only the second one survives a run that
  // takes twice as long.
  function estimateNote(est, basis) {
    if (!est) return '';
    if (basis === 'default') return '';   // no history — claim nothing
    return 'usually about ' + fmtSecs(est);
  }

  function readEstimate(props) {
    if (props && Number(props.estimateMs) > 0) {
      return { ms: Number(props.estimateMs), basis: 'prop' };
    }
    var c = (window.ORG_CONFIG && window.ORG_CONFIG.loadEstimate) || null;
    if (c && Number(c.ms) > 0) return { ms: Number(c.ms), basis: c.basis || 'org' };
    return { ms: DEFAULT_MS, basis: 'default' };
  }

  window.loaderProgress = loaderProgress;
  window.loaderEstimateNote = estimateNote;
  window.loaderFmtSecs = fmtSecs;
  // EXPORTED BECAUSE A SECOND READER GOT THE SHAPE WRONG. programs-schedule.html
  // is vanilla JS and draws its own bar, and it read ORG_CONFIG.loadEstimate by
  // hand and passed the whole {ms,basis} OBJECT to estimateNote — which is
  // truthy, so the no-history guard never fired and fmtSecs(object) rendered the
  // literal "usually about NaNm NaNs" on screen. Every caller reads the estimate
  // through here now, so the object/field mismatch cannot recur.
  window.loaderReadEstimate = readEstimate;

  window.ReportLoader = function ReportLoader(props) {
    props = props || {};
    var R = React;
    var est = readEstimate(props);
    var startRef = R.useRef(Date.now());
    var state = R.useState(0);
    var elapsed = state[0], setElapsed = state[1];

    R.useEffect(function () {
      startRef.current = Date.now();
      var id = setInterval(function () {
        setElapsed(Date.now() - startRef.current);
      }, TICK_MS);
      return function () { clearInterval(id); };
    }, []);

    // Nothing at all until a load is genuinely slow. A bar that flashes for
    // 200ms on a cache hit makes a fast report feel broken.
    if (elapsed < SHOW_DELAY_MS) return null;

    var pct = loaderProgress(elapsed, est.ms);
    var over = elapsed > est.ms;
    var note = estimateNote(est.ms, est.basis);

    return R.createElement('div', {
      className: 'rl-wrap',
      style: props.style || {},
      'data-rl': '1',
      // The computed values, so a render case can key on the NUMBER rather than
      // on "a bar appeared" — a bar wired to a broken estimate renders
      // identically.
      'data-rl-pct': String(Math.round(pct)),
      'data-rl-over': over ? '1' : '0',
      'data-rl-basis': est.basis
    },
      R.createElement('div', { className: 'rl-label' }, props.label || 'Running your report'),
      R.createElement('div', { className: 'rl-track' },
        R.createElement('div', { className: 'rl-bar', style: { width: pct.toFixed(1) + '%' } })
      ),
      R.createElement('div', { className: 'rl-meta' + (over ? ' rl-over' : '') },
        over
          // "longer than usual" is only true when there IS a usual. With no
          // history the honest line says it is still working and claims nothing
          // about how much longer.
          ? fmtSecs(elapsed) + (note ? ' · longer than usual — still working' : ' · still working')
          : (note ? fmtSecs(elapsed) + ' · ' + note : fmtSecs(elapsed))
      )
    );
  };

  // The juice loader is retired, but a page that still calls it must not throw
  // a blank tree — that is the class of failure this repo has shipped twice.
  // It is the standard loader now, and report-loader.spec.js fails if any page
  // still references the old name, so this alias can only ever be a safety net
  // and never a way for the old one to survive.
  window.JuiceLoader = window.ReportLoader;
})();
