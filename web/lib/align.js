// @ts-check
/**
 * Alignment over SB9600: what RSS's SERVICE -> ALIGNMENT screens do. A port
 * of motreader-py/align.py (decoded from RSS traffic and checked on a
 * 617ASN; notes/RADIO-PROTOCOL.md, "Alignment (RSS SERVICE)").
 *
 * A screen puts the radio in a test mode (opcode 0x40) on one of its built-in
 * test frequencies, sends the slider's value live, keys the transmitter with
 * the PTT button message (opcode 0x0a, button 3) and programs the value into
 * the MCU EEPROM, then that block's sum byte, as RSS's F8 PROGRAM VALUE does.
 * Live values last until the radio restarts.
 *
 * PTT safety: key() works only in a test mode that transmits, and a watchdog
 * unkeys before PTT_LIMIT_MS. unkey() sends PTT OFF twice and reads the
 * transmit state back (RAM 0x000d and 0x003b, bit 3 of each, set only while
 * keyed); it retries, and throws PttError if it can't confirm.
 */
import * as sb from "./sb9600.js";
import { SESSION_CODEPLUG, SESSION_MCU, BusError } from "./radio.js";

export const PTT_LIMIT_MS = 10000;   // never key longer (the radio's PA can overheat)
// the watchdog fires this much before the limit (a background tab's timers can run up to 1 s late)
export const PTT_MARGIN_MS = 1200;
export const PTT_ON = Uint8Array.of(0x00, 0x03, 0x01, 0x0A);     // SETBUT button 3 (PTT) pressed
export const PTT_OFF = Uint8Array.of(0x00, 0x03, 0x00, 0x0A);    // released
export const TEST_EXIT = Uint8Array.of(0x01, 0x00, 0x00, 0x40);
/** RAM bits set only while keyed. */
export const TX_FLAGS = [[0x000D, 0x08], [0x003B, 0x08]];
/** RAM showing the receiver's squelch open (the BUSY LED, indicator 0x0a): 0x0031 is 0x0c open / 0 closed, 0x0038 bit 5 set open. */
export const BUSY_FLAGS = [[0x0031, 0xFF], [0x0038, 0x20]];
export const FREQS = /** @type {const} */ (["low", "mid", "high"]);
export const MODEL_ADDR = 0xB675;   // MCU EEPROM: the model number, e.g. "D43KMA7JA5BK"
/**
 * RSS's slider ranges where a model differs from the default (first 3
 * characters of the model). Deviation is 0-12 in RSS on the D43 (VHF), taken
 * as the rule for all models; the D37 (900 MHz, narrowband) shows 0-14.
 * @type {Record<string, Record<string, number>>}
 */
export const MODEL_TOPS = { D37: { deviation: 14 } };

/** @typedef {typeof FREQS[number]} Freq */

/** PTT OFF could not be confirmed: switch the radio off. */
export class PttError extends BusError {}

const sleep = (/** @type {number} */ ms) => new Promise((r) => /** @type {any} */ (globalThis).setTimeout(r, ms));

/** Bit-reverse 7 bits (warp and power are stored and sent this way). */
export const rev7 = (/** @type {number} */ v) => sb.rev8(v & 0x7F) >> 1;

export const testMode = (/** @type {number} */ code) => Uint8Array.of(0x01, code, 0x10, 0x40);

/**
 * @typedef {{
 *   key: string, title: string,
 *   addr: number, block: [number, number], sumAddr: number,
 *   top: number, entry: number, freqs: [number, number, number] | null,
 *   transmits: boolean, liveUnkeyed: boolean, extra: number | null,
 * }} Adjustment
 *   addr: the MCU EEPROM byte F8 programs; block: first and last byte summed
 *   into sumAddr; top: the slider runs 0..top; entry: the test mode on
 *   entering the screen; freqs: the test modes for F2 / F3 / F4; transmits:
 *   F6 TOGGLE PTT; liveUnkeyed: RSS sends the value while not keyed too;
 *   extra: another MCU EEPROM byte the live message needs
 */

/** @type {Adjustment[]} */
export const ADJUSTMENTS = [
    { key: "squelch", title: "DEFAULT SQUELCH", addr: 0xB64F, block: [0xB645, 0xB658], sumAddr: 0xB664,
        top: 15, entry: 0x41, freqs: null, transmits: false, liveUnkeyed: true, extra: null },
    { key: "deviation", title: "TRANSMITTER DEVIATION", addr: 0xB644, block: [0xB644, 0xB644], sumAddr: 0xB663,
        top: 12, entry: 0x42, freqs: [0x42, 0x52, 0x62], transmits: true, liveUnkeyed: false, extra: 0xB645 },
    { key: "warp", title: "REFERENCE OSCILLATOR WARP", addr: 0xB62D, block: [0xB62D, 0xB633], sumAddr: 0xB661,
        top: 127, entry: 0x41, freqs: null, transmits: true, liveUnkeyed: true, extra: null },
    { key: "high_power", title: "TRANSMITTER HIGH POWER", addr: 0xB62F, block: [0xB62D, 0xB633], sumAddr: 0xB661,
        top: 127, entry: 0x11, freqs: [0x41, 0x51, 0x61], transmits: true, liveUnkeyed: true, extra: null },
    { key: "current_limit", title: "POWER AMPLIFIER (PA) CURRENT LIMIT", addr: 0xB62C, block: [0xB600, 0xB62C], sumAddr: 0xB660,
        top: 15, entry: 0x11, freqs: [0x42, 0x52, 0x62], transmits: true, liveUnkeyed: true, extra: 0xB62F },
    { key: "low_power", title: "TRANSMITTER LOW POWER", addr: 0xB62E, block: [0xB62D, 0xB633], sumAddr: 0xB661,
        top: 127, entry: 0x41, freqs: [0x42, 0x52, 0x62], transmits: true, liveUnkeyed: true, extra: null },
];

/** The slider value from the stored byte. */
export function decode(/** @type {Adjustment} */ a, /** @type {number} */ b) {
    if (a.key === "warp") return rev7(b);
    if (a.key === "high_power" || a.key === "low_power") return 127 - rev7(b);
    if (a.key === "current_limit") return (b >> 3) & 0x0F;
    return b;
}

/** The stored byte for slider value v (old: the byte it replaces). */
export function encode(/** @type {Adjustment} */ a, /** @type {number} */ v, /** @type {number} */ old) {
    if (a.key === "warp") return rev7(v);
    if (a.key === "high_power" || a.key === "low_power") return rev7(127 - v);
    if (a.key === "current_limit") return (old & 0x87) | (v << 3);
    return v;
}

/** The messages that set value v in the running radio. @returns {Uint8Array[]} */
export function live(/** @type {Adjustment} */ a, /** @type {number} */ v, /** @type {number | null} */ extra) {
    const x = extra ?? 0;
    switch (a.key) {
    case "squelch": return [Uint8Array.of(0x01, 0x02, v, 0x28)];
    case "deviation": return [Uint8Array.of(0x01, ((v + 1) << 4) & 0xFF, x, 0x32)];
    case "warp": return [Uint8Array.of(0x01, 0x00, rev7(v), 0x43)];
    case "high_power": case "low_power": return [Uint8Array.of(0x01, 0x01, rev7(127 - v), 0x33)];
    // current limit: RSS sends the high power level with it
    default: return [Uint8Array.of(0x01, 0x00, v << 3, 0x42), Uint8Array.of(0x01, 0x01, x, 0x33)];
    }
}

/**
 * One alignment screen at a time on a Radio. Every operation is queued (the
 * watchdog's PTT OFF included), so they never interleave on the bus.
 * leave() unkeys (verified) and leaves test mode; the caller then restarts
 * the radio (radio.finish()).
 */
export class Aligner {
    /**
     * @param {import("./radio.js").Radio} radio
     * @param {{ limitMs?: number, log?: (msg: string) => void, onChange?: () => void }} [opt]
     *   onChange: the PTT state changed (the watchdog, or an error)
     */
    constructor(radio, { limitMs = PTT_LIMIT_MS, log, onChange } = {}) {
        if (!(limitMs > PTT_MARGIN_MS && limitMs <= PTT_LIMIT_MS)) throw new RangeError(`PTT limit is at most ${PTT_LIMIT_MS} ms`);
        this.radio = radio;
        this.limitMs = limitMs;
        this.log = log ?? (() => {});
        this.onChange = onChange ?? (() => {});
        /** @type {Adjustment | null} */
        this.adj = null;
        /** @type {Freq | null} null: the screen's entry test mode */
        this.freq = null;
        this.stored = 0;          // the EEPROM byte as read
        /** @type {number | null} */
        this.extra = null;
        this.value = 0;           // the slider value now
        /** @type {number | null} Date.now() at PTT ON */
        this.keyedAt = null;
        this.keyMs = 0;           // how long the watchdog lets it stay keyed
        /** @type {unknown} from the watchdog */
        this.fault = null;
        /** @type {any} */
        this.timer = null;
        /** @type {Promise<unknown>} */
        this.queue = Promise.resolve();
        /** @type {string | null} read on the first enter() */
        this.model = null;
    }

    /** Run fn after everything queued before it. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
    locked(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => {});
        return run;
    }

    async send(/** @type {Uint8Array} */ payload) {
        await this.radio.link.transact(payload);
    }

    async readMcu(/** @type {number} */ addr, /** @type {number} */ n) {
        return this.radio.session(SESSION_MCU, () => this.radio.read(addr, n, false));
    }

    need() {
        if (!this.adj) throw new Error("no alignment screen open");
        return this.adj;
    }

    /** The slider's top for this radio's model (RSS's range). */
    top(/** @type {Adjustment | null} */ a = null) {
        const adj = a ?? this.need();
        return MODEL_TOPS[(this.model ?? "").slice(0, 3)]?.[adj.key] ?? adj.top;
    }

    testCode() {
        const a = this.need();
        return this.freq === null || !a.freqs ? a.entry : /** @type {number} */ (a.freqs[FREQS.indexOf(this.freq)]);
    }

    /** Open a screen: read its stored value, start its test mode. Resolves with the slider value. */
    enter(/** @type {string} */ key, /** @type {Freq | null} */ freq = null) {
        const a = ADJUSTMENTS.find((x) => x.key === key);
        if (!a) throw new RangeError(`no alignment screen ${key}`);
        if (freq !== null && !a.freqs) throw new RangeError(`${key}: no test frequencies`);
        return this.locked(async () => {
            await this._unkey();
            if (this.model === null) {
                this.model = String.fromCharCode(...(await this.readMcu(MODEL_ADDR, 12))).trim();
            }
            this.stored = /** @type {number} */ ((await this.readMcu(a.addr, 1))[0]);
            this.extra = a.extra === null ? null : /** @type {number} */ ((await this.readMcu(a.extra, 1))[0]);
            this.adj = a;
            this.freq = freq;
            this.value = decode(a, this.stored);
            await this.send(testMode(this.testCode()));
            this.log(`${a.title}: stored ${this.stored.toString(16).padStart(2, "0")} = ${this.value}, `
                + `test mode ${this.testCode().toString(16)}`);
            return this.value;
        });
    }

    /** Change the test frequency (unkeys first, as RSS does). */
    setFreq(/** @type {Freq} */ freq) {
        const a = this.need();
        if (!a.freqs || !FREQS.includes(freq)) throw new RangeError(`${a.key}: no test frequency ${freq}`);
        return this.locked(async () => {
            await this._unkey();
            this.freq = freq;
            await this.send(testMode(this.testCode()));
        });
    }

    /** Set the slider: sent live when RSS would (keyed, or always for squelch, warp and power). */
    set(/** @type {number} */ v) {
        const a = this.need();
        const top = this.top(a);
        if (!(Number.isInteger(v) && v >= 0 && v <= top)) throw new RangeError(`${a.key}: ${v} is outside 0..${top}`);
        return this.locked(async () => {
            this.value = v;
            if (this.keyedAt !== null || a.liveUnkeyed) {
                for (const p of live(a, v, this.extra)) await this.send(p);
            }
        });
    }

    /** PTT ON for ms (capped below the limit). Resolves with the ms until the watchdog unkeys. */
    key(/** @type {number | undefined} */ ms = undefined) {
        const a = this.need();
        if (!a.transmits) throw new Error(`${a.key} does not transmit`);
        if (this.fault) throw this.fault;
        const auto = this.limitMs - PTT_MARGIN_MS;
        const secs = Math.min(ms ?? auto, auto);
        return this.locked(async () => {
            if (this.keyedAt !== null) return this.remainingMs();
            this.keyedAt = Date.now();
            this.keyMs = secs;
            this.timer = /** @type {any} */ (globalThis).setTimeout(() => this.expire(), secs);
            try {
                await this.send(PTT_ON);
                for (const p of live(a, this.value, this.extra)) await this.send(p);
            } catch (e) {
                await this._unkey();
                throw e;
            }
            this.log(`PTT ON (${(secs / 1000).toFixed(1)} s)`);
            this.onChange();
            return secs;
        });
    }

    /** ms until the watchdog unkeys (0 if not keyed). */
    remainingMs() {
        return this.keyedAt === null ? 0 : Math.max(0, this.keyMs - (Date.now() - this.keyedAt));
    }

    expire() {
        this.timer = null;
        this.unkey().then(() => this.log("PTT OFF: time limit"), (e) => {
            this.fault = e;
            this.log(`PTT OFF FAILED: ${e instanceof Error ? e.message : e}`);
            this.onChange();
        });
    }

    /** Read the transmit state from RAM. */
    transmitting() {
        return this.locked(() => this._transmitting());
    }

    async _transmitting() {
        for (const [addr, bit] of TX_FLAGS) {
            if (/** @type {number} */ ((await this.readMcu(/** @type {number} */ (addr), 1))[0]) & /** @type {number} */ (bit)) return true;
        }
        return false;
    }

    /** Whether the squelch is open (the BUSY LED) now. */
    busy() {
        return this.locked(async () => {
            for (const [addr, mask] of BUSY_FLAGS) {
                if (/** @type {number} */ ((await this.readMcu(/** @type {number} */ (addr), 1))[0]) & /** @type {number} */ (mask)) return true;
            }
            return false;
        });
    }

    /**
     * On the squelch screen: the lowest value at which BUSY stays off
     * (`samples` reads after `dwellMs` at each value), left set live (not
     * programmed). Resolves null, with the old value back, if every value is
     * busy (a signal on the test frequency?).
     * @param {{ dwellMs?: number, samples?: number, progress?: (v: number, busy: number, of: number) => void }} [opt]
     */
    async autoSquelch({ dwellMs = 500, samples = 5, progress } = {}) {
        const a = this.need();
        if (a.key !== "squelch") throw new Error("auto squelch needs the squelch screen");
        const start = this.value;
        for (let v = 0; v <= this.top(a); v++) {
            await this.set(v);
            await sleep(dwellMs);
            let open = 0;
            for (let i = 0; i < samples; i++) if (await this.busy()) open++;
            progress?.(v, open, samples);
            if (!open) return v;
        }
        await this.set(start);
        return null;
    }

    /** PTT OFF twice, then read back that the radio isn't transmitting. Safe when not keyed. */
    unkey(tries = 5) {
        return this.locked(() => this._unkey(tries));
    }

    async _unkey(tries = 5) {
        if (this.timer !== null) {
            /** @type {any} */ (globalThis).clearTimeout(this.timer);
            this.timer = null;
        }
        const was = this.keyedAt;
        let last = "";
        for (let i = 0; i < tries; i++) {
            try {
                await this.send(PTT_OFF);
                await this.send(PTT_OFF);
                if (!(await this._transmitting())) {
                    this.keyedAt = null;
                    if (was !== null) {
                        this.log(`PTT OFF (verified) after ${((Date.now() - was) / 1000).toFixed(1)} s`);
                        this.onChange();
                    }
                    return true;
                }
                last = "the radio still reads as transmitting";
            } catch (e) {
                if (!(e instanceof BusError)) throw e;
                last = e.message;
            }
            await sleep(100);
        }
        this.onChange();
        throw new PttError(`PTT OFF not confirmed (${last}): switch the radio off`);
    }

    /**
     * F8 PROGRAM VALUE: write the slider value into the MCU EEPROM and update
     * the block's sum byte, as RSS does; both read back. Unkeys first.
     * Resolves with [old, new] stored bytes, or null if unchanged.
     * @returns {Promise<[number, number] | null>}
     */
    program() {
        const a = this.need();
        return this.locked(async () => {
            await this._unkey();
            const r = this.radio;
            const next = encode(a, this.value, this.stored);
            if (next === this.stored) return null;
            const h2 = (/** @type {number} */ n) => n.toString(16).padStart(2, "0");
            // RSS writes the MCU EEPROM in the codeplug session
            await r.session(SESSION_CODEPLUG, () => r.write(a.addr, Uint8Array.of(next), true));
            if ((await this.readMcu(a.addr, 1))[0] !== next) throw new BusError(`${a.addr.toString(16)} did not read back as ${h2(next)}`);
            const [lo, hi] = a.block;
            const sum = (await this.readMcu(lo, hi - lo + 1)).reduce((s, x) => s + x, 0) & 0xFF;
            await r.session(SESSION_CODEPLUG, () => r.write(a.sumAddr, Uint8Array.of(sum), true));
            if ((await this.readMcu(a.sumAddr, 1))[0] !== sum) throw new BusError(`sum byte ${a.sumAddr.toString(16)} did not read back as ${h2(sum)}`);
            const old = this.stored;
            this.stored = next;
            this.log(`programmed ${a.addr.toString(16)} ${h2(old)} -> ${h2(next)}, sum ${a.sumAddr.toString(16)} = ${h2(sum)}`);
            return /** @type {[number, number]} */ ([old, next]);
        });
    }

    /** Unkey (verified) and leave test mode. */
    leave() {
        return this.locked(async () => {
            await this._unkey();
            if (this.adj) {
                await this.send(TEST_EXIT);
                this.adj = null;
            }
        });
    }
}
