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
 * backup file, and (optionally) verifies by reading it back. Both leave the
 * radio restarted.
 */
import { h } from "./dom.js";
import { openModal, confirmModal } from "./modal.js";
import { store } from "./state.js";
import { log } from "./log.js";
import { download } from "./files.js";
import { isDirty } from "./editing.js";
import { loadCodeplug } from "./actions.js";
import { infoTable } from "./tabs/common.js";
import { serialSupported } from "./serial.js";
import { withRadio } from "./radioconn.js";
import { exportArchive } from "../lib/export.js";
import { InvalidValue } from "../lib/errors.js";
import {
    ProgramRefused, Cancelled, archiveFile, imageFromBody, hasExtRegion, serialOf, modelOf, EXT_SIZE, BLOCK, RESTART_MS,
} from "../lib/radio.js";

const errText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

/** How to get Chrome talking to the RIB: shown in the dialogs and the Tech tab. */
export function serialHelp(open = true) {
    const ok = serialSupported();
    return h("details", { class: "serial-help", open: open || !ok },
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

/** "1:05" */
export const mmss = (/** @type {number} */ secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`;

/**
 * @typedef {{ stage: HTMLElement, progress: HTMLProgressElement }} ProgressUi
 */

/**
 * A progress callback for a bar and its stage text, counting in RSS's
 * 256-byte blocks as well as bytes, with an estimate of the time left from
 * the rate so far: "Reading codeplug block 3 of 6 (768 of 1536 bytes), about 0:09 left".
 * @param {ProgressUi} ui @param {string} what
 * @returns {import("../lib/radio.js").Progress}
 */
export function reporter(ui, what) {
    ui.stage.textContent = `${what}…`;
    ui.progress.hidden = false;
    ui.progress.removeAttribute("value");
    ui.stage.scrollIntoView({ block: "nearest" });
    /** @type {{ t: number, done: number } | null} */
    let first = null;
    return (done, total) => {
        const now = performance.now();
        first ??= { t: now, done };
        ui.progress.max = total;
        ui.progress.value = done;
        const blocks = Math.ceil(total / BLOCK);
        const block = Math.min(blocks, Math.floor(done / BLOCK) + (done < total ? 1 : 0));
        const secs = (now - first.t) / 1000;
        const rate = (done - first.done) / secs;
        const left = done >= total ? "" : secs > 1.5 && rate > 0 ? `, about ${mmss((total - done) / rate)} left` : ", estimating time…";
        ui.stage.textContent = `${what} block ${block} of ${blocks} (${done} of ${total} bytes)${left}`;
    };
}

/** Fold the help and show the progress once the work starts. */
function working(/** @type {import("./modal.js").ModalControl | null} */ ctl, /** @type {ProgressUi} */ ui) {
    ctl?.setButtons([{ label: "Working…", value: "busy", disabled: true }]);
    for (const d of ctl?.dialog.querySelectorAll("details") ?? []) d.open = false;
    ui.stage.scrollIntoView({ block: "nearest" });
}

/** Read Radio: read the codeplug and open it. */
export async function readRadio() {
    if (isDirty() && !(await confirmModal("Discard changes?",
        `${store.get()?.fileName} has changes that haven't been exported. Read the radio anyway (its codeplug replaces this one)?`,
        "Discard and continue"))) return;
    const progress = /** @type {HTMLProgressElement} */ (h("progress", { hidden: true }));
    const stage = h("p", { class: "note" });
    const ui = { stage, progress };
    /** @type {import("./modal.js").ModalControl | null} */
    let ctl = null;
    let busy = false;
    /** @type {{ name: string, bytes: Uint8Array } | null} */
    let file = null;
    const startButtons = () => [{ label: "Cancel", value: "cancel" },
        { label: "Choose port and read", value: "read", primary: true, disabled: !serialSupported() }];
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
        buttons: startButtons(),
        onOpen: (c) => (ctl = c),
        async onButton(value) {
            if (busy) return false;
            if (value === "save" && file) {
                download(file.bytes, file.name);
                log.info(`Saved ${file.name}`);
                return false;
            }
            if (value !== "read") return true;
            busy = true;
            stage.className = "note";
            const t0 = performance.now();
            try {
                const result = await withRadio((radio) => radio.readAll(reporter(ui, "Reading codeplug")),
                    { onOpen: () => working(ctl, ui) });
                if (!result) {
                    stage.textContent = "No serial port was chosen.";
                    ctl?.setButtons(startButtons());
                    return false;
                }
                file = archiveFile(result);
                const secs = mmss((performance.now() - t0) / 1000);
                log.info(`Radio: read ${modelOf(result.codeplug)}, serial ${serialOf(result.codeplug)}, `
                    + `${result.codeplug.length}-byte codeplug (${result.codeplug.length / BLOCK} blocks) in ${secs}`);
                loadCodeplug(file.name, file.bytes);
                stage.textContent = `Done in ${secs}: ${result.codeplug.length / BLOCK} blocks read, opened as ${file.name}. `
                    + "Save it now, or later with Export Codeplug. The radio has restarted.";
                ctl?.setButtons([{ label: "Save archive file", value: "save" }, { label: "Close", value: "close", primary: true }]);
            } catch (e) {
                log.error(`Radio: read failed: ${errText(e)}`);
                progress.hidden = true;
                stage.textContent = `The read failed: ${errText(e)}`;
                stage.className = "warn-box";
                ctl?.setButtons([{ label: "Close", value: "close" }, { label: "Try again", value: "read", primary: true }]);
            } finally {
                busy = false;
                stage.scrollIntoView({ block: "nearest" });
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

    const progress = /** @type {HTMLProgressElement} */ (h("progress", { hidden: true }));
    const stage = h("p", { class: "note" });
    const ui = { stage, progress };
    /** @type {import("./modal.js").ModalControl | null} */
    let ctl = null;
    const checkbox = (/** @type {string} */ id, checked = false, disabled = false) =>
        /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id, checked, disabled }));
    const ack = checkbox("radio-ack");
    const verify = checkbox("radio-verify", true);
    const clone = checkbox("radio-clone");
    const ignoreFeatures = checkbox("radio-ignore-features", false, true);
    const startButtons = () => [{ label: "Cancel", value: "cancel" },
        { label: "Choose port and write", value: "write", primary: true, disabled: !ack.checked || !serialSupported() }];
    let busy = false;
    let written = false;
    /** @type {import("../lib/radio.js").Radio | null} */
    let active = null;
    ack.addEventListener("change", () => ctl?.setButtons(startButtons()));
    clone.addEventListener("change", () => {
        ignoreFeatures.disabled = !clone.checked;
        if (!clone.checked) ignoreFeatures.checked = false;
    });
    const blocks = image.length / BLOCK;

    const body = h("div", { class: "radio-io" },
        h("p", {}, "Programs the open codeplug, with your edits, into a Spectra connected through a RIB, "
            + "the way RSS's PROGRAM does."),
        infoTable([
            { label: "Radio model", value: doc.cp.model || "unknown" },
            { label: "Serial number", value: doc.cp.serial || "unknown" },
            { label: "Modes / zones", value: `${doc.cp.modes.length} / ${doc.cp.zones.length}` },
            { label: "Codeplug", value: `${blocks} blocks, ${image.length} bytes${s9000e ? ` (S9000e head: ${image.length - EXT_SIZE} + ${EXT_SIZE})` : ""}` },
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
                    + "It checks the serial number unless you clone."),
                h("li", {}, "Values RSS would refuse (frequencies outside the radio's range and so on) are written as they are: "
                    + "the radio may not accept them."))),
        serialHelp(),
        h("div", { class: "check-row" }, verify, h("label", { for: "radio-verify" },
            "Verify by reading afterwards: the radio restarts, then every byte is read back and compared "
            + `(about ${mmss(RESTART_MS / 1000 + image.length / 100 + 4)} more; it can be cancelled).`)),
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
        onOpen: (c) => (ctl = c),
        async onButton(value) {
            if (value === "cancel-verify") {
                active?.cancel();
                ctl?.setButtons([{ label: "Cancelling…", value: "busy", disabled: true }]);
                return false;
            }
            if (busy) return false;
            if (value !== "write") return true;
            busy = true;
            stage.className = "note";
            const t0 = performance.now();
            let verified = false;
            try {
                const done = await withRadio(async (radio) => {
                    active = radio;
                    const before = await radio.readAll(reporter(ui, "Reading the radio for the backup: codeplug"), false);
                    const f = archiveFile(before);
                    backup = { name: `backup-${f.name}`, bytes: f.bytes };
                    download(backup.bytes, backup.name);
                    log.info(`Radio: backup of ${serialOf(before.codeplug)} saved as ${backup.name}`);
                    stage.textContent = "Checking the radio…";
                    /** @type {import("../lib/radio.js").Progress | undefined} */
                    let report;
                    const img = await radio.program(image, {
                        clone: clone.checked, options, ignoreFeatures: ignoreFeatures.checked,
                        progress: (d, t) => {
                            written = true;
                            (report ??= reporter(ui, "Programming codeplug"))(d, t);
                        },
                    });
                    log.info(`Radio: programmed ${serialOf(img)} with ${doc.fileName} (${blocks} blocks); the radio restarts`);
                    if (!verify.checked) return img;
                    ctl?.setButtons([{ label: "Cancel verification", value: "cancel-verify" }]);
                    const wait = reporter(ui, "Waiting for the radio to restart");
                    const waitStart = performance.now();
                    const tick = setInterval(() => {
                        const s = (performance.now() - waitStart) / 1000;
                        wait(Math.min(RESTART_MS, s * 1000), RESTART_MS);
                        stage.textContent = `Programmed. Waiting for the radio to restart before reading it back, about ${mmss(Math.max(0, RESTART_MS / 1000 - s))} left`;
                    }, 250);
                    /** @type {import("../lib/radio.js").Progress | undefined} */
                    let vreport;
                    try {
                        await radio.verify(img, {
                            progress: (d, t) => {
                                clearInterval(tick);
                                (vreport ??= reporter(ui, "Verifying codeplug"))(d, t);
                            },
                        });
                    } finally {
                        clearInterval(tick);
                    }
                    verified = true;
                    return img;
                }, { onOpen: () => working(ctl, ui) });
                if (!done) {
                    stage.textContent = "No serial port was chosen.";
                    ctl?.setButtons(startButtons());
                    return false;
                }
                const secs = mmss((performance.now() - t0) / 1000);
                log.info(`Radio: ${verified ? "verified" : "not verified (not asked)"}; done in ${secs}`);
                stage.textContent = `Done in ${secs}: ${blocks} blocks programmed`
                    + (verified ? " and every byte read back correctly." : " (not verified).")
                    + ` The radio has restarted. The backup of what it held before is ${backup?.name}.`;
                ctl?.setButtons([{ label: "Close", value: "close", primary: true }]);
            } catch (e) {
                progress.hidden = true;
                if (e instanceof Cancelled) {
                    log.info("Radio: verification cancelled");
                    stage.textContent = `Programmed (${blocks} blocks); verification cancelled. The radio has restarted. `
                        + `The backup of what it held before is ${backup?.name}.`;
                    ctl?.setButtons([{ label: "Close", value: "close", primary: true }]);
                    return false;
                }
                const refused = e instanceof ProgramRefused;
                log.error(`Radio: write ${refused ? "refused" : "failed"}: ${errText(e)}`);
                stage.className = "warn-box";
                stage.textContent = refused
                    ? `Not written: ${errText(e)}. The radio was not changed.`
                    : written
                        ? `The write did not finish or did not verify: ${errText(e)}. The radio may not work until it is `
                            + "programmed again. Check the power and cable, then try again"
                            + (backup ? `; the backup ${backup.name} holds what the radio had before.` : ".")
                        : `Nothing was written: ${errText(e)}`;
                ctl?.setButtons([{ label: "Close", value: "close" }, { label: "Try again", value: "write", primary: true }]);
            } finally {
                busy = false;
                active = null;
                stage.scrollIntoView({ block: "nearest" });
            }
            return false;
        },
    });
}
