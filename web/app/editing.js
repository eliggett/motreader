// @ts-check
/**
 * Editing the open document: every edit from the grid, the forms, the mode
 * editor or the test API goes through here, so it is validated by the format
 * code, logged, and announced to the tabs ("edit").
 */
import { store } from "./state.js";
import { log } from "./log.js";
import { setModeField, MODE_FIELD_BY_KEY, fieldText } from "../lib/modefields.js";
import { setZoneName, setZoneModes, formatModeList } from "../lib/zonefields.js";
import { setRadioWide, changes } from "../lib/document.js";
import { setPhone, setMpl } from "../lib/listfields.js";
import { setButton } from "../lib/buttonfields.js";
import { InvalidValue } from "../lib/errors.js";

/** @typedef {{ error?: string, note?: string }} EditResult */

const errText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

/**
 * Run an edit; an InvalidValue becomes `{ error }` (and a log warning),
 * anything else is a bug and is logged as an error.
 * @param {string} what  for the log, e.g. "mode 3 Rx MHz"
 * @param {() => string | null | void} fn  returns a note, if any
 * @param {boolean} [mode]  a mode edit (the only kind on an older format version)
 * @returns {EditResult}
 */
function run(what, fn, mode = false) {
    const doc = store.get();
    if (!doc) return { error: "no codeplug is open" };
    if (!doc.support.editable) return { error: `this codeplug is read-only: ${doc.support.reasons.join("; ")}` };
    if (doc.support.modesOnly && !mode) return { error: `only modes are edited in format version ${doc.support.version}` };
    try {
        const note = fn() ?? undefined;
        store.update(() => {}, "edit");
        log.info(`${what}${note ? ` (${note})` : ""}`);
        return note ? { note } : {};
    } catch (e) {
        if (e instanceof InvalidValue) {
            log.warn(`${what}: ${e.message}`);
            return { error: e.message };
        }
        log.error(`${what} failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
        return { error: `internal error: ${errText(e)}` };
    }
}

/** Set mode `n`'s field `key` from text (as typed in the grid). */
export function editMode(/** @type {number} */ n, /** @type {string} */ key, /** @type {string} */ text) {
    const label = MODE_FIELD_BY_KEY.get(key)?.label ?? key;
    return run(`Mode ${n} ${label} = ${JSON.stringify(text)}`, () => {
        const doc = /** @type {import("./state.js").Document} */ (store.get());
        return setModeField(doc.cp, n, key, text).note;
    }, true);
}

/** Set radio-wide setting `key`. */
export function editRadioWide(/** @type {string} */ key, /** @type {unknown} */ value) {
    return run(`Radio-wide ${key} = ${JSON.stringify(value)}`, () => {
        const doc = /** @type {import("./state.js").Document} */ (store.get());
        const before = { ...doc.radioWide };
        setRadioWide(doc, key, value);
        // side effects RSS applies along with it (head type, siren, ...)
        const also = Object.keys(doc.radioWide).filter((k) => k !== key && String(doc.radioWide[k]) !== String(before[k]));
        return also.length ? `also changes ${also.join(", ")}` : null;
    });
}

/** Rename zone `n`. */
export function editZoneName(/** @type {number} */ n, /** @type {string} */ text) {
    return run(`Zone ${n} name = ${JSON.stringify(text)}`, () => {
        setZoneName(/** @type {import("./state.js").Document} */ (store.get()).cp, n, text);
    });
}

/** Set zone `n`'s modes from text like "1-5, 9". */
export function editZoneModes(/** @type {number} */ n, /** @type {string} */ text) {
    return run(`Zone ${n} modes = ${JSON.stringify(text)}`, () => {
        const cp = /** @type {import("./state.js").Document} */ (store.get()).cp;
        setZoneModes(cp, n, text);
        return `modes ${formatModeList(cp.zones[n - 1]?.modes ?? [])}`;
    });
}

/** Set phone `n`'s "name" or "dial" from text. */
export function editPhone(/** @type {number} */ n, /** @type {"name" | "dial"} */ key, /** @type {string} */ text) {
    return run(`Phone ${n} ${key === "dial" ? "number" : key} = ${JSON.stringify(text)}`, () => {
        setPhone(/** @type {import("./state.js").Document} */ (store.get()), n, key, text);
    });
}

/** Set MPL `n`'s "name" or a slot ("rx" / "tx" / "ta", e.g. "TPL 100.0"). */
export function editMpl(/** @type {number} */ n, /** @type {string} */ key, /** @type {string} */ text) {
    return run(`MPL ${n} ${key === "name" ? "name" : key.toUpperCase()} = ${JSON.stringify(text)}`, () => {
        setMpl(/** @type {import("./state.js").Document} */ (store.get()), n, key, text);
    });
}

/**
 * Put function `func` (RSS's label, "Zone 3" for direct entry) on control-head
 * button `button`. `hack`: allow what RSS doesn't (experimental).
 */
export function editButton(/** @type {string} */ button, /** @type {string} */ func, hack = false) {
    return run(`Button ${button} = ${JSON.stringify(func)}${hack ? " (experimental)" : ""}`, () => {
        setButton(/** @type {import("./state.js").Document} */ (store.get()), button, func, hack);
    });
}

/**
 * Run a structural change (lib/structure.js): `fn` gets the open document and
 * returns the re-packed one, which replaces it ("restructure"). A refusal
 * becomes `{ error }`. Refused on read-only codeplugs and on the older format
 * versions (modes are only edited there).
 * @param {string} what  for the log, e.g. "Add mode after 3"
 * @param {(doc: import("./state.js").Document) => import("./state.js").Document} fn
 * @returns {EditResult}
 */
export function restructureDoc(what, fn) {
    const doc = store.get();
    if (!doc) return { error: "no codeplug is open" };
    if (!doc.support.editable) return { error: `this codeplug is read-only: ${doc.support.reasons.join("; ")}` };
    if (doc.support.modesOnly) return { error: `adding, deleting and re-packing aren't supported in format version ${doc.support.version} yet` };
    try {
        const next = fn(doc);
        store.setDocument(next, "restructure");
        log.info(`${what}: ${next.ops[next.ops.length - 1] ?? "done"}; the codeplug is now ${next.plain.length} bytes`);
        return {};
    } catch (e) {
        if (e instanceof InvalidValue) {
            log.warn(`${what}: ${e.message}`);
            return { error: e.message };
        }
        log.error(`${what} failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
        return { error: `internal error: ${errText(e)}` };
    }
}

/** Undo the last structural change (edits made since it are dropped too). */
export function undoRestructure() {
    const doc = store.get();
    if (!doc?.previous) return { error: "there is no structural change to undo" };
    const what = doc.ops[doc.ops.length - 1];
    store.setDocument(doc.previous, "restructure");
    log.info(`Undone: ${what}`);
    return {};
}

/** Has the open document been edited? */
export function isDirty() {
    const doc = store.get();
    return doc ? changes(doc).any : false;
}

/** Text of mode `n`'s field `key` (for the test API). */
export function modeText(/** @type {number} */ n, /** @type {string} */ key) {
    const m = store.get()?.cp.modes[n - 1];
    return m ? fieldText(m, key) : null;
}
