#!/usr/bin/env python3
"""Probe the alignment test mode on a real radio (into a dummy load), as RSS
SERVICE -> ALIGNMENT -> DEVIATION does, to find what shows the transmitter
state in MCU RAM (for a PTT OFF read-back).

Steps: test mode (low test frequency), RAM snapshot, key for at most
--key-secs (hard limit 8 s by alarm), RAM snapshot while keyed, PTT OFF
twice, RAM snapshot, leave test mode, MODE_DONE. Every byte the radio sends
on its own is logged as a message.

PTT safety: keying happens only inside keyed(); its finally sends PTT OFF
twice whatever happened (exception, Ctrl-C, SIGTERM, the alarm).

Usage: align_ptt_probe.py [--port /dev/ttyUSB0] [--key-secs 3] [--no-key] [--test 42]
"""
import argparse
import os
import signal
import sys
import time
from contextlib import contextmanager

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
from motreader import sb9600 as sb  # noqa: E402
from motreader.radio import SerialLink, Radio, SESSION_MCU, BusError  # noqa: E402

PTT_ON = bytes.fromhex("0003010a")       # SETBUT button 03 (PTT) pressed
PTT_OFF = bytes.fromhex("0003000a")      # released
TEST_EXIT = bytes.fromhex("01000040")
HARD_LIMIT = 8                           # s; the owner's limit is 10


class Alarm(Exception):
    pass


def t():
    return time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"


def listen(link, secs):
    """Collect what the radio sends on its own for secs; print it framed."""
    link.ser.timeout = 0.02
    end = time.monotonic() + secs
    buf = bytearray()
    while time.monotonic() < end:
        buf += link.ser.read(64)
    i = 0
    out = []
    while i + 5 <= len(buf):
        m = bytes(buf[i:i + 5])
        if sb.crc(m[:4]) == m[4]:
            out.append(m)
            i += 5
        else:
            i += 1
    for m in out:
        txt = ""
        if m[3] == 0x3C and 0x20 <= m[2] < 0x7F:
            txt = f"  display '{chr(m[2])}'"
        print(f"  {t()} radio: {m.hex(' ')}{txt}")
    if i < len(buf):
        print(f"  {t()} radio: unframed {bytes(buf[i:]).hex(' ')}")
    return out


def send(link, payload, after=0.15):
    print(f"{t()} send {payload.hex(' ')}", flush=True)
    link.transact(payload)
    return listen(link, after)


def ram(r, label):
    out = {}
    with r.session(SESSION_MCU):
        for a, n in ((0x0000, 0x40), (0x0580, 0x80)):
            out[a] = r.read(a, n, False)
    print(f"{t()} RAM {label}:")
    for a, d in out.items():
        print(f"  {a:04x}: {d.hex(' ')}")
    return out


def ptt_off(link):
    """PTT OFF twice; keep trying on bus errors."""
    sent = 0
    for _ in range(20):
        try:
            send(link, PTT_OFF, 0.1)
            sent += 1
            if sent == 2:
                return True
        except BusError as e:
            print(f"{t()} PTT OFF failed: {e}", flush=True)
            time.sleep(0.1)
    return False


@contextmanager
def keyed(link, limit):
    def on_alarm(*_):
        raise Alarm(f"PTT time limit {limit} s")
    old = signal.signal(signal.SIGALRM, on_alarm)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    t0 = time.monotonic()
    try:
        signal.alarm(limit)
        send(link, PTT_ON, 0.1)
        yield t0
    finally:
        signal.alarm(0)
        ok = ptt_off(link)
        print(f"{t()} PTT OFF x2 {'sent' if ok else 'NOT SENT: POWER THE RADIO OFF'}"
              f" after {time.monotonic() - t0:.1f} s keyed", flush=True)
        signal.signal(signal.SIGALRM, old)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyUSB0")
    ap.add_argument("--key-secs", type=float, default=3)
    ap.add_argument("--no-key", action="store_true")
    ap.add_argument("--test", default="42",
                    help="test mode code (01 XX 10 40): 42 deviation low, 11 high power")
    a = ap.parse_args()
    if a.key_secs > HARD_LIMIT - 2:
        sys.exit(f"--key-secs is at most {HARD_LIMIT - 2}")
    link = SerialLink(a.port)
    r = Radio(link)
    try:
        send(link, PTT_OFF)                         # as RSS does first
        before = ram(r, "idle")
        send(link, bytes([0x01, int(a.test, 16), 0x10, 0x40]), 0.5)
        test = ram(r, "test mode")
        keyed_ram = None
        if not a.no_key:
            with keyed(link, HARD_LIMIT) as t0:
                with r.session(SESSION_MCU):
                    f = r.read(0x000C, 7, False)
                print(f"{t()} 000c..0012 keyed: {f.hex(' ')}")
                if time.monotonic() - t0 < a.key_secs - 1.6:
                    keyed_ram = ram(r, "keyed")
                rest = a.key_secs - (time.monotonic() - t0)
                if rest > 0:
                    listen(link, rest)
            after = ram(r, "after PTT OFF")
            for a0 in after:
                for name, snap in (("keyed", keyed_ram), ("after", after)):
                    if not snap:
                        continue
                    d = [f"{a0 + i:04x}:{x:02x}->{y:02x}"
                         for i, (x, y) in enumerate(zip(test[a0], snap[a0])) if x != y]
                    print(f"  test->{name} {a0:04x}: {' '.join(d) or 'same'}")
        send(link, PTT_OFF)
        send(link, TEST_EXIT, 0.5)
        del before
    finally:
        try:
            ptt_off(link)
        finally:
            r.needs_reset = True
            r.finish()                              # MODE_DONE: restart
            link.close()


if __name__ == "__main__":
    main()
