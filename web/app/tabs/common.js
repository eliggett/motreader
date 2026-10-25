// @ts-check
/** Pieces shared by the tab modules. */
import { h } from "../dom.js";

/**
 * A tab: `render` draws it into `el` for the open document (null when none is
 * open). Tabs are re-rendered whenever the document changes or they are shown.
 * @typedef {{
 *   id: string,
 *   title: string,
 *   render: (el: HTMLElement, doc: import("../state.js").Document | null) => void,
 * }} Tab
 */

/** The "nothing to show" message. */
export function empty(/** @type {string} */ text) {
    return h("p", { class: "empty" }, text);
}

export const NO_DOC = "Import a codeplug to begin.";

/** A muted explanatory paragraph. */
export function note(/** @type {string} */ text) {
    return h("p", { class: "note" }, text);
}

/** A two-column table of label/value rows, with an optional muted note per row. */
export function infoTable(/** @type {{ label: string, value: string | number, note?: string }[]} */ rows) {
    return h("table", { class: "info" },
        h("tbody", {}, rows.map((r) => h("tr", {},
            h("th", {}, r.label),
            h("td", {}, String(r.value)),
            h("td", { class: "row-note" }, r.note ?? "")))));
}

/** A titled section: heading and content. */
export function section(/** @type {string} */ title, /** @type {Node[]} */ ...content) {
    return h("section", { class: "block" }, h("h3", {}, title), ...content);
}
