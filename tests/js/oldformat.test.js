// @ts-check
/**
 * Older codeplug format versions (modes only) and 800 MHz radios (shown, not
 * edited), on the AR-ORIG samples: structural checks, skipped when absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDocument } from "../../web/lib/document.js";
import { setModeField } from "../../web/lib/modefields.js";
import { exportArchive } from "../../web/lib/export.js";
import { importTables, exportTables } from "../../web/lib/tables.js";
import { diff } from "../../web/lib/bytes.js";
import { SPECTRA } from "./util.js";

const AR_ORIG = join(SPECTRA, "AR-ORIG");
const has = (/** @type {string} */ f) => existsSync(join(AR_ORIG, f));
const open = (/** @type {string} */ f) => openDocument(f, new Uint8Array(readFileSync(join(AR_ORIG, f))));

test("an older format version exports its mode edits and nothing else", { skip: !has("A624HQU0.228") }, () => {
    const d = open("A624HQU0.228");
    assert.equal(exportArchive(d).changed.length, 0, "unedited: byte-identical");
    setModeField(d.cp, 3, "name", "web 3");
    setModeField(d.cp, 3, "rx_mhz", "166.15");
    setModeField(d.cp, 4, "rx_mhz", "155.00625");
    const res = exportArchive(d);
    assert.deepEqual(res.problems, []);
    const recs = [3, 4].map((n) => /** @type {number} */ (d.cp.modes[n - 1]?.offset) + 3);
    for (const i of res.changed) {
        assert.ok((i >= 0x266 + 12 && i < 0x266 + 18) || recs.some((t) => i >= t && i <= t + 23), `0x${i.toString(16)}`);
    }
    const back = openDocument(d.fileName, res.bytes);
    assert.equal(back.cp.modes[2]?.name, "WEB 3");
    assert.equal(back.cp.modes[2]?.rx_mhz, 166.15);
    assert.equal(back.cp.modes[3]?.rx_mhz, 155.00625);
    for (const t of recs) {
        let s = 0;
        for (let i = t; i < t + 23; i++) s += /** @type {number} */ (back.plain[i]);
        assert.equal(s & 0xFF, back.plain[t + 23], "record sum at +23");
    }
});

test("CSV/YAML import into an older format version applies modes only", { skip: !has("A624HQE9.680") }, () => {
    const d = open("A624HQE9.680");
    const files = exportTables(d);
    const modes = /** @type {{ name: string, text: string }} */ (files.find((f) => f.name === "modes.csv"));
    const lines = modes.text.split("\n");
    const header = /** @type {string} */ (lines[0]).split(",");
    const row = /** @type {string} */ (lines[1]).split(",");
    row[header.indexOf("name")] = "CSV 1";
    lines[1] = row.join(",");
    const rep = importTables(d, [{ name: "modes.csv", text: lines.join("\n") }, { name: "radio.yaml", text: "radio_wide:\n  home_mode: 3\n" }]);
    assert.deepEqual(rep.refused, []);
    assert.equal(rep.applied.length, 1);
    assert.match(rep.notApplied.join("; "), /only modes are edited/);
    assert.equal(d.cp.modes[0]?.name, "CSV 1");
});

test("800 MHz radios decode and open read-only", { skip: !has("A617AVE0.527") }, () => {
    const d = open("A617AVE0.527");
    assert.equal(d.cp.band, "800");
    assert.ok(!d.support.editable);
    assert.ok(d.cp.trunked_mode1);
    assert.equal(d.cp.modes[0]?.rx_mhz, null, "the trunked mode 1 has no values");
    for (const m of d.cp.modes.slice(1)) {
        assert.ok(/** @type {number} */ (m.rx_mhz) >= 851 && /** @type {number} */ (m.rx_mhz) <= 870, String(m.rx_mhz));
    }
    assert.equal(diff(exportArchive(d).plain, d.plain).length, 0, "exports unchanged");
});
