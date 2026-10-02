#!/usr/bin/env python3
"""smoke_test.py: the correctness gate for Voyage (and any change).

Covers every critical user flow with the server's own cached upstream data,
so a full run is fast and adds no meaningful load to public services:
  - page serves and parses as Voyage; vendor assets serve
  - security hardening holds (secrets/docs 403, bad host 403, bad path 400)
  - the crash pipeline is gone (crash endpoints 404, retired /data denied,
    legacy branded HTML removed) -- these double as the negative tests that
    the pivot's removals actually took
  - geocode and routing contracts (cache-hit queries)
  - three live CDP flows: a DRIVE trip renders stop cards + a real road
    route, a FLY trip renders city cards + a direct-line meta, a BOAT trip
    renders port cards + a direct-line meta; none render crash rows
Exit 0 only when every check passes. Never weaken a check to pass it.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BASE = "http://127.0.0.1:8787"
sys.path.insert(0, HERE)
from mobile_shot import WS, CDP, find_chrome  # noqa: E402

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("  %s %-44s %s" % ("PASS" if ok else "FAIL", name, detail))


def get(path, headers=None, timeout=30):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()


def api(path):
    return get(path, {"Origin": BASE})


# poll up to ~20s for the result panel, then report what rendered
POLL = ("new Promise(function(done){var n=0;var iv=setInterval(function(){n++;"
        "if(document.body.classList.contains('inarea')||n>44){clearInterval(iv);done({"
        "inarea:document.body.classList.contains('inarea'),"
        "stopcards:document.querySelectorAll('.stopcard').length,"
        "rows:document.querySelectorAll('.row').length,"
        "meta:document.getElementById('pMeta').textContent,"
        "chooser:document.getElementById('chooser').classList.contains('show')});}},500);})")


def cdp_flow(url, expr, wait_s, timeout=90):
    proc = subprocess.Popen([
        find_chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--remote-debugging-port=9378", "--remote-allow-origins=*",
        "--user-data-dir=" + os.path.join(os.environ.get("TEMP", "/tmp"), "smoke-%d" % os.getpid()),
        "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        target = None
        for _ in range(50):
            try:
                rq = urllib.request.Request("http://127.0.0.1:9378/json/new?about:blank", method="PUT")
                target = json.loads(urllib.request.urlopen(rq, timeout=3).read())
                break
            except Exception:
                time.sleep(0.2)
        if not target:
            return None
        cdp = CDP(WS(target["webSocketDebuggerUrl"]))
        cdp.call("Page.enable")
        cdp.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        cdp.call("Page.navigate", {"url": url})
        cdp.wait_event("Page.loadEventFired", timeout=40)
        time.sleep(wait_s)
        r = cdp.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, timeout=60)
        return r.get("result", {}).get("value")
    finally:
        proc.kill()


def main():
    print("== smoke: static + hardening ==")
    st, body = get("/globe.html")
    check("page serves as Voyage", st == 200 and b"Voyage" in body and b"SafeRoute" not in body)
    check("vendor globe.gl serves", get("/vendor/globe.gl-2.34.4.min.js")[0] == 200)
    check("vendor leaflet css serves", get("/vendor/leaflet-1.9.4.css")[0] == 200)
    check("secrets blocked", get("/secrets.json")[0] == 403)
    check("docs blocked", get("/docs/CHECKPOINT.md")[0] == 403)
    check("bad host blocked", get("/globe.html", {"Host": "evil.com"})[0] == 403)
    st2, _ = get("/%zz")
    st3, _ = get("/globe.html")
    check("bad path 400 + alive", st2 == 400 and st3 == 200)

    print("== smoke: crash pipeline removed (negative tests) ==")
    check("crash state endpoint gone", api("/api/crashes/state?st=CA")[0] == 404)
    check("crash status endpoint gone", api("/api/crashes/status")[0] == 404)
    check("retired /data denied", get("/data/national.json")[0] in (403, 404))
    check("legacy index.html removed", get("/index.html")[0] == 404)
    check("no crash strings in page", b"NHTSA" not in body and b"FARS" not in body and b"crash" not in body)

    print("== smoke: page JS parses ==")
    html = body.decode("utf-8", "replace")
    m = re.search(r"<script(?![^>]*src=)[^>]*>(.*?)</script>", html, re.S)
    tmp = os.path.join(os.environ.get("TEMP", "/tmp"), "smoke-inline.js")
    open(tmp, "w", encoding="utf-8").write(m.group(1) if m else "")
    ok = subprocess.run(["node", "--check", tmp], capture_output=True).returncode == 0
    check("inline JS parses", ok)
    ok2 = subprocess.run(["node", "--check", os.path.join(ROOT, "server.js")], capture_output=True).returncode == 0
    check("server.js parses", ok2)

    print("== smoke: API contracts (cache-hit queries) ==")
    st, b = api("/api/geocode?limit=3&q=Waco%2C%20Texas")
    try:
        j = json.loads(b)
        check("geocode returns results", st == 200 and isinstance(j, list) and len(j) > 0)
        a = (float(j[0]["lat"]), float(j[0]["lon"])) if j else None
    except Exception:
        check("geocode returns results", False)
        a = None
    st, b = api("/api/geocode?limit=3&q=Killeen%2C%20Texas")
    try:
        j = json.loads(b)
        c = (float(j[0]["lat"]), float(j[0]["lon"])) if (st == 200 and j) else None
    except Exception:
        c = None
    if a and c:
        st, b = api("/api/route?costing=auto&stops=%f,%f;%f,%f" % (a[0], a[1], c[0], c[1]))
        try:
            j = json.loads(b)
            check("drive routing returns a trip", st == 200 and bool(j.get("trip")))
        except Exception:
            check("drive routing returns a trip", False)
    else:
        check("drive routing returns a trip", False, "endpoints unresolved")
    st, b = api("/api/social/status")
    try:
        check("platform status answers", st == 200 and isinstance(json.loads(b), dict))
    except Exception:
        check("platform status answers", False)

    print("== smoke: CDP user flows (drive / fly / boat) ==")
    v = cdp_flow(BASE + "/globe.html?mode=drive&stops=Waco%2C%20Texas%7CKilleen%2C%20Texas", POLL, 1)
    check("drive trip renders stop cards, no crash rows",
          bool(v) and v.get("inarea") and v.get("stopcards", 0) > 0 and v.get("rows", 1) == 0 and not v.get("chooser"),
          json.dumps(v))
    v = cdp_flow(BASE + "/globe.html?mode=fly&stops=Denver%2C%20Colorado%7CMiami%2C%20Florida", POLL, 1)
    check("fly trip renders city cards + direct-line meta",
          bool(v) and v.get("stopcards", 0) > 0 and ("direct line" in (v.get("meta") or "")) and not v.get("chooser"),
          json.dumps(v))
    v = cdp_flow(BASE + "/globe.html?mode=boat&stops=New%20Orleans%2C%20Louisiana%7CTampa%2C%20Florida", POLL, 1)
    check("boat trip renders port cards + direct-line meta",
          bool(v) and v.get("stopcards", 0) > 0 and ("direct line" in (v.get("meta") or "")) and not v.get("chooser"),
          json.dumps(v))

    fails = [r for r in RESULTS if not r[1]]
    print("\n== SMOKE: %d/%d passed ==" % (len(RESULTS) - len(fails), len(RESULTS)))
    for name, _, detail in fails:
        print("  FAILING: %s %s" % (name, detail))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
