"""Radio-wide multi-row lists (exported as CSV): the PHONE LIST and the MPL
(Multiple Private Line) list from RSS CHANGE/VIEW -> CONVENTIONAL.

Located white-box with the dosbox-x harness (tools/scenario_steps.py: type a
value in RSS, SAVE, decrypt-diff) and validated against the RSS screens of
every on-hand radio (notes/ground-truth/lists_<serial>.json, tests/test_lists.py).

PHONE LIST (9 entries; shared by conventional and trunked interconnect):

* numbers: 9 x 8 bytes at 0x1E8 (fixed header), 16 dial nibbles each,
  0-9 = digits, 0xA = '*', 0xB = '#', 0xC = 'P' (pause), 0xF = unused.
* names: standard heads -- 9 x 6 bytes at 0x230, 8 chars 6-bit packed (same
  codec as mode names). A9/expanded heads keep 0x230.. for other data and store
  the names as 11-char ASCII in the string block that precedes the zone names
  (see :func:`_a9_phone_names_off`).

Editing either touches only those bytes (no checksum, no pointers).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .codeplug import Codeplug, pack_name, unpack_name
from .radiowide import dial_decode, dial_encode

PHONE_COUNT = 9
PHONE_NUM_OFF = 0x1E8
PHONE_NUM_LEN = 8           # bytes = 16 dial nibbles
PHONE_NAME_OFF = 0x230      # 6-bit names (standard heads)
PHONE_NAME_LEN = 6
PHONE_DIAL_CHARS = "0123456789*#P"

# A9 ASCII string block, in order (11 chars per slot): STATUS x8, MESSAGE x8,
# CODE x4, UNIT x8, UNIT x8, PHONE x9, SITE x8, MPL x16, one more (" REMOTE"),
# then the zone names and the mode names. Seen on 221AZN (T83FWA7HA9AK).
A9_SLOTS_PHONE_TO_ZONES = PHONE_COUNT + 8 + 16 + 1
A9_SLOTS_MPL_TO_ZONES = 16 + 1


@dataclass
class Phone:
    number: int
    name: str
    dial: str


def _a9_block(cp: Codeplug, slots_before_zones: int):
    """(offset, width) of an A9 ASCII table that sits `slots_before_zones`
    11-char slots before the zone names (which directly precede the mode-name
    table), or None if this is not an A9 codeplug."""
    if cp.ascii_names is None:
        return None
    start, w = cp.ascii_names
    off = start - (len(cp.zones) + slots_before_zones) * w
    blk = cp.body[off:off + slots_before_zones * w]
    if off < 0 or not all(0x20 <= c < 0x7F for c in blk):
        raise ValueError("A9 ASCII string block not where expected")
    return off, w


def _phone_name_slots(cp: Codeplug):
    """[(offset, width, encoding)] for the 9 phone-name slots."""
    a9 = _a9_block(cp, A9_SLOTS_PHONE_TO_ZONES)
    if a9 is not None:
        off, w = a9
        return [(off + k * w, w, "ascii") for k in range(PHONE_COUNT)]
    return [(PHONE_NAME_OFF + k * PHONE_NAME_LEN, PHONE_NAME_LEN, "6bit")
            for k in range(PHONE_COUNT)]


def _nibbles(bs: bytes) -> list:
    out = []
    for b in bs:
        out += [b >> 4, b & 0xF]
    return out


def decode_phones(cp: Codeplug) -> list:
    body = cp.body
    out = []
    for k, (noff, w, enc) in enumerate(_phone_name_slots(cp)):
        raw = body[noff:noff + w]
        name = raw.decode("latin-1").rstrip(" \x00") if enc == "ascii" else unpack_name(raw)
        nib = _nibbles(body[PHONE_NUM_OFF + k * PHONE_NUM_LEN:][:PHONE_NUM_LEN])
        dial = dial_decode(nib[:nib.index(0xF)] if 0xF in nib else nib)
        out.append(Phone(k + 1, name, dial))
    return out


def encode_phones(cp: Codeplug, body: bytearray, phones) -> None:
    """Patch phone names/numbers into body (change-gated per entry)."""
    orig = {p.number: p for p in decode_phones(cp)}
    slots = _phone_name_slots(cp)
    for p in phones:
        o = orig.get(p.number)
        if o is None:
            raise ValueError(f"phone {p.number}: only entries 1..{PHONE_COUNT} exist")
        noff, w, enc = slots[p.number - 1]
        if p.name != o.name:
            if enc == "ascii":
                if len(p.name) > w or not all(0x20 <= ord(c) < 0x7F for c in p.name):
                    raise ValueError(f"phone {p.number}: name {p.name!r} must be <= {w} ASCII chars")
                body[noff:noff + w] = p.name.ljust(w).encode("ascii")
            else:
                if len(p.name) > 8:
                    raise ValueError(f"phone {p.number}: name {p.name!r} longer than 8 chars")
                body[noff:noff + w] = pack_name(p.name.upper())
        dial = p.dial.strip().upper()
        if dial != o.dial:
            if len(dial) > 2 * PHONE_NUM_LEN or any(c not in PHONE_DIAL_CHARS for c in dial):
                raise ValueError(f"phone {p.number}: number {p.dial!r} must be <= 16 of 0-9 * # P")
            nib = dial_encode(dial) + [0xF] * (2 * PHONE_NUM_LEN - len(dial))
            a = PHONE_NUM_OFF + (p.number - 1) * PHONE_NUM_LEN
            body[a:a + PHONE_NUM_LEN] = bytes(nib[i] << 4 | nib[i + 1]
                                              for i in range(0, len(nib), 2))


def phone_offsets(cp: Codeplug) -> set:
    offs = set(range(PHONE_NUM_OFF, PHONE_NUM_OFF + PHONE_COUNT * PHONE_NUM_LEN))
    for noff, w, _ in _phone_name_slots(cp):
        offs |= set(range(noff, noff + w))
    return offs


# ---------------------------------------------------------------------------
# MPL LIST (Multiple Private Line; header 0x119 = count, 0 = Disabled).
#
# A table of N 6-byte records -- RX, TX, TA squelch slots, 2 bytes each, the
# same 16-bit tone-slot codec as VHF mode records on EVERY band: 0 = Carrier,
# >= 0xC000 = DPL, else bit15 + 15-bit value (RX: Hz * 61.2428, TX/TA: the
# period 165596.6 / Hz). Standard heads follow it directly with N 6-bit
# names; A9 heads keep 16 ASCII names in the string block instead.
# DPL polarity (hi-byte bit 0x20) uses the TX sense of the mode-record codec
# (SET = INV.DPL) for TX/TA on both bands and for RX on 900 MHz (RSS: 566 MPL 1
# Rx DPL 023 = d8 64, INV.DPL 023 = f8 64); a VHF RX slot uses the RX sense
# (SET = DPL), exactly as in VHF mode records (221AZN MPL 3 Rx d5 49 shows
# "INV.DPL 311").
# The table moves with other variable sections, so it is located
# structurally (:func:`find_mpl_table`). Editing it changes nothing else.
MPL_REC_LEN = 6
# RSS's MPL screen shows TX/TA tones as K / period to 0.1 Hz. Every displayed
# value captured (19 distinct TX periods, incl. the non-standard 986 ->
# "168.0 --" and 889 -> "186.3 --") pins K to [165598.7, 165603.6) (bounds set
# by 986 and 1256 -> 131.8); 165596.6 (the mode-record fit) shows 167.9 for
# 986. Display only: encoding uses RSS's exact byte pairs.
MPL_TX_DISPLAY_K = 165600.0
MPL_SQ = ("rx", "tx", "ta")
_NAME_OK = set(" !\"#$%&'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_")


def _slot_ok(hi: int, lo: int, is_tx: bool) -> bool:
    from .codeplug import vhf_dpl_decode
    v = hi << 8 | lo
    if v == 0:
        return True
    if v >= 0xC000:
        return vhf_dpl_decode(hi, lo)[0] is not None
    if not v & 0x8000:
        return False
    low = v & 0x7FFF
    if not low:
        return False
    f = 165596.6 / low if is_tx else low / 61.2428
    return 60.0 <= f <= 260.0


def _rec_ok(r: bytes) -> bool:
    return all(_slot_ok(r[2 * i], r[2 * i + 1], i > 0) for i in range(3))


def find_mpl_table(cp: Codeplug) -> Optional[int]:
    """Offset of the MPL code table, or None when MPL is disabled.

    Candidates: N consecutive valid squelch triples (N = header count) that
    are not all Carrier, and -- on standard heads -- followed by N plausible
    6-bit names. Exactly one candidate must exist (else ValueError)."""
    body = cp.body
    n = body[0x119]
    if n == 0:
        return None
    a9 = cp.ascii_names is not None
    span = n * MPL_REC_LEN
    hits = []
    for p in range(0x1E8, len(body) - span * (1 if a9 else 2)):
        recs = [body[p + k * MPL_REC_LEN:p + (k + 1) * MPL_REC_LEN] for k in range(n)]
        if not all(_rec_ok(r) for r in recs) or not any(any(r) for r in recs):
            continue
        if not a9:
            names = [unpack_name(body[p + span + 6 * k:p + span + 6 * k + 6]) for k in range(n)]
            if not all(nm and set(nm) <= _NAME_OK for nm in names):
                continue
        hits.append(p)
    # Bytes before the table (zero padding, or anything that happens to decode
    # as squelch slots) give the same table shifted back 6 bytes at a time; the
    # real start is the last of that run. (A shift past it would need the first
    # name to decode as a valid triple, which 6-bit letters/digits never do.)
    if hits and all(b - a == MPL_REC_LEN for a, b in zip(hits, hits[1:])):
        hits = hits[-1:]
    if len(hits) != 1:
        raise ValueError(f"MPL table not uniquely located ({[hex(h) for h in hits]})")
    return hits[0]


@dataclass
class Mpl:
    number: int
    name: str
    rx_type: str        # RSS wording: "Carrier" | "TPL" | "DPL" | "INV.DPL"
    rx_code: str        # "100.0" (TPL Hz, as RSS displays it) | "023" (DPL) | ""
    tx_type: str
    tx_code: str
    ta_type: str
    ta_code: str


def _mpl_dpl_tx_sense(i: int, band) -> bool:
    """Polarity sense for MPL slot i (0=RX, 1=TX, 2=TA) -- see above."""
    return i > 0 or band != "vhf"


def mpl_slot_decode(hi: int, lo: int, is_tx: bool, dpl_tx_sense: bool = True):
    """-> (type, code) as the RSS MPL screen shows it. TPL is displayed as the
    frequency the stored value represents, to 0.1 Hz (so a non-standard value
    reads e.g. 186.3 where the standard 186.2 tone is stored differently)."""
    from .codeplug import vhf_dpl_decode
    v = hi << 8 | lo
    if v == 0:
        return "Carrier", ""
    if v >= 0xC000:
        t, code = vhf_dpl_decode(hi, lo, dpl_tx_sense)
        return t, code[1:]
    low = v & 0x7FFF
    f = MPL_TX_DISPLAY_K / low if is_tx else low / 61.2428
    return "TPL", f"{f:.1f}"


def mpl_slot_encode(typ: str, code: str, is_tx: bool, dpl_tx_sense: bool = True) -> bytes:
    from .codeplug import vhf_dpl_encode, vhf_pl_encode
    t = (typ or "").strip().upper()
    code = str(code or "").strip()
    if t in ("CARRIER", "CSQ", ""):
        return b"\0\0"
    if t in ("TPL", "PL"):
        pair = vhf_pl_encode(code, is_tx)
    elif t in ("DPL", "INV.DPL", "INV DPL"):
        pair = vhf_dpl_encode("D" + code.lstrip("Dd").zfill(3), t != "DPL", dpl_tx_sense)
    else:
        raise ValueError(f"MPL squelch type {typ!r}: expected Carrier/TPL/DPL/INV.DPL")
    if pair is None:
        raise ValueError(f"MPL {typ} code {code!r} is not valid")
    return bytes(pair)


def _mpl_name_slots(cp: Codeplug, p: int, n: int):
    a9 = _a9_block(cp, A9_SLOTS_MPL_TO_ZONES)
    if a9 is not None:
        off, w = a9
        return [(off + k * w, w, "ascii") for k in range(n)]
    return [(p + n * MPL_REC_LEN + 6 * k, 6, "6bit") for k in range(n)]


def decode_mpls(cp: Codeplug) -> list:
    p = find_mpl_table(cp)
    if p is None:
        return []
    body, n = cp.body, cp.body[0x119]
    out = []
    for k, (noff, w, enc) in enumerate(_mpl_name_slots(cp, p, n)):
        raw = body[noff:noff + w]
        name = raw.decode("latin-1").strip() if enc == "ascii" else unpack_name(raw)
        r = body[p + k * MPL_REC_LEN:p + (k + 1) * MPL_REC_LEN]
        sq = [mpl_slot_decode(r[2 * i], r[2 * i + 1], i > 0, _mpl_dpl_tx_sense(i, cp.band))
              for i in range(3)]
        out.append(Mpl(k + 1, name, *sq[0], *sq[1], *sq[2]))
    return out


def encode_mpls(cp: Codeplug, body: bytearray, rows) -> None:
    """Patch MPL names/squelch into body. Change-gated per field, so a slot
    whose displayed value is unchanged keeps its exact stored bytes."""
    p = find_mpl_table(cp)
    orig = {m.number: m for m in decode_mpls(cp)}
    if not orig and rows:
        raise ValueError("MPL is disabled in this codeplug (Number of MPL = 0); "
                         "enable it in RSS first")
    slots = _mpl_name_slots(cp, p, len(orig)) if orig else []
    for m in rows:
        o = orig.get(m.number)
        if o is None:
            raise ValueError(f"MPL {m.number}: only entries 1..{len(orig)} exist")
        noff, w, enc = slots[m.number - 1]
        if m.name != o.name:
            if enc == "ascii":
                if len(m.name) > w:
                    raise ValueError(f"MPL {m.number}: name {m.name!r} longer than {w}")
                body[noff:noff + w] = m.name.ljust(w).encode("ascii")
            else:
                if len(m.name) > 8:
                    raise ValueError(f"MPL {m.number}: name {m.name!r} longer than 8")
                body[noff:noff + w] = pack_name(m.name.upper())
        for i, sq in enumerate(MPL_SQ):
            t, c = getattr(m, sq + "_type"), getattr(m, sq + "_code")
            if (t, c) == (getattr(o, sq + "_type"), getattr(o, sq + "_code")):
                continue
            a = p + (m.number - 1) * MPL_REC_LEN + 2 * i
            body[a:a + 2] = mpl_slot_encode(t, c, i > 0, _mpl_dpl_tx_sense(i, cp.band))


def mpl_offsets(cp: Codeplug) -> set:
    p = find_mpl_table(cp)
    if p is None:
        return set()
    n = cp.body[0x119]
    offs = set(range(p, p + n * MPL_REC_LEN))
    for noff, w, _ in _mpl_name_slots(cp, p, n):
        offs |= set(range(noff, noff + w))
    return offs


# ---------------------------------------------------------------------------
# A9 control-head checksum. RSS warns "Bad control head checksum." on GET when
# the A9 ASCII string block (status/message/.../phone/site/MPL/zone/mode names)
# changes without it. Found by diffing RSS saves (221AZN, 2026-10-23): a 16-bit
# sum of BIG-endian words aligned at ODD addresses (odd byte = high, next even
# byte = low), stored big-endian at CK (odd) right after the mode records,
# behind an ff x6 00 00 run (0xDAF on 221AZN). An odd-lane overflow is lost
# (no higher byte) while an even-lane borrow reaches the high byte -- seen as
# motreader's "ZTEST" zone rename being off by 0x100 until carried. RSS edits of the MPL
# table, the radio-wide ext section and the mode records leave it unchanged.
# The exact region start/end and initial constant are not pinned down (one A9
# sample), so motreader updates it incrementally by the edit's per-lane delta.
A9_ASCII_SLOTS_BEFORE_PHONE = 8 + 8 + 4 + 8 + 8     # STATUS, MESSAGE, CODE, UNIT x2
_CK_MARK = b"\xff" * 6 + b"\x00\x00"


def a9_head_checksum_off(cp: Codeplug) -> Optional[int]:
    if cp.ascii_names is None:
        return None
    ends = [m.offset + len(m.raw) for m in cp.modes if m.offset >= 0]
    if not ends:
        return None
    end = max(ends)
    # the head block starts on a page boundary (body offset = 0xAD mod 0x100)
    # after the radio data; up to a page of FF padding precedes it
    k = cp.body.find(_CK_MARK, end, end + 0x140)
    while k >= 0 and (k + 6 - 0xAD) % 0x100:
        k = cp.body.find(_CK_MARK, k + 1, end + 0x140)
    return None if k < 0 else k + len(_CK_MARK)


def a9_ascii_range(cp: Codeplug):
    """[lo, hi) of the A9 ASCII string block (STATUS 1 .. last mode name)."""
    slots = _phone_name_slots(cp)
    start, w = cp.ascii_names
    return slots[0][0] - A9_ASCII_SLOTS_BEFORE_PHONE * w, start + len(cp.modes) * w


def fix_a9_head_checksum(cp: Codeplug, body: bytearray) -> None:
    """Carry the A9 control-head checksum over edits of the ASCII string block
    (body = edited copy of cp.body). No-op for other heads / unchanged block."""
    if cp.ascii_names is None:
        return
    lo, hi = a9_ascii_range(cp)
    delta = sum((body[i] - cp.body[i]) << (8 if i & 1 else 0)
                for i in range(lo, hi) if body[i] != cp.body[i])
    if not delta:
        return
    ck = a9_head_checksum_off(cp)
    if ck is None or lo <= ck < hi:
        raise ValueError("A9 control-head checksum not found; refusing to edit "
                         "names on this head (RSS would report a bad checksum)")
    v = (int.from_bytes(body[ck:ck + 2], "big") + delta) & 0xFFFF
    body[ck:ck + 2] = v.to_bytes(2, "big")
