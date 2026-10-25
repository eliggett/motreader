"""Remove trunking from a TRUNKED DUAL MODE codeplug (900 MHz Spectra).

RSS won't delete the last trunked mode (one is needed per system, in a zone);
the repeater-builder workaround exploits an RSS bug (notes/Miscellaneous
Spectra Topics.html, "Removing That Last Trunking Mode"). This does the end
result directly, the way RSS stores it on a radio that went through that
(604AUN: TRUNKED DUAL MODE with MAX SYSTEMS / SUBFLEETS 00 and "No Trunking
data loaded"): the trunked mode becomes an ordinary conventional mode instead
of disappearing, so no mode, zone, scan list or name renumbers and you gain a
channel.

Layout (566AYA, A617AVE0.527, A604HQJ2.211; FORMAT §5h):
  * mode 1 is the trunked mode: a 37-byte record (regular records are L =
    header 0x10A bytes) whose word at +2 points at the personality section;
  * personality section: length byte 0x1B, 27 bytes, right after the mode
    records; its word at +10 points 4 bytes into a talkgroup block (4-byte
    head + 37 bytes) at the end of the data;
  * header 0x1D6 / 0x1D7 = MAX SYSTEMS / MAX SUBFLEETS, 0x1DC = 0x54 trunk byte;
  * header word 0xE9 -> trunking system tables when present (A617AVE0.527 /
    A604HQJ2.211, MAX SYSTEMS 15): RSS's re-save also removes those; such
    codeplugs are refused for now (566AYA has none);
  * ext+0x86 = number of conventional modes; the mode-list section (header
    0xE7: index list, per-mode type bytes, …, 8-bit sum before the pointer
    table) marks the trunked mode with type 0x10 on 566AYA.

Conversion (byte-identical to RSS's own GET + re-SAVE of the result):
mode 1 := copy of mode 2 (edit it afterwards; the 37-byte trunked record is
replaced by an L-byte conventional one, shorter or longer), type byte 0,
systems / subfleets 0, 0x1DC 0, ext count = n, personality + talkgroup block
removed, mode pointers and ext +0x20/+0x22 moved, pointer-table / mode-list /
ext sums, 0xC9, FF padding.
"""

from __future__ import annotations

from .codeplug import mode_pointer_table
from . import radiowide as RW

TRUNK_REC_LEN = 37
PERS_LEN = 0x1B
TG_HEAD = 4
MAX_SYSTEMS, MAX_SUBFLEETS, TRUNK_BYTE = 0x1D6, 0x1D7, 0x1DC
TYPE_TRUNKED = 0x10
EXT_CONV_COUNT = 0x86        # ext: number of conventional modes (both ext layouts)
SYSTEM_PTR = 0xE9            # header word -> trunking system tables (0 on 566AYA)


def _be(b, o):
    return b[o] << 8 | b[o + 1]


def _put(b, o, v):
    b[o:o + 2] = (v & 0xFFFF).to_bytes(2, "big")


def trunking_info(body: bytes):
    """None if the codeplug has no trunked mode, else a dict describing it
    (raises ValueError if it has trunking in a shape not handled)."""
    pt = mode_pointer_table(body)
    if pt is None:
        return None
    base, tab, starts = pt
    n, L = body[0x109], body[0x10A]
    if len(starts) < 2 or starts[1] - starts[0] == L:
        return None
    lens = [starts[i + 1] - starts[i] for i in range(n - 1)]
    if starts[1] - starts[0] != TRUNK_REC_LEN or any(x != L for x in lens[1:]):
        raise ValueError("more than one trunked mode (or an unknown record layout): "
                         "only one trunked mode is handled; use RSS")
    if _be(body, SYSTEM_PTR):
        raise ValueError("this codeplug also holds trunking SYSTEM tables (header 0xE9 "
                         "points at them; RSS re-packs those too): not handled yet, use RSS")
    e = RW.find_ext_block(body)
    if e is None:
        raise ValueError("radio-wide ext block not found")
    r0 = starts[0]
    pers = _be(body, r0 + 2) - base
    if not (starts[-1] + L <= pers < len(body)) or body[pers] != PERS_LEN:
        raise ValueError("trunk personality section not where expected; use RSS")
    tg = _be(body, pers + 10) - base - TG_HEAD
    data_end = len(body)
    while data_end and body[data_end - 1] == 0xFF:
        data_end -= 1
    if not (pers + PERS_LEN <= tg < data_end) or data_end - tg != TG_HEAD + 37:
        raise ValueError("trunk talkgroup block not where expected; use RSS")
    if body[e + EXT_CONV_COUNT] != n - 1:
        raise ValueError("conventional mode count not where expected; use RSS")
    return {"base": base, "tab": tab, "starts": starts, "n": n, "L": L, "ext": e,
            "r0": r0, "pers": pers, "tg": tg, "data_end": data_end,
            "systems": body[MAX_SYSTEMS], "subfleets": body[MAX_SUBFLEETS]}


def remove_trunking(body: bytes) -> bytes:
    """Convert the trunked mode into a conventional one (a copy of mode 2) and
    drop the trunking personality/system data. Returns the new body."""
    t = trunking_info(body)
    if t is None:
        raise ValueError("no trunked mode in this codeplug")
    base, tab, starts, n, L, e = t["base"], t["tab"], t["starts"], t["n"], t["L"], t["ext"]
    r0, pers, tg = t["r0"], t["pers"], t["tg"]
    s2 = _be(body, 0xE7) - base
    # (offset, old length, new bytes); the trunked record becomes an L-byte
    # conventional record (shorter or longer than its 37 bytes)
    edits = [(r0, TRUNK_REC_LEN, body[starts[1]:starts[1] + L]),
             (pers, PERS_LEN, b""), (tg, t["data_end"] - tg, b"")]

    def moved(p):
        return p + sum(len(nb) - ln for o, ln, nb in edits if o + ln <= p and o < p)

    out = bytearray(body)
    out[s2 + n] = 0                                  # mode 1 type -> conventional
    out[tab - 1] = sum(out[s2:tab - 1]) & 0xFF       # mode-list section sum
    out[MAX_SYSTEMS] = out[MAX_SUBFLEETS] = out[TRUNK_BYTE] = 0
    out[e + EXT_CONV_COUNT] = n                      # conventional modes
    for i, p in enumerate(starts):
        _put(out, tab + 2 * i, moved(p) + base)
    out[tab + 2 * n] = sum(out[tab:tab + 2 * n]) & 0xFF
    for k in (0x20, 0x22):
        w = _be(body, e + k) - base
        if r0 < w < len(body):
            _put(out, e + k, moved(w) + base)
    Le = out[e]
    out[e + Le - 1] = sum(out[e:e + Le - 1]) & 0xFF
    for o, ln, nb in sorted(edits, key=lambda x: x[0], reverse=True):
        out[o:o + ln] = nb
    end = len(out)
    while end and out[end - 1] == 0xFF:
        end -= 1
    tot = end + ((0xAD - end) % 0x100)
    new = out[:end] + b"\xff" * (tot - end)
    new[0xC9] = (new[0xC9] + (len(new) - len(body)) // 32) & 0xFF
    return bytes(new)
