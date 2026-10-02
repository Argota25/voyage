#!/usr/bin/env python3
"""pixel_gate.py: deterministic globe screenshot + diff, for visual-parity gates.

capture:  python scripts/pixel_gate.py capture out.png [url]
diff:     python scripts/pixel_gate.py diff a.png b.png

Determinism: prefers-reduced-motion is emulated BEFORE navigation (the app
reads RM once at boot: autoRotate off, ring pulses off, zero-duration
flights), and the random starfield is hidden before the shot. Same
machine + same flags -> the only remaining variance is GPU antialiasing,
so the diff gate allows a tiny epsilon: FAIL if more than 0.5% of pixels
move by more than 8/255.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mobile_shot import WS, CDP, find_chrome  # noqa: E402

PORT = 9383


def capture(out, url):
    prof = os.path.join(os.environ.get("TEMP", "."), "pxg-%d" % os.getpid())
    proc = subprocess.Popen([
        find_chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--window-size=1200,900", "--remote-debugging-port=%d" % PORT,
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
        cdp.call("Emulation.setEmulatedMedia", {"features": [
            {"name": "prefers-reduced-motion", "value": "reduce"}]})
        cdp.call("Page.navigate", {"url": url})
        cdp.wait_event("Page.loadEventFired", timeout=60)
        time.sleep(9)  # lazy boot + eval + init + full chunked tessellation
        cdp.call("Runtime.evaluate", {"expression":
                 "var s=document.getElementById('stars');if(s)s.style.display='none';1"})
        time.sleep(0.6)
        shot = cdp.call("Page.captureScreenshot", {"format": "png"})
        import base64
        open(out, "wb").write(base64.b64decode(shot["data"]))
        print("saved %s" % out)
    finally:
        proc.kill()


def diff(a, b):
    from PIL import Image, ImageChops
    ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    if ia.size != ib.size:
        print("FAIL size mismatch %s vs %s" % (ia.size, ib.size))
        return 1
    d = ImageChops.difference(ia, ib)
    px = list(d.getdata())
    n = len(px)
    moved = sum(1 for p in px if max(p) > 8)
    worst = max(max(p) for p in px)
    pct = 100.0 * moved / n
    ok = pct <= 0.5
    print("%s: %.3f%% pixels moved >8/255 (worst delta %d) -> %s" % (
        "PASS" if ok else "FAIL", pct, worst, "visual parity" if ok else "VISIBLE CHANGE"))
    return 0 if ok else 1


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "capture":
        capture(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "http://127.0.0.1:8787/globe.html")
        sys.exit(0)
    sys.exit(diff(sys.argv[2], sys.argv[3]))
