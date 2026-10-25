// @ts-check
/**
 * Export Codeplug: build the archive, show what will be written (model,
 * serial, modes, zones, size, what changed, any verification problem), let
 * the user set the file name, then write it with a progress bar.
 */
import { h } from "./dom.js";
import { openModal, alertModal } from "./modal.js";
import { store } from "./state.js";
import { log } from "./log.js";
import { download } from "./files.js";
import { exportArchive } from "../lib/export.js";
import { changes } from "../lib/document.js";
import { formatModeList } from "../lib/zonefields.js";
import { InvalidValue } from "../lib/errors.js";
import { infoTable } from "./tabs/common.js";

/** A DOS 8.3 file name, as RSS (a DOS program) needs. */
const DOS_NAME = /^[A-Za-z0-9_$~!#%&'(){}^@`-]{1,8}(\.[A-Za-z0-9_$~!#%&'(){}^@`-]{1,3})?$/;

const nextFrame = () => new Promise((r) => setTimeout(r, 120));

/** Run the Export Codeplug dialog. */
export async function exportDialog() {
    const doc = store.get();
    if (!doc) return;
    /** @type {import("../lib/export.js").ExportResult} */
    let result;
    try {
        result = exportArchive(doc, doc.radioWideEdits);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log[e instanceof InvalidValue ? "warn" : "error"](`Export failed: ${msg}`);
        await alertModal("Export failed", `The codeplug can't be written: ${msg}`);
        return;
    }
    const ch = changes(doc);
    const what = [
        ch.modes.length ? `modes ${formatModeList(ch.modes)}` : "",
        ch.zones.length ? `zones ${formatModeList(ch.zones)}` : "",
        ch.phones.length ? `phones ${formatModeList(ch.phones)}` : "",
        ch.mpls.length ? `MPL ${formatModeList(ch.mpls)}` : "",
        ch.radioWide.length ? `radio-wide: ${ch.radioWide.join(", ")}` : "",
    ].filter(Boolean).join("; ");

    const nameInput = h("input", { type: "text", value: doc.fileName, spellcheck: "false", size: 16, id: "export-name" });
    const nameMsg = h("span", { class: "field-msg" });
    const checkName = () => {
        const ok = DOS_NAME.test(nameInput.value);
        nameMsg.textContent = ok ? "" : "not a DOS 8.3 name: RSS can't open it";
        nameMsg.className = `field-msg${ok ? "" : " error"}`;
    };
    nameInput.addEventListener("input", checkName);
    const progress = h("progress", { max: 3, value: 0, hidden: true });
    const stage = h("p", { class: "note" });
    const problems = result.problems.length
        ? h("div", { class: "warn-box" },
            h("p", {}, "The exported file didn't read back exactly as edited:"),
            h("ul", {}, result.problems.slice(0, 12).map((p) => h("li", {}, p))),
            result.problems.length > 12 ? h("p", {}, `... and ${result.problems.length - 12} more`) : null)
        : null;
    if (result.problems.length) log.warn(`Export verification: ${result.problems.join("; ")}`);

    const body = h("div", { class: "export" },
        infoTable([
            { label: "Radio model", value: doc.cp.model || "unknown" },
            { label: "Serial number", value: doc.cp.serial || "unknown" },
            { label: "Modes", value: doc.cp.modes.length },
            { label: "Zones", value: doc.cp.zones.length },
            { label: "Decrypted codeplug", value: `${result.plain.length} bytes` },
            { label: "Changes", value: what || "none: the file will be identical to the one imported" },
            { label: "Bytes changed", value: result.changed.length },
        ]),
        problems,
        h("div", { class: "form-row" }, h("label", { for: "export-name" }, "File name"), nameInput, nameMsg),
        h("p", { class: "note" }, "RSS finds archives through its index, SPECTRAM.DBF, not by looking in the folder. "
            + "Keep this name to replace the radio's archive in RSS's ARCHIVE folder; a new name is only seen "
            + "by RSS once SPECTRAM.DBF lists it."),
        progress, stage);

    await openModal({
        title: "Export Codeplug",
        body,
        wide: true,
        buttons: [{ label: "Cancel", value: "cancel" }, { label: result.problems.length ? "Export anyway" : "Export", value: "export", primary: true }],
        onOpen: (ctl) => (control = ctl),
        async onButton(value) {
            if (value !== "export") return true;
            const name = nameInput.value.trim() || doc.fileName;
            control?.setButtons([{ label: "Exporting…", value: "busy", disabled: true }]);
            progress.hidden = false;
            for (const [i, text] of /** @type {const} */ ([[1, "Encrypting with the original key…"], [2, "Verifying…"], [3, "Saving…"]])) {
                stage.textContent = text;
                progress.value = i;
                await nextFrame();
            }
            download(result.bytes, name);
            stage.textContent = `Done: ${name}, ${result.bytes.length} bytes.`;
            log.info(`Exported ${name} (${result.bytes.length} bytes; ${result.changed.length} bytes changed${what ? `: ${what}` : ""})`);
            control?.setButtons([{ label: "Close", value: "close", primary: true }]);
            return false;
        },
    });
}

/** @type {import("./modal.js").ModalControl | null} */
let control = null;
