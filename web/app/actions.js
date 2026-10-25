// @ts-check
/**
 * The toolbar's commands. Each is also reachable from the test API, and the
 * file-based ones have a bytes-in variant (`loadCodeplug`, `loadIndex`) so
 * tests don't need a file picker.
 */
import { h } from "./dom.js";
import { store } from "./state.js";
import { log } from "./log.js";
import { pickFiles } from "./files.js";
import { alertModal, openModal } from "./modal.js";
import { openDocument } from "../lib/document.js";
import { isArchive } from "../lib/archive.js";
import { readDbf, findArchiveRecord } from "../lib/dbf.js";

const errText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));
const isDbfName = (/** @type {string} */ name) => /\.dbf$/i.test(name);

/**
 * Open a codeplug archive from bytes, as if the user had picked the file.
 * Returns the document, or null (after telling the user) if it can't be read.
 */
export function loadCodeplug(/** @type {string} */ fileName, /** @type {Uint8Array} */ bytes) {
    log.info(`Importing ${fileName} (${bytes.length} bytes)`);
    let doc;
    try {
        doc = openDocument(fileName, bytes);
    } catch (e) {
        log.error(`${fileName}: ${errText(e)}`);
        void alertModal("Import failed", `${fileName} could not be read: ${errText(e)}`);
        return null;
    }
    const { cp } = doc;
    log.info(`${cp.model || "Unknown model"}, serial ${cp.serial || "?"}, ${bandName(cp.band)}: `
        + `${cp.modes.length} modes, ${cp.zones.length} zones, ${doc.plain.length}-byte codeplug`);
    log.debug(`nonce ${Array.from(doc.plain.subarray(0, 13), (x) => x.toString(16).padStart(2, "0")).join(" ")}; `
        + `name table ${cp.ascii_names ? `ASCII at 0x${cp.ascii_names[0].toString(16)} x ${cp.ascii_names[1]}` : "6-bit at 0x266"}`);
    if (cp.band === "900?") log.warn("900 MHz mode layout not recognised: frequencies are not decoded");
    store.setDocument(doc, "load");
    void trunkingNotice(doc);
    return doc;
}

/** Attach SPECTRAM.DBF (RSS's archive index) to the open codeplug, for customer and date. */
export function loadIndex(/** @type {string} */ fileName, /** @type {Uint8Array} */ bytes) {
    const doc = store.get();
    if (!doc) {
        log.warn(`${fileName}: open the archive first (or pick both together)`);
        return null;
    }
    try {
        const t = readDbf(bytes);
        const record = findArchiveRecord(t.records, doc.fileName, doc.cp.serial);
        store.update((d) => (d.index = { fileName, record }), "index");
        if (record) log.info(`${fileName}: ${doc.fileName} is "${record.CUSTOMER}", saved ${record.DATEPGM}`);
        else log.warn(`${fileName}: no entry for ${doc.fileName} (serial ${doc.cp.serial})`);
        return record;
    } catch (e) {
        log.error(`${fileName}: ${errText(e)}`);
        return null;
    }
}

/** Import Codeplug: an archive, optionally with SPECTRAM.DBF picked alongside. */
export async function importCodeplug() {
    const files = await pickFiles("", true);
    if (!files.length) {
        log.debug("Import cancelled");
        return;
    }
    const archives = files.filter((f) => isArchive(f.bytes));
    const dbfs = files.filter((f) => isDbfName(f.name) && !isArchive(f.bytes));
    const other = files.filter((f) => !archives.includes(f) && !dbfs.includes(f));
    for (const f of other) log.warn(`${f.name}: not a Spectra archive or a DBF index; ignored`);
    if (archives.length > 1) log.warn(`Several archives picked; opening ${archives[0]?.name}`);
    const a = archives[0];
    if (a && !loadCodeplug(a.name, a.bytes)) return;
    const dbf = dbfs[0];
    if (dbf) loadIndex(dbf.name, dbf.bytes);
    if (!a && !dbf && other.length) await alertModal("Import", "Pick a Spectra archive file (A… or B…), optionally with SPECTRAM.DBF.");
}

/** Tell the user, once per import, what will happen to trunking data. */
async function trunkingNotice(/** @type {import("./state.js").Document} */ doc) {
    if (doc.trunk.info) {
        log.warn("This codeplug has trunking (mode 1 is trunked); its data is preserved");
        await alertModal("Trunking", h("div", {},
            h("p", {}, `${doc.fileName} has trunking: mode 1 is a trunked mode `
                + `(max systems ${doc.trunk.info.systems}, max subfleets ${doc.trunk.info.subfleets}).`),
            h("p", {}, "motreader keeps the trunking data exactly as it is. It doesn't edit trunking."),
            h("p", {}, "Removing trunking (turning mode 1 into a conventional mode) is possible on this "
                + "codeplug and will be offered here in a later version.")));
    } else if (doc.trunk.unsupported) {
        log.warn(`This codeplug has trunking motreader can't remove: ${doc.trunk.unsupported}`);
        await alertModal("Trunking", h("div", {},
            h("p", {}, `${doc.fileName} has trunking.`),
            h("p", {}, "motreader will do its best to preserve the trunking data, but can't remove it "
                + "from this codeplug yet:"),
            h("p", { class: "note" }, doc.trunk.unsupported)));
    }
}

export async function importTables() {
    await notYet("Import CSV/YAML");
}

export async function exportCodeplug() {
    await notYet("Export codeplug");
}

export async function exportYaml() {
    await notYet("Export YAML");
}

export async function exportCsv() {
    await notYet("Export CSV");
}

/** The About dialog; its text lives in about.html so it can be edited on its own. */
export async function about() {
    let body;
    try {
        const r = await fetch("about.html");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = document.createElement("template");
        t.innerHTML = await r.text(); // our own file, not user data
        body = t.content;
    } catch (e) {
        log.error(`Could not load about.html: ${errText(e)}`);
        body = "About text unavailable.";
    }
    await openModal({ title: "About motreader", body });
}

async function notYet(/** @type {string} */ what) {
    log.warn(`${what}: not available yet`);
    await alertModal(what, `${what} arrives in a later milestone.`);
}

/** "VHF", "900 MHz", ... */
export function bandName(/** @type {string} */ band) {
    return ({ vhf: "VHF", "900": "900 MHz", "900?": "900 MHz (layout not recognised)" })[band] ?? "unknown band";
}
