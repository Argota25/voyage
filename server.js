#!/usr/bin/env node
/*
 * Voyage — local app server + privacy proxy  (zero dependencies)
 * --------------------------------------------------------------------
 * Two jobs:
 *   1. Serve the static app (globe.html, /vendor).
 *   2. Proxy ALL third-party geocode/route calls so the browser never
 *      sends the places a user is planning straight to Nominatim /
 *      Valhalla / Overpass. This is where caching, rate-limiting, and
 *      platform keys live.
 *
 *   GET /api/geocode?q=<query>&limit=<n>     -> Nominatim (US, addressdetails)
 *   GET /api/route?stops=lat,lng;lat,lng&costing=auto -> Valhalla (drive routing)
 *
 * Run:  node server.js        (then open http://localhost:8787/globe.html)
 *
 * NOTE: public Nominatim/Valhalla are still upstream here. This proxy makes
 * usage policy-compliant (proper UA, <=1 req/s to Nominatim, response cache)
 * and gives you ONE place to later swap in self-hosted/keyed providers.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
// Local default: bind to this PC only (127.0.0.1). The public beta host sets
// HOST=0.0.0.0 plus VOYAGE_ORIGINS=https://<domain>; see docs/DEPLOY.md.
// On Railway (RAILWAY_ENVIRONMENT is set by the platform) public mode turns
// on by itself; explicit env vars still win.
const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
const HOST = process.env.HOST || (ON_RAILWAY ? '0.0.0.0' : '127.0.0.1');
const PUBLIC = HOST !== '127.0.0.1' && HOST !== 'localhost';
// Behind a hosting proxy (Railway), the socket address is the proxy, so the
// real client comes from X-Forwarded-For. Only trusted when TRUST_PROXY=1.
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : ON_RAILWAY;
const ROOT = __dirname;
const zlib = require('zlib');
const CONTACT = process.env.VOYAGE_CONTACT || 'https://github.com/Argota25/voyage';
const UA = `Voyage/0.1 (+proxy; ${CONTACT})`;

/* ---------- abuse controls: same-origin gate + per-IP rate limit ---------- */
// Only our own app may use the proxy. Set VOYAGE_ORIGINS for production hosts.
const ORIGINS = (process.env.VOYAGE_ORIGINS ||
  `http://localhost:${PORT},http://127.0.0.1:${PORT}`).split(',').map(s => s.trim()).filter(Boolean);
// Railway's generated domain is always allowed, so the first deploy works
// before VOYAGE_ORIGINS is set (it is still needed for a custom domain).
if (process.env.RAILWAY_PUBLIC_DOMAIN) ORIGINS.push('https://' + process.env.RAILWAY_PUBLIC_DOMAIN);
function originOk(req){
  const o = req.headers.origin || '', r = req.headers.referer || '';
  if (!o && !r) return false;                          // no browser context -> scripted abuse
  return ORIGINS.some(a => o === a || r.indexOf(a) === 0);
}
// The proxy APPENDS the address it saw, so the rightmost entry is the real
// client; anything to its left is client-supplied and spoofable. Without a
// trusted proxy the header is ignored entirely.
function clientIP(req){
  if (TRUST_PROXY){
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'local';
}
const RL = new Map();                                   // ip -> { count, reset }
function rateOk(ip){
  const now = Date.now(), WIN = 60000, MAX = 90;        // 90 API calls / minute / IP
  let b = RL.get(ip);
  if (!b || b.reset < now){ b = { count: 0, reset: now + WIN }; RL.set(ip, b); }
  return ++b.count <= MAX;
}
// public traffic means many IPs: drop expired buckets so the map can't grow forever
setInterval(() => { const now = Date.now(); for (const [k, b] of RL) if (b.reset < now) RL.delete(k); }, 5 * 60000).unref();

/* Daily budgets for keyed free tiers. YouTube gives 10,000 units/day and one
   video lookup costs ~101 (search 100 + stats 1); Google Programmable Search
   gives 100 queries/day. Cache hits are free and never count. Past the cap
   the call fails like an outage, and the UI already degrades to deep links. */
const BUDGET = { yt: 90, google: 95, tm: 4000 };
const spent = {}; let spentDay = '';
function spend(name){
  const day = new Date().toISOString().slice(0, 10);   // resets at UTC midnight, like Google's quota (Pacific) roughly
  if (day !== spentDay){ spentDay = day; for (const k in spent) delete spent[k]; }
  spent[name] = (spent[name] || 0) + 1;
  return spent[name] <= (BUDGET[name] || Infinity);
}

/* ---------- security headers (sent on every response) ---------- */
// HSTS is intentionally omitted on this plain-http dev server (browsers ignore it
// over http). Add it at your TLS terminator in production.
/* Async route handlers used to be dispatched with their promise dropped,
   so any internal async throw became an unhandled rejection - and modern
   Node exits the process on those. An Overpass outage killed the server
   exactly that way. guard() pins every route's promise, answers 500 if
   nothing was sent, and the process-level nets below are the last resort:
   this localhost app must log and keep serving, never die mid-session. */
function guard(p, res){
  Promise.resolve(p).catch(err => {
    console.warn('[handler-error]', (err && err.message) || err);
    try { if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.end(); } catch (e) {}
  });
}
process.on('unhandledRejection', err => console.warn('[unhandled-rejection]', (err && err.message) || err));
process.on('uncaughtException', err => console.warn('[uncaught-exception]', (err && err.message) || err));

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://*.tile.openstreetmap.org https://upload.wikimedia.org https://i.ytimg.com https://*.ticketm.net",
    "connect-src 'self' https://*.wikipedia.org",
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
    "frame-ancestors 'none'",
    "base-uri 'self'"
  ].join('; ')
};

/* ---------- optional social-platform credentials (env wins over secrets.json) ---------- */
let SECRETS = {};
try { SECRETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.json'), 'utf8')); } catch (e) {}
const YT_KEY    = process.env.YOUTUBE_API_KEY      || SECRETS.youtube       || '';
const RD_ID     = process.env.REDDIT_CLIENT_ID     || SECRETS.reddit_id     || '';
const RD_SECRET = process.env.REDDIT_CLIENT_SECRET || SECRETS.reddit_secret || '';

/* ---------- tiny TTL cache ---------- */
const cache = new Map();
function cget(k){ const v = cache.get(k); if (v && v.exp > Date.now()) return v.data; if (v) cache.delete(k); return null; }
function cset(k, data, ttlMs){
  // bounded for public traffic: Map keeps insertion order, so evict the oldest
  if (cache.size >= 5000) cache.delete(cache.keys().next().value);
  cache.set(k, { data, exp: Date.now() + ttlMs });
}

/* ---------- Nominatim politeness queue (<= ~1 req/sec, serialized) ---------- */
// Self-healing: one rejected call must not poison the chain, or every later
// lookup would fail instantly until restart. Callers still see their own
// rejection; the chain itself always settles clean.
let nomChain = Promise.resolve(); let lastNom = 0;
function nomQueue(url){
  const run = nomChain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastNom));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastNom = Date.now();
    return upstream(url);
  });
  nomChain = run.catch(() => {});
  return run;
}
/* Circuit breaker: when Nominatim fails twice in a row, skip it for 60s
   instead of letting every queued lookup serially burn a 12s timeout.
   Fallbacks (Photon, Census) take over instantly while it cools. */
let nomFails = 0, nomSkipUntil = 0;
function nomGuard(p){
  return p.then(up => { nomFails = 0; return up; },
                e => { if (++nomFails >= 2) nomSkipUntil = Date.now() + 60000; throw e; });
}
function nominatim(qs){
  if (Date.now() < nomSkipUntil) return Promise.reject(new Error('nominatim cooling down'));
  return nomGuard(nomQueue('https://nominatim.openstreetmap.org/search?' + qs));
}
function nominatimReverse(qs){
  if (Date.now() < nomSkipUntil) return Promise.reject(new Error('nominatim cooling down'));
  return nomGuard(nomQueue('https://nominatim.openstreetmap.org/reverse?' + qs));
}

/* US Census geocoder: third leg, free, no key, US-only (this is a US app).
   Handles street addresses; returns null when unhealthy, [] on no-match. */
const ST_NAME = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia'};
async function censusGeocode(qtext, limit){
  try {
    const up = await upstream('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(qtext));
    if (up.status !== 200) return null;
    let j; try { j = JSON.parse(up.body); } catch (e){ return null; }
    const m = (j.result && j.result.addressMatches) || [];
    return m.slice(0, limit || 1).map(am => {
      const c = am.coordinates || {}, comp = am.addressComponents || {};
      return { lat: String(c.y), lon: String(c.x), display_name: am.matchedAddress || qtext,
        address: { road: [comp.preDirection, comp.streetName, comp.suffixType].filter(Boolean).join(' ').trim(),
                   city: comp.city || '', state: ST_NAME[comp.state] || comp.state || '', county: '' } };
    });
  } catch (e){ return null; }
}

/* ---------- Photon: typo-tolerant fallback geocoder (Nominatim-shaped output) ---------- */
async function photon(q, limit, near){
  const bias = near ? ('&lat=' + near.lat + '&lon=' + near.lon) : '&lat=39.5&lon=-98.35';
  const url = 'https://photon.komoot.io/api/?lang=en&limit=' + (limit || 5) + bias + '&q=' + encodeURIComponent(q);
  const up = await upstream(url);
  if (up.status !== 200) return null;   // unhealthy, not a no-match
  let j; try { j = JSON.parse(up.body); } catch(e){ return null; }
  const feats = (j.features || []).filter(f => f.properties && (!f.properties.countrycode || f.properties.countrycode === 'US'));
  return feats.map(f => {
    const p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [0, 0];
    const line = [p.name, ((p.housenumber ? p.housenumber + ' ' : '') + (p.street || '')).trim(), p.city || p.county, p.state, 'USA']
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    return { lat: String(c[1]), lon: String(c[0]), display_name: line.join(', '),
      address: { state: p.state || '', city: p.city || p.town || '', town: p.town || '', county: p.county || '', village: p.district || '' } };
  });
}

/* ---------- generic https request (POST-capable, for OAuth token flows) ---------- */
const UPSTREAM_TIMEOUT_MS = 12000;   // a hung upstream degrades one feature, never the app
function httpsReq(url, method, headers, body){
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: UPSTREAM_TIMEOUT_MS }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------- generic upstream GET (https, follows one redirect) ---------- */
function upstream(url, redirects = 0, timeoutMs = 0){
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US' }, timeout: timeoutMs || UPSTREAM_TIMEOUT_MS }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4){
        res.resume();
        return resolve(upstream(new URL(res.headers.location, url).toString(), redirects + 1, timeoutMs));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
  });
}

/* ---------- API handlers ---------- */
// Unambiguous abbreviations users type instead of full names (no city/street collisions).
const ALIASES = { fsu:'Florida State University', fsw:'Florida SouthWestern State College',
  uf:'University of Florida', usf:'University of South Florida', ucf:'University of Central Florida',
  fiu:'Florida International University', fau:'Florida Atlantic University', fgcu:'Florida Gulf Coast University',
  famu:'Florida A&M University', unf:'University of North Florida', lsu:'Louisiana State University',
  uga:'University of Georgia', ucla:'UCLA', nyu:'New York University', mit:'Massachusetts Institute of Technology',
  ucsd:'UC San Diego', ucsb:'UC Santa Barbara' };
function expandAliases(q){
  return q.replace(/\b[A-Za-z][A-Za-z&]{1,5}\b/g, function(m){ return ALIASES[m.toLowerCase()] || m; });
}
function parseNear(s){ const m=(s||'').split(','); const a=parseFloat(m[0]), b=parseFloat(m[1]); return (isFinite(a)&&isFinite(b))?{lat:a,lon:b}:null; }


async function handleGeocode(reqUrl, res){
  const q = (reqUrl.searchParams.get('q') || '').trim();
  let limit = parseInt(reqUrl.searchParams.get('limit') || '1', 10);
  if (!q){ return json(res, 400, { error: 'missing q' }); }
  if (!(limit >= 1 && limit <= 10)) limit = 1;
  const near = parseNear(reqUrl.searchParams.get('near'));   // bias results toward this lat,lng
  const wantGeom = reqUrl.searchParams.get('geom') === '1';  // include street geometry (stop outline)
  const eq = expandAliases(q);                               // "fsu port charlotte" -> "Florida State University port charlotte"
  const key = 'g:' + (wantGeom ? 'G:' : '') + limit + ':' + (near ? near.lat.toFixed(2)+','+near.lon.toFixed(2)+':' : '') + eq.toLowerCase();
  const hit = cget(key);
  if (hit){ return json(res, 200, hit, true); }
  const vb = near ? ('&bounded=0&viewbox=' + (near.lon-0.8)+','+(near.lat+0.8)+','+(near.lon+0.8)+','+(near.lat-0.8)) : '';
  const qs = 'format=jsonv2&addressdetails=1' + (wantGeom ? '&polygon_geojson=1' : '') + '&countrycodes=us&limit=' + limit + vb + '&q=' + encodeURIComponent(eq);
  // Three providers in order: Nominatim (queued, breaker-guarded), Photon
  // (typo-tolerant), Census (US addresses). "healthy" tracks whether ANY
  // provider gave a real answer to distinguish a genuine no-match (200 [])
  // from an outage (502): an empty answer only counts when someone healthy
  // said it.
  // "Chatanooga TN" must never fly to a literally-named street in Illinois:
  // when the query carries a state token, wrong-state-only literal matches
  // are discarded so the typo-tolerant provider gets its turn, and final
  // results are ranked in-state first.
  const stTok = q.match(/[,\s]([A-Za-z]{2})$/);
  const stWant = stTok ? ST_NAME[stTok[1].toUpperCase()] : null;
  const inState = arr => arr.filter(d => d.address && d.address.state === stWant);
  let data = [], healthy = false;
  try {
    const up = await nominatim(qs);
    if (up.status === 200){ healthy = true; const d = JSON.parse(up.body); if (Array.isArray(d)) data = d; }
  } catch (e){}
  if (stWant && data.length && !inState(data).length) data = [];
  if (!data.length){
    try { const p = await photon(eq, limit, near); if (p !== null){ healthy = true; data = p; } } catch (e){}
  }
  if (!data.length && eq !== q){
    try { const p2 = await photon(q, limit, near); if (p2 !== null){ healthy = true; if (p2.length) data = p2; } } catch (e){}
  }
  if (!data.length){
    // comma-less "Town ST" form: expand the state and give Photon a
    // properly-shaped query before giving up
    const m = q.match(/^(.*[^,\s])[,\s]+([A-Za-z]{2})$/);
    const full = m && ST_NAME[m[2].toUpperCase()];
    if (full){
      try { const p3 = await photon(m[1] + ', ' + full, limit, near); if (p3 !== null){ healthy = true; if (p3.length) data = p3; } } catch (e){}
    }
  }
  if (!data.length){
    const cz = await censusGeocode(eq, limit);
    if (cz && cz.length){ data = cz; healthy = true; }   // census only proves matches, never no-matches
  }
  if (data.length){
    if (stWant){ const inSt = inState(data); if (inSt.length) data = inSt; }
    // cache answers only: an empty result during a throttle blip must not
    // become the stored truth for 24 hours (same rule sights/street follow)
    cset(key, data, 24 * 3600 * 1000);
    return json(res, 200, data);
  }
  if (healthy) return json(res, 200, []);
  return json(res, 502, { error: 'geocoder unavailable' });
}

// reverse geocode (name an overnight stop along a road-trip route)
async function censusReverse(lat, lon){
  try {
    const up = await upstream('https://geocoding.geo.census.gov/geocoder/geographies/coordinates?benchmark=Public_AR_Current&vintage=Current_Current&format=json&x=' + lon + '&y=' + lat);
    if (up.status !== 200) return null;
    let j; try { j = JSON.parse(up.body); } catch (e){ return null; }
    const g = (j.result && j.result.geographies) || {};
    const county = ((g.Counties || [])[0] || {}).NAME || '';
    const state = ((g.States || [])[0] || {}).NAME || '';
    if (!county && !state) return null;
    return { display_name: [county, state].filter(Boolean).join(', '),
             address: { county: county, state: state } };
  } catch (e){ return null; }
}
async function handleReverse(reqUrl, res){
  const lat = parseFloat(reqUrl.searchParams.get('lat')), lon = parseFloat(reqUrl.searchParams.get('lon'));
  if (!isFinite(lat) || !isFinite(lon)) return json(res, 400, { error: 'lat/lon required' });
  const key = 'rev:' + lat.toFixed(3) + ',' + lon.toFixed(3);
  const hit = cget(key);
  if (hit) return json(res, 200, hit, true);
  const qs = 'format=jsonv2&zoom=10&addressdetails=1&lat=' + lat + '&lon=' + lon;
  try {
    const up = await nominatimReverse(qs);
    if (up.status !== 200) throw new Error('reverse ' + up.status);
    const data = JSON.parse(up.body);
    // cache real answers only; a throttled {} must not stick for 7 days
    if (data && (data.display_name || data.address)) cset(key, data, 7 * 24 * 3600 * 1000);
    json(res, 200, data);
  } catch (e){
    const cz = await censusReverse(lat, lon);   // county/state naming still beats a blank
    if (cz){ cset(key, cz, 7 * 24 * 3600 * 1000); return json(res, 200, cz); }
    json(res, 502, { error: 'reverse geocoder unavailable' });
  }
}

// sights along a route: notable tourist places near sample points (OpenStreetMap via
// Overpass). Strict mode requires a Wikipedia tag (photo-worthy, used for the route story
// markers). loose=1 adds a fallback sweep for rural stops: named attractions, historic
// sites, and parks WITHOUT the Wikipedia requirement, at a wider radius.
/* Overpass politeness queue: the trip UI fires one sights call per stop, so
   uncoordinated parallel hits are rate-ban bait. Serialize every Overpass
   round (sights AND street) with a small gap. Self-healing like nomQueue:
   a rejected round never poisons the chain. */
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
let opChain = Promise.resolve(); let lastOp = 0;
function opQueue(fn){
  const run = opChain.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastOp));   // ~1 req/s, Overpass etiquette
    if (wait) await sleepMs(wait);
    lastOp = Date.now();
    return fn();
  });
  opChain = run.catch(() => {});
  return run;
}
function overpassRace(ql){
  // Sequential fallback, NOT a parallel race: this IP has been throttled by
  // Overpass before, and racing doubles request volume on every round. The
  // healthy case costs one request; the mirror only sees traffic when the
  // primary fails.
  const data = 'data=' + encodeURIComponent(ql);
  const mirrors = ['https://overpass-api.de/api/interpreter?' + data,
                   'https://overpass.kumi.systems/api/interpreter?' + data];
  return opQueue(async () => {
    let lastErr;
    for (let mi = 0; mi < mirrors.length; mi++){
      const m = mirrors[mi];
      try {
        // Overpass legitimately needs 20-35s on dense metros (measured 32s
        // for one LA street); the global 12s budget starved it and read
        // every slow answer as an outage
        const up = await upstream(m, 0, 40000);
        if (up.status !== 200) throw new Error('overpass ' + up.status);
        const j = JSON.parse(up.body);
        // Overpass reports its own timeouts/overload as HTTP 200 with zero
        // elements plus a remark. That is an outage wearing a no-match
        // costume; surfacing it as [] poisoned the honesty of every caller.
        if (j && j.remark && /error|timed? out|load/i.test(j.remark)) throw new Error('overpass remark: ' + j.remark);
        // A fallback mirror answering "nothing" while the primary is down is
        // not evidence of a no-match (kumi serves 200-empty when unhealthy).
        // Only the primary's empty answer counts as a genuine empty.
        if (mi > 0 && !(j.elements || []).length) throw new Error('fallback empty, distrusted');
        return j;
      } catch (e){ lastErr = e; }
    }
    throw lastErr || new Error('overpass unavailable');
  });
}
function overpassSights(ql){
  return overpassRace(ql).then(j => {
    const seen = {}, out = [];
    (j.elements || []).forEach(el => {
      const t = el.tags || {};
      const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (lat == null || lng == null || !t.name) return;
      const k = (t.wikipedia || t.name).toLowerCase();
      if (seen[k]) return; seen[k] = 1;
      const kind = (t.tourism || t.historic && 'historic' || t.leisure || 'sight').replace(/_/g, ' ');
      out.push({ name: t.name, lat, lng, wp: t.wikipedia || null, kind });
    });
    return out;
  });
}
async function handleSights(reqUrl, res){
  const pts = (reqUrl.searchParams.get('pts') || '').split(';').map(s => {
    const m = s.split(','); const a = parseFloat(m[0]), b = parseFloat(m[1]);
    return (isFinite(a) && isFinite(b)) ? [a, b] : null;
  }).filter(Boolean).slice(0, 14);
  if (!pts.length) return json(res, 400, { error: 'pts required as "lat,lng;lat,lng;..."' });
  const loose = reqUrl.searchParams.get('loose') === '1';
  let radius = parseInt(reqUrl.searchParams.get('r') || '25000', 10);
  if (!(radius >= 1000 && radius <= 50000)) radius = 25000;
  const key = 'sg:' + (loose ? 'L:' : '') + radius + ':' + pts.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join('|');
  const hit = cget(key);
  if (hit) return json(res, 200, hit, true);
  const kinds = 'attraction|viewpoint|theme_park|museum|zoo|aquarium|gallery';
  const strict = pts.map(p => `nwr(around:${radius},${p[0]},${p[1]})["tourism"~"^(${kinds})$"]["name"]["wikipedia"];`).join('');
  try {
    let out = await overpassSights(`[out:json][timeout:25];(${strict});out center 120;`);
    if (!out.length && loose){
      const R2 = Math.min(50000, radius * 2);
      const fb = pts.map(p =>
        `nwr(around:${R2},${p[0]},${p[1]})["tourism"~"^(${kinds}|picnic_site|camp_site)$"]["name"];` +
        `nwr(around:${R2},${p[0]},${p[1]})["historic"]["name"];` +
        `nwr(around:${R2},${p[0]},${p[1]})["leisure"~"^(park|nature_reserve|garden)$"]["name"];`).join('');
      out = await overpassSights(`[out:json][timeout:25];(${fb});out center 120;`);
      // prefer photo-worthy (wikipedia-tagged) first, then the rest
      out.sort((a, b) => (b.wp ? 1 : 0) - (a.wp ? 1 : 0));
    }
    const list = out.slice(0, 40);
    if (list.length) cset(key, list, 24 * 3600 * 1000);   // never cache empties (throttle recovery)
    json(res, 200, list);
  } catch (e){ json(res, 502, { error: 'sights service unavailable' }); }
}

// street outline: all road segments with this name near the point (OpenStreetMap
// via Overpass). One union query tries the exact name, expanded suffix
// abbreviations (Main St -> Main Street), alt_name, and ref, so a spelling
// variant no longer means a silent blank.
function nameVariants(name){
  const out = new Set([name]);
  const m = name.match(/^(.*)\s(St|Ave|Blvd|Rd|Dr|Hwy|Ln|Pkwy|Ct|Pl)\.?$/i);
  if (m){
    const FULL = { st:'Street', ave:'Avenue', blvd:'Boulevard', rd:'Road', dr:'Drive',
                   hwy:'Highway', ln:'Lane', pkwy:'Parkway', ct:'Court', pl:'Place' };
    out.add(m[1] + ' ' + FULL[m[2].toLowerCase()]);
  }
  const area = name.replace(/\s+area$/i, '');
  if (area !== name) out.add(area);
  return [...out].slice(0, 3);
}
async function handleStreet(reqUrl, res){
  const name = (reqUrl.searchParams.get('name') || '').trim();
  const lat = parseFloat(reqUrl.searchParams.get('lat')), lng = parseFloat(reqUrl.searchParams.get('lng'));
  if (!name || !isFinite(lat) || !isFinite(lng)) return json(res, 400, { error: 'name/lat/lng required' });
  const key = 'street:' + name.toLowerCase() + ':' + lat.toFixed(2) + ',' + lng.toFixed(2);
  const hit = cget(key);
  if (hit) return json(res, 200, hit, true);
  const variants = nameVariants(name).map(v => v.replace(/[\\"]/g, ' '));
  // 20 km radius so the WHOLE street outlines, however long it runs.
  // One exact-name clause per round: measured on dense LA, a single clause
  // completes (~21s) while any union of around-clauses times out server-side.
  // Variants run as sequential polite rounds; first hit wins.
  const around = `way(around:20000,${lat},${lng})["highway"]`;
  let sawOutage = false;
  for (const v of variants){
    const ql = `[out:json][timeout:30];(${around}["name"="${v}"];);out geom 400;`;
    try {
      const j = await overpassRace(ql);
      const lines = (j.elements || []).filter(e => e.geometry && e.geometry.length).map(e => e.geometry.map(g => [g.lat, g.lon]));
      if (lines.length){
        cset(key, lines, 24 * 3600 * 1000);   // only cache real hits, never empties
        return json(res, 200, lines);
      }
    } catch (e){ sawOutage = true; }
  }
  if (sawOutage) return json(res, 503, { error: 'street outline service busy' });   // outage, distinct from no-match
  return json(res, 200, []);   // a genuine no-match for every variant
}

/* ===================== social + booking platform layer =====================
   Each integration is credential-gated: it activates the moment keys exist in
   secrets.json (or env) and the server restarts. /api/social/status tells the
   UI what is connected so it never fakes a connection. */
const TM_KEY     = process.env.TICKETMASTER_KEY      || SECRETS.ticketmaster  || '';
const G_CX       = process.env.GOOGLE_CSE_CX         || SECRETS.google_cx     || '';
const G_KEY      = process.env.GOOGLE_API_KEY        || SECRETS.google_key    || YT_KEY;  // same Google key works once Custom Search API is enabled
const AMA_ID     = process.env.AMADEUS_CLIENT_ID     || SECRETS.amadeus_id     || '';
const AMA_SECRET = process.env.AMADEUS_CLIENT_SECRET || SECRETS.amadeus_secret || '';
const AMA_BASE   = (process.env.AMADEUS_ENV || SECRETS.amadeus_env || 'test') === 'production'
  ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';

function handleSocialStatus(res){
  json(res, 200, {
    youtube:  !!YT_KEY,
    reddit:   !!(RD_ID && RD_SECRET),
    hotels:   !!(AMA_ID && AMA_SECRET),        // Amadeus self-service (free tier)
    events:   !!TM_KEY,                        // Ticketmaster Discovery (free key)
    google:   !!(G_KEY && G_CX),               // Programmable Search (web + forums + reddit threads)
    instagram: false, facebook: false, tiktok: false, airbnb: false,
    note: 'instagram/facebook need a Meta developer app + review; tiktok needs developer approval; airbnb has no public API. See docs/SOCIAL-APIS.md.'
  });
}

// YouTube Data API v3: real videos sorted by view count (free key)
async function ytSearch(q){
  const key = 'yt:' + q.toLowerCase();
  const hit = cget(key); if (hit) return hit;
  if (!spend('yt')) throw new Error('youtube daily budget spent');
  const s = await upstream('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=8&q=' + encodeURIComponent(q) + '&key=' + YT_KEY);
  if (s.status !== 200) throw new Error('youtube ' + s.status);
  const sj = JSON.parse(s.body);
  const ids = (sj.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
  const stats = {};
  if (ids.length){
    const v = await upstream('https://www.googleapis.com/youtube/v3/videos?part=statistics&id=' + ids.join(',') + '&key=' + YT_KEY);
    if (v.status === 200) JSON.parse(v.body).items.forEach(it => stats[it.id] = it.statistics || {});
  }
  const out = (sj.items || []).filter(i => i.id && i.id.videoId).map(i => ({
    id: i.id.videoId, title: i.snippet.title, channel: i.snippet.channelTitle,
    published: (i.snippet.publishedAt || '').slice(0, 10),
    thumb: (i.snippet.thumbnails && i.snippet.thumbnails.medium && i.snippet.thumbnails.medium.url) || '',
    views: parseInt((stats[i.id.videoId] || {}).viewCount || '0', 10),
  })).sort((a, b) => b.views - a.views);
  cset(key, out, 6 * 3600 * 1000);
  return out;
}
async function handleVideos(reqUrl, res){
  if (!YT_KEY) return json(res, 501, { error: 'youtube not configured' });
  const q = (reqUrl.searchParams.get('q') || '').trim();
  if (!q) return json(res, 400, { error: 'missing q' });
  try { json(res, 200, await ytSearch(q)); }
  catch (e){ json(res, 502, { error: 'youtube unavailable' }); }
}

// Reddit app-only OAuth (free app at reddit.com/prefs/apps)
let rdTok = null, rdExp = 0;
async function redditToken(){
  if (rdTok && rdExp > Date.now()) return rdTok;
  const auth = Buffer.from(RD_ID + ':' + RD_SECRET).toString('base64');
  const r = await httpsReq('https://www.reddit.com/api/v1/access_token', 'POST',
    { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    'grant_type=client_credentials');
  if (r.status !== 200) throw new Error('reddit token ' + r.status);
  const j = JSON.parse(r.body);
  rdTok = j.access_token; rdExp = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
  return rdTok;
}
async function rdSearch(q){
  const key = 'rd:' + q.toLowerCase();
  const hit = cget(key); if (hit) return hit;
  const tok = await redditToken();
  const r = await httpsReq('https://oauth.reddit.com/search?limit=10&sort=relevance&t=year&q=' + encodeURIComponent(q), 'GET',
    { 'Authorization': 'Bearer ' + tok, 'User-Agent': UA });
  if (r.status !== 200) throw new Error('reddit ' + r.status);
  const j = JSON.parse(r.body);
  const out = ((j.data && j.data.children) || []).map(c => c.data).map(d => ({
    title: d.title, sub: d.subreddit, ups: d.ups || 0, comments: d.num_comments || 0,
    url: 'https://www.reddit.com' + d.permalink, created: d.created_utc || 0,
  })).sort((a, b) => b.ups - a.ups);
  cset(key, out, 6 * 3600 * 1000);
  return out;
}
async function handleReddit(reqUrl, res){
  if (!(RD_ID && RD_SECRET)) return json(res, 501, { error: 'reddit not configured' });
  const q = (reqUrl.searchParams.get('q') || '').trim();
  if (!q) return json(res, 400, { error: 'missing q' });
  try { json(res, 200, await rdSearch(q)); }
  catch (e){ json(res, 502, { error: 'reddit unavailable' }); }
}

// Google Programmable Search: top web results (news, forums, reddit threads via Google's index)
async function gSearch(q){
  const key = 'gs:' + q.toLowerCase();
  const hit = cget(key); if (hit) return hit;
  if (!spend('google')) throw new Error('google daily budget spent');
  const up = await upstream('https://www.googleapis.com/customsearch/v1?key=' + G_KEY + '&cx=' + G_CX + '&num=8&q=' + encodeURIComponent(q));
  if (up.status !== 200) throw new Error('google ' + up.status);
  const j = JSON.parse(up.body);
  const out = (j.items || []).map(i => ({
    title: i.title, url: i.link, snippet: i.snippet || '', site: i.displayLink || '',
  }));
  cset(key, out, 6 * 3600 * 1000);
  return out;
}
async function handleGoogle(reqUrl, res){
  if (!(G_KEY && G_CX)) return json(res, 501, { error: 'google not configured' });
  const q = (reqUrl.searchParams.get('q') || '').trim();
  if (!q) return json(res, 400, { error: 'missing q' });
  try { json(res, 200, await gSearch(q)); }
  catch (e){ json(res, 502, { error: 'google unavailable' }); }
}

/* ---------- "What people are saying" aggregator ----------
   Takes a natural question ("trip to North Carolina, safe stays, fun stops"),
   extracts the meaningful terms, fans out to every CONNECTED platform, and
   ranks all results on one scale (log engagement, so 1M views doesn't bury a
   5k-upvote thread). Unconnected platforms are reported so the UI can offer
   honest deep links instead of fake results. */
const STOPWORDS = new Set(('i im a an the to by car for of in on at is are was were be been where what when which who how why want wanting taking take trip going go my we our you your and or with some any that this these those there here places place get find good best like really so just about between').split(' '));
function condenseQuery(q){
  const words = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter(w => !STOPWORDS.has(w));
  const cleaned = kept.join(' ').trim();
  return cleaned || q;
}
async function handleAggregate(reqUrl, res){
  const q = (reqUrl.searchParams.get('q') || '').trim();
  if (!q) return json(res, 400, { error: 'missing q' });
  const key = 'agg:' + q.toLowerCase();
  const hit = cget(key); if (hit) return json(res, 200, hit, true);
  const cq = condenseQuery(q);
  // trip-shaped questions get travel context for video search, else "safe stay" reads as
  // "stay safe" and returns storm warnings instead of travel content
  const ytq = /\b(trip|travel|vacation|visit|route|drive|driving|road)\b/i.test(q) ? cq + ' road trip travel guide' : cq;
  const jobs = [];
  if (YT_KEY) jobs.push(ytSearch(ytq).then(v => v.map(x => ({
    plat: 'youtube', title: x.title, url: 'https://www.youtube.com/watch?v=' + x.id,
    thumb: x.thumb, meta: x.channel + (x.published ? ' · ' + x.published : ''), engagement: x.views, kind: 'views',
  }))).catch(() => []));
  if (RD_ID && RD_SECRET) jobs.push(rdSearch(cq).then(v => v.map(x => ({
    plat: 'reddit', title: x.title, url: x.url, thumb: '',
    meta: 'r/' + x.sub + ' · ' + x.comments + ' comments', engagement: x.ups, kind: 'upvotes',
  }))).catch(() => []));
  // Google web results are relevance-ordered (no engagement metric) -> separate band
  const webJob = (G_KEY && G_CX) ? gSearch(cq).catch(() => []) : Promise.resolve([]);
  const [parts, web] = await Promise.all([Promise.all(jobs), webJob]);
  const all = [].concat(...parts);
  all.forEach(r => r.score = Math.log10(Math.max(1, r.engagement)));
  all.sort((a, b) => b.score - a.score);
  const out = {
    query: q, used: cq,
    connected: { youtube: !!YT_KEY, reddit: !!(RD_ID && RD_SECRET), google: !!(G_KEY && G_CX), tiktok: false, instagram: false, facebook: false },
    results: all.slice(0, 16),
    web: web.slice(0, 6),
  };
  if (all.length || web.length) cset(key, out, 3600 * 1000);
  json(res, 200, out);
}

// Ticketmaster Discovery: real events near a point (free key; Eventbrite's public search API is gone)
async function handleEvents(reqUrl, res){
  if (!TM_KEY) return json(res, 501, { error: 'events not configured' });
  const lat = parseFloat(reqUrl.searchParams.get('lat')), lng = parseFloat(reqUrl.searchParams.get('lng'));
  if (!isFinite(lat) || !isFinite(lng)) return json(res, 400, { error: 'lat/lng required' });
  const dISO = /^\d{4}-\d{2}-\d{2}$/;
  const ds = dISO.test(reqUrl.searchParams.get('start') || '') ? reqUrl.searchParams.get('start') : '';
  const de = dISO.test(reqUrl.searchParams.get('end') || '') ? reqUrl.searchParams.get('end') : '';
  const win = (ds ? '&startDateTime=' + ds + 'T00:00:00Z' : '') + (de ? '&endDateTime=' + de + 'T23:59:59Z' : '');
  const key = 'ev:' + lat.toFixed(2) + ',' + lng.toFixed(2) + ':' + ds + '-' + de;   // key mirrors the upstream URL exactly (both dates or neither)
  const hit = cget(key); if (hit) return json(res, 200, hit, true);
  if (!spend('tm')) return json(res, 502, { error: 'events unavailable' });
  try {
    const up = await upstream('https://app.ticketmaster.com/discovery/v2/events.json?apikey=' + TM_KEY +
      '&latlong=' + lat + ',' + lng + '&radius=40&unit=miles&sort=date,asc&size=10' + win);
    if (up.status !== 200) return json(res, 502, { error: 'events ' + up.status });
    const j = JSON.parse(up.body);
    const out = (((j._embedded || {}).events) || []).map(e => ({
      name: e.name, url: e.url || '',
      date: ((e.dates || {}).start || {}).localDate || '',
      venue: ((((e._embedded || {}).venues) || [])[0] || {}).name || '',
      img: ((e.images || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0] || {}).url || '',
      price: ((e.priceRanges || [])[0] || {}).min || null,   // ticket floor, when Ticketmaster gives one
    }));
    cset(key, out, 6 * 3600 * 1000);
    json(res, 200, out);
  } catch (e){ json(res, 502, { error: 'events unavailable' }); }
}

// Amadeus self-service hotel search (free tier) — real hotels + live offers near a point
let amaTok = null, amaExp = 0;
async function amadeusToken(){
  if (amaTok && amaExp > Date.now()) return amaTok;
  const r = await httpsReq(AMA_BASE + '/v1/security/oauth2/token', 'POST',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    'grant_type=client_credentials&client_id=' + encodeURIComponent(AMA_ID) + '&client_secret=' + encodeURIComponent(AMA_SECRET));
  if (r.status !== 200) throw new Error('amadeus token ' + r.status);
  const j = JSON.parse(r.body);
  amaTok = j.access_token; amaExp = Date.now() + ((j.expires_in || 1799) - 60) * 1000;
  return amaTok;
}
async function handleHotels(reqUrl, res){
  if (!(AMA_ID && AMA_SECRET)) return json(res, 501, { error: 'hotels not configured' });
  const lat = parseFloat(reqUrl.searchParams.get('lat')), lng = parseFloat(reqUrl.searchParams.get('lng'));
  if (!isFinite(lat) || !isFinite(lng)) return json(res, 400, { error: 'lat/lng required' });
  const dISO = /^\d{4}-\d{2}-\d{2}$/;
  const ci = dISO.test(reqUrl.searchParams.get('in') || '') ? reqUrl.searchParams.get('in') : '';
  const co = dISO.test(reqUrl.searchParams.get('out') || '') ? reqUrl.searchParams.get('out') : '';
  const key = 'ht:' + lat.toFixed(2) + ',' + lng.toFixed(2) + ':' + ci + '-' + co;   // key mirrors the upstream URL exactly (both dates or neither)
  const hit = cget(key); if (hit) return json(res, 200, hit, true);
  try {
    const tok = await amadeusToken();
    const H = { 'Authorization': 'Bearer ' + tok };
    const ls = await httpsReq(AMA_BASE + '/v1/reference-data/locations/hotels/by-geocode?latitude=' + lat + '&longitude=' + lng + '&radius=20&radiusUnit=KM', 'GET', H);
    if (ls.status !== 200) return json(res, 502, { error: 'hotels list ' + ls.status });
    const hotels = (JSON.parse(ls.body).data || []).slice(0, 12);
    let offers = {};
    const ids = hotels.map(h => h.hotelId).slice(0, 10);
    if (ids.length){
      const dts = (ci ? '&checkInDate=' + ci : '') + (co ? '&checkOutDate=' + co : '');
      const of = await httpsReq(AMA_BASE + '/v3/shopping/hotel-offers?adults=1&hotelIds=' + ids.join(',') + dts, 'GET', H);
      if (of.status === 200) (JSON.parse(of.body).data || []).forEach(o => {
        const first = (o.offers || [])[0];
        if (o.hotel && first && first.price) offers[o.hotel.hotelId] = { total: first.price.total, currency: first.price.currency };
      });
    }
    const out = hotels.map(h => ({
      name: h.name, lat: h.geoCode && h.geoCode.latitude, lng: h.geoCode && h.geoCode.longitude,
      price: offers[h.hotelId] ? offers[h.hotelId].total : null,
      currency: offers[h.hotelId] ? offers[h.hotelId].currency : null,
    }));
    cset(key, out, 6 * 3600 * 1000);
    json(res, 200, out);
  } catch (e){ json(res, 502, { error: 'hotels unavailable' }); }
}

const COSTINGS = { auto: 1, pedestrian: 1, bus: 1, bicycle: 1, motorcycle: 1, taxi: 1 };
function parseLatLng(s){ const m = (s || '').split(','); const a = parseFloat(m[0]), b = parseFloat(m[1]); return (isFinite(a) && isFinite(b)) ? { lat: a, lon: b } : null; }
async function handleRoute(reqUrl, res){
  let costing = reqUrl.searchParams.get('costing') || 'auto';
  if (!COSTINGS[costing]) costing = 'auto';
  let locations;
  const stopsParam = reqUrl.searchParams.get('stops');     // road trip: "lat,lng;lat,lng;..."
  if (stopsParam){
    locations = stopsParam.split(';').map(parseLatLng).filter(Boolean);
    if (locations.length < 2){ return json(res, 400, { error: 'need >=2 stops' }); }
  } else {
    const from = parseLatLng(reqUrl.searchParams.get('from'));
    const to = parseLatLng(reqUrl.searchParams.get('to'));
    if (!from || !to){ return json(res, 400, { error: 'from/to required as "lat,lng"' }); }
    locations = [from, to];
  }
  const key = 'r:' + costing + ':' + locations.map(l => l.lat.toFixed(3) + ',' + l.lon.toFixed(3)).join('>');
  const hit = cget(key);
  if (hit){ return json(res, 200, hit, true); }
  try {
    const data = await routeAnyDistance(locations, costing);
    cset(key, data, 6 * 3600 * 1000);
    json(res, 200, data);
  } catch (e){ json(res, 502, { error: 'router unavailable' }); }
}

/* The public Valhalla caps the TOTAL path at 1,500 km (verified: through-
   waypoints do not lift it). Any-distance routing: recursively bisect long
   segments at great-circle midpoints, route each sub-leg as its own
   request, stitch the trips. A coast-to-coast trip is ~4 polite calls. */
function gcMiles(a, b){ return milesLL(a.lat, a.lon, b.lat, b.lon); }
function milesLL(a, b, c, d){ const R = 3959, t = Math.PI / 180, dl = (c - a) * t, dn = (d - b) * t;
  const x = Math.sin(dl/2)**2 + Math.cos(a*t) * Math.cos(c*t) * Math.sin(dn/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }
const LEG_CAP_MI = 780;   // gc miles; ~1.25 road factor keeps legs under the 1500km cap
function splitChain(locs){
  const out = [locs[0]];
  for (let i = 1; i < locs.length; i++){
    let seg = [locs[i - 1], locs[i]];
    // bisect until every gap is under the cap (depth-bounded)
    for (let guard = 0; guard < 4; guard++){
      const next = [seg[0]];
      let grew = false;
      for (let k = 1; k < seg.length; k++){
        if (gcMiles(seg[k - 1], seg[k]) > LEG_CAP_MI){
          next.push({ lat: (seg[k - 1].lat + seg[k].lat) / 2, lon: (seg[k - 1].lon + seg[k].lon) / 2 });
          grew = true;
        }
        next.push(seg[k]);
      }
      seg = next;
      if (!grew) break;
    }
    out.push(...seg.slice(1));
  }
  return out;
}
async function valhallaOnce(locs, costing, alternates){
  const body = { locations: locs, costing, alternates, units: 'miles' };
  const up = await upstream('https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(body)));
  if (up.status !== 200){ const err = new Error('router ' + up.status); err.status = up.status; throw err; }
  return JSON.parse(up.body);
}
async function routeAnyDistance(locations, costing){
  const chain = splitChain(locations);
  if (chain.length === locations.length){
    // short enough for one request (alternates preserved for simple A-B)
    try { return await valhallaOnce(locations, costing, locations.length > 2 ? 0 : 2); }
    catch (e){ if (e.status !== 400) throw e; }
    // 400 despite the estimate (mountain routing overshoot): fall through to legs
  }
  const trips = [];
  for (let i = 1; i < chain.length; i++){
    const part = await valhallaOnce([chain[i - 1], chain[i]], costing, 0);
    if (!part.trip || !part.trip.legs) throw new Error('leg missing');
    trips.push(part.trip);
    if (i > 8) throw new Error('too many legs');
  }
  const legs = [], sum = { length: 0, time: 0 };
  trips.forEach(t => { legs.push(...t.legs); sum.length += (t.summary && t.summary.length) || 0; sum.time += (t.summary && t.summary.time) || 0; });
  return { trip: { legs, summary: sum, status: 0 } };
}

/* ---------- static files ---------- */
const MIME = { '.html':'text/html;charset=utf-8', '.js':'text/javascript;charset=utf-8', '.css':'text/css;charset=utf-8',
  '.json':'application/json;charset=utf-8', '.geojson':'application/json;charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.webp':'image/webp', '.map':'application/json' };
// Never serve these even though they sit in ROOT: secrets, project docs,
// build tooling, retired data, dotfiles. The app needs globe.html and
// /vendor only.
// case-insensitive: Windows/macOS filesystems are case-insensitive, so /SECRETS.JSON
// must be denied exactly like /secrets.json (the deny is compared lowercased too).
const STATIC_DENY = /^(secrets\.json|server\.js|docs|scripts|graphify-out|data|data-backup-0821)([\/\\]|$)|(^|[\/\\])\./i;
function serveStatic(pathname, res){
  let rel;
  try { rel = decodeURIComponent(pathname); }
  catch (e){ return json(res, 400, { error: 'bad path' }); }
  if (rel === '/' || rel === '') rel = '/globe.html';
  const full = path.normalize(path.join(ROOT, rel));
  // ROOT + sep, so a sibling folder like saferoute-usa-x can't pass the check
  if (!full.startsWith(ROOT + path.sep)){ return json(res, 403, { error: 'forbidden' }); }
  if (STATIC_DENY.test(path.relative(ROOT, full).toLowerCase())){ return json(res, 403, { error: 'forbidden' }); }
  fs.stat(full, (serr, st) => {
    if (serr || !st.isFile()){ return json(res, 404, { error: 'not found' }); }
    fs.readFile(full, (err, buf) => {
      if (err){ return json(res, 404, { error: 'not found' }); }
      const ext = path.extname(full).toLowerCase();
      // Vendor files carry their version in the filename, so a year-long
      // immutable cache is safe; a version bump is a new URL. App files stay
      // no-cache so edits show up on refresh.
      const cc = full.indexOf(path.sep + 'vendor' + path.sep) >= 0
        ? 'public, max-age=31536000, immutable' : 'no-cache';
      const h = Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cc, 'Vary': 'Accept-Encoding' }, SECURITY);
      const ae = (res.req && res.req.headers['accept-encoding']) || '';
      // Brotli beats gzip ~25% on these assets; q10 is slow to make but each
      // file is compressed once per mtime and served from cache after that.
      const enc = /\bbr\b/.test(ae) ? 'br' : (/\bgzip\b/.test(ae) ? 'gzip' : '');
      if (buf.length > 1024 && GZ_EXT.test(ext) && enc){
        const key = enc + ':' + full, hit = gzCache.get(key);
        let out;
        if (hit && hit.mtime === st.mtimeMs) out = hit.gz;
        else {
          out = enc === 'br'
            ? zlib.brotliCompressSync(buf, { params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
            : zlib.gzipSync(buf, { level: 6 });
          gzCache.set(key, { mtime: st.mtimeMs, gz: out });
          if (gzCache.size > 40) gzCache.delete(gzCache.keys().next().value);
        }
        h['Content-Encoding'] = enc;
        res.writeHead(200, h);
        return res.end(out);
      }
      res.writeHead(200, h);
      res.end(buf);
    });
  });
}
const GZ_EXT = /^\.(html|js|css|json|geojson|svg|map)$/;
const gzCache = new Map();

function json(res, status, obj, cached){
  let body = Buffer.from(JSON.stringify(obj));
  const h = Object.assign({ 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store', 'X-Cache': cached ? 'HIT' : 'MISS', 'Vary': 'Accept-Encoding' }, SECURITY);
  const ae = (res.req && res.req.headers['accept-encoding']) || '';
  if (body.length > 1024 && /\bgzip\b/.test(ae)){
    body = zlib.gzipSync(body);
    h['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, h);
  res.end(body);
}

/* ---------- router ---------- */
// Host allowlist: a DNS-rebound hostname resolving to 127.0.0.1 sends its
// own Host header; refuse anything that is not literally local.
// In public mode the hosts named in VOYAGE_ORIGINS are allowed too.
const PUBLIC_HOSTS = ORIGINS.map(o => { try { return new URL(o).host.toLowerCase(); } catch (e) { return ''; } }).filter(Boolean);
function hostOk(req){
  const h = String(req.headers.host || '').toLowerCase();
  return h === `localhost:${PORT}` || h === `127.0.0.1:${PORT}` ||
         h === 'localhost' || h === '127.0.0.1' || h === `[::1]:${PORT}` ||
         PUBLIC_HOSTS.includes(h);
}
http.createServer((req, res) => {
 try {
  // liveness probe for the host platform; answered before the host check
  // because the platform's checker sends its own Host header
  if (req.url === '/healthz') return json(res, 200, { ok: true });
  if (!hostOk(req)) return json(res, 403, { error: 'forbidden host' });
  // TLS ends at the platform edge; tell browsers to stay on https
  if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  const u = new URL(req.url, 'http://localhost');
  // operator visibility: endpoint + status only, never query contents
  res.on('finish', () => { if (res.statusCode >= 500) console.warn(`[fail] ${res.statusCode} ${u.pathname}`); });
  // privacy: never log query contents (they contain the places a user plans)
  if (u.pathname.startsWith('/api/')) {
    if (!originOk(req)) return json(res, 403, { error: 'forbidden origin' });
    if (!rateOk(clientIP(req))) return json(res, 429, { error: 'rate limited; slow down' });
    if (u.pathname === '/api/geocode') return void guard(handleGeocode(u, res), res);
    if (u.pathname === '/api/route')   return void guard(handleRoute(u, res), res);
    if (u.pathname === '/api/reverse') return void guard(handleReverse(u, res), res);
    if (u.pathname === '/api/sights')  return void guard(handleSights(u, res), res);
    if (u.pathname === '/api/street')  return void guard(handleStreet(u, res), res);
    if (u.pathname === '/api/social/status') return void guard(handleSocialStatus(res), res);
    if (u.pathname === '/api/social/videos') return void guard(handleVideos(u, res), res);
    if (u.pathname === '/api/social/reddit') return void guard(handleReddit(u, res), res);
    if (u.pathname === '/api/social/aggregate') return void guard(handleAggregate(u, res), res);
    if (u.pathname === '/api/social/google') return void guard(handleGoogle(u, res), res);
    if (u.pathname === '/api/stays/hotels')  return void guard(handleHotels(u, res), res);
    if (u.pathname === '/api/events')        return void guard(handleEvents(u, res), res);
    return json(res, 404, { error: 'unknown endpoint' });
  }
  serveStatic(u.pathname, res);
 } catch (e) {
  // one malformed request must never take the process down
  try { json(res, 400, { error: 'bad request' }); } catch (e2) {}
 }
}).listen(PORT, HOST, () => {
  if (PUBLIC){
    console.log(`Voyage PUBLIC on ${HOST}:${PORT}; origins: ${ORIGINS.join(', ')}; trust proxy: ${TRUST_PROXY}`);
  } else {
    console.log(`Voyage running PRIVATELY at http://localhost:${PORT}/globe.html`);
    console.log(`Bound to ${HOST} only — not reachable from other devices or the internet.`);
  }
});
