// @ts-check
/**
 * Tech: direct access to the radio over the RIB, without a codeplug open.
 * Read and write any address in hex, save the known memory regions (RAM,
 * firmware, EEPROMs) as binary files and write the EEPROM ones back from
 * files, and RSS's alignment adjustments (lib/align.js), PTT included.
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
import { hex, hexdumpLine, latin1 } from "../../lib/bytes.js";
import {
    REGIONS, BLOCK, HC11_REGISTERS, Cancelled, MODEL, CODEPLUG_BASE, serialOf, modelOf,
    parseHexNumber as parseHex, parseHexWrite, MAX_HEX_WRITE,
} from "../../lib/radio.js";
import { ADJUSTMENTS, Aligner, PttError, FREQS, PTT_LIMIT_MS, PTT_MARGIN_MS, decode, encode } from "../../lib/align.js";

/** The adjustments as the RSS alignment menu lists them. @type {Record<string, string>} */
const ALIGN_LABELS = {
    squelch: "Default squelch (F2)", deviation: "Deviation (F3)", warp: "Reference oscillator warp (F5)",
    high_power: "Transmitter high power (F7)", current_limit: "PA current limit (F7, F9)", low_power: "Transmitter low power (F8)",
};

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
    wrAddr.title = "Hex address of the first byte, with or without 0x: 6000, 0x6000, b600";
    wrData.title = `Hex bytes, two digits each, up to ${MAX_HEX_WRITE}. Spaces or commas between bytes are optional:\n`
        + "  5a 01 ff\n  5A01FF\n  0x5a, 0x01, 0xff\n  5a01 ff00 (groups of pairs)\n"
        + "A lone digit (5) is refused: write 05.";
    const wrMsg = h("p", { class: "field-msg tech-write-msg", "aria-live": "polite" });
    /** Check the Write fields as they're typed: the target range, or what's wrong. */
    function checkWrite() {
        if (!wrAddr.value.trim() && !wrData.value.trim()) {
            wrMsg.textContent = "";
            wrMsg.className = "field-msg tech-write-msg";
            wrAddr.removeAttribute("aria-invalid");
            wrData.removeAttribute("aria-invalid");
            return;
        }
        /** @type {HTMLInputElement | null} */
        let bad = null;
        try {
            const { addr, data, region } = parseHexWrite(wrAddr.value, wrData.value);
            wrMsg.textContent = `${data.length} byte${data.length === 1 ? "" : "s"} at `
                + `${h4(addr)}-${h4(addr + data.length - 1)} (${region.name}): ${hex(data, " ")}`;
            wrMsg.className = "field-msg tech-write-msg";
        } catch (e) {
            const text = errText(e);
            // the field at fault (a range outside the regions: the address); one still blank isn't an error yet
            const field = text.startsWith("Bytes") ? wrData : wrAddr;
            if (field.value.trim()) bad = field;
            wrMsg.textContent = bad ? text : "";
            wrMsg.className = `field-msg tech-write-msg${bad ? " error" : ""}`;
        }
        wrAddr.toggleAttribute("aria-invalid", bad === wrAddr);
        wrData.toggleAttribute("aria-invalid", bad === wrData);
    }
    wrAddr.addEventListener("input", checkWrite);
    wrData.addEventListener("input", checkWrite);

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
            ({ addr, data, region } = parseHexWrite(wrAddr.value, wrData.value));
        } catch (e) {
            return say(errText(e), true);
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

    // --- alignment ----------------------------------------------------------
    /** @type {Aligner | null} */
    let aligner = null;
    /** @type {(() => void) | null} ends the alignment operation */
    let stopAlign = null;
    /** @type {any} the PTT countdown's interval */
    let ticker = null;
    const alMsg = h("p", { class: "note tech-align-msg", "aria-live": "polite" });
    const alSay = (/** @type {string} */ text, warn = false) => {
        alMsg.textContent = text;
        alMsg.className = `${warn ? "warn-box" : "note"} tech-align-msg`;
    };
    const alScreen = /** @type {HTMLSelectElement} */ (h("select", { id: "tech-align-screen" },
        ADJUSTMENTS.map((a) => h("option", { value: a.key }, ALIGN_LABELS[a.key] ?? a.title))));
    const alStart = /** @type {HTMLButtonElement} */ (h("button", { class: "primary", onclick: () => startAlign() }, "Start test mode"));
    const alStop = /** @type {HTMLButtonElement} */ (h("button", { onclick: () => stopAlign?.() }, "Leave test mode"));
    const alRange = /** @type {HTMLInputElement} */ (h("input", { type: "range", id: "tech-align-value", min: 0, max: 15, value: 0 }));
    const alNum = /** @type {HTMLInputElement} */ (h("input", { type: "number", id: "tech-align-num", min: 0, max: 15, value: 0, class: "mono" }));
    const alDown = /** @type {HTMLButtonElement} */ (h("button", { title: "Down arrow in RSS", onclick: () => nudge(-1) }, "−"));
    const alUp = /** @type {HTMLButtonElement} */ (h("button", { title: "Up arrow in RSS", onclick: () => nudge(1) }, "+"));
    const alStored = h("span", { class: "note" });
    const freqInputs = /** @type {HTMLInputElement[]} */ (["default", ...FREQS].map((f) =>
        h("input", { type: "radio", name: "tech-align-freq", id: `tech-align-freq-${f}`, value: f, checked: f === "default" ? true : null })));
    const freqRow = h("div", { class: "tech-row" }, h("label", {}, "Test frequency"),
        freqInputs.flatMap((el) => [el, h("label", { for: el.id }, el.value === "default" ? "As RSS opens it" : `${el.value[0]?.toUpperCase()}${el.value.slice(1)} (F${2 + FREQS.indexOf(/** @type {any} */ (el.value))})`)]));
    const pttOn = /** @type {HTMLButtonElement} */ (h("button", { class: "danger", onclick: () => act((al) => al.key()) }, "PTT ON"));
    const pttOff = /** @type {HTMLButtonElement} */ (h("button", { class: "primary", onclick: () => act((al) => al.unkey()) }, "PTT OFF"));
    const pttState = h("span", { class: "tech-ptt", "aria-live": "polite" });
    const pttRow = h("div", { class: "tech-row" }, h("label", {}, "Transmit"), pttOn, pttOff, pttState);
    const alProgram = /** @type {HTMLButtonElement} */ (h("button", { onclick: () => void programValue() }, "Program value…"));
    const busyState = h("span", { class: "tech-ptt", "aria-live": "polite" });
    const showBusy = (/** @type {boolean} */ b) => {
        busyState.textContent = b ? "BUSY: squelch open" : "Not busy: squelch closed";
        busyState.className = `tech-ptt${b ? " on" : ""}`;
    };
    const busyRead = /** @type {HTMLButtonElement} */ (h("button", { onclick: () => act(async (al) => showBusy(await al.busy())) }, "Read BUSY"));
    const autoSq = /** @type {HTMLButtonElement} */ (h("button", {
        title: "Step up from 0 and stop at the first value where the radio's BUSY stays off (5 reads); not programmed",
        onclick: () => act(async (al) => {
            alSay("Finding the lowest quiet squelch…");
            const v = await al.autoSquelch({ progress: (x, n, of) => alSay(`Squelch ${x}: busy in ${n} of ${of} reads…`) });
            showBusy(await al.busy());
            alSay(v === null ? "BUSY at every value (a signal on the test frequency?): squelch put back."
                : `Lowest quiet squelch: ${v}, set live. Program value keeps it.`);
        }),
    }, "Find lowest quiet value"));
    const busyRow = h("div", { class: "tech-row" }, h("label", {}, "Signal"), busyRead, autoSq, busyState);

    /** Run an aligner call, showing its error; a failed PTT OFF also goes to the log. */
    async function act(/** @type {(al: Aligner) => Promise<unknown>} */ fn) {
        const al = aligner;
        if (!al) return;
        try {
            await fn(al);
            if (alMsg.className.startsWith("warn-box")) alSay("");
        } catch (e) {
            if (e instanceof PttError) log.error(`Tech: ${errText(e)}`);
            alSay(errText(e), true);
        }
        alignRefresh();
    }

    // slider moves arrive faster than the bus takes them: send only the latest
    /** @type {number | null} */
    let pending = null;
    let sending = false;
    async function pushValue(/** @type {number} */ v) {
        pending = v;
        if (sending) return;
        sending = true;
        try {
            while (pending !== null && aligner) {
                const x = pending;
                pending = null;
                await act((al) => al.set(x));
            }
        } finally {
            sending = false;
        }
    }
    function nudge(/** @type {number} */ d) {
        const a = aligner?.adj;
        if (!a || !aligner) return;
        // from the value shown: the last one asked for, even if not sent yet
        const v = Math.max(0, Math.min(aligner.top(a), Number(alNum.value) + d));
        alRange.value = alNum.value = String(v);
        void pushValue(v);
    }
    alRange.addEventListener("input", () => {
        alNum.value = alRange.value;
        void pushValue(Number(alRange.value));
    });
    alNum.addEventListener("change", () => {
        const al = aligner, a = al?.adj;
        const v = Number(alNum.value);
        if (!al || !a || !Number.isInteger(v) || v < 0 || v > al.top(a)) {
            alSay(`The value is a whole number from 0 to ${al && a ? al.top(a) : 0}.`, true);
            alNum.value = String(aligner?.value ?? 0);
            return;
        }
        alRange.value = String(v);
        void pushValue(v);
    });
    alScreen.addEventListener("change", () => {
        if (!aligner) return;
        for (const el of freqInputs) el.checked = el.value === "default";
        void act((al) => al.enter(alScreen.value));
    });
    for (const el of freqInputs) {
        el.addEventListener("change", () => {
            if (el.checked && el.value !== "default") void act((al) => al.setFreq(/** @type {any} */ (el.value)));
            else if (el.checked) void act((al) => al.enter(alScreen.value));
        });
    }

    /** Hold the connection in test mode until Leave test mode; then PTT OFF, test mode off, restart. */
    function startAlign() {
        if (!connection() || aligner) return;
        for (const el of freqInputs) el.checked = el.value === "default";
        alSay("Starting test mode…");
        withRadio(async (radio) => {
            const al = new Aligner(radio, { log: (m) => log.info(`Tech: ${m}`), onChange: () => alignRefresh() });
            aligner = al;
            refresh?.();
            try {
                await al.enter(alScreen.value);
                alSay("In test mode. Changes are live; Program value writes one into the radio.");
                alignRefresh();
                await new Promise((resolve) => { stopAlign = () => resolve(undefined); });
            } finally {
                stopAlign = null;
                try {
                    await al.leave();
                } finally {
                    aligner = null;
                    refresh?.();
                }
            }
        }).then(() => alSay("Test mode left; the radio is restarting (live values are dropped)."),
            (e) => {
                if (e instanceof PttError) log.error(`Tech: ${errText(e)}`);
                alSay(`Alignment stopped: ${errText(e)}`, true);
            });
    }

    async function programValue() {
        const al = aligner, a = al?.adj;
        if (!al || !a) return;
        const next = encode(a, al.value, al.stored);
        const h2 = (/** @type {number} */ n) => n.toString(16).padStart(2, "0");
        if (next === al.stored) return alSay(`The radio already holds ${al.value}: nothing to program.`);
        const ok = await confirmModal(`Program ${ALIGN_LABELS[a.key] ?? a.title}?`, h("div", {},
            h("p", {}, `Write ${al.value} into the radio, in place of ${decode(a, al.stored)} `
                + `(MCU EEPROM ${h4(a.addr)}: ${h2(al.stored)} → ${h2(next)}, then its block sum at ${h4(a.sumAddr)}), as RSS's F8 PROGRAM VALUE does.`),
            h("p", { class: "warn-box" }, "This is the radio's alignment: it stays until programmed again. "
                + `Note the old value (${decode(a, al.stored)}).`)), "Program");
        if (!ok) return alSay("Nothing was programmed.");
        await act(async (x) => {
            const r = await x.program();
            alSay(r ? `Programmed ${x.value}; it reads back correctly.` : "Unchanged: nothing written.");
        });
    }

    function alignRefresh() {
        const al = aligner, a = al?.adj ?? null;
        const c = connection();
        alStart.disabled = !!al || !c || c.busy;
        alStop.disabled = !al;
        alScreen.disabled = !!c?.busy && !al;
        const on = !!a;
        for (const el of [alRange, alNum, alDown, alUp, alProgram]) el.disabled = !on;
        for (const el of freqInputs) el.disabled = !on || !a?.freqs;
        freqRow.hidden = on && !a?.freqs;
        const keyed = al?.keyedAt !== null && al?.keyedAt !== undefined;
        pttOn.disabled = !on || !a?.transmits || keyed;
        pttOff.disabled = !al;
        pttRow.hidden = on && !a?.transmits;
        busyRow.hidden = a?.key !== "squelch";
        busyRead.disabled = autoSq.disabled = !on;
        if (a?.key !== "squelch") busyState.textContent = "";
        if (a && al) {
            alRange.max = alNum.max = String(al.top(a));
            if (pending === null && !sending) alRange.value = alNum.value = String(al.value);
            alStored.textContent = `0 to ${al.top(a)}${al.model ? ` (${al.model})` : ""}. In the radio: ${decode(a, al.stored)}`
                + (al.value !== decode(a, al.stored) ? `; live now: ${al.value} (not programmed)` : "");
        } else {
            alStored.textContent = "";
        }
        if (keyed && !ticker) ticker = setInterval(tick, 100);
        if (!keyed && ticker) {
            clearInterval(ticker);
            ticker = null;
        }
        tick();
    }
    function tick() {
        const al = aligner;
        const keyed = al?.keyedAt !== null && al?.keyedAt !== undefined;
        pttState.textContent = !al ? "" : al.fault ? "PTT OFF FAILED: switch the radio off"
            : keyed ? `TRANSMITTING: off in ${(al.remainingMs() / 1000).toFixed(1)} s` : "Not transmitting";
        pttState.className = `tech-ptt${keyed || al?.fault ? " on" : ""}`;
    }
    // leaving the page while keyed: unkey (the dialog gives the message time to go out)
    addEventListener("beforeunload", (e) => {
        if (aligner?.keyedAt === null || !aligner) return;
        void aligner.unkey();
        e.preventDefault();
    });
    addEventListener("pagehide", () => void aligner?.unkey());

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
                h("label", { for: "tech-write-addr", title: wrAddr.title }, "Address"), wrAddr,
                h("label", { for: "tech-write-data", title: wrData.title }, "Bytes"), wrData,
                hexWrite),
            wrMsg,
            note("Hex throughout: an address like 6000 or 0x6000, bytes like 5a 01 ff, 5A01FF or 0x5a,0x01,0xff "
                + "(hover a field for more). Up to 256 bytes inside one writable region: RAM 0000-0FFF, codeplug EEPROM 6000-7FFF, MCU EEPROM B600-B7FF. "
                + "The current bytes are read and shown before anything is written, and the result is read back.")),
        section("Memory regions",
            h("table", { class: "tech-regions" },
                h("thead", {}, h("tr", {}, ["Region", "Addresses", "Size", "Read time", ""].map((t) => h("th", {}, t)))),
                h("tbody", {}, regionRows)),
            note("Read & save writes a .bin file of the region. Write from file compares a .bin of the same size with the "
                + "radio and writes only the bytes that differ, after you confirm, then reads them back. "
                + "Firmware is ROM and can't be written.")),
        section("Alignment",
            h("div", { class: "warn-box" }, "These are RSS's SERVICE → ALIGNMENT adjustments. PTT ON transmits into whatever is on the "
                + `antenna jack: use a dummy load. PTT switches off by itself after ${(PTT_LIMIT_MS - PTT_MARGIN_MS) / 1000} s `
                + `(never more than ${PTT_LIMIT_MS / 1000}); PTT OFF is sent twice and read back from the radio.`),
            h("div", { class: "tech-align" },
                h("div", { class: "tech-row" },
                    h("label", { for: "tech-align-screen" }, "Adjustment"), alScreen, alStart, alStop),
                h("div", { class: "tech-slider" },
                    h("label", { for: "tech-align-value" }, "Value"), alRange, alDown, alNum, alUp),
                h("div", { class: "tech-row" }, alStored),
                freqRow,
                pttRow,
                busyRow,
                h("div", { class: "tech-row" }, alProgram),
                alMsg),
            note("Start test mode puts the radio on a test frequency, as RSS's screen does. Moving the value changes the "
                + "running radio (deviation only while transmitting, as in RSS); Program value writes it into the radio's "
                + "MCU EEPROM with its block sum. Leave test mode restarts the radio, which drops values not programmed. "
                + "The test frequencies are the radio's own three (its display shows the frequency's digits, e.g. "
                + "350125); other frequencies can't be chosen yet. Squelch doesn't transmit; on its screen, Find lowest quiet value "
                + "steps up from 0 to the first value where the radio's BUSY stays off.")));

    refresh = () => {
        const c = connection();
        const idle = !!c && !c.busy;
        for (const b of actions) b.disabled = !idle || b.dataset.never === "1";
        /** @type {HTMLButtonElement} */ (connectBtn).disabled = !!c || !serialSupported();
        status.textContent = !c ? "Not connected."
            : `Connected through ${c.name}${radioName ? `: ${radioName}` : ""}. `
                + (aligner ? "In alignment test mode." : c.busy ? "Working…"
                    : c.radio.needsReset ? "The radio is waiting (control head frozen) until it is restarted." : "The radio is running.");
        alignRefresh();
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

