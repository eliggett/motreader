// @ts-check
/**
 * Can motreader edit this codeplug, or only show it? Editing needs the
 * layout motreader was built and checked on: codeplug format version 115/116
 * (RSS R06.00.05's own saves), RSS's mode pointer table, a known band (VHF or
 * 900 MHz) and conventional modes that account for the header's mode count.
 * Anything else opens read-only, with the reasons, rather than risk writing
 * into data that was decoded wrongly. (Exporting an unedited codeplug is
 * always byte-identical.)
 *
 * Seen on the AR-ORIG samples: older format versions (101, 102, 112, 114),
 * which RSS opens and saves in their own format; a UHF radio (no UHF codec
 * yet); radios whose modes are all trunked.
 */
import { latin1 } from "./bytes.js";
import { modePointerTable } from "./codeplug.js";

/** Format versions motreader reads and writes. */
export const SUPPORTED_VERSIONS = [115, 116];

/**
 * The codeplug format version: the three digits after the serial in the
 * header ("617ASQ126600 115A" -> 115), or null.
 */
export function codeplugVersion(/** @type {Uint8Array} */ body) {
    const text = latin1(body.subarray(0, Math.min(body.length, 0x200)));
    const i = text.indexOf("COPYRIGHT MOTOROLA INC.,1987");
    if (i < 0) return null;
    const m = /^[0-9A-Z]{10}\d\d (\d{3})/.exec(text.slice(i + 0x1D, i + 0x1D + 17));
    return m ? Number(m[1]) : null;
}

/**
 * @typedef {{ editable: boolean, version: number | null, reasons: string[] }} Support
 */

/**
 * Whether the decoded codeplug can be edited, and if not, why.
 * @param {import("./codeplug.js").Codeplug} cp
 * @returns {Support}
 */
export function assessSupport(cp) {
    const body = cp.body;
    const version = codeplugVersion(body);
    /** @type {string[]} */
    const reasons = [];
    if (version === null) reasons.push("the codeplug format version isn't in the header");
    else if (!SUPPORTED_VERSIONS.includes(version)) {
        reasons.push(`it is in codeplug format version ${version}; motreader reads version ${SUPPORTED_VERSIONS.join(" and ")} `
            + "(RSS opens older versions and saves them in their own format)");
    }
    const pt = modePointerTable(body);
    if (!pt) reasons.push("RSS's mode table wasn't found");
    if (cp.band === "900?" || cp.band === "") {
        reasons.push(cp.modes.length || !pt ? "its mode records are in a layout motreader doesn't decode (e.g. UHF)"
            : "no conventional modes were recognised: the band (e.g. UHF) or the mode type (e.g. all trunked) isn't decoded yet");
    }
    const n = body[0x109] ?? 0;
    if (pt && cp.modes.length !== n && !reasons.length) {
        reasons.push(`${cp.modes.length} modes were decoded but the codeplug has ${n} (e.g. several trunked modes)`);
    }
    return { editable: reasons.length === 0, version, reasons };
}
