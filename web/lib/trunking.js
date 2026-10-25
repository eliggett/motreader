// @ts-check
/**
 * Trunking detection (TRUNKED DUAL MODE, 900 MHz; FORMAT §5h). Port of
 * `trunking_info` in motreader/trunking.py; removal is ported later.
 *
 * Layout (566AYA): mode 1 is the trunked mode, a 37-byte record whose word at
 * +2 points at the 27-byte personality section right after the mode records;
 * its word at +10 points 4 bytes into the talkgroup block (4-byte head + 37
 * bytes) at the end of the data. Header 0x1D6 / 0x1D7 = MAX SYSTEMS /
 * SUBFLEETS; header word 0xE9 -> trunking system tables when present.
 */
import { be16 } from "./bytes.js";
import { modePointerTable } from "./codeplug.js";
import { findExtBlock } from "./radiowide.js";

const TRUNK_REC_LEN = 37;
const PERS_LEN = 0x1B;
const TG_HEAD = 4;
const MAX_SYSTEMS = 0x1D6;
const MAX_SUBFLEETS = 0x1D7;
const EXT_CONV_COUNT = 0x86;
const SYSTEM_PTR = 0xE9;

/** Trunking in a shape motreader can't remove (RSS can). */
export class TrunkingUnsupported extends Error {}

/**
 * @typedef {{ base: number, tab: number, starts: number[], n: number, L: number, ext: number,
 *   r0: number, pers: number, tg: number, data_end: number, systems: number, subfleets: number }} TrunkingInfo
 */

/**
 * null if the codeplug has no trunked mode, else where its parts are. Throws
 * `TrunkingUnsupported` for trunking in a shape motreader doesn't handle.
 * @returns {TrunkingInfo | null}
 */
export function trunkingInfo(/** @type {Uint8Array} */ body) {
    const pt = modePointerTable(body);
    if (!pt) return null;
    const [base, tab, starts] = pt;
    const n = /** @type {number} */ (body[0x109]);
    const L = /** @type {number} */ (body[0x10A]);
    const s = (/** @type {number} */ i) => /** @type {number} */ (starts[i]);
    if (starts.length < 2 || s(1) - s(0) === L) return null;
    const lens = Array.from({ length: n - 1 }, (_, i) => s(i + 1) - s(i));
    if (s(1) - s(0) !== TRUNK_REC_LEN || lens.slice(1).some((x) => x !== L)) {
        throw new TrunkingUnsupported("more than one trunked mode (or an unknown record layout): "
            + "only one trunked mode is handled; use RSS");
    }
    if (be16(body, SYSTEM_PTR)) {
        throw new TrunkingUnsupported("this codeplug also holds trunking SYSTEM tables (header 0xE9 "
            + "points at them; RSS re-packs those too): not handled yet, use RSS");
    }
    const e = findExtBlock(body);
    if (e === null) throw new TrunkingUnsupported("radio-wide ext block not found");
    const r0 = s(0);
    const pers = be16(body, r0 + 2) - base;
    if (!(s(starts.length - 1) + L <= pers && pers < body.length) || body[pers] !== PERS_LEN) {
        throw new TrunkingUnsupported("trunk personality section not where expected; use RSS");
    }
    const tg = be16(body, pers + 10) - base - TG_HEAD;
    let dataEnd = body.length;
    while (dataEnd && body[dataEnd - 1] === 0xFF) dataEnd--;
    if (!(pers + PERS_LEN <= tg && tg < dataEnd) || dataEnd - tg !== TG_HEAD + 37) {
        throw new TrunkingUnsupported("trunk talkgroup block not where expected; use RSS");
    }
    if (body[e + EXT_CONV_COUNT] !== n - 1) {
        throw new TrunkingUnsupported("conventional mode count not where expected; use RSS");
    }
    return {
        base, tab, starts, n, L, ext: e, r0, pers, tg, data_end: dataEnd,
        systems: /** @type {number} */ (body[MAX_SYSTEMS]), subfleets: /** @type {number} */ (body[MAX_SUBFLEETS]),
    };
}
