"""Scan with Zone Operation off ("conventional" scan): the per-mode SCAN
settings, the CHANNEL / TALKGROUP SCAN LIST of each mode (RSS mode screen F6)
and the CONVENTIONAL screen's Non-Priority / Priority List type.

Mapped white-box on 617ASQ (VHF), 604ATY and zones-off 604AUN / 617ASN (900)
from RSS saves (notes/ground-truth/convscan_rss/, FORMAT §5m):

  * mode record (true start, from RSS's pointer table) +20, per mode:
      0x02 SCAN Enabled         0x01 Scan Button Control Active (clear = Override)
      0x04 Coded Squelch Scan   0x10 Talkback Scan
      0x80 Non-Priority List Op Select, 0x60 Priority List Op Select (copies of
           the CONVENTIONAL setting, the same in every record; clear = Mode Slave)
  * a list is `[Pri 1][Pri 2][members]`; priority bytes hold a mode number,
    0xFF = <SELMOD>, 0 = none; members = a W-byte bitmap MSB-first (0x80 of
    the first byte = mode 1), W = ext+0x1E & 0x7F. With ext+0x1E & 0x80 (604ATY,
    128 modes) the members are instead up to W mode numbers, zero-padded, in
    RSS's order (it appends new members and closes gaps).
  * Op Select: one radio-wide list, its members at the pointer ext+0x22 (the
    priority bytes are the two bytes before). <SELMOD> is a member.
  * Mode Slave (either list): every record grows by 2+W bytes after its
    checksum holding that mode's list; the radio-wide list then mirrors mode
    1's Mode Slave part(s). <SELMOD> is listed only with Priority List Op
    Select (its shared priority bytes are then copied into every record). With
    Non-Priority Mode Slave a mode is always on its own list ("The Selected
    Mode May Not Be Deleted From the List"; RSS adds it whenever it shows the
    list). With Non-Priority Op Select the records' bitmaps are unused.
  * 900 MHz: ext+0x20 points at a second list of the same shape (zeros on every
    sample; preserved).

The record's 8-bit sum (at +25 VHF, +26 900 / L-1 without a list) is kept
valid on edit.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Union

from .codeplug import mode_pointer_table, zone_operation
from . import radiowide as RW

SELMOD = "SELMOD"
MAX_MEMBERS = 16
SCAN_OFF = 20
FLAGS = (                          # (field, mask, set, clear) in record +20
    ("scan", 0x02, "Enabled", "Disabled"),
    ("scan_button_control", 0x01, "Active", "Override"),
    ("coded_squelch_scan", 0x04, "Enabled", "Disabled"),
    ("talkback_scan", 0x10, "Enabled", "Disabled"),
)
NONPRI_OP, PRI_OP = 0x80, 0x60
SCAN_BIT = 0x02                    # +20: the mode scans (Pri Tlkgr / Channel)
TG_OFF, TG_BIT = 2, 0x10           # 900: +2 b4 instead when SCAN TYPE is Talkgroup
LIST_TYPES = ("Op Select", "Mode Slave")
Priority = Union[int, str, None]


def _be(b, o):
    return b[o] << 8 | b[o + 1]


@dataclass
class ModeScan:
    mode: int
    scan: str = "Disabled"
    scan_button_control: str = "Active"
    coded_squelch_scan: str = "Enabled"
    talkback_scan: str = "Disabled"
    # this mode's own list (Mode Slave); None where the list is Op Select
    priority_1: Priority = None
    priority_2: Priority = None
    modes: Optional[list] = None


@dataclass
class ConvScan:
    """CONVENTIONAL SCAN TYPE + list types + the radio-wide (Op Select) list.
    scan_type is what RSS shows: Talkgroup / Pri Tlkgr (900) / Channel (VHF)
    when any mode scans, else Disabled; it follows the modes' SCAN bits."""
    scan_type: str = "Disabled"
    non_priority_list: str = "Op Select"
    priority_list: str = "Op Select"
    priority_1: Priority = None          # when priority_list is Op Select
    priority_2: Priority = None
    modes: Optional[list] = None         # when non_priority_list is Op Select

    def members(self) -> int:
        return 1 + len(self.modes or []) + sum(
            1 for p in (self.priority_1, self.priority_2) if p not in (None, SELMOD))


class _Layout:
    def __init__(self, body: bytes):
        from .codeplug import Codeplug
        self.band = "vhf" if Codeplug.parse(body).band == "vhf" else "900"
        pt = mode_pointer_table(body)
        e = RW.find_ext_block(body)
        if pt is None or e is None:
            raise ValueError("mode pointer table / ext block not found")
        self.base, self.tab, self.starts = pt
        self.e, self.n, self.L = e, body[0x109], body[0x10A]
        if len(self.starts) > 1 and any(b - a != self.L for a, b in
                                        zip(self.starts, self.starts[1:])):
            raise ValueError("trunked / irregular mode records: not handled")
        f = body[self.starts[0] + SCAN_OFF]
        self.nonpri_op = bool(f & NONPRI_OP)
        self.pri_op = f & PRI_OP == PRI_OP
        w = body[e + 0x1E]
        self.numlist, self.W = bool(w & 0x80), w & 0x7F
        self.per_mode = not (self.nonpri_op and self.pri_op)
        self.tail = self.L - 2 - self.W if self.per_mode else None
        if self.per_mode and (self.numlist or self.tail < 26):
            raise ValueError("per-mode scan lists in an unknown layout; use RSS")
        p = _be(body, e + 0x22) - self.base
        self.rw = p if 2 <= p < len(body) else None
        self.selmod = self.pri_op           # <SELMOD> is listed with Priority Op Select
        self.max = min(MAX_MEMBERS, self.n + (1 if self.selmod else 0))
        self.talkgroup = self.band == "900" and any(body[t + TG_OFF] & TG_BIT for t in self.starts)
        scanning = self.talkgroup or any(body[t + SCAN_OFF] & SCAN_BIT for t in self.starts)
        self.scan_type = ("Talkgroup" if self.talkgroup else
                          ("Channel" if self.band == "vhf" else "Pri Tlkgr") if scanning
                          else "Disabled")

    def scan_bit(self):
        return (TG_OFF, TG_BIT) if self.talkgroup else (SCAN_OFF, SCAN_BIT)

    def sum_at(self) -> int:
        return self.tail - 1 if self.per_mode else self.L - 1


def layout(body: bytes, strict: bool = False) -> Optional[_Layout]:
    """None with Zone Operation on (scan is per zone then: scanlist.py), or
    (strict=False) when the layout isn't handled; strict raises instead."""
    if zone_operation(body) is not False:
        return None
    try:
        return _Layout(body)
    except ValueError:
        if strict:
            raise
        return None


def _pri(v: int) -> Priority:
    return None if v == 0 else SELMOD if v == 0xFF else v


def _members(body, o, W, numlist):
    if numlist:
        return [m for m in body[o:o + W] if m]
    return [i * 8 + j + 1 for i in range(W) for j in range(8) if body[o + i] & (0x80 >> j)]


def decode(body: bytes):
    """(ConvScan, [ModeScan]) or (None, []) with zones on."""
    lay = layout(body)
    if lay is None:
        return None, []
    cs = ConvScan(scan_type=lay.scan_type, non_priority_list=LIST_TYPES[not lay.nonpri_op],
                  priority_list=LIST_TYPES[not lay.pri_op])
    if lay.rw is not None:
        if lay.pri_op:
            cs.priority_1, cs.priority_2 = _pri(body[lay.rw - 2]), _pri(body[lay.rw - 1])
        if lay.nonpri_op:
            cs.modes = _members(body, lay.rw, lay.W, lay.numlist)
    rows = []
    for i, t in enumerate(lay.starts):
        f = body[t + SCAN_OFF]
        m = ModeScan(mode=i + 1)
        for name, mask, on, off in FLAGS:
            setattr(m, name, on if f & mask else off)
        so, sb = lay.scan_bit()
        m.scan = "Enabled" if body[t + so] & sb else "Disabled"
        if lay.per_mode:
            o = t + lay.tail
            if not lay.pri_op:
                m.priority_1, m.priority_2 = _pri(body[o]), _pri(body[o + 1])
            if not lay.nonpri_op:
                m.modes = _members(body, o + 2, lay.W, False)
        rows.append(m)
    return cs, rows


def _pri_enc(p: Priority, lay: _Layout, what: str) -> int:
    if p is None or p == "" or p == 0:
        return 0
    if str(p).upper().strip("<>") == SELMOD:
        if not lay.selmod:
            raise ValueError(f"{what}: no <SELMOD> entry when both lists are Mode Slave")
        return 0xFF
    p = int(p)
    if not 1 <= p <= lay.n:
        raise ValueError(f"{what}: no mode {p} (1..{lay.n})")
    return p


def _check_list(p1, p2, modes, lay, what, selmod):
    if p1 and p1 == p2:
        raise ValueError(f"{what}: the same mode can't be Priority 1 and Priority 2")
    bad = [m for m in modes if not 1 <= m <= lay.n]
    if bad:
        raise ValueError(f"{what}: no mode(s) {bad} (1..{lay.n})")
    size = (1 if selmod else 0) + len(modes) + sum(1 for p in (p1, p2) if p not in (0, 0xFF))
    if size > lay.max:
        raise ValueError(f"{what}: {size} members" + (" (<SELMOD> included)" if selmod else "")
                         + f", RSS allows {lay.max}")


def _bitmap(modes, W):
    bm = bytearray(W)
    for m in modes:
        bm[(m - 1) // 8] |= 0x80 >> ((m - 1) % 8)
    return bytes(bm)


def _numlist(old: list, modes, W):
    keep = [m for m in old if m in modes]
    lst = keep + sorted(set(modes) - set(keep))
    return bytes(lst) + bytes(W - len(lst))


def encode(body: bytes, conv: Optional[ConvScan] = None, modes=()) -> bytes:
    """Apply the radio-wide list (conv; list types must match the codeplug, use
    set_list_types to change them) and per-mode ModeScan rows. Change-gated:
    unchanged values leave their bytes alone."""
    lay = layout(body, strict=True)
    if lay is None:
        raise ValueError("Zone Operation is on: scan lists are per zone (zones[].scan)")
    cur_conv, cur_rows = decode(body)
    out = bytearray(body)
    touched = set()
    if conv is not None:
        for k in ("scan_type", "non_priority_list", "priority_list"):
            if str(getattr(conv, k)).lower() != getattr(cur_conv, k).lower():
                raise ValueError(f"conventional_scan.{k}: changing it re-packs the codeplug; "
                                 f"use set_list_types / set_scan_type (motreader import does)")
        new_pri = (conv.priority_1, conv.priority_2) != (cur_conv.priority_1, cur_conv.priority_2)
        new_mem = conv.modes is not None and cur_conv.modes is not None \
            and sorted(int(m) for m in conv.modes) != sorted(cur_conv.modes)
        if (new_pri or new_mem) and lay.rw is None:
            raise ValueError("conventional_scan: this list layout is not handled; use RSS")
        p1 = _pri_enc(conv.priority_1, lay, "conventional_scan.priority_1") if lay.pri_op else 0
        p2 = _pri_enc(conv.priority_2, lay, "conventional_scan.priority_2") if lay.pri_op else 0
        mem = sorted({int(m) for m in (conv.modes or [])} - {p1, p2}) if lay.nonpri_op else []
        if new_pri or new_mem:
            _check_list(p1, p2, mem, lay, "conventional_scan", True)
        if new_pri:
            out[lay.rw - 2], out[lay.rw - 1] = p1, p2
            if lay.per_mode:                # shared priorities copied into every record
                for t in lay.starts:
                    out[t + lay.tail], out[t + lay.tail + 1] = p1, p2
                    touched.add(t)
        if new_mem:
            out[lay.rw:lay.rw + lay.W] = (
                _numlist(list(body[lay.rw:lay.rw + lay.W]), mem, lay.W) if lay.numlist
                else _bitmap(mem, lay.W))
    by_mode = {r.mode: r for r in cur_rows}
    for r in modes:
        cur = by_mode.get(r.mode)
        if cur is None:
            raise ValueError(f"no mode {r.mode}")
        t = lay.starts[r.mode - 1]
        so, sb = lay.scan_bit()
        for name, mask, on, off in FLAGS:
            v = getattr(r, name)
            if v is None or str(v).lower() == getattr(cur, name).lower():
                continue
            if str(v).lower() not in (on.lower(), off.lower()):
                raise ValueError(f"mode {r.mode} {name}: {v!r} is not {on} / {off}")
            o, bit = (t + so, sb) if name == "scan" else (t + SCAN_OFF, mask)
            out[o] = out[o] | bit if str(v).lower() == on.lower() else out[o] & ~bit & 0xFF
            touched.add(t)
        if not lay.per_mode:
            continue
        what = f"mode {r.mode} scan list"
        o = t + lay.tail
        chg_pri = not lay.pri_op and (r.priority_1, r.priority_2) != (cur.priority_1, cur.priority_2)
        chg_mem = not lay.nonpri_op and r.modes is not None \
            and sorted(int(m) for m in r.modes) != sorted(cur.modes)
        if not (chg_pri or chg_mem):
            continue
        p1 = _pri_enc(r.priority_1, lay, what) if not lay.pri_op else out[o]
        p2 = _pri_enc(r.priority_2, lay, what) if not lay.pri_op else out[o + 1]
        if lay.nonpri_op:                   # members are the radio-wide list's
            mem = sorted(set(_members(out, lay.rw, lay.W, lay.numlist)) - {p1, p2}) \
                if lay.rw is not None else []
            _check_list(p1, p2, mem, lay, what, lay.selmod)
            out[o:o + 2] = bytes([p1, p2])
        else:
            mem = {int(m) for m in (r.modes if r.modes is not None else cur.modes or [])}
            own = set() if lay.pri_op else {p1, p2}   # shared priorities: not exclusive (RSS)
            if r.mode not in own:
                mem.add(r.mode)             # RSS: a mode is always on its own list
            mem = sorted(mem - own)
            _check_list(p1, p2, mem, lay, what, lay.selmod)
            out[o:o + 2 + lay.W] = bytes([p1, p2]) + _bitmap(mem, lay.W)
        touched.add(t)
    if lay.per_mode and lay.rw is not None and lay.starts[0] in touched:
        # the radio-wide list mirrors mode 1's Mode Slave part(s)
        o = lay.starts[0] + lay.tail
        if not lay.pri_op:
            out[lay.rw - 2:lay.rw] = out[o:o + 2]
        if not lay.nonpri_op:
            out[lay.rw:lay.rw + lay.W] = out[o + 2:o + 2 + lay.W]
    k = lay.sum_at()
    for t in touched:
        if sum(body[t:t + k]) & 0xFF == body[t + k]:
            out[t + k] = sum(out[t:t + k]) & 0xFF
    return bytes(out)


def offsets(body: bytes) -> dict:
    """{body offset: mode number} of the per-mode scan bytes, and the
    radio-wide list (mode 0), for change reports."""
    lay = layout(body)
    if lay is None:
        return {}
    out = {}
    for i, t in enumerate(lay.starts):
        out[t + SCAN_OFF] = i + 1
        if lay.per_mode:
            for j in range(2 + lay.W):
                out[t + lay.tail + j] = i + 1
    if lay.rw is not None:
        for j in range(-2, lay.W):
            out[lay.rw + j] = 0
    return out


EXT_PTRS = (0x18, 0x1A, 0x1C, 0x20, 0x22, 0x25, 0x27, 0x29, 0x2B, 0x2D, 0x41, 0x50)
HDR_PTRS = (0xDD, 0xE5, 0xE7, 0xED)


def _put(b, o, v):
    b[o:o + 2] = (v & 0xFFFF).to_bytes(2, "big")


def set_list_types(body: bytes, non_priority_list: str, priority_list: str) -> bytes:
    """CONVENTIONAL Non-Priority / Priority List Op Select <-> Mode Slave, the
    way RSS re-packs it (617ASQ, 604ATY): a Mode Slave list is stored after each
    record's checksum (records grow by 2+W; no list is kept per mode when both
    are Op Select). A list turning Mode Slave starts as a copy of the
    radio-wide list in every mode; turning Op Select it keeps mode 1's
    (the radio-wide copy). Without Priority Op Select there is no <SELMOD>, so
    a <SELMOD> priority is dropped."""
    lay = layout(body, strict=True)
    if lay is None:
        raise ValueError("Zone Operation is on: there is no CONVENTIONAL scan list type")
    want = []
    for k, v in (("non_priority_list", non_priority_list), ("priority_list", priority_list)):
        lc = [x.lower() for x in LIST_TYPES]
        if str(v).lower() not in lc:
            raise ValueError(f"conventional_scan.{k}: {v!r} is not one of {LIST_TYPES}")
        want.append(lc.index(str(v).lower()) == 0)
    nop, pop = want
    if (nop, pop) == (lay.nonpri_op, lay.pri_op):
        return body
    if lay.talkgroup and pop:
        raise ValueError("SCAN TYPE Talkgroup keeps the Priority List Mode Slave")
    per = not (nop and pop)
    if per and lay.numlist:
        raise ValueError("per-mode scan lists above 120 modes are not handled (RSS: the "
                         "codeplug outgrows the radio on 604ATY); use RSS")
    if lay.rw is None:
        raise ValueError("radio-wide scan list not found; use RSS")
    W, L, s0 = lay.W, lay.L, lay.starts[0]
    if any(b - a != L for a, b in zip(lay.starts, lay.starts[1:])):
        raise ValueError("mode records not contiguous; use RSS")
    base_len = lay.tail if lay.per_mode else L
    nL = base_len + (2 + W if per else 0)
    rwl = bytearray(body[lay.rw - 2:lay.rw + W])
    if lay.numlist:                      # (only reachable for Op Select -> Op Select)
        raise ValueError("unsupported")
    recs = []
    for t in lay.starts:
        rec = bytearray(body[t:t + base_len])
        bits = rec[SCAN_OFF] & ~(NONPRI_OP | PRI_OP) & 0xFF
        rec[SCAN_OFF] = bits | (NONPRI_OP if nop else 0) | (PRI_OP if pop else 0)
        if sum(body[t:t + base_len - 1]) & 0xFF == body[t + base_len - 1]:
            rec[base_len - 1] = sum(rec[:base_len - 1]) & 0xFF
        if per:
            tail = bytearray(body[t + base_len:t + L]) if lay.per_mode else bytearray(2 + W)
            if not pop and lay.pri_op or not lay.per_mode:
                tail[0:2] = rwl[0:2]         # priority list turning Mode Slave
            if not nop and lay.nonpri_op or not lay.per_mode:
                tail[2:] = rwl[2:]           # non-priority list turning Mode Slave
            if not pop:                      # no <SELMOD> without Priority Op Select
                tail[0:2] = bytes(0 if x == 0xFF else x for x in tail[0:2])
            rec += tail
        recs.append(bytes(rec))
    end = s0 + L * lay.n
    new = bytearray(body[:s0]) + b"".join(recs) + body[end:]
    d = nL - L

    def moved(p):
        if p < s0:
            return p
        if p >= end:
            return p + d * lay.n
        i, off = divmod(p - s0, L)
        return s0 + i * nL + off

    e = lay.e
    for o in HDR_PTRS:
        _put(new, o, moved(_be(body, o) - lay.base) + lay.base)
    for k in EXT_PTRS:
        w = _be(body, e + k) - lay.base
        if s0 <= w <= len(body):
            _put(new, e + k, moved(w) + lay.base)
    for i, t in enumerate(lay.starts):
        _put(new, lay.tab + 2 * i, moved(t) + lay.base)
    new[lay.tab + 2 * lay.n] = sum(new[lay.tab:lay.tab + 2 * lay.n]) & 0xFF
    new[0x10A] = nL
    rw = moved(lay.rw)
    if per:                              # the radio-wide list mirrors mode 1's Mode Slave part(s)
        o = s0 + base_len
        if not pop:
            new[rw - 2:rw] = new[o:o + 2]
        if not nop:
            new[rw:rw + W] = new[o + 2:o + 2 + W]
    elif lay.per_mode:                   # back to Op Select: mode 1's list (RSS)
        o = s0 + base_len
        new[rw - 2:rw + W] = body[o:o + 2 + W]
    new[e + new[e] - 1] = sum(new[e:e + new[e] - 1]) & 0xFF
    endd = len(new)
    while endd and new[endd - 1] == 0xFF:
        endd -= 1
    tot = endd + ((0xAD - endd) % 0x100)
    out = new[:endd] + b"\xff" * (tot - endd)
    out[0xC9] = (out[0xC9] + (len(out) - len(body)) // 32) & 0xFF
    return bytes(out)


def set_scan_type(body: bytes, scan_type: str) -> bytes:
    """900 MHz SCAN TYPE Pri Tlkgr <-> Talkgroup (604ATY): every scanning mode's
    bit moves between +20 b1 and +2 b4; Talkgroup also needs the Priority List
    Mode Slave (re-packed first, as RSS does). Disabled / Channel are not a
    setting: they follow from no mode scanning / the VHF band."""
    lay = layout(body, strict=True)
    if lay is None:
        raise ValueError("Zone Operation is on: SCAN TYPE is per zone (zones[].scan)")
    if str(scan_type).lower() == lay.scan_type.lower():
        return body
    want = str(scan_type).lower()
    if lay.band != "900" or want not in ("talkgroup", "pri tlkgr") or lay.scan_type == "Disabled":
        raise ValueError(f"conventional_scan.scan_type: RSS offers Pri Tlkgr / Talkgroup only "
                         f"on 900 MHz radios with scanning modes (this one: {lay.scan_type})")
    if want == "pri tlkgr" and not lay.nonpri_op:
        raise ValueError("Talkgroup -> Pri Tlkgr clears the Mode Slave Non-Priority lists in RSS "
                         "(not reproduced yet); use RSS")
    if want == "talkgroup" and lay.pri_op:
        body = set_list_types(body, LIST_TYPES[not lay.nonpri_op], "Mode Slave")
        lay = layout(body)
    out = bytearray(body)
    src, dst = ((SCAN_OFF, SCAN_BIT), (TG_OFF, TG_BIT)) if want == "talkgroup" \
        else ((TG_OFF, TG_BIT), (SCAN_OFF, SCAN_BIT))
    k = lay.sum_at()
    for t in lay.starts:
        if out[t + src[0]] & src[1]:
            ok = sum(out[t:t + k]) & 0xFF == out[t + k]
            out[t + src[0]] &= ~src[1] & 0xFF
            out[t + dst[0]] |= dst[1]
            if ok:
                out[t + k] = sum(out[t:t + k]) & 0xFF
    return bytes(out)
