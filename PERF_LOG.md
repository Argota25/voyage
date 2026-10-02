# Perf loop log

App: SafeRoute USA. Single-file client (globe.html, vendored globe.gl +
Leaflet) behind a zero-dependency Node proxy (server.js) on 127.0.0.1:8787.
Gate: `python scripts/smoke_test.py` (17 checks) + SMOKE.md manual list.
Measure: `python scripts/perf_probe.py` (5 cold-profile runs, median;
server warm; same machine). API: 10 timed curls, warm cache.

Targets: LCP < 1.2s · TBT < 150ms · JS transfer < 300KB gzipped ·
local/cached API p95 < 200ms.

Do not touch: upstream politeness queues, data honesty, security
hardening, the approved visual design, localhost binding.

Baseline notes: zero compression on any response (raw == with
Accept-Encoding for all 8 probed assets); globe.gl 1478KB, countries
geojson 839KB, page 188KB, national.json 239KB. LCP and API already meet
targets on localhost; TBT is 11.6x over target and transfer is 9x the
JS budget.

| iter | change | LCP | TBT | load | xfer | API p95 | smoke | verdict |
|---|---|---|---|---|---|---|---|---|
| 0 | baseline (104a71c) | 800ms | 1742ms | 594ms | 2700KB | 3.3ms | 17/17 | baseline |

| 1 | chunk hex tessellation feed (12 then 3 features per frame; three-globe joins by identity so nothing recomputes) | 696ms | 673ms | 538ms | 2701KB | - | 17/17 | KEPT: TBT -61%, visual identical (render compared) |
| 2 | gzip (zlib level 6) for html/js/css/json/geojson/svg, static + API, mtime-keyed cache, Vary set | 792ms | 667ms | 647ms | 796KB | - | 17/17 | KEPT: transfer -71% |
| 3 | font CSS: blocking @import inside <style> replaced with preconnect + parallel link | 768ms | 681ms | 629ms | 796KB | - | 17/17 | KEPT: removes a serialized round trip on real networks; localhost delta within noise; render compared identical |
| 4 | Cache-Control: vendor files immutable 1y (version-stamped names), app files stay no-cache | 768ms | 681ms | 629ms | 796KB cold / 52KB repeat | - | 17/17 | KEPT: repeat-view transfer -93% |
| 5 | brotli q10 for static (mtime-cached, gzip fallback; API stays gzip) | 740ms | 571ms | 615ms | 629KB | - | 17/17 | KEPT: transfer -21% vs gzip; TBT checked by back-to-back A/B (br 571 vs gz 528, spreads overlap - the first probe's 800ms was machine noise) |

## Final state vs targets (2026-08-22)

| target | baseline | final | met? |
|---|---|---|---|
| LCP < 1.2s | 800ms | 740ms | YES |
| TBT < 150ms | 1742ms | ~570ms (-67%) | NO - floor is vendor single-tasks |
| JS transfer < 300KB gz | 1478KB raw, no compression | 326KB br / 409KB gz (globe.gl) | NO - close; library is the floor |
| cached API p95 < 200ms | 3.3ms | 3.3ms | YES |
| cold page transfer | 2700KB | 629KB (-77%) | - |
| repeat-view transfer | 2700KB | 52KB (-98%) | - |

Remaining TBT floor (profiled, all inside vendor code as single long tasks):
globe.gl script eval ~360ms + WebGL context/scene init ~240ms + first
tessellation batch. Every remaining option changes behavior or
architecture - listed in the loop's final report for a human decision:
lazy globe init after first paint; worker + OffscreenCanvas; lighter
custom three.js scene; custom-built slim globe.gl; coarser geojson.

## Loop A: lazy globe boot (behavior change authorized 2026-08-22)

| iter | change | FCP | LCP | TBT | DCL | smoke | verdict |
|---|---|---|---|---|---|---|---|
| A0 | pre-loop (709d988) | 456ms | 752ms | 639ms | 577ms | 17/17 | baseline (FCP added to probe) |
| A1 | globe.gl eval + WebGL init deferred to post-first-paint (preload keeps the download early); world=null until boot; GLOBE_READY gates the 3 submit branches (deep links submit at load) + resize | 448ms | 800ms | 711ms | 373ms | 17/17 | KEPT: DCL -35% (handlers attach sooner, form usable sooner) and the gate architecture unlocks loops C/D. Honest note: predicted FCP gain did NOT appear - body-end sync scripts never blocked first paint. LCP/TBT deltas inside the documented noise band (LCP 740-868, TBT 528-815 on identical code). |

Loop A closed after A1: remaining ideas (defer leaflet ~50ms eval) are
sub-noise. The TBT floor moves to loop C (slimmer bundle = shorter eval
task) and loop B (geometry = shorter tessellation tasks).

## Loop B: geometry reduction

| iter | change | FCP | LCP | TBT | DCL | xfer | smoke | pixel gate | verdict |
|---|---|---|---|---|---|---|---|---|---|
| B1 | tools/simplify_countries.py: strip the unread 168-key property table (77% of the file), DP 0.1deg, 2-decimal quantize, drop rings <1000km2; app fetches countries-110m.min.geojson (819KB -> 134KB raw, all 177 features) | 440ms | 788ms | 578ms | 361ms | 530KB | 17/17 | PASS 0.013% (allow 0.5%) | KEPT: xfer -100KB, TBT -133ms (819KB JSON parse off the main thread) |

Loop C1 (precomputed h3 cells) CLOSED WITHOUT SHIPPING, on evidence:
chunked feeding (iter 1) already pushed every tessellation slice under
the 50ms longtask threshold, and B1 shrank the input 6x - the cost C1
would remove is no longer on the TBT radar, its ~40KB gz cell file would
UNDO most of B1's transfer win, and it carries real risk (antimeridian
polyfill, h3 version pinning). Wrong trade now; recon notes filed.

## Loop C: slimmer globe bundle - CLOSED WITHOUT SHIPPING, on evidence

Attempted: rollup UMD rebuild of globe.gl with tree-shaken THREE
(tools/slim-globe/, stats.mjs prints the per-package breakdown).
Numbers: naive rebuild 1884KB min / era-pinned (three@0.171,
three-globe@2.35) + typeface stub 1865KB min = 386KB brotli, VS the
official vendored UMD at 1443KB min = 318KB brotli. Tree-shaking cannot
drop the 8 unused layers (they are live references inside the composed
class) and globe.gl's dist pre-bundles its render stack; beating the
official build means forking three-globe source - a permanent
maintenance cost for roughly -25KB br and -40ms of eval that loop A
already moved off the critical path. The 300KB JS budget stands missed
at 318KB br (6% over) and is accepted; loop D attacks the same TBT far
harder (moves eval+init+render off the main thread entirely).

## Loop D: globe on a worker thread (OffscreenCanvas)

| iter | change | FCP | LCP | TBT | DCL | smoke | pixel gate | verdict |
|---|---|---|---|---|---|---|---|---|
| D1 | globe.gl runs in globe-worker.js against a transferred OffscreenCanvas: DOM shims for eval, canvas-backed img shim (fetch+createImageBitmap - THE root-cause fix: three's texture <img> never loaded, so three-globe kept the whole globe invisible), pointer-event forwarding, worker-projected pins driving the existing .gpin DOM, world proxy for all post-boot API calls, frame-proven readiness, automatic classic fallback (?noworker forces it) | 416ms | 568ms | 0ms | 344ms | 17/17 | bit-identical (0.000%, worker-verified in session) | KEPT |

Verification beyond the gate (all in worker mode, after the texture fix):
deep-link accident flow 4/4 clean runs (25 rows, 14 pins, zero errors);
interactive journey (flight renders with tracking pins, map opens, back
to globe restores the overview); drag rotates and wheel zooms through
the event proxy; phone viewport (390x844, DPR 2) works; classic path
still green via ?noworker. Honest notes: (1) the probe's xfer column
reads 411KB in worker mode because worker-context fetches are invisible
to the page's resource timing - real network transfer is unchanged at
~630KB cold; (2) an earlier TBT-0 reading before the texture fix was a
mirage (blank canvas + post-measurement fallback) - caught because the
pixel gate turned out to be photographing the fallback, and re-proven
after the fix with the worker verified live in the capture session.

## Final state vs targets (2026-08-22, all four loops closed)

| target | session start | final | met? |
|---|---|---|---|
| TBT < 150ms | 1742ms | 0ms | YES |
| LCP < 1.2s | 800ms | 568ms | YES |
| cached API p95 < 200ms | 3.3ms | 3.3ms | YES |
| JS transfer < 300KB gz | 1478KB raw uncompressed | 318KB brotli (globe.gl, worker-fetched off the critical path) | accepted 6% over (loop C evidence) |
| cold page transfer | 2700KB | ~630KB real (-77%) | - |
| repeat view | 2700KB | ~52KB (-98%) | - |

## Content-speed loop (2026-08-22): results after a search

Measured with scripts/content_probe.py (deep link, fresh browser, first
appearance of each content piece; choosers auto-answered like a user).
Recon: 3-agent workflow mapped every fetch chain first; fixes are pure
scheduling - no change to what data is claimed or shown.

| iter | change | evidence |
|---|---|---|
| S1 | getStatus: in-flight promise memo + 3s budget | a multi-stop trip fired ~12 duplicate /api/social/status calls; every slider paid a serial RTT first |
| S2 | commute: route fetch + scoring pool start at panel time, run in PARALLEL (stale-vehicle guarded); the 1300ms stage transition only reveals | route cards land WITH the stage (3.2s cold) instead of trailing it |
| S3 | roadtrip: national pool parallel with route; sights fetch starts at decode; panel renders BEFORE reverse geocodes (cards say "Finding the town..." then fill); label-dependent sliders gate on their own stop's label | 2-night trip: 4 stop cards at 3.7s cold (reverses used to sit in front through a 1.1s-spaced queue) |
| S4 | per-stop "Do" sliders reuse the route-wide sights pool (<=28mi) with the per-stop Overpass query as fallback only | zero extra Overpass round trips when the route pool is healthy |
| S5 | bounded waits: route sights 25s, per-stop fallback 12s (was untimed) | skeleton worst case during an Overpass outage: ~37s bounded, was 40-80s+ unbounded shimmer |
| S6 | prewarm getStatus+loadNational at intent choice; trip stop-geocoding runs in parallel with globe boot (only rendering gates) | removes 1-1.5s of dead serialization on trips |

Final cold-query numbers (17/17 smoke after every iteration):
accident: panel+rows+videos 2.4s · commute: panel 2.0s, route cards 3.2s
· 2-night trip: panel+stop cards+feed 4.1s, videos 4.8s. Do-slider
skeletons drain fast with a healthy Overpass (route-pool reuse) and cap
at ~37s during an upstream outage (measured live during one).
