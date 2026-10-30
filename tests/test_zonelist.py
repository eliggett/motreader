"""Add / delete zones (motreader-py/zonelist.py) vs RSS's ZONE NAME LIST.

Ground truth: notes/ground-truth/zonelist_rss/ -- RSS saves before/after ADD /
DELETE ZONE (rss_*: the new zone gets modes 1 and 3 in the ZONE MODE LIST),
and RSS's GET + re-SAVE of motreader's own results (motreader_*)."""

import json
import os

import pytest

from motreader import modeops, zonelist as Z
from motreader.archive import Archive
from motreader.buttons import decode_buttons
from motreader.codeplug import Codeplug
from motreader.crypto import decrypt_body

HERE = os.path.dirname(os.path.abspath(__file__))
GT = os.path.join(os.path.dirname(HERE), "notes", "ground-truth", "zonelist_rss")
ARCHIVE_DIR = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")
BOOK = set(range(0, 13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} \
    | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))


def _gt(name):
    with open(os.path.join(GT, name), "rb") as f:
        return f.read()


def _diff(a, b):
    assert len(a) == len(b)
    return [hex(i) for i in range(len(a)) if a[i] != b[i] and i not in BOOK]


def _body(fn):
    p = os.path.join(ARCHIVE_DIR, fn)
    if not os.path.exists(p):
        pytest.skip(f"{fn} not present")
    return decrypt_body(Archive.load(p).body)


@pytest.mark.parametrize("tag,op,extra", [
    ("zaddm", lambda b: Z.add_zone(b, 5, [1, 3]), []),          # 617ASN, at the end
    ("zinsm", lambda b: Z.add_zone(b, 2, [1, 3]), []),          # (RSS: home zone set by hand)
    ("undel3", lambda b: Z.delete_zone(b, 3), []),              # 604AUN
    ("azzaddm", lambda b: Z.add_zone(b, 13, [1, 3]), []),       # 221AZN A9: head block moves
    ("azzdel", lambda b: Z.delete_zone(b, 3), []),
    # RSS leaves the home zone number on an insert before it; motreader follows the zone
    ("azzinsm", lambda b: Z.add_zone(b, 1, [1, 3]), ["0x1dd"]),
    ("azbzdel", lambda b: Z.delete_zone(b, 3), []),             # key 1 = "Zone 5" kept
    ("azbzins", lambda b: Z.add_zone(b, 1, [1]), ["0x1dd"]),
])
def test_zone_ops_match_rss(tag, op, extra):
    base, want = _gt(f"rss_{tag}_base.plain.bin"), _gt(f"rss_{tag}_after.plain.bin")
    got = op(base)
    assert _diff(got, want) == extra
    if extra:
        assert want[0x1DD] == base[0x1DD] and got[0x1DD] == base[0x1DD] + 1


def test_zone_names_and_renumbering_decode():
    c = Codeplug.parse(_gt("rss_azzinsm_after.plain.bin"))
    assert [(z.name, z.modes) for z in c.zones[:2]] == [("ZONE  01", [1, 3]),
                                                         ("SIMPLEX", [1, 2, 3, 4, 57])]
    assert len(c.zones) == 13 and c.modes[-1].name == "APRS 144390"
    c = Codeplug.parse(_gt("rss_zinsm_after.plain.bin"))
    assert [z.name for z in c.zones] == ["SIMPX ZN", "ZONE  02", "BUS ZN", "LOC RPTR", "NODE CH"]


def test_zone_buttons_are_not_renumbered_like_rss():
    for tag in ("azbzins", "azbzdel"):
        k1 = [b.function for b in decode_buttons(Codeplug.parse(_gt(f"rss_{tag}_after.plain.bin")))
              if b.button == "1"]
        assert k1 == ["Zone 5"]


def test_rss_drops_empty_zones():
    """RSS packs an added zone without modes away (motreader refuses it)."""
    a, b = _gt("rss_zaddend_base.plain.bin"), _gt("rss_zaddend_after.plain.bin")
    assert len(Codeplug.parse(b).zones) == len(Codeplug.parse(a).zones) == 4
    with pytest.raises(ValueError, match="at least one mode"):
        Z.add_zone(a, 5, [])


def test_rss_resets_home_zone_on_delete_before_it():
    """RSS: deleting a zone before the home zone sets home zone 01 and the home
    mode to that zone's first mode (566AYA: 12 -> 1, mode 120 -> 2); motreader
    renumbers the home zone instead."""
    a, b = _gt("rss_aydel5_base.plain.bin"), _gt("rss_aydel5_after.plain.bin")
    assert (a[0x1DD], a[0x10F]) == (12, 120) and (b[0x1DD], b[0x10F]) == (1, 2)


def _motreader_results():
    asn, azn, aun = _body("a617asn1.767"), _body("a221azn0.035"), _body("a604aun0.331")
    az1 = Z.add_zone(azn, 1, [1, 2, 3, 57], name="A9 NEW ZONE")
    az2 = Z.delete_zone(az1, 2)
    return {"zlasnadd": Z.add_zone(asn, 2, [1, 5, 10, 48], name="NEWZONE"),
            "zlaz1": az1, "zlaz2": az2, "zlaundel": Z.delete_zone(aun, 3),
            "zlaz3": modeops.add_mode(az2, 65, name="AFTER ZONES", zones=[1])}


def test_motreader_zone_ops_load_in_rss_and_resave_identically():
    for tag, out in _motreader_results().items():
        with open(os.path.join(GT, f"motreader_{tag}_get.json")) as f:
            assert json.load(f)["get_warnings"] == [], tag
        assert _diff(out, _gt(f"motreader_{tag}_rss_resaved.plain.bin")) == [], tag
    c = Codeplug.parse(_gt("motreader_zlaz2_rss_resaved.plain.bin"))
    assert c.body[0x1DD] == 2 and c.zones[1].name == "FT MY CENTR"
    assert (c.zones[0].name, c.zones[0].modes) == ("A9 NEW ZONE", [1, 2, 3, 57])


@pytest.mark.parametrize("fn,op,match", [
    ("a617asn1.767", lambda b: Z.delete_zone(b, 2), "only in zone 2"),
    ("a617asn1.767", lambda b: Z.delete_zone(b, 4), "home zone"),
    ("a617asn1.767", lambda b: Z.add_zone(b, 7, [1]), "out of range"),
    ("a617asn1.767", lambda b: Z.add_zone(b, 1, [1], name="NINECHARS"), "longer than 8"),
    ("a221azn0.035", lambda b: Z.add_zone(b, 1, [1], name="TWELVE CHARS"), "longer than 11"),
    ("a617asq1.266", lambda b: Z.add_zone(b, 1, [1]), "Zone Operation is off"),
    ("a566aya0.014", lambda b: Z.delete_zone(b, 5), "trunked"),
])
def test_refusals(fn, op, match):
    with pytest.raises(ValueError, match=match):
        op(_body(fn))
