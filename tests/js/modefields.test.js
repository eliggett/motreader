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
    // RX is on a 5 or 6.25 kHz raster (RSS refuses the rest)
    assert.throws(() => setModeField(cp, 2, "rx_mhz", "146.5225"), /5 or 6.25 kHz raster/);
    assert.equal(setModeField(cp, 2, "rx_mhz", "146.50625").note, null);
    assert.equal(cp.modes[1]?.rx_mhz, 146.50625);
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
    setModeField(d.cp, 2, "name", "Lower ok 1`");
    const res = exportArchive(d);
    assert.deepEqual(res.problems, []);
    assert.equal(openDocument(d.fileName, res.bytes).cp.modes[1]?.name, "LOWER OK 1`", "upper-cased; the A9 head holds a backtick");
    assert.ok(res.changed.length > 11, "name bytes and the checksum word");
});

test("VHF RX-only modes: a blank TX / T·A is stored as RSS stores it", { skip: !has("a221azn0.035") }, () => {
    // RSS's own RX-only modes there: 50 "WX1" and 52 "WX3" (NOAA weather)
    let d = open("a221azn0.035");
    const wx = /** @type {any} */ (d.cp.modes[49]);
    assert.deepEqual([wx.name, wx.tx_mhz, wx.ta_mhz], ["WX1 162 550", null, null]);
    // give it a TX and T·A, then blank them again: the original bytes come back
    setModeField(d.cp, 50, "tx_mhz", "162.55");
    setModeField(d.cp, 50, "ta_mhz", "162.55");
    assert.equal(wx.tx_power, "High");
    let back = openDocument(d.fileName, exportArchive(d).bytes).cp.modes[49];
    assert.deepEqual([back?.tx_mhz, back?.ta_mhz], [162.55, 162.55]);
    setModeField(d.cp, 50, "tx_mhz", "");
    setModeField(d.cp, 50, "ta_mhz", " ");
    assert.equal(wx.tx_power, null);
    assert.deepEqual([...exportArchive(d).bytes], [...d.raw]);
    // blank a programmed mode's TX and T·A
    d = open("a221azn0.035");
    const m = /** @type {any} */ (d.cp.modes[0]);
    assert.ok(m.tx_mhz !== null && m.ta_mhz !== null);
    setModeField(d.cp, 1, "tx_mhz", "");
    setModeField(d.cp, 1, "ta_mhz", "");
    const res = exportArchive(d);
    assert.deepEqual(res.problems, []);
    back = openDocument(d.fileName, res.bytes).cp.modes[0];
    assert.deepEqual([back?.rx_mhz, back?.tx_mhz, back?.ta_mhz, back?.tx_power], [m.rx_mhz, null, null, null]);
    const r = /** @type {Uint8Array} */ (back?.raw);
    assert.deepEqual([r[9] & 0x81, r[10], r[11], r[12], r[13] & 0x81, r[14], r[15], r[16]], [0, 0, 0, 0x80, 0, 0, 0, 0x80]);
});

test("blanking TX is refused where RSS's encoding isn't known yet", { skip: !has("a604aun0.331") }, () => {
    const { cp } = open("a604aun0.331");
    const n = cp.modes.findIndex((m) => m.tx_mhz !== null && !(cp.trunked_mode1 && m.number === 1)) + 1;
    assert.throws(() => setModeField(cp, n, "tx_mhz", ""), /VHF only/);
});

test("a VHF TX the synthesizer can't hold is refused, not snapped", { skip: !has("A617ASQ1.266") }, () => {
    const { cp } = open("A617ASQ1.266");
    assert.throws(() => setModeField(cp, 2, "tx_mhz", "165.75"), /synthesizer/);
    setModeField(cp, 2, "tx_mhz", "165.0");
    assert.equal(cp.modes[1]?.tx_mhz, 165.0);
});

test("names: A-Z 0-9 space - + / = # * ` ) ( @ $ % \\ _, upper-cased, no periods", { skip: !has("A617ASQ1.266") }, () => {
    const { cp } = open("A617ASQ1.266");
    setModeField(cp, 2, "name", "a+b/c=#*");
    assert.equal(cp.modes[1]?.name, "A+B/C=#*");
    setModeField(cp, 2, "name", ")(@$%\\_ ");
    assert.equal(cp.modes[1]?.name, ")(@$%\\_");
    assert.throws(() => setModeField(cp, 2, "name", "146.520"), /can't use "\."/);
    assert.throws(() => setModeField(cp, 2, "name", "HI!"), /can't use "!"/);
    assert.throws(() => setModeField(cp, 2, "name", "TICK`"), /only fits on the A9/, "6-bit names can't hold a backtick");
});
