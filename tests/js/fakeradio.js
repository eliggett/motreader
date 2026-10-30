// @ts-check
/**
 * The radio side of tools/fake_radio.py (RSS was checked against it in the
 * emulator), as a link for web/lib/radio.js: transact() goes straight into it.
 */
import * as sb from "../../web/lib/sb9600.js";

const SCRAMBLED_SESSIONS = [0xD1, 0x51];

export class FakeRadio {
    /** @param {Map<number, number>} mem */
    constructor(mem) {
        this.mem = mem;
        this.reads = 0;
        this.writes = 0;
        /** @type {number | null} MODE byte 1 that opened the current session */
        this.session = null;
        /** @type {number | null} payload[2] of the last scrambled read */
        this.chain = null;
        /** @type {Uint8Array[]} every message, CRC included */
        this.sent = [];
    }

    /** @param {number} a */
    at(a) {
        return this.mem.get(a) ?? 0xFF;
    }

    /** Whether a read is scrambled (see fake_radio.py's is_scrambled). */
    isScrambled(/** @type {Uint8Array} */ p) {
        if (this.session === null || !SCRAMBLED_SESSIONS.includes(this.session)) return false;
        if (this.chain !== null && sb.unscramble(/** @type {number} */ (p[0]), /** @type {number} */ (p[1]), /** @type {number} */ (p[2]))[2] === this.chain) return true;
        return p[0] === p[1];
    }

    /** @param {Uint8Array} payload @returns {Promise<Uint8Array | null>} */
    async transact(payload) {
        const m = sb.frame(payload);
        this.sent.push(m);
        const [p0, p1, p2, op] = /** @type {[number, number, number, number]} */ (Array.from(m));
        if (op !== sb.OP_READ) this.chain = null;
        if (op === sb.OP_READ) {
            const scr = this.isScrambled(m);
            this.chain = scr ? p2 : null;
            const [hi, lo] = scr ? sb.unscramble(p0, p1, p2) : [p0, p1];
            const a = (hi << 8) | lo;
            const data = [this.at(a), this.at(a + 1)];
            this.reads++;
            if (scr) return sb.readReply(data, true);
            // the S9000e region answers a third byte in byte 0; elsewhere the
            // real radio echoes the address's high byte there
            return sb.readReply(data, false, this.session === 0xB1 ? this.at(a + 2) : hi);
        }
        if (op === sb.OP_WRITE) {
            const scr = this.session !== null && SCRAMBLED_SESSIONS.includes(this.session);
            const [hi, lo, v] = scr ? sb.unscramble(p0, p1, p2) : [p0, p1, p2];
            this.mem.set((hi << 8) | lo, v);
            this.writes++;
        } else if (op === sb.OP_MODE && p0 === 0) {
            this.session = p1 === 0x90 || p1 === 0x92 ? null : p1;
        }
        return null;
    }
}
