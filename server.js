#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
const HOST = process.env.HOST || (ON_RAILWAY ? '0.0.0.0' : '127.0.0.1');
const PUBLIC = HOST !== '127.0.0.1' && HOST !== 'localhost';
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : ON_RAILWAY;
const ROOT = __dirname;
const zlib = require('zlib');
const CONTACT = process.env.VOYAGE_CONTACT || 'https://github.com/Argota25/voyage';
const UA = `Voyage/0.1 (+proxy; ${CONTACT})`;

const ORIGINS = (process.env.VOYAGE_ORIGINS ||
  `http://localhost:${PORT},http://127.0.0.1:${PORT}`).split(',').map(s => s.trim()).filter(Boolean);
if (process.env.RAILWAY_PUBLIC_DOMAIN) ORIGINS.push('https://' + process.env.RAILWAY_PUBLIC_DOMAIN);
function originOk(req){
  const o = req.headers.origin || '', r = req.headers.referer || '';
  if (!o && !r) return false;
  return ORIGINS.some(a => o === a || r.indexOf(a) === 0);
}
function clientIP(req){
  if (TRUST_PROXY){
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'local';
}
const RL = new Map();
function rateOk(ip){
  const now = Date.now(), WIN = 60000, MAX = 90;
  let b = RL.get(ip);
  if (!b || b.reset < now){ b = { count: 0, reset: now + WIN }; RL.set(ip, b); }
  return ++b.count <= MAX;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of RL) if (b.reset < now) RL.delete(k); }, 5 * 60000).unref();

const BUDGET = { yt: 90, google: 95, tm: 4000 };
const spent = {}; let spentDay = '';
function quotaDay(){ return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
function quotaHour(){ return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }), 10) % 24; }
function spendRoll(){
  const day = quotaDay();
  if (day !== spentDay){ spentDay = day; for (const k in spent) delete spent[k]; }
}
function spend(name){
  spendRoll();
  spent[name] = (spent[name] || 0) + 1;
  if (name === 'yt') storeSet('meta:spent', { day: spentDay, spent });
  return spent[name] <= (BUDGET[name] || Infinity);
}

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
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://form.jotform.com",
    "frame-ancestors 'none'",
    "base-uri 'self'"
  ].join('; ')
};

let SECRETS = {};
try { SECRETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.json'), 'utf8')); } catch (e) {}
const YT_KEY    = process.env.YOUTUBE_API_KEY      || SECRETS.youtube       || '';
const RD_ID     = process.env.REDDIT_CLIENT_ID     || SECRETS.reddit_id     || '';
const RD_SECRET = process.env.REDDIT_CLIENT_SECRET || SECRETS.reddit_secret || '';

const crypto = require('crypto');
const DATA_DIR = process.env.VOYAGE_DATA || process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const STORE_DIR = DATA_DIR ? path.join(DATA_DIR, 'v1') : '';
const STORE_MAX = 300 * 1024 * 1024;
let storeOn = false, storeCount = 0;
function storeFile(k){ return path.join(STORE_DIR, crypto.createHash('sha1').update(k).digest('hex') + '.json'); }
function storeGet(k){
  if (!storeOn) return null;
  try { const j = JSON.parse(fs.readFileSync(storeFile(k), 'utf8')); return (j && j.k === k) ? j : null; } catch (e){ return null; }
}
function storeSet(k, data){
  if (!storeOn) return;
  const f = storeFile(k), tmp = f + '.' + process.pid + '.' + Date.now() + '.tmp';
  if (!fs.existsSync(f)) storeCount++;
  fs.writeFile(tmp, JSON.stringify({ k, t: Date.now(), data }), err => {
    if (err) return void fs.unlink(tmp, () => {});
    fs.rename(tmp, f, e2 => { if (e2) fs.unlink(tmp, () => {}); });
  });
}
function storeTrim(){
  if (!storeOn) return;
  try {
    const now = Date.now();
    const files = fs.readdirSync(STORE_DIR).map(f => { const st = fs.statSync(path.join(STORE_DIR, f)); return { f, size: st.size, m: st.mtimeMs }; });
    files.filter(x => x.f.endsWith('.tmp') && now - x.m > 3600000).forEach(x => { try { fs.unlinkSync(path.join(STORE_DIR, x.f)); } catch (e) {} });
    const kept = files.filter(x => x.f.endsWith('.json'));
    storeCount = kept.length;
    let total = kept.reduce((a, x) => a + x.size, 0);
    if (total <= STORE_MAX) return;
    kept.sort((a, b) => a.m - b.m);
    for (const x of kept){ if (total <= STORE_MAX * 0.8) break; try { fs.unlinkSync(path.join(STORE_DIR, x.f)); total -= x.size; storeCount--; } catch (e) {} }
  } catch (e) {}
}
function storeInit(){
  if (!STORE_DIR) return;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.accessSync(STORE_DIR, fs.constants.W_OK);
    storeOn = true;
    storeTrim();
    const sp = storeGet('meta:spent');
    if (sp && sp.data && sp.data.day === quotaDay()){ spentDay = sp.data.day; Object.assign(spent, sp.data.spent || {}); }
  } catch (e){ storeOn = false; console.warn('[store] off: ' + ((e && e.message) || e)); }
}

const TRIP_DIR = DATA_DIR ? path.join(DATA_DIR, 'trips') : '';
const TRIP_MAX = 150 * 1024 * 1024;
const tripMem = new Map();
let tripsOn = false, tripCount = 0;
function tripFile(id){ return path.join(TRIP_DIR, id + '.json'); }
function tripInit(){
  if (!TRIP_DIR) return;
  try { fs.mkdirSync(TRIP_DIR, { recursive: true }); fs.accessSync(TRIP_DIR, fs.constants.W_OK); tripsOn = true; tripTrim(); }
  catch (e){ tripsOn = false; }
}
function tripTrim(){
  if (!tripsOn) return;
  try {
    const files = fs.readdirSync(TRIP_DIR).filter(f => f.endsWith('.json')).map(f => { const st = fs.statSync(path.join(TRIP_DIR, f)); return { f, size: st.size, m: st.mtimeMs }; });
    tripCount = files.length;
    let total = files.reduce((a, x) => a + x.size, 0);
    if (total <= TRIP_MAX) return;
    files.sort((a, b) => a.m - b.m);
    for (const x of files){ if (total <= TRIP_MAX * 0.8) break; try { fs.unlinkSync(path.join(TRIP_DIR, x.f)); total -= x.size; tripCount--; } catch (e) {} }
  } catch (e) {}
}
function tripRead(id){
  if (!/^[a-z0-9]{10}$/.test(id)) return null;
  if (!tripsOn) return tripMem.get(id) || null;
  try { return JSON.parse(fs.readFileSync(tripFile(id), 'utf8')); } catch (e){ return null; }
}
function tripWrite(id, rec){
  if (!tripsOn){ if (tripMem.size >= 500) tripMem.delete(tripMem.keys().next().value); tripMem.set(id, rec); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const f = tripFile(id), tmp = f + '.' + process.pid + '.' + Date.now() + '.tmp', fresh = !fs.existsSync(f);
    fs.writeFile(tmp, JSON.stringify(rec), err => {
      if (err){ fs.unlink(tmp, () => {}); return reject(err); }
      fs.rename(tmp, f, e2 => { if (e2){ fs.unlink(tmp, () => {}); return reject(e2); } if (fresh) tripCount++; resolve(); });
    });
  });
}
function str(v, max){ return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : ''; }
function num(v, lo, hi, d){ const n = +v; return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
function isoDay(v){ return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : ''; }
function pickClean(x){
  const o = { stopI: Math.round(num(x.stopI, 0, 20, 0)), name: str(x.name, 140), src: ['travelers', 'trending', 'you', 'event'].indexOf(x.src) > -1 ? x.src : 'travelers', note: str(x.note, 220) };
  if (isFinite(+x.lat) && isFinite(+x.lng) && x.lat !== null && x.lng !== null){ o.lat = num(x.lat, -90, 90, 0); o.lng = num(x.lng, -180, 180, 0); }
  if (typeof x.wp === 'string' && /^[a-z-]{2,12}:[^<>"']{1,160}$/.test(x.wp)) o.wp = x.wp;
  if (typeof x.url === 'string' && x.url.length < 400 && /^https:\/\/([a-z0-9-]+\.)*(ticketmaster\.com|livenation\.com|ticketweb\.com|universe\.com|evyy\.net)\/[^\s<>"']*$/i.test(x.url)) o.url = x.url;
  const sh = x.short;
  if (sh && typeof sh === 'object' && /^[A-Za-z0-9_-]{6,16}$/.test(sh.id || '')) o.short = { id: sh.id, title: str(sh.title, 140), channel: str(sh.channel, 80), views: Math.round(num(sh.views, 0, 1e12, 0)), secs: Math.round(num(sh.secs, 0, 1e6, 0)) };
  return o;
}
function tripClean(t){
  if (!t || typeof t !== 'object') return null;
  const mode = ['drive', 'fly', 'boat'].indexOf(t.mode) > -1 ? t.mode : 'drive';
  const stops = (Array.isArray(t.stops) ? t.stops : []).map(x => str(x, 120).trim()).filter(Boolean).slice(0, 6);
  if (stops.length < 2) return null;
  const p = t.prefs || {}, b = t.budget || {}, d = t.dates || {};
  const pts = (Array.isArray(t.pts) ? t.pts : []).slice(0, 6).map(x => (x && isFinite(+x.lat) && isFinite(+x.lng) && x.lat !== null && x.lng !== null)
    ? { lat: num(x.lat, -90, 90, 0), lng: num(x.lng, -180, 180, 0), label: str(x.label, 120), city: str(x.city, 80), st: /^[A-Z]{2}$/.test(x.st || '') ? x.st : '' } : null);
  const out = {
    v: 1, mode, stops, by: str(t.by, 40).replace(/[<>]/g, '').trim(),
    pts: (pts.length === stops.length && pts.every(Boolean)) ? pts : [],
    dates: { start: isoDay(d.start), end: isoDay(d.end) },
    prefs: { hrs: [4, 6, 8, 10].indexOf(+p.hrs) > -1 ? +p.hrs : 8, stay: ['airbnb', 'hotel', 'motel', 'any'].indexOf(p.stay) > -1 ? p.stay : 'any', see: (Array.isArray(p.see) ? p.see : []).filter(x => ['food', 'nature', 'history', 'nightlife', 'family', 'music', 'beaches', 'hikes'].indexOf(x) > -1) },
    style: t.style === 'flow' ? 'flow' : 'plan',
    ready: !!t.ready,
    budget: { nightly: num(b.nightly, 0, 5000, 120), foodDay: num(b.foodDay, 0, 2000, 55), mpg: num(b.mpg, 1, 200, 26), gas: num(b.gas, 0, 20, 3.4), rental: num(b.rental, 0, 2000, 55), ppl: Math.round(num(b.ppl, 1, 30, 1)) },
    edited: {},
    stays: (Array.isArray(t.stays) ? t.stays : []).slice(0, 20).map(x => ({ name: str(x.name, 120), type: ['hotel', 'motel', 'rental'].indexOf(x.type) > -1 ? x.type : 'hotel', cost: num(x.cost, 0, 5000, 0), nights: Math.round(num(x.nights, 1, 30, 1)), stopI: Math.round(num(x.stopI, 0, 20, 0)) })).filter(x => x.name),
    extras: (Array.isArray(t.extras) ? t.extras : []).slice(0, 30).map(x => ({ label: str(x && x.label, 160), cost: num(x && x.cost, 0, 100000, 0), pp: !!(x && x.pp) })).filter(x => x.label),
    picks: (Array.isArray(t.picks) ? t.picks : []).slice(0, 60).map(x => pickClean(x)).filter(x => x.name)
  };
  const ed = t.edited || {};
  ['nightly', 'foodDay', 'mpg', 'gas', 'rental', 'ppl'].forEach(k => { if (ed[k]) out.edited[k] = true; });
  return out;
}
function readBody(req, max){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max){ reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const tripRL = new Map();
function tripRateOk(ip){
  const day = quotaDay(), k = ip + '|' + day;
  if (tripRL.size > 20000) tripRL.clear();
  const n = (tripRL.get(k) || 0) + 1; tripRL.set(k, n);
  return n <= 60;
}
async function handleTripSave(req, res, id){
  let body;
  try { body = JSON.parse(await readBody(req, 40000)); } catch (e){ return json(res, 400, { error: 'bad trip' }); }
  const trip = tripClean(body && body.trip);
  if (!trip) return json(res, 400, { error: 'a trip needs at least two stops' });
  const now = Date.now();
  if (id){
    return tripSerial(id, async () => {
      const cur = tripRead(id);
      if (!cur) return json(res, 404, { error: 'trip not found' });
      if (!body.key || body.key !== cur.key) return json(res, 403, { error: 'this trip belongs to someone else' });
      await tripWrite(id, { id, key: cur.key, created: cur.created, updated: now, trip, sugg: Array.isArray(cur.sugg) ? cur.sugg : [] });
      json(res, 200, { id, updated: now });
    });
  }
  if (!tripRateOk(clientIP(req))) return json(res, 429, { error: 'too many trips saved today' });
  const newId = crypto.randomBytes(8).toString('hex').slice(0, 10).replace(/[^a-z0-9]/g, '0');
  const key = crypto.randomBytes(18).toString('hex');
  await tripWrite(newId, { id: newId, key, created: now, updated: now, trip });
  json(res, 200, { id: newId, key, updated: now });
}
function handleTripGet(res, id){
  const rec = tripRead(id);
  if (!rec) return json(res, 404, { error: 'trip not found' });
  json(res, 200, { id: rec.id, created: rec.created, updated: rec.updated, trip: rec.trip, sugg: Array.isArray(rec.sugg) ? rec.sugg : [] });
}
const tripLocks = new Map();
function tripSerial(id, fn){
  const prev = tripLocks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  tripLocks.set(id, tail);
  tail.then(() => { if (tripLocks.get(id) === tail) tripLocks.delete(id); });
  return run;
}
const suggRL = new Map();
function suggRateOk(ip){
  const day = quotaDay(), k = ip + '|' + day;
  if (suggRL.size > 20000) suggRL.clear();
  const n = (suggRL.get(k) || 0) + 1; suggRL.set(k, n);
  return n <= 40;
}
function suggOpen(rec){ return (Array.isArray(rec.sugg) ? rec.sugg : []).filter(x => x && x.status === 'open').length; }
function suggItem(kind, x){
  if (!x || typeof x !== 'object') return null;
  if (kind === 'pick'){ const o = pickClean(x); return o.name ? o : null; }
  if (kind === 'stay'){
    const o = { stopI: Math.round(num(x.stopI, 0, 20, 0)), name: str(x.name, 120).trim(), type: ['hotel', 'motel', 'rental'].indexOf(x.type) > -1 ? x.type : 'hotel', cost: num(x.cost, 0, 5000, 0), nights: Math.round(num(x.nights, 1, 30, 1)) };
    return o.name ? o : null;
  }
  if (kind === 'note'){ const text = str(x.text, 300).trim(); return text ? { text } : null; }
  return null;
}
async function handleSuggAdd(req, res, id){
  let body;
  try { body = JSON.parse(await readBody(req, 8000)); } catch (e){ return json(res, 400, { error: 'bad suggestion' }); }
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad suggestion' });
  const kind = ['pick', 'stay', 'note'].indexOf(body.kind) > -1 ? body.kind : '';
  const item = kind ? suggItem(kind, body.item) : null;
  if (!item) return json(res, 400, { error: 'bad suggestion' });
  const by = str(body.by, 40).replace(/[<>]/g, '').trim();
  if (!tripRead(id)) return json(res, 404, { error: 'trip not found' });
  if (!suggRateOk(clientIP(req))) return json(res, 429, { error: 'too many suggestions today' });
  return tripSerial(id, async () => {
    const rec = tripRead(id);
    if (!rec) return json(res, 404, { error: 'trip not found' });
    const list = Array.isArray(rec.sugg) ? rec.sugg.slice() : [];
    if (suggOpen({ sugg: list }) >= 60) return json(res, 429, { error: 'full' });
    while (list.length >= 60){
      const i = list.findIndex(x => !x || x.status !== 'open');
      if (i < 0) break;
      list.splice(i, 1);
    }
    const sid = crypto.randomBytes(4).toString('hex');
    list.push({ id: sid, by, kind, item, status: 'open', at: Date.now() });
    rec.sugg = list;
    await tripWrite(id, rec);
    json(res, 201, { id: sid, open: suggOpen(rec) });
  });
}
async function handleSuggDecide(req, res, id, sid){
  let body;
  try { body = JSON.parse(await readBody(req, 4000)); } catch (e){ return json(res, 400, { error: 'bad request' }); }
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad request' });
  return tripSerial(id, async () => {
    const rec = tripRead(id);
    if (!rec) return json(res, 404, { error: 'trip not found' });
    if (!body.key || body.key !== rec.key) return json(res, 403, { error: 'this trip belongs to someone else' });
    const status = ['approved', 'declined'].indexOf(body.status) > -1 ? body.status : '';
    if (!status) return json(res, 400, { error: 'status must be approved or declined' });
    const list = Array.isArray(rec.sugg) ? rec.sugg : [];
    const hit = list.filter(x => x && x.id === sid)[0];
    if (!hit) return json(res, 404, { error: 'suggestion not found' });
    hit.status = status;
    hit.decidedAt = Date.now();
    rec.sugg = list;
    await tripWrite(id, rec);
    json(res, 200, { ok: true, open: suggOpen(rec) });
  });
}
function handleTripPeek(u, res){
  const out = {}, seen = {};
  String(u.searchParams.get('ids') || '').split(',').map(x => x.trim()).filter(x => /^[0-9a-f]{10}$/.test(x)).slice(0, 30).forEach(id => {
    if (seen[id]) return; seen[id] = 1;
    const rec = tripRead(id);
    if (rec) out[id] = { open: suggOpen(rec), updated: rec.updated || 0 };
  });
  json(res, 200, out);
}

function htmlEsc(v){ return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
let pageSrc = { m: 0, html: '' };
function serveTripPage(id, req, res){
  const rec = tripRead(id);
  if (!rec) return serveStatic('/globe.html', res);
  const file = path.join(ROOT, 'globe.html');
  let st; try { st = fs.statSync(file); } catch (e){ return serveStatic('/globe.html', res); }
  if (pageSrc.m !== st.mtimeMs) pageSrc = { m: st.mtimeMs, html: fs.readFileSync(file, 'utf8') };
  const t = rec.trip, first = (t.stops[0] || '').split(',')[0], last = (t.stops[t.stops.length - 1] || '').split(',')[0];
  const kind = t.mode === 'fly' ? 'Flight' : (t.mode === 'boat' ? 'Boat trip' : 'Road trip');
  const title = htmlEsc((t.by ? t.by : 'Someone') + ' shared a trip with you: ' + first + ' to ' + last);
  const bits = [kind, t.stops.length + ' stops'];
  if (t.stays.length) bits.push(t.stays.length + (t.stays.length === 1 ? ' place to stay' : ' places to stay'));
  if (t.picks.length) bits.push(t.picks.length + ' things to do');
  const desc = htmlEsc(bits.join(' · ') + '. Open it to see the route and the plan on Voyage.');
  const head = '<title>' + title + '</title><meta name="description" content="' + desc + '"><meta property="og:title" content="' + title + '"><meta property="og:description" content="' + desc + '"><meta property="og:type" content="website"><meta name="twitter:card" content="summary">';
  const html = pageSrc.html.replace(/<title>[^<]*<\/title>(\s*<meta (name="description"|property="og:[a-z]+")[^>]*>)*/, head);
  const h = Object.assign({ 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' }, SECURITY);
  const ae = (req.headers['accept-encoding']) || '';
  if (/\bgzip\b/.test(ae)){ h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 6 })); }
  res.writeHead(200, h);
  res.end(html);
}

const cache = new Map();
const KEEP = /^(guide2|places|stayosm|yt|r|gas):/;
function cget(k){
  const v = cache.get(k);
  if (v && v.exp > Date.now()) return v.data;
  if (v) cache.delete(k);
  if (KEEP.test(k)){
    const j = storeGet(k);
    if (j && j.data && j.data.exp > Date.now()){ cache.set(k, { data: j.data.data, exp: j.data.exp }); return j.data.data; }
  }
  return null;
}
function cset(k, data, ttlMs){
  if (cache.size >= 5000) cache.delete(cache.keys().next().value);
  const exp = Date.now() + ttlMs;
  cache.set(k, { data, exp });
  if (KEEP.test(k)) storeSet(k, { data, exp });
}

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

async function photon(q, limit, near){
  const bias = near ? ('&lat=' + near.lat + '&lon=' + near.lon) : '&lat=39.5&lon=-98.35';
  const url = 'https://photon.komoot.io/api/?lang=en&limit=' + (limit || 5) + bias + '&q=' + encodeURIComponent(q);
  const up = await upstream(url);
  if (up.status !== 200) return null;
  let j; try { j = JSON.parse(up.body); } catch(e){ return null; }
  const feats = (j.features || []).filter(f => f.properties && (!f.properties.countrycode || f.properties.countrycode === 'US'));
  return feats.map(f => {
    const p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [0, 0];
    const line = [p.name, ((p.housenumber ? p.housenumber + ' ' : '') + (p.street || '')).trim(), p.city || p.county, p.state, 'USA']
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    return { lat: String(c[1]), lon: String(c[0]), display_name: line.join(', '),
      category: p.osm_key || '', type: p.osm_value || '', place_rank: PHOTON_RANK[p.type] || 30, importance: 0,
      address: { state: p.state || '', city: p.city || p.town || '', town: p.town || '', county: p.county || '', village: p.district || '' } };
  });
}
const PHOTON_RANK = { country: 4, state: 8, county: 12, city: 16, district: 20, locality: 20, street: 26, house: 30 };
async function photonCities(q){
  const url = 'https://photon.komoot.io/api/?lang=en&limit=8&osm_tag=place:city&osm_tag=place:town&bbox=-180,17,-64,72&q=' + encodeURIComponent(q);
  const up = await upstream(url);
  if (up.status !== 200) return null;
  let j; try { j = JSON.parse(up.body); } catch(e){ return null; }
  return (j.features || []).filter(f => f.properties && f.properties.countrycode === 'US' && f.properties.name).map(f => {
    const p = f.properties, c = (f.geometry && f.geometry.coordinates) || [0, 0];
    return { lat: String(c[1]), lon: String(c[0]), display_name: [p.name, p.county, p.state, 'USA'].filter(Boolean).join(', '),
      category: 'place', type: p.osm_value || 'city', place_rank: 16, importance: p.osm_value === 'city' ? 0.5 : 0.3,
      address: { city: p.name, county: p.county || '', state: p.state || '' } };
  });
}

const UPSTREAM_TIMEOUT_MS = 12000;
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

function upstream(url, redirects = 0, timeoutMs = 0, accept = ''){
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': accept || 'application/json', 'Accept-Language': 'en-US' }, timeout: timeoutMs || UPSTREAM_TIMEOUT_MS }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4){
        res.resume();
        return resolve(upstream(new URL(res.headers.location, url).toString(), redirects + 1, timeoutMs, accept));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
  });
}

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
  const near = parseNear(reqUrl.searchParams.get('near'));
  const wantGeom = reqUrl.searchParams.get('geom') === '1';
  const eq = expandAliases(q);
  if (reqUrl.searchParams.get('fuzzy') === '1'){
    const fk = 'gz:' + q.toLowerCase();
    const fh = cget(fk);
    if (fh) return json(res, 200, fh, true);
    let list = null;
    try { list = await photonCities(q); } catch (e){}
    if (list === null) return json(res, 502, { error: 'geocoder unavailable' });
    cset(fk, list, 24 * 3600 * 1000);
    return json(res, 200, list);
  }
  const key = 'g:' + (wantGeom ? 'G:' : '') + limit + ':' + (near ? near.lat.toFixed(2)+','+near.lon.toFixed(2)+':' : '') + eq.toLowerCase();
  const hit = cget(key);
  if (hit){ return json(res, 200, hit, true); }
  const vb = near ? ('&bounded=0&viewbox=' + (near.lon-0.8)+','+(near.lat+0.8)+','+(near.lon+0.8)+','+(near.lat-0.8)) : '';
  const qs = 'format=jsonv2&addressdetails=1' + (wantGeom ? '&polygon_geojson=1' : '') + '&countrycodes=us&limit=' + limit + vb + '&q=' + encodeURIComponent(eq);
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
    const m = q.match(/^(.*[^,\s])[,\s]+([A-Za-z]{2})$/);
    const full = m && ST_NAME[m[2].toUpperCase()];
    if (full){
      try { const p3 = await photon(m[1] + ', ' + full, limit, near); if (p3 !== null){ healthy = true; if (p3.length) data = p3; } } catch (e){}
    }
  }
  if (!data.length){
    const cz = await censusGeocode(eq, limit);
    if (cz && cz.length){ data = cz; healthy = true; }
  }
  if (data.length){
    if (stWant){ const inSt = inState(data); if (inSt.length) data = inSt; }
    cset(key, data, 24 * 3600 * 1000);
    return json(res, 200, data);
  }
  if (healthy) return json(res, 200, []);
  return json(res, 502, { error: 'geocoder unavailable' });
}

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
    if (data && (data.display_name || data.address)) cset(key, data, 7 * 24 * 3600 * 1000);
    json(res, 200, data);
  } catch (e){
    const cz = await censusReverse(lat, lon);
    if (cz){ cset(key, cz, 7 * 24 * 3600 * 1000); return json(res, 200, cz); }
    json(res, 502, { error: 'reverse geocoder unavailable' });
  }
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));
let opChain = Promise.resolve(); let lastOp = 0;
function opQueue(fn){
  const run = opChain.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastOp));
    if (wait) await sleepMs(wait);
    lastOp = Date.now();
    return fn();
  });
  opChain = run.catch(() => {});
  return run;
}
function overpassRace(ql){
  const data = 'data=' + encodeURIComponent(ql);
  const mirrors = ['https://overpass-api.de/api/interpreter?' + data,
                   'https://overpass.kumi.systems/api/interpreter?' + data];
  return opQueue(async () => {
    let lastErr;
    for (let mi = 0; mi < mirrors.length; mi++){
      const m = mirrors[mi];
      try {
        const up = await upstream(m, 0, 40000);
        if (up.status !== 200) throw new Error('overpass ' + up.status);
        const j = JSON.parse(up.body);
        if (j && j.remark && /error|timed? out|load/i.test(j.remark)) throw new Error('overpass remark: ' + j.remark);
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
      out.sort((a, b) => (b.wp ? 1 : 0) - (a.wp ? 1 : 0));
    }
    const list = out.slice(0, 40);
    if (list.length) cset(key, list, 24 * 3600 * 1000);
    json(res, 200, list);
  } catch (e){ json(res, 502, { error: 'sights service unavailable' }); }
}

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
async function handleStaysOsm(reqUrl, res){
  const lat = parseFloat(reqUrl.searchParams.get('lat')), lng = parseFloat(reqUrl.searchParams.get('lng'));
  if (!isFinite(lat) || !isFinite(lng)) return json(res, 400, { error: 'lat/lng required' });
  const key = 'stayosm:' + lat.toFixed(2) + ',' + lng.toFixed(2);
  const hit = cget(key);
  if (hit) return json(res, 200, hit, true);
  const ql = `[out:json][timeout:25];nwr(around:15000,${lat.toFixed(4)},${lng.toFixed(4)})["tourism"~"^(hotel|motel|guest_house|hostel)$"]["name"];out center 60;`;
  try {
    const j = await overpassRace(ql);
    const seen = {}, out = [];
    (j.elements || []).forEach(el => {
      const t = el.tags || {};
      const la = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lo = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (la == null || lo == null || !t.name) return;
      const k = t.name.toLowerCase();
      if (seen[k]) return; seen[k] = 1;
      const mi = milesLL(lat, lng, la, lo);
      out.push({ name: t.name, kind: t.tourism, lat: la, lng: lo, mi: Math.round(mi * 10) / 10,
        stars: parseInt(t.stars, 10) || null, addr: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null });
    });
    out.sort((a, b) => a.mi - b.mi);
    const list = out.slice(0, 30);
    if (list.length) cset(key, list, 24 * 3600 * 1000);
    json(res, 200, list);
  } catch (e){ json(res, 502, { error: 'stays unavailable' }); }
}

function stripTags(h){
  return String(h || '').replace(/<style[^>]*>[^]*?<\/style>/gi, '').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;|&#160;|&#32;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
async function wikivoyagePage(title){
  const up = await upstream('https://en.wikivoyage.org/w/api.php?action=parse&prop=text&format=json&redirects=1&formatversion=2&page=' + encodeURIComponent(title));
  if (up.status !== 200) return null;
  let j; try { j = JSON.parse(up.body); } catch (e){ return null; }
  if (!j.parse || !j.parse.text) return null;
  const parts = j.parse.text.split(/<h2[^>]*id="([^"]+)"/);
  const want = { See: 'see', Do: 'do', Eat: 'eat', Drink: 'drink' }, out = { see: [], do: [], eat: [], drink: [] };
  for (let i = 1; i < parts.length; i += 2){
    const k = want[parts[i]]; if (!k) continue;
    const seen = {}, cards = parts[i + 1].split('class="vcard"').slice(1);
    for (const card of cards){
      if (out[k].length >= 14) break;
      const nm = /listing-name[^>]*>([^]*?)<\/span>/.exec(card); if (!nm) continue;
      const name = stripTags(nm[1]); if (!name || name.length > 70 || seen[name.toLowerCase()]) continue;
      seen[name.toLowerCase()] = 1;
      const c = /listing-content[^>]*>([^]*?)<\/span>/.exec(card);
      let note = c ? stripTags(c[1]) : '';
      if (note.length > 170) note = note.slice(0, 167).replace(/\s+\S*$/, '') + '...';
      const la = /class="latitude">(-?[\d.]+)</.exec(card), lo = /class="longitude">(-?[\d.]+)</.exec(card);
      const item = { name, note };
      if (la && lo && isFinite(+la[1]) && isFinite(+lo[1])){ item.lat = +la[1]; item.lng = +lo[1]; }
      out[k].push(item);
    }
  }
  out.title = j.parse.title || title;
  return (out.see.length + out.do.length + out.eat.length + out.drink.length) ? out : null;
}
async function handleGuide(reqUrl, res){
  const place = (reqUrl.searchParams.get('place') || '').trim().slice(0, 80);
  if (!place) return json(res, 400, { error: 'missing place' });
  const key = 'guide2:' + place.toLowerCase();
  const hit = cget(key); if (hit) return json(res, 200, hit, true);
  const bits = place.split(',').map(x => x.trim()).filter(Boolean);
  const city = (bits[0] || '').replace(/ county$/i, ''), state = bits[1] || '';
  const tries = state ? [city + ' (' + state + ')', city] : [city];
  try {
    let g = null;
    for (const t of tries){ g = await wikivoyagePage(t); if (g) break; }
    const out = g || { see: [], do: [], eat: [], drink: [], title: '' };
    cset(key, out, (g ? 7 * 24 : 6) * 3600 * 1000);
    json(res, 200, out);
  } catch (e){ json(res, 502, { error: 'guide unavailable' }); }
}

const PLACE_CATS = {
  food:      { r: 4000,  q: ['["amenity"="restaurant"]["cuisine"]["name"]'] },
  nightlife: { r: 6000,  q: ['["amenity"="bar"]["name"]', '["amenity"="pub"]["name"]', '["amenity"="nightclub"]["name"]'] },
  nature:    { r: 12000, q: ['["leisure"="park"]["name"]["wikidata"]', '["leisure"="nature_reserve"]["name"]', '["tourism"="viewpoint"]["name"]'] },
  hikes:     { r: 20000, q: ['["leisure"="nature_reserve"]["name"]', '["highway"="trailhead"]["name"]', '["natural"="peak"]["name"]["wikidata"]'] },
  history:   { r: 12000, q: ['["tourism"="museum"]["name"]', '["tourism"="gallery"]["name"]', '["historic"="monument"]["name"]', '["historic"="memorial"]["name"]["wikidata"]'] },
  family:    { r: 20000, q: ['["tourism"="zoo"]["name"]', '["tourism"="aquarium"]["name"]', '["tourism"="theme_park"]["name"]', '["leisure"="water_park"]["name"]', '["leisure"="miniature_golf"]["name"]'] },
  music:     { r: 10000, q: ['["amenity"="theatre"]["name"]', '["amenity"="music_venue"]["name"]', '["amenity"="arts_centre"]["name"]'] },
  beaches:   { r: 25000, q: ['["natural"="beach"]["name"]', '["leisure"="beach_resort"]["name"]'] }
};
async function handlePlaces(reqUrl, res){
  const lat = parseFloat(reqUrl.searchParams.get('lat')), lng = parseFloat(reqUrl.searchParams.get('lng'));
  const cat = (reqUrl.searchParams.get('cat') || '').toLowerCase(), def = PLACE_CATS[cat];
  if (!isFinite(lat) || !isFinite(lng) || !def) return json(res, 400, { error: 'lat/lng/cat required' });
  const key = 'places:' + cat + ':' + lat.toFixed(2) + ',' + lng.toFixed(2);
  const hit = cget(key); if (hit) return json(res, 200, hit, true);
  const around = '(around:' + def.r + ',' + lat.toFixed(4) + ',' + lng.toFixed(4) + ')';
  const ql = '[out:json][timeout:20];(' + def.q.map(f => 'nw' + around + f + ';').join('') + ');out center 60;';
  try {
    const j = await overpassRace(ql);
    const seen = {}, out = [];
    (j.elements || []).forEach(el => {
      const t = el.tags || {};
      const la = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lo = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (la == null || lo == null || !t.name) return;
      const k = t.name.toLowerCase(); if (seen[k]) return; seen[k] = 1;
      const kind = (t.cuisine ? t.cuisine.split(';')[0].replace(/_/g, ' ') + ' food' : (t.tourism || t.amenity || t.leisure || t.historic || t.natural || 'place').replace(/_/g, ' '));
      out.push({ name: t.name, kind, cat, lat: la, lng: lo, mi: Math.round(milesLL(lat, lng, la, lo) * 10) / 10,
        wp: t.wikipedia || null, known: !!(t.wikipedia || t.wikidata) });
    });
    out.sort((a, b) => (b.known - a.known) || (a.mi - b.mi));
    const list = out.slice(0, 24);
    if (list.length) cset(key, list, 24 * 3600 * 1000);
    json(res, 200, list);
  } catch (e){ json(res, 502, { error: 'places unavailable' }); }
}

async function handleStreet(reqUrl, res){
  const name = (reqUrl.searchParams.get('name') || '').trim();
  const lat = parseFloat(reqUrl.searchParams.get('lat')), lng = parseFloat(reqUrl.searchParams.get('lng'));
  if (!name || !isFinite(lat) || !isFinite(lng)) return json(res, 400, { error: 'name/lat/lng required' });
  const key = 'street:' + name.toLowerCase() + ':' + lat.toFixed(2) + ',' + lng.toFixed(2);
  const hit = cget(key);
  if (hit) return json(res, 200, hit, true);
  const variants = nameVariants(name).map(v => v.replace(/[\\"]/g, ' '));
  const around = `way(around:20000,${lat},${lng})["highway"]`;
  let sawOutage = false;
  for (const v of variants){
    const ql = `[out:json][timeout:30];(${around}["name"="${v}"];);out geom 400;`;
    try {
      const j = await overpassRace(ql);
      const lines = (j.elements || []).filter(e => e.geometry && e.geometry.length).map(e => e.geometry.map(g => [g.lat, g.lon]));
      if (lines.length){
        cset(key, lines, 24 * 3600 * 1000);
        return json(res, 200, lines);
      }
    } catch (e){ sawOutage = true; }
  }
  if (sawOutage) return json(res, 503, { error: 'street outline service busy' });
  return json(res, 200, []);
}

const TM_KEY     = process.env.TICKETMASTER_KEY      || SECRETS.ticketmaster  || '';
const G_CX       = process.env.GOOGLE_CSE_CX         || SECRETS.google_cx     || '';
const G_KEY      = process.env.GOOGLE_API_KEY        || SECRETS.google_key    || YT_KEY;
const AMA_ID     = process.env.AMADEUS_CLIENT_ID     || SECRETS.amadeus_id     || '';
const AMA_SECRET = process.env.AMADEUS_CLIENT_SECRET || SECRETS.amadeus_secret || '';
const AMA_BASE   = (process.env.AMADEUS_ENV || SECRETS.amadeus_env || 'test') === 'production'
  ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';

const GAS_URL = 'https://www.eia.gov/dnav/pet/pet_pri_gnd_a_epmr_pte_dpgal_w.htm';
const GAS_SRC = 'U.S. Energy Information Administration, weekly retail regular';
const GAS_LABEL = { NUS: 'U.S. average', R10: 'East Coast', R1X: 'New England', R1Y: 'Central Atlantic', R1Z: 'Lower Atlantic', R20: 'Midwest', R30: 'Gulf Coast', R40: 'Rocky Mountain', R50: 'West Coast', R5XCA: 'West Coast less California',
  SCA: 'California', SCO: 'Colorado', SFL: 'Florida', SMA: 'Massachusetts', SMN: 'Minnesota', SNY: 'New York', SOH: 'Ohio', STX: 'Texas', SWA: 'Washington' };
const GAS_OWN = { CA: 'SCA', CO: 'SCO', FL: 'SFL', MA: 'SMA', MN: 'SMN', NY: 'SNY', OH: 'SOH', TX: 'STX', WA: 'SWA' };
const GAS_PADD = { R1X: 'CT ME MA NH RI VT', R1Y: 'DE DC MD NJ NY PA', R1Z: 'FL GA NC SC VA WV', R20: 'IL IN IA KS KY MI MN MO NE ND OH OK SD TN WI',
  R30: 'AL AR LA MS NM TX', R40: 'CO ID MT UT WY', R5XCA: 'AK AZ HI NV OR WA', R50: 'CA' };
const GAS_PARENT = { R1X: 'R10', R1Y: 'R10', R1Z: 'R10', R5XCA: 'R50' };
const GAS_REGION = {};
Object.keys(GAS_PADD).forEach(r => GAS_PADD[r].split(' ').forEach(st => { GAS_REGION[st] = r; }));
function gasParse(html){
  const src = String(html || ''), p = {};
  src.split(/<tr class=["']DataRow["']>/).slice(1).forEach(r => {
    const id = /EMM_EPMR_PTE_([A-Z0-9]+)_DPG/.exec(r), v = /class=["']Current2["']>\s*([0-9]+\.[0-9]+)/.exec(r);
    if (!id || !v || !GAS_LABEL[id[1]] || p[id[1]]) return;
    const n = parseFloat(v[1]);
    if (n > 1 && n < 15) p[id[1]] = n;
  });
  const ds = src.match(/class=["']Series5["']>\s*\d\d\/\d\d\/\d\d/g);
  const dm = ds && /(\d\d)\/(\d\d)\/(\d\d)$/.exec(ds[ds.length - 1]);
  if (!p.NUS || !dm) return null;
  return { asof: '20' + dm[3] + '-' + dm[1] + '-' + dm[2], p };
}
let gasInflight = null, gasDownUntil = 0;
function gasTable(){
  const hit = cget('gas:tbl');
  if (hit) return Promise.resolve(hit);
  if (Date.now() < gasDownUntil) return Promise.resolve(cget('gas:last'));
  if (!gasInflight){
    gasInflight = upstream(GAS_URL, 0, 12000, 'text/html').then(r => {
      const t = r && r.status === 200 ? gasParse(r.body) : null;
      if (!t){ gasDownUntil = Date.now() + 5 * 60000; return cget('gas:last'); }
      cset('gas:tbl', t, 12 * 3600000);
      cset('gas:last', t, 45 * 86400000);
      return t;
    }, () => { gasDownUntil = Date.now() + 5 * 60000; return cget('gas:last'); }).then(t => { gasInflight = null; return t; });
  }
  return gasInflight;
}
function gasStatus(){
  gasTable().catch(() => {});
  const t = cget('gas:tbl') || cget('gas:last');
  return t ? { asof: t.asof, source: GAS_SRC } : { asof: '', source: 'fallback' };
}
async function handleGas(u, res){
  const want = [];
  String(u.searchParams.get('st') || '').toUpperCase().split(',').forEach(x => {
    x = x.trim();
    if (/^[A-Z]{2}$/.test(x) && GAS_REGION[x] && want.indexOf(x) < 0 && want.length < 8) want.push(x);
  });
  let t = null;
  try { t = await gasTable(); } catch (e){ t = null; }
  if (!t) return json(res, 200, { price: 3.40, unit: '$/gal', label: 'U.S. typical', asof: '', source: 'fallback', fallback: true, by: [] });
  const r2 = n => Math.round(n * 100) / 100;
  if (!want.length) return json(res, 200, { price: r2(t.p.NUS), unit: '$/gal', label: 'U.S. average', asof: t.asof, source: GAS_SRC, by: [] });
  const by = want.map(st => {
    const reg = GAS_REGION[st];
    const k = [GAS_OWN[st], reg, GAS_PARENT[reg], 'NUS'].filter(x => x && t.p[x])[0];
    return { st, price: r2(t.p[k]), label: GAS_LABEL[k] };
  });
  const labels = by.map(b => b.label);
  json(res, 200, { price: r2(by.reduce((a, b) => a + b.price, 0) / by.length), unit: '$/gal', label: labels.every(l => l === labels[0]) ? labels[0] : 'your route', asof: t.asof, source: GAS_SRC, by });
}

function handleSocialStatus(res){
  json(res, 200, {
    youtube:  !!YT_KEY,
    reddit:   !!(RD_ID && RD_SECRET),
    hotels:   !!(AMA_ID && AMA_SECRET),
    events:   !!TM_KEY,
    google:   !!(G_KEY && G_CX),
    instagram: false, facebook: false, tiktok: false, airbnb: false,
    store: storeOn, stored: storeCount, trips: tripCount, gas: gasStatus(), videoSearches: { used: spent.yt || 0, max: BUDGET.yt }, videoIndex: chanIdx.length,
    note: 'instagram/facebook need a Meta developer app + review; tiktok needs developer approval; airbnb has no public API. See docs/SOCIAL-APIS.md.'
  });
}

let ytDownUntil = 0;
function limitedErr(){ const e = new Error('youtube limited'); e.limited = true; return e; }
async function ytSearch(q){
  const key = 'yt:' + q.toLowerCase();
  const hit = cget(key); if (hit) return hit;
  if (Date.now() < ytDownUntil) throw limitedErr();
  if (!spend('yt')) throw limitedErr();
  const s = await upstream('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance&maxResults=25&regionCode=US&relevanceLanguage=en&q=' + encodeURIComponent(q) + '&key=' + YT_KEY);
  if (s.status === 403 || s.status === 429){ ytDownUntil = Date.now() + 30 * 60000; throw limitedErr(); }
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
  if (out.length) cset(key, out, 30 * 24 * 3600 * 1000);
  return out;
}

function isoSecs(d){ const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || ''); return m ? (+(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0)) : 9999; }
const PACK_FRESH = 30 * 864e5;
const packBusy = {};
let wanted = [];
function packKey(place){ return 'ytp:' + place.toLowerCase().replace(/\s+/g, ' ').trim(); }
function packRead(place){
  const k = packKey(place), m = cache.get(k);
  if (m) return m.data;
  const j = storeGet(k);
  if (!j) return null;
  const d = j.data || [];
  const v = Array.isArray(d) ? { t: j.t, list: d, full: true } : { t: j.t, list: d.list || [], full: !!d.full };
  cache.set(k, { data: v, exp: Infinity });
  return v;
}
function packSave(place, list, full){
  const k = packKey(place);
  cache.set(k, { data: { t: Date.now(), list, full }, exp: Infinity });
  storeSet(k, { list, full });
}
function wantAdd(place){
  const k = place.trim();
  if (!k || wanted.some(x => x.toLowerCase() === k.toLowerCase())) return;
  wanted.push(k); if (wanted.length > 500) wanted.shift();
  storeSet('meta:wanted', wanted);
}
function wantDrop(place){
  const n = wanted.length;
  wanted = wanted.filter(x => x.toLowerCase() !== place.trim().toLowerCase());
  if (wanted.length !== n) storeSet('meta:wanted', wanted);
}

const CHANNELS = [
  ['UUGaOvAFinZ7BCN_FDmw74fQ', 'Expedia'],
  ['UUh3Rpsdv1fxefE0ZcKBaNcQ', 'touropia'],
  ['UUPsil91i8gN0XLIbwl3vqsw', 'Lonely Planet'],
  ['UUEaOIzCASJLcj3UDwGlt7nQ', 'The Daytripper'],
  ['UUFr3sz2t3bDp6Cux08B93KQ', 'Wolters World'],
  ['UUuoctbnIa5iwYAURijRCG8A', 'Travel Texas'],
  ['UUk_5HwLfgy-eALpm879J5Ag', 'Visit California'],
  ['UUDlZa0hPoPD3gjwRZrv9A6Q', 'VISIT FLORIDA'],
  ['UU4ijq8Cg-8zQKx8OH12dUSw', 'Kara and Nate'],
  ['UUS9S86BryT1on_qhDT2Jwig', 'Tripadvisor'],
  ['UUw8_bi1G4duPevdfktipGOA', 'Yellow Productions'],
  ['UUWyPjY3I86JQt1u3mV8OyUw', 'Through My Lens'],
  ['UU6G-WN8KW4qFHEmdyyQtF7g', 'Visit The USA'],
  ['UUEDrRCC0qRtPd5-sSa1hajw', 'The Endless Adventure'],
  ['UU9_eukrzdzY91jjDZm62FXQ', 'MojoTravels'],
  ['UUqENvRsthKwsb5Ab-OwnlOw', 'Oregon'],
  ['UUy7RRCC-8zSimglouKlqa3Q', 'Visit Utah'],
  ['UUOGzEUB9F0-tfeYHzTj3cgQ', 'Visit Colorado'],
  ['UUTKQETAT33j2Gukan7-yKEQ', 'Pure Michigan'],
  ['UUfnkzN14Mplb3U8VFU5YuPw', 'Visit North Carolina'],
  ['UU1EzZHIWf382f_tyaZ5zOmA', 'Travel Wisconsin']
];
const IDX_FRESH = 7 * 864e5;
let chanIdx = [], chanIdxAt = 0, chanIdxBusy = null;
async function idxBuild(){
  const out = [];
  for (const [pl, name] of CHANNELS){
    let tok = '', got = 0;
    for (let page = 0; page < 30; page++){
      const up = await upstream('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=' + pl + (tok ? '&pageToken=' + tok : '') + '&key=' + YT_KEY);
      if (up.status !== 200) break;
      let j; try { j = JSON.parse(up.body); } catch (e){ break; }
      (j.items || []).forEach(it => {
        const sn = it.snippet || {}, id = sn.resourceId && sn.resourceId.videoId;
        if (!id || sn.title === 'Private video' || sn.title === 'Deleted video') return;
        out.push({ id, t: sn.title, c: name, p: (sn.publishedAt || '').slice(0, 10) }); got++;
      });
      tok = j.nextPageToken || '';
      if (!tok || got >= 1500) break;
    }
  }
  if (out.length > 500){ chanIdx = out; chanIdxAt = Date.now(); storeSet('meta:chanidx', out); }
  return chanIdx;
}
function idxEnsure(){
  if (!YT_KEY) return;
  if (!chanIdx.length){
    const j = storeGet('meta:chanidx');
    if (j && Array.isArray(j.data) && j.data.length){ chanIdx = j.data; chanIdxAt = j.t; }
  }
  if ((!chanIdx.length || Date.now() - chanIdxAt > IDX_FRESH) && !chanIdxBusy){
    chanIdxBusy = idxBuild().catch(() => chanIdx).finally(() => { chanIdxBusy = null; });
  }
}
function rxWord(w){ return new RegExp('(^|[^a-z0-9])' + w.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, '\\s+') + '([^a-z0-9]|$)', 'i'); }
async function idxDetail(hits){
  hits = hits.slice(0, 50);
  if (!hits.length) return [];
  const meta = {};
  const v = await upstream('https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=' + hits.map(x => x.id).join(',') + '&key=' + YT_KEY);
  if (v.status === 200) JSON.parse(v.body).items.forEach(it => meta[it.id] = { views: parseInt((it.statistics || {}).viewCount || '0', 10), secs: isoSecs((it.contentDetails || {}).duration) });
  return hits.filter(x => meta[x.id]).map(x => ({ id: x.id, title: x.t, channel: x.c, published: x.p, views: meta[x.id].views, secs: meta[x.id].secs, tier: 0 }))
    .sort((a, b) => b.views - a.views);
}
async function idxPack(place){
  idxEnsure();
  const city = (place.split(',')[0] || '').replace(/ county$/i, '').trim();
  if (city.length < 3 || !chanIdx.length) return [];
  const rx = rxWord(city);
  return idxDetail(chanIdx.filter(x => rx.test(x.t)));
}
function packMerge(a, b){
  const seen = {}, out = [];
  a.concat(b).forEach(x => { if (!seen[x.id]){ seen[x.id] = 1; out.push(x); } });
  return out.sort((x, y) => x.tier - y.tier || y.views - x.views);
}
async function packFetch(place){
  if (Date.now() < ytDownUntil) throw limitedErr();
  if (!spend('yt')) throw limitedErr();
  const parts = place.split(',').map(x => x.trim()).filter(Boolean);
  const city = (parts[0] || '').replace(/ county$/i, '').toLowerCase(), state = (parts[1] || '').toLowerCase();
  const after = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10) + 'T00:00:00Z';
  const s = await upstream('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short&order=relevance&maxResults=50&regionCode=US&relevanceLanguage=en&publishedAfter=' + after +
    '&q=' + encodeURIComponent(place + ' travel things to do #shorts') + '&key=' + YT_KEY);
  if (s.status === 403 || s.status === 429){ ytDownUntil = Date.now() + 30 * 60000; throw limitedErr(); }
  if (s.status !== 200) throw new Error('youtube ' + s.status);
  const items = (JSON.parse(s.body).items || []).filter(i => i.id && i.id.videoId);
  const ids = items.map(i => i.id.videoId);
  const meta = {};
  if (ids.length){
    const v = await upstream('https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=' + ids.join(',') + '&key=' + YT_KEY);
    if (v.status === 200) JSON.parse(v.body).items.forEach(it => meta[it.id] = { views: parseInt((it.statistics || {}).viewCount || '0', 10), secs: isoSecs((it.contentDetails || {}).duration) });
  }
  let list = items.map(i => {
    const text = ((i.snippet.title || '') + ' ' + (i.snippet.description || '')).toLowerCase();
    const m = meta[i.id.videoId] || { views: 0, secs: 9999 };
    return { id: i.id.videoId, title: i.snippet.title, channel: i.snippet.channelTitle, published: (i.snippet.publishedAt || '').slice(0, 10), views: m.views, secs: m.secs,
      tier: (city && text.indexOf(city) > -1) ? 0 : ((state && text.indexOf(state) > -1) ? 1 : 2) };
  }).filter(x => x.tier < 2);
  let extra = [];
  try { extra = await idxPack(place); } catch (e) {}
  list = packMerge(list, extra);
  packSave(place, list, true);
  wantDrop(place);
  return list;
}
function packOnce(place){
  const k = packKey(place);
  if (!packBusy[k]) packBusy[k] = packFetch(place).finally(() => { delete packBusy[k]; });
  return packBusy[k];
}
async function ytPack(place){
  const have = packRead(place);
  if (have && have.full){
    if (Date.now() - have.t > PACK_FRESH) packOnce(place).catch(() => {});
    return have.list;
  }
  try { return await packOnce(place); }
  catch (e){
    if (!(e && e.limited)) throw e;
    wantAdd(place);
    if (have && have.list.length) return have.list;
    const list = await idxPack(place).catch(() => []);
    if (list.length){ packSave(place, list, false); return list; }
    throw e;
  }
}
async function ytShorts(place){
  const list = await ytPack(place);
  const pick = x => ({ id: x.id, title: x.title, channel: x.channel, views: x.views, secs: x.secs });
  const short = list.filter(x => x.secs <= 180), long = list.filter(x => x.secs > 180).sort((a, b) => b.views - a.views);
  return short.concat(long).slice(0, 14).map(pick);
}
async function idxSearch(q){
  idxEnsure();
  const words = q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && ['travel', 'things', 'to', 'do', 'in', 'the', 'fun', 'tips', 'videos'].indexOf(w) < 0);
  for (let n = Math.min(words.length, 4); n >= 1; n--){
    const phrase = words.slice(0, n).join(' ');
    if (phrase.length < 4) break;
    const rx = rxWord(phrase), hits = chanIdx.filter(x => rx.test(x.t));
    if (hits.length){
      const d = await idxDetail(hits);
      return d.map(x => ({ id: x.id, title: x.title, channel: x.channel, published: x.published, thumb: 'https://i.ytimg.com/vi/' + x.id + '/mqdefault.jpg', views: x.views }));
    }
  }
  return [];
}

const STATE_NAME = { AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California', CO:'Colorado', CT:'Connecticut', DE:'Delaware', DC:'District of Columbia', FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York', NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia', WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming' };
let seedPlaces = null;
function seedList(){
  if (seedPlaces) return seedPlaces;
  seedPlaces = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'perdiem-fy2026.json'), 'utf8'));
    const seen = {};
    (j.rows || []).forEach(r => {
      if (!r.c || r.c === 'Standard Rate' || !STATE_NAME[r.s]) return;
      const place = r.c.split('/')[0].trim() + ', ' + STATE_NAME[r.s];
      if (!seen[place]){ seen[place] = 1; seedPlaces.push(place); }
    });
  } catch (e) {}
  return seedPlaces;
}
let seedAt = 0;
function prefillTick(){
  if (!storeOn || !YT_KEY || Date.now() < ytDownUntil) return;
  spendRoll();
  const reserve = quotaHour() >= 20 ? 5 : 50;
  if ((spent.yt || 0) >= BUDGET.yt - reserve) return;
  let place = wanted.find(x => !(packRead(x) || {}).full);
  if (!place){
    const seeds = seedList();
    for (let n = 0; n < seeds.length && !place; n++){
      const c = seeds[(seedAt + n) % seeds.length];
      const have = packRead(c);
      if (!have || !have.full || Date.now() - have.t > PACK_FRESH){ place = c; seedAt = (seedAt + n + 1) % seeds.length; }
    }
  }
  if (place) packOnce(place).catch(() => {});
}

async function handleShorts(reqUrl, res){
  if (!YT_KEY) return json(res, 501, { error: 'youtube not configured' });
  const place = (reqUrl.searchParams.get('place') || '').trim().slice(0, 80);
  if (!place) return json(res, 400, { error: 'missing place' });
  try { json(res, 200, await ytShorts(place)); }
  catch (e){ json(res, e && e.limited ? 429 : 502, { error: e && e.limited ? 'video limit reached' : 'youtube unavailable' }); }
}
async function handleVideos(reqUrl, res){
  if (!YT_KEY) return json(res, 501, { error: 'youtube not configured' });
  const q = (reqUrl.searchParams.get('q') || '').trim();
  if (!q) return json(res, 400, { error: 'missing q' });
  try { json(res, 200, await ytSearch(q)); }
  catch (e){
    if (e && e.limited){
      const alt = await idxSearch(q).catch(() => []);
      if (alt.length) return json(res, 200, alt);
    }
    json(res, e && e.limited ? 429 : 502, { error: e && e.limited ? 'video limit reached' : 'youtube unavailable' });
  }
}

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
  const ytq = q.replace(/\s+/g, ' ').slice(0, 120);
  let limited = false;
  const jobs = [];
  const pm = /^fun things to do in (.+)$/i.exec(ytq);
  if (YT_KEY && pm){
    const place = pm[1].replace(/ USA$/i, '').trim();
    let list = [];
    try { list = await ytPack(place); } catch (e){ if (e && e.limited) limited = true; }
    if (list.length) limited = false;
    const results = list.slice().sort((a, b) => b.views - a.views).slice(0, 16).map(x => ({
      plat: 'youtube', title: x.title, url: 'https://www.youtube.com/watch?v=' + x.id,
      thumb: 'https://i.ytimg.com/vi/' + x.id + '/mqdefault.jpg', meta: x.channel + (x.published ? ' · ' + x.published : ''), engagement: x.views, kind: 'views',
    }));
    return json(res, 200, { query: q, used: ytq, limited, stored: true,
      connected: { youtube: true, reddit: !!(RD_ID && RD_SECRET), google: !!(G_KEY && G_CX), tiktok: false, instagram: false, facebook: false },
      results, web: [] });
  }
  if (YT_KEY) jobs.push(ytSearch(ytq).then(v => v.map(x => ({
    plat: 'youtube', title: x.title, url: 'https://www.youtube.com/watch?v=' + x.id,
    thumb: x.thumb, meta: x.channel + (x.published ? ' · ' + x.published : ''), engagement: x.views, kind: 'views',
  }))).catch(e => { if (e && e.limited) limited = true; return []; }));
  if (RD_ID && RD_SECRET) jobs.push(rdSearch(cq).then(v => v.map(x => ({
    plat: 'reddit', title: x.title, url: x.url, thumb: '',
    meta: 'r/' + x.sub + ' · ' + x.comments + ' comments', engagement: x.ups, kind: 'upvotes',
  }))).catch(() => []));
  const webJob = (G_KEY && G_CX) ? gSearch(cq).catch(() => []) : Promise.resolve([]);
  const [parts, web] = await Promise.all([Promise.all(jobs), webJob]);
  const all = [].concat(...parts);
  all.forEach(r => r.score = Math.log10(Math.max(1, r.engagement)));
  all.sort((a, b) => b.score - a.score);
  const out = {
    query: q, used: ytq, limited,
    connected: { youtube: !!YT_KEY, reddit: !!(RD_ID && RD_SECRET), google: !!(G_KEY && G_CX), tiktok: false, instagram: false, facebook: false },
    results: all.slice(0, 16),
    web: web.slice(0, 6),
  };
  if (all.length || web.length) cset(key, out, 3600 * 1000);
  json(res, 200, out);
}

async function handleEvents(reqUrl, res){
  if (!TM_KEY) return json(res, 501, { error: 'events not configured' });
  const lat = parseFloat(reqUrl.searchParams.get('lat')), lng = parseFloat(reqUrl.searchParams.get('lng'));
  if (!isFinite(lat) || !isFinite(lng)) return json(res, 400, { error: 'lat/lng required' });
  const dISO = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().slice(0, 10);
  let ds = dISO.test(reqUrl.searchParams.get('start') || '') ? reqUrl.searchParams.get('start') : today;
  if (ds < today) ds = today;
  let de = dISO.test(reqUrl.searchParams.get('end') || '') ? reqUrl.searchParams.get('end') : '';
  if (de && de < ds) de = '';
  const win = (ds ? '&startDateTime=' + ds + 'T00:00:00Z' : '') + (de ? '&endDateTime=' + de + 'T23:59:59Z' : '');
  const key = 'ev:' + lat.toFixed(2) + ',' + lng.toFixed(2) + ':' + ds + '-' + de;
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
      lat: parseFloat((((((e._embedded || {}).venues) || [])[0] || {}).location || {}).latitude) || undefined,
      lng: parseFloat((((((e._embedded || {}).venues) || [])[0] || {}).location || {}).longitude) || undefined,
      img: (((e.images || []).filter(i => i.ratio === '16_9' && (i.width || 0) >= 500).sort((a, b) => (a.width || 0) - (b.width || 0))[0]) || (e.images || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0] || {}).url || '',
      price: ((e.priceRanges || [])[0] || {}).min || null,
    }));
    cset(key, out, 6 * 3600 * 1000);
    json(res, 200, out);
  } catch (e){ json(res, 502, { error: 'events unavailable' }); }
}

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
  const key = 'ht:' + lat.toFixed(2) + ',' + lng.toFixed(2) + ':' + ci + '-' + co;
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
  const stopsParam = reqUrl.searchParams.get('stops');
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
    cset(key, data, 7 * 24 * 3600 * 1000);
    json(res, 200, data);
  } catch (e){
    if (e && e.status === 400 && (e.code === 170 || e.code === 442 || e.code === 171)) return json(res, 422, { error: 'noroad' });
    json(res, 502, { error: 'router unavailable' });
  }
}

function gcMiles(a, b){ return milesLL(a.lat, a.lon, b.lat, b.lon); }
function milesLL(a, b, c, d){ const R = 3959, t = Math.PI / 180, dl = (c - a) * t, dn = (d - b) * t;
  const x = Math.sin(dl/2)**2 + Math.cos(a*t) * Math.cos(c*t) * Math.sin(dn/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }
const LEG_CAP_MI = 780;
function splitChain(locs){
  const out = [locs[0]];
  for (let i = 1; i < locs.length; i++){
    let seg = [locs[i - 1], locs[i]];
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
  if (up.status !== 200){
    const err = new Error('router ' + up.status); err.status = up.status;
    try { err.code = JSON.parse(up.body).error_code; } catch (e) {}
    throw err;
  }
  return JSON.parse(up.body);
}
const NUDGES = [2.4, 1.6, 3.5];
const SNAP_M = 600000;
function shapeEnd(trip){
  const legs = (trip && trip.legs) || [], s = legs.length ? legs[legs.length - 1].shape : '';
  if (!s) return null;
  let i = 0, lat = 0, lon = 0;
  while (i < s.length){
    for (let k = 0; k < 2; k++){
      let shift = 0, r = 0, c;
      do { c = s.charCodeAt(i++) - 63; r |= (c & 0x1f) << shift; shift += 5; } while (c >= 0x20 && i < s.length);
      const d = (r & 1) ? ~(r >> 1) : (r >> 1);
      if (k === 0) lat += d; else lon += d;
    }
  }
  return { lat: lat / 1e6, lon: lon / 1e6 };
}
async function routeVia(a, b, costing, depth, st){
  if (gcMiles(a, b) <= LEG_CAP_MI){
    if (++st.calls > 28) throw new Error('too many legs');
    try {
      const part = await valhallaOnce([a, b], costing, 0);
      if (!part.trip || !part.trip.legs) throw new Error('leg missing');
      return [part.trip];
    } catch (e){ if (e.status !== 400 || e.code === 170 || depth >= 3 || (depth > 0 && e.code !== 154)) throw e; }
  }
  if (depth >= 4){ const e = new Error('route too deep'); e.status = 400; throw e; }
  const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const k = Math.cos(mid.lat * Math.PI / 180) || 1;
  const vy = b.lat - a.lat, vx = (b.lon - a.lon) * k, vl = Math.sqrt(vy * vy + vx * vx) || 1;
  const py = -vx / vl, px = vy / vl / k;
  const miles = parts => parts.reduce((t, x) => t + ((x.summary && x.summary.length) || 0), 0);
  let last = null, best = null, sign = 0;
  const via = async n => {
    const c = { lat: mid.lat + py * n, lon: mid.lon + px * n, search_cutoff: SNAP_M };
    const left = await routeVia(a, c, costing, depth + 1, st);
    const end = shapeEnd(left[left.length - 1]);
    const right = await routeVia(c, b, costing, depth + 1, st);
    const land = !end || gcMiles(c, end) < 15;
    if (n === 0 && end && !land) sign = ((end.lat - c.lat) * py + (end.lon - c.lon) * k * px * k) >= 0 ? 1 : -1;
    return { parts: left.concat(right), land };
  };
  try {
    const r0 = await via(0);
    if (r0.land || depth > 0) return r0.parts;
    best = r0.parts;
  } catch (e){ last = e; if (e.status !== 400) throw e; }
  const order = sign ? NUDGES.map(n => n * sign) : NUDGES.reduce((o, n) => o.concat([n, -n]), []);
  for (const n of order){
    if (st.calls > 18) break;
    try {
      const r = await via(n);
      if (!best || miles(r.parts) < miles(best)) best = r.parts;
    } catch (e){ last = e; if (e.status !== 400) throw e; }
  }
  if (best) return best;
  throw last || new Error('no route');
}
async function routeAnyDistance(locations, costing){
  const chain = splitChain(locations);
  if (chain.length === locations.length){
    try { return await valhallaOnce(locations, costing, locations.length > 2 ? 0 : 2); }
    catch (e){ if (e.status !== 400) throw e; }
  }
  const st = { calls: 0 };
  const trips = [];
  for (let i = 1; i < locations.length; i++){
    const parts = await routeVia(locations[i - 1], locations[i], costing, 0, st);
    trips.push(...parts);
  }
  const legs = [], sum = { length: 0, time: 0 };
  trips.forEach(t => { legs.push(...t.legs); sum.length += (t.summary && t.summary.length) || 0; sum.time += (t.summary && t.summary.time) || 0; });
  return { trip: { legs, summary: sum, status: 0 } };
}

const MIME = { '.html':'text/html;charset=utf-8', '.js':'text/javascript;charset=utf-8', '.css':'text/css;charset=utf-8',
  '.json':'application/json;charset=utf-8', '.geojson':'application/json;charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.webp':'image/webp', '.map':'application/json' };
const STATIC_DENY = /^(secrets\.json|server\.js|docs|scripts|graphify-out|data|data-backup-0821)([\/\\]|$)|(^|[\/\\])\./i;
function serveStatic(pathname, res){
  let rel;
  try { rel = decodeURIComponent(pathname); }
  catch (e){ return json(res, 400, { error: 'bad path' }); }
  if (rel === '/' || rel === '') rel = '/globe.html';
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT + path.sep)){ return json(res, 403, { error: 'forbidden' }); }
  if (STATIC_DENY.test(path.relative(ROOT, full).toLowerCase())){ return json(res, 403, { error: 'forbidden' }); }
  fs.stat(full, (serr, st) => {
    if (serr || !st.isFile()){ return json(res, 404, { error: 'not found' }); }
    fs.readFile(full, (err, buf) => {
      if (err){ return json(res, 404, { error: 'not found' }); }
      const ext = path.extname(full).toLowerCase();
      const cc = full.indexOf(path.sep + 'vendor' + path.sep) >= 0
        ? 'public, max-age=31536000, immutable' : 'no-cache';
      const h = Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cc, 'Vary': 'Accept-Encoding' }, SECURITY);
      const ae = (res.req && res.req.headers['accept-encoding']) || '';
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

const PUBLIC_HOSTS = ORIGINS.map(o => { try { return new URL(o).host.toLowerCase(); } catch (e) { return ''; } }).filter(Boolean);
function hostOk(req){
  const h = String(req.headers.host || '').toLowerCase();
  return h === `localhost:${PORT}` || h === `127.0.0.1:${PORT}` ||
         h === 'localhost' || h === '127.0.0.1' || h === `[::1]:${PORT}` ||
         PUBLIC_HOSTS.includes(h);
}
http.createServer((req, res) => {
 try {
  if (req.url === '/healthz') return json(res, 200, { ok: true });
  if (!hostOk(req)) return json(res, 403, { error: 'forbidden host' });
  if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  const u = new URL(req.url, 'http://localhost');
  res.on('finish', () => { if (res.statusCode >= 500) console.warn(`[fail] ${res.statusCode} ${u.pathname}`); });
  if (u.pathname.startsWith('/api/')) {
    if (!originOk(req)) return json(res, 403, { error: 'forbidden origin' });
    if (!rateOk(clientIP(req))) return json(res, 429, { error: 'rate limited; slow down' });
    if (u.pathname === '/api/trips/peek'){
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      return void handleTripPeek(u, res);
    }
    const sm = /^\/api\/trips\/([a-z0-9]{10})\/sugg(?:\/([0-9a-f]{8}))?$/.exec(u.pathname);
    if (sm){
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (sm[2]) return void guard(handleSuggDecide(req, res, sm[1], sm[2]), res);
      return void guard(handleSuggAdd(req, res, sm[1]), res);
    }
    const tm = /^\/api\/trips(?:\/([a-z0-9]{10}))?$/.exec(u.pathname);
    if (tm){
      if (req.method === 'POST' && !tm[1]) return void guard(handleTripSave(req, res, ''), res);
      if (req.method === 'PUT' && tm[1]) return void guard(handleTripSave(req, res, tm[1]), res);
      if (req.method === 'GET' && tm[1]) return void handleTripGet(res, tm[1]);
      return json(res, 405, { error: 'method not allowed' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    if (u.pathname === '/api/geocode') return void guard(handleGeocode(u, res), res);
    if (u.pathname === '/api/route')   return void guard(handleRoute(u, res), res);
    if (u.pathname === '/api/gas')     return void guard(handleGas(u, res), res);
    if (u.pathname === '/api/reverse') return void guard(handleReverse(u, res), res);
    if (u.pathname === '/api/sights')  return void guard(handleSights(u, res), res);
    if (u.pathname === '/api/street')  return void guard(handleStreet(u, res), res);
    if (u.pathname === '/api/social/status') return void guard(handleSocialStatus(res), res);
    if (u.pathname === '/api/social/videos') return void guard(handleVideos(u, res), res);
    if (u.pathname === '/api/social/shorts') return void guard(handleShorts(u, res), res);
    if (u.pathname === '/api/social/reddit') return void guard(handleReddit(u, res), res);
    if (u.pathname === '/api/social/aggregate') return void guard(handleAggregate(u, res), res);
    if (u.pathname === '/api/social/google') return void guard(handleGoogle(u, res), res);
    if (u.pathname === '/api/stays/hotels')  return void guard(handleHotels(u, res), res);
    if (u.pathname === '/api/stays/osm')     return void guard(handleStaysOsm(u, res), res);
    if (u.pathname === '/api/guide')         return void guard(handleGuide(u, res), res);
    if (u.pathname === '/api/places')        return void guard(handlePlaces(u, res), res);
    if (u.pathname === '/api/events')        return void guard(handleEvents(u, res), res);
    return json(res, 404, { error: 'unknown endpoint' });
  }
  if ((u.pathname === '/' || u.pathname === '/globe.html') && /^[a-z0-9]{10}$/.test(u.searchParams.get('t') || '')) return serveTripPage(u.searchParams.get('t'), req, res);
  serveStatic(u.pathname, res);
 } catch (e) {
  try { json(res, 400, { error: 'bad request' }); } catch (e2) {}
 }
}).listen(PORT, HOST, () => {
  storeInit();
  tripInit();
  if (storeOn){
    const w = storeGet('meta:wanted'); if (w && Array.isArray(w.data)) wanted = w.data;
    setInterval(prefillTick, 3 * 60000).unref();
    setInterval(storeTrim, 6 * 3600000).unref();
    setInterval(tripTrim, 6 * 3600000).unref();
    idxEnsure();
    setInterval(idxEnsure, 6 * 3600000).unref();
  }
  console.log('Store: ' + (storeOn ? ('on at ' + STORE_DIR + ', ' + storeCount + ' saved') : 'off (memory only)'));
  if (PUBLIC){
    console.log(`Voyage PUBLIC on ${HOST}:${PORT}; origins: ${ORIGINS.join(', ')}; trust proxy: ${TRUST_PROXY}`);
  } else {
    console.log(`Voyage running PRIVATELY at http://localhost:${PORT}/globe.html`);
    console.log(`Bound to ${HOST} only — not reachable from other devices or the internet.`);
  }
});
