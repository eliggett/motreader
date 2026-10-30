// @ts-check
/**
 * The radio connection the app shares: the Tech tab keeps one open between
 * operations; Read Radio / Write Radio use it when it is open, or open the
 * port for the one operation. One operation at a time.
 *
 * Any session leaves the radio's control head frozen until MODE_DONE
 * restarts the radio (`radio.needsReset`). Read/Write Radio always finish
 * with it; the Tech tab leaves the radio waiting between operations and
 * restarts it on Restart radio or Disconnect.
 */
import { log } from "./log.js";
import { requestPort, portName, WebSerialLink } from "./serial.js";
import { Radio } from "../lib/radio.js";

/** @typedef {{ link: WebSerialLink, radio: Radio, name: string, busy: boolean }} Connection */

/** @type {Connection | null} */
let conn = null;
/** @type {Set<() => void>} */
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

/** The open connection, or null. */
export const connection = () => conn;

/** Call `fn` when the connection opens, closes or starts / ends an operation. */
export function onConnectionChange(/** @type {() => void} */ fn) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** Ask for a port and open it. Resolves null if no port was chosen. */
async function open() {
    let port;
    try {
        port = await requestPort();
    } catch (e) {
        log.info(`Radio: no serial port chosen (${e instanceof Error ? e.message : e})`);
        return null;
    }
    const link = new WebSerialLink(port, { log: (s) => log.debug(`Radio: ${s}`) });
    const name = portName(port);
    log.info(`Radio: opening ${name}`);
    try {
        await link.open();
    } catch (e) {
        throw new Error(`the serial port could not be opened (in use by another program?): ${e instanceof Error ? e.message : e}`);
    }
    return { link, radio: new Radio(link), name, busy: false };
}

/** Open the shared connection (the Tech tab). Resolves false if no port was chosen. */
export async function connect() {
    if (conn) return true;
    conn = await open();
    changed();
    return !!conn;
}

/** Restart the radio if it is waiting, and close the shared connection. */
export async function disconnect() {
    const c = conn;
    if (!c) return;
    conn = null;
    await c.radio.finish();
    await c.link.close();
    log.info(`Radio: closed ${c.name}`);
    changed();
}

/**
 * Run `work` on the radio: on the shared connection if it is open, else on a
 * port opened for this operation and closed afterwards. `restart`: send
 * MODE_DONE at the end (also after an error) so the radio isn't left frozen.
 * Resolves null if no port was chosen.
 * @template T
 * @param {(radio: Radio) => Promise<T>} work
 * @param {{ restart?: boolean, onOpen?: () => void }} [opt]
 * @returns {Promise<T | null>}
 */
export async function withRadio(work, { restart = true, onOpen } = {}) {
    const shared = conn;
    if (shared?.busy) throw new Error("the radio is busy with another operation");
    const c = shared ?? (await open());
    if (!c) return null;
    c.busy = true;
    changed();
    onOpen?.();
    try {
        return await work(c.radio);
    } finally {
        if (restart) await c.radio.finish();
        c.busy = false;
        if (!shared) await c.link.close();
        changed();
    }
}
