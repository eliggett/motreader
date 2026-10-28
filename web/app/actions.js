// @ts-check
/**
 * The toolbar's commands. Each is also reachable from the test API, and the
 * file-based ones have a bytes-in variant (`loadCodeplug`, `loadIndex`) so
 * tests don't need a file picker.
 */
import { showAboutBox } from "./aboutbox.js";
import { h } from "./dom.js";
import { store } from "./state.js";
import { log } from "./log.js";
import { pickFiles, download } from "./files.js";
import { importTables as importTableFiles, exportTables } from "../lib/tables.js";
import { alertModal, confirmModal } from "./modal.js";
import { openDocument } from "../lib/document.js";
import { isArchive } from "../lib/archive.js";
import { readDbf, findArchiveRecord } from "../lib/dbf.js";
import { exportDialog } from "./exportdialog.js";
import { isDirty } from "./editing.js";

const errText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));
const isDbfName = (/** @type {string} */ name) => /\.dbf$/i.test(name);

/**
 * The last SPECTRAM.DBF loaded this session. It stays loaded: every codeplug
 * opened afterwards (and the one open when it is loaded) is looked up in it.
 * @type {{ fileName: string, records: import("../lib/dbf.js").DbfRecord[] } | null}
 */
let index = null;

/** The loaded DBF index (file name and record count), or null. */
export const loadedIndex = () => index && { fileName: index.fileName, records: index.records.length };

/** Look the open codeplug up in the loaded DBF, if there is one. */
function attachIndex() {
    const doc = store.get();
    if (!doc || !index) return null;
    const record = findArchiveRecord(index.records, doc.fileName, doc.cp.serial);
    const { fileName } = index;
    store.update((d) => (d.index = { fileName, record }), "index");
    if (record) log.info(`${fileName}: ${doc.fileName} is "${record.CUSTOMER}", saved ${record.DATEPGM}`);
    else log.warn(`${fileName}: no entry for ${doc.fileName} (serial ${doc.cp.serial})`);
    return record;
}

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
    if (cp.band === "900?") log.warn("Mode layout not recognized: frequencies are not decoded");
    store.setDocument(doc, "load");
    attachIndex();
    void trunkingNotice(doc);
    return doc;
}

/**
 * Load SPECTRAM.DBF (RSS's archive index, for customer and date). It is kept
 * for the rest of the session and used for this and every later codeplug.
 * Returns the open codeplug's record, or null.
 */
export function loadIndex(/** @type {string} */ fileName, /** @type {Uint8Array} */ bytes) {
    try {
        index = { fileName, records: readDbf(bytes).records };
    } catch (e) {
        log.error(`${fileName}: ${errText(e)}`);
        return null;
    }
    log.info(`${fileName}: ${index.records.filter((r) => !r.__deleted__).length} archives listed; used for every codeplug opened`);
    return attachIndex();
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
    if (a && isDirty() && !(await confirmModal("Discard changes?",
        `${store.get()?.fileName} has changes that haven't been exported. Open ${a.name} anyway?`, "Discard and open"))) return;
    // the DBF first, so the archive opened with it is looked up in it
    const dbf = dbfs[0];
    if (dbf) loadIndex(dbf.name, dbf.bytes);
    if (a) loadCodeplug(a.name, a.bytes);
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
            h("p", {}, "Trunking can be removed on this codeplug (mode 1 becomes a conventional mode): "
                + "use Remove trunking… on the Modes tab.")));
    } else if (doc.trunk.unsupported) {
        log.warn(`This codeplug has trunking motreader can't remove: ${doc.trunk.unsupported}`);
        await alertModal("Trunking", h("div", {},
            h("p", {}, `${doc.fileName} has trunking.`),
            h("p", {}, "motreader will do its best to preserve the trunking data, but can't remove it "
                + "from this codeplug yet:"),
            h("p", { class: "note" }, doc.trunk.unsupported)));
    }
}

/**
 * Import CSV/YAML: modes.csv, phones.csv, mpl.csv and radio.yaml in the CLI's
 * formats (any of them; recognised by header, so renamed copies work).
 */
export async function importTables() {
    const doc = store.get();
    if (!doc) return;
    const picked = await pickFiles(".csv,.yaml,.yml,text/csv", true);
    if (!picked.length) {
        log.debug("Import CSV/YAML cancelled");
        return;
    }
    const files = picked.map((f) => ({ name: f.name, text: new TextDecoder().decode(f.bytes) }));
    await applyTables(files);
}

/** Apply CSV/YAML text files to the open document and show what happened. */
export async function applyTables(/** @type {import("../lib/tables.js").TextFile[]} */ files) {
    const doc = store.get();
    if (!doc) return null;
    if (!doc.support.editable) {
        await alertModal("Import CSV/YAML", `This codeplug is read-only, so nothing can be imported into it: ${doc.support.reasons.join("; ")}.`);
        return null;
    }
    let rep;
    try {
        rep = importTableFiles(doc, files);
    } catch (e) {
        log.error(`Import failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
        await alertModal("Import failed", `The files couldn't be imported: ${errText(e)}`);
        return null;
    }
    // a Zone Operation switch or a scan list type change re-packs: a new document
    if (rep.doc === doc) store.update(() => {}, "edit");
    else store.setDocument(rep.doc, "restructure");
    for (const f of rep.files) log.info(`Import: ${f}`);
    for (const a of rep.applied) log.info(`Import: ${a}`);
    for (const r of rep.refused) log.warn(`Import refused: ${r}`);
    for (const n of rep.notApplied) log.warn(`Import: not applied: ${n}`);
    const list = (/** @type {string[]} */ xs, max = 30) => h("ul", {}, xs.slice(0, max).map((x) => h("li", {}, x)),
        xs.length > max ? h("li", {}, `... and ${xs.length - max} more (all are in the log)`) : null);
    void alertModal("Import CSV/YAML", h("div", { class: "import-report" },
        h("p", {}, `${rep.applied.length} change${rep.applied.length === 1 ? "" : "s"} applied`
            + (rep.applied.length ? " (highlighted in the tabs; nothing is written until you export)." : ": the files match the codeplug.")),
        rep.refused.length ? h("div", { class: "warn-box" }, h("p", {}, `${rep.refused.length} value(s) refused:`), list(rep.refused)) : null,
        rep.notApplied.length ? h("div", {}, h("p", {}, "Not applied (not supported by the web app yet):"), list(rep.notApplied)) : null,
        h("p", { class: "note" }, rep.files.join("; "))));
    return rep;
}

/** Export CSV: modes.csv, phones.csv (and mpl.csv), in the CLI's format. */
export async function exportCsv() {
    const files = await tablesOrAlert();
    for (const f of files?.filter((x) => x.name.endsWith(".csv")) ?? []) download(f.text, f.name, "text/csv");
    if (files) log.info(`Exported ${files.filter((x) => x.name.endsWith(".csv")).map((f) => f.name).join(", ")}`);
}

/** Export YAML: radio.yaml, in the CLI's format. */
export async function exportYaml() {
    const f = (await tablesOrAlert())?.find((x) => x.name === "radio.yaml");
    if (!f) return;
    download(f.text, f.name, "application/yaml");
    log.info("Exported radio.yaml");
}

/** The open document's CSV/YAML, or null after telling the user why not. */
async function tablesOrAlert() {
    const doc = store.get();
    if (!doc) return null;
    try {
        return exportTables(doc);
    } catch (e) {
        log.warn(`Export failed: ${errText(e)}`);
        await alertModal("Export failed", `The codeplug can't be written: ${errText(e)}`);
        return null;
    }
}

export async function exportCodeplug() {
    await exportDialog();
}

/** The About box (an RSS-style screen); its text lives in about.html so it can be edited on its own. */
export async function about() {
    const t = document.createElement("template");
    try {
        const r = await fetch("about.html");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        t.innerHTML = await r.text(); // our own file, not user data
    } catch (e) {
        log.error(`Could not load about.html: ${errText(e)}`);
        t.innerHTML = "<p>About text unavailable.</p>";
    }
    await showAboutBox(t.content);
}

/** "VHF", "900 MHz", ... */
export function bandName(/** @type {string} */ band) {
    return ({ vhf: "VHF", uhf: "UHF", "800": "800 MHz", "900": "900 MHz", "900?": "Mode layout not recognized" })[band] ?? "unknown band";
}
