// @ts-check
/**
 * The UHF codec against what RSS stores (tools/scenario_freq_sweep.py on a
 * 440-490 MHz A9 radio; the values below are the frequencies typed and the
 * bytes RSS wrote for them), and an edit round trip on that radio when its
 * archive is on hand. The 403-441 MHz range (518ATN, D44ZXA) splits b2
 * elsewhere: notes/ground-truth/uhf_403_rss/sweep.csv is RSS's bytes for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { uhfEncodeRx, uhfEncodeTxTa, uhfDecodeRx, uhfDecodeTxTa, uhfStep, UHF_RANGES } from "../../web/lib/codeplug.js";
import { openDocument } from "../../web/lib/document.js";
import { setModeField } from "../../web/lib/modefields.js";
import { exportArchive } from "../../web/lib/export.js";
import { rebuild } from "../../web/lib/rebuild.js";
import { SPECTRA, ROOT, GROUND_TRUTH } from "./util.js";

test("UHF TX/T·A: the bytes RSS writes (lo, mid, lo's 9th bit, band byte)", () => {
    for (const [f, lo, mid, b9, band] of [
        [465.025, 220, 109, 0, 0x80], [465.45, 24, 50, 1, 0x80], [470.0, 64, 16, 1, 0x84], [452.5, 48, 10, 1, 0x80],
        [449.44, 96, 99, 1, 0x81], [444.445, 71, 116, 1, 0x81], [466.99375, null, null, null, 0x80], [467.0, null, null, null, 0x84],
        [489.995, null, null, null, 0x85], [466.995, null, null, null, 0x81],
    ]) {
        const enc = uhfEncodeTxTa(/** @type {number} */ (f));
        assert.ok(enc, String(f));
        if (lo !== null) assert.deepEqual(enc, [lo, mid, b9, band], String(f));
        else assert.equal(enc[3], band, `${f} band byte`);
        assert.equal(uhfDecodeTxTa(enc[0], enc[1], enc[2] ? 0xEA : 0xE9, enc[3]), f);
    }
});

test("UHF RX: the bytes RSS writes (lo, mid, lo's 9th bit at view +5, flag byte)", () => {
    for (const [f, ...want] of [[460.025, 116, 89, 0, 0x08], [470.0, 184, 34, 0, 0x0C], [455.005, 93, 28, 1, 0x09],
        [489.995, 135, 41, 1, 0x0D], [444.005, 245, 114, 0, 0x09], [440.205, 237, 116, 0, 0x09]]) {
        const enc = uhfEncodeRx(/** @type {number} */ (f));
        assert.deepEqual(enc, want, String(f));
        const [lo, mid, b9, flag] = /** @type {number[]} */ (want);
        assert.equal(uhfDecodeRx(/** @type {number} */ (lo), /** @type {number} */ (mid), /** @type {number} */ (flag), 0xA2 | /** @type {number} */ (b9)), f);
    }
});

test("UHF raster: 6.25 kHz when on it, else 5 kHz, else none", () => {
    assert.equal(uhfStep(460.0), 0.00625);
    assert.equal(uhfStep(460.005), 0.005);
    assert.equal(uhfStep(460.00625), 0.00625);
    assert.equal(uhfStep(460.0025), null);
});

test("UHF 403-441 MHz: the bytes RSS writes, b2 from 418 (RX) and 421 MHz (TX / T·A)", () => {
    const rows = readFileSync(join(GROUND_TRUTH, "uhf_403_rss", "sweep.csv"), "utf8").split("\n")
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("field")).map((l) => l.split(","))
        .filter((r) => r[2] === "ok");
    assert.ok(rows.length >= 90);
    const r = /** @type {import("../../web/lib/codeplug.js").UhfRange} */ (UHF_RANGES.find((x) => x.name === "403-441"));
    for (const [field, mhz, , , lo, mid, b9, fb] of rows) {
        const f = Number(mhz);
        const enc = field === "rx" ? uhfEncodeRx(f, r.rxSplit) : uhfEncodeTxTa(f, r.txSplit);
        assert.ok(enc, `${field} ${mhz}`);
        assert.deepEqual([enc[0], enc[1], enc[2], field === "rx" ? enc[3] & 0x0D : enc[3]], [lo, mid, b9, fb].map(Number), `${field} ${mhz}`);
    }
});

const ASJ = join(SPECTRA, "AR-ORIG", "A221ASJ0.121");
test("a UHF codeplug decodes and edits", { skip: !existsSync(ASJ) }, () => {
    const d = openDocument("A221ASJ0.121", new Uint8Array(readFileSync(ASJ)));
    assert.equal(d.cp.band, "uhf");
    assert.ok(d.support.editable);
    const { cp } = d;
    setModeField(cp, 2, "rx_mhz", "462.5625");
    setModeField(cp, 2, "tx_mhz", "467.5625");
    setModeField(cp, 3, "rx_mhz", "455.005");
    setModeField(cp, 4, "tx_mhz", "475.0");
    assert.equal(cp.modes[3]?.tx_power, "Low", "power forced Low above 470 MHz");
    assert.throws(() => setModeField(cp, 4, "tx_power", "High"), /above 470/);
    assert.throws(() => setModeField(cp, 2, "rx_mhz", "460.0025"), /raster/);
    setModeField(cp, 5, "rx_mhz", "444.005");
    // outside what RSS accepts on this radio, but the codec holds it: stored, with a note
    assert.match(setModeField(cp, 6, "rx_mhz", "435.0").note ?? "", /outside the 440–491 MHz RSS accepts/);
    const res = exportArchive(d);
    assert.deepEqual(res.problems, []);
    const back = openDocument("x", res.bytes).cp;
    assert.deepEqual([back.modes[1]?.rx_mhz, back.modes[1]?.tx_mhz, back.modes[2]?.rx_mhz, back.modes[3]?.tx_mhz, back.modes[3]?.tx_power, back.modes[4]?.rx_mhz],
        [462.5625, 467.5625, 455.005, 475.0, "Low", 444.005]);
    assert.equal(back.modes[5]?.rx_mhz, 435.0);
});

const A518 = join(ROOT, "notes", "Codeplugs", "K1IMD", "A518ATN0.172");
test("a 403-441 MHz radio writes its own band split", { skip: !existsSync(A518) }, () => {
    const { cp } = openDocument("A518ATN0.172", new Uint8Array(readFileSync(A518)));
    assert.equal(cp.uhf_range?.name, "403-441");
    // mode 6 (simplex T/A on): RX 417.99375 / 418.0 straddle the RX split, TX 420.975 / T/A 421.0 the TX one
    setModeField(cp, 6, "rx_mhz", "418.0");
    setModeField(cp, 6, "tx_mhz", "420.975");
    setModeField(cp, 6, "ta_mhz", "421.0");
    setModeField(cp, 7, "rx_mhz", "417.99375");
    assert.match(setModeField(cp, 8, "tx_mhz", "450.0").note ?? "", /outside the 403–441 MHz/);
    assert.equal(cp.modes[7]?.tx_power, "High", "no power limit on this range");
    const out = rebuild(cp);
    const v = (/** @type {number} */ n, /** @type {number} */ o) => out[/** @type {number} */ (cp.modes[n - 1]?.offset) + o] ?? 0;
    // above the range's top (441 MHz) b2 is clear again, as on K1IMD's working 444.1 / 449.1 MHz mode 5
    assert.deepEqual([v(6, 8) & 4, v(6, 12) & 4, v(6, 16) & 4, v(7, 8) & 4, v(8, 12) & 4], [4, 0, 4, 0, 0]);
    const m5 = /** @type {import("../../web/lib/codeplug.js").Mode} */ (cp.modes[4]);
    const r = /** @type {import("../../web/lib/codeplug.js").UhfRange} */ (cp.uhf_range);
    assert.deepEqual(uhfEncodeTxTa(449.1, r.txSplit, r.rss[1]), [m5.raw[10], m5.raw[11], ((m5.raw[9] ?? 0) >> 1) & 1, m5.raw[12]]);
    assert.equal((uhfEncodeRx(444.1, r.rxSplit, r.rss[1])?.[3] ?? 0) & 4, (m5.raw[8] ?? 0) & 4);
});
