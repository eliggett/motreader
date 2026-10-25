#!/usr/bin/env python3
"""Dump the Rx SQUELCH TYPE cycle order (and the CODE value) on a VHF mode, so we
know the exact enum labels/order. Usage: <serial> <sandbox_c> <workdir> <mode>"""
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
        raise RuntimeError("no MAIN MENU")
    N.key_to(d, "f3", "GET / SAVE MENU"); d.send_keys("f3")
    if not N.wait_for(d, "RADIO SERIAL") and "WARNING" in N.scr(d):
        d.send_keys("f2"); N.wait_for(d, "RADIO SERIAL")
    d.send_keys("f8"); N.wait_for(d, "GET / SAVE MENU")


def to_mode(d, num):
    N.to_main(d)
    N.key_to(d, "f4", "CHANGE / VIEW CODEPLUG")
    N.key_to(d, "f5", "CONVENTIONAL MODE CONFIGURATION")
    d.send_keys("f2"); time.sleep(0.5)
    for ch in f"{num:03d}":
        d.send_keys(ch); time.sleep(0.15)
    d.send_keys("enter"); time.sleep(0.6)
    N.wait_for(d, f"MODE {num:03d}", tries=20)


def line(rows, label):
    for r in rows:
        if label in r:
            return r.split(label, 1)[1].strip(". ")
    return ""


def main():
    serial, sandbox_c, workdir, mode_s = sys.argv[1:5]
    num = int(mode_s)
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect(); boot(d)
        for d_dir in ("down", "up"):
            to_mode(d, num)
            for _ in range(4):
                d.send_keys("tab"); time.sleep(0.15)
            print(f"--- cycling {d_dir} from Rx SQUELCH TYPE ---", flush=True)
            for i in range(6):
                rows = d.read_screen()[0] or []
                print(f"  {i}: TYPE={line(rows,'Rx SQUELCH TYPE')!r}  "
                      f"CODE={line(rows,'Rx CODE')!r}", flush=True)
                d.send_keys(d_dir); time.sleep(0.4)
        d.close()
    print("done.")


if __name__ == "__main__":
    main()
