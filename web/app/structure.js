// @ts-check
/**
 * The structural commands' dialogs and toolbars: add / duplicate / delete a
 * mode, add / delete a zone, a zone's scan list, the zones-off scan
 * settings, Zone Operation, trunk removal, and undo. Each change re-packs the
 * codeplug through editing.restructureDoc (lib/structure.js does the work).
 */
import { h, upperCaseAsTyped } from "./dom.js";
import { openModal, confirmModal, alertModal } from "./modal.js";
import { store } from "./state.js";
import { restructureDoc, undoRestructure } from "./editing.js";
import * as S from "../lib/structure.js";
import { SCAN_TYPES, FLAGS as ZONE_FLAGS, MAX_MEMBERS } from "../lib/scanlist.js";
import { FLAGS as MODE_FLAGS, LIST_TYPES } from "../lib/convscan.js";
import { nameRule } from "../lib/modefields.js";
import { formatModeList, parseModeList } from "../lib/zonefields.js";
import { changes } from "../lib/document.js";

/** @typedef {import("./state.js").Document} Document */

const errText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

/** Why structural changes aren't available on `doc`, or "". */
export function structureBlocked(/** @type {Document} */ doc) {
    if (!doc.support.editable) return "this codeplug is read-only";
    if (doc.support.modesOnly) return `adding and deleting aren't supported in format version ${doc.support.version} yet`;
    return "";
}

/** A labelled form row: [label, input, message]. */
function row(/** @type {string} */ label, /** @type {HTMLElement} */ input, /** @type {string} */ id, /** @type {string} */ hint = "") {
    input.id = id;
    return h("div", { class: "form-row" }, h("label", { for: id }, label), input, h("span", { class: "field-msg" }, hint));
}

const textInput = (/** @type {string} */ value, /** @type {Record<string, any>} */ attrs = {}) =>
    h("input", { type: "text", value, spellcheck: "false", ...attrs });

/** @param {readonly string[]} options @param {string} value @param {Record<string, string>} [labels] */
const select = (options, value, labels = {}) =>
    h("select", {}, (options.includes(value) ? options : [value, ...options]).map((o) => h("option", { value: o, selected: o === value }, labels[o] ?? o)));

/**
 * A form dialog that runs `apply` on OK; a refusal shows in the dialog and
 * keeps it open.
 * @param {string} title @param {Node} form @param {string} okLabel @param {() => { error?: string }} apply
 */
async function formDialog(title, form, okLabel, apply) {
    const msg = h("p", { class: "field-msg error", role: "alert" });
    await openModal({
        title,
        body: h("div", { class: "struct-form" }, form, msg),
        buttons: [{ label: "Cancel", value: "cancel" }, { label: okLabel, value: "ok", primary: true }],
        onButton(value) {
            if (value !== "ok") return true;
            let res;
            try {
                res = apply();
            } catch (e) {
                res = { error: errText(e) };
            }
            msg.textContent = res.error ?? "";
            return !res.error;
        },
    });
}

/** Run a structural change from a button, reporting a refusal in an alert. */
async function act(/** @type {string} */ what, /** @type {(d: Document) => Document} */ fn) {
    const res = restructureDoc(what, fn);
    if (res.error) await alertModal(what, res.error);
    return res;
}

// ---------------------------------------------------------------------------
// Modes

/** Add a mode after mode `after` (default: the active one). */
export async function addModeDialog(/** @type {number} */ after) {
    const doc = store.get();
    if (!doc) return;
    const n = doc.cp.modes.length;
    const zoned = S.zonesOnIn(doc) === true;
    const width = nameRule(doc.cp).width;
    const afterIn = textInput(String(after), { inputmode: "numeric", size: 4 });
    const copyIn = textInput(String(after >= 1 ? after : 1), { inputmode: "numeric", size: 4 });
    const nameIn = textInput("", { maxlength: width, placeholder: S.defaultModeName(after + 1, doc.cp.ascii_names !== null).trim(), size: width + 2 });
    upperCaseAsTyped(nameIn);
    const zoneBoxes = doc.cp.zones.map((z) => h("label", { class: "check" },
        h("input", { type: "checkbox", value: String(z.number), checked: S.zonesOf(doc, Number(copyIn.value)).includes(z.number) }),
        ` ${z.number} ${z.name}`));
    const form = h("div", { class: "form" },
        row("Insert after mode", afterIn, "am-after", `0 = before mode 1; 1–${n}`),
        row("Copy settings of mode", copyIn, "am-copy", `1–${n}: frequencies, tones and options (edit them afterwards)`),
        row("Name", nameIn, "am-name", `empty: RSS's default name; up to ${width} characters`),
        zoned ? h("div", { class: "form-row" }, h("span", { class: "label" }, "Zones"),
            h("div", { class: "checks" }, zoneBoxes), h("span", { class: "field-msg" }, "Zone Operation is on: the mode must be in a zone")) : null,
        h("p", { class: "note" }, "Later modes renumber, as in RSS; zones, scan lists and the home mode follow."));
    await formDialog("Add mode", form, "Add", () => {
        const a = Number(afterIn.value);
        const c = Number(copyIn.value);
        if (!Number.isInteger(a) || !Number.isInteger(c)) return { error: "mode numbers are whole numbers" };
        const zones = zoneBoxes.map((l) => /** @type {HTMLInputElement} */ (l.querySelector("input"))).filter((i) => i.checked).map((i) => Number(i.value));
        return restructureDoc("Add mode", (d) => S.addModeTo(d, { after: a, copyFrom: c, name: nameIn.value, zones }));
    });
}

/** Duplicate mode `n` right after it. */
export const duplicateMode = (/** @type {number} */ n) => act(`Duplicate mode ${n}`, (d) => S.duplicateModeIn(d, n));

/** Delete mode `n`, after confirming. */
export async function deleteModeAsk(/** @type {number} */ n) {
    const m = store.get()?.cp.modes[n - 1];
    if (!m) return;
    if (!(await confirmModal("Delete mode", `Delete mode ${n} "${m.name}"? Later modes renumber, and zones, scan lists `
        + "and the home mode follow (Undo puts it back).", "Delete"))) return;
    await act(`Delete mode ${n}`, (d) => S.deleteModeIn(d, n));
}

/** The undo button's label for `doc`, or null. */
export const undoLabel = (/** @type {Document} */ doc) => (doc.previous ? `Undo: ${doc.ops[doc.ops.length - 1]}` : null);

/** Undo the last structural change, after confirming if edits were made since. */
export async function undoAsk() {
    const doc = store.get();
    if (!doc?.previous) return;
    const ch = changes(doc);
    const since = ch.modes.length + ch.zones.length + ch.radioWide.length + ch.phones.length + ch.mpls.length;
    if (since && !(await confirmModal("Undo", `Undo "${doc.ops[doc.ops.length - 1]}"? The ${since} edit${since === 1 ? "" : "s"} `
        + "made since then are dropped too.", "Undo"))) return;
    const res = undoRestructure();
    if (res.error) await alertModal("Undo", res.error);
}

/**
 * The bar of structural buttons above a grid.
 * @param {Document} doc
 * @param {{ label: string, title?: string, run: () => unknown, needs?: boolean }[]} buttons  needs: a structural change (disabled when blocked)
 */
export function structureBar(doc, buttons) {
    const blocked = structureBlocked(doc);
    const undo = undoLabel(doc);
    return h("div", { class: "struct-bar" },
        buttons.map((b) => h("button", {
            class: "small", disabled: Boolean(b.needs !== false && blocked), title: blocked && b.needs !== false ? blocked : b.title ?? "",
            onclick: () => void b.run(),
        }, b.label)),
        undo ? h("button", { class: "small", title: "Put back the codeplug as it was before this change (edits made since are dropped)", onclick: () => void undoAsk() }, undo) : null);
}

// ---------------------------------------------------------------------------
// Zones

/** Add a zone at `position`. */
export async function addZoneDialog(/** @type {number} */ position) {
    const doc = store.get();
    if (!doc) return;
    const nz = doc.cp.zones.length;
    const width = doc.cp.ascii_names ? doc.cp.ascii_names[1] : 8;
    const posIn = textInput(String(position), { inputmode: "numeric", size: 4 });
    const nameIn = textInput("", { maxlength: width, placeholder: S.defaultZoneName(position), size: width + 2 });
    upperCaseAsTyped(nameIn);
    const modesIn = textInput("", { placeholder: "1-5, 9", size: 24 });
    const form = h("div", { class: "form" },
        row("Position", posIn, "az-pos", `1–${nz + 1}; later zones renumber`),
        row("Name", nameIn, "az-name", `empty: RSS's default name; up to ${width} characters`),
        row("Modes", modesIn, "az-modes", "at least one (RSS drops empty zones)"),
        h("p", { class: "note" }, "The new zone's scan list starts empty (Talkgroup scan, RSS's default for a new zone)."));
    await formDialog("Add zone", form, "Add", () => {
        const p = Number(posIn.value);
        if (!Number.isInteger(p)) return { error: "the position is a whole number" };
        return restructureDoc("Add zone", (d) => S.addZoneTo(d, { position: p, name: nameIn.value, modesText: modesIn.value }));
    });
}

/** Delete zone `n`, after confirming. */
export async function deleteZoneAsk(/** @type {number} */ n) {
    const z = store.get()?.cp.zones[n - 1];
    if (!z) return;
    if (!(await confirmModal("Delete zone", `Delete zone ${n} "${z.name}"? Later zones renumber and the home zone follows `
        + "(Undo puts it back).", "Delete"))) return;
    await act(`Delete zone ${n}`, (d) => S.deleteZoneIn(d, n));
}

/** A one-line summary of a zone's scan list. */
export function zoneScanText(/** @type {import("../lib/scanlist.js").ZoneScan | undefined} */ sc) {
    if (!sc) return "";
    if (sc.scan_type === "Disabled") return "off";
    const pri = [sc.priority_1, sc.priority_2].map((p, i) => (p === null ? "" : `P${i + 1} ${p}`)).filter(Boolean);
    return [sc.scan_type, ...pri, sc.modes.length ? formatModeList(sc.modes) : ""].filter(Boolean).join("; ")
        + ` (${S.zoneScanCount(sc)} of ${MAX_MEMBERS})`;
}

/** Edit zone `n`'s scan list and ZONE SCAN OPTIONS. */
export async function zoneScanDialog(/** @type {number} */ n) {
    const doc = store.get();
    if (!doc) return;
    const sc = S.zoneScans(doc)[n - 1];
    if (!sc) {
        await alertModal("Scan list", "This zone's scan list wasn't found.");
        return;
    }
    const typeIn = select(Object.values(SCAN_TYPES), sc.scan_type);
    const flagIns = ZONE_FLAGS.map(([name, , on, off]) => [name, select([on, off], String(sc[name]))]);
    const p1 = textInput(S.priorityText(sc.priority_1), { size: 8, placeholder: "none" });
    const p2 = textInput(S.priorityText(sc.priority_2), { size: 8, placeholder: "none" });
    const membersIn = textInput(formatModeList(sc.modes), { size: 28 });
    const labels = /** @type {Record<string, string>} */ ({
        talkback_scan: "Talkback scan", scan_button_control: "Scan button control", coded_squelch_scan: "Coded squelch scan",
        non_priority_list: "Non-priority list", priority_list: "Priority list",
    });
    const form = h("div", { class: "form" },
        row("Scan type", typeIn, "zs-type"),
        flagIns.map(([name, input]) => row(labels[/** @type {string} */ (name)] ?? String(name), /** @type {HTMLElement} */ (input), `zs-${name}`)),
        row("Priority 1", p1, "zs-p1", "a mode number, SELMOD (the selected mode) or empty; needs scan type Pri Tlkgr"),
        row("Priority 2", p2, "zs-p2"),
        row("Other members", membersIn, "zs-modes", `mode numbers and ranges; <SELMOD> is always on the list; ${MAX_MEMBERS} at most in all`));
    await formDialog(`Zone ${n} scan list`, form, "OK", () => {
        /** @type {import("../lib/scanlist.js").ZoneScan} */
        const want = {
            ...sc, scan_type: typeIn.value,
            priority_1: S.parsePriority(p1.value), priority_2: S.parsePriority(p2.value), modes: parseModeList(membersIn.value),
        };
        for (const [name, input] of flagIns) /** @type {any} */ (want)[/** @type {string} */ (name)] = /** @type {HTMLSelectElement} */ (input).value;
        return restructureDoc(`Zone ${n} scan list`, (d) => S.setZoneScan(d, want));
    });
}

// ---------------------------------------------------------------------------
// Zones-off scan (per mode, and the CONVENTIONAL screen's lists)

/** A one-line summary of a mode's zones-off scan list (Mode Slave), or "". */
export function modeScanText(/** @type {import("../lib/convscan.js").ModeScan | undefined} */ r) {
    if (!r) return "";
    const pri = [r.priority_1, r.priority_2].map((p, i) => (p === null ? "" : `P${i + 1} ${p}`)).filter(Boolean);
    return [...pri, r.modes?.length ? formatModeList(r.modes) : ""].filter(Boolean).join("; ");
}

/** Edit mode `n`'s zones-off scan settings (and its Mode Slave list). */
export async function modeScanDialog(/** @type {number} */ n) {
    const doc = store.get();
    if (!doc) return;
    const [conv, rows] = S.convScans(doc);
    const r = rows[n - 1];
    if (!conv || !r) {
        await alertModal("Scan", "Zones-off scan settings aren't available on this codeplug.");
        return;
    }
    const labels = /** @type {Record<string, string>} */ ({
        scan: "Scan", scan_button_control: "Scan button control", coded_squelch_scan: "Coded squelch scan", talkback_scan: "Talkback scan",
    });
    const flagIns = MODE_FLAGS.map(([name, , on, off]) => [name, select([on, off], String(r[name]))]);
    const priSlave = conv.priority_list === "Mode Slave";
    const npSlave = conv.non_priority_list === "Mode Slave";
    const p1 = textInput(S.priorityText(r.priority_1), { size: 8, placeholder: "none" });
    const p2 = textInput(S.priorityText(r.priority_2), { size: 8, placeholder: "none" });
    const membersIn = textInput(formatModeList(r.modes ?? []), { size: 28 });
    const form = h("div", { class: "form" },
        flagIns.map(([name, input]) => row(labels[/** @type {string} */ (name)] ?? String(name), /** @type {HTMLElement} */ (input), `ms-${name}`)),
        priSlave ? [row("Priority 1", p1, "ms-p1", "a mode number or empty (Mode Slave list)"), row("Priority 2", p2, "ms-p2")] : null,
        npSlave ? row("List members", membersIn, "ms-modes", "this mode's own list (it is always on it)") : null,
        !priSlave || !npSlave ? h("p", { class: "note" }, "Op Select lists are shared by every mode: edit them on the Conventional tab.") : null);
    await formDialog(`Mode ${n} scan`, form, "OK", () => {
        /** @type {Partial<import("../lib/convscan.js").ModeScan> & { mode: number }} */
        const want = { mode: n };
        for (const [name, input] of flagIns) /** @type {any} */ (want)[/** @type {string} */ (name)] = /** @type {HTMLSelectElement} */ (input).value;
        if (priSlave) [want.priority_1, want.priority_2] = [S.parsePriority(p1.value), S.parsePriority(p2.value)];
        if (npSlave) want.modes = parseModeList(membersIn.value);
        return restructureDoc(`Mode ${n} scan`, (d) => S.setModeScan(d, want));
    });
}

/** Edit the CONVENTIONAL scan settings: list types, SCAN TYPE and the radio-wide (Op Select) list. */
export async function convScanDialog() {
    const doc = store.get();
    if (!doc) return;
    const [conv] = S.convScans(doc);
    if (!conv) {
        await alertModal("Conventional scan", "Zones-off scan settings aren't available on this codeplug.");
        return;
    }
    const typeOpts = doc.cp.band === "900" && conv.scan_type !== "Disabled" ? ["Pri Tlkgr", "Talkgroup"] : [conv.scan_type];
    const typeIn = select(typeOpts, conv.scan_type);
    const npIn = select(LIST_TYPES, conv.non_priority_list);
    const pIn = select(LIST_TYPES, conv.priority_list);
    const p1 = textInput(S.priorityText(conv.priority_1), { size: 8, placeholder: "none" });
    const p2 = textInput(S.priorityText(conv.priority_2), { size: 8, placeholder: "none" });
    const membersIn = textInput(formatModeList(conv.modes ?? []), { size: 28 });
    const form = h("div", { class: "form" },
        row("Scan type", typeIn, "cs-type", typeOpts.length > 1 ? "" : "follows the modes' Scan setting"),
        row("Non-priority list", npIn, "cs-np", "Mode Slave: a list per mode (changing it re-packs the codeplug)"),
        row("Priority list", pIn, "cs-p"),
        h("p", { class: "note" }, "The radio-wide list (used where a list is Op Select):"),
        row("Priority 1", p1, "cs-p1", "a mode number, SELMOD or empty"),
        row("Priority 2", p2, "cs-p2"),
        row("Members", membersIn, "cs-modes", `mode numbers and ranges; <SELMOD> is always on it; ${MAX_MEMBERS} at most`));
    await formDialog("Conventional scan", form, "OK", () => {
        const opSel = npIn.value === "Op Select";
        const priOp = pIn.value === "Op Select";
        return restructureDoc("Conventional scan", (d) => S.setConvScan(d, {
            scan_type: typeIn.value, non_priority_list: npIn.value, priority_list: pIn.value,
            ...(priOp ? { priority_1: S.parsePriority(p1.value), priority_2: S.parsePriority(p2.value) } : {}),
            ...(opSel ? { modes: parseModeList(membersIn.value) } : {}),
        }));
    });
}

/** The CONVENTIONAL scan summary and its Edit button (Conventional tab, zones off). */
export function convScanSection(/** @type {Document} */ doc) {
    const [conv] = S.convScans(doc);
    if (!conv) return null;
    const blocked = structureBlocked(doc);
    const list = [conv.priority_1, conv.priority_2].map((p, i) => (p === null ? "" : `P${i + 1} ${p}`)).filter(Boolean);
    return h("section", { class: "block" }, h("h3", {}, "Conventional Scan"),
        h("table", { class: "info" }, h("tbody", {},
            [["Scan type", conv.scan_type], ["Non-priority list", conv.non_priority_list], ["Priority list", conv.priority_list],
                ["Radio-wide list", [...list, conv.modes?.length ? formatModeList(conv.modes) : ""].filter(Boolean).join("; ") || "(only <SELMOD>)"]]
                .map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v), h("td", { class: "row-note" }, ""))))),
        h("p", { class: "note" }, "Each mode's own scan settings and Mode Slave list are on the Modes tab (Scan column)."),
        h("button", { class: "small", disabled: Boolean(blocked), title: blocked, onclick: () => void convScanDialog() }, "Edit conventional scan…"));
}

// ---------------------------------------------------------------------------
// Zone Operation and trunking

/** Switch Zone Operation, after explaining what happens. */
export async function zoneOperationAsk(/** @type {boolean} */ on) {
    const text = on
        ? "Turning Zone Operation on re-packs the codeplug the way RSS does: one zone, \"ZONE  01\", holding every mode, "
            + "becomes the home zone. The zones-off scan settings (per-mode lists) are dropped."
        : "Turning Zone Operation off re-packs the codeplug the way RSS does: all zones and their scan lists are deleted.";
    if (!(await confirmModal(`Zone Operation ${on ? "on" : "off"}`, `${text} Undo puts it back.`, on ? "Turn on" : "Turn off"))) return;
    await act(`Zone Operation ${on ? "on" : "off"}`, (d) => S.setZoneOperationIn(d, on));
}

/** Remove trunking, after explaining what happens. */
export async function removeTrunkingAsk() {
    if (!(await confirmModal("Remove trunking", h("div", {},
        h("p", {}, "Mode 1, the trunked mode, becomes a conventional mode: a copy of mode 2 (edit it afterwards). "
            + "The trunking data is removed, as RSS stores a radio whose trunking was removed; no other mode, zone or "
            + "scan list renumbers, so you gain a channel."),
        h("p", {}, "Undo puts it back.")), "Remove trunking"))) return;
    await act("Remove trunking", (d) => S.removeTrunkingIn(d));
}
