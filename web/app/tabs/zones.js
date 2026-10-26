// @ts-check
/**
 * Zones: each zone's name and member modes, editable in a grid (members as
 * text like "1-5, 9"), and a summary of its scan list. Above the grid: add /
 * delete a zone, the active zone's scan list, and undo. With Zone Operation
 * off: a button to turn it on.
 */
import { h, fill } from "../dom.js";
import { createGrid } from "../grid.js";
import { editZoneName, editZoneModes } from "../editing.js";
import { formatModeList } from "../../lib/zonefields.js";
import { empty, note, NO_DOC, modesOnlyText } from "./common.js";
import { structureBar, addZoneDialog, deleteZoneAsk, zoneScanDialog, zoneScanText, zoneOperationAsk, structureBlocked } from "../structure.js";
import { zoneScans } from "../../lib/structure.js";

/** @typedef {import("../../lib/codeplug.js").Zone} Zone */
/** @typedef {import("../state.js").Document} Document */

/** @type {{ doc: Document, grid: ReturnType<typeof createGrid<Zone>>, el: HTMLElement } | null} */
let cache = null;

/** @param {Document} doc @param {readonly [number, string] | null} [keep]  the active cell to keep */
function build(doc, keep = null) {
    const { cp } = doc;
    const scans = zoneScans(doc);
    const was = (/** @type {Zone} */ z) => doc.original.zones[z.number - 1];
    const grid = createGrid({
        label: "Zones",
        columns: [
            { id: "number", label: "#", cls: "num", text: (z) => String(z.number) },
            {
                id: "name", label: "Name", cls: "name", text: (z) => z.name,
                editor: (z) => ({ type: "text", maxLength: z.name_enc === "ascii" ? z.name_w : 8, upper: true }),
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
            { id: "scan", label: "Scan list", cls: "name", text: (z) => zoneScanText(scans[z.number - 1]) },
        ],
        rows: () => cp.zones,
        onEdit: (z, key, text) => (key === "name" ? editZoneName(z.number, text) : editZoneModes(z.number, text)),
    });
    if (keep) grid.select(Math.min(keep[0], cp.zones.length - 1), keep[1]);
    const active = () => cp.zones[grid.active()[0]]?.number ?? cp.zones.length;
    const el = h("div", {},
        structureBar(doc, [
            { label: "Add zone…", title: "Insert a zone after the active one", run: () => addZoneDialog(active() + 1) },
            { label: "Delete", title: "Delete the active zone", run: () => deleteZoneAsk(active()) },
            { label: "Scan list…", title: "The active zone's scan list and scan options", run: () => zoneScanDialog(active()) },
        ]),
        note(`${cp.zones.length} zones. Edit a zone's name, or its modes as numbers and ranges (1-5, 9). `
            + "The home zone is set on the Radio-Wide tab."),
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
        if (doc.support.modesOnly) return fill(el, empty(modesOnlyText(doc)));
        if (doc.radioWide.zone_operation === "Disabled") {
            const blocked = structureBlocked(doc);
            return fill(el, h("div", {}, structureBar(doc, []), empty("Zone Operation is off on this radio: it has no zones."),
                h("button", { class: "small", disabled: Boolean(blocked), title: blocked, onclick: () => void zoneOperationAsk(true) },
                    "Turn Zone Operation on…")));
        }
        if (!doc.cp.zones.length) return fill(el, empty("No zones were found in this codeplug."));
        if (cache?.doc !== doc) cache = build(doc, cache?.grid.active() ?? null);
        else cache.grid.refresh();
        if (cache.el.parentElement !== el) fill(el, cache.el);
    },
};
