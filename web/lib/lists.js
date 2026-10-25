// @ts-check
/**
 * The radio-wide PHONE LIST and MPL (Multiple Private Line) list, RSS
 * CHANGE/VIEW -> CONVENTIONAL. Port of motreader/lists.py.
 *
 * PHONE LIST, 9 entries: numbers as 16 dial nibbles at 0x1E8 (8 bytes each;
 * 0xA = *, 0xB = #, 0xC = P, 0xF unused); names 6-bit at 0x230 (standard
 * heads) or 11-char ASCII in the A9 head's string block.
 *
 * MPL LIST, header 0x119 entries (0 = Disabled): 6-byte records of Rx/Tx/T·A
 * squelch slots (the mode-record tone codec), located structurally, then N
 * 6-bit names (A9: ASCII names in the string block).
 */
import { InvalidValue } from "./errors.js";
import { unpackName, packName } from "./codeplug.js";
import { dialDecode } from "./radiowide.js";
import { dplDecode, dplEncode, plEncode } from "./tones.js";
import { pyRound } from "./num.js";
import { latin1 } from "./bytes.js";

/** @typedef {import("./codeplug.js").Codeplug} Codeplug */
/** @typedef {{ number: number, name: string, dial: string }} Phone */
/**
 * RSS's MPL screen wording: type "Carrier" | "TPL" | "DPL" | "INV.DPL";
 * code "100.0" (TPL, as RSS shows it), "023" (DPL) or "".
 * @typedef {{ number: number, name: string, rx_type: string, rx_code: string,
 *   tx_type: string, tx_code: string, ta_type: string, ta_code: string }} Mpl
 */

export const PHONE_COUNT = 9;
const PHONE_NUM_OFF = 0x1E8;
const PHONE_NUM_LEN = 8;
const PHONE_NAME_OFF = 0x230;
const PHONE_NAME_LEN = 6;
export const PHONE_DIAL_CHARS = "0123456789*#P";
// A9 ASCII string block slots (11 chars): STATUS x8, MESSAGE x8, CODE x4,
// UNIT x8, UNIT x8, PHONE x9, SITE x8, MPL x16, " REMOTE", zone names, mode names
const A9_SLOTS_PHONE_TO_ZONES = PHONE_COUNT + 8 + 16 + 1;
const A9_SLOTS_MPL_TO_ZONES = 16 + 1;
const MPL_REC_LEN = 6;
/** RSS's MPL screen shows TX/TA tones as K / period to 0.1 Hz (display only). */
const MPL_TX_DISPLAY_K = 165600.0;
export const MPL_SLOTS = /** @type {const} */ (["rx", "tx", "ta"]);
const NAME_OK = new Set(" !\"#$%&'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_");

const b = (/** @type {Uint8Array} */ x, /** @type {number} */ o) => /** @type {number} */ (x[o]);

/** [offset, width] of an A9 ASCII table `slotsBeforeZones` slots before the zone names, or null (not A9). */
function a9Block(/** @type {Codeplug} */ cp, /** @type {number} */ slotsBeforeZones) {
    if (!cp.ascii_names) return null;
    const [start, w] = cp.ascii_names;
    const off = start - (cp.zones.length + slotsBeforeZones) * w;
    const blk = cp.body.subarray(Math.max(off, 0), off + slotsBeforeZones * w);
    if (off < 0 || !blk.every((c) => c >= 0x20 && c < 0x7F)) throw new InvalidValue("A9 ASCII string block not where expected");
    return /** @type {[number, number]} */ ([off, w]);
}

/** @typedef {[number, number, "ascii" | "6bit"]} NameSlot  offset, width, encoding */

/** The 9 phone-name slots. */
function phoneNameSlots(/** @type {Codeplug} */ cp) {
    const a9 = a9Block(cp, A9_SLOTS_PHONE_TO_ZONES);
    return Array.from({ length: PHONE_COUNT }, (_, k) => /** @type {NameSlot} */ (a9
        ? [a9[0] + k * a9[1], a9[1], "ascii"]
        : [PHONE_NAME_OFF + k * PHONE_NAME_LEN, PHONE_NAME_LEN, "6bit"]));
}

const nibbles = (/** @type {Uint8Array} */ x) => [...x].flatMap((v) => [v >> 4, v & 0xF]);

/** The phone list. @returns {Phone[]} */
export function decodePhones(/** @type {Codeplug} */ cp) {
    const body = cp.body;
    return phoneNameSlots(cp).map(([noff, w, enc], k) => {
        const raw = body.subarray(noff, noff + w);
        const name = enc === "ascii" ? latin1(raw).replace(/[ \x00]+$/, "") : unpackName(raw);
        const nib = nibbles(body.subarray(PHONE_NUM_OFF + k * PHONE_NUM_LEN, PHONE_NUM_OFF + (k + 1) * PHONE_NUM_LEN));
        const end = nib.indexOf(0xF);
        return { number: k + 1, name, dial: dialDecode(end < 0 ? nib : nib.slice(0, end)) };
    });
}

/** Patch phone names/numbers into `out` (a copy of cp.body), change-gated per entry. */
export function encodePhones(/** @type {Codeplug} */ cp, /** @type {Uint8Array} */ out, /** @type {Phone[]} */ phones) {
    const orig = new Map(decodePhones(cp).map((p) => [p.number, p]));
    const slots = phoneNameSlots(cp);
    for (const p of phones) {
        const o = orig.get(p.number);
        if (!o) throw new InvalidValue(`phone ${p.number}: only entries 1..${PHONE_COUNT} exist`);
        const [noff, w, enc] = /** @type {NameSlot} */ (slots[p.number - 1]);
        if (p.name !== o.name) {
            if (enc === "ascii") {
                if (p.name.length > w || ![...p.name].every((c) => c >= " " && c < "\x7F")) {
                    throw new InvalidValue(`phone ${p.number}: name "${p.name}" must be <= ${w} ASCII characters`);
                }
                out.set(Uint8Array.from(p.name.padEnd(w), (c) => c.charCodeAt(0)), noff);
            } else {
                if (p.name.length > 8) throw new InvalidValue(`phone ${p.number}: name "${p.name}" longer than 8 characters`);
                out.set(packName(p.name.toUpperCase()), noff);
            }
        }
        const dial = p.dial.trim().toUpperCase();
        if (dial !== o.dial) {
            if (dial.length > 2 * PHONE_NUM_LEN || [...dial].some((c) => !PHONE_DIAL_CHARS.includes(c))) {
                throw new InvalidValue(`phone ${p.number}: number "${p.dial}" must be up to 16 of 0-9 * # P`);
            }
            const nib = [...dial].map((c) => PHONE_DIAL_CHARS.indexOf(c)).concat(new Array(2 * PHONE_NUM_LEN - dial.length).fill(0xF));
            const a = PHONE_NUM_OFF + (p.number - 1) * PHONE_NUM_LEN;
            for (let i = 0; i < PHONE_NUM_LEN; i++) out[a + i] = (/** @type {number} */ (nib[2 * i]) << 4) | /** @type {number} */ (nib[2 * i + 1]);
        }
    }
}

/** Is a squelch slot plausible (Carrier, a known DPL code, or a 60..260 Hz tone)? */
function slotOk(/** @type {number} */ hi, /** @type {number} */ lo, /** @type {boolean} */ isTx) {
    const v = (hi << 8) | lo;
    if (v === 0) return true;
    if (v >= 0xC000) return dplDecode(hi, lo)[0] !== null;
    if (!(v & 0x8000)) return false;
    const low = v & 0x7FFF;
    if (!low) return false;
    const f = isTx ? 165596.6 / low : low / 61.2428;
    return f >= 60.0 && f <= 260.0;
}

/**
 * Offset of the MPL table, or null when MPL is disabled: N consecutive valid
 * squelch triples (not all Carrier) and, on standard heads, N plausible
 * 6-bit names after them. Exactly one candidate (throws otherwise).
 */
export function findMplTable(/** @type {Codeplug} */ cp) {
    const body = cp.body;
    const n = b(body, 0x119);
    if (n === 0) return null;
    const a9 = cp.ascii_names !== null;
    const span = n * MPL_REC_LEN;
    /** @type {number[]} */
    let hits = [];
    for (let p = 0x1E8; p < body.length - span * (a9 ? 1 : 2); p++) {
        let ok = true;
        let any = false;
        for (let k = 0; k < n && ok; k++) {
            const r = p + k * MPL_REC_LEN;
            for (let i = 0; i < 3 && ok; i++) ok = slotOk(b(body, r + 2 * i), b(body, r + 2 * i + 1), i > 0);
            for (let i = 0; i < MPL_REC_LEN; i++) if (body[r + i]) any = true;
        }
        if (!ok || !any) continue;
        if (!a9) {
            let names = true;
            for (let k = 0; k < n && names; k++) {
                const nm = unpackName(body.subarray(p + span + 6 * k, p + span + 6 * k + 6));
                names = nm !== "" && [...nm].every((c) => NAME_OK.has(c));
            }
            if (!names) continue;
        }
        hits.push(p);
    }
    // bytes before the table can decode as slots too, shifting it back 6 at a time: the real start is the last
    if (hits.length && hits.every((h, i) => i === 0 || h - /** @type {number} */ (hits[i - 1]) === MPL_REC_LEN)) {
        hits = hits.slice(-1);
    }
    if (hits.length !== 1) throw new InvalidValue(`MPL table not uniquely located ([${hits.map((h) => `'0x${h.toString(16)}'`).join(", ")}])`);
    return /** @type {number} */ (hits[0]);
}

/** DPL polarity sense for MPL slot i (0 = Rx): the Tx sense, except a VHF Rx slot. */
const dplTxSense = (/** @type {number} */ i, /** @type {string} */ band) => i > 0 || band !== "vhf";

/** An MPL slot as RSS's MPL screen shows it: [type, code]. */
export function mplSlotDecode(/** @type {number} */ hi, /** @type {number} */ lo, /** @type {boolean} */ isTx, dplTx = true) {
    const v = (hi << 8) | lo;
    if (v === 0) return /** @type {[string, string]} */ (["Carrier", ""]);
    if (v >= 0xC000) {
        const [t, code] = dplDecode(hi, lo, dplTx);
        return /** @type {[string, string]} */ ([/** @type {string} */ (t), /** @type {string} */ (code).slice(1)]);
    }
    const low = v & 0x7FFF;
    const f = isTx ? MPL_TX_DISPLAY_K / low : low / 61.2428;
    return /** @type {[string, string]} */ (["TPL", pyRound(f, 1).toFixed(1)]);
}

/** [type, code] in MPL wording -> slot bytes; throws InvalidValue. */
export function mplSlotEncode(/** @type {string} */ type, /** @type {string} */ code, /** @type {boolean} */ isTx, dplTx = true) {
    const t = (type ?? "").trim().toUpperCase();
    const c = String(code ?? "").trim();
    if (t === "CARRIER" || t === "CSQ" || t === "") return [0, 0];
    let pair = null;
    if (t === "TPL" || t === "PL") pair = plEncode(c, isTx);
    else if (t === "DPL" || t === "INV.DPL" || t === "INV DPL") pair = dplEncode("D" + c.replace(/^[Dd]+/, "").padStart(3, "0"), t !== "DPL", dplTx);
    else throw new InvalidValue(`MPL squelch type "${type}": expected Carrier/TPL/DPL/INV.DPL`);
    if (!pair) throw new InvalidValue(`MPL ${type} code "${code}" is not valid`);
    return pair;
}

/** The MPL name slots for a table at `p` with `n` entries. */
function mplNameSlots(/** @type {Codeplug} */ cp, /** @type {number} */ p, /** @type {number} */ n) {
    const a9 = a9Block(cp, A9_SLOTS_MPL_TO_ZONES);
    return Array.from({ length: n }, (_, k) => /** @type {NameSlot} */ (a9
        ? [a9[0] + k * a9[1], a9[1], "ascii"]
        : [p + n * MPL_REC_LEN + 6 * k, 6, "6bit"]));
}

/** The MPL list ([] when MPL is disabled). @returns {Mpl[]} */
export function decodeMpls(/** @type {Codeplug} */ cp) {
    const p = findMplTable(cp);
    if (p === null) return [];
    const body = cp.body;
    const n = b(body, 0x119);
    return mplNameSlots(cp, p, n).map(([noff, w, enc], k) => {
        const raw = body.subarray(noff, noff + w);
        const name = enc === "ascii" ? latin1(raw).trim() : unpackName(raw);
        const r = p + k * MPL_REC_LEN;
        const sq = [0, 1, 2].map((i) => mplSlotDecode(b(body, r + 2 * i), b(body, r + 2 * i + 1), i > 0, dplTxSense(i, cp.band)));
        const [[rt, rc], [tt, tc], [at, ac]] = /** @type {[string, string][]} */ (sq);
        return { number: k + 1, name, rx_type: rt, rx_code: rc, tx_type: tt, tx_code: tc, ta_type: at, ta_code: ac };
    });
}

/** Patch MPL names/squelch into `out`, change-gated per field. */
export function encodeMpls(/** @type {Codeplug} */ cp, /** @type {Uint8Array} */ out, /** @type {Mpl[]} */ rows) {
    const p = findMplTable(cp);
    const orig = new Map(decodeMpls(cp).map((m) => [m.number, m]));
    if (!orig.size && rows.length) throw new InvalidValue("MPL is disabled in this codeplug (Number of MPL = 0); enable it in RSS first");
    const slots = orig.size ? mplNameSlots(cp, /** @type {number} */ (p), orig.size) : [];
    for (const m of rows) {
        const o = orig.get(m.number);
        if (!o) throw new InvalidValue(`MPL ${m.number}: only entries 1..${orig.size} exist`);
        const [noff, w, enc] = /** @type {NameSlot} */ (slots[m.number - 1]);
        if (m.name !== o.name) {
            if (enc === "ascii") {
                if (m.name.length > w) throw new InvalidValue(`MPL ${m.number}: name "${m.name}" longer than ${w}`);
                out.set(Uint8Array.from(m.name.padEnd(w), (c) => c.charCodeAt(0)), noff);
            } else {
                if (m.name.length > 8) throw new InvalidValue(`MPL ${m.number}: name "${m.name}" longer than 8`);
                out.set(packName(m.name.toUpperCase()), noff);
            }
        }
        MPL_SLOTS.forEach((s, i) => {
            const t = m[`${s}_type`];
            const c = m[`${s}_code`];
            if (t === o[`${s}_type`] && c === o[`${s}_code`]) return;
            const a = /** @type {number} */ (p) + (m.number - 1) * MPL_REC_LEN + 2 * i;
            out.set(mplSlotEncode(t, c, i > 0, dplTxSense(i, cp.band)), a);
        });
    }
}
