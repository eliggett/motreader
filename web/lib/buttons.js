// @ts-check
/**
 * Control-head buttons (RSS CHANGE/VIEW -> CONTROL HEAD -> F2 KEYPAD), the
 * CLI's buttons.csv. Port of motreader/buttons.py and buttons_a9.py.
 *
 * Standard / Enhanced / Rotary heads: a fixed table of 20 x 4-byte function
 * codes at 0x123 (entry: Ind 1-5 = 0-4, key 0 = 8, keys 1-9 = 9-17, * / # =
 * 18 / 19). Ind 5 (Sel), * and # (Rcl / Del, one code, label by position) are
 * fixed in RSS. Radios without a full keypad (0x10D b1) have Ind 1-5 and keys
 * 7, 8, 9 only. RSS keeps CHB+0x46 b4 set while some button has Airhn (with
 * the control-head block's checksum); no other function touches anything
 * outside the table.
 *
 * A9 / S9000e head: 88 x 7-byte key records in two copies 0x268 apart (copy 2
 * is the trunking layer), a bitmap of the records whose 2nd byte is 0x90, and
 * an indicator list of 5-byte entries (Ind n lights LED n + 5), all under the
 * A9 head checksum. A function is a template (a9table.js) plus the key's home
 * code. Fixed in RSS: *, 0, # ("May NOT Be Changed"), Ind 1 (Sel) and Home
 * ("SEL / HOME Button Is REQUIRED").
 *
 * `hack` (experimental, the UI's "not in RSS" choices): change the buttons RSS
 * keeps fixed and, on the A9, put functions on keys RSS doesn't offer them on.
 * RSS never wrote these; on the A9 a function then takes the key's home code
 * as on the other keys.
 */
import { InvalidValue } from "./errors.js";
import { a9HeadChecksumOff } from "./a9.js";
import { FUNCTIONS as A9_FUNCTIONS, ALLOWED as A9_ALLOWED } from "./a9table.js";
import { hex as hexOf, fromHex } from "./bytes.js";
import { findChbBlock, CHB_CK, CHB_SUM_LO, sum8 } from "./radiowide.js";

/** @typedef {import("./codeplug.js").Codeplug} Codeplug */
/**
 * @typedef {{ button: string, function: string, name: string, code: string, editable: boolean }} Button
 *   function: RSS's short label (A9 direct entry: "Zone 3"), or "0x<hex>" for an
 *   unknown code; name: RSS's full name; code: the raw bytes, hex;
 *   editable: RSS lets you change it.
 */
/** @typedef {{ button: string, function: string, hack?: boolean }} ButtonRow  hack: this row may do what RSS doesn't */

// ---------------------------------------------------------------------------
// Standard / Enhanced / Rotary heads

const TABLE_OFF = 0x123;
const ENTRY_LEN = 4;
const NO_KEYPAD = /** @type {const} */ ([0x10D, 1]);
/** @type {Readonly<Record<string, number>>} */
const ENTRIES = {
    "Ind 1": 0, "Ind 2": 1, "Ind 3": 2, "Ind 4": 3, "Ind 5": 4,
    "1": 9, "2": 10, "3": 11, "4": 12, "5": 13, "6": 14,
    "7": 15, "8": 16, "9": 17, "*": 18, "0": 8, "#": 19,
};
export const KEYPAD_ORDER = /** @type {const} */ (["Ind 1", "Ind 2", "Ind 3", "Ind 4", "Ind 5",
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]);
export const SMALL_ORDER = /** @type {const} */ (["Ind 1", "Ind 2", "Ind 3", "Ind 4", "Ind 5", "7", "8", "9"]);
const FIXED = new Set(["Ind 5", "*", "#"]);   // no RSS tab stop (Rotary too: owner, 2026-10-28)
const SEL = "01100000";   // RSS offers Sel on no other button: Ind 5 keeps it
/** @type {Readonly<Record<string, string>>} */
const FIXED_LABEL = { "*": "Rcl", "#": "Del" };
const BLANK = "00000000";
const RCL_DEL = "02020000";
const AIRHN = "08050000";
const AIRHN_FLAG = /** @type {const} */ ([0x46, 4]);   // CHB+0x46 b4: some button has Airhn
/** code (hex) -> [RSS short label, RSS full name] */
/** @type {Readonly<Record<string, [string, string]>>} */
export const FUNCTIONS = {
    "00000000": ["Blank", "Blank Button, no function"],
    "00040004": ["Emer", "Emergency"],
    "01000000": ["ZnUP", "Zone Up"],
    "01800000": ["ZnDN", "Zone Down"],
    "01040000": ["Dir", "Conventional Direct"],
    "01050103": ["Mon", "Monitor"],
    "010d010e": ["H/L", "Horn and Lights"],
    "010f0000": ["RSSI", "Receive Signal Strength Ind."],
    "01100000": ["Sel", "Select"],
    "02000201": ["Scan", "Scan"],
    "02020000": ["Rcl/Del", "Keypad recall / delete (fixed * and # keys)"],
    "03000301": ["MPL", "Multiple Private Line"],
    "08000000": ["Siren", "Siren On/Off"],
    "08020000": ["PA", "Public Address"],
    "08050000": ["Airhn", "Siren Airhorn Selection"],
    "08060000": ["XRadB", "Standalone External Radio ON/OFF"],
    "080a0000": ["Wail", "Siren Wail Selection"],
    "080b0000": ["Yelp", "Siren Yelp Selection"],
    "080c0000": ["HiLo", "Siren HiLo Selection"],
    "080d0000": ["Man", "Manual Siren"],
    "080e0000": ["XRadA", "Siren External Radio Selection"],
    "0a000000": ["Sts", "Status,Keypad Data Entry Allowed"],
    "0b000000": ["Msg", "Message,Keypad Data Entry Allowed"],
    "0c080000": ["Bid", "Bid Button"],
    "10051005": ["Lck", "AMSS Lock"],
    "10061006": ["Ste", "AMSS Site"],
    "100e100e": ["Rpg", "Trunking Reprogram Request"],
    "11010000": ["Phone", "Trunk and/or Conv. Phone"],
    "11030000": ["Page", "MDC Page,Trunking Call Alert"],
    "11060000": ["Call", "Conv. MDC Call,Trnk Private Call"],
    "12011200": ["VRS", "Vehicle Repeater System"],
    "14001401": ["ST", "SingleTone"],
    "011a0000": ["A/B", "Speaker A/B"],
};
/** label (lower case) -> code; the fixed * / # code isn't assignable by label */
const CODE_BY_LABEL = new Map(Object.entries(FUNCTIONS).filter(([, [l]]) => l !== "Rcl/Del").map(([c, [l]]) => [l.toLowerCase(), c]));

/** Standard / Enhanced / Rotary heads (not the A9 / S9000e). */
const hasTable = (/** @type {Codeplug} */ cp) => cp.ascii_names === null;

/** The buttons of a standard-head radio, in RSS's order. */
export function layout(/** @type {Uint8Array} */ body) {
    return (/** @type {number} */ (body[NO_KEYPAD[0]]) >> NO_KEYPAD[1]) & 1 ? SMALL_ORDER : KEYPAD_ORDER;
}

const entryOff = (/** @type {string} */ btn) => TABLE_OFF + ENTRY_LEN * /** @type {number} */ (ENTRIES[btn]);

/** @returns {Button[]} */
function decodeTable(/** @type {Codeplug} */ cp) {
    return layout(cp.body).map((btn) => {
        const code = hexOf(cp.body.subarray(entryOff(btn), entryOff(btn) + ENTRY_LEN));
        let [lab, name] = FUNCTIONS[code] ?? [`0x${code}`, ""];
        if (btn in FIXED_LABEL && code === RCL_DEL) lab = /** @type {string} */ (FIXED_LABEL[btn]);
        return { button: btn, function: lab, name, code, editable: !FIXED.has(btn) };
    });
}

function parseFunction(/** @type {string} */ btn, /** @type {string} */ func) {
    const f = func.trim();
    if (/^0x[0-9a-f]{8}$/i.test(f)) return f.slice(2).toLowerCase();
    let code = CODE_BY_LABEL.get(f.toLowerCase());
    if (code === undefined && [(FIXED_LABEL[btn] ?? "").toLowerCase(), "rcl/del"].includes(f.toLowerCase())) code = RCL_DEL;
    if (code === undefined) {
        const known = Object.values(FUNCTIONS).map(([l]) => l).sort();
        throw new InvalidValue(`button ${btn}: unknown function ${JSON.stringify(func)} (known: ${known.join(", ")})`);
    }
    return code;
}

/** @param {Codeplug} cp @param {Uint8Array} body @param {ButtonRow[]} rows @param {boolean} hack */
function encodeTable(cp, body, rows, hack) {
    const orig = new Map(decodeTable(cp).map((b) => [b.button, b]));
    /** @type {Map<string, string>} */
    const want = new Map();
    for (const r of rows) {
        const o = orig.get(r.button);
        if (!o) throw new InvalidValue(`button ${JSON.stringify(r.button)} does not exist on this radio (buttons: ${[...orig.keys()].join(", ")})`);
        if (r.function.trim().toLowerCase() === o.function.toLowerCase()) {
            want.set(r.button, o.code);
            continue;
        }
        if (!o.editable && !hack && !r.hack) throw new InvalidValue(`button ${r.button} is fixed in RSS (${o.function})`);
        const code = parseFunction(r.button, r.function);
        if (code === SEL && !hack && !r.hack) throw new InvalidValue(`button ${r.button}: RSS doesn't offer Sel there (it stays on Ind 5)`);
        want.set(r.button, code);
    }
    /** @type {Map<string, string>} */
    const seen = new Map();
    for (const [b, o] of orig) {
        const code = want.get(b) ?? o.code;
        if (code === BLANK || code === RCL_DEL || (FIXED.has(b) && code === o.code)) continue;
        const other = seen.get(code);
        if (other !== undefined) {
            const lab = FUNCTIONS[code]?.[0] ?? `0x${code}`;
            throw new InvalidValue(`buttons ${other} and ${b} both have ${lab}: RSS refuses duplicate buttons (blank one of them)`);
        }
        seen.set(code, b);
    }
    if ([...want].every(([b, code]) => code === orig.get(b)?.code)) return;
    for (const [b, code] of want) if (code !== orig.get(b)?.code) body.set(fromHex(code), entryOff(b));
    airhnFlag(body, [...orig].some(([b, o]) => (want.get(b) ?? o.code) === AIRHN));
}

/** CHB+0x46 b4 follows "some button has Airhn" (and the CHB checksum). */
function airhnFlag(/** @type {Uint8Array} */ body, /** @type {boolean} */ on) {
    const c = findChbBlock(body);
    if (c === null) return;
    const [o, bit] = AIRHN_FLAG;
    const was = /** @type {number} */ (body[c + o]);
    const v = on ? was | (1 << bit) : was & ~(1 << bit) & 0xFF;
    if (v === was) return;
    body[c + o] = v;
    body[c + CHB_CK] = sum8(body, c + CHB_SUM_LO, c + CHB_CK);
}

// ---------------------------------------------------------------------------
// A9 / S9000e head

const N_RECS = 88;
const REC_LEN = 7;
const COPY2 = 0x268;
const MAP_FROM_CK = 0x23;
const SIDE_FROM_MAP = 0x7D2;
const BITMAP_LEN = 11;
const SIDE_LEN = 5;
const SIDE_CAP = 0x180;
/** button -> [record index, home key code, LED or null], in export order */
/** @type {ReadonlyMap<string, [number, number, number | null]>} */
const KEYS = new Map(/** @type {[string, [number, number, number | null]][]} */ ([
    ["Ind 1", [19, 0x0e, 6]], ["Ind 2", [27, 0x14, 7]], ["Ind 3", [35, 0x15, 8]],
    ["Ind 4", [21, 0x16, 9]], ["Ind 5", [29, 0x17, 0x0A]], ["Ind 6", [37, 0x18, 0x0B]],
    ["1", [22, 0x01, null]], ["2", [39, 0x02, null]], ["3", [15, 0x03, null]],
    ["4", [23, 0x04, null]], ["5", [38, 0x05, null]], ["6", [14, 0x06, null]],
    ["7", [20, 0x07, null]], ["8", [18, 0x08, null]], ["9", [12, 0x09, null]],
    ["*", [17, 0x0a, null]], ["0", [34, 0x00, null]], ["#", [10, 0x0b, null]],
    ["Mode Dn", [28, 0x12, null]], ["Mode Up", [26, 0x12, null]],
    ["Vol Dn", [33, 0x12, null]], ["Vol Up", [36, 0x12, null]],
    ["Zone Up", [25, 0x12, null]], ["Home", [9, 0x12, null]],
]));
const A9_FIXED = new Set(["*", "0", "#", "Ind 1", "Home"]);
const IND = [...KEYS.keys()].filter((k) => k.startsWith("Ind"));
const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const DUP_SCOPE = new Set([...IND, ...KEYPAD]);
const NOT_OFFERED = new Set(["Securenet"]);
/** RSS writes the same bytes for both; decode shows the key, import accepts both */
const ALIASES = new Set(["V/A Dn", "V/A Up", "Scrl-Lt", "Scrl-Rt", "Send-A", "Pass"]);
const A9_BLANK_REC = "008000000000";

/** Key of ALLOWED: "ind", "keypad", or the labelled key's own name. */
const keyClass = (/** @type {string} */ b) => (IND.includes(b) ? "ind" : KEYPAD.includes(b) ? "keypad" : b);

/** [map start, indicator list start] or null if the structure isn't the one mapped. */
function a9Layout(/** @type {Codeplug} */ cp) {
    const ck = a9HeadChecksumOff(cp);
    if (ck === null) return null;
    const m = ck + MAP_FROM_CK;
    const b = cp.body;
    const s = m + SIDE_FROM_MAP;
    if (s + SIDE_CAP > b.length) return null;
    let blanks = 0;
    for (let i = 40; i < N_RECS; i++) {
        const a = m + COPY2 + REC_LEN * i;
        if (hexOf(b.subarray(a, a + 6)) === A9_BLANK_REC) blanks++;
    }
    if (blanks < 30 || readSide(b, s) === null) return null;
    return /** @type {[number, number]} */ ([m, s]);
}

/** The indicator list's entries (hex), or null if it doesn't end in its area. */
function readSide(/** @type {Uint8Array} */ b, /** @type {number} */ s) {
    /** @type {string[]} */
    const out = [];
    for (let a = s; a + SIDE_LEN <= s + SIDE_CAP; a += SIDE_LEN) {
        const e = hexOf(b.subarray(a, a + SIDE_LEN));
        if (e === "0000000000") return out;
        out.push(e);
    }
    return null;
}

const rec = (/** @type {Uint8Array} */ b, /** @type {number} */ m, /** @type {number} */ idx, /** @type {number} */ copy) => {
    const a = m + copy * COPY2 + REC_LEN * idx;
    return hexOf(b.subarray(a, a + REC_LEN));
};

const keyCode = (/** @type {number | string | null} */ c, /** @type {number} */ home) => (c === null ? home : c === "+1d" ? (home + 0x1D) & 0x3F : /** @type {number} */ (c));
const ledOf = (/** @type {string} */ e) => parseInt(e.slice(6, 8), 16) & 0x3F;

/** [record 1, record 2, indicator entries] (hex) for a function on a key. */
function build(/** @type {string} */ label, /** @type {number} */ home, /** @type {number} */ led, /** @type {number} */ data) {
    const [, r1, r2, sides, slots] = /** @type {import("./a9table.js").A9Function} */ (A9_FUNCTIONS[label]);
    const recs = [r1, r2].map(([t, fl, c]) => [...fromHex(t), fl | keyCode(c, home)]);
    const ents = sides.map((e) => {
        const x = [...fromHex(e)];
        x[3] = /** @type {number} */ (x[3]) | led;
        return x;
    });
    for (const [where, i] of slots) {
        const tgt = where === "r1" ? recs[0] : where === "r2" ? recs[1] : ents[Number(where.slice(1))];
        /** @type {number[]} */ (tgt)[i] = data;
    }
    const h = (/** @type {number[]} */ x) => hexOf(Uint8Array.from(x));
    return /** @type {[string, string, string[]]} */ ([h(/** @type {number[]} */ (recs[0])), h(/** @type {number[]} */ (recs[1])), ents.map(h)]);
}

/** The data value (or true) if `button`'s bytes are exactly `label`, else null. */
function match(/** @type {string} */ label, /** @type {Uint8Array} */ b, /** @type {number} */ m, /** @type {string[]} */ side, /** @type {string} */ button) {
    const [idx, home, led] = /** @type {[number, number, number | null]} */ (KEYS.get(button));
    const have1 = rec(b, m, idx, 0);
    const have2 = rec(b, m, idx, 1);
    const mine = side.filter((e) => led !== null && ledOf(e) === led);
    const [, [t1], , , slots] = /** @type {import("./a9table.js").A9Function} */ (A9_FUNCTIONS[label]);
    if (have1.slice(0, 6) !== t1.slice(0, 6)) return null;   // quick reject (data slots are at byte 3 on)
    const r1Data = [...new Set(slots.filter(([w]) => w === "r1").map(([, i]) => parseInt(have1.slice(2 * i, 2 * i + 2), 16)))];
    const cands = !slots.length ? [0] : (r1Data.length ? r1Data : [0]).sort((x, y) => x - y);
    for (const d of cands) {
        const [r1, r2, ents] = build(label, home, led ?? 0, d);
        if (r1 === have1 && r2 === have2 && (led === null || ents.join() === mine.join())) return slots.length ? d : true;
    }
    return null;
}

const takesData = (/** @type {string} */ label) => /** @type {import("./a9table.js").A9Function} */ (A9_FUNCTIONS[label])[4].length > 0;
const labelOf = (/** @type {string} */ label, /** @type {number | true} */ d) => (takesData(label) ? label.replace("X", String(d)) : label);

/** @returns {Button[]} */
function decodeA9(/** @type {Codeplug} */ cp) {
    const lay = a9Layout(cp);
    if (!lay) return [];
    const [m, s] = lay;
    const b = cp.body;
    const side = /** @type {string[]} */ (readSide(b, s));
    return [...KEYS].map(([btn, [idx]]) => {
        const raw = rec(b, m, idx, 0) + rec(b, m, idx, 1);
        let lab = `0x${raw}`;
        let name = "";
        for (const cand of Object.keys(A9_FUNCTIONS)) {
            if (ALIASES.has(cand)) continue;
            const d = match(cand, b, m, side, btn);
            if (d !== null) {
                lab = labelOf(cand, d);
                name = /** @type {import("./a9table.js").A9Function} */ (A9_FUNCTIONS[cand])[0];
                break;
            }
        }
        return { button: btn, function: lab, name, code: raw, editable: !A9_FIXED.has(btn) };
    });
}

/** "Zone 3" -> ["Zone X", 3]; "Scan" -> ["Scan", 0]. */
function parseA9(/** @type {string} */ btn, /** @type {string} */ func) {
    const f = func.split(/\s+/).filter(Boolean).join(" ");
    for (const lab of Object.keys(A9_FUNCTIONS)) {
        if (!takesData(lab)) {
            if (lab.toLowerCase() === f.toLowerCase()) return /** @type {[string, number]} */ ([lab, 0]);
            continue;
        }
        const stem = lab.slice(0, -1).trim().toLowerCase();
        const rest = f.slice(stem.length).trim();
        if (f.toLowerCase().startsWith(stem) && /^\d+$/.test(rest)) return /** @type {[string, number]} */ ([lab, Number(rest)]);
    }
    throw new InvalidValue(`button ${btn}: unknown A9 function ${JSON.stringify(func)} (known: ${Object.keys(A9_FUNCTIONS).sort().join(", ")})`);
}

const LED_REC = new Map([...KEYS.values()].filter(([, , led]) => led !== null).map(([idx, , led]) => [led, idx]));

/** One Ind key's indicator entries replaced, keeping RSS's order (fixed radio entries, then Ind keys by record). */
function place(/** @type {string[]} */ side, /** @type {string[]} */ ents, /** @type {number} */ led, /** @type {number} */ idx) {
    const keep = side.filter((e) => ledOf(e) !== led);
    let pos = 0;
    keep.forEach((e, i) => {
        const own = LED_REC.get(ledOf(e));
        if (own === undefined || own < idx) pos = i + 1;
    });
    return [...keep.slice(0, pos), ...ents, ...keep.slice(pos)];
}

/** @param {Codeplug} cp @param {Uint8Array} body @param {ButtonRow[]} rows @param {boolean} hack */
function encodeA9(cp, body, rows, hack) {
    const lay = a9Layout(cp);
    if (!lay) throw new InvalidValue("A9 key map not recognized; refusing to edit buttons");
    const [m, s] = lay;
    const orig = new Map(decodeA9(cp).map((x) => [x.button, x]));
    const norm = (/** @type {string} */ x) => x.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
    /** @type {Map<string, [string, number]>} */
    const want = new Map();
    for (const r of rows) {
        const o = orig.get(r.button);
        if (!o) throw new InvalidValue(`button ${JSON.stringify(r.button)} does not exist on this head (buttons: ${[...orig.keys()].join(", ")})`);
        if (norm(r.function) === norm(o.function)) continue;
        if (!o.editable && !hack && !r.hack) throw new InvalidValue(`button ${r.button} is fixed in RSS (${o.function})`);
        const [lab, d] = parseA9(r.button, r.function);
        const allowed = A9_ALLOWED[keyClass(r.button)] ?? [];
        if (NOT_OFFERED.has(lab) || (!allowed.includes(lab) && !hack && !r.hack)) {
            throw new InvalidValue(`button ${r.button}: RSS does not offer ${JSON.stringify(lab)} there (offered: ${allowed.join(", ")})`);
        }
        if (takesData(lab) && !(d >= 1 && d <= 99)) throw new InvalidValue(`button ${r.button}: ${lab} needs a number (e.g. ${JSON.stringify(lab.replace("X", "2"))})`);
        want.set(r.button, [lab, d]);
    }
    if (!want.size) return;
    // RSS refuses the same function on two buttons ("Duplicate Buttons!"), by
    // label (Send-A next to Sel is accepted), among Ind 1-6 and keys 1-9
    /** @type {Map<string, string>} */
    const final = new Map([...orig].map(([btn, o]) => {
        const w = want.get(btn);
        return [btn, w ? labelOf(w[0], w[1]) : o.function];
    }));
    for (const btn of want.keys()) {
        const lab = /** @type {string} */ (final.get(btn));
        if (lab === "Blank" || !DUP_SCOPE.has(btn)) continue;
        for (const [other, olab] of final) {
            if (other !== btn && DUP_SCOPE.has(other) && olab.toLowerCase() === lab.toLowerCase()) {
                throw new InvalidValue(`buttons ${btn} and ${other} both have ${lab}: RSS refuses duplicate buttons (blank one of them)`);
            }
        }
    }
    const before = body.slice();
    let side = /** @type {string[]} */ (readSide(body, s));
    for (const [btn, [lab, d]] of want) {
        const [idx, home, led] = /** @type {[number, number, number | null]} */ (KEYS.get(btn));
        const [r1, r2, ents] = build(lab, home, led ?? 0, d);
        const a = m + REC_LEN * idx;
        body.set(fromHex(r1), a);
        body.set(fromHex(r2), a + COPY2);
        if (led !== null) side = place(side, ents, led, idx);
        const bitAt = m - BITMAP_LEN + (idx >> 3);
        const bit = 0x80 >> (idx & 7);
        const v = /** @type {number} */ (body[bitAt]);
        body[bitAt] = r1.slice(2, 4) === "90" ? v | bit : v & ~bit & 0xFF;
    }
    const raw = side.join("");
    if (raw.length / 2 + SIDE_LEN > SIDE_CAP) throw new InvalidValue("A9 indicator list full");
    body.fill(0, s, s + SIDE_CAP);
    body.set(fromHex(raw), s);
    carryChecksum(cp, before, body, m, s);
}

/** Carry the A9 head checksum (big-endian word sum) over the button bytes changed. */
function carryChecksum(/** @type {Codeplug} */ cp, /** @type {Uint8Array} */ before, /** @type {Uint8Array} */ body, /** @type {number} */ m, /** @type {number} */ s) {
    const ck = /** @type {number} */ (a9HeadChecksumOff(cp));
    let delta = 0;
    for (const [lo, hi] of a9Spans(m, s)) {
        for (let i = lo; i < hi; i++) {
            const d = /** @type {number} */ (body[i]) - /** @type {number} */ (before[i]);
            if (d) delta += d * (i & 1 ? 256 : 1);
        }
    }
    const v = (((/** @type {number} */ (body[ck]) << 8) | /** @type {number} */ (body[ck + 1])) + delta) & 0xFFFF;
    body[ck] = v >> 8;
    body[ck + 1] = v & 0xFF;
}

/** [lo, hi) of the A9 bitmap + key map copy 1, key map copy 2, and the indicator list. */
const a9Spans = (/** @type {number} */ m, /** @type {number} */ s) => /** @type {[number, number][]} */ ([
    [m - BITMAP_LEN, m + N_RECS * REC_LEN], [m + COPY2, m + COPY2 + N_RECS * REC_LEN], [s, s + SIDE_CAP]]);

// ---------------------------------------------------------------------------
// Both

/** Is this an A9 / S9000e head (record-based buttons)? */
export const isA9 = (/** @type {Codeplug} */ cp) => !hasTable(cp);

/** The radio's buttons, in RSS's order ([] on an A9 head whose key map isn't recognized). */
export function decodeButtons(/** @type {Codeplug} */ cp) {
    return hasTable(cp) ? decodeTable(cp) : decodeA9(cp);
}

/**
 * Apply buttons.csv rows to `body` (an edited copy of cp.body), change-gated
 * per button. Throws InvalidValue for what RSS refuses (unless `hack`, or the
 * row's own `hack`: fixed buttons and, on the A9, functions RSS doesn't offer
 * on a key).
 * @param {Codeplug} cp @param {Uint8Array} body @param {ButtonRow[]} rows @param {boolean} [hack]
 */
export function encodeButtons(cp, body, rows, hack = false) {
    if (hasTable(cp)) encodeTable(cp, body, rows, hack);
    else encodeA9(cp, body, rows, hack);
}

/** Body offsets of the button bytes. */
export function buttonOffsets(/** @type {Codeplug} */ cp) {
    if (hasTable(cp)) {
        const c = findChbBlock(cp.body);
        return new Set([...Array.from({ length: 20 * ENTRY_LEN }, (_, i) => TABLE_OFF + i), ...(c === null ? [] : [c + AIRHN_FLAG[0], c + CHB_CK])]);
    }
    const lay = a9Layout(cp);
    /** @type {Set<number>} */
    const out = new Set();
    if (lay) for (const [lo, hi] of a9Spans(...lay)) for (let i = lo; i < hi; i++) out.add(i);
    return out;
}

/**
 * @typedef {{ label: string, name: string, data: boolean }} Choice
 *   data: a direct-entry function ("Zone X": a number goes in place of X)
 */

/**
 * The functions for `button`'s menu: `offered` = what RSS offers there,
 * `other` = what RSS doesn't (the experimental choices). A fixed button offers
 * nothing in RSS. A9 byte-identical aliases and SECURENET are left out.
 * Blank comes first, then by name.
 * @param {Codeplug} cp @param {string} button
 * @returns {{ offered: Choice[], other: Choice[] }}
 */
export function functionChoices(cp, button) {
    if (hasTable(cp)) {
        const all = Object.entries(FUNCTIONS).filter(([c]) => c !== RCL_DEL)
            .sort(([a, [x]], [b, [y]]) => (a === BLANK ? -1 : b === BLANK ? 1 : x.localeCompare(y)));
        const choices = (/** @type {[string, [string, string]][]} */ list) => list.map(([, [label, name]]) => ({ label, name, data: false }));
        const fixed = button in FIXED_LABEL ? [{ label: /** @type {string} */ (FIXED_LABEL[button]), name: /** @type {[string, string]} */ (FUNCTIONS[RCL_DEL])[1], data: false }] : [];
        if (FIXED.has(button)) return { offered: [], other: [...fixed, ...choices(all)] };
        return { offered: choices(all.filter(([c]) => c !== SEL)), other: choices(all.filter(([c]) => c === SEL)) };
    }
    const allowed = A9_FIXED.has(button) ? [] : A9_ALLOWED[keyClass(button)] ?? [];
    const choice = (/** @type {string} */ label) => ({ label, name: /** @type {import("./a9table.js").A9Function} */ (A9_FUNCTIONS[label])[0], data: takesData(label) });
    const usable = Object.keys(A9_FUNCTIONS).filter((l) => !ALIASES.has(l) && !NOT_OFFERED.has(l));
    const byName = (/** @type {string} */ a, /** @type {string} */ b) => (a === "Blank" ? -1 : b === "Blank" ? 1 : a.localeCompare(b));
    return {
        offered: usable.filter((l) => allowed.includes(l)).sort(byName).map(choice),
        other: usable.filter((l) => !allowed.includes(l)).sort(byName).map(choice),
    };
}

/**
 * The buttons' functions as a whole: which required functions no button has
 * (Sel on every head; Home too on the A9, where it's a programmable key).
 * @param {Codeplug} cp @param {Button[]} buttons
 */
export function missingRequired(cp, buttons) {
    const have = new Set(buttons.map((b) => b.function.toLowerCase()));
    const req = isA9(cp) ? [["Sel", "send-a"], ["Home"]] : [["Sel"]];
    return req.filter((names) => !names.some((n) => have.has(n.toLowerCase()))).map((names) => /** @type {string} */ (names[0]));
}
