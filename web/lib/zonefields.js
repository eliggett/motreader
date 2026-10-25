// @ts-check
/**
 * Zone edits: a zone's name and its member modes (the zone tables are
 * template-patched by rebuild.js; adding/removing zones comes later).
 */
import { InvalidValue } from "./errors.js";
import { nameRule } from "./modefields.js";

/** @typedef {import("./codeplug.js").Codeplug} Codeplug */

/** "1-5, 9 12" -> [1, 2, 3, 4, 5, 9, 12]. */
export function parseModeList(/** @type {string} */ text) {
    /** @type {Set<number>} */
    const out = new Set();
    for (const part of text.split(/[\s,]+/).filter(Boolean)) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!m) throw new InvalidValue(`"${part}" is not a mode number or range (like 1-5)`);
        const a = Number(m[1]);
        const b = m[2] === undefined ? a : Number(m[2]);
        if (b < a) throw new InvalidValue(`"${part}": the range runs backwards`);
        for (let n = a; n <= b; n++) out.add(n);
    }
    return [...out].sort((x, y) => x - y);
}

/** [1, 2, 3, 5, 7, 8] -> "1-3, 5, 7-8". */
export function formatModeList(/** @type {number[]} */ modes) {
    /** @type {string[]} */
    const parts = [];
    for (let i = 0; i < modes.length;) {
        let j = i;
        while (j + 1 < modes.length && /** @type {number} */ (modes[j + 1]) === /** @type {number} */ (modes[j]) + 1) j++;
        parts.push(i === j ? String(modes[i]) : `${modes[i]}-${modes[j]}`);
        i = j + 1;
    }
    return parts.join(", ");
}

/** Rename zone `n`. */
export function setZoneName(/** @type {Codeplug} */ cp, /** @type {number} */ n, /** @type {string} */ text) {
    const z = cp.zones[n - 1];
    if (!z) throw new InvalidValue(`no zone ${n}`);
    const rule = nameRule(cp);
    const width = z.name_enc === "ascii" ? z.name_w : rule.width;
    const name = z.name_enc === "ascii" ? text.replace(/\s+$/, "") : text.toUpperCase().replace(/\s+$/, "");
    if (!name.trim()) throw new InvalidValue("a zone needs a name");
    if (name.length > width) throw new InvalidValue(`a zone name holds at most ${width} characters`);
    // the structural zone finder recognises names by these characters, so keep to them
    if (!/^[A-Za-z0-9][A-Za-z0-9 /-]*$/.test(name) || !/[A-Z]/.test(name)) {
        throw new InvalidValue("a zone name starts with a letter or digit, has at least one capital letter, "
            + "and uses only letters, digits, spaces, / and -");
    }
    z.name = name;
}

/** Set zone `n`'s member modes from text like "1-5, 9". */
export function setZoneModes(/** @type {Codeplug} */ cp, /** @type {number} */ n, /** @type {string} */ text) {
    const z = cp.zones[n - 1];
    if (!z) throw new InvalidValue(`no zone ${n}`);
    const modes = parseModeList(text);
    // RSS deletes a zone with no modes on save
    if (!modes.length) throw new InvalidValue("a zone needs at least one mode (RSS deletes empty zones)");
    const bad = modes.filter((m) => m > cp.modes.length || m > z.memb_w * 8);
    if (bad.length) throw new InvalidValue(`no mode ${bad.join(", ")} (this codeplug has ${cp.modes.length})`);
    z.modes = modes;
}
