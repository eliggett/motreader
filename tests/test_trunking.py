"""Remove trunking (motreader/trunking.py) vs RSS.

566AYA (TRUNKED DUAL MODE, one system / subfleet, trunked mode 1): motreader's
conversion GET-loads in RSS with no warning, RSS shows MAX SYSTEMS/SUBFLEETS
00, "No Trunking data loaded" and a conventional mode 1, and RSS's re-SAVE of
it is byte-identical (notes/ground-truth/trunk_rss/)."""

import json
import os

import pytest

from motreader import radiowide as RW
from motreader.archive import Archive
from motreader.codeplug import Codeplug
from motreader.crypto import decrypt_body
from motreader.trunking import remove_trunking, trunking_info

HERE = os.path.dirname(os.path.abspath(__file__))
GT = os.path.join(os.path.dirname(HERE), "notes", "ground-truth", "trunk_rss")
ARCHIVE_DIR = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")
BOOK = set(range(0, 13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} \
    | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))


def _body(fn):
    p = os.path.join(ARCHIVE_DIR, fn)
    if not os.path.exists(p):
        pytest.skip(f"{fn} not present")
    return decrypt_body(Archive.load(p).body)


def test_remove_trunking_566aya_matches_rss_resave():
    body = _body("a566aya0.014")
    info = trunking_info(body)
    assert info["systems"] == 1 and info["subfleets"] == 1
    new = remove_trunking(body)
    with open(os.path.join(GT, "566AYA0014_detrunked_rss_resaved.plain.bin"), "rb") as f:
        rss = f.read()
    assert len(new) == len(rss)
    assert [hex(i) for i in range(len(new)) if new[i] != rss[i] and i not in BOOK] == []
    assert trunking_info(new) is None
    assert RW.decode(new)["max_systems"] == 0 and RW.decode(new)["max_subfleets"] == 0


def test_remove_trunking_keeps_modes_and_zones():
    body = _body("a566aya0.014")
    a, c = Codeplug.parse(body), Codeplug.parse(remove_trunking(body))
    key = lambda m: (m.rx_mhz, m.tx_mhz, m.ta_mhz, m.name, m.rx_pl, m.tx_pl)
    assert len(a.modes) == len(c.modes) == 122
    assert [key(m) for m in a.modes[1:]] == [key(m) for m in c.modes[1:]]
    assert key(c.modes[0])[:3] == key(c.modes[1])[:3]          # mode 1 = copy of mode 2
    assert c.modes[0].name == a.modes[0].name
    assert [(z.name, z.modes) for z in a.zones] == [(z.name, z.modes) for z in c.zones]


def test_rss_shows_no_trunking_after_removal():
    with open(os.path.join(GT, "566AYA0014_detrunked_get.json")) as f:
        g = json.load(f)
    assert g["get_warnings"] == []
    s = g["screens"]
    assert any("MAX SYSTEMS...............00" in r for r in s["f4,f2"])
    assert any("MAX SUBFLEETS.............00" in r for r in s["f4,f2"])
    assert any("No Trunking data loaded" in r for r in s["f4,f4"])
    assert any("CONVENTIONAL MODE CONFIGURATION" in r for r in s["f4,f5"])


def test_non_trunked_codeplug_is_refused():
    with pytest.raises(ValueError, match="no trunked mode"):
        remove_trunking(_body("a617asn1.767"))
    assert trunking_info(_body("a604aun0.331")) is None    # already removed (RSS bug)
