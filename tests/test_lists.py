"""Phone list, phone options and MPL list: decode vs RSS screens (every on-hand
radio) + write path."""

import json
import os
import re

import pytest

from motreader import lists as L
from motreader import radiowide as RW
from motreader.archive import Archive
from motreader.codeplug import Codeplug
from motreader.crypto import decrypt_body

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ARCHIVE_DIR = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")
GT_DIR = os.path.join(ROOT, "notes", "ground-truth")
RADIOS = {
    "566AYA0014": "a566aya0.014",
    "617ASN1767": "a617asn1.767",
    "604AUN0331": "a604aun0.331",
    "604ATY0472": "a604aty0.472",
    "617ASQ1266": "a617asq1.266",
    "221AZN0035": "a221azn0.035",
}
PHONE_PATH = "f4,f3,f7"
PHONE_OPT_PATH = "f4,f3,f7,f9"
MPL_PATH = "f4,f3,f6"


def _cp(fn):
    p = os.path.join(ARCHIVE_DIR, fn)
    if not os.path.exists(p):
        pytest.skip(f"{fn} not present")
    return Codeplug.parse(decrypt_body(Archive.load(p).body))


def _screens(serial):
    with open(os.path.join(GT_DIR, f"lists_{serial}.json")) as f:
        return json.load(f)["screens"]


def _value(rows, label):
    """Raw text after `label` and its dot leader (None if the label is absent)."""
    for r in rows[3:22]:
        m = re.search(re.escape(label) + r"\.+(.*)$", r)
        if m:
            return m.group(1).rstrip()
    return None


def _phone_rows(rows):
    """[(name, number)] from the PHONE LIST screen (name col 6, number col 20)."""
    out = []
    for r in rows:
        if len(r) > 6 and r[:6].strip().isdigit() and r[3] != " ":
            out.append((r[6:20].rstrip(), r[20:].strip()))
    return out


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_phone_list_matches_rss(serial):
    cp = _cp(RADIOS[serial])
    rows = _screens(serial)[PHONE_PATH]
    if "PHONE LIST" not in "\n".join(rows):
        pytest.skip("phone list not shown on this model (PHONE Is Disabled)")
    shown = _phone_rows(rows)
    assert len(shown) == L.PHONE_COUNT
    assert [(p.name, p.dial) for p in L.decode_phones(cp)] == shown


PHONE_OPT_LABELS = {
    "phone_access_code": "ACCESS CODE",
    "phone_release_code": "RELEASE CODE",
    "phone_digit_time_ms": "DIGIT TIME (mSec)",
    "phone_interdigit_time_ms": "INTERDIGIT TIME (mSec)",
    "phone_system_delay_ms": "SYSTEM DELAY (mSec)",
}


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_phone_options_match_rss(serial):
    cp = _cp(RADIOS[serial])
    rows = _screens(serial)[PHONE_OPT_PATH]
    if "PHONE LIST OPTIONS" not in "\n".join(rows):
        pytest.skip("phone options not shown on this model")
    dec = RW.decode(cp.body)
    for key, label in PHONE_OPT_LABELS.items():
        shown = (_value(rows, label) or "").strip()
        want = dec[key]
        if isinstance(want, int):
            assert int(shown) == want, (key, shown, want)
        else:
            assert shown == want, (key, shown, want)


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_mpl_list_matches_rss(serial):
    cp = _cp(RADIOS[serial])
    screens = _screens(serial)
    mpls = L.decode_mpls(cp)
    if cp.body[0x119] == 0:
        assert mpls == []
        return
    assert len(mpls) == cp.body[0x119]
    for m in mpls:
        rows = screens[MPL_PATH + ",f4" * (m.number - 1)]
        assert f"MPL {m.number:02d}" in "\n".join(rows)
        assert _value(rows, "MPL Name").strip() == m.name.strip(), m
        for sq, lab in (("rx", "RX"), ("tx", "TX"), ("ta", "TA")):
            typ = _value(rows, f"{lab} Squelch Type").strip()
            assert typ == getattr(m, sq + "_type"), (m, sq, typ)
            code_lab = "TA Code" if lab == "TA" else f"{lab.capitalize()} Code"
            code = (_value(rows, code_lab) or "").split()
            assert (code[0] if code else "") == getattr(m, sq + "_code"), (m, sq, code)


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_unchanged_lists_encode_identical(serial):
    cp = _cp(RADIOS[serial])
    out = bytearray(cp.body)
    L.encode_phones(cp, out, L.decode_phones(cp))
    L.encode_mpls(cp, out, L.decode_mpls(cp))
    assert bytes(out) == cp.body


def test_phone_and_mpl_edits_touch_only_their_bytes():
    cp = _cp(RADIOS["221AZN0035"])
    out = bytearray(cp.body)
    ph = L.decode_phones(cp)
    ph[5].dial, ph[5].name = "9P555#*1", "TEST PH"
    L.encode_phones(cp, out, ph)
    mp = L.decode_mpls(cp)
    mp[1].rx_type, mp[1].rx_code = "TPL", "88.5"
    L.encode_mpls(cp, out, mp)
    diff = {i for i in range(len(out)) if out[i] != cp.body[i]}
    assert diff and diff <= L.phone_offsets(cp) | L.mpl_offsets(cp)
    cp2 = Codeplug.parse(bytes(out))
    assert (L.decode_phones(cp2)[5].name, L.decode_phones(cp2)[5].dial) == ("TEST PH", "9P555#*1")
    assert (L.decode_mpls(cp2)[1].rx_type, L.decode_mpls(cp2)[1].rx_code) == ("TPL", "88.5")


def test_a9_head_checksum_reproduces_rss():
    """RSS's own saves (221AZN): renaming phone 6 'CONT W6EL 9' -> all 'Z' moved
    the checksum bytes a1 14 -> 51 77 (odd-lane overflow, no carry out); renaming
    zone 2 'FT..' -> 'ZZ..' moved them to b5 1a. A borrow in the even (low) lane must reach
    the odd (high) byte: motreader's zone 2 -> 'ZTEST' edit only GET-loaded
    cleanly once carried (41bd for the full validated edit set below)."""
    cp = _cp(RADIOS["221AZN0035"])
    assert L.a9_head_checksum_off(cp) == 0xDAF
    for off, new, want in ((0x1A05, b"ZZZZZZZZZZZ", "5177"), (0x1B4F, b"ZZ", "b51a")):
        out = bytearray(cp.body)
        out[off:off + len(new)] = new
        L.fix_a9_head_checksum(cp, out)
        assert out[0xDAF:0xDB1].hex() == want


def test_non_a9_heads_have_no_head_checksum():
    for serial in ("566AYA0014", "617ASN1767", "617ASQ1266"):
        cp = _cp(RADIOS[serial])
        out = bytearray(cp.body)
        L.fix_a9_head_checksum(cp, out)
        assert out == cp.body and L.a9_head_checksum_off(cp) is None


# The exact edit set motreader applied to 221AZN0035 for the real-RSS check
# (2026-10-23): the archive GET-loaded with NO warning and RSS displayed every
# value (notes/ground-truth/lists_221AZN0035_edited.json).
RSS_VALIDATED_PHONES = {6: ("TEST PH", "9P555#*1"), 9: ("LAST NODE N", "1234567890123456")}
RSS_VALIDATED_MPLS = {
    2: ("TONE 2X", "TPL", "88.5", "DPL", "754", "INV.DPL", "023"),
    3: ("TONE 03", "DPL", "311", "Carrier", "", "Carrier", ""),
}
RSS_VALIDATED_RW = {"phone_access_code": "123", "phone_release_code": "#9",
                    "phone_digit_time_ms": 300, "phone_interdigit_time_ms": 120,
                    "phone_system_delay_ms": 1000}


def test_list_edits_match_real_rss_display():
    cp = _cp(RADIOS["221AZN0035"])
    # modes/zones edited in the same validated archive
    m = {x.number: x for x in cp.modes}
    m[2].tx_squelch_type, m[2].tx_pl = "DPL", "D311"
    m[3].tx_squelch_type, m[3].tx_pl = "INV.DPL", "D023"
    m[4].rx_squelch_type, m[4].rx_pl = "DPL", "D754"
    m[5].name = "A9 TEST NM"
    cp.zones[1].name = "ZTEST"
    cp.zones[1].modes = sorted(set(cp.zones[1].modes) | {1})
    out = bytearray(cp.rebuild())
    ph = L.decode_phones(cp)
    for n, (name, dial) in RSS_VALIDATED_PHONES.items():
        ph[n - 1].name, ph[n - 1].dial = name, dial
    L.encode_phones(cp, out, ph)
    mp = L.decode_mpls(cp)
    for n, vals in RSS_VALIDATED_MPLS.items():
        mp[n - 1] = L.Mpl(n, *vals)
    L.encode_mpls(cp, out, mp)
    out = RW.encode(bytes(out), RSS_VALIDATED_RW)
    L.fix_a9_head_checksum(Codeplug.parse(cp.body), out)
    assert out[0xDAF:0xDB1].hex() == "41bd"     # the checksum RSS accepted

    with open(os.path.join(GT_DIR, "lists_221AZN0035_edited.json")) as f:
        gt = json.load(f)
    assert gt["get_warnings"] == []
    screens = gt["screens"]
    new = Codeplug.parse(bytes(out))
    assert [(p.name, p.dial) for p in L.decode_phones(new)] == _phone_rows(screens[PHONE_PATH])
    dec = RW.decode(new.body)
    for key, label in PHONE_OPT_LABELS.items():
        shown = (_value(screens[PHONE_OPT_PATH], label) or "").strip()
        assert str(dec[key]) == shown, (key, shown)
    for mm in L.decode_mpls(new)[:3]:
        rows = screens[MPL_PATH + ",f4" * (mm.number - 1)]
        assert _value(rows, "MPL Name").strip() == mm.name
        for sq, lab in (("rx", "RX"), ("tx", "TX"), ("ta", "TA")):
            assert _value(rows, f"{lab} Squelch Type").strip() == getattr(mm, sq + "_type")
