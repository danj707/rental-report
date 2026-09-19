"use strict";

/* ── Current conditions for an org's own dashboard ─────────────────────────
   PURE: no Express, no fetch, no fs. Everything that decides what the page
   paints lives here so `scripts/org-weather.spec.js` can LIFT AND RUN it —
   every defect this can have is a comparison (a code range read the wrong way
   round, a staleness test inverted), and a regex passes on an inverted
   comparison.

   THE ONE RULE THAT IS NOT COSMETIC: an unknown code is never CLEAR. A
   treatment that invents sunshine it cannot vouch for is the load-versus-empty
   mistake this repo already has a rule for (`hasAbsent`, `POS_OK`) — so an
   unrecognised code falls to `overcast`, which claims nothing, and a reading
   we could not parse at all yields NO weather rather than a default one.
   ───────────────────────────────────────────────────────────────────────── */

// The skies the page can paint. NIGHT IS NOT ONE OF THEM — it is a modifier,
// so rain at 9pm still rains. A single `night` sky would silently drop the
// condition, which is the half the first mockup got wrong.
const WX_SKIES = ["clear", "cloudy", "overcast", "fog", "drizzle", "rain", "snow", "storm"];

/* NULL IS NOT ZERO, and the language disagrees: `Number(null)`, `Number("")`
   and `Number(false)` are all 0. Left to coerce on its own, a MISSING weather
   code reads as code 0 — clear — and the page paints sunshine it has no
   reading for, which is the one thing the rule at the top of this file
   forbids. A missing latitude lands the org in the Gulf of Guinea by the same
   route. Every number here is taken through this. */
function strictNum(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// WMO 4677, as Open-Meteo emits it.
function skyFor(code) {
  const c = strictNum(code);
  if (c === null) return "overcast";
  if (c === 0 || c === 1) return "clear";
  if (c === 2) return "cloudy";
  if (c === 3) return "overcast";
  if (c === 45 || c === 48) return "fog";
  if (c >= 51 && c <= 57) return "drizzle";
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return "rain";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 95 && c <= 99) return "storm";
  return "overcast";
}

// A sky that is WET is the one a parks department acts on — it cancels
// programming and empties facilities. Read by the look-ahead line.
function isWet(sky) { return sky === "drizzle" || sky === "rain" || sky === "snow" || sky === "storm"; }

const WX_LABELS = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Heavy rain showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};
// Not "Clear" — see the rule at the top of this file.
function labelFor(code) { return WX_LABELS[Number(code)] || "Unsettled"; }

/* ── Dates and clocks, built from PARTS ────────────────────────────────────
   `new Date("2026-09-19")` is UTC midnight and renders as the 18th anywhere
   west of UTC. That trap is recorded five times over in CLAUDE.md — the
   fasttrack dates, the check-in day-of-week, the ePACT export — so nothing
   here ever hands a bare date string to the Date constructor. */
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekdayOf(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  if (!m) return "";
  return DOW[new Date(+m[1], +m[2] - 1, +m[3]).getDay()] || "";
}

// "2026-09-19T18:47" → "6:47 PM". Local already: Open-Meteo is asked with
// timezone=auto, so every stamp it returns is the org's own wall clock and
// nothing here converts one.
function clockOf(stamp) {
  const m = /T(\d{2}):(\d{2})/.exec(String(stamp || ""));
  if (!m) return "";
  const h = +m[1], mm = m[2];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ":" + mm + " " + (h < 12 ? "AM" : "PM");
}

// A missing temperature must not round to a confident 0°F — same defect as the
// age band that filed 60 un-aged rows under the under-fives.
function roundOrNull(v) {
  const n = strictNum(v);
  return n === null ? null : Math.round(n);
}

/* ── The look-ahead line ───────────────────────────────────────────────────
   The next wet day inside three, named and given its own chance. It is the
   one line on the card a parks department would actually act on, so it is
   WITHHELD rather than softened when the feed cannot support it: no daily
   block, no probability, or a dry week all yield null and the row is dropped.
   A row reading "0%" is a claim; an absent row is not. */
const WX_AHEAD_MIN_PROB = 50;

function aheadFrom(daily) {
  if (!daily || !Array.isArray(daily.time)) return null;
  const codes = daily.weather_code || [];
  const probs = daily.precipitation_probability_max || [];
  // Today first: if it is already wet, say so rather than pointing at tomorrow.
  const todaySky = skyFor(codes[0]);
  const todayProb = roundOrNull(probs[0]);
  if (isWet(todaySky) && todayProb !== null && todayProb >= WX_AHEAD_MIN_PROB) {
    return (todaySky === "snow" ? "Snow" : "Rain") + " likely today — " + todayProb + "%";
  }
  for (let i = 1; i < Math.min(daily.time.length, 4); i++) {
    const sky = skyFor(codes[i]);
    const prob = roundOrNull(probs[i]);
    if (!isWet(sky) || prob === null || prob < WX_AHEAD_MIN_PROB) continue;
    const day = weekdayOf(daily.time[i]);
    if (!day) continue;
    return (sky === "snow" ? "Snow" : "Rain") + " arrives " + day + " — " + prob + "%";
  }
  return null;
}

/* ── The readout the page renders ──────────────────────────────────────────
   NULL, never a default, when the reading cannot be read. The temperature is
   the one field with no honest fallback: without it there is no card. */
function readoutFrom(raw) {
  const cur = (raw && raw.current) || null;
  const daily = (raw && raw.daily) || null;
  if (!cur) return null;
  const temp = roundOrNull(cur.temperature_2m);
  if (temp === null) return null;

  const code = Number(cur.weather_code);
  const sky = skyFor(code);
  const night = Number(cur.is_day) === 0;

  // After dark the useful clock is the next sunrise, which is tomorrow's once
  // the sun is already down. Falling back to today's would print a time that
  // has been and gone.
  let sunLabel = "";
  if (night) {
    const rise = (daily && daily.sunrise && (daily.sunrise[1] || daily.sunrise[0])) || "";
    const t = clockOf(rise);
    if (t) sunLabel = "Sunrise " + t;
  } else {
    const t = clockOf((daily && daily.sunset && daily.sunset[0]) || "");
    if (t) sunLabel = "Sunset " + t;
  }

  const wind = roundOrNull(cur.wind_speed_10m);

  return {
    sky, night, code,
    temp,
    feels: roundOrNull(cur.apparent_temperature),
    label: labelFor(code),
    hi: roundOrNull(daily && daily.temperature_2m_max && daily.temperature_2m_max[0]),
    lo: roundOrNull(daily && daily.temperature_2m_min && daily.temperature_2m_min[0]),
    wind: wind === null ? null : wind + " mph",
    sunLabel,
    ahead: aheadFrom(daily),
    day: weekdayOf((daily && daily.time && daily.time[0]) || ""),
    observedAt: (cur && cur.time) || "",
  };
}

/* ── How old a reading may be ──────────────────────────────────────────────
   `fresh`  — serve it.
   `stale`  — serve it and refresh behind the reader. Twenty minutes of drift
              is invisible; a page that blocks on an external API is not.
   `expired`— DO NOT SERVE. An org nobody has opened for a week must not be
              shown last Tuesday's snow, so past the stale window the page
              renders exactly as it does today, with no weather at all. */
const WX_FRESH_MS = 20 * 60 * 1000;
const WX_STALE_MS = 2 * 60 * 60 * 1000;

function ageStateOf(entry, now, freshMs, staleMs) {
  if (!entry || !Number.isFinite(Number(entry.ts))) return "expired";
  const age = Number(now) - Number(entry.ts);
  if (!Number.isFinite(age) || age < 0) return "expired";
  if (age < (freshMs === undefined ? WX_FRESH_MS : freshMs)) return "fresh";
  if (age < (staleMs === undefined ? WX_STALE_MS : staleMs)) return "stale";
  return "expired";
}

// Coordinates are the gate: an org without them gets no weather rather than a
// guess from its name. "Watertown" alone is in MA, NY, CT and WI, and the
// wrong city's sky is worse than none.
function coordsOf(org) {
  const c = (org && org.coords) || null;
  if (!c) return null;
  const lat = strictNum(c.lat), lon = strictNum(c.lon);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function requestUrlFor(coords) {
  const p = new URLSearchParams({
    latitude: String(coords.lat),
    longitude: String(coords.lon),
    current: "temperature_2m,apparent_temperature,is_day,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
    forecast_days: "4",
  });
  return "https://api.open-meteo.com/v1/forecast?" + p.toString();
}

module.exports = {
  WX_SKIES, WX_FRESH_MS, WX_STALE_MS, WX_AHEAD_MIN_PROB,
  skyFor, labelFor, isWet, weekdayOf, clockOf,
  aheadFrom, readoutFrom, ageStateOf, coordsOf, requestUrlFor,
};
