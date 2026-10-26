// @ts-check
/**
 * RADIO-WIDE ZONE OPERATION switch: re-pack the codeplug the way RSS does.
 * Port of motreader/zoneop.py (FORMAT §5g; reproduced byte-exact from RSS
 * saves of every on-hand radio).
 *
 * zones on -> off: the zone tables (right before the radio-wide ext block)
 * are deleted; on models with per-mode scan lists (900 MHz) every mode record
 * grows by E zero bytes after its checksum (header 0x10A = record length);
 * every pointer behind the change moves; ext zone pointers and count := 0;
 * CHB+0x13 b4 cleared, home zone 0; checksums, 0xC9, FF padding.
 * zones off -> on: one zone "ZONE  01" holding every mode is created (RSS
 * refuses to pack until every mode is in a zone), per-mode scan lists are
 * dropped again, and everything above is reversed.
 *
 * Supported: standard-head, conventional codeplugs with up to 120 modes.
 */
import { parseCodeplug, modePointerTable, packMembership, packName } from "./codeplug.js";
import { findExtBlock, findChbBlock, blocks, finish } from "./radiowide.js";
import { InvalidValue } from "./errors.js";
import { layout as convLayout } from "./convscan.js";
import { be16, putBe16, HDR_PTRS, sum8, finishBody, bitmapBytes } from "./repack.js";

const EXT_TAIL_PTRS = [0x20, 0x22];
const EXT_ZONE_MEMB = 0x54;
const EXT_ZONE_FLAGS = 0x56;
const EXT_ZONE_NAMES = 0x58;
const EXT_ZONE_COUNT = 0x5B;
const ZONE_OP = /** @type {const} */ ([0x13, 0x10]);

class Layout {
    constructor(/** @type {Uint8Array} */ body) {
        const pt = modePointerTable(body);
        if (!pt) throw new InvalidValue("mode pointer table not found: can't re-pack this codeplug");
        this.base = pt[0];
        this.tab = pt[1];
        this.starts = pt[2];
        this.ext = findExtBlock(body);
        this.n = /** @type {number} */ (body[0x109]);
        this.L = /** @type {number} */ (body[0x10A]);
        this.trunked = this.starts.length > 1 && /** @type {number} */ (this.starts[1]) - /** @type {number} */ (this.starts[0]) !== this.L;
    }

    /** Record starts of the regular (length L) records, in address order. */
    regular() {
        const rs = [...this.starts].sort((a, b) => a - b);
        return rs.filter((p, i) => (i + 1 < rs.length ? /** @type {number} */ (rs[i + 1]) : p + this.L) - p === this.L);
    }
}

function check(/** @type {import("./codeplug.js").Codeplug} */ cp, /** @type {Layout} */ lay) {
    if (cp.ascii_names) {
        throw new InvalidValue("Zone Operation can't be changed on the A9 head yet (its zone "
            + "names live in the head's string pool); use RSS");
    }
    if (lay.trunked) {
        throw new InvalidValue("Zone Operation can't be changed on a trunked codeplug "
            + "(trunking data is not handled); use RSS");
    }
    if (findChbBlock(cp.body) === null || lay.ext === null) throw new InvalidValue("radio-wide blocks not found: can't re-pack this codeplug");
    if (bitmapBytes(lay.n) > 15) {
        throw new InvalidValue(`Zone Operation can't be changed with ${lay.n} user modes yet `
            + "(above 120 modes RSS also rewrites scan-list sections after the "
            + "mode records, not decoded); use RSS");
    }
}

/** Per-mode scan-list bytes (E) RSS appends with zones off on this model. */
function scanListLen(/** @type {Uint8Array} */ body, /** @type {Layout} */ lay) {
    if (lay.trunked) return 2 + Math.min(/** @type {number} */ (body[/** @type {number} */ (lay.ext) + 0x11]), 16);
    return 2 + bitmapBytes(lay.n);
}

function extAndChb(/** @type {Uint8Array} */ neu, /** @type {number} */ e, /** @type {boolean} */ zoneOn, /** @type {number} */ homeZone) {
    const L = /** @type {number} */ (neu[e]);
    neu[e + L - 1] = sum8(neu, e, e + L - 1);
    const blk = blocks(neu);
    const c = /** @type {number} */ (blk.chb);
    const a = c + ZONE_OP[0];
    neu[a] = zoneOn ? /** @type {number} */ (neu[a]) | ZONE_OP[1] : /** @type {number} */ (neu[a]) & ~ZONE_OP[1] & 0xFF;
    finish(neu, blk, new Set(["chb"]));
    neu[0x1DD] = homeZone;
}

/**
 * Zone Operation Enabled -> Disabled (all zones are lost, as in RSS).
 * `hasScanLists`: does this model keep a per-mode scan list with zones off?
 * Default: the 900 MHz models do; the VHF ones seen don't.
 * @param {Uint8Array} body @param {boolean | null} [hasScanLists]
 */
export function zonesOff(body, hasScanLists = null) {
    const cp = parseCodeplug(body);
    const lay = new Layout(body);
    check(cp, lay);
    const e = /** @type {number} */ (lay.ext);
    if (!(/** @type {number} */ (body[/** @type {number} */ (findChbBlock(body)) + ZONE_OP[0]]) & ZONE_OP[1])) return body;
    if (hasScanLists === null) hasScanLists = cp.band === "900";
    const zstart = Math.min(...[EXT_ZONE_MEMB, EXT_ZONE_FLAGS, EXT_ZONE_NAMES].map((k) => be16(body, e + k) - lay.base));
    const D = e - zstart;
    const E = hasScanLists ? scanListLen(body, lay) : 0;
    const ins = E ? lay.regular().map((p) => p + lay.L) : [];
    const moved = (/** @type {number} */ p) => (p < zstart ? p : p - D + E * ins.filter((q) => q <= p).length);

    const out = [...body.subarray(0, zstart), ...body.subarray(e)];
    /** @type {number[]} */
    const parts = [];
    let prev = 0;
    for (const q of ins) {
        parts.push(...out.slice(prev, q - D), ...new Array(E).fill(0));
        prev = q - D;
    }
    parts.push(...out.slice(prev));
    const neu = Uint8Array.from(parts);
    for (const o of HDR_PTRS) putBe16(neu, o, moved(be16(body, o) - lay.base) + lay.base);
    const tab = moved(lay.tab);
    lay.starts.forEach((p, i) => putBe16(neu, tab + 2 * i, moved(p) + lay.base));
    neu[tab + 2 * lay.n] = sum8(neu, tab, tab + 2 * lay.n);
    const ne = moved(e);
    for (const k of EXT_TAIL_PTRS) {
        const w = be16(body, e + k) - lay.base;
        if (w >= e && w <= body.length) putBe16(neu, ne + k, moved(w) + lay.base);
    }
    neu.fill(0, ne + EXT_ZONE_MEMB, ne + EXT_ZONE_NAMES + 2);
    neu[ne + EXT_ZONE_COUNT] = 0;
    neu[0x10A] = lay.L + E;
    extAndChb(neu, ne, false, 0);
    return finishBody(neu, body.length);
}

/**
 * Zone Operation Disabled -> Enabled: one zone "ZONE  01" with every mode,
 * home zone 1 (what RSS requires before it will pack). `scanListBytes` = the
 * per-mode scan list to drop from each record (default: what the zones-off
 * scan layout says the records carry, so records without one stay whole).
 * @param {Uint8Array} body @param {number | null} [scanListBytes] @param {number} [flagByte]
 */
export function zonesOn(body, scanListBytes = null, flagByte = 0xA0) {
    const cp = parseCodeplug(body);
    const lay = new Layout(body);
    check(cp, lay);
    if (/** @type {number} */ (body[/** @type {number} */ (findChbBlock(body)) + ZONE_OP[0]]) & ZONE_OP[1]) return body;
    const { n } = lay;
    const e = /** @type {number} */ (lay.ext);
    // the per-mode lists the records actually carry: none when both CONVENTIONAL
    // lists are Op Select (a 900 radio can be switched there after RSS's zones off)
    const cl = convLayout(body);
    const E = scanListBytes ?? (cl ? (cl.perMode ? 2 + cl.W : 0) : cp.band === "900" ? scanListLen(body, lay) : 0);
    const W = bitmapBytes(n);
    const names = Array.from(packName("ZONE  01"));
    const flagsLen = 2 + (W + 3);
    const flags = [flagsLen >> 8, flagsLen & 0xFF, flagByte, ...new Array(W + 2).fill(0)];
    const membLen = 2 + W + 1;
    const memb = [membLen >> 8, membLen & 0xFF, ...packMembership(Array.from({ length: n }, (_, i) => i + 1), W)];
    memb.push(sum8(memb, 0, memb.length));
    const zones = [...names, ...flags, ...memb];
    const T = zones.length;
    const cut = E ? lay.regular().map((p) => p + lay.L - E) : [];
    const moved = (/** @type {number} */ p) => (p < e ? p : p + T - E * cut.filter((q) => q < p).length);

    const out = [...body.subarray(0, e), ...zones, ...body.subarray(e)];
    /** @type {number[]} */
    const parts = [];
    let prev = 0;
    for (const q of cut) {
        parts.push(...out.slice(prev, q + T));
        prev = q + T + E;
    }
    parts.push(...out.slice(prev));
    const neu = Uint8Array.from(parts);
    for (const o of HDR_PTRS) putBe16(neu, o, moved(be16(body, o) - lay.base) + lay.base);
    const tab = moved(lay.tab);
    lay.starts.forEach((p, i) => putBe16(neu, tab + 2 * i, moved(p) + lay.base));
    neu[tab + 2 * n] = sum8(neu, tab, tab + 2 * n);
    const ne = moved(e);
    for (const k of EXT_TAIL_PTRS) {
        const w = be16(body, e + k) - lay.base;
        if (w >= e && w <= body.length) putBe16(neu, ne + k, moved(w) + lay.base);
    }
    const zn = e;
    putBe16(neu, ne + EXT_ZONE_NAMES, zn + lay.base);
    putBe16(neu, ne + EXT_ZONE_FLAGS, zn + names.length + lay.base);
    putBe16(neu, ne + EXT_ZONE_MEMB, zn + names.length + flags.length + lay.base);
    neu[ne + EXT_ZONE_COUNT] = 1;
    neu[0x10A] = lay.L - E;
    extAndChb(neu, ne, true, 1);
    return finishBody(neu, body.length);
}
