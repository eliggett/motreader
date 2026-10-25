// @ts-check
/**
 * The General Info summary of an open codeplug: what it is, as best we know.
 * Things not decoded yet say so rather than being left out.
 */
import { hex, latin1 } from "./bytes.js";
import { nonce } from "./crypto.js";
import { BANNER_LONG } from "./archive.js";
import { valueLabel } from "./radiowide.js";

/** @typedef {{ label: string, value: string, note?: string }} InfoRow */
/** @typedef {{ title: string, rows: InfoRow[] }} InfoSection */

const NOT_DECODED = "not decoded yet";
const BAND_NAMES = /** @type {Record<string, string>} */ ({
    vhf: "VHF", uhf: "UHF", "900": "900 MHz", "900?": "900 MHz (mode layout not recognised)", "": "unknown",
});

/** Printable ASCII in `b`, other bytes shown as "·". */
const text = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => (x >= 0x20 && x <= 0x7E ? String.fromCharCode(x) : "·")).join("");

/** Where the data ends: the body is padded with 0xFF after it. */
export function dataEnd(/** @type {Uint8Array} */ body) {
    let end = body.length;
    while (end && body[end - 1] === 0xFF) end--;
    return end;
}

/** General Info, in sections. @param {import("./document.js").CodeplugDocument} d */
export function generalInfo(d) {
    const { cp, radioWide: rw } = d;
    const rec = d.index?.record ?? null;
    const fromDbf = d.index
        ? (rec ? null : `${d.fileName} is not listed in ${d.index.fileName}`)
        : "kept by RSS in SPECTRAM.DBF: import it (with or without an archive) to show it";
    const zoneOp = rw.zone_operation;
    const sigOff = cp.signature ? latin1(d.plain).indexOf(cp.signature) : -1;

    /** @type {InfoRow[]} */
    const radio = [
        { label: "Radio model", value: cp.model || "unknown" },
        { label: "Serial number", value: cp.serial || "unknown" },
        { label: "Customer", value: rec?.CUSTOMER || "—", note: rec ? undefined : fromDbf ?? undefined },
        { label: "Date programmed", value: rec?.DATEPGM || "—", note: rec ? `from ${d.index?.fileName} (the date RSS last saved it)` : fromDbf ?? undefined },
        { label: "Radio band", value: BAND_NAMES[cp.band] ?? cp.band },
        { label: "Control head", value: rw.control_head_type ? valueLabel("control_head_type", rw.control_head_type) : "unknown" },
        { label: "Modes", value: String(cp.modes.length) },
        {
            label: "Zones",
            value: zoneOp === "Disabled" ? "none (Zone Operation off)" : String(cp.zones.length),
        },
    ];

    const trunk = d.trunk.info
        ? `yes: mode 1 is trunked (max systems ${d.trunk.info.systems}, max subfleets ${d.trunk.info.subfleets})`
        : d.trunk.unsupported ? "yes, in a layout motreader can't remove" : "no";
    /** @type {InfoRow[]} */
    const features = [
        { label: "Zone Operation", value: String(zoneOp ?? "unknown") },
        { label: "Trunking", value: trunk, note: d.trunk.unsupported ?? undefined },
        { label: "Siren / P.A.", value: String(rw.siren_pa_options ?? "unknown") },
        { label: "MDC signalling", value: String(rw.mdc_signalling ?? "unknown") },
        { label: "Emergency", value: String(rw.emergency ?? "unknown") },
        { label: "MPL entries", value: String(rw.number_of_mpl ?? "unknown") },
        { label: "Mode names", value: cp.ascii_names ? `ASCII, ${cp.ascii_names[1]} characters (expanded head)` : "6-bit, 8 characters" },
    ];

    const end = dataEnd(d.plain);
    /** @type {InfoRow[]} */
    const codeplug = [
        { label: "Decrypted codeplug size", value: `${d.plain.length} bytes`, note: `data ends at byte ${end}; the rest is 0xFF padding` },
        { label: "Codeplug blocks", value: "—", note: NOT_DECODED },
        { label: "Radio's maximum codeplug size", value: "—", note: NOT_DECODED },
        { label: "Decryption key (nonce)", value: hex(nonce(d.plain), " "), note: "the 13 bytes at the start of the body; RSS picks new ones on every save" },
        { label: "Archive file", value: d.fileName, note: `${d.raw.length} bytes, ${d.banner.length === BANNER_LONG.length ? "long" : "short"} banner` },
        { label: "Signature", value: cp.signature || "not found" },
        {
            label: "Format version", value: d.support.version === null ? "unknown" : String(d.support.version),
            note: d.support.editable ? "supported" : `read-only: ${d.support.reasons.join("; ")}`,
        },
    ];
    if (sigOff >= 0) {
        codeplug.push({
            label: "Header ID text", value: text(d.plain.subarray(sigOff + 0x1D, sigOff + 0x1D + 17)),
            note: "serial, then digits not decoded yet",
        });
    }

    /** @type {InfoSection[]} */
    const sections = [
        { title: "Radio", rows: radio },
        { title: "Features", rows: features },
        { title: "Codeplug", rows: codeplug },
    ];
    return sections;
}
