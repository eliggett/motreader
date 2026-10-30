// @ts-check
/**
 * Zone scan lists and ZONE SCAN OPTIONS (RSS RADIO-WIDE F2 -> ZONE LIST F7 ->
 * SCAN LIST F7 / SCAN OPTIONS F8), Zone Operation on. Port of
 * motreader-py/scanlist.py (FORMAT §5l; mapped on 604AUN, 617ASN, 566AYA).
 *
 * Each zone's W+3-byte record in the zone flag section (ext +0x56):
 *   +0      scan-options byte: 0x80 / 0x08 SCAN TYPE Talkgroup / Pri Tlkgr
 *           (neither = Disabled), 0x40 Talkback Scan, 0x20 Scan Button Control
 *           Active (clear = Override), 0x10 Coded Squelch Scan, 0x04
 *           Non-Priority List Op Select, 0x03 Priority List Op Select (clear =
 *           Zone Slaved)
 *   +1, +2  Priority 1 / 2 mode: mode number, 0xFF = <SELMOD>, 0 = none
 *   +3      W-byte bitmap of the non-priority members, MSB-first
 * <SELMOD> is always on the list (RSS counts it: "List = 12 of 16 Max").
 * Fixed-size records: edits are in place, nothing moves.
 */
import { zoneSections, zoneOperation } from "./codeplug.js";
import { InvalidValue } from "./errors.js";

export const SELMOD = "SELMOD";
export const MAX_MEMBERS = 16;
const TYPE_BITS = 0x88;
export const SCAN_TYPES = /** @type {Record<number, string>} */ ({ 0x80: "Talkgroup", 0x08: "Pri Tlkgr", 0x00: "Disabled" });
/** [field, mask, value when set, value when clear] */
export const FLAGS = /** @type {const} */ ([
    ["talkback_scan", 0x40, "Enabled", "Disabled"],
    ["scan_button_control", 0x20, "Active", "Override"],
    ["coded_squelch_scan", 0x10, "Enabled", "Disabled"],
    ["non_priority_list", 0x04, "Op Select", "Zone Slaved"],
    ["priority_list", 0x03, "Op Select", "Zone Slaved"],
]);

/** @typedef {number | "SELMOD" | null} Priority */

/**
 * @typedef {{
 *   zone: number, scan_type: string, talkback_scan: string, scan_button_control: string,
 *   coded_squelch_scan: string, non_priority_list: string, priority_list: string,
 *   priority_1: Priority, priority_2: Priority, modes: number[],
 * }} ZoneScan
 *   `modes`: the non-priority members besides <SELMOD>.
 */

/** A ZoneScan with RSS's defaults. @param {number} zone @returns {ZoneScan} */
export const zoneScan = (zone) => ({
    zone, scan_type: "Talkgroup", talkback_scan: "Enabled", scan_button_control: "Active",
    coded_squelch_scan: "Enabled", non_priority_list: "Zone Slaved", priority_list: "Zone Slaved",
    priority_1: null, priority_2: null, modes: [],
});

/** Scan-list size as RSS counts it (<SELMOD> included). */
export const memberCount = (/** @type {ZoneScan} */ z) =>
    1 + z.modes.length + [z.priority_1, z.priority_2].filter((p) => p !== null && p !== SELMOD).length;

/** @returns {[number, number][]}  [offset, W] of each zone's flag record ([] with zones off) */
function records(/** @type {Uint8Array} */ body) {
    if (!zoneOperation(body)) return [];
    const zs = zoneSections(body);
    if (!zs) return [];
    return Array.from({ length: zs.count }, (_, k) => [zs.flags + 2 + k * (zs.w + 3), zs.w]);
}

/** @returns {Priority} */
const priDecode = (/** @type {number} */ v) => (v === 0 ? null : v === 0xFF ? SELMOD : v);
const hex2 = (/** @type {number} */ v) => `0x${v.toString(16).padStart(2, "0")}`;

/** ZoneScan per zone (empty with Zone Operation off). */
export function decode(/** @type {Uint8Array} */ body) {
    return records(body).map(([o, w], k) => {
        const f = /** @type {number} */ (body[o]);
        const z = zoneScan(k + 1);
        z.scan_type = SCAN_TYPES[f & TYPE_BITS] ?? hex2(f & TYPE_BITS);
        for (const [name, mask, on, off] of FLAGS) {
            const v = f & mask;
            z[name] = v === mask ? on : v === 0 ? off : hex2(v);
        }
        [z.priority_1, z.priority_2] = [priDecode(/** @type {number} */ (body[o + 1])), priDecode(/** @type {number} */ (body[o + 2]))];
        z.modes = [];
        for (let i = 0; i < w; i++) for (let j = 0; j < 8; j++) if (/** @type {number} */ (body[o + 3 + i]) & (0x80 >> j)) z.modes.push(i * 8 + j + 1);
        return z;
    });
}

function priEncode(/** @type {unknown} */ p, /** @type {number} */ n, /** @type {string} */ what) {
    if (p === null || p === undefined || p === "" || p === 0) return 0;
    if (String(p).toUpperCase().replace(/^<|>$/g, "") === SELMOD) return 0xFF;
    const v = Number(p);
    if (!Number.isInteger(v)) throw new InvalidValue(`${what}: ${JSON.stringify(p)} is not a mode number`);
    if (!(v >= 1 && v <= n)) throw new InvalidValue(`${what}: no mode ${v} (1..${n})`);
    return v;
}

function enumBits(/** @type {Record<string, unknown>} */ z, /** @type {string} */ name, /** @type {Record<number, string>} */ table) {
    const v = z[name];
    for (const [bits, label] of Object.entries(table)) if (String(v).toLowerCase() === label.toLowerCase()) return Number(bits);
    throw new InvalidValue(`zone ${z.zone} ${name}: ${JSON.stringify(v)} is not one of ${Object.values(table).join(", ")}`);
}

/**
 * Write the given ZoneScan rows into their zones' flag records (zones not
 * listed are left alone). Refuses what RSS won't store: more than 16
 * members, the same mode as Priority 1 and 2, modes out of range.
 * @param {Uint8Array} body @param {ZoneScan[]} scans
 */
export function encode(body, scans) {
    const recs = records(body);
    if (!recs.length) throw new InvalidValue("no zone scan lists (Zone Operation is off or zone tables not found)");
    const n = /** @type {number} */ (body[0x109]);
    const out = Uint8Array.from(body);
    for (const z of scans) {
        if (!(z.zone >= 1 && z.zone <= recs.length)) throw new InvalidValue(`no zone ${z.zone} (1..${recs.length})`);
        const [o, w] = /** @type {[number, number]} */ (recs[z.zone - 1]);
        const f = /** @type {number} */ (body[o]);
        const zr = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (z));
        let nf = String(z.scan_type).startsWith("0x") ? f & TYPE_BITS : enumBits(zr, "scan_type", SCAN_TYPES);
        for (const [name, mask, on, off] of FLAGS) {
            if (String(z[name]).startsWith("0x")) nf |= f & mask;   // undecoded value: keep the bits
            else nf |= enumBits(zr, name, { [mask]: on, 0: off });
        }
        const p1 = priEncode(z.priority_1, n, `zone ${z.zone} priority_1`);
        const p2 = priEncode(z.priority_2, n, `zone ${z.zone} priority_2`);
        if (p1 && p1 === p2) throw new InvalidValue(`zone ${z.zone}: the same mode can't be Priority 1 and Priority 2`);
        if ((p1 || p2) && (nf & TYPE_BITS) === 0x80) {
            throw new InvalidValue(`zone ${z.zone}: priority modes need scan_type Pri Tlkgr (RSS drops them from a Talkgroup list)`);
        }
        const modes = [...new Set(z.modes.map(Number))].filter((m) => m !== p1 && m !== p2).sort((a, b) => a - b);
        const bad = modes.filter((m) => !(m >= 1 && m <= Math.min(n, w * 8)));
        if (bad.length) throw new InvalidValue(`zone ${z.zone} scan list: no mode(s) [${bad.join(", ")}] (1..${n})`);
        const size = 1 + modes.length + [p1, p2].filter((p) => p !== 0 && p !== 0xFF).length;
        if (size > MAX_MEMBERS) {
            throw new InvalidValue(`zone ${z.zone} scan list: ${size} members (<SELMOD> included), RSS allows ${MAX_MEMBERS}`);
        }
        const bm = new Array(w).fill(0);
        for (const m of modes) bm[(m - 1) >> 3] |= 0x80 >> ((m - 1) % 8);
        out.set([nf, p1, p2, ...bm], o);
    }
    return out;
}

/** {body offset: zone number} of every scan-record byte (change reports). */
export function offsets(/** @type {Uint8Array} */ body) {
    /** @type {Map<number, number>} */
    const out = new Map();
    records(body).forEach(([o, w], k) => {
        for (let i = 0; i < w + 3; i++) out.set(o + i, k + 1);
    });
    return out;
}
