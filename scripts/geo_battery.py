#!/usr/bin/env python3
"""geo_battery.py: geocode torture test across US location classes.

Hits /api/geocode the way the app does (limit=10, geom=1) with obscure
towns, typos, bare names, punctuation, counties, and addresses. Reports
per-query: status, result count, top match, and latency. The server's
politeness queues do the pacing; this script just walks the list.

usage: python scripts/geo_battery.py
"""
import json
import sys
import time
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8787"

CASES = [
    # (category, query, expect-substring-of-top-match lowercased, or None = any US hit)
    ("obscure", "Monowi NE", "monowi"),
    ("obscure", "Supai AZ", "supai"),
    ("obscure", "Chicken AK", "chicken"),
    ("obscure", "Rachel NV", "rachel"),
    ("obscure", "Ismay MT", "ismay"),
    ("obscure", "Hell MI", "hell"),
    ("obscure", "Truth or Consequences NM", "truth or consequences"),
    ("obscure", "Cut and Shoot TX", "cut and shoot"),
    ("obscure", "Toad Suck AR", "toad suck"),
    ("obscure", "Zzyzx CA", "zzyzx"),
    ("obscure", "Boring OR", "boring"),
    ("obscure", "Weeki Wachee FL", "weeki wachee"),
    ("typo", "Alburqurque NM", "albuquerque"),
    ("typo", "Tuscon AZ", "tucson"),
    ("typo", "Cincinatti OH", "cincinnati"),
    ("typo", "Philidelphia PA", "philadelphia"),
    ("typo", "Seatle WA", "seattle"),
    ("typo", "Sann Antonio TX", "san antonio"),
    ("typo", "Minneapols MN", "minneapolis"),
    ("typo", "Chatanooga TN", "chattanooga"),
    ("bare", "Kalamazoo", "kalamazoo"),
    ("bare", "Poughkeepsie", "poughkeepsie"),
    ("bare", "Ketchikan", "ketchikan"),
    ("bare", "Paducah", "paducah"),
    ("punct", "Coeur d'Alene ID", "coeur d'alene"),
    ("punct", "O'Fallon MO", "o'fallon"),
    ("punct", "Winston-Salem NC", "winston-salem"),
    ("punct", "St. Marys GA", "marys"),
    ("county", "Loving County TX", "loving"),
    ("county", "Kalawao County HI", "kalawao"),
    ("county", "Slope County ND", "slope"),
    ("address", "1600 Pennsylvania Avenue Washington DC", "pennsylvania"),
    ("address", "123 Main St Barrow AK", None),
    ("address", "1 Duval St Key West FL", "duval"),
    ("smallst", "Wamsutter WY", "wamsutter"),
    ("smallst", "Circle MT", "circle"),
    ("smallst", "Eek AK", "eek"),
    ("smallst", "Gnaw Bone IN", None),
    ("smallst", "Frostproof FL", "frostproof"),
    ("smallst", "Intercourse PA", "intercourse"),
]


def q(query):
    url = BASE + "/api/geocode?limit=10&geom=1&q=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"Origin": BASE})
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=45)
        body = json.loads(r.read())
        ms = int((time.time() - t0) * 1000)
        return r.status, body, ms
    except urllib.error.HTTPError as e:
        return e.code, None, int((time.time() - t0) * 1000)
    except Exception as e:
        return str(e)[:40], None, int((time.time() - t0) * 1000)


def main():
    ok = fail = weak = 0
    fails = []
    for cat, query, expect in CASES:
        status, body, ms = q(query)
        if isinstance(body, list) and body:
            top = (body[0].get("display_name") or "")[:66]
            norm = top.lower().replace('’', "'")
            hit = (expect is None) or (expect in norm)
            n = len(body)
            if hit:
                ok += 1
                mark = "PASS"
            else:
                weak += 1
                mark = "WEAK"  # results, but top match is not the expected place
                fails.append((cat, query, "top=" + top))
        else:
            fail += 1
            mark = "FAIL"
            top = "(status %s, empty)" % status
            n = 0
            fails.append((cat, query, top))
        print("%-4s %-8s %-38s %5dms n=%-2d %s" % (mark, cat, query, ms, n, top))
        sys.stdout.flush()
    print()
    print("== %d PASS · %d WEAK (wrong top match) · %d FAIL (no result) of %d" % (
        ok, weak, fail, len(CASES)))
    for f in fails:
        print("   ", f)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
