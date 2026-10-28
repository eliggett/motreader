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

/** Why a tab is empty on an older format version (only its modes are decoded). */
export function modesOnlyText(/** @type {import("../state.js").Document} */ doc) {
    return `This codeplug is in the older format version ${doc.support.version}: motreader decodes and edits `
        + "only its modes (on the Modes tab). Everything else is kept exactly as it is.";
}

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
export function section(/** @type {string} */ title, /** @type {(Node | null)[]} */ ...content) {
    return h("section", { class: "block" }, h("h3", {}, title), ...content);
}
