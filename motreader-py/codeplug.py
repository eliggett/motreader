"""Decode a Spectra codeplug (decrypted archive body) into structured data.

Field mapping is incremental and **band-aware**. The archive body layout and the
per-channel frequency encoding differ between radio bands, so the decoder detects
the band from the body structure and applies the matching codec.

Solidly decoded so far:

* container + cipher (byte-exact, see archive.py / crypto.py)
* codeplug header: signature, serial, model
* mode alpha-tags (6-bit packed name table at 0x0266)
* **VHF conventional**: RX, TX and T/A frequencies, each an INDEPENDENT per-field
  value. The encoding is linear in the individual record bytes (NOT in the packed
  integer) and was recovered + validated byte-exact against RSS via the inverse
  oracle (patch a stored value, let RSS decode+PRINT the MHz). See notes/FORMAT.md.
* **900 MHz conventional**: RX / talk-around frequency (linear `925.65 + 0.0125*v`)
  and RX PL/DPL. TX is not yet independently decoded for 900 (see note below).

Unmapped fields are preserved verbatim as the raw record bytes so that an edit +
re-encrypt is lossless.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# ---------------------------------------------------------------------------
# Mode alpha-tag table: 8 characters 6-bit packed (char - 0x20, MSB first) =
# 6 bytes per mode, in mode order. Same offset on the VHF and 900 samples.
# Found via the RSS differential oracle (editing a name).
NAME_TABLE_OFF = 0x0266
NAME_LEN_BYTES = 6
NAME_CHARS = 8


def unpack_name(b6: bytes) -> str:
    bits = 0
    nb = 0
    out = []
    for by in b6:
        bits = (bits << 8) | by
        nb += 8
        while nb >= 6:
            nb -= 6
            out.append(chr(((bits >> nb) & 0x3F) + 0x20))
    return "".join(out[:NAME_CHARS]).rstrip()


# ---------------------------------------------------------------------------
# A9 / "CONVENTIONAL EXPANDED" head (e.g. T83FWA...A9..): mode names are stored
# as fixed-width PLAIN ASCII (not 6-bit packed) in a separate table, in mode
# order. Width is head-dependent (11 chars seen on 221AZN). Standard heads leave
# the 6-bit table at 0x0266 populated; expanded heads leave it blank and use this
# table instead.
#
# The table is located STRUCTURALLY, not by recognising user names. RSS fills
# every unprogrammed mode slot with the fixed default name ``MODE <n>`` (n = the
# 1-based mode number). Those defaults appear verbatim in the body on a constant
# stride, and each one pins the table's start and width exactly:
#   width  = the stride between consecutive "MODE <n>" defaults
#   start  = default_offset - (n - 1) * width - (lead padding in the field)
# All defaults agree on one (start, width), independent of what the user named
# the programmed modes. (Only a fully-programmed codeplug with zero default slots
# lacks this anchor; that rare case falls back to a frequency-correlation
# heuristic -- see ``_find_name_table_by_freq``.)
import re as _re

ASCII_NAME_WIDTHS = range(16, 6, -1)
_MODE_DEFAULT = _re.compile(rb"MODE +(\d+)")


def _ascii_name_field_ok(f: bytes) -> bool:
    """A left-justified ASCII name field: starts with a visible char, all bytes
    printable or NUL, and no data after a NUL pad byte."""
    if not f or not (0x21 <= f[0] <= 0x7E):
        return False
    if not all(b == 0 or 0x20 <= b <= 0x7E for b in f):
        return False
    head, _, tail = bytes(f).partition(b"\x00")
    return not any(tail)  # once padding (NUL) starts, the rest must be NUL


def _find_name_table_by_defaults(body: bytes, n: int):
    """Locate the ASCII name table from RSS's ``MODE <n>`` default slots. Returns
    (start, width) or None. Content-independent: it keys off Motorola's fixed
    default string, not the user's names.

    The default's number is right-justified to the field's end, so each default
    gives ``table_start = match.end() - n_mode * width`` with ``width`` = the
    stride between consecutive defaults. Every default agrees on one start."""
    occ = [(m.start(), m.end(), int(m.group(1))) for m in _MODE_DEFAULT.finditer(body)]
    if len(occ) < 3:
        return None
    from collections import Counter
    w, freq = Counter(b[0] - a[0] for a, b in zip(occ, occ[1:])).most_common(1)[0]
    if freq < 2 or not (7 <= w <= 16):
        return None
    start, agree = Counter(end - num * w for _, end, num in occ).most_common(1)[0]
    if agree < 2 or start < 0 or start + n * w > len(body):
        return None
    # anchored by the defaults, so only require printable fields: a default
    # inside the table ("  MODE   66", after an ADD MODE) starts with spaces
    if all(all(b == 0 or 0x20 <= b <= 0x7E for b in body[start + i * w : start + (i + 1) * w])
           for i in range(n)):
        return start, w
    return None


def _digits(s: str) -> str:
    return "".join(c for c in s if c.isdigit())


def _freq_hint(freq) -> str:
    """Digit string a ham mode name often embeds for this RX freq, e.g.
    146.520 -> '146520' (names like '146 520' or 'KC8MOB 6505' share a run)."""
    if not freq:
        return ""
    return f"{int(round(freq * 1000)):d}"


def _name_table_score(body: bytes, start: int, w: int, hints: list[str]) -> int:
    """How many entries' digit runs overlap their mode's RX-freq digits (>=3
    consecutive). Separates the real mode-name table from radio-wide string
    blocks (STATUS/label lists), which do not correlate with frequencies."""
    hits = 0
    for i, h in enumerate(hints):
        if not h:
            continue
        d = _digits(body[start + i * w : start + i * w + w].decode("latin-1", "replace"))
        if any(h[a : a + 3] in d for a in range(len(h) - 2)):
            hits += 1
    return hits


def _find_name_table_by_freq(body: bytes, n: int, hints: list[str]):
    """FALLBACK heuristic for a codeplug with no default slots: among all
    constant-width runs of >= n left-justified printable fields, pick the one
    whose entries' digits best match the decoded mode RX frequencies. Relies on
    names embedding the channel frequency (common for ham), so it is only used
    when the structural default-slot anchor is unavailable."""
    cands = []
    L = len(body)
    for w in ASCII_NAME_WIDTHS:
        ok = [_ascii_name_field_ok(body[i : i + w]) for i in range(L - w + 1)]
        run = [0] * len(ok)
        for i in range(len(ok) - 1, -1, -1):
            if ok[i]:
                nxt = i + w
                run[i] = 1 + (run[nxt] if nxt < len(ok) else 0)
        cands += [(i, w) for i in range(len(ok)) if run[i] >= n]
    if not cands:
        return None
    if any(hints):
        best = max(cands, key=lambda c: (_name_table_score(body, c[0], c[1], hints),
                                         -c[0]))
        if _name_table_score(body, best[0], best[1], hints) > 0:
            return best
    return None


def find_ascii_name_table(body: bytes, n: int, hints: list[str] | None = None):
    """Return (start, width) of the ASCII mode-name table (>= n entries) or None.
    Prefers the content-independent default-slot anchor; only if that is absent
    (a fully-programmed codeplug) does it try the frequency-correlation heuristic.
    """
    return (_find_name_table_by_defaults(body, n)
            or _find_name_table_by_freq(body, n, hints or []))


# ---------------------------------------------------------------------------
# CTCSS ("PL") tone codec for VHF mode records. Each tone slot is a 16-bit value
# (lo, hi) with bit15 = tone-enabled. The low 15 bits encode the tone two ways:
#   * TX (encode) slot  -> a PERIOD:   tone_Hz = TX_K / low
#   * RX (decode) slot  -> freq-LINEAR: tone_Hz = low / RX_K
# Recovered + validated byte-exact vs the RSS MODE SUMMARY on 221AZN (every Rx
# and Tx code maps to the correct standard CTCSS tone). DPL (digital) uses a
# different flag and is left undecoded (no sample on hand).
CTCSS_TONES = [
    67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4,
    100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5,
    141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8,
    177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5,
    210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
]
VHF_PL_TX_K = 165596.6   # TX slot: tone_Hz = TX_K / low15
VHF_PL_RX_K = 61.2428    # RX slot: tone_Hz = low15 / RX_K
VHF_PL_ENABLE = 0x8000
VHF_PL_RX_OFF = 17       # Rx (decode) PL value, u16 BE (hi=17, lo=18)
VHF_PL_TX_OFF = 19       # Tx (encode) PL value, u16 BE (hi=19, lo=20)

# Exact tone -> slot-byte maps captured by cycling the 221AZN "TPL CODE" field in
# RSS across its whole tone list (tools/scenario_vhf_pl_table.py). The `K`
# formulas above decode every tone to the right standard value, but ENCODE needs
# these tables for byte-exactness: the stored value is not a clean `round(f*K)`
# (a handful of tones land one count off). This Spectra VHF head offers 40 CTCSS
# tones (the older "standard" set; it omits 159.8/165.5/.../241.8/254.1). For a
# tone outside the table, vhf_pl_encode falls back to the formula.
VHF_PL_RX_BY_TONE = {
    "250.3": (0xbb, 0xe1), "233.6": (0xb7, 0xe2), "229.1": (0xb6, 0xcf), "225.7": (0xb5, 0xfe),
    "218.1": (0xb4, 0x2d), "210.7": (0xb2, 0x68), "206.5": (0xb1, 0x66), "203.5": (0xb0, 0xaf),
    "192.8": (0xae, 0x1f), "186.2": (0xac, 0x8b), "179.9": (0xab, 0x09), "173.8": (0xa9, 0x94),
    "167.9": (0xa8, 0x2b), "162.2": (0xa6, 0xcd), "156.7": (0xa5, 0x7d), "151.4": (0xa4, 0x38),
    "146.2": (0xa2, 0xfa), "141.3": (0xa1, 0xce), "136.5": (0xa0, 0xa8), "131.8": (0x9f, 0x88),
    "127.3": (0x9e, 0x74), "123.0": (0x9d, 0x6d), "118.8": (0x9c, 0x6c), "114.8": (0x9b, 0x77),
    "110.9": (0x9a, 0x88), "107.2": (0x99, 0xa5), "103.5": (0x98, 0xc3), "100.0": (0x97, 0xec),
    "97.4": (0x97, 0x4d), "94.8": (0x96, 0xae), "91.5": (0x95, 0xe4), "88.5": (0x95, 0x2c),
    "85.4": (0x94, 0x6e), "82.5": (0x93, 0xbc), "79.7": (0x93, 0x11), "77.0": (0x92, 0x6c),
    "74.4": (0x91, 0xcc), "71.9": (0x91, 0x33), "69.3": (0x90, 0x94), "67.0": (0x90, 0x07),
}
VHF_PL_TX_BY_TONE = {
    "250.3": (0x82, 0x96), "233.6": (0x82, 0xc5), "229.1": (0x82, 0xd3), "225.7": (0x82, 0xde),
    "218.1": (0x82, 0xf7), "210.7": (0x83, 0x12), "206.5": (0x83, 0x22), "203.5": (0x83, 0x2e),
    "192.8": (0x83, 0x5b), "186.2": (0x83, 0x79), "179.9": (0x83, 0x99), "173.8": (0x83, 0xb9),
    "167.9": (0x83, 0xda), "162.2": (0x83, 0xfd), "156.7": (0x84, 0x21), "151.4": (0x84, 0x46),
    "146.2": (0x84, 0x6d), "141.3": (0x84, 0x94), "136.5": (0x84, 0xbd), "131.8": (0x84, 0xe8),
    "127.3": (0x85, 0x15), "123.0": (0x85, 0x42), "118.8": (0x85, 0x72), "114.8": (0x85, 0xa3),
    "110.9": (0x85, 0xd5), "107.2": (0x86, 0x09), "103.5": (0x86, 0x40), "100.0": (0x86, 0x78),
    "97.4": (0x86, 0xa4), "94.8": (0x86, 0xd3), "91.5": (0x87, 0x12), "88.5": (0x87, 0x4f),
    "85.4": (0x87, 0x93), "82.5": (0x87, 0xd7), "79.7": (0x88, 0x1e), "77.0": (0x88, 0x67),
    "74.4": (0x88, 0xb2), "71.9": (0x88, 0xff), "69.3": (0x89, 0x56), "67.0": (0x89, 0xa8),
}


def _is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except (TypeError, ValueError):
        return False


def _nearest_ctcss(freq: float) -> str:
    tone = min(CTCSS_TONES, key=lambda t: abs(t - freq))
    return f"{tone:.1f}"


def vhf_pl_decode(hi: int, lo: int, is_tx: bool):
    """Decode a VHF PL tone slot to a tone string (e.g. '100.0') or None."""
    val = (hi << 8) | lo
    if not (val & VHF_PL_ENABLE):
        return None
    low = val & 0x7FFF
    if low == 0 or val >= 0xC000:  # 0xC000+ is DPL (handled separately)
        return None
    freq = VHF_PL_TX_K / low if is_tx else low / VHF_PL_RX_K
    return _nearest_ctcss(freq)


def vhf_pl_encode(tone, is_tx: bool):
    """Encode a CTCSS tone string ('100.0') -> (hi, lo) VHF tone-slot bytes, or
    None. Inverse of vhf_pl_decode: the Tx slot stores the tone PERIOD
    (165596.6 / f), the Rx slot a freq-linear value (f * 61.2428); bit15 = enable.
    The round-trip is byte-exact vs RSS on every tone captured by cycling the
    221AZN TPL CODE field (tools/scenario_vhf_pl_table.py)."""
    try:
        f = float(tone)
    except (TypeError, ValueError):
        return None
    if f <= 0:
        return None
    # Prefer the exact RSS-captured byte pair; fall back to the formula for a
    # tone this head's list does not carry.
    table = VHF_PL_TX_BY_TONE if is_tx else VHF_PL_RX_BY_TONE
    pair = table.get(f"{f:.1f}")
    if pair is not None:
        return pair
    low = round(VHF_PL_TX_K / f) if is_tx else round(f * VHF_PL_RX_K)
    val = VHF_PL_ENABLE | (low & 0x7FFF)
    return (val >> 8) & 0xFF, val & 0xFF


def pack_name(name: str) -> bytes:
    name = (name + " " * NAME_CHARS)[:NAME_CHARS]
    bits = 0
    nb = 0
    out = bytearray()
    for ch in name:
        v = (ord(ch) - 0x20) & 0x3F
        bits = (bits << 6) | v
        nb += 6
        while nb >= 8:
            nb -= 8
            out.append((bits >> nb) & 0xFF)
    if nb:
        out.append((bits << (8 - nb)) & 0xFF)
    return bytes(out[:NAME_LEN_BYTES])


# ---------------------------------------------------------------------------
# ZONES (radio-wide). A zone is a named group of modes; a mode may belong to
# several zones. Cracked on four on-hand radios (566AYA/617ASN/604AUN 900 +
# 221AZN VHF A9) and validated vs the RSS zone editor. The zone block is three
# tightly-packed parallel arrays of N entries (N = zone count):
#
#   [names]  the zone names
#   [flags]  W+3 bytes/zone  -- per-zone scan options + scan-list data
#   [memb]   W   bytes/zone  -- mode-membership BITMAP, bit (mode-1) LSB-first
#
# W (membership width in bytes) tracks the mode count: W in {ceil(n/8),
# ceil(n/8)-1}. The flag record is W+3 bytes; its scan-options byte sits at a
# model-specific offset/value (0xF4/0xA0/0x78/0xF0 seen) and repeats per zone.
# Name storage follows the head type, exactly like MODE names: standard heads
# pack names 6-bit (6 B/zone) immediately before the flag array; the A9/expanded
# head stores them as fixed-width ASCII in the string pool, as the N entries
# right before the ASCII mode-name table (names then live far from the block).
#
# The W+3 record (scan-options byte, priority modes, zone scan list) is decoded
# and written by scanlist.py; zone edits here preserve it verbatim. RSS deletes
# any zone with no modes on save, so every stored zone is non-empty -- which
# the locator relies on.
ZONE_SEARCH_HI = 0x1000      # the flag+membership block lives in the low region


def _zone_name_plausible(nm: str) -> bool:
    # Zone names are letters/digits/space and the occasional "/" or "-"
    # (e.g. "BBND/MURS", "LOC RPTR"). First char must be alphanumeric.
    return bool(nm) and nm[0:1].isalnum() \
        and all(c.isalnum() or c in " /-" for c in nm) \
        and any("A" <= c <= "Z" for c in nm)


def _zone_rec_modes(body: bytes, off: int, w: int):
    """Decode a w-byte membership bitmap -> sorted mode numbers."""
    out = []
    for i in range(w):
        by = body[off + i]
        if by:
            for bit in range(8):
                if by & (1 << bit):
                    out.append(i * 8 + bit + 1)
    return out


def pack_membership(modes, w: int) -> bytes:
    bm = bytearray(w)
    for mode in modes:
        if 1 <= mode <= w * 8:
            bm[(mode - 1) // 8] |= 1 << ((mode - 1) % 8)
    return bytes(bm)


def _zone_flag_run(body: bytes, p: int, stride: int, foff: int):
    """Length of the run of records at `p` (stride) whose byte at `foff` repeats
    the value body[p+foff] (allowing <=1 odd value, e.g. the home zone)."""
    v = body[p + foff]
    if v == 0:
        return 0, v
    n = 0
    odd = 0
    while p + n * stride + foff < len(body):
        b = body[p + n * stride + foff]
        if b == v:
            pass
        elif odd == 0 and n > 0:
            odd = 1
        else:
            break
        n += 1
    return n, v


def _zone_best_memb(body: bytes, flags_base: int, stride: int, n: int, w: int,
                    n_modes: int):
    """Choose the membership base after the flag block. The flags->membership pad
    is small and varies; the correct alignment MINIMIZES the max mode number (a
    byte-shift sprays bits into the top byte, raising it to the w*8 ceiling), then
    MAXIMIZES mode adjacency. Returns (memb_off, score) or None."""
    best = None
    for pad in range(0, 8):
        mb = flags_base + stride * n + pad
        if mb + n * w > len(body):
            break
        zs = [_zone_rec_modes(body, mb + k * w, w) for k in range(n)]
        if any((not z) or z[-1] > n_modes for z in zs):
            continue
        mx = max(z[-1] for z in zs)
        adj = sum(1 for z in zs for a, c in zip(z, z[1:]) if c - a == 1)
        union = len({m for z in zs for m in z})
        score = (union, -mx, adj)
        if best is None or score > best[1]:
            best = (mb, score)
    return best


def _find_zone_6bit(body: bytes, n_modes: int):
    """Standard head: zone names are 6-bit packed, immediately before the flag
    array. Anchor on the 6-bit name run (stops cleanly at punctuation)."""
    n = len(body)
    wc = -(-n_modes // 8)
    best = None
    nt = 0x100
    hi = min(n, ZONE_SEARCH_HI + 0x400)
    while nt < hi:
        nm = unpack_name(body[nt:nt + 6])
        if not _zone_name_plausible(nm) or (nt >= 6 and _zone_name_plausible(unpack_name(body[nt - 6:nt]))):
            nt += 1
            continue
        N = 0
        while nt + (N + 1) * 6 <= n and _zone_name_plausible(unpack_name(body[nt + N * 6:nt + N * 6 + 6])):
            N += 1
        if 2 <= N <= 20:
            for w in (wc, wc - 1):
                if w < 2:
                    continue
                stride = w + 3
                for pn in range(0, 3):
                    fb = nt + 6 * N + pn
                    if fb + stride * N > n:
                        continue
                    # require a periodic flag byte somewhere in the flag record
                    foff = next((f for f in range(stride)
                                 if _zone_flag_run(body, fb, stride, f)[0] >= max(2, N - 1)), None)
                    if foff is None:
                        continue
                    bm = _zone_best_memb(body, fb, stride, N, w, n_modes)
                    if bm:
                        cand = (N, w, nt, 6, "6bit", fb, foff, bm[0], bm[1])
                        if best is None or (cand[0], cand[8]) > (best[0], best[8]):
                            best = cand
        nt += 1
    return best


def _find_zone_ascii(body: bytes, n_modes: int, ascii_names):
    """A9/expanded head: zone names are fixed-width ASCII, the N entries right
    before the ASCII mode-name table. The flag+membership block is in the low
    binary region; anchor on it, then map N names before the mode table."""
    n = len(body)
    wc = -(-n_modes // 8)
    name_start, name_w = ascii_names
    best = None
    for w in (wc, wc - 1):
        if w < 2:
            continue
        stride = w + 3
        for foff in range(stride):
            p = 0x100
            hi = min(n, ZONE_SEARCH_HI)
            while p + 2 * stride <= hi:
                run, _ = _zone_flag_run(body, p, stride, foff)
                if 3 <= run <= 20:
                    N = run
                    bm = _zone_best_memb(body, p, stride, N, w, n_modes)
                    if bm:
                        noff = name_start - N * name_w
                        if noff >= 0:
                            names = [body[noff + k * name_w:noff + (k + 1) * name_w]
                                     .decode("latin-1").rstrip(" \x00") for k in range(N)]
                            if all(_zone_name_plausible(x) for x in names):
                                cand = (N, w, noff, name_w, "ascii", p, foff, bm[0], bm[1])
                                if best is None or (cand[0], cand[8]) > (best[0], best[8]):
                                    best = cand
                p += 1
    return best


def find_zone_block(body: bytes, n_modes: int, ascii_names=None):
    """Locate the zone block. Returns (N, w, names_off, name_w, name_enc,
    flags_off, flag_foff, memb_off, score) or None. Dispatches by head type
    (ASCII names for the expanded head, else 6-bit)."""
    if n_modes <= 0:
        return None
    if ascii_names is not None:
        return _find_zone_ascii(body, n_modes, ascii_names)
    return _find_zone_6bit(body, n_modes)


@dataclass
class Zone:
    number: int
    name: str = ""
    modes: list = field(default_factory=list)   # mode numbers in this zone
    flag_byte: int = 0                           # raw scan-options byte (scanlist.py)
    names_off: int = -1                          # name slot offset
    name_w: int = 6                              # name slot width (bytes)
    name_enc: str = "6bit"                       # "6bit" | "ascii"
    memb_off: int = -1                           # membership bitmap offset
    memb_w: int = 16                             # membership bitmap width (bytes)


# ---------------------------------------------------------------------------
# VHF conventional mode record (26 bytes). Recovered + validated byte-exact
# against RSS (inverse oracle, 136-174 MHz, independent RX/TX/T/A splits).
#
# The record is located structurally by its TX/T/A tag bytes: 0xE9 at record
# offset 9 (TX) and 0xA9 at offset 13 (T/A). Record start = tag_e9 - 9.
#
# Each frequency field is LINEAR IN THE RECORD BYTES (not the packed int):
#   freq_MHz = c0*lo + c1*mid + k
# with its own (c0, c1, k). The third ("band") byte of TX/TA selects the VCO
# band and does NOT affect the displayed frequency (coefficient 0); it is
# preserved on edit, or chosen by range when synthesizing a new value.
VHF_REC_LEN = 26
VHF_RX_OFF = 6    # lo=+0, mid=+1  (no band byte)
VHF_TX_OFF = 10   # lo=+0, mid=+1, band=+2  (tag 0xE9 at off 9)
VHF_TA_OFF = 14   # lo=+0, mid=+1, band=+2  (tag 0xA9 at off 13)
VHF_RX_COEF = (0.635, 0.64, 52.91)
VHF_TX_COEF = (0.3175, 0.32, 81.28)
VHF_TA_COEF = VHF_TX_COEF

# Per-mode option flags (VHF), mapped white-box via the harness differential
# (notes/FORMAT.md §5a). Each is a single bit in a record byte; polarity is from
# the measured original byte + the value RSS displayed for it.
VHF_FLAGS3_OFF = 3          # bit4 = uP Xtal Shift   (bit SET => Disabled)
VHF_UPXTAL_BIT = 0x10
VHF_FLAGS4_OFF = 4          # bit7 = MDC PTT ID, bit5 = Phone Encode (SET => Enabled)
VHF_MDC_PTT_BIT = 0x80
VHF_PHONE_ENC_BIT = 0x20
VHF_TX_TAG_OFF = 9          # TX tag byte; bit6 = Transmit Power    (SET => High)
VHF_TA_TAG_OFF = 13         # T·A tag byte; bit6 = Talkaround Power (SET => High)
VHF_POWER_BIT = 0x40
# MPL Type: rec+3 bits 5-6 (mask 0x60); bit5 = TX, bit6 = RX.
VHF_MPL_MASK = 0x60
VHF_MPL_BY_BITS = {0x00: "Disabled", 0x20: "TX Only", 0x40: "RX Only", 0x60: "RX & TX"}
VHF_MPL_BY_NAME = {v.lower(): k for k, v in VHF_MPL_BY_BITS.items()}


def vhf_decode(lo: int, mid: int, coef) -> float:
    c0, c1, k = coef
    return round(c0 * lo + c1 * mid + k, 4)


def vhf_encode(freq: float, coef) -> tuple[int, int]:
    """(lo, mid) in 0..255 for freq under the given field coefficients.

    The bytes program a 127/128 dual-modulus synthesizer: N = 127*Np + A with
    mid = A (the swallow count, at most 127) and lo = Np - A - 256 (8 bits).
    In field terms the count = 127*lo + 128*mid, which has two encodings, mid
    and mid+127; RSS writes the smaller mid (all 6818 VHF frequency fields in
    the RSS saves on hand have mid < 127; TX 162.56 MHz, count 127*256, gets
    mid = 127, lo = 128). Some TX/TA frequencies above 165.74 MHz have no
    encoding (lo would pass 255): RSS then stores a wrapped, wrong value
    (tools/scenario_vhf_band_sweep.py); here they get the nearest storable one,
    which vhf_storable() tells apart."""
    c0, c1, k = coef
    count = round((freq - k) / (c1 / 128))
    for mid in (count % 127, count % 127 + 127):
        lo, rem = divmod(count - 128 * mid, 127)
        if not rem and 0 <= lo <= 255 and mid <= 127:
            return lo, mid
    best = None
    for mid in range(128):
        lo = round((freq - k - c1 * mid) / c0)
        if 0 <= lo <= 255:
            err = abs(c0 * lo + c1 * mid + k - freq)
            if best is None or err < best[0]:
                best = (err, lo, mid)
    return (best[1], best[2]) if best else (0, 0)


def vhf_storable(freq: float, coef) -> bool:
    """Can freq be stored exactly (on its field's raster, with mid <= 127)?"""
    lo, mid = vhf_encode(freq, coef)
    return abs(vhf_decode(lo, mid, coef) - round(freq, 4)) < 1e-9


def vhf_tx_band_byte(freq: float) -> int:
    """The TX/TA band byte (view +12 / +16) RSS writes for freq: 6 MHz bands,
    v = (freq - 126) // 6 clamped to 3..7, stored as 0x80 | v0<<5 | v1<<2 |
    v2<<3. Swept in RSS on 617ASQ (144-174 MHz, exact boundaries at 150, 156,
    162 and 168) and seen on 221AZN (142-160): 144-150 0xA4 (also below 144),
    150-156 0x88, 156-162 0xA8, 162-168 0x8C, 168-174 0xAC. It doesn't change the
    displayed frequency (most likely the VCO range). An unchanged field keeps
    its original byte; this is for new values."""
    v = min(7, max(3, (round(freq * 10000) - 1260000) // 60000))
    return 0x80 | (v & 1) << 5 | (v >> 1 & 1) << 2 | (v >> 2 & 1) << 3


# VHF RX (FORMAT §5a; RSS sweeps on 617ASQ and an AR-ORIG v112 radio,
# 2026-10-25): the synthesizer count on a 5 kHz reference, or 6.25 kHz when
# the flag byte (+8) has b0 set:
#   freq = step * (127*(lo + 256*rec5.b0) + 128*mid) - 109.65 (the IF, as UHF)
# view +5 b0 = lo's 9th bit; flag b2 = 166.15 MHz and up. RSS uses 5 kHz when
# the frequency is on that raster, else 6.25 kHz, else refuses. Every 5 kHz
# value has the 9th bit set, so for those this is VHF_RX_COEF's
# 0.635*lo + 0.64*mid + 52.91.
VHF_RX_HIGH = 166.15


def vhf_rx_step(freq: float):
    """The reference RSS uses for a VHF RX freq: 5 kHz if it's on that raster,
    else 6.25 kHz, else None (not storable)."""
    for step in (0.005, 0.00625):
        n = freq / step
        if abs(n - round(n)) < 1e-6:
            return step
    return None


def vhf_decode_rx(lo: int, mid: int, flag: int, hi: int) -> float:
    """hi = the byte at view +5, whose bit 0 is lo's 9th bit."""
    step = 0.00625 if flag & 1 else 0.005
    return round(step * (127 * (lo + 256 * (hi & 1)) + 128 * mid) - UHF_RX_IF, 5)


def vhf_encode_rx(freq: float):
    """(lo, mid, lo's 9th bit, flag bits) for a VHF RX frequency, or None."""
    step = vhf_rx_step(freq)
    if step is None:
        return None
    n = round((freq + UHF_RX_IF) / step)
    np_, a = divmod(n, 127)
    x = np_ - a
    if not 0 <= x <= 511:
        return None
    return x & 0xFF, a, x >> 8, (1 if step == 0.00625 else 0) | (4 if freq >= VHF_RX_HIGH else 0)


# ---------------------------------------------------------------------------
# UHF conventional (2026-10-25; mapped with RSS on a 440-490 MHz A9 radio,
# tools/scenario_freq_sweep.py; FORMAT §5a-uhf). The record is the VHF one
# (same tags, tone slots, option bits); only the frequency codec differs. Both
# fields program the same 127/128 dual-modulus synthesizer as VHF, N = 127*Np
# + A with A = mid (the swallow count), on a 6.25 kHz or a 5 kHz reference:
#
#   TX / T/A: freq = step * (127*(lo + 256 + 256*tag.b1) + 128*mid)
#             tag (view +9 / +13): b1 = the 9th bit of lo, b0 = its complement
#             band byte (+12 / +16): 0x80 | b0 = 5 kHz step | b2 = the upper
#             half of the range (b1 = a 2.5 kHz form RSS sometimes writes; not decoded)
#   RX:       freq = step * (127*(lo + 512 + 256*rec5.b0) + 128*mid) - 109.65
#             (the first IF); view +5 b0 = lo's 9th bit; flag byte (+8):
#             b0 = 5 kHz step | b2 = the upper half | b3 (RSS sets it on save)
#
# RSS uses the 6.25 kHz reference when the frequency is on it, else 5 kHz;
# other values it refuses. Where b2 switches depends on the radio's range
# (UHF_RANGES). On the 440-491 MHz range RSS forces TX / T/A power Low above
# 470 MHz (tag bit 6 cleared).
UHF_RX_IF = 109.65
UHF_BAND = (400.0, 520.0)


def uhf_step(freq: float):
    """The reference RSS uses for freq: 6.25 kHz if it's on that raster, else
    5 kHz, else None (not storable)."""
    for step in (0.00625, 0.005):
        n = freq / step
        if abs(n - round(n)) < 1e-6:
            return step
    return None


@dataclass(frozen=True)
class UhfRange:
    """A UHF range's band split (RSS's VCO split tables in SPECTRA1.EXE,
    0x4E1B8 RX / 0x4E308 TX; confirmed by RSS sweeps): b2 selects the upper
    VCO segment, set from rx_split (RX flag byte) or tx_split (TX / T·A band
    byte) up to the range's top, rss[1]. rss = the frequencies RSS lets you
    type (motreader stores others too, FORMAT §5a-UHF). Above the top b2 is
    clear (K1IMD's working 444.1 / 449.1 MHz channel on a 403-441 radio).
    low_power_above = where RSS forces TX / T·A power Low."""
    name: str
    rx_split: float
    tx_split: float
    rss: tuple
    low_power_above: Optional[float] = None


UHF_RANGES = (
    # a 440-491 MHz A9 radio (T84FWA…) and the D44KMA / T44KMA radios
    UhfRange("440-491", 467.0, 467.0, (440.0, 491.0), 470.0),
    # 518ATN, D44ZXA: RSS takes 403-441 MHz
    UhfRange("403-441", 418.0, 421.0, (403.0, 441.0)),
)


def uhf_b2(freq: float, split: float, top: float) -> bool:
    """The upper VCO segment: split <= freq <= top."""
    return split <= freq <= top


def uhf_range_fits(r: UhfRange, modes) -> bool:
    """Do the modes' b2 bits follow r's splits?"""
    top = r.rss[1]
    for m in modes:
        v = m.raw
        if m.rx_mhz is not None and bool(v[8] & 4) != uhf_b2(m.rx_mhz, r.rx_split, top):
            return False
        for o in (VHF_TX_OFF, VHF_TA_OFF):
            if not (v[o] or v[o + 1]) or v[o + 2] & 2:
                continue
            f = uhf_decode_txta(v[o], v[o + 1], v[o - 1], v[o + 2])
            if bool(v[o + 2] & 4) != uhf_b2(f, r.tx_split, top):
                return False
    return True


def uhf_range_for(model: str, modes) -> Optional[UhfRange]:
    """The radio's UHF range: the first (the model's band letter first: the
    one after the band digit, Z = 403-441) whose splits the modes follow,
    or None."""
    letter = model[3:4] if _re.match(r"[A-Z]\d4[A-Z]", model) else ""
    order = sorted(UHF_RANGES, key=lambda r: (r.name == "403-441") != (letter == "Z"))
    return next((r for r in order if uhf_range_fits(r, modes)), None)


def uhf_decode_rx(lo: int, mid: int, flag: int, hi: int) -> float:
    """hi = the byte at view +5, whose bit 0 is lo's 9th bit."""
    step = 0.005 if flag & 1 else 0.00625
    return round(step * (127 * (lo + 512 + 256 * (hi & 1)) + 128 * mid) - UHF_RX_IF, 5)


def uhf_decode_txta(lo: int, mid: int, tag: int, band: int):
    if band & 2:
        return None                       # RSS's 2.5 kHz form: not decoded
    step = 0.005 if band & 1 else 0.00625
    return round(step * (127 * (lo + 256 + 256 * ((tag >> 1) & 1)) + 128 * mid), 5)


def uhf_encode_rx(freq: float, split: float = 467.0, top: float = 491.0):
    """(lo, mid, lo's 9th bit, flag bits) for an RX frequency, or None; b2
    from `split` to `top` MHz (UhfRange.rx_split, .rss[1])."""
    step = uhf_step(freq)
    if step is None:
        return None
    n = round((freq + UHF_RX_IF) / step)
    np_, a = divmod(n, 127)
    x = np_ - a - 512
    if not 0 <= x <= 511:
        return None
    return x & 0xFF, a, x >> 8, 0x08 | (1 if step == 0.005 else 0) | (4 if uhf_b2(freq, split, top) else 0)


def uhf_encode_txta(freq: float, split: float = 467.0, top: float = 491.0):
    """(lo, mid, lo's 9th bit, band byte) for a TX / T/A frequency, or None;
    b2 from `split` to `top` MHz (UhfRange.tx_split, .rss[1])."""
    step = uhf_step(freq)
    if step is None:
        return None
    n = round(freq / step)
    np_, a = divmod(n, 127)
    x = np_ - a - 256
    if not 0 <= x <= 511:
        return None
    return x & 0xFF, a, x >> 8, 0x80 | (1 if step == 0.005 else 0) | (4 if uhf_b2(freq, split, top) else 0)


def _uhf_record(body: bytes, t: int) -> bool:
    """The record at true start t is UHF: TX tag E9/EA, a TX band byte of
    0x80..0x87 (VHF's always has bit 3 or 5 set: 0xA4/0x88/0xA8/0x8C/0xAC) and
    an RX that reads as UHF."""
    return (body[t + 6] in (0xE9, 0xEA) and body[t + 9] & 0xF8 == 0x80
            and UHF_BAND[0] <= uhf_decode_rx(body[t + 3], body[t + 4], body[t + 5], body[t + 2]) <= UHF_BAND[1])


# ---------------------------------------------------------------------------
# 800 MHz conventional, decode only (FORMAT §5a-800; RSS's MODE SUMMARY of two
# AR-ORIG radios). The VHF record layout with the UHF form of the codec on a
# 12.5 kHz reference:
#   RX:       freq = 0.0125*(127*(lo + 256*rec5.b0) + 128*mid) + 109.65
#   TX / T/A: freq = 0.0125*(127*(lo + 256 + 256*tag.b1) + 128*mid)
# RSS shows TX = the TX field when programmed, else the T/A field (a simplex
# mode), as on 900 MHz.
M800_STEP = 0.0125
M800_BAND = (806.0, 870.0)


def m800_decode_rx(lo: int, mid: int, hi: int) -> float:
    """hi = the byte at view +5, whose bit 0 is lo's 9th bit."""
    return round(M800_STEP * (127 * (lo + 256 * (hi & 1)) + 128 * mid) + UHF_RX_IF, 5)


def m800_decode_txta(lo: int, mid: int, tag: int) -> float:
    return round(M800_STEP * (127 * (lo + 256 + 256 * ((tag >> 1) & 1)) + 128 * mid), 5)


def _m800_record(body: bytes, t: int) -> bool:
    """The record at true start t is 800 MHz: VHF tags, an RX that reads as
    800 MHz and not as VHF."""
    if body[t + 6] not in (0xE9, 0xE8, 0x68):
        return False
    rx = m800_decode_rx(body[t + 3], body[t + 4], body[t + 2])
    vhf = vhf_decode_rx(body[t + 3], body[t + 4], body[t + 5], body[t + 2])
    return M800_BAND[0] <= rx <= M800_BAND[1] and not 108.0 <= vhf <= 180.0


# Trunked record lengths seen: 37 (800 / 900 MHz), 47 (518ATN, UHF).
TRUNKED_REC_LENS = (0x25, 0x2F)


def is_trunked_record(body: bytes, t: int) -> bool:
    """A trunked record in RSS's mode table: its length byte (0x25 = 37 or
    0x2F = 47) at true start +1, after 0x1F / 0x20 / 0x21. A conventional
    record starts with a flag byte that has bit 7 set (0x84, 0x94, 0xB4 on
    every sample)."""
    return t + 1 < len(body) and body[t + 1] in TRUNKED_REC_LENS and body[t] < 0x80


def find_vhf_records(body: bytes) -> list[int]:
    """Return record-start offsets for VHF conventional modes (may be empty).

    Anchored on the longest 26-byte-stride run of the TX/T·A tag pair (0xE9 @ rec
    offset 9, 0xA9 @ offset 13), then extended in both directions over adjacent
    valid records. The extension picks up RX-only modes (e.g. NOAA weather) whose
    TX/T·A fields are blank (tag bytes 0x68/0x28), which would otherwise split the
    tag run. Returns [] when there is no VHF table (e.g. a 900 MHz codeplug)."""
    starts = [i - 9 for i in range(9, len(body) - 4)
              if body[i] == 0xE9 and body[i + 4] == 0xA9]
    best: list[int] = []
    i = 0
    while i < len(starts):
        run = [starts[i]]
        j = i
        while j + 1 < len(starts) and starts[j + 1] - starts[j] == VHF_REC_LEN:
            run.append(starts[j + 1])
            j += 1
        if len(run) > len(best):
            best = run
        i = j + 1
    if len(best) < 2:
        return []

    def valid(off: int) -> bool:
        if off < 0 or off + VHF_REC_LEN > len(body):
            return False
        rec = body[off : off + VHF_REC_LEN]
        if not any(rec):
            return False
        if rec[9] == 0xE9 and rec[13] == 0xA9:
            return True
        # RX-only mode (blank TX/T·A): accept only on a plausible VHF RX freq.
        return 108.0 <= vhf_decode_rx(rec[VHF_RX_OFF], rec[VHF_RX_OFF + 1],
                                      rec[VHF_RX_OFF + 2], rec[VHF_RX_OFF - 1]) <= 180.0

    s = best[0]
    while valid(s - VHF_REC_LEN):
        s -= VHF_REC_LEN
    e = best[-1]
    while valid(e + VHF_REC_LEN):
        e += VHF_REC_LEN
    return list(range(s, e + VHF_REC_LEN, VHF_REC_LEN))


# ---------------------------------------------------------------------------
# 900 MHz conventional mode record (26 bytes). Each frequency is byte-linear
# (recovered + validated byte-exact vs RSS, 105 modes; TX/TA via inverse oracle).
#
#   RX : off15 (lo) off16 (hi)   freq = 925.6500 + 0.0125 * (off15 + 256*off16)
#   TX : carry=off17 lo=off18 mid=off19
#   T/A: carry=off21 lo=off22 mid=off23
#        TX/TA freq = 0.0125*(255*lo + 256*mid) + 816*(carry & 1)
#
# TX and T/A share one codec. The carry byte (0xE8/0xE9/0xA8...) selects the VCO
# band; its bit0 is a +816 MHz high-count carry (0xFF00 steps), and its other
# bits (e.g. 0x40) do not affect the frequency. Validated byte-exact vs RSS
# (decode: 105 modes; encode: independent RX/TX/TA splits via the inverse oracle).
MODE_TABLE_OFF = 0x0D26
MODE_REC_LEN = 26
FREQ_STEP_MHZ = 0.0125  # 12.5 kHz raster
RX_VALUE_OFF = 15       # u16 LE: freq = RX_BASE + step * value
RX_PL_OFF = 25          # byte: RX PL/DPL code (lookup table below)

M900_TX = (17, 18, 19)  # (carry, lo, mid)
M900_TA = (21, 22, 23)
M900_STEP = 0.0125
M900_HIGH = 816.0       # 0.0125 * 0xFF00

# RX is the same byte-linear form at off14(lo)/off15(mid) with a fixed base and
# NO carry bit (RX-tag off13 is always 0xA0). Base 109.65; validated exact across
# 566AYA, 604ATY and 617ASN (incl. its 935-940 MHz band).
M900_RX_LO = 14
M900_RX_MID = 15
M900_RX_BASE = 109.65


def m900_rx_decode(rec: bytes) -> float:
    return round(M900_STEP * (255 * rec[M900_RX_LO] + 256 * rec[M900_RX_MID])
                 + M900_RX_BASE, 4)


def m900_rx_encode(freq: float):
    """Return (lo, mid) encoding an RX frequency (no carry byte)."""
    target = round((freq - M900_RX_BASE) / M900_STEP)  # 255*lo + 256*mid
    if 0 <= target <= 255 * 255 + 256 * 255:
        for mid in range(256):
            rem = target - 256 * mid
            if 0 <= rem and rem % 255 == 0 and rem // 255 <= 255:
                return rem // 255, mid
    best = None
    for mid in range(256):
        for lo in range(256):
            e = abs(M900_STEP * (255 * lo + 256 * mid) + M900_RX_BASE - freq)
            if best is None or e < best[0]:
                best = (e, lo, mid)
    return best[1], best[2]


# A 900 MHz conventional channel sits in ~896-941 MHz (896/902 TX, 927/935-941
# RX, 927 T/A). Values outside this are a decode artifact, not a real frequency.
M900_BAND = (895.0, 942.0)

# 900 per-mode option flags, mapped white-box via the harness (notes/FORMAT.md).
# The power bits share a byte with the TX/TA frequency "carry"; bit-surgical
# writes preserve the freq bits.
M900_FLAGS11_OFF = 11       # bit4 = uP Xtal Shift       (SET => Disabled)
M900_UPXTAL_BIT = 0x10
M900_FLAGS12_OFF = 12       # bit3 = Audio Compander, bit6 = Adaptive Splatter (SET => Enabled)
M900_COMPANDER_BIT = 0x08
M900_SPLATTER_BIT = 0x40
M900_TXPWR_OFF = 17         # bit6 = Transmit Power      (SET => High); = TX carry byte
M900_TAPWR_OFF = 21         # bit6 = Talkaround Power    (SET => High); = TA carry byte
M900_PWR_BIT = 0x40

# rec+11 (FLAGS11) and rec+12 (FLAGS12) pack several per-mode options. Mapped
# white-box via the harness differential on 617ASN (MODE + MODE OPT 1 screens);
# polarity from the measured byte + the value RSS displayed. rec+11 also holds
# uP Xtal (bit4, above). Baseline 0x7a at rec+12 confirms all four FLAGS12 bits.
M900_REVBURST_BIT = 0x04    # rec+11 bit2 = Reverse Burst/TOC   (SET => Enabled)
M900_UNMUTE_MASK = 0x03     # rec+11 bits0-1 = UnMute/Mute Type
M900_UNMUTE_BY_BITS = {0x00: "Std/Std", 0x01: "Std/OR",
                       0x02: "AND/Std", 0x03: "AND/OR"}
M900_UNMUTE_BY_NAME = {v.lower(): k for k, v in M900_UNMUTE_BY_BITS.items()}
M900_MPL_MASK = 0x60        # rec+11 bits5-6 = MPL Type (same semantics as VHF)
M900_MDC_PTT_BIT = 0x80     # rec+12 bit7 = MDC PTT ID    (SET => Enabled)
M900_PHONE_ENC_BIT = 0x20   # rec+12 bit5 = Phone Encode  (SET => Enabled)


def _plausible_900(freq):
    lo, hi = M900_BAND
    return freq if (freq is not None and lo <= freq <= hi) else None


def m900_freq_decode(rec: bytes, field) -> float:
    carry, lo, mid = field
    return round(M900_STEP * (255 * rec[lo] + 256 * rec[mid])
                 + M900_HIGH * (rec[carry] & 1), 4)


def m900_freq_encode(freq: float, carry_byte: int):
    """Return (lo, mid, carry_byte) encoding freq for a TX/TA field. Preserve the
    carry byte's non-frequency bits; choose bit0 so an exact (lo, mid) exists."""
    for bit in (carry_byte & 1, (carry_byte & 1) ^ 1):
        target = round((freq - M900_HIGH * bit) / M900_STEP)  # = 255*lo + 256*mid
        if 0 <= target <= 255 * 255 + 256 * 255:
            for mid in range(256):
                rem = target - 256 * mid
                if 0 <= rem and rem % 255 == 0 and rem // 255 <= 255:
                    return rem // 255, mid, (carry_byte & ~1) | bit
    # nearest fallback (should not happen for 12.5 kHz-raster inputs)
    best = None
    for bit in (0, 1):
        for mid in range(256):
            for lo in range(256):
                f = M900_STEP * (255 * lo + 256 * mid) + M900_HIGH * bit
                e = abs(f - freq)
                if best is None or e < best[0]:
                    best = (e, lo, mid, (carry_byte & ~1) | bit)
    return best[1], best[2], best[3]


# Valid TX/TA "carry" bytes (VCO band select). A TX/TA field whose tag is not one
# of these, with a zero value, is an unprogrammed/blank field.
VALID_CARRY_900 = {0xE8, 0xE9, 0xA8, 0xA9}


def find_900_table(body: bytes):
    """Locate a 900 mode table structurally: a stride-N run of records carrying
    the RX-tag 0xA0 @off13 and end-tag 0x8C @off24. Returns (start, stride, n) or
    None. Handles variable record length (566AYA=26, 604ATY=40, ...)."""
    from collections import Counter
    sig = [p for p in range(len(body) - 26)
           if body[p + 13] & 0xEF == 0xA0 and body[p + 16] == 0x00 and body[p + 24] == 0x8C]
    if len(sig) < 3:
        return None
    stride = Counter(sig[i + 1] - sig[i] for i in range(len(sig) - 1)).most_common(1)[0][0]
    if not (24 <= stride <= 80):
        return None
    best, i = [], 0
    while i < len(sig):
        run, j = [sig[i]], i
        while j + 1 < len(sig) and sig[j + 1] - sig[j] == stride:
            run.append(sig[j + 1])
            j += 1
        if len(run) > len(best):
            best = run
        i = j + 1
    return best[0], stride, len(best)


def decode_900_fields(rec: bytes):
    """Decode (rx, tx, ta) MHz from a 900 mode record, applying RSS display logic:

    off17-19 is the repeater-input TX (902 band), off21-23 the RX-side/talk-around
    TX. RSS shows TX = off17-19 when programmed, else off21-23 (a simplex mode);
    T/A is shown only for a repeater mode. An unprogrammed slot (no valid TX/TA
    carry) decodes as empty. Validated vs RSS on 566AYA (all repeater) and 604ATY
    (repeater + simplex + empty)."""
    rx = _plausible_900(m900_rx_decode(rec))
    tx_set = rec[17] in VALID_CARRY_900 and (rec[18] or rec[19])
    ta_set = rec[21] in VALID_CARRY_900 and (rec[22] or rec[23])
    if tx_set:
        return (rx, _plausible_900(m900_freq_decode(rec, M900_TX)),
                _plausible_900(m900_freq_decode(rec, M900_TA)))
    if ta_set:  # simplex: TX is in the off21-23 field, no talk-around
        return rx, _plausible_900(m900_freq_decode(rec, M900_TA)), None
    return None, None, None  # unprogrammed slot


# LEGACY (superseded by slot_decode / M900_SLOTS: 900 has independent Rx / Tx /
# T·A slots in the VHF codec, see the "Tone slots" note). Kept for reference:
# the first byte of the 900 Rx slot (view +25), which is what the old decode
# read; "Rx Code == Tx Code" was a wrong inference from it.
#
# DPL ("digital", byte >= 0xC0) is deliberately NOT given a specific code here:
# rec+25 alone does not determine the DPL code -- the SAME byte maps to different
# DPL codes across modes (566AYA rec+25=0xd8 -> both 125 and 532; 0xcc -> 411 and
# 114), and those modes differ only in frequency bytes (which already validate
# byte-exact), so the DPL code lives in bits not yet isolated. DPL modes are
# reported with squelch type "DPL" and the code left undecoded; their raw record
# bytes round-trip untouched, so the codeplug stays valid. (Earlier single-byte
# DPL labels were an artifact of 617ASN-only ground truth and could mislabel.)
PL_CODE_BY_BYTE = {
    0x93: "82.5", 0x95: "88.5", 0x97: "100.0", 0x98: "103.5", 0x99: "107.2",
    0x9A: "110.9", 0x9B: "114.8", 0x9D: "123.0", 0x9E: "127.3", 0x9F: "131.8",
    0xA1: "141.3", 0xA2: "146.2", 0xA4: "151.4", 0xA6: "162.2", 0xA9: "173.8",
    0xAE: "192.8", 0xB0: "203.5", 0xB4: "218.1",
}
PL_BYTE_BY_CODE = {v: k for k, v in PL_CODE_BY_BYTE.items()}
M900_DPL_MIN = 0xC0   # rec+25 >= this => DPL (digital)

# 900 DPL ("Digital Private Line" / DCS) code. The code is a 2-byte value at
# record offsets +25 and +26 (where +26 falls in the next record's address space
# but belongs to THIS mode's squelch -- confirmed in RSS: patching both bytes
# set the mode's Rx code with the next mode undisturbed). rec+25 alone is NOT
# enough (it collides across codes). The (b25, b26) -> octal-code map is the full
# 83-code standard DPL set, captured by cycling the Rx CODE field in RSS (both
# directions) and validated byte-exact vs the MODE SUMMARY ground truth (566AYA
# 46/46, 617ASN 40/40). Codes are shown with a leading "D" (e.g. "D411").
DPL_CODE_BY_PAIR = {
    (0xd8, 0x64): "023", (0xdc, 0x54): "025", (0xd4, 0x34): "026", (0xdc, 0x4c): "031",
    (0xd4, 0x2c): "032", (0xcc, 0x62): "043", (0xd4, 0x72): "047", (0xc8, 0x4a): "051",
    (0xc4, 0x1a): "054", (0xd0, 0x56): "065", (0xd0, 0x4e): "071", (0xd8, 0x2e): "072",
    (0xcc, 0x6e): "073", (0xdc, 0x1e): "074", (0xcc, 0x19): "114", (0xd8, 0x59): "115",
    (0xd0, 0x39): "116", (0xd8, 0x55): "125", (0xd8, 0x4d): "131", (0xd0, 0x2d): "132",
    (0xd4, 0x1d): "134", (0xc8, 0x63): "143", (0xc4, 0x2b): "152", (0xd4, 0x5b): "155",
    (0xdc, 0x3b): "156", (0xc4, 0x27): "162", (0xd4, 0x57): "165", (0xdc, 0x2f): "172",
    (0xd8, 0x1f): "174", (0xd1, 0x50): "205", (0xcd, 0x64): "223", (0xc1, 0x34): "226",
    (0xd9, 0x62): "243", (0xc9, 0x12): "244", (0xdd, 0x52): "245", (0xdd, 0x4a): "251",
    (0xdd, 0x46): "261", (0xc1, 0x66): "263", (0xc5, 0x56): "265", (0xc5, 0x4e): "271",
    (0xcd, 0x31): "306", (0xd5, 0x49): "311", (0xcd, 0x59): "315", (0xcd, 0x4d): "331",
    (0xdd, 0x63): "343", (0xd1, 0x33): "346", (0xd9, 0x4b): "351", (0xd5, 0x17): "364",
    (0xc1, 0x57): "365", (0xc1, 0x4f): "371", (0xcc, 0xc8): "411", (0xc4, 0xa8): "412",
    (0xd0, 0xe8): "413", (0xd0, 0xe4): "423", (0xd4, 0xcc): "431", (0xdc, 0xac): "432",
    (0xc0, 0xd2): "445", (0xcc, 0x96): "464", (0xd8, 0xd6): "465", (0xd0, 0xb6): "466",
    (0xcc, 0xe1): "503", (0xc0, 0xb1): "506", (0xd8, 0xb9): "516", (0xd8, 0xad): "532",
    (0xcc, 0xb3): "546", (0xdc, 0xd7): "565", (0xd1, 0xb0): "606", (0xd1, 0xa8): "612",
    (0xd5, 0x94): "624", (0xdd, 0xf4): "627", (0xc1, 0xcc): "631", (0xc9, 0xac): "632",
    (0xd9, 0x9a): "654", (0xdd, 0xa6): "662", (0xd9, 0x96): "664", (0xd9, 0xe1): "703",
    (0xd5, 0xa9): "712", (0xc1, 0xe5): "723", (0xc5, 0xcd): "731", (0xcd, 0xad): "732",
    (0xc9, 0x9d): "734", (0xd5, 0xe3): "743", (0xdd, 0x9b): "754",
}
DPL_PAIR_BY_CODE = {v: k for k, v in DPL_CODE_BY_PAIR.items()}
M900_DPL_OFF2 = 26   # the second DPL byte, at record offset +26 (next rec's +0)


def dpl_code_900(b25: int, b26: int):
    """Map a 900 DPL byte pair (rec+25, rec+26) to a code string like 'D411'."""
    c = DPL_CODE_BY_PAIR.get((b25, b26))
    return ("D" + c) if c else None


def squelch_900(b: int):
    """Classify a 900 squelch code byte (rec+25) -> (type, pl_freq).

    type is "Carrier" | "PL" | "DPL"; pl_freq is the CTCSS tone string for a
    recognized PL byte, else None (Carrier, DPL, or an unseen PL byte)."""
    if b == 0:
        return "Carrier", None
    if b >= M900_DPL_MIN:
        return "DPL", None
    return "PL", PL_CODE_BY_BYTE.get(b)


# VHF DPL (digital) uses the SAME 83-code value map as 900 (DPL_CODE_BY_PAIR),
# stored big-endian in the mode's 2-byte tone slot (hi@+17/+19/+21, lo@+18/...).
# The only difference from the 900 pair is one bit in the high byte: bit 0x20
# SET => normal "DPL", CLEAR => "INV.DPL" (inverted). Mask that bit off and the
# (hi, lo) pair indexes DPL_CODE_BY_PAIR directly. Recovered + validated vs RSS
# on 221AZN (T83FW): 22 captured codes across both polarities all decode exactly,
# and all 83 codes x 2 polarities give 166 distinct, DPL-classified pairs.
#
# The polarity bit's sense depends on the slot: the above holds for the RX slot;
# in the TX (and T.A) slot it is the opposite -- SET => INV.DPL. Found when a
# motreader edit writing mode 2 Tx "DPL 311" (bit set) GET-loaded in RSS as
# "Tx INV.DPL 311" and mode 3 Tx "INV.DPL 023" as "Tx DPL 023" (2026-10-23); the
# MPL list shows the same TX/TA convention on both bands.
VHF_DPL_NORMAL_BIT = 0x20   # RX slot hi byte: SET => DPL, CLEAR => INV.DPL (TX: reversed)
VHF_PL_TA_OFF = 21          # T·A tone slot (hi=21, lo=22); preserved, not decoded


def _dpl_normal(hi: int, is_tx: bool) -> bool:
    return bool(hi & VHF_DPL_NORMAL_BIT) != is_tx


def vhf_dpl_decode(hi: int, lo: int, is_tx: bool = False):
    """Decode a VHF DPL tone slot -> (squelch_type, code) or (None, None).
    squelch_type is 'DPL' | 'INV.DPL'; code is like 'D754'. `is_tx` selects the
    TX/T.A polarity sense (see VHF_DPL_NORMAL_BIT)."""
    code = DPL_CODE_BY_PAIR.get((hi & (~VHF_DPL_NORMAL_BIT & 0xFF), lo))
    if code is None:
        return None, None
    return ("DPL" if _dpl_normal(hi, is_tx) else "INV.DPL"), "D" + code


def vhf_dpl_encode(code: str, inverted: bool, is_tx: bool = False):
    """Encode a DPL code ('D754') + polarity -> (hi, lo) slot bytes, or None."""
    if not code or code[:1] != "D":
        return None
    pair = DPL_PAIR_BY_CODE.get(code[1:])
    if pair is None:
        return None
    h9, lo = pair
    return (h9 | VHF_DPL_NORMAL_BIT if inverted == is_tx else h9), lo


def vhf_squelch_type(hi: int, lo: int, is_tx: bool = False):
    """Classify a VHF 16-bit tone slot (bit15 enable) -> squelch type or None.
    0 = Carrier; >= 0xC000 = DPL family (polarity from bit 0x20 of hi, sense per
    slot: see VHF_DPL_NORMAL_BIT); else PL (CTCSS)."""
    val = (hi << 8) | lo
    if val == 0:
        return "Carrier"
    if val >= 0xC000:
        return "DPL" if _dpl_normal(hi, is_tx) else "INV.DPL"
    if val & VHF_PL_ENABLE:
        return "PL"
    return None

RX_BASE_MHZ = 925.6500  # 900 MHz band base for the RX value
# 900 MHz TX/T/A are not yet decoded as independent fields (the VHF per-field
# codec does not transfer directly -- 900 uses a different record layout and its
# own constants). For 900, tx/ta are left None until calibrated via the same
# inverse-oracle method used for VHF. (RX/TX/TA are independent; there is no
# fixed split.)


# Tone slots: every mode has three 2-byte squelch slots, Rx / Tx / T·A, in the
# same codec on both bands (bit15 + Rx Hz*61.2428, Tx/T·A 165596.6/Hz; DPL by the
# 83-code map). VHF slots sit at view +17/+19/+21; 900 MHz at view +25/+27/+29
# (true record +14/+16/+18), cracked by stepping each code in RSS. DPL polarity
# (bit 0x20 of the hi byte): SET = DPL in a VHF Rx slot, SET = INV.DPL in every
# other slot (900 Rx included). Rx and Tx codes are independent on 900 (the RSS
# MODE SUMMARY shows e.g. Rx 411 / Tx blank), not one shared code.
M900_SLOTS = {"rx": 25, "tx": 27, "ta": 29}
VHF_SLOTS = {"rx": 17, "tx": 19, "ta": 21}


def _sum_places(body: bytes):
    """Where a record's 8-bit sum may be, relative to its true start: at L-1,
    or +25 / +26 on zones-off records with a scan list after them (26: a 900
    27-byte record); on the older format versions at +23, before the scan list."""
    v = codeplug_version(body)
    return (23,) if v is not None and v < 115 else (body[0x10A] - 1, 25, 26)


def record_sum_offsets(body: bytes) -> set:
    """Body offsets of the mode records' 8-bit sums (see Codeplug._fix_record_sums)."""
    pt = mode_pointer_table(body)
    if pt is None:
        return set()
    out = set()
    for t in pt[2]:
        for k in _sum_places(body):
            if t + k < len(body) and sum(body[t:t + k]) & 0xFF == body[t + k]:
                out.add(t + k)
                break
    return out


def slot_decode(hi: int, lo: int, pl_tx: bool, dpl_tx: bool):
    """-> (squelch type, code) of a tone slot; code is a tone ("141.3"), a DPL
    code ("D411") or None (Carrier)."""
    t = vhf_squelch_type(hi, lo, dpl_tx)
    if t == "PL":
        return t, vhf_pl_decode(hi, lo, pl_tx)
    if t in ("DPL", "INV.DPL"):
        return t, vhf_dpl_decode(hi, lo, dpl_tx)[1]
    return t, None


def slot_encode(stype: str, code, pl_tx: bool, dpl_tx: bool):
    if stype == "Carrier":
        return 0x00, 0x00
    if stype == "PL":
        return vhf_pl_encode(code, pl_tx)
    return vhf_dpl_encode(code, stype == "INV.DPL", dpl_tx)


@dataclass
class Mode:
    number: int
    name: str = ""
    rx_mhz: Optional[float] = None
    ta_mhz: Optional[float] = None
    tx_mhz: Optional[float] = None
    rx_pl: Optional[str] = None  # Rx PL tone ("141.3") or DPL code ("D754"); None for Carrier
    tx_pl: Optional[str] = None  # Tx PL tone or DPL code; None for Carrier
    rx_squelch_type: Optional[str] = None  # "Carrier" | "PL" | "DPL" | "INV.DPL"
    tx_squelch_type: Optional[str] = None  # "Carrier" | "PL" | "DPL" | "INV.DPL"
    ta_pl: Optional[str] = None  # Talkaround PL tone or DPL code; None for Carrier
    ta_squelch_type: Optional[str] = None
    # Per-mode options (VHF only; None on bands not yet mapped). Strings so the
    # CSV reads like the RSS screen: "High"/"Low" and "Enabled"/"Disabled".
    tx_power: Optional[str] = None       # Transmit Power  "High"/"Low"
    ta_power: Optional[str] = None       # Talkaround Power "High"/"Low"
    up_xtal_shift: Optional[str] = None  # uP Xtal Shift    "Enabled"/"Disabled"
    mdc_ptt_id: Optional[str] = None     # MDC PTT ID       "Enabled"/"Disabled"
    phone_encode: Optional[str] = None   # Phone Encode     "Enabled"/"Disabled"
    mpl_type: Optional[str] = None       # MPL Type  Disabled/TX Only/RX Only/RX & TX
    audio_compander: Optional[str] = None   # Audio Compander  "Enabled"/"Disabled" (900)
    adaptive_splatter: Optional[str] = None # Adaptive Splatter "Enabled"/"Disabled" (900)
    reverse_burst_toc: Optional[str] = None # Reverse Burst/TOC "Enabled"/"Disabled" (900)
    unmute_mute_type: Optional[str] = None  # UnMute/Mute Type  Std/Std, AND/Std, AND/OR (900)
    raw: bytes = b""             # full record, for lossless round-trip
    offset: int = -1            # record start offset in the body

    def rx_value(self) -> int:
        return self.raw[RX_VALUE_OFF] | (self.raw[RX_VALUE_OFF + 1] << 8)


OLD_FORMAT_BASE = 0x5F53   # pointer base of the older format versions


def codeplug_version(body: bytes) -> Optional[int]:
    """The codeplug format version: the three digits after the serial in the
    header ("617ASQ126600 115A" -> 115), or None."""
    import re
    i = body[:0x200].find(b"COPYRIGHT MOTOROLA INC.,1987")
    if i < 0:
        return None
    m = re.match(rb"[0-9A-Z]{10}\d\d (\d{3})", body[i + 0x1D:i + 0x1D + 17])
    return int(m.group(1)) if m else None


def mode_pointer_table(body: bytes):
    """The mode pointer table: (base, table offset, [true record starts]) or None.

    RSS keeps one big-endian pointer per mode (count = header 0x109) to each
    mode record; pointer = body offset + base (a model EEPROM base: 0x5F53 on
    most radios, 0x1953 on 604AUN). The header word at 0xE5 points at the
    radio-wide ext block (which gives the base) and 0xED at the table. Record
    length = header 0x10A; it changes with ZONE OPERATION (per-mode scan list),
    so this is the robust way to find the records. 566AYA's first record is a
    longer special one, and trunked records come first, at their own length.
    motreader's per-band record views start 11 (900 MHz) or 3 (VHF) bytes
    before the true start. The older format versions (101-114)
    have the same table, record length and base, but no ext block."""
    from .radiowide import find_ext_block
    if len(body) < 0x1E8:
        return None
    e = find_ext_block(body)
    # older format versions (101-114) have no ext block: their pointers use the usual base
    base = OLD_FORMAT_BASE if e is None else ((body[0xE5] << 8) | body[0xE6]) - e
    tab = ((body[0xED] << 8) | body[0xEE]) - base
    n, L = body[0x109], body[0x10A]
    if not (0x1E8 <= tab < len(body) - 2 * n) or n == 0 or L < 20:
        return None
    starts = [((body[tab + 2 * i] << 8) | body[tab + 2 * i + 1]) - base for i in range(n)]
    if any(not (tab < t < len(body) - L) for t in starts):
        return None
    # the records after the first are L apart, except leading trunked ones
    # (518ATN: four 47-byte trunked modes before its conventional ones)
    k = 1
    while k < n - 1 and is_trunked_record(body, starts[k]):
        k += 1
    if any(starts[i + 1] - starts[i] != L for i in range(k, n - 1)):
        return None
    return base, tab, starts


def _record_band(body: bytes, starts) -> Optional[str]:
    """Band of the records at the pointer-table starts, from their tags
    (trunked records don't count)."""
    starts = [t for t in starts if not is_trunked_record(body, t)]
    # RX tag 0xA0 at +2 (b4 set = the mode scans with SCAN TYPE Talkgroup)
    s900 = sum(body[t + 2] & 0xEF == 0xA0 and body[t + 13] == 0x8C for t in starts)
    svhf = sum(body[t + 6] in (0xE9, 0xE8, 0x68) for t in starts)
    # UHF: the VHF record with tags E9/EA (lo's 9th bit) and an RX that only reads as UHF
    suhf = sum(_uhf_record(body, t) for t in starts)
    s800 = sum(_m800_record(body, t) for t in starts)
    need = max(min(2, len(starts)), len(starts) // 2)   # a one-mode codeplug has one record
    if s900 >= need:
        return "900"
    if suhf >= need:
        return "uhf"
    if s800 >= need:
        return "800"
    if svhf >= need:
        return "vhf"
    return None


def zone_sections(body: bytes):
    """RSS's own zone-table pointers in the radio-wide ext block, or None:
    {"count", "w", "names", "flags", "memb", "memb_len"} (body offsets).
    ext +0x58 -> names (6 bytes/zone, 6-bit; 0 on the A9 head, whose names
    live in its ASCII pool), +0x56 -> flag section (2-byte length, then one
    W+3 record per zone: scan-options byte, 2 priority bytes, W-byte zone scan
    list), +0x54 -> membership section (2-byte length, W bytes per zone, 8-bit
    sum), +0x5B = zone count, +0x1E = W (membership width)."""
    from .radiowide import find_ext_block
    e = find_ext_block(body)
    if e is None or len(body) < e + 0x60:
        return None
    base = ((body[0xE5] << 8) | body[0xE6]) - e
    nz, w = body[e + 0x5B], body[e + 0x1E] & 0x7F
    if nz == 0 or w == 0:
        return None
    ptr = lambda k: ((body[e + k] << 8) | body[e + k + 1]) - base
    names, flags, memb = ptr(0x58), ptr(0x56), ptr(0x54)
    if not (0 <= flags < memb < e):
        return None
    mlen = (body[memb] << 8) | body[memb + 1]
    if memb + mlen != e or mlen != 2 + nz * w + 1:
        return None
    return {"count": nz, "w": w, "names": names if 0 < names < flags else None,
            "flags": flags, "memb": memb, "memb_len": mlen}


def zone_operation(body: bytes) -> Optional[bool]:
    """RADIO-WIDE ZONE OPERATION: control-head block +0x13 bit 4 (set = zones,
    on all six on-hand radios). None if the block isn't found. With it off the
    radio is mode-driven: no zone tables (the structural zone finder can match
    other data there, so zones are only decoded when it is on)."""
    from .radiowide import find_chb_block
    c = find_chb_block(body)
    return None if c is None else bool(body[c + 0x13] & 0x10)


@dataclass
class Codeplug:
    body: bytes  # decrypted archive body (plaintext)
    signature: str = ""
    serial: str = ""
    model: str = ""
    band: str = ""  # "vhf" | "uhf" | "800" (decode only) | "900" | "900?" | ""
    # the codeplug format version in the header (115, 116; older radios 101-114)
    format_version: Optional[int] = None
    modes: list[Mode] = field(default_factory=list)
    zones: list = field(default_factory=list)   # list[Zone] (radio-wide)
    # (start, width) of an ASCII mode-name table (A9/expanded heads), else None.
    ascii_names: Optional[tuple] = None
    # UHF: the radio's range (band split), None if its modes fit no known one
    uhf_range: Optional[UhfRange] = None

    @classmethod
    def parse(cls, body: bytes) -> "Codeplug":
        cp = cls(body=body, format_version=codeplug_version(body))
        cp._parse_header()
        cp._parse_modes()
        # the older format versions' zones aren't mapped (the zone finder matches other data)
        if cp.format_version is None or cp.format_version >= 115:
            cp._parse_zones()
        return cp

    @property
    def zone_operation(self) -> Optional[bool]:
        return zone_operation(self.body)

    def _parse_zones(self) -> None:
        """Locate + decode the zone block (name + mode membership per zone).
        No zone block -> cp.zones stays empty. Requires modes already parsed
        (membership bitmaps are bounded by the mode count; the name encoding
        follows the same head type as the mode names)."""
        n_modes = len(self.modes)
        if n_modes == 0 or zone_operation(self.body) is False:
            return
        self._zone_secs = secs = zone_sections(self.body)
        if secs and secs["names"] is not None and self.ascii_names is None:
            # standard head: follow RSS's pointers (works for any zone count,
            # incl. the single zone a Zone Operation switch creates)
            w = secs["w"]
            for k in range(secs["count"]):
                noff = secs["names"] + 6 * k
                moff = secs["memb"] + 2 + k * w
                self.zones.append(Zone(
                    number=k + 1, name=unpack_name(self.body[noff:noff + 6]),
                    modes=_zone_rec_modes(self.body, moff, w),
                    flag_byte=self.body[secs["flags"] + 2 + k * (w + 3)],
                    names_off=noff, name_w=6, name_enc="6bit",
                    memb_off=moff, memb_w=w))
            return
        if secs and secs["names"] is None and self.ascii_names is not None:
            # A9 head: same pointers; the names are the 11-char ASCII entries
            # right before the mode-name table in the head's string block
            w, (mstart, nw) = secs["w"], self.ascii_names
            noff0 = mstart - secs["count"] * nw
            for k in range(secs["count"]):
                noff = noff0 + k * nw
                moff = secs["memb"] + 2 + k * w
                self.zones.append(Zone(
                    number=k + 1, name=self._ascii_at(noff, nw),
                    modes=_zone_rec_modes(self.body, moff, w),
                    flag_byte=self.body[secs["flags"] + 2 + k * (w + 3)],
                    names_off=noff, name_w=nw, name_enc="ascii",
                    memb_off=moff, memb_w=w))
            return
        blk = find_zone_block(self.body, n_modes, self.ascii_names)
        if not blk:
            return
        N, w, noff0, name_w, enc, flags_off, flag_foff, memb0, _score = blk
        flag_stride = w + 3
        for k in range(N):
            noff = noff0 + k * name_w
            moff = memb0 + k * w
            if enc == "ascii":
                name = self.body[noff:noff + name_w].decode("latin-1").rstrip(" \x00")
            else:
                name = unpack_name(self.body[noff:noff + name_w])
            # the per-zone scan-options byte (the periodic flag byte), for
            # reference; scanlist.py decodes it.
            fbyte_off = flags_off + k * flag_stride + flag_foff
            self.zones.append(Zone(
                number=k + 1,
                name=name,
                modes=_zone_rec_modes(self.body, moff, w),
                flag_byte=self.body[fbyte_off] if fbyte_off < len(self.body) else 0,
                names_off=noff,
                name_w=name_w,
                name_enc=enc,
                memb_off=moff,
                memb_w=w,
            ))

    def _ascii_at(self, off: int, length: int) -> str:
        return self.body[off : off + length].decode("latin-1").rstrip(" \x00")

    def _parse_header(self) -> None:
        b = self.body
        i = b.find(b"COPYRIGHT MOTOROLA INC.,1987")
        if i >= 0:
            self.signature = "COPYRIGHT MOTOROLA INC.,1987"
            self.serial = self._ascii_at(i + 0x1D, 10)
        import re

        m = re.search(rb"[DT]\d{2}[A-Z0-9]{9}", b)
        if m:
            self.model = m.group().decode("ascii")
        s = re.search(rb"[0-9][0-9A-Z]{9}\d{2}", b[max(0, i - 40) : i] if i > 0 else b"")
        if s:
            self.serial = s.group()[:10].decode("ascii")

    def _name_for(self, n: int) -> str:
        if self.ascii_names is not None:
            start, w = self.ascii_names
            off = start + (n - 1) * w
            return self.body[off : off + w].decode("latin-1").rstrip(" \x00")
        noff = NAME_TABLE_OFF + (n - 1) * NAME_LEN_BYTES
        return unpack_name(self.body[noff : noff + NAME_LEN_BYTES])

    def _name_quality(self, n_modes: int) -> int:
        """Count modes whose current name source yields a sensible name."""
        good = 0
        for i in range(1, n_modes + 1):
            nm = self._name_for(i)
            if nm and all(0x20 <= ord(c) <= 0x7E for c in nm) \
                    and any(c.isalnum() for c in nm):
                good += 1
        return good

    def _select_name_table(self, n_modes: int) -> None:
        """Choose the mode-name source. Standard heads keep the 6-bit table at
        0x0266 populated; A9/expanded heads leave it blank (or sparse garbage)
        there and store fixed-width ASCII names elsewhere. Decide by which source
        actually yields readable names, so a sparse-but-nonzero 6-bit slot does
        not mask a real ASCII table. Modes must already be decoded (their RX
        frequencies anchor the ASCII table against look-alike string blocks)."""
        q6 = self._name_quality(n_modes)
        if q6 >= n_modes * 0.6:  # 6-bit names are fine -> standard head
            return
        hints = [_freq_hint(m.rx_mhz) for m in self.modes]
        cand = find_ascii_name_table(self.body, n_modes, hints)
        if cand is None:
            return
        self.ascii_names = cand
        if self._name_quality(n_modes) < max(q6, 1):  # ASCII no better -> revert
            self.ascii_names = None

    def _parse_modes(self) -> None:
        pt = mode_pointer_table(self.body)
        band = pt and _record_band(self.body, pt[2])
        if band in ("uhf", "800"):
            # UHF, 800 MHz: the VHF record layout with their own frequency codecs
            self.band = band
            self._parse_modes_vhf([t - 3 for t in pt[2]])
            if band == "uhf":
                self.uhf_range = uhf_range_for(self.model, [m for m in self.modes if m.rx_mhz is not None])
            self._select_name_table(len(pt[2]))
            for m in self.modes:
                m.name = self._name_for(m.number)
            return
        if pt and band == "vhf":
            # RSS's own mode pointers (identical to the tag-run search on every
            # on-hand file, and robust when sections move, e.g. after a Zone
            # Operation re-pack, where the search can pick up a stray record)
            vhf = [t - 3 for t in pt[2]]
        else:
            vhf = find_vhf_records(self.body)
        if vhf:
            self.band = "vhf"
            self._parse_modes_vhf(vhf)
            self._select_name_table(len(vhf))
            for m in self.modes:
                m.name = self._name_for(m.number)
        else:
            self._parse_modes_900()

    def _parse_modes_vhf(self, starts: list[int]) -> None:
        b = self.body
        for n, off in enumerate(starts, 1):
            rec = b[off : off + VHF_REC_LEN]
            m = Mode(number=n, raw=rec, offset=off)
            if is_trunked_record(b, off + 3):
                # a trunked mode in a mixed table: listed with no values, never written
                m.name = self._name_for(n)
                self.modes.append(m)
                continue
            uhf, m800 = self.band == "uhf", self.band == "800"
            m.rx_mhz = (uhf_decode_rx(rec[6], rec[7], rec[8], rec[5]) if uhf
                        else m800_decode_rx(rec[6], rec[7], rec[5]) if m800
                        else vhf_decode_rx(rec[VHF_RX_OFF], rec[VHF_RX_OFF + 1], rec[VHF_RX_OFF + 2],
                                           rec[VHF_RX_OFF - 1]))

            def field(o):
                if uhf:
                    return uhf_decode_txta(rec[o], rec[o + 1], rec[o - 1], rec[o + 2])
                if m800:
                    return m800_decode_txta(rec[o], rec[o + 1], rec[o - 1])
                return vhf_decode(rec[o], rec[o + 1], VHF_TX_COEF)
            # TX / T·A are "Blank" on an RX-only mode (e.g. NOAA weather): both
            # value bytes are zero (which would otherwise decode to the base
            # frequency). A programmed field always has a non-zero (lo, mid).
            if rec[VHF_TX_OFF] or rec[VHF_TX_OFF + 1]:
                m.tx_mhz = field(VHF_TX_OFF)
            if rec[VHF_TA_OFF] or rec[VHF_TA_OFF + 1]:
                m.ta_mhz = field(VHF_TA_OFF)
            m.rx_pl = vhf_pl_decode(rec[VHF_PL_RX_OFF], rec[VHF_PL_RX_OFF + 1], False)
            m.tx_pl = vhf_pl_decode(rec[VHF_PL_TX_OFF], rec[VHF_PL_TX_OFF + 1], True)
            m.rx_squelch_type = vhf_squelch_type(rec[VHF_PL_RX_OFF], rec[VHF_PL_RX_OFF + 1])
            m.tx_squelch_type = vhf_squelch_type(rec[VHF_PL_TX_OFF], rec[VHF_PL_TX_OFF + 1], True)
            # DPL (digital) squelch: fill the code ("D754") -- vhf_pl_decode only
            # handles CTCSS, so rx_pl/tx_pl are still None for a DPL slot here.
            if m.rx_squelch_type in ("DPL", "INV.DPL"):
                _, m.rx_pl = vhf_dpl_decode(rec[VHF_PL_RX_OFF], rec[VHF_PL_RX_OFF + 1])
            if m.tx_squelch_type in ("DPL", "INV.DPL"):
                _, m.tx_pl = vhf_dpl_decode(rec[VHF_PL_TX_OFF], rec[VHF_PL_TX_OFF + 1], True)
            m.ta_squelch_type, m.ta_pl = slot_decode(rec[VHF_PL_TA_OFF], rec[VHF_PL_TA_OFF + 1],
                                                     True, True)
            # per-mode option flags (power reported only for a programmed TX/T·A)
            m.up_xtal_shift = "Disabled" if (rec[VHF_FLAGS3_OFF] & VHF_UPXTAL_BIT) else "Enabled"
            m.mdc_ptt_id = "Enabled" if (rec[VHF_FLAGS4_OFF] & VHF_MDC_PTT_BIT) else "Disabled"
            m.phone_encode = "Enabled" if (rec[VHF_FLAGS4_OFF] & VHF_PHONE_ENC_BIT) else "Disabled"
            m.mpl_type = VHF_MPL_BY_BITS[rec[VHF_FLAGS3_OFF] & VHF_MPL_MASK]
            if m.tx_mhz is not None:
                m.tx_power = "High" if (rec[VHF_TX_TAG_OFF] & VHF_POWER_BIT) else "Low"
            if m.ta_mhz is not None:
                m.ta_power = "High" if (rec[VHF_TA_TAG_OFF] & VHF_POWER_BIT) else "Low"
            if m800 and m.tx_mhz is None and m.ta_mhz is not None:
                # simplex: RSS shows the T/A field as the TX
                m.tx_mhz, m.tx_power, m.ta_mhz, m.ta_power = m.ta_mhz, m.ta_power, None, None
            m.name = self._name_for(n)
            self.modes.append(m)

    def _parse_modes_900(self) -> None:
        """Decode a 900 MHz codeplug. Two record layouts are handled, both with
        the same per-field freq codec but different record lengths:

        * 566AYA layout: table at 0x0D26, stride 26, a special (non-conventional)
          mode 1 that lacks the signature. Kept on the fixed offset so mode
          numbering matches RSS.
        * variable-stride layouts (e.g. 604ATY, stride 40): located structurally
          by the RX-tag/end-tag signature run (``find_900_table``).

        Frequencies are decoded with ``decode_900_fields`` (RSS display logic:
        repeater vs simplex vs empty) and only when plausible. If no layout is
        recognized the band is flagged ``900?`` and freqs are left undecoded
        (names + raw are still exported) so the tool never prints bogus MHz.

        Other 900 models (e.g. D37KMA / 935-band) use yet other layouts — not yet
        decoded; see notes/STATUS.md and notes/ground-truth/.
        """
        b = self.body
        start = stride = None

        # Prefer the 566AYA fixed layout (preserves its special mode-1 numbering).
        sig26 = sum(1 for i in range(60)
                    if MODE_TABLE_OFF + i * 26 + 24 < len(b)
                    and b[MODE_TABLE_OFF + i * 26 + 13] == 0xA0
                    and b[MODE_TABLE_OFF + i * 26 + 24] == 0x8C)
        if sig26 >= 5:
            start, stride = MODE_TABLE_OFF, 26
        else:
            found = find_900_table(b)
            if found:
                start, stride, _ = found

        offsets = None
        pt = mode_pointer_table(b)
        if pt and _record_band(b, pt[2]) == "900":
            starts = pt[2]
            ptr_offs = [t - 11 for t in starts]
            if len(starts) > 1 and starts[1] - starts[0] != b[0x10A]:
                ptr_offs[0] = starts[0]         # special first record (566AYA)
            if (stride, start) != (b[0x10A], ptr_offs[0]):
                # the stride search disagrees with the header (e.g. zones off on
                # 566AYA: 43-byte records): follow RSS's own pointers
                offsets = ptr_offs
                start, stride = offsets[0], b[0x10A]

        if start is None:
            self.band = "900?"  # layout not recognized: names/raw only, no freqs
            return

        self.band = "900"
        n = 0
        limit = len(pt[2]) if pt and _record_band(b, pt[2]) == "900" else None
        while True:
            if (offsets or limit) and n >= (len(offsets) if offsets else limit):
                break         # RSS's own mode count (header 0x109)
            off = offsets[n] if offsets else start + n * stride
            if off + 26 > len(b):
                break
            rec = b[off : off + stride]
            if not any(rec[:26]):  # all-zero record terminates the table
                break
            n += 1
            m = Mode(number=n, raw=rec, offset=off,
                     name=self._name_for(n))
            m.rx_mhz, m.tx_mhz, m.ta_mhz = decode_900_fields(rec)
            # squelch: three independent tone slots (Rx / Tx / T·A) at view
            # +25/+27/+29; they run past the 26-byte view into the next one
            # (the 37-byte trunked mode 1 of a trunked codeplug has no tone slots:
            # its view offset is its true start rather than true start - 11)
            special = n == 1 and ((pt is not None and pt[2][0] == off)
                                  or (pt is None and off == MODE_TABLE_OFF))
            if not special:
                for key, so in M900_SLOTS.items():
                    hi = b[off + so] if off + so < len(b) else 0
                    lo = b[off + so + 1] if off + so + 1 < len(b) else 0
                    st_, code = slot_decode(hi, lo, key != "rx", True)
                    setattr(m, f"{key}_squelch_type", st_)
                    setattr(m, f"{key}_pl", code)
            # per-mode option flags
            m.up_xtal_shift = "Disabled" if (rec[M900_FLAGS11_OFF] & M900_UPXTAL_BIT) else "Enabled"
            m.audio_compander = "Enabled" if (rec[M900_FLAGS12_OFF] & M900_COMPANDER_BIT) else "Disabled"
            m.adaptive_splatter = "Enabled" if (rec[M900_FLAGS12_OFF] & M900_SPLATTER_BIT) else "Disabled"
            m.mdc_ptt_id = "Enabled" if (rec[M900_FLAGS12_OFF] & M900_MDC_PTT_BIT) else "Disabled"
            m.phone_encode = "Enabled" if (rec[M900_FLAGS12_OFF] & M900_PHONE_ENC_BIT) else "Disabled"
            m.reverse_burst_toc = "Enabled" if (rec[M900_FLAGS11_OFF] & M900_REVBURST_BIT) else "Disabled"
            m.unmute_mute_type = M900_UNMUTE_BY_BITS.get(rec[M900_FLAGS11_OFF] & M900_UNMUTE_MASK)
            m.mpl_type = VHF_MPL_BY_BITS[rec[M900_FLAGS11_OFF] & M900_MPL_MASK]
            if m.tx_mhz is not None:
                m.tx_power = "High" if (rec[M900_TXPWR_OFF] & M900_PWR_BIT) else "Low"
            if m.ta_mhz is not None:
                m.ta_power = "High" if (rec[M900_TAPWR_OFF] & M900_PWR_BIT) else "Low"
            self.modes.append(m)
            if n >= 250:
                break

    def rebuild(self) -> bytearray:
        """Return a mutable copy of the body with current mode fields applied.

        Only mapped fields are written; everything else is preserved from the
        stored raw records, so unmodified modes re-encode byte-identically.
        """
        out = bytearray(self.body)
        for m in self.modes:
            # 800 MHz records (decoded only) and trunked records are never written
            if self.band in ("vhf", "uhf"):
                if not is_trunked_record(self.body, m.offset + 3):
                    self._write_mode_vhf(out, m)
            elif self.band != "800":
                self._write_mode_900(out, m)
            self._write_name(out, m)
        self._fix_record_sums(out)
        for z in self.zones:
            self._write_zone(out, z)
        secs = getattr(self, "_zone_secs", None)
        if secs and self.zones:
            # the membership section ends with an 8-bit sum (RSS recomputes it)
            m, L = secs["memb"], secs["memb_len"]
            if out[m:m + L - 1] != self.body[m:m + L - 1]:
                out[m + L - 1] = sum(out[m:m + L - 1]) & 0xFF
        return out

    def _fix_record_sums(self, out: bytearray) -> None:
        """Each mode record ends with an 8-bit sum of its other bytes
        (_sum_places). RSS doesn't check it on GET but recomputes it when it
        edits a mode, so do the same for every record motreader changed (only
        where the sum was valid to begin with)."""
        pt = mode_pointer_table(self.body)
        if pt is None:
            return
        for t in pt[2]:
            for k in _sum_places(self.body):
                if t + k >= len(self.body):
                    continue
                if sum(self.body[t:t + k]) & 0xFF != self.body[t + k]:
                    continue
                if out[t:t + k] != self.body[t:t + k]:
                    out[t + k] = sum(out[t:t + k]) & 0xFF
                break

    def _write_zone(self, out: bytearray, z: "Zone") -> None:
        """Write a zone's name + mode membership, change-gated so an unedited
        zone re-encodes byte-identically. The per-zone flag byte and the rest of
        the flag record (scan list etc.) are preserved verbatim via `out`
        (started as a copy of the body); only name + membership bytes change."""
        if z.names_off >= 0:
            if z.name_enc == "ascii":
                # preserve original pad bytes (space vs NUL) when unchanged
                cur = self.body[z.names_off:z.names_off + z.name_w]
                if cur.rstrip(b" \x00").decode("latin-1") != z.name:
                    out[z.names_off:z.names_off + z.name_w] = \
                        z.name.encode("latin-1")[:z.name_w].ljust(z.name_w, b" ")
            else:
                packed = pack_name(z.name)[:z.name_w]
                if self.body[z.names_off:z.names_off + z.name_w] != packed:
                    out[z.names_off:z.names_off + z.name_w] = packed
        if z.memb_off >= 0:
            bm = pack_membership(z.modes, z.memb_w)
            if self.body[z.memb_off:z.memb_off + z.memb_w] != bm:
                out[z.memb_off:z.memb_off + z.memb_w] = bm

    def _write_name(self, out: bytearray, m: Mode) -> None:
        if self.ascii_names is not None:
            start, w = self.ascii_names
            off = start + (m.number - 1) * w
            # Preserve the original pad bytes (space vs NUL) when the name is
            # unchanged, so re-encode is byte-identical.
            if self.body[off : off + w].rstrip(b" \x00").decode("latin-1") == m.name:
                return
            field = m.name.encode("latin-1")[:w].ljust(w, b" ")
            out[off : off + w] = field
            return
        noff = NAME_TABLE_OFF + (m.number - 1) * NAME_LEN_BYTES
        packed = pack_name(m.name)
        # Only write when the bytes actually differ, so an unchanged name is a
        # true no-op (preserves the template's exact bytes even if pack_name is
        # not a perfect inverse of the original packing).
        if self.body[noff : noff + NAME_LEN_BYTES] != packed:
            out[noff : noff + NAME_LEN_BYTES] = packed

    def _write_field_vhf(self, out: bytearray, m: Mode, foff: int, freq, coef,
                         has_band: bool) -> None:
        if freq is None:
            return
        # Lossless: a field can have several (lo, mid) encodings of the same MHz,
        # so if the value is unchanged from the original bytes, leave them as-is
        # (out already holds the original body). Only re-encode a real edit.
        if freq == vhf_decode(m.raw[foff], m.raw[foff + 1], coef):
            return
        base = m.offset
        lo, mid = vhf_encode(freq, coef)
        out[base + foff], out[base + foff + 1] = lo, mid
        if has_band:
            out[base + foff + 2] = vhf_tx_band_byte(freq)

    def _write_field_vhf_rx(self, out: bytearray, m: Mode, freq) -> None:
        """A VHF RX field, re-encoded only if its value changed: lo/mid, lo's
        9th bit (view +5 b0) and the flag byte's step / 166.15 MHz bits."""
        if freq is None:
            return
        r = m.raw
        if freq == vhf_decode_rx(r[6], r[7], r[8], r[5]):
            return
        enc = vhf_encode_rx(freq)
        if enc is None:
            raise ValueError(f"mode {m.number}: VHF RX {freq} MHz can't be stored "
                             "(it must be on a 5 or 6.25 kHz raster)")
        a = m.offset + VHF_RX_OFF
        out[a], out[a + 1] = enc[0], enc[1]
        out[a - 1] = (out[a - 1] & ~0x01 & 0xFF) | enc[2]
        out[a + 2] = (out[a + 2] & ~0x05 & 0xFF) | enc[3]

    def _write_flag_vhf(self, out: bytearray, m: Mode, off: int, bit: int,
                        want_set: Optional[bool]) -> None:
        """Set/clear a single option bit, preserving the rest of the byte.
        Writes only on a real change, so an unedited mode re-encodes byte-exact."""
        if want_set is None:
            return
        if bool(m.raw[off] & bit) == want_set:   # unchanged: leave original bits
            return
        base = m.offset
        if want_set:
            out[base + off] |= bit
        else:
            out[base + off] &= (~bit & 0xFF)

    def _write_field_uhf(self, out: bytearray, m: Mode, foff: int, freq) -> None:
        """A UHF frequency field, re-encoded only if its value changed. RX:
        lo/mid + the flag byte's step and band bits; TX/TA: lo/mid, lo's 9th
        bit in the tag, the band byte, and power forced Low where RSS forces
        it. The band split is the radio's range's (440-491 MHz's if unknown)."""
        if freq is None:
            return
        rng = self.uhf_range or UHF_RANGES[0]
        rx = foff == VHF_RX_OFF
        r = m.raw
        cur = (uhf_decode_rx(r[6], r[7], r[8], r[5]) if rx
               else uhf_decode_txta(r[foff], r[foff + 1], r[foff - 1], r[foff + 2]))
        if freq == cur:
            return
        a = m.offset + foff
        if rx:
            enc = uhf_encode_rx(freq, rng.rx_split, rng.rss[1])
            if enc is None:
                raise ValueError(f"mode {m.number}: UHF RX {freq} MHz can't be stored")
            out[a], out[a + 1] = enc[0], enc[1]
            out[a - 1] = (out[a - 1] & ~0x01 & 0xFF) | enc[2]
            out[a + 2] = (out[a + 2] & ~0x0D & 0xFF) | enc[3]
            return
        enc = uhf_encode_txta(freq, rng.tx_split, rng.rss[1])
        if enc is None:
            raise ValueError(f"mode {m.number}: UHF TX/T·A {freq} MHz can't be stored")
        lo, mid, bit9, band = enc
        out[a], out[a + 1], out[a + 2] = lo, mid, band
        tag = (out[a - 1] & ~0x03 & 0xFF) | (0x02 if bit9 else 0x01)
        if rng.low_power_above is not None and freq > rng.low_power_above:
            tag &= ~VHF_POWER_BIT & 0xFF        # RSS: Low power only up there
        out[a - 1] = tag

    def _write_mode_vhf(self, out: bytearray, m: Mode) -> None:
        if self.band == "uhf":
            for foff, freq in ((VHF_RX_OFF, m.rx_mhz), (VHF_TX_OFF, m.tx_mhz), (VHF_TA_OFF, m.ta_mhz)):
                self._write_field_uhf(out, m, foff, freq)
        else:
            self._write_field_vhf_rx(out, m, m.rx_mhz)
            self._write_field_vhf(out, m, VHF_TX_OFF, m.tx_mhz, VHF_TX_COEF, True)
            self._write_field_vhf(out, m, VHF_TA_OFF, m.ta_mhz, VHF_TA_COEF, True)
        # option flags (strings -> desired bit state; polarity per notes/FORMAT.md)
        def on(v, yes):
            return None if v is None else (v.strip().lower() == yes)
        self._write_flag_vhf(out, m, VHF_FLAGS3_OFF, VHF_UPXTAL_BIT, on(m.up_xtal_shift, "disabled"))
        self._write_flag_vhf(out, m, VHF_FLAGS4_OFF, VHF_MDC_PTT_BIT, on(m.mdc_ptt_id, "enabled"))
        self._write_flag_vhf(out, m, VHF_FLAGS4_OFF, VHF_PHONE_ENC_BIT, on(m.phone_encode, "enabled"))
        self._write_flag_vhf(out, m, VHF_TX_TAG_OFF, VHF_POWER_BIT, on(m.tx_power, "high"))
        self._write_flag_vhf(out, m, VHF_TA_TAG_OFF, VHF_POWER_BIT, on(m.ta_power, "high"))
        if m.mpl_type is not None:
            want = VHF_MPL_BY_NAME.get(m.mpl_type.strip().lower())
            if want is not None and (m.raw[VHF_FLAGS3_OFF] & VHF_MPL_MASK) != want:
                o = m.offset + VHF_FLAGS3_OFF
                out[o] = (out[o] & (~VHF_MPL_MASK & 0xFF)) | want
        # Squelch tone slots (Rx +17/+18, Tx +19/+20): CTCSS ("PL"), DPL/INV.DPL
        # codes, or Carrier. Each slot is written only when its decoded value
        # changed, so an unedited mode stays byte-identical. (The T·A slot +21/+22
        # is preserved via the raw copy -- it is not exposed as a field.)
        self._write_squelch_vhf(out, m, VHF_PL_RX_OFF, m.rx_pl, m.rx_squelch_type, False)
        self._write_squelch_vhf(out, m, VHF_PL_TX_OFF, m.tx_pl, m.tx_squelch_type, True)
        if m.ta_squelch_type is not None:
            self._write_slot(out, m, VHF_PL_TA_OFF, m.ta_pl, m.ta_squelch_type, True, True)

    @staticmethod
    def _slot_decoded(hi: int, lo: int, is_tx: bool):
        """-> (squelch_type, code) for a VHF tone slot. type is
        Carrier/PL/DPL/INV.DPL/None; code is a tone string, a 'D###' DPL code,
        or None (Carrier)."""
        t = vhf_squelch_type(hi, lo, is_tx)
        if t == "PL":
            return t, vhf_pl_decode(hi, lo, is_tx)
        if t in ("DPL", "INV.DPL"):
            return t, vhf_dpl_decode(hi, lo, is_tx)[1]
        return t, None

    def _write_squelch_vhf(self, out: bytearray, m: Mode, off: int,
                           want_code: Optional[str], want_type: Optional[str],
                           is_tx: bool) -> None:
        self._write_slot(out, m, off, want_code, want_type, is_tx, is_tx)

    def _write_slot(self, out: bytearray, m: Mode, off: int,
                    want_code: Optional[str], want_type: Optional[str],
                    pl_tx: bool, dpl_tx: bool) -> None:
        """Write a tone slot (PL / DPL / INV.DPL / Carrier) at view offset `off`
        when its decoded value changed; otherwise leave the original bytes
        (byte-exact). Gating is on the DECODED value, so an unchanged tone is
        preserved even if the encode formula rounded differently than the stored
        bytes. pl_tx: Tx tone formula (period); dpl_tx: DPL polarity sense."""
        a = m.offset + off
        if a + 1 >= len(self.body):
            return
        orig_type, orig_code = slot_decode(self.body[a], self.body[a + 1], pl_tx, dpl_tx)

        code = (want_code or "").strip()
        wt = (want_type or "").strip()
        if orig_type is None and want_type is None and not code:
            return   # a slot that isn't a tone (it decodes to no type) and wasn't edited: keep it
        if code[:1] == "D" and code[1:] in DPL_PAIR_BY_CODE:      # DPL code
            if wt in ("DPL", "INV.DPL"):
                des_type = wt                         # explicit polarity
            elif orig_type in ("DPL", "INV.DPL"):
                des_type = orig_type                  # keep original polarity
            else:
                des_type = "DPL"                      # new DPL defaults to normal
            des_code = code
        elif code and _is_number(code):                          # PL (CTCSS) tone
            des_type, des_code = "PL", code
        elif not code and wt in ("", "Carrier"):                 # Carrier (no tone)
            des_type, des_code = "Carrier", None
        else:
            return   # unrecognized code (or a tone type with no code) -> untouched

        if (des_type, des_code) == (orig_type, orig_code):
            return   # unchanged: preserve the original bytes
        enc = slot_encode(des_type, des_code, pl_tx, dpl_tx)
        if enc is None:
            return
        out[a], out[a + 1] = enc

    def _write_mode_900(self, out: bytearray, m: Mode) -> None:
        base = m.offset
        rec = bytearray(out[base : base + MODE_REC_LEN])
        # Compare against the display-logic decode so an unmodified mode (incl.
        # simplex, where TX lives in the off21-23 field) re-encodes byte-identically.
        cur_rx, cur_tx, cur_ta = decode_900_fields(m.raw)

        if m.rx_mhz is not None and m.rx_mhz != cur_rx:
            lo, mid = m900_rx_encode(m.rx_mhz)
            rec[M900_RX_LO], rec[M900_RX_MID] = lo, mid

        if (m.tx_mhz, m.ta_mhz) != (cur_tx, cur_ta):
            # the simplex layout (TX in the off21-23 field) only for a mode that
            # already has it, or whose T/A is being cleared: a split mode with
            # no T/A (617ASN mode 1: 935.9 / 896.9) keeps its TX in off17-19
            tx_in_ta = not (m.raw[17] in VALID_CARRY_900 and (m.raw[18] or m.raw[19]))
            if m.ta_mhz is None and m.tx_mhz is not None and (tx_in_ta or cur_ta is not None):
                # simplex: TX goes in the off21-23 field; clear the repeater input
                lo, mid, carry = m900_freq_encode(m.tx_mhz, m.raw[M900_TA[0]])
                c, l, md = M900_TA
                rec[l], rec[md], rec[c] = lo, mid, carry
                rec[M900_TX[1]] = rec[M900_TX[2]] = 0
            else:
                for field, freq in ((M900_TX, m.tx_mhz), (M900_TA, m.ta_mhz)):
                    if freq is None:
                        continue
                    carry, lo, mid = field
                    b_lo, b_mid, b_carry = m900_freq_encode(freq, m.raw[carry])
                    rec[lo], rec[mid], rec[carry] = b_lo, b_mid, b_carry

        extra_writes = []
        # per-mode option flags (bit-surgical; preserve freq-carry bits in the
        # shared power bytes). Only flip a bit that actually changed.
        def on(v, yes):
            return None if v is None else (v.strip().lower() == yes)

        def flagbit(off, bit, want_set):
            if want_set is None or bool(m.raw[off] & bit) == want_set:
                return
            if want_set:
                rec[off] |= bit
            else:
                rec[off] &= (~bit & 0xFF)

        flagbit(M900_FLAGS11_OFF, M900_UPXTAL_BIT, on(m.up_xtal_shift, "disabled"))
        flagbit(M900_FLAGS12_OFF, M900_COMPANDER_BIT, on(m.audio_compander, "enabled"))
        flagbit(M900_FLAGS12_OFF, M900_SPLATTER_BIT, on(m.adaptive_splatter, "enabled"))
        flagbit(M900_FLAGS12_OFF, M900_MDC_PTT_BIT, on(m.mdc_ptt_id, "enabled"))
        flagbit(M900_FLAGS12_OFF, M900_PHONE_ENC_BIT, on(m.phone_encode, "enabled"))
        flagbit(M900_FLAGS11_OFF, M900_REVBURST_BIT, on(m.reverse_burst_toc, "enabled"))
        flagbit(M900_TXPWR_OFF, M900_PWR_BIT, on(m.tx_power, "high"))
        flagbit(M900_TAPWR_OFF, M900_PWR_BIT, on(m.ta_power, "high"))

        # masked multi-value enums in rec+11 (preserve the other bits of the byte)
        def masked(off, mask, want):
            if want is not None and (m.raw[off] & mask) != want:
                rec[off] = (rec[off] & (~mask & 0xFF)) | want
        if m.unmute_mute_type is not None:
            masked(M900_FLAGS11_OFF, M900_UNMUTE_MASK,
                   M900_UNMUTE_BY_NAME.get(m.unmute_mute_type.strip().lower()))
        if m.mpl_type is not None:
            masked(M900_FLAGS11_OFF, M900_MPL_MASK,
                   VHF_MPL_BY_NAME.get(m.mpl_type.strip().lower()))
        out[base : base + MODE_REC_LEN] = rec
        for off, val in extra_writes:
            if off < len(out):
                out[off] = val
        # tone slots (Rx / Tx / T·A at view +25/+27/+29, partly past the 26-byte
        # view): written into `out` after the record write-back; the next mode's
        # copy starts from `out`, so it keeps them. No slots on a trunked mode 1.
        if any(getattr(m, f"{k}_squelch_type") is not None for k in M900_SLOTS):
            for k, so in M900_SLOTS.items():
                self._write_slot(out, m, so, getattr(m, f"{k}_pl"),
                                 getattr(m, f"{k}_squelch_type"), k != "rx", True)

    def _orig_900_code(self, base: int):
        """The squelch code string originally stored at a 900 mode (from the
        pristine body): a DPL code 'D###', a PL tone, or None."""
        b25 = self.body[base + RX_PL_OFF]
        if b25 >= M900_DPL_MIN:
            b26 = self.body[base + M900_DPL_OFF2] if base + M900_DPL_OFF2 < len(self.body) else 0
            return dpl_code_900(b25, b26)
        if b25:
            return PL_CODE_BY_BYTE.get(b25)
        return None
