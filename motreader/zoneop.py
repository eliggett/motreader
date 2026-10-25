"""RADIO-WIDE ZONE OPERATION switch: re-pack the codeplug the way RSS does.

Zone Operation (control-head block +0x13 bit 4) is not a plain flag: RSS
re-packs the body when it changes (FORMAT §5g). Captured from RSS saves of
every on-hand radio (notes/ground-truth/zoneop_rss/) and reproduced byte-exact:

zones on -> off
  * the zone tables (names, scan/flag records, membership) are deleted; they
    sit right before the radio-wide ext block;
  * on models with per-mode scan lists (the 900 MHz radios) every mode record
    grows by E zero bytes appended after its checksum; header 0x10A = record
    length. E = 2 + ceil(user modes / 8), or 2 + min(ext[0x11], 16) on trunked
    codeplugs (RSS SPECTRA4.OVL: X[0x3AA] = X[0x172] + 2, X[0x172] = ext+0x11);
  * every pointer behind the change moves: header words 0xDD/0xE5/0xE7/0xED,
    ext +0x20/+0x22, the mode pointer table (and its 8-bit sum right after);
    ext +0x54..+0x59 (zone table pointers) and +0x5B (zone count) := 0;
  * CHB+0x13 b4 cleared (W + CHB checksum follow), home zone 0x1DD := 0, ext
    checksum, header 0xC9 (+1 per 32 bytes of growth), FF padding re-trimmed
    so the body length stays k*0x100 + 0xAD.

zones off -> on
  * one zone "ZONE  01" holding every mode is created (RSS refuses to pack
    until every mode is in a zone and the home mode in the home zone), the
    per-mode scan lists are dropped again, and everything above is reversed.

Supported: standard-head, conventional (non-trunked) codeplugs with up to 120
user modes. Refused: the A9 head (zone names live in its ASCII string pool,
with pointers into it), trunked codeplugs, and more than 120 user modes (RSS
then also rewrites scan-list bitmaps after the mode records: ext+0x1E switches
0x10 <-> 0x8F and the sections at ext+0x20/+0x22 change size and content).
"""

from __future__ import annotations

from .codeplug import Codeplug, mode_pointer_table, pack_membership, pack_name
from . import radiowide as RW

HDR_PTRS = (0xDD, 0xE5, 0xE7, 0xED)
EXT_TAIL_PTRS = (0x20, 0x22)          # ext pointers to sections after the records
EXT_ZONE_MEMB, EXT_ZONE_FLAGS, EXT_ZONE_NAMES, EXT_ZONE_COUNT = 0x54, 0x56, 0x58, 0x5B
ZONE_OP = (0x13, 0x10)                # CHB offset, bit


def _be(b, o):
    return b[o] << 8 | b[o + 1]


def _put(b, o, v):
    b[o:o + 2] = (v & 0xFFFF).to_bytes(2, "big")


class _Layout:
    def __init__(self, body: bytes):
        pt = mode_pointer_table(body)
        if pt is None:
            raise ValueError("mode pointer table not found: can't re-pack this codeplug")
        self.base, self.tab, self.starts = pt
        self.ext = RW.find_ext_block(body)
        self.n = body[0x109]
        self.L = body[0x10A]
        self.trunked = len(self.starts) > 1 and self.starts[1] - self.starts[0] != self.L

    def regular(self):
        """Record starts of the regular (length L) records, in address order."""
        rs = sorted(self.starts)
        return [p for i, p in enumerate(rs)
                if (rs[i + 1] if i + 1 < len(rs) else p + self.L) - p == self.L]


def _check(cp: Codeplug, lay: _Layout):
    if cp.ascii_names is not None:
        raise ValueError("Zone Operation can't be changed on the A9 head yet (its zone "
                         "names live in the head's string pool); use RSS")
    if lay.trunked:
        raise ValueError("Zone Operation can't be changed on a trunked codeplug "
                         "(trunking data is not handled); use RSS")
    if RW.find_chb_block(cp.body) is None or lay.ext is None:
        raise ValueError("radio-wide blocks not found: can't re-pack this codeplug")
    if -(-lay.n // 8) > 15:
        raise ValueError(f"Zone Operation can't be changed with {lay.n} user modes yet "
                         "(above 120 modes RSS also rewrites scan-list sections after the "
                         "mode records, not decoded); use RSS")


def scan_list_len(body: bytes, lay: _Layout) -> int:
    """Per-mode scan-list bytes (E) RSS appends with zones off on this model."""
    if lay.trunked:
        return 2 + min(body[lay.ext + 0x11], 16)
    return 2 + -(-lay.n // 8)


def _finish(new: bytearray, old_len: int) -> bytes:
    """Ext/CHB checksums are set by the callers; here: FF padding to
    k*0x100 + 0xAD and header 0xC9 (body size / 32)."""
    end = len(new)
    while end and new[end - 1] == 0xFF:
        end -= 1
    tot = end + ((0xAD - end) % 0x100)
    out = new[:end] + b"\xff" * (tot - end)
    out[0xC9] = (out[0xC9] + (len(out) - old_len) // 32) & 0xFF
    return bytes(out)


def _ext_and_chb(new: bytearray, lay_ext_new: int, zone_on: bool, home_zone: int):
    e = lay_ext_new
    L = new[e]
    new[e + L - 1] = sum(new[e:e + L - 1]) & 0xFF
    blk = RW._blocks(bytes(new))
    c = blk["chb"]
    if zone_on:
        new[c + ZONE_OP[0]] |= ZONE_OP[1]
    else:
        new[c + ZONE_OP[0]] &= ~ZONE_OP[1] & 0xFF
    RW._finish(new, blk, {"chb"})
    new[0x1DD] = home_zone


def zones_off(body: bytes, has_scan_lists: bool | None = None) -> bytes:
    """Zone Operation Enabled -> Disabled (all zones are lost, as in RSS).
    has_scan_lists: does this model keep a per-mode scan list with zones off?
    Default: the 900 MHz models do (566AYA/617ASN/604AUN/604ATY); the VHF ones
    seen don't (617ASQ, 221AZN)."""
    cp = Codeplug.parse(body)
    lay = _Layout(body)
    _check(cp, lay)
    if not cp.zone_operation:
        return body
    if has_scan_lists is None:
        has_scan_lists = cp.band == "900"
    e = lay.ext
    zstart = min(_be(body, e + k) - lay.base for k in (EXT_ZONE_MEMB, EXT_ZONE_FLAGS, EXT_ZONE_NAMES))
    D = e - zstart
    E = scan_list_len(body, lay) if has_scan_lists else 0
    ins = [p + lay.L for p in lay.regular()] if E else []

    def moved(p):
        if p < zstart:
            return p
        return p - D + E * sum(1 for q in ins if q <= p)

    out = bytearray(body[:zstart]) + body[e:]
    new = bytearray()
    prev = 0
    for q in ins:
        new += out[prev:q - D] + bytes(E)
        prev = q - D
    new += out[prev:]
    for o in HDR_PTRS:
        _put(new, o, moved(_be(body, o) - lay.base) + lay.base)
    tab = moved(lay.tab)
    for i, p in enumerate(lay.starts):
        _put(new, tab + 2 * i, moved(p) + lay.base)
    new[tab + 2 * lay.n] = sum(new[tab:tab + 2 * lay.n]) & 0xFF
    ne = moved(e)
    for k in EXT_TAIL_PTRS:
        w = _be(body, e + k) - lay.base
        if e <= w <= len(body):
            _put(new, ne + k, moved(w) + lay.base)
    new[ne + EXT_ZONE_MEMB:ne + EXT_ZONE_NAMES + 2] = bytes(6)
    new[ne + EXT_ZONE_COUNT] = 0
    new[0x10A] = lay.L + E
    _ext_and_chb(new, ne, False, 0)
    return _finish(new, len(body))


def zones_on(body: bytes, scan_list_bytes: int | None = None, flag_byte: int = 0xA0) -> bytes:
    """Zone Operation Disabled -> Enabled: one zone "ZONE  01" with every mode,
    home zone 1 (what RSS requires before it will pack). scan_list_bytes = the
    per-mode scan list to drop from each record (default: what this model
    appends, i.e. scan_list_len, if the records carry one)."""
    cp = Codeplug.parse(body)
    lay = _Layout(body)
    _check(cp, lay)
    if cp.zone_operation:
        return body
    n, e = lay.n, lay.ext
    if scan_list_bytes is None:
        scan_list_bytes = scan_list_len(body, lay) if cp.band == "900" else 0
    E = scan_list_bytes
    W = -(-n // 8)
    names = pack_name("ZONE  01")
    flags_len = 2 + (W + 3)
    flags = flags_len.to_bytes(2, "big") + bytes([flag_byte]) + bytes(W + 2)
    memb_len = 2 + W + 1
    memb = memb_len.to_bytes(2, "big") + pack_membership(range(1, n + 1), W)
    memb += bytes([sum(memb) & 0xFF])
    zones = names + flags + memb
    T = len(zones)
    cut = [p + lay.L - E for p in lay.regular()] if E else []

    def moved(p):
        if p < e:
            return p
        return p + T - E * sum(1 for q in cut if q < p)

    out = bytearray(body[:e]) + zones + body[e:]
    new = bytearray()
    prev = 0
    for q in cut:
        new += out[prev:q + T]
        prev = q + T + E
    new += out[prev:]
    for o in HDR_PTRS:
        _put(new, o, moved(_be(body, o) - lay.base) + lay.base)
    tab = moved(lay.tab)
    for i, p in enumerate(lay.starts):
        _put(new, tab + 2 * i, moved(p) + lay.base)
    new[tab + 2 * n] = sum(new[tab:tab + 2 * n]) & 0xFF
    ne = moved(e)
    for k in EXT_TAIL_PTRS:
        w = _be(body, e + k) - lay.base
        if e <= w <= len(body):
            _put(new, ne + k, moved(w) + lay.base)
    zn = e
    _put(new, ne + EXT_ZONE_NAMES, zn + lay.base)
    _put(new, ne + EXT_ZONE_FLAGS, zn + len(names) + lay.base)
    _put(new, ne + EXT_ZONE_MEMB, zn + len(names) + len(flags) + lay.base)
    new[ne + EXT_ZONE_COUNT] = 1
    new[0x10A] = lay.L - E
    _ext_and_chb(new, ne, True, 1)
    return _finish(new, len(body))
