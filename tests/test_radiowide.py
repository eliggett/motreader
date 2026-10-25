"""Radio-wide settings: decode vs RSS screens (every on-hand radio) + write path."""

import json
import os
import sys

import pytest

from motreader import radiowide as RW
from motreader.archive import Archive
from motreader.crypto import decrypt_body

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import rw_gt  # noqa: E402

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

# radio.yaml key -> (RSS screen path, on-screen label)
SCREEN = {
    "home_zone": ("f4,f2", "Home Zone"),
    "home_mode": ("f4,f2", "HOME MODE"),
    "mode_names": ("f4,f2", "MODE NAMES"),
    "time_out_timer": ("f4,f2", "TIME OUT TIMER"),
    "hub_switch": ("f4,f2", "HUB SWITCH"),
    "max_user_modes": ("f4,f2", "MAX USER MODES"),
    "minimum_volume": ("f4,f2", "MINIMUM VOLUME (0-15)"),
    "speaker_b_min_volume": ("f4,f2", "SPEAKER B MIN VOLUME (0-15)"),
    "positional_zones": ("f4,f2", "Positional"),
    "volume_set_tone": ("f4,f2,f9", "Volume Set Tone"),
    "mode_change_tone": ("f4,f2,f9", "Mode Change Tone"),
    "ptt_on_rx_only_mode": ("f4,f2,f9", "PTT on Rx-Only Mode"),
    "ptt_ignition_sense": ("f4,f2,f9", "PTT Ignition Sense"),
    "subsequent_call_alert": ("f4,f2,f9", "Subsequent Call Alert"),
    "horn_time_out_s": ("f4,f2,f9", "Horn Time Out (s)"),
    "lights_time_out_s": ("f4,f2,f9", "Lights Time Out (s)"),
    "speaker_b_vip_number": ("f4,f2,f9", "Speaker B VIP Number"),
    "master_adaptive_splatter": ("f4,f2,f9", "Adaptive Splatter"),
    "master_audio_compandor": ("f4,f2,f9", "Audio Compandor"),
    "scan_priority1_activity_tone": ("f4,f2,f6", "Priority 1 Activity"),
    "scan_priority2_activity_tone": ("f4,f2,f6", "Priority 2 Activity"),
    "scan_nuisance_delete": ("f4,f2,f6", "Nuisance Delete"),
    "scan_off_hub": ("f4,f2,f6", "Scan Off HUB"),
    "scan_lookback_cycle_count": ("f4,f2,f6", "Lookback Cycle Count"),
    "scan_conv_rx_hang_time_ms": ("f4,f2,f6", "Receive Hang Time"),    # CONV (first) column
    "scan_conv_tx_hang_time_ms": ("f4,f2,f6", "Transmit Hang Time"),
    "scan_tx_revert_mode": ("f4,f2,f6", "Tx Revert Mode"),
    "scan_dynamic_priority_assignment": ("f4,f2,f6", "Dynmic Pri Assgnmt"),
    "mdc_unit_id": ("f4,f3", "Unit ID (0000-9999)"),
    "mdc_group_id": ("f4,f3", "Group ID (00-99)"),
    "mdc_fleet_id": ("f4,f3", "Fleet ID (0-9)"),
    "mdc_signalling": ("f4,f3", "MDC SIGNALLING"),
    "dtmf_individual_id": ("f4,f3,f2", "Individual ID"),
    "dtmf_end_of_callback": ("f4,f3,f2", "End-of-Callback"),
    "dtmf_digit_time_ms": ("f4,f3,f2", "Digit Time (mSec)"),
    "dtmf_interdigit_time_ms": ("f4,f3,f2", "Interdigit Time (mSec)"),
    "dtmf_system_delay_ms": ("f4,f3,f2", "System Delay (mSec)"),
    "emergency": ("f4,f3", "Emergency"),
    "number_of_mpl": ("f4,f3", "Number of MPL"),
    "ch_default_backlight": ("f4,f6,f9", "Default Backlight"),
    "ch_default_dim": ("f4,f6,f9", "Default Dim"),
    "ch_low_backlight": ("f4,f6,f9", "Low Backlight"),
    "ch_medium_backlight": ("f4,f6,f9", "Medium Backlight"),
    "ch_high_backlight": ("f4,f6,f9", "High Backlight"),
    "mdc_system_delay_ms": ("f4,f3,f3", "System Delay (ms)"),
    "mdc_ptt_id_beginning": ("f4,f3,f3", "Beginning of PTT"),
    "mdc_ptt_id_ending": ("f4,f3,f3", "Ending of PTT"),
    "mdc_sidetone": ("f4,f3,f3", "Sidetone"),
    "mdc_preamble": ("f4,f3,f3", "Preamble"),
    "mdc_channel_busy_wait_s": ("f4,f3,f3", "CHANNEL BUSY WAIT TIME"),
    "siren_pa_options": ("f4,f2,f9", "Siren/P.A. Options"),
    "horn_lights_rearm": ("f4,f2,f9", "Horn & Lights Rearm"),
    "internal_pa": ("f4,f2,f9", "Internal PA"),
    "speaker_a_b": ("f4,f2,f9", "Speaker A/B"),
    "control_head_type": ("f4,f2,f9", "Control Head Type"),
    "phone_dtmf_encode": ("f4,f2,f9", "Phone/DTMF Encode"),
}

# SIREN / PUBLIC ADDRESS + ADDITIONAL OPTIONS screens (notes/ground-truth/
# siren_<serial>.json); only 604AUN has Siren/PA on, so only it shows them.
SIREN_SCREEN = {
    "pa_option_audio_routing": ("f4,f2,f9,f6", "Option Audio Routing"),
    "pa_ignition_sense": ("f4,f2,f9,f6", "P.A. Ignition Sense"),
    "pa_ex_rd_ignition_sense": ("f4,f2,f9,f6", "Ex Rd Ignition Sense"),
    "pa_default_volume": ("f4,f2,f9,f6", "Default P.A. Volume Level"),
    "siren_pa_after_reset": ("f4,f2,f9,f6", "Siren/PA After Reset"),
    "siren_hilo_airhorn_tones": ("f4,f2,f9,f6", "Hilo/Airhorn Siren Tones"),
    "siren_manual_tone": ("f4,f2,f9,f6", "Manual Siren Tone"),
    "siren_ignition_sense": ("f4,f2,f9,f6", "Siren Ignition Sense"),
    "tx_mic_input_control": ("f4,f2,f9,f7", "TX Mic Input Control by"),
    "filtered_audio_thru_rear": ("f4,f2,f9,f7", "Filtered Audio Thru Rear"),
    "mic_gain": ("f4,f2,f9,f7", "MIC Gain"),
}


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_siren_pa_screens_match_rss(serial):
    body = _body(RADIOS[serial])
    dec = RW.decode(body)
    with open(os.path.join(GT_DIR, f"siren_{serial}.json")) as f:
        screens = json.load(f)["screens"]
    shown_any = False
    for key, (path, label) in SIREN_SCREEN.items():
        # raw row match: RSS sometimes leaves a single dot ("Rear.Disabled")
        shown = next((r.split(label, 1)[1].lstrip(".").strip()
                      for r in screens.get(path, [])[3:22] if label + "." in r), None)
        if shown is None:
            # RSS refused the screen ("Neither Siren or PA selected" /
            # "This Option is Disabled"): motreader must not export it either
            assert key not in dec, key
            continue
        shown_any = True
        assert _norm(dec[key]) == _norm(shown), (key, dec[key], shown)
    assert shown_any == (serial == "604AUN0331")


def test_siren_edit_recomputes_chb_checksum():
    body = _body(RADIOS["604AUN0331"])
    c = RW.find_chb_block(body)
    out = bytes(RW.encode(body, {"siren_manual_tone": "Yelp", "pa_default_volume": 6,
                                 "siren_ignition_sense": "Enabled"}))
    # the exact bytes RSS saved for these edits individually (604AUN mapping run)
    assert out[c + 0x5E] == 0x91 and out[c + 0x5F] == 0x06
    assert RW.find_chb_block(out) == c                      # checksum valid
    assert {i for i in range(len(body)) if body[i] != out[i]} == {c + 0x5E, c + 0x5F, c + RW.CHB_CK}
    dec = RW.decode(out)
    assert (dec["siren_manual_tone"], dec["pa_default_volume"]) == ("Yelp", 6)
    with pytest.raises(ValueError, match="S9000e"):         # A9 head is fixed in RSS
        RW.encode(_body(RADIOS["221AZN0035"]), {"control_head_type": "Standard"})


def _body(fn):
    p = os.path.join(ARCHIVE_DIR, fn)
    if not os.path.exists(p):
        pytest.skip(f"{fn} not present")
    return decrypt_body(Archive.load(p).body)


def _norm(v):
    if isinstance(v, float):
        v = f"{v:.1f}"
    s = str(v).strip()
    return str(int(s)) if s.isdigit() else s


def _shown(key, s):
    if key.endswith("hang_time_ms"):
        return str(round(float(s) * 1000))          # RSS shows seconds
    return _norm(s)


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_decode_matches_rss_screens(serial):
    body = _body(RADIOS[serial])
    gt = rw_gt.load(os.path.join(GT_DIR, f"rw_{serial}.json"))
    dec = RW.decode(body)
    assert RW.find_ext_block(body) is not None
    checked, bad = 0, []
    for key, (path, label) in SCREEN.items():
        shown = gt.get(path, {}).get(label)
        if shown is None or shown in ("Not Avail",):
            continue            # field not shown / not applicable on this model
        if key == "number_of_mpl" and shown == "Disabled":
            shown = "0"             # RSS shows a zero count as "Disabled"
        checked += 1
        if key not in dec or _norm(dec[key]) != _shown(key, shown):
            bad.append((key, dec.get(key), shown))
    # signalling type is shown as a baud rate
    st = gt.get("f4,f3,f3", {}).get("SIGNALLING TYPE")
    if st:
        checked += 1
        if dec.get("mdc_signalling_type_1200") != ("Enabled" if st == "1200" else "Disabled"):
            bad.append(("mdc_signalling_type_1200", dec.get("mdc_signalling_type_1200"), st))
    assert not bad, f"{serial}: decoded != RSS screen: {bad}"
    assert checked >= 12


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_unchanged_encode_is_byte_identical(serial):
    body = _body(RADIOS[serial])
    assert bytes(RW.encode(body, RW.decode(body))) == body


def test_edit_touches_only_field_and_ext_checksum():
    body = _body(RADIOS["221AZN0035"])
    ext = RW.find_ext_block(body)
    L = body[ext]
    out = RW.encode(body, {"horn_time_out_s": 7, "minimum_volume": 3,
                           "volume_set_tone": "Disabled", "mdc_unit_id": "0042"})
    diff = {i for i in range(len(body)) if body[i] != out[i]}
    assert diff <= {ext + 0x0A, ext + L - 1, 0x10B, 0x10E, 0x1B3, 0x1B4}
    dec = RW.decode(bytes(out))
    assert (dec["horn_time_out_s"], dec["minimum_volume"], dec["volume_set_tone"],
            dec["mdc_unit_id"]) == (7, 3, "Disabled", "0042")
    # ext checksum stays valid
    assert RW.find_ext_block(bytes(out)) == ext


# The exact radio_wide edits motreader applied to 221AZN0035 for the real-RSS
# validation (2026-10-23): the patched archive GET-loaded with no warnings and
# RSS displayed every value below (screens in rw_221AZN0035_edited.json).
RSS_VALIDATED_EDITS = {
    "hub_switch": "Enabled", "minimum_volume": 3, "speaker_b_min_volume": 5,
    "positional_zones": "Enabled", "volume_set_tone": "Disabled",
    "subsequent_call_alert": "Disabled", "horn_time_out_s": 9,
    "lights_time_out_s": 120, "scan_priority1_activity_tone": "Enabled",
    "scan_off_hub": "Disabled", "scan_lookback_cycle_count": 15,
    "mdc_unit_id": "0815", "mdc_group_id": "42", "mdc_fleet_id": 3,
    "dtmf_individual_id": "4711", "dtmf_digit_time_ms": 300, "emergency": "Enabled",
    "mdc_system_delay_ms": 300, "mdc_sidetone": "Enabled", "mdc_preamble": "Enabled",
    "mdc_channel_busy_wait_s": 1.5,
}


def test_edits_match_real_rss_display():
    body = _body(RADIOS["221AZN0035"])
    out = bytes(RW.encode(body, RSS_VALIDATED_EDITS))
    gt_path = os.path.join(GT_DIR, "rw_221AZN0035_edited.json")
    gt = rw_gt.load(gt_path)
    dec = RW.decode(out, "vhf")
    shown = 0
    for key, (path, label) in SCREEN.items():
        s = gt.get(path, {}).get(label)
        if s is None or s == "Not Avail":
            continue
        shown += 1
        assert _norm(dec[key]) == _shown(key, s), (key, dec[key], s)
    assert shown >= 35
    import json
    with open(gt_path) as f:
        assert json.load(f)["get_warnings"] == []      # ext checksum accepted


# motreader edits of 604AUN's SIREN/PA + ADDITIONAL OPTIONS screens, GET-loaded
# in real RSS with no warning and displayed exactly (2026-10-23;
# notes/ground-truth/siren_604AUN0331_edited.json).
RSS_VALIDATED_SIREN_EDITS = {
    "pa_option_audio_routing": "Disabled", "pa_ignition_sense": "Enabled",
    "pa_default_volume": 7, "siren_pa_after_reset": "Off",
    "siren_hilo_airhorn_tones": "Disabled", "siren_manual_tone": "Airhorn",
    "siren_ignition_sense": "Enabled", "tx_mic_input_control": "Current",
    "mic_gain": "Enabled",
}


def test_siren_edits_match_real_rss_display():
    body = _body(RADIOS["604AUN0331"])
    dec = RW.decode(bytes(RW.encode(body, RSS_VALIDATED_SIREN_EDITS)))
    with open(os.path.join(GT_DIR, "siren_604AUN0331_edited.json")) as f:
        gt = json.load(f)
    assert gt["get_warnings"] == []
    for key, (path, label) in SIREN_SCREEN.items():
        shown = next(r.split(label, 1)[1].lstrip(".").strip()
                     for r in gt["screens"][path][3:22] if label + "." in r)
        assert _norm(dec[key]) == _norm(shown), (key, dec[key], shown)


# RSS's own saves of 617ASN while cycling Siren/P.A. Options with Horn & Lights
# Rearm off and on (decrypted bodies). motreader's encode must reproduce every
# transition byte for byte, apart from RSS's per-save bookkeeping bytes.
SIREN_RSS_DIR = os.path.join(GT_DIR, "siren_617ASN_rss")
_BOOKKEEPING = (set(range(13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} | set(range(0x1BC, 0x1C0))
                | set(range(0x1DE, 0x1E6)))


@pytest.mark.parametrize("src,dst,value", [
    ("off_off", "paonly_off", "PA only"),
    ("paonly_off", "sirenpa_off", "Siren/PA"),
    ("sirenpa_off", "paonly_off", "PA only"),
    ("off_rearm", "paonly_rearm", "PA only"),
])
def test_siren_transitions_match_rss_saves(src, dst, value):
    def load(n):
        with open(os.path.join(SIREN_RSS_DIR, n + ".plain.bin"), "rb") as f:
            return f.read()
    a, b = load(src), load(dst)
    out = RW.encode(a, {"siren_pa_options": value})
    assert [hex(i) for i in range(len(a)) if out[i] != b[i] and i not in _BOOKKEEPING] == []


ACCESSORY_RSS_DIR = os.path.join(GT_DIR, "accessory_566AYA_rss")


def _plain(d, n):
    with open(os.path.join(d, n + ".plain.bin"), "rb") as f:
        return f.read()


@pytest.mark.parametrize("d,src,dst,edit", [
    # once refused: Siren/PA off while Rearm is on (RSS recomputes W)
    (SIREN_RSS_DIR, "sirenpa_rearm", "off_rearm", {"siren_pa_options": "Disabled"}),
    (SIREN_RSS_DIR, "sirenpa_off", "sirenpa_rearm", {"horn_lights_rearm": "Enabled"}),
    (SIREN_RSS_DIR, "paonly_rearm", "paonly_off_after_rearm", {"horn_lights_rearm": "Disabled"}),
    (ACCESSORY_RSS_DIR, "base", "internal_pa", {"internal_pa": "Enabled"}),
    (ACCESSORY_RSS_DIR, "base", "speaker_ab", {"speaker_a_b": "Enabled"}),
    (ACCESSORY_RSS_DIR, "base", "rearm_permanent", {"horn_lights_rearm": "Permanent"}),
    (ACCESSORY_RSS_DIR, "base", "rearm_enabled", {"horn_lights_rearm": "Enabled"}),
])
def test_accessory_edits_match_rss_saves(d, src, dst, edit):
    a, b = _plain(d, src), _plain(d, dst)
    out = RW.encode(a, edit)
    c = RW.find_chb_block(a)
    # (566's saves also carry earlier, unrelated mode-record edits: compare
    # everything up to the end of the control-head block)
    assert [hex(i) for i in range(c + RW.CHB_CK + 1)
            if out[i] != b[i] and i not in _BOOKKEEPING] == []


@pytest.mark.parametrize("serial", sorted(RADIOS))
def test_chb_summary_word_formula(serial):
    """W = sum(CHB[+0x12:+0x1B]) bit-interleaved (s7 s15 s6 s14 ... s0 s8),
    from RSS's own encoder (SPECTRA4.OVL @0x32911, located with break-on-write)."""
    body = _body(RADIOS[serial])
    c = RW.find_chb_block(body)
    assert RW.chb_summary_word(body, c) == body[c + 0x1C] << 8 | body[c + 0x1D]


def test_enable_siren_and_set_its_options_in_one_import():
    body = _body(RADIOS["617ASN1767"])                     # Siren/PA off
    out = bytes(RW.encode(body, {"siren_pa_options": "Siren/PA",
                                 "siren_manual_tone": "Yelp", "pa_default_volume": 5}))
    d = RW.decode(out)
    assert (d["siren_pa_options"], d["siren_manual_tone"], d["pa_default_volume"]) == \
        ("Siren/PA", "Yelp", 5)
    assert RW.find_chb_block(out) is not None              # checksum valid


# motreader set Siren/P.A. Options on three radios; each archive GET-loaded in
# real RSS with no warning and RSS showed the option + the SIREN/PA screen
# (notes/ground-truth/siren_<serial>_enabled.json, 2026-10-23).
@pytest.mark.parametrize("serial,value", [
    ("617ASN1767", "Siren/PA"),        # off -> Siren/PA (Rearm off)
    ("566AYA0014", "PA only"),         # off -> PA only
    ("604AUN0331", "PA only"),         # Siren/PA -> PA only (Rearm Enabled)
])
def test_siren_enable_matches_real_rss_display(serial, value):
    body = _body(RADIOS[serial])
    dec = RW.decode(bytes(RW.encode(body, {"siren_pa_options": value})))
    with open(os.path.join(GT_DIR, f"siren_{serial}_enabled.json")) as f:
        gt = json.load(f)
    assert gt["get_warnings"] == []
    screens = gt["screens"]
    opt = rw_gt.parse_rows(screens["f4,f2,f9"])
    assert dec["siren_pa_options"] == opt["Siren/P.A. Options"] == value
    for key, (path, label) in SIREN_SCREEN.items():
        if path != "f4,f2,f9,f6":
            continue
        shown = next((r.split(label, 1)[1].lstrip(".").strip()
                      for r in screens[path][3:22] if label + "." in r), None)
        if shown is None:
            assert key not in dec, key            # e.g. siren fields under PA only
        else:
            assert _norm(dec[key]) == _norm(shown), (key, dec[key], shown)



# motreader edits of the accessory enables, GET-loaded in real RSS with no
# warning and displayed exactly (notes/ground-truth/accessory_<serial>_edited.json).
@pytest.mark.parametrize("serial,edit", [
    ("604AUN0331", {"siren_pa_options": "Disabled", "horn_lights_rearm": "Permanent"}),
    ("566AYA0014", {"internal_pa": "Enabled", "speaker_a_b": "Enabled",
                    "horn_lights_rearm": "Enabled"}),
])
def test_accessory_edits_match_real_rss_display(serial, edit):
    dec = RW.decode(bytes(RW.encode(_body(RADIOS[serial]), edit)))
    with open(os.path.join(GT_DIR, f"accessory_{serial}_edited.json")) as f:
        gt = json.load(f)
    assert gt["get_warnings"] == []
    shown = rw_gt.parse_rows(gt["screens"]["f4,f2,f9"])
    for key in edit:
        label = SCREEN[key][1]
        assert dec[key] == shown[label] == edit[key], (key, dec[key], shown[label])



# RSS's own saves while cycling Control Head Type both ways on 617ASN, 566AYA and
# 617ASQ (notes/ground-truth/headtype_rss). Every transition must reproduce.
HEAD_RSS_DIR = os.path.join(GT_DIR, "headtype_rss")


def _head_transitions():
    with open(os.path.join(HEAD_RSS_DIR, "sequences.json")) as f:
        for seq in json.load(f):
            for a, b in zip(seq, seq[1:]):
                yield a, b


@pytest.mark.parametrize("src,dst", list(_head_transitions()))
def test_head_type_swaps_match_rss_saves(src, dst):
    a, b = _plain(HEAD_RSS_DIR, src), _plain(HEAD_RSS_DIR, dst)
    out = RW.encode(a, {"control_head_type": dst.rsplit("_", 1)[1]})
    assert [hex(i) for i in range(len(a)) if out[i] != b[i] and i not in _BOOKKEEPING] == []


def test_head_swap_keeps_side_effects_with_untouched_yaml():
    """An import passes every radio_wide key; untouched ones (e.g. the backlight
    options RSS resets on a head change) must not undo the swap's side effects."""
    a = _plain(HEAD_RSS_DIR, "566AYA0014_hd0_Enhanced")
    b = _plain(HEAD_RSS_DIR, "566AYA0014_hd1_Rotary")
    values = dict(RW.decode(a), control_head_type="Rotary")
    out = RW.encode(a, values)
    assert [hex(i) for i in range(len(a)) if out[i] != b[i] and i not in _BOOKKEEPING] == []



# motreader head swaps GET-loaded in real RSS with no warning (2026-10-23):
# 617ASN Standard -> Rotary, 566AYA Enhanced -> Standard.
@pytest.mark.parametrize("serial,head,gtfile", [
    ("617ASN1767", "Rotary", "headtype_617ASN1767_rotary.json"),
    ("566AYA0014", "Standard", "headtype_566AYA0014_standard.json"),
])
def test_head_swap_matches_real_rss_display(serial, head, gtfile):
    body = _body(RADIOS[serial])
    values = dict(RW.decode(body), control_head_type=head)     # as an import would
    dec = RW.decode(bytes(RW.encode(body, values)))
    with open(os.path.join(GT_DIR, gtfile)) as f:
        gt = json.load(f)
    assert gt["get_warnings"] == []
    opt = rw_gt.parse_rows(gt["screens"]["f4,f2,f9"])
    assert dec["control_head_type"] == opt["Control Head Type"] == head
    assert dec["phone_dtmf_encode"] == opt["Phone/DTMF Encode"]
    chopt = rw_gt.parse_rows(gt["screens"]["f4,f6,f9"])
    for key, (path, label) in SCREEN.items():
        if path == "f4,f6,f9" and label in chopt:
            assert dec[key] == chopt[label], (key, dec[key], chopt[label])


# ZONE OPERATION (CHB+0x13 b4) as shown on each radio's RSS RADIO-WIDE screen;
# with it off the radio has no zones (the structural finder must not invent any:
# it used to find 2 on 604ATY).
ZONE_OP = {"a566aya0.014": True, "a617asn1.767": True, "a604aun0.331": True,
           "a221azn0.035": True, "a604aty0.472": False, "a617asq1.266": False}


@pytest.mark.parametrize("fn", sorted(ZONE_OP))
def test_zone_operation_and_no_phantom_zones(fn):
    from motreader.codeplug import Codeplug
    body = _body(fn)
    cp = Codeplug.parse(body)
    assert cp.zone_operation is ZONE_OP[fn]
    assert RW.decode(body)["zone_operation"] == ("Enabled" if ZONE_OP[fn] else "Disabled")
    assert bool(cp.zones) is ZONE_OP[fn]
    if not ZONE_OP[fn]:
        assert body[0x1DD] == 0                  # home zone
