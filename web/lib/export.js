// @ts-check
/**
 * Turning an edited document back into an archive file, in the order the
 * Python import applies edits (motreader-py/cli.py do_import):
 *
 *   1. modes and zones (rebuild.js) into a copy of the original body
 *   2. the phone and MPL lists (lists.js), the control-head buttons (buttons.js)
 *   3. radio-wide settings (radiowide.encode)
 *   4. the A9 head checksum over name edits
 *   5. encrypt with the original nonce, behind the original banner
 *
 * then the result is decoded again and checked against what was asked for.
 */
import { rebuild } from "./rebuild.js";
import { encode as encodeRadioWide, decode as decodeRadioWide } from "./radiowide.js";
import { fixA9HeadChecksum } from "./a9.js";
import { sealArchive, openArchive } from "./archive.js";
import { parseCodeplug, fixHeaderChecksum } from "./codeplug.js";
import { diff } from "./bytes.js";
import { encodePhones, encodeMpls, decodePhones, decodeMpls } from "./lists.js";
import { encodeButtons, decodeButtons } from "./buttons.js";
import { buttonRows } from "./buttonfields.js";

/** @typedef {import("./document.js").CodeplugDocument} CodeplugDocument */

/** The fields compared after a round trip (the editable mode values). */
export const MODE_CHECK_FIELDS = /** @type {const} */ ([
    "name", "rx_mhz", "tx_mhz", "ta_mhz", "tx_power", "ta_power", "up_xtal_shift", "mdc_ptt_id",
    "phone_encode", "mpl_type", "audio_compander", "adaptive_splatter", "reverse_burst_toc",
    "unmute_mute_type",
]);

/**
 * The new plaintext body: `doc.cp`'s modes/zones, the lists and
 * `radioWideEdits` applied to the original body. Throws InvalidValue for a
 * value that can't be written. (`phones` / `mpls` / `buttons` may be absent: unchanged.)
 * @param {Pick<CodeplugDocument, "cp"> & Partial<Pick<CodeplugDocument, "phones" | "mpls" | "buttons">>} doc
 * @param {Record<string, unknown>} radioWideEdits  key -> value in RSS wording
 */
export function buildBody(doc, radioWideEdits = {}) {
    let out = /** @type {Uint8Array} */ (rebuild(doc.cp));
    if (doc.phones?.length) encodePhones(doc.cp, out, doc.phones);
    if (doc.mpls?.length) encodeMpls(doc.cp, out, doc.mpls);
    if (doc.buttons?.length) encodeButtons(doc.cp, out, buttonRows({ buttons: doc.buttons }));
    if (Object.keys(radioWideEdits).length) out = encodeRadioWide(out, radioWideEdits);
    fixA9HeadChecksum(doc.cp, out);
    fixHeaderChecksum(out);         // the radio checks it (FL 01/82)
    return out;
}

/**
 * @typedef {{
 *   bytes: Uint8Array,        // the archive file
 *   plain: Uint8Array,        // its decrypted body
 *   changed: number[],        // body offsets that differ from the file as imported (over the shorter length)
 *   problems: string[],       // round-trip mismatches (empty = verified)
 * }} ExportResult
 */

/**
 * Build the archive file and verify it: decrypt and decode it again, and
 * compare the modes' editable values and the radio-wide settings.
 * @param {CodeplugDocument} doc
 * @param {Record<string, unknown>} radioWideEdits
 * @returns {ExportResult}
 */
export function exportArchive(doc, radioWideEdits = {}) {
    const plain = buildBody(doc, radioWideEdits);
    const bytes = sealArchive(doc.banner, plain);
    const back = openArchive(bytes).plain;
    /** @type {string[]} */
    const problems = [];
    if (back.length !== plain.length || diff(back, plain).length) problems.push("the archive does not decrypt to the body written");
    const check = parseCodeplug(back);
    if (check.modes.length !== doc.cp.modes.length) problems.push(`${check.modes.length} modes read back, ${doc.cp.modes.length} expected`);
    doc.cp.modes.forEach((m, i) => {
        const c = check.modes[i];
        if (!c) return;
        for (const k of MODE_CHECK_FIELDS) {
            if (m[k] !== c[k]) problems.push(`mode ${m.number} ${k}: wrote ${JSON.stringify(m[k])}, reads back ${JSON.stringify(c[k])}`);
        }
    });
    const want = decodeRadioWide(plain);
    const got = decodeRadioWide(back);
    for (const k of Object.keys(want)) if (want[k] !== got[k]) problems.push(`radio_wide.${k} reads back differently`);
    for (const [k, v] of Object.entries(radioWideEdits)) {
        if (k in got && String(got[k]).toLowerCase() !== String(v).toLowerCase() && Number(got[k]) !== Number(v)) {
            problems.push(`radio_wide.${k}: asked for ${JSON.stringify(v)}, reads back ${JSON.stringify(got[k])}`);
        }
    }
    const lists = /** @type {const} */ ([["phone", doc.phones, decodePhones], ["MPL", doc.mpls, decodeMpls]]);
    for (const [what, want, decodeList] of lists) {
        if (!want?.length) continue;
        const back = decodeList(check);
        want.forEach((x, i) => {
            if (JSON.stringify(x) !== JSON.stringify(back[i])) problems.push(`${what} ${x.number} reads back as ${JSON.stringify(back[i])}`);
        });
    }
    if (doc.buttons?.length) {
        const back = decodeButtons(check);
        doc.buttons.forEach((b, i) => {
            if (back[i]?.button !== b.button || back[i]?.function !== b.function) problems.push(`button ${b.button} reads back as ${back[i]?.function}`);
        });
    }
    return { bytes, plain, changed: diff(doc.importedPlain ?? doc.plain, plain), problems };
}
