#!/usr/bin/env python3
"""A RIB + fake radio on a pseudo-terminal, for testing real-port code paths
(dosbox-x directserial, motreader.radio) without hardware.

Prints the slave device path, then echoes every byte written to it (as the
SB9600 bus does) and answers RSS-style messages via tools/fake_radio.Radio.
A pty has no modem lines, so BUSY is not modelled; messages are found by
their CRC instead.

Usage: pty_rib.py [--image FILE] [--set ADDR=HEX]... [--log FILE]
                  [--echo-delay MS] [--reply-delay MS] [--link PATH]
  --echo-delay / --reply-delay  simulate USB-serial latency
  --link   also make a symlink PATH -> the slave device
"""
import argparse
import heapq
import os
import select
import sys
import time
import tty

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, ".."))
from fake_radio import Radio  # noqa: E402
from motreader import sb9600 as sb  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image")
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--log")
    ap.add_argument("--echo-delay", type=float, default=0.0)
    ap.add_argument("--reply-delay", type=float, default=2.0)
    ap.add_argument("--link")
    a = ap.parse_args()

    mem = dict(enumerate(open(a.image, "rb").read())) if a.image else {}
    for spec in a.set:
        addr, hexbytes = spec.split("=")
        for i, v in enumerate(bytes.fromhex(hexbytes)):
            mem[int(addr, 16) + i] = v
    log = open(a.log, "w") if a.log else sys.stderr
    radio = Radio(mem, log)

    master, slave = os.openpty()
    tty.setraw(slave)
    name = os.ttyname(slave)
    if a.link:
        if os.path.lexists(a.link):
            os.remove(a.link)
        os.symlink(name, a.link)
    print(name, flush=True)
    radio.note(f"pty {name}")

    pending = []          # (due, seq, bytes) to write to the master
    seq = 0
    buf = bytearray()
    while True:
        now = time.monotonic()
        timeout = max(0.0, pending[0][0] - now) if pending else 0.5
        r, _, _ = select.select([master], [], [], timeout)
        now = time.monotonic()
        while pending and pending[0][0] <= now:
            os.write(master, heapq.heappop(pending)[2])
        if not r:
            continue
        try:
            data = os.read(master, 4096)
        except OSError:
            break          # slave closed
        for b in data:
            seq += 1
            heapq.heappush(pending, (now + a.echo_delay / 1000, seq, bytes([b])))
            buf.append(b)
            if len(buf) > 5:
                del buf[0]
            if len(buf) == 5 and sb.crc(bytes(buf[:4])) == buf[4]:
                reply = radio.message(bytes(buf))
                buf.clear()
                if reply:
                    t = now + (a.echo_delay + a.reply_delay) / 1000
                    for i, x in enumerate(reply):
                        seq += 1
                        heapq.heappush(pending, (t + i * 0.00105, seq, bytes([x])))
    radio.note(f"closed: {radio.reads} reads, {radio.writes} writes")


if __name__ == "__main__":
    main()
