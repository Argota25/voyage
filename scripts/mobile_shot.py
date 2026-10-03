#!/usr/bin/env python3
"""mobile_shot.py: true mobile-viewport screenshots via Chrome DevTools.

Plain CLI flags cannot emulate a phone: Chrome clamps windows to ~500px wide,
so a --window-size=390 shot silently lays out at ~510 and crops (a paid
trap; the page looks broken when only the measurement is). This drives CDP
Emulation.setDeviceMetricsOverride over a stdlib-only WebSocket client.

usage: python mobile_shot.py <url> <width> <height> <out.png>
       [--full] [--eval JS] [--settle N]
  --full    capture beyond the viewport (full page height)
  --eval    run JS after load, print its JSON result (page probes, clicks)
  --await   treat --eval as a Promise and wait for it (async end-state probes)
  --settle  extra seconds to wait after --eval before the screenshot
            (lets a click-triggered transition finish)

Exit 0 on success. Python 3.8+ stdlib only.
"""
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    "/usr/bin/google-chrome", "/usr/bin/chromium",
]
DEBUG_PORT = 9377


def find_chrome():
    for c in CHROME_CANDIDATES:
        if os.path.isfile(c):
            return c
    sys.exit("chrome not found")


class WS(object):
    """Minimal RFC6455 client: masked text frames out, fragmented frames in."""

    def __init__(self, url, timeout=60):
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET /%s HTTP/1.1\r\nHost: %s:%s\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n") % (path, host, port, key)
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("handshake failed")
            resp += chunk
        if b" 101 " not in resp.split(b"\r\n", 1)[0]:
            raise RuntimeError("handshake rejected: %r" % resp[:200])
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        if accept not in resp:
            raise RuntimeError("bad accept key")
        self.buf = b""

    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        header = b"\x81"
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_message(self):
        """One complete (possibly fragmented) text message."""
        parts = []
        while True:
            b1, b2 = self._read_exact(2)
            fin = b1 & 0x80
            opcode = b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read_exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read_exact(8))[0]
            data = self._read_exact(n)
            if opcode == 0x9:
                mask = os.urandom(4)
                self.sock.sendall(b"\x8A" + bytes([0x80 | len(data)]) + mask +
                                  bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
                continue
            if opcode == 0x8:
                raise RuntimeError("closed by peer")
            parts.append(data)
            if fin:
                return b"".join(parts).decode("utf-8", "replace")


class CDP(object):
    def __init__(self, ws):
        self.ws = ws
        self.next_id = 1
        self.events = []

    def call(self, method, params=None, timeout=45):
        mid = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(self.ws.recv_message())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (method, msg["error"]))
                return msg.get("result", {})
            self.events.append(msg)
        raise RuntimeError("timeout waiting for %s" % method)

    def wait_event(self, name, timeout=30):
        for i, e in enumerate(self.events):
            if e.get("method") == name:
                return self.events.pop(i)
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(self.ws.recv_message())
            if msg.get("method") == name:
                return msg
            self.events.append(msg)
        raise RuntimeError("timeout waiting for event %s" % name)


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    full = "--full" in argv
    ev = None
    settle = 0.0
    if "--eval" in argv:
        ev = argv[argv.index("--eval") + 1]
        if ev in args:
            args.remove(ev)
    if "--settle" in argv:
        s = argv[argv.index("--settle") + 1]
        settle = float(s)
        if s in args:
            args.remove(s)
    if len(args) < 4:
        sys.exit(__doc__)
    url, width, height, out = args[0], int(args[1]), int(args[2]), args[3]

    chrome = find_chrome()
    proc = subprocess.Popen([
        chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--remote-debugging-port=%d" % DEBUG_PORT,
        "--remote-allow-origins=*",
        "--user-data-dir=" + os.path.join(
            os.environ.get("TEMP", "/tmp"), "mshot-%d" % os.getpid()),
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        target = None
        for attempt in range(50):
            try:
                req = urllib.request.Request(
                    "http://127.0.0.1:%d/json/new?about:blank" % DEBUG_PORT, method="PUT")
                target = json.loads(urllib.request.urlopen(req, timeout=3).read())
                break
            except Exception:
                time.sleep(0.2)
        if not target:
            sys.exit("could not reach chrome devtools")

        cdp = CDP(WS(target["webSocketDebuggerUrl"]))
        cdp.call("Page.enable")
        cdp.call("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height,
            "deviceScaleFactor": 2, "mobile": True})
        cdp.call("Emulation.setTouchEmulationEnabled", {"enabled": True})
        cdp.call("Page.navigate", {"url": url})
        cdp.wait_event("Page.loadEventFired", timeout=40)
        time.sleep(4)

        if ev:
            params = {"expression": ev, "returnByValue": True}
            if "--await" in sys.argv:
                params["awaitPromise"] = True
            r = cdp.call("Runtime.evaluate", params, timeout=90)
            print(json.dumps(r.get("result", {}).get("value")))
        if settle:
            time.sleep(settle)

        shot = {"format": "png"}
        if full:
            m = cdp.call("Page.getLayoutMetrics")
            cs = m.get("cssContentSize") or m.get("contentSize", {})
            shot["clip"] = {"x": 0, "y": 0, "width": cs.get("width", width),
                            "height": cs.get("height", height), "scale": 1}
            shot["captureBeyondViewport"] = True
        data = cdp.call("Page.captureScreenshot", shot, timeout=60)
        with open(out, "wb") as f:
            f.write(base64.b64decode(data["data"]))
        sys.stderr.write("saved %s\n" % out)
        return 0
    finally:
        proc.kill()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
