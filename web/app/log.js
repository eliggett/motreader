// @ts-check
/**
 * The event log: timestamped entries with a level, shown in the panel at the
 * bottom of the page and exportable as text. Debug entries are always kept;
 * the panel's Debug checkbox only decides whether they are shown and exported.
 */

/** @typedef {"debug" | "info" | "warn" | "error"} Level */
/** @typedef {{ time: Date, level: Level, message: string }} Entry */

export const LEVELS = /** @type {const} */ (["debug", "info", "warn", "error"]);
const MAX_ENTRIES = 5000;

/** @type {Entry[]} */
const entries = [];
/** @type {Set<(e: Entry) => void>} */
const listeners = new Set();

/** @param {Level} level @param {string} message */
function add(level, message) {
    const e = { time: new Date(), level, message };
    entries.push(e);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(format(e));
    for (const fn of listeners) fn(e);
    return e;
}

export const log = {
    debug: (/** @type {string} */ m) => add("debug", m),
    info: (/** @type {string} */ m) => add("info", m),
    warn: (/** @type {string} */ m) => add("warn", m),
    error: (/** @type {string} */ m) => add("error", m),
    /** Entries, oldest first; without `includeDebug`, debug entries are left out. */
    entries: (includeDebug = true) => entries.filter((e) => includeDebug || e.level !== "debug"),
    clear: () => void entries.splice(0),
    /** Call `fn` for each new entry; returns an unsubscribe function. */
    subscribe(/** @type {(e: Entry) => void} */ fn) {
        listeners.add(fn);
        return () => void listeners.delete(fn);
    },
};

const pad = (/** @type {number} */ n, w = 2) => String(n).padStart(w, "0");

/** Local time as `2026-10-24 21:40:12.345`. */
export function timestamp(/** @type {Date} */ d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** One log line: `2026-10-24 21:40:12.345 INFO  message`. */
export function format(/** @type {Entry} */ e) {
    return `${timestamp(e.time)} ${e.level.toUpperCase().padEnd(5)} ${e.message}`;
}

/** The log as a text file's contents. */
export function exportText(includeDebug = false) {
    return log.entries(includeDebug).map(format).join("\n") + "\n";
}
