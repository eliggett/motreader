#!/usr/bin/env python3
"""Decode the SB9600 traffic in a dosbox-x log written with MOT_RIBDEBUG=1
(directserial rib:1): RSS's transmitted bytes ("RIB t tx xx") in 5-byte
messages, and the radio's bytes ("RIB t rx xx") as replies or unsolicited
messages. Requests in a scrambled session (codeplug 00 d1, rear head 00 51)
are shown unscrambled, replies too.

Usage: rib_log_decode.py <dosbox.log> [--raw]
"""
import re
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "motreader-py"))
from sb9600 import crc, unscramble, unscramble_reply  # noqa: E402

LINE = re.compile(r"RIB ([\d.]+) (tx|rx) ([0-9a-f]{2})")
SCRAMBLED_OPEN = {0xD1, 0x51}
CLOSE = {0x90, 0x92}


def events(path):
    """(t_ms, 'tx'|'rx', byte) in log order."""
    with open(path, errors="replace") as f:
        for line in f:
            m = LINE.search(line)
            if m:
                yield float(m.group(1)), m.group(2), int(m.group(3), 16)


def frames(evs):
    """Group into (t, dir, bytes5) messages; a direction change or a gap of
    more than 5 ms starts a new message."""
    cur, cdir, t0, tl = [], None, 0.0, 0.0
    for t, d, b in evs:
        if cur and (d != cdir or t - tl > 5 or len(cur) == 5):
            yield t0, cdir, bytes(cur)
            cur = []
        if not cur:
            cdir, t0 = d, t
        cur.append(b)
        tl = t
    if cur:
        yield t0, cdir, bytes(cur)


def main():
    path = sys.argv[1]
    raw = "--raw" in sys.argv
    scr = False
    last_t = None
    for t, d, m in frames(events(path)):
        gap = "" if last_t is None else f"+{t - last_t:7.1f}"
        last_t = t
        hexs = " ".join(f"{b:02x}" for b in m)
        note = ""
        if len(m) == 5 and crc(m[:4]) != m[4]:
            note = " BADCRC"
        if len(m) < 5:
            note = " SHORT"
        if raw or len(m) != 5:
            print(f"{t:12.1f} {gap} {d} {hexs}{note}")
            continue
        op = m[3]
        if d == "tx":
            if op == 0x08:
                desc = f"MODE {m[1]:02x} {m[2]:02x}"
                if m[0]:
                    desc += f" (addr byte {m[0]:02x})"
                if m[1] in SCRAMBLED_OPEN:
                    scr = True
                elif m[1] in CLOSE or m[1] == 0x10:
                    scr = False
            elif op in (0x87, 0x07) or op & 0x7F in (0x07,):
                hi, lo, data = (unscramble(m[0], m[1], m[2]) if scr
                                else (m[0], m[1], m[2]))
                kind = "READ " if op & 0x80 else "WRITE"
                desc = f"{kind} {hi:02x}{lo:02x}" + \
                    ("" if op & 0x80 else f" = {data:02x}")
            else:
                desc = f"OP{op:02x} {m[0]:02x} {m[1]:02x} {m[2]:02x}"
            print(f"{t:12.1f} {gap} >> {hexs}  {desc}{' [s]' if scr else ''}{note}")
        else:
            desc = ""
            if op == 0x07:
                r1, r2 = (unscramble_reply(m[0], m[1], m[2]) if scr
                          else (m[1], m[2]))
                desc = f"data {r2:02x} {r1:02x}  (r0 {m[0]:02x})"
            print(f"{t:12.1f} {gap} << {hexs}  {desc}{note}")


if __name__ == "__main__":
    main()
