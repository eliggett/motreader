// @ts-check
/**
 * Decode a Spectra codeplug (the decrypted archive body): header, modes and
 * zones. Port of the read side of motreader/codeplug.py; see notes/FORMAT.md
 * §5 for the layouts. Decoding is band-aware: the record layout and the
 * frequency codecs differ between VHF and 900 MHz, and the band is detected
 * from the body's structure.
 *
 * Decoded records keep the snake_case field names of the Python code, which
 * are also the CSV/YAML column names (`rx_mhz`, `tx_pl`, ...).
 */
import { be16 } from "./bytes.js";
import { pyRound } from "./num.js";
import { slotDecode } from "./tones.js";
import { findExtBlock, findChbBlock } from "./radiowide.js";

// ---------------------------------------------------------------------------
// Small helpers. `at` throws past the end, like a Python index would.

/** @param {Uint8Array} b @param {number} o */
function at(b, o) {
    const v = b[o];
    if (v === undefined || o < 0) throw new RangeError(`index ${o} out of range (${b.length} bytes)`);
    return v;
}
/** @param {Uint8Array} b */
const latin1 = (b) => String.fromCharCode(...b);
/** `latin-1` text with trailing spaces/NULs removed. */
const asciiField = (/** @type {Uint8Array} */ b) => latin1(b).replace(/[ \x00]+$/, "");
/** Any non-zero byte? */
const anySet = (/** @type {Uint8Array} */ b) => b.some((x) => x !== 0);
/** Lexicographic comparison of number tuples (Python tuple `>`). */
function tupleGt(/** @type {number[]} */ a, /** @type {number[]} */ b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (/** @type {number} */ (a[i]) !== b[i]) return /** @type {number} */ (a[i]) > /** @type {number} */ (b[i]);
    }
    return a.length > b.length;
}
/** Python `Counter(xs).most_common(1)[0]`: the commonest value, first seen on a tie. */
function mostCommon(/** @type {number[]} */ xs) {
    /** @type {Map<number, number>} */
    const c = new Map();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    let best = /** @type {[number, number] | null} */ (null);
    for (const [k, n] of c) if (!best || n > best[1]) best = [k, n];
    return /** @type {[number, number]} */ (best);
}
/** Python `str.isalnum` for one latin-1 character. */
const isAlnum = (/** @type {string} */ c) => /^[\p{L}\p{N}]$/u.test(c);
/** Python `str.isdigit` for one latin-1 character (includes superscripts ²³¹). */
const isDigit = (/** @type {string} */ c) => /^[0-9²³¹]$/.test(c);

// ---------------------------------------------------------------------------
// Mode names. Standard heads: 8 characters 6-bit packed (char - 0x20, MSB
// first), 6 bytes per mode, at 0x266. A9 / expanded heads: fixed-width plain
// ASCII at a variable offset, located from RSS's "MODE <n>" default names.

export const NAME_TABLE_OFF = 0x0266;
export const NAME_LEN_BYTES = 6;
export const NAME_CHARS = 8;

/** 6-bit packed name -> text (trailing spaces removed). */
export function unpackName(/** @type {Uint8Array} */ b6) {
    let bits = 0;
    let nb = 0;
    let out = "";
    for (const by of b6) {
        bits = ((bits << 8) | by) & 0xFFFF;   // at most 13 live bits, so 16 is plenty
        nb += 8;
        while (nb >= 6) {
            nb -= 6;
            out += String.fromCharCode(((bits >> nb) & 0x3F) + 0x20);
        }
    }
    return out.slice(0, NAME_CHARS).replace(/\s+$/, "");
}

/** Text -> 6-bit packed name (8 characters, space padded). */
export function packName(/** @type {string} */ name) {
    const s = (name + " ".repeat(NAME_CHARS)).slice(0, NAME_CHARS);
    const out = [];
    let bits = 0;
    let nb = 0;
    for (const ch of s) {
        bits = ((bits << 6) | ((/** @type {number} */ (ch.codePointAt(0)) - 0x20) & 0x3F)) & 0xFFFF;
        nb += 6;
        while (nb >= 8) {
            nb -= 8;
            out.push((bits >> nb) & 0xFF);
        }
    }
    if (nb) out.push((bits << (8 - nb)) & 0xFF);
    return Uint8Array.from(out.slice(0, NAME_LEN_BYTES));
}

/** A left-justified ASCII name field: visible first char, printable or NUL, nothing after the NUL pad. */
function asciiNameFieldOk(/** @type {Uint8Array} */ f) {
    if (!f.length || !(at(f, 0) >= 0x21 && at(f, 0) <= 0x7E)) return false;
    if (!f.every((b) => b === 0 || (b >= 0x20 && b <= 0x7E))) return false;
    const z = f.indexOf(0);
    return z < 0 || !anySet(f.subarray(z + 1));
}

/**
 * The ASCII name table from RSS's "MODE <n>" default names: each default's
 * number is right-justified to its field's end, so `start = end - n * width`
 * with `width` = the stride between defaults. [start, width] or null.
 */
function findNameTableByDefaults(/** @type {Uint8Array} */ body, /** @type {number} */ n) {
    const text = latin1(body);
    const occ = [...text.matchAll(/MODE +(\d+)/g)].map((m) => ({
        start: /** @type {number} */ (m.index), end: /** @type {number} */ (m.index) + m[0].length,
        num: Number(m[1]),
    }));
    if (occ.length < 3) return null;
    const [w, freq] = mostCommon(occ.slice(1).map((b, i) => b.start - /** @type {{start: number}} */ (occ[i]).start));
    if (freq < 2 || !(w >= 7 && w <= 16)) return null;
    const [start, agree] = mostCommon(occ.map((o) => o.end - o.num * w));
    if (agree < 2 || start < 0 || start + n * w > body.length) return null;
    // only printable fields required: a default inside the table ("  MODE   66") starts with spaces
    for (let i = 0; i < n; i++) {
        if (!body.subarray(start + i * w, start + (i + 1) * w).every((b) => b === 0 || (b >= 0x20 && b <= 0x7E))) return null;
    }
    return /** @type {[number, number]} */ ([start, w]);
}

/** The digits a ham mode name often embeds for its RX frequency: 146.52 -> "146520". */
function freqHint(/** @type {number | null} */ freq) {
    return freq ? String(pyRound(freq * 1000)) : "";
}

/** How many entries' digit runs (3+) overlap their mode's RX-frequency digits. */
function nameTableScore(/** @type {Uint8Array} */ body, /** @type {number} */ start, /** @type {number} */ w, /** @type {string[]} */ hints) {
    let hits = 0;
    hints.forEach((h, i) => {
        if (!h) return;
        const d = [...latin1(body.subarray(start + i * w, start + i * w + w))].filter(isDigit).join("");
        for (let a = 0; a < h.length - 2; a++) {
            if (d.includes(h.slice(a, a + 3))) {
                hits++;
                return;
            }
        }
    });
    return hits;
}

/**
 * Fallback for a codeplug with no default names: among constant-width runs of
 * at least n printable fields, the one whose digits best match the RX
 * frequencies. Only used when the structural anchor is unavailable.
 */
function findNameTableByFreq(/** @type {Uint8Array} */ body, /** @type {number} */ n, /** @type {string[]} */ hints) {
    /** @type {[number, number][]} */
    const cands = [];
    const L = body.length;
    for (let w = 16; w > 6; w--) {
        const count = L - w + 1;
        if (count <= 0) continue;
        const ok = Array.from({ length: count }, (_, i) => asciiNameFieldOk(body.subarray(i, i + w)));
        const run = new Array(count).fill(0);
        for (let i = count - 1; i >= 0; i--) {
            if (ok[i]) run[i] = 1 + (i + w < count ? run[i + w] : 0);
        }
        for (let i = 0; i < count; i++) if (run[i] >= n) cands.push([i, w]);
    }
    if (!cands.length || !hints.some(Boolean)) return null;
    let best = /** @type {[number, number]} */ (cands[0]);
    let bestKey = [nameTableScore(body, best[0], best[1], hints), -best[0]];
    for (const c of cands.slice(1)) {
        const key = [nameTableScore(body, c[0], c[1], hints), -c[0]];
        if (tupleGt(key, bestKey)) {
            best = c;
            bestKey = key;
        }
    }
    return /** @type {number} */ (bestKey[0]) > 0 ? best : null;
}

/** [start, width] of the ASCII mode-name table (>= n entries), or null. */
export function findAsciiNameTable(/** @type {Uint8Array} */ body, /** @type {number} */ n, /** @type {string[]} */ hints = []) {
    return findNameTableByDefaults(body, n) ?? findNameTableByFreq(body, n, hints);
}

// ---------------------------------------------------------------------------
// Zones: three parallel arrays per zone (names, a W+3-byte flag record, a
// W-byte membership bitmap, bit (mode-1) LSB-first). Found from RSS's own
// pointers in the ext block when present (`zoneSections`), otherwise by a
// structural search (FORMAT §5c).

const ZONE_SEARCH_HI = 0x1000;

/** @param {string} nm */
function zoneNamePlausible(nm) {
    return Boolean(nm) && isAlnum(/** @type {string} */ (nm[0])) && [...nm].every((c) => isAlnum(c) || " /-".includes(c))
        && [...nm].some((c) => c >= "A" && c <= "Z");
}

/** A w-byte membership bitmap -> sorted mode numbers. */
export function membershipModes(/** @type {Uint8Array} */ body, /** @type {number} */ off, /** @type {number} */ w) {
    const out = [];
    for (let i = 0; i < w; i++) {
        const by = at(body, off + i);
        if (by) for (let bit = 0; bit < 8; bit++) if (by & (1 << bit)) out.push(i * 8 + bit + 1);
    }
    return out;
}

/** Mode numbers -> a w-byte membership bitmap. */
export function packMembership(/** @type {number[]} */ modes, /** @type {number} */ w) {
    const bm = new Uint8Array(w);
    for (const m of modes) if (m >= 1 && m <= w * 8) bm[(m - 1) >> 3] |= 1 << ((m - 1) % 8);
    return bm;
}

/** Length of the run of records (stride) repeating the byte at p+foff (<= 1 odd value allowed). */
function zoneFlagRun(/** @type {Uint8Array} */ body, /** @type {number} */ p, /** @type {number} */ stride, /** @type {number} */ foff) {
    const v = at(body, p + foff);
    if (v === 0) return 0;
    let n = 0;
    let odd = 0;
    while (p + n * stride + foff < body.length) {
        const b = at(body, p + n * stride + foff);
        if (b !== v) {
            if (odd === 0 && n > 0) odd = 1;
            else break;
        }
        n++;
    }
    return n;
}

/**
 * The membership base after the flag block: the alignment minimising the top
 * mode number, then maximising adjacency. [offset, score] or null.
 */
function zoneBestMemb(/** @type {Uint8Array} */ body, /** @type {number} */ flagsBase, /** @type {number} */ stride,
    /** @type {number} */ n, /** @type {number} */ w, /** @type {number} */ nModes) {
    /** @type {[number, number[]] | null} */
    let best = null;
    for (let pad = 0; pad < 8; pad++) {
        const mb = flagsBase + stride * n + pad;
        if (mb + n * w > body.length) break;
        const zs = Array.from({ length: n }, (_, k) => membershipModes(body, mb + k * w, w));
        if (zs.some((z) => !z.length || /** @type {number} */ (z[z.length - 1]) > nModes)) continue;
        const mx = Math.max(...zs.map((z) => /** @type {number} */ (z[z.length - 1])));
        let adj = 0;
        for (const z of zs) for (let i = 1; i < z.length; i++) if (/** @type {number} */ (z[i]) - /** @type {number} */ (z[i - 1]) === 1) adj++;
        const union = new Set(zs.flat()).size;
        const score = [union, -mx, adj];
        if (!best || tupleGt(score, best[1])) best = [mb, score];
    }
    return best;
}

/**
 * @typedef {{ N: number, w: number, namesOff: number, nameW: number, enc: "6bit" | "ascii",
 *   flagsOff: number, flagFoff: number, membOff: number, score: number[] }} ZoneBlock
 */

/** Is `cand` a better zone block than `best` (more zones, then a better score)? */
const betterBlock = (/** @type {ZoneBlock} */ cand, /** @type {ZoneBlock | null} */ best) =>
    !best || tupleGt([cand.N, ...cand.score], [best.N, ...best.score]);

/** Standard head: 6-bit names right before the flag array. */
function findZone6bit(/** @type {Uint8Array} */ body, /** @type {number} */ nModes) {
    const n = body.length;
    const wc = Math.ceil(nModes / 8);
    /** @type {ZoneBlock | null} */
    let best = null;
    const hi = Math.min(n, ZONE_SEARCH_HI + 0x400);
    const nameAt = (/** @type {number} */ o) => unpackName(body.subarray(o, o + 6));
    for (let nt = 0x100; nt < hi; nt++) {
        if (!zoneNamePlausible(nameAt(nt)) || (nt >= 6 && zoneNamePlausible(nameAt(nt - 6)))) continue;
        let N = 0;
        while (nt + (N + 1) * 6 <= n && zoneNamePlausible(nameAt(nt + N * 6))) N++;
        if (N < 2 || N > 20) continue;
        for (const w of [wc, wc - 1]) {
            if (w < 2) continue;
            const stride = w + 3;
            for (let pn = 0; pn < 3; pn++) {
                const fb = nt + 6 * N + pn;
                if (fb + stride * N > n) continue;
                let foff = -1;
                for (let f = 0; f < stride; f++) {
                    if (zoneFlagRun(body, fb, stride, f) >= Math.max(2, N - 1)) {
                        foff = f;
                        break;
                    }
                }
                if (foff < 0) continue;
                const bm = zoneBestMemb(body, fb, stride, N, w, nModes);
                if (!bm) continue;
                /** @type {ZoneBlock} */
                const cand = { N, w, namesOff: nt, nameW: 6, enc: "6bit", flagsOff: fb, flagFoff: foff, membOff: bm[0], score: bm[1] };
                if (betterBlock(cand, best)) best = cand;
            }
        }
    }
    return best;
}

/** A9 head: ASCII names are the N entries right before the ASCII mode-name table. */
function findZoneAscii(/** @type {Uint8Array} */ body, /** @type {number} */ nModes, /** @type {[number, number]} */ asciiNames) {
    const n = body.length;
    const wc = Math.ceil(nModes / 8);
    const [nameStart, nameW] = asciiNames;
    /** @type {ZoneBlock | null} */
    let best = null;
    for (const w of [wc, wc - 1]) {
        if (w < 2) continue;
        const stride = w + 3;
        const hi = Math.min(n, ZONE_SEARCH_HI);
        for (let foff = 0; foff < stride; foff++) {
            for (let p = 0x100; p + 2 * stride <= hi; p++) {
                const run = zoneFlagRun(body, p, stride, foff);
                if (run < 3 || run > 20) continue;
                const N = run;
                const bm = zoneBestMemb(body, p, stride, N, w, nModes);
                if (!bm) continue;
                const noff = nameStart - N * nameW;
                if (noff < 0) continue;
                const names = Array.from({ length: N }, (_, k) => asciiField(body.subarray(noff + k * nameW, noff + (k + 1) * nameW)));
                if (!names.every(zoneNamePlausible)) continue;
                /** @type {ZoneBlock} */
                const cand = { N, w, namesOff: noff, nameW, enc: "ascii", flagsOff: p, flagFoff: foff, membOff: bm[0], score: bm[1] };
                if (betterBlock(cand, best)) best = cand;
            }
        }
    }
    return best;
}

/** Locate the zone block structurally (no pointers), by head type. */
export function findZoneBlock(/** @type {Uint8Array} */ body, /** @type {number} */ nModes, /** @type {[number, number] | null} */ asciiNames = null) {
    if (nModes <= 0) return null;
    return asciiNames ? findZoneAscii(body, nModes, asciiNames) : findZone6bit(body, nModes);
}

/**
 * @typedef {{
 *   number: number, name: string, modes: number[], flag_byte: number,
 *   names_off: number, name_w: number, name_enc: "6bit" | "ascii",
 *   memb_off: number, memb_w: number,
 * }} Zone
 */

/**
 * @typedef {{ count: number, w: number, names: number | null, flags: number, memb: number, memb_len: number }} ZoneSections
 */

/**
 * RSS's own zone-table pointers in the ext block, or null. ext +0x58 -> names
 * (6-bit; 0 on the A9 head), +0x56 -> flag section, +0x54 -> membership
 * section (2-byte length, W bytes per zone, 8-bit sum), +0x5B = zone count,
 * +0x1E = W.
 */
export function zoneSections(/** @type {Uint8Array} */ body) {
    const e = findExtBlock(body);
    if (e === null || body.length < e + 0x60) return null;
    const base = be16(body, 0xE5) - e;
    const nz = at(body, e + 0x5B);
    const w = at(body, e + 0x1E) & 0x7F;
    if (nz === 0 || w === 0) return null;
    const ptr = (/** @type {number} */ k) => be16(body, e + k) - base;
    const [names, flags, memb] = [ptr(0x58), ptr(0x56), ptr(0x54)];
    if (!(flags >= 0 && flags < memb && memb < e)) return null;
    const mlen = be16(body, memb);
    if (memb + mlen !== e || mlen !== 2 + nz * w + 1) return null;
    /** @type {ZoneSections} */
    const s = { count: nz, w, names: names > 0 && names < flags ? names : null, flags, memb, memb_len: mlen };
    return s;
}

/** RADIO-WIDE ZONE OPERATION (control-head block +0x13 bit 4), or null if the block isn't found. */
export function zoneOperation(/** @type {Uint8Array} */ body) {
    const c = findChbBlock(body);
    return c === null ? null : Boolean(at(body, c + 0x13) & 0x10);
}

// ---------------------------------------------------------------------------
// The mode pointer table (FORMAT §5i): one big-endian pointer per mode (count
// = header 0x109) to each record; pointer = body offset + base (a model EEPROM
// base: 0x5F53 on most radios, 0x1953 on 604AUN). Record length = header
// 0x10A. motreader's per-band record views start 11 (900) or 3 (VHF) bytes
// before the true start.

/** [base, table offset, true record starts] or null. */
export function modePointerTable(/** @type {Uint8Array} */ body) {
    if (body.length < 0x1E8) return null;
    const e = findExtBlock(body);
    if (e === null) return null;
    const base = be16(body, 0xE5) - e;
    const tab = be16(body, 0xED) - base;
    const n = at(body, 0x109);
    const L = at(body, 0x10A);
    if (!(tab >= 0x1E8 && tab < body.length - 2 * n) || n === 0 || L < 20) return null;
    const starts = Array.from({ length: n }, (_, i) => be16(body, tab + 2 * i) - base);
    if (starts.some((t) => !(t > tab && t < body.length - L))) return null;
    for (let i = 1; i < n - 1; i++) if (/** @type {number} */ (starts[i + 1]) - /** @type {number} */ (starts[i]) !== L) return null;
    return /** @type {[number, number, number[]]} */ ([base, tab, starts]);
}

/** Band of the records at the pointer-table starts, from their tags. */
function recordBand(/** @type {Uint8Array} */ body, /** @type {number[]} */ starts) {
    // RX tag 0xA0 at +2 (b4 set = the mode scans with SCAN TYPE Talkgroup)
    const s900 = starts.filter((t) => (at(body, t + 2) & 0xEF) === 0xA0 && at(body, t + 13) === 0x8C).length;
    const svhf = starts.filter((t) => [0xE9, 0xE8, 0x68].includes(at(body, t + 6))).length;
    const need = Math.max(2, Math.floor(starts.length / 2));
    if (s900 >= need) return "900";
    if (svhf >= need) return "vhf";
    return null;
}

// ---------------------------------------------------------------------------
// Modes

/**
 * @typedef {{
 *   number: number, name: string,
 *   rx_mhz: number | null, ta_mhz: number | null, tx_mhz: number | null,
 *   rx_pl: string | null, tx_pl: string | null,
 *   rx_squelch_type: string | null, tx_squelch_type: string | null,
 *   ta_pl: string | null, ta_squelch_type: string | null,
 *   tx_power: string | null, ta_power: string | null, up_xtal_shift: string | null,
 *   mdc_ptt_id: string | null, phone_encode: string | null, mpl_type: string | null,
 *   audio_compander: string | null, adaptive_splatter: string | null,
 *   reverse_burst_toc: string | null, unmute_mute_type: string | null,
 *   raw: Uint8Array, offset: number,
 * }} Mode
 */

/** @returns {Mode} */
function newMode(/** @type {number} */ number, /** @type {Uint8Array} */ raw, /** @type {number} */ offset, name = "") {
    return {
        number, name, rx_mhz: null, ta_mhz: null, tx_mhz: null, rx_pl: null, tx_pl: null,
        rx_squelch_type: null, tx_squelch_type: null, ta_pl: null, ta_squelch_type: null,
        tx_power: null, ta_power: null, up_xtal_shift: null, mdc_ptt_id: null, phone_encode: null,
        mpl_type: null, audio_compander: null, adaptive_splatter: null, reverse_burst_toc: null,
        unmute_mute_type: null, raw, offset,
    };
}

const ED = (/** @type {number} */ v, /** @type {number} */ bit) => (v & bit ? "Enabled" : "Disabled");
export const MPL_BY_BITS = /** @type {Record<number, string>} */ ({ 0x00: "Disabled", 0x20: "TX Only", 0x40: "RX Only", 0x60: "RX & TX" });
export const UNMUTE_BY_BITS = /** @type {Record<number, string>} */ ({ 0: "Std/Std", 1: "Std/OR", 2: "AND/Std", 3: "AND/OR" });

// VHF conventional record (26 bytes), located by TX/T·A tags 0xE9 at +9, 0xA9
// at +13. Each frequency is linear in its record bytes: c0*lo + c1*mid + k.
export const VHF_REC_LEN = 26;
const VHF_RX_OFF = 6;
const VHF_TX_OFF = 10;
const VHF_TA_OFF = 14;
/** @typedef {[number, number, number]} Coef */
export const VHF_RX_COEF = /** @type {Coef} */ ([0.635, 0.64, 52.91]);
export const VHF_TX_COEF = /** @type {Coef} */ ([0.3175, 0.32, 81.28]);

/** VHF frequency field (lo, mid) -> MHz. */
export function vhfDecode(/** @type {number} */ lo, /** @type {number} */ mid, /** @type {Coef} */ coef) {
    const [c0, c1, k] = coef;
    return pyRound(c0 * lo + c1 * mid + k, 4);
}

/** Record starts of the VHF conventional modes (may be empty). */
export function findVhfRecords(/** @type {Uint8Array} */ body) {
    const starts = [];
    for (let i = 9; i < body.length - 4; i++) if (body[i] === 0xE9 && body[i + 4] === 0xA9) starts.push(i - 9);
    /** @type {number[]} */
    let best = [];
    for (let i = 0; i < starts.length;) {
        const run = [/** @type {number} */ (starts[i])];
        let j = i;
        while (j + 1 < starts.length && /** @type {number} */ (starts[j + 1]) - /** @type {number} */ (starts[j]) === VHF_REC_LEN) {
            run.push(/** @type {number} */ (starts[j + 1]));
            j++;
        }
        if (run.length > best.length) best = run;
        i = j + 1;
    }
    if (best.length < 2) return [];
    const valid = (/** @type {number} */ off) => {
        if (off < 0 || off + VHF_REC_LEN > body.length) return false;
        const rec = body.subarray(off, off + VHF_REC_LEN);
        if (!anySet(rec)) return false;
        if (rec[9] === 0xE9 && rec[13] === 0xA9) return true;
        // RX-only mode (blank TX/T·A): accept only on a plausible VHF RX frequency
        const rx = vhfDecode(at(rec, VHF_RX_OFF), at(rec, VHF_RX_OFF + 1), VHF_RX_COEF);
        return rx >= 108.0 && rx <= 180.0;
    };
    let s = /** @type {number} */ (best[0]);
    while (valid(s - VHF_REC_LEN)) s -= VHF_REC_LEN;
    let e = /** @type {number} */ (best[best.length - 1]);
    while (valid(e + VHF_REC_LEN)) e += VHF_REC_LEN;
    const out = [];
    for (let o = s; o < e + VHF_REC_LEN; o += VHF_REC_LEN) out.push(o);
    return out;
}

// 900 MHz conventional record. RX (no carry): 0.0125*(255*lo + 256*mid) +
// 109.65 at +14/+15. TX (+17 carry, +18, +19) and T/A (+21, +22, +23):
// 0.0125*(255*lo + 256*mid) + 816*(carry & 1).
const MODE_TABLE_OFF = 0x0D26;
const M900_TX = /** @type {const} */ ([17, 18, 19]);
const M900_TA = /** @type {const} */ ([21, 22, 23]);
const M900_STEP = 0.0125;
const M900_HIGH = 816.0;
const M900_RX_BASE = 109.65;
const M900_BAND = /** @type {const} */ ([895.0, 942.0]);
const VALID_CARRY_900 = [0xE8, 0xE9, 0xA8, 0xA9];
/** Tone slots: view +25/+27/+29 on 900 MHz, +17/+19/+21 on VHF. */
export const M900_SLOTS = /** @type {const} */ ({ rx: 25, tx: 27, ta: 29 });
export const VHF_SLOTS = /** @type {const} */ ({ rx: 17, tx: 19, ta: 21 });

/** @param {Uint8Array} rec */
function m900RxDecode(rec) {
    return pyRound(M900_STEP * (255 * at(rec, 14) + 256 * at(rec, 15)) + M900_RX_BASE, 4);
}

/** @param {Uint8Array} rec @param {readonly [number, number, number]} field */
function m900FreqDecode(rec, field) {
    const [carry, lo, mid] = field;
    return pyRound(M900_STEP * (255 * at(rec, lo) + 256 * at(rec, mid)) + M900_HIGH * (at(rec, carry) & 1), 4);
}

const plausible900 = (/** @type {number | null} */ f) => (f !== null && f >= M900_BAND[0] && f <= M900_BAND[1] ? f : null);

/**
 * (rx, tx, ta) MHz of a 900 record, as RSS shows them: TX = +17..19 when
 * programmed, else +21..23 (a simplex mode, no T/A); unprogrammed = empty.
 * @returns {[number | null, number | null, number | null]}
 */
export function decode900Fields(/** @type {Uint8Array} */ rec) {
    const rx = plausible900(m900RxDecode(rec));
    const txSet = VALID_CARRY_900.includes(at(rec, 17)) && (at(rec, 18) || at(rec, 19));
    const taSet = VALID_CARRY_900.includes(at(rec, 21)) && (at(rec, 22) || at(rec, 23));
    if (txSet) return [rx, plausible900(m900FreqDecode(rec, M900_TX)), plausible900(m900FreqDecode(rec, M900_TA))];
    if (taSet) return [rx, plausible900(m900FreqDecode(rec, M900_TA)), null];
    return [null, null, null];
}

/**
 * A 900 table found by its signature (RX tag 0xA0 at +13, 0x00 at +16, end tag
 * 0x8C at +24) on a common stride: [start, stride, count] or null.
 */
export function find900Table(/** @type {Uint8Array} */ body) {
    /** @type {number[]} */
    const sig = [];
    for (let p = 0; p < body.length - 26; p++) {
        if ((at(body, p + 13) & 0xEF) === 0xA0 && body[p + 16] === 0x00 && body[p + 24] === 0x8C) sig.push(p);
    }
    if (sig.length < 3) return null;
    const [stride] = mostCommon(sig.slice(1).map((x, i) => x - /** @type {number} */ (sig[i])));
    if (stride < 24 || stride > 80) return null;
    /** @type {number[]} */
    let best = [];
    for (let i = 0; i < sig.length;) {
        const run = [/** @type {number} */ (sig[i])];
        let j = i;
        while (j + 1 < sig.length && /** @type {number} */ (sig[j + 1]) - /** @type {number} */ (sig[j]) === stride) {
            run.push(/** @type {number} */ (sig[j + 1]));
            j++;
        }
        if (run.length > best.length) best = run;
        i = j + 1;
    }
    return /** @type {[number, number, number]} */ ([best[0], stride, best.length]);
}

// ---------------------------------------------------------------------------
// The codeplug

/**
 * @typedef {{
 *   body: Uint8Array,
 *   signature: string, serial: string, model: string,
 *   band: "" | "vhf" | "900" | "900?",
 *   modes: Mode[], zones: Zone[],
 *   ascii_names: [number, number] | null,
 *   zone_sections: ZoneSections | null,
 * }} Codeplug
 */

const SIGNATURE = "COPYRIGHT MOTOROLA INC.,1987";

/** Decode a plaintext codeplug body. */
export function parseCodeplug(/** @type {Uint8Array} */ body) {
    /** @type {Codeplug} */
    const cp = { body, signature: "", serial: "", model: "", band: "", modes: [], zones: [], ascii_names: null, zone_sections: null };
    parseHeader(cp);
    parseModes(cp);
    parseZones(cp);
    return cp;
}

/** @param {Codeplug} cp */
function parseHeader(cp) {
    const text = latin1(cp.body);
    const i = text.indexOf(SIGNATURE);
    if (i >= 0) {
        cp.signature = SIGNATURE;
        cp.serial = asciiField(cp.body.subarray(i + 0x1D, i + 0x1D + 10));
    }
    const m = /[DT]\d{2}[A-Z0-9]{9}/.exec(text);
    if (m) cp.model = m[0];
    const s = i > 0 ? /[0-9][0-9A-Z]{9}\d{2}/.exec(text.slice(Math.max(0, i - 40), i)) : null;
    if (s) cp.serial = s[0].slice(0, 10);
}

/** @param {Codeplug} cp @param {number} n */
function nameFor(cp, n) {
    if (cp.ascii_names) {
        const [start, w] = cp.ascii_names;
        const off = start + (n - 1) * w;
        return asciiField(cp.body.subarray(off, off + w));
    }
    const noff = NAME_TABLE_OFF + (n - 1) * NAME_LEN_BYTES;
    return unpackName(cp.body.subarray(noff, noff + NAME_LEN_BYTES));
}

/** How many modes get a sensible name from the current name source. */
function nameQuality(/** @type {Codeplug} */ cp, /** @type {number} */ nModes) {
    let good = 0;
    for (let i = 1; i <= nModes; i++) {
        const nm = nameFor(cp, i);
        if (nm && [...nm].every((c) => c >= " " && c <= "~") && [...nm].some(isAlnum)) good++;
    }
    return good;
}

/**
 * Standard heads keep readable 6-bit names at 0x266; A9 heads leave them
 * blank there and store ASCII elsewhere. Pick whichever reads better.
 * @param {Codeplug} cp @param {number} nModes
 */
function selectNameTable(cp, nModes) {
    const q6 = nameQuality(cp, nModes);
    if (q6 >= nModes * 0.6) return;
    const cand = findAsciiNameTable(cp.body, nModes, cp.modes.map((m) => freqHint(m.rx_mhz)));
    if (!cand) return;
    cp.ascii_names = cand;
    if (nameQuality(cp, nModes) < Math.max(q6, 1)) cp.ascii_names = null;
}

/** @param {Codeplug} cp */
function parseModes(cp) {
    const pt = modePointerTable(cp.body);
    // RSS's own pointers when they say VHF (robust after section moves), else the tag search
    const vhf = pt && recordBand(cp.body, pt[2]) === "vhf" ? pt[2].map((t) => t - 3) : findVhfRecords(cp.body);
    if (vhf.length) {
        cp.band = "vhf";
        parseModesVhf(cp, vhf);
        selectNameTable(cp, vhf.length);
        for (const m of cp.modes) m.name = nameFor(cp, m.number);
    } else {
        parseModes900(cp, pt);
    }
}

/** @param {Codeplug} cp @param {number[]} starts */
function parseModesVhf(cp, starts) {
    starts.forEach((off, i) => {
        const n = i + 1;
        const rec = cp.body.slice(off, off + VHF_REC_LEN);
        const m = newMode(n, rec, off);
        m.rx_mhz = vhfDecode(at(rec, VHF_RX_OFF), at(rec, VHF_RX_OFF + 1), VHF_RX_COEF);
        // TX / T·A are blank on an RX-only mode (both value bytes zero)
        if (at(rec, VHF_TX_OFF) || at(rec, VHF_TX_OFF + 1)) m.tx_mhz = vhfDecode(at(rec, VHF_TX_OFF), at(rec, VHF_TX_OFF + 1), VHF_TX_COEF);
        if (at(rec, VHF_TA_OFF) || at(rec, VHF_TA_OFF + 1)) m.ta_mhz = vhfDecode(at(rec, VHF_TA_OFF), at(rec, VHF_TA_OFF + 1), VHF_TX_COEF);
        [m.rx_squelch_type, m.rx_pl] = slotDecode(at(rec, 17), at(rec, 18), false, false);
        [m.tx_squelch_type, m.tx_pl] = slotDecode(at(rec, 19), at(rec, 20), true, true);
        [m.ta_squelch_type, m.ta_pl] = slotDecode(at(rec, 21), at(rec, 22), true, true);
        // option flags (FORMAT §5a); power only for a programmed TX / T·A
        m.up_xtal_shift = at(rec, 3) & 0x10 ? "Disabled" : "Enabled";
        m.mdc_ptt_id = ED(at(rec, 4), 0x80);
        m.phone_encode = ED(at(rec, 4), 0x20);
        m.mpl_type = /** @type {string} */ (MPL_BY_BITS[at(rec, 3) & 0x60]);
        if (m.tx_mhz !== null) m.tx_power = at(rec, 9) & 0x40 ? "High" : "Low";
        if (m.ta_mhz !== null) m.ta_power = at(rec, 13) & 0x40 ? "High" : "Low";
        m.name = nameFor(cp, n);
        cp.modes.push(m);
    });
}

/**
 * 900 MHz: the 566AYA fixed layout (table at 0x0D26, stride 26, a special
 * mode 1), a signature-located variable-stride table, or RSS's own pointers
 * when the two disagree with the header (e.g. zones off: 43-byte records).
 * An unrecognised layout gets band "900?" and no frequencies.
 * @param {Codeplug} cp @param {[number, number, number[]] | null} pt
 */
function parseModes900(cp, pt) {
    const b = cp.body;
    /** @type {number | null} */
    let start = null;
    /** @type {number | null} */
    let stride = null;
    let sig26 = 0;
    for (let i = 0; i < 60; i++) {
        const o = MODE_TABLE_OFF + i * 26;
        if (o + 24 < b.length && b[o + 13] === 0xA0 && b[o + 24] === 0x8C) sig26++;
    }
    if (sig26 >= 5) {
        [start, stride] = [MODE_TABLE_OFF, 26];
    } else {
        const found = find900Table(b);
        if (found) [start, stride] = [found[0], found[1]];
    }

    /** @type {number[] | null} */
    let offsets = null;
    const ptIs900 = pt !== null && recordBand(b, pt[2]) === "900";
    if (pt && ptIs900) {
        const starts = pt[2];
        const ptrOffs = starts.map((t) => t - 11);
        if (starts.length > 1 && /** @type {number} */ (starts[1]) - /** @type {number} */ (starts[0]) !== at(b, 0x10A)) {
            ptrOffs[0] = /** @type {number} */ (starts[0]);   // special first record (566AYA)
        }
        if (stride !== at(b, 0x10A) || start !== ptrOffs[0]) {
            offsets = ptrOffs;
            [start, stride] = [/** @type {number} */ (offsets[0]), at(b, 0x10A)];
        }
    }
    if (start === null || stride === null) {
        cp.band = "900?";
        return;
    }
    cp.band = "900";
    const limit = pt && ptIs900 ? pt[2].length : null;
    for (let n = 0; ;) {
        if ((offsets?.length || limit) && n >= (offsets?.length ? offsets.length : /** @type {number} */ (limit))) break;
        const off = offsets?.length ? /** @type {number} */ (offsets[n]) : start + n * stride;
        if (off + 26 > b.length) break;
        const rec = b.slice(off, off + stride);
        if (!anySet(rec.subarray(0, 26))) break;
        n++;
        const m = newMode(n, rec, off, nameFor(cp, n));
        [m.rx_mhz, m.tx_mhz, m.ta_mhz] = decode900Fields(rec);
        // the three tone slots run past the 26-byte view; a trunked mode 1 has none
        const special = n === 1 && ((pt !== null && pt[2][0] === off) || (pt === null && off === MODE_TABLE_OFF));
        if (!special) {
            for (const [key, so] of Object.entries(M900_SLOTS)) {
                const hi = off + so < b.length ? at(b, off + so) : 0;
                const lo = off + so + 1 < b.length ? at(b, off + so + 1) : 0;
                const [t, code] = slotDecode(hi, lo, key !== "rx", true);
                if (key === "rx") [m.rx_squelch_type, m.rx_pl] = [t, code];
                else if (key === "tx") [m.tx_squelch_type, m.tx_pl] = [t, code];
                else [m.ta_squelch_type, m.ta_pl] = [t, code];
            }
        }
        const f11 = at(rec, 11);
        const f12 = at(rec, 12);
        m.up_xtal_shift = f11 & 0x10 ? "Disabled" : "Enabled";
        m.audio_compander = ED(f12, 0x08);
        m.adaptive_splatter = ED(f12, 0x40);
        m.mdc_ptt_id = ED(f12, 0x80);
        m.phone_encode = ED(f12, 0x20);
        m.reverse_burst_toc = ED(f11, 0x04);
        m.unmute_mute_type = /** @type {string} */ (UNMUTE_BY_BITS[f11 & 0x03]);
        m.mpl_type = /** @type {string} */ (MPL_BY_BITS[f11 & 0x60]);
        if (m.tx_mhz !== null) m.tx_power = at(rec, 17) & 0x40 ? "High" : "Low";
        if (m.ta_mhz !== null) m.ta_power = at(rec, 21) & 0x40 ? "High" : "Low";
        cp.modes.push(m);
        if (n >= 250) break;
    }
}

/**
 * Zones (name + mode membership). Needs the modes (membership is bounded by
 * the mode count, and names follow the head type). Skipped when Zone
 * Operation is off: the structural finder could match other data then.
 * @param {Codeplug} cp
 */
function parseZones(cp) {
    const nModes = cp.modes.length;
    if (nModes === 0 || zoneOperation(cp.body) === false) return;
    const b = cp.body;
    const secs = cp.zone_sections = zoneSections(b);
    const flagByte = (/** @type {ZoneSections} */ s, /** @type {number} */ k) => at(b, s.flags + 2 + k * (s.w + 3));
    if (secs && secs.names !== null && !cp.ascii_names) {
        // standard head: follow RSS's pointers
        for (let k = 0; k < secs.count; k++) {
            const noff = secs.names + 6 * k;
            const moff = secs.memb + 2 + k * secs.w;
            cp.zones.push({
                number: k + 1, name: unpackName(b.subarray(noff, noff + 6)), modes: membershipModes(b, moff, secs.w),
                flag_byte: flagByte(secs, k), names_off: noff, name_w: 6, name_enc: "6bit", memb_off: moff, memb_w: secs.w,
            });
        }
        return;
    }
    if (secs && secs.names === null && cp.ascii_names) {
        // A9 head: same pointers; names are the ASCII entries before the mode names
        const [mstart, nw] = cp.ascii_names;
        const noff0 = mstart - secs.count * nw;
        for (let k = 0; k < secs.count; k++) {
            const noff = noff0 + k * nw;
            const moff = secs.memb + 2 + k * secs.w;
            cp.zones.push({
                number: k + 1, name: asciiField(b.subarray(noff, noff + nw)), modes: membershipModes(b, moff, secs.w),
                flag_byte: flagByte(secs, k), names_off: noff, name_w: nw, name_enc: "ascii", memb_off: moff, memb_w: secs.w,
            });
        }
        return;
    }
    const blk = findZoneBlock(b, nModes, cp.ascii_names);
    if (!blk) return;
    for (let k = 0; k < blk.N; k++) {
        const noff = blk.namesOff + k * blk.nameW;
        const moff = blk.membOff + k * blk.w;
        const name = blk.enc === "ascii" ? asciiField(b.subarray(noff, noff + blk.nameW)) : unpackName(b.subarray(noff, noff + blk.nameW));
        const fo = blk.flagsOff + k * (blk.w + 3) + blk.flagFoff;
        cp.zones.push({
            number: k + 1, name, modes: membershipModes(b, moff, blk.w), flag_byte: fo < b.length ? at(b, fo) : 0,
            names_off: noff, name_w: blk.nameW, name_enc: blk.enc, memb_off: moff, memb_w: blk.w,
        });
    }
}
