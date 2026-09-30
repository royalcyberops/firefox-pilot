/* Firefox Pilot - background script (MV3-compatible, browser.* namespace).
 * Opens ONE outbound WebSocket to 127.0.0.1:8765 (token via storage or default).
 * No inbound ports, no remote hosts, no AI calls.
 */
(() => {
  "use strict";
  const PORT = 8765;
  const RECONNECT_MS = 3000;
  let ws = null;
  let token = "pilot-local";

  const B = typeof browser !== "undefined" ? browser : chrome;

  async function loadToken() {
    try {
      const s = await B.storage.local.get("token");
      if (s.token) token = s.token;
    } catch (e) { /* storage unavailable, keep default */ }
  }

  async function activeTab() {
    const tabs = await B.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) throw new Error("no active tab");
    return tabs[0];
  }

  async function sendToTab(tabId, msg) {
    return B.tabs.sendMessage(tabId, msg);
  }

  async function handle(msg) {
    const a = msg.action;
    switch (a) {
      case "ping":
        return { pong: true };
      case "tabs": {
        const tabs = await B.tabs.query({});
        return { tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
      }
      case "goto": {
        const tab = await activeTab();
        await B.tabs.update(tab.id, { url: msg.params.url });
        return { ok: true };
      }
      case "snapshot":
      case "click":
      case "type":
      case "read":
      case "scroll": {
        const tab = await activeTab();
        const r = await sendToTab(tab.id, {
          cmd: a,
          ref: msg.params && msg.params.ref,
          text: msg.params && msg.params.text,
          submit: msg.params && msg.params.submit,
          mode: msg.params && msg.params.mode,
          x: msg.params && msg.params.x,
          y: msg.params && msg.params.y,
        });
        if (!r.ok) throw new Error(r.error || "tab error");
        return r.data || r;
      }
      case "screenshot": {
        const win = await B.windows.getCurrent();
        const url = await B.tabs.captureVisibleTab(win.id, { format: "png" });
        return { dataUrl: url.slice(0, 2000000) };
      }
      default:
        throw new Error("unknown action: " + a);
    }
  }

  function connect() {
    try { if (ws) ws.close(); } catch (e) {}
    const url = `ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`;
    console.log("[pilot] page=" + location.href + " connecting " + url);
    // Plain-HTTP probe first: distinguishes TCP/TLS-upgrade faults from WS faults.
    fetch(`http://127.0.0.1:${PORT}/probe`).then(
      (r) => console.log("[pilot] http probe status=" + r.status),
      (e) => console.log("[pilot] http probe failed: " + e)
    );
    ws = new WebSocket(url);
    console.log("[pilot] constructed url=" + ws.url);
    ws.onopen = () => { console.log("[pilot] open"); setStatus("connected"); };
    ws.onclose = () => {
      setStatus("disconnected");
      setTimeout(connect, RECONNECT_MS);
    };
    ws.onerror = (ev) => {
      console.log("[pilot] error event, readyState=" + ws.readyState + " url=" + ws.url);
      try { ws.close(); } catch (e) {}
    };
    ws.onmessage = async (ev) => {
      let req;
      try { req = JSON.parse(ev.data); } catch (e) { return; }
      try {
        const data = await handle(req);
        ws.send(JSON.stringify({ id: req.id, ok: true, data }));
      } catch (e) {
        try { ws.send(JSON.stringify({ id: req.id, ok: false, error: String(e.message || e) })); } catch (e2) {}
      }
    };
  }

  async function setStatus(s) {
    try { await B.storage.local.set({ status: s }); } catch (e) {}
    try { B.action.setBadgeText({ text: s === "connected" ? "●" : "○" }); } catch (e) {}
  }

  loadToken().then(connect);
})();
