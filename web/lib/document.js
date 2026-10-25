// @ts-check
/**
 * An open codeplug: the archive file decoded into everything the app shows.
 * Pure (no browser APIs), so it is what the tests open too.
 */
import { splitArchive } from "./archive.js";
import { decryptBody } from "./crypto.js";
import { parseCodeplug } from "./codeplug.js";
import { decode as decodeRadioWide } from "./radiowide.js";
import { trunkingInfo, TrunkingUnsupported } from "./trunking.js";

/**
 * @typedef {{
 *   fileName: string,
 *   raw: Uint8Array,            // the archive file as imported
 *   banner: Uint8Array,
 *   plain: Uint8Array,          // the decrypted codeplug body
 *   cp: import("./codeplug.js").Codeplug,
 *   radioWide: import("./radiowide.js").RadioWide,
 *   trunk: { info: import("./trunking.js").TrunkingInfo | null, unsupported: string | null },
 *   index: { fileName: string, record: import("./dbf.js").DbfRecord | null } | null,
 * }} CodeplugDocument
 *   `trunk.unsupported`: why trunking is present but can't be removed by motreader.
 *   `index`: the archive's SPECTRAM.DBF entry, when the DBF was loaded too.
 */

/** Decode an archive file. Throws if it isn't one. */
export function openDocument(/** @type {string} */ fileName, /** @type {Uint8Array} */ raw) {
    const a = splitArchive(raw);
    const plain = decryptBody(a.body);
    const cp = parseCodeplug(plain);
    /** @type {CodeplugDocument["trunk"]} */
    let trunk = { info: null, unsupported: null };
    try {
        trunk.info = trunkingInfo(plain);
    } catch (e) {
        if (!(e instanceof TrunkingUnsupported)) throw e;
        trunk = { info: null, unsupported: e.message };
    }
    /** @type {CodeplugDocument} */
    const doc = {
        fileName, raw, banner: a.banner, plain, cp,
        radioWide: decodeRadioWide(plain, cp.band),
        trunk, index: null,
    };
    return doc;
}

/** Does the codeplug have trunking (removable or not)? */
export const hasTrunking = (/** @type {CodeplugDocument} */ d) => d.trunk.info !== null || d.trunk.unsupported !== null;
