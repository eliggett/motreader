#!/usr/bin/env python3
"""Recon the ZONE sub-screens: MODE LIST (F2), SCAN LIST (F7), SCAN OPTIONS (F8)
from the ZONE NAME LIST. Usage: scenario_zone_recon3.py <sandbox_c> <workdir>"""
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


def to_zone_names(d):
    N.to_main(d)
    N.key_to(d, "f4", "CHANGE / VIEW")
    N.key_to(d, "f2", "RADIO-WIDE")
    d.send_keys("f7"); time.sleep(1.0)
    if not N.wait_for(d, "ZONE NAME LIST", tries=20):
        d.send_keys("tab"); time.sleep(0.8)
    N.wait_for(d, "ZONE NAME LIST", tries=20)


def main():
    sandbox_c, workdir = sys.argv[1], sys.argv[2]
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        N.boot_and_get(d); print("booted+GET ok")
        to_zone_names(d); dump(d, "ZONE NAME LIST")
        # F8 SCAN OPTIONS (per-zone flags)
        d.send_keys("f8"); time.sleep(1.2); dump(d, "F8 SCAN OPTIONS")
        for i in range(6):
            d.send_keys("tab"); time.sleep(0.5); dump(d, f"SCAN OPTIONS TAB#{i+1}")
        # back, F2 MODE LIST (membership)
        to_zone_names(d)
        d.send_keys("f2"); time.sleep(1.2); dump(d, "F2 MODE LIST")
        d.send_keys("pgdn"); time.sleep(0.6); dump(d, "MODE LIST pgdn")
        # back, F7 SCAN LIST
        to_zone_names(d)
        d.send_keys("f7"); time.sleep(1.2); dump(d, "F7 SCAN LIST")


if __name__ == "__main__":
    main()
