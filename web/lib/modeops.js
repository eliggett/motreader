// @ts-check
/**
 * Add / delete modes (channels) the way RSS's MODE UTILITY does. Port of
 * motreader/modeops.py (FORMAT §5j; byte-exact against RSS saves of ADD /
 * DELETE MODE on 617ASN, 617ASQ, 604AUN and the A9 head 221AZN).
 *
 * RSS keeps everything in mode order, so a mode inserted after N becomes N+1
 * and later modes renumber: the 6-bit name table, the mode-list section
 * (header 0xE7), the mode pointer table, the record itself, zone membership
 * bitmaps (LSB-first) and zone scan lists (MSB-first) with their priority
 * bytes, zones-off scan lists (convscan.js), the membership width W =
 * ceil(n/8) and everything sized by it, counts, header mode numbers (home
 * mode), every section pointer behind the change, sums, 0xC9, FF padding.
 * The A9 head: the same re-pack of the radio data, the head block moved whole
 * to the next page boundary with the names shifted within their slots.
 *
 * Deliberately unlike RSS (its bugs): after a delete a stale membership bit
 * for the old last mode is cleared; zones-off lists are all renumbered.
 * Refused: trunked codeplugs, more than 120 modes when W would change,
 * zones-on radio-wide bitmaps in use when W changes, the model's mode limit,
 * a zones-on add without a zone, deleting a zone's last mode or the home mode.
 */
import { parseCodeplug, modePointerTable, zoneSections, packName, NAME_TABLE_OFF } from "./codeplug.js";
import { findExtBlock, findChbBlock } from "./radiowide.js";
import { refuseIfTrunked } from "./trunking.js";
import { a9HeadChecksumOff } from "./a9.js";
import { layout as convLayout } from "./convscan.js";
import { InvalidValue } from "./errors.js";
import { be16, putBe16, HDR_PTRS, sum8, spliceAll, finishBody, bitmapBytes } from "./repack.js";

// ext words pointing at sections; +0x47 / +0x49 = the MPL code / name tables
// (0 with MPL off), which sit after the 6-bit mode names on standard heads
const EXT_PTRS = [0x18, 0x1A, 0x1C, 0x20, 0x22, 0x25, 0x27, 0x29, 0x2B, 0x2D, 0x41, 0x47, 0x49, 0x50, 0x54, 0x56, 0x58];
const MODE_REFS = [0x10F, 0x1B6, 0x1C1];   // header bytes holding a mode number
const MAX_MODES = 0x1D5;                   // model limit (radio address 0x6128)
const EXT_CONV_COUNT = 0x86;

/** @typedef {{ ins?: number, dele?: number }} Shift */

/**
 * Mode bitmap (bit m-1 = mode m, LSB first) renumbered for a mode inserted
 * after `ins` (its bit clear) or mode `dele` removed; w bytes.
 * @param {ArrayLike<number>} bm @param {number} w @param {Shift} sh
 */
function renumLsb(bm, w, sh) {
    let modes = [];
    for (let i = 0; i < bm.length * 8; i++) if ((/** @type {number} */ (bm[i >> 3]) >> (i % 8)) & 1) modes.push(i + 1);
    if (sh.ins !== undefined) {
        const a = sh.ins;
        modes = modes.map((m) => (m > a ? m + 1 : m));
    }
    if (sh.dele !== undefined) {
        const d = sh.dele;
        modes = modes.filter((m) => m !== d).map((m) => (m > d ? m - 1 : m));
    }
    const out = new Array(w).fill(0);
    for (const m of modes) if (m - 1 < w * 8) out[(m - 1) >> 3] |= 1 << ((m - 1) % 8);
    return out;
}

const rev = (/** @type {ArrayLike<number>} */ x) => Array.from(x, (c) => {
    let r = 0;
    for (let i = 0; i < 8; i++) if (c & (1 << i)) r |= 0x80 >> i;
    return r;
});

const renumMsb = (/** @type {ArrayLike<number>} */ bm, /** @type {number} */ w, /** @type {Shift} */ sh) => rev(renumLsb(rev(bm), w, sh));

/** RSS's name for a new mode: "MODE   2" (8 wide), "  MODE   66" on the A9 head. */
export function defaultModeName(/** @type {number} */ number, a9 = false) {
    return a9 ? `  MODE${String(number).padStart(5)}` : `MODE${String(number).padStart(4)}`;
}

/**
 * @param {Uint8Array} body @param {number | null} after @param {number | null} dele
 * @param {Uint8Array | null} record @param {string} name @param {number[]} zones
 */
function change(body, after, dele, record, name, zones) {
    const cp = parseCodeplug(body);
    if (!cp.ascii_names) return repack(body, cp, after, dele, record, name, zones, true);
    return changeA9(body, cp, after, dele, record, name, zones);
}

/**
 * A9 head: the radio data (FF-padded to a page) is followed by the head
 * block, which holds the 11-char ASCII mode names in a fixed slot array. RSS
 * re-packs the radio data, moves the head block whole to the next page
 * boundary after it, and shifts the names inside their slots.
 * @param {Uint8Array} body @param {import("./codeplug.js").Codeplug} cp @param {number | null} after @param {number | null} dele
 * @param {Uint8Array | null} record @param {string} name @param {number[]} zones
 */
function changeA9(body, cp, after, dele, record, name, zones) {
    const ck = a9HeadChecksumOff(cp);
    if (ck === null || (ck - 2 - 0xAD) % 0x100) throw new InvalidValue("A9 control-head block not found where expected; use RSS");
    const h = ck - 2;
    const [start, w] = /** @type {[number, number]} */ (cp.ascii_names);
    const n = /** @type {number} */ (body[0x109]);
    if (!(h <= start) || start + (n + 1) * w > body.length) throw new InvalidValue("A9 mode-name slots not where expected; use RSS");
    const radio = repack(body.slice(0, h), cp, after, dele, record, name, zones, false);
    const head = Uint8Array.from(body.subarray(h));
    const rel = start - h;
    const slots = Array.from({ length: n + 1 }, (_, i) => head.slice(rel + i * w, rel + (i + 1) * w));
    let neu;
    if (after !== null) {
        // later names move up a slot; the old slot n+1 content is overwritten
        const nb = new Uint8Array(w).fill(0x20);
        nb.set(Uint8Array.from(name.slice(0, w), (c) => c.charCodeAt(0) & 0xFF));
        neu = [...slots.slice(0, after), nb, ...slots.slice(after, n)];
    } else {
        // later names move down; the old last slot keeps its (now spare) name
        const d = /** @type {number} */ (dele);
        neu = [...slots.slice(0, d - 1), ...slots.slice(d, n), /** @type {Uint8Array} */ (slots[n - 1])];
    }
    neu.forEach((s, i) => head.set(s, rel + i * w));
    // head checksum (big-endian words at odd addresses): carry the delta; the
    // block moves by whole pages, so its byte lanes don't change
    let delta = 0;
    for (let i = 0; i < head.length; i++) {
        const x = /** @type {number} */ (head[i]) - /** @type {number} */ (body[h + i]);
        if (x) delta += x * ((h + i) & 1 ? 256 : 1);
    }
    putBe16(head, 2, (be16(head, 2) + delta) & 0xFFFF);
    const out = new Uint8Array(radio.length + head.length);
    out.set(radio);
    out.set(head, radio.length);
    out[0xC9] = (/** @type {number} */ (body[0xC9]) + Math.floor((out.length - body.length) / 32)) & 0xFF;
    return out;
}

/**
 * @param {Uint8Array} body  the radio data (without an A9 head block)
 * @param {import("./codeplug.js").Codeplug} cp  the whole codeplug, decoded
 * @param {number | null} after @param {number | null} dele
 * @param {Uint8Array | null} record @param {string} name @param {number[]} zones @param {boolean} sixBitNames
 */
function repack(body, cp, after, dele, record, name, zones, sixBitNames) {
    refuseIfTrunked(body);
    const pt = modePointerTable(body);
    const e = findExtBlock(body);
    const chb = findChbBlock(body);
    if (!pt || e === null || chb === null) throw new InvalidValue("codeplug layout not recognized; use RSS");
    const [base, tab, starts] = pt;
    const n = /** @type {number} */ (body[0x109]);
    const L = /** @type {number} */ (body[0x10A]);
    const ins = after !== null;
    const a = /** @type {number} */ (after);
    const del = /** @type {number} */ (dele);
    const n2 = ins ? n + 1 : n - 1;
    if (ins && !(a >= 0 && a <= n)) throw new InvalidValue(`insert position after mode ${a} out of range (0..${n})`);
    if (!ins && !(del >= 1 && del <= n)) throw new InvalidValue(`no mode ${del} (1..${n})`);
    const limit = /** @type {number} */ (body[MAX_MODES]) || 128;
    if (ins && n2 > limit) throw new InvalidValue(`the radio holds at most ${limit} modes`);
    if (n2 < 1) throw new InvalidValue("can't delete the last mode");
    if (!ins && body[0x10F] === del) throw new InvalidValue(`mode ${del} is the home mode: change the home mode first`);
    const zoned = Boolean(/** @type {number} */ (body[chb + 0x13]) & 0x10);
    /** @type {[number, number, ArrayLike<number>, boolean][]}  [offset, old length, new bytes, a pointer AT offset moves too] */
    const edits = [];

    if (sixBitNames) {
        edits.push(ins ? [NAME_TABLE_OFF + 6 * a, 0, packName(name).subarray(0, 6), a > 0]
            : [NAME_TABLE_OFF + 6 * (del - 1), 6, [], false]);
    }

    /** A priority byte (mode number) renumbered. */
    const rp = (/** @type {number} */ p) => {
        if (p === 0 || p === 0xFF) return p;   // none / <SELMOD> (the selected mode)
        if (ins) return p > a ? p + 1 : p;
        return p === del ? 0 : p > del ? p - 1 : p;
    };
    /** @type {Shift} */
    const sh = ins ? { ins: a } : { dele: del };
    const wOld = /** @type {number} */ (body[e + 0x1E]) & 0x7F;
    let wNew = bitmapBytes(n2);
    const numlist = Boolean(/** @type {number} */ (body[e + 0x1E]) & 0x80);
    if (wNew !== wOld && (numlist || wNew > 15)) {
        throw new InvalidValue("above 120 modes RSS encodes the scan width specially; not handled yet");
    }
    if (numlist) wNew = wOld;

    /** [Pri 1][Pri 2][members] (bitmap MSB-first, or mode numbers). */
    const renumList = (/** @type {Uint8Array} */ old) => {
        const head = [rp(/** @type {number} */ (old[0])), rp(/** @type {number} */ (old[1]))];
        if (numlist) {
            let ms = Array.from(old.subarray(2)).filter((m) => m);
            ms = ins ? ms.map((m) => (m > a ? m + 1 : m)) : ms.filter((m) => m !== del).map((m) => (m > del ? m - 1 : m));
            return [...head, ...ms, ...new Array(wOld - ms.length).fill(0)];
        }
        return [...head, ...renumMsb(old.subarray(2), wNew, sh)];
    };

    // zones off: Mode Slave lists after each record and the radio-wide lists
    // at ext +0x20 / +0x22, renumbered like RSS's ADD / DELETE MODE
    let dE = 0;
    const lay = zoned ? null : convLayout(body, true);
    if (lay && lay.perMode) {
        const E = 2 + wOld;
        dE = wNew - wOld;
        starts.forEach((t, i) => {
            if (!ins && i === del - 1) return;
            edits.push([t + lay.tail, E, renumList(body.subarray(t + lay.tail, t + L)), false]);
        });
    }
    /** @type {Uint8Array} */
    let rec = new Uint8Array(0);
    if (ins) {
        rec = /** @type {Uint8Array} */ (record).slice(0, L);
        if (lay && lay.perMode) {   // a fresh mode scans nothing
            const r = new Uint8Array(lay.tail + 2 + wNew);
            r.set(rec.subarray(0, lay.tail));
            rec = r;
        }
    }
    for (const k of [0x20, 0x22]) {
        const t = be16(body, e + k) - base;
        if (!(t >= 2 && t < body.length)) continue;
        if (lay) {
            edits.push([t - 2, 2 + wOld, renumList(body.subarray(t - 2, t + wOld)), false]);
        } else if (wNew !== wOld) {
            if (body.subarray(t, t + wOld).some((x) => x)) {
                throw new InvalidValue("radio-wide scan bitmaps are in use; renumbering them isn't handled yet (use RSS)");
            }
            edits.push(wNew > wOld ? [t + wOld, 0, new Array(wNew - wOld).fill(0), false] : [t + wNew, wOld - wNew, [], false]);
        }
    }
    // zone sections
    const zs = zoned ? zoneSections(body) : null;
    /** @type {number | null} */
    let membAt = null;
    if (zoned) {
        if (!zs) throw new InvalidValue("zone tables not found; use RSS");
        if (ins && !zones.length) {
            throw new InvalidValue("Zone Operation is on: the new mode must go in a zone "
                + "(RSS won't save a mode outside every zone)");
        }
        const { w, count: nz } = zs;
        for (const z of zones) if (!(z >= 1 && z <= nz)) throw new InvalidValue(`no zone ${z} (1..${nz})`);
        if (!ins) {
            for (const z of cp.zones) {
                if (z.modes.length === 1 && z.modes[0] === del) {
                    throw new InvalidValue(`mode ${del} is the only mode in zone ${z.number} ('${z.name}'); RSS would drop the zone`);
                }
            }
        }
        /** @type {number[]} */
        const fl = [];
        for (let k = 0; k < nz; k++) {
            const r = body.subarray(zs.flags + 2 + k * (w + 3), zs.flags + 2 + (k + 1) * (w + 3));
            fl.push(/** @type {number} */ (r[0]), rp(/** @type {number} */ (r[1])), rp(/** @type {number} */ (r[2])), ...renumMsb(r.subarray(3), wNew, sh));
        }
        const flLen = 2 + fl.length;
        const flags = [flLen >> 8, flLen & 0xFF, ...fl];
        /** @type {number[]} */
        const mb = [];
        for (let k = 0; k < nz; k++) {
            const bm = renumLsb(body.subarray(zs.memb + 2 + k * w, zs.memb + 2 + (k + 1) * w), wNew, sh);
            if (ins && zones.includes(k + 1)) bm[a >> 3] |= 1 << (a % 8);
            mb.push(...bm);
        }
        const mLen = 2 + mb.length + 1;
        const memb = [mLen >> 8, mLen & 0xFF, ...mb];
        memb.push(sum8(memb, 0, memb.length));
        edits.push([zs.flags, e - zs.flags, [...flags, ...memb], false]);
        membAt = flags.length;
    }
    // mode-list section
    const s2 = be16(body, 0xE7) - base;
    const types = Array.from(body.subarray(s2 + n, s2 + 2 * n));
    if (ins) types.splice(a, 0, 0);
    else types.splice(del - 1, 1);
    const s2new = [...Array.from({ length: n2 }, (_, i) => i + 1), ...types, ...new Array(2 * n2).fill(0)];
    edits.push([s2, tab - s2, [...s2new, sum8(s2new, 0, s2new.length)], false]);
    edits.push([tab, 2 * n + 1, new Array(2 * n2 + 1).fill(0), false]);   // refilled below
    const pos = ins ? (a < n ? /** @type {number} */ (starts[a]) : /** @type {number} */ (starts[starts.length - 1]) + L) : 0;
    if (ins) edits.push([pos, 0, rec, true]);
    else edits.push([/** @type {number} */ (starts[del - 1]), L, [], false]);

    const moved = (/** @type {number} */ p) => p + edits.reduce((d, [o, ln, nb, eq]) => d + (o + ln <= p && (o < p || eq) ? nb.length - ln : 0), 0);

    const out = Uint8Array.from(body);
    out[0x109] = n2;
    out[0x10A] = L + dE;
    if (out[0x110] === n) out[0x110] = n2;
    for (const k of [7, 8]) if (out[e + k] === n) out[e + k] = n2;
    out[e + EXT_CONV_COUNT] = (/** @type {number} */ (out[e + EXT_CONV_COUNT]) + (ins ? 1 : -1)) & 0xFF;
    out[e + 0x1E] = (/** @type {number} */ (out[e + 0x1E]) & 0x80) | wNew;
    for (const ref of MODE_REFS) {
        const v = /** @type {number} */ (out[ref]);
        if (ins && v > a) out[ref] = v + 1;
        else if (!ins && v === del) out[ref] = 0;   // (never the home mode: refused)
        else if (!ins && v > del) out[ref] = v - 1;
    }
    for (const o of HDR_PTRS) putBe16(out, o, moved(be16(body, o) - base) + base);
    for (const k of EXT_PTRS) {
        const t = be16(body, e + k) - base;
        if (t >= 0x1E8 && t < body.length) putBe16(out, e + k, moved(t) + base);
    }
    if (membAt !== null) putBe16(out, e + 0x54, moved(/** @type {NonNullable<typeof zs>} */ (zs).flags) + membAt + base);
    const Le = /** @type {number} */ (out[e]);
    out[e + Le - 1] = sum8(out, e, e + Le - 1);
    // same offset: replacements first, then the new record, then other inserts
    // (applied back to front, so those end up in front of the record)
    const key = (/** @type {typeof edits[number]} */ x) => [x[0], x[1] > 0 ? 1 : 0, ins && x[2] === rec ? 1 : 0];
    const ordered = [...edits].sort((x, y) => {
        const kx = key(x);
        const ky = key(y);
        for (let i = 0; i < 3; i++) if (kx[i] !== ky[i]) return /** @type {number} */ (ky[i]) - /** @type {number} */ (kx[i]);
        return 0;
    });
    const res = spliceAll(out, ordered.map(([o, ln, nb]) => /** @type {[number, number, ArrayLike<number>]} */ ([o, ln, nb])));
    const tab2 = moved(tab);
    const news = ins
        ? (() => {
            const olds = starts.map(moved);
            return [...olds.slice(0, a), moved(pos) - rec.length, ...olds.slice(a)];
        })()
        : starts.filter((_, i) => i !== del - 1).map(moved);
    news.forEach((p, i) => {
        const v = (p + base) & 0xFFFF;
        res[tab2 + 2 * i] = v >> 8;
        res[tab2 + 2 * i + 1] = v & 0xFF;
    });
    res[tab2 + 2 * n2] = sum8(res, tab2, tab2 + 2 * n2);
    return finishBody(res, body.length);
}

/**
 * Insert a new mode after mode `after` (0 = before mode 1): a copy of mode
 * `copyFrom` (default: mode `after`, or 1), named `name` (default RSS's
 * "MODE  nn"), placed in `zones` (needed when Zone Operation is on).
 * @param {Uint8Array} body @param {number} after
 * @param {{ copyFrom?: number | null, name?: string | null, zones?: number[] }} [opts]
 */
export function addMode(body, after, { copyFrom = null, name = null, zones = [] } = {}) {
    const pt = modePointerTable(body);
    if (!pt) throw new InvalidValue("codeplug layout not recognized; use RSS");
    const n = /** @type {number} */ (body[0x109]);
    const L = /** @type {number} */ (body[0x10A]);
    const src = copyFrom || (after >= 1 ? after : 1);
    if (!(src >= 1 && src <= n)) throw new InvalidValue(`no mode ${src} to copy (1..${n})`);
    const t = /** @type {number} */ (pt[2][src - 1]);
    const record = body.slice(t, t + L);
    const a9 = parseCodeplug(body).ascii_names;
    const width = a9 ? a9[1] : 8;
    if (name !== null && name.length > width) throw new InvalidValue(`mode name '${name}' longer than ${width} characters`);
    return change(body, after, null, record, name ?? defaultModeName(after + 1, a9 !== null), [...zones]);
}

/** Delete mode `number`; later modes renumber (zones, home mode follow). */
export function deleteMode(/** @type {Uint8Array} */ body, /** @type {number} */ number) {
    return change(body, null, number, null, "", []);
}

/** For tests against RSS's own ADD: insert `record` as is (RSS writes a model default record). */
export function insertRecord(/** @type {Uint8Array} */ body, /** @type {number} */ after, /** @type {Uint8Array} */ record,
    /** @type {string} */ name, /** @type {number[]} */ zones = []) {
    return change(body, after, null, record, name, zones);
}
