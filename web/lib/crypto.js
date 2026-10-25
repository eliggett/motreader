// @ts-check
/**
 * Spectra RSS archive body cipher (recovered from the RSS binary; FORMAT §4).
 *
 * A self-chaining byte cipher keyed off a per-save 13-byte nonce, stored in
 * the clear at the start of the body, and a fixed Microsoft-`rand()` LCG
 * (seed 1):
 *
 *     plain[0:13] = cipher[0:13]
 *     state = (cipher[2] + cipher[6] - cipher[8]) & 0xFF
 *     plain[13] = cipher[13] ^ state
 *     for k in 13 .. len-2:
 *         seed = seed * 0x343FD + 0x269EC3        (mod 2^32)
 *         state = (((seed >> 16) & 0xFF) + state + plain[k]) & 0xFF
 *         plain[k+1] = cipher[k+1] ^ state
 *
 * Encryption is the exact inverse. The nonce is kept from the original, so
 * re-encrypting an unmodified body is byte-identical.
 */
import { mul32 } from "./bytes.js";

export const NONCE_LEN = 13;
const LCG_A = 0x343FD;
const LCG_C = 0x269EC3;

/**
 * The shared loop. The keystream chains on the *plaintext*, so when
 * decrypting it reads the bytes it has just produced (`out`); when
 * encrypting it reads the input.
 * @param {Uint8Array} src
 * @param {boolean} decrypting
 */
function run(src, decrypting) {
    const n = src.length;
    const out = new Uint8Array(src);
    if (n <= NONCE_LEN) return out;
    let state = (/** @type {number} */ (src[2]) + /** @type {number} */ (src[6]) - /** @type {number} */ (src[8])) & 0xFF;
    out[NONCE_LEN] = /** @type {number} */ (src[NONCE_LEN]) ^ state;
    const plain = decrypting ? out : src;
    let seed = 1;
    for (let k = NONCE_LEN; k < n - 1; k++) {
        seed = (mul32(seed, LCG_A) + LCG_C) >>> 0;
        state = (((seed >>> 16) & 0xFF) + state + /** @type {number} */ (plain[k])) & 0xFF;
        out[k + 1] = /** @type {number} */ (src[k + 1]) ^ state;
    }
    return out;
}

/** Decrypt a scrambled codeplug body (the archive after its banner). */
export function decryptBody(/** @type {Uint8Array} */ cipher) {
    return run(cipher, true);
}

/** Re-encrypt a plaintext body; its first 13 bytes (the nonce) are kept. */
export function encryptBody(/** @type {Uint8Array} */ plain) {
    return run(plain, false);
}

/** The body's nonce: the 13 bytes stored in the clear that key the cipher. */
export function nonce(/** @type {Uint8Array} */ body) {
    return body.slice(0, NONCE_LEN);
}
