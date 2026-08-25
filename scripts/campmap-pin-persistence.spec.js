// Spec for the campmap's saved pin layout — that a failed load can never become
// a published layout of seed defaults.
//
// THE BUG (reproduced 2026-08-25, reported by Dan: "a few times I'd seen the map
// pins reset and then I had to save them on the admin side. Strange.")
//
// loadPositions() mapped a failed response to `{positions:{}}`:
//
//     .then(function(r){ return r.ok ? r.json() : {positions:{}}; })
//
// which is byte-identical to "this org has never placed a pin". So one transient
// failure — a deploy restart, a 502, a dropped connection — rendered all 41
// Topaz pins on their seed coordinates with nothing on screen to say so. Against
// a stored 41-pin layout, forcing that GET to 500 put site 01 back on its seed
// coordinate, `placed:false`, and threw no console error.
//
// THE DESTRUCTIVE PART WAS THE RECOVERY, which is why this is data loss and not
// a display glitch. saveLayout() publishes EVERY site in SEED, so an admin who
// saw the "reset", dragged one pin and hit Save wrote 41 pins of which 40 were
// seed defaults, over the real layout. Measured: 40 of 41. The glitch was
// transient; re-saving is what made it permanent — and re-saving is exactly what
// the glitch invites. loadMarkers() had the same shape, so the same blip wiped
// every admin-placed marker on the next save.
//
// WHAT THIS PINS:
//
// 1. A LOAD FAILURE MUST NOT LOOK LIKE AN EMPTY STORE. Neither loader may map a
//    non-ok response onto an empty result.
// 2. PUBLISHING IS REFUSED UNTIL THE STORE HAS ANSWERED — gated at the button
//    AND inside saveLayout(), because a stale handler must not get through
//    either. An empty answer from a store that *answered* is legitimate: a new
//    org has to be able to place its pins.
// 3. A SINGLE BLIP SELF-HEALS. One retry, so a restart mid-request does not lock
//    an admin out of editing until they reload.
// 4. THE VIEWER STILL GETS A MAP. Degrading to seed coordinates is right for a
//    public camper-facing page; what must not happen is writing them back.
//
// Run: node scripts/campmap-pin-persistence.spec.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "public", "campmap.html"), "utf8");
const ORG = "douglas-county-nv";
const PORT = 4970 + (process.pid % 500);

let passed = 0;
const sourceTests = [];
// Collected, not run inline: they must report through stop() like the browser
// half, and SKIP_SOURCE=1 must be able to take them out so the behavioural half
// can be shown to catch the bug on its own — a regex over my own patch is not
// evidence that the page behaves.
function test(name, fn) { sourceTests.push([name, fn]); }
function runSourceTests() {
  if (process.env.SKIP_SOURCE === "1") { console.log("  (source checks skipped)"); return; }
  for (const [name, fn] of sourceTests) { fn(); console.log(`  ✓ ${name}`); passed++; }
}

// ── the source half: the invariant, stated where it cannot drift ────────────
function slice(fnName) {
  const i = SRC.indexOf("function " + fnName + "(");
  assert.ok(i > 0, `${fnName} not found — did campmap.html move?`);
  // Functions here are top-level and closed by a column-0 brace.
  const end = SRC.indexOf("\n}", i);
  return SRC.slice(i, end);
}

test("neither loader treats a failed response as an empty store", () => {
  for (const fn of ["loadPositions", "loadMarkers"]) {
    const body = slice(fn);
    assert.ok(!/r\.ok\s*\?\s*r\.json\(\)\s*:\s*\{/.test(body),
      `${fn} maps a failed response onto an empty result — that is the bug: a blip `
      + `becomes "nothing was ever saved", and the next save publishes defaults`);
    assert.ok(/if\s*\(\s*!r\.ok\s*\)\s*throw/.test(body),
      `${fn} must throw on a non-ok response so the catch can mark the load failed`);
  }
});

test("both stores must answer before a save is allowed", () => {
  assert.ok(/if\(!POS_OK \|\| !MK_OK\)/.test(slice("refreshDirty")),
    "the Save button is not gated on the load having succeeded");
  assert.ok(/if\(!POS_OK \|\| !MK_OK\)/.test(slice("saveLayout")),
    "saveLayout itself must refuse — the button is one way in, not the only one");
});

test("a store that answers empty is still editable", () => {
  // The gate keys on POS_OK/MK_OK, never on how many pins came back. A new org
  // with no saved layout must be able to place one.
  const lp = slice("loadPositions");
  assert.ok(/POS_OK=true/.test(lp), "a successful load must set the flag");
  assert.ok(!/Object\.keys\(pos\)\.length/.test(lp),
    "gating on the NUMBER of saved pins would lock a new org out of placing any");
});

test("one retry, so a restart mid-request does not lock editing", () => {
  for (const fn of ["loadPositions", "loadMarkers"]) {
    assert.ok(new RegExp("if\\(!attempt\\)\\{ setTimeout\\(function\\(\\)\\{ " + fn + "\\(1\\)").test(slice(fn)),
      `${fn} must retry once before giving up`);
  }
});

// ── the behavioural half: drive a real browser three ways ───────────────────
// Reuses ci-check-render's vendored CDN cache, so this never leaves the machine.
// A page that cannot load React/Leaflet renders nothing, which would pass a
// "did it throw" test and prove nothing — so a cache miss is a failure here.
const VENDOR_DIR = path.join(ROOT, "node_modules", ".cache", "render-check");
const vendorPath = u => path.join(VENDOR_DIR, u.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "_"));
function vendorFetch(url) {
  const dest = vendorPath(url);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const r = spawnSync("curl", ["-sSfL", "--max-time", "60", "-o", dest + ".part", url], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(dest + ".part") || fs.statSync(dest + ".part").size === 0) {
    try { fs.rmSync(dest + ".part", { force: true }); } catch (_) {}
    return null;
  }
  fs.renameSync(dest + ".part", dest);
  return dest;
}

const CTYPE = { js: "application/javascript", css: "text/css", json: "application/json" };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "campmap-pins-"));

// A stored layout that cannot be confused with the seed: every pin +0.01.
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, "campmap-seeds.json"), "utf8"));
const seedSites = (seeds[ORG] || {}).sites || [];
assert.ok(seedSites.length > 1, `${ORG} seed has no sites — pick another org`);
const stored = {};
seedSites.forEach(s => { stored[s.id] = { lat: +(s.lat + 0.01).toFixed(7), lng: +(s.lng + 0.01).toFixed(7) }; });
fs.writeFileSync(path.join(dataDir, "campmap_positions.json"), JSON.stringify({ [ORG]: stored }, null, 1));

// The org token, read out of server.js — the editor is token-gated.
const TOKEN = (() => {
  const s = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const i = s.indexOf(`"${ORG}"`);
  const m = /token:\s*"([^"]+)"/.exec(s.slice(i, i + 400));
  return m ? m[1] : "";
})();
assert.ok(TOKEN, `could not resolve the ${ORG} token from server.js`);

const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
         METABASE_URL: "http://127.0.0.1:9", RESEND_API_KEY: "",
         SLACK_WEBHOOK_URL: "", DASHBOARD_PASSWORD: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", d => { log += d; });
child.stderr.on("data", d => { log += d; });

function stop(ok, msg) {
  try { child.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  if (!ok) {
    console.error("\n✗ " + msg);
    if (log) console.error(log.split("\n").slice(-12).join("\n"));
    process.exit(1);
  }
  console.log(`\n${passed}/${passed} passing`);
  process.exit(0);
}

// mode: "ok" | "fail" (every GET 500s) | "blip" (the first GET 500s)
async function drive(puppeteer, chrome, mode) {
  const browser = await puppeteer.launch({ headless: true, executablePath: chrome,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 820 });
    const errs = [];
    let posted = null, gets = 0, missing = null;
    page.on("pageerror", e => errs.push(String(e.message).slice(0, 140)));
    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url();
      if (/campmap\/api\/positions/.test(u) && req.method() === "GET") {
        gets++;
        if (mode === "fail" || (mode === "blip" && gets === 1)) {
          return req.respond({ status: 500, contentType: "text/plain", body: "boom" });
        }
      }
      // Capture what a save WOULD publish, without letting it land.
      if (/campmap\/api\/(positions|markers)/.test(u) && req.method() === "POST") {
        if (/positions/.test(u)) { try { posted = JSON.parse(req.postData() || "{}"); } catch (_) {} }
        return req.respond({ status: 200, contentType: "application/json", body: '{"ok":true,"saved":0}' });
      }
      if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
      const ext = (u.split("?")[0].match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
      if (!/^(js|css|json)$/.test(ext)) {
        return req.respond({ status: 200, contentType: "text/plain",
          headers: { "access-control-allow-origin": "*" }, body: "" });
      }
      const f = vendorFetch(u);
      if (!f) { missing = u; return req.respond({ status: 502, contentType: "text/plain", body: "" }); }
      return req.respond({ status: 200, contentType: CTYPE[ext],
        headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(f) });
    });

    await page.goto(`http://127.0.0.1:${PORT}/${ORG}/campmap?token=${encodeURIComponent(TOKEN)}`,
                    { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("#editBtn", { timeout: 60000 });
    // Long enough to cover the 1.5s retry plus its round trip.
    await new Promise(r => setTimeout(r, 6000));
    if (missing) throw new Error("vendored asset missing (" + missing + ") — this check proves nothing without it");

    const before = await page.evaluate(() => {
      const s = window.SEED[0];
      return { lat: +s.lat.toFixed(5), placed: !!s.placed,
               def: +window.DEFAULT_COORDS[s.id].lat.toFixed(5),
               msg: (document.getElementById("editMsg") || {}).textContent || "" };
    });

    // Behave like an admin who sees "reset" pins: nudge one, then Save.
    await page.evaluate(() => {
      window.setEditMode(true);
      window.SEED[5].lat += 0.0002;
      window.refreshDirty();
      window.saveLayout();
    });
    await new Promise(r => setTimeout(r, 2000));

    let atDefault = null, wrote = 0;
    if (posted && posted.positions) {
      wrote = Object.keys(posted.positions).length;
      atDefault = await page.evaluate(pj => {
        const pos = JSON.parse(pj); let n = 0;
        window.SEED.forEach(s => {
          const d = window.DEFAULT_COORDS[s.id], q = pos[s.id];
          if (d && q && Math.abs(d.lat - q.lat) < 1e-6 && Math.abs(d.lng - q.lng) < 1e-6) n++;
        });
        return n;
      }, JSON.stringify(posted.positions));
    }
    const saveDisabled = await page.evaluate(() =>
      !!(document.getElementById("editSave") || {}).disabled);
    return { ...before, gets, saved: !!posted, wrote, atDefault, saveDisabled, errs };
  } finally {
    await browser.close();
  }
}

(async () => {
  // Wait for the port.
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 90000) return stop(false, "server did not start");
    try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; }
    catch (_) { await new Promise(r => setTimeout(r, 500)); }
  }

  try { runSourceTests(); } catch (e) { return stop(false, e.message); }

  let puppeteer;
  try { puppeteer = require(path.join(ROOT, "node_modules", "puppeteer")); }
  catch (_) { return stop(false, "puppeteer not installed — run npm install"); }
  const chrome = (() => {
    const ok = p => p && fs.existsSync(p);
    if (ok(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    for (const c of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
                     "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium"]) {
      if (ok(c)) return c;
    }
    try { const b = puppeteer.executablePath(); if (ok(b)) return b; } catch (_) {}
    return null;
  })();
  if (!chrome) return stop(false, "no browser — set CHROME_PATH or: npx puppeteer browsers install chrome");

  try {
    // A · the store answers. Nothing about the happy path may change.
    const a = await drive(puppeteer, chrome, "ok");
    assert.deepStrictEqual(a.errs, [], "healthy load threw: " + a.errs.join(" | "));
    assert.notStrictEqual(a.lat, a.def, "the stored layout was not applied");
    assert.strictEqual(a.placed, true, "a loaded pin should be marked placed");
    console.log("  ✓ a healthy load applies the stored layout"); passed++;

    assert.strictEqual(a.saved, true, "an admin edit should still publish");
    assert.strictEqual(a.wrote, seedSites.length, "a save publishes every site");
    assert.strictEqual(a.atDefault, 0,
      `a healthy save wrote ${a.atDefault} pins at seed defaults — it must write the stored layout`);
    console.log("  ✓ and a save publishes the real layout, not defaults"); passed++;

    // B · the store never answers. This is the incident.
    const b = await drive(puppeteer, chrome, "fail");
    assert.deepStrictEqual(b.errs, [], "the failure path threw: " + b.errs.join(" | "));
    assert.strictEqual(b.lat, b.def,
      "with no answer the map should still render on seed coordinates — a camper gets a map");
    console.log("  ✓ a failed load still renders the map for a viewer"); passed++;

    assert.strictEqual(b.saved, false,
      `a save was published after a failed load — it would have written ${b.wrote} pins, `
      + `${b.atDefault} of them seed defaults, over the real layout`);
    assert.strictEqual(b.saveDisabled, true, "the Save button must be disabled after a failed load");
    console.log("  ✓ but publishing is refused, so it cannot overwrite the layout"); passed++;

    assert.ok(/could not be loaded/i.test(b.msg),
      "the edit bar must say the layout could not be loaded; it read: " + JSON.stringify(b.msg));
    assert.ok(/defaults/i.test(b.msg),
      "and must say these pins are defaults — otherwise the admin re-places 41 pins by hand");
    console.log("  ✓ and the edit bar says why, naming defaults"); passed++;

    // C · one blip. A restart mid-request must not cost an admin their session.
    const c = await drive(puppeteer, chrome, "blip");
    assert.strictEqual(c.gets, 2, `expected one retry, saw ${c.gets} GET(s)`);
    assert.strictEqual(c.lat, a.lat, "the retry should recover the stored layout");
    assert.strictEqual(c.saved, true, "editing should work again after a successful retry");
    assert.strictEqual(c.atDefault, 0, "and the recovered save must not contain defaults");
    console.log("  ✓ a single blip self-heals on retry, editing intact"); passed++;

    stop(true);
  } catch (e) {
    stop(false, e.message);
  }
})();
