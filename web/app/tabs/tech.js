// @ts-check
/**
 * Tech: direct access to the radio over the RIB, without a codeplug open.
 * Read and write any address in hex, save the known memory regions (RAM,
 * firmware, EEPROMs) as binary files and write the EEPROM ones back from
 * files, and (disabled until the commands are found) alignment controls.
 *
 * The tab keeps one connection open between operations (radioconn.js). Each
 * operation leaves the radio waiting with its control head frozen; Restart
 * radio or Disconnect restarts it.
 *
 * The tab is built once and kept, so its fields, output and a running
 * operation survive switching tabs.
 */
import { h, fill } from "../dom.js";
import { log } from "../log.js";
import { confirmModal } from "../modal.js";
import { download, pickFiles } from "../files.js";
import { note, section } from "./common.js";
import { serialSupported } from "../serial.js";
import { connection, connect, disconnect, withRadio, onConnectionChange } from "../radioconn.js";
import { serialHelp, reporter, mmss } from "../radioio.js";
import { hex, fromHex, hexdumpLine, latin1 } from "../../lib/bytes.js";
import {
    REGIONS, BLOCK, HC11_REGISTERS, Cancelled, writableRegion, MODEL, CODEPLUG_BASE, serialOf, modelOf,
} from "../../lib/radio.js";

/** Measured on a 617ASQ through Chrome: bytes per second reading (2 per message) and writing (1 per message). */
const READ_BPS = 100;
const WRITE_BPS = 32;

const errText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));
const h4 = (/** @type {number} */ n) => n.toString(16).toUpperCase().padStart(4, "0");

/** `hexdump -C` lines with radio addresses. */
function dump(/** @type {Uint8Array} */ b, /** @type {number} */ base) {
    const lines = [];
    for (let off = 0; off < b.length; off += 16) {
        lines.push(hexdumpLine(b, off).replace(/^[0-9a-f]{8}/, h4(base + off)));
    }
    return lines.join("\n");
}

/** A hex number from a field ("6000", "0x6000"); throws a readable error. */
function parseHex(/** @type {string} */ text, /** @type {string} */ what) {
    const t = text.trim().replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,5}$/i.test(t)) throw new Error(`${what}: "${text}" is not a hex number`);
    return parseInt(t, 16);
}

/** Runs of differing bytes [start, end), joining runs closer than 4 bytes. */
function diffRuns(/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) {
    /** @type {[number, number][]} */
    const runs = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        const last = runs.at(-1);
        if (last && i - last[1] < 4) last[1] = i + 1;
        else runs.push([i, i + 1]);
    }
    return runs;
}

/** @type {HTMLElement | null} */
let root = null;
/** @type {(() => void) | null} */
let refresh = null;
/** @type {{ writeRegionBytes: (id: string, bytes: Uint8Array) => Promise<string> } | null} */
export let techApi = null;

function build() {
    const progress = /** @type {HTMLProgressElement} */ (h("progress", { hidden: true }));
    const stage = h("p", { class: "note tech-stage" });
    const ui = { stage, progress };
    const cancel = h("button", { hidden: true, onclick: () => connection()?.radio.cancel() }, "Cancel");
    /** @type {HTMLButtonElement[]} buttons that need an idle connection */
    const actions = [];
    const action = (/** @type {string} */ label, /** @type {() => Promise<void>} */ fn, attrs = {}) => {
        const b = /** @type {HTMLButtonElement} */ (h("button", { ...attrs, onclick: () => void fn() }, label));
        actions.push(b);
        return b;
    };
    const status = h("p", { class: "tech-status" });
    let radioName = "";

    /** Show a result or an error in the stage line. */
    const say = (/** @type {string} */ text, warn = false) => {
        stage.textContent = text;
        stage.className = warn ? "warn-box tech-stage" : "note tech-stage";
    };

    /**
     * Run an operation on the open connection (the radio is left waiting).
     * `cancellable`: show Cancel while it runs.
     * @param {string} what @param {(radio: import("../../lib/radio.js").Radio) => Promise<string | void>} fn
     */
    async function run(what, fn, cancellable = false) {
        if (!connection()) return;
        say(`${what}…`);
        cancel.hidden = !cancellable;
        try {
            const msg = await withRadio(fn, { restart: false });
            if (msg) say(msg);
        } catch (e) {
            progress.hidden = true;
            if (e instanceof Cancelled) {
                say(`${what}: cancelled.`);
            } else {
                log.error(`Tech: ${what} failed: ${errText(e)}`);
                say(`${what} failed: ${errText(e)}`, true);
            }
        } finally {
            cancel.hidden = true;
        }
    }

    // --- connection ---------------------------------------------------------
    const connectBtn = h("button", {
        class: "primary",
        onclick: async () => {
            try {
                if (!(await connect())) return say("No serial port was chosen.");
            } catch (e) {
                return say(`Could not connect: ${errText(e)}`, true);
            }
            await run("Identifying the radio", async (radio) => {
                const head = await radio.readRange(CODEPLUG_BASE, CODEPLUG_BASE + MODEL[1]);
                if (latin1(head.subarray(0, 9)) !== "COPYRIGHT") {
                    radioName = "no codeplug header at 0x6000";
                    return `Connected, but the codeplug header wasn't found: ${hex(head.subarray(0, 16), " ")}`;
                }
                radioName = `${serialOf(head)}, ${modelOf(head)}`;
                log.info(`Tech: connected to ${radioName}`);
                return `Connected to ${radioName}.`;
            });
        },
    }, "Connect…");
    const restartBtn = action("Restart radio", async () => {
        await run("Restarting the radio", async (radio) => {
            await radio.finish();
            return "The radio is restarting (about 10 s before it answers again).";
        });
    });
    const disconnectBtn = action("Disconnect", async () => {
        await disconnect();
        radioName = "";
        say("Disconnected; the radio restarted if it was waiting.");
    });

    // --- hex read / write ---------------------------------------------------
    const field = (/** @type {string} */ id, /** @type {string} */ value, size = 6) =>
        /** @type {HTMLInputElement} */ (h("input", { type: "text", id, value, size, spellcheck: "false", class: "mono" }));
    const rdAddr = field("tech-read-addr", "6000");
    const rdLen = field("tech-read-len", "40", 5);
    const rdExt = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "tech-read-ext" }));
    const out = h("pre", { class: "hexdump tech-out" });
    const wrAddr = field("tech-write-addr", "");
    const wrData = field("tech-write-data", "", 40);

    const hexRead = action("Read", async () => {
        let addr, len;
        try {
            addr = parseHex(rdAddr.value, "Address");
            len = parseHex(rdLen.value, "Length");
            if (len < 1 || len > 0x2000) throw new Error("Length: 1 to 2000 (hex) bytes");
            if (addr + len > 0x10000) throw new Error("the range runs past FFFF");
            if (addr < HC11_REGISTERS[1] && addr + len > HC11_REGISTERS[0]) throw new Error("1000-103F are the 68HC11's registers: never read");
        } catch (e) {
            return say(errText(e), true);
        }
        const ext = rdExt.checked;
        await run(`Reading ${h4(addr)}-${h4(addr + len - 1)}`, async (radio) => {
            const b = await radio.readRange(addr, addr + len, { session: ext ? "ext" : "codeplug", progress: reporter(ui, "Reading") });
            out.textContent = dump(b, addr);
            log.info(`Tech: read ${h4(addr)}-${h4(addr + len - 1)}${ext ? " (S9000e session)" : ""}`);
            return `Read ${len} bytes at ${h4(addr)}.`;
        }, true);
    });

    const hexWrite = action("Write…", async () => {
        let addr, data, region;
        try {
            addr = parseHex(wrAddr.value, "Address");
            data = fromHex(wrData.value);
            if (!data.length || data.length > 0x100) throw new Error("Bytes: 1 to 256 hex bytes, e.g. \"5a 01 ff\"");
            region = writableRegion(addr, addr + data.length);
            if (!region) throw new Error(`${h4(addr)}-${h4(addr + data.length - 1)} isn't inside one writable region `
                + "(RAM 0000-0FFF, codeplug EEPROM 6000-7FFF, MCU EEPROM B600-B7FF)");
        } catch (e) {
            return say(e instanceof SyntaxError ? `Bytes: ${e.message}` : errText(e), true);
        }
        const range = `${h4(addr)}-${h4(addr + data.length - 1)}`;
        await run(`Writing ${range}`, async (radio) => {
            const before = await radio.readRange(addr, addr + data.length);
            const ok = await confirmModal("Write to the radio?", h("div", {},
                h("p", {}, `${data.length} byte${data.length === 1 ? "" : "s"} at ${range} (${region.name}):`),
                h("pre", { class: "hexdump" }, `now:   ${hex(before, " ")}\nwrite: ${hex(data, " ")}`),
                h("p", { class: "warn-box" }, region.id === "ram"
                    ? "RAM is the radio's live state: a bad value can make it misbehave until it restarts."
                    : region.id === "mcu_eeprom"
                        ? "The MCU EEPROM holds the radio's serial number, model, options and (probably) alignment. "
                            + "A wrong value stays until it is written back. Note the old bytes above."
                        : "This changes the codeplug EEPROM directly. A wrong value stays until it is written back.")),
            "Write");
            if (!ok) return "Write cancelled; nothing was written.";
            await radio.writeRange(addr, data);
            const back = await radio.readRange(addr, addr + data.length);
            out.textContent = dump(back, addr);
            const good = hex(back) === hex(data);
            log[good ? "info" : "warn"](`Tech: wrote ${range} = ${hex(data, " ")} (was ${hex(before, " ")})${good ? "" : `; reads back ${hex(back, " ")}`}`);
            return good ? `Wrote ${range}; it reads back correctly (was ${hex(before, " ")}).`
                : `Wrote ${range}, but it reads back as ${hex(back, " ")}.`;
        });
    });

    // --- regions ------------------------------------------------------------
    /** Read a region and save it as a file. */
    const saveRegion = (/** @type {import("../../lib/radio.js").Region} */ r) => run(`Reading ${r.name}`, async (radio) => {
        const b = await radio.readRange(r.start, r.end, { session: r.session, progress: reporter(ui, `Reading ${r.name}`) });
        const serial = radioName.split(",")[0] || "radio";
        const name = `${serial}-${r.id}-${h4(r.start)}.bin`;
        download(b, name);
        log.info(`Tech: saved ${r.name} ${h4(r.start)}-${h4(r.end - 1)} as ${name}`);
        return `Saved ${name} (${b.length} bytes, ${b.length / BLOCK} blocks).`;
    }, true);

    /**
     * Write a region from file bytes: read it, write only the bytes that
     * differ (after a confirmation) and read those back.
     */
    async function writeRegionBytes(/** @type {string} */ id, /** @type {Uint8Array} */ bytes) {
        const r = REGIONS.find((x) => x.id === id);
        if (!r?.writable) throw new Error(`${id} can't be written`);
        if (bytes.length !== r.end - r.start) {
            say(`The file is ${bytes.length} bytes; ${r.name} is ${r.end - r.start}. Nothing was written.`, true);
            return stage.textContent ?? "";
        }
        await run(`Writing ${r.name}`, async (radio) => {
            const now = await radio.readRange(r.start, r.end, { session: r.session, progress: reporter(ui, `Reading ${r.name} to compare`) });
            const runs = diffRuns(now, bytes);
            const n = runs.reduce((s, [a, b]) => s + b - a, 0);
            if (!runs.length) return `The radio's ${r.name} already matches the file: nothing written.`;
            const list = runs.slice(0, 12).map(([a, b]) => `${h4(r.start + a)}-${h4(r.start + b - 1)}`).join(", ");
            const ok = await confirmModal(`Write ${r.name}?`, h("div", {},
                h("p", {}, `${n} bytes differ from the file, in ${runs.length} place${runs.length === 1 ? "" : "s"}: `
                    + `${list}${runs.length > 12 ? ", …" : ""}. Only those are written (about ${mmss(n / WRITE_BPS)}), then read back.`),
                h("p", { class: "warn-box" }, r.id === "mcu_eeprom"
                    ? "The MCU EEPROM holds the radio's serial number, model, options and (probably) alignment. "
                        + "Write only a file read from this radio. The file just compared is the only copy of the old values "
                        + "unless you saved this region first."
                    : `This replaces the radio's ${r.name}. Save it first if you may want it back.`)), "Write");
            if (!ok) return "Write cancelled; nothing was written.";
            const write = reporter(ui, `Writing ${r.name}`);
            let done = 0;
            for (const [a, b] of runs) {
                await radio.writeRange(r.start + a, bytes.subarray(a, b), { session: r.session, progress: (d) => write(done + d, n) });
                done += b - a;
            }
            const bad = [];
            for (const [a, b] of runs) {
                const back = await radio.readRange(r.start + a, r.start + b, { session: r.session });
                if (hex(back) !== hex(bytes.subarray(a, b))) bad.push(h4(r.start + a));
            }
            progress.hidden = true;
            log[bad.length ? "warn" : "info"](`Tech: wrote ${n} bytes of ${r.name} in ${runs.length} runs; `
                + (bad.length ? `runs at ${bad.join(", ")} read back differently` : "all read back correctly"));
            return bad.length ? `Wrote ${n} bytes, but the runs at ${bad.join(", ")} read back differently.`
                : `Wrote ${n} bytes of ${r.name}; all read back correctly.`;
        });
        return stage.textContent ?? "";
    }
    techApi = { writeRegionBytes };

    const regionRows = REGIONS.map((r) => {
        const size = r.end - r.start;
        const readSecs = size / (r.session === "ext" ? READ_BPS * 1.5 : READ_BPS);
        const writeWhy = r.writable ? (r.id === "ram" ? "RAM is live state; restarting the radio resets it" : "")
            : "ROM: it can't be written over SB9600 (that needs the 1200-baud bootstrap, which motreader doesn't do)";
        return h("tr", {},
            h("td", {}, r.name, h("div", { class: "note" }, r.note)),
            h("td", { class: "mono" }, `${h4(r.start)}-${h4(r.end - 1)}`),
            h("td", {}, `${size / BLOCK} blocks`, h("div", { class: "note" }, `${size} bytes`)),
            h("td", {}, `about ${mmss(readSecs)}`),
            h("td", { class: "tech-buttons" },
                action("Read & save…", () => saveRegion(r)),
                action("Write from file…", async () => {
                    const [f] = await pickFiles(".bin", false);
                    if (f) await writeRegionBytes(r.id, f.bytes);
                }, { "data-never": writeWhy ? "1" : null, title: writeWhy || null })));
    });

    // --- alignment placeholders ---------------------------------------------
    const slider = (/** @type {string} */ label, /** @type {string} */ unit) => h("div", { class: "tech-slider" },
        h("label", {}, label),
        h("input", { type: "range", min: 0, max: 255, value: 128, disabled: true }),
        h("input", { type: "text", value: "", size: 5, disabled: true, placeholder: unit }),
        h("button", { disabled: true }, "Get"), h("button", { disabled: true }, "Set"));

    root = h("div", { class: "tech" },
        h("div", { class: "warn-box" }, "Direct access to the radio's memory. Reads are safe; writes change the radio "
            + "with no codeplug checks, and a wrong value in the MCU EEPROM can stay until written back. "
            + "Save a region before writing it. Firmware and RAM dumps contain Motorola's code: keep them to yourself."),
        section("Connection",
            status,
            h("div", { class: "tech-buttons" }, connectBtn, restartBtn, disconnectBtn),
            note("Each operation leaves the radio waiting, with its control head frozen, so the next one starts at once. "
                + "Restart radio (or Disconnect) restarts it. Read Radio and Write Radio use this connection while it is open."),
            serialHelp(!serialSupported())),
        h("div", { class: "tech-progress" }, progress, h("div", { class: "tech-stage-row" }, stage, cancel)),
        section("Read memory (hex)",
            h("div", { class: "tech-row" },
                h("label", { for: "tech-read-addr" }, "Address"), rdAddr,
                h("label", { for: "tech-read-len" }, "Length"), rdLen,
                rdExt, h("label", { for: "tech-read-ext" }, "S9000e session (8000-9FFF)"),
                hexRead),
            note("Any address 0000-FFFF except the 68HC11 registers (1000-103F), through the codeplug session as RSS reads; "
                + "about 100 bytes a second."),
            out),
        section("Write memory (hex)",
            h("div", { class: "tech-row" },
                h("label", { for: "tech-write-addr" }, "Address"), wrAddr,
                h("label", { for: "tech-write-data" }, "Bytes"), wrData,
                hexWrite),
            note("Up to 256 bytes inside one writable region: RAM 0000-0FFF, codeplug EEPROM 6000-7FFF, MCU EEPROM B600-B7FF. "
                + "The current bytes are read and shown before anything is written, and the result is read back.")),
        section("Memory regions",
            h("table", { class: "tech-regions" },
                h("thead", {}, h("tr", {}, ["Region", "Addresses", "Size", "Read time", ""].map((t) => h("th", {}, t)))),
                h("tbody", {}, regionRows)),
            note("Read & save writes a .bin file of the region. Write from file compares a .bin of the same size with the "
                + "radio and writes only the bytes that differ, after you confirm, then reads them back. "
                + "Firmware is ROM and can't be written.")),
        section("Alignment (not available yet)",
            note("Placeholders: the commands RSS's alignment screens use haven't been found yet "
                + "(notes/RADIO-PROTOCOL.md, Open questions). These controls do nothing until they are."),
            h("fieldset", { class: "tech-align", disabled: true },
                slider("Reference oscillator (warp)", "warp"),
                slider("Deviation (modulation level)", "dev"),
                slider("Power output", "power"),
                h("div", { class: "tech-row" },
                    h("label", {}, "Transmit"), h("button", { disabled: true }, "PTT ON"), h("button", { disabled: true }, "PTT OFF")),
                h("div", { class: "tech-row" },
                    h("label", {}, "Current frequency"),
                    h("input", { type: "text", size: 10, disabled: true, placeholder: "MHz" }),
                    h("button", { disabled: true }, "Get"), h("button", { disabled: true }, "Set")))));

    refresh = () => {
        const c = connection();
        const idle = !!c && !c.busy;
        for (const b of actions) b.disabled = !idle || b.dataset.never === "1";
        /** @type {HTMLButtonElement} */ (connectBtn).disabled = !!c || !serialSupported();
        status.textContent = !c ? "Not connected."
            : `Connected through ${c.name}${radioName ? `: ${radioName}` : ""}. `
                + (c.busy ? "Working…" : c.radio.needsReset ? "The radio is waiting (control head frozen) until it is restarted." : "The radio is running.");
    };
    onConnectionChange(() => refresh?.());
    refresh();
}

/** @type {import("./common.js").Tab} */
export default {
    id: "tech",
    title: "Tech",
    render(el) {
        if (!root) build();
        if (el.firstChild !== root) fill(el, root);
        refresh?.();
    },
};

