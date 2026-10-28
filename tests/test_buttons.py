"""Control-head button map: decode vs RSS KEYPAD screens + write path."""

import json
import os

import pytest

from motreader import buttons as B
from motreader.archive import Archive
from motreader.codeplug import Codeplug
from motreader.crypto import decrypt_body

HERE = os.path.dirname(os.path.abspath(__file__))
GT_DIR = os.path.join(os.path.dirname(HERE), "notes", "ground-truth")
ARCHIVE_DIR = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")
RADIOS = {"566AYA0014": "a566aya0.014", "617ASN1767": "a617asn1.767",
          "604AUN0331": "a604aun0.331", "604ATY0472": "a604aty0.472",
          "617ASQ1266": "a617asq1.266", "221AZN0035": "a221azn0.035"}
# KEYPAD screen cell (value row, column) per button, for the standard heads
CELLS = {"Ind 1": (8, 16), "Ind 2": (8, 24), "Ind 3": (8, 32), "Ind 4": (8, 40),
         "Ind 5": (8, 48), "1": (8, 56), "2": (8, 64), "3": (8, 72), "4": (12, 56),
         "5": (12, 64), "6": (12, 72), "7": (16, 56), "8": (16, 64), "9": (16, 72),
         "*": (20, 56), "0": (20, 64), "#": (20, 72)}


def _cp(serial):
    p = os.path.join(ARCHIVE_DIR, RADIOS[serial])
    if not os.path.exists(p):
        pytest.skip("archive not present")
    return Codeplug.parse(decrypt_body(Archive.load(p).body))


def _shown(serial):
    with open(os.path.join(GT_DIR, f"buttons_{serial}.json")) as f:
        rows = json.load(f)["screens"]["f4,f6,f2"]
    out = {}
    for name, (y, x) in CELLS.items():
        if rows[y - 2][max(0, x - 2):x + 7].strip():       # caption present
            seg = rows[y][max(0, x - 2):x + 7].split()
            if seg:
                out[name] = seg[0]
    return out


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_buttons_match_rss_keypad_screen(serial):
    cp = _cp(serial)
    dec = {b.button: b.function for b in B.decode_buttons(cp)}
    if serial == "221AZN0035":
        assert _a9_screen_matches(dec, "buttons_221AZN0035.json")
        return
    assert dec == _shown(serial)


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_unchanged_buttons_encode_identical(serial):
    cp = _cp(serial)
    out = bytearray(cp.body)
    B.encode_buttons(cp, out, B.decode_buttons(cp))
    assert bytes(out) == cp.body


def test_button_edit_touches_only_its_entry_and_refuses_duplicates():
    cp = _cp("566AYA0014")
    rows = B.decode_buttons(cp)
    by = {b.button: b for b in rows}
    by["1"].function = "Page"                 # key 1: Blank -> Page
    out = bytearray(cp.body)
    B.encode_buttons(cp, out, rows)
    assert [i for i in range(len(out)) if out[i] != cp.body[i]] == [0x147, 0x148]
    assert out[0x147:0x14B].hex() == "11030000"
    by["2"].function = "Page"                 # Page twice -> refused
    with pytest.raises(ValueError, match="duplicate"):
        B.encode_buttons(cp, bytearray(cp.body), rows)
    by["2"].function = "Blank"
    by["*"].function = "Scan"                 # fixed key -> refused
    with pytest.raises(ValueError, match="fixed"):
        B.encode_buttons(cp, bytearray(cp.body), rows)


# motreader edits, GET-loaded in real RSS with no warning and displayed exactly
# (notes/ground-truth/buttons_<serial>_edited.json, 2026-10-23).
RSS_VALIDATED = {
    "604AUN0331": {"Ind 4": "Siren", "3": "Wail", "0": "Emer", "6": "Blank"},
    "566AYA0014": {"1": "Page", "2": "MPL", "3": "H/L", "7": "Call"},
}


@pytest.mark.parametrize("serial", sorted(RSS_VALIDATED))
def test_button_edits_match_real_rss_display(serial):
    cp = _cp(serial)
    rows = B.decode_buttons(cp)
    for b in rows:
        b.function = RSS_VALIDATED[serial].get(b.button, b.function)
    out = bytearray(cp.body)
    B.encode_buttons(cp, out, rows)
    dec = {b.button: b.function for b in B.decode_buttons(Codeplug.parse(bytes(out)))}
    with open(os.path.join(GT_DIR, f"buttons_{serial}_edited.json")) as f:
        gt = json.load(f)
    assert gt["get_warnings"] == []
    rows_ = gt["screens"]["f4,f6,f2"]
    shown = {}
    for name, (y, x) in CELLS.items():
        if rows_[y - 2][max(0, x - 2):x + 7].strip():
            seg = rows_[y][max(0, x - 2):x + 7].split()
            if seg:
                shown[name] = seg[0]
    assert dec == shown


# ---- A9 / S9000e head (221AZN, motreader/buttons_a9.py) ----

A9_IND = ["Ind 1", "Ind 2", "Ind 3", "Ind 4", "Ind 5", "Ind 6"]
A9_LABELLED = ["Mode Dn", "Mode Up", "Vol Dn", "Vol Up", "Zone Up", "Home"]
A9_KEYROWS = {8: ["1", "2", "3"], 12: ["4", "5", "6"], 16: ["7", "8", "9"], 20: ["*", "0", "#"]}


def _norm(s):
    return " ".join(s.split())


def _a9_screen_matches(dec, gt_file):
    """The A9 KEYPAD screen: Ind 1-6 on row 8 and the labelled keys on row 18
    (cells overlap, so compare the row text), keypad cells at cols 53/62/71."""
    with open(os.path.join(GT_DIR, gt_file)) as f:
        rows = json.load(f)["screens"]["f4,f6,f2"]
    assert _norm(rows[8][:52]) == _norm(" ".join(dec[b] for b in A9_IND))
    assert _norm(rows[18][:52]) == _norm(" ".join(dec[b] for b in A9_LABELLED))
    for y, keys in A9_KEYROWS.items():
        assert [_norm(rows[y][c:c + 9]) for c in (53, 62, 71)] == [_norm(dec[k]) for k in keys]
    return True


# motreader edits on 221AZN (via the CLI path's encode), GET-loaded in real RSS
# with no warning and shown exactly; RSS's re-SAVE of it was byte-identical
# (notes/ground-truth/buttons_221AZN0035_edited.json, buttons_221AZN_rss/).
A9_EDITS = {"Ind 2": "Sts 3", "Ind 3": "Alt", "Ind 4": "Siren", "Ind 5": "Zone 4",
            "Ind 6": "Pass", "2": "Mode 3", "3": "Page-A", "5": "Msg 2", "7": "Phone",
            "9": "H/L", "Vol Dn": "Airhn", "Zone Up": "Emer"}
BOOKKEEPING = set(range(0, 13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} \
    | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))


def _a9_edited():
    cp = _cp("221AZN0035")
    rows = B.decode_buttons(cp)
    for b in rows:
        b.function = A9_EDITS.get(b.button, b.function)
    out = bytearray(cp.body)
    B.encode_buttons(cp, out, rows)
    return cp, bytes(out)


def test_a9_edits_match_real_rss_display_and_resave():
    cp, out = _a9_edited()
    dec = {b.button: b.function for b in B.decode_buttons(Codeplug.parse(out))}
    with open(os.path.join(GT_DIR, "buttons_221AZN0035_edited.json")) as f:
        assert json.load(f)["get_warnings"] == []
    assert dec["Ind 6"] == "Emp No"          # same bytes as Pass; RSS shows Emp No
    assert _a9_screen_matches(dec, "buttons_221AZN0035_edited.json")
    with open(os.path.join(GT_DIR, "buttons_221AZN_rss", "edited_rss_resaved.plain.bin"), "rb") as f:
        rss = f.read()
    assert [hex(i) for i in range(len(out)) if out[i] != rss[i] and i not in BOOKKEEPING] == []


def test_a9_edit_keeps_head_checksum_and_bitmap():
    from motreader import buttons_a9 as A
    from motreader.lists import a9_head_checksum_off
    cp, out = _a9_edited()
    ck = a9_head_checksum_off(cp)
    m, _s = A._layout(cp)
    # every changed byte is in the button areas or the checksum
    offs = B.button_offsets(cp) | {ck, ck + 1}
    assert all(i in offs for i in range(len(out)) if out[i] != cp.body[i])
    # Airhn (record 2nd byte 0x90) on Vol Dn (record 33) sets its bitmap bit
    assert out[m - A.BITMAP_LEN + 33 // 8] & (0x80 >> (33 % 8))


def test_a9_rules():
    cp = _cp("221AZN0035")
    rows = B.decode_buttons(cp)
    by = {b.button: b for b in rows}
    by["Ind 2"].function = "Scan"             # Ind 4 has Scan, both in RSS's dup scope
    with pytest.raises(ValueError, match="duplicate"):
        B.encode_buttons(cp, bytearray(cp.body), rows)
    by["Ind 2"].function = "Blank"
    by["Vol Up"].function = "Scan"            # labelled keys are outside RSS's dup check
    B.encode_buttons(cp, bytearray(cp.body), rows)
    by["Vol Up"].function = "Vol Up"
    for fixed in ("Ind 1", "Home", "*", "0", "#"):
        by[fixed].function = "Alt"
        with pytest.raises(ValueError, match="fixed"):
            B.encode_buttons(cp, bytearray(cp.body), rows)
        by[fixed].function = B.decode_buttons(cp)[list(by).index(fixed)].function
    by["1"].function = "Sql"                  # not offered on keypad keys
    with pytest.raises(ValueError, match="does not offer"):
        B.encode_buttons(cp, bytearray(cp.body), rows)
    by["1"].function = "Securenet"            # encryption: never offered
    with pytest.raises(ValueError, match="does not offer"):
        B.encode_buttons(cp, bytearray(cp.body), rows)
    by["1"].function = "Zone"                 # direct entry needs a number
    with pytest.raises(ValueError):
        B.encode_buttons(cp, bytearray(cp.body), rows)
    by["1"].function = "Blank"
    by["Mode Dn"].function = "V/A Up"         # alias: same bytes as Vol Up...
    out = bytearray(cp.body)
    B.encode_buttons(cp, out, rows)
    dec = {b.button: b.function for b in B.decode_buttons(Codeplug.parse(bytes(out)))}
    assert dec["Mode Dn"] == "Vol Up"         # ...decoded under RSS's GET name


# RSS cycle of 604AUN Ind 1 through every function (2026-10-28): Airhn on a
# button sets CHB+0x46 b4 (and the CHB checksum); taking it off clears it.
AIRHN_GT = os.path.join(GT_DIR, "buttons_604AUN_rss")


def _gt(name):
    with open(os.path.join(AIRHN_GT, f"{name}.plain.bin"), "rb") as f:
        return f.read()


@pytest.mark.parametrize("src,func,want", [
    ("ind1_xradb", "Airhn", "ind1_airhn"), ("ind1_airhn", "Siren", "ind1_siren")])
def test_airhn_sets_the_control_head_flag_as_rss_does(src, func, want):
    cp = Codeplug.parse(_gt(src))
    out = bytearray(cp.body)
    B.encode_buttons(cp, out, [B.Button("Ind 1", func)])
    rss = _gt(want)
    assert [i for i in range(len(rss)) if out[i] != rss[i] and i not in BOOKKEEPING] == []
