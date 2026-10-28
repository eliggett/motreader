// @ts-check
/**
 * Radio-wide (non-per-mode) settings: the RSS RADIO-WIDE and CONVENTIONAL
 * screens (FORMAT §5f). Port of motreader/radiowide.py; decode only so far.
 *
 * Fields live in three areas:
 *  - `hdr`: the fixed codeplug header (absolute body offsets);
 *  - `ext`: the radio-wide extension section, a block whose byte 0 is its
 *    length L and whose byte L-1 is the 8-bit sum of the rest, found by
 *    signature (`findExtBlock`);
 *  - `chb`: the control-head/accessory block, found by signature and the sum
 *    of [+0x1E, +0x11E) stored at +0x11E (`findChbBlock`).
 *
 * `FIELDS` is the schema: one entry per setting, in RSS screen order, with
 * its location, how it is stored and when RSS shows it.
 */
import { InvalidValue } from "./errors.js";

/** @typedef {"hdr" | "ext" | "chb"} Area */
/**
 * kind: "bit" | "nibble" (low) | "hinibble" | "byte" | "bcd" | "bcdf" (BCD
 * digits ended by 0xF nibbles) | "busywait" | "enum" (`(byte >> bit) & mask`
 * indexes `choices`) | "word" (big-endian 16-bit) | "dial" (DTMF digits in the
 * nibbles `nibs`) | "siren" | "rearm" | "headtype" (multi-bit decodes).
 * @typedef {{
 *   key: string, area: Area, off: number, kind: string,
 *   bit?: number, invert?: boolean, width?: number, scale?: number,
 *   editable?: boolean, note?: string,
 *   mirrors?: [Area, number, number][],
 *   bands?: string[], mask?: number, choices?: string[],
 *   nibs?: [Area, number, boolean][], rjust?: boolean,
 *   when?: [string, string[]],
 *   extMin?: number,
 * }} Field
 */

export const EN = /** @type {const} */ (["Disabled", "Enabled"]);
/** MDC channel busy wait: 0x1C2 = half-seconds; 0x1B9 bit 0 SET = Infinite. */
const BUSY_FLAG = /** @type {const} */ ([0x1B9, 0]);

const revertChoices = Array.from({ length: 0x22 }, (_, i) =>
    ({ 0: "Selected", 1: "Active", 0x20: "Home" })[i] ?? `?0x${i.toString(16)}`);

/** @type {Field[]} */
export const FIELDS = [
    // --- RADIO-WIDE CONFIGURATION (F4 -> F2) ---
    { key: "zone_operation", area: "chb", off: 0x13, kind: "bit", bit: 4, editable: false,
        note: "changing it re-packs the codeplug" },
    { key: "home_zone", area: "hdr", off: 0x1DD, kind: "byte", note: "0 when the radio has no zones" },
    { key: "max_systems", area: "hdr", off: 0x1D6, kind: "byte", editable: false,
        note: "trunking (TRUNKED DUAL MODE models); 0 after remove-trunking" },
    { key: "max_subfleets", area: "hdr", off: 0x1D7, kind: "byte", editable: false },
    { key: "home_mode", area: "hdr", off: 0x10F, kind: "byte" },
    { key: "mode_names", area: "hdr", off: 0x0E3, kind: "bit", bit: 4, mirrors: [["hdr", 0x10B, 7]] },
    { key: "time_out_timer", area: "hdr", off: 0x0E3, kind: "bit", bit: 3 },
    { key: "hub_switch", area: "hdr", off: 0x105, kind: "bit", bit: 7 },
    { key: "max_user_modes", area: "hdr", off: 0x109, kind: "byte", editable: false,
        note: "number of modes in the codeplug; change via the mode list" },
    { key: "minimum_volume", area: "hdr", off: 0x10B, kind: "nibble" },
    { key: "speaker_b_min_volume", area: "ext", off: 0x6A, kind: "byte" },
    { key: "positional_zones", area: "ext", off: 0x04, kind: "bit", bit: 0 },
    // --- RADIO-WIDE CONFIGURATION OPTIONS (F4 -> F2 -> F9) ---
    { key: "volume_set_tone", area: "hdr", off: 0x10E, kind: "bit", bit: 4 },
    { key: "mode_change_tone", area: "hdr", off: 0x10E, kind: "bit", bit: 0 },
    { key: "ptt_on_rx_only_mode", area: "hdr", off: 0x10E, kind: "bit", bit: 3 },
    { key: "ptt_ignition_sense", area: "hdr", off: 0x105, kind: "bit", bit: 2 },
    { key: "subsequent_call_alert", area: "ext", off: 0x02, kind: "bit", bit: 4, invert: true },
    { key: "horn_time_out_s", area: "ext", off: 0x0A, kind: "byte" },
    { key: "lights_time_out_s", area: "ext", off: 0x0B, kind: "byte" },
    { key: "speaker_b_vip_number", area: "ext", off: 0x6B, kind: "byte" },
    { key: "master_adaptive_splatter", area: "hdr", off: 0x0E3, kind: "bit", bit: 2, bands: ["900"] },
    { key: "master_audio_compandor", area: "hdr", off: 0x0E3, kind: "bit", bit: 1, bands: ["900"] },
    // --- SCAN CONFIGURATION OPTIONS (F4 -> F2 -> F6) ---
    { key: "scan_priority1_activity_tone", area: "hdr", off: 0x10E, kind: "bit", bit: 2, mirrors: [["ext", 0x03, 3]] },
    { key: "scan_priority2_activity_tone", area: "hdr", off: 0x10E, kind: "bit", bit: 1, mirrors: [["ext", 0x03, 2]] },
    { key: "scan_nuisance_delete", area: "hdr", off: 0x105, kind: "bit", bit: 4, mirrors: [["ext", 0x03, 0]] },
    { key: "scan_off_hub", area: "hdr", off: 0x105, kind: "bit", bit: 6, invert: true },
    { key: "scan_lookback_cycle_count", area: "ext", off: 0x24, kind: "byte" },
    { key: "scan_conv_rx_hang_time_ms", area: "hdr", off: 0x111, kind: "byte", scale: 250 },
    { key: "scan_conv_tx_hang_time_ms", area: "hdr", off: 0x112, kind: "byte", scale: 250 },
    // 0x105 b0 = Active, b5 = Home, neither = Selected; only with Scan Off HUB disabled
    { key: "scan_tx_revert_mode", area: "hdr", off: 0x105, kind: "enum", bit: 0, mask: 0x21,
        choices: revertChoices, when: ["scan_off_hub", ["Enabled"]] },
    { key: "scan_dynamic_priority_assignment", area: "hdr", off: 0x105, kind: "bit", bit: 3, mirrors: [["ext", 0x03, 1]] },
    // --- CONVENTIONAL CONFIGURATION (F4 -> F3) ---
    { key: "mdc_unit_id", area: "hdr", off: 0x1B3, kind: "bcd", width: 2 },
    { key: "mdc_group_id", area: "hdr", off: 0x1B5, kind: "bcd", width: 1 },
    { key: "mdc_fleet_id", area: "hdr", off: 0x1B7, kind: "hinibble" },
    // --- CONTROL HEAD OPTIONS (F4 -> F6 -> F9) ---
    { key: "ch_default_backlight", area: "ext", off: 0x6C, kind: "bit", bit: 2 },
    { key: "ch_default_dim", area: "ext", off: 0x6C, kind: "enum", bit: 0, mask: 3, choices: ["Off", "Low", "Medium", "High"] },
    { key: "ch_low_backlight", area: "ext", off: 0x6C, kind: "bit", bit: 6 },
    { key: "ch_medium_backlight", area: "ext", off: 0x6C, kind: "bit", bit: 5 },
    { key: "ch_high_backlight", area: "ext", off: 0x6C, kind: "bit", bit: 4 },
    // --- DTMF SIGNALLING OPTIONS (F4 -> F3 -> F2); 5 ms units ---
    { key: "dtmf_individual_id", area: "ext", off: 0x2F, kind: "bcdf", width: 3 },
    { key: "dtmf_end_of_callback", area: "ext", off: 0x32, kind: "bit", bit: 2, invert: true },
    { key: "dtmf_digit_time_ms", area: "ext", off: 0x33, kind: "byte", scale: 5 },
    { key: "dtmf_interdigit_time_ms", area: "ext", off: 0x34, kind: "byte", scale: 5 },
    { key: "dtmf_system_delay_ms", area: "ext", off: 0x36, kind: "byte", scale: 5 },
    { key: "mdc_signalling", area: "hdr", off: 0x0E4, kind: "bit", bit: 5, editable: false,
        note: "RSS also rewrites per-mode MDC bits when this changes" },
    { key: "emergency", area: "hdr", off: 0x1B9, kind: "bit", bit: 4 },
    // --- MDC SIGNALLING OPTIONS (F4 -> F3 -> F3) ---
    { key: "mdc_signalling_type_1200", area: "hdr", off: 0x1B8, kind: "bit", bit: 7, note: "Enabled = 1200 baud, Disabled = 600" },
    { key: "mdc_system_delay_ms", area: "hdr", off: 0x1B7, kind: "nibble", scale: 100 },
    { key: "mdc_ptt_id_beginning", area: "hdr", off: 0x1B8, kind: "bit", bit: 4 },
    { key: "mdc_ptt_id_ending", area: "hdr", off: 0x1B8, kind: "bit", bit: 3 },
    { key: "mdc_sidetone", area: "hdr", off: 0x1B8, kind: "bit", bit: 1 },
    { key: "mdc_preamble", area: "hdr", off: 0x1D2, kind: "bit", bit: 5 },
    { key: "mdc_channel_busy_wait_s", area: "hdr", off: 0x1C2, kind: "busywait", note: "'Infinite' or seconds in 0.5 s steps" },
    { key: "number_of_mpl", area: "hdr", off: 0x119, kind: "byte", editable: false,
        note: "resizes the MPL table (moves sections); not template-patchable" },
    // --- PHONE LIST OPTIONS (F4 -> F3 -> F7 -> F9; conventional only). The
    // 5-digit codes are split: 4 nibbles in the header + 1 in ext+0x45 ---
    { key: "phone_access_code", area: "hdr", off: 0x174, kind: "dial", width: 2, rjust: true,
        nibs: [["hdr", 0x174, true], ["hdr", 0x174, false], ["hdr", 0x175, true], ["hdr", 0x175, false], ["ext", 0x45, true]] },
    { key: "phone_release_code", area: "hdr", off: 0x176, kind: "dial", width: 2,
        nibs: [["ext", 0x45, false], ["hdr", 0x176, true], ["hdr", 0x176, false], ["hdr", 0x177, true], ["hdr", 0x177, false]] },
    { key: "phone_digit_time_ms", area: "hdr", off: 0x178, kind: "byte", scale: 5 },
    { key: "phone_interdigit_time_ms", area: "hdr", off: 0x1CA, kind: "byte", scale: 5 },
    { key: "phone_system_delay_ms", area: "hdr", off: 0x179, kind: "word", width: 2, scale: 5 },
    // --- RADIO-WIDE OPTIONS: accessory feature enables (CHB +0x12..+0x1A) ---
    { key: "siren_pa_options", area: "hdr", off: 0x17C, kind: "siren", note: "Disabled / PA only / Siren/PA" },
    { key: "horn_lights_rearm", area: "chb", off: 0x18, kind: "rearm", note: "Disabled / Enabled / Permanent" },
    // Vehicle Repeater, SECURENET and trunking are deliberately not exposed
    // (owner's choice): their bytes are preserved verbatim.
    { key: "phone_dtmf_encode", area: "hdr", off: 0x10D, kind: "enum", bit: 6, mask: 1, choices: ["List", "Unlimited"],
        editable: false, note: "derived by RSS: List with a Rotary head, else the model default" },
    { key: "control_head_type", area: "hdr", off: 0x10D, kind: "headtype",
        note: "Standard / Enhanced / Rotary editable; S9000e (A9 head) is fixed" },
    { key: "internal_pa", area: "chb", off: 0x17, kind: "bit", bit: 3, note: "RSS shows 'Not Avail' on some models (604AUN)" },
    { key: "speaker_a_b", area: "chb", off: 0x17, kind: "bit", bit: 4, note: "RSS shows 'Not Avail' on some models (604AUN)" },
    // --- SIREN / PUBLIC ADDRESS (F4 -> F2 -> F9 -> F6) ---
    { key: "pa_option_audio_routing", area: "chb", off: 0x5F, kind: "bit", bit: 6, invert: true, when: ["siren_pa_options", ["Disabled"]] },
    { key: "pa_ignition_sense", area: "chb", off: 0x5E, kind: "bit", bit: 2, when: ["siren_pa_options", ["Disabled"]] },
    { key: "pa_ex_rd_ignition_sense", area: "chb", off: 0x5E, kind: "bit", bit: 1, when: ["siren_pa_options", ["Disabled"]] },
    { key: "pa_default_volume", area: "chb", off: 0x5F, kind: "nibble", when: ["siren_pa_options", ["Disabled"]] },
    { key: "siren_pa_after_reset", area: "chb", off: 0x5F, kind: "enum", bit: 4, mask: 1, choices: ["Last State", "Off"],
        when: ["siren_pa_options", ["Disabled"]] },
    { key: "siren_hilo_airhorn_tones", area: "chb", off: 0x5F, kind: "bit", bit: 5, invert: true,
        when: ["siren_pa_options", ["Disabled", "PA only"]] },
    { key: "siren_manual_tone", area: "chb", off: 0x5E, kind: "enum", bit: 3, mask: 7,
        choices: ["?0", "Wail", "Yelp", "?3", "Airhorn", "?5", "?6", "?7"], when: ["siren_pa_options", ["Disabled", "PA only"]] },
    { key: "siren_ignition_sense", area: "chb", off: 0x5E, kind: "bit", bit: 0, when: ["siren_pa_options", ["Disabled", "PA only"]] },
    // --- ADDITIONAL RADIO WIDE OPTIONS (F4 -> F2 -> F9 -> F7): only on 604AUN,
    // the one radio with the longer ext section (L=0x95); provisional gate ---
    { key: "tx_mic_input_control", area: "ext", off: 0x74, kind: "enum", bit: 4, mask: 1, choices: ["Voltage", "Current"], extMin: 0x95 },
    { key: "filtered_audio_thru_rear", area: "ext", off: 0x74, kind: "bit", bit: 5, extMin: 0x95 },
    { key: "mic_gain", area: "ext", off: 0x74, kind: "bit", bit: 7, extMin: 0x95 },
];

/** @type {Map<string, Field>} */
export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export const sum8 = (/** @type {Uint8Array} */ b, /** @type {number} */ from, /** @type {number} */ to) => {
    let s = 0;
    for (let i = from; i < to; i++) s += /** @type {number} */ (b[i]);
    return s & 0xFF;
};
const byte = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => /** @type {number} */ (b[o]);

/**
 * Offset of the radio-wide extension section, or null. Signature: byte 0 =
 * length L (0x80..0xC0), byte L-1 = 8-bit sum of [0, L-1), bytes 5,6 = 0 and
 * byte 7 = the mode count (header 0x109). Byte 8 usually repeats it but not
 * always (8 with 7 modes in a 604AUN backup; 5 and 4 on all-trunked radios).
 */
export function findExtBlock(/** @type {Uint8Array} */ body) {
    if (body.length <= 0x109) return null;
    const n = byte(body, 0x109);
    for (let k = 0x1E8; k < body.length - 0x80; k++) {
        const L = byte(body, k);
        if (L < 0x80 || L > 0xC0 || k + L > body.length) continue;
        if (body[k + 5] || body[k + 6] || body[k + 7] !== n) continue;
        if (sum8(body, k, k + L - 1) === body[k + L - 1]) return k;
    }
    return null;
}

export const CHB_CK = 0x11E;
export const CHB_SUM_LO = 0x1E;

/**
 * Offset of the control-head/accessory block, or null: bytes +0x66..+0x68 =
 * 04 80 00 and the sum of [+0x1E, +0x11E) at +0x11E. Must be unique.
 */
export function findChbBlock(/** @type {Uint8Array} */ body) {
    const hits = [];
    for (let p = 0x1E8; p < body.length - CHB_CK; p++) {
        if (body[p + 0x66] === 0x04 && body[p + 0x67] === 0x80 && body[p + 0x68] === 0x00
            && sum8(body, p + CHB_SUM_LO, p + CHB_CK) === body[p + CHB_CK]) hits.push(p);
    }
    return hits.length === 1 ? /** @type {number} */ (hits[0]) : null;
}

/** @typedef {{ hdr: number, ext: number | null, chb: number | null }} Blocks */

/** Where the three areas start in this body. */
export function blocks(/** @type {Uint8Array} */ body) {
    /** @type {Blocks} */
    const b = { hdr: 0, ext: findExtBlock(body), chb: findChbBlock(body) };
    return b;
}

/** Body offset of (`area`, `off`), or null if the area wasn't found. */
function loc(/** @type {Area} */ area, /** @type {number} */ off, /** @type {Blocks} */ blk) {
    const base = blk[area];
    return base === null ? null : base + off;
}

const DIAL_CHARS = "0123456789*#P";

/** DTMF nibbles -> dial string; 0xF (or any unknown code) is a space. */
export function dialDecode(/** @type {number[]} */ nibs) {
    return nibs.map((n) => (n < DIAL_CHARS.length ? DIAL_CHARS[n] : " ")).join("");
}

const nib = (/** @type {Uint8Array} */ b, /** @type {number} */ a, /** @type {boolean} */ hi) => (hi ? byte(b, a) >> 4 : byte(b, a) & 0xF);
const hex2 = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** @typedef {Record<string, string | number | null>} RadioWide */

/**
 * Every field present (and applicable to `band`, when given), in RSS wording:
 * booleans "Enabled"/"Disabled", numbers as numbers, BCD IDs as strings.
 * @param {Uint8Array} body
 * @param {string | null} [band]
 */
export function decode(body, band = null) {
    const blk = blocks(body);
    /** @type {RadioWide} */
    const out = {};
    for (const f of FIELDS) {
        const a = loc(f.area, f.off, blk);
        const width = f.width ?? 1;
        if (a === null || a + width > body.length) continue;
        if (f.area === "ext") {
            const L = byte(body, /** @type {number} */ (blk.ext));
            if (f.off >= L - 1 || L < (f.extMin ?? 0)) continue;   // not in this model's (shorter) ext section
        }
        if (band !== null && f.bands && !f.bands.includes(band)) continue;
        if (f.when) {
            const gate = out[f.when[0]];
            if (typeof gate === "string" && f.when[1].includes(gate)) continue;   // RSS hides it
        }
        const v = byte(body, a);
        const scale = f.scale ?? 1;
        switch (f.kind) {
            case "bit":
                out[f.key] = EN[(((v >> (f.bit ?? 0)) & 1) ^ (f.invert ? 1 : 0))];
                break;
            case "nibble":
                out[f.key] = (v & 0x0F) * scale;
                break;
            case "enum":
                out[f.key] = /** @type {string[]} */ (f.choices)[(v >> (f.bit ?? 0)) & /** @type {number} */ (f.mask)] ?? null;
                break;
            case "busywait":
                out[f.key] = (byte(body, BUSY_FLAG[0]) >> BUSY_FLAG[1]) & 1 ? "Infinite" : v / 2;
                break;
            case "hinibble":
                out[f.key] = v >> 4;
                break;
            case "byte":
                out[f.key] = v * scale;
                break;
            case "bcd": {
                const s = hex2(body.subarray(a, a + width));
                out[f.key] = /^\d+$/.test(s) ? s : null;
                break;
            }
            case "bcdf":
                out[f.key] = /** @type {string} */ (hex2(body.subarray(a, a + width)).split("f")[0]);
                break;
            case "word":
                out[f.key] = ((v << 8) | byte(body, a + 1)) * scale;
                break;
            case "siren": {
                const c = blk.chb;
                if (!((v >> 7) & 1)) out[f.key] = "Disabled";
                else if (c !== null) out[f.key] = (byte(body, c + 0x5F) >> 7) & 1 ? "PA only" : "Siren/PA";
                break;
            }
            case "headtype": {
                // 0x10D b5 clear = S9000e (A9); b4 = Rotary; else CHB+0x17 b1 = Enhanced / clear = Standard
                const c = blk.chb;
                if (!((v >> 5) & 1)) out[f.key] = "S9000e";
                else if ((v >> 4) & 1) out[f.key] = "Rotary";
                else if (c !== null) out[f.key] = (byte(body, c + 0x17) >> 1) & 1 ? "Enhanced" : "Standard";
                break;
            }
            case "rearm":
                out[f.key] = !(v & 1) ? "Disabled" : byte(body, a - 0x18 + 0x13) & 1 ? "Permanent" : "Enabled";
                break;
            case "dial": {
                const locs = (f.nibs ?? []).map(([ar, o, hi]) => /** @type {const} */ ([loc(ar, o, blk), hi]));
                if (locs.some(([x]) => x === null)) continue;
                out[f.key] = dialDecode(locs.map(([x, hi]) => nib(body, /** @type {number} */ (x), hi))).trim();
                break;
            }
            default:
                throw new Error(`unknown field kind ${f.kind}`);
        }
    }
    return out;
}

/**
 * How the fields are presented: the app tab, the RSS screen (as a heading)
 * and each field's label, in RSS order. Units are part of the label.
 * @typedef {{ tab: "radiowide" | "conventional" | "head", title: string, fields: [string, string][] }} Screen
 * @type {Screen[]}
 */
export const SCREENS = [
    { tab: "radiowide", title: "Radio-Wide Configuration", fields: [
        ["zone_operation", "Zone Operation"], ["home_zone", "Home Zone"], ["home_mode", "Home Mode"],
        ["max_user_modes", "Max User Modes"], ["max_systems", "Max Systems"], ["max_subfleets", "Max Subfleets"],
        ["mode_names", "Mode Names"], ["time_out_timer", "Time-Out Timer"], ["hub_switch", "HUB Switch"],
        ["minimum_volume", "Minimum Volume"], ["speaker_b_min_volume", "Speaker B Min Volume"],
        ["positional_zones", "Positional Zones"],
    ] },
    { tab: "radiowide", title: "Radio-Wide Configuration Options", fields: [
        ["volume_set_tone", "Volume Set Tone"], ["mode_change_tone", "Mode Change Tone"],
        ["ptt_on_rx_only_mode", "PTT on Rx-Only Mode"], ["ptt_ignition_sense", "PTT Ignition Sense"],
        ["subsequent_call_alert", "Subsequent Call Alert"], ["horn_time_out_s", "Horn Time-Out (s)"],
        ["lights_time_out_s", "Lights Time-Out (s)"], ["speaker_b_vip_number", "Speaker B VIP Number"],
        ["master_adaptive_splatter", "Master Adaptive Splatter"], ["master_audio_compandor", "Master Audio Compandor"],
    ] },
    { tab: "radiowide", title: "Radio-Wide Options", fields: [
        ["siren_pa_options", "Siren/P.A. Options"], ["horn_lights_rearm", "Horn & Lights Rearm"],
        ["internal_pa", "Internal P.A."], ["speaker_a_b", "Speaker A/B"], ["phone_dtmf_encode", "Phone DTMF Encode"],
    ] },
    { tab: "radiowide", title: "Siren / Public Address", fields: [
        ["pa_option_audio_routing", "P.A. Option Audio Routing"], ["pa_ignition_sense", "P.A. Ignition Sense"],
        ["pa_ex_rd_ignition_sense", "P.A. Ex-Rd Ignition Sense"], ["pa_default_volume", "P.A. Default Volume"],
        ["siren_pa_after_reset", "Siren/P.A. After Reset"], ["siren_hilo_airhorn_tones", "Siren Hi-Lo/Airhorn Tones"],
        ["siren_manual_tone", "Siren Manual Tone"], ["siren_ignition_sense", "Siren Ignition Sense"],
    ] },
    { tab: "radiowide", title: "Scan Configuration Options", fields: [
        ["scan_priority1_activity_tone", "Priority 1 Activity Tone"], ["scan_priority2_activity_tone", "Priority 2 Activity Tone"],
        ["scan_nuisance_delete", "Nuisance Delete"], ["scan_off_hub", "Scan Off HUB"],
        ["scan_lookback_cycle_count", "Lookback Cycle Count"],
        ["scan_conv_rx_hang_time_ms", "Conventional Rx Hang Time (ms)"], ["scan_conv_tx_hang_time_ms", "Conventional Tx Hang Time (ms)"],
        ["scan_tx_revert_mode", "Tx Revert Mode"], ["scan_dynamic_priority_assignment", "Dynamic Priority Assignment"],
    ] },
    { tab: "radiowide", title: "Additional Radio-Wide Options", fields: [
        ["tx_mic_input_control", "Tx Mic Input Control"], ["filtered_audio_thru_rear", "Filtered Audio Thru Rear"],
        ["mic_gain", "Mic Gain"],
    ] },
    { tab: "conventional", title: "Conventional Configuration", fields: [
        ["mdc_signalling", "MDC Signalling"], ["emergency", "Emergency"], ["number_of_mpl", "Number of MPL"],
        ["mdc_unit_id", "MDC Unit ID"], ["mdc_group_id", "MDC Group ID"], ["mdc_fleet_id", "MDC Fleet ID"],
    ] },
    { tab: "conventional", title: "MDC Signalling Options", fields: [
        ["mdc_signalling_type_1200", "1200 Baud Signalling"], ["mdc_system_delay_ms", "System Delay (ms)"],
        ["mdc_ptt_id_beginning", "PTT ID at Beginning"], ["mdc_ptt_id_ending", "PTT ID at End"],
        ["mdc_sidetone", "Sidetone"], ["mdc_preamble", "Preamble"], ["mdc_channel_busy_wait_s", "Channel Busy Wait (s)"],
    ] },
    { tab: "conventional", title: "DTMF Signalling Options", fields: [
        ["dtmf_individual_id", "Individual ID"], ["dtmf_end_of_callback", "End of Callback"],
        ["dtmf_digit_time_ms", "Digit Time (ms)"], ["dtmf_interdigit_time_ms", "Interdigit Time (ms)"],
        ["dtmf_system_delay_ms", "System Delay (ms)"],
    ] },
    { tab: "conventional", title: "Phone List Options", fields: [
        ["phone_access_code", "Access Code"], ["phone_release_code", "Release Code"],
        ["phone_digit_time_ms", "Digit Time (ms)"], ["phone_interdigit_time_ms", "Interdigit Time (ms)"],
        ["phone_system_delay_ms", "System Delay (ms)"],
    ] },
    { tab: "head", title: "Control Head Options", fields: [
        ["control_head_type", "Control Head Type"], ["ch_default_backlight", "Default Backlight"],
        ["ch_default_dim", "Default Dim"], ["ch_low_backlight", "Low Backlight"],
        ["ch_medium_backlight", "Medium Backlight"], ["ch_high_backlight", "High Backlight"],
    ] },
];

// ---------------------------------------------------------------------------
// Encoding (template-patch). Port of radiowide.encode and its helpers.

/** @param {Uint8Array} out @param {number} a @param {number} bit @param {boolean} v */
function setBit(out, a, bit, v) {
    out[a] = v ? byte(out, a) | (1 << bit) : byte(out, a) & (~(1 << bit) & 0xFF);
}
/** @param {Uint8Array} out @param {number} a @param {boolean} hi @param {number} n */
function setNib(out, a, hi, n) {
    out[a] = hi ? (byte(out, a) & 0x0F) | (n << 4) : (byte(out, a) & 0xF0) | n;
}

/** Python `float(v)` for the values a field can be given. */
function toFloat(/** @type {unknown} */ v) {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
    return null;
}
/** Python `int(v)`: integers, whole-number text, or a float (truncated). */
function toInt(/** @type {string} */ key, /** @type {unknown} */ v) {
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
    throw new InvalidValue(`radio_wide.${key}: expected a whole number, got ${JSON.stringify(v)}`);
}
/** Loose equality for edited values (numbers as numbers, else text ignoring case). */
function same(/** @type {unknown} */ a, /** @type {unknown} */ b) {
    const fa = toFloat(a);
    const fb = toFloat(b);
    if (fa !== null && fb !== null) return fa === fb;
    return String(a ?? "None").trim().toLowerCase() === String(b ?? "None").trim().toLowerCase();
}
/** Enabled/Disabled (and on/off, yes/no, true/false, 1/0). */
function parseBool(/** @type {string} */ key, /** @type {unknown} */ v) {
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (["enabled", "enable", "on", "yes", "true", "1"].includes(s)) return true;
    if (["disabled", "disable", "off", "no", "false", "0"].includes(s)) return false;
    throw new InvalidValue(`radio_wide.${key}: expected Enabled/Disabled, got ${JSON.stringify(v)}`);
}
/** The matching choice (ignoring case), or throw. */
function pick(/** @type {string} */ key, /** @type {readonly string[]} */ choices, /** @type {unknown} */ v) {
    const want = String(v).trim().toLowerCase();
    const c = choices.find((x) => x.toLowerCase() === want);
    if (c === undefined) throw new InvalidValue(`radio_wide.${key}: expected one of ${choices.join(", ")}, got ${JSON.stringify(v)}`);
    return c;
}

export const SIREN_CHOICES = /** @type {const} */ (["Disabled", "PA only", "Siren/PA"]);
export const REARM_CHOICES = /** @type {const} */ (["Disabled", "Enabled", "Permanent"]);
export const HEAD_CHOICES = /** @type {const} */ (["Standard", "Enhanced", "Rotary"]);

/**
 * How values are shown, where RSS's word alone isn't the clearest: the
 * control heads with their Motorola codes (RSS's "Standard" is the Basic
 * head). The stored and exported value stays RSS's word.
 * @type {Record<string, Record<string, string>>}
 */
export const VALUE_LABELS = {
    control_head_type: { Standard: "Basic (A5)", Enhanced: "Enhanced (A7)", Rotary: "Rotary (A4)", S9000e: "S9000e (A9)" },
};

/** `value` of field `key` as shown. */
export const valueLabel = (/** @type {string} */ key, /** @type {unknown} */ value) =>
    VALUE_LABELS[key]?.[String(value)] ?? String(value);
const CHB_W = 0x1C;

/**
 * CHB+0x1C/+0x1D = W, RSS's control-head summary word: the 16-bit sum S of
 * CHB bytes [+0x12, +0x1B), bit-interleaved MSB-first as s7 s15 s6 s14 ... s0 s8.
 */
export function chbSummaryWord(/** @type {Uint8Array} */ body, /** @type {number} */ c) {
    let s = 0;
    for (let i = c + 0x12; i < c + 0x1B; i++) s += byte(body, i);
    let acc = 0;
    for (let k = 0; k < 8; k++) acc = (acc << 2) | (((s >> (7 - k)) & 1) << 1) | ((s >> (15 - k)) & 1);
    return acc;
}

/** Siren/P.A. Options: hdr 0x17C b7, CHB+0x14 b2, CHB+0x5E b7, CHB+0x5F b7 (PA only). */
function encodeSiren(/** @type {Uint8Array} */ out, /** @type {Blocks} */ blk, /** @type {unknown} */ v) {
    const want = pick("siren_pa_options", SIREN_CHOICES, v);
    const c = blk.chb;
    if (c === null) throw new InvalidValue("radio_wide.siren_pa_options: control-head block not found");
    const isOn = want !== "Disabled";
    setBit(out, 0x17C, 7, isOn);
    setBit(out, c + 0x14, 2, isOn);
    setBit(out, c + 0x5E, 7, isOn);
    setBit(out, c + 0x5F, 7, want === "PA only");
}

/**
 * Control Head Type, as RSS does it: Enhanced/Rotary set 0x1CD b3 and CHB+0x17
 * b1, CHB+0x46 |= 0x0C and reset the options byte ext+0x6C to 0x63; Rotary
 * also sets 0x10D b4, forces Phone/DTMF Encode to List and turns Volume Set
 * Tone off (and Mode Change Tone, with no zones); leaving Rotary restores
 * Phone/DTMF Encode to the model default. S9000e (A9) can't be changed.
 */
function encodeHead(/** @type {Uint8Array} */ out, /** @type {Blocks} */ blk, /** @type {RadioWide} */ orig, /** @type {unknown} */ v) {
    const was = orig.control_head_type;
    if (!HEAD_CHOICES.includes(/** @type {any} */ (was)) || !HEAD_CHOICES.some((c) => c.toLowerCase() === String(v).trim().toLowerCase())) {
        throw new InvalidValue("radio_wide.control_head_type: only Basic (A5, RSS's Standard) / Enhanced (A7) / "
            + "Rotary (A4) can be swapped (RSS can't change to or from the S9000e (A9) head)");
    }
    const want = pick("control_head_type", HEAD_CHOICES, v);
    const { chb: c, ext: e } = blk;
    if (c === null || e === null) throw new InvalidValue("radio_wide.control_head_type: control-head/ext block not found");
    const fancy = want !== "Standard";
    setBit(out, 0x1CD, 3, fancy);
    setBit(out, c + 0x17, 1, fancy);
    if (fancy) {
        out[c + 0x46] = byte(out, c + 0x46) | 0x0C;
        out[e + 0x6C] = 0x63;
    }
    const rotary = want === "Rotary";
    setBit(out, 0x10D, 4, rotary);
    if (rotary) {
        setBit(out, 0x10D, 6, false);
        setBit(out, 0x10E, 4, false);
        if (byte(out, 0x1DD) === 0) setBit(out, 0x10E, 0, false);
    } else if (was === "Rotary") {
        setBit(out, 0x10D, 6, !((byte(out, 0x10D) >> 1) & 1));
    }
}

/** Recompute the derived bytes of every touched block: ext sum; CHB summary word, then CHB sum. */
export function finish(/** @type {Uint8Array} */ out, /** @type {Blocks} */ blk, /** @type {Set<string>} */ touched) {
    const { ext: e, chb: c } = blk;
    if (touched.has("ext") && e !== null) {
        const L = byte(out, e);
        out[e + L - 1] = sum8(out, e, e + L - 1);
    }
    if (touched.has("chb") && c !== null) {
        const w = chbSummaryWord(out, c);
        out[c + CHB_W] = w >> 8;
        out[c + CHB_W + 1] = w & 0xFF;
        out[c + CHB_CK] = sum8(out, c + CHB_SUM_LO, c + CHB_CK);
    }
    return out;
}

/** Fields whose value decides whether others are shown. */
const GATES = new Set(FIELDS.flatMap((f) => (f.when ? [f.when[0]] : [])));
const ORDER = /** @type {Record<string, number>} */ ({ control_head_type: 0, siren_pa_options: 1, scan_off_hub: 1 });

/**
 * Apply edited radio-wide values (key -> value, in RSS wording) to a copy of
 * `body`. Change-gated per field against the decoded original: unchanged or
 * absent values leave their bytes alone; a block's checksum is recomputed
 * only if one of its bytes changed. Throws `InvalidValue` for a bad value.
 * @param {Uint8Array} body
 * @param {Record<string, unknown>} values
 */
export function encode(body, values) {
    const out = new Uint8Array(body);
    let orig = decode(body);
    const blk = blocks(body);
    /** @type {Set<string>} */
    const touched = new Set();
    // the head type first, then Siren/P.A. Options (enabling it reveals the
    // siren settings, which may be edited in the same call)
    const items = Object.entries(values).sort(([a], [b]) => (ORDER[a] ?? 2) - (ORDER[b] ?? 2));
    const base = { ...orig };   // the template's values, before side effects
    for (const [key, v] of items) {
        const f = FIELD_BY_KEY.get(key);
        // only what changed vs the template is applied, so side effects of a
        // head-type / siren change stand unless those fields were edited too
        if (key in base && same(v, base[key]) && !(key in ORDER)) continue;
        if (!f || v === null || v === undefined || !(key in orig)) continue;
        const a = /** @type {number} */ (loc(f.area, f.off, blk));
        const width = f.width ?? 1;
        const scale = f.scale ?? 1;
        switch (f.kind) {
            case "bit": {
                const isOn = parseBool(key, v);
                if (EN[isOn ? 1 : 0] === orig[key]) continue;
                if (f.editable === false) throw new InvalidValue(`radio_wide.${key} is read-only`);
                setBit(out, a, f.bit ?? 0, isOn !== Boolean(f.invert));
                for (const [area, off, bit] of f.mirrors ?? []) {
                    const m = loc(area, off, blk);
                    if (m !== null) {
                        setBit(out, m, bit, isOn);
                        touched.add(area);
                    }
                }
                if (GATES.has(key)) orig = decode(finish(new Uint8Array(out), blk, new Set(touched)));
                break;
            }
            case "enum": {
                const want = String(v).trim();
                if (want === orig[key]) continue;
                const choices = /** @type {string[]} */ (f.choices);
                const n = choices.findIndex((c) => c.toLowerCase() === want.toLowerCase());
                if (n < 0) throw new InvalidValue(`radio_wide.${key}: expected one of ${choices.filter((c) => !c.startsWith("?")).join(", ")}, got ${JSON.stringify(v)}`);
                if (f.editable === false) throw new InvalidValue(`radio_wide.${key} is read-only`);
                if (want.startsWith("?")) throw new InvalidValue(`radio_wide.${key}: ${JSON.stringify(v)} is not a valid choice`);
                const mask = /** @type {number} */ (f.mask);
                const bit = f.bit ?? 0;
                out[a] = (byte(out, a) & (~(mask << bit) & 0xFF)) | (n << bit);
                break;
            }
            case "busywait": {
                const inf = String(v).trim().toLowerCase() === "infinite";
                const val = inf ? "Infinite" : toFloat(v);
                if (val === null) throw new InvalidValue(`radio_wide.${key}: expected seconds or Infinite, got ${JSON.stringify(v)}`);
                if (val === orig[key]) continue;
                setBit(out, BUSY_FLAG[0], BUSY_FLAG[1], inf);
                if (!inf) {
                    const half = /** @type {number} */ (val) * 2;
                    if (half !== Math.trunc(half) || !(half > 0 && half <= 0xFF)) throw new InvalidValue(`radio_wide.${key}: ${JSON.stringify(v)} not a 0.5 s step`);
                    out[a] = half;
                } else {
                    out[a] = 0;
                }
                break;
            }
            case "siren": {
                if (String(v).trim().toLowerCase() === String(orig[key]).toLowerCase()) continue;
                encodeSiren(out, blk, v);
                touched.add("chb");
                orig = decode(finish(out, blk, touched));   // reveals the siren settings
                continue;
            }
            case "rearm": {
                if (String(v).trim().toLowerCase() === String(orig[key]).toLowerCase()) continue;
                const want = pick(key, REARM_CHOICES, v);
                setBit(out, a, 0, want !== "Disabled");           // CHB+0x18 b0
                setBit(out, a - 0x18 + 0x13, 0, want === "Permanent");
                touched.add("chb");
                continue;
            }
            case "headtype": {
                if (String(v).trim().toLowerCase() === String(orig[key]).toLowerCase()) continue;
                encodeHead(out, blk, orig, v);
                touched.add("chb").add("ext");
                orig = decode(finish(out, blk, touched));
                continue;
            }
            case "dial": {
                const s = String(v).trim();
                if (s === orig[key]) continue;
                const nibs = f.nibs ?? [];
                const n = nibs.length;
                if (s.length > n || [...s].some((c) => !"0123456789*#".includes(c))) {
                    throw new InvalidValue(`radio_wide.${key}: expected up to ${n} of 0-9 * #, got ${JSON.stringify(v)}`);
                }
                const padded = f.rjust ? s.padStart(n) : s.padEnd(n);
                nibs.forEach(([ar, o, hi], i) => {
                    const c = /** @type {string} */ (padded[i]);
                    setNib(out, /** @type {number} */ (loc(ar, o, blk)), hi, c === " " ? 0xF : DIAL_CHARS.indexOf(c));
                    touched.add(ar);
                });
                break;
            }
            case "word": {
                const n = toInt(key, v);
                if (n === orig[key]) continue;
                if (n % scale || !(Math.floor(n / scale) >= 0 && Math.floor(n / scale) <= 0xFFFF)) {
                    throw new InvalidValue(`radio_wide.${key}: ${n} not a multiple of ${scale} in range`);
                }
                const w = Math.floor(n / scale);
                out[a] = w >> 8;
                out[a + 1] = w & 0xFF;
                break;
            }
            case "nibble":
            case "hinibble":
            case "byte": {
                let n = toInt(key, v);
                if (n === orig[key]) continue;
                if (n % scale) throw new InvalidValue(`radio_wide.${key}: ${n} is not a multiple of ${scale}`);
                n = Math.floor(n / scale);
                if (f.editable === false) throw new InvalidValue(`radio_wide.${key} is read-only`);
                const hi = f.kind === "byte" ? 0xFF : 0x0F;
                if (n < 0 || n > hi) throw new InvalidValue(`radio_wide.${key}: ${n} out of range 0..${hi}`);
                if (f.kind === "nibble") out[a] = (byte(out, a) & 0xF0) | n;
                else if (f.kind === "hinibble") out[a] = (byte(out, a) & 0x0F) | (n << 4);
                else out[a] = n;
                break;
            }
            case "bcd": {
                let s = String(v).trim();
                if (/^\d+$/.test(s)) s = s.padStart(2 * width, "0");
                if (s === orig[key]) continue;
                if (!(/^\d+$/.test(s) && s.length === 2 * width)) throw new InvalidValue(`radio_wide.${key}: expected ${2 * width} digits, got ${JSON.stringify(v)}`);
                for (let i = 0; i < width; i++) out[a + i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
                break;
            }
            case "bcdf": {
                const s = String(v).trim();
                if (s === orig[key]) continue;
                if (!(/^\d+$/.test(s) && s.length >= 1 && s.length <= 2 * width)) {
                    throw new InvalidValue(`radio_wide.${key}: expected 1..${2 * width} digits, got ${JSON.stringify(v)}`);
                }
                const t = s.padEnd(2 * width, "f");
                for (let i = 0; i < width; i++) out[a + i] = parseInt(t.slice(2 * i, 2 * i + 2), 16);
                break;
            }
            default:
                continue;
        }
        touched.add(f.area);
    }
    return finish(out, blk, touched);
}
