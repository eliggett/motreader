// @ts-check
/** The VHF and 900 MHz frequency codecs against what RSS writes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    vhfEncode, vhfDecode, vhfStorable, vhfTxBandByte, vhfEncodeRx, vhfDecodeRx, VHF_RX_COEF, VHF_TX_COEF,
} from "../../web/lib/codeplug.js";

test("VHF encodings are the ones RSS writes (smallest swallow count, at most 127)", () => {
    // typed into RSS on 617ASQ (tools/scenario_vhf_band_sweep.py)
    for (const [f, lo, mid] of [[146.415, 186, 19], [162.56, 128, 127], [149.9975, 161, 55], [150.0025, 159, 57],
        [165.0, 176, 87], [170.25, 252, 28], [144.0, 128, 69], [153.0, 112, 113]]) {
        assert.deepEqual(vhfEncode(/** @type {number} */ (f), VHF_TX_COEF), [lo, mid], String(f));
    }
});

test("VHF TX/TA above 165.74 MHz: storable exactly when the synthesizer bytes hold it", () => {
    for (let i = 0; i <= (174 - 136) / 0.005; i++) {
        const f = Math.round((136 + i * 0.005) * 10000) / 10000;
        for (const coef of [VHF_RX_COEF, VHF_TX_COEF]) {
            const [lo, mid] = vhfEncode(f, coef);
            assert.ok(mid <= 127);
            const count = Math.round((f - coef[2]) / (coef[1] / 128));
            const r = count % 127;
            const fits = count <= 32385 + 128 * r || r === 0;
            assert.equal(vhfStorable(f, coef), fits, `${f}`);
            if (fits) assert.equal(vhfDecode(lo, mid, coef), f);
        }
    }
    // RSS stored these wrong (wrapped); they can't be held
    assert.ok(!vhfStorable(165.75, VHF_TX_COEF));
    assert.ok(!vhfStorable(174.0, VHF_TX_COEF));
    assert.ok(vhfStorable(171.0, VHF_TX_COEF));
});

// [MHz, lo, mid, 9th bit (view +5 b0), flag bits (view +8 & 0x05)] as RSS stored
// the RX values typed into 617ASQ and an AR-ORIG v112 radio (tests/test_vhf.py)
const VHF_RX_RSS = [
    [144.0, 0x56, 0x39, 1, 0x00],
    [145.0, 0x8E, 0x03, 1, 0x00],
    [145.2125, 0x36, 0x0B, 1, 0x01],
    [145.6, 0x16, 0x7B, 1, 0x00],
    [145.6125, 0xF6, 0x4B, 0, 0x01],
    [146.5125, 0xE6, 0x5C, 0, 0x01],
    [150.0, 0x26, 0x72, 1, 0x00],
    [150.00625, 0x37, 0x10, 1, 0x01],
    [151.8125, 0x16, 0x33, 1, 0x01],
    [154.4875, 0xEA, 0x62, 0, 0x01],
    [155.00625, 0x17, 0x36, 1, 0x01],
    [160.0, 0x56, 0x52, 1, 0x00],
    [160.0125, 0xF6, 0x5D, 0, 0x01],
    [160.5, 0x72, 0x37, 1, 0x00],
    [161.0, 0x8E, 0x1C, 1, 0x00],
    [161.5, 0xAA, 0x01, 1, 0x00],
    [162.0, 0x46, 0x65, 1, 0x00],
    [162.5, 0x62, 0x4A, 1, 0x00],
    [162.5375, 0xE2, 0x74, 0, 0x01],
    [162.55, 0x58, 0x54, 1, 0x00],
    [163.0, 0x7E, 0x2F, 1, 0x00],
    [163.5, 0x9A, 0x14, 1, 0x00],
    [164.0, 0x36, 0x78, 1, 0x00],
    [164.5, 0x52, 0x5D, 1, 0x00],
    [165.0, 0x6E, 0x42, 1, 0x00],
    [165.5, 0x8A, 0x27, 1, 0x00],
    [166.0, 0xA6, 0x0C, 1, 0x00],
    [166.00625, 0x37, 0x24, 1, 0x01],
    [166.0125, 0x36, 0x25, 1, 0x01],
    [166.05, 0x9C, 0x16, 1, 0x00],
    [166.05625, 0x2F, 0x2C, 1, 0x01],
    [166.1, 0x92, 0x20, 1, 0x00],
    [166.1125, 0x26, 0x35, 1, 0x01],
    [166.115, 0x8F, 0x23, 1, 0x00],
    [166.11875, 0x25, 0x36, 1, 0x01],
    [166.12, 0x8E, 0x24, 1, 0x00],
    [166.125, 0x8D, 0x25, 1, 0x00],
    [166.13, 0x8C, 0x26, 1, 0x00],
    [166.13125, 0x23, 0x38, 1, 0x01],
    [166.135, 0x8B, 0x27, 1, 0x00],
    [166.1375, 0x22, 0x39, 1, 0x01],
    [166.14, 0x8A, 0x28, 1, 0x00],
    [166.14375, 0x21, 0x3A, 1, 0x01],
    [166.145, 0x89, 0x29, 1, 0x00],
    [166.15, 0x88, 0x2A, 1, 0x04],
    [166.15625, 0x1F, 0x3C, 1, 0x05],
    [166.2, 0x7E, 0x34, 1, 0x04],
    [166.20625, 0x17, 0x44, 1, 0x05],
    [166.25, 0x74, 0x3E, 1, 0x04],
    [166.25625, 0x0F, 0x4C, 1, 0x05],
    [166.3, 0x6A, 0x48, 1, 0x04],
    [166.3125, 0x06, 0x55, 1, 0x05],
    [166.35, 0x60, 0x52, 1, 0x04],
    [166.4, 0x56, 0x5C, 1, 0x04],
    [166.40625, 0xF7, 0x64, 0, 0x05],
    [166.45, 0x4C, 0x66, 1, 0x04],
    [166.49375, 0xE9, 0x72, 0, 0x05],
    [166.5, 0x42, 0x70, 1, 0x04],
    [167.0, 0x5E, 0x55, 1, 0x04],
    [167.5, 0x7A, 0x3A, 1, 0x04],
    [167.99375, 0xF9, 0x64, 0, 0x05],
    [168.0, 0x96, 0x1F, 1, 0x04],
    [168.00625, 0xF7, 0x66, 0, 0x05],
    [168.5, 0xB2, 0x04, 1, 0x04],
    [169.0, 0x4E, 0x68, 1, 0x04],
    [169.5, 0x6A, 0x4D, 1, 0x04],
    [170.0, 0x86, 0x32, 1, 0x04],
    [170.5, 0xA2, 0x17, 1, 0x04],
    [171.0, 0x3E, 0x7B, 1, 0x04],
    [171.5, 0x5A, 0x60, 1, 0x04],
    [172.0, 0x76, 0x45, 1, 0x04],
    [172.00625, 0xF7, 0x6B, 0, 0x05],
    [172.5, 0x92, 0x2A, 1, 0x04],
    [173.0, 0xAE, 0x0F, 1, 0x04],
    [173.5, 0x4A, 0x73, 1, 0x04],
    [173.99375, 0x39, 0x2C, 1, 0x05],
    [174.0, 0x66, 0x58, 1, 0x04],
    [174.005, 0x65, 0x59, 1, 0x04],
];

test("VHF RX encodings are the ones RSS writes (5 kHz, else 6.25 kHz; flag b2 from 166.15 MHz)", () => {
    for (const [f, lo, mid, hi, flag] of VHF_RX_RSS) {
        assert.deepEqual(vhfEncodeRx(/** @type {number} */ (f)), [lo, mid, hi, flag], String(f));
        assert.equal(vhfDecodeRx(/** @type {number} */ (lo), /** @type {number} */ (mid), /** @type {number} */ (flag), 0xA0 | /** @type {number} */ (hi)), f);
    }
    assert.equal(vhfEncodeRx(146.5225), null, "neither raster: RSS refuses it");
});

test("VHF band byte: 6 MHz bands as RSS writes them", () => {
    for (const [f, band] of [[142.0, 0xA4], [144.0025, 0xA4], [149.9975, 0xA4], [150.0, 0x88], [155.9975, 0x88],
        [156.0, 0xA8], [161.9975, 0xA8], [162.0025, 0x8C], [165.75, 0x8C], [168.0, 0xAC], [174.0, 0xAC],
        [156.45, 0xA8], [162.56, 0x8C]]) {
        assert.equal(vhfTxBandByte(/** @type {number} */ (f)), band, String(f));
    }
});
