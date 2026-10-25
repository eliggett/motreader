"""Radio-wide (non-per-mode) settings: RSS CHANGE/VIEW -> RADIO-WIDE and
CONVENTIONAL screens.

Every field here was located white-box with the dosbox-x harness
(tools/scenario_rw_map.py: step one field in RSS, SAVE, decrypt-diff) and is
validated against the RSS screens of every on-hand radio
(notes/ground-truth/rw_<serial>.json, tests/test_radiowide.py).

Two storage areas hold them:

* ``hdr`` -- the fixed codeplug header (absolute body offsets, the same on every
  model seen: 900 trunked/conventional, VHF standard and A9 heads).
* ``chb`` -- the *control-head/accessory block* (siren, PA, horn & lights,
  VRS, speaker A/B). Position varies (it follows the mode-name table, after any
  model-specific tables); located by signature + its checksum, the 8-bit sum of
  bytes [+0x1E, +0x11E) stored at +0x11E (see :func:`find_chb_block`), which
  motreader recomputes on edit.
* ``ext`` -- the *radio-wide extension section*, a self-describing block whose
  first byte is its total length L and whose last byte (offset L-1) is the
  8-bit sum of bytes [0, L-1). Its position varies per codeplug, so it is
  located structurally (see :func:`find_ext_block`). RSS keeps the checksum
  current on save, so motreader recomputes it whenever it edits the block.

The write path is template-patch like the rest of motreader: only fields whose
decoded value changed are written, bit-surgically; everything else is
preserved byte-for-byte.

NOTE on master overrides (Adaptive Splatter / Audio Compandor / TOT / Mode
Names): in RSS, flipping a master also rewrites the matching bit in every mode
record (and Mode Names off resets all names). motreader only flips the master
bit; per-mode settings stay as they are in modes.csv.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

EN = ("Disabled", "Enabled")
# MDC channel busy wait: 0x1C2 = half-seconds; 0x1B9 bit0 SET = Infinite.
_BUSY_FLAG = (0x1B9, 0)


@dataclass(frozen=True)
class Field:
    key: str            # radio.yaml key
    area: str           # "hdr" | "ext"
    off: int            # body offset (hdr) or offset inside the ext block
    kind: str           # "bit" | "nibble" (low) | "hinibble" | "byte" | "bcd"
                        # | "bcdf" (BCD digits terminated/padded by 0xF nibbles)
                        # | "busywait" (MDC channel busy wait, see _BUSY_*)
                        # | "enum" (value = (byte >> bit) & mask -> choices[value])
                        # | "word" (big-endian 16-bit, x scale)
                        # | "dial" (DTMF digit string in nibbles listed by `nibs`)
                        # | "siren" / "rearm" / "headtype" (read-only multi-bit decodes)
    bit: int = 0        # bit index for kind="bit"
    invert: bool = False  # bit SET means Disabled
    width: int = 1      # bytes, for kind="bcd"
    scale: int = 1      # displayed value = stored * scale (byte/nibble kinds)
    editable: bool = True
    note: str = ""
    # extra copies RSS keeps of the same boolean: ((area, off, bit), ...),
    # bit SET = Enabled. Written in tandem with the primary bit.
    mirrors: tuple = ()
    bands: tuple = ()   # only these bands (RSS shows "Not Avail" elsewhere)
    mask: int = 0       # kind="enum"
    choices: tuple = ()  # kind="enum"
    # kind="dial": the digit nibbles in display order, ((area, off, hi), ...)
    # (hi=True: high nibble); `rjust` = stored right-justified (else left).
    nibs: tuple = ()
    rjust: bool = False
    # shown by RSS only while another field is NOT one of these values
    # (e.g. the siren settings need Siren/P.A. Options enabled): (key, values)
    when: tuple = ()
    ext_min: int = 0    # only when the ext section is at least this long


FIELDS = [
    # --- RADIO-WIDE CONFIGURATION (F4 -> F2) ---
    Field("zone_operation", "chb", 0x13, "bit", bit=4, editable=False,
          note="changing it re-packs the codeplug (motreader import does it via "
               "zoneop.py: standard-head conventional radios up to 120 modes); "
               "zones/home_zone are then re-created, re-export to edit them"),
    Field("home_zone", "hdr", 0x1DD, "byte", note="0 when the radio has no zones"),
    Field("max_systems", "hdr", 0x1D6, "byte", editable=False,
          note="trunking (TRUNKED DUAL MODE models); 0 after motreader remove-trunking"),
    Field("max_subfleets", "hdr", 0x1D7, "byte", editable=False),
    Field("home_mode", "hdr", 0x10F, "byte"),
    Field("mode_names", "hdr", 0x0E3, "bit", bit=4, mirrors=(("hdr", 0x10B, 7),)),
    Field("time_out_timer", "hdr", 0x0E3, "bit", bit=3),
    Field("hub_switch", "hdr", 0x105, "bit", bit=7),
    Field("max_user_modes", "hdr", 0x109, "byte", editable=False,
          note="number of modes in the codeplug; change via the mode list"),
    Field("minimum_volume", "hdr", 0x10B, "nibble"),
    Field("speaker_b_min_volume", "ext", 0x6A, "byte"),
    Field("positional_zones", "ext", 0x04, "bit", bit=0),
    # --- RADIO-WIDE CONFIGURATION OPTIONS (F4 -> F2 -> F9) ---
    Field("volume_set_tone", "hdr", 0x10E, "bit", bit=4),
    Field("mode_change_tone", "hdr", 0x10E, "bit", bit=0),
    Field("ptt_on_rx_only_mode", "hdr", 0x10E, "bit", bit=3),
    Field("ptt_ignition_sense", "hdr", 0x105, "bit", bit=2),
    Field("subsequent_call_alert", "ext", 0x02, "bit", bit=4, invert=True),
    Field("horn_time_out_s", "ext", 0x0A, "byte"),
    Field("lights_time_out_s", "ext", 0x0B, "byte"),
    Field("speaker_b_vip_number", "ext", 0x6B, "byte"),
    Field("master_adaptive_splatter", "hdr", 0x0E3, "bit", bit=2, bands=("900",)),
    Field("master_audio_compandor", "hdr", 0x0E3, "bit", bit=1, bands=("900",)),
    # --- SCAN CONFIGURATION OPTIONS (F4 -> F2 -> F6) ---
    Field("scan_priority1_activity_tone", "hdr", 0x10E, "bit", bit=2,
          mirrors=(("ext", 0x03, 3),)),
    Field("scan_priority2_activity_tone", "hdr", 0x10E, "bit", bit=1,
          mirrors=(("ext", 0x03, 2),)),
    Field("scan_nuisance_delete", "hdr", 0x105, "bit", bit=4,
          mirrors=(("ext", 0x03, 0),)),
    Field("scan_off_hub", "hdr", 0x105, "bit", bit=6, invert=True),
    Field("scan_lookback_cycle_count", "ext", 0x24, "byte"),
    # conventional scan hang times, 0.25 s steps
    Field("scan_conv_rx_hang_time_ms", "hdr", 0x111, "byte", scale=250),
    Field("scan_conv_tx_hang_time_ms", "hdr", 0x112, "byte", scale=250),
    # 0x105 b0 = Active, b5 = Home, neither = Selected; RSS offers it only
    # with Scan Off HUB disabled ("Not Avail" otherwise)
    Field("scan_tx_revert_mode", "hdr", 0x105, "enum", bit=0, mask=0x21,
          choices=tuple({0: "Selected", 1: "Active", 0x20: "Home"}.get(i, f"?{i:#x}")
                        for i in range(0x22)),
          when=("scan_off_hub", ("Enabled",))),
    # RSS shows "Not Avail" on 566AYA / 604AUN / 617ASN (bit kept as is)
    Field("scan_dynamic_priority_assignment", "hdr", 0x105, "bit", bit=3,
          mirrors=(("ext", 0x03, 1),)),
    # --- CONVENTIONAL CONFIGURATION (F4 -> F3) ---
    Field("mdc_unit_id", "hdr", 0x1B3, "bcd", width=2),
    Field("mdc_group_id", "hdr", 0x1B5, "bcd", width=1),
    Field("mdc_fleet_id", "hdr", 0x1B7, "hinibble"),
    # --- CONTROL HEAD OPTIONS (F4 -> F6 -> F9) ---
    Field("ch_default_backlight", "ext", 0x6C, "bit", bit=2),
    Field("ch_default_dim", "ext", 0x6C, "enum", bit=0, mask=3,
          choices=("Off", "Low", "Medium", "High")),
    Field("ch_low_backlight", "ext", 0x6C, "bit", bit=6),
    Field("ch_medium_backlight", "ext", 0x6C, "bit", bit=5),
    Field("ch_high_backlight", "ext", 0x6C, "bit", bit=4),
    # --- DTMF SIGNALLING OPTIONS (F4 -> F3 -> F2); stored in 5 ms units ---
    Field("dtmf_individual_id", "ext", 0x2F, "bcdf", width=3),
    Field("dtmf_end_of_callback", "ext", 0x32, "bit", bit=2, invert=True),
    Field("dtmf_digit_time_ms", "ext", 0x33, "byte", scale=5),
    Field("dtmf_interdigit_time_ms", "ext", 0x34, "byte", scale=5),
    Field("dtmf_system_delay_ms", "ext", 0x36, "byte", scale=5),
    Field("mdc_signalling", "hdr", 0x0E4, "bit", bit=5, editable=False,
          note="RSS also rewrites per-mode MDC bits when this changes"),
    Field("emergency", "hdr", 0x1B9, "bit", bit=4),
    # --- MDC SIGNALLING OPTIONS (F4 -> F3 -> F3) ---
    Field("mdc_signalling_type_1200", "hdr", 0x1B8, "bit", bit=7,
          note="Enabled = 1200 baud, Disabled = 600"),
    Field("mdc_system_delay_ms", "hdr", 0x1B7, "nibble", scale=100),
    Field("mdc_ptt_id_beginning", "hdr", 0x1B8, "bit", bit=4),
    Field("mdc_ptt_id_ending", "hdr", 0x1B8, "bit", bit=3),
    Field("mdc_sidetone", "hdr", 0x1B8, "bit", bit=1),
    Field("mdc_preamble", "hdr", 0x1D2, "bit", bit=5),
    Field("mdc_channel_busy_wait_s", "hdr", 0x1C2, "busywait",
          note="'Infinite' or seconds in 0.5 s steps"),
    Field("number_of_mpl", "hdr", 0x119, "byte", editable=False,
          note="resizes the MPL table (moves sections); not template-patchable"),
    # --- PHONE LIST OPTIONS (F4 -> F3 -> F7 -> F9; conventional only) ---
    # The 5-digit codes are split: 4 nibbles in the header + 1 in ext+0x45
    # (the access code's last digit, the release code's first).
    Field("phone_access_code", "hdr", 0x174, "dial", width=2, rjust=True,
          nibs=(("hdr", 0x174, True), ("hdr", 0x174, False), ("hdr", 0x175, True),
                ("hdr", 0x175, False), ("ext", 0x45, True))),
    Field("phone_release_code", "hdr", 0x176, "dial", width=2,
          nibs=(("ext", 0x45, False), ("hdr", 0x176, True), ("hdr", 0x176, False),
                ("hdr", 0x177, True), ("hdr", 0x177, False))),
    Field("phone_digit_time_ms", "hdr", 0x178, "byte", scale=5),
    Field("phone_interdigit_time_ms", "hdr", 0x1CA, "byte", scale=5),
    Field("phone_system_delay_ms", "hdr", 0x179, "word", width=2, scale=5),
    # --- RADIO-WIDE OPTIONS: accessory feature enables. Their bits sit in CHB
    # +0x12..+0x1A, summarised by W (recomputed on edit) ---
    Field("siren_pa_options", "hdr", 0x17C, "siren",
          note="Disabled / PA only / Siren/PA; see _encode_siren for the bits "
               "RSS writes and the one transition motreader refuses"),
    Field("horn_lights_rearm", "chb", 0x18, "rearm",
          note="Disabled / Enabled / Permanent (CHB+0x18 b0, CHB+0x13 b0)"),
    # Vehicle Repeater (hdr 0x17D b5 + a CHB table), SECURENET and trunking are
    # deliberately not exposed (owner's choice): their bytes are preserved
    # verbatim from the template codeplug.
    Field("phone_dtmf_encode", "hdr", 0x10D, "enum", bit=6, mask=1,
          choices=("List", "Unlimited"), editable=False,
          note="derived by RSS: List with a Rotary head, else the model default"),
    Field("control_head_type", "hdr", 0x10D, "headtype",
          note="Standard / Enhanced / Rotary editable; S9000e (A9 head) is fixed. "
               "See _encode_head for what RSS changes along with it"),
    Field("internal_pa", "chb", 0x17, "bit", bit=3,
          note="RSS shows 'Not Avail' on some models (604AUN) whatever the siren"),
    Field("speaker_a_b", "chb", 0x17, "bit", bit=4,
          note="RSS shows 'Not Avail' on some models (604AUN) whatever the siren"),
    # --- SIREN / PUBLIC ADDRESS (F4 -> F2 -> F9 -> F6): the PUBLIC ADDRESS part
    # needs Siren/P.A. Options on; the SIREN part only shows for "Siren/PA" ---
    Field("pa_option_audio_routing", "chb", 0x5F, "bit", bit=6, invert=True,
          when=("siren_pa_options", ("Disabled",))),
    Field("pa_ignition_sense", "chb", 0x5E, "bit", bit=2,
          when=("siren_pa_options", ("Disabled",))),
    Field("pa_ex_rd_ignition_sense", "chb", 0x5E, "bit", bit=1,
          when=("siren_pa_options", ("Disabled",))),
    Field("pa_default_volume", "chb", 0x5F, "nibble",
          when=("siren_pa_options", ("Disabled",))),
    Field("siren_pa_after_reset", "chb", 0x5F, "enum", bit=4, mask=1,
          choices=("Last State", "Off"), when=("siren_pa_options", ("Disabled",))),
    Field("siren_hilo_airhorn_tones", "chb", 0x5F, "bit", bit=5, invert=True,
          when=("siren_pa_options", ("Disabled", "PA only"))),
    Field("siren_manual_tone", "chb", 0x5E, "enum", bit=3, mask=7,
          choices=("?0", "Wail", "Yelp", "?3", "Airhorn", "?5", "?6", "?7"),
          when=("siren_pa_options", ("Disabled", "PA only"))),
    Field("siren_ignition_sense", "chb", 0x5E, "bit", bit=0,
          when=("siren_pa_options", ("Disabled", "PA only"))),
    # --- ADDITIONAL RADIO WIDE OPTIONS (F4 -> F2 -> F9 -> F7): RSS offers this
    # screen only on 604AUN, the one radio with the longer ext section (L=0x95);
    # "This Option is Disabled" elsewhere. The gate on L is provisional. ---
    Field("tx_mic_input_control", "ext", 0x74, "enum", bit=4, mask=1,
          choices=("Voltage", "Current"), ext_min=0x95),
    Field("filtered_audio_thru_rear", "ext", 0x74, "bit", bit=5, ext_min=0x95),
    Field("mic_gain", "ext", 0x74, "bit", bit=7, ext_min=0x95),
]
FIELD_BY_KEY = {f.key: f for f in FIELDS}


def find_ext_block(body: bytes) -> Optional[int]:
    """Offset of the radio-wide extension section, or None.

    Signature (all on-hand models): byte0 = section length L (0x80..0xC0),
    byte[L-1] = sum(bytes[0:L-1]) & 0xFF, bytes 5,6 = 0 and byte 7 = the mode
    count (header 0x109). Byte 8 usually repeats it but not always (8 with 7
    modes in a 604AUN backup; 5 and 4 on all-trunked radios), so it isn't
    required. The checksum makes a false match vanishingly unlikely; requiring
    it also means we never patch a block we can't re-checksum correctly."""
    n = body[0x109] if len(body) > 0x109 else None
    if n is None:
        return None
    for k in range(0x1E8, len(body) - 0x80):
        L = body[k]
        if not (0x80 <= L <= 0xC0) or k + L > len(body):
            continue
        if body[k + 5] or body[k + 6] or body[k + 7] != n:
            continue
        if (sum(body[k:k + L - 1]) & 0xFF) == body[k + L - 1]:
            return k
    return None


# DTMF dial-string nibbles (phone numbers, access/release codes). 0xF = unused.
DIAL_CHARS = "0123456789*#P"


def dial_decode(nibs) -> str:
    """Nibble values -> dial string; 0xF (and any unknown code) ends/pads."""
    return "".join(DIAL_CHARS[n] if n < len(DIAL_CHARS) else " " for n in nibs)


def dial_encode(s: str) -> list:
    return [DIAL_CHARS.index(c) if c != " " else 0xF for c in s]


def _getnib(body, a: int, hi: bool) -> int:
    return body[a] >> 4 if hi else body[a] & 0xF


def _setnib(out, a: int, hi: bool, n: int) -> None:
    out[a] = (out[a] & 0x0F) | (n << 4) if hi else (out[a] & 0xF0) | n


CHB_CK = 0x11E           # checksum byte; sum covers [CHB_SUM_LO, CHB_CK)
CHB_SUM_LO = 0x1E


def find_chb_block(body: bytes) -> Optional[int]:
    """Offset of the control-head/accessory block, or None.

    Signature on every on-hand model: bytes +0x66..+0x68 = 04 80 00, and the
    8-bit sum of [+0x1E, +0x11E) equals the byte at +0x11E. Searched from the
    end of the fixed header (0x1E8); must be unique."""
    hits = [p for p in range(0x1E8, len(body) - CHB_CK)
            if body[p + 0x66:p + 0x69] == b"\x04\x80\x00"
            and (sum(body[p + CHB_SUM_LO:p + CHB_CK]) & 0xFF) == body[p + CHB_CK]]
    return hits[0] if len(hits) == 1 else None


def _blocks(body: bytes) -> dict:
    return {"hdr": 0, "ext": find_ext_block(body), "chb": find_chb_block(body)}


def _loc(area: str, off: int, blocks) -> Optional[int]:
    if not isinstance(blocks, dict):          # legacy: ext offset only
        blocks = {"hdr": 0, "ext": blocks}
    base = blocks.get(area)
    return None if base is None else base + off


def _abs(f: Field, blocks) -> Optional[int]:
    return _loc(f.area, f.off, blocks)


def _bcd(bs: bytes) -> Optional[str]:
    s = bs.hex()
    return s if s.isdigit() else None


def decode(body: bytes, band: Optional[str] = None) -> dict:
    """{key: value} for every field present (and applicable to `band`, when
    given: e.g. the Compandor/Splatter masters are 900-only). Booleans as 'Enabled'/'Disabled'
    (the RSS wording), numbers as int, BCD IDs as zero-padded strings."""
    blk = _blocks(body)
    ext = blk
    out = {}
    for f in FIELDS:
        a = _abs(f, blk)
        if a is None or a + f.width > len(body):
            continue
        if f.area == "ext" and (f.off >= body[blk["ext"]] - 1 or body[blk["ext"]] < f.ext_min):
            continue                  # not in this model's (shorter) ext section
        if band is not None and f.bands and band not in f.bands:
            continue
        if f.when and out.get(f.when[0]) in f.when[1]:
            continue                  # RSS shows the field only when enabled
        v = body[a]
        if f.kind == "bit":
            on = bool(v >> f.bit & 1) ^ f.invert
            out[f.key] = EN[on]
        elif f.kind == "nibble":
            out[f.key] = (v & 0x0F) * f.scale
        elif f.kind == "enum":
            out[f.key] = f.choices[(v >> f.bit) & f.mask]
        elif f.kind == "busywait":
            fo, fb = _BUSY_FLAG
            out[f.key] = "Infinite" if body[fo] >> fb & 1 else v / 2
        elif f.kind == "hinibble":
            out[f.key] = v >> 4
        elif f.kind == "byte":
            out[f.key] = v * f.scale
        elif f.kind == "bcd":
            out[f.key] = _bcd(body[a:a + f.width])
        elif f.kind == "bcdf":
            out[f.key] = body[a:a + f.width].hex().split("f")[0]
        elif f.kind == "word":
            out[f.key] = (v << 8 | body[a + 1]) * f.scale
        elif f.kind == "siren":
            c = blk["chb"]
            if not v >> 7 & 1:
                out[f.key] = "Disabled"
            elif c is not None:
                out[f.key] = "PA only" if body[c + 0x5F] >> 7 & 1 else "Siren/PA"
        elif f.kind == "headtype":
            # 0x10D b5 clear = S9000e (A9); b4 = Rotary; else CHB+0x17 b1 =
            # Enhanced / clear = Standard (6 radios + 3 RSS-cycled variants)
            c = blk["chb"]
            if not v >> 5 & 1:
                out[f.key] = "S9000e"
            elif v >> 4 & 1:
                out[f.key] = "Rotary"
            elif c is not None:
                out[f.key] = "Enhanced" if body[c + 0x17] >> 1 & 1 else "Standard"
        elif f.kind == "rearm":
            out[f.key] = ("Disabled" if not v & 1 else
                          "Permanent" if body[a - 0x18 + 0x13] & 1 else "Enabled")
        elif f.kind == "dial":
            locs = [(_loc(ar, o, ext), hi) for ar, o, hi in f.nibs]
            if any(x is None for x, _ in locs):
                continue
            out[f.key] = dial_decode([_getnib(body, x, hi) for x, hi in locs]).strip()
    return out


def field_offsets(body: bytes) -> dict:
    """{body offset: field key} for every byte a radio-wide edit may change
    (incl. the Mode Names mirror and the ext-section checksum)."""
    blk = _blocks(body)
    offs = {}
    for f in FIELDS:
        a = _abs(f, blk)
        if a is not None:
            for i in range(a, a + f.width):
                offs.setdefault(i, f.key)
        for area, off, _bit in f.mirrors + f.nibs:
            m = _loc(area, off, blk)
            if m is not None:
                offs.setdefault(m, f.key)
    if blk["ext"] is not None:
        offs[blk["ext"] + body[blk["ext"]] - 1] = "ext checksum"
    if blk["chb"] is not None:
        offs[blk["chb"] + CHB_CK] = "control-head block checksum"
        for o in (0x13, 0x14, 0x1C, 0x1D, 0x46, 0x5E, 0x5F):  # siren/rearm/head bits + W
            offs.setdefault(blk["chb"] + o, "control-head summary")
    offs.setdefault(0x1CD, "control_head_type")
    return offs


def _same(a, b) -> bool:
    """Loose equality for radio.yaml values (YAML may give int/float/str)."""
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return str(a).strip().lower() == str(b).strip().lower()


def _setbit(out: bytearray, a: int, bit: int, on: bool) -> None:
    out[a] = (out[a] | (1 << bit)) if on else (out[a] & ~(1 << bit) & 0xFF)


def _parse_bool(key: str, v) -> bool:
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("enabled", "enable", "on", "yes", "true", "1"):
        return True
    if s in ("disabled", "disable", "off", "no", "false", "0"):
        return False
    raise ValueError(f"radio_wide.{key}: expected Enabled/Disabled, got {v!r}")


SIREN_CHOICES = ("Disabled", "PA only", "Siren/PA")
REARM_CHOICES = ("Disabled", "Enabled", "Permanent")
# CHB+0x1C/+0x1D = W, RSS's control-head summary word: the 16-bit sum S of CHB
# bytes [+0x12, +0x1B), bit-interleaved MSB-first as s7 s15 s6 s14 ... s0 s8
# (RSS overlay SPECTRA4.OVL @0x32911, found with break-on-write; matches all 22
# saved variants). Those bytes hold the Siren/PA, Rearm, Internal PA and Speaker
# A/B bits, which is why toggling any of them "rewrites" W.
CHB_W_LO, CHB_W_HI = 0x12, 0x1B
CHB_W = 0x1C


def chb_summary_word(body, c: int) -> int:
    s = sum(body[c + CHB_W_LO:c + CHB_W_HI])
    acc = 0
    for lo, hi in zip(range(7, -1, -1), range(15, 7, -1)):
        acc = (acc << 2) | ((s >> lo) & 1) << 1 | ((s >> hi) & 1)
    return acc


def _encode_siren(out: bytearray, blk: dict, orig: dict, want: str) -> None:
    """Siren/P.A. Options: hdr 0x17C b7 (siren or PA on), CHB+0x14 b2,
    CHB+0x5E b7, CHB+0x5F b7 (PA only); W is recomputed by encode(). Reproduces
    RSS's own saves byte for byte."""
    lc = [c.lower() for c in SIREN_CHOICES]
    if want.lower() not in lc:
        raise ValueError(f"radio_wide.siren_pa_options: expected one of {SIREN_CHOICES}, got {want!r}")
    want = SIREN_CHOICES[lc.index(want.lower())]
    c = blk["chb"]
    if c is None:
        raise ValueError("radio_wide.siren_pa_options: control-head block not found")
    on = want != "Disabled"
    _setbit(out, 0x17C, 7, on)
    _setbit(out, c + 0x14, 2, on)
    _setbit(out, c + 0x5E, 7, on)
    _setbit(out, c + 0x5F, 7, want == "PA only")


HEAD_CHOICES = ("Standard", "Enhanced", "Rotary")


def _encode_head(out: bytearray, blk: dict, orig: dict, want: str) -> None:
    """Control Head Type, as RSS does it (617ASN, 566AYA, 617ASQ, 604AUN; every
    transition between Standard/Enhanced/Rotary captured both ways):

    * Enhanced/Rotary: 0x1CD b3 and CHB+0x17 b1 set, CHB+0x46 |= 0x0C (sticky),
      and the CONTROL HEAD OPTIONS byte ext+0x6C reset to its default 0x63
      (the Standard head has no options screen; its byte is left alone).
    * Rotary: also 0x10D b4; Phone/DTMF Encode (0x10D b6) forced to List,
      Volume Set Tone (0x10E b4) off, and Mode Change Tone (0x10E b0) off when
      Zone Operation is off (home zone 0) - it becomes a zone-mode tone.
    * Leaving Rotary: Phone/DTMF Encode back to the model default = NOT 0x10D b1.
    W and both checksums are recomputed by encode(). S9000e (A9) is fixed in RSS."""
    lc = [c.lower() for c in HEAD_CHOICES]
    if orig["control_head_type"] not in HEAD_CHOICES or want.lower() not in lc:
        raise ValueError("radio_wide.control_head_type: only Standard / Enhanced / Rotary "
                         "can be swapped (RSS can't change to or from S9000e)")
    want = HEAD_CHOICES[lc.index(want.lower())]
    c, e = blk["chb"], blk["ext"]
    if c is None or e is None:
        raise ValueError("radio_wide.control_head_type: control-head/ext block not found")
    fancy = want != "Standard"
    _setbit(out, 0x1CD, 3, fancy)
    _setbit(out, c + 0x17, 1, fancy)
    if fancy:
        out[c + 0x46] |= 0x0C
        out[e + 0x6C] = 0x63
    rotary = want == "Rotary"
    _setbit(out, 0x10D, 4, rotary)
    if rotary:
        _setbit(out, 0x10D, 6, False)
        _setbit(out, 0x10E, 4, False)
        if out[0x1DD] == 0:
            _setbit(out, 0x10E, 0, False)
    elif orig["control_head_type"] == "Rotary":
        _setbit(out, 0x10D, 6, not out[0x10D] >> 1 & 1)


_GATES = {f.when[0] for f in FIELDS if f.when}


def encode(body: bytes, values: dict) -> bytearray:
    """Apply edited radio-wide values to a copy of body (template-patch).

    Change-gated per field against the decoded original, so values that are
    unchanged (or absent) leave their bytes untouched; the extension block's
    checksum is recomputed only if one of its bytes changed."""
    out = bytearray(body)
    orig = decode(body)
    blk = _blocks(body)
    ext = blk
    touched = set()
    # Siren/P.A. Options first: enabling it reveals the siren settings, which
    # may be edited in the same call (re-decode after it).
    order = {"control_head_type": 0, "siren_pa_options": 1, "scan_off_hub": 1}
    items = sorted(values.items(), key=lambda kv: order.get(kv[0], 2))
    base = dict(orig)                 # the template's values, before side effects
    for key, new in items:
        f = FIELD_BY_KEY.get(key)
        # Only what the caller changed vs the template is applied, so side
        # effects of a head-type / siren change (e.g. reset backlight options)
        # stand unless those fields were edited too.
        if key in base and _same(new, base[key]) and key not in order:
            continue
        if f is None or new is None or key not in orig:
            continue
        a = _abs(f, ext)
        if f.kind == "bit":
            on = _parse_bool(key, new)
            if EN[on] == orig[key]:
                continue
            if not f.editable:
                raise ValueError(f"radio_wide.{key} is read-only")
            _setbit(out, a, f.bit, on ^ f.invert)
            for area, off, bit in f.mirrors:
                m = _loc(area, off, ext)
                if m is not None:
                    _setbit(out, m, bit, on)
                    touched.add(area)
            if key in _GATES:             # reveals / hides dependent fields
                orig = decode(bytes(_finish(bytearray(out), blk, set(touched))))
        elif f.kind == "enum":
            want = str(new).strip()
            if want == orig[key]:
                continue
            lc = [c.lower() for c in f.choices]
            if want.lower() not in lc:
                raise ValueError(f"radio_wide.{key}: expected one of {f.choices}, got {new!r}")
            n = lc.index(want.lower())
            if not f.editable:
                raise ValueError(f"radio_wide.{key} is read-only")
            if want.startswith("?"):
                raise ValueError(f"radio_wide.{key}: {new!r} is not a valid choice")
            out[a] = (out[a] & ~(f.mask << f.bit) & 0xFF) | (n << f.bit)
        elif f.kind == "busywait":
            inf = str(new).strip().lower() == "infinite"
            val = "Infinite" if inf else float(new)
            if val == orig[key]:
                continue
            fo, fb = _BUSY_FLAG
            _setbit(out, fo, fb, inf)
            if not inf:
                if val * 2 != int(val * 2) or not 0 < val * 2 <= 0xFF:
                    raise ValueError(f"radio_wide.{key}: {new!r} not a 0.5 s step")
                out[a] = int(val * 2)
            else:
                out[a] = 0
        elif f.kind == "siren":
            want = str(new).strip()
            if want.lower() == orig[key].lower():
                continue
            _encode_siren(out, blk, orig, want)
            touched.add("chb")
            orig = decode(bytes(_finish(out, blk, touched)))   # reveals siren settings
            continue
        elif f.kind == "rearm":
            want = str(new).strip()
            if want.lower() == orig[key].lower():
                continue
            lc = [x.lower() for x in REARM_CHOICES]
            if want.lower() not in lc:
                raise ValueError(f"radio_wide.{key}: expected one of {REARM_CHOICES}, got {new!r}")
            want = REARM_CHOICES[lc.index(want.lower())]
            _setbit(out, a, 0, want != "Disabled")             # CHB+0x18 b0
            _setbit(out, a - 0x18 + 0x13, 0, want == "Permanent")
            touched.add("chb")
            continue
        elif f.kind == "headtype":
            want = str(new).strip()
            if want.lower() == orig[key].lower():
                continue
            _encode_head(out, blk, orig, want)
            touched |= {"chb", "ext"}
            orig = decode(bytes(_finish(out, blk, touched)))
            continue
        elif f.kind == "dial":
            s = str(new).strip()
            if s == orig[key]:
                continue
            n = len(f.nibs)
            if len(s) > n or any(c not in "0123456789*#" for c in s):
                raise ValueError(f"radio_wide.{key}: expected up to {n} of 0-9 * #, got {new!r}")
            s = s.rjust(n) if f.rjust else s.ljust(n)
            for (ar, o, hi), v in zip(f.nibs, dial_encode(s)):
                _setnib(out, _loc(ar, o, ext), hi, v)
                touched.add(ar)
        elif f.kind == "word":
            n = int(new)
            if n == orig[key]:
                continue
            if n % f.scale or not 0 <= n // f.scale <= 0xFFFF:
                raise ValueError(f"radio_wide.{key}: {n} not a multiple of {f.scale} in range")
            out[a:a + 2] = (n // f.scale).to_bytes(2, "big")
        elif f.kind in ("nibble", "hinibble", "byte"):
            n = int(new)
            if n == orig[key]:
                continue
            if n % f.scale:
                raise ValueError(f"radio_wide.{key}: {n} is not a multiple of {f.scale}")
            n //= f.scale
            if not f.editable:
                raise ValueError(f"radio_wide.{key} is read-only")
            hi = 0xFF if f.kind == "byte" else 0x0F
            if not 0 <= n <= hi:
                raise ValueError(f"radio_wide.{key}: {n} out of range 0..{hi}")
            if f.kind == "nibble":
                out[a] = (out[a] & 0xF0) | n
            elif f.kind == "hinibble":
                out[a] = (out[a] & 0x0F) | (n << 4)
            else:
                out[a] = n
        elif f.kind == "bcd":
            s = str(new).strip()
            if s.isdigit():
                s = s.zfill(2 * f.width)
            if s == orig[key]:
                continue
            if not (s.isdigit() and len(s) == 2 * f.width):
                raise ValueError(f"radio_wide.{key}: expected {2 * f.width} digits, got {new!r}")
            out[a:a + f.width] = bytes.fromhex(s)
        elif f.kind == "bcdf":
            s = str(new).strip()
            if s == orig[key]:
                continue
            if not (s.isdigit() and 1 <= len(s) <= 2 * f.width):
                raise ValueError(f"radio_wide.{key}: expected 1..{2 * f.width} digits, got {new!r}")
            out[a:a + f.width] = bytes.fromhex(s.ljust(2 * f.width, "f"))
        touched.add(f.area)
    return _finish(out, blk, touched)


def _finish(out: bytearray, blk: dict, touched: set) -> bytearray:
    """Recompute the derived bytes of every touched block: ext checksum; CHB
    summary word W, then CHB checksum."""
    e, c = blk["ext"], blk["chb"]
    if "ext" in touched:
        L = out[e]
        out[e + L - 1] = sum(out[e:e + L - 1]) & 0xFF
    if "chb" in touched:
        w = chb_summary_word(out, c)
        out[c + CHB_W], out[c + CHB_W + 1] = w >> 8, w & 0xFF
        out[c + CHB_CK] = sum(out[c + CHB_SUM_LO:c + CHB_CK]) & 0xFF
    return out
