#!/usr/bin/env python3
"""Validate an archive written by motreader (Python or the web app) in real
RSS: GET it noting any warning RSS raises, show the screens that should
display the edits, then SAVE it so the re-saved codeplug can be compared
byte for byte with what motreader wrote (see tools/compare_resave.py).

Usage: scenario_validate_export.py <sandbox_c> <workdir> [options]
  --modes 2,3        mode numbers whose MODE screen (and OPT1) to dump
  --paths "f4,f2;f4,f3"   radio-wide key paths from MAIN MENU to dump
  --zones            dump the ZONE NAME LIST
Build the sandbox first with tools/mk_single_sandbox.py <serial> <sandbox_c> <archive>.
Writes <workdir>/resaved.bin (the archive file RSS saved) and prints the screens.
"""
import argparse, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot
from scenario_rw_gt import get_noting_warnings
from scenario_zone_validate import to_zone_names


def dump(d, label):
    rows = d.read_screen()[0] or []
    print(f"===== {label}")
    for r in rows:
        if r.rstrip():
            print("  |" + r.rstrip())
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sandbox_c")
    ap.add_argument("workdir")
    ap.add_argument("--modes", default="")
    ap.add_argument("--paths", default="")
    ap.add_argument("--zones", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)
    arch_dir = os.path.join(a.sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    with Harness(a.sandbox_c, a.workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        warnings = get_noting_warnings(d)
        print("GET warnings:", warnings or "none", flush=True)
        for n in [int(x) for x in a.modes.split(",") if x]:
            N.to_main(d)
            N.key_to(d, "f4", "CHANGE / VIEW")
            N.key_to(d, "f5", "MODE CONFIGURATION")
            for _ in range(n - 1):                 # F4 = next mode
                d.send_keys("f4"); time.sleep(0.9)
            time.sleep(0.6)
            dump(d, f"MODE {n}")
            d.send_keys("f7"); time.sleep(1.2)
            dump(d, f"MODE {n} OPTIONS")
        for p in [x for x in a.paths.split(";") if x]:
            N.to_main(d)
            for k in p.split(","):
                d.send_keys(k); time.sleep(1.2)
            time.sleep(0.6)
            dump(d, p)
        if a.zones:
            to_zone_names(d)
            dump(d, "ZONE NAME LIST")
        N.to_main(d)
        N.save(d, arch_dir, os.path.join(a.workdir, "resaved.bin"))
        print("saved resaved.bin", flush=True)
        d.close()


if __name__ == "__main__":
    main()
