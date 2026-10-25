// @ts-check
/**
 * CSV/YAML interchange with the motreader CLI, both ways:
 *  - export: web/lib's modes.csv, phones.csv, mpl.csv and radio.yaml equal
 *    the CLI's on every sample (minus the scan parts the web app doesn't do
 *    yet: modes.csv's zones-off scan columns, conventional_scan, zones[].scan);
 *  - import: the same edited files imported by the CLI and by web/lib give
 *    byte-identical archives (on the real archives on hand).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isArchive, openArchive } from "../../web/lib/archive.js";
import { BANNER_LONG } from "../../web/lib/archive.js";
import { tablesOfBody, importTables, SCAN_COLUMNS } from "../../web/lib/tables.js";
import { parseCsv, toCsv } from "../../web/lib/csv.js";
import { openDocument } from "../../web/lib/document.js";
import { exportArchive } from "../../web/lib/export.js";
import { sampleFiles } from "./reference.js";
import { ROOT } from "./util.js";

const py = (/** @type {string[]} */ args, input = "") => spawnSync("python3", [join(ROOT, "tools", "py_tables.py"), ...args], {
    cwd: ROOT, env: { ...process.env, PYTHONPATH: ROOT }, encoding: "utf8", maxBuffer: 1 << 30, input,
});

const files = sampleFiles().filter((f) => !f.toLowerCase().endsWith(".dbf"));
const ref = (() => {
    const r = py(["export", ...files]);
    return r.status === 0 ? /** @type {Record<string, any>} */ (JSON.parse(r.stdout)) : null;
})();

/** The web app's export of a sample file. */
function jsTables(/** @type {string} */ path) {
    const data = new Uint8Array(readFileSync(path));
    const { banner, plain } = isArchive(data) ? openArchive(data) : { banner: BANNER_LONG, plain: data };
    return Object.fromEntries(tablesOfBody(banner, plain).files.map((f) => [f.name, f.text]));
}

/** A CSV without some columns. */
function dropColumns(/** @type {string} */ text, /** @type {string[]} */ cols) {
    const rows = parseCsv(text);
    const keep = (rows[0] ?? []).map((h, i) => (cols.includes(h) ? -1 : i)).filter((i) => i >= 0);
    return toCsv(rows.map((r) => keep.map((i) => r[i] ?? "")));
}

test("CLI export reference available", { skip: ref ? false : "Python unavailable" }, () => assert.ok(files.length > 200));

for (const path of files) {
    test(`export matches the CLI: ${basename(path)}`, { skip: !ref }, () => {
        const want = /** @type {Record<string, any>} */ (ref)[path];
        let got;
        try {
            got = jsTables(path);
        } catch (e) {
            assert.ok(want.error, `JS failed (${e}) where the CLI exported`);
            return;
        }
        assert.ok(!want.error, `the CLI failed (${want.error}) where JS exported`);
        const modes = want.scan_columns ? dropColumns(want["modes.csv"], SCAN_COLUMNS) : want["modes.csv"];
        assert.equal(got["modes.csv"], modes, "modes.csv");
        assert.equal(got["phones.csv"], want["phones.csv"], "phones.csv");
        assert.equal(got["mpl.csv"], want["mpl.csv"], "mpl.csv");
        // PyYAML (YAML 1.1) leaves a digit string like 0228 unquoted (it can't be octal); js-yaml
        // (YAML 1.2) quotes it. Both read back as the same text in both importers.
        const unquote = (/** @type {string} */ y) => y.replace(/: '(\d+)'$/gm, ": $1");
        assert.equal(unquote(got["radio.yaml"] ?? ""), unquote(want["radio.yaml (no scan)"]), "radio.yaml");
    });
}

/** Edit a CSV cell by (row key column, key, column). */
function setCell(/** @type {string} */ text, /** @type {string} */ keyCol, /** @type {string} */ key, /** @type {string} */ col, /** @type {string} */ value) {
    const rows = parseCsv(text);
    const head = /** @type {string[]} */ (rows[0]);
    const k = head.indexOf(keyCol);
    const c = head.indexOf(col);
    const r = rows.find((x, i) => i > 0 && x[k] === key);
    if (r && c >= 0) r[c] = value;
    return toCsv(rows);
}

const archives = files.filter((f) => /\/SPECTRA\/ARCHIVE[^/]*\//.test(f));
for (const path of archives) {
    test(`import gives the CLI's archive: ${basename(path)}`, { skip: !ref || !archives.length }, () => {
        const t = jsTables(path);
        const doc0 = openDocument(basename(path), new Uint8Array(readFileSync(path)));
        const conv = doc0.cp.modes.find((m) => m.rx_mhz !== null && !(doc0.cp.trunked_mode1 && m.number === 1) && m.tx_mhz !== null);
        if (!conv || doc0.cp.band === "900?") return;
        const n = String(conv.number);
        const step = doc0.cp.band === "vhf" ? 0.025 : 0.0125;
        const r4 = (/** @type {number} */ x) => String(Math.round(x * 10000) / 10000);
        let modes = t["modes.csv"] ?? "";
        modes = setCell(modes, "mode", n, "name", "WEB IMP");
        modes = setCell(modes, "mode", n, "rx_mhz", r4(/** @type {number} */ (conv.rx_mhz) + step));
        modes = setCell(modes, "mode", n, "tx_mhz", r4(/** @type {number} */ (conv.tx_mhz) - step));
        modes = setCell(modes, "mode", n, "mdc_ptt_id", conv.mdc_ptt_id === "Enabled" ? "Disabled" : "Enabled");
        modes = setCell(modes, "mode", n, "rx_pl", "100.0");
        modes = setCell(modes, "mode", n, "rx_squelch_type", "PL");
        modes = setCell(modes, "mode", n, "tx_pl", "D411");
        modes = setCell(modes, "mode", n, "tx_squelch_type", "INV.DPL");
        let phones = t["phones.csv"] ?? "";
        phones = setCell(phones, "phone", "1", "name", "WEB PH");
        phones = setCell(phones, "phone", "1", "number", "5551212#");
        let mpl = t["mpl.csv"];
        if (mpl) {
            mpl = setCell(mpl, "mpl", "1", "name", "WEB MPL");
            mpl = setCell(mpl, "mpl", "1", "rx_type", "TPL");
            mpl = setCell(mpl, "mpl", "1", "rx_code", "103.5");
        }
        let yaml = t["radio.yaml"] ?? "";
        yaml = yaml.replace(/^(  time_out_timer: )(\w+)$/m, (_, a, v) => a + (v === "Enabled" ? "Disabled" : "Enabled"));
        yaml = yaml.replace(/^(  minimum_volume: )(\d+)$/m, (_, a, v) => a + String((Number(v) + 1) % 16));
        if (doc0.cp.zones.length) yaml = yaml.replace(/^(- number: 1\n  name: ).*$/m, "$1WEB ZONE");

        const dir = mkdtempSync(join(tmpdir(), "motreader-tables-"));
        try {
            /** @type {import("../../web/lib/tables.js").TextFile[]} */
            const edited = [{ name: "modes.csv", text: modes }, { name: "phones.csv", text: phones }, { name: "radio.yaml", text: yaml }];
            if (mpl) edited.push({ name: "mpl.csv", text: mpl });
            for (const f of edited) writeFileSync(join(dir, f.name), f.text);
            const out = join(dir, "out.arc");
            const r = py(["import", path, dir, out]);
            assert.equal(r.status, 0, `CLI import failed: ${r.stderr}`);

            const doc = openDocument(basename(path), new Uint8Array(readFileSync(path)));
            const rep = importTables(doc, edited);
            assert.deepEqual(rep.refused, [], "nothing refused");
            assert.ok(rep.applied.length >= 8, `applied: ${rep.applied.join("; ")}`);
            const mine = exportArchive(doc, doc.radioWideEdits);
            assert.deepEqual(mine.problems, []);
            assert.ok(existsSync(out));
            assert.deepEqual([...mine.bytes], [...readFileSync(out)], "the same archive as the CLI's import");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

for (const path of archives) {
    test(`the CLI's unedited files import as no change: ${basename(path)}`, { skip: !ref }, () => {
        const want = /** @type {Record<string, any>} */ (ref)[path];
        if (want.error) return;
        const doc = openDocument(basename(path), new Uint8Array(readFileSync(path)));
        const tables = Object.entries(want).filter(([n, t]) => typeof t === "string" && !n.includes("(")).map(([name, text]) => ({ name, text }));
        const rep = importTables(doc, tables);
        assert.deepEqual(rep.refused, []);
        assert.deepEqual(rep.applied, [], "nothing to apply");
        const out = exportArchive(doc, doc.radioWideEdits);
        assert.deepEqual(out.changed, [], "the archive is unchanged");
    });
}
