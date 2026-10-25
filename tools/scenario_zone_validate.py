#!/usr/bin/env python3
"""End-to-end: GET a motreader zone-edited archive into real RSS and read the
ZONE NAME LIST + zone-1 MODE LIST to confirm the edit loaded.
Usage: scenario_zone_validate.py <sandbox_c> <workdir>"""
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


def to_zone_names(d):
    N.to_main(d)
    N.key_to(d, "f4", "CHANGE / VIEW")
    N.key_to(d, "f2", "RADIO-WIDE")
    for _ in range(5):
        d.send_keys("f7"); time.sleep(1.2)
        if "ZONE NAME LIST" in N.scr(d):
            return
        d.send_keys("tab"); time.sleep(0.8)
        if "ZONE NAME LIST" in N.scr(d):
            return
    raise RuntimeError("no ZONE NAME LIST:\n" + N.scr(d))


def main():
    sandbox_c, workdir = sys.argv[1], sys.argv[2]
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        N.boot_and_get(d); print("booted+GET ok")
        to_zone_names(d); dump(d, "ZONE NAME LIST (expect Z01=ZEBRA)")
        d.send_keys("f2"); time.sleep(1.2)      # MODE LIST (zone 1)
        dump(d, "ZONE 1 MODE LIST p1 (expect modes 2,3,18 Y)")
        d.send_keys("pgdn"); time.sleep(0.6)
        dump(d, "ZONE 1 MODE LIST p2")
        d.send_keys("pgdn"); time.sleep(0.6)
        dump(d, "ZONE 1 MODE LIST p3 (expect mode 99 Y)")


if __name__ == "__main__":
    main()
