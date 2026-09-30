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
      const isFile = el.tagName === "INPUT" && el.type === "file";
      if (!isVisible(el) && !isFile) return; // ponytail: hidden file inputs stay addressable (sites hide them behind buttons)
      const idx = lastNodes.length;
      lastNodes.push(el);
      const r = el.getBoundingClientRect();
      out.push({
        ref: idx,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        label: (isFile ? "📎 " : "") + label(el),
        accept: el.getAttribute("accept") || "",
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

  function fireChange(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fileFromMsg(file) {
    if (!file || !file.data) throw new Error("no file data (pilot.py reads the local file for you)");
    const bin = atob(file.data);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], file.filename || "upload.bin", { type: file.mime || "application/octet-stream" });
  }

  function findUploadTarget(ref) {
    const el = lastNodes[ref];
    if (el) {
      if (el.tagName === "INPUT" && el.type === "file") return el;
      throw new Error("ref " + ref + " is not a file input (file inputs show as 📎 in snapshot)");
    }
    const fallback = document.querySelector("input[type=file]"); // ponytail: one fallback covers hidden LinkedIn-style inputs
    if (!fallback) throw new Error("no file input on this page");
    return fallback;
  }

  // Fill many fields in one round trip. items: [{ref, value}].
  // Auto-detects select / checkbox+radio / text / contenteditable. Never throws per batch.
  function fill(items) {
    const out = [];
    (items || []).forEach((it) => {
      const el = lastNodes[it.ref];
      if (!el) { out.push({ ref: it.ref, ok: false, error: "bad ref" }); return; }
      const v = it.value;
      try {
        if (el.tagName === "SELECT") {
          let matched = false;
          for (const o of el.options) {
            if (o.value === v || o.text.trim() === String(v).trim()) { el.value = o.value; matched = true; break; }
          }
          if (!matched) throw new Error("no option '" + v + "'");
          fireChange(el);
        } else if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
          el.checked = /^(1|true|yes|on|checked)$/i.test(String(v));
          fireChange(el);
        } else if ("value" in el) {
          el.focus();
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.value = v;
          fireChange(el);
        } else if (el.isContentEditable) {
          el.focus();
          el.textContent = v;
          el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        } else {
          throw new Error("not editable");
        }
        out.push({ ref: it.ref, ok: true });
      } catch (e) {
        out.push({ ref: it.ref, ok: false, error: String((e && e.message) || e) });
      }
    });
    return { ok: true, results: out };
  }

  // Put a real local file into <input type=file> (bytes arrive via pilot.py).
  function upload(ref, file) {
    const el = findUploadTarget(ref);
    const dt = new DataTransfer();
    dt.items.add(fileFromMsg(file));
    el.files = dt.files;
    fireChange(el);
    return { ok: true, ref, filename: file.filename };
  }

  // Synthetic drop with a real File. Not OS-level drag, but accepted
  // by virtually all dropzones (LinkedIn, Gmail, Drive, etc.).
  function drop(ref, file) {
    const el = lastNodes[ref];
    if (!el) throw new Error("bad ref " + ref + " (run snapshot first)");
    const dt = new DataTransfer();
    dt.items.add(fileFromMsg(file));
    el.scrollIntoView({ block: "center" });
    ["dragenter", "dragover", "drop"].forEach((t) => {
      const e = new DragEvent(t, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: dt }); // ponytail: Firefox ignores ctor dataTransfer, patch it on
      el.dispatchEvent(e);
    });
    return { ok: true, ref, filename: file.filename };
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
      if (msg.cmd === "fill") return Promise.resolve({ ok: true, data: fill(msg.items) });
      if (msg.cmd === "upload") return Promise.resolve({ ok: true, data: upload(msg.ref, msg.file) });
      if (msg.cmd === "drop") return Promise.resolve({ ok: true, data: drop(msg.ref, msg.file) });
      if (msg.cmd === "read") return Promise.resolve({ ok: true, data: read(msg.mode) });
      if (msg.cmd === "scroll")
        return Promise.resolve((window.scrollBy(msg.x || 0, msg.y || 600), { ok: true }));
      return Promise.resolve({ ok: false, error: "unknown content cmd" });
    } catch (e) {
      return Promise.resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
})();
