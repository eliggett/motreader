// @ts-check
/**
 * Byte and integer helpers for the codeplug format code.
 *
 * Two JavaScript habits differ from Python's `bytes`, and every module here
 * relies on this file to get them right:
 *
 * - Numbers are 64-bit floats, and the bitwise operators work on *signed*
 *   32-bit integers. Anything 32 bits wide (LCG seeds, products) goes through
 *   `mul32` / `u32` so it stays unsigned and exact; a bare `a * b` silently
 *   loses low bits once the product passes 2^53.
 * - `Uint8Array.subarray()` shares memory with the original. Editing a
 *   subarray edits the template it came from. Use `copy()` (or `slice()`)
 *   whenever the result will be modified.
 *
 * Multi-byte codeplug values are big-endian, so the 16-bit helpers are `be16`.
 */

/** @typedef {Uint8Array} Bytes */

/** @param {number} x @returns {number} x as an unsigned 32-bit integer. */
export function u32(x) {
    return x >>> 0;
}

/** Unsigned 32-bit product, exact (wraps like C `uint32_t`). */
export function mul32(/** @type {number} */ a, /** @type {number} */ b) {
    return Math.imul(a, b) >>> 0;
}

/** Big-endian unsigned 16-bit word at `o`. */
export function be16(/** @type {Bytes} */ b, /** @type {number} */ o) {
    return (at(b, o) << 8) | at(b, o + 1);
}

/** Store `v` (0..0xFFFF) as a big-endian word at `o`. */
export function putBe16(/** @type {Bytes} */ b, /** @type {number} */ o, /** @type {number} */ v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFF) throw new RangeError(`not a 16-bit value: ${v}`);
    inRange(b, o, 2);
    b[o] = v >> 8;
    b[o + 1] = v & 0xFF;
}

/** Byte at `o`, with a bounds check (a plain `b[o]` reads `undefined` past the end). */
export function at(/** @type {Bytes} */ b, /** @type {number} */ o) {
    inRange(b, o, 1);
    return /** @type {number} */ (b[o]);
}

/** @param {Bytes} b @param {number} o @param {number} n */
function inRange(b, o, n) {
    if (!Number.isInteger(o) || o < 0 || o + n > b.length) {
        throw new RangeError(`offset 0x${o.toString(16)}+${n} outside ${b.length} bytes`);
    }
}

/** A copy that is safe to modify (never shares memory with `b`). */
export function copy(/** @type {Bytes} */ b) {
    return new Uint8Array(b);
}

/** Byte-for-byte equality. */
export function equal(/** @type {Bytes} */ a, /** @type {Bytes} */ b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Offsets where `a` and `b` differ (over the shorter length, plus a length note). */
export function diff(/** @type {Bytes} */ a, /** @type {Bytes} */ b) {
    /** @type {number[]} */
    const out = [];
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
    return out;
}

/** Concatenate byte arrays into a new one. */
export function concat(/** @type {Bytes[]} */ ...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

/** Lower-case hex, optionally separated: `hex(b, " ")` gives "0a ff 12". */
export function hex(/** @type {Bytes} */ b, sep = "") {
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(sep);
}

/** Parse hex, ignoring whitespace: "0a ff12" gives [0x0a, 0xff, 0x12]. */
export function fromHex(/** @type {string} */ s) {
    const t = s.replace(/\s+/g, "");
    if (t.length % 2 || /[^0-9a-fA-F]/.test(t)) throw new SyntaxError(`bad hex: ${s}`);
    const out = new Uint8Array(t.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(2 * i, 2 * i + 2), 16);
    return out;
}

/**
 * One `hexdump -C` line for the 16 bytes at `off`:
 * `00000010  48 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |Hello world.|`
 */
export function hexdumpLine(/** @type {Bytes} */ b, /** @type {number} */ off) {
    const row = b.subarray(off, off + 16);
    let h = "";
    for (let i = 0; i < 16; i++) {
        h += i < row.length ? /** @type {number} */ (row[i]).toString(16).padStart(2, "0") + " " : "   ";
        if (i === 7) h += " ";
    }
    const text = Array.from(row, (x) => (x >= 0x20 && x <= 0x7e ? String.fromCharCode(x) : ".")).join("");
    return `${off.toString(16).padStart(8, "0")}  ${h} |${text}|`;
}

/**
 * The whole of `b` in `hexdump -C` format, ending with the length line.
 * With `squeeze` (hexdump's default), runs of identical lines become `*`;
 * without it the output matches `hexdump -C -v`.
 */
export function hexdump(/** @type {Bytes} */ b, { squeeze = false } = {}) {
    const lines = [];
    let prev = null;
    let starred = false;
    for (let off = 0; off < b.length; off += 16) {
        const row = b.subarray(off, off + 16);
        if (squeeze && prev && row.length === 16 && equal(row, prev)) {
            if (!starred) lines.push("*");
            starred = true;
            continue;
        }
        lines.push(hexdumpLine(b, off));
        prev = row;
        starred = false;
    }
    if (b.length) lines.push(b.length.toString(16).padStart(8, "0"));
    return lines.join("\n") + (lines.length ? "\n" : "");
}
