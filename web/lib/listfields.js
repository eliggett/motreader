// @ts-check
/**
 * Edits of the phone list and the MPL list, checked like mode edits: names by
 * the name rule, numbers by the dial characters, MPL squelch settings by
 * encoding and decoding them back (so the stored value is what RSS shows).
 */
import { InvalidValue } from "./errors.js";
import { nameRule } from "./modefields.js";
import { PHONE_DIAL_CHARS, mplSlotEncode, mplSlotDecode, MPL_SLOTS } from "./lists.js";
import { CTCSS_TONES, DPL_CODES } from "./tones.js";

/** @typedef {import("./document.js").CodeplugDocument} CodeplugDocument */

/** Every MPL squelch setting, as shown: "Carrier", "TPL 100.0", "DPL 023", "INV.DPL 023". */
export const MPL_SQUELCH_CHOICES = [
    "Carrier",
    ...CTCSS_TONES.map((t) => `TPL ${t.toFixed(1)}`),
    ...DPL_CODES.map((c) => `DPL ${c.slice(1)}`),
    ...DPL_CODES.map((c) => `INV.DPL ${c.slice(1)}`),
];

/** An MPL entry's slot as shown. */
export const mplSquelchText = (/** @type {import("./lists.js").Mpl} */ m, /** @type {"rx" | "tx" | "ta"} */ s) =>
    m[`${s}_code`] ? `${m[`${s}_type`]} ${m[`${s}_code`]}` : m[`${s}_type`];

/** Name width of the list's entries: the A9 head's ASCII slots are 11 wide. */
const listNameRule = (/** @type {CodeplugDocument} */ doc) => nameRule(doc.cp, doc.cp.ascii_names ? doc.cp.ascii_names[1] : 8);

/** Set phone `n`'s "name" or "dial" (number) from text. */
export function setPhone(/** @type {CodeplugDocument} */ doc, /** @type {number} */ n, /** @type {"name" | "dial"} */ key, /** @type {string} */ text) {
    const p = doc.phones[n - 1];
    if (!p) throw new InvalidValue(`no phone ${n}`);
    if (key === "name") {
        p.name = listNameRule(doc).check(text);
        return;
    }
    const dial = text.trim().toUpperCase();
    if (dial.length > 16 || [...dial].some((c) => !PHONE_DIAL_CHARS.includes(c))) {
        throw new InvalidValue("a phone number is up to 16 of 0-9 * # P");
    }
    p.dial = dial;
}

/** Set MPL `n`'s "name", or a slot ("rx" / "tx" / "ta") from text like "TPL 100.0" or "DPL 023". */
export function setMpl(/** @type {CodeplugDocument} */ doc, /** @type {number} */ n, /** @type {string} */ key, /** @type {string} */ text) {
    const m = doc.mpls[n - 1];
    if (!m) throw new InvalidValue(`no MPL entry ${n}`);
    if (key === "name") {
        m.name = listNameRule(doc).check(text);
        return;
    }
    const i = MPL_SLOTS.indexOf(/** @type {"rx" | "tx" | "ta"} */ (key));
    if (i < 0) throw new InvalidValue(`no MPL field ${key}`);
    const [type = "", code = ""] = text.trim().split(/\s+/);
    const t = type.toUpperCase() === "CARRIER" ? "Carrier" : type.toUpperCase();
    if (!["Carrier", "TPL", "DPL", "INV.DPL"].includes(t)) throw new InvalidValue(`"${text}" is not an MPL squelch setting (Carrier, TPL 100.0, DPL 023, INV.DPL 023)`);
    if (t !== "Carrier" && !code) throw new InvalidValue(`${t} needs a code`);
    // store what RSS will show: encode, then decode back
    const dplTx = i > 0 || doc.cp.band !== "vhf";
    const [hi, lo] = /** @type {[number, number]} */ (mplSlotEncode(t, code, i > 0, dplTx));
    const [bt, bc] = mplSlotDecode(hi, lo, i > 0, dplTx);
    m[`${/** @type {"rx" | "tx" | "ta"} */ (key)}_type`] = bt;
    m[`${/** @type {"rx" | "tx" | "ta"} */ (key)}_code`] = bc;
}
