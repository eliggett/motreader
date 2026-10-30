// @ts-check
/**
 * Read and program a Spectra over a RIB, the way RSS does: a port of
 * motreader-py/radio.py (see notes/RADIO-PROTOCOL.md). Pure: the serial port
 * is behind a link object, so the tests drive a simulated radio.
 *
 * A link has `transact(payload) -> Promise<Uint8Array | null>`: send one
 * 4-byte payload (the link adds the CRC) and resolve with the 5-byte reply,
 * or null for a message that has none. It throws BusError when the radio
 * doesn't answer. web/app/serial.js is the Web Serial one.
 */
import * as sb from "./sb9600.js";
import { latin1, equal, concat } from "./bytes.js";
import { BANNER_LONG, sealArchive } from "./archive.js";

export const CODEPLUG_BASE = 0x6000;
export const BLOCK = 0x100;
/** The codeplug EEPROM is 8 KB (0x6000-0x7FFF). */
export const EEPROM_SIZE = 0x2000;
/** Header offsets of the serial number ("617ASQ1266") and model. */
export const SERIAL = [0x1D, 0x27];
export const MODEL = [0x44, 0x58];

/** @typedef {[[number, number], [number, number]]} Session  MODE (open, close) payloads */

/** @type {Session} */
export const SESSION_CODEPLUG = [[0xD1, 0x01], [0x90, 0x01]];
/** @type {Session} */
export const SESSION_MCU = [[0x93, 0x01], [0x92, 0x01]];
/**
 * S9000e (A9 head) radios: a second 8 KB codeplug region at 0x8000, in its
 * own unscrambled session, three bytes per read (traced from RSS against the
 * fake radio; not yet seen on a real S9000e radio).
 * @type {Session}
 */
export const SESSION_EXT = [[0xB1, 0x05], [0x90, 0x05]];
export const EXT_BASE = 0x8000;
export const EXT_SIZE = 0x2000;
/** RSS ends every READ and PROGRAM with this. */
export const MODE_DONE = [0x10, 0x01];

/** MCU bytes RSS reads during READ: b675.. starts the model ("D43"), b69f.. unknown. */
export const MCU_PROBES = [[0xB675, 3], [0xB69F, 4]];
/** ROM pointer (codeplug session) to the option block in MCU EEPROM; its first 6 bytes go in the archive prefix. */
export const OPTIONS_POINTER = 0xFFC6;
export const OPTIONS_LEN = 16;
/** RSS writes this MCU EEPROM byte after programming (0x39 on every radio seen); we only check it. */
export const PROGRAMMED_FLAG = [0xB6A0, 0x39];
/** How long programVerified waits for the radio to restart before reading it back. */
export const RESTART_MS = 10000;
/** Offset of the codeplug in the decrypted archive body; prefix bytes 13..18 are the options. */
export const BODY_CODEPLUG = 0xAD;

export class BusError extends Error {
    name = "BusError";
}

export class ProgramRefused extends Error {
    name = "ProgramRefused";
}

/** Radio.cancel() was called: the operation stopped between two messages. */
export class Cancelled extends Error {
    name = "Cancelled";
}

/**
 * Known regions of the radio's 64 KB address space (68HC11 map, from a real
 * 617ASQ dump; notes/RADIO-PROTOCOL.md). All are read in the codeplug
 * session except the S9000e region. `writable`: EEPROM (RSS writes the MCU
 * EEPROM through the codeplug session too) and RAM; the firmware is ROM.
 * @typedef {{ id: string, name: string, start: number, end: number, session: "codeplug" | "ext", writable: boolean, note: string }} Region
 * @type {Region[]}
 */
export const REGIONS = [
    { id: "ram", name: "RAM", start: 0x0000, end: 0x1000, session: "codeplug", writable: true,
        note: "live state; anything written is lost when the radio restarts" },
    { id: "firmware_low", name: "Code below the codeplug", start: 0x1100, end: 0x6000, session: "codeplug", writable: false,
        note: "code and tables" },
    { id: "codeplug_eeprom", name: "Codeplug EEPROM", start: 0x6000, end: 0x8000, session: "codeplug", writable: true,
        note: "all 8 KB: the codeplug and the unused rest" },
    { id: "firmware", name: "Firmware ROM", start: 0x8000, end: 0x10000, session: "codeplug", writable: false,
        note: "includes the MCU EEPROM window at 0xB600" },
    { id: "mcu_eeprom", name: "MCU EEPROM", start: 0xB600, end: 0xB800, session: "codeplug", writable: true,
        note: "serial, model, option block, alignment candidates" },
    { id: "codeplug_ext", name: "S9000e codeplug region", start: EXT_BASE, end: EXT_BASE + EXT_SIZE, session: "ext", writable: true,
        note: "S9000e (A9 head) radios only; untested on a real radio" },
];

/** 68HC11 registers: some reads have side effects (serial port flags), so they are never read. */
export const HC11_REGISTERS = [0x1000, 0x1040];

/** The writable region (codeplug session) holding all of [start, end), or undefined. */
export const writableRegion = (/** @type {number} */ start, /** @type {number} */ end) =>
    REGIONS.find((r) => r.session === "codeplug" && r.writable && start >= r.start && end <= r.end);

// setTimeout is in every host this runs in (page, Node) but not in plain ECMAScript
const sleep = (/** @type {number} */ ms) => new Promise((r) => /** @type {any} */ (globalThis).setTimeout(r, ms));
const sub = (/** @type {Uint8Array} */ b, /** @type {number[]} */ [s, e]) => b.subarray(s, e);
const hex = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * S9000e / A9 head (header 0x60 bit 5 clear): the codeplug continues in the
 * 0x8000 region.
 */
export const hasExtRegion = (/** @type {Uint8Array} */ cp) => !(/** @type {number} */ (cp[0x60]) & 0x20);

/** Codeplug size from its header byte 0x1C: (k - 4) * 32, rounded up to whole blocks. */
export function codeplugLength(/** @type {Uint8Array} */ header) {
    const n = (/** @type {number} */ (header[0x1C]) - 4) * 32;
    return Math.ceil(n / BLOCK) * BLOCK;
}

/** The radio's serial number and model as text, from a codeplug header. */
export const serialOf = (/** @type {Uint8Array} */ cp) => latin1(sub(cp, SERIAL));
/** The model as the app shows it ("D43KMA7JA5BK" from " 503D43KMA7JA5BK    "). */
export function modelOf(/** @type {Uint8Array} */ cp) {
    const text = latin1(sub(cp, MODEL));
    return /[DT]\d{2}[A-Z0-9]{9}/.exec(text)?.[0] ?? text.trim();
}

/**
 * @typedef {{
 *   codeplug: Uint8Array,               // EEPROM from 0x6000 (plus the S9000e region)
 *   mcu: Map<number, Uint8Array>,       // address -> bytes
 *   options: Uint8Array,                // the option block
 * }} ReadResult
 */

/**
 * The decrypted archive body as RSS saves it: 13-byte nonce, the option
 * block's first 6 bytes, zeros to 0xAD, then the codeplug.
 */
export function archiveBody(/** @type {ReadResult} */ r, /** @type {Uint8Array | undefined} */ nonce = undefined) {
    const prefix = new Uint8Array(BODY_CODEPLUG);
    prefix.set(nonce ?? Uint8Array.from({ length: 13 }, () => Math.floor(Math.random() * 256)));   // RSS's nonce isn't secret either
    prefix.set(r.options.subarray(0, 6), 13);
    return concat(prefix, r.codeplug);
}

/** A read as an archive file, and RSS's name for it ("A617ASQ1.266"). */
export function archiveFile(/** @type {ReadResult} */ r) {
    const serial = serialOf(r.codeplug);
    return { name: `A${serial.slice(0, 7)}.${serial.slice(7)}`, bytes: sealArchive(BANNER_LONG, archiveBody(r)) };
}

/** What program() writes, from a decrypted archive body. */
export function imageFromBody(/** @type {Uint8Array} */ body) {
    return { image: body.slice(BODY_CODEPLUG), options: body.slice(13, 19) };
}

/**
 * @typedef {(done: number, total: number) => void} Progress
 * @typedef {{ transact: (payload: Uint8Array) => Promise<Uint8Array | null> }} Link
 */

export class Radio {
    /** @param {Link} link */
    constructor(link) {
        this.link = link;
        // a session was opened since the last MODE_DONE: the radio's panel
        // stays frozen until it gets MODE_DONE (which restarts it)
        this.needsReset = false;
        this.stopping = false;
    }

    /** Stop the running read or verify at the next message (it throws Cancelled). */
    cancel() {
        this.stopping = true;
    }

    /** Throw Cancelled if cancel() was called; a new operation starts uncancelled. */
    checkCancel() {
        if (!this.stopping) return;
        this.stopping = false;
        throw new Cancelled("cancelled");
    }

    /** Wait for the radio to restart after MODE_DONE (cancellable). */
    async waitRestart(ms = RESTART_MS) {
        for (const end = Date.now() + ms; Date.now() < end;) {
            this.checkCancel();
            await sleep(Math.min(100, end - Date.now()));
        }
    }

    /** Send a MODE message. */
    async mode(/** @type {number} */ b1, /** @type {number} */ b2) {
        await this.link.transact(Uint8Array.of(0x00, b1, b2, sb.OP_MODE));
        this.needsReset = b1 !== MODE_DONE[0] || b2 !== MODE_DONE[1];
    }

    /**
     * Send MODE_DONE (the radio restarts) if a session was opened since the
     * last one. Safe to call after an error: never throws.
     */
    async finish() {
        this.stopping = false;
        if (!this.needsReset) return;
        try {
            await this.mode(MODE_DONE[0], MODE_DONE[1]);
        } catch { /* the bus is gone: nothing more to do */ }
    }

    /**
     * Run `fn` inside a session; the session is closed even if `fn` throws.
     * @template T @param {Session} which @param {() => Promise<T>} fn @returns {Promise<T>}
     */
    async session(which, fn) {
        const [[o1, o2], [c1, c2]] = which;
        await this.mode(o1, o2);
        try {
            return await fn();
        } finally {
            await this.mode(c1, c2);
        }
    }

    /**
     * Read n bytes from addr in the current session, perMsg bytes per message
     * (1 or 2; 3 only unscrambled, where reply byte 0 is the third byte),
     * chaining the scramble like RSS.
     */
    async read(/** @type {number} */ addr, /** @type {number} */ n, /** @type {boolean} */ scrambled, perMsg = 2) {
        const out = [];
        let chain = 0;
        while (out.length < n) {
            this.checkCancel();
            const hi = (addr >> 8) & 0xFF, lo = addr & 0xFF;
            let p;
            if (scrambled) {
                p = sb.scramble(hi, lo, chain);
                chain = p[2];
            } else {
                p = [hi, lo, 0];
            }
            const r = await this.link.transact(Uint8Array.of(...p, sb.OP_READ));
            if (!r || r[3] !== sb.OP_READ_REPLY) {
                throw new BusError(`bad reply to read ${addr.toString(16).padStart(4, "0")}: ${r ? hex(r) : "none"}`);
            }
            const [r0, r1, r2] = /** @type {[number, number, number]} */ ([r[0], r[1], r[2]]);
            const [d1, d0] = scrambled ? sb.unscrambleReply(r0, r1, r2) : [r1, r2];
            out.push(d0);
            if (perMsg >= 2) out.push(d1);
            if (perMsg === 3) out.push(r0);
            addr += perMsg;
        }
        return Uint8Array.from(out.slice(0, n));
    }

    /** Write bytes one per message (opcode 0x07, no reply). */
    async write(/** @type {number} */ addr, /** @type {Uint8Array} */ data, /** @type {boolean} */ scrambled,
        /** @type {((i: number) => void) | undefined} */ each = undefined) {
        for (let i = 0; i < data.length; i++) {
            const a = addr + i, v = /** @type {number} */ (data[i]);
            const hi = (a >> 8) & 0xFF, lo = a & 0xFF;
            const p = scrambled ? sb.scramble(hi, lo, v) : [hi, lo, v];
            await this.link.transact(Uint8Array.of(...p, sb.OP_WRITE));
            each?.(i + 1);
        }
    }

    /** The codeplug, block by block (and the S9000e region). */
    async readCodeplug(/** @type {Progress | undefined} */ progress = undefined) {
        const probe = await this.session(SESSION_CODEPLUG, () => this.read(CODEPLUG_BASE + 0x38, 3, true, 1));
        const per = probe[1] === 0x28 ? 1 : 2;      // RSS's probe
        const head = await this.session(SESSION_CODEPLUG, () => this.read(CODEPLUG_BASE, BLOCK, true, per));
        if (latin1(head.subarray(0, 18)) !== "COPYRIGHT MOTOROLA") {
            throw new BusError(`codeplug header not found at 0x6000: ${hex(head.subarray(0, 32))}`);
        }
        const total = codeplugLength(head);
        const ext = hasExtRegion(head);
        const grand = total + (ext ? EXT_SIZE : 0);
        const parts = [head];
        let done = BLOCK;
        progress?.(done, grand);
        for (let a = CODEPLUG_BASE + BLOCK; a < CODEPLUG_BASE + total; a += BLOCK) {
            parts.push(await this.session(SESSION_CODEPLUG, () => this.read(a, BLOCK, true, per)));
            progress?.((done += BLOCK), grand);
        }
        if (ext) {
            await this.session(SESSION_EXT, async () => {
                for (let a = EXT_BASE; a < EXT_BASE + EXT_SIZE; a += BLOCK) {
                    parts.push(await this.read(a, BLOCK, false, 3));
                    progress?.((done += BLOCK), grand);
                }
            });
        }
        return concat(...parts);
    }

    async readMcu() {
        /** @type {Map<number, Uint8Array>} */
        const out = new Map();
        for (const [addr, n] of MCU_PROBES) {
            out.set(/** @type {number} */ (addr), await this.session(SESSION_MCU, () => this.read(/** @type {number} */ (addr), /** @type {number} */ (n), false, 1)));
        }
        return out;
    }

    /** @returns {Promise<[number, Uint8Array]>} the option block's address and bytes */
    async readOptions() {
        const ptr = await this.session(SESSION_CODEPLUG, () => this.read(OPTIONS_POINTER, 2, true, 1));
        const addr = (/** @type {number} */ (ptr[0]) << 8) | /** @type {number} */ (ptr[1]);
        return [addr, await this.session(SESSION_MCU, () => this.read(addr, OPTIONS_LEN, false, 1))];
    }

    /** Everything RSS's READ reads. @returns {Promise<ReadResult>} */
    async readAll(/** @type {Progress | undefined} */ progress = undefined, finish = true) {
        const mcu = await this.readMcu();
        const [addr, options] = await this.readOptions();
        mcu.set(addr, options);
        const codeplug = await this.readCodeplug(progress);
        if (finish) await this.mode(MODE_DONE[0], MODE_DONE[1]);
        return { codeplug, mcu, options };
    }

    /**
     * Check that `image` can go on this radio, without writing anything:
     * the image as it would be written (a clone gets this radio's serial).
     * Throws ProgramRefused unless the model matches, the serial matches (or
     * `clone`), the control head type matches and the image fits the codeplug
     * EEPROM; with `clone`, the archive's options must match the radio's
     * ("Target Radio has different features") unless `ignoreFeatures`.
     * @param {Uint8Array} image
     * @param {{ clone?: boolean, options?: Uint8Array, ignoreFeatures?: boolean }} [opt]
     */
    async check(image, { clone = false, options, ignoreFeatures = false } = {}) {
        const head = await this.session(SESSION_CODEPLUG, () => this.read(CODEPLUG_BASE, 0x62, true));
        if (latin1(head.subarray(0, 18)) !== "COPYRIGHT MOTOROLA") throw new ProgramRefused("radio codeplug header not recognised");
        if (!equal(sub(head, MODEL), sub(image, MODEL))) {
            throw new ProgramRefused(`model differs: radio ${modelOf(head)}, codeplug ${modelOf(image)}`);
        }
        if (!equal(sub(head, SERIAL), sub(image, SERIAL))) {
            if (!clone) {
                throw new ProgramRefused(`serial number differs: radio ${serialOf(head)}, codeplug ${serialOf(image)} `
                    + "(clone to program it anyway)");
            }
            image = image.slice();
            image.set(sub(head, SERIAL), SERIAL[0]);
        }
        const ext = hasExtRegion(image);
        if (ext !== hasExtRegion(head)) throw new ProgramRefused("control head differs: one is S9000e (A9), the other is not");
        const main = ext ? image.subarray(0, image.length - EXT_SIZE) : image;
        if (main.length > EEPROM_SIZE || main.length % BLOCK) {
            throw new ProgramRefused(`codeplug length 0x${main.length.toString(16)} does not fit the 8 KB codeplug EEPROM`);
        }
        if (Math.abs(codeplugLength(main) - main.length) > BLOCK) {   // 604AUN: one block off
            throw new ProgramRefused(`codeplug length 0x${image.length.toString(16)} disagrees with its header `
                + `(0x${codeplugLength(main).toString(16)}${ext ? " + 0x2000" : ""})`);
        }
        if (clone && !ignoreFeatures) {
            const [, radioOptions] = await this.readOptions();
            if (!options || !equal(radioOptions.subarray(0, 6), options.subarray(0, 6))) {
                throw new ProgramRefused(`the radio has different features: radio options ${hex(radioOptions.subarray(0, 6))}, `
                    + `codeplug ${options ? hex(options.subarray(0, 6)) : "unknown"}`);
            }
        }
        const flag = await this.session(SESSION_MCU, () => this.read(/** @type {number} */ (PROGRAMMED_FLAG[0]), 1, false, 1));
        if (flag[0] !== PROGRAMMED_FLAG[1]) {
            throw new ProgramRefused(`MCU byte b6a0 is ${hex(flag)}, not 39: not seen on a radio before`);
        }
        return image;
    }

    /**
     * Write a codeplug image (EEPROM from 0x6000) as RSS does, after
     * check(): in one codeplug session, 0x6000 = 0xFF, then every byte from
     * 0x6000 in order; the S9000e region in its own session; then a reset.
     * Resolves with the image written. Callers should keep a backup read and
     * verify by reading back (programVerified does).
     * @param {Uint8Array} image
     * @param {{ clone?: boolean, options?: Uint8Array, ignoreFeatures?: boolean, progress?: Progress }} [opt]
     */
    async program(image, opt = {}) {
        image = await this.check(image, opt);
        const ext = hasExtRegion(image);
        const main = ext ? image.subarray(0, image.length - EXT_SIZE) : image;
        const extra = ext ? image.subarray(image.length - EXT_SIZE) : new Uint8Array(0);
        if (ext) await this.probeExtWritable();
        const each = (/** @type {number} */ base) => (/** @type {number} */ i) => {
            if (i % 16 === 0 || base + i === image.length) opt.progress?.(base + i, image.length);
        };
        await this.session(SESSION_CODEPLUG, async () => {
            await this.write(CODEPLUG_BASE, Uint8Array.of(0xFF), true);
            await this.write(CODEPLUG_BASE, main, true, each(0));
            if (!equal(await this.read(CODEPLUG_BASE, 2, true), main.subarray(0, 2))) {
                throw new BusError("header byte did not read back after programming");
            }
        });
        if (ext) await this.session(SESSION_EXT, () => this.write(EXT_BASE, extra, false, each(main.length)));
        await this.mode(MODE_DONE[0], MODE_DONE[1]);
        return image;
    }

    /** RSS's check that the 0x8000 region is writable EEPROM: flip its first byte and put it back. */
    async probeExtWritable() {
        const ok = await this.session(SESSION_EXT, async () => {
            const v = /** @type {number} */ ((await this.read(EXT_BASE, 1, false, 1))[0]);
            await this.write(EXT_BASE, Uint8Array.of(v ^ 0xFF), false);
            const back = (await this.read(EXT_BASE, 1, false, 1))[0];
            await this.write(EXT_BASE, Uint8Array.of(v), false);
            return back === (v ^ 0xFF);
        });
        if (!ok) throw new ProgramRefused("the 0x8000 region is not writable (no S9000e codeplug EEPROM?)");
    }

    /**
     * After program(): wait for the restart, read the whole radio back and
     * compare (ends with MODE_DONE, so the radio restarts again).
     * Cancellable with cancel().
     * @param {Uint8Array} image  as program() returned it
     * @param {{ progress?: Progress, restartMs?: number }} [opt]
     * @returns {Promise<ReadResult>}
     */
    async verify(image, opt = {}) {
        await this.waitRestart(opt.restartMs);
        const back = await this.readAll(opt.progress);
        if (!equal(back.codeplug, image)) {
            const bad = [];
            for (let i = 0; i < image.length; i++) if (back.codeplug[i] !== image[i]) bad.push(i);
            const first = bad.length ? `first 0x${(CODEPLUG_BASE + /** @type {number} */ (bad[0])).toString(16)}` : `length ${back.codeplug.length}`;
            throw new BusError(`verify failed at ${bad.length} bytes, ${first}`);
        }
        return back;
    }

    /**
     * program(), then verify().
     * @param {Uint8Array} image
     * @param {{ clone?: boolean, options?: Uint8Array, ignoreFeatures?: boolean, progress?: Progress, verifyProgress?: Progress, restartMs?: number }} [opt]
     * @returns {Promise<ReadResult>}
     */
    async programVerified(image, opt = {}) {
        image = await this.program(image, opt);
        return this.verify(image, { progress: opt.verifyProgress, restartMs: opt.restartMs });
    }

    /**
     * Read [start, end) of the address space, a session per 0x100-byte block
     * (as RSS reads), two bytes per message; in the S9000e region with
     * `session` "ext", three. Never reads the 68HC11 registers.
     * @param {number} start @param {number} end
     * @param {{ session?: "codeplug" | "ext", progress?: Progress }} [opt]
     */
    async readRange(start, end, { session = "codeplug", progress } = {}) {
        if (start < HC11_REGISTERS[1] && end > HC11_REGISTERS[0]) {
            throw new RangeError("0x1000-0x103F are the 68HC11's registers: reading them can upset the radio");
        }
        const out = new Uint8Array(end - start);
        for (let a = start; a < end;) {
            const n = Math.min(BLOCK - (a % BLOCK), end - a);
            const part = session === "ext"
                ? await this.session(SESSION_EXT, () => this.read(a, n, false, 3))
                : await this.session(SESSION_CODEPLUG, () => this.read(a, n, true));
            out.set(part, a - start);
            a += n;
            progress?.(a - start, end - start);
        }
        return out;
    }

    /**
     * Write bytes at addr in one session: scrambled in the codeplug session
     * (as RSS writes both the codeplug and the MCU EEPROM), or plain in the
     * S9000e region. Not cancellable: a write stopped half-way is worse.
     * @param {number} addr @param {Uint8Array} data
     * @param {{ session?: "codeplug" | "ext", progress?: Progress }} [opt]
     */
    async writeRange(addr, data, { session = "codeplug", progress } = {}) {
        const each = (/** @type {number} */ i) => {
            if (i % 16 === 0 || i === data.length) progress?.(i, data.length);
        };
        if (session === "ext") await this.session(SESSION_EXT, () => this.write(addr, data, false, each));
        else await this.session(SESSION_CODEPLUG, () => this.write(addr, data, true, each));
    }
}
