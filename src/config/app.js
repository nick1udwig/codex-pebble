const STORAGE_KEY = "codex_jobs:config_state";

const DEFAULT_SETTINGS = Object.freeze({
  wsUrl: "",
  displayLimit: 3,
  recentCompletionLookbackMinutes: 720,
});

export function sanitizeSettings(settings = {}) {
  return {
    wsUrl: String(settings.wsUrl ?? "").trim(),
    displayLimit: clamp(settings.displayLimit, 1, 8, DEFAULT_SETTINGS.displayLimit),
    recentCompletionLookbackMinutes: clamp(
      settings.recentCompletionLookbackMinutes,
      5,
      10080,
      DEFAULT_SETTINGS.recentCompletionLookbackMinutes,
    ),
  };
}

export function parseEmbeddedSettings(search = globalThis.location?.search ?? "") {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get("settings") ?? params.get("state");
    return raw ? sanitizeSettings(JSON.parse(decodeURIComponent(raw))) : {};
  } catch (_error) {
    return {};
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? sanitizeSettings(JSON.parse(raw)) : {};
    const embedded = parseEmbeddedSettings();
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      ...embedded,
    };
  } catch (_error) {
    return {
      ...DEFAULT_SETTINGS,
      ...parseEmbeddedSettings(),
    };
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
}

function getBridge() {
  if (globalThis.PebbleConfigBridge && typeof globalThis.PebbleConfigBridge.submit === "function") {
    return globalThis.PebbleConfigBridge;
  }

  const returnTo = getReturnToUrl();
  if (returnTo) {
    return {
      submit(payload) {
        try {
          globalThis.location.href = appendClosePayload(returnTo, payload);
        } catch (_error) {
        }
      },
    };
  }

  return {
    submit(payload) {
      try {
        globalThis.location.href = "pebblejs://close#" + encodeURIComponent(JSON.stringify(payload));
      } catch (_error) {
      }
    },
  };
}

function getReturnToUrl(search = globalThis.location?.search ?? "") {
  try {
    return new URLSearchParams(search).get("return_to") || "";
  } catch (_error) {
    return "";
  }
}

function appendClosePayload(returnTo, payload) {
  const separator = returnTo.includes("?") ? "" : "?";
  return returnTo + separator + encodeURIComponent(JSON.stringify(payload));
}

function readFormSettings() {
  return sanitizeSettings({
    wsUrl: document.querySelector("#wsUrl").value,
    displayLimit: document.querySelector("#displayLimit").value,
    recentCompletionLookbackMinutes: document.querySelector("#recentCompletionLookbackMinutes").value,
  });
}

function writeFormSettings(settings) {
  document.querySelector("#wsUrl").value = settings.wsUrl;
  document.querySelector("#displayLimit").value = String(settings.displayLimit);
  document.querySelector("#recentCompletionLookbackMinutes").value = String(settings.recentCompletionLookbackMinutes);
}

function setStatus(message, kind = "info") {
  const banner = document.querySelector("#status-banner");
  banner.textContent = message;
  banner.dataset.kind = kind;
}

function validateSettings(settings) {
  if (!/^wss?:\/\/.+/i.test(settings.wsUrl))
    return "Enter a ws:// or wss:// URL.";
  return "";
}

function bootstrap() {
  const settings = loadSettings();
  writeFormSettings(settings);
  saveSettings(settings);
  setStatus(settings.wsUrl ? "Current settings loaded." : "Save settings to configure the watch.", settings.wsUrl ? "success" : "info");

  document.querySelector("#settings-form").addEventListener("submit", event => {
    event.preventDefault();

    const nextSettings = readFormSettings();
    const error = validateSettings(nextSettings);
    if (error) {
      setStatus(error, "error");
      return;
    }

    saveSettings(nextSettings);
    getBridge().submit(nextSettings);
    setStatus("Closing to save settings.", "success");
  });
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

bootstrap();
