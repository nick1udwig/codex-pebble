const CLIENT_INFO = {
    name: "repebble_codex_jobs",
    title: "Codex Jobs for Pebble",
    version: "0.1.0"
};

const ALLOWED_METHODS = new Set([
    "initialize",
    "initialized",
    "thread/loaded/list",
    "thread/list",
    "thread/read",
    "thread/resume",
    "thread/unsubscribe",
    "turn/steer",
    "turn/start",
    "account/read",
    "turn/interrupt"
]);

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(ms) {
    return ms + Math.floor(Math.random() * Math.max(1, ms / 3));
}

export class JsonRpcError extends Error {
    constructor(method, error) {
        super(error && error.message ? error.message : "JSON-RPC request failed");
        this.name = "JsonRpcError";
        this.method = method;
        this.code = error ? error.code : undefined;
        this.data = error ? error.data : undefined;
    }
}

export default class CodexRpcClient {
    constructor(url, hooks = {}) {
        this.url = url;
        this.hooks = hooks;
        this.nextId = 1;
        this.pending = new Map();
        this.ws = null;
        this.closedByClient = false;
    }

    connect() {
        this.close();
        this.closedByClient = false;
        this.setState("connecting");

        return new Promise((resolve, reject) => {
            let settled = false;

            try {
                this.ws = new WebSocket(this.url);
            } catch (error) {
                this.setState("closed");
                reject(error);
                return;
            }

            const fail = error => {
                if (settled)
                    return;
                settled = true;
                this.setState("closed");
                reject(error);
            };

            this.ws.addEventListener("open", () => {
                this.setState("open");
                this.initialize()
                    .then(result => {
                        settled = true;
                        this.setState("ready");
                        resolve(result);
                    })
                    .catch(fail);
            });

            this.ws.addEventListener("message", event => this.handleMessage(event));
            this.ws.addEventListener("error", event => {
                const error = new Error("WebSocket error");
                error.event = event;
                if (!settled)
                    fail(error);
                this.emitError(error);
            });
            this.ws.addEventListener("close", event => {
                this.rejectAll(new Error("WebSocket closed"));
                this.setState("closed");
                if (!settled)
                    fail(new Error("WebSocket closed before initialize"));
                if (!this.closedByClient && this.hooks.onClose)
                    this.hooks.onClose(event);
            });
        });
    }

    initialize() {
        return this.request("initialize", {
            clientInfo: CLIENT_INFO,
            capabilities: {
                experimentalApi: true
            }
        }).then(result => {
            this.notify("initialized", {});
            return result;
        });
    }

    request(method, params = {}, options = {}) {
        this.assertAllowed(method);
        const retries = options.retries === undefined ? 3 : options.retries;
        const timeout = options.timeout || 15000;

        return this.sendOnce(method, params, timeout).catch(error => {
            if (error.code === -32001 && retries > 0) {
                const attempt = 4 - retries;
                return delay(jitter(750 * attempt)).then(() => {
                    return this.request(method, params, { ...options, retries: retries - 1 });
                });
            }
            throw error;
        });
    }

    notify(method, params = {}) {
        this.assertAllowed(method);
        this.sendMessage({ method, params });
    }

    close() {
        this.closedByClient = true;
        if (this.ws) {
            try {
                this.ws.close();
            } catch (_) {
            }
            this.ws = null;
        }
        this.rejectAll(new Error("JSON-RPC client closed"));
    }

    sendOnce(method, params, timeout) {
        const id = this.nextId++;
        const message = { method, id, params };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(method + " timed out"));
            }, timeout);

            this.pending.set(id, { resolve, reject, timer, method });

            try {
                this.sendMessage(message);
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    sendMessage(message) {
        if (!this.ws || this.ws.readyState !== 1)
            throw new Error("WebSocket is not open");
        this.ws.send(JSON.stringify(message));
    }

    handleMessage(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            this.emitError(error);
            return;
        }

        if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);

            if (message.error)
                pending.reject(new JsonRpcError(pending.method, message.error));
            else
                pending.resolve(message.result || {});
            return;
        }

        if (message.method && this.hooks.onNotify)
            this.hooks.onNotify(message.method, message.params || {});
    }

    rejectAll(error) {
        this.pending.forEach(pending => {
            clearTimeout(pending.timer);
            pending.reject(error);
        });
        this.pending.clear();
    }

    assertAllowed(method) {
        if (!ALLOWED_METHODS.has(method))
            throw new Error("Forbidden Codex app-server method: " + method);
    }

    setState(state) {
        if (this.hooks.onStateChange)
            this.hooks.onStateChange(state);
    }

    emitError(error) {
        if (this.hooks.onError)
            this.hooks.onError(error);
    }
}
