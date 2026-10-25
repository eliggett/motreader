// @ts-check
/**
 * The archive file container (FORMAT §3): an ASCII banner, then the
 * encrypted codeplug body.
 *
 * The long banner (83 bytes) is the common case; the short one (52 bytes, the
 * prefix only) is rare and older.
 */
import { concat, equal } from "./bytes.js";
import { decryptBody, encryptBody } from "./crypto.js";

const ascii = (/** @type {string} */ s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export const BANNER_PREFIX = ascii("Requires MOTOROLA Radio Service Software For Spectra");
export const BANNER_LONG = concat(BANNER_PREFIX, ascii("\r\nCOPYRIGHT MOTOROLA INC.,1987\x1a"));

/** @typedef {{ banner: Uint8Array, body: Uint8Array }} Archive  body: still encrypted */

/** True if `data` starts with the archive banner. */
export function isArchive(/** @type {Uint8Array} */ data) {
    return data.length >= BANNER_PREFIX.length && equal(data.subarray(0, BANNER_PREFIX.length), BANNER_PREFIX);
}

/** Split an archive file into banner and (encrypted) body. */
export function splitArchive(/** @type {Uint8Array} */ data) {
    if (!isArchive(data)) throw new Error("not a Spectra archive (missing the RSS banner)");
    const n = data.length >= BANNER_LONG.length && equal(data.subarray(0, BANNER_LONG.length), BANNER_LONG)
        ? BANNER_LONG.length
        : BANNER_PREFIX.length;
    /** @type {Archive} */
    const a = { banner: data.slice(0, n), body: data.slice(n) };
    return a;
}

/** Join banner and encrypted body back into a file. */
export function joinArchive(/** @type {Archive} */ a) {
    return concat(a.banner, a.body);
}

/** An archive file's decrypted body and banner. */
export function openArchive(/** @type {Uint8Array} */ data) {
    const a = splitArchive(data);
    return { banner: a.banner, plain: decryptBody(a.body) };
}

/** Build an archive file from a banner and a plaintext body. */
export function sealArchive(/** @type {Uint8Array} */ banner, /** @type {Uint8Array} */ plain) {
    return joinArchive({ banner, body: encryptBody(plain) });
}
