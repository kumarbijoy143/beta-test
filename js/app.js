// =====================================================================
// TERMINAL CONSOLE - TEST VERSION
// =====================================================================
function uid() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
}
const $ = (id) => document.getElementById(id);

let passkey = "";
// Permanent device id: the same on every launch, so you never get your own messages back.
const clientId = (() => {
  let id = lsGet("device_id");
  if (!id) { id = "d_" + uid(); lsSet("device_id", id); }
  return id;
})();
let channel = null;

const _d = lsGet("disappearing");
let disappearingEnabled = _d === "" ? true : _d === "true";
let burnDuration = parseInt(lsGet("burn_duration", "10"), 10) || 10;
let currentTheme = lsGet("theme", "stealth");
let currentFont = lsGet("font", "sans");
let currentFontSize = lsGet("font_size", "15");

let outbox = [];                 // only used when no vault is configured
const pending = new Map();       // sent but not yet delivered: msgId -> sent time
const sent = new Map();          // text of messages I sent (needed to replace an undelivered one on edit)
const seenIds = new Set();       // every message already shown (stops duplicates)
const unread = new Set();        // peer messages that arrived while app was in background
let appActive = document.visibilityState === "visible";
let syncing = false;
let pingTimer = null;

let peerOnline = false;
let peerWatchdogTimer = null;
let peerTypingTimer = null;
let lastTypingBroadcast = 0;
let localTypingTimeout = null;

let activeQuotedTarget = null;
let editingTargetMsgId = null;
let activeContextTarget = null;

const stream = $("chat-stream");
const msgInput = $("msg-input");
const connState = $("conn-state");
const statusDot = $("status-dot");
const typingIndicator = $("typing-indicator");

// =====================================================================
// CUSTOM DIALOGS (replace the browser's alert / confirm / prompt)
// =====================================================================
function uiDialog(o) {
  return new Promise(res => {
    const ov = document.createElement("div");
    ov.className = "os-modal-overlay ui-modal";
    ov.style.display = "flex";
    const box = document.createElement("div");
    box.className = "os-dialog";

    const h = document.createElement("div");
    h.className = "dialog-header";
    h.textContent = o.title;
    box.appendChild(h);

    if (o.text) {
      const p = document.createElement("div");
      p.className = "dialog-text";
      p.textContent = o.text;
      box.appendChild(p);
    }

    const inputs = {};
    (o.fields || []).forEach(f => {
      const i = document.createElement("input");
      i.className = "dialog-input";
      i.type = f.type || "text";
      i.placeholder = f.placeholder || "";
      i.value = f.value || "";
      i.autocomplete = "off";
      i.spellcheck = false;
      box.appendChild(i);
      inputs[f.id] = i;
    });

    const row = document.createElement("div");
    row.className = "dialog-actions";
    const done = (v) => { ov.remove(); res(v); };

    if (!o.hideCancel) {
      const c = document.createElement("button");
      c.className = "dialog-btn";
      c.textContent = o.cancel || "Cancel";
      c.onclick = () => done(o.fields ? null : false);
      row.appendChild(c);
    }
    const k = document.createElement("button");
    k.className = "dialog-btn " + (o.danger ? "danger" : "primary");
    k.textContent = o.ok || "OK";
    k.onclick = () => {
      if (o.fields && o.fields.length) {
        const v = {};
        for (const id in inputs) v[id] = inputs[id].value;
        done(v);
      } else {
        done(true);
      }
    };
    row.appendChild(k);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);

    const first = Object.values(inputs)[0];
    if (first) setTimeout(() => first.focus(), 80);
  });
}
const uiAlert = (title, text) => uiDialog({ title, text, hideCancel: true });
const uiConfirm = (title, text, ok, danger) => uiDialog({ title, text, ok, danger });
const uiForm = (o) => uiDialog(o);

// =====================================================================
// BASIC UI
// =====================================================================
function scrollToBottom(targetNode) {
  requestAnimationFrame(() => {
    if (targetNode && targetNode.scrollIntoView) {
      targetNode.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      stream.scrollTop = stream.scrollHeight;
    }
    setTimeout(() => { stream.scrollTop = stream.scrollHeight; }, 120);
  });
}

function resizeInputBox() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 110) + "px";
}

msgInput.addEventListener("input", () => {
  resizeInputBox();
  updateSendMic();
  if (!channel || !passkey) return;
  const now = Date.now();
  if (now - lastTypingBroadcast > 3000) {
    lastTypingBroadcast = now;
    dispatchRaw({ type: "typing", status: true, senderId: clientId });
  }
  clearTimeout(localTypingTimeout);
  localTypingTimeout = setTimeout(() => {
    dispatchRaw({ type: "typing", status: false, senderId: clientId });
  }, 2500);
});

msgInput.addEventListener("focus", () => scrollToBottom());
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$("numeric-key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") mountSession();
});

function triggerNativeEmojiKeyboard() { msgInput.focus(); }

// ---- App visibility: decides when a message counts as "read" ----
function setActive(v) {
  if (appActive === v) return;
  appActive = v;
  fbSetActive(v);
  if (v) {
    flushUnread();
    if (passkey) { pingNow(); syncVault(); }
  }
}
document.addEventListener("visibilitychange", () => setActive(document.visibilityState === "visible"));
window.addEventListener("focus", () => setActive(true));
window.addEventListener("blur", () => setActive(false));

window.addEventListener("DOMContentLoaded", () => {
  setTheme(currentTheme);
  setFont(currentFont);
  setFontSize(currentFontSize);
  injectUi();
  updateDisappearingUI();
  updateSettingsLabels();

  // Tapping a link inside a message asks first, then opens it.
  stream.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest(".msg-link");
    if (a) { e.preventDefault(); openLink(a.dataset.u); }
  });

  // Ask the browser to keep saved settings (key, vault link) permanently.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const keyInput = $("numeric-key");
  setTimeout(() => { if (keyInput) { keyInput.focus(); keyInput.click(); } }, 150);
});

// Adds the extra settings rows, the call screen and the settings entries.
function injectUi() {}

function panicExit() {
  endCall("CALL ENDED", true);
  cancelOutgoing();
  fileIn.clear();
  stream.innerHTML = "";
  outbox = [];
  pending.clear();
  passkey = "";
  keys = null;
  if (window.history.length > 1) window.history.back();
  else window.location.reload();
}

let mounting = false;
async function mountSession() {
  if (mounting) return;
  const val = $("numeric-key").value.trim();
  if (!val) return;

  mounting = true;
  const btn = document.querySelector(".passkey-btn");
  const oldLabel = btn.innerText;
  btn.innerText = "AUTHENTICATING…";
  btn.disabled = true;
  try {
    keys = await deriveKeys(val);
  } catch (e) {
    btn.innerText = oldLabel;
    btn.disabled = false;
    mounting = false;
    return uiAlert("Secure crypto unavailable",
      "This browser can't run the secure key function. Open the app from its https link.");
  }
  mounting = false;
  btn.innerText = oldLabel;
  btn.disabled = false;

  passkey = val;
  $("passkey-dialog").style.display = "none";
  setTimeout(() => msgInput.focus(), 100);

  initRelay();
  syncVault();

  lsSet("setup_done", "1");
}

// =====================================================================
// ENCRYPTION + TRANSPORT
// =====================================================================
// Passkey -> strong keys: PBKDF2 (200,000 rounds, SHA-256) gives 64 bytes that are
// split into the AES-GCM key, the relay channel name and the vault room name.
const te = new TextEncoder();
let keys = null;
const hex = (a) => Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
function b64(buf) {
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
async function deriveKeys(pass) {
  if (!(window.crypto && crypto.subtle)) throw new Error("no-subtle");
  const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: te.encode("terminal-console-v2"), iterations: 200000, hash: "SHA-256" }, base, 512));
  const aes = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { aes, chan: hex(bits.slice(32, 48)), room: hex(bits.slice(48, 64)) };
}
// AES-GCM also detects tampering. Output: base64( 12-byte random IV + ciphertext ).
async function encrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.aes, te.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}
async function decrypt(cipher) {
  try {
    const raw = unb64(cipher);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, keys.aes, raw.slice(12));
    return new TextDecoder().decode(pt);
  } catch (e) {
    return null;
  }
}
function dispatchRaw(dataObj) {
  if (!channel) return;
  const jsonStr = JSON.stringify(dataObj);
  if (typeof channel.publish === "function") channel.publish("message", jsonStr);
  else if (typeof channel.send === "function") channel.send(jsonStr);
}
// Every command is encrypted, so only someone with the passkey can send one.
let sendChain = Promise.resolve();   // keeps commands in the order they were issued
function sendCtl(obj) {
  sendChain = sendChain.then(async () => {
    if (!keys) return;
    const c = await encrypt(JSON.stringify(obj));
    dispatchRaw({ type: "ctl", c, senderId: clientId });
  }).catch(() => {});
  return sendChain;
}

function initRelay() {
  const apiKey = getStoredApiKey();
  if (!apiKey) {
    setPeerStatusUI("KEY REQUIRED", "offline");
    logSys("SETUP: Add your Relay Product Key in Settings (three dots).");
    return;
  }
  setPeerStatusUI("CONNECTING RELAY...", "connecting");
  try {
    const PS = window.PieSocket?.default || window.PieSocket;
    if (typeof PS !== "function") {
      setPeerStatusUI("LIB ERROR", "offline");
      logSys("ERR: PieSocket library failed to load.");
      return;
    }
    const piesocket = new PS({ clusterId: PIESOCKET_CLUSTER_ID, apiKey: apiKey, notifySelf: false });
    const dynamicChannel = "ch_" + keys.chan;
    const subResult = piesocket.subscribe(dynamicChannel);
    if (subResult && typeof subResult.then === "function") {
      subResult.then((ch) => setupChannel(ch)).catch(() => {
        setPeerStatusUI("AUTH FAILED", "offline");
        logSys("SOCKET ERROR: invalid key or network rejected.");
      });
    } else {
      setupChannel(subResult);
    }
  } catch (e) {
    setPeerStatusUI("INIT ERROR", "offline");
    logSys("ERR: " + e.message);
  }
}

function setupChannel(ch) {
  channel = ch;
  setPeerStatusUI("WAITING FOR PEER...", "connecting");
  const onMsg = (raw) => handlePacket(typeof raw === "string" ? raw : JSON.stringify(raw));
  if (typeof channel.listen === "function") channel.listen("message", onMsg);
  else if (typeof channel.on === "function") channel.on("message", onMsg);

  clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (appActive) pingNow(); }, 25000);
  pingNow();
}
function pingNow() { dispatchRaw({ type: "ping", senderId: clientId }); }

function refreshPeerWatchdog() {
  const wasOffline = !peerOnline;
  peerOnline = true;
  clearTimeout(peerWatchdogTimer);
  setPeerStatusUI("PEER ONLINE", "online");
  if (wasOffline) broadcastConfigSync();
  peerWatchdogTimer = setTimeout(() => {
    peerOnline = false;
    clearTimeout(peerTypingTimer);
    typingIndicator.style.display = "none";
    setPeerStatusUI("WAITING FOR PEER...", "connecting");
  }, 70000);
}

function setPeerStatusUI(text, state) {
  connState.innerText = text;
  statusDot.className = "status-dot";
  if (state === "online") statusDot.classList.add("online");
  else if (state === "offline") statusDot.classList.add("offline");
}

function handlePacket(raw) {
  try {
    const pkg = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!pkg || pkg.senderId === clientId) return;

    if (pkg.type === "ping") {
      const was = !peerOnline;
      refreshPeerWatchdog();
      if (was) pingNow();
      return;
    }
    if (pkg.type === "typing") {
      refreshPeerWatchdog();
      handlePeerTyping(pkg.status);
      return;
    }
    if (pkg.type === "ctl") {
      recvChain = recvChain.then(async () => {
        const plain = await decrypt(pkg.c);
        if (!plain) return;
        refreshPeerWatchdog();
        handleCtl(JSON.parse(plain));
      }).catch(() => {});
    }
  } catch (e) {}
}
let recvChain = Promise.resolve();

function handleCtl(o) {
  switch (o.op) {
    case "chat":
      clearTimeout(peerTypingTimer);
      typingIndicator.style.display = "none";
      receiveMessage(o.m);
      if (getStoredVaultUrl() && o.m && o.m.msgId) vaultCall({ action: "delete", ids: [o.m.msgId] });
      break;
    case "ack": markDelivered(o.id); break;
    case "read": (o.ids || []).forEach(markRead); break;
    case "edit": applyRemoteEdit(o.id, String(o.text || "")); break;
    case "react": applyReactionToBubble(o.id, o.emoji); break;
    case "purge":
      wipeLocal();
      logSys("SESSION BUFFER SHREDDED BY PEER.");
      break;
    case "cfg": applyRemoteConfig(o.enabled, o.duration); break;
    case "call":
    case "cend": handleCallSignal(o); break;
    case "fmeta":
    case "fchunk":
    case "fcancel": handleFileOp(o); break;
  }
}

function handlePeerTyping(isTyping) {
  clearTimeout(peerTypingTimer);
  if (isTyping) {
    typingIndicator.style.display = "flex";
    scrollToBottom(typingIndicator);
    peerTypingTimer = setTimeout(() => { typingIndicator.style.display = "none"; }, 3500);
  } else {
    typingIndicator.style.display = "none";
  }
}

// =====================================================================
// OFFLINE VAULT (messages wait here until delivered)
// =====================================================================
function getVaultRoomHash() {
  return "v_" + keys.room;
}

async function vaultCall(body) {
  const url = getStoredVaultUrl();
  if (!url || !passkey) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ room: getVaultRoomHash(), ...body })
    });
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function storeInVault(m) {
  const r = await vaultCall({
    action: "store",
    msgId: m.msgId,
    from: clientId,
    envelope: await encrypt(JSON.stringify(m)),
    ttlDays: getVaultDays()
  });
  if (r && r.status === "stored") return true;
  const why = {
    room_full: "VAULT FULL",
    storage_full: "VAULT STORAGE FULL",
    too_large: "MESSAGE TOO LARGE FOR VAULT",
    busy: "VAULT BUSY",
    unknown_action: "VAULT SCRIPT NEEDS THE NEW VERSION"
  }[r && r.code] || "VAULT UNREACHABLE";
  logSys(why + ". SENT LIVE ONLY.");
  return false;
}

// Collects waiting messages, shows them, then removes only those from the vault.
async function syncVault() {
  if (syncing || !passkey || !getStoredVaultUrl()) return;
  syncing = true;
  try {
    const r = await vaultCall({ action: "list" });
    if (!r || r.status !== "ok") return;
    const own = new Set();
    const del = [];
    let fresh = 0;

    for (const item of r.messages) {
      let m = null;
      try {
        const p = await decrypt(item.envelope);
        if (p) m = JSON.parse(p);
      } catch (e) {}
      if (!m) continue;
      if (m.senderId === clientId) { own.add(item.id); continue; }
      if (m.edit) {                       // an edit that was saved while we were away
        applyRemoteEdit(String(m.target || ""), String(m.text || ""));
        del.push(item.id);
        continue;
      }
      if (receiveMessage(m)) fresh++;
      del.push(item.id);
    }
    if (del.length) vaultCall({ action: "delete", ids: del });

    if (!r.more) {
      const now = Date.now();
      [...pending.keys()].forEach(id => {
        if (!own.has(id) && now - pending.get(id) > 8000) markDelivered(id, true);
      });
    }
    if (fresh) logSys(`${fresh} OFFLINE MESSAGE(S) RECEIVED.`);
  } finally {
    syncing = false;
  }
}
setInterval(() => { if (appActive && passkey && getStoredVaultUrl()) syncVault(); }, 20000);

// =====================================================================
// MESSAGES: send, receive, delivered, read
// =====================================================================
function getFormattedTime() {
  const d = new Date();
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !passkey) { msgInput.focus(); return; }

  clearTimeout(localTypingTimeout);
  dispatchRaw({ type: "typing", status: false, senderId: clientId });

  if (editingTargetMsgId) {
    const editId = editingTargetMsgId;
    applyLocalEdit(editId, text);
    sendCtl({ op: "edit", id: editId, text });
    if (getStoredVaultUrl()) {
      const original = sent.get(editId);
      if (original && pending.has(editId)) {
        // Not delivered yet: replace the waiting copy so the peer receives the edited text.
        original.text = text;
        storeInVault(original);
      } else {
        // Already delivered: leave a small edit note for a phone that missed the live one.
        storeInVault({ msgId: "e_" + uid(), edit: true, target: editId, text, senderId: clientId });
      }
    }
    msgInput.value = "";
    msgInput.style.height = "auto";
    cancelReplyOrEdit();
    msgInput.focus();
    return;
  }

  const m = {
    msgId: "m_" + uid(),
    text,
    timestamp: getFormattedTime(),
    burn: disappearingEnabled ? burnDuration : 0,
    reply: activeQuotedTarget ? { ...activeQuotedTarget } : null,
    senderId: clientId
  };

  msgInput.value = "";
  msgInput.style.height = "auto";
  cancelReplyOrEdit();
  msgInput.focus();

  const bubble = renderBubble(m.text, "you", m.msgId, m.timestamp, m.burn, m.reply);
  pending.set(m.msgId, Date.now());
  sent.set(m.msgId, m);
  sendCtl({ op: "chat", m }).then(() => markSentToServer(m.msgId)).catch(() => {});
  scrollToBottom(bubble);
}

// Without a vault: retry up to 3 times, then stop.
setInterval(() => {
  if (!channel || !outbox.length) return;
  const now = Date.now();
  outbox.forEach(o => {
    if (now < o.next || o.tries >= 3) return;
    o.tries++;
    o.next = now + (o.tries === 1 ? 15000 : 60000);
    sendCtl({ op: "chat", m: o.m });
  });
}, 5000);

// Returns true if the message is new.
function receiveMessage(m) {
  if (!m || typeof m.msgId !== "string") return false;
  if (seenIds.has(m.msgId)) {
    sendCtl({ op: "ack", id: m.msgId });
    return false;
  }
  seenIds.add(m.msgId);

  let reply = null;
  if (m.reply && m.reply.text) {
    // "You" and "Peer" are from the sender's point of view, so swap them.
    reply = { sender: m.reply.sender === "You" ? "Peer" : "You", text: String(m.reply.text) };
  }
  renderBubble(String(m.text || ""), "peer", m.msgId, String(m.timestamp || ""), Number(m.burn) || 0, reply);
  sendCtl({ op: "ack", id: m.msgId });
  afterPeerBubble(m.msgId);
  return true;
}

// "Read" means the app is actually open and visible.
function afterPeerBubble(id) {
  if (appActive) markPeerRead([id]);
  else unread.add(id);
}
function markPeerRead(ids) {
  const ok = [];
  ids.forEach(id => {
    unread.delete(id);
    const w = $(id);
    if (!w) return;
    ok.push(id);
    const b = parseInt(w.dataset.burnSecs || 0, 10);
    if (b > 0) startBurn(w, b);
  });
  if (ok.length) sendCtl({ op: "read", ids: ok });
}
function flushUnread() {
  if (unread.size) markPeerRead([...unread]);
}

function markDelivered(id, skipVaultDelete) {
  pending.delete(id);
  outbox = outbox.filter(o => o.m.msgId !== id);
  const w = $(id);
  if (w && w.dataset.role === "you") {
    const t = w.querySelector(".ticks");
    if (t && !t.classList.contains("seen")) t.innerText = "✓✓";
  }
  if (!skipVaultDelete && getStoredVaultUrl()) vaultCall({ action: "delete", ids: [id] });
}
function markRead(id) {
  markDelivered(id, true);
  const w = $(id);
  if (!w || w.dataset.role !== "you") return;
  const t = w.querySelector(".ticks");
  if (t) { t.innerText = "✓✓"; t.classList.add("seen"); }
  const b = parseInt(w.dataset.burnSecs || 0, 10);
  if (b > 0) startBurn(w, b);
}

function startBurn(node, seconds) {
  if (node.dataset.burning) return;
  node.dataset.burning = "1";
  let s = seconds;
  const digit = node.querySelector(".burn-digit");
  const interval = setInterval(() => {
    s--;
    if (digit) digit.innerText = `${s}s`;
    if (s <= 0) {
      clearInterval(interval);
      node.style.opacity = "0";
      node.style.transform = "scale(0.9)";
      node.style.transition = "opacity 0.25s ease, transform 0.25s ease";
      setTimeout(() => node.remove(), 250);
    }
  }, 1000);
}

function wipeLocal() {
  fileIn.clear();
  stream.innerHTML = "";
  stream.appendChild(typingIndicator);
  outbox = [];
  pending.clear();
  unread.clear();
}

// =====================================================================
// BUBBLE RENDERING (all peer-supplied values are escaped)
// =====================================================================
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}
// Turns links (with or without https://) into tappable links. Everything else stays escaped text.
const LINK_TLDS = "com|net|org|in|io|co|app|dev|me|info|gov|edu|ly|tv|xyz|online|site|live|ai|us|uk|ca|au|de|fr|jp|ru|be|ch|fm|gg|to|so|link|page|store|shop|tech|cloud|club|blog|news|bio";
const LINK_RE_SRC =
  "https?:\\/\\/[^\\s<>\"']+" +
  "|www\\.[^\\s<>\"']+" +
  "|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:" + LINK_TLDS + ")(?![a-z0-9-])(?::\\d{2,5})?(?:[\\/?#][^\\s<>\"']*)?";
function linkify(text) {
  text = String(text || "");
  const re = new RegExp(LINK_RE_SRC, "gi");
  let out = "", last = 0, m;
  while ((m = re.exec(text))) {
    let url = m[0];
    const hasScheme = /^https?:\/\//i.test(url);
    const prev = m.index > 0 ? text.charAt(m.index - 1) : "";
    if (!hasScheme && prev && /[@\w.\/-]/.test(prev)) continue;   // emails, parts of longer words
    const trail = url.match(/[.,;:!?)\]]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    if (!url) continue;
    const href = hasScheme ? url : "https://" + url;
    out += escapeHtml(text.slice(last, m.index));
    out += `<a class="msg-link" href="#" data-u="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
    re.lastIndex = last;
  }
  return out + escapeHtml(text.slice(last));
}

async function openLink(u) {
  let url;
  try { url = new URL(u); } catch (e) { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  const ok = await uiConfirm("Open this link?", url.hostname + "\n\n" + url.href, "Open");
  if (!ok) return;
  if (window.AndroidBridge && typeof window.AndroidBridge.openLink === "function") {
    window.AndroidBridge.openLink(url.href);   // in-app browser, if the wrapper supports it
  } else {
    window.open(url.href, "_blank", "noopener");
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  ta.remove();
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function renderBubble(text, role, msgId, timeStr, burnSecs, replyData, fileData) {
  const wrap = document.createElement("div");
  wrap.className = `msg-wrap ${role}`;
  wrap.id = msgId;
  wrap.dataset.role = role;

  burnSecs = Number(burnSecs) || 0;
  const displayTime = escapeHtml(timeStr || getFormattedTime());
  const isSolo = !fileData && checkIsSoloEmoji(text);
  const isImg = !!(fileData && /^image\/(png|jpe?g|gif|webp)$/.test(fileData.mime || ""));

  const badgeHtml = burnSecs > 0 ? `
    <span class="burn-badge">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>
      <span class="burn-digit">${burnSecs}s</span>
    </span>` : "";

  const quotedHtml = (replyData && replyData.text) ? `
    <div class="quoted-card">
      <strong style="color:var(--accent); font-size:11px;">${escapeHtml(replyData.sender)}</strong><br/>
      ${escapeHtml(replyData.text)}
    </div>` : "";

  const textBodyHtml = isImg ? "" : `<span class="msg-text">${linkify(text)}</span>`;
  wrap.dataset.kind = fileData ? "file" : "text";
  const ticksHtml = role === "you" ? '<span class="ticks">🕓</span>' : "";

  wrap.innerHTML = `
    <div class="swipe-reply-icon">
      <svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
    </div>
    <div class="bubble ${isSolo ? "emoji-solo" : ""}">
      ${quotedHtml}
      <div class="media-slot"></div>
      ${textBodyHtml}
      <div class="msg-meta">
        ${badgeHtml}
        <span class="timestamp">${displayTime}</span>
        ${ticksHtml}
      </div>
      <div class="bubble-reaction"></div>
    </div>`;
  wrap.dataset.burnSecs = burnSecs;

  // Files are attached with DOM calls only (never built from text).
  if (fileData && fileData.url && String(fileData.url).startsWith("blob:")) {
    const slot = wrap.querySelector(".media-slot");
    if (isImg) {
      const img = document.createElement("img");
      img.className = "media-preview";
      img.src = fileData.url;
      img.alt = "Image";
      slot.appendChild(img);
    } else if (/^audio\//.test(fileData.mime || "")) {
      const au = document.createElement("audio");
      au.controls = true;
      au.preload = "metadata";
      au.className = "voice-note";
      au.src = fileData.url;
      slot.appendChild(au);
    } else {
      const a = document.createElement("a");
      a.className = "file-card";
      a.href = fileData.url;
      a.download = fileData.name || "file";
      a.textContent = "📎 " + (fileData.name || "File") + " (" + fmtSize(fileData.size) + ")";
      slot.appendChild(a);
    }
  }

  setupBubbleInteractions(wrap, text, role);
  stream.insertBefore(wrap, typingIndicator);
  scrollToBottom(wrap);
  return wrap;
}

function logSys(msg) {
  const el = document.createElement("div");
  el.className = "sys-log";
  el.innerText = msg;
  stream.insertBefore(el, typingIndicator);
  scrollToBottom(el);
}

// =====================================================================
// BUBBLE GESTURES, REPLY, EDIT, REACTIONS
// =====================================================================
// The text as currently shown (it changes after an edit).
function liveText(wrap, fallback) {
  const n = wrap.querySelector(".msg-text");
  return n ? n.innerText : fallback;
}

function setupBubbleInteractions(wrap, text, role) {
  let startX = 0, currentX = 0, isSwiping = false, longPressTimer = null;
  const swipeIcon = wrap.querySelector(".swipe-reply-icon");

  // Never let a long press select the words inside a bubble.
  wrap.addEventListener("contextmenu", (e) => e.preventDefault());
  wrap.addEventListener("selectstart", (e) => e.preventDefault());

  wrap.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    isSwiping = false;
    longPressTimer = setTimeout(() => {
      if (!isSwiping) openClampedContextMenu(wrap, liveText(wrap, text), role);
    }, 450);
  }, { passive: true });

  wrap.addEventListener("touchmove", (e) => {
    currentX = e.touches[0].clientX;
    const diffX = currentX - startX;
    if (diffX > 10) {
      clearTimeout(longPressTimer);
      isSwiping = true;
      const boundedX = Math.min(diffX, 60);
      wrap.style.transform = `translateX(${boundedX}px)`;
      if (swipeIcon) swipeIcon.style.opacity = boundedX / 60;
    }
  }, { passive: true });

  wrap.addEventListener("touchend", () => {
    clearTimeout(longPressTimer);
    const diffX = currentX - startX;
    if (isSwiping && diffX >= 50) {
      if (navigator.vibrate) navigator.vibrate(12);
      setReplyTarget(liveText(wrap, text), role === "you" ? "You" : "Peer");
    }
    wrap.style.transform = "translateX(0px)";
    if (swipeIcon) swipeIcon.style.opacity = 0;
    isSwiping = false;
    startX = 0;
    currentX = 0;
  });
}

let ctxOpenedAt = 0;

// Long press: highlight the message, show a top action bar (Reply / Copy / Edit)
// and a row of reactions next to it. Nothing is drawn on top of the message text.
function openClampedContextMenu(bubbleWrap, text, role) {
  hideContext();
  activeContextTarget = { wrap: bubbleWrap, text, role, id: bubbleWrap.id };
  bubbleWrap.classList.add("msg-selected");

  const canEdit = role === "you" && bubbleWrap.dataset.kind !== "file";
  $("select-edit").style.display = canEdit ? "flex" : "none";
  $("select-bar").style.display = "flex";

  const dock = $("reaction-dock");
  dock.style.display = "flex";
  const dockH = dock.offsetHeight || 44;
  const headerBottom = document.querySelector("header").getBoundingClientRect().bottom;
  const rect = bubbleWrap.getBoundingClientRect();
  let top = rect.top - dockH - 8;                          // above the message
  if (top < headerBottom + 4) top = rect.bottom + 8;       // no room above: put it below
  const maxTop = window.innerHeight - dockH - 76;          // stay clear of the typing bar
  if (top > maxTop) top = Math.max(headerBottom + 4, maxTop);
  dock.style.top = top + "px";
  if (role === "you") { dock.style.right = "12px"; dock.style.left = "auto"; }
  else { dock.style.left = "12px"; dock.style.right = "auto"; }

  if (navigator.vibrate) navigator.vibrate(15);

  ctxOpenedAt = Date.now();
  setTimeout(() => {
    document.addEventListener("click", ctxOutside);
    document.addEventListener("touchstart", ctxOutside);
  }, 100);
}

function hideContext() {
  $("reaction-dock").style.display = "none";
  $("select-bar").style.display = "none";
  if (activeContextTarget && activeContextTarget.wrap) activeContextTarget.wrap.classList.remove("msg-selected");
  document.removeEventListener("click", ctxOutside);
  document.removeEventListener("touchstart", ctxOutside);
}

function ctxOutside(e) {
  if (Date.now() - ctxOpenedAt < 400) return;   // ignore the finger lifting after the long press
  if (!$("reaction-dock").contains(e.target) && !$("select-bar").contains(e.target)) hideContext();
}

function triggerContextAction(action) {
  if (!activeContextTarget) return;
  const t = activeContextTarget;
  if (action === "reply") {
    setReplyTarget(t.text, t.role === "you" ? "You" : "Peer");
  } else if (action === "copy") {
    copyText(t.text);
  } else if (action === "edit") {
    startEditMessage(t.id, t.text);
  }
  hideContext();
}

function startEditMessage(msgId, currentText) {
  editingTargetMsgId = msgId;
  activeQuotedTarget = null;
  $("reply-target-title").innerText = "Editing message";
  $("reply-target-text").innerText = currentText;
  $("reply-preview-bar").style.display = "flex";
  msgInput.value = currentText;
  resizeInputBox();
  msgInput.focus();
}

function applyLocalEdit(msgId, newText) {
  const wrap = $(msgId);
  if (wrap) {
    const node = wrap.querySelector(".msg-text");
    if (node) node.innerHTML = linkify(newText);
    addEditedBadge(wrap);
  }
}
function applyRemoteEdit(msgId, newText) {
  const wrap = $(msgId);
  if (wrap && wrap.dataset.role === "peer") {   // a peer can only edit its own messages
    const node = wrap.querySelector(".msg-text");
    if (node) node.innerHTML = linkify(newText);
    addEditedBadge(wrap);
  }
}
function addEditedBadge(wrap) {
  const meta = wrap.querySelector(".msg-meta");
  if (meta && !meta.querySelector(".edited-badge")) {
    const b = document.createElement("span");
    b.className = "edited-badge";
    b.innerText = "edited";
    meta.insertBefore(b, meta.firstChild);
  }
}

function setReplyTarget(text, senderLabel) {
  editingTargetMsgId = null;
  activeQuotedTarget = { sender: senderLabel, text };
  $("reply-target-title").innerText = `Replying to ${senderLabel}`;
  $("reply-target-text").innerText = text;
  $("reply-preview-bar").style.display = "flex";
  msgInput.focus();
}
function cancelReplyOrEdit() {
  activeQuotedTarget = null;
  editingTargetMsgId = null;
  $("reply-preview-bar").style.display = "none";
}

function selectReaction(emoji) {
  if (!activeContextTarget) return;
  applyReactionToBubble(activeContextTarget.id, emoji);
  sendCtl({ op: "react", id: activeContextTarget.id, emoji });
  hideContext();
}
function applyReactionToBubble(msgId, emoji) {
  const wrap = $(msgId);
  if (!wrap) return;
  const el = wrap.querySelector(".bubble-reaction");
  if (el) { el.innerText = String(emoji || "").slice(0, 8); el.style.display = "block"; }
}

// =====================================================================
// CALLS (voice + video) through VDO.Ninja. Signals travel through the encrypted channel.
// Live signals (invite, accept, heartbeat) use op "call". Important ones (end, mode, video requests)
// use op "cend", which is durable, so they still arrive after a dropped connection.
const call = { state: "idle", video: false, facing: "front", room: "", pw: "", timer: null, joinTimer: null,
  tick: null, hbTimer: null, hbWatch: null, lastHb: 0, t0: 0, joined: false,
  micOn: true, camOn: true, spkOn: true };

const ICON = {
  mic: '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/><line x1="3" y1="3" x2="21" y2="21"/></svg>',
  spk: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  spkOff: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>',
  camOff: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
  flip: '<svg viewBox="0 0 24 24"><path d="M3 7h13l-3-3"/><path d="M21 17H8l3 3"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>'
};

function getContactName() { return lsGet("contact_name", "Partner") || "Partner"; }

function updateContactLabel() {
  const el = $("current-contact-label");
  if (el) el.innerText = getContactName();
}

async function changeContactName() {
  const r = await uiForm({
    title: "Contact name",
    text: "The name shown on your call screen. Saved only on this phone.",
    fields: [{ id: "v", value: getContactName(), placeholder: "Partner" }],
    ok: "Save"
  });
  if (!r) return;
  lsSet("contact_name", String(r.v || "").trim().slice(0, 30) || "Partner");
  updateContactLabel();
}

function sendSig(k, extra) {
  return sendCtl(Object.assign({ op: "cend", k, room: call.room }, extra || {}));
}

function sendLive(k, extra) {
  return sendCtl(Object.assign({ op: "call", k, room: call.room }, extra || {}));
}

function callUI() {
  const scr = $("call-screen");
  if (call.state === "idle") { scr.style.display = "none"; return; }
  scr.style.display = "flex";
  const name = getContactName();
  $("call-avatar").innerText = name.charAt(0).toUpperCase();
  $("call-name").innerText = name;
  $("top-name").innerText = name;
  const live = call.state === "active" && call.joined;
  const kind = call.video ? "video" : "voice";
  let status = "";
  if (call.state === "calling") status = "Calling…";
  else if (call.state === "ringing") status = "Incoming " + kind + " call";
  else if (call.state === "active" && !call.joined) status = "Connecting…";
  else if (live && !call.video) status = fmtTime(Date.now() - call.t0);
  $("call-status").innerText = status;
  $("call-cover").style.display = (!live || !call.video) ? "flex" : "none";
  $("call-top").style.display = live && call.video ? "flex" : "none";

  const ringing = call.state === "ringing";
  const active = call.state === "active";
  $("call-accept").style.display = ringing ? "flex" : "none";
  $("call-end").style.display = "flex";
  $("call-mic-btn").style.display = active ? "flex" : "none";
  $("call-spk-btn").style.display = active ? "flex" : "none";
  $("call-mode-btn").style.display = active ? "flex" : "none";
  $("call-cam-btn").style.display = active && call.video ? "flex" : "none";
  $("call-flip-btn").style.display = active && call.video ? "flex" : "none";
  $("call-accept").innerHTML = ICON.phone;
  $("call-end").innerHTML = ICON.phone;
  $("call-end").title = ringing ? "Decline" : "End";
  $("call-flip-btn").innerHTML = ICON.flip;
  $("call-mode-btn").innerHTML = call.video ? ICON.phone : ICON.cam;
  $("call-mode-btn").title = call.video ? "Switch to voice" : "Switch to video";
  refreshCallButtons();
}

function refreshCallButtons() {
  const mic = $("call-mic-btn"), spk = $("call-spk-btn"), cam = $("call-cam-btn");
  mic.innerHTML = call.micOn ? ICON.mic : ICON.micOff;
  mic.classList.toggle("off", !call.micOn);
  mic.title = call.micOn ? "Mute" : "Unmute";
  spk.innerHTML = call.spkOn ? ICON.spk : ICON.spkOff;
  spk.classList.toggle("off", !call.spkOn);
  spk.title = call.spkOn ? "Speaker on" : "Speaker off";
  cam.innerHTML = call.camOn ? ICON.cam : ICON.camOff;
  cam.classList.toggle("off", !call.camOn);
  cam.title = call.camOn ? "Camera on" : "Camera off";
}

function postToCall(msg) {
  const f = $("vdo-frame");
  if (f && f.contentWindow) f.contentWindow.postMessage(msg, "*");
}

// Re-applies mute, speaker and camera states after the call frame loads.
function applyCallStates() {
  postToCall({ mic: call.micOn });
  postToCall({ mute: !call.spkOn });
  if (call.video) postToCall({ camera: call.camOn });
}

function toggleCallMic() {
  if (call.state !== "active") return;
  call.micOn = !call.micOn;
  postToCall({ mic: call.micOn });
  refreshCallButtons();
}

function toggleCallCam() {
  if (call.state !== "active" || !call.video) return;
  call.camOn = !call.camOn;
  postToCall({ camera: call.camOn });
  refreshCallButtons();
}

function toggleCallSpk() {
  if (call.state !== "active") return;
  call.spkOn = !call.spkOn;
  postToCall({ mute: !call.spkOn });
  refreshCallButtons();
}

function flipCamera() {
  if (call.state !== "active" || !call.video) return;
  call.facing = call.facing === "front" ? "rear" : "front";
  loadFrame();
}

function triggerCallHandOff(isVideo) { startCall(!!isVideo); }

async function startCall(video) {
  if (call.state !== "idle") return;
  if (!passkey || !channel || !peerOnline) {
    return uiAlert("Peer is offline", "Calls need both phones online with the app open.");
  }
  Object.assign(call, {
    state: "calling", video: !!video, facing: "front", joined: false,
    micOn: true, camOn: true, spkOn: true,
    room: "c" + uid() + uid(), pw: uid() + uid()
  });
  callUI();
  sendCtl({ op: "call", k: "invite", video: call.video, room: call.room, pw: call.pw });
  call.timer = setTimeout(() => { if (call.state === "calling") endCall("No answer", true); }, 45000);
}

function acceptCall() {
  if (call.state !== "ringing") return;
  clearTimeout(call.timer);
  sendLive("accept");
  openCall();
}

function hangUp() {
  if (call.state === "ringing") endCall("Declined", true);
  else endCall("Call ended", true);
}

function vdoUrl() {
  const p = new URLSearchParams();
  p.set("room", call.room);
  p.set("password", call.pw);
  p.set("autostart", "");
  p.set("cleanoutput", "");
  if (call.video) {
    p.set("webcam", "");
    p.set("facing", call.facing === "rear" ? "rear" : "front");
    p.set("minipreview", "");          // self-view as a small corner preview
  } else {
    p.set("miconly", "");              // audio only, no video player
    p.set("audiodevice", "1");         // default microphone
  }
  const t = getTurnConfig();
  if (t && t.url) p.set("turn", [t.user || "", t.cred || "", t.url].join(";"));
  return "https://vdo.ninja/?" + p.toString();
}

async function micCamProbe(video) {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
    s.getTracks().forEach(t => t.stop());
    return true;
  } catch (e) { return false; }
}

function removeFrame() {
  const f = $("vdo-frame");
  if (f) { f.src = "about:blank"; f.remove(); }
}

function closeFrame() {
  clearTimeout(call.joinTimer);
  removeFrame();
}

function loadFrame() {
  removeFrame();
  const f = document.createElement("iframe");
  f.id = "vdo-frame";
  f.allow = "camera; microphone; autoplay; fullscreen";
  f.src = vdoUrl();
  $("cs-frame-slot").appendChild(f);
  setTimeout(applyCallStates, 4000);
}

async function openCall() {
  closeFrame();
  call.state = "active";
  call.joined = false;
  callUI();
  const ok = await micCamProbe(call.video);
  if (call.state === "idle") return;
  if (!ok) {
    await uiAlert("Mic or camera blocked", "Allow microphone and camera for this app in your phone's settings, then try again.");
    return endCall("Call ended", true);
  }
  startHeartbeat();
  loadFrame();
  call.joinTimer = setTimeout(markJoined, 20000);   // safety: the cover never stays up for good
}

// The cover comes off once the other person has joined.
function markJoined() {
  if (call.state !== "active" || call.joined) return;
  call.joined = true;
  clearTimeout(call.joinTimer);
  call.t0 = Date.now();
  clearInterval(call.tick);
  call.tick = setInterval(updateCallTimer, 1000);
  applyCallStates();
  callUI();
}

function updateCallTimer() {
  if (call.state !== "active" || !call.joined) return;
  const t = fmtTime(Date.now() - call.t0);
  if (call.video) $("top-status").innerText = t;
  else $("call-status").innerText = t;
}

window.addEventListener("message", (e) => {
  const f = $("vdo-frame");
  if (!f || e.source !== f.contentWindow || call.joined) return;
  const s = typeof e.data === "string" ? e.data : JSON.stringify(e.data || "");
  if (/join/i.test(s)) markJoined();
});

// Heartbeat: each phone says "still here". If the other one goes quiet, the call ends on both sides.
function startHeartbeat() {
  clearInterval(call.hbTimer);
  clearInterval(call.hbWatch);
  call.lastHb = Date.now();
  call.hbTimer = setInterval(() => { if (call.state === "active") sendLive("hb"); }, 4000);
  call.hbWatch = setInterval(() => {
    if (call.state === "active" && Date.now() - call.lastHb > 20000) endCall("Connection lost", true);
  }, 3000);
}

// Voice to video: the other person must agree.
function toggleMode() {
  if (call.state !== "active") return;
  if (call.video) switchMode(false, true);
  else requestVideo();
}

async function requestVideo() {
  const ok = await micCamProbe(true);
  if (!ok) return uiAlert("Camera blocked", "Allow the camera for this app in your phone's settings.");
  sendSig("vidreq");
  logSys("ASKED PARTNER TO START VIDEO.");
}

async function askVideo() {
  if (call.state !== "active" || call.video) return;
  const ok = await micCamProbe(true);
  if (call.state !== "active") return;
  if (!ok) { sendSig("vidno"); return; }
  const yes = await uiConfirm("Switch to video?", "Your partner wants to start video.", "Accept");
  if (call.state !== "active") return;
  if (yes) { sendSig("vidyes"); await switchMode(true, false); }
  else sendSig("vidno");
}

async function switchMode(video, notify) {
  if (call.state !== "active") return;
  if (video) {
    const ok = await micCamProbe(true);
    if (!ok) return uiAlert("Camera blocked", "Allow the camera for this app in your phone's settings.");
  }
  call.video = !!video;
  if (call.video) call.camOn = true;
  if (notify) sendSig("mode", { video: call.video });
  loadFrame();
  callUI();
}

function endCall(reason, notify) {
  if (call.state === "idle") return;
  const dur = call.state === "active" && call.joined ? fmtTime(Date.now() - call.t0) : "";
  const kind = call.video ? "Video call" : "Voice call";
  if (notify) sendSig(call.state === "ringing" ? "decline" : "end");
  clearTimeout(call.timer);
  clearInterval(call.tick);
  clearInterval(call.hbTimer);
  clearInterval(call.hbWatch);
  closeFrame();
  Object.assign(call, { state: "idle", room: "", pw: "", joined: false, t0: 0, video: false, facing: "front" });
  callUI();
  if (dur) logSys(kind + " · " + dur);
  else if (reason) logSys(reason.toUpperCase());
}

async function handleCallSignal(o) {
  try {
    if (o.k === "invite") {
      if (call.state !== "idle") { sendCtl({ op: "call", k: "busy" }); return; }
      const ok = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(s);
      if (!ok(o.room) || !ok(o.pw)) return;
      Object.assign(call, {
        state: "ringing", video: !!o.video, facing: "front", room: o.room, pw: o.pw,
        joined: false, micOn: true, camOn: true, spkOn: true
      });
      callUI();
      call.timer = setTimeout(() => { if (call.state === "ringing") endCall("Missed call", false); }, 45000);
      return;
    }
    if (o.k === "hb") {
      if (call.state === "active" && o.room === call.room) call.lastHb = Date.now();
      return;
    }
    if (call.room && o.room && o.room !== call.room) return;   // a signal from an earlier call
    switch (o.k) {
      case "accept":
        if (call.state !== "calling") return;
        clearTimeout(call.timer);
        openCall();
        break;
      case "decline": if (call.state === "calling") endCall("Call declined", false); break;
      case "busy": if (call.state === "calling") endCall("Peer is busy", false); break;
      case "end": endCall(call.state === "ringing" ? "Missed call" : "Call ended", false); break;
      case "mode": if (call.state === "active") await switchMode(!!o.video, false); break;
      case "vidreq": await askVideo(); break;
      case "vidyes": if (call.state === "active" && !call.video) await switchMode(true, false); break;
      case "vidno": if (call.state === "active") logSys("PARTNER DECLINED VIDEO."); break;
    }
  } catch (e) {
    endCall("Call error", true);
  }
}

updateContactLabel();

// =====================================================================
// FILES AND VOICE MESSAGES: sent through Firebase as small encrypted chunks.
const FILE_MAX = 50 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;            // raw bytes per chunk: small, safe for one database write
const VOICE_MAX_MS = 5 * 60 * 1000;
const fileIn = new Map();                   // incoming transfers being collected: t -> state
const fileCancelled = new Set();            // transfers the other phone cancelled
let fileOut = null;                         // the transfer this phone is sending
let voiceRec = null;                        // the voice recording in progress
let voiceGesture = null;                    // the finger currently holding the mic button

function baseMime(m) {
  const s = String(m || "").split(";")[0].trim();
  return /^[\w.+-]+\/[\w.+-]+$/.test(s) ? s : "application/octet-stream";
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function setProgress(text, cancelable) {
  let el = $("ft-progress");
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "ft-progress";
    el.className = "sys-log transfer-log";
    stream.insertBefore(el, typingIndicator);
  }
  el.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = text;
  el.appendChild(label);
  if (cancelable) {
    const b = document.createElement("button");
    b.className = "transfer-cancel";
    b.textContent = "Cancel";
    b.onclick = cancelOutgoing;
    el.appendChild(b);
  }
  scrollToBottom(el);
}

function cancelOutgoing() {
  if (fileOut) fileOut.cancelled = true;
}

// Photos are shrunk to 1280 px so they send quickly. GIFs are left as they are.
async function shrinkImage(file) {
  if (file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const out = await new Promise(res => c.toBlob(res, "image/jpeg", 0.8));
    return out && out.size < file.size ? out : file;
  } catch (e) {
    return file;
  }
}

// Sends any blob (photo, document or voice clip) in encrypted chunks.
async function sendBlob(blob, info) {
  if (!passkey || !channel) return uiAlert("Not connected", "Enter the passkey and wait for the connection.");
  if (!peerOnline) return uiAlert("Peer is offline", "Both of you need the app open to send files.");
  if (fileOut) return uiAlert("Transfer in progress", "Wait for the current file to finish.");
  if (blob.size > FILE_MAX) return uiAlert("File too large", "The limit is 50 MB.");

  const t = uid();
  const mime = baseMime(info.mime || blob.type);
  const total = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
  const url = URL.createObjectURL(blob);
  const bubbleText = info.kind === "voice" ? "" : info.name;
  renderBubble(bubbleText, "you", info.msgId, info.timestamp, info.burn, null,
    { url, name: info.name, mime, size: blob.size });
  pending.set(info.msgId, Date.now());
  fileOut = { t, cancelled: false };
  setProgress("SENDING 0%", true);

  try {
    await sendCtl({ op: "fmeta", t, msgId: info.msgId, name: info.name, mime,
      kind: info.kind || "file", size: blob.size, total, timestamp: info.timestamp, burn: info.burn });
    for (let i = 0; i < total; i++) {
      if (fileOut.cancelled) break;
      const part = new Uint8Array(await blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer());
      await sendCtl({ op: "fchunk", t, i, d: b64(part) });
      setProgress("SENDING " + Math.round((i + 1) / total * 100) + "%", true);
    }
    if (fileOut.cancelled) {
      await sendCtl({ op: "fcancel", t });
      pending.delete(info.msgId);
      const w = $(info.msgId);
      if (w) w.remove();
      logSys("FILE CANCELLED.");
    }
  } catch (e) {
    const w = $(info.msgId);
    const tk = w && w.querySelector(".ticks");
    if (tk) { tk.innerText = "!"; tk.style.color = "#ef4444"; }
    pending.delete(info.msgId);
    logSys("FILE SEND FAILED. TRY AGAIN.");
  } finally {
    fileOut = null;
    setProgress(null);
  }
}

async function sendFile(file) {
  if (file.size > FILE_MAX) return uiAlert("File too large", "The limit is 50 MB.");
  const isImg = /^image\//.test(file.type);
  const blob = isImg ? await shrinkImage(file) : file;
  return sendBlob(blob, {
    msgId: "m_" + uid(),
    name: String(file.name || "file").slice(0, 120),
    mime: blob.type || file.type,
    kind: isImg ? "image" : "file",
    timestamp: getFormattedTime(),
    burn: disappearingEnabled ? burnDuration : 0
  });
}

function triggerFileSelect() { $("file-picker").click(); }

function handleFileSelected(event) {
  const f = event.target.files[0];
  event.target.value = "";
  if (f) sendFile(f);
}

// ---- Receiving ----
function handleFileOp(o) {
  if (o.op === "fmeta") {
    const total = Number(o.total), size = Number(o.size);
    if (fileCancelled.has(o.t) || seenIds.has(o.msgId)) return;
    if (!(total >= 1 && total <= 4096) || !(size > 0 && size <= FILE_MAX) || typeof o.msgId !== "string") return;
    fileIn.set(o.t, { meta: o, parts: new Array(total), got: 0, total });
    setProgress("RECEIVING " + (o.kind === "voice" ? "voice message" : "file") + " 0%", false);
    return;
  }
  if (o.op === "fchunk") {
    const st = fileIn.get(o.t);
    const i = Number(o.i);
    if (!st || typeof o.d !== "string" || !(i >= 0 && i < st.total) || st.parts[i]) return;
    st.parts[i] = unb64(o.d);
    st.got++;
    setProgress("RECEIVING " + Math.round(st.got / st.total * 100) + "%", false);
    if (st.got === st.total) finishIncomingFile(o.t, st);
    return;
  }
  if (o.op === "fcancel") {
    fileIn.delete(o.t);
    fileCancelled.add(o.t);
    setProgress(null);
  }
}

function finishIncomingFile(t, st) {
  fileIn.delete(t);
  setProgress(null);
  const m = st.meta;
  if (seenIds.has(m.msgId)) return;
  seenIds.add(m.msgId);
  const mime = baseMime(m.mime);
  const name = String(m.name || "file").slice(0, 120);
  const url = URL.createObjectURL(new Blob(st.parts, { type: mime }));
  renderBubble(m.kind === "voice" ? "" : name, "peer", m.msgId, String(m.timestamp || ""),
    Number(m.burn) || 0, null, { url, name, mime, size: Number(m.size) || 0 });
  sendCtl({ op: "ack", id: m.msgId });
  afterPeerBubble(m.msgId);
}

// ---- Voice messages: hold the mic button to record, release to send ----
function pickRecorderMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  const list = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return list.find(m => MediaRecorder.isTypeSupported(m)) || "";
}

function showRecBar(text) {
  let el = $("rec-bar");
  if (!el) {
    el = document.createElement("div");
    el.id = "rec-bar";
    $("input-bar").parentNode.insertBefore(el, $("input-bar"));
  }
  el.textContent = text;
  el.style.display = "flex";
}

function hideRecBar() {
  const el = $("rec-bar");
  if (el) el.style.display = "none";
}

function voiceHint(startedAt, cancel) {
  return "● " + fmtTime(Date.now() - startedAt) + "   " + (cancel ? "Release to cancel" : "← Slide to cancel");
}

async function startVoiceRecording(g) {
  if (!passkey || !channel) return uiAlert("Not connected", "Enter the passkey and wait for the connection.");
  if (!peerOnline) return uiAlert("Peer is offline", "Voice messages are sent when your partner is online.");
  if (fileOut || voiceRec) return;
  if (!window.MediaRecorder || !navigator.mediaDevices) {
    return uiAlert("Not supported", "This phone can't record voice messages in the app.");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return uiAlert("Microphone blocked", "Allow microphone access for this app in your phone's settings.");
  }
  const mime = pickRecorderMime();
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const v = { g, rec, stream, parts: [], startedAt: Date.now(), timer: null, ui: null };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) v.parts.push(e.data); };
  voiceRec = v;
  rec.start(1000);
  showRecBar(voiceHint(v.startedAt, g.cancel));
  v.ui = setInterval(() => showRecBar(voiceHint(v.startedAt, g.cancel)), 500);
  v.timer = setTimeout(() => stopVoiceRecording(true), VOICE_MAX_MS);
  if (g.released) stopVoiceRecording(!g.cancel);   // finger was lifted while the mic was starting
}

function stopVoiceRecording(send) {
  const v = voiceRec;
  if (!v) return;
  voiceRec = null;
  clearInterval(v.ui);
  clearTimeout(v.timer);
  hideRecBar();
  const elapsed = Date.now() - v.startedAt;
  const stopped = new Promise(res => {
    if (v.rec.state === "inactive") return res();
    v.rec.onstop = () => res();
    v.rec.stop();
  });
  stopped.then(() => {
    v.stream.getTracks().forEach(t => t.stop());
    if (!send || elapsed < 800) return;          // too short or cancelled: nothing is sent
    const blob = new Blob(v.parts, { type: v.rec.mimeType || "audio/webm" });
    if (!blob.size) return;
    sendBlob(blob, {
      msgId: "m_" + uid(), name: "Voice message", mime: blob.type, kind: "voice",
      timestamp: getFormattedTime(), burn: disappearingEnabled ? burnDuration : 0
    });
  });
}

function voiceDown(e) {
  e.preventDefault();
  if (voiceGesture) return;
  if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
  const g = { x0: e.clientX, cancel: false, released: false };
  voiceGesture = g;
  startVoiceRecording(g);
}

function voiceMove(e) {
  const g = voiceGesture;
  if (g) g.cancel = (e.clientX - g.x0) < -80;
}

function voiceUp() {
  const g = voiceGesture;
  if (!g) return;
  voiceGesture = null;
  if (voiceRec && voiceRec.g === g) stopVoiceRecording(!g.cancel);
  else g.released = true;
}

// Mic button when the box is empty, send button when there is text.
function updateSendMic() {
  const hasText = msgInput.value.trim().length > 0;
  const send = $("send-btn"), mic = $("voice-btn");
  if (send) send.style.display = hasText ? "flex" : "none";
  if (mic) mic.style.display = hasText ? "none" : "flex";
}

// =====================================================================
// SETTINGS, DISAPPEARING MESSAGES, DIALOGS, PURGE, THEMES
// =====================================================================
function broadcastConfigSync() {
  if (!passkey) return;
  sendCtl({ op: "cfg", enabled: disappearingEnabled, duration: burnDuration });
}

function toggleDisappearingSetting(broadcast) {
  disappearingEnabled = !disappearingEnabled;
  lsSet("disappearing", disappearingEnabled);
  updateDisappearingUI();
  if (broadcast) {
    broadcastConfigSync();
    logSys(disappearingEnabled
      ? `YOU SET DISAPPEARING MESSAGES TO ${burnDuration}s.`
      : "YOU TURNED OFF DISAPPEARING MESSAGES.");
  }
}

function setDisappearingDuration(val, label, broadcast) {
  burnDuration = val;
  lsSet("burn_duration", burnDuration);
  updateDisappearingUI();
  if (broadcast) {
    broadcastConfigSync();
    logSys(`YOU SET DISAPPEARING MESSAGES TO ${label}.`);
  }
}

function applyRemoteConfig(enabled, duration) {
  const en = !!enabled;
  const dur = parseInt(duration, 10) || 10;
  if (en === disappearingEnabled && dur === burnDuration) return;   // nothing changed: stay silent
  disappearingEnabled = en;
  burnDuration = dur;
  lsSet("disappearing", disappearingEnabled);
  lsSet("burn_duration", burnDuration);
  updateDisappearingUI();
  logSys(disappearingEnabled
    ? `PEER SET DISAPPEARING MESSAGES TO ${burnDuration}s.`
    : "PEER TURNED OFF DISAPPEARING MESSAGES.");
}

function updateDisappearingUI() {
  const toggleEl = $("disappearing-toggle");
  const masterSub = $("disappearing-master-sub");
  const timerRow = $("burn-timer-row");
  const burnLabel = $("current-burn-label");
  if (burnLabel) burnLabel.innerText = `${burnDuration} Seconds`;
  if (disappearingEnabled) {
    toggleEl.classList.add("active");
    masterSub.innerText = `On (${burnDuration}s auto-burn)`;
    timerRow.classList.remove("disabled");
  } else {
    toggleEl.classList.remove("active");
    masterSub.innerText = "Off";
    timerRow.classList.add("disabled");
  }
}

function openSettings() {
  updateSettingsLabels();
  $("settings-screen").style.display = "flex";
  history.pushState({ modal: "settings" }, "");
}
function closeSettings() {
  $("settings-screen").style.display = "none";
  if (history.state && history.state.modal === "settings") history.back();
}
window.addEventListener("popstate", () => {
  const settingsScreen = $("settings-screen");
  const selectionModal = $("selection-modal");
  if (selectionModal && selectionModal.style.display === "flex") {
    selectionModal.style.display = "none";
    return;
  }
  if (settingsScreen && settingsScreen.style.display === "flex") settingsScreen.style.display = "none";
});

const dialogData = {
  theme: {
    title: "Select Console Theme",
    options: [
      { label: "Stealth Emerald", val: "stealth" },
      { label: "Matrix Green", val: "matrix" },
      { label: "OLED Black", val: "oled" },
      { label: "Charcoal Slate", val: "charcoal" },
      { label: "Vintage Amber", val: "amber" }
    ],
    current: () => currentTheme,
    onSelect: (val, label) => {
      currentTheme = val;
      lsSet("theme", val);
      setTheme(val);
      $("current-theme-label").innerText = label;
    }
  },
  font: {
    title: "Select Typography",
    options: [
      { label: "System Modern", val: "sans" },
      { label: "Courier Terminal", val: "mono" },
      { label: "Classic Serif", val: "serif" }
    ],
    current: () => currentFont,
    onSelect: (val, label) => {
      currentFont = val;
      lsSet("font", val);
      setFont(val);
      $("current-font-label").innerText = label;
    }
  },
  fontSize: {
    title: "Select Font Size",
    options: [
      { label: "Small (13px)", val: "13" },
      { label: "Medium (15px)", val: "15" },
      { label: "Large (17px)", val: "17" },
      { label: "Extra Large (19px)", val: "19" }
    ],
    current: () => currentFontSize,
    onSelect: (val) => {
      currentFontSize = val;
      lsSet("font_size", val);
      setFontSize(val);
    }
  },
  burn: {
    title: "Select Burn Duration",
    options: [
      { label: "10 Seconds", val: 10 },
      { label: "20 Seconds", val: 20 },
      { label: "30 Seconds", val: 30 },
      { label: "60 Seconds", val: 60 }
    ],
    current: () => burnDuration,
    onSelect: (val, label) => setDisappearingDuration(val, label, true)
  },
  retention: {
    title: "Keep Undelivered Messages",
    options: [
      { label: "1 day", val: 1 },
      { label: "7 days", val: 7 },
      { label: "30 days", val: 30 }
    ],
    current: () => getVaultDays(),
    onSelect: (val) => { lsSet("vault_days", val); updateSettingsLabels(); }
  }
};

function openDialog(type) {
  const config = dialogData[type];
  $("modal-dialog-title").innerText = config.title;
  const list = $("modal-options-list");
  list.innerHTML = "";
  const activeVal = config.current();
  config.options.forEach(opt => {
    const row = document.createElement("div");
    row.className = "dialog-option";
    row.innerHTML = `
      <div class="os-radio ${opt.val == activeVal ? "selected" : ""}"><div class="os-radio-dot"></div></div>
      <span>${escapeHtml(opt.label)}</span>`;
    row.onclick = () => { config.onSelect(opt.val, opt.label); closeDialog(); };
    list.appendChild(row);
  });
  $("selection-modal").style.display = "flex";
}
function closeDialog() { $("selection-modal").style.display = "none"; }

async function purgeBothScreens() {
  const ok = await uiConfirm("Shred everything?",
    "This clears the chat on both phones and empties the server queue. It cannot be undone.",
    "Shred", true);
  if (!ok) return;
  wipeLocal();
  fbPurgeQueue().then(() => sendCtl({ op: "purge" }));
  closeSettings();
  logSys("LOCAL & VAULT BUFFERS SHREDDED.");
}

const THEME_VARS = ["--bg", "--panel-bg", "--card-bg", "--card-border", "--dialog-bg", "--you-bubble", "--peer-bubble", "--accent"];
const THEMES = {
  stealth:  ["#090a0f", "#0e1015", "#161922", "#212631", "#1c202a", "#005c4b", "#1a222d", "#00a884"],
  matrix:   ["#050b07", "#09140c", "#102115", "#1b3824", "#14281a", "#133b1e", "#0f2015", "#22c55e"],
  oled:     ["#000000", "#080808", "#121212", "#1f1f1f", "#171717", "#262626", "#161616", "#ffffff"],
  charcoal: ["#121316", "#17181c", "#202227", "#2e3138", "#25272e", "#2d3748", "#1a202c", "#38bdf8"],
  amber:    ["#0e0905", "#150e08", "#20160d", "#362516", "#2a1c10", "#3d2708", "#211606", "#f59e0b"]
};
function setTheme(t) {
  const v = THEMES[t] || THEMES.stealth;
  THEME_VARS.forEach((n, i) => document.documentElement.style.setProperty(n, v[i]));
}
function setFont(f) {
  const fonts = {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Devanagari", "Devanagari MT", Helvetica, Arial, sans-serif',
    mono: '"Courier New", Courier, monospace',
    serif: 'Georgia, Cambria, "Times New Roman", serif'
  };
  document.documentElement.style.setProperty("--font-stack", fonts[f] || fonts.sans);
}
function setFontSize(sz) {
  document.documentElement.style.setProperty("--font-size", sz + "px");
  const label = $("current-size-label");
  if (label) label.innerText = `${sz}px`;
}

// ---- Input bar: keep the mic / send button in step with the text box ----
const _sendMessageBase = sendMessage;
sendMessage = async function () { await _sendMessageBase(); updateSendMic(); };
const _startEditBase = startEditMessage;
startEditMessage = function (id, text) { _startEditBase(id, text); updateSendMic(); };
updateSendMic();
