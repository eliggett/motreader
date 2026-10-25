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
