# Voyage — scripts

Gate and measurement tooling. Python 3.8+, stdlib only; no crash-data pipeline
lives here any more (Voyage cut the crash datasets on 2026-08-27; the old
`build-fars.js` and `data/` are gone).

| Script | What it does |
|--------|--------------|
| `smoke_test.py` | The correctness gate. Static + hardening checks, crash-pipeline-removed negative tests, geocode/route contracts, and three live CDP flows (drive / fly / boat). Exit 0 only when every check passes. Run after every change: `python scripts/smoke_test.py` |
| `mobile_shot.py` | True mobile-viewport screenshots + async CDP probes over DevTools (plain `--window-size` lies below ~500px). `python scripts/mobile_shot.py <url> <w> <h> <out.png> [--full] [--eval JS] [--await] [--settle N]` |
| `perf_probe.py` | Cold-profile perf medians (FCP/LCP/TBT/DCL) over CDP. |
| `pixel_gate.py` | Pixel-parity gate for geometry/asset swaps. |
| `content_probe.py` | Times first appearance of each content piece after a search (deep-link driven). |
| `geo_battery.py` / `geo_loop_test.py` | Geocoder soak tests across regions + route pairs; rerun after any geocode/routing change. |

Run the server first (`node server.js` from the project root), then the gates
against `http://127.0.0.1:8787`.
