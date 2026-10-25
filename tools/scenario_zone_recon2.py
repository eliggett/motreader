#!/usr/bin/env python3
"""Recon the ZONE LIST editor: CHANGE/VIEW -> F2 RADIO-WIDE -> F7 ZONE LIST.
Dump the screen, try TAB/arrows/F-keys to understand navigation + fields.

Usage: scenario_zone_recon2.py <sandbox_c> <workdir>
"""
import sys, time
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from trace_lib import Harness
import rss_nav as N


def dump(d, label):
    rows, _ = d.read_screen()
    print(f"\n===== {label} =====")
    for r in (rows or []):
        if r.rstrip():
            print("  |" + r.rstrip())
    return "\n".join(rows or [])


def zone_editor(d):
    N.to_main(d)
    N.key_to(d, "f4", "CHANGE / VIEW")
    N.key_to(d, "f2", "RADIO-WIDE")
    d.send_keys("f7")
    time.sleep(1.5)


def main():
    sandbox_c, workdir = sys.argv[1], sys.argv[2]
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        N.boot_and_get(d)
        print("booted+GET ok")
        zone_editor(d)
        dump(d, "ZONE LIST (entry)")
        # try F-keys available on the zone screen
        for key in ["f3", "f4", "f2"]:
            d.send_keys(key); time.sleep(1.2)
            dump(d, f"ZONE LIST + {key.upper()}")
        # try TAB a few times to see field focus movement
        zone_editor(d)
        for i in range(8):
            d.send_keys("tab"); time.sleep(0.6)
            dump(d, f"ZONE LIST TAB#{i+1}")


if __name__ == "__main__":
    main()
