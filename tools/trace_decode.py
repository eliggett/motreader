#!/usr/bin/env python3
"""Decode a binary trace produced by the motreader-patched dosbox-x harness.

Record stream (little-endian, 1-byte type tag + payload), written by
TRACE_Mem / TRACE_StepGate / the control-channel 'mark'/'trace-open' commands
in dosbox-x/src/hardware/memory.cpp:

  'B'  base:u32 len:u32                                   header (once)
  'R'  cyc:u64 cs:u16 eip:u32 addr:u32 size:u8 value:u32  guest data read
  'W'  ... (same layout as 'R')                           guest data write
  'M'  cyc:u64 len:u8 label[len]                          marker
  'S'  cyc:u64 cs:u16 eip:u32 eax,ebx,ecx,edx,esi,edi,ebp,esp,flags:u32*9
                                                          single-step snapshot

Use as a library (iter_records / load) or CLI (dumps records as text).
"""
import struct
import sys
from dataclasses import dataclass


@dataclass
class Buffer:
    base: int
    length: int


@dataclass
class Access:            # 'R' or 'W'
    write: bool
    cyc: int
    cs: int
    eip: int
    addr: int
    size: int
    value: int

    def off(self, base):
        return self.addr - base


@dataclass
class Mark:
    cyc: int
    label: str


@dataclass
class Step:              # 'S'
    cyc: int
    cs: int
    eip: int
    eax: int
    ebx: int
    ecx: int
    edx: int
    esi: int
    edi: int
    ebp: int
    esp: int
    flags: int


_RW = struct.Struct("<QHIIBI")        # cyc,cs,eip,addr,size,value  (24 total incl tag)
_B = struct.Struct("<II")
_MH = struct.Struct("<QB")
_S = struct.Struct("<QHI" + "I" * 9)


def iter_records(data):
    """Yield typed records from a bytes blob."""
    i, n = 0, len(data)
    while i < n:
        tag = data[i:i + 1]
        i += 1
        if tag == b"B":
            base, length = _B.unpack_from(data, i)
            i += _B.size
            yield Buffer(base, length)
        elif tag in (b"R", b"W"):
            cyc, cs, eip, addr, size, value = _RW.unpack_from(data, i)
            i += _RW.size
            yield Access(tag == b"W", cyc, cs, eip, addr, size, value)
        elif tag == b"M":
            cyc, ln = _MH.unpack_from(data, i)
            i += _MH.size
            label = data[i:i + ln].decode(errors="replace")
            i += ln
            yield Mark(cyc, label)
        elif tag == b"S":
            v = _S.unpack_from(data, i)
            i += _S.size
            yield Step(*v)
        else:
            raise ValueError(f"bad record tag {tag!r} at offset {i-1}")


def load(path):
    with open(path, "rb") as f:
        return list(iter_records(f.read()))


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: trace_decode.py <trace.bin> [--limit N]")
    recs = load(sys.argv[1])
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    base = next((r.base for r in recs if isinstance(r, Buffer)), 0)
    shown = 0
    for r in recs:
        if isinstance(r, Buffer):
            print(f"BUFFER base={r.base:#x} len={r.length}")
        elif isinstance(r, Access):
            o = r.addr - base
            orel = f" off={o:+#x}" if base else ""
            print(f"{'W' if r.write else 'R'} cyc={r.cyc} {r.cs:04x}:{r.eip:04x} "
                  f"addr={r.addr:#x}{orel} sz={r.size} val={r.value:#x}")
        elif isinstance(r, Mark):
            print(f"--- MARK cyc={r.cyc} {r.label} ---")
        elif isinstance(r, Step):
            print(f"S cyc={r.cyc} {r.cs:04x}:{r.eip:04x} ax={r.eax & 0xffff:04x} "
                  f"bx={r.ebx & 0xffff:04x} cx={r.ecx & 0xffff:04x} dx={r.edx & 0xffff:04x} "
                  f"si={r.esi & 0xffff:04x} di={r.edi & 0xffff:04x} fl={r.flags & 0xffff:04x}")
        shown += 1
        if limit and shown >= limit:
            print("...")
            break


if __name__ == "__main__":
    main()
