"""Add / delete zones the way RSS's ZONE NAME LIST (RADIO-WIDE F7) does.

Reproduced from RSS saves of ADD ZONE / DELETE ZONE on 617ASN (900), 604AUN
(900) and 221AZN (VHF, A9 head), byte-exact (notes/ground-truth/zonelist_rss/,
FORMAT §5k). The zone tables are three contiguous sections right before the
radio-wide ext block (ext +0x58 / +0x56 / +0x54):

  * names: 6 bytes/zone, 6-bit (standard heads; the A9 head keeps its zone
    names in the head block's string area instead);
  * flags: 2-byte length, then per zone W+3 bytes: scan-options byte (RSS's new
    zone: 0xA0), 2 priority-mode bytes, W-byte zone scan list;
  * membership: 2-byte length, W bytes per zone (LSB-first), 8-bit sum.

A zone inserted at position P becomes zone P and later zones renumber; the
sections grow by 6 / W+3 / W bytes, ext +0x5B (zone count), every pointer
behind them (header, ext, mode pointer table), ext sum, 0xC9 and the FF
padding follow.

A9 head: the radio data is re-packed the same way (no 6-bit names); the head
block moves to the next page boundary after it (as for modes, see modeops),
and in the head's string area the 11-char zone name is inserted / removed at
its position, the rest of the area (later zone names, the mode-name slots)
shifts by 11 bytes into / out of the zero pad at its end, the zone-name
table's count byte changes, the mode-name table pointers move by 11, and the
head checksum is carried.

RSS behavior motreader does differently (deliberately):
  * RSS drops a zone with no modes when it packs; motreader refuses an empty zone;
  * RSS leaves the home zone number alone on ADD (so it can end up pointing at
    another zone) and resets it to 01 (and the home mode to that zone's
    first mode) when a zone at or before it is deleted; motreader renumbers the
    home zone so it keeps pointing at the same zone, and refuses to delete it.
Refused: Zone Operation off, trunked codeplugs, a delete that leaves a mode in
no zone (RSS won't pack: "mode # N is not assigned to any zone"), no room left
in the A9 string area.
"""

from __future__ import annotations

from .codeplug import Codeplug, mode_pointer_table, zone_sections, pack_name, pack_membership
from . import radiowide as RW

HDR_PTRS = (0xDD, 0xE5, 0xE7, 0xED)
EXT_PTRS = (0x18, 0x1A, 0x1C, 0x20, 0x22, 0x25, 0x27, 0x29, 0x2B, 0x2D, 0x41,
            0x47, 0x49, 0x50)          # + the zone pointers +0x54/+0x56/+0x58, set explicitly
EXT_MEMB, EXT_FLAGS, EXT_NAMES, EXT_COUNT = 0x54, 0x56, 0x58, 0x5B
HOME_ZONE = 0x1DD
NEW_ZONE_FLAG = 0xA0                   # RSS's scan-options byte for a new zone


def _be(b, o):
    return b[o] << 8 | b[o + 1]


def _put(b, o, v):
    b[o:o + 2] = (v & 0xFFFF).to_bytes(2, "big")


def default_name(number: int) -> str:
    return f"ZONE  {number:02d}"         # RSS: "ZONE  05"


def _sections(body, cp):
    from .trunking import trunking_info
    if not cp.zone_operation:
        raise ValueError("Zone Operation is off: turn it on first (radio_wide.zone_operation)")
    if trunking_info(body) is not None:
        raise ValueError("trunked codeplug: remove trunking first (remove-trunking)")
    zs = zone_sections(body)
    e = RW.find_ext_block(body)
    pt = mode_pointer_table(body)
    if zs is None or e is None or pt is None:
        raise ValueError("zone tables not found; use RSS")
    w, nz = zs["w"], zs["count"]
    first = zs["names"] if zs["names"] is not None else zs["flags"]
    if (zs["names"] is not None and zs["names"] + 6 * nz != zs["flags"]) \
            or zs["flags"] + _be(body, zs["flags"]) != zs["memb"] \
            or _be(body, zs["flags"]) != 2 + nz * (w + 3):
        raise ValueError("zone tables not laid out as expected; use RSS")
    return zs, e, pt, first


def _rebuild(body, cp, ins=None, dele=None, name="", modes=()):
    """Re-pack the radio data (body without an A9 head block) for a zone
    inserted at position `ins` or zone `dele` removed."""
    zs, e, (base, tab, starts), first = _sections(body, cp)
    w, nz = zs["w"], zs["count"]
    names = [body[zs["names"] + 6 * k: zs["names"] + 6 * k + 6] for k in range(nz)] \
        if zs["names"] is not None else None
    flags = [body[zs["flags"] + 2 + k * (w + 3): zs["flags"] + 2 + (k + 1) * (w + 3)]
             for k in range(nz)]
    memb = [body[zs["memb"] + 2 + k * w: zs["memb"] + 2 + (k + 1) * w] for k in range(nz)]
    if ins is not None:
        k = ins - 1
        if names is not None:
            names.insert(k, pack_name(name)[:6])
        flags.insert(k, bytes([NEW_ZONE_FLAG, 0, 0]) + bytes(w))
        memb.insert(k, pack_membership(sorted(modes), w))
    else:
        k = dele - 1
        for lst in (names, flags, memb):
            if lst is not None:
                del lst[k]
    nz2 = len(flags)
    fl = (2 + nz2 * (w + 3)).to_bytes(2, "big") + b"".join(flags)
    mb = (2 + nz2 * w + 1).to_bytes(2, "big") + b"".join(memb)
    mb += bytes([sum(mb) & 0xFF])
    nm = b"".join(names) if names is not None else b""
    new = nm + fl + mb
    delta = len(new) - (e - first)

    def moved(p):
        return p + delta if p >= e else p

    out = bytearray(body)
    for o in HDR_PTRS:
        _put(out, o, moved(_be(body, o) - base) + base)
    for k2 in EXT_PTRS:
        t = _be(body, e + k2) - base
        if 0x1E8 <= t < len(body):
            _put(out, e + k2, moved(t) + base)
    if names is not None:
        _put(out, e + EXT_NAMES, first + base)
    _put(out, e + EXT_FLAGS, first + len(nm) + base)
    _put(out, e + EXT_MEMB, first + len(nm) + len(fl) + base)
    out[e + EXT_COUNT] = nz2
    out[e + out[e] - 1] = sum(out[e:e + out[e] - 1]) & 0xFF
    for i, p in enumerate(starts):
        _put(out, tab + 2 * i, moved(p) + base)
    out[tab + 2 * len(starts)] = sum(out[tab:tab + 2 * len(starts)]) & 0xFF
    hz = body[HOME_ZONE]
    if ins is not None and hz >= ins:
        out[HOME_ZONE] = hz + 1
    elif dele is not None and hz > dele:
        out[HOME_ZONE] = hz - 1
    out[first:e] = new
    end = len(out)
    while end and out[end - 1] == 0xFF:
        end -= 1
    tot = end + ((0xAD - end) % 0x100)
    res = out[:end] + b"\xff" * (tot - end)
    res[0xC9] = (res[0xC9] + (len(res) - len(body)) // 32) & 0xFF
    return bytes(res)


def _a9_head(head: bytes, h: int, cp, ins=None, dele=None, name=""):
    """The A9 head block with a zone name inserted / removed (see module doc)."""
    mstart, w = cp.ascii_names
    nz = len(cp.zones)
    rel_m = mstart - h                 # mode-name table, head-relative
    rel_z = rel_m - nz * w             # zone-name table
    hb = bytearray(head)
    # descriptors: [w, 1, nz, zone-table ptr]; the mode-table pointer
    # (zone ptr + nz*w) appears in the entries after it
    desc = [i for i in range(len(hb) - 5) if hb[i] == w and hb[i + 1] == 1 and hb[i + 2] == nz
            and head.find((_be(hb, i + 3) + nz * w).to_bytes(2, "big"), i + 5, i + 0x40) > 0]
    if len(desc) != 1:
        raise ValueError("A9 zone-name table descriptor not found; use RSS")
    d = desc[0]
    zp = _be(hb, d + 3)
    mp = zp + nz * w
    # end of the string area: the zero pad after the mode-name slots
    s = rel_m
    while s + w <= len(hb) and all(0x20 <= c < 0x7F for c in hb[s:s + w]):
        s += w
    g = s
    while g < len(hb) and hb[g] == 0:
        g += 1
    if ins is not None:
        if g - s < w:
            raise ValueError("no room for another zone name in the A9 head; use RSS")
        p = rel_z + (ins - 1) * w
        hb[p:g] = name.encode("latin-1")[:w].ljust(w, b" ") + hb[p:g - w]
        dz = 1
    else:
        p = rel_z + (dele - 1) * w
        hb[p:g] = hb[p + w:g] + bytes(w)
        dz = -1
    hb[d + 2] = nz + dz
    i = head.find(mp.to_bytes(2, "big"), d + 5, d + 0x40)
    while i > 0:
        _put(hb, i, mp + dz * w)
        i = head.find(mp.to_bytes(2, "big"), i + 2, d + 0x40)
    delta = sum((hb[i] - head[i]) << (8 if (h + i) & 1 else 0)
                for i in range(len(hb)) if hb[i] != head[i])
    _put(hb, 2, (_be(hb, 2) + delta) & 0xFFFF)
    return bytes(hb)


def _change(body: bytes, ins=None, dele=None, name=None, modes=()) -> bytes:
    cp = Codeplug.parse(body)
    nz = len(cp.zones)
    a9 = cp.ascii_names is not None
    width = cp.ascii_names[1] if a9 else 8
    n = len(cp.modes)
    if ins is not None:
        if not 1 <= ins <= nz + 1:
            raise ValueError(f"zone position {ins} out of range (1..{nz + 1})")
        modes = sorted(set(modes))
        if not modes:
            raise ValueError("a new zone needs at least one mode (RSS drops empty zones)")
        if not all(1 <= m <= n for m in modes):
            raise ValueError(f"zone modes must be 1..{n}")
        name = default_name(ins) if name is None else name
        if len(name) > width:
            raise ValueError(f"zone name {name!r} longer than {width} characters")
    else:
        if not 1 <= dele <= nz:
            raise ValueError(f"no zone {dele} (1..{nz})")
        if nz == 1:
            raise ValueError("can't delete the last zone (turn Zone Operation off instead)")
        if body[HOME_ZONE] == dele:
            raise ValueError(f"zone {dele} is the home zone: change the home zone first")
        left = set().union(*[set(z.modes) for z in cp.zones if z.number != dele])
        orphans = sorted(set(cp.zones[dele - 1].modes) - left)
        if orphans:
            raise ValueError(f"modes {orphans} are only in zone {dele}: put them in another "
                             f"zone first (RSS won't pack a mode outside every zone)")
    if not a9:
        return _rebuild(body, cp, ins, dele, name or "", modes)
    from .lists import a9_head_checksum_off
    ck = a9_head_checksum_off(cp)
    if ck is None or (ck - 2 - 0xAD) % 0x100:
        raise ValueError("A9 control-head block not found where expected; use RSS")
    h = ck - 2
    radio = _rebuild(body[:h], cp, ins, dele, "", modes)
    head = _a9_head(body[h:], h, cp, ins, dele, name or "")
    out = bytearray(radio + head)
    out[0xC9] = (body[0xC9] + (len(out) - len(body)) // 32) & 0xFF
    return bytes(out)


def add_zone(body: bytes, position: int, modes, name: str | None = None) -> bytes:
    """Insert a zone at `position` (1..count+1; later zones renumber) holding
    `modes`, named `name` (default RSS's "ZONE  nn")."""
    return _change(body, ins=position, name=name, modes=modes)


def delete_zone(body: bytes, number: int) -> bytes:
    """Delete zone `number`; later zones renumber (the home zone follows)."""
    return _change(body, dele=number)
