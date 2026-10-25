#!/usr/bin/env python3
"""GET a (patched) archive and read back the Rx/Tx SQUELCH TYPE + CODE that RSS
decodes for a list of modes, via GOTO MODE on the MODE screen. Pure read — the
inverse-oracle readout for the 900 DPL investigation.

Usage: scenario_read_modes.py <serial> <sandbox_c> <workdir> <m1,m2,...>
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N


def boot(d):
    for _ in range(12):
        if "MAIN MENU" in N.scr(d):
            break
        d.send_keys("enter"); time.sleep(1.5)
    else:
        raise RuntimeError("no MAIN MENU:\n" + N.scr(d))
    if not N.key_to(d, "f3", "GET / SAVE MENU"):
        raise RuntimeError("no GET/SAVE")
    d.send_keys("f3")
    if not N.wait_for(d, "RADIO SERIAL"):
        if "WARNING" in N.scr(d):
            d.send_keys("f2"); N.wait_for(d, "RADIO SERIAL")
    d.send_keys("f8")
    N.wait_for(d, "GET / SAVE MENU")


def to_mode(d):
    N.to_main(d)
    N.key_to(d, "f4", "CHANGE / VIEW CODEPLUG")
    N.key_to(d, "f5", "CONVENTIONAL MODE CONFIGURATION")


def goto_mode(d, num):
    # F2 = GOTO MODE, then type the 3-digit mode number + Enter
    d.send_keys("f2"); time.sleep(0.5)
    for ch in f"{num:03d}":
        d.send_keys(ch); time.sleep(0.15)
    d.send_keys("enter"); time.sleep(0.6)
    N.wait_for(d, f"MODE {num:03d}", tries=20)


def field(rows, label):
    for r in rows:
        if label in r:
            # text after the dotted leader
            seg = r.split(label, 1)[1]
            return seg.strip(". ")
    return ""


def main():
    serial, sandbox_c, workdir, modes_s = sys.argv[1:5]
    modes = [int(x) for x in modes_s.split(",")]
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        boot(d)
        print("booted + GET ok\n", flush=True)
        to_mode(d)
        for num in modes:
            goto_mode(d, num)
            rows = d.read_screen()[0] or []
            name = field(rows, "NAME")
            rxt = field(rows, "Rx SQUELCH TYPE")
            rxc = field(rows, "Rx CODE")
            txt = field(rows, "Tx SQUELCH TYPE")
            txc = field(rows, "Tx CODE")
            print(f"mode {num:3}: name={name:12.12} Rx[{rxt:>8} {rxc:>10}]  Tx[{txt:>8} {txc:>10}]",
                  flush=True)
        d.close()
    print("done.")


if __name__ == "__main__":
    main()
