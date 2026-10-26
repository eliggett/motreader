// @ts-check
/**
 * Add / delete zones the way RSS's ZONE NAME LIST (RADIO-WIDE F7) does. Port
 * of motreader/zonelist.py (FORMAT §5k; byte-exact against RSS saves on
 * 617ASN, 604AUN and 221AZN).
 *
 * The zone tables are three contiguous sections right before the radio-wide
 * ext block: names (6 bytes/zone, 6-bit; the A9 head keeps its zone names in
 * the head block's string area instead), flags (2-byte length, then W+3
 * bytes per zone: scan-options byte, 2 priority bytes, W-byte scan list) and
 * membership (2-byte length, W bytes per zone, 8-bit sum). A zone inserted at
 * position P becomes zone P and later zones renumber; the sections grow, the
 * zone count, every pointer behind them, ext sum, 0xC9 and FF padding follow.
 *
 * Deliberately unlike RSS: an empty zone is refused (RSS drops it on save),
 * the home zone is renumbered so it keeps pointing at the same zone, and the
 * home zone can't be deleted. Refused: Zone Operation off, trunked
 * codeplugs, a delete that leaves a mode in no zone, no room left in the A9
 * string area.
 */
import { parseCodeplug, modePointerTable, zoneSections, zoneOperation, packName, packMembership } from "./codeplug.js";
import { findExtBlock } from "./radiowide.js";
import { refuseIfTrunked } from "./trunking.js";
import { a9HeadChecksumOff } from "./a9.js";
import { InvalidValue } from "./errors.js";
import { be16, putBe16, HDR_PTRS, sum8, finishBody } from "./repack.js";

const EXT_PTRS = [0x18, 0x1A, 0x1C, 0x20, 0x22, 0x25, 0x27, 0x29, 0x2B, 0x2D, 0x41, 0x47, 0x49, 0x50];
const EXT_MEMB = 0x54;
const EXT_FLAGS = 0x56;
const EXT_NAMES = 0x58;
const EXT_COUNT = 0x5B;
const HOME_ZONE = 0x1DD;
const NEW_ZONE_FLAG = 0xA0;   // RSS's scan-options byte for a new zone

/** RSS's name for a new zone: "ZONE  05". */
export const defaultZoneName = (/** @type {number} */ number) => `ZONE  ${String(number).padStart(2, "0")}`;

/** @param {Uint8Array} body */
function sections(body) {
    if (!zoneOperation(body)) throw new InvalidValue("Zone Operation is off: turn it on first (radio_wide.zone_operation)");
    refuseIfTrunked(body);
    const zs = zoneSections(body);
    const e = findExtBlock(body);
    const pt = modePointerTable(body);
    if (!zs || e === null || !pt) throw new InvalidValue("zone tables not found; use RSS");
    const { w, count: nz } = zs;
    const first = zs.names !== null ? zs.names : zs.flags;
    if ((zs.names !== null && zs.names + 6 * nz !== zs.flags)
        || zs.flags + be16(body, zs.flags) !== zs.memb || be16(body, zs.flags) !== 2 + nz * (w + 3)) {
        throw new InvalidValue("zone tables not laid out as expected; use RSS");
    }
    return { zs, e, pt, first };
}

/**
 * Re-pack the radio data (body without an A9 head block) for a zone inserted
 * at position `ins` or zone `dele` removed.
 * @param {Uint8Array} body @param {number | null} ins @param {number | null} dele @param {string} name @param {number[]} modes
 */
function rebuildZones(body, ins, dele, name, modes) {
    const { zs, e, pt: [base, tab, starts], first } = sections(body);
    const { w, count: nz } = zs;
    const sl = (/** @type {number} */ a, /** @type {number} */ b) => Array.from(body.subarray(a, b));
    const names = zs.names !== null ? Array.from({ length: nz }, (_, k) => sl(/** @type {number} */ (zs.names) + 6 * k, /** @type {number} */ (zs.names) + 6 * k + 6)) : null;
    const flags = Array.from({ length: nz }, (_, k) => sl(zs.flags + 2 + k * (w + 3), zs.flags + 2 + (k + 1) * (w + 3)));
    const memb = Array.from({ length: nz }, (_, k) => sl(zs.memb + 2 + k * w, zs.memb + 2 + (k + 1) * w));
    if (ins !== null) {
        const k = ins - 1;
        names?.splice(k, 0, Array.from(packName(name).subarray(0, 6)));
        flags.splice(k, 0, [NEW_ZONE_FLAG, 0, 0, ...new Array(w).fill(0)]);
        memb.splice(k, 0, Array.from(packMembership([...modes].sort((a, b) => a - b), w)));
    } else {
        const k = /** @type {number} */ (dele) - 1;
        for (const lst of [names, flags, memb]) lst?.splice(k, 1);
    }
    const nz2 = flags.length;
    const flLen = 2 + nz2 * (w + 3);
    const fl = [flLen >> 8, flLen & 0xFF, ...flags.flat()];
    const mbLen = 2 + nz2 * w + 1;
    const mb = [mbLen >> 8, mbLen & 0xFF, ...memb.flat()];
    mb.push(sum8(mb, 0, mb.length));
    const nm = names ? names.flat() : [];
    const neu = [...nm, ...fl, ...mb];
    const delta = neu.length - (e - first);
    const moved = (/** @type {number} */ p) => (p >= e ? p + delta : p);

    const out = Uint8Array.from(body);
    for (const o of HDR_PTRS) putBe16(out, o, moved(be16(body, o) - base) + base);
    for (const k of EXT_PTRS) {
        const t = be16(body, e + k) - base;
        if (t >= 0x1E8 && t < body.length) putBe16(out, e + k, moved(t) + base);
    }
    if (names) putBe16(out, e + EXT_NAMES, first + base);
    putBe16(out, e + EXT_FLAGS, first + nm.length + base);
    putBe16(out, e + EXT_MEMB, first + nm.length + fl.length + base);
    out[e + EXT_COUNT] = nz2;
    const Le = /** @type {number} */ (out[e]);
    out[e + Le - 1] = sum8(out, e, e + Le - 1);
    starts.forEach((p, i) => putBe16(out, tab + 2 * i, moved(p) + base));
    out[tab + 2 * starts.length] = sum8(out, tab, tab + 2 * starts.length);
    const hz = /** @type {number} */ (body[HOME_ZONE]);
    if (ins !== null && hz >= ins) out[HOME_ZONE] = hz + 1;
    else if (dele !== null && hz > dele) out[HOME_ZONE] = hz - 1;
    const res = [...out.subarray(0, first), ...neu, ...out.subarray(e)];
    return finishBody(res, body.length);
}

/**
 * The A9 head block with a zone name inserted / removed: the rest of the
 * string area shifts by one name width into / out of the zero pad at its
 * end, the zone-name table's count byte changes, the mode-name table
 * pointers move, and the head checksum is carried.
 * @param {Uint8Array} head @param {number} h @param {import("./codeplug.js").Codeplug} cp
 * @param {number | null} ins @param {number | null} dele @param {string} name
 */
function a9Head(head, h, cp, ins, dele, name) {
    const [mstart, w] = /** @type {[number, number]} */ (cp.ascii_names);
    const nz = cp.zones.length;
    const relM = mstart - h;
    const relZ = relM - nz * w;
    const hb = Uint8Array.from(head);
    const findWord = (/** @type {number} */ v, /** @type {number} */ from, /** @type {number} */ to) => {
        for (let i = from; i + 1 < Math.min(to, head.length); i++) if (head[i] === v >> 8 && head[i + 1] === (v & 0xFF)) return i;
        return -1;
    };
    // descriptors: [w, 1, nz, zone-table ptr]; the mode-table pointer follows in the entries after it
    const desc = [];
    for (let i = 0; i < hb.length - 5; i++) {
        if (hb[i] === w && hb[i + 1] === 1 && hb[i + 2] === nz && findWord(be16(hb, i + 3) + nz * w, i + 5, i + 0x40) > 0) desc.push(i);
    }
    if (desc.length !== 1) throw new InvalidValue("A9 zone-name table descriptor not found; use RSS");
    const d = /** @type {number} */ (desc[0]);
    const zp = be16(hb, d + 3);
    const mp = zp + nz * w;
    // end of the string area: the zero pad after the mode-name slots
    const printable = (/** @type {number} */ s) => hb.subarray(s, s + w).every((c) => c >= 0x20 && c < 0x7F);
    let s = relM;
    while (s + w <= hb.length && printable(s)) s += w;
    let g = s;
    while (g < hb.length && hb[g] === 0) g++;
    let dz;
    if (ins !== null) {
        if (g - s < w) throw new InvalidValue("no room for another zone name in the A9 head; use RSS");
        const p = relZ + (ins - 1) * w;
        const nameBytes = new Uint8Array(w).fill(0x20);
        nameBytes.set(Uint8Array.from(name.slice(0, w), (c) => c.charCodeAt(0) & 0xFF));
        const rest = hb.slice(p, g - w);
        hb.set(nameBytes, p);
        hb.set(rest, p + w);
        dz = 1;
    } else {
        const p = relZ + (/** @type {number} */ (dele) - 1) * w;
        const rest = hb.slice(p + w, g);
        hb.set(rest, p);
        hb.fill(0, p + rest.length, g);
        dz = -1;
    }
    hb[d + 2] = nz + dz;
    let i = findWord(mp, d + 5, d + 0x40);
    while (i > 0) {
        putBe16(hb, i, mp + dz * w);
        i = findWord(mp, i + 2, d + 0x40);
    }
    let delta = 0;
    for (let j = 0; j < hb.length; j++) {
        const x = /** @type {number} */ (hb[j]) - /** @type {number} */ (head[j]);
        if (x) delta += x * ((h + j) & 1 ? 256 : 1);
    }
    putBe16(hb, 2, (be16(hb, 2) + delta) & 0xFFFF);
    return hb;
}

/** @param {Uint8Array} body @param {number | null} ins @param {number | null} dele @param {string | null} name @param {number[]} modes */
function change(body, ins, dele, name, modes) {
    const cp = parseCodeplug(body);
    const nz = cp.zones.length;
    const a9 = cp.ascii_names !== null;
    const width = cp.ascii_names ? cp.ascii_names[1] : 8;
    const n = cp.modes.length;
    if (ins !== null) {
        if (!(ins >= 1 && ins <= nz + 1)) throw new InvalidValue(`zone position ${ins} out of range (1..${nz + 1})`);
        modes = [...new Set(modes)].sort((a, b) => a - b);
        if (!modes.length) throw new InvalidValue("a new zone needs at least one mode (RSS drops empty zones)");
        if (!modes.every((m) => m >= 1 && m <= n)) throw new InvalidValue(`zone modes must be 1..${n}`);
        name = name ?? defaultZoneName(ins);
        if (name.length > width) throw new InvalidValue(`zone name '${name}' longer than ${width} characters`);
    } else {
        const k = /** @type {number} */ (dele);
        if (!(k >= 1 && k <= nz)) throw new InvalidValue(`no zone ${k} (1..${nz})`);
        if (nz === 1) throw new InvalidValue("can't delete the last zone (turn Zone Operation off instead)");
        if (body[HOME_ZONE] === k) throw new InvalidValue(`zone ${k} is the home zone: change the home zone first`);
        const left = new Set(cp.zones.filter((z) => z.number !== k).flatMap((z) => z.modes));
        const orphans = [...new Set(/** @type {import("./codeplug.js").Zone} */ (cp.zones[k - 1]).modes)].filter((m) => !left.has(m)).sort((a, b) => a - b);
        if (orphans.length) {
            throw new InvalidValue(`modes [${orphans.join(", ")}] are only in zone ${k}: put them in another `
                + "zone first (RSS won't pack a mode outside every zone)");
        }
    }
    if (!a9) return rebuildZones(body, ins, dele, name ?? "", modes);
    const ck = a9HeadChecksumOff(cp);
    if (ck === null || (ck - 2 - 0xAD) % 0x100) throw new InvalidValue("A9 control-head block not found where expected; use RSS");
    const h = ck - 2;
    const radio = rebuildZones(body.slice(0, h), ins, dele, "", modes);
    const head = a9Head(body.subarray(h), h, cp, ins, dele, name ?? "");
    const out = new Uint8Array(radio.length + head.length);
    out.set(radio);
    out.set(head, radio.length);
    out[0xC9] = (/** @type {number} */ (body[0xC9]) + Math.floor((out.length - body.length) / 32)) & 0xFF;
    return out;
}

/**
 * Insert a zone at `position` (1..count+1; later zones renumber) holding
 * `modes`, named `name` (default RSS's "ZONE  nn").
 * @param {Uint8Array} body @param {number} position @param {number[]} modes @param {string | null} [name]
 */
export function addZone(body, position, modes, name = null) {
    return change(body, position, null, name, modes);
}

/** Delete zone `number`; later zones renumber (the home zone follows). */
export function deleteZone(/** @type {Uint8Array} */ body, /** @type {number} */ number) {
    return change(body, null, number, null, []);
}
