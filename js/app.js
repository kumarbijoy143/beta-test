let passkey = "";
let clientId = "dev_" + Math.random().toString(36).substr(2, 7);
let channel = null;

let disappearingEnabled = localStorage.getItem("term_disappearing") !== null
  ? localStorage.getItem("term_disappearing") === "true"
  : true;

let burnDuration = localStorage.getItem("term_burn_duration") !== null
  ? parseInt(localStorage.getItem("term_burn_duration"), 10)
  : 10;

let currentTheme = localStorage.getItem("term_theme") || "stealth";
let currentFont = localStorage.getItem("term_font") || "sans";
let currentFontSize = localStorage.getItem("term_font_size") || "15";

let outbox = [];
let isFlushing = false;

let peerOnline = false;
let peerWatchdogTimer = null;
let peerTypingTimer = null;
let lastTypingBroadcast = 0;
let localTypingTimeout = null;

let activeQuotedTarget = null;
let editingTargetMsgId = null;
let activeContextTarget = null;

// PUBG-Style Live WebRTC Audio & P2P Data State
let rtcPeer = null;
let localAudioStream = null;
let isMicActive = false;
let isSpeakerMuted = false;
const remoteAudioEl = new Audio();
remoteAudioEl.autoplay = true;

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const stream = document.getElementById("chat-stream");
const msgInput = document.getElementById("msg-input");
const connState = document.getElementById("conn-state");
const statusDot = document.getElementById("status-dot");
const typingIndicator = document.getElementById("typing-indicator");

function scrollToBottom(targetNode) {
  requestAnimationFrame(() => {
    if (targetNode && targetNode.scrollIntoView) {
      targetNode.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      stream.scrollTop = stream.scrollHeight;
    }
    setTimeout(() => {
      stream.scrollTop = stream.scrollHeight;
    }, 120);
  });
}

function resizeInputBox() {
  msgInput.style.height = "auto";
  const newHeight = Math.min(msgInput.scrollHeight, 110);
  msgInput.style.height = newHeight + "px";
}

msgInput.addEventListener("input", () => {
  resizeInputBox();

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

window.addEventListener("DOMContentLoaded", () => {
  setTheme(currentTheme);
  setFont(currentFont);
  setFontSize(currentFontSize);
  updateDisappearingUI();
  updateSettingsLabels();

  const keyInput = document.getElementById("numeric-key");
  setTimeout(() => {
    if (keyInput) {
      keyInput.focus();
      keyInput.click();
    }
  }, 150);
});

msgInput.addEventListener("focus", () => {
  scrollToBottom();
});

msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById("numeric-key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") mountSession();
});

function triggerNativeEmojiKeyboard() {
  msgInput.focus();
}

function triggerCallHandOff(isVideo) {
  if (window.AndroidBridge && window.AndroidBridge.openCallScreen) {
    window.AndroidBridge.openCallScreen(isVideo);
  } else {
    alert("Launching local calling terminal (Voice/Video P2P)...");
  }
}

function panicExit() {
  if (localAudioStream) {
    localAudioStream.getTracks().forEach(t => t.stop());
  }
  stream.innerHTML = "";
  outbox = [];
  passkey = "";
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.reload();
  }
}

function mountSession() {
  const val = document.getElementById("numeric-key").value.trim();
  if (!val) return;
  passkey = val;
  document.getElementById("passkey-dialog").style.display = "none";

  setTimeout(() => {
    msgInput.focus();
  }, 100);

  initRelay();
  fetchAndBurnVault();
}

// -------------------------------------------------------------
// GOOGLE APPS SCRIPT ZERO-KNOWLEDGE DEAD-DROP VAULT
// -------------------------------------------------------------
function getVaultRoomHash() {
  return "v_" + CryptoJS.SHA256(passkey + "_universal_vault_salt").toString().substr(0, 28);
}

async function storeInOfflineVault(envelopeObj) {
  const vaultUrl = getStoredVaultUrl();
  if (!vaultUrl || !passkey) return;

  try {
    const cipherEnv = encrypt(JSON.stringify(envelopeObj));
    await fetch(vaultUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "store",
        room: getVaultRoomHash(),
        envelope: cipherEnv
      })
    });
  } catch (e) {}
}

async function fetchAndBurnVault() {
  const vaultUrl = getStoredVaultUrl();
  if (!vaultUrl || !passkey) return;

  try {
    const res = await fetch(vaultUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "fetch_and_burn",
        room: getVaultRoomHash()
      })
    });

    const data = await res.json();
    if (data && Array.isArray(data.envelopes) && data.envelopes.length > 0) {
      let count = 0;
      data.envelopes.forEach(cipherEnv => {
        const rawJson = decrypt(cipherEnv);
        if (rawJson) {
          const pkg = JSON.parse(rawJson);
          if (pkg.senderId !== clientId && !document.getElementById(pkg.msgId)) {
            renderBubble(pkg.text, "peer", pkg.msgId, pkg.timestamp, pkg.burn, pkg.reply, pkg.fileData);
            count++;
            if (channel) {
              dispatchRaw({ type: "ack", msgId: pkg.msgId, senderId: clientId });
            }
          }
        }
      });
      if (count > 0) {
        logSys(`SYNCED ${count} OFFLINE MESSAGE(S) & SHREDDED VAULT.`);
      }
    }
  } catch (e) {}
}

// -------------------------------------------------------------
// PUBG-STYLE MIC & SPEAKER LIVE WEBRTC ENGINE
// -------------------------------------------------------------
async function ensureAudioConnection(isInitiator) {
  if (!rtcPeer) {
    rtcPeer = new RTCPeerConnection(RTC_CONFIG);

    rtcPeer.onicecandidate = (e) => {
      if (e.candidate) {
        dispatchRaw({
          type: "rtc-sig",
          sig: encrypt(JSON.stringify({ ice: e.candidate })),
          senderId: clientId
        });
      }
    };

    rtcPeer.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        remoteAudioEl.srcObject = e.streams[0];
        remoteAudioEl.muted = isSpeakerMuted;
      }
    };
  }

  if (isInitiator) {
    const offer = await rtcPeer.createOffer();
    await rtcPeer.setLocalDescription(offer);
    dispatchRaw({
      type: "rtc-sig",
      sig: encrypt(JSON.stringify({ sdp: rtcPeer.localDescription })),
      senderId: clientId
    });
  }
}

async function handleRtcSignal(cipherSig) {
  const raw = decrypt(cipherSig);
  if (!raw) return;
  const signal = JSON.parse(raw);

  await ensureAudioConnection(false);

  if (signal.sdp) {
    await rtcPeer.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    if (signal.sdp.type === "offer") {
      const answer = await rtcPeer.createAnswer();
      await rtcPeer.setLocalDescription(answer);
      dispatchRaw({
        type: "rtc-sig",
        sig: encrypt(JSON.stringify({ sdp: rtcPeer.localDescription })),
        senderId: clientId
      });
    }
  } else if (signal.ice) {
    try {
      await rtcPeer.addIceCandidate(new RTCIceCandidate(signal.ice));
    } catch (e) {}
  }
}

async function toggleMic() {
  const btn = document.getElementById("mic-toggle-btn");
  if (!localAudioStream) {
    try {
      localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      await ensureAudioConnection(false);
      localAudioStream.getTracks().forEach(track => rtcPeer.addTrack(track, localAudioStream));
      await ensureAudioConnection(true);
      isMicActive = true;
    } catch (err) {
      logSys("MIC ACCESS DENIED OR BLOCKED BY WEBVIEW.");
      return;
    }
  } else {
    isMicActive = !isMicActive;
    localAudioStream.getAudioTracks().forEach(t => t.enabled = isMicActive);
  }

  if (btn) btn.classList.toggle("mic-active", isMicActive);
}

function toggleSpeaker() {
  isSpeakerMuted = !isSpeakerMuted;
  remoteAudioEl.muted = isSpeakerMuted;
  const btn = document.getElementById("speaker-toggle-btn");
  if (btn) btn.classList.toggle("speaker-muted", isSpeakerMuted);
}

// -------------------------------------------------------------
// IN-MEMORY ENCRYPTED FILE / IMAGE ATTACHMENT
// -------------------------------------------------------------
function triggerFileSelect() {
  document.getElementById("file-picker").click();
}

function handleFileSelected(event) {
  const file = event.target.files[0];
  if (!file || !passkey) return;

  if (file.size > 2.5 * 1024 * 1024) {
    alert("For instant encrypted RAM transfer, select a file under 2.5 MB.");
    event.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const base64Data = reader.result;
    const filePayload = {
      name: file.name,
      mime: file.type,
      data: base64Data
    };

    const msgId = "m_" + Math.random().toString(36).substr(2, 8);
    const nowTime = getFormattedTime();
    const activeBurn = disappearingEnabled ? burnDuration : 0;

    renderBubble(file.name, "you", msgId, nowTime, activeBurn, null, filePayload);

    const packet = {
      msgId: msgId,
      text: file.name,
      timestamp: nowTime,
      burn: activeBurn,
      reply: null,
      fileData: filePayload,
      senderId: clientId
    };

    dispatchRaw({
      type: "chat",
      msgId: msgId,
      ciphertext: encrypt(JSON.stringify(packet)),
      isJson: true,
      senderId: clientId
    });

    if (!peerOnline) {
      storeInOfflineVault(packet);
    }
  };
  reader.readAsDataURL(file);
  event.target.value = "";
}

// -------------------------------------------------------------
// PIESOCKET RELAY ENGINE
// -------------------------------------------------------------
function initRelay() {
  const apiKey = getStoredApiKey();
  if (!apiKey) {
    setPeerStatusUI("KEY REQUIRED", "offline");
    logSys("SETUP: Configure your Relay Product Key in Settings (Three dots).");
    return;
  }

  setPeerStatusUI("CONNECTING RELAY...", "connecting");

  try {
    const PS = window.PieSocket?.default || window.PieSocket;

    if (typeof PS !== "function") {
      setPeerStatusUI("LIB ERROR", "offline");
      logSys("ERR: PieSocket library failed to resolve.");
      return;
    }

    const piesocket = new PS({
      clusterId: PIESOCKET_CLUSTER_ID,
      apiKey: apiKey,
      notifySelf: false
    });

    const dynamicChannel = "ch_" + CryptoJS.SHA256(passkey + "_terminal_salt").toString().substr(0, 16);
    const subResult = piesocket.subscribe(dynamicChannel);

    if (subResult && typeof subResult.then === "function") {
      subResult.then((ch) => setupChannel(ch)).catch(() => {
        setPeerStatusUI("AUTH FAILED", "offline");
        logSys("SOCKET ERROR: Invalid Key or Network Reject.");
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

  if (typeof channel.listen === "function") {
    channel.listen("message", (raw) => {
      const payload = typeof raw === "string" ? raw : JSON.stringify(raw);
      handlePacket(payload);
    });
  } else if (typeof channel.on === "function") {
    channel.on("message", (raw) => {
      const payload = typeof raw === "string" ? raw : JSON.stringify(raw);
      handlePacket(payload);
    });
  }

  setInterval(() => {
    dispatchRaw({ type: "ping", senderId: clientId });
  }, 3000);
}

function refreshPeerWatchdog() {
  const wasOffline = !peerOnline;
  peerOnline = true;
  clearTimeout(peerWatchdogTimer);

  setPeerStatusUI("PEER ONLINE", "online");

  if (wasOffline) {
    broadcastConfigSync();
  }

  peerWatchdogTimer = setTimeout(() => {
    peerOnline = false;
    clearTimeout(peerTypingTimer);
    typingIndicator.style.display = "none";
    setPeerStatusUI("WAITING FOR PEER...", "connecting");
  }, 5500);
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

    refreshPeerWatchdog();

    switch (pkg.type) {
      case "ping":
        break;

      case "rtc-sig":
        handleRtcSignal(pkg.sig);
        break;

      case "typing":
        handlePeerTyping(pkg.status);
        break;

      case "chat":
        clearTimeout(peerTypingTimer);
        typingIndicator.style.display = "none";

        if (pkg.isJson) {
          const decStr = decrypt(pkg.ciphertext);
          if (decStr && !document.getElementById(pkg.msgId)) {
            const inner = JSON.parse(decStr);
            renderBubble(inner.text, "peer", inner.msgId, inner.timestamp, inner.burn, inner.reply, inner.fileData);
            dispatchRaw({ type: "ack", msgId: inner.msgId, senderId: clientId });
          }
        } else {
          const plain = decrypt(pkg.ciphertext);
          if (plain && !document.getElementById(pkg.msgId)) {
            renderBubble(plain, "peer", pkg.msgId, pkg.timestamp, pkg.burn, pkg.reply);
            dispatchRaw({ type: "ack", msgId: pkg.msgId, senderId: clientId });
          }
        }
        break;

      case "edit":
        const editedPlain = decrypt(pkg.ciphertext);
        if (editedPlain) {
          applyRemoteEdit(pkg.msgId, editedPlain);
        }
        break;

      case "reaction":
        applyReactionToBubble(pkg.msgId, pkg.emoji);
        break;

      case "ack":
        confirmAck(pkg.msgId);
        break;

      case "purge":
        stream.innerHTML = "";
        stream.appendChild(typingIndicator);
        outbox = [];
        logSys("SESSION BUFFER SHREDDED BY PEER.");
        break;

      case "config-sync":
        if (pkg.ciphertext) {
          const rawConfig = decrypt(pkg.ciphertext);
          if (rawConfig) {
            const cfg = JSON.parse(rawConfig);
            applyRemoteConfig(cfg.enabled, cfg.duration);
          }
        }
        break;
    }
  } catch (e) {}
}

function handlePeerTyping(isTyping) {
  clearTimeout(peerTypingTimer);

  if (isTyping) {
    typingIndicator.style.display = "flex";
    scrollToBottom(typingIndicator);

    peerTypingTimer = setTimeout(() => {
      typingIndicator.style.display = "none";
    }, 3500);
  } else {
    typingIndicator.style.display = "none";
  }
}

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, passkey).toString();
}

function decrypt(cipher) {
  try {
    const bytes = CryptoJS.AES.decrypt(cipher, passkey);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    return null;
  }
}

function dispatchRaw(dataObj) {
  if (!channel) return;
  const jsonStr = JSON.stringify(dataObj);

  if (typeof channel.publish === "function") {
    channel.publish("message", jsonStr);
  } else if (typeof channel.send === "function") {
    channel.send(jsonStr);
  }
}

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !passkey) {
    msgInput.focus();
    return;
  }

  clearTimeout(localTypingTimeout);
  dispatchRaw({ type: "typing", status: false, senderId: clientId });

  if (editingTargetMsgId) {
    applyLocalEdit(editingTargetMsgId, text);
    dispatchRaw({
      type: "edit",
      msgId: editingTargetMsgId,
      ciphertext: encrypt(text),
      senderId: clientId
    });

    msgInput.value = "";
    msgInput.style.height = "auto";
    cancelReplyOrEdit();
    msgInput.focus();
    return;
  }

  const msgId = "m_" + Math.random().toString(36).substr(2, 8);
  const nowTime = getFormattedTime();
  const activeBurn = disappearingEnabled ? burnDuration : 0;
  const replyPayload = activeQuotedTarget ? { ...activeQuotedTarget } : null;

  msgInput.value = "";
  msgInput.style.height = "auto";
  cancelReplyOrEdit();
  msgInput.focus();

  const newBubble = renderBubble(text, "you", msgId, nowTime, activeBurn, replyPayload);
  outbox.push({ msgId, text, timestamp: nowTime, burn: activeBurn, reply: replyPayload, lastSent: Date.now() });

  dispatchRaw({
    type: "chat",
    msgId: msgId,
    ciphertext: encrypt(text),
    timestamp: nowTime,
    burn: activeBurn,
    reply: replyPayload,
    senderId: clientId
  });

  // If peer is offline, push to universal Google Apps Script dead-drop vault
  if (!peerOnline) {
    storeInOfflineVault({
      msgId: msgId,
      text: text,
      timestamp: nowTime,
      burn: activeBurn,
      reply: replyPayload,
      senderId: clientId
    });
  }

  scrollToBottom(newBubble);
}

setInterval(() => {
  if (!channel || outbox.length === 0 || isFlushing) return;

  isFlushing = true;
  const now = Date.now();

  outbox.forEach(item => {
    if (now - item.lastSent > 4000) {
      item.lastSent = now;
      dispatchRaw({
        type: "chat",
        msgId: item.msgId,
        ciphertext: encrypt(item.text),
        timestamp: item.timestamp,
        burn: item.burn,
        reply: item.reply,
        senderId: clientId
      });
    }
  });

  isFlushing = false;
}, 3000);

function getFormattedTime() {
  const d = new Date();
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${hours}:${minutes} ${ampm}`;
}

function setupBubbleInteractions(wrap, text, role) {
  let startX = 0;
  let currentX = 0;
  let isSwiping = false;
  let longPressTimer = null;
  const swipeIcon = wrap.querySelector(".swipe-reply-icon");

  wrap.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    isSwiping = false;

    longPressTimer = setTimeout(() => {
      if (!isSwiping) {
        openClampedContextMenu(wrap, text, role);
      }
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
      setReplyTarget(text, role === "you" ? "You" : "Peer");
    }

    wrap.style.transform = "translateX(0px)";
    if (swipeIcon) swipeIcon.style.opacity = 0;
    isSwiping = false;
    startX = 0;
    currentX = 0;
  });
}

function openClampedContextMenu(bubbleWrap, text, role) {
  activeContextTarget = { wrap: bubbleWrap, text: text, role: role, id: bubbleWrap.id };

  const dock = document.getElementById("reaction-dock");
  const menu = document.getElementById("msg-context-menu");
  const editItem = document.getElementById("context-edit-item");

  editItem.style.display = role === "you" ? "flex" : "none";

  const rect = bubbleWrap.getBoundingClientRect();
  const streamRect = stream.getBoundingClientRect();
  const screenWidth = window.innerWidth;

  const isNearTop = (rect.top - streamRect.top) < 65;

  let dockTop = isNearTop
    ? (rect.bottom - streamRect.top + 8)
    : (rect.top - streamRect.top - 46);

  let menuTop = isNearTop
    ? (dockTop + 48)
    : (rect.bottom - streamRect.top + 6);

  let dockLeft = role === "you"
    ? Math.max(12, screenWidth - 280)
    : Math.min(screenWidth - 280, Math.max(12, rect.left - streamRect.left));

  let menuLeft = role === "you"
    ? Math.max(12, screenWidth - 170)
    : Math.max(12, rect.left - streamRect.left);

  dock.style.top = `${dockTop}px`;
  dock.style.left = `${dockLeft}px`;
  dock.style.display = "flex";

  menu.style.top = `${menuTop}px`;
  menu.style.left = `${menuLeft}px`;
  menu.style.display = "flex";

  if (navigator.vibrate) navigator.vibrate(15);

  setTimeout(() => {
    document.addEventListener("click", closeContextModals);
    document.addEventListener("touchstart", closeContextModals);
  }, 100);
}

function closeContextModals(e) {
  const dock = document.getElementById("reaction-dock");
  const menu = document.getElementById("msg-context-menu");
  if (!dock.contains(e.target) && !menu.contains(e.target)) {
    dock.style.display = "none";
    menu.style.display = "none";
    document.removeEventListener("click", closeContextModals);
    document.removeEventListener("touchstart", closeContextModals);
  }
}

function triggerContextAction(action) {
  if (!activeContextTarget) return;

  if (action === "reply") {
    setReplyTarget(activeContextTarget.text, activeContextTarget.role === "you" ? "You" : "Peer");
  } else if (action === "copy") {
    navigator.clipboard?.writeText(activeContextTarget.text);
  } else if (action === "edit") {
    startEditMessage(activeContextTarget.id, activeContextTarget.text);
  }

  document.getElementById("reaction-dock").style.display = "none";
  document.getElementById("msg-context-menu").style.display = "none";
}

function startEditMessage(msgId, currentText) {
  editingTargetMsgId = msgId;
  activeQuotedTarget = null;

  document.getElementById("reply-target-title").innerText = "Editing message";
  document.getElementById("reply-target-text").innerText = currentText;
  document.getElementById("reply-preview-bar").style.display = "flex";

  msgInput.value = currentText;
  resizeInputBox();
  msgInput.focus();
}

function applyLocalEdit(msgId, newText) {
  const wrap = document.getElementById(msgId);
  if (wrap) {
    const textNode = wrap.querySelector(".msg-text");
    if (textNode) textNode.innerText = newText;
    addEditedBadge(wrap);
  }
  const outboxItem = outbox.find(i => i.msgId === msgId);
  if (outboxItem) outboxItem.text = newText;
}

function applyRemoteEdit(msgId, newText) {
  const wrap = document.getElementById(msgId);
  if (wrap) {
    const textNode = wrap.querySelector(".msg-text");
    if (textNode) textNode.innerText = newText;
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
  activeQuotedTarget = { sender: senderLabel, text: text };
  document.getElementById("reply-target-title").innerText = `Replying to ${senderLabel}`;
  document.getElementById("reply-target-text").innerText = text;
  document.getElementById("reply-preview-bar").style.display = "flex";
  msgInput.focus();
}

function cancelReplyOrEdit() {
  activeQuotedTarget = null;
  editingTargetMsgId = null;
  document.getElementById("reply-preview-bar").style.display = "none";
}

function selectReaction(emoji) {
  if (!activeContextTarget) return;
  applyReactionToBubble(activeContextTarget.id, emoji);

  dispatchRaw({
    type: "reaction",
    msgId: activeContextTarget.id,
    emoji: emoji,
    senderId: clientId
  });

  document.getElementById("reaction-dock").style.display = "none";
  document.getElementById("msg-context-menu").style.display = "none";
}

function applyReactionToBubble(msgId, emoji) {
  const wrap = document.getElementById(msgId);
  if (!wrap) return;
  const reactionEl = wrap.querySelector(".bubble-reaction");
  if (reactionEl) {
    reactionEl.innerText = emoji;
    reactionEl.style.display = "block";
  }
}

function renderBubble(text, role, msgId, timeStr, burnSecs, replyData, fileData) {
  const wrap = document.createElement("div");
  wrap.className = `msg-wrap ${role}`;
  wrap.id = msgId;

  const displayTime = timeStr || getFormattedTime();
  const isBurnActive = burnSecs && burnSecs > 0;
  const isSolo = !fileData && checkIsSoloEmoji(text);

  let badgeHtml = "";
  if (isBurnActive) {
    badgeHtml = `
      <span class="burn-badge">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>
        <span class="burn-digit">${burnSecs}s</span>
      </span>`;
  }

  let quotedHtml = "";
  if (replyData && replyData.text) {
    quotedHtml = `
      <div class="quoted-card">
        <strong style="color:var(--accent); font-size:11px;">${escapeHtml(replyData.sender)}</strong><br/>
        ${escapeHtml(replyData.text)}
      </div>
    `;
  }

  let mediaHtml = "";
  if (fileData && fileData.data) {
    if (fileData.mime && fileData.mime.startsWith("image/")) {
      mediaHtml = `<img src="${fileData.data}" class="media-preview" alt="Encrypted Image" />`;
    } else {
      mediaHtml = `<a href="${fileData.data}" download="${escapeHtml(fileData.name || 'file')}" class="file-card">📎 ${escapeHtml(fileData.name || 'Encrypted File')}</a>`;
    }
  }

  const textBodyHtml = fileData && fileData.mime && fileData.mime.startsWith("image/")
    ? ""
    : `<span class="msg-text">${escapeHtml(text)}</span>`;

  if (role === "you") {
    wrap.innerHTML = `
      <div class="swipe-reply-icon">
        <svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
      </div>
      <div class="bubble ${isSolo ? 'emoji-solo' : ''}">
        ${quotedHtml}
        ${mediaHtml}
        ${textBodyHtml}
        <div class="msg-meta">
          ${badgeHtml}
          <span class="timestamp">${displayTime}</span>
          <span class="ticks">✓</span>
        </div>
        <div class="bubble-reaction"></div>
      </div>
    `;
    wrap.dataset.burnSecs = isBurnActive ? burnSecs : 0;
  } else {
    wrap.innerHTML = `
      <div class="swipe-reply-icon">
        <svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
      </div>
      <div class="bubble ${isSolo ? 'emoji-solo' : ''}">
        ${quotedHtml}
        ${mediaHtml}
        ${textBodyHtml}
        <div class="msg-meta">
          ${badgeHtml}
          <span class="timestamp">${displayTime}</span>
        </div>
        <div class="bubble-reaction"></div>
      </div>
    `;
    if (isBurnActive) {
      startBurn(wrap, burnSecs);
    }
  }

  setupBubbleInteractions(wrap, text, role);
  stream.insertBefore(wrap, typingIndicator);
  scrollToBottom(wrap);
  return wrap;
}

function confirmAck(msgId) {
  outbox = outbox.filter(item => item.msgId !== msgId);
  const wrap = document.getElementById(msgId);
  if (wrap) {
    const ticks = wrap.querySelector(".ticks");
    if (ticks) {
      ticks.innerText = "✓✓";
      ticks.classList.add("seen");
    }
    const burnSecs = parseInt(wrap.dataset.burnSecs || 0);
    if (burnSecs > 0 && !wrap.dataset.burning) {
      wrap.dataset.burning = "true";
      startBurn(wrap, burnSecs);
    }
  }
}

function startBurn(node, seconds) {
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

function logSys(msg) {
  const el = document.createElement("div");
  el.className = "sys-log";
  el.innerText = msg;
  stream.insertBefore(el, typingIndicator);
  scrollToBottom(el);
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>"']/g, function(m) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m];
  });
}

function broadcastConfigSync() {
  if (!passkey) return;
  const payload = JSON.stringify({
    enabled: disappearingEnabled,
    duration: burnDuration
  });
  dispatchRaw({
    type: "config-sync",
    ciphertext: encrypt(payload),
    senderId: clientId
  });
}

function toggleDisappearingSetting(broadcast) {
  disappearingEnabled = !disappearingEnabled;
  localStorage.setItem("term_disappearing", disappearingEnabled);
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
  localStorage.setItem("term_burn_duration", burnDuration);
  updateDisappearingUI();

  if (broadcast) {
    broadcastConfigSync();
    logSys(`YOU SET DISAPPEARING MESSAGES TO ${label}.`);
  }
}

function applyRemoteConfig(enabled, duration) {
  disappearingEnabled = enabled;
  burnDuration = duration;

  localStorage.setItem("term_disappearing", disappearingEnabled);
  localStorage.setItem("term_burn_duration", burnDuration);

  updateDisappearingUI();

  logSys(disappearingEnabled
    ? `PEER SET DISAPPEARING MESSAGES TO ${burnDuration}s.`
    : "PEER TURNED OFF DISAPPEARING MESSAGES.");
}

function updateDisappearingUI() {
  const toggleEl = document.getElementById("disappearing-toggle");
  const masterSub = document.getElementById("disappearing-master-sub");
  const timerRow = document.getElementById("burn-timer-row");
  const burnLabel = document.getElementById("current-burn-label");

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
  document.getElementById("settings-screen").style.display = "flex";
  history.pushState({ modal: "settings" }, "");
}

function closeSettings() {
  document.getElementById("settings-screen").style.display = "none";
  if (history.state && history.state.modal === "settings") {
    history.back();
  }
}

window.addEventListener("popstate", () => {
  const settingsScreen = document.getElementById("settings-screen");
  const selectionModal = document.getElementById("selection-modal");

  if (selectionModal && selectionModal.style.display === "flex") {
    selectionModal.style.display = "none";
    return;
  }
  if (settingsScreen && settingsScreen.style.display === "flex") {
    settingsScreen.style.display = "none";
  }
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
      localStorage.setItem("term_theme", currentTheme);
      setTheme(val);
      document.getElementById("current-theme-label").innerText = label;
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
      localStorage.setItem("term_font", currentFont);
      setFont(val);
      document.getElementById("current-font-label").innerText = label;
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
    onSelect: (val, label) => {
      currentFontSize = val;
      localStorage.setItem("term_font_size", currentFontSize);
      setFontSize(val);
      document.getElementById("current-size-label").innerText = `${val}px`;
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
    onSelect: (val, label) => {
      setDisappearingDuration(val, label, true);
    }
  }
};

function openDialog(type) {
  const config = dialogData[type];
  document.getElementById("modal-dialog-title").innerText = config.title;
  const list = document.getElementById("modal-options-list");
  list.innerHTML = "";

  const activeVal = config.current();

  config.options.forEach(opt => {
    const isSelected = opt.val == activeVal;
    const row = document.createElement("div");
    row.className = "dialog-option";
    row.innerHTML = `
      <div class="os-radio ${isSelected ? 'selected' : ''}">
        <div class="os-radio-dot"></div>
      </div>
      <span>${opt.label}</span>
    `;
    row.onclick = () => {
      config.onSelect(opt.val, opt.label);
      closeDialog();
    };
    list.appendChild(row);
  });

  document.getElementById("selection-modal").style.display = "flex";
}

function closeDialog() {
  document.getElementById("selection-modal").style.display = "none";
}

async function purgeBothScreens() {
  if (confirm("Shred chat log on both devices and clear offline vault?")) {
    stream.innerHTML = "";
    stream.appendChild(typingIndicator);
    outbox = [];
    dispatchRaw({ type: "purge", senderId: clientId });

    const vaultUrl = getStoredVaultUrl();
    if (vaultUrl && passkey) {
      fetch(vaultUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ action: "purge", room: getVaultRoomHash() })
      }).catch(() => {});
    }

    closeSettings();
    logSys("LOCAL & VAULT BUFFERS SHREDDED.");
  }
}

function setTheme(t) {
  const r = document.documentElement;
  if (t === "stealth") {
    r.style.setProperty("--bg", "#090a0f");
    r.style.setProperty("--panel-bg", "#0e1015");
    r.style.setProperty("--card-bg", "#161922");
    r.style.setProperty("--card-border", "#212631");
    r.style.setProperty("--dialog-bg", "#1c202a");
    r.style.setProperty("--you-bubble", "#005c4b");
    r.style.setProperty("--peer-bubble", "#1a222d");
    r.style.setProperty("--accent", "#00a884");
  } else if (t === "matrix") {
    r.style.setProperty("--bg", "#050b07");
    r.style.setProperty("--panel-bg", "#09140c");
    r.style.setProperty("--card-bg", "#102115");
    r.style.setProperty("--card-border", "#1b3824");
    r.style.setProperty("--dialog-bg", "#14281a");
    r.style.setProperty("--you-bubble", "#133b1e");
    r.style.setProperty("--peer-bubble", "#0f2015");
    r.style.setProperty("--accent", "#22c55e");
  } else if (t === "oled") {
    r.style.setProperty("--bg", "#000000");
    r.style.setProperty("--panel-bg", "#080808");
    r.style.setProperty("--card-bg", "#121212");
    r.style.setProperty("--card-border", "#1f1f1f");
    r.style.setProperty("--dialog-bg", "#171717");
    r.style.setProperty("--you-bubble", "#262626");
    r.style.setProperty("--peer-bubble", "#161616");
    r.style.setProperty("--accent", "#ffffff");
  } else if (t === "charcoal") {
    r.style.setProperty("--bg", "#121316");
    r.style.setProperty("--panel-bg", "#17181c");
    r.style.setProperty("--card-bg", "#202227");
    r.style.setProperty("--card-border", "#2e3138");
    r.style.setProperty("--dialog-bg", "#25272e");
    r.style.setProperty("--you-bubble", "#2d3748");
    r.style.setProperty("--peer-bubble", "#1a202c");
    r.style.setProperty("--accent", "#38bdf8");
  } else if (t === "amber") {
    r.style.setProperty("--bg", "#0e0905");
    r.style.setProperty("--panel-bg", "#150e08");
    r.style.setProperty("--card-bg", "#20160d");
    r.style.setProperty("--card-border", "#362516");
    r.style.setProperty("--dialog-bg", "#2a1c10");
    r.style.setProperty("--you-bubble", "#3d2708");
    r.style.setProperty("--peer-bubble", "#211606");
    r.style.setProperty("--accent", "#f59e0b");
  }
}

function setFont(f) {
  const fonts = {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Devanagari", "Devanagari MT", Helvetica, Arial, sans-serif',
    mono: '"Courier New", Courier, monospace',
    serif: 'Georgia, Cambria, "Times New Roman", serif'
  };
  document.documentElement.style.setProperty("--font-stack", fonts[f]);
}

function setFontSize(sz) {
  document.documentElement.style.setProperty("--font-size", sz + "px");
  const label = document.getElementById("current-size-label");
  if (label) label.innerText = `${sz}px`;
}
