#!/usr/bin/env python3
"""Differential: ADD a zone and diff the body to find the zone-COUNT byte and
how the name/flag/membership arrays grow. Usage:
  scenario_zone_addcount.py <sandbox_c> <workdir> <archive_A_file>
"""
import sys, os, time
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from field_diff import FieldMapper, _body, _diff, CHECKSUM_BLOCK
import rss_nav as N


def to_zone_names(fm):
    fm.to_main()
    fm.go("f4", "CHANGE / VIEW")
    fm.go("f2", "RADIO-WIDE")
    for _ in range(5):
        fm.d.send_keys("f7"); time.sleep(1.2)
        if "ZONE NAME LIST" in fm.scr():
            return True
        fm.d.send_keys("tab"); time.sleep(0.8)
        if "ZONE NAME LIST" in fm.scr():
            return True
    raise RuntimeError("could not reach ZONE NAME LIST:\n" + fm.scr())


def add_zone(fm):
    to_zone_names(fm)
    print("--- ZONE NAME LIST before ADD ---"); print(fm.scr())
    fm.d.send_keys("f3"); time.sleep(1.2)       # ADD ZONE
    print("--- after F3 ADD ZONE ---"); print(fm.scr())
    # the "Add Zone At Position" field: type a position at the end (13) + enter
    fm.d.send_keys("1"); fm.d.send_keys("3"); time.sleep(0.4)
    fm.d.send_keys("enter"); time.sleep(1.0)
    print("--- after type 13 + ENTER ---"); print(fm.scr())


def main():
    sandbox_c, workdir, arch = sys.argv[1:4]
    with FieldMapper(sandbox_c, workdir, arch) as fm:
        out = fm.map_field(add_zone, "ADD ZONE (count)", exclude_checksum=True)
        # print changed bytes grouped by region
        print("\nchanged byte offsets:", [hex(i) for i,_,_,_ in out])


if __name__ == "__main__":
    main()
