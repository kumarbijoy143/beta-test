const PIESOCKET_CLUSTER_ID = "free.blr2";

function getStoredApiKey() {
  return localStorage.getItem("term_relay_api_key") || "";
}

function getStoredVaultUrl() {
  return localStorage.getItem("term_vault_url") || "";
}

function updateSettingsLabels() {
  const k = getStoredApiKey();
  const v = getStoredVaultUrl();

  const relayEl = document.getElementById("current-relay-label");
  if (relayEl) {
    relayEl.innerText = k ? `••••••••${k.slice(-4)}` : "Not Configured";
  }

  const vaultEl = document.getElementById("current-vault-label");
  if (vaultEl) {
    vaultEl.innerText = v ? "Connected (Script Vault)" : "Not Configured";
  }
}

function configureRelayKey() {
  const current = getStoredApiKey();
  const val = prompt("Paste your PieSocket Relay Key:", current);
  if (val !== null) {
    const clean = val.trim();
    if (clean) {
      localStorage.setItem("term_relay_api_key", clean);
    } else {
      localStorage.removeItem("term_relay_api_key");
    }
    updateSettingsLabels();
    if (typeof initRelay === "function" && typeof passkey !== "undefined" && passkey) {
      initRelay();
    }
  }
}

function configureVaultUrl() {
  const current = getStoredVaultUrl();
  const val = prompt("Paste your Google Apps Script Web App URL:", current);
  if (val !== null) {
    const clean = val.trim();
    if (clean) {
      localStorage.setItem("term_vault_url", clean);
    } else {
      localStorage.removeItem("term_vault_url");
    }
    updateSettingsLabels();
    if (typeof fetchAndBurnVault === "function" && typeof passkey !== "undefined" && passkey) {
      fetchAndBurnVault();
    }
  }
}

function checkIsSoloEmoji(str) {
  if (!str) return false;
  const clean = str.trim();
  const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}){1,3}$/u;
  return emojiRegex.test(clean);
}