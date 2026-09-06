/* pdf-fonts.spec.js — the server-side PDFs must have glyphs for the emoji they print.
 *
 * THE BUG THIS EXISTS FOR (2026-09-06, Dan, on Pawnee's rental schedule PDF):
 * "look at the last few columns, things aren't rendering properly" — the Forms,
 * Paid?, Permit and Rec-link columns rendered as tofu boxes. The Dockerfile
 * installed `fonts-liberation` and nothing else; that covers Latin text and has
 * ZERO emoji coverage, so Chromium had no glyph for any emoji and drew a box.
 *
 * IT IS INVISIBLE EVERYWHERE EXCEPT THE PDF. A developer's laptop, this sandbox
 * and GitHub's runners all ship an emoji font, so the page looks right in a
 * browser and in every render case. The Puppeteer PDFs are the one surface where
 * the CONTAINER's own fonts are what render — which is why no existing check
 * could see it, and why this spec builds its font environment from the
 * Dockerfile rather than trusting the machine it runs on.
 *
 * The behavioural half deliberately does NOT try to recognise tofu by shape.
 * It renders the real glyph set twice — once under the fonts the Dockerfile
 * installs, once under liberation alone — and requires the two to DIFFER. Drop
 * the emoji package from the Dockerfile and both renders are tofu, the images
 * match, and this fails. That is the only form of the assertion that cannot
 * pass on the broken build.
 */
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error("  ✗ " + msg); } }

const ROOT = path.join(__dirname, "..");
const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");

// ── 1. The Dockerfile must install a font with emoji coverage ───────────────
// Package names that actually carry emoji glyphs. `fonts-liberation` is
// deliberately NOT here: it was the whole bug.
const EMOJI_PACKAGES = ["fonts-noto-color-emoji", "fonts-emojione", "fonts-symbola", "fonts-twemoji"];
const installed = (dockerfile.match(/fonts-[a-z0-9-]+/g) || []);
ok(installed.length > 0, "the Dockerfile installs fonts at all");
const emojiPkg = installed.find(p => EMOJI_PACKAGES.includes(p));
ok(!!emojiPkg,
   "the Dockerfile installs a font with EMOJI coverage — fonts-liberation alone renders every emoji as a tofu box in the PDFs");

// ── 2. The glyphs are read from the SOURCE, not transcribed ────────────────
// A hardcoded list goes stale the first time a column gains an icon, and then
// the guard silently stops covering the thing that broke. These are the files
// whose markup reaches a Puppeteer PDF.
const PDF_SURFACES = [
  "public/facility.html",      // the rental schedule — where Dan hit it
  "public/programs.html",
  "public/directors-report.html",
  "lib/permit.js",             // the permit posting sheets
];
// Pictographic characters only: skip plain punctuation and the arrows/marks
// that Liberation does cover, so a match here really does need an emoji font.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const glyphs = new Set();
for (const f of PDF_SURFACES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const g of (fs.readFileSync(p, "utf8").match(EMOJI_RE) || [])) glyphs.add(g);
}
ok(glyphs.size > 0,
   "the PDF-rendered pages really do print emoji — otherwise the font assertion above is vacuous");

// ── 3. Behaviourally: those glyphs must render DIFFERENTLY with the emoji ───
//     font than without it. Skipped, never silently passed, when the pieces
//     are not here — a spec that reports success without having rendered is
//     the warm-cache sign-off this repo has a rule about.
const EMOJI_TTF = ["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
                   "/usr/share/fonts/truetype/noto/NotoColorEmoji-Regular.ttf"]
                   .find(p => fs.existsSync(p));
const LIB_DIR = "/usr/share/fonts/truetype/liberation";
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch {}

// THE MODULE BEING PRESENT IS NOT A BROWSER BEING PRESENT, and conflating the
// two is what broke CI: the `validate` job installs dependencies with
// PUPPETEER_SKIP_DOWNLOAD on purpose (the browser is ~150MB and server.js only
// requires puppeteer lazily, inside the PDF route), so require() succeeds and
// launch() then dies with "Could not find Chrome". This spec is meant to SKIP
// when it cannot render, not to throw.
function findBrowser() {
  for (const p of [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH,
                   "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
                   "/usr/bin/chromium", "/usr/bin/chromium-browser",
                   "/opt/pw-browsers/chromium"]) {
    if (p && fs.existsSync(p)) return p;
  }
  // puppeteer's own download, if the postinstall actually fetched one.
  try {
    const p = puppeteer && puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null;
}
const BROWSER = puppeteer ? findBrowser() : null;

(async () => {
  if (!puppeteer || !BROWSER || !EMOJI_TTF || !fs.existsSync(LIB_DIR)) {
    console.log("SKIP the render half — needs a browser, a Liberation dir and an emoji TTF on this machine."
      + (puppeteer && !BROWSER ? " (puppeteer is installed but no Chrome binary was found.)" : ""));
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdffonts-"));
    // "with" = the fonts the DOCKERFILE installs. "without" = the bug.
    const withDir = path.join(tmp, "with"), noDir = path.join(tmp, "no");
    fs.mkdirSync(withDir); fs.mkdirSync(noDir);
    for (const f of fs.readdirSync(LIB_DIR)) {
      fs.copyFileSync(path.join(LIB_DIR, f), path.join(withDir, f));
      fs.copyFileSync(path.join(LIB_DIR, f), path.join(noDir, f));
    }
    // The emoji font goes in ONLY if the Dockerfile asked for one. That is what
    // makes this discriminating rather than decorative: remove the package and
    // the two font sets become identical, so the two renders match and the
    // assertion below fails.
    if (emojiPkg) fs.copyFileSync(EMOJI_TTF, path.join(withDir, path.basename(EMOJI_TTF)));

    const conf = (dir, name) => {
      const p = path.join(tmp, name + ".conf");
      fs.writeFileSync(p, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">`
        + `<fontconfig><dir>${dir}</dir><cachedir>${path.join(tmp, "cache-" + name)}</cachedir></fontconfig>`);
      return p;
    };
    const html = `<html><body style="font:14px 'Liberation Sans',sans-serif">`
      + `<div>${[...glyphs].join(" ")}</div></body></html>`;
    fs.writeFileSync(path.join(tmp, "t.html"), html);

    const shot = path.join(tmp, "shot.js");
    fs.writeFileSync(shot, `
      const puppeteer = require(${JSON.stringify(require.resolve("puppeteer"))});
      (async () => {
        const b = await puppeteer.launch({ headless: true,
          executablePath: process.env.PDF_FONTS_BROWSER || undefined,
          args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
        const p = await b.newPage();
        await p.setContent(require('fs').readFileSync(process.argv[2],'utf8'), { waitUntil: 'load' });
        await p.screenshot({ path: process.argv[3], clip: { x:0, y:0, width: 900, height: 40 } });
        await b.close();
      })().catch(e => { console.error(e); process.exit(1); });`);

    const render = (cfg, out) => execFileSync(process.execPath,
      [shot, path.join(tmp, "t.html"), out],
      { env: { ...process.env, FONTCONFIG_FILE: cfg, PDF_FONTS_BROWSER: BROWSER }, stdio: "pipe" });

    const a = path.join(tmp, "with.png"), b = path.join(tmp, "no.png");
    try {
      render(conf(withDir, "with"), a);
      render(conf(noDir, "no"), b);
      const A = fs.readFileSync(a), B = fs.readFileSync(b);
      ok(!A.equals(B),
         "the glyphs render DIFFERENTLY with the Dockerfile's fonts than with Liberation alone "
         + "— identical means both are tofu, i.e. no emoji font is installed");
      // Sanity: the run without the font must really be the impoverished one.
      // Without this, a build that somehow rendered nothing at all in both
      // passes the assertion above for the wrong reason.
      ok(A.length > B.length,
         "...and the emoji render carries MORE image data than the tofu one");
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  if (failed) { console.error("\n" + failed + " assertion(s) FAILED."); process.exit(1); }
  console.log(passed + " assertions passed. (" + glyphs.size + " distinct emoji across the PDF surfaces"
    + (emojiPkg ? ", font: " + emojiPkg : "") + ")");
})().catch(e => { console.error(e); process.exit(1); });
