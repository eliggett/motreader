// @ts-check
/**
 * `window.mr`: a small API for driving and inspecting the app from scripts
 * (tools/cdp.mjs) or the browser console. It goes through the same code paths
 * as the buttons, without file pickers.
 *
 *   await mr.ready
 *   mr.load("A617ASQ1.266", bytesOrBase64)   // and mr.loadIndex("SPECTRAM.DBF", ...)
 *   mr.tab("hex"); mr.text()         // visible tab's text
 *   mr.modal(); mr.answer("ok")      // inspect / press the open dialog
 *   mr.log("info")                   // log lines at info and above
 *   mr.setMode(3, "rx_mhz", "146.52"); mr.mode(3, "rx_mhz")   // edit / read a mode field
 *   mr.setRadioWide("home_mode", 2); mr.setZone(1, { name: "HOME", modes: "1-5" })
 *   mr.exported()                    // build the archive without the dialog: { base64, problems, changed }
 *   mr.errors                        // uncaught errors since load
 */
import { VERSION } from "./version.js";
import { store } from "./state.js";
import { log, format, LEVELS } from "./log.js";
import { showTab, activeTab } from "./tabbar.js";
import { TABS } from "./tabs/index.js";
import * as modal from "./modal.js";
import * as actions from "./actions.js";
import * as editing from "./editing.js";
import { exportArchive } from "../lib/export.js";
import { changes } from "../lib/document.js";
import { lastDownload } from "./files.js";
import { currentDialog } from "./modal.js";

/** @type {string[]} */
const errors = [];

/** Bytes from a Uint8Array, a plain array or base64. */
function toBytes(/** @type {Uint8Array | number[] | string} */ data) {
    return typeof data === "string" ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : Uint8Array.from(data);
}

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
            actions.loadCodeplug(name, toBytes(data));
            return api.state();
        },
        /** Attach a SPECTRAM.DBF (same data forms as load); returns the archive's record or null. */
        loadIndex: (/** @type {string} */ name, /** @type {Uint8Array | number[] | string} */ data) =>
            actions.loadIndex(name, toBytes(data)),
        /** A summary of the open document. */
        state() {
            const d = store.get();
            return d && {
                fileName: d.fileName, model: d.cp.model, serial: d.cp.serial, band: d.cp.band,
                modes: d.cp.modes.length, zones: d.cp.zones.length, size: d.plain.length,
                customer: d.index?.record?.CUSTOMER ?? null,
                trunking: d.trunk.info ? "removable" : d.trunk.unsupported ? "not removable" : null,
            };
        },
        /** The open document itself (decoded codeplug, radio-wide values, ...). */
        doc: () => store.get(),
        /** Log lines at `level` and above (default: everything, debug included). */
        log(/** @type {import("./log.js").Level} */ level = "debug") {
            const min = LEVELS.indexOf(level);
            return log.entries(true).filter((e) => LEVELS.indexOf(e.level) >= min).map(format);
        },
        /** The open dialog ({ title, text, buttons }) or null. */
        modal: modal.current,
        /** Press the open dialog's button `value` (null = Escape). */
        answer: modal.answer,
        /** Edit mode `n`'s field from text, as the grid does: { note } or { error }. */
        setMode: (/** @type {number} */ n, /** @type {string} */ key, /** @type {string} */ text) => editing.editMode(n, key, text),
        /** Mode `n`'s field as displayed text. */
        mode: (/** @type {number} */ n, /** @type {string} */ key) => editing.modeText(n, key),
        /** Edit a radio-wide setting: { note } or { error }. */
        setRadioWide: (/** @type {string} */ key, /** @type {unknown} */ value) => editing.editRadioWide(key, value),
        /** Edit zone `n`: name and/or modes ("1-5, 9"). */
        setZone(/** @type {number} */ n, /** @type {{ name?: string, modes?: string }} */ z) {
            const out = [];
            if (z.name !== undefined) out.push(editing.editZoneName(n, z.name));
            if (z.modes !== undefined) out.push(editing.editZoneModes(n, z.modes));
            return out;
        },
        /** What changed since the file was opened. */
        changes: () => {
            const d = store.get();
            return d && changes(d);
        },
        /** Build the archive as Export would, without the dialog. */
        exported() {
            const d = store.get();
            if (!d) return null;
            const r = exportArchive(d, d.radioWideEdits);
            return { base64: btoa(String.fromCharCode(...r.bytes)), size: r.bytes.length, problems: r.problems, changed: r.changed.length };
        },
        /** The last file the app offered as a download: { name, size, base64 }. */
        lastDownload() {
            if (!lastDownload) return null;
            const b = lastDownload.bytes;
            return {
                name: lastDownload.name, size: b.length,
                base64: typeof b === "string" ? btoa(b) : btoa(String.fromCharCode(...b)),
            };
        },
        /** Set a field of the open dialog by element id and fire its change. */
        fill(/** @type {string} */ id, /** @type {string} */ value) {
            const el = currentDialog()?.querySelector(`#${CSS.escape(id)}`) ?? document.getElementById(id);
            if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) throw new Error(`no field #${id}`);
            el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        /** The toolbar commands (file pickers can't be driven from scripts; use load()). */
        actions,
    };
    Object.assign(window, { mr: api });
    return api;
}
