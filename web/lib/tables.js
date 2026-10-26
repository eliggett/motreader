// @ts-check
/**
 * CSV and YAML, in the motreader CLI's formats (motreader/cli.py export /
 * import), so files move freely between the web app and the CLI:
 *
 *   modes.csv   one row per mode (the editable columns, the zones-off scan
 *               columns when Zone Operation is off, then raw_hex)
 *   phones.csv  the phone list          mpl.csv  the MPL list (when enabled)
 *   radio.yaml  identity, radio_wide settings, conventional_scan (zones off),
 *               zones (name, modes, scan)
 *
 * Not yet in the web app: buttons.csv. Import reports it as not applied
 * rather than guessing. As the CLI import does, a Zone Operation switch or a
 * zones-off scan list / scan type change re-packs the codeplug first, and the
 * zones / scan lists of the old layout aren't applied then (re-export to edit
 * them).
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
import { setRadioWide, restructure } from "./document.js";
import { setPhone, setMpl, mplSquelchText } from "./listfields.js";
import { isDplCode } from "./tones.js";
import { decode as decodeConvScan, encode as encodeConvScan, setListTypes, setScanType } from "./convscan.js";
import { decode as decodeZoneScan, encode as encodeZoneScan, zoneScan } from "./scanlist.js";
import { zonesOn, zonesOff } from "./zoneop.js";
import { equal } from "./bytes.js";
import { InvalidValue } from "./errors.js";

/** @typedef {import("./document.js").CodeplugDocument} CodeplugDocument */
/** @typedef {{ name: string, text: string }} TextFile */

export const MODE_COLUMNS = [
    "mode", "name", "rx_mhz", "tx_mhz", "ta_mhz", "rx_pl", "tx_pl", "ta_pl",
    "rx_squelch_type", "tx_squelch_type", "ta_squelch_type", "tx_power", "ta_power", "up_xtal_shift",
    "mdc_ptt_id", "phone_encode", "mpl_type", "audio_compander", "adaptive_splatter",
    "reverse_burst_toc", "unmute_mute_type",
];
/** modes.csv columns for the zones-off scan settings (present with Zone Operation off). */
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
    const [conv, mscan] = decodeConvScan(body);
    const byMode = new Map(mscan.map((r) => [r.mode, r]));
    const pri = (/** @type {unknown} */ p) => (p === null || p === undefined ? "" : String(p));
    const scanCells = (/** @type {import("./convscan.js").ModeScan | undefined} */ sc) => (sc
        ? [sc.scan, sc.scan_button_control, sc.coded_squelch_scan, sc.talkback_scan, pri(sc.priority_1), pri(sc.priority_2),
            sc.modes === null ? "" : sc.modes.join(" ")]
        : SCAN_COLUMNS.map(() => ""));
    const modes = [[...MODE_COLUMNS, ...(conv ? SCAN_COLUMNS : []), "raw_hex"], ...cp.modes.map((m) => [
        String(m.number), m.name, pyCell(m.rx_mhz, true), pyCell(m.tx_mhz, true), pyCell(m.ta_mhz, true),
        m.rx_pl ?? "", m.tx_pl ?? "", m.ta_pl ?? "",
        m.rx_squelch_type ?? "", m.tx_squelch_type ?? "", m.ta_squelch_type ?? "",
        ...OPTION_COLUMNS.map((k) => /** @type {string | null} */ (/** @type {any} */ (m)[k]) ?? ""),
        ...(conv ? scanCells(byMode.get(m.number)) : []),
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
    if (conv) {
        const { modes: listed, ...rest } = conv;
        radio.conventional_scan = listed === null ? rest : conv;
    }
    if (cp.zones.length) {
        const scans = new Map(decodeZoneScan(body).map((z) => [z.zone, z]));
        radio.zones = cp.zones.map((z) => {
            /** @type {Record<string, unknown>} */
            const row = {
                number: z.number, name: z.name, modes: z.modes,
                mode_names: z.modes.map((n) => cp.modes[n - 1]?.name ?? `MODE ${n}`),
            };
            const sc = scans.get(z.number);
            if (sc) {
                const { zone: _zone, ...scan } = sc;
                row.scan = scan;
            }
            return row;
        });
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
 * @typedef {{ applied: string[], refused: string[], notApplied: string[], files: string[], doc: CodeplugDocument }} ImportReport
 *   applied: changes made; refused: values that can't be stored (with why);
 *   notApplied: things recognised but not supported here yet; files: what each file was taken for;
 *   doc: the document with the changes (a new one when the import re-packed the codeplug).
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
    const rep = { applied: [], refused: [], notApplied: [], files: [], doc };
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
    /** A structural change (re-pack), when `fn` changes the bytes; false if refused or no change. */
    const repack = (/** @type {string} */ what, /** @type {(b: Uint8Array) => Uint8Array} */ fn) => {
        try {
            const body = buildBody(doc, doc.radioWideEdits);
            const out = fn(body);
            if (out.length === body.length && equal(out, body)) return false;
            doc = rep.doc = restructure(doc, what, () => out);
            rep.applied.push(what);
            return true;
        } catch (e) {
            if (!(e instanceof InvalidValue)) throw e;
            rep.refused.push(`${what}: ${e.message}`);
            return false;
        }
    };
    const kinds = files.map((f) => ({ f, kind: tableKind(f) }));
    for (const { f, kind } of kinds) rep.files.push(`${f.name}: ${kind ? `${kind}${kind === "yaml" ? " (radio.yaml)" : ".csv"}` : "not recognised, ignored"}`);
    if (doc.support.modesOnly) {
        // an older format version: only its modes are decoded
        for (const { f, kind } of kinds) {
            if (kind === "modes") importModes(doc, f, apply, rep);
            else if (kind) rep.notApplied.push(`${f.name}: only modes are edited in format version ${doc.support.version}`);
        }
        return rep;
    }

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
    // Zone Operation first: switching it re-packs the whole codeplug; the zones
    // of the old export then describe the old layout and aren't applied
    let zoneSwitched = false;
    const wantZo = rwIn.zone_operation;
    if (wantZo !== undefined && wantZo !== null && !same(wantZo, doc.radioWide.zone_operation)) {
        const on = String(wantZo) === "Enabled";
        zoneSwitched = repack(`Zone Operation ${on ? "on" : "off"}`, (b) => (on ? zonesOn(b) : zonesOff(b)));
        if (zoneSwitched) {
            rep.notApplied.push("radio.yaml zones / home_zone: not applied after the Zone Operation switch (re-export to edit them)");
            delete rwIn.home_zone;
        }
    }
    delete rwIn.zone_operation;
    // zones off: list types / SCAN TYPE re-pack the mode records, so they go first too
    const wantCs = !zoneSwitched ? radio.conventional_scan : null;
    let scanSwitched = false;
    if (wantCs && typeof wantCs === "object") {
        const [cur] = safeConvDecode(buildBody(doc, doc.radioWideEdits));
        if (cur) {
            const st = String(wantCs.scan_type ?? cur.scan_type);
            const nl = String(wantCs.non_priority_list ?? cur.non_priority_list);
            const pl = String(wantCs.priority_list ?? cur.priority_list);
            scanSwitched = repack("conventional scan list / scan type", (b) => {
                if (cur.scan_type === "Talkgroup" && st !== "Talkgroup") b = setScanType(b, st);
                return setScanType(setListTypes(b, nl, pl), st);
            });
            if (scanSwitched) rep.notApplied.push("scan lists in modes.csv / radio.yaml: not applied after the list type change (re-export to edit them)");
        }
    }

    /** @type {Partial<import("./convscan.js").ModeScan>[]} */
    const scanRows = [];
    for (const { f, kind } of kinds) {
        if (kind === "modes") importModes(doc, f, apply, rep, scanRows);
        else if (kind === "phones") importPhones(doc, f, apply, rep);
        else if (kind === "mpl") importMpls(doc, f, apply, rep);
        else if (kind === "buttons") rep.notApplied.push(`${f.name}: control head buttons aren't edited by the web app yet`);
    }
    if (Array.isArray(radio.zones) && doc.cp.zones.length && !zoneSwitched) importZones(doc, radio.zones, apply, rep);
    // zones off: per-mode SCAN settings / Mode Slave lists and the radio-wide (Op Select) list, in place
    if ((wantCs && !zoneSwitched) || scanRows.length) {
        const [cur, curRows] = safeConvDecode(buildBody(doc, doc.radioWideEdits));
        if (cur) {
            if (scanSwitched) {   // after a re-pack the lists of the old export don't apply: keep the new ones
                for (const r of scanRows) {
                    const k = curRows[/** @type {number} */ (r.mode) - 1];
                    if (k) Object.assign(r, { priority_1: k.priority_1, priority_2: k.priority_2, modes: k.modes });
                }
            }
            const conv = wantCs && !scanSwitched && !zoneSwitched ? { ...cur, ...pick(wantCs, Object.keys(cur)) } : null;
            repack("scan settings", (b) => encodeConvScan(b, /** @type {import("./convscan.js").ConvScan | null} */ (conv), scanRows));
        }
    }
    // zone scan lists + ZONE SCAN OPTIONS (radio.yaml zones[].scan), in place
    if (Array.isArray(radio.zones) && doc.cp.zones.length && !zoneSwitched) {
        const fields = Object.keys(zoneScan(0)).filter((k) => k !== "zone");
        const scans = radio.zones.filter((z) => z && z.scan && z.number !== undefined && z.number !== null)
            .map((z) => ({ ...zoneScan(Number(z.number)), ...pick(z.scan, fields) }));
        if (scans.length) repack("zone scan lists", (b) => encodeZoneScan(b, /** @type {import("./scanlist.js").ZoneScan[]} */ (scans)));
    }
    for (const [key, v] of Object.entries(rwIn)) {
        if (v === null || v === undefined || same(v, doc.radioWide[key])) continue;
        apply(`radio_wide.${key} = ${JSON.stringify(v)}`, () => setRadioWide(doc, key, v));
    }
    return rep;
}

/** The keys of `o` that are in `keys`. */
function pick(/** @type {Record<string, unknown>} */ o, /** @type {string[]} */ keys) {
    return Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keys.includes(k)));
}

/** convscan.decode, or [null, []] when the layout isn't handled. */
function safeConvDecode(/** @type {Uint8Array} */ body) {
    try {
        return decodeConvScan(body);
    } catch (e) {
        if (e instanceof InvalidValue) return /** @type {[null, []]} */ ([null, []]);
        throw e;
    }
}

/**
 * A modes.csv row's scan columns as a ModeScan (as the CLI reads them; null
 * values are left alone), or null.
 * @param {Record<string, string>} row @param {number} mode
 * @returns {Partial<import("./convscan.js").ModeScan> | null}
 */
function scanRowOf(row, mode) {
    if (!SCAN_COLUMNS.slice(0, 4).some((c) => row[c])) return null;
    const pri = (/** @type {string | undefined} */ v) => {
        const t = (v ?? "").trim();
        return !t ? null : /^\d+$/.test(t) ? Number(t) : t;
    };
    const lst = row.scan_list;
    return /** @type {any} */ ({
        mode, scan: row.scan || null, scan_button_control: row.scan_button_control || null,
        coded_squelch_scan: row.coded_squelch_scan || null, talkback_scan: row.talkback_scan || null,
        priority_1: /** @type {any} */ (pri(row.scan_priority_1)), priority_2: /** @type {any} */ (pri(row.scan_priority_2)),
        modes: lst === undefined ? null : lst.replace(/,/g, " ").split(/\s+/).filter(Boolean).map(Number),
    });
}

/** @typedef {(what: string, fn: () => { note?: string | null } | void) => void} Apply */

/**
 * modes.csv rows -> mode edits; the zones-off scan columns are collected in
 * `scanRows` (applied after, as the CLI does).
 * @param {CodeplugDocument} doc @param {TextFile} f @param {Apply} apply @param {ImportReport} rep
 * @param {Partial<import("./convscan.js").ModeScan>[]} [scanRows]
 */
function importModes(doc, f, apply, rep, scanRows = []) {
    const { rows } = parseCsvObjects(f.text);
    const { cp } = doc;
    for (const row of rows) {
        const n = Number(row.mode);
        const sr = Number.isInteger(n) ? scanRowOf(row, n) : null;
        if (sr) scanRows.push(sr);
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
    for (const zr of zones) {
        const z = cp.zones[Number(zr?.number) - 1];
        if (!z) {
            rep.refused.push(`radio.yaml zone ${zr?.number}: no such zone (add it on the Zones tab, then import again)`);
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
