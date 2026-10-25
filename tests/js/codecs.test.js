// @ts-check
/** The VHF and 900 MHz frequency codecs against what RSS writes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { vhfEncode, vhfDecode, vhfStorable, vhfTxBandByte, VHF_RX_COEF, VHF_TX_COEF } from "../../web/lib/codeplug.js";

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

test("VHF band byte: 6 MHz bands as RSS writes them", () => {
    for (const [f, band] of [[142.0, 0xA4], [144.0025, 0xA4], [149.9975, 0xA4], [150.0, 0x88], [155.9975, 0x88],
        [156.0, 0xA8], [161.9975, 0xA8], [162.0025, 0x8C], [165.75, 0x8C], [168.0, 0xAC], [174.0, 0xAC],
        [156.45, 0xA8], [162.56, 0x8C]]) {
        assert.equal(vhfTxBandByte(/** @type {number} */ (f)), band, String(f));
    }
});
