// @ts-check
/**
 * Helpers shared by the operations that re-pack the codeplug (adding /
 * deleting modes and zones, Zone Operation, scan list types, trunk removal):
 * the body is rebuilt with sections inserted or removed, every pointer behind
 * a change moved, and the size bookkeeping redone as RSS does.
 */
import { be16, putBe16 } from "./bytes.js";

export { be16, putBe16 };

/** Header words pointing at sections (body offset + base). */
export const HDR_PTRS = /** @type {const} */ ([0xDD, 0xE5, 0xE7, 0xED]);

/** 8-bit sum of b[from, to). */
export function sum8(/** @type {ArrayLike<number>} */ b, /** @type {number} */ from, /** @type {number} */ to) {
    let s = 0;
    for (let i = from; i < to; i++) s += /** @type {number} */ (b[i]);
    return s & 0xFF;
}

/**
 * Apply byte-range replacements [offset, old length, new bytes] to `body`
 * (offsets in the original body; applied back to front in the given order,
 * so of two edits at one offset the later-listed lands first). Returns the
 * new bytes as a plain array.
 * @param {ArrayLike<number>} body
 * @param {[number, number, ArrayLike<number>][]} edits  already sorted, back to front
 */
export function spliceAll(body, edits) {
    const out = Array.from(body);
    for (const [o, ln, nb] of edits) out.splice(o, ln, ...Array.from(nb));
    return out;
}

/**
 * The body re-trimmed of its FF padding and padded again so its length is
 * k*0x100 + 0xAD, with header 0xC9 (size / 32) following the growth.
 * @param {ArrayLike<number>} out  the re-packed body
 * @param {number} oldLen  the original body's length
 */
export function finishBody(out, oldLen) {
    let end = out.length;
    while (end && out[end - 1] === 0xFF) end--;
    const tot = end + (((0xAD - end) % 0x100) + 0x100) % 0x100;
    const res = new Uint8Array(tot).fill(0xFF);
    for (let i = 0; i < end; i++) res[i] = /** @type {number} */ (out[i]);
    res[0xC9] = (/** @type {number} */ (res[0xC9]) + Math.floor((tot - oldLen) / 32)) & 0xFF;
    return res;
}

/** ceil(n / 8): the bytes of a bitmap of n modes. */
export const bitmapBytes = (/** @type {number} */ n) => Math.ceil(n / 8);
