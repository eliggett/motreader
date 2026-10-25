// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDocument } from "../../web/lib/document.js";
import { setModeField, fieldText } from "../../web/lib/modefields.js";
import { exportArchive } from "../../web/lib/export.js";
import { InvalidValue } from "../../web/lib/errors.js";
import { SPECTRA } from "./util.js";

const ARCHIVE = join(SPECTRA, "ARCHIVE");
const open = (/** @type {string} */ f) => openDocument(f, new Uint8Array(readFileSync(join(ARCHIVE, f))));
const has = (/** @type {string} */ f) => existsSync(join(ARCHIVE, f));

test("VHF edits store, snap and export cleanly", { skip: !has("A617ASQ1.266") }, () => {
    const d = open("A617ASQ1.266");
    const { cp } = d;
    setModeField(cp, 2, "name", "test 2");
    assert.equal(cp.modes[1]?.name, "TEST 2", "6-bit names are upper case");
    assert.equal(setModeField(cp, 2, "rx_mhz", "146.52").note, null);
    assert.equal(cp.modes[1]?.rx_mhz, 146.52);
    // RX resolution is 5 kHz: 146.5225 isn't storable exactly
    const r = setModeField(cp, 2, "rx_mhz", "146.5225");
    assert.match(r.note ?? "", /stored as/);
    setModeField(cp, 2, "tx_squelch", "DPL d411");
    assert.equal(fieldText(/** @type {any} */ (cp.modes[1]), "tx_squelch"), "DPL D411");
    setModeField(cp, 2, "rx_squelch", "pl 100");
    assert.equal(fieldText(/** @type {any} */ (cp.modes[1]), "rx_squelch"), "PL 100.0");
    setModeField(cp, 3, "mpl_type", "rx & tx");
    assert.throws(() => setModeField(cp, 2, "name", "TOO LONG NAME"), InvalidValue);
    assert.throws(() => setModeField(cp, 2, "rx_squelch", "DPL D999"), InvalidValue);
    assert.throws(() => setModeField(cp, 2, "rx_mhz", ""), InvalidValue);
    assert.throws(() => setModeField(cp, 2, "audio_compander", "Enabled"), InvalidValue, "900 MHz only");
    const res = exportArchive(d);
    assert.deepEqual(res.problems, []);
    const back = openDocument(d.fileName, res.bytes).cp;
    assert.equal(back.modes[1]?.name, "TEST 2");
    assert.equal(back.modes[1]?.tx_pl, "D411");
    assert.equal(back.modes[2]?.mpl_type, "RX & TX");
});

test("900 MHz edits, simplex conversion and refusals", { skip: !has("a604aun0.331") }, () => {
    const d = open("a604aun0.331");
    const { cp } = d;
    const rep = cp.modes.find((m) => m.tx_mhz !== null && m.ta_mhz !== null);
    assert.ok(rep, "a repeater mode");
    const n = rep.number;
    setModeField(cp, n, "rx_mhz", "927.5000");
    setModeField(cp, n, "ta_mhz", "");   // simplex: TX moves into the T/A field
    assert.equal(cp.modes[n - 1]?.ta_mhz, null);
    assert.throws(() => setModeField(cp, n, "ta_mhz", "927.5"), /simplex 900 MHz mode/);
    assert.throws(() => setModeField(cp, n, "rx_mhz", "146.52"), /895–942/);
    setModeField(cp, n, "audio_compander", "Enabled");
    setModeField(cp, n, "unmute_mute_type", "AND/OR");
    const res = exportArchive(d);
    assert.deepEqual(res.problems, []);
    const m = openDocument(d.fileName, res.bytes).cp.modes[n - 1];
    assert.equal(m?.rx_mhz, 927.5);
    assert.equal(m?.ta_mhz, null);
    assert.equal(m?.unmute_mute_type, "AND/OR");
});

test("the trunked mode 1 is not editable", { skip: !has("a566aya0.014") }, () => {
    const { cp } = open("a566aya0.014");
    assert.throws(() => setModeField(cp, 1, "name", "X"), /trunked/);
});

test("an unedited export is the original file", { skip: !has("a221azn0.035") }, () => {
    const d = open("a221azn0.035");
    const res = exportArchive(d);
    assert.deepEqual(res.problems, []);
    assert.deepEqual(res.changed, []);
    assert.deepEqual([...res.bytes], [...d.raw]);
});

test("A9 name edits carry the head checksum", { skip: !has("a221azn0.035") }, () => {
    const d = open("a221azn0.035");
    setModeField(d.cp, 2, "name", "Lower ok 11");
    const res = exportArchive(d);
    assert.deepEqual(res.problems, []);
    assert.equal(openDocument(d.fileName, res.bytes).cp.modes[1]?.name, "Lower ok 11");
    assert.ok(res.changed.length > 11, "name bytes and the checksum word");
});

test("a VHF TX the synthesizer can't hold is refused, not snapped", { skip: !has("A617ASQ1.266") }, () => {
    const { cp } = open("A617ASQ1.266");
    assert.throws(() => setModeField(cp, 2, "tx_mhz", "165.75"), /synthesizer/);
    setModeField(cp, 2, "tx_mhz", "165.0");
    assert.equal(cp.modes[1]?.tx_mhz, 165.0);
});
