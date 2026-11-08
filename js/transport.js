// Firebase transport. Loaded AFTER app.js; it replaces the old relay and vault.
// Durable queue : rooms/<room>/msgs  (chat, ack, read, edit, react, purge, cfg)
// Live signals  : rooms/<room>/ctl   (call, ft) - ignored if older than 45 s
// Presence      : rooms/<room>/pres/<deviceId> (online + typing)

const FB_DURABLE = { chat: 1, ack: 1, read: 1, edit: 1, react: 1, purge: 1, cfg: 1, fmeta: 1, fchunk: 1, fcancel: 1 };
const FB_LIVE_MAX_AGE = 45000;

let fbDb = null, fbRoom = "", fbOffset = 0, fbStarted = false, fbPresRef = null;
let fbResolve = null;
const fbReady = new Promise(r => { fbResolve = r; });
let fbChain = Promise.resolve();

// True while a call or file transfer is running: presence and live signals must keep working
// even if the screen briefly loses focus (permission pop-ups, the call frame, etc.).
function fbBusy() {
  return (typeof call !== "undefined" && call.state !== "idle") || (typeof fileOut !== "undefined" && !!fileOut);
}

async function fbInit() {
  if (fbStarted || !keys) return;
  fbStarted = true;
  setPeerStatusUI("CONNECTING...", "connecting");
  try {
    if (!window.firebase) throw new Error("Firebase library failed to load");
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    await firebase.auth().signInAnonymously();
  } catch (e) {
    fbStarted = false;
    setPeerStatusUI("AUTH FAILED", "offline");
    logSys("ERR: " + (e && e.message ? e.message : "sign-in failed"));
    return;
  }
  fbDb = firebase.database();
  fbRoom = "rooms/" + keys.room;

  fbDb.ref(".info/serverTimeOffset").on("value", s => { fbOffset = s.val() || 0; });

  fbDb.ref(fbRoom + "/pres").on("value", (s) => {
    const v = s.val() || {};
    let online = false, typing = false;
    Object.keys(v).forEach(k => {
      if (k === clientId) return;
      online = true;
      if (v[k] && v[k].ty === true) typing = true;
    });
    const was = peerOnline;
    peerOnline = online;
    fbRefreshStatus();
    if (online) {
      handlePeerTyping(typing);
    } else {
      typingIndicator.style.display = "none";
    }
  });

  fbDb.ref(fbRoom + "/msgs").on("child_added", s => fbIncoming(s, true));
  fbDb.ref(fbRoom + "/ctl").on("child_added", s => fbIncoming(s, false));

  fbDb.ref(".info/connected").on("value", (s) => {
    if (s.val() === true) fbAnnounce();
    else setPeerStatusUI("OFFLINE, RECONNECTING...", "offline");
  });

  channel = { firebase: true };     // marks "connected" for the calls and file code
  fbResolve();
}

function fbAnnounce() {
  fbPresRef = fbDb.ref(fbRoom + "/pres/" + clientId);
  fbPresRef.onDisconnect().remove();
  if (appActive || fbBusy()) fbPresRef.set({ c: String(Date.now()), f: clientId, ty: false }).catch(() => {});
  fbRefreshStatus();
}

function fbRefreshStatus() {
  if (peerOnline) setPeerStatusUI("PEER ONLINE", "online");
  else setPeerStatusUI("WAITING FOR PEER...", "connecting");
}

function fbSetActive(v) {
  if (!fbDb || !fbPresRef) return;
  if (v) fbPresRef.set({ c: String(Date.now()), f: clientId, ty: false }).catch(() => {});
  else if (!fbBusy()) fbPresRef.remove().catch(() => {});   // stay visible during a call
}

function fbTyping(on) {
  if (!fbDb || !fbPresRef || !appActive) return;
  fbPresRef.set({ c: String(Date.now()), f: clientId, ty: !!on }).catch(() => {});
}

function fbPut(op, c) {
  const durable = !!FB_DURABLE[op];
  // Live signals only matter if the peer is here (or a call / transfer is already running).
  if (!durable && !peerOnline && !fbBusy()) return Promise.resolve();
  const payload = { c, f: clientId };
  if (!durable) payload.t = firebase.database.ServerValue.TIMESTAMP;
  return fbReady.then(() => fbDb.ref(fbRoom + (durable ? "/msgs" : "/ctl")).push().set(payload));
}

function fbIncoming(snap, durable) {
  const v = snap.val();
  const ref = snap.ref;
  if (!v || typeof v.c !== "string") { ref.remove().catch(() => {}); return; }
  if (v.f === clientId) return;                       // my own packet; the peer removes it
  if (!durable) {
    ref.remove().catch(() => {});
    const age = Date.now() + fbOffset - (Number(v.t) || 0);
    if (age > FB_LIVE_MAX_AGE) return;                // stale call signal
  }
  recvChain = recvChain.then(async () => {
    const plain = await decrypt(v.c);
    let o = null;
    if (plain) { try { o = JSON.parse(plain); } catch (e) {} }
    if (o) handleCtl(o);
    if (durable) ref.remove().catch(() => {});        // deleted only after it was handled
  }).catch(() => {});
}

function fbPurgeQueue() {
  return fbReady.then(() => Promise.all([
    fbDb.ref(fbRoom + "/msgs").remove(),
    fbDb.ref(fbRoom + "/ctl").remove()
  ])).catch(() => {});
}

function markSentToServer(id) {
  const w = document.getElementById(id);
  if (!w || w.dataset.role !== "you") return;
  const t = w.querySelector(".ticks");
  if (t && t.innerText === "🕓") t.innerText = "✓";
}

// ---- Replace the old functions from app.js (same names, so nothing else changes) ----
sendCtl = function (obj) {
  const job = fbChain.then(async () => {
    if (!keys) return null;
    const c = await encrypt(JSON.stringify(obj));
    return { p: fbPut(obj.op, c) };       // wrapped so the chain does not wait for the network
  });
  fbChain = job.then(() => {}, () => {});
  return job.then(r => (r ? r.p : null));
};
dispatchRaw = function (o) { if (o && o.type === "typing") fbTyping(!!o.status); };
initRelay = fbInit;
syncVault = function () {};
vaultCall = async function () { return null; };
storeInVault = async function () { return true; };
