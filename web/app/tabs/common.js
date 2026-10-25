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

/** A tab whose content arrives in a later milestone. */
export function placeholder(/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ coming) {
    /** @type {Tab} */
    const tab = {
        id, title,
        render(el, doc) {
            el.replaceChildren(empty(doc ? coming : NO_DOC));
        },
    };
    return tab;
}

/** A two-column table of label/value rows. */
export function infoTable(/** @type {[string, string | number][]} */ rows) {
    return h("table", { class: "info" },
        h("tbody", {}, rows.map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v)))));
}
