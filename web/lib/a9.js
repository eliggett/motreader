// @ts-check
/**
 * The A9 (S9000e / "conventional expanded") head keeps a 16-bit checksum
 * over its ASCII string block (STATUS 1 .. the last mode name). Name edits
 * must carry it, or RSS reports a bad checksum on GET. Port of
 * fix_a9_head_checksum and friends in motreader/lists.py.
 *
 * ASCII string block, 11 characters per slot: STATUS x8, MESSAGE x8, CODE x4,
 * UNIT x8, UNIT x8, PHONE x9, SITE x8, MPL x16, " REMOTE", then the zone
 * names and the mode names.
 */
import { InvalidValue } from "./errors.js";

const PHONE_COUNT = 9;
const A9_SLOTS_PHONE_TO_ZONES = PHONE_COUNT + 8 + 16 + 1;
const A9_ASCII_SLOTS_BEFORE_PHONE = 8 + 8 + 4 + 8 + 8;
const CK_MARK = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00];

/** @typedef {import("./codeplug.js").Codeplug} Codeplug */

/** Offset of the first phone-name slot on an A9 head. */
function phoneNamesOff(/** @type {Codeplug} */ cp) {
    const [start, w] = /** @type {[number, number]} */ (cp.ascii_names);
    const off = start - (cp.zones.length + A9_SLOTS_PHONE_TO_ZONES) * w;
    const blk = cp.body.subarray(Math.max(off, 0), off + A9_SLOTS_PHONE_TO_ZONES * w);
    if (off < 0 || !blk.every((c) => c >= 0x20 && c < 0x7F)) throw new InvalidValue("A9 ASCII string block not where expected");
    return off;
}

/** [lo, hi) of the A9 ASCII string block (STATUS 1 .. last mode name). */
export function a9AsciiRange(/** @type {Codeplug} */ cp) {
    const [start, w] = /** @type {[number, number]} */ (cp.ascii_names);
    return /** @type {[number, number]} */ ([phoneNamesOff(cp) - A9_ASCII_SLOTS_BEFORE_PHONE * w, start + cp.modes.length * w]);
}

/** Index of `pat` in `b` within [from, to), or -1 (like bytes.find). */
function find(/** @type {Uint8Array} */ b, /** @type {number[]} */ pat, /** @type {number} */ from, /** @type {number} */ to) {
    const end = Math.min(to, b.length) - pat.length;
    for (let i = Math.max(from, 0); i <= end; i++) {
        let ok = true;
        for (let j = 0; j < pat.length && ok; j++) ok = b[i + j] === pat[j];
        if (ok) return i;
    }
    return -1;
}

/** Offset of the A9 head checksum word, or null (not A9, or not found). */
export function a9HeadChecksumOff(/** @type {Codeplug} */ cp) {
    if (!cp.ascii_names) return null;
    const ends = cp.modes.filter((m) => m.offset >= 0).map((m) => m.offset + m.raw.length);
    if (!ends.length) return null;
    const end = Math.max(...ends);
    // the head block starts on a page boundary (body offset = 0xAD mod 0x100)
    // after the radio data; up to a page of FF padding precedes it
    let k = find(cp.body, CK_MARK, end, end + 0x140);
    while (k >= 0 && (k + 6 - 0xAD) % 0x100) k = find(cp.body, CK_MARK, k + 1, end + 0x140);
    return k < 0 ? null : k + CK_MARK.length;
}

/**
 * Carry the A9 head checksum over edits of the ASCII block (`out` = edited
 * copy of cp.body). No-op for other heads or an unchanged block.
 */
export function fixA9HeadChecksum(/** @type {Codeplug} */ cp, /** @type {Uint8Array} */ out) {
    if (!cp.ascii_names) return;
    const [lo, hi] = a9AsciiRange(cp);
    let delta = 0;
    for (let i = lo; i < hi; i++) {
        const d = /** @type {number} */ (out[i]) - /** @type {number} */ (cp.body[i]);
        if (d) delta += d * (i & 1 ? 256 : 1);
    }
    if (!delta) return;
    const ck = a9HeadChecksumOff(cp);
    if (ck === null || (lo <= ck && ck < hi)) {
        throw new InvalidValue("A9 control-head checksum not found; refusing to edit names on this head "
            + "(RSS would report a bad checksum)");
    }
    const v = (((/** @type {number} */ (out[ck]) << 8) | /** @type {number} */ (out[ck + 1])) + delta) & 0xFFFF;
    out[ck] = v >> 8;
    out[ck + 1] = v & 0xFF;
}
