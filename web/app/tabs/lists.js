// @ts-check
/**
 * The Phone List and MPL List grids (on the Conventional tab). The grids are
 * kept per document, so redraws after an edit keep the active cell.
 */
import { h } from "../dom.js";
import { createGrid } from "../grid.js";
import { editPhone, editMpl } from "../editing.js";
import { MPL_SQUELCH_CHOICES, mplSquelchText } from "../../lib/listfields.js";
import { note, section } from "./common.js";

/** @typedef {import("../state.js").Document} Document */
/** @typedef {import("../../lib/lists.js").Phone} Phone */
/** @typedef {import("../../lib/lists.js").Mpl} Mpl */

/** @type {{ doc: Document, sections: HTMLElement[], grids: { refresh: () => void }[] } | null} */
let cache = null;

/** @param {Document} doc */
function build(doc) {
    const width = doc.cp.ascii_names ? doc.cp.ascii_names[1] : 8;
    const wasPhone = (/** @type {Phone} */ p) => JSON.parse(doc.original.phones[p.number - 1] ?? "{}");
    const wasMpl = (/** @type {Mpl} */ m) => JSON.parse(doc.original.mpls[m.number - 1] ?? "{}");
    const phones = createGrid({
        label: "Phone list",
        columns: [
            { id: "number", label: "#", cls: "num", text: (p) => String(p.number) },
            {
                id: "name", label: "Name", cls: "name", text: (p) => p.name,
                editor: () => ({ type: "text", maxLength: width, upper: true }), changed: (p) => p.name !== wasPhone(p).name,
            },
            {
                id: "dial", label: "Number", cls: "name", text: (p) => p.dial,
                editor: () => ({ type: "text", maxLength: 16, upper: true }), changed: (p) => p.dial !== wasPhone(p).dial,
            },
        ],
        rows: () => doc.phones,
        onEdit: (p, key, text) => editPhone(p.number, /** @type {"name" | "dial"} */ (key), text),
    });
    const sections = [section("Phone List",
        note("Numbers: up to 16 of 0-9 * # and P (pause)."), phones.el)];
    const grids = [phones];
    if (doc.mpls.length) {
        const slot = (/** @type {"rx" | "tx" | "ta"} */ s, /** @type {string} */ label) => /** @type {import("../grid.js").Column<Mpl>} */ ({
            id: s, label, text: (m) => mplSquelchText(m, s),
            editor: () => ({ type: "select", options: MPL_SQUELCH_CHOICES }),
            changed: (m) => mplSquelchText(m, s) !== mplSquelchText(wasMpl(m), s),
        });
        const mpls = createGrid({
            label: "MPL list",
            columns: [
                { id: "number", label: "#", cls: "num", text: (m) => String(m.number) },
                {
                    id: "name", label: "Name", cls: "name", text: (m) => m.name,
                    editor: () => ({ type: "text", maxLength: width, upper: true }), changed: (m) => m.name !== wasMpl(m).name,
                },
                slot("rx", "Rx"), slot("tx", "Tx"), slot("ta", "T/A"),
            ],
            rows: () => doc.mpls,
            onEdit: (m, key, text) => editMpl(m.number, key, text),
        });
        sections.push(section("MPL List", mpls.el));
        grids.push(mpls);
    } else {
        sections.push(section("MPL List", note(doc.listProblem
            ? `The MPL list couldn't be read: ${doc.listProblem}`
            : "MPL is disabled on this radio (Number of MPL = 0); RSS can enable it.")));
    }
    return { doc, sections, grids };
}

/** The list sections for `doc` (built once per document, refreshed after). */
export function listSections(/** @type {Document} */ doc) {
    if (cache?.doc !== doc) cache = build(doc);
    else for (const g of cache.grids) g.refresh();
    return cache.sections;
}
