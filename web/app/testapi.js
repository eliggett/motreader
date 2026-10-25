// @ts-check
/**
 * `window.mr`: a small API for driving and inspecting the app from scripts
 * (tools/cdp.mjs) or the browser console. It goes through the same code paths
 * as the buttons, without file pickers.
 *
 *   await mr.ready
 *   mr.load("A617ASQ1.266", bytesOrBase64)
 *   mr.tab("hex"); mr.text()         // visible tab's text
 *   mr.modal(); mr.answer("ok")      // inspect / press the open dialog
 *   mr.log("info")                   // log lines at info and above
 *   mr.errors                        // uncaught errors since load
 */
import { VERSION } from "./version.js";
import { store } from "./state.js";
import { log, format, LEVELS } from "./log.js";
import { showTab, activeTab } from "./tabbar.js";
import { TABS } from "./tabs/index.js";
import * as modal from "./modal.js";
import * as actions from "./actions.js";

/** @type {string[]} */
const errors = [];

/** Install `window.mr`; `ready` resolves once the page has finished starting. */
export function installTestApi(/** @type {Promise<void>} */ ready) {
    window.addEventListener("error", (e) => errors.push(`${e.message} (${e.filename}:${e.lineno})`));
    window.addEventListener("unhandledrejection", (e) => errors.push(`unhandled rejection: ${e.reason}`));

    const api = {
        version: VERSION,
        ready,
        errors,
        /** Tab ids, or with an id, switch to it; returns the active tab id. */
        tabs: () => TABS.map((t) => t.id),
        tab(/** @type {string | undefined} */ id) {
            if (id !== undefined) {
                if (!TABS.some((t) => t.id === id)) throw new Error(`no tab "${id}"`);
                showTab(id);
            }
            return activeTab();
        },
        /** Text of the visible tab's panel. */
        text: () => document.getElementById(`panel-${activeTab()}`)?.innerText ?? "",
        /** Load a codeplug from a Uint8Array, a byte array or base64. */
        load(/** @type {string} */ name, /** @type {Uint8Array | number[] | string} */ data) {
            const bytes = typeof data === "string"
                ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
                : Uint8Array.from(data);
            actions.loadCodeplug(name, bytes);
            return api.state();
        },
        /** A summary of the open document. */
        state() {
            const d = store.get();
            return d && { fileName: d.fileName, size: d.raw.length };
        },
        /** Log lines at `level` and above (default: everything, debug included). */
        log(/** @type {import("./log.js").Level} */ level = "debug") {
            const min = LEVELS.indexOf(level);
            return log.entries(true).filter((e) => LEVELS.indexOf(e.level) >= min).map(format);
        },
        /** The open dialog ({ title, text, buttons }) or null. */
        modal: modal.current,
        /** Press the open dialog's button `value` (null = Escape). */
        answer: modal.answer,
        /** The toolbar commands (file pickers can't be driven from scripts; use load()). */
        actions,
    };
    Object.assign(window, { mr: api });
    return api;
}
