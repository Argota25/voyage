#!/usr/bin/env python3
"""perf_probe.py: page-load metrics via CDP, methodology fixed for the loop.

Each run uses a FRESH browser profile (cold browser cache; server stays
warm), observers installed before navigation, metrics read after load+3s.
Reports per-run values and the median of N runs (default 5).

usage: python scripts/perf_probe.py [url] [runs]
"""
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mobile_shot import WS, CDP, find_chrome  # noqa: E402

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787/globe.html"
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 5
PORT = 9379

OBSERVER = """
window.__perf={lcp:0,tbt:0,tasks:[]};
try{new PerformanceObserver(function(l){var e=l.getEntries();for(var i=0;i<e.length;i++)window.__perf.lcp=e[i].startTime;}).observe({type:'largest-contentful-paint',buffered:true});}catch(x){}
try{new PerformanceObserver(function(l){var e=l.getEntries();for(var i=0;i<e.length;i++){var b=e[i].duration-50;if(b>0){window.__perf.tbt+=b;window.__perf.tasks.push([Math.round(e[i].startTime),Math.round(e[i].duration)]);}}}).observe({type:'longtask',buffered:true});}catch(x){}
"""

READ = """
(function(){
  var nav=performance.getEntriesByType('navigation')[0]||{};
  var res=performance.getEntriesByType('resource');
  var xfer=0;for(var i=0;i<res.length;i++)xfer+=res[i].transferSize||0;
  xfer+=(nav.transferSize||0);
  var lcp=window.__perf.lcp,early=0,t=window.__perf.tasks,fcp=0;
  var pe=performance.getEntriesByType('paint');
  for(var k=0;k<pe.length;k++){if(pe[k].name==='first-contentful-paint')fcp=pe[k].startTime;}
  for(var j=0;j<t.length;j++){if(t[j][0]<lcp)early+=Math.max(0,t[j][1]-50);}
  return {fcp:Math.round(fcp),lcp:Math.round(lcp),tbt:Math.round(window.__perf.tbt),
    tbtPreLcp:Math.round(early),
    tasks:t.slice().sort(function(a,b){return b[1]-a[1];}).slice(0,5),
    dcl:Math.round(nav.domContentLoadedEventEnd||0),load:Math.round(nav.loadEventEnd||0),
    xferKB:Math.round(xfer/1024),resources:res.length};
})()
"""


def one_run(i):
    prof = os.path.join(os.environ.get("TEMP", "/tmp"), "perfp-%d-%d" % (os.getpid(), i))
    proc = subprocess.Popen([
        find_chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--window-size=800,900",
        "--remote-debugging-port=%d" % PORT, "--remote-allow-origins=*",
        "--user-data-dir=" + prof, "about:blank"],
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
        cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": OBSERVER})
        cdp.call("Page.navigate", {"url": URL})
        cdp.wait_event("Page.loadEventFired", timeout=60)
        time.sleep(3)
        r = cdp.call("Runtime.evaluate", {"expression": READ, "returnByValue": True})
        return r.get("result", {}).get("value")
    finally:
        proc.kill()


def main():
    rows = []
    for i in range(RUNS):
        v = one_run(i)
        if v:
            rows.append(v)
            print("  run %d: FCP %dms  LCP %dms  TBT %dms (preLCP %dms)  DCL %dms  load %dms  xfer %dKB  res %d  top-tasks %s" % (
                i + 1, v.get("fcp", -1), v["lcp"], v["tbt"], v.get("tbtPreLcp", -1), v["dcl"], v["load"],
                v["xferKB"], v["resources"], v.get("tasks", [])))
        time.sleep(1)
    if not rows:
        print("no data")
        return 1
    med = lambda k: int(statistics.median(r.get(k, 0) for r in rows))
    print("MEDIAN: FCP %dms  LCP %dms  TBT %dms (preLCP %dms)  DCL %dms  load %dms  xfer %dKB  res %d" % (
        med("fcp"), med("lcp"), med("tbt"), med("tbtPreLcp"), med("dcl"), med("load"), med("xferKB"), med("resources")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
