"""Zone scan lists and ZONE SCAN OPTIONS (RSS RADIO-WIDE F2 -> ZONE LIST F7 ->
SCAN LIST F7 / SCAN OPTIONS F8), Zone Operation on.

Mapped white-box on 604AUN, 617ASN and 566AYA (one field stepped per RSS
SAVE; notes/ground-truth/scanlist_rss/, FORMAT §5l). Each zone's W+3-byte
record in the zone flag section (ext +0x56) is

  +0      scan-options byte
            0x80 / 0x08  SCAN TYPE: Talkgroup / Pri Tlkgr (neither = Disabled)
            0x40         Talkback Scan Enabled
            0x20         Scan Button Control Active (clear = Override)
            0x10         Coded Squelch Scan Enabled
            0x04         Non-Priority List Op Select (clear = Zone Slaved)
            0x03         Priority List Op Select (clear = Zone Slaved)
  +1, +2  Priority 1 / Priority 2 mode: mode number, 0xFF = <SELMOD> (the
          selected mode), 0 = none
  +3      W-byte bitmap of the non-priority ("N Pri") members, MSB-first
          (0x80 of the first byte = mode 1)

<SELMOD> is always on the list (RSS counts it: "List = 12 of 16 Max"); it is
N Pri unless a priority byte names it. A priority mode is not in the bitmap.
A scan list may hold modes outside its zone. Fixed-size records: edits are
in place, nothing moves.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Union

from .codeplug import zone_sections, zone_operation

SELMOD = "SELMOD"
MAX_MEMBERS = 16                     # RSS: "List = nn of 16 Max", <SELMOD> included
TYPE_BITS = 0x88
SCAN_TYPES = {0x80: "Talkgroup", 0x08: "Pri Tlkgr", 0x00: "Disabled"}
FLAGS = (                            # (field, bit mask, value when set, value when clear)
    ("talkback_scan", 0x40, "Enabled", "Disabled"),
    ("scan_button_control", 0x20, "Active", "Override"),
    ("coded_squelch_scan", 0x10, "Enabled", "Disabled"),
    ("non_priority_list", 0x04, "Op Select", "Zone Slaved"),
    ("priority_list", 0x03, "Op Select", "Zone Slaved"),
)

Priority = Union[int, str, None]     # mode number, "SELMOD", or None


@dataclass
class ZoneScan:
    zone: int
    scan_type: str = "Talkgroup"
    talkback_scan: str = "Enabled"
    scan_button_control: str = "Active"
    coded_squelch_scan: str = "Enabled"
    non_priority_list: str = "Zone Slaved"
    priority_list: str = "Zone Slaved"
    priority_1: Priority = None
    priority_2: Priority = None
    modes: list = field(default_factory=list)   # N Pri members (besides <SELMOD>)

    def members(self) -> int:
        """Scan-list size as RSS counts it (<SELMOD> included)."""
        return 1 + len(self.modes) + sum(1 for p in (self.priority_1, self.priority_2)
                                         if p not in (None, SELMOD))


def _records(body: bytes):
    """[(offset, W)] of each zone's flag record, or [] (zones off / not found)."""
    if not zone_operation(body):
        return []
    zs = zone_sections(body)
    if zs is None:
        return []
    w = zs["w"]
    return [(zs["flags"] + 2 + k * (w + 3), w) for k in range(zs["count"])]


def _pri_decode(v: int) -> Priority:
    return None if v == 0 else SELMOD if v == 0xFF else v


def decode(body: bytes) -> list:
    """ZoneScan per zone (empty with Zone Operation off)."""
    out = []
    for k, (o, w) in enumerate(_records(body)):
        f = body[o]
        z = ZoneScan(zone=k + 1, scan_type=SCAN_TYPES.get(f & TYPE_BITS, f"0x{f & TYPE_BITS:02x}"))
        for name, mask, on, off in FLAGS:
            v = f & mask
            setattr(z, name, on if v == mask else off if v == 0 else f"0x{v:02x}")
        z.priority_1, z.priority_2 = _pri_decode(body[o + 1]), _pri_decode(body[o + 2])
        z.modes = [i * 8 + j + 1 for i in range(w) for j in range(8)
                   if body[o + 3 + i] & (0x80 >> j)]
        out.append(z)
    return out


def _pri_encode(p: Priority, n: int, what: str) -> int:
    if p is None or p == "" or p == 0:
        return 0
    if str(p).upper().strip("<>") == SELMOD:
        return 0xFF
    p = int(p)
    if not 1 <= p <= n:
        raise ValueError(f"{what}: no mode {p} (1..{n})")
    return p


def _enum(z: ZoneScan, name: str, table: dict) -> int:
    v = getattr(z, name)
    for bits, label in table.items():
        if str(v).lower() == label.lower():
            return bits
    raise ValueError(f"zone {z.zone} {name}: {v!r} is not one of {list(table.values())}")


def encode(body: bytes, scans) -> bytes:
    """Write the given ZoneScan rows into their zones' flag records (zones
    not listed are left alone). Refuses what RSS won't store: more than 16
    members, the same mode as Priority 1 and 2, modes out of range."""
    recs = _records(body)
    if not recs:
        raise ValueError("no zone scan lists (Zone Operation is off or zone tables not found)")
    n = body[0x109]
    out = bytearray(body)
    for z in scans:
        if not 1 <= z.zone <= len(recs):
            raise ValueError(f"no zone {z.zone} (1..{len(recs)})")
        o, w = recs[z.zone - 1]
        f = body[o]
        nf = f & TYPE_BITS if str(z.scan_type).startswith("0x") else _enum(z, "scan_type", SCAN_TYPES)
        for name, mask, on, off in FLAGS:
            v = getattr(z, name)
            if str(v).startswith("0x"):          # undecoded value: keep the bits
                nf |= f & mask
            else:
                nf |= _enum(z, name, {mask: on, 0: off})
        p1 = _pri_encode(z.priority_1, n, f"zone {z.zone} priority_1")
        p2 = _pri_encode(z.priority_2, n, f"zone {z.zone} priority_2")
        if p1 and p1 == p2:
            raise ValueError(f"zone {z.zone}: the same mode can't be Priority 1 and Priority 2")
        if (p1 or p2) and nf & TYPE_BITS == 0x80:
            raise ValueError(f"zone {z.zone}: priority modes need scan_type Pri Tlkgr "
                             f"(RSS drops them from a Talkgroup list)")
        modes = sorted({int(m) for m in z.modes} - {p1, p2})
        bad = [m for m in modes if not 1 <= m <= min(n, w * 8)]
        if bad:
            raise ValueError(f"zone {z.zone} scan list: no mode(s) {bad} (1..{n})")
        size = 1 + len(modes) + sum(1 for p in (p1, p2) if p not in (0, 0xFF))
        if size > MAX_MEMBERS:
            raise ValueError(f"zone {z.zone} scan list: {size} members (<SELMOD> included), "
                             f"RSS allows {MAX_MEMBERS}")
        bm = bytearray(w)
        for m in modes:
            bm[(m - 1) // 8] |= 0x80 >> ((m - 1) % 8)
        out[o:o + 3 + w] = bytes([nf, p1, p2]) + bm
    return bytes(out)


def offsets(body: bytes) -> dict:
    """{body offset: zone number} of every scan-record byte (change reports)."""
    return {o + i: k + 1 for k, (o, w) in enumerate(_records(body)) for i in range(w + 3)}
