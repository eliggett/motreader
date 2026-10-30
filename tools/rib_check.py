#!/usr/bin/env python3
"""Check a serial port + RIB + radio before reading a codeplug.

1. Show the modem input lines at rest (BUSY comes back on CTS/RI).
2. Toggle DTR (the BUSY output) and time how long CTS/RI take to follow:
   RSS allows about 1 ms; motreader allows much more.
3. Optionally (--read) read the codeplug header's first bytes, the same read
   RSS starts with, and print the timings. Read-only.

Usage: rib_check.py <port> [--read]
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def lines(ser):
    try:
        return {"CTS": ser.cts, "RI": ser.ri, "DSR": ser.dsr, "CD": ser.cd}
    except OSError as e:
        return {"error": str(e)}


def follow_time(ser, want, limit=0.2):
    t0 = time.monotonic()
    while time.monotonic() - t0 < limit:
        if bool(ser.cts or ser.ri) == want:
            return (time.monotonic() - t0) * 1000
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("--read", action="store_true")
    a = ap.parse_args()
    import serial

    ser = serial.Serial(a.port, 9600, timeout=0.3, rtscts=False, dsrdtr=False)
    try:
        ser.dtr = False
    except OSError:
        pass
    time.sleep(0.1)
    rest = lines(ser)
    print("at rest (DTR off):", rest)
    if "error" in rest:
        print("  no modem lines on this port (a pty?): skipping the DTR test")
    elif rest["CTS"] or rest["RI"]:
        print("  BUSY is set with DTR off: radio off/busy, or the cable/RIB is unpowered")
    for i in range(0 if "error" in rest else 3):
        ser.dtr = True
        up = follow_time(ser, True)
        ser.dtr = False
        down = follow_time(ser, False)
        fmt = lambda t: "never (200 ms)" if t is None else f"{t:.1f} ms"
        print(f"DTR on -> BUSY seen after {fmt(up)}; DTR off -> clear after {fmt(down)}")
        time.sleep(0.05)
        if i == 2:
            print("  RSS needs 'clear' within about 1 ms (dosbox-x rib:1 hides this).")
    ser.close()

    if a.read:
        from motreader.radio import CODEPLUG_BASE, SESSION_CODEPLUG, Radio, SerialLink
        log = []
        link = SerialLink(a.port, log=log.append)
        try:
            r = Radio(link)
            t0 = time.monotonic()
            with r.session(SESSION_CODEPLUG):
                head = r.read(CODEPLUG_BASE, 32, True)
            dt = time.monotonic() - t0
        finally:
            link.close()
        print(f"header read in {dt * 1000:.0f} ms: {head!r}")
        print("OK: the radio answers." if head.startswith(b"COPYRIGHT")
              else "unexpected header; see the messages below")
        for line in log:
            print("  ", line)


if __name__ == "__main__":
    main()
