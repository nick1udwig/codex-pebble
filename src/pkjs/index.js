const moddableProxy = require("@moddable/pebbleproxy");

const SETTINGS_KEY = "codexJobsSettings";
const CONFIG_URL = "https://nick1udwig.github.io/codex-pebble/config/?v=20260609-return-to";

Pebble.addEventListener("ready", function(event) {
    moddableProxy.readyReceived(event);
    sendSettingsToWatch();
});

Pebble.addEventListener("appmessage", function(event) {
    if (moddableProxy.appMessageReceived(event))
        return;

    if (event.payload && event.payload.ConfigRequest)
        sendSettingsToWatch();
});

Pebble.addEventListener("showConfiguration", function() {
    const settings = loadSettings();
    const separator = CONFIG_URL.indexOf("?") === -1 ? "?" : "&";
    Pebble.openURL(CONFIG_URL + separator + "settings=" + encodeURIComponent(JSON.stringify(settings)));
});

Pebble.addEventListener("webviewclosed", function(event) {
    if (!event.response)
        return;

    let decoded = event.response;
    try {
        decoded = decodeURIComponent(decoded);
    } catch (_) {
    }

    try {
        const settings = sanitizeSettings(JSON.parse(decoded));
        saveSettings(settings);
        sendSettingsToWatch();
    } catch (error) {
        console.log("Config parse failed: " + error.message);
    }
});

function sendSettingsToWatch() {
    Pebble.sendAppMessage({
        Config: JSON.stringify(loadSettings())
    }, function() {
        console.log("Settings sent to watch");
    }, function(error) {
        console.log("Settings send failed: " + JSON.stringify(error));
    });
}

function loadSettings() {
    const fallback = {
        wsUrl: "",
        displayLimit: 3,
        recentCompletionLookbackMinutes: 720
    };

    const stored = localStorage.getItem(SETTINGS_KEY);
    if (!stored)
        return fallback;

    try {
        return sanitizeSettings(Object.assign(fallback, JSON.parse(stored)));
    } catch (_) {
        return fallback;
    }
}

function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
}

function sanitizeSettings(settings) {
    return {
        wsUrl: typeof settings.wsUrl === "string" ? settings.wsUrl.trim() : "",
        displayLimit: clamp(settings.displayLimit, 1, 8, 3),
        recentCompletionLookbackMinutes: clamp(settings.recentCompletionLookbackMinutes, 5, 10080, 720)
    };
}

function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
}
