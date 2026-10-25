"""Independent Rx / Tx / T·A squelch codes (both bands) vs RSS.

900 MHz: three tone slots per mode at true record +14/+16/+18 (motreader view
+25/+27/+29), the VHF slot codec. Cracked by stepping each code of 566AYA mode 2
in RSS (notes/ground-truth/tones_rss/566AYA0014_mode2_*.plain.bin)."""

import json
import os
import re

import pytest

from motreader.archive import Archive
from motreader.codeplug import Codeplug, mode_pointer_table
from motreader.crypto import decrypt_body

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GT = os.path.join(ROOT, "notes", "ground-truth", "tones_rss")
ARCHIVE_DIR = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")
BOOK = set(range(0, 13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} \
    | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))
# (RSS save name, edit RSS made on mode 2), in order
STEPS = [("tx", {"tx_pl": "136.5"}), ("ta", {"ta_pl": "136.5"}), ("rx", {"rx_pl": "136.5"}),
         ("txtype", {"tx_pl": None, "tx_squelch_type": "Carrier"}),
         ("txdpl", {"ta_pl": None, "ta_squelch_type": "Carrier"})]


def _gt(name):
    with open(os.path.join(GT, name), "rb") as f:
        return f.read()


def test_rss_tone_edits_decode_and_replay_byte_exact():
    prev = _gt("566AYA0014_mode2_base.plain.bin")
    for name, change in STEPS:
        want = _gt(f"566AYA0014_mode2_{name}.plain.bin")
        cp = Codeplug.parse(prev)
        for k, v in change.items():
            setattr(cp.modes[1], k, v)
        got = bytes(cp.rebuild())
        assert [hex(i) for i in range(len(got)) if got[i] != want[i] and i not in BOOK] == [], name
        prev = want
    m = Codeplug.parse(prev).modes[1]
    assert (m.rx_squelch_type, m.rx_pl) == ("PL", "136.5")
    assert (m.tx_squelch_type, m.tx_pl) == ("Carrier", None)
    assert (m.ta_squelch_type, m.ta_pl) == ("Carrier", None)


@pytest.mark.parametrize("prn,fn", [("modesummary_617asn1665.prn", "a617asn1.665"),
                                    ("modesummary_604aty0472.prn", "a604aty0.472")])
def test_900_rx_tx_codes_match_rss_mode_summary(prn, fn):
    """Rx and Tx codes are independent (e.g. 617ASN mode 6: Rx 411, Tx blank)."""
    p = os.path.join(ARCHIVE_DIR, fn)
    if not os.path.exists(p):
        pytest.skip("archive not present")
    cp = Codeplug.parse(decrypt_body(Archive.load(p).body))
    with open(os.path.join(ROOT, "notes", "ground-truth", prn), encoding="latin-1") as f:
        lines = f.read().splitlines()
    cr = next(l for l in lines if "Rx Code" in l).index("Rx Code")
    seen = {}
    for l in lines:
        mm = re.match(r"\s*(\d{3})\s{2,}\S", l)
        if mm and "Rx Code" not in l and int(mm.group(1)) not in seen:
            codes = [x for x in l[cr - 2:].split() if re.fullmatch(r"\d+(\.\d)?", x)]
            seen[int(mm.group(1))] = (codes + ["", ""])[:2]
    norm = lambda c: (c or "").lstrip("D")
    got = {m.number: [norm(m.rx_pl), norm(m.tx_pl)] for m in cp.modes}
    assert {n: got[n] for n in seen} == seen


def test_motreader_split_tones_show_in_rss_and_resave_identically():
    with open(os.path.join(GT, "566AYA0014_motreader_split_tones_get.json")) as f:
        g = json.load(f)
    assert g["get_warnings"] == []
    rows = [r.strip() for r in g["screens"]["f4,f5,f4,f4"]]
    assert "Rx CODE................100.0 1Z" in rows
    assert "Tx SQUELCH TYPE..............DPL" in rows and "Tx CODE.....................023" in rows
    assert "TA Code................123.0 3Z" in rows
    with open(os.path.join(GT, "617ASQ1266_motreader_ta_tone_get.json")) as f:
        rows = [r.strip() for r in json.load(f)["screens"]["f4,f5"]]
    assert "TA Code................88.5  YB" in rows                 # VHF T·A slot
    # motreader's split-tone 566AYA: RSS's GET + re-SAVE is byte-identical
    p = os.path.join(ARCHIVE_DIR, "a566aya0.014")
    if not os.path.exists(p):
        pytest.skip("archive not present")
    cp = Codeplug.parse(decrypt_body(Archive.load(p).body))
    m = cp.modes[2]
    m.rx_pl, m.rx_squelch_type = "100.0", "PL"
    m.tx_pl, m.tx_squelch_type = "D023", "DPL"
    m.ta_pl, m.ta_squelch_type = "123.0", "PL"
    out = bytes(cp.rebuild())
    rss = _gt("566AYA0014_motreader_split_tones_rss_resaved.plain.bin")
    assert [hex(i) for i in range(len(out)) if out[i] != rss[i] and i not in BOOK] == []
