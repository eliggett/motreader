"""The UHF codec against the bytes RSS writes (typed into RSS on a 440-490 MHz
A9 radio with tools/scenario_freq_sweep.py; FORMAT §5a, UHF)."""

from pathlib import Path

import pytest

from motreader.codeplug import (uhf_decode_rx, uhf_decode_txta, uhf_encode_rx,
                                uhf_encode_txta, uhf_step)


@pytest.mark.parametrize("f, want", [
    (465.025, (220, 109, 0, 0x80)), (465.45, (24, 50, 1, 0x80)), (470.0, (64, 16, 1, 0x84)),
    (452.5, (48, 10, 1, 0x80)), (449.44, (96, 99, 1, 0x81)), (444.445, (71, 116, 1, 0x81)),
])
def test_txta_matches_rss(f, want):
    assert uhf_encode_txta(f) == want
    lo, mid, b9, band = want
    assert uhf_decode_txta(lo, mid, 0xEA if b9 else 0xE9, band) == f


@pytest.mark.parametrize("f, band", [(466.99375, 0x80), (467.0, 0x84), (489.995, 0x85), (466.995, 0x81)])
def test_band_byte(f, band):
    assert uhf_encode_txta(f)[3] == band


@pytest.mark.parametrize("f, want", [
    (460.025, (116, 89, 0, 0x08)), (470.0, (184, 34, 0, 0x0C)), (455.005, (93, 28, 1, 0x09)),
    (489.995, (135, 41, 1, 0x0D)), (444.005, (245, 114, 0, 0x09)), (440.205, (237, 116, 0, 0x09)),
])
def test_rx_matches_rss(f, want):
    """(lo, mid, lo's 9th bit at view +5 b0, flag byte) as RSS wrote them."""
    assert uhf_encode_rx(f) == want
    lo, mid, b9, flag = want
    assert uhf_decode_rx(lo, mid, flag, 0xA2 | b9) == f


def test_raster():
    assert uhf_step(460.0) == 0.00625 and uhf_step(460.005) == 0.005 and uhf_step(460.0025) is None


A518 = Path(__file__).resolve().parent.parent / "notes" / "Codeplugs" / "K1IMD" / "A518ATN0.172"


@pytest.mark.skipif(not A518.exists(), reason="K1IMD's 518ATN (third-party, not in the repo)")
def test_uhf_after_trunked_modes():
    """518ATN: four 47-byte trunked records, then 24 UHF conventional ones."""
    from motreader.archive import Archive
    from motreader.codeplug import Codeplug
    from motreader.crypto import decrypt_body
    cp = Codeplug.parse(decrypt_body(Archive.load(A518).body))
    assert cp.band == "uhf" and len(cp.modes) == 28
    assert all(m.rx_mhz is None for m in cp.modes[:4])
    assert (cp.modes[4].rx_mhz, cp.modes[4].tx_mhz) == (444.1, 449.1)
    assert [m.rx_mhz for m in cp.modes[19:]] == [float(m.name) for m in cp.modes[19:]]
