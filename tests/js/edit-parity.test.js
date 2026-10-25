// @ts-check
/**
 * The web/lib write path must produce the same bytes as the Python one for
 * the same edits. Edit scripts are generated here from each sample's decoded
 * values (renames, frequency changes, every option flipped, squelch codes,
 * zones, every editable radio-wide field), applied by tools/py_edit.py and by
 * web/lib/export.js buildBody, and the results compared.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { isArchive, splitArchive } from "../../web/lib/archive.js";
import { decryptBody } from "../../web/lib/crypto.js";
import { parseCodeplug } from "../../web/lib/codeplug.js";
import { decode as decodeRadioWide, FIELD_BY_KEY, SIREN_CHOICES, REARM_CHOICES, HEAD_CHOICES } from "../../web/lib/radiowide.js";
import { buildBody } from "../../web/lib/export.js";
import { diff, equal } from "../../web/lib/bytes.js";
import { sampleFiles } from "./reference.js";
import { ROOT } from "./util.js";

/** @param {string} path */
function bodyOf(path) {
    const data = new Uint8Array(readFileSync(path));
    return isArchive(data) ? decryptBody(splitArchive(data).body) : data;
}

/** The next value in a cycle. @template T @param {readonly T[]} xs @param {T} x */
const next = (xs, x) => /** @type {T} */ (xs[(xs.indexOf(x) + 1) % xs.length]);
const EN = ["Enabled", "Disabled"];

/** A changed value for every editable radio-wide field present. */
function radioWideChanges(/** @type {Uint8Array} */ body) {
    const rw = decodeRadioWide(body);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, v] of Object.entries(rw)) {
        const f = FIELD_BY_KEY.get(key);
        if (!f || f.editable === false || v === null) continue;
        const scale = f.scale ?? 1;
        switch (f.kind) {
            case "bit": out[key] = next(EN, v); break;
            case "enum": {
                const valid = /** @type {string[]} */ (f.choices).filter((c) => !c.startsWith("?"));
                out[key] = valid.length > 1 ? next(valid, valid.includes(String(v)) ? v : valid[0]) : v;
                break;
            }
            case "nibble": out[key] = ((Number(v) / scale + 1) % 16) * scale; break;
            case "hinibble": out[key] = (Number(v) + 1) % 16; break;
            case "byte": out[key] = ((Number(v) / scale + 1) % 256) * scale; break;
            case "word": out[key] = ((Number(v) / scale + 7) % 0x10000) * scale; break;
            case "bcd": out[key] = String(v).split("").map((c) => String((Number(c) + 1) % 10)).join(""); break;
            case "bcdf": out[key] = "123"; break;
            case "dial": out[key] = String(v) === "12#" ? "9*" : "12#"; break;
            case "busywait": out[key] = v === "Infinite" ? 2.5 : "Infinite"; break;
            case "siren": out[key] = next(SIREN_CHOICES, v); break;
            case "rearm": out[key] = next(REARM_CHOICES, v); break;
            case "headtype": out[key] = HEAD_CHOICES.includes(/** @type {any} */ (v)) ? next(HEAD_CHOICES, v) : "Standard"; break;
        }
    }
    return out;
}

/** Edit cases for one sample. `full`: also one case per radio-wide field. */
function casesFor(/** @type {string} */ file, /** @type {boolean} */ full) {
    const body = bodyOf(file);
    const cp = parseCodeplug(body);
    const id = (/** @type {string} */ what) => `${file}#${what}`;
    /** @type {any[]} */
    const cases = [{ id: id("noop"), file }];
    const conv = cp.modes.filter((m) => m.rx_mhz !== null && !(m.number === 1 && cp.band === "900" && m.rx_squelch_type === null));
    const step = cp.band === "vhf" ? 0.025 : 0.0125;
    const w = cp.ascii_names ? cp.ascii_names[1] : 8;
    cases.push({ id: id("names"), file, modes: cp.modes.slice(0, 3).map((m, i) => ({ number: m.number, name: `NAME${i}TEST X`.slice(0, w) })) });
    cases.push({
        id: id("freqs"), file, modes: conv.slice(0, 3).map((m, i) => ({
            number: m.number,
            rx_mhz: Math.round((/** @type {number} */ (m.rx_mhz) + step * (i + 1)) * 10000) / 10000,
            ...(m.tx_mhz !== null ? { tx_mhz: Math.round((m.tx_mhz - step * (2 + i)) * 10000) / 10000 } : {}),
            ...(i === 2 ? { ta_mhz: m.rx_mhz } : {}),
        })),
    });
    const m = conv[0];
    if (m) {
        /** @type {Record<string, unknown>} */
        const flips = { number: m.number };
        for (const k of ["up_xtal_shift", "mdc_ptt_id", "phone_encode", "audio_compander", "adaptive_splatter", "reverse_burst_toc"]) {
            const v = /** @type {any} */ (m)[k];
            if (v !== null) flips[k] = next(EN, v);
        }
        if (m.tx_power !== null) flips.tx_power = m.tx_power === "High" ? "Low" : "High";
        if (m.ta_power !== null) flips.ta_power = m.ta_power === "High" ? "Low" : "High";
        if (m.mpl_type !== null) flips.mpl_type = next(["Disabled", "TX Only", "RX Only", "RX & TX"], m.mpl_type);
        if (m.unmute_mute_type !== null) flips.unmute_mute_type = next(["Std/Std", "Std/OR", "AND/Std", "AND/OR"], m.unmute_mute_type);
        cases.push({ id: id("options"), file, modes: [flips] });
    }
    const [s1, s2] = conv;
    if (s1 && s2) {
        cases.push({
            id: id("squelch"), file, modes: [
                { number: s1.number, rx_pl: "100.0", rx_squelch_type: "PL", tx_pl: "D411", tx_squelch_type: "DPL", ta_pl: null, ta_squelch_type: "Carrier" },
                { number: s2.number, rx_pl: "D754", rx_squelch_type: "INV.DPL", tx_pl: "141.3", tx_squelch_type: "PL", ta_pl: "D023", ta_squelch_type: "INV.DPL" },
            ],
        });
    }
    if (cp.band === "900" && s1 && s1.tx_mhz !== null) {
        cases.push({ id: id("simplex"), file, modes: [{ number: s1.number, tx_mhz: s1.rx_mhz, ta_mhz: null }] });
    }
    if (cp.zones.length >= 2) {
        const [z1, z2] = cp.zones;
        const extra = cp.modes.find((x) => !z2?.modes.includes(x.number));
        cases.push({
            id: id("zones"), file, zones: [
                { number: 1, name: "ZTEST", modes: cp.modes.slice(0, 3).map((x) => x.number) },
                { number: 2, modes: [...(z2?.modes ?? []), ...(extra ? [extra.number] : [])].sort((a, b) => a - b) },
            ].filter(() => z1),
        });
    }
    const rw = radioWideChanges(body);
    cases.push({ id: id("radio_wide all"), file, radio_wide: rw });
    if (full) for (const [k, v] of Object.entries(rw)) cases.push({ id: id(`radio_wide ${k}`), file, radio_wide: { [k]: v } });
    return cases;
}

/** Apply a case with web/lib. */
function jsApply(/** @type {any} */ c) {
    const body = bodyOf(c.file);
    const cp = parseCodeplug(body);
    for (const e of c.modes ?? []) Object.assign(/** @type {any} */ (cp.modes[e.number - 1]), e);
    for (const e of c.zones ?? []) Object.assign(/** @type {any} */ (cp.zones[e.number - 1]), e);
    const out = buildBody(/** @type {any} */ ({ cp }), c.radio_wide ?? {});
    return { sha256: createHash("sha256").update(out).digest("hex"), changed: diff(body, out), out, body };
}

const files = sampleFiles().filter((f) => !f.toLowerCase().endsWith(".dbf"));
const fullFiles = new Set(files.filter((f) => /\/ARCHIVE\/[aA]/.test(f)));
const cases = files.flatMap((f) => casesFor(f, fullFiles.has(f)));
const py = spawnSync("python3", [join(ROOT, "tools", "py_edit.py")], {
    cwd: ROOT, env: { ...process.env, PYTHONPATH: ROOT }, input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 1 << 30,
});
const ref = py.status === 0 ? /** @type {Record<string, any>} */ (JSON.parse(py.stdout)) : null;

test("edit cases were generated and run", { skip: ref ? false : `Python: ${py.stderr}` }, (t) => {
    const results = Object.values(/** @type {Record<string, any>} */ (ref));
    const errors = results.filter((r) => r.error);
    const changed = results.filter((r) => !r.error && r.changed.length);
    t.diagnostic(`${cases.length} cases: ${changed.length} changed bytes, ${errors.length} refused (same on both sides)`);
    assert.ok(cases.length > 1000, `${cases.length} cases`);
    // refusals are legitimate (e.g. S9000e head type) but must stay the exception
    assert.ok(errors.length < cases.length / 20, `${errors.length} cases refused`);
});

/** One test per sample file, checking all its cases. */
for (const file of files) {
    const mine = cases.filter((c) => c.file === file);
    test(`edits match Python: ${basename(file)} (${mine.length} cases)`, { skip: !ref }, () => {
        for (const c of mine) {
            const want = /** @type {Record<string, any>} */ (ref)[c.id];
            let got;
            try {
                got = jsApply(c);
            } catch (e) {
                got = { error: String(e) };
            }
            const what = c.id.slice(c.id.indexOf("#") + 1);
            if (want.error || "error" in got) {
                assert.equal("error" in got, Boolean(want.error), `${what}: Python ${want.error ?? "ok"}; JS ${"error" in got ? got.error : "ok"}`);
                continue;
            }
            const g = /** @type {{ sha256: string, changed: number[], out: Uint8Array, body: Uint8Array }} */ (got);
            assert.deepEqual(g.changed, want.changed, `${what}: changed offsets`);
            assert.equal(g.sha256, want.sha256, what);
            if (what === "noop") assert.ok(equal(g.out, g.body), "an unedited rebuild is byte-identical");
        }
    });
}
