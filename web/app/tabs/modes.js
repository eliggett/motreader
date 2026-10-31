// @ts-check
/**
 * Modes: the mode list as an editable grid, plus an Edit button per row for
 * the single-mode editor. Columns that don't apply to this radio (900 MHz-only
 * options on a VHF radio) are left out. Above the grid: add / duplicate /
 * delete the active mode, trunk removal and undo (each re-packs the codeplug).
 * With Zone Operation off, the per-mode scan settings show as Scan columns.
 */
import { h, fill } from "../dom.js";
import { createGrid } from "../grid.js";
import { editMode } from "../editing.js";
import { openModeEditor } from "../modeeditor.js";
import { MODE_FIELDS, SQUELCH_CHOICES, fieldText, applies, nameRule, isTrunkedMode } from "../../lib/modefields.js";
import { empty, note, NO_DOC } from "./common.js";
import { structureBar, addModeDialog, duplicateMode, deleteModeAsk, removeTrunkingAsk, modeScanDialog, modeScanText, structureBlocked } from "../structure.js";
import { restructureDoc } from "../editing.js";
import { convScans, setModeScan } from "../../lib/structure.js";

/** @typedef {import("../../lib/codeplug.js").Mode} Mode */
/** @typedef {import("../state.js").Document} Document */

/** @type {{ doc: Document, grid: ReturnType<typeof createGrid<Mode>>, el: HTMLElement } | null} */
let cache = null;

/** @param {Document} doc @param {readonly [number, string] | null} [keep]  the active cell to keep */
function build(doc, keep = null) {
    const { cp } = doc;
    const [conv, scans] = convScans(doc);
    const blocked = structureBlocked(doc);
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
        ...(conv ? /** @type {import("../grid.js").Column<Mode>[]} */ ([
            {
                id: "scan", label: "Scan", text: (m) => scans[m.number - 1]?.scan ?? "",
                editor: (m) => (blocked || isTrunkedMode(cp, m) ? null : { type: "select", options: ["Enabled", "Disabled"] }),
            },
            { id: "scan_list", label: "Scan list", cls: "name", text: (m) => modeScanText(scans[m.number - 1]) },
        ]) : []),
    ];
    const grid = createGrid({
        label: "Modes",
        columns,
        rows: () => cp.modes,
        onEdit: (m, key, text) => (key === "scan"
            ? restructureDoc(`Mode ${m.number} scan`, (d) => setModeScan(d, { mode: m.number, scan: text }))
            : editMode(m.number, key, text)),
        rowAction: { label: "Edit", title: "Open this mode in the mode editor", run: (m) => void openModeEditor(m.number) },
        rowClass: (m) => (isTrunkedMode(cp, m) ? "trunked" : ""),
    });
    if (keep) grid.select(Math.min(keep[0], cp.modes.length - 1), keep[1]);
    const active = () => (cp.modes[grid.active()[0]]?.number ?? cp.modes.length);
    const el = h("div", {},
        structureBar(doc, [
            { label: "Add mode…", title: "Insert a mode after the active one", run: () => addModeDialog(active()) },
            { label: "Duplicate", title: "Copy the active mode right after it", run: () => duplicateMode(active()) },
            { label: "Delete", title: "Delete the active mode", run: () => deleteModeAsk(active()) },
            ...(conv ? [{ label: "Scan…", title: "The active mode's scan settings (Zone Operation off)", run: () => modeScanDialog(active()) }] : []),
            ...(doc.trunk.info ? [{ label: "Remove trunking…", title: "Make mode 1 a conventional mode", run: () => removeTrunkingAsk() }] : []),
        ]),
        doc.trunked.length > 1 ? trunkedNote(doc) : null,
        note(`${cp.modes.length} modes. Arrow keys move, Enter or typing edits, Delete clears, Escape cancels; `
            + "Edit opens one mode as a form. Changed cells are highlighted."
            + (cp.band === "vhf" ? " Leave Tx MHz and T/A MHz blank for an RX-only mode (e.g. NOAA weather)." : "")
            + (cp.trunked_mode1 ? " Mode 1 is the trunked mode and isn't editable." : "")
            + (editable ? "" : " This codeplug's 900 MHz mode layout isn't recognised, so modes are read-only.")),
        grid.el);
    return { doc, grid, el };
}

/** The trunked modes, listed by name (trunking is preserved, not decoded or edited). */
function trunkedNote(/** @type {Document} */ doc) {
    const t = doc.trunked;
    return h("div", { class: "block" },
        h("p", { class: "note" }, `${t.length} trunked mode${t.length === 1 ? "" : "s"} (trunking is kept exactly as it is; `
            + "motreader doesn't decode or edit it):"),
        h("p", { class: "trunked-list" }, t.map((m) => `${m.number} ${m.name || "(no name)"}`).join(", ")));
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
        if (!doc.cp.modes.length) {
            return fill(el, doc.trunked.length ? trunkedNote(doc) : empty("No modes were found in this codeplug."));
        }
        if (cache?.doc !== doc) cache = build(doc, cache?.grid.active() ?? null);
        else cache.grid.refresh();
        if (cache.el.parentElement !== el) fill(el, cache.el);
    },
};

/** The grid of the open document's Modes tab (for the test API), if built. */
export const modesGrid = () => cache?.grid ?? null;
