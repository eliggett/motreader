// @ts-check
/**
 * Structural changes to an open document, as the app offers them: each
 * checks what it's given (names, mode lists, priorities) the way an edit is
 * checked, then re-packs the codeplug with the ported Python operation
 * (restructure in document.js). Each returns the new document, or throws
 * InvalidValue with the reason.
 */
import { restructure } from "./document.js";
import { addMode, deleteMode, defaultModeName } from "./modeops.js";
import { addZone, deleteZone, defaultZoneName } from "./zonelist.js";
import { zonesOn, zonesOff } from "./zoneop.js";
import { removeTrunking } from "./trunking.js";
import * as convscan from "./convscan.js";
import * as scanlist from "./scanlist.js";
import { zoneOperation } from "./codeplug.js";
import { nameRule } from "./modefields.js";
import { parseModeList, formatModeList } from "./zonefields.js";
import { InvalidValue } from "./errors.js";

export { defaultModeName, defaultZoneName };

/** @typedef {import("./document.js").CodeplugDocument} CodeplugDocument */
/** @typedef {number | "SELMOD" | null} Priority */

/** Zones holding mode `n`. */
export const zonesOf = (/** @type {CodeplugDocument} */ doc, /** @type {number} */ n) =>
    doc.cp.zones.filter((z) => z.modes.includes(n)).map((z) => z.number);

/** Is Zone Operation on? (null: not found) */
export const zonesOnIn = (/** @type {CodeplugDocument} */ doc) => zoneOperation(doc.plain);

/** A name as stored, checked like an edit (upper case; the head's width and characters). */
function checkedName(/** @type {CodeplugDocument} */ doc, /** @type {string} */ text, /** @type {number} */ width) {
    return nameRule(doc.cp, width).check(text);
}

/**
 * Add a mode after mode `after` (0 = first): a copy of mode `copyFrom`, named
 * `name` (default RSS's "MODE  nn"), in `zones` (needed with Zone Operation on).
 * @param {CodeplugDocument} doc
 * @param {{ after: number, copyFrom?: number | null, name?: string | null, zones?: number[] }} o
 */
export function addModeTo(doc, { after, copyFrom = null, name = null, zones = [] }) {
    const a9 = doc.cp.ascii_names !== null;
    const stored = name === null || name.trim() === "" ? defaultModeName(after + 1, a9) : checkedName(doc, name, a9 ? /** @type {[number, number]} */ (doc.cp.ascii_names)[1] : 8);
    return restructure(doc, `added mode ${after + 1} "${stored.trim()}"`, (b) => addMode(b, after, { copyFrom, name: stored, zones }));
}

/** Duplicate mode `n` right after it (same name, same zones). */
export function duplicateModeIn(/** @type {CodeplugDocument} */ doc, /** @type {number} */ n) {
    const m = doc.cp.modes[n - 1];
    if (!m) throw new InvalidValue(`no mode ${n}`);
    return restructure(doc, `duplicated mode ${n} as mode ${n + 1}`,
        (b) => addMode(b, n, { copyFrom: n, name: m.name, zones: zonesOf(doc, n) }));
}

/** Delete mode `n` (later modes renumber; zones and the home mode follow). */
export function deleteModeIn(/** @type {CodeplugDocument} */ doc, /** @type {number} */ n) {
    const m = doc.cp.modes[n - 1];
    return restructure(doc, `deleted mode ${n}${m ? ` "${m.name}"` : ""}`, (b) => deleteMode(b, n));
}

/**
 * Add a zone at `position` holding the modes in `modesText` ("1-5, 9").
 * @param {CodeplugDocument} doc @param {{ position: number, name?: string | null, modesText: string }} o
 */
export function addZoneTo(doc, { position, name = null, modesText }) {
    const modes = parseModeList(modesText);
    const width = doc.cp.ascii_names ? doc.cp.ascii_names[1] : 8;
    const stored = name === null || name.trim() === "" ? defaultZoneName(position) : checkedName(doc, name, width);
    return restructure(doc, `added zone ${position} "${stored.trim()}" (modes ${formatModeList(modes)})`,
        (b) => addZone(b, position, modes, stored));
}

/** Delete zone `n` (later zones renumber; the home zone follows). */
export function deleteZoneIn(/** @type {CodeplugDocument} */ doc, /** @type {number} */ n) {
    const z = doc.cp.zones[n - 1];
    return restructure(doc, `deleted zone ${n}${z ? ` "${z.name}"` : ""}`, (b) => deleteZone(b, n));
}

/** Turn Zone Operation on (one zone with every mode) or off (all zones are lost). */
export function setZoneOperationIn(/** @type {CodeplugDocument} */ doc, /** @type {boolean} */ on) {
    return restructure(doc, `Zone Operation ${on ? "on" : "off"}`, (b) => (on ? zonesOn(b) : zonesOff(b)));
}

/** Remove trunking: the trunked mode 1 becomes a conventional mode (a copy of mode 2). */
export function removeTrunkingIn(/** @type {CodeplugDocument} */ doc) {
    return restructure(doc, "removed trunking (mode 1 is now a copy of mode 2)", removeTrunking);
}

/** "3" -> 3, "SELMOD" / "<SELMOD>" -> "SELMOD", "" -> null; anything else throws. @returns {Priority} */
export function parsePriority(/** @type {string} */ text) {
    const t = text.trim();
    if (!t || /^(none|-+)$/i.test(t)) return null;
    if (/^<?selmod>?$/i.test(t)) return "SELMOD";
    if (/^\d+$/.test(t)) return Number(t);
    throw new InvalidValue(`"${text}" is not a mode number, SELMOD or empty`);
}

/** A priority as shown: "", "SELMOD", "12". */
export const priorityText = (/** @type {Priority} */ p) => (p === null ? "" : String(p));

// ---------------------------------------------------------------------------
// Scan (zones on: per zone; zones off: per mode and the CONVENTIONAL lists)

/** The zones' scan lists and options (Zone Operation on), from the document's codeplug. */
export const zoneScans = (/** @type {CodeplugDocument} */ doc) => scanlist.decode(doc.plain);

/** The zones-off scan settings: [ConvScan, ModeScan rows], or [null, []] with zones on. */
export const convScans = (/** @type {CodeplugDocument} */ doc) => {
    try {
        return convscan.decode(doc.plain);
    } catch (e) {
        if (e instanceof InvalidValue) return /** @type {[null, []]} */ ([null, []]);
        throw e;
    }
};

/** A zone scan list's members as RSS counts them ("List = n of 16 Max"). */
export const zoneScanCount = scanlist.memberCount;

/** Set zone `row.zone`'s scan list and options. @param {CodeplugDocument} doc @param {scanlist.ZoneScan} row */
export function setZoneScan(doc, row) {
    return restructure(doc, `zone ${row.zone} scan list`, (b) => scanlist.encode(b, [row]));
}

/** Set a mode's zones-off scan settings / Mode Slave list. @param {CodeplugDocument} doc @param {Partial<convscan.ModeScan> & { mode: number }} row */
export function setModeScan(doc, row) {
    const [, rows] = convScans(doc);
    const cur = rows[row.mode - 1];
    if (!cur) throw new InvalidValue("zones-off scan settings aren't available on this codeplug");
    return restructure(doc, `mode ${row.mode} scan`, (b) => convscan.encode(b, null, [{ ...cur, ...row }]));
}

/**
 * Set the CONVENTIONAL scan: list types and SCAN TYPE (these re-pack the mode
 * records), then the radio-wide (Op Select) list.
 * @param {CodeplugDocument} doc @param {Partial<convscan.ConvScan>} want
 */
export function setConvScan(doc, want) {
    const [cur] = convScans(doc);
    if (!cur) throw new InvalidValue("zones-off scan settings aren't available on this codeplug");
    return restructure(doc, "conventional scan", (b) => {
        const nl = want.non_priority_list ?? cur.non_priority_list;
        const pl = want.priority_list ?? cur.priority_list;
        const st = want.scan_type ?? cur.scan_type;
        // as the CLI import does: Talkgroup -> Pri Tlkgr first, then list types, then scan type
        if (cur.scan_type === "Talkgroup" && st !== "Talkgroup") b = convscan.setScanType(b, st);
        b = convscan.setListTypes(b, nl, pl);
        b = convscan.setScanType(b, st);
        const [now] = /** @type {[convscan.ConvScan, unknown]} */ (convscan.decode(b));
        const list = {
            ...now,
            ...(want.priority_1 !== undefined ? { priority_1: want.priority_1 } : {}),
            ...(want.priority_2 !== undefined ? { priority_2: want.priority_2 } : {}),
            ...(want.modes !== undefined ? { modes: want.modes } : {}),
        };
        return convscan.encode(b, list, []);
    });
}

/** The document before the last structural change, or throws. */
export function undoLast(/** @type {CodeplugDocument} */ doc) {
    if (!doc.previous) throw new InvalidValue("there is no structural change to undo");
    return doc.previous;
}
