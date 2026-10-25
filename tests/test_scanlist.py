"""Zone scan lists + ZONE SCAN OPTIONS (motreader/scanlist.py) and the radio-wide
SCAN CONFIGURATION fields vs RSS.

Ground truth: notes/ground-truth/scanlist_rss/ -- RSS saves with one field /
list entry stepped (rss_*), and RSS's GET + re-SAVE of motreader's own edits
(motreader_*)."""

import json
import os

import pytest

from motreader import modeops as M
from motreader import radiowide as R
from motreader import scanlist as S

HERE = os.path.dirname(os.path.abspath(__file__))
GT = os.path.join(os.path.dirname(HERE), "notes", "ground-truth", "scanlist_rss")
BOOK = set(range(0, 13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} \
    | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))


def _gt(name):
    with open(os.path.join(GT, f"{name}.plain.bin"), "rb") as f:
        return f.read()


def _diff(a, b):
    assert len(a) == len(b)
    return [hex(i) for i in range(len(a)) if a[i] != b[i] and i not in BOOK]


def _edit(body, zone, **kw):
    z = S.decode(body)[zone - 1]
    for k, v in kw.items():
        setattr(z, k, v)
    return S.encode(body, [z])


@pytest.mark.parametrize("base,want,kw", [
    # ZONE SCAN OPTIONS, zone 1 (one field per RSS save)
    ("aun_base", "aun_talkback_dis", dict(talkback_scan="Disabled")),
    ("aun_base", "aun_button_override", dict(scan_button_control="Override")),
    ("aun_base", "aun_coded_dis", dict(coded_squelch_scan="Disabled")),
    ("aun_base", "aun_type_disabled", dict(scan_type="Disabled")),
    ("aun_base", "aun_nonpri_opsel", dict(non_priority_list="Op Select")),
    ("aun_base", "aun_pri_opsel", dict(priority_list="Op Select")),
    ("asn_base", "asn_talkback_en", dict(talkback_scan="Enabled")),
    ("asn_base", "asn_button_override", dict(scan_button_control="Override")),
    ("asn_base", "asn_coded_en", dict(coded_squelch_scan="Enabled")),
    ("asn_base", "asn_type_disabled", dict(scan_type="Disabled")),
    ("asn_base", "asn_type_pritlkgr", dict(scan_type="Pri Tlkgr")),
    ("asn_base", "asn_nonpri_opsel", dict(non_priority_list="Op Select")),
    ("aya_base", "aya_nonpri_zoneslaved", dict(non_priority_list="Zone Slaved")),
    # SCAN LIST entries, zone 1 (604AUN: Pri 1 = mode 1, 10 N Pri members)
    ("aun_base", "aun_selmod_pri2", dict(priority_2="SELMOD")),
    ("aun_base", "aun_m1_npri", dict(priority_1=None, modes=[1, 11, 15, 16, 17, 18, 19, 26, 28, 29, 30])),
    ("aun_base", "aun_m1_none", dict(priority_1=None)),
    ("aun_base", "aun_m1_pri2", dict(priority_1=None, priority_2=1)),
    ("aun_base", "aun_m2_pri2", dict(priority_2=2)),
    ("aun_base", "aun_m2_npri", dict(modes=[2, 11, 15, 16, 17, 18, 19, 26, 28, 29, 30])),
    ("asn_base", "asn_m1_npri", dict(modes=[1])),
    ("asn_base", "asn_m2_npri", dict(modes=[2])),
    ("asn_base", "asn_pri12", dict(scan_type="Pri Tlkgr", priority_1=1, priority_2=2)),
    # Pri Tlkgr -> Talkgroup: RSS drops both priority modes
    ("asn_pri12", "asn_pri12_to_talkgroup", dict(scan_type="Talkgroup", priority_1=None, priority_2=None)),
])
def test_zone_scan_edits_match_rss(base, want, kw):
    assert _diff(_edit(_gt(f"rss_{base}"), 1, **kw), _gt(f"rss_{want}")) == []


def test_decode_matches_rss_screens():
    """604AUN zone 1 PRI TLKGROUP SCAN LIST: <SELMOD> N Pri, 1 Pri 1, 11 15-19 26
    28-30 N Pri, "List = 12 of 16 Max"; 617ASN zone 1: Talkgroup, only <SELMOD>."""
    z = S.decode(_gt("rss_aun_base"))[0]
    assert (z.scan_type, z.priority_1, z.priority_2) == ("Pri Tlkgr", 1, None)
    assert z.modes == [11, 15, 16, 17, 18, 19, 26, 28, 29, 30] and z.members() == 12
    assert (z.talkback_scan, z.scan_button_control, z.coded_squelch_scan,
            z.non_priority_list, z.priority_list) == ("Enabled", "Active", "Enabled",
                                                      "Zone Slaved", "Zone Slaved")
    z = S.decode(_gt("rss_asn_base"))[0]
    assert (z.scan_type, z.talkback_scan, z.coded_squelch_scan, z.modes, z.members()) == \
        ("Talkgroup", "Disabled", "Disabled", [], 1)
    z = S.decode(_gt("rss_aya_base"))[0]
    assert (z.non_priority_list, z.members()) == ("Op Select", 8)
    assert S.decode(_gt("rss_aun_selmod_pri2"))[0].priority_2 == "SELMOD"


def test_unchanged_encode_is_byte_identical():
    for name in ("rss_aun_base", "rss_asn_base", "rss_aya_base", "rss_azn_base"):
        b = _gt(name)
        assert S.encode(b, S.decode(b)) == b


@pytest.mark.parametrize("base,want,kw", [
    ("aun_base", "aun_rxhang_1750", dict(scan_conv_rx_hang_time_ms=1750)),
    ("aun_base", "aun_txhang_1750", dict(scan_conv_tx_hang_time_ms=1750)),
    ("asn_base", "asn_txrevert_active", dict(scan_tx_revert_mode="Active")),
    ("asn_base", "asn_txrevert_home", dict(scan_tx_revert_mode="Home")),
    ("asn_base", "asn_scanoffhub_en", dict(scan_off_hub="Enabled")),
    ("azn_base", "azn_dynpri_dis", dict(scan_dynamic_priority_assignment="Disabled")),
])
def test_scan_configuration_edits_match_rss(base, want, kw):
    assert _diff(bytes(R.encode(_gt(f"rss_{base}"), kw)), _gt(f"rss_{want}")) == []


def test_tx_revert_mode_shown_only_with_scan_off_hub_disabled():
    b = _gt("rss_azn_base")                               # Scan Off HUB Enabled
    assert "scan_tx_revert_mode" not in R.decode(b)
    out = R.encode(b, dict(scan_off_hub="Disabled", scan_tx_revert_mode="Home"))
    assert R.decode(bytes(out))["scan_tx_revert_mode"] == "Home"


@pytest.mark.parametrize("kw,match", [
    (dict(modes=list(range(1, 17))), "17 members"),
    (dict(priority_1=None, priority_2=None, modes=list(range(2, 17)), scan_type="Pri Tlkgr"), None),
    (dict(scan_type="Talkgroup"), "need scan_type Pri Tlkgr"),
    (dict(priority_2=1), "Priority 1 and Priority 2"),
    (dict(priority_2="SELMOD", priority_1="SELMOD"), "Priority 1 and Priority 2"),
    (dict(modes=[49]), r"no mode\(s\) \[49\]"),
    (dict(priority_2=60), "no mode 60"),
    (dict(scan_type="Channel"), "not one of"),
])
def test_refusals(kw, match):
    b = _gt("rss_aun_base")                     # 48 modes, zone 1 Pri 1 = mode 1
    if match is None:
        _edit(b, 1, **kw)                       # 16 incl. <SELMOD>: allowed
        return
    with pytest.raises(ValueError, match=match):
        _edit(b, 1, **kw)


def test_priority_mode_in_modes_is_not_also_n_pri():
    out = _edit(_gt("rss_aun_base"), 1, modes=[1, 11])   # mode 1 is Pri 1
    z = S.decode(out)[0]
    assert (z.priority_1, z.modes) == (1, [11])


def test_mode_ops_keep_selmod_priority():
    b = _edit(_gt("rss_aun_base"), 3, priority_1="SELMOD", modes=[29])
    for out in (M.add_mode(b, 1, zones=[1]), M.delete_mode(b, 20)):
        z = S.decode(out)[2]
        assert z.priority_1 == "SELMOD"
    z = S.decode(M.add_mode(b, 1, zones=[1]))[0]
    assert (z.priority_1, z.modes[:2]) == (1, [12, 16])         # Pri 1 = old mode 1 stays mode 1
    z = S.decode(M.delete_mode(b, 20))[0]
    assert z.modes == [11, 15, 16, 17, 18, 19, 25, 27, 28, 29]


def test_rss_add_mode_keeps_selmod_priority():
    """RSS ADD MODE after 1 (zone 1) on a list with Pri 1 = 30 / Pri 2 = 2 and a
    zone-3 <SELMOD> Pri 1: 30 -> 31, 2 -> 3, <SELMOD> (0xFF) unchanged."""
    from motreader.codeplug import mode_pointer_table
    base, want = _gt("rss_aun_selmod_add_base"), _gt("rss_aun_selmod_add_after")
    t = mode_pointer_table(want)[2][1]
    got = M._change(base, after=1, record=want[t:t + want[0x10A]], name=M.default_name(2), zones=(1,))
    assert _diff(got, want) == []
    z1, _, z3 = S.decode(got)[:3]
    assert (z1.priority_1, z1.priority_2, z3.priority_1) == (31, 3, "SELMOD")


ARCHIVE_DIR = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")
# the motreader edits RSS GET-loaded (no warning), displayed as set, and
# re-saved byte-identically (motreader_<tag>_get.json / _rss_resaved)
VALIDATED = {
    "asn": ("a617asn1.767", {
        1: dict(scan_type="Pri Tlkgr", priority_1=5, priority_2="SELMOD", modes=[1, 2, 3, 40],
                talkback_scan="Enabled", coded_squelch_scan="Enabled",
                scan_button_control="Override", non_priority_list="Op Select",
                priority_list="Op Select"),
        3: dict(scan_type="Disabled")}, None),
    "azn": ("a221azn0.035", {2: dict(modes=[4, 5, 60, 65]), 1: dict(talkback_scan="Disabled")},
            dict(scan_off_hub="Disabled", scan_tx_revert_mode="Home",
                 scan_conv_rx_hang_time_ms=1500, scan_conv_tx_hang_time_ms=3000,
                 scan_dynamic_priority_assignment="Disabled")),
    "aun": ("a604aun0.331", {1: dict(priority_1=30, priority_2=2, modes=[11, 15, 47]),
                             3: dict(priority_1="SELMOD", modes=[29])}, None),
    "aya": ("a566aya0.014", {12: dict(modes=list(range(80, 95)),
                                      non_priority_list="Zone Slaved")}, None),
}


@pytest.mark.parametrize("tag", sorted(VALIDATED))
def test_motreader_edits_load_in_rss_and_resave_identically(tag):
    from motreader.archive import Archive
    from motreader.crypto import decrypt_body
    fn, zones, rw = VALIDATED[tag]
    p = os.path.join(ARCHIVE_DIR, fn)
    if not os.path.exists(p):
        pytest.skip("archive not present")
    out = decrypt_body(Archive.load(p).body)
    for zn, kw in zones.items():
        out = _edit(out, zn, **kw)
    if rw:
        out = bytes(R.encode(out, rw))
    with open(os.path.join(GT, f"motreader_{tag}_get.json")) as f:
        shown = json.load(f)
    assert shown["get_warnings"] == []
    assert _diff(out, _gt(f"motreader_{tag}_rss_resaved")) == []
    lists = [r for p_, rows in shown["screens"].items() for r in rows if "List = " in r]
    assert lists                                    # RSS's member counts == motreader's
    zone, count = {"asn": (1, 6), "azn": (2, 5), "aun": (1, 6), "aya": (12, 16)}[tag]
    assert f"List = {count:02d} of 16 Max" in lists[0]     # the first list screen dumped
    assert S.decode(out)[zone - 1].members() == count
