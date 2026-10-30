// @ts-check
/**
 * Read Radio and Write Radio: talk to a Spectra through a RIB on a serial
 * port with Web Serial (Chrome / Edge), as the CLI's read-radio and
 * write-radio do. Each starts with a dialog that spells out the risk and how
 * to give the browser the serial port; the work runs inside that dialog with
 * a progress bar.
 *
 * Read opens what it read as the current codeplug. Write programs the open
 * codeplug (with its edits), after reading the radio and saving that as a
 * backup file, and verifies by reading it back.
 */
import { h } from "./dom.js";
import { openModal, confirmModal } from "./modal.js";
import { store } from "./state.js";
import { log } from "./log.js";
import { download } from "./files.js";
import { isDirty } from "./editing.js";
import { loadCodeplug } from "./actions.js";
import { infoTable } from "./tabs/common.js";
import { serialSupported, requestPort, portName, WebSerialLink } from "./serial.js";
import { exportArchive } from "../lib/export.js";
import { InvalidValue } from "../lib/errors.js";
import {
    Radio, ProgramRefused, archiveFile, imageFromBody, hasExtRegion, serialOf, modelOf, EXT_SIZE,
} from "../lib/radio.js";

const errText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

/** How to get Chrome talking to the RIB: shown in both dialogs. */
function serialHelp() {
    const ok = serialSupported();
    return h("details", { class: "serial-help", open: true },
        h("summary", {}, "Setting up the serial port in Chrome"),
        ok ? null : h("p", { class: "warn-box" }, window.isSecureContext
            ? "This browser has no Web Serial, so it can't reach the radio. Use Google Chrome or Microsoft Edge on a desktop computer."
            : "Web Serial only works on a page loaded over https:// or from localhost; this one isn't, so the radio can't be reached."),
        h("ol", {},
            h("li", {}, "Use Google Chrome or Microsoft Edge (version 89 or later) on Windows, macOS, Linux or ChromeOS. "
                + "Firefox and Safari don't have Web Serial. No flag or extension is needed."),
            h("li", {}, "Open motreader over https:// or from http://localhost (not as a file:// page)."),
            h("li", {}, "Connect: computer serial port or USB-serial adapter → RIB (powered) → the radio's programming connector. "
                + "Turn the radio on."),
            h("li", {}, "Linux: your user must be able to open the port. Add yourself to the dialout group "
                + "(", h("code", {}, "sudo usermod -aG dialout $USER"), ") and log out and back in. "
                + "Chromium installed as a snap also needs ", h("code", {}, "sudo snap connect chromium:raw-usb"), "."),
            h("li", {}, "Linux: if reading fails at once with \"The device has been lost\", a program that used the port "
                + "before (motreader's Python tools, DOSBox) left it in a mode Chrome can't read. Run ",
                h("code", {}, "stty -F /dev/ttyUSB0 min 1"), " (with your port's name) or unplug and replug the adapter."),
            h("li", {}, "Windows: install the adapter's driver (FTDI, Prolific, ...) so it appears as a COM port in Device Manager. "
                + "macOS: it appears as cu.usbserial-…"),
            h("li", {}, "When Chrome shows its port list, pick the adapter (for example \"FT232R USB UART (ttyUSB0)\" or \"COM3\") "
                + "and press Connect. On Linux the built-in ports ttyS0, ttyS1, ... are listed too; a USB adapter is ttyUSB0 or similar."),
            h("li", {}, "If Chrome never asks, or the list stays empty: check the site's permission at ",
                h("code", {}, "chrome://settings/content/serialPorts"), " (\"Sites can ask to connect to serial ports\"), "
                + "close other programs using the port (RSS in DOSBox, a terminal), and look at ",
                h("code", {}, "chrome://device-log"), ".")));
}

/**
 * Run `work` inside an open dialog: buttons off, Escape ignored, the port
 * opened first and always closed afterwards.
 * @template T
 * @param {{ stage: HTMLElement, progress: HTMLProgressElement, ctl: import("./modal.js").ModalControl | null }} ui
 * @param {(radio: Radio) => Promise<T>} work
 * @returns {Promise<T | null>} null if no port was picked
 */
async function withRadio(ui, work) {
    let port;
    try {
        port = await requestPort();
    } catch (e) {
        ui.stage.textContent = "No serial port was chosen.";
        log.info(`Radio: no serial port chosen (${errText(e)})`);
        return null;
    }
    ui.ctl?.setButtons([{ label: "Working…", value: "busy", disabled: true }]);
    // the help has done its job: fold it so the progress shows
    for (const d of ui.ctl?.dialog.querySelectorAll("details") ?? []) d.open = false;
    reveal(ui);
    const link = new WebSerialLink(port, { log: (s) => log.debug(`Radio: ${s}`) });
    log.info(`Radio: opening ${portName(port)}`);
    try {
        await link.open();
    } catch (e) {
        throw new Error(`the serial port could not be opened (in use by another program?): ${errText(e)}`);
    }
    try {
        return await work(new Radio(link));
    } finally {
        await link.close();
    }
}

/** Scroll the dialog to the progress and stage text. */
const reveal = (/** @type {{ stage: HTMLElement }} */ ui) => ui.stage.scrollIntoView({ block: "nearest" });

/** A progress callback that drives the bar and the stage text. */
function stageProgress(/** @type {{ stage: HTMLElement, progress: HTMLProgressElement }} */ ui, /** @type {string} */ what) {
    ui.stage.textContent = `${what}…`;
    ui.progress.hidden = false;
    ui.progress.removeAttribute("value");
    reveal(ui);
    return (/** @type {number} */ done, /** @type {number} */ total) => {
        ui.progress.max = total;
        ui.progress.value = done;
        ui.stage.textContent = `${what}: ${done} of ${total} bytes`;
    };
}

/** Read Radio: read the codeplug and open it. */
export async function readRadio() {
    if (isDirty() && !(await confirmModal("Discard changes?",
        `${store.get()?.fileName} has changes that haven't been exported. Read the radio anyway (its codeplug replaces this one)?`,
        "Discard and continue"))) return;
    const progress = h("progress", { hidden: true });
    const stage = h("p", { class: "note" });
    /** @type {{ stage: HTMLElement, progress: HTMLProgressElement, ctl: import("./modal.js").ModalControl | null }} */
    const ui = { stage, progress: /** @type {HTMLProgressElement} */ (progress), ctl: null };
    let busy = false;
    /** @type {{ name: string, bytes: Uint8Array } | null} */
    let file = null;
    const body = h("div", { class: "radio-io" },
        h("p", {}, "Reads the codeplug from a Spectra connected through a RIB, the way RSS's READ does, "
            + "and opens it here. Nothing in the radio is changed."),
        h("div", { class: "warn-box" },
            h("p", {}, "motreader is not Motorola software. Its radio protocol was worked out by watching RSS, "
                + "and it has been tried on few radios. Reading is the safe direction, but:"),
            h("ul", {},
                h("li", {}, "Don't transmit or change the radio's controls while it is being read."),
                h("li", {}, "The radio restarts at the end, as it does after RSS reads it."))),
        serialHelp(),
        progress, stage);
    await openModal({
        title: "Read Radio",
        body,
        wide: true,
        buttons: [{ label: "Cancel", value: "cancel" },
            { label: "Choose port and read", value: "read", primary: true, disabled: !serialSupported() }],
        onOpen: (ctl) => (ui.ctl = ctl),
        async onButton(value) {
            if (busy) return false;
            if (value === "save" && file) {
                download(file.bytes, file.name);
                log.info(`Saved ${file.name}`);
                return false;
            }
            if (value !== "read") return true;
            busy = true;
            const t0 = performance.now();
            try {
                const result = await withRadio(ui, (radio) => radio.readAll(stageProgress(ui, "Reading the codeplug")));
                if (!result) {
                    ui.ctl?.setButtons([{ label: "Cancel", value: "cancel" }, { label: "Choose port and read", value: "read", primary: true }]);
                    return false;
                }
                file = archiveFile(result);
                const secs = ((performance.now() - t0) / 1000).toFixed(0);
                log.info(`Radio: read ${modelOf(result.codeplug)}, serial ${serialOf(result.codeplug)}, `
                    + `${result.codeplug.length}-byte codeplug in ${secs} s`);
                loadCodeplug(file.name, file.bytes);
                stage.textContent = `Done in ${secs} s: opened as ${file.name}. Save it now, or later with Export Codeplug.`;
                ui.ctl?.setButtons([{ label: "Save archive file", value: "save" }, { label: "Close", value: "close", primary: true }]);
                reveal(ui);
            } catch (e) {
                log.error(`Radio: read failed: ${errText(e)}`);
                progress.hidden = true;
                stage.textContent = `The read failed: ${errText(e)}`;
                stage.className = "warn-box";
                ui.ctl?.setButtons([{ label: "Close", value: "close" }, { label: "Try again", value: "read", primary: true }]);
                reveal(ui);
            } finally {
                busy = false;
            }
            return false;
        },
    });
}

/** Write Radio: program the open codeplug into the radio. */
export async function writeRadio() {
    const doc = store.get();
    if (!doc) return;
    let built;
    try {
        built = exportArchive(doc, doc.radioWideEdits);
    } catch (e) {
        log[e instanceof InvalidValue ? "warn" : "error"](`Write Radio: ${errText(e)}`);
        await openModal({ title: "Write Radio", body: `The codeplug can't be built: ${errText(e)}` });
        return;
    }
    if (built.problems.length) log.warn(`Write Radio: the codeplug didn't read back exactly as edited: ${built.problems.join("; ")}`);
    const { image, options } = imageFromBody(built.plain);
    const s9000e = hasExtRegion(image);

    const progress = h("progress", { hidden: true });
    const stage = h("p", { class: "note" });
    /** @type {{ stage: HTMLElement, progress: HTMLProgressElement, ctl: import("./modal.js").ModalControl | null }} */
    const ui = { stage, progress: /** @type {HTMLProgressElement} */ (progress), ctl: null };
    const ack = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "radio-ack" }));
    const clone = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "radio-clone" }));
    const ignoreFeatures = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "radio-ignore-features", disabled: true }));
    const startButtons = () => [{ label: "Cancel", value: "cancel" },
        { label: "Choose port and write", value: "write", primary: true, disabled: !ack.checked || !serialSupported() }];
    let busy = false;
    let written = false;
    ack.addEventListener("change", () => ui.ctl?.setButtons(startButtons()));
    clone.addEventListener("change", () => {
        ignoreFeatures.disabled = !clone.checked;
        if (!clone.checked) ignoreFeatures.checked = false;
    });

    const body = h("div", { class: "radio-io" },
        h("p", {}, "Programs the open codeplug, with your edits, into a Spectra connected through a RIB, "
            + "the way RSS's PROGRAM does."),
        infoTable([
            { label: "Radio model", value: doc.cp.model || "unknown" },
            { label: "Serial number", value: doc.cp.serial || "unknown" },
            { label: "Modes / zones", value: `${doc.cp.modes.length} / ${doc.cp.zones.length}` },
            { label: "Codeplug", value: `${image.length} bytes${s9000e ? ` (S9000e head: ${image.length - EXT_SIZE} + ${EXT_SIZE})` : ""}` },
        ]),
        built.problems.length ? h("div", { class: "warn-box" },
            h("p", {}, "This codeplug didn't read back exactly as edited (details are in the log):"),
            h("ul", {}, built.problems.slice(0, 8).map((p) => h("li", {}, p)))) : null,
        h("div", { class: "warn-box" },
            h("p", {}, h("strong", {}, "Writing replaces the codeplug in the radio. Read this first:")),
            h("ul", {},
                h("li", {}, "motreader is not Motorola software. Its radio protocol was worked out by watching RSS and has been "
                    + "tried on few radios (a VHF Spectra with a standard head; S9000e radios only in simulation). "
                    + "You use it at your own risk."),
                h("li", {}, "If writing is interrupted (power, cable, closing this tab), the radio may not work until it is "
                    + "programmed again. Keep the radio powered, leave the cable alone and keep this tab in front until it says done."),
                h("li", {}, "The radio is read first and that copy is saved as a backup archive file (in your downloads). "
                    + "Keep it: opening it here and writing it back restores the radio."),
                h("li", {}, "motreader refuses a codeplug for a different model or control head, or one that won't fit. "
                    + "It checks the serial number unless you clone. Afterwards it reads the radio back to check every byte."),
                h("li", {}, "Values RSS would refuse (frequencies outside the radio's range and so on) are written as they are: "
                    + "the radio may not accept them."))),
        serialHelp(),
        h("div", { class: "check-row" }, clone, h("label", { for: "radio-clone" },
            "Clone: the radio's serial number differs from this codeplug's (another radio of the same model, as RSS's CLONE). "
            + "The radio keeps its own serial number.")),
        h("div", { class: "check-row" }, ignoreFeatures, h("label", { for: "radio-ignore-features" },
            "Clone even if the radio's options (features) differ from the codeplug's radio")),
        h("div", { class: "check-row" }, ack, h("label", { for: "radio-ack" },
            "I understand the risk, and the radio is on, connected and powered")),
        progress, stage);

    /** @type {{ name: string, bytes: Uint8Array } | null} */
    let backup = null;
    await openModal({
        title: "Write Radio",
        body,
        wide: true,
        buttons: startButtons(),
        onOpen: (ctl) => (ui.ctl = ctl),
        async onButton(value) {
            if (busy) return false;
            if (value !== "write") return true;
            busy = true;
            stage.className = "note";
            const t0 = performance.now();
            try {
                const done = await withRadio(ui, async (radio) => {
                    const before = await radio.readAll(stageProgress(ui, "Reading the radio for the backup"), false);
                    const f = archiveFile(before);
                    backup = { name: `backup-${f.name}`, bytes: f.bytes };
                    download(backup.bytes, backup.name);
                    log.info(`Radio: backup of ${serialOf(before.codeplug)} saved as ${backup.name}`);
                    ui.stage.textContent = "Checking the radio…";
                    /** @type {import("../lib/radio.js").Progress | undefined} */
                    let write, verify;
                    return radio.programVerified(image, {
                        clone: clone.checked, options, ignoreFeatures: ignoreFeatures.checked,
                        progress: (d, t) => {
                            written = true;
                            (write ??= stageProgress(ui, "Writing"))(d, t);
                        },
                        verifyProgress: (d, t) => (verify ??= stageProgress(ui, "Verifying"))(d, t),
                    });
                });
                if (!done) {
                    ui.ctl?.setButtons(startButtons());
                    return false;
                }
                const secs = ((performance.now() - t0) / 1000).toFixed(0);
                log.info(`Radio: programmed ${serialOf(done.codeplug)} with ${doc.fileName} and verified (${image.length} bytes, ${secs} s)`);
                stage.textContent = `Done in ${secs} s: the radio is programmed and every byte read back correctly. `
                    + `The backup of what it held before is ${backup?.name}.`;
                ui.ctl?.setButtons([{ label: "Close", value: "close", primary: true }]);
                reveal(ui);
            } catch (e) {
                const refused = e instanceof ProgramRefused;
                log.error(`Radio: write ${refused ? "refused" : "failed"}: ${errText(e)}`);
                progress.hidden = true;
                stage.className = "warn-box";
                stage.textContent = refused
                    ? `Not written: ${errText(e)}. The radio was not changed.`
                    : written
                        ? `The write did not finish: ${errText(e)}. The radio may not work until it is programmed again. `
                            + "Check the power and cable, then try again"
                            + (backup ? `; the backup ${backup.name} holds what the radio had before.` : ".")
                        : `Nothing was written: ${errText(e)}`;
                ui.ctl?.setButtons([{ label: "Close", value: "close" }, { label: "Try again", value: "write", primary: true }]);
                reveal(ui);
            } finally {
                busy = false;
            }
            return false;
        },
    });
}
