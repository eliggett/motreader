"""SB9600 message primitives, as RSS (SPECTRA1.EXE segment 10bd) builds them.

A message is 4 payload bytes plus a CRC byte. RSS sends ``addr_hi, addr_lo,
data, opcode``; an opcode with bit 7 set expects a 5-byte reply. Codeplug
reads and writes can scramble the address/data bytes (``scramble`` and
``unscramble_reply`` below). See notes/RADIO-PROTOCOL.md.

Each routine follows the disassembly instruction for instruction; the 10bd
offsets are noted so they can be re-checked.
"""

from __future__ import annotations

# CRC lookup, indexed by the low 3 bits of (byte ^ crc). 10bd:002c.
CRC_TABLE = (0x00, 0x99, 0xAC, 0x35, 0xC7, 0x5E, 0x6B, 0xF2)

OP_READ = 0x87         # read codeplug byte(s); reply opcode OP_READ_REPLY
OP_READ_REPLY = 0x07
OP_WRITE = 0x07        # write one codeplug byte; no reply
OP_MODE = 0x08         # mode/control commands; no reply


def _sar(b: int) -> int:
    """8086 ``sar r8, 1``."""
    return ((b >> 1) | (b & 0x80)) & 0xFF


def crc_step(crc: int, b: int) -> int:
    """Fold one byte into the running CRC (10bd:0221..0253)."""
    t = b ^ crc
    a = (_sar(t) >> 1) ^ t
    cl = a
    a = (a << 1) & 0xF0
    neg = cl & 0x80          # sar keeps the sign; jns tests it
    cl = _sar(cl)
    if neg:
        cl ^= 0xFF
    a = (a + (cl & 0x0F)) & 0xFF
    return a ^ CRC_TABLE[t & 7]


def crc(payload: bytes) -> int:
    c = 0
    for b in payload:
        c = crc_step(c, b)
    return c


def frame(payload: bytes) -> bytes:
    """4 payload bytes -> the 5 bytes on the wire."""
    assert len(payload) == 4
    return bytes(payload) + bytes([crc(payload)])


def rev8(b: int) -> int:
    """Bit-reverse a byte (10bd:0576)."""
    return int(f"{b:08b}"[::-1], 2)


def scramble(hi: int, lo: int, data: int) -> tuple[int, int, int]:
    """RSS's request scramble over (addr_hi, addr_lo, data) (10bd:0542)."""
    s5 = data ^ hi ^ 0x9B
    s6 = rev8(data) ^ s5
    s7 = rev8(lo) ^ s6 ^ 0xB5
    return s5, s6, s7


def unscramble(s5: int, s6: int, s7: int) -> tuple[int, int, int]:
    """Inverse of scramble: the radio's view of a scrambled request."""
    data = rev8(s6 ^ s5)
    hi = s5 ^ data ^ 0x9B
    lo = rev8(s7 ^ s6 ^ 0xB5)
    return hi, lo, data


def unscramble_reply(r0: int, r1: int, r2: int) -> tuple[int, int]:
    """RSS's reply unscramble (10bd:051c): returns the new (r1, r2)."""
    return rev8(r2 ^ r1 ^ 0x5C), rev8(r2 ^ r0 ^ 0xA4)


def scramble_reply(r0: int, r1: int, r2: int) -> tuple[int, int]:
    """Inverse of unscramble_reply for a chosen r0: the (r1, r2) to send so RSS
    recovers the given plain (r1, r2)."""
    s2 = rev8(r2) ^ r0 ^ 0xA4
    s1 = rev8(r1) ^ s2 ^ 0x5C
    return s1, s2


def read_reply(data: bytes, scrambled: bool, r0: int = 0) -> bytes:
    """Reply to a read: RSS takes byte 2 as the byte at the address and byte 1
    as the next one (10bd:02b4)."""
    d0 = data[0]
    d1 = data[1] if len(data) > 1 else 0
    r1, r2 = (scramble_reply(r0, d1, d0) if scrambled else (d1, d0))
    return frame(bytes([r0, r1, r2, OP_READ_REPLY]))
