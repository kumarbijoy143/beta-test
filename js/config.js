// ---------------------------------------------------------------
// When you move this test version into the WORKING app, change ONLY
// the next line to "term_" so it finds the settings it already saved.
//   test version : "term_test_"
//   working app  : "term_"
// ---------------------------------------------------------------
const STORE_PREFIX = "term_test_";

const PIESOCKET_CLUSTER_ID = "free.blr2";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD9iAj6bEvb9wbwLo_BKmOYYApxJP0Jr8o",
  authDomain: "calc-notes-test.firebaseapp.com",
  databaseURL: "https://calc-notes-test-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "calc-notes-test",
  storageBucket: "calc-notes-test.firebasestorage.app",
  messagingSenderId: "66213443086",
  appId: "1:66213443086:web:04de204f27ed7fa8a86e5f"
};

const lsGet = (k, d = "") => {
  try { const v = localStorage.getItem(STORE_PREFIX + k); return v === null ? d : v; }
  catch (e) { return d; }
};
const lsSet = (k, v) => { try { localStorage.setItem(STORE_PREFIX + k, v); } catch (e) {} };
const lsDel = (k) => { try { localStorage.removeItem(STORE_PREFIX + k); } catch (e) {} };

function getStoredApiKey() { return lsGet("relay_api_key"); }
function getStoredVaultUrl() { return lsGet("vault_url"); }
function getVaultDays() {
  const n = parseInt(lsGet("vault_days", "7"), 10);
  return [1, 7, 30].includes(n) ? n : 7;
}
function getTurnConfig() {
  try { return JSON.parse(lsGet("turn", "null")); } catch (e) { return null; }
}

function updateSettingsLabels() {
  const k = getStoredApiKey();
  const v = getStoredVaultUrl();
  const t = getTurnConfig();
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };

  set("current-relay-label", k ? `••••••••${k.slice(-4)}` : "Not Configured");
  set("current-vault-label", v ? "Connected (Script Vault)" : "Not Configured");
  const d = getVaultDays();
  set("current-retention-label", d === 1 ? "1 day" : `${d} days`);
  set("current-turn-label", t && t.url ? "Configured" : "Not set");
}

async function configureRelayKey() {
  const r = await uiForm({
    title: "Relay Product Key",
    text: "Paste your PieSocket key. It is saved on this phone only.",
    fields: [{ id: "v", value: getStoredApiKey(), placeholder: "PieSocket API key" }],
    ok: "Save"
  });
  if (!r) return;
  const clean = r.v.trim();
  if (clean) lsSet("relay_api_key", clean); else lsDel("relay_api_key");
  updateSettingsLabels();
  if (typeof passkey !== "undefined" && passkey) initRelay();
}

async function configureVaultUrl() {
  const r = await uiForm({
    title: "Offline Vault URL",
    text: "Paste your Google Apps Script web app URL.",
    fields: [{ id: "v", value: getStoredVaultUrl(), placeholder: "https://script.google.com/macros/s/..." }],
    ok: "Save"
  });
  if (!r) return;
  const clean = r.v.trim();
  if (clean && !clean.startsWith("https://script.google.com/")) {
    await uiAlert("Invalid link", "The vault URL should start with https://script.google.com/");
    return;
  }
  if (clean) lsSet("vault_url", clean); else lsDel("vault_url");
  updateSettingsLabels();
  if (typeof passkey !== "undefined" && passkey) syncVault();
}

async function configureTurn() {
  const t = getTurnConfig() || {};
  const r = await uiForm({
    title: "Call Relay (TURN)",
    text: "Optional. Helps calls and files connect on mobile data. Leave empty to use Wi-Fi only.",
    fields: [
      { id: "url", value: t.url || "", placeholder: "turn:host:3478" },
      { id: "user", value: t.user || "", placeholder: "Username" },
      { id: "cred", value: t.cred || "", placeholder: "Password" }
    ],
    ok: "Save"
  });
  if (!r) return;
  if (r.url.trim()) {
    lsSet("turn", JSON.stringify({ url: r.url.trim(), user: r.user.trim(), cred: r.cred.trim() }));
  } else {
    lsDel("turn");
  }
  updateSettingsLabels();
}

function checkIsSoloEmoji(str) {
  if (!str) return false;
  const clean = str.trim();
  const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}){1,3}$/u;
  return emojiRegex.test(clean);
}
