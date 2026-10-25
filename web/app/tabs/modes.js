// @ts-check
/**
 * Modes: the mode list as an editable grid, plus an Edit button per row for
 * the single-mode editor. Columns that don't apply to this radio (900 MHz-only
 * options on a VHF radio) are left out. Mode add/delete/move/duplicate come
 * with the structural milestone.
 */
import { h, fill } from "../dom.js";
import { createGrid } from "../grid.js";
import { editMode } from "../editing.js";
import { openModeEditor } from "../modeeditor.js";
import { MODE_FIELDS, SQUELCH_CHOICES, fieldText, applies, nameRule, isTrunkedMode } from "../../lib/modefields.js";
import { empty, note, NO_DOC } from "./common.js";

/** @typedef {import("../../lib/codeplug.js").Mode} Mode */
/** @typedef {import("../state.js").Document} Document */

/** @type {{ doc: Document, grid: ReturnType<typeof createGrid<Mode>>, el: HTMLElement } | null} */
let cache = null;

/** @param {Document} doc */
function build(doc) {
    const { cp } = doc;
    const editable = cp.band !== "900?";
    const fields = MODE_FIELDS.filter((f) => cp.modes.some((m) => applies(cp, m, f)) || f.kind === "mhz");
    /** @type {import("../grid.js").Column<Mode>[]} */
    const columns = [
        { id: "number", label: "#", cls: "num", text: (m) => String(m.number) },
        ...fields.map((f) => /** @type {import("../grid.js").Column<Mode>} */ ({
            id: f.key, label: f.label,
            cls: f.kind === "mhz" ? "num" : f.kind === "name" ? "name" : "",
            text: (m) => fieldText(m, f.key),
            editor: (m) => {
                if (!editable || isTrunkedMode(cp, m) || !applies(cp, m, f)) return null;
                if (f.kind === "name") return { type: "text", maxLength: nameRule(cp).width, upper: true };
                if (f.kind === "mhz") return { type: "text" };
                return { type: "select", options: f.kind === "squelch" ? SQUELCH_CHOICES : /** @type {readonly string[]} */ (f.choices) };
            },
            changed: (m) => fieldText(m, f.key) !== doc.original.modes[m.number - 1]?.[f.key],
        })),
    ];
    const grid = createGrid({
        label: "Modes",
        columns,
        rows: () => cp.modes,
        onEdit: (m, key, text) => editMode(m.number, key, text),
        rowAction: { label: "Edit", title: "Open this mode in the mode editor", run: (m) => void openModeEditor(m.number) },
        rowClass: (m) => (isTrunkedMode(cp, m) ? "trunked" : ""),
    });
    const el = h("div", {},
        note(`${cp.modes.length} modes. Arrow keys move, Enter or typing edits, Escape cancels; `
            + "Edit opens one mode as a form. Changed cells are highlighted."
            + (cp.trunked_mode1 ? " Mode 1 is the trunked mode and isn't editable." : "")
            + (editable ? "" : " This codeplug's 900 MHz mode layout isn't recognised, so modes are read-only.")),
        grid.el);
    return { doc, grid, el };
}

/** @type {import("./common.js").Tab} */
export default {
    id: "modes",
    title: "Modes",
    render(el, doc) {
        if (!doc) {
            cache = null;
            return fill(el, empty(NO_DOC));
        }
        if (!doc.cp.modes.length) return fill(el, empty("No modes were found in this codeplug."));
        if (cache?.doc !== doc) cache = build(doc);
        else cache.grid.refresh();
        if (cache.el.parentElement !== el) fill(el, cache.el);
    },
};

/** The grid of the open document's Modes tab (for the test API), if built. */
export const modesGrid = () => cache?.grid ?? null;
