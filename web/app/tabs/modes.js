// @ts-check
/**
 * Modes: the mode list as a table. Read-only for now; the editable grid
 * arrives with the edit milestone. Columns no mode has a value for (the
 * 900 MHz-only options on a VHF radio) are left out.
 */
import { h, fill } from "../dom.js";
import { empty, note, NO_DOC } from "./common.js";

/** @typedef {import("../../lib/codeplug.js").Mode} Mode */

const mhz = (/** @type {number | null} */ v) => (v === null ? "" : v.toFixed(4));
/** "PL 100.0", "DPL D411", "Carrier", or "" when the slot isn't decoded. */
const squelch = (/** @type {string | null} */ type, /** @type {string | null} */ code) =>
    type === null ? "" : code ? `${type} ${code}` : type;

/** @type {{ label: string, get: (m: Mode) => string, cls?: string }[]} */
export const COLUMNS = [
    { label: "#", get: (m) => String(m.number), cls: "num" },
    { label: "Name", get: (m) => m.name, cls: "name" },
    { label: "Rx MHz", get: (m) => mhz(m.rx_mhz), cls: "num" },
    { label: "Tx MHz", get: (m) => mhz(m.tx_mhz), cls: "num" },
    { label: "T/A MHz", get: (m) => mhz(m.ta_mhz), cls: "num" },
    { label: "Rx squelch", get: (m) => squelch(m.rx_squelch_type, m.rx_pl) },
    { label: "Tx squelch", get: (m) => squelch(m.tx_squelch_type, m.tx_pl) },
    { label: "T/A squelch", get: (m) => squelch(m.ta_squelch_type, m.ta_pl) },
    { label: "Tx power", get: (m) => m.tx_power ?? "" },
    { label: "T/A power", get: (m) => m.ta_power ?? "" },
    { label: "MPL type", get: (m) => m.mpl_type ?? "" },
    { label: "uP Xtal shift", get: (m) => m.up_xtal_shift ?? "" },
    { label: "MDC PTT ID", get: (m) => m.mdc_ptt_id ?? "" },
    { label: "Phone encode", get: (m) => m.phone_encode ?? "" },
    { label: "Audio compander", get: (m) => m.audio_compander ?? "" },
    { label: "Adaptive splatter", get: (m) => m.adaptive_splatter ?? "" },
    { label: "Reverse burst/TOC", get: (m) => m.reverse_burst_toc ?? "" },
    { label: "Unmute/mute", get: (m) => m.unmute_mute_type ?? "" },
];

/** @type {import("./common.js").Tab} */
export default {
    id: "modes",
    title: "Modes",
    render(el, doc) {
        if (!doc) return fill(el, empty(NO_DOC));
        const modes = doc.cp.modes;
        if (!modes.length) return fill(el, empty("No modes were found in this codeplug."));
        const cols = COLUMNS.filter((c) => modes.some((m) => c.get(m) !== ""));
        // a trunked mode 1 is a different record: its option bits aren't conventional settings
        const trunked = (/** @type {Mode} */ m) => m.number === 1 && doc.trunk.info !== null;
        const cell = (/** @type {Mode} */ m, /** @type {typeof COLUMNS[number]} */ c) =>
            h("td", { class: c.cls ?? "" }, c.get(m), c.label === "Name" && trunked(m) ? h("span", { class: "tag" }, "trunked") : null);
        const row = (/** @type {Mode} */ m) => h("tr", { class: trunked(m) ? "trunked" : "" }, cols.map((c) => cell(m, c)));
        fill(el,
            note(`${modes.length} modes. Read-only for now: the editor arrives in the next milestone.`),
            h("div", { class: "table-wrap" },
                h("table", { class: "grid" },
                    h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c.cls ?? "" }, c.label)))),
                    h("tbody", {}, modes.map(row)))));
    },
};
