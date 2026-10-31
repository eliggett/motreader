#!/usr/bin/env python3
"""A RIB + fake radio on a pseudo-terminal, for testing real-port code paths
(dosbox-x directserial, motreader.radio) without hardware.

Prints the slave device path, then echoes every byte written to it (as the
SB9600 bus does) and answers RSS-style messages via tools/fake_radio.Radio.
A pty has no modem lines, so BUSY is not modelled unless --bus is given
(with tools/ptybus/ptybus.so preloaded in dosbox-x); messages are found by
their CRC.

Usage: pty_rib.py [--image FILE] [--set ADDR=HEX]... [--log FILE]
                  [--echo-delay MS] [--reply-delay MS] [--link PATH]
                  [--chatter-delay MS] [--bus FILE]
  --echo-delay / --reply-delay  simulate USB-serial latency
  --link   also make a symlink PATH -> the slave device
  --chatter-delay MS  the radio's display messages after an alignment
                      command (tools/fake_radio.CHATTER), -1 for none
"""
import argparse
import heapq
import mmap
import os
import select
import signal
import struct
import sys
import time
import tty

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, ".."))
from fake_radio import Radio  # noqa: E402
from motreader import sb9600 as sb  # noqa: E402


BYTE = 0.00105            # one byte at 9600 baud


class Bus:
    """The RIB's BUSY line, shared with tools/ptybus/ptybus.so (LD_PRELOAD
    in dosbox-x): the PC's DTR comes in, and BUSY as the PC would see it
    goes out, with the lag measured on an FT232R + RIB (BUSY shows about
    1.5 ms after DTR goes up, clears about 4 ms after it drops), OR the
    radio's own BUSY while it sends."""
    ON_LAG, OFF_LAG = 0.0015, 0.004

    def __init__(self, path, note=None):
        self.note = note or (lambda msg: None)
        with open(path, "wb") as f:
            f.write(bytes(12))
        self.f = open(path, "r+b")
        self.m = mmap.mmap(self.f.fileno(), 12)
        self.dtr = False
        self.dtr_t = 0.0
        self.windows = []          # (start, end) the radio holds BUSY
        self.state = False
        self.changes = 0

    def pc_dtr(self, now):
        d = struct.unpack_from("<I", self.m, 0)[0] != 0
        if d != self.dtr:
            self.dtr, self.dtr_t = d, now
            self.note(f"   PC DTR {int(d)}")
        return d

    def radio(self, start, end):
        self.windows.append((start, end))

    def idle(self, now):
        """Free for the radio: the PC's DTR down for 2 ms, nobody else on."""
        return (not self.pc_dtr(now) and now - self.dtr_t >= 0.002
                and not any(s <= now < e for s, e in self.windows))

    def update(self, now):
        d = self.pc_dtr(now)
        lag = self.ON_LAG if d else self.OFF_LAG
        seen = d if now - self.dtr_t >= lag else not d
        self.windows = [w for w in self.windows if w[1] > now]
        st = seen or any(s <= now < e for s, e in self.windows)
        if st != self.state:
            self.state = st
            self.changes += 1
            self.note(f"   BUSY seen by PC {int(st)}")
            struct.pack_into("<II", self.m, 4, int(st), self.changes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image")
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--log")
    ap.add_argument("--echo-delay", type=float, default=0.0)
    ap.add_argument("--reply-delay", type=float, default=2.0)
    ap.add_argument("--link")
    ap.add_argument("--bus", metavar="FILE",
                    help="model BUSY through this shared file, for "
                         "tools/ptybus/ptybus.so (MOT_PTYBUS=FILE) in dosbox-x")
    ap.add_argument("--chatter-delay", type=float, default=10.0,
                    help="ms after an alignment command before the radio's "
                         "own display messages (negative: none)")
    a = ap.parse_args()

    mem = dict(enumerate(open(a.image, "rb").read())) if a.image else {}
    for spec in a.set:
        addr, hexbytes = spec.split("=")
        for i, v in enumerate(bytes.fromhex(hexbytes)):
            mem[int(addr, 16) + i] = v
    log = open(a.log, "w") if a.log else sys.stderr
    radio = Radio(mem, log)
    radio.flush = False       # a flush per message can delay a reply
    signal.signal(signal.SIGTERM, lambda *_: (log.flush(), sys.exit(0)))

    master, slave = os.openpty()
    tty.setraw(slave)
    name = os.ttyname(slave)
    if a.link:
        if os.path.lexists(a.link):
            os.remove(a.link)
        os.symlink(name, a.link)
    print(name, flush=True)
    radio.note(f"pty {name}")

    bus = Bus(a.bus, radio.note) if a.bus else None
    pending = []          # (due, seq, bytes) to write to the master
    seq = 0
    buf = bytearray()
    chatter, chatter_due = b"", 0.0
    radio_until = 0.0     # the radio holds BUSY until then (bus model)

    def send(t, data):
        nonlocal seq
        for i, x in enumerate(data):
            seq += 1
            heapq.heappush(pending, (t + i * BYTE, seq, bytes([x])))
        return t + len(data) * BYTE

    while True:
        now = time.monotonic()
        if bus:
            timeout = 0.0002
        else:
            due = [pending[0][0]] if pending else []
            if chatter:
                due.append(chatter_due)
            timeout = max(0.0, min(due) - now) if due else 0.5
        r, _, _ = select.select([master], [], [], timeout)
        now = time.monotonic()
        while pending and pending[0][0] <= now:
            os.write(master, heapq.heappop(pending)[2])
        if chatter and now >= chatter_due and (not bus or bus.idle(now)):
            # the radio talks on its own once the bus is free, holding BUSY
            radio_until = send(now, chatter)
            if bus:
                bus.radio(now, radio_until)
            chatter = b""
        if bus:
            bus.update(now)
        if not r:
            continue
        try:
            data = os.read(master, 4096)
        except OSError:
            break          # slave closed
        for b in data:
            send(now + a.echo_delay / 1000, bytes([b]))
            buf.append(b)
            if len(buf) > 5:
                del buf[0]
            if len(buf) == 5 and sb.crc(bytes(buf[:4])) == buf[4]:
                reply = radio.message(bytes(buf))
                buf.clear()
                if reply:
                    t = now + (a.echo_delay + a.reply_delay) / 1000
                    end = send(t, reply)
                    if bus:
                        bus.radio(t, end)
                if radio.chatter and a.chatter_delay >= 0:
                    chatter = radio.chatter
                    chatter_due = now + (a.echo_delay + a.chatter_delay) / 1000
    radio.note(f"closed: {radio.reads} reads, {radio.writes} writes")


if __name__ == "__main__":
    main()
