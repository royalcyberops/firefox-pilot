# Firefox Pilot — local-only browser control for OpenCode

No AI inside. No API keys. No paid models. Stdlib-only server, plain-JS extension.
The brains are your existing free OpenCode models (Qwen3 8B local / Muse Spark Free).

## Layout

- `manifest.json` — MV2 + persistent background (keeps WS alive; MV3 event pages unload), Gecko ID, `connect-src` CSP for `ws(s)://127.0.0.1:8765`
- `background.js` — outbound WS client to `127.0.0.1:8765`, actions: ping/tabs/goto/snapshot/click/type/read/scroll/screenshot
- `content.js` — per-page snapshot (refs), trusted click/type events, text/html read
- `popup.html` — toolbar status (connected ○/●)
- `server.py` — stdlib-only WS server: localhost only, token auth, relays CLI↔extension by request id
- `pilot.py` — stdlib CLI client

## Run

```bash
export PILOT_TOKEN=pilot-local   # must match extension default (or set ext storage token)
python3 server.py
python3 pilot.py ping            # {"pong": true, "extension": true} when connected
```

## Load extension (Firefox ESR)

1. `about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`
2. Optional: set token — extension popup has no setter yet, so default `pilot-local`
   matches only if you export `PILOT_TOKEN=pilot-local` before starting server,
   or copy the generated token into extension storage via devtools console:
   `browser.storage.local.set({token: "<from ~/.config/firefox-pilot/token>"})`
3. `python3 pilot.py ping` → `"extension": true`

## Use

```bash
python3 pilot.py tabs
python3 pilot.py snapshot            # numbered refs
python3 pilot.py click 12
python3 pilot.py type 7 "hello" --submit
python3 pilot.py read text
python3 pilot.py screenshot /tmp/opencode/pilot-shot.png
```

## Security

- Binds 127.0.0.1 only. Token required (`?token=`). Wrong token → 403.
- Extension only connects out to localhost; no inbound ports, no remote hosts.
- Temporary add-on (unloaded on restart) — reload per session, by design.
