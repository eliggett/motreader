// @ts-check
/**
 * Can motreader edit this codeplug, or only show it? Editing needs the
 * layout motreader was built and checked on: codeplug format version 115/116
 * (RSS R06.00.05's own saves), RSS's mode pointer table, a band whose codec
 * is mapped for writing (VHF, UHF or 900 MHz) and conventional modes that
 * account for the header's mode count. Anything else opens read-only, with
 * the reasons, rather than risk writing into data that was decoded wrongly.
 * (Exporting an unedited codeplug is always byte-identical.)
 *
 * The older format versions RSS still opens and saves in their own format
 * (seen on the AR-ORIG samples: 101, 102, 112, 114) keep the same mode
 * records, but their other sections aren't mapped. Versions 112 and 114 were
 * checked against RSS and open "modes only": their conventional modes can be
 * edited, nothing else is decoded. 101 and 102 (only trunked samples) are
 * read-only.
 */
import { modePointerTable, codeplugVersion, trunkedModes } from "./codeplug.js";

export { codeplugVersion };

/** Format versions motreader reads and writes. */
export const SUPPORTED_VERSIONS = [115, 116];

/** Older format versions whose conventional modes (only) motreader edits. */
export const MODES_ONLY_VERSIONS = [112, 114];

/**
 * @typedef {{ editable: boolean, modesOnly: boolean, version: number | null, reasons: string[] }} Support
 *   `modesOnly`: an older format version; only its modes are decoded and edited.
 */

/** Is this an older format version (fewer sections decoded)? */
export const isOldFormat = (/** @type {number | null} */ version) => version !== null && version < SUPPORTED_VERSIONS[0];

/**
 * Whether the decoded codeplug can be edited, and if not, why.
 * @param {import("./codeplug.js").Codeplug} cp
 * @returns {Support}
 */
export function assessSupport(cp) {
    const body = cp.body;
    const version = cp.format_version;
    /** @type {string[]} */
    const reasons = [];
    const modesOnly = isOldFormat(version);
    if (version === null) reasons.push("the codeplug format version isn't in the header");
    else if (!SUPPORTED_VERSIONS.includes(version) && !MODES_ONLY_VERSIONS.includes(version)) {
        reasons.push(`it is in codeplug format version ${version}; motreader edits version ${SUPPORTED_VERSIONS.join(" and ")}, `
            + `and the modes of versions ${MODES_ONLY_VERSIONS.join(" and ")}`);
    }
    const pt = modePointerTable(body);
    if (!pt) reasons.push("RSS's mode table wasn't found");
    if (cp.band === "900?" || cp.band === "") {
        reasons.push(cp.modes.length || !pt ? "its mode records are in a layout motreader doesn't decode"
            : "no conventional modes were recognised: the band or the mode type (e.g. all trunked) isn't decoded yet");
    }
    if (cp.band === "800") reasons.push("800 MHz modes are shown, but motreader doesn't edit them yet");
    if (cp.band === "uhf" && cp.modes.some((m) => (m.raw[12] ?? 0) & 2 || (m.raw[16] ?? 0) & 2)) {
        reasons.push("some UHF frequencies are stored in a 2.5 kHz form motreader doesn't decode yet");
    }
    const n = body[0x109] ?? 0;
    if (pt && cp.modes.length !== n && !reasons.length) {
        reasons.push(`${cp.modes.length} modes were decoded but the codeplug has ${n} (e.g. several trunked modes)`);
    }
    if (!reasons.length && trunkedModes(cp).some((t) => t.number !== 1)) {
        reasons.push("it has trunked modes other than mode 1");
    }
    return { editable: reasons.length === 0, modesOnly, version, reasons };
}
