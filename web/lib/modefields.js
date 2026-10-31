// @ts-check
/**
 * The per-mode fields the app edits: what kind of value each is, its
 * choices, which band has it, and `setModeField`, which every edit goes
 * through.
 *
 * `setModeField` doesn't trust the typed value: it writes the edited mode into
 * a scratch copy of the codeplug with the real encoder and decodes it back.
 * A frequency the codec can't hold exactly is stored as the nearest one it
 * can (and the caller is told); anything that would read back differently is
 * refused with a reason, so export never meets a value it can't write.
 */
import { InvalidValue } from "./errors.js";
import { readModeBack, uhfStep, vhfRxStep } from "./codeplug.js";
import { writeMode } from "./rebuild.js";
import { CTCSS_TONES, DPL_CODES } from "./tones.js";

/** @typedef {import("./codeplug.js").Mode} Mode */
/** @typedef {import("./codeplug.js").Codeplug} Codeplug */
/** @typedef {"name" | "mhz" | "squelch" | "choice"} FieldKind */
/**
 * @typedef {{
 *   key: string, label: string, kind: FieldKind,
 *   choices?: readonly string[],
 *   bands?: readonly string[],
 *   slot?: "rx" | "tx" | "ta",
 *   needs?: "tx_mhz" | "ta_mhz",
 * }} ModeField
 *   `slot`: the squelch slot a "squelch" field edits (type and code together).
 *   `needs`: shown only when the mode has that frequency (power settings).
 */

const EN = /** @type {const} */ (["Enabled", "Disabled"]);
export const SQUELCH_TYPES = /** @type {const} */ (["Carrier", "PL", "DPL", "INV.DPL"]);

/** @type {ModeField[]} */
export const MODE_FIELDS = [
    { key: "name", label: "Name", kind: "name" },
    { key: "rx_mhz", label: "Rx MHz", kind: "mhz" },
    { key: "tx_mhz", label: "Tx MHz", kind: "mhz" },
    { key: "ta_mhz", label: "T/A MHz", kind: "mhz" },
    { key: "rx_squelch", label: "Rx squelch", kind: "squelch", slot: "rx" },
    { key: "tx_squelch", label: "Tx squelch", kind: "squelch", slot: "tx" },
    { key: "ta_squelch", label: "T/A squelch", kind: "squelch", slot: "ta" },
    { key: "tx_power", label: "Tx power", kind: "choice", choices: ["High", "Low"], needs: "tx_mhz" },
    { key: "ta_power", label: "T/A power", kind: "choice", choices: ["High", "Low"], needs: "ta_mhz" },
    { key: "mpl_type", label: "MPL type", kind: "choice", choices: ["Disabled", "TX Only", "RX Only", "RX & TX"] },
    { key: "up_xtal_shift", label: "uP Xtal shift", kind: "choice", choices: EN },
    { key: "mdc_ptt_id", label: "MDC PTT ID", kind: "choice", choices: EN },
    { key: "phone_encode", label: "Phone encode", kind: "choice", choices: EN },
    { key: "audio_compander", label: "Audio compander", kind: "choice", choices: EN, bands: ["900"] },
    { key: "adaptive_splatter", label: "Adaptive splatter", kind: "choice", choices: EN, bands: ["900"] },
    { key: "reverse_burst_toc", label: "Reverse burst/TOC", kind: "choice", choices: EN, bands: ["900"] },
    { key: "unmute_mute_type", label: "Unmute/mute", kind: "choice", choices: ["Std/Std", "Std/OR", "AND/Std", "AND/OR"], bands: ["900"] },
];
export const MODE_FIELD_BY_KEY = new Map(MODE_FIELDS.map((f) => [f.key, f]));

/** Every squelch setting a slot can take, as shown: "Carrier", "PL 100.0", "DPL D411", "INV.DPL D411". */
export const SQUELCH_CHOICES = [
    "Carrier",
    ...CTCSS_TONES.map((t) => `PL ${t.toFixed(1)}`),
    ...DPL_CODES.map((c) => `DPL ${c}`),
    ...DPL_CODES.map((c) => `INV.DPL ${c}`),
];

/** A slot's setting as shown ("PL 100.0"), or "" if it isn't a tone motreader decodes. */
export function squelchText(/** @type {Mode} */ m, /** @type {"rx" | "tx" | "ta"} */ slot) {
    const type = m[`${slot}_squelch_type`];
    const code = m[`${slot}_pl`];
    return type === null ? "" : code ? `${type} ${code}` : type;
}

/** The value of field `key` of mode `m` as shown and edited (text). */
export function fieldText(/** @type {Mode} */ m, /** @type {string} */ key) {
    const f = MODE_FIELD_BY_KEY.get(key);
    if (!f) throw new Error(`no mode field ${key}`);
    if (f.kind === "squelch") return squelchText(m, /** @type {"rx" | "tx" | "ta"} */ (f.slot));
    const v = /** @type {any} */ (m)[key];
    if (v === null || v === undefined) return "";
    return f.kind === "mhz" ? Number(v).toFixed(5) : String(v);
}

/** Is a trunked mode 1 (not a conventional record; not editable here)? */
export const isTrunkedMode = (/** @type {Codeplug} */ cp, /** @type {Mode} */ m) => cp.trunked_mode1 && m.number === 1;

/** Does field `f` apply to mode `m` of `cp` (band, and power only with its frequency)? */
export function applies(/** @type {Codeplug} */ cp, /** @type {Mode} */ m, /** @type {ModeField} */ f) {
    if (f.bands && !f.bands.includes(cp.band)) return false;
    if (f.needs && m[f.needs] === null) return false;
    return true;
}

/**
 * Characters a name may use (owner's rule): A-Z, 0-9, space and
 * - + / = # * ` ) ( @ $ % \ _ (no periods). Lower case is turned into upper case.
 */
export const NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -+/=#*`)(@$%\\_";

/**
 * The longest name a mode (or zone) can have, and which characters it may
 * use. The 6-bit packed names of standard heads hold characters 0x20..0x5F,
 * so the backtick (0x60) fits only on the A9 head's ASCII names.
 */
export function nameRule(/** @type {Codeplug} */ cp, width = cp.ascii_names ? cp.ascii_names[1] : 8) {
    const chars = cp.ascii_names ? NAME_CHARS : NAME_CHARS.replace("`", "");
    return {
        width,
        chars,
        /** The name as stored (upper case, trailing spaces dropped), or throws. */
        check(/** @type {string} */ text) {
            const name = text.toUpperCase().replace(/\s+$/, "");
            if (name.length > width) throw new InvalidValue(`a name holds at most ${width} characters`);
            const bad = [...new Set([...name].filter((c) => !chars.includes(c)))];
            if (bad.length) {
                throw new InvalidValue(`a name can't use ${bad.map((c) => (c === " " ? "space" : `"${c}"`)).join(" ")}`
                    + (bad.includes("`") ? " (the backtick only fits on the A9 head's names)" : "")
                    + ": use A-Z, 0-9, space and - + / = # * ) ( @ $ % \\ _");
            }
            return name;
        },
    };
}

/**
 * Parse the text typed for a field into the mode's value(s).
 * @param {Codeplug} cp @param {ModeField} f @param {string} text
 * @returns {Partial<Mode>}
 */
function parse(cp, f, text) {
    const t = text.trim();
    switch (f.kind) {
        case "name":
            return { name: nameRule(cp).check(text) };
        case "mhz": {
            if (t === "") return { [f.key]: null };
            if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) throw new InvalidValue(`"${text}" is not a frequency in MHz`);
            return { [f.key]: Number(t) };
        }
        case "squelch": {
            const [type, code = null] = t.split(/\s+/);
            const st = SQUELCH_TYPES.find((x) => x.toLowerCase() === (type ?? "").toLowerCase());
            if (!st) throw new InvalidValue(`"${text}" is not a squelch setting (Carrier, PL 100.0, DPL D411, INV.DPL D411)`);
            if (st === "Carrier" && code) throw new InvalidValue("Carrier squelch has no code");
            if (st !== "Carrier" && !code) throw new InvalidValue(`${st} needs a code`);
            const c = st === "PL" ? Number(code).toFixed(1) : st === "Carrier" ? null : String(code).toUpperCase();
            if (st === "PL" && !Number.isFinite(Number(code))) throw new InvalidValue(`"${code}" is not a PL tone`);
            if ((st === "DPL" || st === "INV.DPL") && !DPL_CODES.includes(/** @type {string} */ (c))) {
                throw new InvalidValue(`"${code}" is not a DPL code (D023 ... D754)`);
            }
            return { [`${f.slot}_squelch_type`]: st, [`${f.slot}_pl`]: c };
        }
        case "choice": {
            const c = /** @type {readonly string[]} */ (f.choices).find((x) => x.toLowerCase() === t.toLowerCase());
            if (!c) throw new InvalidValue(`expected ${/** @type {readonly string[]} */ (f.choices).join(" or ")}`);
            return { [f.key]: c };
        }
    }
}

/**
 * Set field `key` of mode number `n` from typed text. Returns a note when the
 * value was adjusted (a frequency stored as the nearest one the codec holds);
 * throws InvalidValue if it can't be stored.
 * @param {Codeplug} cp @param {number} n @param {string} key @param {string} text
 * @returns {{ note: string | null }}
 */
export function setModeField(cp, n, key, text) {
    const m = cp.modes[n - 1];
    const f = MODE_FIELD_BY_KEY.get(key);
    if (!m || !f) throw new InvalidValue(`no mode ${n} field ${key}`);
    if (isTrunkedMode(cp, m)) throw new InvalidValue("mode 1 is the trunked mode: motreader doesn't edit it");
    if (cp.band === "900?") throw new InvalidValue("this codeplug's 900 MHz mode layout isn't recognised, so its modes can't be edited");
    if (!applies(cp, m, f)) throw new InvalidValue(`${f.label} doesn't apply to this mode`);
    const want = parse(cp, f, text);
    if (f.kind === "mhz" && want[/** @type {keyof Mode} */ (key)] === null) {
        // VHF: a blank TX / T·A makes an RX-only mode (NOAA weather), stored as RSS does
        const blankOk = (key === "ta_mhz" && cp.band === "900" && m.ta_mhz !== null && m.tx_mhz !== null)
            || (key !== "rx_mhz" && cp.band === "vhf");
        if (m[/** @type {"rx_mhz"} */ (key)] !== null && !blankOk) {
            throw new InvalidValue(key === "rx_mhz" ? "a mode needs a receive frequency"
                : "clearing this frequency (an RX-only mode) is supported on VHF only so far");
        }
    }

    if (cp.band === "uhf" && f.kind === "mhz" && want[/** @type {"rx_mhz"} */ (key)] !== null
        && uhfStep(/** @type {number} */ (want[/** @type {"rx_mhz"} */ (key)])) === null) {
        throw new InvalidValue(`${text} MHz isn't on a 6.25 or 5 kHz raster, which UHF frequencies use`);
    }
    if (cp.band === "vhf" && key === "rx_mhz" && want.rx_mhz !== null && vhfRxStep(/** @type {number} */ (want.rx_mhz)) === null) {
        throw new InvalidValue(`${text} MHz isn't on a 5 or 6.25 kHz raster, which VHF receive frequencies use`);
    }
    const lowAbove = cp.band === "uhf" ? cp.uhf_range?.lowPowerAbove ?? null : null;
    if (lowAbove !== null && (key === "tx_power" || key === "ta_power") && want[key] === "High"
        && /** @type {number} */ (m[key === "tx_power" ? "tx_mhz" : "ta_mhz"]) > lowAbove) {
        throw new InvalidValue(`RSS allows only Low power above ${lowAbove} MHz`);
    }
    if (key === "ta_mhz" && cp.band === "900" && m.ta_mhz === null && want.ta_mhz !== null) {
        throw new InvalidValue("adding a talk-around frequency to a simplex 900 MHz mode isn't supported yet");
    }

    // try it: write the edited mode into a scratch copy and decode it back
    const trial = /** @type {Mode} */ ({ ...m, ...want });
    const out = new Uint8Array(cp.body);
    writeMode(cp, out, trial);
    const back = readModeBack(cp, out, trial);
    /** @type {string | null} */
    let note = null;
    if (f.kind === "mhz") {
        const asked = /** @type {number | null} */ (want[/** @type {keyof Mode} */ (key)]);
        // with T/A cleared on 900 MHz the mode turns simplex: TX moves into the T/A field
        const got = back[/** @type {"rx_mhz"} */ (key)];
        if (asked !== null && got === null) {
            throw new InvalidValue(`${asked} MHz can't be stored in this field`
                + (cp.band === "900" ? " (900 MHz modes read 895–942 MHz)" : ""));
        }
        if (asked !== null && got !== null && Math.abs(got - asked) > 0.00005) {
            // on the field's raster but not stored as asked: the synthesizer bytes can't hold it
            const step = cp.band === "vhf" ? (key === "rx_mhz" ? 0.005 : 0.0025) : cp.band === "uhf" ? 0.005 : 0.0125;
            const onRaster = Math.abs(asked / step - Math.round(asked / step)) < 1e-6;
            if (onRaster || Math.abs(got - asked) > 0.01) {
                throw new InvalidValue(`${asked} MHz can't be stored in this field: the radio's synthesizer `
                    + `can't be set to it${cp.band === "vhf" ? " (RSS itself stores a wrong frequency for it)" : ""}; `
                    + `the nearest it holds is ${got.toFixed(5)} MHz`);
            }
            note = `stored as ${got.toFixed(5)} MHz, the nearest the radio holds`;
        }
        // RSS's own entry range is information, not a limit: motreader stores what the codec holds
        const rss = cp.band === "uhf" ? cp.uhf_range?.rss : undefined;
        if (rss && got !== null && (got < rss[0] || got > rss[1])) {
            note = `${note ? `${note}; ` : ""}outside the ${rss[0]}–${rss[1]} MHz RSS accepts for this radio `
                + "(RSS would refuse to enter it; the radio may need retuning)";
        }
        /** @type {any} */ (want)[key] = got;
        // other frequencies must read back unchanged (e.g. 900 MHz simplex <-> repeater)
        for (const k of /** @type {const} */ (["rx_mhz", "tx_mhz", "ta_mhz"])) {
            if (k !== key && back[k] !== trial[k]) {
                throw new InvalidValue(`that would change ${MODE_FIELD_BY_KEY.get(k)?.label} (reads back ${back[k] ?? "blank"})`);
            }
        }
    } else if (f.kind === "squelch") {
        const s = /** @type {"rx" | "tx" | "ta"} */ (f.slot);
        if (squelchText(back, s) !== squelchText(trial, s)) {
            throw new InvalidValue(`${text} can't be stored in this slot (reads back "${squelchText(back, s)}")`);
        }
    } else if (f.kind === "choice") {
        if (back[/** @type {"mpl_type"} */ (key)] !== trial[/** @type {"mpl_type"} */ (key)]) {
            throw new InvalidValue(`${text} can't be stored (reads back ${back[/** @type {"mpl_type"} */ (key)]})`);
        }
    }
    Object.assign(m, want);
    // a power setting appears with its frequency
    if (key === "tx_mhz") m.tx_power = m.tx_mhz === null ? null : m.tx_power ?? back.tx_power;
    if (key === "ta_mhz") m.ta_power = m.ta_mhz === null ? null : m.ta_power ?? back.ta_power;
    // UHF above the range's power limit: RSS (and the encoder) force power Low
    if (cp.band === "uhf" && key === "tx_mhz" && back.tx_power === "Low") m.tx_power = "Low";
    if (cp.band === "uhf" && key === "ta_mhz" && back.ta_power === "Low") m.ta_power = "Low";
    return { note };
}
