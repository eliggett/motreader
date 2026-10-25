// @ts-check
/**
 * The toolbar's commands. Each is also reachable from the test API, and the
 * file-based ones have a bytes-in variant (`loadCodeplug`) so tests don't need
 * a file picker.
 */
import { store } from "./state.js";
import { log } from "./log.js";
import { pickFile } from "./files.js";
import { alertModal, openModal } from "./modal.js";

/** Open a codeplug archive from bytes, as if the user had picked the file. */
export function loadCodeplug(/** @type {string} */ fileName, /** @type {Uint8Array} */ bytes) {
    log.info(`Importing ${fileName} (${bytes.length} bytes)`);
    store.setDocument({ fileName, raw: bytes }, "load");
    log.debug("Decoding is not ported yet; showing the raw file");
}

export async function importCodeplug() {
    const f = await pickFile();
    if (!f) {
        log.debug("Import cancelled");
        return;
    }
    loadCodeplug(f.name, f.bytes);
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
        log.error(`Could not load about.html: ${e instanceof Error ? e.message : e}`);
        body = "About text unavailable.";
    }
    await openModal({ title: "About motreader", body });
}

async function notYet(/** @type {string} */ what) {
    log.warn(`${what}: not available yet`);
    await alertModal(what, `${what} arrives in a later milestone.`);
}
