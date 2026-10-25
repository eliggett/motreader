// @ts-check
/**
 * Squelch tone slots: CTCSS ("PL") and DPL codes (FORMAT §5a/§5b).
 *
 * Every mode has three 2-byte slots, Rx / Tx / T·A, in one codec on both
 * bands. Bit 15 enables a tone; the low 15 bits encode a CTCSS tone two ways:
 * the Tx/T·A slots store a period (Hz = 165596.6 / v), the Rx slot a linear
 * value (Hz = v / 61.2428). Values 0xC000 and up are DPL, looked up in the
 * 83-code map below after masking off the polarity bit (0x20 of the high byte;
 * SET = DPL in a VHF Rx slot, SET = INV.DPL in every other slot).
 */
import { pyRound } from "./num.js";

export const CTCSS_TONES = [
    67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4,
    100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5,
    141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8,
    177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5,
    210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
];
const PL_TX_K = 165596.6;
const PL_RX_K = 61.2428;
const PL_ENABLE = 0x8000;
const DPL_NORMAL_BIT = 0x20;

/**
 * Exact tone -> slot bytes captured from RSS (cycling the 221AZN TPL CODE
 * field). The formulas decode every tone correctly but a few encode one count
 * off, so encoding prefers these.
 * @type {Record<string, [number, number]>}
 */
const PL_RX_BY_TONE = {
    "250.3": [0xbb, 0xe1], "233.6": [0xb7, 0xe2], "229.1": [0xb6, 0xcf], "225.7": [0xb5, 0xfe],
    "218.1": [0xb4, 0x2d], "210.7": [0xb2, 0x68], "206.5": [0xb1, 0x66], "203.5": [0xb0, 0xaf],
    "192.8": [0xae, 0x1f], "186.2": [0xac, 0x8b], "179.9": [0xab, 0x09], "173.8": [0xa9, 0x94],
    "167.9": [0xa8, 0x2b], "162.2": [0xa6, 0xcd], "156.7": [0xa5, 0x7d], "151.4": [0xa4, 0x38],
    "146.2": [0xa2, 0xfa], "141.3": [0xa1, 0xce], "136.5": [0xa0, 0xa8], "131.8": [0x9f, 0x88],
    "127.3": [0x9e, 0x74], "123.0": [0x9d, 0x6d], "118.8": [0x9c, 0x6c], "114.8": [0x9b, 0x77],
    "110.9": [0x9a, 0x88], "107.2": [0x99, 0xa5], "103.5": [0x98, 0xc3], "100.0": [0x97, 0xec],
    "97.4": [0x97, 0x4d], "94.8": [0x96, 0xae], "91.5": [0x95, 0xe4], "88.5": [0x95, 0x2c],
    "85.4": [0x94, 0x6e], "82.5": [0x93, 0xbc], "79.7": [0x93, 0x11], "77.0": [0x92, 0x6c],
    "74.4": [0x91, 0xcc], "71.9": [0x91, 0x33], "69.3": [0x90, 0x94], "67.0": [0x90, 0x07],
};
/** @type {Record<string, [number, number]>} */
const PL_TX_BY_TONE = {
    "250.3": [0x82, 0x96], "233.6": [0x82, 0xc5], "229.1": [0x82, 0xd3], "225.7": [0x82, 0xde],
    "218.1": [0x82, 0xf7], "210.7": [0x83, 0x12], "206.5": [0x83, 0x22], "203.5": [0x83, 0x2e],
    "192.8": [0x83, 0x5b], "186.2": [0x83, 0x79], "179.9": [0x83, 0x99], "173.8": [0x83, 0xb9],
    "167.9": [0x83, 0xda], "162.2": [0x83, 0xfd], "156.7": [0x84, 0x21], "151.4": [0x84, 0x46],
    "146.2": [0x84, 0x6d], "141.3": [0x84, 0x94], "136.5": [0x84, 0xbd], "131.8": [0x84, 0xe8],
    "127.3": [0x85, 0x15], "123.0": [0x85, 0x42], "118.8": [0x85, 0x72], "114.8": [0x85, 0xa3],
    "110.9": [0x85, 0xd5], "107.2": [0x86, 0x09], "103.5": [0x86, 0x40], "100.0": [0x86, 0x78],
    "97.4": [0x86, 0xa4], "94.8": [0x86, 0xd3], "91.5": [0x87, 0x12], "88.5": [0x87, 0x4f],
    "85.4": [0x87, 0x93], "82.5": [0x87, 0xd7], "79.7": [0x88, 0x1e], "77.0": [0x88, 0x67],
    "74.4": [0x88, 0xb2], "71.9": [0x88, 0xff], "69.3": [0x89, 0x56], "67.0": [0x89, 0xa8],
};

/** The standard 83 DPL codes by (hi & ~0x20, lo) slot bytes, as "hi,lo" keys. */
const DPL_CODE_BY_PAIR = new Map(Object.entries({
    "d8,64": "023", "dc,54": "025", "d4,34": "026", "dc,4c": "031", "d4,2c": "032", "cc,62": "043",
    "d4,72": "047", "c8,4a": "051", "c4,1a": "054", "d0,56": "065", "d0,4e": "071", "d8,2e": "072",
    "cc,6e": "073", "dc,1e": "074", "cc,19": "114", "d8,59": "115", "d0,39": "116", "d8,55": "125",
    "d8,4d": "131", "d0,2d": "132", "d4,1d": "134", "c8,63": "143", "c4,2b": "152", "d4,5b": "155",
    "dc,3b": "156", "c4,27": "162", "d4,57": "165", "dc,2f": "172", "d8,1f": "174", "d1,50": "205",
    "cd,64": "223", "c1,34": "226", "d9,62": "243", "c9,12": "244", "dd,52": "245", "dd,4a": "251",
    "dd,46": "261", "c1,66": "263", "c5,56": "265", "c5,4e": "271", "cd,31": "306", "d5,49": "311",
    "cd,59": "315", "cd,4d": "331", "dd,63": "343", "d1,33": "346", "d9,4b": "351", "d5,17": "364",
    "c1,57": "365", "c1,4f": "371", "cc,c8": "411", "c4,a8": "412", "d0,e8": "413", "d0,e4": "423",
    "d4,cc": "431", "dc,ac": "432", "c0,d2": "445", "cc,96": "464", "d8,d6": "465", "d0,b6": "466",
    "cc,e1": "503", "c0,b1": "506", "d8,b9": "516", "d8,ad": "532", "cc,b3": "546", "dc,d7": "565",
    "d1,b0": "606", "d1,a8": "612", "d5,94": "624", "dd,f4": "627", "c1,cc": "631", "c9,ac": "632",
    "d9,9a": "654", "dd,a6": "662", "d9,96": "664", "d9,e1": "703", "d5,a9": "712", "c1,e5": "723",
    "c5,cd": "731", "cd,ad": "732", "c9,9d": "734", "d5,e3": "743", "dd,9b": "754",
}));
/** @type {Map<string, [number, number]>} DPL code ("411") -> slot bytes */
const DPL_PAIR_BY_CODE = new Map([...DPL_CODE_BY_PAIR].map(([k, v]) => {
    const [hi, lo] = k.split(",").map((x) => parseInt(x, 16));
    return [v, [/** @type {number} */ (hi), /** @type {number} */ (lo)]];
}));
const pairKey = (/** @type {number} */ hi, /** @type {number} */ lo) =>
    `${hi.toString(16).padStart(2, "0")},${lo.toString(16).padStart(2, "0")}`;

/** All DPL codes, as "D023" ... "D754". */
export const DPL_CODES = [...DPL_PAIR_BY_CODE.keys()].map((c) => "D" + c);

/** @typedef {"Carrier" | "PL" | "DPL" | "INV.DPL"} SquelchType */

/** The standard CTCSS tone nearest `freq`, as "100.0". */
function nearestCtcss(/** @type {number} */ freq) {
    let best = /** @type {number} */ (CTCSS_TONES[0]);
    for (const t of CTCSS_TONES) if (Math.abs(t - freq) < Math.abs(best - freq)) best = t;
    return best.toFixed(1);
}

/** A PL slot -> tone string ("100.0"), or null. `isTx` selects the period formula. */
export function plDecode(/** @type {number} */ hi, /** @type {number} */ lo, /** @type {boolean} */ isTx) {
    const val = (hi << 8) | lo;
    if (!(val & PL_ENABLE)) return null;
    const low = val & 0x7FFF;
    if (low === 0 || val >= 0xC000) return null;
    return nearestCtcss(isTx ? PL_TX_K / low : low / PL_RX_K);
}

/** A tone string -> PL slot bytes, or null. */
export function plEncode(/** @type {string | number} */ tone, /** @type {boolean} */ isTx) {
    const f = Number(tone);
    if (!Number.isFinite(f) || f <= 0) return null;
    const pair = (isTx ? PL_TX_BY_TONE : PL_RX_BY_TONE)[pyRound(f, 1).toFixed(1)];
    if (pair) return /** @type {[number, number]} */ ([...pair]);
    const low = isTx ? pyRound(PL_TX_K / f) : pyRound(f * PL_RX_K);
    const val = PL_ENABLE | (low & 0x7FFF);
    return /** @type {[number, number]} */ ([(val >> 8) & 0xFF, val & 0xFF]);
}

/** Is a DPL slot's polarity normal (else inverted)? The sense flips for Tx slots. */
const dplNormal = (/** @type {number} */ hi, /** @type {boolean} */ isTx) => Boolean(hi & DPL_NORMAL_BIT) !== isTx;

/** A DPL slot -> [type, "D754"], or [null, null] if not a known code. */
export function dplDecode(/** @type {number} */ hi, /** @type {number} */ lo, isTx = false) {
    const code = DPL_CODE_BY_PAIR.get(pairKey(hi & (~DPL_NORMAL_BIT & 0xFF), lo));
    if (code === undefined) return /** @type {[null, null]} */ ([null, null]);
    return /** @type {[SquelchType, string]} */ ([dplNormal(hi, isTx) ? "DPL" : "INV.DPL", "D" + code]);
}

/** A DPL code ("D754") and polarity -> slot bytes, or null. */
export function dplEncode(/** @type {string} */ code, /** @type {boolean} */ inverted, isTx = false) {
    if (!code || code[0] !== "D") return null;
    const pair = DPL_PAIR_BY_CODE.get(code.slice(1));
    if (!pair) return null;
    const [h, lo] = pair;
    return /** @type {[number, number]} */ ([inverted === isTx ? h | DPL_NORMAL_BIT : h, lo]);
}

/** Classify a slot: Carrier (0), DPL family (>= 0xC000), PL (bit 15), else null. */
export function squelchType(/** @type {number} */ hi, /** @type {number} */ lo, isTx = false) {
    const val = (hi << 8) | lo;
    if (val === 0) return "Carrier";
    if (val >= 0xC000) return dplNormal(hi, isTx) ? "DPL" : "INV.DPL";
    if (val & PL_ENABLE) return "PL";
    return null;
}

/**
 * A slot -> [type, code]: code is a tone ("141.3"), a DPL code ("D411") or
 * null (Carrier). `plTx`: Tx tone formula; `dplTx`: Tx DPL polarity sense.
 * @returns {[SquelchType | null, string | null]}
 */
export function slotDecode(/** @type {number} */ hi, /** @type {number} */ lo, /** @type {boolean} */ plTx, /** @type {boolean} */ dplTx) {
    const t = squelchType(hi, lo, dplTx);
    if (t === "PL") return [t, plDecode(hi, lo, plTx)];
    if (t === "DPL" || t === "INV.DPL") return [t, dplDecode(hi, lo, dplTx)[1]];
    return [t, null];
}

/** [type, code] -> slot bytes, or null if it can't be encoded. */
export function slotEncode(/** @type {SquelchType} */ type, /** @type {string | null} */ code, /** @type {boolean} */ plTx, /** @type {boolean} */ dplTx) {
    if (type === "Carrier") return /** @type {[number, number]} */ ([0, 0]);
    if (type === "PL") return code === null ? null : plEncode(code, plTx);
    return code === null ? null : dplEncode(code, type === "INV.DPL", dplTx);
}

/** Is `code` a known DPL code like "D411"? */
export const isDplCode = (/** @type {string} */ code) => code[0] === "D" && DPL_PAIR_BY_CODE.has(code.slice(1));
