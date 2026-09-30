#!/usr/bin/env python3
"""pilot.py - CLI client for the Firefox Pilot server. Stdlib only.

Usage:
  pilot.py ping
  pilot.py tabs
  pilot.py goto <url>
  pilot.py snapshot
  pilot.py click <ref>
  pilot.py type <ref> <text> [--submit]
  pilot.py read [text|html]
  pilot.py scroll [x] [y]
  pilot.py screenshot [out.png]
"""
import base64
import hashlib
import json
import os
import socket
import struct
import sys
from pathlib import Path

HOST, PORT = "127.0.0.1", 8765
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def token():
    env = os.environ.get("PILOT_TOKEN")
    if env:
        return env.strip()
    p = Path.home() / ".config" / "firefox-pilot" / "token"
    if p.exists():
        return p.read_text().strip()
    sys.exit("no token yet: start server.py once to create it")


def recv_exact(s, n):
    buf = b""
    while len(buf) < n:
        c = s.recv(n - len(buf))
        if not c:
            raise ConnectionError("closed")
        buf += c
    return buf


def read_frame(s):
    h = recv_exact(s, 2)
    ln = h[1] & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", recv_exact(s, 2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", recv_exact(s, 8))[0]
    return recv_exact(s, ln).decode("utf-8") if ln else ""


def send_frame(s, text):
    data = text.encode()
    mask = os.urandom(4)
    if len(data) > 125:
        head = bytes([0x81, 0x80 | 0x7E]) + struct.pack(">H", len(data))
    else:
        head = bytes([0x81, 0x80 | len(data)])
    s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def call(action, params=None):
    key = base64.b64encode(os.urandom(16)).decode()
    s = socket.create_connection((HOST, PORT), timeout=10)
    s.sendall(
        (f"GET /?token={token()}&role=cli HTTP/1.1\r\nHost: {HOST}\r\n"
         "Upgrade: websocket\r\nConnection: Upgrade\r\n"
         f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode()
    )
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += s.recv(4096)
    if b"101" not in resp.split(b"\r\n", 1)[0]:
        sys.exit(f"server refused: {resp.splitlines()[0].decode()}")
    send_frame(s, json.dumps({"id": 1, "action": action, "params": params or {}}))
    out = json.loads(read_frame(s))
    s.close()
    return out


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        sys.exit(__doc__)
    cmd, rest = argv[0], argv[1:]
    if cmd == "ping":
        print(json.dumps(call("ping"), indent=1))
    elif cmd == "tabs":
        print(json.dumps(call("tabs"), indent=1))
    elif cmd == "goto" and rest:
        print(json.dumps(call("goto", {"url": rest[0]})))
    elif cmd == "snapshot":
        r = call("snapshot")
        for n in (r.get("data") or {}).get("nodes", []):
            print(f"[{n['ref']}] {n['tag']} {n['label'][:70]} ({n['x']},{n['y']})")
    elif cmd == "click" and rest:
        print(json.dumps(call("click", {"ref": int(rest[0])})))
    elif cmd == "type" and len(rest) >= 2:
        print(json.dumps(call("type", {"ref": int(rest[0]), "text": rest[1],
                                       "submit": "--submit" in rest})))
    elif cmd == "read":
        print(json.dumps(call("read", {"mode": rest[0] if rest else "text"}))[:4000])
    elif cmd == "scroll":
        x = int(rest[0]) if len(rest) > 0 else 0
        y = int(rest[1]) if len(rest) > 1 else 600
        print(json.dumps(call("scroll", {"x": x, "y": y})))
    elif cmd == "screenshot":
        r = call("screenshot")
        import base64 as b64
        out = rest[0] if rest else "/tmp/opencode/pilot-shot.png"
        d = (r.get("data") or {}).get("dataUrl", "")
        if "," in d:
            Path(out).write_bytes(b64.b64decode(d.split(",", 1)[1]))
            print("saved", out)
        else:
            print(json.dumps(r)[:500])
    else:
        sys.exit(f"unknown command: {cmd}\n{__doc__}")


if __name__ == "__main__":
    main(sys.argv[1:])
