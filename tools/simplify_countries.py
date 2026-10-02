#!/usr/bin/env python3
"""Shrink vendor/countries-110m.geojson for the hex globe. stdlib only.

The app reads ONLY coordinates (hexPolygonsData feeds an h3 res-3
tessellation whose hex edges are ~60km; color accessors take no feature
argument). So: drop every property, simplify rings with Douglas-Peucker
in degree space, quantize to 2 decimals (~1.1km), drop only rings whose
area cannot influence any hex (< MIN_KM2), keep all 177 features.

Output: vendor/countries-110m.min.geojson (minified). A pixel-diff gate
must pass before the app switches to it.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'vendor', 'countries-110m.geojson')
DST = os.path.join(HERE, '..', 'vendor', 'countries-110m.min.geojson')
TOL = 0.1        # degrees, Douglas-Peucker
DECIMALS = 2     # ~1.1km at the equator
MIN_KM2 = 1000.0  # strict tier: only rings far below hex size are dropped


def dp(points, tol):
    """Iterative Douglas-Peucker on [lng,lat] pairs (open ring)."""
    if len(points) < 3:
        return points[:]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        worst, wd = -1, -1.0
        for i in range(a + 1, b):
            px, py = points[i]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dx * (ay - py) - dy * (ax - px)) / norm
            if d > wd:
                worst, wd = i, d
        if wd > tol:
            keep[worst] = True
            stack.append((a, worst))
            stack.append((worst, b))
    return [p for p, k in zip(points, keep) if k]


def ring_km2(ring):
    """Equirectangular shoelace with cos-lat correction, km^2."""
    if len(ring) < 4:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = 111.32 * math.cos(math.radians(lat0))
    ky = 110.57
    area = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * kx, ring[i][1] * ky
        x2, y2 = ring[i + 1][0] * kx, ring[i + 1][1] * ky
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def clean_ring(ring):
    open_ring = ring[:-1] if ring[0] == ring[-1] else ring[:]
    simp = dp(open_ring, TOL)
    q = [[round(x, DECIMALS), round(y, DECIMALS)] for x, y in simp]
    out = [q[0]]
    for p in q[1:]:
        if p != out[-1]:
            out.append(p)
    out.append(out[0])
    return out if len(out) >= 4 else None


def polys_of(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    if geom['type'] == 'MultiPolygon':
        return geom['coordinates']
    return []


def main():
    j = json.load(open(SRC, encoding='utf-8'))
    feats = j['features']
    verts_in = verts_out = dropped_rings = 0
    out_feats = []
    for f in feats:
        new_polys = []
        for poly in polys_of(f['geometry']):
            outer = poly[0]
            verts_in += sum(len(r) for r in poly)
            if ring_km2(outer) < MIN_KM2:
                dropped_rings += len(poly)
                continue
            rings = []
            for ridx, r in enumerate(poly):
                cr = clean_ring(r)
                if cr is None:
                    if ridx == 0:
                        rings = None
                        break
                    continue
                rings.append(cr)
            if rings:
                new_polys.append(rings)
                verts_out += sum(len(r) for r in rings)
        if not new_polys:
            # a feature must never disappear: fall back to its largest
            # outer ring, quantized but unsimplified
            best = max(polys_of(f['geometry']), key=lambda p: ring_km2(p[0]))
            fb = clean_ring(best[0])
            new_polys = [[fb if fb else best[0]]]
        geom = ({'type': 'Polygon', 'coordinates': new_polys[0]}
                if len(new_polys) == 1 else
                {'type': 'MultiPolygon', 'coordinates': new_polys})
        out_feats.append({'type': 'Feature', 'properties': {}, 'geometry': geom})
    out = {'type': 'FeatureCollection', 'features': out_feats}
    body = json.dumps(out, separators=(',', ':'))
    open(DST, 'w', encoding='utf-8', newline='').write(body)
    print('features %d -> %d | verts %d -> %d (-%d%%) | rings dropped %d' % (
        len(feats), len(out_feats), verts_in, verts_out,
        round(100 * (1 - verts_out / verts_in)), dropped_rings))
    print('size %dKB -> %dKB' % (os.path.getsize(SRC) // 1024, len(body.encode()) // 1024))


if __name__ == '__main__':
    main()
