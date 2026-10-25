#!/usr/bin/env python3
"""ADD-zone differential using robust rss_nav (answers the 'not saved' warning,
verifies save landed). Finds the zone-count byte + array growth.
Usage: scenario_zone_addcount2.py <sandbox_c> <workdir>"""
import sys, os, time
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from trace_lib import Harness
import rss_nav as N
from field_diff import _body, _diff, CHECKSUM_BLOCK


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
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        N.boot_and_get(d); print("booted+GET ok")
        b0 = N.save(d, arch_dir, os.path.join(workdir, "z_b0"))
        b1 = N.save(d, arch_dir, os.path.join(workdir, "z_b1"))
        # add a zone at position 13
        to_zone_names(d)
        d.send_keys("f3"); time.sleep(1.0)       # ADD ZONE
        d.send_keys("1"); d.send_keys("3"); time.sleep(0.4)
        d.send_keys("enter"); time.sleep(1.0)
        print("--- after ADD 13 ---"); print(N.scr(d))
        b2 = N.save(d, arch_dir, os.path.join(workdir, "z_b2"))
        base, basen, edit = _body(b0), _body(b1), _body(b2)
        noise = _diff(base, basen)
        field = sorted(_diff(base, edit) - noise - CHECKSUM_BLOCK)
        print(f"\nnoise bytes: {len(noise)}  changed(add-zone): {len(field)}")
        for i in field:
            print(f"  body[{i:#06x}] {base[i]:#04x} -> {edit[i]:#04x}")
        print("len base/edit:", len(base), len(edit))


if __name__ == "__main__":
    main()
