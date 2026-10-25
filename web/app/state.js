// @ts-check
/**
 * The open document. Every change goes through `setDocument` / `update`, which
 * notify subscribers, so tabs re-render from one source of truth (and undo can
 * be added here later).
 */

/** @typedef {import("../lib/document.js").CodeplugDocument} Document */

/** @type {Document | null} */
let doc = null;
/** @type {Set<(d: Document | null, why: string) => void>} */
const listeners = new Set();

export const store = {
    /** The open document, or null. */
    get: () => doc,
    /** Replace the document (null closes it). */
    setDocument(/** @type {Document | null} */ d, why = "load") {
        doc = d;
        notify(why);
    },
    /** Change the open document in place via `fn`, then notify. */
    update(/** @type {(d: Document) => void} */ fn, why = "edit") {
        if (!doc) throw new Error("no document is open");
        fn(doc);
        notify(why);
    },
    /** Call `fn(doc, why)` after every change; returns an unsubscribe function. */
    subscribe(/** @type {(d: Document | null, why: string) => void} */ fn) {
        listeners.add(fn);
        return () => void listeners.delete(fn);
    },
};

function notify(/** @type {string} */ why) {
    for (const fn of listeners) fn(doc, why);
}
