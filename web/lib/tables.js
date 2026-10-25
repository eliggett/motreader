// @ts-check
/**
 * CSV and YAML, in the motreader CLI's formats (motreader/cli.py export /
 * import), so files move freely between the web app and the CLI:
 *
 *   modes.csv   one row per mode (the editable columns, then raw_hex)
 *   phones.csv  the phone list          mpl.csv  the MPL list (when enabled)
 *   radio.yaml  identity, radio_wide settings, zones (name, modes)
 *
 * Not yet in the web app: buttons.csv, the zones-off scan columns of
 * modes.csv, radio.yaml conventional_scan and zones[].scan. Import reports
 * them as not applied rather than guessing.
 */
import { dump, load } from "../vendor/js-yaml/js-yaml.mjs";
import { parseCodeplug } from "./codeplug.js";
import { decode as decodeRadioWide } from "./radiowide.js";
import { decodePhones, decodeMpls } from "./lists.js";
import { toCsv, parseCsvObjects, pyCell } from "./csv.js";
import { buildBody } from "./export.js";
import { BANNER_LONG } from "./archive.js";
import { MODE_FIELD_BY_KEY, fieldText, squelchText, setModeField } from "./modefields.js";
import { setZoneName, setZoneModes } from "./zonefields.js";
import { setRadioWide } from "./document.js";
import { setPhone, setMpl, mplSquelchText } from "./listfields.js";
import { isDplCode } from "./tones.js";
import { InvalidValue } from "./errors.js";

/** @typedef {import("./document.js").CodeplugDocument} CodeplugDocument */
/** @typedef {{ name: string, text: string }} TextFile */

export const MODE_COLUMNS = [
    "mode", "name", "rx_mhz", "tx_mhz", "ta_mhz", "rx_pl", "tx_pl", "ta_pl",
    "rx_squelch_type", "tx_squelch_type", "ta_squelch_type", "tx_power", "ta_power", "up_xtal_shift",
    "mdc_ptt_id", "phone_encode", "mpl_type", "audio_compander", "adaptive_splatter",
    "reverse_burst_toc", "unmute_mute_type",
];
/** modes.csv columns for the zones-off scan settings (CLI only, for now). */
export const SCAN_COLUMNS = ["scan", "scan_button_control", "coded_squelch_scan", "talkback_scan",
    "scan_priority_1", "scan_priority_2", "scan_list"];
const OPTION_COLUMNS = ["tx_power", "ta_power", "up_xtal_shift", "mdc_ptt_id", "phone_encode", "mpl_type",
    "audio_compander", "adaptive_splatter", "reverse_burst_toc", "unmute_mute_type"];
const hex = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------
// Export

/**
 * The CSV/YAML of a plaintext body (and its banner), as the CLI exports it.
 * @param {Uint8Array} banner @param {Uint8Array} body
 * @returns {{ files: TextFile[], radio: Record<string, unknown> }}
 */
export function tablesOfBody(banner, body) {
    const cp = parseCodeplug(body);
    const modes = [MODE_COLUMNS.concat("raw_hex"), ...cp.modes.map((m) => [
        String(m.number), m.name, pyCell(m.rx_mhz, true), pyCell(m.tx_mhz, true), pyCell(m.ta_mhz, true),
        m.rx_pl ?? "", m.tx_pl ?? "", m.ta_pl ?? "",
        m.rx_squelch_type ?? "", m.tx_squelch_type ?? "", m.ta_squelch_type ?? "",
        ...OPTION_COLUMNS.map((k) => /** @type {string | null} */ (/** @type {any} */ (m)[k]) ?? ""),
        hex(m.raw),
    ])];
    /** @type {TextFile[]} */
    const files = [{ name: "modes.csv", text: toCsv(modes) }];
    files.push({
        name: "phones.csv",
        text: toCsv([["phone", "name", "number"], ...decodePhones(cp).map((p) => [String(p.number), p.name, p.dial])]),
    });
    const mpls = decodeMpls(cp);
    if (mpls.length) {
        files.push({
            name: "mpl.csv",
            text: toCsv([["mpl", "name", "rx_type", "rx_code", "tx_type", "tx_code", "ta_type", "ta_code"],
                ...mpls.map((m) => [String(m.number), m.name, m.rx_type, m.rx_code, m.tx_type, m.tx_code, m.ta_type, m.ta_code])]),
        });
    }
    /** @type {Record<string, unknown>} */
    const radio = {
        serial: cp.serial, model: cp.model, band: cp.band, signature: cp.signature,
        banner: banner.length === BANNER_LONG.length ? "long" : "short",
        body_len: body.length, mode_count: cp.modes.length,
    };
    const rw = decodeRadioWide(body, cp.band);
    if (Object.keys(rw).length) radio.radio_wide = rw;
    if (cp.zones.length) {
        radio.zones = cp.zones.map((z) => ({
            number: z.number, name: z.name, modes: z.modes,
            mode_names: z.modes.map((n) => cp.modes[n - 1]?.name ?? `MODE ${n}`),
        }));
    }
    // Python writes these as floats (10 s -> "10.0")
    const text = toYaml(radio).replace(/^( {2}mdc_channel_busy_wait_s: )(\d+)$/m, "$1$2.0");
    files.push({ name: "radio.yaml", text });
    return { files, radio };
}

/** YAML laid out like PyYAML's safe_dump(sort_keys=False). */
export function toYaml(/** @type {unknown} */ data) {
    return dump(data, { seqNoIndent: true, lineWidth: -1, quoteStyle: "single" });
}

/**
 * The open document's CSV/YAML: the codeplug as it would be exported (edits
 * included), read back. Throws InvalidValue if the edits can't be written.
 * @param {CodeplugDocument} doc
 */
export function exportTables(doc) {
    return tablesOfBody(doc.banner, buildBody(doc, doc.radioWideEdits)).files;
}

// ---------------------------------------------------------------------------
// Import

/**
 * @typedef {{ applied: string[], refused: string[], notApplied: string[], files: string[] }} ImportReport
 *   applied: changes made; refused: values that can't be stored (with why);
 *   notApplied: things recognised but not supported here yet; files: what each file was taken for.
 */

/** What kind of table a file is, from its name and header row. */
export function tableKind(/** @type {TextFile} */ f) {
    if (/\.ya?ml$/i.test(f.name)) return "yaml";
    const first = f.text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
    const col = first.split(",")[0]?.trim().replace(/^"|"$/g, "");
    return { mode: "modes", phone: "phones", mpl: "mpl", button: "buttons" }[col ?? ""] ?? null;
}

/** Loose equality of a table value and the current one (numbers as numbers, text ignoring case). */
function same(/** @type {unknown} */ a, /** @type {unknown} */ b) {
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? "") === (b ?? "");
    const na = Number(a);
    const nb = Number(b);
    if (String(a).trim() !== "" && String(b).trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Apply CSV/YAML files to the open document (as the CLI import does, but
 * each value through the same checks as an edit in the app). Only values
 * that differ from the document are applied.
 * @param {CodeplugDocument} doc @param {TextFile[]} files
 * @returns {ImportReport}
 */
export function importTables(doc, files) {
    /** @type {ImportReport} */
    const rep = { applied: [], refused: [], notApplied: [], files: [] };
    /** Run one edit, recording it. */
    const apply = (/** @type {string} */ what, /** @type {() => { note?: string | null } | void} */ fn) => {
        try {
            const r = fn();
            rep.applied.push(r?.note ? `${what} (${r.note})` : what);
        } catch (e) {
            if (!(e instanceof InvalidValue)) throw e;
            rep.refused.push(`${what}: ${e.message}`);
        }
    };
    const kinds = files.map((f) => ({ f, kind: tableKind(f) }));
    for (const { f, kind } of kinds) rep.files.push(`${f.name}: ${kind ? `${kind}${kind === "yaml" ? " (radio.yaml)" : ".csv"}` : "not recognised, ignored"}`);

    // radio.yaml first for Zone Operation (a re-pack: not supported here yet)
    /** @type {Record<string, any>} */
    let radio = {};
    for (const { f } of kinds.filter((k) => k.kind === "yaml")) {
        try {
            const y = load(f.text);
            if (y && typeof y === "object") radio = { ...radio, .../** @type {Record<string, any>} */ (y) };
        } catch (e) {
            rep.refused.push(`${f.name}: not valid YAML (${e instanceof Error ? e.message.split("\n")[0] : e})`);
        }
    }
    const rwIn = /** @type {Record<string, unknown>} */ ({ ...(radio.radio_wide ?? {}) });
    if (rwIn.zone_operation !== undefined && !same(rwIn.zone_operation, doc.radioWide.zone_operation)) {
        rep.notApplied.push(`radio_wide.zone_operation ${doc.radioWide.zone_operation} -> ${rwIn.zone_operation}: switching Zone Operation `
            + "re-packs the codeplug, which the web app can't do yet (the motreader CLI can)");
    }
    delete rwIn.zone_operation;
    if (radio.conventional_scan) rep.notApplied.push("radio.yaml conventional_scan: zones-off scan settings aren't edited by the web app yet");

    for (const { f, kind } of kinds) {
        if (kind === "modes") importModes(doc, f, apply, rep);
        else if (kind === "phones") importPhones(doc, f, apply, rep);
        else if (kind === "mpl") importMpls(doc, f, apply, rep);
        else if (kind === "buttons") rep.notApplied.push(`${f.name}: control head buttons aren't edited by the web app yet`);
    }
    if (Array.isArray(radio.zones)) importZones(doc, radio.zones, apply, rep);
    for (const [key, v] of Object.entries(rwIn)) {
        if (v === null || v === undefined || same(v, doc.radioWide[key])) continue;
        apply(`radio_wide.${key} = ${JSON.stringify(v)}`, () => setRadioWide(doc, key, v));
    }
    return rep;
}

/** @typedef {(what: string, fn: () => { note?: string | null } | void) => void} Apply */

/** modes.csv rows -> mode edits. @param {CodeplugDocument} doc @param {TextFile} f @param {Apply} apply @param {ImportReport} rep */
function importModes(doc, f, apply, rep) {
    const { header, rows } = parseCsvObjects(f.text);
    const { cp } = doc;
    if (header.some((h) => SCAN_COLUMNS.includes(h)) && rows.some((r) => SCAN_COLUMNS.some((c) => r[c]))) {
        rep.notApplied.push(`${f.name}: the scan columns (zones-off scan settings) aren't edited by the web app yet`);
    }
    for (const row of rows) {
        const n = Number(row.mode);
        const m = cp.modes[n - 1];
        if (!Number.isInteger(n) || !m) {
            rep.refused.push(`${f.name}: mode ${row.mode}: no such mode (this codeplug has ${cp.modes.length})`);
            continue;
        }
        const edit = (/** @type {string} */ key, /** @type {string} */ text) => {
            const label = MODE_FIELD_BY_KEY.get(key)?.label ?? key;
            apply(`mode ${n} ${label} = ${JSON.stringify(text)}`, () => setModeField(cp, n, key, text));
        };
        if (row.name !== undefined && row.name !== m.name) edit("name", row.name);
        for (const k of ["rx_mhz", "tx_mhz", "ta_mhz"]) {
            const v = (row[k] ?? "").trim();
            if (v && !same(v, /** @type {any} */ (m)[k])) edit(k, v);
        }
        for (const s of /** @type {const} */ (["rx", "tx", "ta"])) {
            if (!(`${s}_pl` in row) && !(`${s}_squelch_type` in row)) continue;
            const code = (row[`${s}_pl`] ?? "").trim();
            const type = (row[`${s}_squelch_type`] ?? "").trim();
            let text = null;
            if (code) {
                const cur = m[`${s}_squelch_type`];
                const t = type || (isDplCode(code) ? (cur === "DPL" || cur === "INV.DPL" ? cur : "DPL") : "PL");
                text = `${t} ${code}`;
            } else if (type === "Carrier") {
                text = "Carrier";
            }
            // a type without a code is left alone (as the CLI does: it protects tones motreader can't name)
            if (text !== null && text !== squelchText(m, s)) edit(`${s}_squelch`, text);
        }
        for (const k of OPTION_COLUMNS) {
            const v = (row[k] ?? "").trim();
            if (v && v !== fieldText(m, k)) edit(k, v);
        }
    }
}

/** radio.yaml zones -> zone edits. @param {CodeplugDocument} doc @param {any[]} zones @param {Apply} apply @param {ImportReport} rep */
function importZones(doc, zones, apply, rep) {
    const { cp } = doc;
    if (zones.some((z) => z && z.scan)) rep.notApplied.push("radio.yaml zones[].scan: zone scan lists aren't edited by the web app yet");
    for (const zr of zones) {
        const z = cp.zones[Number(zr?.number) - 1];
        if (!z) {
            rep.refused.push(`radio.yaml zone ${zr?.number}: no such zone (adding zones isn't supported here yet)`);
            continue;
        }
        if (zr.name !== undefined && zr.name !== null && String(zr.name) !== z.name) {
            apply(`zone ${z.number} name = ${JSON.stringify(String(zr.name))}`, () => setZoneName(cp, z.number, String(zr.name)));
        }
        if (Array.isArray(zr.modes)) {
            const want = [...new Set(zr.modes.map(Number))].sort((a, b) => a - b);
            if (want.join(" ") !== z.modes.join(" ")) {
                apply(`zone ${z.number} modes = ${want.join(" ")}`, () => setZoneModes(cp, z.number, want.join(" ")));
            }
        }
    }
}

/** phones.csv -> phone edits. @param {CodeplugDocument} doc @param {TextFile} f @param {Apply} apply @param {ImportReport} rep */
function importPhones(doc, f, apply, rep) {
    for (const row of parseCsvObjects(f.text).rows) {
        const n = Number(row.phone);
        const p = doc.phones[n - 1];
        if (!p) {
            rep.refused.push(`${f.name}: phone ${row.phone}: only entries 1..${doc.phones.length} exist`);
            continue;
        }
        if (row.name !== undefined && row.name !== p.name) apply(`phone ${n} name = ${JSON.stringify(row.name)}`, () => setPhone(doc, n, "name", row.name ?? ""));
        const dial = (row.number ?? "").trim().toUpperCase();
        if (row.number !== undefined && dial !== p.dial) apply(`phone ${n} number = ${JSON.stringify(dial)}`, () => setPhone(doc, n, "dial", dial));
    }
}

/** mpl.csv -> MPL edits. @param {CodeplugDocument} doc @param {TextFile} f @param {Apply} apply @param {ImportReport} rep */
function importMpls(doc, f, apply, rep) {
    const rows = parseCsvObjects(f.text).rows;
    if (rows.length && !doc.mpls.length) {
        rep.refused.push(`${f.name}: MPL is disabled in this codeplug (Number of MPL = 0); enable it in RSS first`);
        return;
    }
    for (const row of rows) {
        const n = Number(row.mpl);
        const m = doc.mpls[n - 1];
        if (!m) {
            rep.refused.push(`${f.name}: MPL ${row.mpl}: only entries 1..${doc.mpls.length} exist`);
            continue;
        }
        if (row.name !== undefined && row.name !== m.name) apply(`MPL ${n} name = ${JSON.stringify(row.name)}`, () => setMpl(doc, n, "name", row.name ?? ""));
        for (const s of /** @type {const} */ (["rx", "tx", "ta"])) {
            const type = (row[`${s}_type`] ?? "").trim();
            const code = (row[`${s}_code`] ?? "").trim();
            if (!type) continue;
            const text = code ? `${type} ${code}` : type;
            if (text !== mplSquelchText(m, s)) apply(`MPL ${n} ${s.toUpperCase()} = ${JSON.stringify(text)}`, () => setMpl(doc, n, s, text));
        }
    }
}
