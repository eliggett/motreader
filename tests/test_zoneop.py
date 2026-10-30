"""ZONE OPERATION switch (motreader-py/zoneop.py) vs RSS's own re-packs.

Ground truth: notes/ground-truth/zoneop_rss/ -- plain bodies RSS saved before
and after toggling ZONE OPERATION on every on-hand radio, plus RSS's GET +
re-SAVE of the files motreader wrote."""

import json
import os

import pytest

from motreader import zoneop as Z
from motreader.codeplug import Codeplug, mode_pointer_table

HERE = os.path.dirname(os.path.abspath(__file__))
GT = os.path.join(os.path.dirname(HERE), "notes", "ground-truth", "zoneop_rss")
# RSS's per-save bookkeeping (timestamp / counters), not data
BOOK = set(range(0, 13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} \
    | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))


def _gt(name):
    with open(os.path.join(GT, name), "rb") as f:
        return f.read()


def _diff(a, b):
    assert len(a) == len(b)
    return [hex(i) for i in range(len(a)) if a[i] != b[i] and i not in BOOK]


def test_zones_off_matches_rss_617asn():
    on = _gt("617ASN1767_zones_on.plain.bin")
    assert _diff(Z.zones_off(on), _gt("617ASN1767_zones_off.plain.bin")) == []


def test_zones_off_matches_rss_604aun_but_scan_priority_bytes():
    # RSS also writes header 0x1D5-0x1D7 (80 00 00 -> 0a 0f 10) here, not on
    # 617ASN; RSS GET + re-SAVE of motreader's output keeps 80 00 00 (below)
    on = _gt("604AUN0331_zones_on.plain.bin")
    assert _diff(Z.zones_off(on), _gt("604AUN0331_zones_off.plain.bin")) == ["0x1d5", "0x1d6", "0x1d7"]


def test_zones_on_matches_rss_617asq():
    off = _gt("617ASQ1266_zones_off.plain.bin")
    assert _diff(Z.zones_on(off), _gt("617ASQ1266_zones_on.plain.bin")) == []


@pytest.mark.parametrize("serial,name,fn,match", [
    ("566AYA0014", "566AYA0014_zones_on.plain.bin", Z.zones_off, "trunked"),
    ("221AZN0035", "221AZN0035_zones_on.plain.bin", Z.zones_off, "A9 head"),
    ("604ATY0472", "604ATY0472_zones_off.plain.bin", Z.zones_on, "128 user modes"),
])
def test_unsupported_switches_are_refused(serial, name, fn, match):
    with pytest.raises(ValueError, match=match):
        fn(_gt(name))


@pytest.mark.parametrize("serial,state", [
    ("617ASN1767", "zones_off"), ("604AUN0331", "zones_off"), ("617ASQ1266", "zones_on")])
def test_motreader_switch_loads_in_rss_and_resaves_identically(serial, state):
    src = _gt(f"{serial}_{'zones_on' if state == 'zones_off' else 'zones_off'}.plain.bin")
    out = (Z.zones_off if state == "zones_off" else Z.zones_on)(src)
    with open(os.path.join(GT, f"{serial}_motreader_switched_get.json")) as f:
        get = json.load(f)
    assert get["get_warnings"] == []
    want = "Disabled" if state == "zones_off" else "Enabled"
    row = next(r for r in get["screens"]["f4,f2"] if "ZONE OPERATION" in r)
    assert row.split()[-1] == want
    resaved = _gt(f"{serial}_motreader_switched_rss_resaved.plain.bin")
    # RSS normalizes one byte of the post-record section on 617ASQ (FF -> 00)
    # on its own pack output too; nothing else changes
    assert _diff(out, resaved) == (["0x646"] if serial == "617ASQ1266" else [])


@pytest.mark.parametrize("serial", ["566AYA0014", "617ASN1767", "604AUN0331"])
def test_modes_decode_the_same_after_rss_zones_off(serial):
    """Longer zones-off records (566AYA: 43 bytes) are found via RSS's mode
    pointer table: every mode decodes the same as before the switch."""
    a = Codeplug.parse(_gt(f"{serial}_zones_on.plain.bin"))
    b = Codeplug.parse(_gt(f"{serial}_zones_off.plain.bin"))
    key = lambda m: (m.rx_mhz, m.tx_mhz, m.ta_mhz, m.name, m.rx_pl, m.tx_pl,
                     m.tx_power, m.audio_compander, m.mpl_type)
    n = len(mode_pointer_table(b.body)[2])
    assert [key(m) for m in a.modes[:n]] == [key(m) for m in b.modes[:n]]
    assert b.zone_operation is False and b.zones == []


def test_single_zone_is_decoded_via_rss_pointers():
    cp = Codeplug.parse(_gt("617ASQ1266_zones_on.plain.bin"))
    assert cp.zone_operation is True
    assert [(z.number, z.name, z.modes) for z in cp.zones] == [(1, "ZONE  01", list(range(1, 11)))]


def test_zones_on_keeps_records_without_per_mode_lists():
    """A 900 radio with zones off and both CONVENTIONAL lists Op Select keeps
    no per-mode scan list: switching zones on must not cut its records."""
    p = os.path.expanduser("~/.dosbox/c/MRSS/SPECTRA/ARCHIVE-bk/A617ASN1.767")
    if not os.path.exists(p):
        pytest.skip("archive not present")
    from motreader.archive import Archive
    from motreader.crypto import decrypt_body
    body = decrypt_body(Archive.load(p).body)
    before = Codeplug.parse(body)
    assert not before.zone_operation and before.band == "900"
    after = Codeplug.parse(Z.zones_on(body))
    assert after.body[0x10A] == body[0x10A]
    key = lambda m: (m.name, m.rx_mhz, m.tx_mhz, m.ta_mhz, m.rx_pl, m.tx_pl)
    assert [key(m) for m in after.modes] == [key(m) for m in before.modes]
    assert [z.modes for z in after.zones] == [list(range(1, len(before.modes) + 1))]
