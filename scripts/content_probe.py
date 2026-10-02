#!/usr/bin/env python3
"""content_probe.py: time-to-content for the three user flows.

Drives each flow via deep link in a fresh headless Chrome and polls every
200ms for content milestones, printing first-seen times relative to
navigation. Cold vs warm is decided by the SERVER cache, not the browser,
so run twice to separate upstream latency from app structure.

usage: python scripts/content_probe.py <accident|commute|trip> "<q>" ["<q2>"]
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mobile_shot import WS, CDP, find_chrome  # noqa: E402

PORT = 9500 + (os.getpid() % 400)

FLOW = sys.argv[1]
Q = sys.argv[2]
Q2 = sys.argv[3] if len(sys.argv) > 3 else ""

if FLOW == "accident":
    url = "http://127.0.0.1:8787/globe.html?intent=accident&q=" + urllib.parse.quote(Q)
elif FLOW == "commute":
    url = ("http://127.0.0.1:8787/globe.html?intent=commute&from=" + urllib.parse.quote(Q)
           + "&to=" + urllib.parse.quote(Q2))
else:
    url = "http://127.0.0.1:8787/globe.html?intent=roadtrip&stops=" + urllib.parse.quote(Q + "|" + Q2)

MILESTONES = """
(function(){
  function vis(sel){var n=document.querySelector(sel);return !!n;}
  function cnt(sel){return document.querySelectorAll(sel).length;}
  return {
    panel: document.getElementById('panel').classList.contains('open'),
    stage: document.getElementById('stage').classList.contains('show'),
    rows: cnt('#rows .row'),
    routeCards: cnt('#routes .route'),
    stopcards: cnt('.stopcard'),
    videos: cnt('.hsvid, .svcard'),
    skeletons: cnt('.hskel'),
    feed: cnt('.fslide'),
    hint: (document.getElementById('hint')||{}).textContent||''
  };
})()
"""

prof = os.path.join(os.environ.get("TEMP", "."), "cnt-%d" % os.getpid())
proc = subprocess.Popen([
    find_chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--window-size=1440,900", "--remote-debugging-port=%d" % PORT,
    "--remote-allow-origins=*", "--user-data-dir=" + prof, "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    target = None
    for _ in range(50):
        try:
            rq = urllib.request.Request("http://127.0.0.1:%d/json/new?about:blank" % PORT, method="PUT")
            target = json.loads(urllib.request.urlopen(rq, timeout=3).read())
            break
        except Exception:
            time.sleep(0.2)
    cdp = CDP(WS(target["webSocketDebuggerUrl"]))
    cdp.call("Page.enable")
    t0 = time.time()
    cdp.call("Page.navigate", {"url": url})
    first = {}
    last = {}
    deadline = t0 + 75
    while time.time() < deadline:
        t = time.time() - t0
        try:
            r = cdp.call("Runtime.evaluate", {"expression": MILESTONES, "returnByValue": True})
            v = r.get("result", {}).get("value") or {}
            if not v and "dbg" not in first:
                first["dbg"] = t
                print("  dbg first empty eval: %s" % str(r)[:200])
        except Exception as e:
            if "dbgx" not in first:
                first["dbgx"] = t
                print("  dbg eval exception: %r" % e)
            v = {}
        # answer ambiguity choosers like a user would (first option), and
        # record the decision cost separately
        try:
            picked = cdp.call("Runtime.evaluate", {"expression":
                "(function(){var c=document.getElementById('chooser');"
                "if(c&&c.classList.contains('show')){var b=c.querySelector('.chopt');"
                "if(b){b.click();return true;}}return false;})()",
                "returnByValue": True}).get("result", {}).get("value")
            if picked:
                first.setdefault("chooser_answered", t)
                last["choosers"] = last.get("choosers", 0) + 1
                time.sleep(1.0)  # let the pick settle; never double-click a rebuilt chooser
        except Exception:
            pass
        for k in ("panel", "stage"):
            if v.get(k) and k not in first:
                first[k] = t
        for k in ("rows", "routeCards", "stopcards", "videos", "feed"):
            n = v.get(k, 0)
            if n and k not in first:
                first[k] = t
            if n:
                last[k] = n
        if v.get("skeletons", 0):
            last["skeletons_seen"] = True
            first.setdefault("skeletons", t)
        if v.get("skeletons", 0) == 0 and "skeletons" in first and "skeletons_gone" not in first:
            first["skeletons_gone"] = t
        # done when the flow's terminal content exists and skeletons cleared
        done = {
            "accident": lambda: "rows" in first and "videos" in first,
            "commute": lambda: "routeCards" in first,
            "trip": lambda: "stopcards" in first and "videos" in first and first.get("skeletons_gone"),
        }[FLOW]
        if done() and t > 8:
            break
        time.sleep(0.2)
    print("flow=%s q=%r q2=%r" % (FLOW, Q, Q2))
    for k in sorted(first, key=lambda x: first[x]):
        print("  %7.1fs  %s%s" % (first[k], k,
              (" (n=%d)" % last[k]) if k in last and not isinstance(last[k], bool) else ""))
    print("  final counts: %s" % json.dumps({k: v for k, v in last.items()}))
    print("  final state: %s" % json.dumps(v)[:400])
finally:
    try:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True)
    except Exception:
        proc.kill()
