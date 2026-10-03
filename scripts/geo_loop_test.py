#!/usr/bin/env python3
"""geo_loop_test.py: recursive lookup soak test for SafeRoute USA.

Feeds the geocoder locations from every corner of the country (cities,
streets, quirks, typos), then routes between region pairs. Failed cases
re-enter the queue each round until everything passes or the round cap
hits. The goal: "map works from any location to any location" backed by
evidence, with failure classes named when it does not.

usage: python scripts/geo_loop_test.py [--rounds 4] [--base http://127.0.0.1:8787]
Exit 0 = every case green. Nonzero = persistent failures, listed.
"""
import json
import sys
import time
import urllib.request
import urllib.parse

BASE = "http://127.0.0.1:8787"
ROUNDS = 4
if "--base" in sys.argv:
    BASE = sys.argv[sys.argv.index("--base") + 1]
if "--rounds" in sys.argv:
    ROUNDS = int(sys.argv[sys.argv.index("--rounds") + 1])

GEOCODE_CASES = [
    "Miami, FL", "Seattle, WA", "Bangor, Maine", "Boise, ID",
    "El Paso, TX", "Fargo, ND", "Honolulu, HI", "Anchorage, AK",
    "Burlington, VT", "Tulsa, OK", "Savannah, GA", "Reno, NV",
    "Kansas City, MO", "New Orleans, LA", "Brooklyn, NY", "Duluth, MN",
    "Van Nuys Boulevard, Los Angeles", "Peachtree Street, Atlanta",
    "Michigan Avenue, Chicago", "Las Vegas Boulevard, Las Vegas",
    "Ocean Drive, Miami Beach", "601 Van Nuys Blvd, Los Angeles, CA",
    "fsu tallahassee", "ucla westwood",
    "Chicgo, IL", "Seatle WA",
]

EXPECTED_NO_MATCH = ["zzqx nowhereville xx"]

ROUTE_PAIRS = [
    ("Miami, FL", "Savannah, GA"),
    ("Seattle, WA", "Boise, ID"),
    ("El Paso, TX", "Tulsa, OK"),
    ("Burlington, VT", "Bangor, Maine"),
    ("Reno, NV", "Boise, ID"),
    ("Kansas City, MO", "Tulsa, OK"),
    ("New Orleans, LA", "El Paso, TX"),
    ("Fargo, ND", "Duluth, MN"),
    ("Miami, FL", "Seattle, WA"),
]


def get(path, timeout=45):
    req = urllib.request.Request(BASE + path, headers={"Origin": BASE.replace("127.0.0.1", "127.0.0.1")})
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            body = {}
        return e.code, body
    except Exception as e:
        return 0, {"error": str(e)[:120]}


def try_geocode(q):
    status, body = get("/api/geocode?limit=3&q=" + urllib.parse.quote(q))
    if status == 0:
        return None, "network: %s" % body.get("error")
    if status >= 500:
        return None, "HTTP %d (%s)" % (status, body.get("error", ""))
    if status != 200:
        return None, "HTTP %d" % status
    if not isinstance(body, list) or not body:
        return None, "empty result"
    hit = body[0]
    try:
        return (float(hit["lat"]), float(hit["lon"])), None
    except Exception:
        return None, "bad shape"


def try_route(a, b):
    status, body = get("/api/route?costing=auto&from=%f,%f&to=%f,%f" % (a[0], a[1], b[0], b[1]), timeout=60)
    if status == 0:
        return "network: %s" % body.get("error")
    if status >= 500:
        return "HTTP %d (%s)" % (status, body.get("error", ""))
    if status != 200 or not isinstance(body, dict) or not body.get("trip"):
        return "no trip in response (HTTP %d)" % status
    return None


def main():
    print("=== expected no-match contract (200 + empty, never 5xx) ===")
    nm_bad = []
    for q in EXPECTED_NO_MATCH:
        status, body = get("/api/geocode?limit=3&q=" + urllib.parse.quote(q))
        ok = status == 200 and isinstance(body, list) and not body
        print("  %s %-44s HTTP %s, %s results" % ("PASS" if ok else "FAIL", q, status,
              len(body) if isinstance(body, list) else "?"))
        if not ok:
            nm_bad.append(q)
        time.sleep(0.3)

    coords = {}
    geo_pending = list(GEOCODE_CASES)
    route_pending = list(ROUTE_PAIRS)
    geo_fail = {}
    route_fail = {}

    for rnd in range(1, ROUNDS + 1):
        if not geo_pending and not route_pending:
            break
        print("=== round %d: %d geocodes, %d routes pending ===" % (rnd, len(geo_pending), len(route_pending)))
        still = []
        for q in geo_pending:
            t0 = time.time()
            c, err = try_geocode(q)
            ms = int((time.time() - t0) * 1000)
            if c:
                coords[q] = c
                geo_fail.pop(q, None)
                print("  PASS %-44s %5dms" % (q, ms))
            else:
                geo_fail[q] = err
                still.append(q)
                print("  FAIL %-44s %5dms  %s" % (q, ms, err))
            time.sleep(0.3)
        geo_pending = still

        still_r = []
        for a, b in route_pending:
            if a not in coords or b not in coords:
                still_r.append((a, b))
                continue
            t0 = time.time()
            err = try_route(coords[a], coords[b])
            ms = int((time.time() - t0) * 1000)
            key = "%s -> %s" % (a, b)
            if err is None:
                route_fail.pop(key, None)
                print("  PASS route %-38s %5dms" % (key, ms))
            else:
                route_fail[key] = err
                still_r.append((a, b))
                print("  FAIL route %-38s %5dms  %s" % (key, ms, err))
            time.sleep(0.3)
        route_pending = still_r

        if (geo_pending or route_pending) and rnd < ROUNDS:
            print("  ...retrying %d failures in 8s" % (len(geo_pending) + len(route_pending)))
            time.sleep(8)

    print("\n=== FINAL: %d/%d geocodes, %d/%d routes ===" % (
        len(GEOCODE_CASES) - len(geo_pending), len(GEOCODE_CASES),
        len(ROUTE_PAIRS) - len(route_pending), len(ROUTE_PAIRS)))
    for q in geo_pending:
        print("  STILL FAILING geocode: %-40s %s" % (q, geo_fail.get(q)))
    for a, b in route_pending:
        key = "%s -> %s" % (a, b)
        print("  STILL FAILING route:   %-40s %s" % (key, route_fail.get(key, "endpoints never resolved")))
    for q in nm_bad:
        print("  BROKEN no-match contract: %s" % q)
    return 1 if (geo_pending or route_pending or nm_bad) else 0


if __name__ == "__main__":
    sys.exit(main())
