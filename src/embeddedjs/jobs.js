export const DEFAULT_SETTINGS = {
    wsUrl: "",
    displayLimit: 3,
    recentCompletionLookbackMinutes: 720
};

export const SOURCE_KINDS = [
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

const STATE_KEY = "codexJobsState";
const SETTINGS_KEY = "codexJobsSettings";
const DASHBOARD_KEY = "codexJobsDashboard";
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

export function nowUnix() {
    return Math.floor(Date.now() / 1000);
}

export function loadSettings() {
    return mergeSettings(readJson(SETTINGS_KEY, {}));
}

export function saveSettings(settings) {
    writeJson(SETTINGS_KEY, mergeSettings(settings));
}

export function mergeSettings(settings) {
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    merged.wsUrl = typeof merged.wsUrl === "string" ? merged.wsUrl.trim() : "";
    merged.displayLimit = clampNumber(merged.displayLimit, 1, 8, DEFAULT_SETTINGS.displayLimit);
    merged.recentCompletionLookbackMinutes = clampNumber(
        merged.recentCompletionLookbackMinutes,
        5,
        10080,
        DEFAULT_SETTINGS.recentCompletionLookbackMinutes
    );
    return merged;
}

export function loadAppState() {
    return normalizeAppState(readJson(STATE_KEY, {}));
}

export function saveAppState(state) {
    writeJson(STATE_KEY, normalizeAppState(state));
}

export function loadCachedDashboard() {
    return readJson(DASHBOARD_KEY, { jobs: [], syncedAt: 0, stale: true });
}

export function saveCachedDashboard(dashboard) {
    writeJson(DASHBOARD_KEY, dashboard || { jobs: [], syncedAt: 0, stale: true });
}

export function normalizeAppState(state) {
    const normalized = {
        watermark: {
            lastSuccessfulSyncUnix: 0
        },
        threads: {}
    };

    if (state && state.watermark)
        normalized.watermark.lastSuccessfulSyncUnix = asUnix(state.watermark.lastSuccessfulSyncUnix);
    if (state && state.threads && typeof state.threads === "object")
        normalized.threads = state.threads;

    return normalized;
}

export function buildVisibleJobs(threadEntries, appState, settings, syncedAt = nowUnix()) {
    const state = normalizeAppState(appState);
    const config = mergeSettings(settings);
    const watermark = state.watermark.lastSuccessfulSyncUnix || 0;
    const lookbackSince = syncedAt - (config.recentCompletionLookbackMinutes * 60);
    const jobs = [];

    for (const entry of threadEntries) {
        const thread = entry.thread || entry;
        const latestTurn = entry.latestTurn || entry.turn || null;
        const id = getThreadId(thread);

        if (!id)
            continue;

        const meta = ensureThreadMeta(state, id);
        const status = getThreadStatusType(thread);
        const latestStatus = getTurnStatus(latestTurn);
        const latestId = getTurnId(latestTurn) || fallbackTurnId(id, latestStatus, thread, latestTurn);
        const updatedAt = Math.max(getThreadUpdatedAt(thread), getTurnUpdatedAt(latestTurn));
        const previouslyActive = meta.lastSeenStatus === "active";
        const active = status === "active";
        const systemError = status === "systemError";
        const terminal = TERMINAL_TURN_STATUSES.has(latestStatus);
        const acked = latestId ? (meta.ackedTurnIds || []).indexOf(latestId) !== -1 : false;

        if (active) {
            meta.lastSeenStatus = "active";
            meta.lastSeenTurnId = latestId || meta.lastSeenTurnId || "";
            meta.lastSeenUpdatedAt = updatedAt || syncedAt;
        }

        if (active || systemError || (terminal && !acked && shouldShowCompleted(updatedAt, watermark, lookbackSince, previouslyActive))) {
            jobs.push(toJob(thread, latestTurn, {
                id,
                latestId,
                latestStatus,
                status,
                updatedAt,
                active,
                systemError
            }));
        }
    }

    jobs.sort(compareJobs);
    state.watermark.lastSuccessfulSyncUnix = syncedAt;
    return { jobs, appState: state };
}

export function acknowledgeJob(appState, job) {
    const state = normalizeAppState(appState);
    if (!job || !job.id || !job.latestTurnId)
        return state;
    const meta = ensureThreadMeta(state, job.id);
    if ((meta.ackedTurnIds || []).indexOf(job.latestTurnId) === -1)
        meta.ackedTurnIds.push(job.latestTurnId);
    return state;
}

export function isTerminalJob(job) {
    return job && (job.kind === "completed" || job.kind === "failed" || job.kind === "interrupted");
}

export function getThreadId(thread) {
    return thread && (thread.id || thread.threadId || thread.sessionId);
}

export function getTurnId(turn) {
    return turn && (turn.id || turn.turnId);
}

export function getThreadStatusType(thread) {
    if (!thread)
        return "unknown";

    const status = thread.status || thread.runtimeStatus || thread.state;
    if (typeof status === "string")
        return status;
    if (status && typeof status === "object")
        return status.type || status.state || status.status || "unknown";
    return "unknown";
}

export function getTurnStatus(turn) {
    if (!turn)
        return null;

    const status = turn.status || turn.state;
    if (typeof status === "string")
        return status;
    if (status && typeof status === "object")
        return status.type || status.state || status.status || null;
    return null;
}

export function getLatestTurnFromThread(thread) {
    const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
    if (!turns.length)
        return null;

    return turns.reduce((latest, turn) => {
        if (!latest)
            return turn;
        return getTurnUpdatedAt(turn) >= getTurnUpdatedAt(latest) ? turn : latest;
    }, null);
}

export function getThreadUpdatedAt(thread) {
    if (!thread)
        return 0;
    return asUnix(thread.updatedAt || thread.updated_at || thread.lastUpdatedAt || thread.createdAt || thread.created_at);
}

export function getTurnUpdatedAt(turn) {
    if (!turn)
        return 0;
    return asUnix(turn.updatedAt || turn.updated_at || turn.completedAt || turn.completed_at || turn.startedAt || turn.started_at || turn.createdAt || turn.created_at);
}

export function getJobTitle(thread) {
    if (!thread)
        return "Untitled";

    const direct = thread.name || thread.title || thread.preview || thread.summary;
    if (direct && String(direct).trim())
        return cleanOneLine(String(direct));

    if (thread.cwd) {
        const parts = String(thread.cwd).split("/");
        return parts[parts.length - 1] || String(thread.cwd);
    }

    return getThreadId(thread) || "Untitled";
}

export function getProgressText(thread, latestTurn) {
    const candidates = [
        latestTurn && latestTurn.summary,
        latestTurn && latestTurn.preview,
        latestTurn && latestTurn.lastMessage,
        thread && thread.preview,
        thread && thread.summary
    ];

    for (const candidate of candidates) {
        if (candidate && String(candidate).trim())
            return cleanOneLine(String(candidate));
    }

    const itemText = getItemSummary(latestTurn);
    return itemText ? cleanOneLine(itemText) : "";
}

export function hasWaitingOnApproval(threadOrStatus) {
    const status = threadOrStatus && (threadOrStatus.status || threadOrStatus.runtimeStatus || threadOrStatus);
    if (!status || typeof status !== "object")
        return false;

    if (status.waitingOnApproval || status.waitingForApproval)
        return true;

    const flags = status.activeFlags || status.flags || [];
    return Array.isArray(flags) && flags.indexOf("waitingOnApproval") !== -1;
}

function toJob(thread, latestTurn, facts) {
    const waitingOnApproval = facts.active && hasWaitingOnApproval(thread);
    const kind = facts.systemError ? "systemError" : (facts.active ? "active" : facts.latestStatus);
    return {
        id: facts.id,
        title: getJobTitle(thread),
        kind,
        statusType: facts.status,
        latestTurnId: facts.latestId || "",
        latestTurnStatus: facts.latestStatus || "",
        updatedAt: facts.updatedAt,
        waitingOnApproval,
        progress: getProgressText(thread, latestTurn),
        cwd: thread && thread.cwd ? String(thread.cwd) : ""
    };
}

function compareJobs(a, b) {
    const ap = statusPriority(a);
    const bp = statusPriority(b);
    if (ap !== bp)
        return ap - bp;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
}

function statusPriority(job) {
    if (job.waitingOnApproval)
        return 0;
    if (job.kind === "systemError")
        return 1;
    if (job.kind === "active")
        return 2;
    return 3;
}

function shouldShowCompleted(updatedAt, watermark, lookbackSince, previouslyActive) {
    return previouslyActive || (watermark > 0 && updatedAt > watermark) || updatedAt >= lookbackSince;
}

function fallbackTurnId(threadId, latestStatus, thread, latestTurn) {
    const updatedAt = Math.max(getThreadUpdatedAt(thread), getTurnUpdatedAt(latestTurn));
    if (!latestStatus && !updatedAt)
        return "";
    return threadId + ":" + (latestStatus || "unknown") + ":" + updatedAt;
}

function ensureThreadMeta(state, threadId) {
    if (!state.threads[threadId]) {
        state.threads[threadId] = {
            lastSeenStatus: "",
            lastSeenTurnId: "",
            lastSeenUpdatedAt: 0,
            ackedTurnIds: []
        };
    }

    const meta = state.threads[threadId];
    if (!Array.isArray(meta.ackedTurnIds))
        meta.ackedTurnIds = [];
    return meta;
}

function getItemSummary(turn) {
    const items = turn && (turn.items || turn.itemsView || turn.summaryItems);
    if (!Array.isArray(items) || !items.length)
        return "";

    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const text = item && (item.text || item.summary || item.preview || item.message);
        if (text)
            return String(text);
    }
    return "";
}

function cleanOneLine(value) {
    return value.replace(/\s+/g, " ").trim();
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
}

function asUnix(value) {
    if (value === undefined || value === null || value === "")
        return 0;

    if (typeof value === "number")
        return value > 100000000000 ? Math.floor(value / 1000) : Math.floor(value);

    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber))
        return asUnix(parsedNumber);

    const date = Date.parse(value);
    if (Number.isFinite(date))
        return Math.floor(date / 1000);

    return 0;
}

function readJson(key, fallback) {
    if (typeof localStorage === "undefined")
        return fallback;

    const stored = localStorage.getItem(key);
    if (!stored)
        return fallback;

    try {
        return JSON.parse(stored);
    } catch (_) {
        return fallback;
    }
}

function writeJson(key, value) {
    if (typeof localStorage === "undefined")
        return;

    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.log("Storage write failed: " + error.message);
    }
}
