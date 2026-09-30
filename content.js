/* Firefox Pilot - content script (no dependencies, no AI, no network).
 * Answers page-level commands from background.js via runtime messages.
 * Every interactive element gets a stable numeric ref per snapshot.
 */
(() => {
  "use strict";
  let lastNodes = [];

  const INTERACTIVE = "a,button,input,select,textarea,[role=button],[role=link],[contenteditable=true]";

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  function label(el) {
    return (
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.value ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.tagName
    )
      .trim()
      .slice(0, 80);
  }

  function snapshot() {
    lastNodes = [];
    const out = [];
    document.querySelectorAll(INTERACTIVE).forEach((el) => {
      if (!isVisible(el)) return;
      const idx = lastNodes.length;
      lastNodes.push(el);
      const r = el.getBoundingClientRect();
      out.push({
        ref: idx,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        label: label(el),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      });
      if (out.length >= 200) return;
    });
    return {
      url: location.href,
      title: document.title,
      count: out.length,
      nodes: out,
    };
  }

  function click(ref) {
    const el = lastNodes[ref];
    if (!el) throw new Error("bad ref " + ref + " (run snapshot first)");
    el.scrollIntoView({ block: "center" });
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
    );
    if (el.tagName === "A" && el.href) location.href = el.href;
    return { ok: true, ref };
  }

  function typeText(ref, text, submit) {
    const el = lastNodes[ref];
    if (!el) throw new Error("bad ref " + ref + " (run snapshot first)");
    el.focus();
    if ("value" in el) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      throw new Error("ref " + ref + " is not editable");
    }
    if (submit) {
      const form = el.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
      else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    return { ok: true, ref };
  }

  function read(mode) {
    if (mode === "text") return { url: location.href, text: document.body.innerText.slice(0, 12000) };
    if (mode === "html") return { url: location.href, html: document.documentElement.outerHTML.slice(0, 60000) };
    return snapshot();
  }

  browser.runtime.onMessage.addListener((msg) => {
    try {
      if (msg.cmd === "snapshot") return Promise.resolve({ ok: true, data: snapshot() });
      if (msg.cmd === "click") return Promise.resolve({ ok: true, data: click(msg.ref) });
      if (msg.cmd === "type") return Promise.resolve({ ok: true, data: typeText(msg.ref, msg.text, msg.submit) });
      if (msg.cmd === "read") return Promise.resolve({ ok: true, data: read(msg.mode) });
      if (msg.cmd === "scroll")
        return Promise.resolve((window.scrollBy(msg.x || 0, msg.y || 600), { ok: true }));
      return Promise.resolve({ ok: false, error: "unknown content cmd" });
    } catch (e) {
      return Promise.resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
})();
