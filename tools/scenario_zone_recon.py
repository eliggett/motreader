#!/usr/bin/env python3
"""Recon the RSS zone editor: boot+GET, dump the CHANGE/VIEW submenu, then try
each F-key to find the ZONE screen and dump what it shows.

Usage: scenario_zone_recon.py <sandbox_c> <workdir>
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


def main():
    sandbox_c, workdir = sys.argv[1], sys.argv[2]
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        N.boot_and_get(d)
        print("booted+GET ok")
        N.to_main(d)
        dump(d, "MAIN MENU")
        # enter CHANGE/VIEW
        N.key_to(d, "f4", "CHANGE / VIEW")
        chg = dump(d, "CHANGE / VIEW menu")
        # probe F5..F9 one at a time, dumping and returning to CHANGE/VIEW
        for key in ["f5", "f6", "f7", "f9", "f2", "f3"]:
            N.to_main(d)
            N.key_to(d, "f4", "CHANGE / VIEW")
            d.send_keys(key)
            time.sleep(1.5)
            dump(d, f"CHANGE/VIEW -> {key.upper()}")


if __name__ == "__main__":
    main()
