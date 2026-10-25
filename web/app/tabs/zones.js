// @ts-check
/**
 * Zones: each zone's name and member modes, editable in a grid (members as
 * text like "1-5, 9"). Adding and deleting zones, and scan lists, come with
 * the structural milestone.
 */
import { h, fill } from "../dom.js";
import { createGrid } from "../grid.js";
import { editZoneName, editZoneModes } from "../editing.js";
import { formatModeList } from "../../lib/zonefields.js";
import { empty, note, NO_DOC } from "./common.js";

/** @typedef {import("../../lib/codeplug.js").Zone} Zone */
/** @typedef {import("../state.js").Document} Document */

/** @type {{ doc: Document, grid: ReturnType<typeof createGrid<Zone>>, el: HTMLElement } | null} */
let cache = null;

/** @param {Document} doc */
function build(doc) {
    const { cp } = doc;
    const was = (/** @type {Zone} */ z) => doc.original.zones[z.number - 1];
    const grid = createGrid({
        label: "Zones",
        columns: [
            { id: "number", label: "#", cls: "num", text: (z) => String(z.number) },
            {
                id: "name", label: "Name", cls: "name", text: (z) => z.name,
                editor: (z) => ({ type: "text", maxLength: z.name_enc === "ascii" ? z.name_w : 8 }),
                changed: (z) => z.name !== was(z)?.name,
            },
            {
                id: "home", label: "Home", text: (z) => (z.number === doc.radioWide.home_zone ? "home" : ""),
            },
            {
                id: "modes", label: "Modes", cls: "members-edit", text: (z) => formatModeList(z.modes),
                editor: () => ({ type: "text" }),
                changed: (z) => z.modes.join(" ") !== was(z)?.modes,
            },
            { id: "count", label: "Count", cls: "num", text: (z) => String(z.modes.length) },
            {
                id: "members", label: "Members", cls: "members",
                text: (z) => z.modes.map((n) => `${n} ${cp.modes[n - 1]?.name ?? "?"}`).join(", "),
            },
        ],
        rows: () => cp.zones,
        onEdit: (z, key, text) => (key === "name" ? editZoneName(z.number, text) : editZoneModes(z.number, text)),
    });
    const el = h("div", {},
        note(`${cp.zones.length} zones. Edit a zone's name, or its modes as numbers and ranges (1-5, 9). `
            + "The home zone is set on the Radio-Wide tab. Adding and deleting zones, and scan lists, come later."),
        grid.el);
    return { doc, grid, el };
}

/** @type {import("./common.js").Tab} */
export default {
    id: "zones",
    title: "Zones",
    render(el, doc) {
        if (!doc) {
            cache = null;
            return fill(el, empty(NO_DOC));
        }
        if (doc.radioWide.zone_operation === "Disabled") return fill(el, empty("Zone Operation is off on this radio: it has no zones."));
        if (!doc.cp.zones.length) return fill(el, empty("No zones were found in this codeplug."));
        if (cache?.doc !== doc) cache = build(doc);
        else cache.grid.refresh();
        if (cache.el.parentElement !== el) fill(el, cache.el);
    },
};
