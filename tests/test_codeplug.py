"""Tests for codeplug decode and the export/import round-trip."""

import os

import pytest


def _diff(body, new):
    """Changed offsets, ignoring the mode records' 8-bit sums (rebuild keeps
    them valid, as RSS does)."""
    from motreader.codeplug import record_sum_offsets
    sums = record_sum_offsets(body)
    return [i for i in range(len(body)) if body[i] != new[i] and i not in sums]

from motreader.archive import Archive
from motreader.codeplug import Codeplug
from motreader.crypto import decrypt_body, encrypt_body

import glob

ARCHIVE_DIR = os.path.expanduser(
    "~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE"
)
SAMPLE = os.path.join(ARCHIVE_DIR, "a566aya0.014")
ASN = os.path.expanduser(
    "~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE/a617asn1.665"
)


def _cp():
    return Codeplug.parse(decrypt_body(Archive.load(SAMPLE).body))


def test_header_decoded():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    cp = _cp()
    assert cp.serial.startswith("566AYA")
    assert cp.model == "D37KGA5JB5FK"
    assert len(cp.modes) > 100


def test_band_detected_900():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    assert _cp().band == "900"


def test_rx_freq_matches_print():
    """Known RX frequencies from the RSS MODE SUMMARY print."""
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    cp = _cp()
    by_num = {m.number: m for m in cp.modes}
    assert by_num[2].rx_mhz == 927.0375
    assert by_num[3].rx_mhz == 927.25
    assert by_num[4].rx_mhz == 927.05


def test_900_tx_ta_match_print():
    """900 MHz TX / talk-around, byte-exact vs the RSS MODE SUMMARY print.

    These are 25 MHz repeater splits (TX = RX - 25, T/A = RX), but decoded from
    the real per-field codec (carry byte + lo/mid), not an assumed split.
    """
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    by_num = {m.number: m for m in _cp().modes}
    assert (by_num[2].tx_mhz, by_num[2].ta_mhz) == (902.0375, 927.0375)
    assert (by_num[3].tx_mhz, by_num[3].ta_mhz) == (902.25, 927.25)
    assert (by_num[6].tx_mhz, by_num[6].ta_mhz) == (902.525, 927.525)


ATY = os.path.expanduser(
    "~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE/a604aty0.472"
)


def test_604aty_variable_stride_layout():
    """604ATY is the 40-byte-record 900 layout, located structurally; decode is
    byte-exact vs RSS (repeater, simplex and empty slots)."""
    if not os.path.exists(ATY):
        pytest.skip("sample not present")
    cp = Codeplug.parse(decrypt_body(Archive.load(ATY).body))
    assert cp.band == "900"
    by = {m.number: m for m in cp.modes}
    # m3 repeater, m1 simplex (TX in the off21-23 field), m4 empty slot
    assert (by[3].rx_mhz, by[3].tx_mhz, by[3].ta_mhz) == (927.0625, 902.0625, 927.0625)
    assert (by[1].rx_mhz, by[1].tx_mhz, by[1].ta_mhz) == (927.85, 927.85, None)
    assert (by[4].rx_mhz, by[4].tx_mhz, by[4].ta_mhz) == (None, None, None)


def test_604aty_rebuild_identity():
    if not os.path.exists(ATY):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(ATY).body)
    cp = Codeplug.parse(body)
    assert encrypt_body(bytes(cp.rebuild())) == Archive.load(ATY).body


AZN = os.path.expanduser(
    "~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE/a221azn0.035"
)


def test_221azn_vhf_expanded_a9_head():
    """T83FWA (A9 / CONVENTIONAL EXPANDED head): VHF with 11-char ASCII mode
    names (not 6-bit), located structurally via frequency correlation. Byte-exact
    vs the RSS MODE SUMMARY for names, independent RX/TX/T·A, and Rx/Tx PL."""
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    cp = Codeplug.parse(decrypt_body(Archive.load(AZN).body))
    assert cp.band == "vhf"
    assert cp.model == "T83FWA7HA9AK"
    assert cp.ascii_names is not None and cp.ascii_names[1] == 11
    assert len(cp.modes) == 65
    by = {m.number: m for m in cp.modes}
    assert by[1].name == "146 520"
    assert by[23].name == "BONISPRG PD"  # 11-char name only the A9 head holds
    assert by[65].name == "APRS 144390"
    # independent split + PL (mode 5: +600 kHz repeater, 100.0 Hz PL both ways)
    assert (by[5].rx_mhz, by[5].tx_mhz, by[5].ta_mhz) == (147.195, 147.795, 147.195)
    assert (by[5].rx_pl, by[5].tx_pl) == ("100.0", "100.0")
    # encode-only PL (carrier-squelch RX): mode 8 Tx 136.5, Rx blank
    assert (by[8].rx_pl, by[8].tx_pl) == (None, "136.5")
    # NOAA weather mode: RX only, TX/T·A blank
    assert (by[50].rx_mhz, by[50].tx_mhz, by[50].ta_mhz) == (162.55, None, None)


def test_221azn_rebuild_identity():
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(AZN).body)
    cp = Codeplug.parse(body)
    assert bytes(cp.rebuild()) == body
    assert encrypt_body(bytes(cp.rebuild())) == Archive.load(AZN).body


def test_221azn_ascii_name_edit_is_surgical():
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(AZN).body)
    cp = Codeplug.parse(body)
    start, w = cp.ascii_names
    cp.modes[0].name = "W1AW TEST"
    new = bytes(cp.rebuild())
    diffs = _diff(body, new)
    assert all(start <= d < start + w for d in diffs)  # only mode-1's name field
    assert Codeplug.parse(new).modes[0].name == "W1AW TEST"


def test_221azn_option_flags_decode():
    """Per-mode option flags (power, uP xtal, MDC PTT ID, phone encode) mapped
    white-box via the harness differential (notes/FORMAT.md §5a)."""
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    cp = Codeplug.parse(decrypt_body(Archive.load(AZN).body))
    by = {m.number: m for m in cp.modes}
    assert (by[1].tx_power, by[1].ta_power) == ("High", "Low")
    assert by[1].up_xtal_shift == "Disabled"
    assert (by[1].mdc_ptt_id, by[1].phone_encode) == ("Enabled", "Enabled")
    assert by[1].mpl_type == "Disabled"
    assert by[13].ta_power == "High"            # the one programmed-TA High mode
    # RX-only NOAA weather mode: no TX/T·A, so power is not reported
    assert (by[50].tx_power, by[50].ta_power) == (None, None)


def test_221azn_option_flag_edit_is_surgical():
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(AZN).body)
    cp = Codeplug.parse(body)
    base = cp.modes[0].offset
    cp.modes[0].tx_power = "Low"          # High -> Low = clear bit6 of the TX tag
    new = bytes(cp.rebuild())
    diffs = _diff(body, new)
    assert diffs == [base + 9]            # only the TX tag byte, only that bit
    assert body[base + 9] ^ new[base + 9] == 0x40
    assert Codeplug.parse(new).modes[0].tx_power == "Low"


def test_221azn_mpl_type_all_values_roundtrip():
    """MPL Type is a 4-value enum in rec+3 bits5-6 (bit5=TX, bit6=RX); each value
    encodes to exactly those two bits and re-decodes, touching only that byte."""
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(AZN).body)
    base = Codeplug.parse(body).modes[0].offset
    for val in ("Disabled", "TX Only", "RX Only", "RX & TX"):
        cp = Codeplug.parse(body)
        cp.modes[0].mpl_type = val
        new = bytes(cp.rebuild())
        diffs = _diff(body, new)
        assert all(d == base + 3 for d in diffs)      # only the rec+3 flags byte
        assert new[base + 3] & 0x10 == body[base + 3] & 0x10  # uP Xtal bit preserved
        assert Codeplug.parse(new).modes[0].mpl_type == val


import re

# A-codeplug files look like a221azn0.035 (letter + 7 chars + "." + 3 digits).
_AFILE = re.compile(r"^[aA][0-9A-Za-z]{7}\.[0-9]{3}$")


def _all_a_archives():
    if not os.path.isdir(ARCHIVE_DIR):
        return []
    out = []
    for p in sorted(glob.glob(os.path.join(ARCHIVE_DIR, "*"))):
        b = os.path.basename(p)
        if not os.path.isfile(p) or not _AFILE.match(b):
            continue
        if "428twn" in b.lower():            # short-banner radio, never readable
            continue
        out.append(p)
    return out


@pytest.mark.parametrize("path", _all_a_archives())
def test_rebuild_preserves_every_byte(path):
    """The core safety guarantee: with no edits, rebuild() reproduces the source
    body byte-for-byte for EVERY on-hand radio — so any per-mode feature motreader
    does not understand is preserved exactly (a valid codeplug, safe values)."""
    body = decrypt_body(Archive.load(path).body)
    cp = Codeplug.parse(body)
    assert bytes(cp.rebuild()) == body, os.path.basename(path)


def test_single_field_edit_touches_only_that_mode():
    """Editing one field on one mode leaves every other mode byte-identical."""
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    cp = Codeplug.parse(body)
    target = cp.modes[1]
    lo, hi = target.offset, target.offset + len(target.raw)
    target.rx_mhz = (target.rx_mhz or 900.0) + 0.05
    new = bytes(cp.rebuild())
    outside = [i for i in range(len(body))
               if body[i] != new[i] and not (lo <= i < hi)]
    assert outside == [], [hex(i) for i in outside]


def test_900_mode_options_decode_and_edit():
    """900 per-mode options (Audio Compander etc.) mapped white-box via the
    harness: Compander rec+12 bit3, Adaptive Splatter rec+12 bit6, powers at
    rec+17/+21 bit6. Decode + bit-surgical encode, nothing else touched."""
    if not os.path.exists(ASN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(ASN).body)
    cp = Codeplug.parse(body)
    assert cp.band == "900"
    m0 = cp.modes[0]
    assert (m0.audio_compander, m0.adaptive_splatter) == ("Enabled", "Enabled")
    assert m0.tx_power == "High" and m0.up_xtal_shift == "Disabled"
    # across all modes the option genuinely varies (not a constant)
    comp = {m.audio_compander for m in cp.modes}
    assert comp == {"Enabled", "Disabled"}
    # surgical edit of Compander changes only rec+12
    base = m0.offset
    cp.modes[0].audio_compander = "Disabled"
    new = bytes(cp.rebuild())
    assert _diff(body, new) == [base + 12]
    assert new[base + 12] & 0x08 == 0            # bit3 cleared
    assert Codeplug.parse(new).modes[0].audio_compander == "Disabled"


def test_900_mode_screen_options_decode_and_edit():
    """900 MODE/OPT1 enums mapped white-box via the harness on 617ASN:
    MDC PTT ID rec+12 bit7, Phone Encode rec+12 bit5, Reverse Burst/TOC
    rec+11 bit2, UnMute/Mute Type rec+11 bits0-1, MPL Type rec+11 bits5-6.
    Decode matches the RSS screen; edits are bit-surgical (preserve the rest
    of the shared flag byte)."""
    if not os.path.exists(ASN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(ASN).body)
    cp = Codeplug.parse(body)
    m0 = cp.modes[0]
    # matches the RSS MODE / MODE OPT 1 screens for mode 1 (BUS 1)
    assert m0.mdc_ptt_id == "Disabled"
    assert m0.phone_encode == "Enabled"
    assert m0.reverse_burst_toc == "Enabled"
    assert m0.unmute_mute_type == "Std/Std"
    assert m0.mpl_type == "Disabled"
    base = m0.offset

    # MDC PTT ID -> Enabled sets only rec+12 bit7
    cp.modes[0].mdc_ptt_id = "Enabled"
    new = bytes(cp.rebuild())
    assert _diff(body, new) == [base + 12]
    assert new[base + 12] & 0x80
    assert Codeplug.parse(new).modes[0].mdc_ptt_id == "Enabled"

    # UnMute/Mute Type -> AND/OR sets rec+11 bits0-1 only, nothing else
    cp2 = Codeplug.parse(body)
    cp2.modes[0].unmute_mute_type = "AND/OR"
    new2 = bytes(cp2.rebuild())
    assert _diff(body, new2) == [base + 11]
    assert new2[base + 11] & 0x03 == 0x03
    assert Codeplug.parse(new2).modes[0].unmute_mute_type == "AND/OR"


def test_900_unmute_and_mpl_all_values_roundtrip():
    """Every mapped UnMute/Mute Type and 900 MPL Type value round-trips, and
    writing it touches only the shared rec+11 flag byte (bits outside the mask
    preserved)."""
    if not os.path.exists(ASN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(ASN).body)
    base = Codeplug.parse(body).modes[0].offset
    for col, values in (
        ("unmute_mute_type", ["Std/Std", "AND/Std", "AND/OR"]),
        ("mpl_type", ["Disabled", "TX Only", "RX Only", "RX & TX"]),
    ):
        for v in values:
            cp = Codeplug.parse(body)
            setattr(cp.modes[0], col, v)
            new = bytes(cp.rebuild())
            changed = _diff(body, new)
            assert changed in ([], [base + 11]), (col, v, changed)
            assert getattr(Codeplug.parse(new).modes[0], col) == v


def test_squelch_type_decode_both_bands():
    """Squelch type (Carrier/PL/DPL) is derived from the tone bytes and matches
    the RSS MODE SUMMARY ground truth. PL carries the CTCSS tone; DPL is flagged
    but its code is not guessed (rec+25 alone can't encode it); Carrier = no tone.
    Round-trip stays byte-identical (squelch type is read-only / derived)."""
    if os.path.exists(ASN):
        body = decrypt_body(Archive.load(ASN).body)
        cp = Codeplug.parse(body)
        by = {m.number: m for m in cp.modes}
        assert (by[1].rx_squelch_type, by[1].rx_pl) == ("PL", "162.2")   # 162.2 5B
        assert (by[6].rx_squelch_type, by[6].rx_pl) == ("DPL", "D411")   # GT: 411
        assert (by[8].rx_squelch_type, by[8].rx_pl) == ("Carrier", None) # GT: blank
        # 900 stores one code byte -> Rx and Tx report identically
        assert by[1].tx_squelch_type == "PL" and by[1].tx_pl == "162.2"
        assert bytes(cp.rebuild()) == body

    if os.path.exists(AZN):  # 221AZN VHF
        body = decrypt_body(Archive.load(AZN).body)
        by = {m.number: m for m in Codeplug.parse(body).modes}
        assert by[1].rx_squelch_type == "Carrier"                 # no tone
        assert (by[4].rx_squelch_type, by[4].rx_pl) == ("PL", "100.0")
        # encode-only PL: mode 8 Rx carrier, Tx PL 136.5
        assert by[8].rx_squelch_type == "Carrier"
        assert (by[8].tx_squelch_type, by[8].tx_pl) == ("PL", "136.5")


def test_900_dpl_decode_matches_ground_truth():
    """Every 900 DPL mode decodes to the exact octal code RSS prints, via the
    2-byte (rec+25, rec+26) DPL table. Validated against the MODE SUMMARY ground
    truth for the stride-26 radios (566AYA, 617ASN)."""
    import re
    for arch, gt in ((SAMPLE, "notes/ground-truth/modesummary_566aya.prn"),
                     (ASN, "notes/ground-truth/modesummary_617asn1665.prn")):
        if not (os.path.exists(arch) and os.path.exists(gt)):
            pytest.skip("sample/ground-truth not present")
        cp = Codeplug.parse(decrypt_body(Archive.load(arch).body))
        by = {m.number: m for m in cp.modes}
        checked = 0
        for l in open(gt).read().splitlines():
            m = re.match(r"\s*(\d{3})\s", l)
            if not m or len(l) < 60:
                continue
            num = int(m.group(1)); rx = l[51:60].strip()
            if not re.match(r"^\d{3}$", rx) or num not in by:  # DPL rows only
                continue
            mo = by[num]
            if mo.number == 1:   # 566AYA's special non-conventional slot
                continue
            assert mo.rx_squelch_type == "DPL"
            assert mo.rx_pl == "D" + rx, (arch, num, rx, mo.rx_pl)
            checked += 1
        assert checked >= 20   # plenty of DPL modes actually verified


def test_900_dpl_edit_is_surgical_and_roundtrips():
    """Changing a 900 Rx DPL code rewrites exactly the Rx tone slot (view
    +25,+26) and the record's 8-bit sum (true start + 25 = view +36); the Tx and
    T·A slots (view +27/+29) are independent and stay put, the next mode is
    undisturbed, and it re-decodes to the new code."""
    if not os.path.exists(ASN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(ASN).body)
    cp = Codeplug.parse(body)
    m = next(x for x in cp.modes if x.rx_squelch_type == "DPL")
    base = m.offset
    assert m.rx_pl == "D411"
    m.rx_pl = "D311"
    new = bytes(cp.rebuild())
    changed = [i for i in range(len(body)) if body[i] != new[i]]
    assert changed == [base + 25, base + 26, base + 36]
    re = Codeplug.parse(new)
    assert re.modes[m.number - 1].rx_pl == "D311"
    assert re.modes[m.number - 1].ta_pl == m.ta_pl == "D411"     # T·A untouched
    # the following mode kept its own code
    assert re.modes[m.number].rx_pl == cp.modes[m.number].rx_pl

    # unchanged DPL round-trips byte-identical (change-gated write)
    assert bytes(Codeplug.parse(body).rebuild()) == body


def test_vhf_dpl_codec_matches_rss_ground_truth():
    """VHF DPL/INV.DPL codec, cracked on 221AZN (T83FW) via the harness and
    validated byte-exact vs RSS: the code uses the same 83-value map as 900,
    stored big-endian in the 2-byte tone slot, with hi bit 0x20 = normal DPL vs
    INV.DPL. These (hi, lo) -> (type, code) points are captured RSS ground truth."""
    from motreader.codeplug import vhf_dpl_decode, vhf_dpl_encode, vhf_squelch_type
    normal = {"612": (0xf1, 0xa8), "627": (0xfd, 0xf4), "662": (0xfd, 0xa6),
              "703": (0xf9, 0xe1), "734": (0xe9, 0x9d), "754": (0xfd, 0x9b)}
    inverted = {"662": (0xdd, 0xa6), "703": (0xd9, 0xe1), "712": (0xd5, 0xa9),
                "734": (0xc9, 0x9d), "754": (0xdd, 0x9b)}
    for code, (hi, lo) in normal.items():
        assert vhf_squelch_type(hi, lo) == "DPL"
        assert vhf_dpl_decode(hi, lo) == ("DPL", "D" + code)
        assert vhf_dpl_encode("D" + code, inverted=False) == (hi, lo)
    for code, (hi, lo) in inverted.items():
        assert vhf_squelch_type(hi, lo) == "INV.DPL"
        assert vhf_dpl_decode(hi, lo) == ("INV.DPL", "D" + code)
        assert vhf_dpl_encode("D" + code, inverted=True) == (hi, lo)


def test_vhf_tx_dpl_polarity_matches_rss():
    """The polarity bit's sense is reversed in the TX slot. motreader writes of
    mode 2 Tx DPL 311 (d5 49, bit 0x20 clear) and mode 3 Tx INV.DPL 023 (f8 64,
    bit set) GET-loaded in RSS showing 'Tx DPL 311' / 'Tx INV.DPL 023'
    (notes/ground-truth/lists_221AZN0035_edited.json)."""
    from motreader.codeplug import vhf_dpl_decode, vhf_dpl_encode, vhf_squelch_type
    assert vhf_dpl_encode("D311", inverted=False, is_tx=True) == (0xd5, 0x49)
    assert vhf_dpl_encode("D023", inverted=True, is_tx=True) == (0xf8, 0x64)
    assert vhf_dpl_decode(0xd5, 0x49, True) == ("DPL", "D311")
    assert vhf_squelch_type(0xf8, 0x64, True) == "INV.DPL"
    # the RX sense is unchanged (0x20 set = DPL)
    assert vhf_dpl_decode(0xf8, 0x64) == ("DPL", "D023")


def test_vhf_dpl_edit_is_surgical_and_roundtrips():
    """Setting a VHF mode's Rx DPL code/polarity rewrites exactly the Rx tone
    slot (rec+17,+18) and nothing else; a polarity flip touches only the hi byte.
    Validated end-to-end in RSS: motreader DPL D311 + INV.DPL D023 edits GET-loaded
    and displayed 'Rx DPL 311' / 'Rx INV.DPL 023'."""
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(AZN).body)

    # Carrier -> DPL D311 (normal): only rec+17,+18 change
    cp = Codeplug.parse(body)
    base = cp.modes[1].offset
    assert cp.modes[1].rx_squelch_type == "Carrier"
    cp.modes[1].rx_squelch_type = "DPL"
    cp.modes[1].rx_pl = "D311"
    new = bytes(cp.rebuild())
    assert _diff(body, new) == [base + 17, base + 18]
    re = Codeplug.parse(new)
    assert (re.modes[1].rx_squelch_type, re.modes[1].rx_pl) == ("DPL", "D311")

    # polarity flip DPL -> INV.DPL (code unchanged): only the hi byte (rec+17)
    cp2 = Codeplug.parse(new)
    cp2.modes[1].rx_squelch_type = "INV.DPL"
    new2 = bytes(cp2.rebuild())
    assert _diff(new, new2) == [base + 17]
    re2 = Codeplug.parse(new2)
    assert (re2.modes[1].rx_squelch_type, re2.modes[1].rx_pl) == ("INV.DPL", "D311")

    # unchanged VHF rebuild stays byte-identical (change-gated write)
    assert bytes(Codeplug.parse(body).rebuild()) == body


def test_vhf_pl_codec_byte_exact_both_slots():
    """VHF CTCSS ("TPL") encode is table-exact vs RSS for every tone this head
    carries (40 tones, captured by cycling the 221AZN TPL CODE field). Each table
    tone encodes to its exact slot bytes and decodes back; the Rx slot is
    freq-linear, the Tx slot a period, and the tables beat the formula on the
    tones where RSS rounds one count off (e.g. Rx 162.2, Tx 179.9)."""
    from motreader.codeplug import (vhf_pl_encode, vhf_pl_decode,
                                    VHF_PL_RX_BY_TONE, VHF_PL_TX_BY_TONE)
    for is_tx, tbl in ((False, VHF_PL_RX_BY_TONE), (True, VHF_PL_TX_BY_TONE)):
        for tone, (hi, lo) in tbl.items():
            assert vhf_pl_encode(tone, is_tx) == (hi, lo), (is_tx, tone)
            assert vhf_pl_decode(hi, lo, is_tx) == tone, (is_tx, tone)
    # the table, not the rounding formula, is used (these are the off-by-one tones)
    assert vhf_pl_encode("162.2", is_tx=False) == (0xa6, 0xcd)
    assert vhf_pl_encode("179.9", is_tx=True) == (0x83, 0x99)


def test_vhf_pl_edit_is_surgical_and_roundtrips():
    """VHF PL (CTCSS) edits are byte-surgical and re-decode. Carrier->PL writes
    the slot, a tone change rewrites only that slot, PL->Carrier zeroes it, and an
    unchanged mode stays byte-identical. Validated end-to-end in RSS (mode 1 ->
    Rx TPL 141.3 / Tx TPL 123.0, mode 5 -> Rx 162.2 / Tx 179.9 GET-loaded)."""
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(AZN).body)

    # Carrier mode 1 -> Rx PL 141.3 + Tx PL 123.0: only the two tone slots change
    cp = Codeplug.parse(body)
    base = cp.modes[0].offset
    cp.modes[0].rx_squelch_type = "PL"; cp.modes[0].rx_pl = "141.3"
    cp.modes[0].tx_squelch_type = "PL"; cp.modes[0].tx_pl = "123.0"
    new = bytes(cp.rebuild())
    assert [i - base for i in _diff(body, new)] == [17, 18, 19, 20]
    r = Codeplug.parse(new).modes[0]
    assert (r.rx_squelch_type, r.rx_pl, r.tx_pl) == ("PL", "141.3", "123.0")

    # existing PL mode: change the Rx tone only -> only rec+17,+18
    cp2 = Codeplug.parse(body)
    m = next(x for x in cp2.modes if x.rx_squelch_type == "PL")
    b2 = m.offset
    m.rx_pl = "88.5" if m.rx_pl != "88.5" else "127.3"
    want = m.rx_pl
    new2 = bytes(cp2.rebuild())
    assert [i - b2 for i in _diff(body, new2)] == [17, 18]
    assert Codeplug.parse(new2).modes[m.number - 1].rx_pl == want

    # PL -> Carrier zeroes the Rx slot
    cp3 = Codeplug.parse(body)
    m3 = next(x for x in cp3.modes if x.rx_squelch_type == "PL")
    b3 = m3.offset
    m3.rx_squelch_type = "Carrier"; m3.rx_pl = ""
    new3 = bytes(cp3.rebuild())
    assert new3[b3 + 17] == 0 and new3[b3 + 18] == 0
    assert Codeplug.parse(new3).modes[m3.number - 1].rx_squelch_type == "Carrier"

    # unchanged rebuild is byte-identical
    assert bytes(Codeplug.parse(body).rebuild()) == body


def test_900_edit_tx_ta_roundtrip():
    """Editing 900 TX/TA to an independent split round-trips exactly."""
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    cp = Codeplug.parse(body)
    m = cp.modes[2]  # mode 3
    m.tx_mhz, m.ta_mhz = 903.0, 927.5  # TX not RX-25; T/A not RX
    chk = Codeplug.parse(bytes(cp.rebuild())).modes[2]
    assert (chk.tx_mhz, chk.ta_mhz) == (903.0, 927.5)
    assert chk.rx_mhz == 927.25  # RX untouched


def test_rebuild_identity():
    """Parsing then rebuilding an unmodified codeplug is byte-identical."""
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    cp = Codeplug.parse(body)
    assert bytes(cp.rebuild()) == body
    assert encrypt_body(bytes(cp.rebuild())) == Archive.load(SAMPLE).body


def test_names_decoded():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    cp = _cp()
    by_num = {m.number: m for m in cp.modes}
    assert by_num[1].name == "098 USED"
    assert by_num[2].name == "L P 0375"
    assert by_num[5].name == "SUN 2875"


def test_name_pack_roundtrip():
    from motreader.codeplug import pack_name, unpack_name

    for nm in ["L P 0375", "W1AW TST", "ABCDEFGH", "A"]:
        assert unpack_name(pack_name(nm)) == nm.rstrip()


def test_edit_name_is_surgical():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    cp = Codeplug.parse(body)
    cp.modes[1].name = "W1AW TST"
    new = bytes(cp.rebuild())
    diffs = _diff(body, new)
    assert len(diffs) == 6  # one 6-byte name slot
    assert Codeplug.parse(new).modes[1].name == "W1AW TST"


def test_edit_rx_is_surgical():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    cp = Codeplug.parse(body)
    cp.modes[1].rx_mhz = 927.5  # mode 2
    new = bytes(cp.rebuild())
    diffs = _diff(body, new)
    # RX is a two-byte field (off14 lo, off15 mid); both live inside mode 2.
    assert len(diffs) <= 2
    base = cp.modes[1].offset
    assert all(base + 14 <= d <= base + 15 for d in diffs)
    assert Codeplug.parse(new).modes[1].rx_mhz == 927.5


# ---------------------------------------------------------------------------
# Zones (radio-wide). 566AYA has 12 zones; ground truth = its RADIO CONFIG print
# (notes/ground-truth/radiocfg_566aya.prn, ZONE OPERATION section).

def test_zone_names_and_count_match_print():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    cp = _cp()
    assert len(cp.zones) == 12
    assert [z.name for z in cp.zones] == [
        "VEGAS", "ARIZONA", "S CALF", "N CALF", "WASH", "EAST",
        "WEST", "TEXAS", "PA NJ NY", "RENO NV", "SOCA NEW", "HOME ZN",
    ]


def test_zone_membership_matches_print():
    """Mode membership (bitmap) vs the print's Zone Mode List, byte-exact.
    VEGAS = modes 2..17; TEXAS = a sparse set; HOME ZN = the home zone."""
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    by = {z.number: z for z in _cp().zones}
    assert by[1].modes == list(range(2, 18))                 # VEGAS
    assert by[8].modes == [5, 9, 10, 31, 33, 41, 44, 50, 51, 61, 67, 68, 69, 70]
    assert by[6].modes == [12]                               # EAST (single mode)
    assert 1 in by[7].modes                                  # WEST holds "PERS 1"
    # the special home zone has the distinct flag byte
    assert by[12].name == "HOME ZN" and by[12].flag_byte == 0xA0
    assert all(z.flag_byte == 0xF4 for z in _cp().zones if z.number != 12)


def test_zone_edit_is_surgical_and_roundtrips():
    """A zone name + membership edit changes only that zone's name/bitmap bytes;
    an untouched zone and every mode stay byte-identical."""
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    cp = Codeplug.parse(body)
    z = cp.zones[0]
    z.name = "ZEBRA"
    z.modes = [2, 3, 18, 99]
    new = bytes(cp.rebuild())
    diffs = _diff(body, new)
    # only zone-1 name slot (6 B) + its membership bitmap (<=16 B) may change,
    # plus the membership section's 8-bit sum (RSS keeps it valid)
    name_lo, name_hi = z.names_off, z.names_off + 6
    memb_lo, memb_hi = z.memb_off, z.memb_off + 16
    secs = cp._zone_secs
    ck = secs["memb"] + secs["memb_len"] - 1
    assert all(name_lo <= d < name_hi or memb_lo <= d < memb_hi or d == ck for d in diffs)
    assert new[ck] == sum(new[secs["memb"]:ck]) & 0xFF
    # re-decode: the edit took, other zones intact
    cp2 = Codeplug.parse(new)
    assert cp2.zones[0].name == "ZEBRA"
    assert cp2.zones[0].modes == [2, 3, 18, 99]
    assert cp2.zones[1].name == "ARIZONA"
    assert [z.modes for z in cp2.zones[1:]] == [z.modes for z in cp.zones[1:]]


def test_unchanged_zone_rebuild_is_byte_identical():
    if not os.path.exists(SAMPLE):
        pytest.skip("sample not present")
    body = decrypt_body(Archive.load(SAMPLE).body)
    assert bytes(Codeplug.parse(body).rebuild()) == body


_AUN = os.path.expanduser(
    "~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE/a604aun0.331")
_ASN1767 = os.path.expanduser(
    "~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE/a617asn1.767")
_SQ = os.path.expanduser(
    "~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE/a617asq1.266")


def _zones(path):
    return Codeplug.parse(decrypt_body(Archive.load(path).body)).zones


def test_zones_617asn_conventional_900():
    """617ASN1767 (D37KMA, 900): 4 zones, 6-bit names, W=7 membership.
    Full membership read from the RSS zone editor (MODE LIST, all pages)."""
    if not os.path.exists(_ASN1767):
        pytest.skip("sample not present")
    zs = _zones(_ASN1767)
    assert [z.name for z in zs] == ["SIMPX ZN", "BUS ZN", "LOC RPTR", "NODE CH"]
    by = {z.number: z for z in zs}
    assert by[1].modes == [6, 7, 8, 9, 10, 11, 12, 13, 47, 48]
    assert by[2].modes == [1, 2, 3, 4, 5]
    assert by[4].modes == list(range(27, 54))


def test_zones_604aun_conventional_900():
    """604AUN0331 (D37KGA, 900): 4 zones HOME/SOCAL/SIMPLEX/TUCSON, W=6."""
    if not os.path.exists(_AUN):
        pytest.skip("sample not present")
    zs = _zones(_AUN)
    assert [z.name for z in zs] == ["HOME", "SOCAL", "SIMPLEX", "TUCSON"]
    by = {z.number: z for z in zs}
    assert by[1].modes == [1, 2, 3, 11, 15, 16, 17, 18, 19, 25, 26, 27, 28, 29, 30]
    assert by[4].modes == list(range(31, 49))


def test_zones_221azn_vhf_a9_ascii_names():
    """221AZN (T83FWA, VHF A9 head): 12 zones with 11-char ASCII names stored in
    the string pool before the ASCII mode-name table; W=9 membership block in the
    low binary region. Names contain '/' ("BBND/MURS")."""
    if not os.path.exists(AZN):
        pytest.skip("sample not present")
    zs = _zones(AZN)
    assert [z.name for z in zs] == [
        "SIMPLEX", "FT MY CENTR", "FT MY EAST", "FT MY NORTH", "FT MY SOUTH",
        "FT MY ALL", "CINCINNATI", "BBND/MURS", "SEARCH RESC", "MARINE VHF",
        "NOAA WEATHR", "SOCAL TEST",
    ]
    by = {z.number: z for z in zs}
    assert by[1].modes == [1, 2, 3, 4, 57]
    assert by[2].modes == list(range(4, 16))
    assert by[12].modes == list(range(57, 66))
    assert all(z.name_enc == "ascii" and z.memb_w == 9 for z in zs)


def test_zones_roundtrip_all_radios():
    """Unchanged rebuild is byte-identical for every zone-bearing radio."""
    for p in (SAMPLE, _ASN1767, _AUN, AZN):
        if not os.path.exists(p):
            continue
        body = decrypt_body(Archive.load(p).body)
        assert bytes(Codeplug.parse(body).rebuild()) == body


def test_no_false_zone_block_on_zoneless_radio():
    """The locator must not invent zones where there are none. 617ASQ (small VHF)
    has no zone block."""
    if not os.path.exists(_SQ):
        pytest.skip("sample not present")
    assert _zones(_SQ) == []


def test_unedited_rebuild_is_byte_identical_everywhere():
    """A no-op import must not change a byte, on every archive and RSS capture
    on hand, including codeplugs whose tone slots hold data that isn't a tone
    (they decode to no squelch type and must be left alone)."""
    import glob
    from tests.test_crypto import _archives
    from motreader.archive import Archive
    from motreader.crypto import decrypt_body
    from motreader.codeplug import Codeplug
    bodies = [(p, decrypt_body(Archive.load(p).body)) for p in _archives()]
    bodies += [(p, open(p, "rb").read()) for p in
               glob.glob(os.path.join(os.path.dirname(__file__), "..", "notes", "ground-truth", "**", "*.bin"),
                         recursive=True)]
    assert bodies
    for p, body in bodies:
        if p.endswith("A428TWN2.810"):
            continue
        assert bytes(Codeplug.parse(body).rebuild()) == body, p
