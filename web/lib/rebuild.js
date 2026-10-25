// @ts-check
/**
 * Write a decoded codeplug's (edited) modes and zones back into a copy of its
 * body: template-patch. Port of Codeplug.rebuild and its helpers in
 * motreader/codeplug.py.
 *
 * Only mapped fields are written, and each only when its decoded value
 * changed, so an unedited mode or zone re-encodes byte-identically and every
 * byte motreader doesn't understand is preserved. The values to write are the
 * fields of `cp.modes` / `cp.zones`; `cp.body` is the template.
 */
import {
    NAME_TABLE_OFF, NAME_LEN_BYTES, packName, packMembership, modePointerTable,
    vhfDecode, vhfEncode, vhfTxBandByte, VHF_RX_COEF, VHF_TX_COEF, VHF_SLOTS, M900_SLOTS,
    decode900Fields, m900RxEncode, m900FreqEncode, M900_TX, M900_TA, MPL_BY_BITS, UNMUTE_BY_BITS, VALID_CARRY_900,
} from "./codeplug.js";
import { slotDecode, slotEncode, isDplCode } from "./tones.js";
import { equal } from "./bytes.js";
import { InvalidValue } from "./errors.js";

export { InvalidValue };

/** @typedef {import("./codeplug.js").Codeplug} Codeplug */
/** @typedef {import("./codeplug.js").Mode} Mode */
/** @typedef {import("./codeplug.js").Zone} Zone */

const byName = (/** @type {Record<number, string>} */ m) =>
    new Map(Object.entries(m).map(([bits, name]) => [name.toLowerCase(), Number(bits)]));
const MPL_BY_NAME = byName(MPL_BY_BITS);
const UNMUTE_BY_NAME = byName(UNMUTE_BY_BITS);

/** @param {Uint8Array} b @param {number} from @param {number} to */
const sum8 = (b, from, to) => {
    let s = 0;
    for (let i = from; i < to; i++) s += /** @type {number} */ (b[i]);
    return s & 0xFF;
};
const byteAt = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => /** @type {number} */ (b[o]);

/** Option text -> desired bit state: null = not given; else is it `yes`? */
const on = (/** @type {string | null} */ v, /** @type {string} */ yes) => (v === null || v === undefined ? null : String(v).trim().toLowerCase() === yes);

/** Text as latin-1 bytes; throws for characters outside latin-1. */
function latin1Bytes(/** @type {string} */ s) {
    return Uint8Array.from(s, (c) => {
        const x = /** @type {number} */ (c.codePointAt(0));
        if (x > 0xFF) throw new InvalidValue(`can't store "${c}" in a name`);
        return x;
    });
}

/** `name` in a w-byte ASCII field, space padded (truncated at w). */
function asciiFieldBytes(/** @type {string} */ name, /** @type {number} */ w) {
    const out = new Uint8Array(w).fill(0x20);
    out.set(latin1Bytes(name).subarray(0, w));
    return out;
}
const asciiText = (/** @type {Uint8Array} */ b) => String.fromCharCode(...b).replace(/[ \x00]+$/, "");

/** Write mode `m`'s values (record and name) into `out`, a copy of cp.body. */
export function writeMode(/** @type {Codeplug} */ cp, /** @type {Uint8Array} */ out, /** @type {Mode} */ m) {
    if (cp.band === "vhf") writeModeVhf(cp, out, m);
    else writeMode900(cp, out, m);
    writeName(cp, out, m);
}

/** A copy of the body with the modes' and zones' current values applied. */
export function rebuild(/** @type {Codeplug} */ cp) {
    const out = new Uint8Array(cp.body);
    for (const m of cp.modes) writeMode(cp, out, m);
    fixRecordSums(cp.body, out);
    for (const z of cp.zones) writeZone(cp, out, z);
    const secs = cp.zone_sections;
    if (secs && cp.zones.length) {
        // the membership section ends with an 8-bit sum (RSS recomputes it)
        const m = secs.memb;
        const L = secs.memb_len;
        if (!equal(out.subarray(m, m + L - 1), cp.body.subarray(m, m + L - 1))) out[m + L - 1] = sum8(out, m, m + L - 1);
    }
    return out;
}

/** Body offsets of the mode records' 8-bit sums. */
export function recordSumOffsets(/** @type {Uint8Array} */ body) {
    const pt = modePointerTable(body);
    /** @type {Set<number>} */
    const out = new Set();
    if (!pt) return out;
    const L = byteAt(body, 0x10A);
    for (const t of pt[2]) {
        for (const k of [L - 1, 25, 26]) {   // 26: 900 27-byte record + scan list
            if (t + k < body.length && sum8(body, t, t + k) === body[t + k]) {
                out.add(t + k);
                break;
            }
        }
    }
    return out;
}

/**
 * Each mode record ends with an 8-bit sum of its other bytes (at true start +
 * L-1, or +25 / +26 on zones-off records with a scan list after them). RSS
 * doesn't check it on GET but recomputes it when it edits a mode, so do the
 * same for every record motreader changed, where the sum was valid to begin with.
 */
function fixRecordSums(/** @type {Uint8Array} */ body, /** @type {Uint8Array} */ out) {
    const pt = modePointerTable(body);
    if (!pt) return;
    const L = byteAt(body, 0x10A);
    for (const t of pt[2]) {
        for (const k of [L - 1, 25, 26]) {
            if (t + k >= body.length) continue;
            if (sum8(body, t, t + k) !== body[t + k]) continue;
            if (!equal(out.subarray(t, t + k), body.subarray(t, t + k))) out[t + k] = sum8(out, t, t + k);
            break;
        }
    }
}

/** A zone's name and membership, each only if changed; flag records are kept verbatim. */
function writeZone(/** @type {Codeplug} */ cp, /** @type {Uint8Array} */ out, /** @type {Zone} */ z) {
    if (z.names_off >= 0) {
        const cur = cp.body.subarray(z.names_off, z.names_off + z.name_w);
        if (z.name_enc === "ascii") {
            // keep the original pad bytes (space vs NUL) when the name is unchanged
            if (asciiText(cur) !== z.name) out.set(asciiFieldBytes(z.name, z.name_w), z.names_off);
        } else {
            const packed = packName(z.name).subarray(0, z.name_w);
            if (!equal(cur, packed)) out.set(packed, z.names_off);
        }
    }
    if (z.memb_off >= 0) {
        const bm = packMembership(z.modes, z.memb_w);
        if (!equal(cp.body.subarray(z.memb_off, z.memb_off + z.memb_w), bm)) out.set(bm, z.memb_off);
    }
}

/** A mode's name, only if changed (6-bit table at 0x266, or the A9 ASCII table). */
function writeName(/** @type {Codeplug} */ cp, /** @type {Uint8Array} */ out, /** @type {Mode} */ m) {
    if (cp.ascii_names) {
        const [start, w] = cp.ascii_names;
        const off = start + (m.number - 1) * w;
        if (asciiText(cp.body.subarray(off, off + w)) === m.name) return;
        out.set(asciiFieldBytes(m.name, w), off);
        return;
    }
    const noff = NAME_TABLE_OFF + (m.number - 1) * NAME_LEN_BYTES;
    const packed = packName(m.name);
    if (!equal(cp.body.subarray(noff, noff + NAME_LEN_BYTES), packed)) out.set(packed, noff);
}

/** A VHF frequency field, re-encoded only if its value changed. */
function writeFieldVhf(/** @type {Uint8Array} */ out, /** @type {Mode} */ m, /** @type {number} */ foff,
    /** @type {number | null} */ freq, /** @type {import("./codeplug.js").Coef} */ coef, /** @type {boolean} */ hasBand) {
    if (freq === null || freq === undefined) return;
    if (freq === vhfDecode(byteAt(m.raw, foff), byteAt(m.raw, foff + 1), coef)) return;
    const [lo, mid] = vhfEncode(freq, coef);
    out[m.offset + foff] = lo;
    out[m.offset + foff + 1] = mid;
    if (hasBand) out[m.offset + foff + 2] = vhfTxBandByte(freq);
}

/** Set or clear one option bit at view offset `off`, only on a real change. */
function writeFlag(/** @type {Uint8Array} */ target, /** @type {number} */ base, /** @type {Mode} */ m,
    /** @type {number} */ off, /** @type {number} */ bit, /** @type {boolean | null} */ wantSet) {
    if (wantSet === null) return;
    if (Boolean(byteAt(m.raw, off) & bit) === wantSet) return;
    if (wantSet) target[base + off] = byteAt(target, base + off) | bit;
    else target[base + off] = byteAt(target, base + off) & (~bit & 0xFF);
}

/** A multi-bit option (`mask`) at view offset `off`, only on a real change. */
function writeMasked(/** @type {Uint8Array} */ target, /** @type {number} */ base, /** @type {Mode} */ m,
    /** @type {number} */ off, /** @type {number} */ mask, /** @type {number | undefined} */ want) {
    if (want === undefined || (byteAt(m.raw, off) & mask) === want) return;
    target[base + off] = (byteAt(target, base + off) & (~mask & 0xFF)) | want;
}

/** @param {Codeplug} cp @param {Uint8Array} out @param {Mode} m */
function writeModeVhf(cp, out, m) {
    writeFieldVhf(out, m, 6, m.rx_mhz, VHF_RX_COEF, false);
    writeFieldVhf(out, m, 10, m.tx_mhz, VHF_TX_COEF, true);
    writeFieldVhf(out, m, 14, m.ta_mhz, VHF_TX_COEF, true);
    const b = m.offset;
    writeFlag(out, b, m, 3, 0x10, on(m.up_xtal_shift, "disabled"));
    writeFlag(out, b, m, 4, 0x80, on(m.mdc_ptt_id, "enabled"));
    writeFlag(out, b, m, 4, 0x20, on(m.phone_encode, "enabled"));
    writeFlag(out, b, m, 9, 0x40, on(m.tx_power, "high"));
    writeFlag(out, b, m, 13, 0x40, on(m.ta_power, "high"));
    if (m.mpl_type !== null) writeMasked(out, b, m, 3, 0x60, MPL_BY_NAME.get(String(m.mpl_type).trim().toLowerCase()));
    // tone slots Rx +17, Tx +19, T·A +21
    writeSlot(cp, out, m, VHF_SLOTS.rx, m.rx_pl, m.rx_squelch_type, false, false);
    writeSlot(cp, out, m, VHF_SLOTS.tx, m.tx_pl, m.tx_squelch_type, true, true);
    if (m.ta_squelch_type !== null) writeSlot(cp, out, m, VHF_SLOTS.ta, m.ta_pl, m.ta_squelch_type, true, true);
}

/** Python `float(s)` succeeds (for the decimal numbers a tone field holds). */
const isNumber = (/** @type {string} */ s) => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);

/**
 * A tone slot at view offset `off` (PL / DPL / INV.DPL / Carrier), written
 * only when its decoded value changed. `plTx`: Tx tone formula; `dplTx`: Tx
 * DPL polarity sense.
 * @param {Codeplug} cp @param {Uint8Array} out @param {Mode} m @param {number} off
 * @param {string | null} wantCode @param {string | null} wantType @param {boolean} plTx @param {boolean} dplTx
 */
function writeSlot(cp, out, m, off, wantCode, wantType, plTx, dplTx) {
    const a = m.offset + off;
    if (a + 1 >= cp.body.length) return;
    const [origType, origCode] = slotDecode(byteAt(cp.body, a), byteAt(cp.body, a + 1), plTx, dplTx);
    const code = (wantCode ?? "").trim();
    const wt = (wantType ?? "").trim();
    if (origType === null && wantType === null && !code) return;   // a slot that isn't a tone and wasn't edited: keep it
    /** @type {import("./tones.js").SquelchType} */
    let desType;
    /** @type {string | null} */
    let desCode;
    if (isDplCode(code)) {
        desType = wt === "DPL" || wt === "INV.DPL" ? wt
            : origType === "DPL" || origType === "INV.DPL" ? origType   // keep the original polarity
            : "DPL";
        desCode = code;
    } else if (code && isNumber(code)) {
        [desType, desCode] = ["PL", code];
    } else if (!code && (wt === "" || wt === "Carrier")) {
        [desType, desCode] = ["Carrier", null];
    } else {
        return;   // an unrecognised code (or a tone type without a code): left as is
    }
    if (desType === origType && desCode === origCode) return;
    const enc = slotEncode(desType, desCode, plTx, dplTx);
    if (!enc) return;
    out[a] = enc[0];
    out[a + 1] = enc[1];
}

/** @param {Codeplug} cp @param {Uint8Array} out @param {Mode} m */
function writeMode900(cp, out, m) {
    const base = m.offset;
    const rec = out.slice(base, base + 26);
    // compare with the display-logic decode, so an unedited simplex mode stays identical
    const [curRx, curTx, curTa] = decode900Fields(m.raw);
    if (m.rx_mhz !== null && m.rx_mhz !== curRx) {
        const [lo, mid] = m900RxEncode(m.rx_mhz);
        rec[14] = lo;
        rec[15] = mid;
    }
    if (m.tx_mhz !== curTx || m.ta_mhz !== curTa) {
        // the simplex layout (TX in the +21..23 field) only for a mode that
        // already has it, or whose T/A is being cleared: a split mode with no
        // T/A (617ASN mode 1: 935.9 / 896.9) keeps its TX in +17..19
        const txInTa = !(VALID_CARRY_900.includes(byteAt(m.raw, 17)) && (byteAt(m.raw, 18) || byteAt(m.raw, 19)));
        if (m.ta_mhz === null && m.tx_mhz !== null && (txInTa || curTa !== null)) {
            // simplex: TX goes in the +21..23 field; clear the repeater input
            const [lo, mid, carry] = m900FreqEncode(m.tx_mhz, byteAt(m.raw, M900_TA[0]));
            [rec[M900_TA[1]], rec[M900_TA[2]], rec[M900_TA[0]]] = [lo, mid, carry];
            rec[M900_TX[1]] = 0;
            rec[M900_TX[2]] = 0;
        } else {
            for (const [field, freq] of /** @type {const} */ ([[M900_TX, m.tx_mhz], [M900_TA, m.ta_mhz]])) {
                if (freq === null) continue;
                const [carry, lo, mid] = field;
                const [bLo, bMid, bCarry] = m900FreqEncode(freq, byteAt(m.raw, carry));
                [rec[lo], rec[mid], rec[carry]] = [bLo, bMid, bCarry];
            }
        }
    }
    writeFlag(rec, 0, m, 11, 0x10, on(m.up_xtal_shift, "disabled"));
    writeFlag(rec, 0, m, 12, 0x08, on(m.audio_compander, "enabled"));
    writeFlag(rec, 0, m, 12, 0x40, on(m.adaptive_splatter, "enabled"));
    writeFlag(rec, 0, m, 12, 0x80, on(m.mdc_ptt_id, "enabled"));
    writeFlag(rec, 0, m, 12, 0x20, on(m.phone_encode, "enabled"));
    writeFlag(rec, 0, m, 11, 0x04, on(m.reverse_burst_toc, "enabled"));
    writeFlag(rec, 0, m, 17, 0x40, on(m.tx_power, "high"));
    writeFlag(rec, 0, m, 21, 0x40, on(m.ta_power, "high"));
    if (m.unmute_mute_type !== null) writeMasked(rec, 0, m, 11, 0x03, UNMUTE_BY_NAME.get(String(m.unmute_mute_type).trim().toLowerCase()));
    if (m.mpl_type !== null) writeMasked(rec, 0, m, 11, 0x60, MPL_BY_NAME.get(String(m.mpl_type).trim().toLowerCase()));
    out.set(rec, base);
    // tone slots at view +25/+27/+29 (partly past the 26-byte view); none on a trunked mode 1
    if (m.rx_squelch_type !== null || m.tx_squelch_type !== null || m.ta_squelch_type !== null) {
        writeSlot(cp, out, m, M900_SLOTS.rx, m.rx_pl, m.rx_squelch_type, false, true);
        writeSlot(cp, out, m, M900_SLOTS.tx, m.tx_pl, m.tx_squelch_type, true, true);
        writeSlot(cp, out, m, M900_SLOTS.ta, m.ta_pl, m.ta_squelch_type, true, true);
    }
}
