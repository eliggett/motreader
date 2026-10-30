// @ts-check
/**
 * Scan with Zone Operation off ("conventional" scan): the per-mode SCAN
 * settings, the CHANNEL / TALKGROUP SCAN LIST of each mode (RSS mode screen
 * F6) and the CONVENTIONAL screen's Non-Priority / Priority List type. Port
 * of motreader-py/convscan.py (FORMAT §5m; mapped on 617ASQ, 604ATY, 604AUN,
 * 617ASN from RSS saves).
 *
 *   * mode record (true start) +20: 0x02 SCAN Enabled, 0x01 Scan Button
 *     Control Active (clear = Override), 0x04 Coded Squelch Scan, 0x10
 *     Talkback Scan, 0x80 Non-Priority List Op Select, 0x60 Priority List Op
 *     Select (copies of the CONVENTIONAL setting; clear = Mode Slave).
 *   * a list is [Pri 1][Pri 2][members]: priority bytes hold a mode number,
 *     0xFF = <SELMOD>, 0 = none; members = a W-byte bitmap MSB-first, W =
 *     ext+0x1E & 0x7F (with ext+0x1E & 0x80, above 120 modes: up to W mode
 *     numbers, zero-padded, in RSS's order).
 *   * Op Select: one radio-wide list at ext+0x22 (priority bytes just before).
 *   * Mode Slave (either list): every record grows by 2+W bytes after its
 *     checksum holding that mode's list; the radio-wide list then mirrors mode
 *     1's Mode Slave part(s). <SELMOD> is listed only with Priority List Op
 *     Select. With Non-Priority Mode Slave a mode is always on its own list.
 */
import { modePointerTable, zoneOperation, parseCodeplug } from "./codeplug.js";
import { findExtBlock } from "./radiowide.js";
import { InvalidValue } from "./errors.js";
import { be16, putBe16, HDR_PTRS, sum8, finishBody } from "./repack.js";

export const SELMOD = "SELMOD";
const MAX_MEMBERS = 16;
export const SCAN_OFF = 20;
/** [field, mask, set, clear] in record +20. */
export const FLAGS = /** @type {const} */ ([
    ["scan", 0x02, "Enabled", "Disabled"],
    ["scan_button_control", 0x01, "Active", "Override"],
    ["coded_squelch_scan", 0x04, "Enabled", "Disabled"],
    ["talkback_scan", 0x10, "Enabled", "Disabled"],
]);
const NONPRI_OP = 0x80;
const PRI_OP = 0x60;
const SCAN_BIT = 0x02;
const TG_OFF = 2;
const TG_BIT = 0x10;
export const LIST_TYPES = /** @type {const} */ (["Op Select", "Mode Slave"]);

/** @typedef {number | "SELMOD" | null} Priority */

/**
 * @typedef {{
 *   mode: number, scan: string, scan_button_control: string, coded_squelch_scan: string,
 *   talkback_scan: string, priority_1: Priority, priority_2: Priority, modes: number[] | null,
 * }} ModeScan
 *   The mode's own list (priority_1/2, modes) is null where the list is Op Select.
 */

/**
 * @typedef {{
 *   scan_type: string, non_priority_list: string, priority_list: string,
 *   priority_1: Priority, priority_2: Priority, modes: number[] | null,
 * }} ConvScan
 *   scan_type is what RSS shows: Talkgroup / Pri Tlkgr (900) / Channel (VHF)
 *   when any mode scans, else Disabled.
 */

/** A ModeScan with RSS's defaults. @param {number} mode @returns {ModeScan} */
export const modeScan = (mode) => ({
    mode, scan: "Disabled", scan_button_control: "Active", coded_squelch_scan: "Enabled",
    talkback_scan: "Disabled", priority_1: null, priority_2: null, modes: null,
});

class Layout {
    constructor(/** @type {Uint8Array} */ body) {
        const band = parseCodeplug(body).band;
        this.band = band === "vhf" || band === "uhf" ? "vhf" : "900";
        const pt = modePointerTable(body);
        const e = findExtBlock(body);
        if (!pt || e === null) throw new InvalidValue("mode pointer table / ext block not found");
        this.base = pt[0];
        this.tab = pt[1];
        this.starts = pt[2];
        this.e = e;
        this.n = /** @type {number} */ (body[0x109]);
        this.L = /** @type {number} */ (body[0x10A]);
        const s = this.starts;
        if (s.length > 1 && s.some((t, i) => i > 0 && t - /** @type {number} */ (s[i - 1]) !== this.L)) {
            throw new InvalidValue("trunked / irregular mode records: not handled");
        }
        const f = /** @type {number} */ (body[/** @type {number} */ (s[0]) + SCAN_OFF]);
        this.nonpriOp = Boolean(f & NONPRI_OP);
        this.priOp = (f & PRI_OP) === PRI_OP;
        const w = /** @type {number} */ (body[e + 0x1E]);
        this.numlist = Boolean(w & 0x80);
        this.W = w & 0x7F;
        this.perMode = !(this.nonpriOp && this.priOp);
        this.tail = this.perMode ? this.L - 2 - this.W : 0;
        if (this.perMode && (this.numlist || this.tail < 26)) throw new InvalidValue("per-mode scan lists in an unknown layout; use RSS");
        const p = be16(body, e + 0x22) - this.base;
        /** @type {number | null} */
        this.rw = p >= 2 && p < body.length ? p : null;
        this.selmod = this.priOp;
        this.max = Math.min(MAX_MEMBERS, this.n + (this.selmod ? 1 : 0));
        this.talkgroup = this.band === "900" && s.some((t) => /** @type {number} */ (body[t + TG_OFF]) & TG_BIT);
        const scanning = this.talkgroup || s.some((t) => /** @type {number} */ (body[t + SCAN_OFF]) & SCAN_BIT);
        this.scanType = this.talkgroup ? "Talkgroup" : scanning ? (this.band === "vhf" ? "Channel" : "Pri Tlkgr") : "Disabled";
    }

    /** @returns {[number, number]} */
    scanBit() {
        return this.talkgroup ? [TG_OFF, TG_BIT] : [SCAN_OFF, SCAN_BIT];
    }

    sumAt() {
        return this.perMode ? this.tail - 1 : this.L - 1;
    }
}

/**
 * The zones-off scan layout: null with Zone Operation on (scan is per zone
 * then: scanlist.js) or, unless `strict`, when the layout isn't handled.
 * @returns {Layout | null}
 */
export function layout(/** @type {Uint8Array} */ body, strict = false) {
    if (zoneOperation(body) !== false) return null;
    try {
        return new Layout(body);
    } catch (e) {
        if (strict || !(e instanceof InvalidValue)) throw e;
        return null;
    }
}

/** @returns {Priority} */
const pri = (/** @type {number} */ v) => (v === 0 ? null : v === 0xFF ? SELMOD : v);

function members(/** @type {ArrayLike<number>} */ body, /** @type {number} */ o, /** @type {number} */ W, /** @type {boolean} */ numlist) {
    const out = [];
    if (numlist) {
        for (let i = 0; i < W; i++) if (body[o + i]) out.push(/** @type {number} */ (body[o + i]));
        return out;
    }
    for (let i = 0; i < W; i++) for (let j = 0; j < 8; j++) if (/** @type {number} */ (body[o + i]) & (0x80 >> j)) out.push(i * 8 + j + 1);
    return out;
}

/**
 * [ConvScan, ModeScan rows], or [null, []] with zones on.
 * @returns {[ConvScan | null, ModeScan[]]}
 */
export function decode(/** @type {Uint8Array} */ body) {
    const lay = layout(body);
    if (!lay) return [null, []];
    /** @type {ConvScan} */
    const cs = {
        scan_type: lay.scanType, non_priority_list: /** @type {string} */ (LIST_TYPES[lay.nonpriOp ? 0 : 1]),
        priority_list: /** @type {string} */ (LIST_TYPES[lay.priOp ? 0 : 1]), priority_1: null, priority_2: null, modes: null,
    };
    if (lay.rw !== null) {
        if (lay.priOp) [cs.priority_1, cs.priority_2] = [pri(/** @type {number} */ (body[lay.rw - 2])), pri(/** @type {number} */ (body[lay.rw - 1]))];
        if (lay.nonpriOp) cs.modes = members(body, lay.rw, lay.W, lay.numlist);
    }
    const rows = lay.starts.map((t, i) => {
        const f = /** @type {number} */ (body[t + SCAN_OFF]);
        const m = modeScan(i + 1);
        for (const [name, mask, on, off] of FLAGS) m[name] = f & mask ? on : off;
        const [so, sb] = lay.scanBit();
        m.scan = /** @type {number} */ (body[t + so]) & sb ? "Enabled" : "Disabled";
        if (lay.perMode) {
            const o = t + lay.tail;
            if (!lay.priOp) [m.priority_1, m.priority_2] = [pri(/** @type {number} */ (body[o])), pri(/** @type {number} */ (body[o + 1]))];
            if (!lay.nonpriOp) m.modes = members(body, o + 2, lay.W, false);
        }
        return m;
    });
    return [cs, rows];
}

const isSelmod = (/** @type {unknown} */ p) => String(p).toUpperCase().replace(/^<|>$/g, "") === SELMOD;

function priEnc(/** @type {unknown} */ p, /** @type {Layout} */ lay, /** @type {string} */ what) {
    if (p === null || p === undefined || p === "" || p === 0) return 0;
    if (isSelmod(p)) {
        if (!lay.selmod) throw new InvalidValue(`${what}: no <SELMOD> entry when both lists are Mode Slave`);
        return 0xFF;
    }
    const v = Number(p);
    if (!Number.isInteger(v)) throw new InvalidValue(`${what}: ${JSON.stringify(p)} is not a mode number`);
    if (!(v >= 1 && v <= lay.n)) throw new InvalidValue(`${what}: no mode ${v} (1..${lay.n})`);
    return v;
}

function checkList(/** @type {number} */ p1, /** @type {number} */ p2, /** @type {number[]} */ modes, /** @type {Layout} */ lay,
    /** @type {string} */ what, /** @type {boolean} */ selmod) {
    if (p1 && p1 === p2) throw new InvalidValue(`${what}: the same mode can't be Priority 1 and Priority 2`);
    const bad = modes.filter((m) => !(m >= 1 && m <= lay.n));
    if (bad.length) throw new InvalidValue(`${what}: no mode(s) [${bad.join(", ")}] (1..${lay.n})`);
    const size = (selmod ? 1 : 0) + modes.length + [p1, p2].filter((p) => p !== 0 && p !== 0xFF).length;
    if (size > lay.max) {
        throw new InvalidValue(`${what}: ${size} members${selmod ? " (<SELMOD> included)" : ""}, RSS allows ${lay.max}`);
    }
}

function bitmap(/** @type {number[]} */ modes, /** @type {number} */ W) {
    const bm = new Array(W).fill(0);
    for (const m of modes) bm[(m - 1) >> 3] |= 0x80 >> ((m - 1) % 8);
    return bm;
}

function numlistBytes(/** @type {number[]} */ old, /** @type {number[]} */ modes, /** @type {number} */ W) {
    const keep = old.filter((m) => modes.includes(m));
    const lst = [...keep, ...[...new Set(modes)].filter((m) => !keep.includes(m)).sort((a, b) => a - b)];
    return [...lst, ...new Array(W - lst.length).fill(0)];
}

const sortedNums = (/** @type {Iterable<unknown>} */ xs) => [...new Set(Array.from(xs, Number))].sort((a, b) => a - b);
const sameList = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.length === b.length && a.every((x, i) => x === b[i]);
const lc = (/** @type {unknown} */ v) => String(v).toLowerCase();

/**
 * Apply the radio-wide list (`conv`; its list types must match the codeplug:
 * use setListTypes to change them) and per-mode ModeScan rows. Change-gated:
 * unchanged values leave their bytes alone.
 * @param {Uint8Array} body @param {ConvScan | null} conv @param {Partial<ModeScan>[]} rows  (mode required)
 */
export function encode(body, conv = null, rows = []) {
    const lay = layout(body, true);
    if (!lay) throw new InvalidValue("Zone Operation is on: scan lists are per zone (zones[].scan)");
    const [curConv, curRows] = /** @type {[ConvScan, ModeScan[]]} */ (decode(body));
    const out = Uint8Array.from(body);
    /** @type {Set<number>} */
    const touched = new Set();
    if (conv) {
        for (const k of /** @type {const} */ (["scan_type", "non_priority_list", "priority_list"])) {
            if (lc(conv[k]) !== lc(curConv[k])) {
                throw new InvalidValue(`conventional_scan.${k}: changing it re-packs the codeplug; `
                    + "use set_list_types / set_scan_type (motreader import does)");
            }
        }
        const newPri = !(conv.priority_1 === curConv.priority_1 && conv.priority_2 === curConv.priority_2);
        const newMem = conv.modes !== null && curConv.modes !== null && !sameList(sortedNums(conv.modes), sortedNums(curConv.modes));
        if ((newPri || newMem) && lay.rw === null) throw new InvalidValue("conventional_scan: this list layout is not handled; use RSS");
        const p1 = lay.priOp ? priEnc(conv.priority_1, lay, "conventional_scan.priority_1") : 0;
        const p2 = lay.priOp ? priEnc(conv.priority_2, lay, "conventional_scan.priority_2") : 0;
        const mem = lay.nonpriOp ? sortedNums(conv.modes ?? []).filter((m) => m !== p1 && m !== p2) : [];
        if (newPri || newMem) checkList(p1, p2, mem, lay, "conventional_scan", true);
        const rw = /** @type {number} */ (lay.rw);
        if (newPri) {
            [out[rw - 2], out[rw - 1]] = [p1, p2];
            if (lay.perMode) {   // shared priorities copied into every record
                for (const t of lay.starts) {
                    [out[t + lay.tail], out[t + lay.tail + 1]] = [p1, p2];
                    touched.add(t);
                }
            }
        }
        if (newMem) {
            out.set(lay.numlist ? numlistBytes(Array.from(body.subarray(rw, rw + lay.W)), mem, lay.W) : bitmap(mem, lay.W), rw);
        }
    }
    const byMode = new Map(curRows.map((r) => [r.mode, r]));
    for (const r of rows) {
        const cur = byMode.get(/** @type {number} */ (r.mode));
        if (!cur) throw new InvalidValue(`no mode ${r.mode}`);
        const t = /** @type {number} */ (lay.starts[cur.mode - 1]);
        const [so, sb] = lay.scanBit();
        for (const [name, mask, on, off] of FLAGS) {
            const v = r[name];
            if (v === null || v === undefined || lc(v) === lc(cur[name])) continue;
            if (lc(v) !== lc(on) && lc(v) !== lc(off)) throw new InvalidValue(`mode ${r.mode} ${name}: ${JSON.stringify(v)} is not ${on} / ${off}`);
            const [o, bit] = name === "scan" ? [t + so, sb] : [t + SCAN_OFF, mask];
            out[o] = lc(v) === lc(on) ? /** @type {number} */ (out[o]) | bit : /** @type {number} */ (out[o]) & ~bit & 0xFF;
            touched.add(t);
        }
        if (!lay.perMode) continue;
        const what = `mode ${r.mode} scan list`;
        const o = t + lay.tail;
        const chgPri = !lay.priOp && !((r.priority_1 ?? null) === cur.priority_1 && (r.priority_2 ?? null) === cur.priority_2);
        const chgMem = !lay.nonpriOp && r.modes !== null && r.modes !== undefined && !sameList(sortedNums(r.modes), sortedNums(cur.modes ?? []));
        if (!(chgPri || chgMem)) continue;
        const p1 = !lay.priOp ? priEnc(r.priority_1, lay, what) : /** @type {number} */ (out[o]);
        const p2 = !lay.priOp ? priEnc(r.priority_2, lay, what) : /** @type {number} */ (out[o + 1]);
        if (lay.nonpriOp) {   // members are the radio-wide list's
            const mem = lay.rw !== null ? sortedNums(members(out, lay.rw, lay.W, lay.numlist)).filter((m) => m !== p1 && m !== p2) : [];
            checkList(p1, p2, mem, lay, what, lay.selmod);
            [out[o], out[o + 1]] = [p1, p2];
        } else {
            const mem = new Set(Array.from(r.modes ?? cur.modes ?? [], Number));
            const own = lay.priOp ? new Set() : new Set([p1, p2]);   // shared priorities: not exclusive (RSS)
            if (!own.has(cur.mode)) mem.add(cur.mode);   // RSS: a mode is always on its own list
            const list = sortedNums(mem).filter((m) => !own.has(m));
            checkList(p1, p2, list, lay, what, lay.selmod);
            out.set([p1, p2, ...bitmap(list, lay.W)], o);
        }
        touched.add(t);
    }
    const s0 = /** @type {number} */ (lay.starts[0]);
    if (lay.perMode && lay.rw !== null && touched.has(s0)) {
        // the radio-wide list mirrors mode 1's Mode Slave part(s)
        const o = s0 + lay.tail;
        if (!lay.priOp) out.set(out.slice(o, o + 2), lay.rw - 2);
        if (!lay.nonpriOp) out.set(out.slice(o + 2, o + 2 + lay.W), lay.rw);
    }
    const k = lay.sumAt();
    for (const t of touched) if (sum8(body, t, t + k) === body[t + k]) out[t + k] = sum8(out, t, t + k);
    return out;
}

/**
 * {body offset: mode number} of the per-mode scan bytes, and the radio-wide
 * list (mode 0), for change reports.
 */
export function offsets(/** @type {Uint8Array} */ body) {
    const lay = layout(body);
    /** @type {Map<number, number>} */
    const out = new Map();
    if (!lay) return out;
    lay.starts.forEach((t, i) => {
        out.set(t + SCAN_OFF, i + 1);
        if (lay.perMode) for (let j = 0; j < 2 + lay.W; j++) out.set(t + lay.tail + j, i + 1);
    });
    if (lay.rw !== null) for (let j = -2; j < lay.W; j++) out.set(lay.rw + j, 0);
    return out;
}

const EXT_PTRS = [0x18, 0x1A, 0x1C, 0x20, 0x22, 0x25, 0x27, 0x29, 0x2B, 0x2D, 0x41, 0x47, 0x49, 0x50];

/**
 * CONVENTIONAL Non-Priority / Priority List Op Select <-> Mode Slave, the way
 * RSS re-packs it (617ASQ, 604ATY): a Mode Slave list is stored after each
 * record's checksum (records grow by 2+W; no list is kept per mode when both
 * are Op Select). A list turning Mode Slave starts as a copy of the
 * radio-wide list in every mode; turning Op Select it keeps mode 1's.
 * Without Priority Op Select there is no <SELMOD>, so a <SELMOD> priority is
 * dropped.
 */
export function setListTypes(/** @type {Uint8Array} */ body, /** @type {string} */ nonPriorityList, /** @type {string} */ priorityList) {
    const lay = layout(body, true);
    if (!lay) throw new InvalidValue("Zone Operation is on: there is no CONVENTIONAL scan list type");
    const want = [["non_priority_list", nonPriorityList], ["priority_list", priorityList]].map(([k, v]) => {
        const i = LIST_TYPES.map(lc).indexOf(lc(v));
        if (i < 0) throw new InvalidValue(`conventional_scan.${k}: ${JSON.stringify(v)} is not one of ${LIST_TYPES.join(", ")}`);
        return i === 0;
    });
    const [nop, pop] = /** @type {[boolean, boolean]} */ (want);
    if (nop === lay.nonpriOp && pop === lay.priOp) return body;
    if (lay.talkgroup && pop) throw new InvalidValue("SCAN TYPE Talkgroup keeps the Priority List Mode Slave");
    const per = !(nop && pop);
    if (per && lay.numlist) {
        throw new InvalidValue("per-mode scan lists above 120 modes are not handled (RSS: the "
            + "codeplug outgrows the radio on 604ATY); use RSS");
    }
    if (lay.rw === null) throw new InvalidValue("radio-wide scan list not found; use RSS");
    const { W, L, n } = lay;
    const s0 = /** @type {number} */ (lay.starts[0]);
    const baseLen = lay.perMode ? lay.tail : L;
    const nL = baseLen + (per ? 2 + W : 0);
    const rwl = Array.from(body.subarray(lay.rw - 2, lay.rw + W));
    /** @type {number[]} */
    const recs = [];
    for (const t of lay.starts) {
        const rec = Array.from(body.subarray(t, t + baseLen));
        const bits = /** @type {number} */ (rec[SCAN_OFF]) & ~(NONPRI_OP | PRI_OP) & 0xFF;
        rec[SCAN_OFF] = bits | (nop ? NONPRI_OP : 0) | (pop ? PRI_OP : 0);
        if (sum8(body, t, t + baseLen - 1) === body[t + baseLen - 1]) rec[baseLen - 1] = sum8(rec, 0, baseLen - 1);
        if (per) {
            const tail = lay.perMode ? Array.from(body.subarray(t + baseLen, t + L)) : new Array(2 + W).fill(0);
            if ((!pop && lay.priOp) || !lay.perMode) tail.splice(0, 2, ...rwl.slice(0, 2));   // priority list turning Mode Slave
            if ((!nop && lay.nonpriOp) || !lay.perMode) tail.splice(2, W, ...rwl.slice(2));   // non-priority list turning Mode Slave
            if (!pop) for (const i of [0, 1]) if (tail[i] === 0xFF) tail[i] = 0;   // no <SELMOD> without Priority Op Select
            rec.push(...tail);
        }
        recs.push(...rec);
    }
    const end = s0 + L * n;
    const neu = new Uint8Array([...body.subarray(0, s0), ...recs, ...body.subarray(end)]);
    const d = nL - L;
    const moved = (/** @type {number} */ p) => {
        if (p < s0) return p;
        if (p >= end) return p + d * n;
        return s0 + Math.floor((p - s0) / L) * nL + ((p - s0) % L);
    };
    const e = lay.e;
    for (const o of HDR_PTRS) putBe16(neu, o, moved(be16(body, o) - lay.base) + lay.base);
    for (const k of EXT_PTRS) {
        const w = be16(body, e + k) - lay.base;
        if (w >= s0 && w <= body.length) putBe16(neu, e + k, moved(w) + lay.base);
    }
    lay.starts.forEach((t, i) => putBe16(neu, lay.tab + 2 * i, moved(t) + lay.base));
    neu[lay.tab + 2 * n] = sum8(neu, lay.tab, lay.tab + 2 * n);
    neu[0x10A] = nL;
    const rw = moved(lay.rw);
    const o = s0 + baseLen;
    if (per) {   // the radio-wide list mirrors mode 1's Mode Slave part(s)
        if (!pop) neu.set(neu.slice(o, o + 2), rw - 2);
        if (!nop) neu.set(neu.slice(o + 2, o + 2 + W), rw);
    } else if (lay.perMode) {   // back to Op Select: mode 1's list (RSS)
        neu.set(body.subarray(o, o + 2 + W), rw - 2);
    }
    const Le = /** @type {number} */ (neu[e]);
    neu[e + Le - 1] = sum8(neu, e, e + Le - 1);
    return finishBody(neu, body.length);
}

/**
 * 900 MHz SCAN TYPE Pri Tlkgr <-> Talkgroup (604ATY): every scanning mode's
 * bit moves between +20 b1 and +2 b4; Talkgroup also needs the Priority List
 * Mode Slave (re-packed first, as RSS does). Disabled / Channel are not a
 * setting: they follow from no mode scanning / the VHF band.
 */
export function setScanType(/** @type {Uint8Array} */ body, /** @type {string} */ scanType) {
    let lay = /** @type {Layout | null} */ (layout(body, true));
    if (!lay) throw new InvalidValue("Zone Operation is on: SCAN TYPE is per zone (zones[].scan)");
    if (lc(scanType) === lc(lay.scanType)) return body;
    const want = lc(scanType);
    if (lay.band !== "900" || !["talkgroup", "pri tlkgr"].includes(want) || lay.scanType === "Disabled") {
        throw new InvalidValue("conventional_scan.scan_type: RSS offers Pri Tlkgr / Talkgroup only "
            + `on 900 MHz radios with scanning modes (this one: ${lay.scanType})`);
    }
    if (want === "pri tlkgr" && !lay.nonpriOp) {
        throw new InvalidValue("Talkgroup -> Pri Tlkgr clears the Mode Slave Non-Priority lists in RSS "
            + "(not reproduced yet); use RSS");
    }
    if (want === "talkgroup" && lay.priOp) {
        body = setListTypes(body, /** @type {string} */ (LIST_TYPES[lay.nonpriOp ? 0 : 1]), "Mode Slave");
        lay = /** @type {Layout} */ (layout(body));
    }
    const out = Uint8Array.from(body);
    const [src, dst] = want === "talkgroup" ? [[SCAN_OFF, SCAN_BIT], [TG_OFF, TG_BIT]] : [[TG_OFF, TG_BIT], [SCAN_OFF, SCAN_BIT]];
    const k = lay.sumAt();
    for (const t of lay.starts) {
        const [so, sb] = /** @type {[number, number]} */ (src);
        const [dO, dB] = /** @type {[number, number]} */ (dst);
        if (/** @type {number} */ (out[t + so]) & sb) {
            const ok = sum8(out, t, t + k) === out[t + k];
            out[t + so] = /** @type {number} */ (out[t + so]) & ~sb & 0xFF;
            out[t + dO] = /** @type {number} */ (out[t + dO]) | dB;
            if (ok) out[t + k] = sum8(out, t, t + k);
        }
    }
    return out;
}
