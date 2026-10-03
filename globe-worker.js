'use strict';

self.window = self;
function fakeNode(tag){
  var listeners = {};
  return {
    nodeName: String(tag || 'div').toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    classList: { add: function(){}, remove: function(){}, contains: function(){ return false; }, toggle: function(){} },
    setAttribute: function(k, v){ this.attributes[k] = v; },
    getAttribute: function(k){ return this.attributes[k]; },
    appendChild: function(c){ this.children.push(c); return c; },
    removeChild: function(c){ var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore: function(c){ this.children.push(c); return c; },
    addEventListener: function(t, f){ (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: function(t, f){ var a = listeners[t] || []; var i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    dispatchEvent: function(e){ (listeners[e.type] || []).slice().forEach(function(f){ f(e); }); return true; },
    getBoundingClientRect: function(){ return { left: 0, top: 0, x: 0, y: 0, width: W, height: H, right: W, bottom: H }; },
    getRootNode: function(){ return self.document; },
    querySelector: function(){ return null; },
    contains: function(){ return false; },
    ownerDocument: null,
    set innerHTML(v){}, get innerHTML(){ return ''; },
    set textContent(v){}, get textContent(){ return ''; },
    get clientWidth(){ return W; }, get clientHeight(){ return H; },
    get offsetWidth(){ return W; }, get offsetHeight(){ return H; }
  };
}
function fakeImg(){
  var c = new OffscreenCanvas(1, 1);
  c.crossOrigin = '';
  Object.defineProperty(c, 'src', { set: function(v){
    fetch(v).then(function(r){ if (!r.ok) throw 0; return r.blob(); })
      .then(function(b){ return createImageBitmap(b); })
      .then(function(bm){
        c.width = bm.width; c.height = bm.height;
        c.getContext('2d').drawImage(bm, 0, 0);
        c.dispatchEvent(new Event('load'));
      })
      .catch(function(){ c.dispatchEvent(new Event('error')); });
  } });
  return c;
}
self.document = fakeNode('#document');
document.createElement = function(t){ return String(t).toLowerCase() === 'img' ? fakeImg() : fakeNode(t); };
document.createElementNS = function(ns, t){ return String(t).toLowerCase() === 'img' ? fakeImg() : fakeNode(t); };
document.head = fakeNode('head');
document.body = fakeNode('body');
document.documentElement = { scrollLeft: 0, scrollTop: 0, style: {} };
document.getElementById = function(){ return null; };
document.createTextNode = function(){ return fakeNode('text'); };
self.devicePixelRatio = 1;
var W = 300, H = 300;

self.addEventListener('error', function(e){
  try { self.postMessage({ ev: 'werr', message: String(e.message), stack: String(e.error && e.error.stack || '').slice(0, 900) }); } catch (x) {}
});

importScripts('vendor/globe.gl-2.34.4.min.js');

var world = null, canvas = null, accentRGB = [58, 182, 125], RMreduce = false;
var pins = [], pinTick = 0;

function hexRGB(h){ h = (h || '').replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

function init(msg){
  canvas = msg.canvas;
  W = msg.width; H = msg.height;
  self.devicePixelRatio = msg.dpr || 1;
  accentRGB = hexRGB(msg.accent);
  RMreduce = !!msg.reducedMotion;
  canvas.style = {};
  try { Object.defineProperty(canvas, 'clientWidth', { get: function(){ return W; } }); } catch (e) {}
  try { Object.defineProperty(canvas, 'clientHeight', { get: function(){ return H; } }); } catch (e) {}
  canvas.getBoundingClientRect = function(){ return { left: 0, top: 0, x: 0, y: 0, width: W, height: H, right: W, bottom: H }; };
  canvas.classList = { add: function(){}, remove: function(){}, contains: function(){ return false; }, toggle: function(){} };
  canvas.setPointerCapture = function(){};
  canvas.releasePointerCapture = function(){};
  canvas.ownerDocument = self.document;
  canvas.getRootNode = function(){ return self.document; };

  var container = fakeNode('div');
  var accent = msg.accent;

  world = Globe({ rendererConfig: { canvas: canvas, antialias: true, alpha: true } })(container)
    .width(W).height(H)
    .globeImageUrl('vendor/earth-dark.jpg')
    .backgroundColor('rgba(0,0,0,0)')
    .atmosphereColor(accent).atmosphereAltitude(0.2)
    .pointsData(msg.overview || []).pointLat('lat').pointLng('lng').pointAltitude(0.012)
      .pointRadius(0.34).pointColor(function(d){ return d.sample ? '#A2E494' : rgbaAccent(1); }).pointsMerge(false)
    .onPointClick(function(d){ post({ ev: 'pointClick', st: d.st }); })
    .ringColor(function(){ return function(t){ return 'rgba(' + accentRGB.join(',') + ',' + (1 - t) + ')'; }; })
    .ringMaxRadius(0.95).ringPropagationSpeed(0.7).ringRepeatPeriod(RMreduce ? 0 : 900);
  world.arcColor(function(){ return ['rgba(' + accentRGB.join(',') + ',0.95)', 'rgba(' + accentRGB.join(',') + ',0.15)']; })
    .arcStroke(0.7).arcDashLength(0.4).arcDashGap(0.18).arcDashAnimateTime(2200).arcAltitudeAutoScale(0.45);
  world.pointOfView(msg.pov, 0);
  world.controls().autoRotate = !RMreduce;
  world.controls().autoRotateSpeed = 0.55;
  world.controls().enableDamping = true;
  var gm = world.globeMaterial && world.globeMaterial();
  if (gm){ if (gm.color) gm.color.set('#173A61'); if (gm.emissive) gm.emissive.set('#0A2140'); if ('emissiveIntensity' in gm) gm.emissiveIntensity = 0.3; if ('shininess' in gm) gm.shininess = 9; }
  world.hexPolygonResolution(3).hexPolygonMargin(0.26).hexPolygonAltitude(0.008)
    .hexPolygonColor(function(){ return 'rgba(' + accentRGB.join(',') + ',0.5)'; });

  fetch('vendor/countries-110m.min.geojson')
    .then(function(r){ return r.json(); }).then(function(j){
      var feats = j.features || j, i = 0, CH = 3;
      (function step(){
        i = Math.min(feats.length, i + CH);
        world.hexPolygonsData(feats.slice(0, i));
        if (i < feats.length) requestAnimationFrame(step);
      })();
    }).catch(function(){});

  var readySent = false;
  function sendReady(){ if (!readySent){ readySent = true; post({ ev: 'ready' }); } }
  if (world.onGlobeReady) world.onGlobeReady(sendReady);
  (function chk(n){
    if (readySent) return;
    try { var r = world.renderer(); if (r && r.info && r.info.render.frame > 0){ sendReady(); return; } } catch (e) {}
    if (n > 60){ post({ ev: 'error', op: 'ready', message: 'no frames rendered' }); return; }
    setTimeout(function(){ chk(n + 1); }, 100);
  })(0);
  requestAnimationFrame(pinLoop);
}

function rgbaAccent(a){ return 'rgba(' + accentRGB.join(',') + ',' + a + ')'; }

function pinLoop(){
  requestAnimationFrame(pinLoop);
  if (!world || !pins.length) return;
  if ((pinTick = (pinTick + 1) % 2)) return;
  var cam = world.camera();
  if (!cam) return;
  cam.updateMatrixWorld();
  var pv = mat4mul(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements);
  var cp = cam.position, cl = Math.sqrt(cp.x * cp.x + cp.y * cp.y + cp.z * cp.z);
  var out = [];
  for (var i = 0; i < pins.length; i++){
    var c = world.getCoords(pins[i].lat, pins[i].lng, 0.02);
    var r = Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z);
    var facing = (c.x * cp.x + c.y * cp.y + c.z * cp.z) / (r * cl);
    var vis = facing > (r / cl) * 0.99;
    var clip = apply4(pv, c.x, c.y, c.z);
    if (clip[3] <= 0){ out.push([i, 0, 0, 0]); continue; }
    var sx = (clip[0] / clip[3] + 1) / 2 * W;
    var sy = (1 - clip[1] / clip[3]) / 2 * H;
    out.push([i, Math.round(sx), Math.round(sy), vis ? 1 : 0]);
  }
  post({ ev: 'pins', p: out });
}
function mat4mul(a, b){
  var o = new Array(16);
  for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++){
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function apply4(m, x, y, z){
  return [m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
          m[3] * x + m[7] * y + m[11] * z + m[15]];
}

function post(o){ self.postMessage(o); }

self.onmessage = function(e){
  var m = e.data;
  try {
    switch (m.op){
      case 'init': init(m); break;
      case 'call': if (world) world[m.name].apply(null, m.args); break;
      case 'ctrl': if (world) world.controls()[m.key] = m.value; break;
      case 'size':
        W = m.width; H = m.height;
        if (world) world.width(W).height(H);
        break;
      case 'theme':
        accentRGB = hexRGB(m.accent);
        if (world){
          world.atmosphereColor(m.accent);
          world.hexPolygonColor(function(){ return 'rgba(' + accentRGB.join(',') + ',0.5)'; });
        }
        break;
      case 'pins':
        pins = m.items || [];
        if (!pins.length) post({ ev: 'pins', p: [] });
        break;
      case 'stats':
        var rr = world && world.renderer(), cc = world && world.camera(), ss = world && world.scene();
        var meshes = 0, vis = 0, mats = {};
        if (ss) ss.traverse(function(o){ if (o.isMesh || o.isPoints || o.isLine){ meshes++; if (o.visible) vis++; var t = (o.material && o.material.type) || '?'; mats[t] = (mats[t] || 0) + 1; } });
        post({ ev: 'stats', meshes: meshes, visMeshes: vis, mats: mats,
               frame: rr && rr.info && rr.info.render.frame, calls: rr && rr.info && rr.info.render.calls,
               cam: cc ? { x: Math.round(cc.position.x), y: Math.round(cc.position.y), z: Math.round(cc.position.z) } : null,
               kids: ss ? ss.children.length : -1, w: W, h: H,
               cw: canvas ? canvas.width : -1, ch: canvas ? canvas.height : -1 });
        break;
      case 'pointer':
        if (!canvas) break;
        var ev = new Event(m.type);
        ev.clientX = m.x; ev.clientY = m.y; ev.pageX = m.x; ev.pageY = m.y;
        ev.offsetX = m.x; ev.offsetY = m.y;
        ev.button = m.button || 0; ev.buttons = m.buttons || 0;
        ev.pointerId = m.pointerId || 1; ev.pointerType = m.pointerType || 'mouse';
        ev.deltaY = m.deltaY || 0; ev.deltaMode = 0;
        ev.ctrlKey = !!m.ctrlKey; ev.shiftKey = !!m.shiftKey; ev.metaKey = false; ev.altKey = false;
        ev.preventDefault = function(){}; ev.stopPropagation = function(){};
        canvas.dispatchEvent(ev);
        self.document.dispatchEvent(ev);
        break;
    }
  } catch (err){
    post({ ev: 'error', message: String(err && err.message || err), op: m.op });
  }
};
