var SETTINGS_KEY = "codexJobsSettings";
var CONFIG_URL = "https://nick1udwig.github.io/codex-pebble/config/?v=20260609-return-to";

var Key = Object.freeze({
  messageType: 0,
  payload: 1,
  requestId: 2,
  syncState: 3
});

var MessageType = Object.freeze({
  appReady: "app_ready",
  refresh: "refresh",
  openConfig: "open_config",
  settingsState: "settings_state",
  syncStatus: "sync_status",
  jobClear: "job_clear",
  jobItem: "job_item",
  jobComplete: "job_complete",
  error: "error"
});

var SyncState = Object.freeze({
  desynced: 0,
  syncing: 1,
  synced: 2
});

var SOURCE_KINDS = [
  "cli",
  "vscode",
  "appServer",
  "exec",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
];

var ProtocolByteLimit = Object.freeze({
  title: 47,
  detail: 95,
  payload: 220
});

var sendQueue = [];
var sending = false;
var syncInFlight = false;
var currentClient = null;

Pebble.addEventListener("ready", function() {
  sendSettingsState();
});

Pebble.addEventListener("appmessage", function(event) {
  var type = readPayloadValue(event.payload, Key.messageType, "MessageType");

  if (type === MessageType.appReady) {
    sendSettingsState();
    syncJobs();
  } else if (type === MessageType.refresh) {
    syncJobs();
  } else if (type === MessageType.openConfig) {
    openConfiguration();
  }
});

Pebble.addEventListener("showConfiguration", openConfiguration);

Pebble.addEventListener("webviewclosed", function(event) {
  if (!event.response)
    return;

  var decoded = event.response;
  try {
    decoded = decodeURIComponent(decoded);
  } catch (_) {
  }

  try {
    saveSettings(JSON.parse(decoded));
    sendSettingsState();
    syncJobs();
  } catch (error) {
    log("Config parse failed", error);
    sendError("Bad config");
  }
});

function openConfiguration() {
  var separator = CONFIG_URL.indexOf("?") === -1 ? "?" : "&";
  Pebble.openURL(CONFIG_URL + separator + "settings=" + encodeURIComponent(JSON.stringify(loadSettings())));
}

function syncJobs() {
  var settings = loadSettings();
  if (!settings.wsUrl) {
    sendSettingsState();
    sendStatus("Set server URL", SyncState.desynced);
    return;
  }

  if (syncInFlight)
    return;

  syncInFlight = true;
  sendSettingsState();
  sendStatus("Syncing", SyncState.syncing);
  sendEnvelope(MessageType.jobClear, "", 0, SyncState.syncing);
  log("Sync starting", settings.wsUrl);

  if (currentClient)
    currentClient.close();

  currentClient = new JsonRpcClient(settings.wsUrl);
  currentClient.connect()
    .then(function() {
      return currentClient.request("thread/list", {
        limit: settings.displayLimit,
        sortKey: "updated_at",
        archived: false,
        sourceKinds: SOURCE_KINDS,
        useStateDbOnly: true
      });
    })
    .then(function(result) {
      var threads = result.data || result.threads || [];
      sendJobs(threads, settings);
      currentClient.close();
      currentClient = null;
      syncInFlight = false;
    })
    .catch(function(error) {
      log("Sync failed", error);
      if (currentClient)
        currentClient.close();
      currentClient = null;
      syncInFlight = false;
      sendError(humanError(error));
    });
}

function sendJobs(threads, settings) {
  var count = Math.min(threads.length, settings.displayLimit);
  var index;

  for (index = 0; index < count; index += 1)
    sendJobItem(threads[index]);

  sendEnvelope(MessageType.jobComplete, String(count), 0, SyncState.synced);
  log("Sync complete", count + " jobs");
}

function sendJobItem(thread) {
  var id = sanitizeField(thread.id || thread.sessionId || "", 36);
  var kind = sanitizeField(threadStatusText(thread), 15);
  var title = sanitizeField(thread.name || thread.preview || thread.cwd || "Codex thread", ProtocolByteLimit.title);
  var detail = sanitizeField(jobDetail(thread), ProtocolByteLimit.detail);

  sendEnvelope(
    MessageType.jobItem,
    truncateUtf8([id, kind, title, detail].join("|"), ProtocolByteLimit.payload),
    0,
    SyncState.syncing
  );
}

function jobDetail(thread) {
  var parts = [];
  var status = threadStatusText(thread);
  var source = thread.source || "";
  var cwd = basename(thread.cwd || "");

  if (status)
    parts.push(status);
  if (source)
    parts.push(source);
  if (cwd)
    parts.push(cwd);
  return parts.join(" - ") || "Codex";
}

function threadStatusText(thread) {
  var status = thread && thread.status;
  if (!status)
    return "unknown";
  if (typeof status === "string")
    return status;
  return status.type || "unknown";
}

function basename(path) {
  var text = String(path || "");
  var parts = text.split("/");
  return parts[parts.length - 1] || text;
}

function sendSettingsState() {
  var settings = loadSettings();
  sendEnvelope(
    MessageType.settingsState,
    [settings.wsUrl ? "1" : "0", sanitizeField(settings.wsUrl, 120)].join("|"),
    0,
    settings.wsUrl ? SyncState.syncing : SyncState.desynced
  );
}

function sendStatus(status, syncState) {
  sendEnvelope(MessageType.syncStatus, sanitizeField(status, ProtocolByteLimit.detail), 0, syncState);
}

function sendError(message) {
  sendEnvelope(MessageType.error, sanitizeField(message || "Sync failed", ProtocolByteLimit.detail), 0, SyncState.desynced);
}

function sendEnvelope(type, payload, requestId, syncState) {
  var message = {};
  message[Key.messageType] = type || "";
  message[Key.payload] = payload || "";
  message[Key.requestId] = requestId || 0;
  message[Key.syncState] = syncState == null ? SyncState.desynced : syncState;

  sendQueue.push(message);
  flushSendQueue();
}

function flushSendQueue() {
  if (sending || !sendQueue.length)
    return;

  sending = true;
  Pebble.sendAppMessage(sendQueue[0], function() {
    sending = false;
    sendQueue.shift();
    flushSendQueue();
  }, function(error) {
    sending = false;
    sendQueue.shift();
    log("sendAppMessage failed", error);
    flushSendQueue();
  });
}

function readPayloadValue(payload, numericKey, namedKey) {
  if (!payload)
    return null;
  if (payload[namedKey] !== undefined && payload[namedKey] !== null)
    return payload[namedKey];
  if (payload[numericKey] !== undefined && payload[numericKey] !== null)
    return payload[numericKey];
  if (payload[String(numericKey)] !== undefined && payload[String(numericKey)] !== null)
    return payload[String(numericKey)];
  return null;
}

function loadSettings() {
  var fallback = {
    wsUrl: "",
    displayLimit: 3,
    recentCompletionLookbackMinutes: 720
  };
  var stored = localStorage.getItem(SETTINGS_KEY);
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
  var number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function sanitizeField(value, maxBytes) {
  return truncateUtf8(
    String(value == null ? "" : value)
      .replace(/\|/g, "/")
      .replace(/\r?\n/g, " ")
      .trim(),
    maxBytes
  );
}

function truncateUtf8(value, maxBytes) {
  var text = String(value == null ? "" : value);
  var length = 0;
  var end = 0;
  var index;
  var code;
  var next;
  var codeUnitLength;
  var codeByteLength;

  for (index = 0; index < text.length; index += codeUnitLength) {
    code = text.charCodeAt(index);
    codeUnitLength = 1;
    codeByteLength = 1;

    if (code <= 0x7F) {
      codeByteLength = 1;
    } else if (code <= 0x7FF) {
      codeByteLength = 2;
    } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
      next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        codeUnitLength = 2;
        codeByteLength = 4;
      } else {
        codeByteLength = 3;
      }
    } else {
      codeByteLength = 3;
    }

    if (length + codeByteLength > maxBytes)
      break;

    length += codeByteLength;
    end = index + codeUnitLength;
  }

  return text.slice(0, end);
}

function humanError(error) {
  var message = error && error.message ? error.message : String(error || "Sync failed");
  if (/WebSocket|Handshake status 403|Connection failed/i.test(message))
    return "Cannot reach Codex";
  return message;
}

function log(message, extra) {
  if (extra && extra.message)
    console.log("[PKJS] " + message + ": " + extra.message);
  else if (extra)
    console.log("[PKJS] " + message + ": " + String(extra));
  else
    console.log("[PKJS] " + message);
}

function JsonRpcClient(url) {
  this.url = url;
  this.ws = null;
  this.nextId = 1;
  this.pending = {};
  this.closed = false;
}

JsonRpcClient.prototype.connect = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    try {
      self.ws = new WebSocket(self.url);
    } catch (error) {
      reject(error);
      return;
    }

    self.ws.onopen = function() {
      self.request("initialize", {
        clientInfo: {
          name: "repebble_codex_jobs",
          title: "Codex Jobs for Pebble",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      }).then(function(result) {
        self.notify("initialized", {});
        resolve(result);
      }).catch(reject);
    };
    self.ws.onmessage = function(event) {
      self.handleMessage(event.data);
    };
    self.ws.onerror = function() {
      reject(new Error("WebSocket error"));
    };
    self.ws.onclose = function() {
      self.rejectAll(new Error("WebSocket closed"));
    };
  });
};

JsonRpcClient.prototype.request = function(method, params) {
  var self = this;
  var id = this.nextId++;
  var message = { method: method, id: id, params: params || {} };

  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      delete self.pending[id];
      reject(new Error(method + " timed out"));
    }, 15000);
    self.pending[id] = { resolve: resolve, reject: reject, timer: timer };
    self.send(message);
  });
};

JsonRpcClient.prototype.notify = function(method, params) {
  this.send({ method: method, params: params || {} });
};

JsonRpcClient.prototype.send = function(message) {
  if (!this.ws || this.ws.readyState !== 1)
    throw new Error("WebSocket is not open");
  this.ws.send(JSON.stringify(message));
};

JsonRpcClient.prototype.handleMessage = function(raw) {
  var message;
  var pending;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    log("Bad JSON-RPC message", error);
    return;
  }

  if (message.id === undefined)
    return;

  pending = this.pending[message.id];
  if (!pending)
    return;

  delete this.pending[message.id];
  clearTimeout(pending.timer);
  if (message.error)
    pending.reject(new Error(message.error.message || "JSON-RPC request failed"));
  else
    pending.resolve(message.result || {});
};

JsonRpcClient.prototype.rejectAll = function(error) {
  var keys = Object.keys(this.pending);
  var index;
  var pending;
  for (index = 0; index < keys.length; index += 1) {
    pending = this.pending[keys[index]];
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  this.pending = {};
};

JsonRpcClient.prototype.close = function() {
  this.closed = true;
  if (this.ws) {
    try {
      this.ws.close();
    } catch (_) {
    }
    this.ws = null;
  }
  this.rejectAll(new Error("JSON-RPC client closed"));
};

module.exports = {
  Key: Key,
  MessageType: MessageType,
  SyncState: SyncState,
  sanitizeSettings: sanitizeSettings,
  truncateUtf8: truncateUtf8,
  JsonRpcClient: JsonRpcClient
};
