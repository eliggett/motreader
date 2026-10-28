// @ts-check
/**
 * Edits of the control-head buttons, checked the way the CLI checks
 * buttons.csv: all the buttons' functions are written together onto the
 * codeplug as opened (so RSS's duplicate check sees the final layout) and
 * read back, so a button shows what RSS would show.
 */
import { InvalidValue } from "./errors.js";
import { decodeButtons, encodeButtons } from "./buttons.js";

/** @typedef {import("./document.js").CodeplugDocument} CodeplugDocument */
/** @typedef {import("./buttons.js").Button & { hack?: boolean }} DocButton  hack: set as an experimental (not in RSS) edit */

const norm = (/** @type {string} */ f) => f.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** The buttons as rows for encodeButtons (unchanged ones are skipped by it). */
export const buttonRows = (/** @type {Pick<CodeplugDocument, "buttons">} */ doc) =>
    doc.buttons.map((b) => ({ button: b.button, function: b.function, hack: b.hack === true }));

/**
 * Set buttons' functions (rows of button + function text). `hack` allows
 * what RSS doesn't (fixed buttons, functions RSS doesn't offer on a key).
 * Throws InvalidValue (nothing changed) if they can't be written.
 * @param {CodeplugDocument} doc @param {{ button: string, function: string }[]} rows @param {boolean} [hack]
 */
export function setButtons(doc, rows, hack = false) {
    const next = doc.buttons.map((b) => ({ ...b }));
    const extra = [];
    for (const r of rows) {
        const b = next.find((x) => x.button === r.button);
        if (!b) extra.push({ ...r, hack });
        else if (norm(r.function) !== norm(b.function)) Object.assign(b, { function: r.function, hack });
    }
    const body = doc.cp.body.slice();
    encodeButtons(doc.cp, body, [...buttonRows({ buttons: next }), ...extra]);
    const back = decodeButtons({ ...doc.cp, body });
    if (back.length !== next.length) throw new InvalidValue("the buttons don't read back");
    doc.buttons = back.map((b, i) => ({ ...b, hack: b.function !== doc.original.buttons[i] && next[i]?.hack === true }));
}

/** Set one button's function. @param {CodeplugDocument} doc @param {string} button @param {string} func @param {boolean} [hack] */
export const setButton = (doc, button, func, hack = false) => setButtons(doc, [{ button, function: func }], hack);
