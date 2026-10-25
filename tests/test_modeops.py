"""Add / delete modes (motreader/modeops.py) vs RSS's MODE UTILITY.

Ground truth: notes/ground-truth/modeops_rss/ -- RSS saves before/after ADD /
DELETE MODE (rss_*), and RSS's GET + re-SAVE of motreader's own results
(motreader_*)."""

import json
import os

import pytest

from motreader import modeops as M
from motreader.archive import Archive
from motreader.codeplug import Codeplug, mode_pointer_table
from motreader.crypto import decrypt_body

HERE = os.path.dirname(os.path.abspath(__file__))
GT = os.path.join(os.path.dirname(HERE), "notes", "ground-truth", "modeops_rss")
ARCHIVE_DIR = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")
BOOK = set(range(0, 13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} \
    | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))


def _gt(name):
    with open(os.path.join(GT, name), "rb") as f:
        return f.read()


def _diff(a, b):
    assert len(a) == len(b)
    return [hex(i) for i in range(len(a)) if a[i] != b[i] and i not in BOOK]


def _rss_record(after_body, number):
    t = mode_pointer_table(after_body)[2][number - 1]
    return after_body[t:t + after_body[0x10A]]


@pytest.mark.parametrize("tag,after,zones", [
    ("asqadd", 10, ()), ("asqins", 1, ()),            # 617ASQ: VHF, zones off
    ("asnadd", 53, (1,)), ("asnins", 1, (1,)),        # 617ASN: 900, zones on
    ("aunoffadd", 48, ()),                            # 604AUN zones off: records grow
])
def test_add_mode_matches_rss(tag, after, zones):
    base, want = _gt(f"rss_{tag}_base.plain.bin"), _gt(f"rss_{tag}_after.plain.bin")
    # RSS's ADD writes a model default record; give motreader the same record
    got = M._change(base, after=after, record=_rss_record(want, after + 1),
                    name=M.default_name(after + 1), zones=zones)
    assert _diff(got, want) == []


def test_add_mode_copy_from_matches_rss():
    base, want = _gt("rss_asncopy_base.plain.bin"), _gt("rss_asncopy_after.plain.bin")
    assert _diff(M.add_mode(base, 1, copy_from=3, zones=[1]), want) == []


def test_four_adds_widen_zone_bitmaps_like_rss():
    """617ASN 53 -> 57 modes: membership width W 7 -> 8 (zone sections and the
    post-record bitmap grow)."""
    x, want = _gt("rss_asn4_base.plain.bin"), _gt("rss_asn4_after.plain.bin")
    for k in range(4):
        x = M._change(x, after=53 + k, record=_rss_record(want, 54 + k),
                      name=M.default_name(54 + k), zones=(1,))
    assert _diff(x, want) == []


def test_delete_mode_matches_rss():
    assert _diff(M.delete_mode(_gt("rss_asqdel_base.plain.bin"), 2),
                 _gt("rss_asqdel_after.plain.bin")) == []
    # 617ASN: identical except the membership byte where RSS leaves a stale bit
    # for the old last mode (53) set, and the section sum; motreader clears it
    got = M.delete_mode(_gt("rss_asndel_base.plain.bin"), 2)
    assert _diff(got, _gt("rss_asndel_after.plain.bin")) == ["0x5ac", "0x5ad"]
    zones = [z.modes for z in Codeplug.parse(got).zones]
    assert zones == [z.modes for z in Codeplug.parse(_gt("rss_asndel_after.plain.bin")).zones][:1] + zones[1:]
    assert max(max(z) for z in zones) == 52


@pytest.mark.parametrize("tag,fn,op", [
    ("asnadd", "a617asn1.767", lambda b: M.add_mode(b, 5, copy_from=14, name="NEW MODE", zones=[1, 3])),
    ("asndel", "a617asn1.767", lambda b: M.delete_mode(b, 10)),
    ("asqadd", "a617asq1.266", lambda b: M.add_mode(b, 0, copy_from=3, name="FIRST")),
])
def test_motreader_mode_ops_load_in_rss_and_resave_identically(tag, fn, op):
    p = os.path.join(ARCHIVE_DIR, fn)
    if not os.path.exists(p):
        pytest.skip("archive not present")
    out = op(decrypt_body(Archive.load(p).body))
    with open(os.path.join(GT, f"motreader_{tag}_get.json")) as f:
        assert json.load(f)["get_warnings"] == []
    assert _diff(out, _gt(f"motreader_{tag}_rss_resaved.plain.bin")) == []


def test_zones_off_add_grows_records_and_rss_resaves_identically():
    out = M.add_mode(_gt("aunoff_source.plain.bin"), 48)
    assert out[0x10A] == 36 and Codeplug.parse(out).modes[48].name == "MODE  49"
    assert _diff(out, _gt("motreader_aunadd_rss_resaved.plain.bin")) == []


def test_add_and_delete_keep_other_modes_and_renumber_zones():
    p = os.path.join(ARCHIVE_DIR, "a617asn1.767")
    if not os.path.exists(p):
        pytest.skip("archive not present")
    body = decrypt_body(Archive.load(p).body)
    a = Codeplug.parse(body)
    key = lambda m: (m.rx_mhz, m.tx_mhz, m.ta_mhz, m.name, m.rx_pl, m.tx_pl, m.ta_pl)
    c = Codeplug.parse(M.add_mode(body, 5, copy_from=14, name="NEW", zones=[1]))
    assert [key(m) for m in c.modes[:5] + c.modes[6:]] == [key(m) for m in a.modes]
    assert key(c.modes[5])[:3] == key(a.modes[13])[:3] and c.modes[5].name == "NEW"
    for za, zc in zip(a.zones, c.zones):
        want = [m + 1 if m > 5 else m for m in za.modes] + ([6] if za.number == 1 else [])
        assert zc.modes == sorted(want)
    d = Codeplug.parse(M.delete_mode(body, 10))
    assert [key(m) for m in d.modes] == [key(m) for m in a.modes[:9] + a.modes[10:]]
    for za, zd in zip(a.zones, d.zones):
        assert zd.modes == [m - 1 if m > 10 else m for m in za.modes if m != 10]


@pytest.mark.parametrize("fn,op,match", [
    ("a617asn1.767", lambda b: M.add_mode(b, 5), "must go in a zone"),
    ("a617asn1.767", lambda b: M.delete_mode(b, 48), "home mode"),
    ("a566aya0.014", lambda b: M.delete_mode(b, 3), "trunked"),
    ("a221azn0.035", lambda b: M.add_mode(b, 3, name="TWELVE CHARS", zones=[1]), "longer than 11"),
    ("a617asn1.767", lambda b: M.add_mode(b, 3, name="NINECHARS", zones=[1]), "longer than 8"),
    ("a604aty0.472", lambda b: M.add_mode(b, 3), "at most 128"),
])
def test_refusals(fn, op, match):
    p = os.path.join(ARCHIVE_DIR, fn)
    if not os.path.exists(p):
        pytest.skip("archive not present")
    with pytest.raises(ValueError, match=match):
        op(decrypt_body(Archive.load(p).body))


# --- A9 / S9000e head (221AZN): names in the head block's fixed slot array,
# head block moved whole to the next page boundary after the radio data

@pytest.mark.parametrize("tag,after,zones", [
    ("azadd", 65, (12,)), ("azins", 1, (1,)), ("azcopy", 10, (2,)),
])
def test_a9_add_mode_matches_rss(tag, after, zones):
    base, want = _gt(f"rss_{tag}_base.plain.bin"), _gt(f"rss_{tag}_after.plain.bin")
    got = M._change(base, after=after, record=_rss_record(want, after + 1),
                    name=M.default_name(after + 1, a9=True), zones=zones)
    assert len(got) == len(want) and _diff(got, want) == []


def test_a9_copy_and_delete_match_rss():
    assert _diff(M.add_mode(_gt("rss_azcopy_base.plain.bin"), 10, copy_from=3, zones=[2]),
                 _gt("rss_azcopy_after.plain.bin")) == []
    got = M.delete_mode(_gt("rss_azdel_base.plain.bin"), 2)
    assert _diff(got, _gt("rss_azdel_after.plain.bin")) == []


def test_a9_results_decode():
    c = Codeplug.parse(_gt("rss_azadd_after.plain.bin"))
    assert len(c.modes) == 66 and c.modes[-1].name == "  MODE   66"
    assert c.modes[-2].name == "APRS 144390" and len(c.zones[11].modes) == 10
    c = Codeplug.parse(_gt("rss_azins_after.plain.bin"))
    assert [m.name for m in c.modes[:3]] == ["146 520", "  MODE    2", "146 550"]
    c = Codeplug.parse(_gt("rss_azdel_after.plain.bin"))
    assert [m.name for m in c.modes[:3]] == ["146 520", "146 580", "KC8MOB 6505"]
    assert c.zones[0].modes == [1, 2, 3, 56]


def _a9_ops(body):
    """The motreader A9 sequence RSS GET-loaded and re-saved (motreader_a9*)."""
    add = M.add_mode(body, 5, copy_from=50, name="WX TEST 1", zones=[1, 11])
    adddel = M.delete_mode(add, 30)
    cp = Codeplug.parse(adddel)
    cp.modes[5].name, cp.modes[5].rx_mhz = "NOAA 162400", 162.4
    cp.modes[6].name, cp.modes[6].tx_mhz, cp.modes[6].tx_pl = "KC8 EDITED", 146.6, "103.5"
    from motreader.lists import fix_a9_head_checksum
    edit = bytearray(cp.rebuild())
    fix_a9_head_checksum(cp, edit)
    return {"a9def": M.add_mode(body, 65, zones=[12]), "a9add": add,
            "a9adddel": adddel, "a9edit": bytes(edit)}


def test_a9_motreader_mode_ops_load_in_rss_and_resave_identically():
    p = os.path.join(ARCHIVE_DIR, "a221azn0.035")
    if not os.path.exists(p):
        pytest.skip("archive not present")
    for tag, out in _a9_ops(decrypt_body(Archive.load(p).body)).items():
        with open(os.path.join(GT, f"motreader_{tag}_get.json")) as f:
            assert json.load(f)["get_warnings"] == [], tag
        assert _diff(out, _gt(f"motreader_{tag}_rss_resaved.plain.bin")) == [], tag
    c = Codeplug.parse(_gt("motreader_a9edit_rss_resaved.plain.bin"))
    assert (c.modes[5].name, c.modes[5].rx_mhz) == ("NOAA 162400", 162.4)
    assert (c.modes[6].name, c.modes[6].tx_mhz, c.modes[6].tx_pl) == ("KC8 EDITED", 146.6, "103.5")


@pytest.mark.parametrize("tag,kw", [("azbdel", dict(delete=2)), ("azbins", dict(after=1, zones=(1,)))])
def test_a9_mode_buttons_are_not_renumbered_like_rss(tag, kw):
    """Key 1 = "Mode 30" (set by motreader) keeps 30 through RSS's DELETE / ADD."""
    from motreader.buttons import decode_buttons
    base, want = _gt(f"rss_{tag}_base.plain.bin"), _gt(f"rss_{tag}_after.plain.bin")
    if "after" in kw:
        kw.update(record=_rss_record(want, 2), name=M.default_name(2, a9=True))
    got = M._change(base, **kw)
    assert _diff(got, want) == []
    key1 = [b.function for b in decode_buttons(Codeplug.parse(got)) if b.button == "1"]
    assert key1 == ["Mode 30"]
