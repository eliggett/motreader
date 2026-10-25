#!/usr/bin/env python3
"""Dump ALL mode-list pages for every zone (full membership ground truth).
Usage: scenario_zone_dump_modelists.py <sandbox_c> <workdir> <n_zones>"""
import sys, time
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from trace_lib import Harness
import rss_nav as N


def scr(d):
    return N.scr(d)


def to_zone_names(d):
    N.to_main(d)
    N.key_to(d, "f4", "CHANGE / VIEW")
    N.key_to(d, "f2", "RADIO-WIDE")
    for _ in range(6):
        d.send_keys("f7"); time.sleep(1.2)
        if "ZONE NAME LIST" in scr(d):
            return True
        d.send_keys("tab"); time.sleep(0.8)
        if "ZONE NAME LIST" in scr(d):
            return True
    raise RuntimeError("no ZONE NAME LIST")


def main():
    sandbox_c, workdir, nz = sys.argv[1], sys.argv[2], int(sys.argv[3])
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        N.boot_and_get(d); print("booted+GET ok")
        to_zone_names(d)
        d.send_keys("f2"); time.sleep(1.2)       # MODE LIST (zone 1)
        for z in range(1, nz + 1):
            # read all pages of the current zone
            seen = set()
            for _ in range(8):
                s = scr(d)
                print(f"\n@@@@@ ZONE {z} PAGE @@@@@")
                print(s)
                import re
                m = re.search(r"Page = (\d+) of (\d+)", s)
                if m and m.group(1) == m.group(2):
                    break
                d.send_keys("pgdn"); time.sleep(0.6)
            if z < nz:
                d.send_keys("f4"); time.sleep(1.0)   # NEXT ZONE
                # back to page 1
                for _ in range(6):
                    d.send_keys("pgup"); time.sleep(0.2)


if __name__ == "__main__":
    main()
