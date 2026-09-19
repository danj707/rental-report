#!/usr/bin/env node
"use strict";

/* ── Live weather on the org dashboard ─────────────────────────────────────
   LIFTS AND RUNS lib/weather.js rather than regexing it: every defect this
   feature can have is a comparison — a WMO range read the wrong way round, a
   staleness test inverted, a null treated as a zero — and a regex passes on an
   inverted comparison just as happily as on a correct one.

   The half that cannot be run is asserted from source, scoped to the function
   that has to do the asking: a file-wide match passes when some other caller
   happens to contain the same words.

   IT RE-EXECS UNDER A ZONE BEHIND UTC. `new Date("2026-09-19")` is UTC
   midnight, so west of UTC it is the 18th — and this sandbox and GitHub
   Actions both run UTC, where the broken derivation passes every assertion.
   `America/Los_Angeles` is chosen for that property, not because an org is in
   it. (The ePACT spec picks a zone AHEAD of UTC for the opposite reason: it
   parses MM/DD/YYYY, which is LOCAL midnight. Different string, other
   direction.)
   ───────────────────────────────────────────────────────────────────────── */

const path = require("path");
const fs = require("fs");

if (!process.env.WX_SPEC_TZ_REEXEC) {
  const r = require("child_process").spawnSync(
    process.execPath, [__filename],
    { stdio: "inherit", env: { ...process.env, TZ: "America/Los_Angeles", WX_SPEC_TZ_REEXEC: "1" } });
  process.exit(r.status === null ? 1 : r.status);
}

const W = require(path.join(__dirname, "..", "lib", "weather.js"));
const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const ORGHTML = fs.readFileSync(path.join(__dirname, "..", "public", "org.html"), "utf8");

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failures.push(msg);
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
// A throw at CALL time must fail by name rather than killing the run.
function guard(fn, msg) {
  try { return fn(); } catch (err) { failures.push(`${msg} — THREW ${err.message}`); return undefined; }
}

/* ── The timezone pin is only worth having if it can discriminate ───────── */
ok(/^America\/Los_Angeles$/.test(process.env.TZ || ""),
  "the spec must run under a zone behind UTC, or the date derivation is untested");
eq(new Date("2026-09-19").getDay(), 5,
  "sanity: under this zone a bare ISO date parses to the PREVIOUS day — if this is 6 the pin no longer discriminates");

/* ── skyFor: the WMO ranges ─────────────────────────────────────────────── */
eq(W.skyFor(0), "clear", "code 0 is clear");
eq(W.skyFor(1), "clear", "code 1 is mainly clear");
eq(W.skyFor(2), "cloudy", "code 2 is partly cloudy");
eq(W.skyFor(3), "overcast", "code 3 is overcast");
eq(W.skyFor(45), "fog", "code 45 is fog");
eq(W.skyFor(48), "fog", "code 48 is rime fog");
[51, 53, 55, 56, 57].forEach(c => eq(W.skyFor(c), "drizzle", `code ${c} is drizzle`));
[61, 63, 65, 66, 67].forEach(c => eq(W.skyFor(c), "rain", `code ${c} is rain`));
[80, 81, 82].forEach(c => eq(W.skyFor(c), "rain", `code ${c} is a rain shower`));
[71, 73, 75, 77].forEach(c => eq(W.skyFor(c), "snow", `code ${c} is snow`));
[85, 86].forEach(c => eq(W.skyFor(c), "snow", `code ${c} is a snow shower`));
[95, 96, 99].forEach(c => eq(W.skyFor(c), "storm", `code ${c} is a thunderstorm`));

/* THE RULE THAT IS NOT COSMETIC. A code we do not recognise must never paint
   sunshine — the treatment would then be claiming weather it cannot vouch for,
   which is the load-versus-empty mistake this repo already has a rule for. */
[999, -1, 4, 50, 70, 100, null, undefined, "", "abc", NaN].forEach(c => {
  ok(W.skyFor(c) !== "clear", `an unreadable code (${JSON.stringify(c)}) must not read as CLEAR`);
});
eq(W.skyFor(999), "overcast", "an unknown code falls to overcast, which claims nothing");
eq(W.skyFor(undefined), "overcast", "a missing code falls to overcast");

ok(W.WX_SKIES.length === 8, "eight skies");
ok(!W.WX_SKIES.includes("night"), "NIGHT IS NOT A SKY — it is a modifier, or a wet night silently stops raining");
W.WX_SKIES.forEach(s => ok(typeof s === "string" && /^[a-z]+$/.test(s), `sky ${s} is a bare class-safe name`));

/* ── labels ─────────────────────────────────────────────────────────────── */
eq(W.labelFor(0), "Clear", "code 0 reads Clear");
eq(W.labelFor(61), "Light rain", "code 61 reads Light rain");
ok(W.labelFor(999) !== "Clear", "an unknown code must not be LABELLED Clear either");
ok(typeof W.labelFor(999) === "string" && W.labelFor(999).length > 0, "an unknown code still gets a word");

/* ── isWet: what the look-ahead line acts on ────────────────────────────── */
["drizzle", "rain", "snow", "storm"].forEach(s => ok(W.isWet(s), `${s} is wet`));
["clear", "cloudy", "overcast", "fog"].forEach(s => ok(!W.isWet(s), `${s} is not wet`));

/* ── dates and clocks, built from PARTS ─────────────────────────────────── */
eq(W.weekdayOf("2026-09-19"), "Saturday", "2026-09-19 is a Saturday — a UTC-midnight parse says Friday here");
eq(W.weekdayOf("2026-09-20"), "Sunday", "2026-09-20 is a Sunday");
eq(W.weekdayOf("2026-01-22"), "Thursday", "2026-01-22 is a Thursday");
eq(W.weekdayOf(""), "", "no date, no weekday");
eq(W.weekdayOf(null), "", "a null date yields no weekday rather than throwing");
eq(W.clockOf("2026-09-19T18:47"), "6:47 PM", "18:47 is 6:47 PM");
eq(W.clockOf("2026-09-19T06:28"), "6:28 AM", "06:28 is 6:28 AM");
eq(W.clockOf("2026-09-19T00:15"), "12:15 AM", "midnight is 12, not 0");
eq(W.clockOf("2026-09-19T12:00"), "12:00 PM", "noon is 12 PM, not 12 AM");
eq(W.clockOf(""), "", "no stamp, no clock");

/* ── the look-ahead line ────────────────────────────────────────────────── */
const dailyDry = { time: ["2026-09-19", "2026-09-20", "2026-09-21"], weather_code: [0, 1, 3], precipitation_probability_max: [0, 5, 10] };
const dailyWetTomorrow = { time: ["2026-09-19", "2026-09-20", "2026-09-21"], weather_code: [3, 61, 61], precipitation_probability_max: [0, 90, 82] };
const dailyWetToday = { time: ["2026-09-19", "2026-09-20"], weather_code: [61, 0], precipitation_probability_max: [85, 0] };
const dailySnow = { time: ["2026-01-22", "2026-01-23"], weather_code: [3, 73], precipitation_probability_max: [10, 80] };
const dailyThin = { time: ["2026-09-19", "2026-09-20"], weather_code: [3, 61], precipitation_probability_max: [0, 40] };

eq(W.aheadFrom(dailyDry), null, "a dry week says nothing rather than printing a 0%");
eq(W.aheadFrom(dailyWetTomorrow), "Rain arrives Sunday — 90%", "the next wet day is named, with its own chance");
eq(W.aheadFrom(dailyWetToday), "Rain likely today — 85%", "a wet TODAY is said plainly rather than pointing at tomorrow");
eq(W.aheadFrom(dailySnow), "Snow arrives Friday — 80%", "snow is called snow, not rain");
eq(W.aheadFrom(dailyThin), null, `below the ${W.WX_AHEAD_MIN_PROB}% floor the line is withheld`);
eq(W.aheadFrom(null), null, "no daily block, no look-ahead");
eq(W.aheadFrom({ time: ["2026-09-19", "2026-09-20"], weather_code: [3, 61] }), null,
  "a wet day with NO probability is withheld — the line's whole value is the number on it");
ok(W.WX_AHEAD_MIN_PROB >= 40 && W.WX_AHEAD_MIN_PROB <= 70,
  "the look-ahead floor is a judgement, but a 10% chance is not a forecast worth acting on");

/* ── the readout ────────────────────────────────────────────────────────── */
const rawDay = {
  current: { time: "2026-09-19T08:15", temperature_2m: 53.8, apparent_temperature: 49.4, is_day: 1, weather_code: 0, wind_speed_10m: 7.0 },
  daily: Object.assign({ sunrise: ["2026-09-19T06:28", "2026-09-20T06:30"], sunset: ["2026-09-19T18:47", "2026-09-20T18:45"], temperature_2m_max: [64.0, 60.3], temperature_2m_min: [50.6, 47.4] }, dailyWetTomorrow),
};
const day = guard(() => W.readoutFrom(rawDay), "readoutFrom(day)") || {};
eq(day.sky, "clear", "a clear reading paints a clear sky");
eq(day.night, false, "is_day 1 is not night");
eq(day.temp, 54, "53.8 rounds to 54");
eq(day.feels, 49, "49.4 rounds to 49");
eq(day.hi, 64, "today's high comes from daily[0]");
eq(day.lo, 51, "today's low comes from daily[0]");
eq(day.wind, "7 mph", "the wind carries its unit");
eq(day.sunLabel, "Sunset 6:47 PM", "by day the useful clock is the sunset");
eq(day.day, "Saturday", "the readout names its own day");
eq(day.ahead, "Rain arrives Sunday — 90%", "the look-ahead rides on the readout");
eq(day.label, "Clear", "the label comes from the code");

const rawNight = JSON.parse(JSON.stringify(rawDay));
rawNight.current.is_day = 0;
rawNight.current.temperature_2m = 50.6;
const night = guard(() => W.readoutFrom(rawNight), "readoutFrom(night)") || {};
eq(night.night, true, "is_day 0 is night");
eq(night.sunLabel, "Sunrise 6:30 AM", "after dark the next sunrise is TOMORROW'S — today's has been and gone");

const rawOneDay = JSON.parse(JSON.stringify(rawDay));
rawOneDay.current.is_day = 0;
rawOneDay.daily.sunrise = ["2026-09-19T06:28"];
eq((guard(() => W.readoutFrom(rawOneDay), "readoutFrom(one day)") || {}).sunLabel, "Sunrise 6:28 AM",
  "with only one day on file the night falls back to that day's sunrise rather than printing nothing");

eq(W.readoutFrom(null), null, "no payload, no readout");
eq(W.readoutFrom({}), null, "no current block, no readout");
eq(W.readoutFrom({ current: { weather_code: 0 } }), null,
  "NO TEMPERATURE, NO CARD — it is the one field with no honest fallback");
const noWind = JSON.parse(JSON.stringify(rawDay));
delete noWind.current.wind_speed_10m;
eq((guard(() => W.readoutFrom(noWind), "readoutFrom(no wind)") || {}).wind, null,
  "a missing wind is null, never the string NaN mph");
const noDaily = { current: rawDay.current };
const bare = guard(() => W.readoutFrom(noDaily), "readoutFrom(no daily)") || {};
eq(bare.temp, 54, "a reading with no daily block still carries its temperature");
eq(bare.hi, null, "...and nulls the figures it cannot support");
eq(bare.ahead, null, "...and says nothing about tomorrow");

/* ── staleness ──────────────────────────────────────────────────────────── */
const now = 1_758_000_000_000;
eq(W.ageStateOf({ ts: now }, now), "fresh", "a reading taken now is fresh");
eq(W.ageStateOf({ ts: now - 60_000 }, now), "fresh", "a minute old is still fresh");
eq(W.ageStateOf({ ts: now - 30 * 60_000 }, now), "stale", "half an hour old is stale — serve it, refresh behind the reader");
eq(W.ageStateOf({ ts: now - 5 * 3600_000 }, now), "expired",
  "FIVE HOURS OLD IS NOT SERVED: an org nobody opened for a week must not be shown last Tuesday's snow");
eq(W.ageStateOf(undefined, now), "expired", "no entry is expired, never fresh");
eq(W.ageStateOf({}, now), "expired", "an entry with no timestamp is expired");
eq(W.ageStateOf({ ts: now + 3600_000 }, now), "expired", "a reading from the future is a broken clock, not a fresh reading");
ok(W.WX_FRESH_MS < W.WX_STALE_MS, "the fresh window sits inside the stale one");
ok(W.WX_STALE_MS <= 6 * 3600_000, "the stale window is hours, not days");

/* ── coordinates are the gate ───────────────────────────────────────────── */
eq(JSON.stringify(W.coordsOf({ coords: { lat: 42.3709, lon: -71.1828 } })), JSON.stringify({ lat: 42.3709, lon: -71.1828 }), "real coordinates resolve");
eq(W.coordsOf({}), null, "an org with no coords gets NO weather — never a guess from its name");
eq(W.coordsOf(null), null, "a missing org is not a crash");
eq(W.coordsOf({ coords: {} }), null, "an empty coords block is not coordinates");
eq(W.coordsOf({ coords: { lat: "x", lon: 1 } }), null, "an unreadable latitude is refused");
eq(W.coordsOf({ coords: { lat: 91, lon: 0 } }), null, "a latitude past the pole is refused");
eq(W.coordsOf({ coords: { lat: 0, lon: 181 } }), null, "a longitude past the meridian is refused");
eq(JSON.stringify(W.coordsOf({ coords: { lat: 0, lon: 0 } })), JSON.stringify({ lat: 0, lon: 0 }), "zero is a real coordinate, not a missing one");

/* ── the request ────────────────────────────────────────────────────────── */
const url = W.requestUrlFor({ lat: 42.37, lon: -71.18 });
ok(/timezone=auto/.test(url),
  "TIMEZONE=AUTO IS LOAD-BEARING: without it is_day and every daily boundary are computed in the wrong zone");
ok(/is_day/.test(url) && /weather_code/.test(url), "the current block asks for the two fields the sky is chosen from");
["sunrise", "sunset", "precipitation_probability_max", "temperature_2m_max", "temperature_2m_min"].forEach(f =>
  ok(url.includes(f), `the daily block asks for ${f}`));
ok(/temperature_unit=fahrenheit/.test(url) && /wind_speed_unit=mph/.test(url), "US orgs, US units");
ok(/^https:\/\/api\.open-meteo\.com\//.test(url), "over https, to the documented host");

/* ── server wiring ──────────────────────────────────────────────────────── */
function sliceIn(text, from, to, label) {
  const i = text.indexOf(from);
  const j = i < 0 ? -1 : text.indexOf(to, i + from.length);
  const s = i < 0 || j < 0 ? "" : text.slice(i, j);
  ok(s.length > 0, `${label} — the slice is empty, so every assertion under it would be vacuous`);
  return s;
}
const slice = (from, to, label) => sliceIn(SERVER, from, to, label);

const fnFor = slice("function orgWeatherFor(", "\napp.get(\"/:org\"", "orgWeatherFor");
ok(/getFlags\(\)\.orgWeather/.test(fnFor), "orgWeatherFor is gated on the orgWeather flag — the kill switch has to work without a deploy");
ok(/coordsOf\(ORGS\[slug\]\)/.test(fnFor), "orgWeatherFor refuses an org with no coordinates");
ok(/ageStateOf/.test(fnFor), "orgWeatherFor asks how old the reading is");
ok(/"expired"\s*\?\s*null/.test(fnFor), "an EXPIRED reading yields null — it must not be served");
ok(/!==\s*"fresh"/.test(fnFor) && /refreshOrgWeather\(slug\)/.test(fnFor), "anything but fresh kicks a refresh behind the reader");
ok(!/await\s+refreshOrgWeather/.test(fnFor),
  "THE FRONT DOOR MUST NOT BLOCK ON A THIRD PARTY: the refresh is fire-and-forget, never awaited");
ok(/^function orgWeatherFor/m.test(SERVER),
  "orgWeatherFor is synchronous — an async one would have to be awaited in the route, which is the same blocking bug by another door");

const fnRefresh = slice("async function refreshOrgWeather(", "function orgWeatherFor(", "refreshOrgWeather");
ok(/if\s*\(readout\)\s*_wxCache\.set/.test(fnRefresh),
  "a reading we could not parse must NOT overwrite one we could — the last good answer keeps serving and ages out on its own");
ok(/AbortSignal\.timeout\(WX_TIMEOUT_MS\)/.test(fnRefresh), "the fetch is bounded");
ok(/_wxInFlight/.test(fnRefresh), "a refresh already running is not started twice");
ok(/catch\s*\(err\)/.test(fnRefresh), "a failed feed is caught, never thrown into a page render");

const fnFixture = slice("function weatherFixtureFor(", "async function refreshOrgWeather(", "weatherFixtureFor");
ok(/if\s*\(!process\.env\.WEATHER_FIXTURE\)\s*return null/.test(fnFixture),
  "THE TEST SEAM IS ENV-GATED: without WEATHER_FIXTURE the query parameter does not exist, so there is no production path to it");
ok(/WX_SKIES\.includes\(want\)/.test(fnFixture), "the fixture only answers to a known sky");
ok(/if \(process\.env\.WEATHER_FIXTURE\) return null;/.test(fnFor),
  "WITH THE SEAM OPEN THE REAL PATH IS CLOSED: the harness never reaches a third party, and its no-weather case cannot depend on whether an earlier case warmed the cache");

ok(/weather:\s*orgWeatherFor\(slug,\s*req\)/.test(SERVER),
  "the org landing config carries the reading — injected, so the sky is there on first paint");
ok(/^\s*orgWeather:\s*true,\s*$/m.test(SERVER), "orgWeather defaults ON; Dan approved the design and asked for it merged");
ok(/updateFlagUI\('orgweather',\s*flags\.orgWeather\)/.test(SERVER),
  "the admin toggle is DRIVEN by applyFlags — a flag that block never drives renders permanently off");
ok(/toggleFlag\('orgWeather'/.test(SERVER), "...and the switch posts the right key");
ok(/orgweather:\s*\['ON —/.test(SERVER), "the toggle says what it does in words");

/* ── the page ───────────────────────────────────────────────────────────── */
const iife = sliceIn(ORGHTML, "(function orgWeather()", "/* Render cards */", "org.html weather block");
ok(/SKIES\.indexOf\(w\.sky\)\s*<\s*0/.test(iife) || /SKIES\.includes\(w\.sky\)/.test(iife),
  "the sky is whitelisted before it becomes a class name, never interpolated blind");
ok(/if \(!w \|\|[\s\S]{0,160}?\) return;/.test(iife)
   && iife.indexOf("if (!w ") >= 0
   && iife.indexOf("if (!w ") < iife.indexOf("classList.add"),
  "NO READING, NO WEATHER: the block returns BEFORE it touches the body");
ok(/classList\.add\('has-wx'/.test(iife), "a reading adds the has-wx class the CSS hangs off");
ok(/w\.night[\s\S]{0,80}classList\.add\('wx-night'\)/.test(iife),
  "night is added SEPARATELY from the sky — a wet night must keep raining");
ok(/w\.temp === null \|\| w\.temp === undefined/.test(iife), "a reading with no temperature renders nothing");
ok(/w\.feels === null \|\| w\.feels === undefined/.test(iife), "an absent feels-like is dropped, not printed empty");
ok(/if \(w\.wind\)/.test(iife) && /if \(w\.sunLabel\)/.test(iife) && /if \(w\.ahead\)/.test(iife),
  "every optional field is dropped when missing rather than rendered blank");
ok(/escChip\(/.test(iife), "the card reuses the page's ONE escape helper");
ok(!/function esc\w*\(/.test(iife), "...and does not grow a third copy of it");
ok(/aria-hidden/.test(iife), "the sky is decoration and is hidden from a screen reader");

ok(/\.wx-layer\s*\{[^}]*pointer-events:\s*none/.test(ORGHTML),
  "the sky NEVER eats a click — it covers the whole viewport");
ok(/\.wx-layer\s*\{[^}]*position:\s*fixed/.test(ORGHTML), "the sky is behind the whole page, not inside one card");
ok(/body\.has-wx\s*>\s*\*:not\(\.wx-layer\)\s*\{[^}]*z-index:\s*1/.test(ORGHTML),
  "...and every other child is lifted above it, or the page renders behind its own sky");
ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}\.wx-fx[\s\S]{0,60}animation:\s*none/.test(ORGHTML),
  "rain and snow hold still under prefers-reduced-motion; the sky stays");
W.WX_SKIES.forEach(s => ok(new RegExp("\\.wx-" + s + "\\s").test(ORGHTML), `the page styles the ${s} sky`));
ok(/body\.wx-night \.card \{[^}]*background/.test(ORGHTML), "night repaints the report cards, not only the sky");
ok(/body\.wx-night \.card-label \{[^}]*color/.test(ORGHTML), "...and their ink, or the text goes dark on dark");
ok(/body\.wx-night \.wx-sky \{/.test(ORGHTML), "night overrides the sky gradient");
ok(!/\.wx-night \.wx-fx\s*\{[^}]*animation:\s*none/.test(ORGHTML),
  "NIGHT MUST NOT STOP THE PARTICLES — that is the single-night-sky bug wearing a different hat");

const cases = fs.readFileSync(path.join(__dirname, "ci-check-render.js"), "utf8");
ok(/WEATHER_FIXTURE: "1"/.test(cases), "the render harness opens the fixture seam");
["no reading, no weather", "rain paints the whole page", "night goes properly dark", "a wet night still rains"]
  .forEach(n => ok(cases.includes(n), `render case present: ${n}`));

if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n` + failures.map(f => "  ✗ " + f).join("\n") + "\n");
  console.log(`${passed} assertions passed, ${failures.length} failed.`);
  process.exit(1);
}
console.log(`${passed} assertions passed.`);
