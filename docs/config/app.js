const STORAGE_KEY = "codex_jobs:config_state";

const DEFAULT_SETTINGS = Object.freeze({
  wsUrl: "",
  displayLimit: 3,
});

export function sanitizeSettings(settings = {}) {
  return {
    wsUrl: String(settings.wsUrl ?? "").trim(),
    displayLimit: clamp(settings.displayLimit, 1, 8, DEFAULT_SETTINGS.displayLimit),
  };
}

export function parseEmbeddedSettings(search = globalThis.location?.search ?? "") {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get("settings") ?? params.get("state");
    return raw ? sanitizeSettings(JSON.parse(raw)) : {};
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
    return {
      submit(payload) {
        globalThis.PebbleConfigBridge.submit(payload);
        return true;
      },
    };
  }

  const returnTo = getReturnToUrl();
  if (returnTo) {
    return {
      submit(payload) {
        try {
          globalThis.location.href = appendClosePayload(returnTo, payload);
          return true;
        } catch (_error) {
          return false;
        }
      },
    };
  }

  return {
      submit(payload) {
        try {
          globalThis.location.href = "pebblejs://close#" + encodeURIComponent(JSON.stringify(payload));
          return true;
        } catch (_error) {
          return false;
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
  let separator = "?";
  if (returnTo.endsWith("?") || returnTo.endsWith("&"))
    separator = "";
  else if (returnTo.includes("?"))
    separator = "&";
  return returnTo + separator + encodeURIComponent(JSON.stringify(payload));
}

function readFormSettings() {
  return sanitizeSettings({
    wsUrl: document.querySelector("#wsUrl").value,
    displayLimit: document.querySelector("#displayLimit").value,
  });
}

function writeFormSettings(settings) {
  document.querySelector("#wsUrl").value = settings.wsUrl;
  document.querySelector("#displayLimit").value = String(settings.displayLimit);
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
    try {
      if (getBridge().submit(nextSettings)) {
        setStatus("Closing to save settings.", "success");
      } else {
        setStatus("Settings saved locally, but watch was not notified.", "error");
      }
    } catch (_error) {
      setStatus("Settings saved locally, but watch was not notified.", "error");
    }
  });
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

bootstrap();
