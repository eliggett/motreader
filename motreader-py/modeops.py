"""Add / delete modes (channels) the way RSS's MODE UTILITY does.

Reproduced from RSS saves of ADD / DELETE MODE on 617ASN (900, zones on),
617ASQ (VHF, zones off) and 604AUN (900, zones off with per-mode scan lists),
byte-exact (notes/ground-truth/modeops_rss/, FORMAT §5j). RSS keeps everything
in mode order, so a mode inserted after N becomes N+1 and later modes renumber:

  * mode name table (6-bit, 6 bytes/mode at 0x266): insert / remove a name;
  * mode-list section (header 0xE7): index list 1..n, per-mode type bytes, 2n
    zeros, 8-bit sum (just before the pointer table);
  * mode pointer table (header 0xED, n entries + 8-bit sum);
  * the mode record itself, at its position (a copy of another mode here);
  * zones: membership bitmaps (LSB-first) and zone scan lists (MSB-first)
    renumbered; the new mode joins the given zones; priority-mode bytes
    renumbered; membership width W = ceil(n/8) (ext+0x1E) can grow / shrink,
    and with it the zone sections and the bitmaps after the mode records
    (ext +0x20 / +0x22);
  * zones off (convscan.py): every scan list -- Mode Slave lists after each
    record (2 + W bytes: they grow / shrink with W) and the radio-wide lists at
    ext +0x20 / +0x22 (bitmap, or mode numbers above 120 modes) -- renumbered,
    priority bytes too (<SELMOD> 0xFF kept, a deleted mode -> 0); the new mode's
    own list starts empty;
  * counts (0x109, 0x110, ext +7 / +8, ext+0x86), header mode numbers (home
    mode 0x10F, 0x1B6, 0x1C1), every section pointer behind the change, ext /
    membership / pointer-table / mode-list sums, 0xC9, FF padding.

Deliberate differences (RSS bugs): after a delete RSS leaves a stale
membership bit for the old last mode, motreader clears it (else the next added
mode would join that zone); zones off, RSS's ADD leaves the list member
numbered after+1 unrenumbered (the new mode inherits its place, the old one
drops out) and on 900 MHz Mode Slave lists its DELETE shifts later members by
two; motreader renumbers them all correctly (tests/test_convscan.py).
A9 / S9000e head (221AZN): the same re-pack of the radio data, with the head
block (11-char ASCII mode names in a fixed slot array, button maps, its
checksum) moved whole to the next page boundary after the radio data and the
names shifted within their slots (_change_a9).

Refused (clear message): trunked codeplugs, more than 120 modes
when W would change, zones-on radio-wide bitmaps in use when W changes, the
model's mode limit, a zones-on add without a zone, deleting a zone's last
mode, and deleting the home mode.
"""

from __future__ import annotations

from .codeplug import (Codeplug, mode_pointer_table, zone_sections, pack_name,
                       NAME_TABLE_OFF)
from . import radiowide as RW

# ext words pointing at sections; +0x47 / +0x49 = the MPL code / name tables
# (0 with MPL off), which sit after the 6-bit mode names on standard heads
EXT_PTRS = (0x18, 0x1A, 0x1C, 0x20, 0x22, 0x25, 0x27, 0x29, 0x2B, 0x2D, 0x41,
            0x47, 0x49, 0x50, 0x54, 0x56, 0x58)
HDR_PTRS = (0xDD, 0xE5, 0xE7, 0xED)
MODE_REFS = (0x10F, 0x1B6, 0x1C1)   # header bytes holding a mode number
MAX_MODES = 0x1D5                   # model limit (radio address 0x6128)
EXT_CONV_COUNT = 0x86


def _be(b, o):
    return b[o] << 8 | b[o + 1]


def _put(b, o, v):
    b[o:o + 2] = (v & 0xFFFF).to_bytes(2, "big")


def _renum_lsb(bm: bytes, w: int, ins=None, dele=None) -> bytes:
    """Mode bitmap (bit m-1 = mode m, LSB first) renumbered for a mode
    inserted after `ins` (its bit clear) or mode `dele` removed; w bytes."""
    modes = [i + 1 for i in range(len(bm) * 8) if bm[i // 8] >> (i % 8) & 1]
    if ins is not None:
        modes = [m + 1 if m > ins else m for m in modes]
    if dele is not None:
        modes = [m - 1 if m > dele else m for m in modes if m != dele]
    out = bytearray(w)
    for m in modes:
        if m - 1 < w * 8:
            out[(m - 1) // 8] |= 1 << ((m - 1) % 8)
    return bytes(out)


def _rev(x: bytes) -> bytes:
    return bytes(int(f"{c:08b}"[::-1], 2) for c in x)


def _renum_msb(bm: bytes, w: int, ins=None, dele=None) -> bytes:
    return _rev(_renum_lsb(_rev(bm), w, ins, dele))


def default_name(number: int, a9: bool = False) -> str:
    if a9:
        return f"  MODE{number:>5}"     # RSS on the A9 head: "  MODE   66"
    return f"MODE{number:>4}"           # RSS: "MODE   2", "MODE  54"


def _change(body: bytes, after=None, delete=None, record=None, name="", zones=()) -> bytes:
    cp = Codeplug.parse(body)
    if cp.ascii_names is None:
        return _repack(body, cp, after, delete, record, name, zones)
    return _change_a9(body, cp, after, delete, record, name, zones)


def _change_a9(body, cp, after, delete, record, name, zones) -> bytes:
    """A9 head: the radio data (FF-padded to a page) is followed by the head
    block, which holds the 11-char ASCII mode names in a fixed slot array.
    RSS re-packs the radio data, moves the head block whole to the next page
    boundary after it, and shifts the names inside their slots."""
    from .lists import a9_head_checksum_off
    ck = a9_head_checksum_off(cp)
    if ck is None or (ck - 2 - 0xAD) % 0x100:
        raise ValueError("A9 control-head block not found where expected; use RSS")
    h = ck - 2
    start, w = cp.ascii_names
    n = body[0x109]
    if not h <= start or start + (n + 1) * w > len(body):
        raise ValueError("A9 mode-name slots not where expected; use RSS")
    radio = _repack(body[:h], cp, after, delete, record, name, zones, six_bit_names=False)
    head = bytearray(body[h:])
    rel = start - h
    slots = [bytes(head[rel + i * w:rel + (i + 1) * w]) for i in range(n + 1)]
    if after is not None:
        # later names move up a slot; the old slot n+1 content is overwritten
        new = slots[:after] + [name.encode("latin-1")[:w].ljust(w, b" ")] + slots[after:n]
    else:
        # later names move down; the old last slot keeps its (now spare) name
        new = slots[:delete - 1] + slots[delete:n] + [slots[n - 1]]
    head[rel:rel + len(new) * w] = b"".join(new)
    # head checksum (big-endian words at odd addresses): carry the delta; the
    # block moves by whole pages, so its byte lanes don't change
    delta = sum((head[i] - body[h + i]) << (8 if (h + i) & 1 else 0)
                for i in range(len(head)) if head[i] != body[h + i])
    v = (int.from_bytes(head[2:4], "big") + delta) & 0xFFFF
    head[2:4] = v.to_bytes(2, "big")
    out = bytearray(radio + head)
    out[0xC9] = (body[0xC9] + (len(out) - len(body)) // 32) & 0xFF
    return bytes(out)


def _repack(body, cp, after, delete, record, name, zones, six_bit_names=True) -> bytes:
    from .trunking import trunking_info
    if trunking_info(body) is not None:
        raise ValueError("trunked codeplug: remove trunking first (remove-trunking)")
    pt = mode_pointer_table(body)
    e = RW.find_ext_block(body)
    chb = RW.find_chb_block(body)
    if pt is None or e is None or chb is None:
        raise ValueError("codeplug layout not recognized; use RSS")
    base, tab, starts = pt
    n, L = body[0x109], body[0x10A]
    ins = after is not None
    n2 = n + 1 if ins else n - 1
    if ins and not 0 <= after <= n:
        raise ValueError(f"insert position after mode {after} out of range (0..{n})")
    if not ins and not 1 <= delete <= n:
        raise ValueError(f"no mode {delete} (1..{n})")
    if ins and n2 > (body[MAX_MODES] or 128):
        raise ValueError(f"the radio holds at most {body[MAX_MODES] or 128} modes")
    if n2 < 1:
        raise ValueError("can't delete the last mode")
    if not ins and body[0x10F] == delete:
        raise ValueError(f"mode {delete} is the home mode: change the home mode first")
    zoned = bool(body[chb + 0x13] & 0x10)
    edits = []          # (offset, old length, new bytes, a pointer AT offset moves too)

    if six_bit_names:
        edits.append((NAME_TABLE_OFF + 6 * after, 0, pack_name(name)[:6], after > 0) if ins
                     else (NAME_TABLE_OFF + 6 * (delete - 1), 6, b"", False))

    def rp(p):                          # a priority byte (mode number) renumbered
        if p in (0, 0xFF):              # none / <SELMOD> (the selected mode)
            return p
        if ins:
            return p + 1 if p > after else p
        return 0 if p == delete else (p - 1 if p > delete else p)

    sh = dict(ins=after) if ins else dict(dele=delete)
    w_old, w_new = body[e + 0x1E] & 0x7F, -(-n2 // 8)
    numlist = bool(body[e + 0x1E] & 0x80)
    if w_new != w_old and (numlist or w_new > 15):
        raise ValueError("above 120 modes RSS encodes the scan width specially; "
                         "not handled yet")
    if numlist:
        w_new = w_old

    def renum_list(old: bytes) -> bytes:
        """[Pri 1][Pri 2][members] (bitmap MSB-first, or mode numbers)."""
        if numlist:
            ms = [m for m in old[2:] if m]
            ms = [m + 1 if ins and m > after else m for m in ms] if ins else \
                [m - 1 if m > delete else m for m in ms if m != delete]
            return bytes([rp(old[0]), rp(old[1])]) + bytes(ms) + bytes(w_old - len(ms))
        return bytes([rp(old[0]), rp(old[1])]) + _renum_msb(old[2:], w_new, **sh)

    # zones off: Mode Slave lists after each record's checksum and the
    # radio-wide (Op Select / mirror) lists at ext +0x20 / +0x22, renumbered
    # like RSS's ADD / DELETE MODE (617ASQ, 604AUN; convscan.py)
    dE = 0
    lay = None
    if not zoned:
        from . import convscan
        lay = convscan.layout(body, strict=True)
    if lay is not None and lay.per_mode:
        E = 2 + w_old
        dE = w_new - w_old
        for i, t in enumerate(starts):
            if not ins and i == delete - 1:
                continue
            edits.append((t + lay.tail, E, renum_list(body[t + lay.tail:t + L]), False))
    if ins:
        record = bytes(record[:L])
        if lay is not None and lay.per_mode:
            record = record[:lay.tail] + bytes(2 + w_new)   # a fresh mode scans nothing
    for k in (0x20, 0x22):
        t = _be(body, e + k) - base
        if not 2 <= t < len(body):
            continue
        if lay is not None:
            edits.append((t - 2, 2 + w_old, renum_list(body[t - 2:t + w_old]), False))
        elif w_new != w_old:
            if any(body[t:t + w_old]):
                raise ValueError("radio-wide scan bitmaps are in use; renumbering "
                                 "them isn't handled yet (use RSS)")
            edits.append((t + w_old, 0, bytes(w_new - w_old), False) if w_new > w_old
                         else (t + w_new, w_old - w_new, b"", False))
    # zone sections
    zs = zone_sections(body) if zoned else None
    memb_at = None
    if zoned:
        if zs is None:
            raise ValueError("zone tables not found; use RSS")
        if ins and not zones:
            raise ValueError("Zone Operation is on: the new mode must go in a zone "
                             "(RSS won't save a mode outside every zone)")
        w, nz = zs["w"], zs["count"]
        for z in zones:
            if not 1 <= z <= nz:
                raise ValueError(f"no zone {z} (1..{nz})")
        if not ins:
            for z in cp.zones:
                if z.modes == [delete]:
                    raise ValueError(f"mode {delete} is the only mode in zone {z.number} "
                                     f"({z.name!r}); RSS would drop the zone")
        fl = bytearray()
        for k in range(nz):
            r = body[zs["flags"] + 2 + k * (w + 3): zs["flags"] + 2 + (k + 1) * (w + 3)]
            fl += bytes([r[0], rp(r[1]), rp(r[2])]) + _renum_msb(r[3:], w_new, **sh)
        flags = (2 + len(fl)).to_bytes(2, "big") + bytes(fl)
        mb = bytearray()
        for k in range(nz):
            bm = bytearray(_renum_lsb(body[zs["memb"] + 2 + k * w: zs["memb"] + 2 + (k + 1) * w],
                                      w_new, **sh))
            if ins and (k + 1) in zones:
                bm[after // 8] |= 1 << (after % 8)
            mb += bm
        memb = (2 + len(mb) + 1).to_bytes(2, "big") + bytes(mb)
        memb += bytes([sum(memb) & 0xFF])
        edits.append((zs["flags"], e - zs["flags"], flags + memb, False))
        memb_at = len(flags)
    # mode-list section
    s2 = _be(body, 0xE7) - base
    types = list(body[s2 + n:s2 + 2 * n])
    if ins:
        types.insert(after, 0)
    else:
        del types[delete - 1]
    s2new = bytes(range(1, n2 + 1)) + bytes(types) + bytes(2 * n2)
    edits.append((s2, tab - s2, s2new + bytes([sum(s2new) & 0xFF]), False))
    edits.append((tab, 2 * n + 1, bytes(2 * n2 + 1), False))     # refilled below
    if ins:
        pos = starts[after] if after < n else starts[-1] + L
        edits.append((pos, 0, record, True))
    else:
        edits.append((starts[delete - 1], L, b"", False))

    def moved(p):
        return p + sum(len(nb) - ln for o, ln, nb, eq in edits
                       if o + ln <= p and (o < p or eq))

    out = bytearray(body)
    out[0x109] = n2
    out[0x10A] = L + dE
    if out[0x110] == n:
        out[0x110] = n2
    for k in (7, 8):
        if out[e + k] == n:
            out[e + k] = n2
    out[e + EXT_CONV_COUNT] = (out[e + EXT_CONV_COUNT] + (1 if ins else -1)) & 0xFF
    out[e + 0x1E] = (out[e + 0x1E] & 0x80) | w_new
    for ref in MODE_REFS:
        v = out[ref]
        if ins and v > after:
            out[ref] = v + 1
        elif not ins and v == delete:
            out[ref] = 0                             # (never the home mode: refused)
        elif not ins and v > delete:
            out[ref] = v - 1
    for o in HDR_PTRS:
        _put(out, o, moved(_be(body, o) - base) + base)
    for k in EXT_PTRS:
        t = _be(body, e + k) - base
        if 0x1E8 <= t < len(body):
            _put(out, e + k, moved(t) + base)
    if memb_at is not None:
        _put(out, e + 0x54, moved(zs["flags"]) + memb_at + base)
    out[e + out[e] - 1] = sum(out[e:e + out[e] - 1]) & 0xFF
    # same offset: replacements first, then the new record, then other inserts
    # (applied back to front, so those end up in front of the record)
    for o, ln, nb, _eq in sorted(edits, key=lambda x: (x[0], x[1] > 0, ins and x[2] is record),
                                 reverse=True):
        out[o:o + ln] = nb
    tab2 = moved(tab)
    if ins:
        olds = [moved(p) for p in starts]
        news = olds[:after] + [moved(pos) - len(record)] + olds[after:]
    else:
        news = [moved(p) for i, p in enumerate(starts) if i != delete - 1]
    for i, p in enumerate(news):
        _put(out, tab2 + 2 * i, p + base)
    out[tab2 + 2 * n2] = sum(out[tab2:tab2 + 2 * n2]) & 0xFF
    end = len(out)
    while end and out[end - 1] == 0xFF:
        end -= 1
    tot = end + ((0xAD - end) % 0x100)
    res = out[:end] + b"\xff" * (tot - end)
    res[0xC9] = (res[0xC9] + (len(res) - len(body)) // 32) & 0xFF
    return bytes(res)


def add_mode(body: bytes, after: int, copy_from: int | None = None, name: str | None = None,
             zones=()) -> bytes:
    """Insert a new mode after mode `after` (0 = before mode 1): a copy of mode
    `copy_from` (default: mode `after`, or 1), named `name` (default RSS's
    "MODE  nn"), placed in `zones` (needed when Zone Operation is on)."""
    pt = mode_pointer_table(body)
    if pt is None:
        raise ValueError("codeplug layout not recognized; use RSS")
    n, L = body[0x109], body[0x10A]
    src = copy_from or (after if after >= 1 else 1)
    if not 1 <= src <= n:
        raise ValueError(f"no mode {src} to copy (1..{n})")
    t = pt[2][src - 1]
    record = body[t:t + L]
    a9 = Codeplug.parse(body).ascii_names
    width = a9[1] if a9 else 8
    if name is not None and len(name) > width:
        raise ValueError(f"mode name {name!r} longer than {width} characters")
    return _change(body, after=after, record=record,
                   name=default_name(after + 1, a9 is not None) if name is None else name,
                   zones=tuple(zones))


def delete_mode(body: bytes, number: int) -> bytes:
    """Delete mode `number`; later modes renumber (zones, home mode follow)."""
    return _change(body, delete=number)
