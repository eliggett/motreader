"""Zones-off scan (motreader-py/convscan.py): per-mode SCAN settings, Op Select /
Mode Slave scan lists, CONVENTIONAL list types and SCAN TYPE, vs RSS.

Ground truth: notes/ground-truth/convscan_rss/ -- RSS saves with one field /
list entry stepped (rss_*), RSS's re-packs, RSS ADD / DELETE MODE on populated
lists, and RSS's GET + re-SAVE of motreader's own edits (motreader_*)."""

import json
import os

import pytest

from motreader import convscan as C
from motreader import modeops as M
from motreader.codeplug import Codeplug, mode_pointer_table

HERE = os.path.dirname(os.path.abspath(__file__))
GT = os.path.join(os.path.dirname(HERE), "notes", "ground-truth", "convscan_rss")
BOOK = set(range(0, 13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} \
    | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))


def _gt(name):
    with open(os.path.join(GT, f"{name}.plain.bin"), "rb") as f:
        return f.read()


def _diff(a, b):
    assert len(a) == len(b)
    return [hex(i) for i in range(len(a)) if a[i] != b[i] and i not in BOOK]


def _edit(body, conv=None, rows=()):
    cs, cur = C.decode(body)
    c = C.ConvScan(**{**vars(cs), **conv}) if conv else None
    return C.encode(body, c, [C.ModeScan(**{**vars(cur[m - 1]), **kw}) for m, kw in rows])


@pytest.mark.parametrize("base,want,conv,rows", [
    # 617ASQ (VHF) Op Select: one radio-wide list, <SELMOD> listed
    ("asq_base", "asq_selmod_pri1", dict(priority_1="SELMOD", priority_2=None), ()),
    ("asq_base", "asq_selmod_npri", dict(priority_1=None, priority_2=None), ()),
    ("asq_base", "asq_m1_pri1", dict(priority_1=1), ()),
    ("asq_base", "asq_m1_npri", dict(modes=[1]), ()),
    ("asq_base", "asq_m2_pri1", dict(priority_1=2), ()),
    ("asq_base", "asq_m3_npri", dict(modes=[3]), ()),
    # per-mode SCAN settings (record +20)
    ("asq_base", "asq_m1_override", None, [(1, dict(scan_button_control="Override"))]),
    ("asq_base", "asq_m1_coded_dis", None, [(1, dict(coded_squelch_scan="Disabled"))]),
    ("asq_base", "asq_m1_talkback_dis", None, [(1, dict(talkback_scan="Disabled"))]),
    ("asq_mode_base", "asq_m1_scan_dis", None, [(1, dict(scan="Disabled"))]),
    # both Mode Slave: lists after each record, no <SELMOD>, a mode on its own
    # list, the radio-wide list mirrors mode 1's (not the home mode's)
    ("asq_ms_home3_base", "asq_ms_home3_after", None,
     [(1, dict(priority_2=2, modes=[1])), (2, dict(modes=[2])), (3, dict(priority_2=2, modes=[3]))]),
    ("asq_ms_base", "asq_ms_m2edit", None, [(1, dict(modes=[1])), (2, dict(priority_2=2, modes=[4]))]),
    # Non-Priority Mode Slave + Priority Op Select: shared priorities in every record
    ("asq_nps_base", "asq_nps_selmod_pri1", dict(priority_1="SELMOD", priority_2=None),
     [(10, dict(modes=[10]))]),
    ("asq_nps_m2_none", "asq_nps_m2_npri", None, [(1, dict(modes=[1, 2]))]),
    # Non-Priority Op Select + Priority Mode Slave: per-mode priorities (RSS left
    # Pri 1 = 4 from its Pri 1 -> N Pri cycling)
    ("asq_ps_base", "asq_ps_after", None, [(1, dict(priority_1=4, priority_2=3))]),
    # 900 (604AUN zones off): Mode Slave on a 27-byte record (sum at +26)
    ("aunoff_base", "aunoff_m1_pri2self", None, [(1, dict(priority_2=1, modes=[]))]),
    ("aunoff_base", "aunoff_m2_pri2", None, [(1, dict(priority_2=2))]),
    ("aunoff_base", "aunoff_m2_npri", None, [(1, dict(modes=[1, 2]))]),
    ("aunoff_base", "aunoff_m4_npri", None, [(1, dict(modes=[1, 4]))]),
    ("aunoff_opt_base", "aunoff_m1_active", None, [(1, dict(scan_button_control="Active"))]),
    ("aunoff_opt_base", "aunoff_m1_coded_dis", None, [(1, dict(coded_squelch_scan="Disabled"))]),
    ("aunoff_mode_scandis", "aunoff_m1_scan_en", None, [(1, dict(scan="Enabled"))]),
    # 604ATY (128 modes): the Op Select list holds mode numbers, RSS appends
    ("aty_base", "aty_m1_npri", dict(priority_1=None, modes=[3, 6, 31, 1]), ()),
    ("aty_base", "aty_m1_none", dict(priority_1=None), ()),
    ("aty_base", "aty_m3_none", dict(modes=[6, 31]), ()),
    ("aty_m3_none", "aty_m3_readd", dict(modes=[6, 31, 3]), ()),
    ("aty_base", "aty_m1_override", None, [(1, dict(scan_button_control="Override"))]),
    ("aty_base", "aty_m1_coded_dis", None, [(1, dict(coded_squelch_scan="Disabled"))]),
    ("aty_tb_base", "aty_m1_talkback_en", None, [(1, dict(talkback_scan="Enabled"))]),
    ("aty_mode_scandis", "aty_m1_scan_en", None, [(1, dict(scan="Enabled"))]),
])
def test_scan_edits_match_rss(base, want, conv, rows):
    assert _diff(_edit(_gt(f"rss_{base}"), conv, rows), _gt(f"rss_{want}")) == []


@pytest.mark.parametrize("base,want,fn", [
    ("asq_sw_base", "asq_sw_npslave", lambda b: C.set_list_types(b, "Mode Slave", "Op Select")),
    ("asq_sw_base", "asq_sw_pslave", lambda b: C.set_list_types(b, "Op Select", "Mode Slave")),
    ("asq_sw2_base", "asq_sw_bothslave", lambda b: C.set_list_types(b, "Mode Slave", "Mode Slave")),
    ("asq_sw3_base", "asq_sw_back_opsel", lambda b: C.set_list_types(b, "Op Select", "Op Select")),
    ("aty59_base", "aty59_pslave", lambda b: C.set_list_types(b, "Op Select", "Mode Slave")),
    ("aty59_base", "aty59_talkgroup", lambda b: C.set_scan_type(b, "Talkgroup")),
    ("aty59_talkgroup", "aty59_tg_back", lambda b: C.set_scan_type(b, "Pri Tlkgr")),
])
def test_repacks_match_rss(base, want, fn):
    assert _diff(fn(_gt(f"rss_{base}")), _gt(f"rss_{want}")) == []


def test_decode_matches_rss_screens():
    cs, rows = C.decode(_gt("rss_asq_base"))            # 617ASQ CONVENTIONAL + list
    assert (cs.scan_type, cs.non_priority_list, cs.priority_list) == ("Channel", "Op Select", "Op Select")
    assert (cs.priority_1, cs.priority_2, cs.modes, cs.members()) == (None, "SELMOD", [], 1)
    assert (rows[0].scan, rows[0].scan_button_control, rows[0].coded_squelch_scan,
            rows[0].talkback_scan, rows[0].modes) == ("Enabled", "Active", "Enabled", "Enabled", None)
    cs, _ = C.decode(_gt("rss_aty_base"))                # 604ATY: Pri Tlkgr, 1 Pri 1, 2 Pri 2
    assert (cs.scan_type, cs.priority_1, cs.priority_2, cs.modes, cs.members()) == \
        ("Pri Tlkgr", 1, 2, [3, 6, 31], 6)
    cs, rows = C.decode(_gt("rss_aunoff_mode_scandis"))  # zones-off 900, no mode scans:
    assert (cs.scan_type, cs.non_priority_list, cs.priority_list) == \
        ("Disabled", "Mode Slave", "Mode Slave")          # RSS: SCAN TYPE Disabled
    assert C.decode(_gt("rss_aunoff_base"))[0].scan_type == "Pri Tlkgr"   # mode 1 scans
    assert C.decode(_gt("rss_aty59_talkgroup"))[0].scan_type == "Talkgroup"
    assert Codeplug.parse(_gt("rss_aty59_talkgroup")).band == "900"   # +2 b4 is not a VHF tag
    assert C.decode(_gt("rss_asq_ms_home3_after"))[1][2].modes == [3]


def test_unchanged_encode_is_byte_identical():
    for name in ("rss_asq_base", "rss_aty_base", "rss_aunoff_base", "rss_asq_ms_base",
                 "rss_asq_nps_base", "rss_asq_ps_base", "rss_aty59_talkgroup"):
        b = _gt(name)
        cs, rows = C.decode(b)
        assert C.encode(b, cs, rows) == b


def _rss_record(after_body, number):
    t = mode_pointer_table(after_body)[2][number - 1]
    return after_body[t:t + after_body[0x10A]]


@pytest.mark.parametrize("tag,bug", [
    # RSS ADD MODE renumbers every list member except the one numbered after+1
    # (old mode 2 stays "2": the new mode inherits its membership); motreader
    # renumbers it too -- the one differing byte, deliberate
    ("asq_opadd", ["0x65b"]), ("asq_msadd", ["0x5ed"]), ("aun_msadd", ["0x758"]),
])
def test_add_mode_renumbers_lists_like_rss_except_its_off_by_one(tag, bug):
    base, want = _gt(f"rss_{tag}_base"), _gt(f"rss_{tag}_after")
    got = M._change(base, after=1, record=_rss_record(want, 2), name=M.default_name(2))
    assert _diff(got, want) == bug


def test_add_mode_renumbering_details():
    cs, rows = C.decode(M.add_mode(_gt("rss_asq_opadd_base"), 1))
    assert (cs.priority_1, cs.priority_2, cs.modes) == (4, "SELMOD", [3, 6, 10])
    _, rows = C.decode(M.add_mode(_gt("rss_asq_msadd_base"), 1))
    assert [(r.mode, r.priority_1, r.priority_2, r.modes) for r in rows if r.modes] == \
        [(1, 4, None, [1, 5, 8]), (6, None, 10, [3, 6]), (11, None, None, [1, 11])]
    out = M.add_mode(_gt("rss_aun_msadd_base"), 1)      # 48 -> 49 modes: W 6 -> 7
    assert out[0x10A] == 36
    _, rows = C.decode(out)
    assert rows[1].modes == [] and rows[2].modes == [3, 49] and rows[48].priority_2 == 4


@pytest.mark.parametrize("tag,mode,bug", [
    ("asq_opdel", 5, []), ("asq_msdel", 4, []),
    # 900 Mode Slave: RSS shifts later members down by two (10 -> 8, 48 -> 46)
    ("aun_msdel", 3, ["0x6f8", "0x6f9", "0x720", "0xd47", "0xd52", "0xd53"]),
])
def test_delete_mode_renumbers_lists(tag, mode, bug):
    got = M.delete_mode(_gt(f"rss_{tag}_base"), mode)
    assert _diff(got, _gt(f"rss_{tag}_after")) == bug
    if tag == "aun_msdel":
        _, rows = C.decode(got)
        assert [(r.mode, r.priority_1, r.priority_2, r.modes) for r in rows if r.modes] == \
            [(1, None, None, [1, 9]), (2, 1, None, [2, 47]), (47, None, None, [47])]


def test_zone_scan_list_insert_is_renumbered_correctly_by_rss_too():
    base, want = _gt("rss_asn_zscanins_base"), _gt("rss_asn_zscanins_after")
    got = M._change(base, after=5, record=_rss_record(want, 6), name=M.default_name(6), zones=(2,))
    assert _diff(got, want) == []


@pytest.mark.parametrize("base,kw,match", [
    ("asq_base", dict(conv=dict(modes=list(range(1, 11)), priority_1=None, priority_2=None)), None),
    ("aty_base", dict(conv=dict(modes=list(range(3, 18)))), "18 members"),
    ("asq_base", dict(conv=dict(priority_1="SELMOD")), "Priority 1 and Priority 2"),
    ("asq_base", dict(conv=dict(modes=[11])), r"no mode\(s\) \[11\]"),
    ("asq_base", dict(conv=dict(non_priority_list="Mode Slave")), "set_list_types"),
    ("asq_ms_base", dict(rows=[(1, dict(priority_1="SELMOD"))]), "no <SELMOD>"),
    ("asq_ms_base", dict(rows=[(1, dict(modes=list(range(1, 11)), priority_1=None))]), None),
    ("asq_base", dict(rows=[(1, dict(scan="Maybe"))]), "not Enabled / Disabled"),
])
def test_refusals(base, kw, match):
    b = _gt(f"rss_{base}")
    if match is None:
        _edit(b, kw.get("conv"), kw.get("rows", ()))
        return
    with pytest.raises(ValueError, match=match):
        _edit(b, kw.get("conv"), kw.get("rows", ()))


def test_mode_slave_list_always_holds_its_mode():
    out = _edit(_gt("rss_asq_ms_base"), rows=[(4, dict(modes=[7]))])
    assert C.decode(out)[1][3].modes == [4, 7]


def test_scan_type_refusals():
    with pytest.raises(ValueError, match="900 MHz"):
        C.set_scan_type(_gt("rss_asq_base"), "Talkgroup")
    with pytest.raises(ValueError, match="Mode Slave"):
        C.set_list_types(_gt("rss_aty59_talkgroup"), "Op Select", "Op Select")
    with pytest.raises(ValueError, match="above 120 modes"):
        C.set_list_types(_gt("rss_aty_base"), "Mode Slave", "Op Select")


ARCHIVE_DIR = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")
# motreader edits RSS GET-loaded with no warning, displayed as set and
# re-saved byte-identically (motreader_<tag>_get.json / _rss_resaved)
VALIDATED = {
    "asqop": ("a617asq1.266", None, dict(priority_1=4, priority_2="SELMOD", modes=[2, 7, 9]),
              [(3, dict(scan="Disabled")),
               (5, dict(talkback_scan="Disabled", scan_button_control="Override"))]),
    "asqms": ("a617asq1.266", ("Mode Slave", "Mode Slave"), None,
              [(2, dict(priority_1=8, modes=[2, 5])), (10, dict(coded_squelch_scan="Disabled"))]),
    "aunms": ("modeops_rss/aunoff_source.plain.bin", None, None,
              [(1, dict(scan="Enabled", priority_2=7, modes=[1, 4, 20])), (30, dict(scan="Enabled"))]),
    "atyop": ("a604aty0.472", None, dict(priority_1=5, priority_2=None, modes=[3, 31, 100, 128]),
              [(1, dict(scan="Enabled"))]),
}


@pytest.mark.parametrize("tag", sorted(VALIDATED))
def test_motreader_edits_load_in_rss_and_resave_identically(tag):
    from motreader.archive import Archive
    from motreader.crypto import decrypt_body
    src, lists, conv, rows = VALIDATED[tag]
    if src.endswith(".plain.bin"):
        with open(os.path.join(os.path.dirname(GT), src), "rb") as f:
            body = f.read()
    else:
        p = os.path.join(ARCHIVE_DIR, src)
        if not os.path.exists(p):
            pytest.skip("archive not present")
        body = decrypt_body(Archive.load(p).body)
    if lists:
        body = C.set_list_types(body, *lists)
    out = _edit(body, conv, rows)
    with open(os.path.join(GT, f"motreader_{tag}_get.json")) as f:
        shown = json.load(f)
    assert shown["get_warnings"] == []
    assert _diff(out, _gt(f"motreader_{tag}_rss_resaved")) == []
    count = next(r for rows_ in shown["screens"].values() for r in rows_ if "List = " in r)
    cs, ms = C.decode(out)
    n = cs.members() if cs.non_priority_list == "Op Select" else \
        len(ms[0].modes) + sum(1 for p in (ms[0].priority_1, ms[0].priority_2) if p)
    assert f"List = {max(n, 1):02d} of" in count          # the mode-1 list screen


def test_cli_export_import_round_trip(tmp_path):
    """modes.csv scan columns + radio.yaml conventional_scan, then a list-type
    switch in a second import (lists then come from the re-pack)."""
    import csv
    import yaml
    from motreader import cli
    from motreader.archive import Archive
    from motreader.crypto import decrypt_body
    src = os.path.join(ARCHIVE_DIR, "a617asq1.266")
    if not os.path.exists(src):
        pytest.skip("archive not present")
    out = tmp_path / "ex"
    cli.export(src, str(out))
    rows = list(csv.DictReader(open(out / "modes.csv")))
    rows[2]["scan"] = "Disabled"
    rows[4]["talkback_scan"] = "Disabled"
    with open(out / "modes.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
    y = yaml.safe_load(open(out / "radio.yaml"))
    y["conventional_scan"].update(priority_1=4, modes=[2, 7, 9])
    yaml.safe_dump(y, open(out / "radio.yaml", "w"), sort_keys=False)
    cli.do_import(src, str(out), str(tmp_path / "a.266"))
    a = decrypt_body(Archive.load(str(tmp_path / "a.266")).body)
    cs, ms = C.decode(a)
    assert (cs.priority_1, cs.priority_2, cs.modes) == (4, "SELMOD", [2, 7, 9])
    assert (ms[2].scan, ms[4].talkback_scan) == ("Disabled", "Disabled")
    y["conventional_scan"].update(non_priority_list="Mode Slave", priority_list="Mode Slave")
    yaml.safe_dump(y, open(out / "radio.yaml", "w"), sort_keys=False)
    cli.do_import(str(tmp_path / "a.266"), str(out), str(tmp_path / "b.266"))
    b = decrypt_body(Archive.load(str(tmp_path / "b.266")).body)
    assert b == C.set_list_types(a, "Mode Slave", "Mode Slave")
