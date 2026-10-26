// @ts-check
/**
 * An open codeplug: the archive file decoded into everything the app shows.
 * Pure (no browser APIs), so it is what the tests open too.
 */
import { splitArchive } from "./archive.js";
import { decryptBody } from "./crypto.js";
import { parseCodeplug, trunkedModes } from "./codeplug.js";
import { decode as decodeRadioWide, encode as encodeRadioWide, FIELD_BY_KEY } from "./radiowide.js";
import { trunkingInfo, TrunkingUnsupported } from "./trunking.js";
import { MODE_FIELDS, fieldText } from "./modefields.js";
import { decodePhones, decodeMpls } from "./lists.js";
import { assessSupport, isOldFormat } from "./support.js";
import { buildBody } from "./export.js";

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
 *   radioWideEdits: Record<string, unknown>,
 *   phones: import("./lists.js").Phone[],
 *   mpls: import("./lists.js").Mpl[],
 *   listProblem: string | null,
 *   support: import("./support.js").Support,
 *   trunked: { number: number, name: string }[],
 *   ops: string[],
 *   importedPlain: Uint8Array,
 *   previous: CodeplugDocument | null,
 *   original: {
 *     modes: Record<string, string>[], zones: { name: string, modes: string }[],
 *     radioWide: import("./radiowide.js").RadioWide, phones: string[], mpls: string[],
 *   },
 * }} CodeplugDocument
 *   `trunk.unsupported`: why trunking is present but can't be removed by motreader.
 *   `index`: the archive's SPECTRAM.DBF entry, when the DBF was loaded too.
 *   Edits: modes and zones are edited in place in `cp`; radio-wide edits
 *   accumulate in `radioWideEdits` (applied on export), and `radioWide` shows
 *   their effect. `phones` / `mpls` are edited in place too (`listProblem`: why
 *   a list couldn't be read). `original` is how everything read when the file
 *   was opened, as displayed text, to tell what changed.
 *   An older format version (`support.modesOnly`) decodes only its modes:
 *   `radioWide`, `phones` and `mpls` are empty (and zones aren't parsed).
 *   Structural changes (adding / deleting modes and zones, Zone Operation, ...)
 *   re-pack the codeplug: `restructure` writes the edits so far into it and
 *   opens the result as a new document, so `plain` / `original` describe the
 *   re-packed codeplug; `ops` lists the structural changes made since the file
 *   was imported, `importedPlain` is the body as imported, and `previous` is
 *   the document before the last structural change (for undo).
 */

/** Decode an archive file. Throws if it isn't one. */
export function openDocument(/** @type {string} */ fileName, /** @type {Uint8Array} */ raw) {
    const a = splitArchive(raw);
    return documentFromBody(fileName, raw, a.banner, decryptBody(a.body));
}

/**
 * A document for a decrypted body (as imported, or re-packed).
 * @param {string} fileName @param {Uint8Array} raw @param {Uint8Array} banner @param {Uint8Array} plain
 * @returns {CodeplugDocument}
 */
function documentFromBody(fileName, raw, banner, plain) {
    const cp = parseCodeplug(plain);
    /** @type {CodeplugDocument["trunk"]} */
    let trunk = { info: null, unsupported: null };
    try {
        trunk.info = trunkingInfo(plain);
    } catch (e) {
        if (!(e instanceof TrunkingUnsupported)) throw e;
        trunk = { info: null, unsupported: e.message };
    }
    // older format versions: only the modes are mapped
    const modesOnly = isOldFormat(cp.format_version);
    const radioWide = modesOnly ? {} : decodeRadioWide(plain, cp.band);
    /** @type {string | null} */
    let listProblem = null;
    const tryList = (/** @type {() => any[]} */ fn) => {
        try {
            return fn();
        } catch (e) {
            listProblem = e instanceof Error ? e.message : String(e);
            return [];
        }
    };
    const phones = modesOnly ? [] : tryList(() => decodePhones(cp));
    const mpls = modesOnly ? [] : tryList(() => decodeMpls(cp));
    /** @type {CodeplugDocument} */
    const doc = {
        fileName, raw, banner, plain, cp, radioWide, trunk, index: null,
        radioWideEdits: {}, phones, mpls, listProblem, support: assessSupport(cp), trunked: trunkedModes(cp),
        ops: [], importedPlain: plain, previous: null,
        original: {
            modes: cp.modes.map(modeTexts),
            zones: cp.zones.map((z) => ({ name: z.name, modes: z.modes.join(" ") })),
            radioWide: { ...radioWide },
            phones: phones.map((p) => JSON.stringify(p)),
            mpls: mpls.map((m) => JSON.stringify(m)),
        },
    };
    return doc;
}

/** A mode's fields as displayed text, key -> text. */
export function modeTexts(/** @type {import("./codeplug.js").Mode} */ m) {
    return Object.fromEntries(MODE_FIELDS.map((f) => [f.key, fieldText(m, f.key)]));
}

/** Does the codeplug have trunking (removable or not)? */
export const hasTrunking = (/** @type {CodeplugDocument} */ d) => d.trunk.info !== null || d.trunk.unsupported !== null;

/**
 * Edit radio-wide setting `key`. The value is tried on the codeplug first
 * (throws InvalidValue if it can't be stored); `radioWide` then shows the
 * result, side effects included. Setting a field back to how it was opened
 * drops the edit.
 * @param {CodeplugDocument} doc @param {string} key @param {unknown} value
 */
export function setRadioWide(doc, key, value) {
    const f = FIELD_BY_KEY.get(key);
    if (!f) throw new Error(`no radio-wide field ${key}`);
    const edits = { ...doc.radioWideEdits, [key]: value };
    if (String(value) === String(doc.original.radioWide[key])) delete edits[key];
    const body = encodeRadioWide(doc.plain, edits);
    doc.radioWideEdits = edits;
    doc.radioWide = decodeRadioWide(body, doc.cp.band);
}

/**
 * What differs from the file as opened: mode numbers, zone numbers and
 * radio-wide keys (side effects included).
 * @param {CodeplugDocument} doc
 */
export function changes(doc) {
    const ops = doc.ops;
    const modes = doc.cp.modes.filter((m, i) => {
        const was = doc.original.modes[i] ?? {};
        return MODE_FIELDS.some((f) => fieldText(m, f.key) !== was[f.key]);
    }).map((m) => m.number);
    const zones = doc.cp.zones.filter((z, i) => {
        const was = doc.original.zones[i];
        return !was || was.name !== z.name || was.modes !== z.modes.join(" ");
    }).map((z) => z.number);
    const keys = new Set([...Object.keys(doc.radioWide), ...Object.keys(doc.original.radioWide)]);
    const radioWide = [...keys].filter((k) => String(doc.radioWide[k]) !== String(doc.original.radioWide[k]));
    const phones = doc.phones.filter((p, i) => JSON.stringify(p) !== doc.original.phones[i]).map((p) => p.number);
    const mpls = doc.mpls.filter((m, i) => JSON.stringify(m) !== doc.original.mpls[i]).map((m) => m.number);
    return {
        ops, modes, zones, radioWide, phones, mpls,
        any: ops.length + modes.length + zones.length + radioWide.length + phones.length + mpls.length > 0,
    };
}

/**
 * Apply a structural change: the edits so far are written into the body (as
 * on export), `fn` re-packs it, and the result opens as the new document
 * (with `what` added to `ops`). Throws InvalidValue when the edits can't be
 * written or `fn` refuses. Highlighting of changed values starts again from
 * the new document.
 * @param {CodeplugDocument} doc @param {string} what @param {(body: Uint8Array) => Uint8Array} fn
 * @returns {CodeplugDocument}
 */
export function restructure(doc, what, fn) {
    const body = fn(buildBody(doc, doc.radioWideEdits));
    const next = documentFromBody(doc.fileName, doc.raw, doc.banner, body);
    next.index = doc.index;
    next.ops = [...doc.ops, what];
    next.importedPlain = doc.importedPlain;
    next.previous = doc;
    return next;
}
