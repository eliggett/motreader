"""Older codeplug format versions (101-114) and 800 MHz radios, on the AR-ORIG
samples (third-party radios: structural checks only, skipped when absent).

FORMAT §5: the older versions keep RSS's mode pointer table (base 0x5F53, no
ext block) and the VHF record, with the record sum at true start +23 and a
per-mode scan list after it. Versions 112 and 114 were checked against RSS's
MODE SUMMARY (every mode) and by loading motreader edits into RSS.
"""

import os

import pytest

from motreader.archive import Archive
from motreader.codeplug import Codeplug, codeplug_version, is_trunked_record, mode_pointer_table
from motreader.crypto import decrypt_body

AR_ORIG = os.path.expanduser("~/.dosbox/c/MRSS/SPECTRA/AR-ORIG")


def _body(name):
    path = os.path.join(AR_ORIG, name)
    if not os.path.exists(path):
        pytest.skip(f"{name} not present")
    return decrypt_body(Archive.load(path).body)


@pytest.mark.parametrize("name, version", [("A624HQE9.680", 112), ("A624HQU0.228", 114)])
def test_old_vhf_modes_decode(name, version):
    body = _body(name)
    assert codeplug_version(body) == version
    pt = mode_pointer_table(body)
    assert pt is not None and pt[0] == 0x5F53
    cp = Codeplug.parse(body)
    assert cp.format_version == version and cp.band == "vhf"
    assert len(cp.modes) == body[0x109]
    assert cp.zones == []                     # not mapped in the older versions
    for m in cp.modes:
        assert 136.0 <= m.rx_mhz <= 174.0, m
        t = m.offset + 3
        assert sum(body[t:t + 23]) & 0xFF == body[t + 23], m.number


def test_old_vhf_edit_writes_only_the_mode():
    body = _body("A624HQE9.680")
    cp = Codeplug.parse(body)
    assert bytes(cp.rebuild()) == body
    m = cp.modes[0]
    m.rx_mhz, m.name = 146.50625, "WEB 1"
    out = cp.rebuild()
    t = m.offset + 3
    changed = [i for i in range(len(body)) if body[i] != out[i]]
    assert all(0x266 <= i < 0x26C or t <= i <= t + 23 for i in changed), [hex(i) for i in changed]
    assert sum(out[t:t + 23]) & 0xFF == out[t + 23]
    back = Codeplug.parse(bytes(out)).modes[0]
    assert (back.rx_mhz, back.name) == (146.50625, "WEB 1")


@pytest.mark.parametrize("name, n", [("A617AVE0.527", 10), ("A604HQJ2.211", 3)])
def test_800_mhz_decodes(name, n):
    body = _body(name)
    cp = Codeplug.parse(body)
    assert cp.band == "800" and len(cp.modes) == n
    first = cp.modes[0]
    assert is_trunked_record(body, first.offset + 3)
    assert (first.rx_mhz, first.tx_mhz, first.ta_mhz) == (None, None, None)
    for m in cp.modes[1:]:
        assert 851.0 <= m.rx_mhz <= 870.0, m
        assert 806.0 <= m.tx_mhz <= 870.0, m
    assert bytes(cp.rebuild()) == body
