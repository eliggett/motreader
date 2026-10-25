"""VHF conventional codec: decode/encode validated byte-exact against RSS.

The expected frequencies are the RSS MODE SUMMARY print of a617asq1.266
(notes/ground-truth/vhf_617asq.prn). The encode side was additionally confirmed
against RSS via the inverse oracle (136-174 MHz, independent RX/TX/T/A splits).
"""

import os

import pytest


def _diff(body, new):
    """Changed offsets, ignoring the mode records' 8-bit sums (rebuild keeps
    them valid, as RSS does)."""
    from motreader.codeplug import record_sum_offsets
    sums = record_sum_offsets(body)
    return [i for i in range(len(body)) if body[i] != new[i] and i not in sums]

from motreader.archive import Archive
from motreader.codeplug import (
    Codeplug, vhf_decode, vhf_encode,
    VHF_RX_COEF, VHF_TX_COEF,
)
from motreader.crypto import decrypt_body, encrypt_body

SAMPLE = os.path.expanduser(
    "~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE/a617asq1.266"
)

# RSS MODE SUMMARY ground truth (all simplex on this radio).
VHF_FREQS = [146.52, 144.0, 145.0, 146.0, 147.0, 148.0, 150.0, 155.0, 155.0, 160.0]


def _cp():
    return Codeplug.parse(decrypt_body(Archive.load(SAMPLE).body))


def test_band_detected():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    cp = _cp()
    assert cp.band == "vhf"
    assert cp.model == "D43KMA7JA5BK"
    assert len(cp.modes) == 10


def test_vhf_freqs_match_print():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    cp = _cp()
    for m, f in zip(cp.modes, VHF_FREQS):
        # this radio is simplex: RX == TX == T/A
        assert m.rx_mhz == f
        assert m.tx_mhz == f
        assert m.ta_mhz == f


def test_vhf_encode_roundtrip():
    """Every 5 kHz step across 136-174 MHz encodes exactly, except the TX/TA
    values above 165.74 MHz that the synthesizer bytes can't hold (RSS stores
    a wrapped, wrong value for those): count = 127*lo + 128*mid, mid <= 127."""
    from motreader.codeplug import vhf_storable
    for coef in (VHF_RX_COEF, VHF_TX_COEF):
        f = 136.0
        while f <= 174.0001:
            lo, mid = vhf_encode(f, coef)
            assert mid <= 127
            count = round((f - coef[2]) / (coef[1] / 128))
            r = count % 127
            fits = count <= 32385 + 128 * r or r == 0   # r == 0: the mid = 127 form
            assert vhf_storable(f, coef) == fits, f
            if fits:
                assert abs(vhf_decode(lo, mid, coef) - round(f, 4)) < 1e-9
            f += 0.005


def test_vhf_encode_matches_rss():
    """The (lo, mid) pairs and band bytes RSS wrote when 162.56, 146.415 and a
    sweep of TX/TA values were typed in (scenario_vhf_band_sweep.py)."""
    from motreader.codeplug import vhf_tx_band_byte
    for f, lo, mid in [(146.415, 186, 19), (162.56, 128, 127), (149.9975, 161, 55), (150.0025, 159, 57),
                       (165.0, 176, 87), (170.25, 252, 28), (144.0, 128, 69), (153.0, 112, 113)]:
        assert vhf_encode(f, VHF_TX_COEF) == (lo, mid), f
    for f, band in [(142.0, 0xA4), (144.0025, 0xA4), (149.9975, 0xA4), (150.0, 0x88), (155.9975, 0x88),
                    (156.0, 0xA8), (161.9975, 0xA8), (162.0025, 0x8C), (165.75, 0x8C), (168.0, 0xAC),
                    (174.0, 0xAC), (156.45, 0xA8), (162.56, 0x8C)]:
        assert vhf_tx_band_byte(f) == band, f


# (MHz, lo, mid, 9th bit (view +5 b0), flag bits (view +8 & 0x05)) as RSS
# stored the RX values typed into 617ASQ and an AR-ORIG v112 radio
# (tools/scenario_freq_sweep.py, 2026-10-25): 5 kHz when on that raster, else
# 6.25 kHz (flag b0); flag b2 from 166.15 MHz.
VHF_RX_RSS = [
(144.0, 0x56, 0x39, 1, 0x00),
    (145.0, 0x8E, 0x03, 1, 0x00),
    (145.2125, 0x36, 0x0B, 1, 0x01),
    (145.6, 0x16, 0x7B, 1, 0x00),
    (145.6125, 0xF6, 0x4B, 0, 0x01),
    (146.5125, 0xE6, 0x5C, 0, 0x01),
    (150.0, 0x26, 0x72, 1, 0x00),
    (150.00625, 0x37, 0x10, 1, 0x01),
    (151.8125, 0x16, 0x33, 1, 0x01),
    (154.4875, 0xEA, 0x62, 0, 0x01),
    (155.00625, 0x17, 0x36, 1, 0x01),
    (160.0, 0x56, 0x52, 1, 0x00),
    (160.0125, 0xF6, 0x5D, 0, 0x01),
    (160.5, 0x72, 0x37, 1, 0x00),
    (161.0, 0x8E, 0x1C, 1, 0x00),
    (161.5, 0xAA, 0x01, 1, 0x00),
    (162.0, 0x46, 0x65, 1, 0x00),
    (162.5, 0x62, 0x4A, 1, 0x00),
    (162.5375, 0xE2, 0x74, 0, 0x01),
    (162.55, 0x58, 0x54, 1, 0x00),
    (163.0, 0x7E, 0x2F, 1, 0x00),
    (163.5, 0x9A, 0x14, 1, 0x00),
    (164.0, 0x36, 0x78, 1, 0x00),
    (164.5, 0x52, 0x5D, 1, 0x00),
    (165.0, 0x6E, 0x42, 1, 0x00),
    (165.5, 0x8A, 0x27, 1, 0x00),
    (166.0, 0xA6, 0x0C, 1, 0x00),
    (166.00625, 0x37, 0x24, 1, 0x01),
    (166.0125, 0x36, 0x25, 1, 0x01),
    (166.05, 0x9C, 0x16, 1, 0x00),
    (166.05625, 0x2F, 0x2C, 1, 0x01),
    (166.1, 0x92, 0x20, 1, 0x00),
    (166.1125, 0x26, 0x35, 1, 0x01),
    (166.115, 0x8F, 0x23, 1, 0x00),
    (166.11875, 0x25, 0x36, 1, 0x01),
    (166.12, 0x8E, 0x24, 1, 0x00),
    (166.125, 0x8D, 0x25, 1, 0x00),
    (166.13, 0x8C, 0x26, 1, 0x00),
    (166.13125, 0x23, 0x38, 1, 0x01),
    (166.135, 0x8B, 0x27, 1, 0x00),
    (166.1375, 0x22, 0x39, 1, 0x01),
    (166.14, 0x8A, 0x28, 1, 0x00),
    (166.14375, 0x21, 0x3A, 1, 0x01),
    (166.145, 0x89, 0x29, 1, 0x00),
    (166.15, 0x88, 0x2A, 1, 0x04),
    (166.15625, 0x1F, 0x3C, 1, 0x05),
    (166.2, 0x7E, 0x34, 1, 0x04),
    (166.20625, 0x17, 0x44, 1, 0x05),
    (166.25, 0x74, 0x3E, 1, 0x04),
    (166.25625, 0x0F, 0x4C, 1, 0x05),
    (166.3, 0x6A, 0x48, 1, 0x04),
    (166.3125, 0x06, 0x55, 1, 0x05),
    (166.35, 0x60, 0x52, 1, 0x04),
    (166.4, 0x56, 0x5C, 1, 0x04),
    (166.40625, 0xF7, 0x64, 0, 0x05),
    (166.45, 0x4C, 0x66, 1, 0x04),
    (166.49375, 0xE9, 0x72, 0, 0x05),
    (166.5, 0x42, 0x70, 1, 0x04),
    (167.0, 0x5E, 0x55, 1, 0x04),
    (167.5, 0x7A, 0x3A, 1, 0x04),
    (167.99375, 0xF9, 0x64, 0, 0x05),
    (168.0, 0x96, 0x1F, 1, 0x04),
    (168.00625, 0xF7, 0x66, 0, 0x05),
    (168.5, 0xB2, 0x04, 1, 0x04),
    (169.0, 0x4E, 0x68, 1, 0x04),
    (169.5, 0x6A, 0x4D, 1, 0x04),
    (170.0, 0x86, 0x32, 1, 0x04),
    (170.5, 0xA2, 0x17, 1, 0x04),
    (171.0, 0x3E, 0x7B, 1, 0x04),
    (171.5, 0x5A, 0x60, 1, 0x04),
    (172.0, 0x76, 0x45, 1, 0x04),
    (172.00625, 0xF7, 0x6B, 0, 0x05),
    (172.5, 0x92, 0x2A, 1, 0x04),
    (173.0, 0xAE, 0x0F, 1, 0x04),
    (173.5, 0x4A, 0x73, 1, 0x04),
    (173.99375, 0x39, 0x2C, 1, 0x05),
    (174.0, 0x66, 0x58, 1, 0x04),
    (174.005, 0x65, 0x59, 1, 0x04),
]


def test_vhf_rx_encode_matches_rss():
    from motreader.codeplug import vhf_encode_rx, vhf_decode_rx
    for f, lo, mid, hi, flag in VHF_RX_RSS:
        assert vhf_encode_rx(f) == (lo, mid, hi, flag), f
        assert vhf_decode_rx(lo, mid, flag, 0xA0 | hi) == f, f
    assert vhf_encode_rx(146.5225) is None          # neither raster: RSS refuses it
    # the 5 kHz form is the old linear codec (0.635*lo + 0.64*mid + 52.91)
    lo, mid, hi, flag = vhf_encode_rx(146.52)
    assert (hi, flag) == (1, 0) and vhf_decode(lo, mid, VHF_RX_COEF) == 146.52


def test_vhf_rebuild_identity():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    cp = Codeplug.parse(body)
    assert bytes(cp.rebuild()) == body
    assert encrypt_body(bytes(cp.rebuild())) == Archive.load(SAMPLE).body


def test_vhf_edit_split_is_surgical():
    """A -600 kHz repeater split touches only RX/TX/T/A bytes of that mode."""
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    cp = Codeplug.parse(body)
    m = cp.modes[2]  # mode 3
    m.rx_mhz, m.tx_mhz, m.ta_mhz = 146.94, 146.34, 146.94
    new = bytes(cp.rebuild())
    diffs = _diff(body, new)
    # RX lo/mid (2) + TX lo/mid (2) + T/A lo/mid (2) = 6 bytes; still in-band so
    # the band bytes are preserved.
    assert len(diffs) == 6
    chk = Codeplug.parse(new).modes[2]
    assert (chk.rx_mhz, chk.tx_mhz, chk.ta_mhz) == (146.94, 146.34, 146.94)
