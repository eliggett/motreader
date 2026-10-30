// @ts-check
/**
 * SB9600 message primitives, as RSS (SPECTRA1.EXE segment 10bd) builds them;
 * a port of motreader-py/sb9600.py (the 10bd offsets are noted there).
 *
 * A message is 4 payload bytes plus a CRC byte: `addr_hi, addr_lo, data,
 * opcode`. An opcode with bit 7 set expects a 5-byte reply. Codeplug reads
 * and writes scramble the address/data bytes. See notes/RADIO-PROTOCOL.md.
 */

/** CRC lookup, indexed by the low 3 bits of (byte ^ crc). */
export const CRC_TABLE = [0x00, 0x99, 0xAC, 0x35, 0xC7, 0x5E, 0x6B, 0xF2];

export const OP_READ = 0x87;        // read codeplug byte(s); reply opcode OP_READ_REPLY
export const OP_READ_REPLY = 0x07;
export const OP_WRITE = 0x07;       // write one codeplug byte; no reply
export const OP_MODE = 0x08;        // mode/control commands; no reply

/** 8086 `sar r8, 1`. */
const sar = (/** @type {number} */ b) => ((b >> 1) | (b & 0x80)) & 0xFF;

/** Fold one byte into the running CRC. */
export function crcStep(/** @type {number} */ crc, /** @type {number} */ b) {
    const t = b ^ crc;
    let a = (sar(t) >> 1) ^ t;
    let cl = a;
    a = (a << 1) & 0xF0;
    const neg = cl & 0x80;          // sar keeps the sign; jns tests it
    cl = sar(cl);
    if (neg) cl ^= 0xFF;
    a = (a + (cl & 0x0F)) & 0xFF;
    return a ^ /** @type {number} */ (CRC_TABLE[t & 7]);
}

/** The CRC of a payload. */
export function crc(/** @type {ArrayLike<number>} */ payload) {
    let c = 0;
    for (let i = 0; i < payload.length; i++) c = crcStep(c, /** @type {number} */ (payload[i]));
    return c;
}

/** 4 payload bytes -> the 5 bytes on the wire. */
export function frame(/** @type {ArrayLike<number>} */ payload) {
    if (payload.length !== 4) throw new Error("an SB9600 payload is 4 bytes");
    return Uint8Array.of(...Array.from(payload), crc(payload));
}

/** Bit-reverse a byte. */
export function rev8(/** @type {number} */ b) {
    let r = 0;
    for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
    return r;
}

/**
 * RSS's request scramble over (addr_hi, addr_lo, data).
 * @returns {[number, number, number]}
 */
export function scramble(/** @type {number} */ hi, /** @type {number} */ lo, /** @type {number} */ data) {
    const s5 = data ^ hi ^ 0x9B;
    const s6 = rev8(data) ^ s5;
    const s7 = rev8(lo) ^ s6 ^ 0xB5;
    return [s5, s6, s7];
}

/**
 * Inverse of scramble: the radio's view of a scrambled request (hi, lo, data).
 * @returns {[number, number, number]}
 */
export function unscramble(/** @type {number} */ s5, /** @type {number} */ s6, /** @type {number} */ s7) {
    const data = rev8(s6 ^ s5);
    return [s5 ^ data ^ 0x9B, rev8(s7 ^ s6 ^ 0xB5), data];
}

/**
 * RSS's reply unscramble: the plain (r1, r2).
 * @returns {[number, number]}
 */
export function unscrambleReply(/** @type {number} */ r0, /** @type {number} */ r1, /** @type {number} */ r2) {
    return [rev8(r2 ^ r1 ^ 0x5C), rev8(r2 ^ r0 ^ 0xA4)];
}

/**
 * Inverse of unscrambleReply for a chosen r0: the (r1, r2) to send so RSS
 * recovers the given plain (r1, r2).
 * @returns {[number, number]}
 */
export function scrambleReply(/** @type {number} */ r0, /** @type {number} */ r1, /** @type {number} */ r2) {
    const s2 = rev8(r2) ^ r0 ^ 0xA4;
    return [rev8(r1) ^ s2 ^ 0x5C, s2];
}

/**
 * The radio's reply to a read: byte 2 is the byte at the address, byte 1 the
 * next one (and byte 0 `r0`).
 */
export function readReply(/** @type {ArrayLike<number>} */ data, /** @type {boolean} */ scrambled, r0 = 0) {
    const d0 = /** @type {number} */ (data[0]);
    const d1 = data.length > 1 ? /** @type {number} */ (data[1]) : 0;
    const [r1, r2] = scrambled ? scrambleReply(r0, d1, d0) : [d1, d0];
    return frame([r0, r1, r2, OP_READ_REPLY]);
}
