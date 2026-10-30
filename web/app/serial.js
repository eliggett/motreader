// @ts-check
/**
 * An SB9600 link over a RIB on a Web Serial port (Chrome and Edge), the
 * browser twin of motreader-py/radio.py's SerialLink.
 *
 * Wiring (RSS's RIB cable): DTR drives the SB9600 BUSY line, BUSY comes back
 * on CTS (tied to RI), and every byte sent is echoed by the bus. A message is
 * written as one burst: the radio ignores one whose bytes are spread out.
 * Timeouts are generous because the browser can't make a USB adapter
 * low-latency.
 */
import { BusError } from "../lib/radio.js";
import * as sb from "../lib/sb9600.js";

/**
 * The bits of the Web Serial API used here (not in TypeScript's DOM types yet).
 * @typedef {{
 *   open: (o: { baudRate: number, dataBits?: number, stopBits?: number, parity?: string, flowControl?: string, bufferSize?: number }) => Promise<void>,
 *   close: () => Promise<void>,
 *   setSignals: (s: { dataTerminalReady?: boolean, requestToSend?: boolean }) => Promise<void>,
 *   getSignals: () => Promise<{ clearToSend: boolean, ringIndicator: boolean, dataSetReady: boolean, dataCarrierDetect: boolean }>,
 *   getInfo: () => { usbVendorId?: number, usbProductId?: number },
 *   readable: ReadableStream<Uint8Array>,
 *   writable: WritableStream<Uint8Array>,
 * }} SerialPort
 */

/** @returns {{ requestPort: (o?: object) => Promise<SerialPort>, getPorts: () => Promise<SerialPort[]> } | undefined} */
const serialApi = () => /** @type {any} */ (navigator).serial;

/** Does this browser have Web Serial (Chrome / Edge 89+, on https or localhost)? */
export const serialSupported = () => !!serialApi();

/** Ask the user to pick a port (needs a click just before). */
export async function requestPort() {
    const api = serialApi();
    if (!api) throw new Error("this browser has no Web Serial");
    return api.requestPort();
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const hex = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Describe a port for the log ("USB 0403:6001"). */
export function portName(/** @type {SerialPort} */ port) {
    const i = port.getInfo();
    const h4 = (/** @type {number | undefined} */ n) => (n ?? 0).toString(16).padStart(4, "0");
    return i.usbVendorId === undefined ? "serial port" : `USB ${h4(i.usbVendorId)}:${h4(i.usbProductId)}`;
}

export class WebSerialLink {
    /**
     * @param {SerialPort} port  not yet open
     * @param {{ echoTimeout?: number, replyTimeout?: number, busyTimeout?: number, tries?: number, invertBusy?: boolean, log?: (s: string) => void }} [opt]
     *   times in ms; `log` hears about retries
     */
    constructor(port, opt = {}) {
        this.port = port;
        // USB adapters without low latency hold bytes up to 16 ms each way
        this.echoTimeout = opt.echoTimeout ?? 300;
        this.replyTimeout = opt.replyTimeout ?? 600;
        this.busyTimeout = opt.busyTimeout ?? 2000;
        this.tries = opt.tries ?? 10;
        // some RIB cables invert BUSY (RadioConsole2 has the same option)
        this.invertBusy = opt.invertBusy ?? false;
        this.log = opt.log;
        this.senseBusy = true;
        /** @type {number[]} */
        this.rx = [];
        /** @type {(() => void) | null} */
        this.wake = null;
        /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
        this.reader = null;
        /** @type {WritableStreamDefaultWriter<Uint8Array> | null} */
        this.writer = null;
        /** @type {Promise<void> | null} */
        this.pump = null;
        /** @type {string | null} why the port can't be read any more */
        this.readError = null;
        this.closing = false;
    }

    /** Open the port at 9600 8N1 with BUSY released. */
    async open() {
        await this.port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 4096 });
        await this.port.setSignals({ dataTerminalReady: this.invertBusy, requestToSend: false });
        this.writer = this.port.writable.getWriter();
        this.pump = this.receive();
        return this;
    }

    /**
     * Collect received bytes until the port closes. A break, framing or
     * parity error (the radio resetting after PROGRAM sends a break) ends
     * the current stream but not the port: carry on with the next one.
     */
    async receive() {
        let received = false;
        while (this.port.readable && !this.closing) {
            const reader = this.port.readable.getReader();
            this.reader = reader;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) return;
                    if (value) for (const b of value) this.rx.push(b);
                    received = true;
                    this.wake?.();
                }
            } catch (e) {
                if (this.closing) return;
                const name = e instanceof Error ? e.name : "";
                if (["BreakError", "FramingError", "ParityError", "BufferOverrunError"].includes(name)) {
                    this.log?.(`${name} on the line (ignored)`);
                    continue;
                }
                // Chrome on Linux keeps the tty's VMIN, and reads 0 as a lost device
                // when another program (pyserial, DOSBox) left it at 0
                this.readError = name === "NetworkError" && !received
                    ? `${e}. On Linux this usually means a program that used the port before left it in a mode `
                        + "Chrome can't read: run stty -F /dev/ttyUSB0 min 1 (with your port's name), or unplug and "
                        + "replug the adapter, then try again"
                    : String(e);
                this.wake?.();
                return;
            } finally {
                reader.releaseLock();
            }
        }
    }

    /** Release BUSY and close the port. */
    async close() {
        try {
            await this.port.setSignals({ dataTerminalReady: this.invertBusy });
        } catch { /* already gone */ }
        this.closing = true;
        try {
            await this.reader?.cancel();
            await this.pump;
            this.writer?.releaseLock();
        } catch { /* closing anyway */ }
        await this.port.close().catch(() => {});
    }

    async setBusy(/** @type {boolean} */ on) {
        await this.port.setSignals({ dataTerminalReady: on !== this.invertBusy });
    }

    /** Is the bus BUSY (CTS / RI)? */
    async busy() {
        if (!this.senseBusy) return false;
        try {
            const s = await this.port.getSignals();
            return this.invertBusy ? !(s.ringIndicator && s.clearToSend) : s.ringIndicator || s.clearToSend;
        } catch {
            this.senseBusy = false;        // a port without modem lines
            return false;
        }
    }

    async waitIdle() {
        const end = performance.now() + this.busyTimeout;
        while (await this.busy()) {
            if (performance.now() > end) throw new BusError("BUSY line stuck: is the radio on, and the RIB powered and cabled?");
            await sleep(1);
        }
    }

    /** Up to n received bytes, waiting at most `ms` for them all. */
    async readBytes(/** @type {number} */ n, /** @type {number} */ ms) {
        const end = performance.now() + ms;
        while (this.rx.length < n && !this.readError) {
            const left = end - performance.now();
            if (left <= 0) break;
            await new Promise((/** @type {(v?: unknown) => void} */ r) => {
                const t = setTimeout(r, left);
                this.wake = () => {
                    clearTimeout(t);
                    r();
                };
            });
            this.wake = null;
        }
        if (this.readError) throw new BusError(`the serial port failed: ${this.readError}`);
        return Uint8Array.from(this.rx.splice(0, n));
    }

    /**
     * Send one message (payload + CRC); resolve with its 5-byte reply, or
     * null for a message that has none. Retries a collision or no answer.
     * @param {Uint8Array} payload
     */
    async transact(payload) {
        const msg = sb.frame(payload);
        const wantsReply = !!(/** @type {number} */ (payload[3]) & 0x80);
        for (let attempt = 0; attempt < this.tries; attempt++) {
            if (attempt) {
                this.log?.(`retrying ${hex(msg)} (try ${attempt + 1})`);
                await sleep(5 + Math.random() * 25);
            }
            await this.waitIdle();
            this.rx.length = 0;
            await this.setBusy(true);
            try {
                await /** @type {WritableStreamDefaultWriter<Uint8Array>} */ (this.writer).write(msg);
                const echo = await this.readBytes(5, this.echoTimeout);
                if (hex(echo) !== hex(msg)) continue;      // a collision, or nothing on the bus
                if (!wantsReply) {
                    await sleep(20);
                    return null;
                }
                const first = await this.readBytes(1, this.replyTimeout);
                await this.setBusy(false);                 // RSS drops BUSY on the first reply byte
                if (!first.length) continue;
                const rest = await this.readBytes(4, this.replyTimeout);
                if (rest.length === 4) {
                    return Uint8Array.of(...first, ...rest);
                }
            } finally {
                await this.setBusy(false);
            }
        }
        throw new BusError(`no answer to ${hex(msg)} after ${this.tries} tries: is the radio on and the RIB cabled?`);
    }
}
