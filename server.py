#!/usr/bin/env python3
"""Firefox Pilot server - stdlib only, localhost only, no AI, no API keys.

Listens on 127.0.0.1:8765. Two roles share one port:
  - extension connects as a worker (holds its socket open, receives commands)
  - pilot.py CLI connects per command (sends one request, reads one reply)

Minimal RFC6455 implementation: handshake + text frames only.
Token: ~/.config/firefox-pilot/token (created on first run) or PILOT_TOKEN env.
"""
import base64
import hashlib
import json
import os
import socket
import struct
import threading
from pathlib import Path

HOST, PORT = "127.0.0.1", 8765
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

TOKEN_FILE = Path.home() / ".config" / "firefox-pilot" / "token"


def get_token():
    env = os.environ.get("PILOT_TOKEN")
    if env:
        return env.strip()
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    import secrets
    tok = secrets.token_hex(16)
    TOKEN_FILE.write_text(tok)
    TOKEN_FILE.chmod(0o600)
    return tok


TOKEN = get_token()
worker = None
worker_lock = threading.Lock()
pending = {}  # req id -> cli socket (replies from worker are routed back here)
pending_lock = threading.Lock()


def recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def read_http(conn):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
        if len(buf) > 65536:
            raise ValueError("headers too big")
    head, _ = buf.split(b"\r\n\r\n", 1)
    lines = head.decode("latin1").split("\r\n")
    method, target, _ = lines[0].split(" ", 2)
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return method, target, headers


def read_frame(conn):
    h = recv_exact(conn, 2)
    fin, mask = h[0] & 0x80, h[1] & 0x80
    length = h[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", recv_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", recv_exact(conn, 8))[0]
    key = recv_exact(conn, 4) if mask else None
    payload = recv_exact(conn, length) if length else b""
    if mask:
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    opcode = h[0] & 0x0F
    if opcode == 0x8:
        raise ConnectionError("close frame")
    return payload.decode("utf-8")


def send_frame(conn, text):
    data = text.encode("utf-8")
    if len(data) > 65535:  # ponytail: 64-bit lengths carry photos; 16-bit capped everything at 64KB
        head = bytes([0x81, 0x7F]) + struct.pack(">Q", len(data))
    elif len(data) > 125:
        head = bytes([0x81, 0x7E]) + struct.pack(">H", len(data))
    else:
        head = bytes([0x81, len(data)])
    conn.sendall(head + data)


def handle(conn):
    global worker
    peer = None
    try:
        try:
            peer = conn.getpeername()
        except OSError:
            pass
        method, target, headers = read_http(conn)
        print(f"conn from {peer}: {method} {target[:60]!r}", flush=True)
        if headers.get("upgrade", "").lower() != "websocket" or "upgrade" not in headers.get("connection", "").lower():
            conn.sendall(b"HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n")
            return
        if "token=" not in target or target.split("token=", 1)[1].split("&")[0].split(" ")[0] != TOKEN:
            conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + WS_MAGIC).encode()).digest()).decode()
        conn.sendall(
            ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
             "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").encode()
        )
        role = "cli" if "role=cli" in target else "worker"
        if role == "worker":
            with worker_lock:
                worker = conn
            try:
                while True:
                    raw = read_frame(conn)
                    try:
                        rep = json.loads(raw)
                    except ValueError:
                        continue
                    rid = rep.get("id")
                    with pending_lock:
                        cli = pending.pop(rid, None)
                    if cli is not None:
                        try:
                            send_frame(cli, raw)
                        except OSError:
                            pass
                        try:
                            cli.close()
                        except OSError:
                            pass
            except (ConnectionError, OSError):
                pass
            finally:
                with worker_lock:
                    if worker is conn:
                        worker = None
            return
        # CLI: one request -> forward to worker (or answer ping locally)
        try:
            raw = read_frame(conn)
        except (ConnectionError, OSError):
            return
        try:
            req = json.loads(raw)
        except ValueError:
            send_frame(conn, json.dumps({"ok": False, "error": "bad json"}))
            return
        if req.get("action") == "ping":
            with worker_lock:
                alive = worker is not None
            send_frame(conn, json.dumps({"id": req.get("id"), "ok": True, "data": {"pong": True, "extension": alive}}))
            return
        with worker_lock:
            w = worker
        if w is None:
            send_frame(conn, json.dumps({"id": req.get("id"), "ok": False, "error": "no extension connected"}))
            return
        rid = req.get("id", 1)
        with pending_lock:
            pending[rid] = conn
        try:
            send_frame(w, raw)
        except OSError:
            with pending_lock:
                pending.pop(rid, None)
            send_frame(conn, json.dumps({"id": rid, "ok": False, "error": "no extension connected"}))
            return
        # Park this thread: the worker loop forwards the reply and closes us.
        # Safety timeout so a lost reply can't hang the CLI forever.
        conn.settimeout(30)
        try:
            read_frame(conn)  # CLI never sends more; EOF/timeout ends the park
        except socket.timeout:
            try:
                send_frame(conn, json.dumps({"id": rid, "ok": False, "error": "extension timeout"}))
            except OSError:
                pass
        except (ConnectionError, OSError):
            pass
        finally:
            with pending_lock:
                pending.pop(rid, None)
    except (ConnectionError, OSError, ValueError, KeyError):
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(10)
    print(f"pilot server on {HOST}:{PORT} (localhost only, token in {TOKEN_FILE})")
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
