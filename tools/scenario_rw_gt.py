#!/usr/bin/env python3
"""Capture RSS ground truth for the radio-wide screens: boot + GET one radio,
then visit each key path from MAIN MENU and save the screen text. The result
(JSON: {path: [rows]}) is what motreader's radio-wide decode is validated
against (tests/test_radiowide.py via notes/ground-truth/rw_<serial>.json).

Usage: scenario_rw_gt.py <serial> <sandbox_c> <workdir> <out.json> [paths]
  [paths] ';'-separated comma key paths (default: all radio-wide screens)
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot


def get_noting_warnings(d):
    """GET the selected archive; return any warning text RSS shows on the way
    (e.g. a bad-checksum prompt), dismissing it with F2 CONTINUE."""
    warnings = []
    N.to_main(d)
    if not N.key_to(d, "f3", "GET / SAVE MENU"):
        raise RuntimeError("no GET/SAVE")
    d.send_keys("f3")
    if not N.wait_for(d, "RADIO SERIAL"):
        raise RuntimeError("no archive list:\n" + N.scr(d))
    d.send_keys("f8")
    for _ in range(6):
        if N.wait_for(d, "GET / SAVE MENU", tries=25):
            break
        s = N.scr(d)
        warnings.append("\n".join(l.strip() for l in s.splitlines()[2:22] if l.strip()))
        d.send_keys("f2")
    if "GET / SAVE MENU" not in N.scr(d):
        raise RuntimeError("GET did not complete:\n" + N.scr(d))
    return warnings

DEFAULT_PATHS = [
    "f4,f2",            # RADIO-WIDE
    "f4,f2,f9",         # RADIO-WIDE OPTIONS
    "f4,f2,f6",         # SCAN OPTIONS
    "f4,f3",            # CONVENTIONAL
    "f4,f3,f2",         # DTMF OPTIONS
    "f4,f3,f3",         # MDC OPTIONS
    "f4,f3,f6",         # MPL LIST
    "f4,f3,f7",         # PHONE LIST
    "f4,f3,f8",         # SINGLE TONE LIST
    "f4,f6,f9",         # CONTROL HEAD OPTIONS
]


def main():
    serial, sandbox_c, workdir, out = sys.argv[1:5]
    paths = sys.argv[5].split(";") if len(sys.argv) > 5 else DEFAULT_PATHS
    res = {}
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        warnings = get_noting_warnings(d)
        print("GET warnings:", warnings or "none", flush=True)
        for p in paths:
            N.to_main(d)
            for k in p.split(","):
                d.send_keys(k)
                time.sleep(1.2)
            time.sleep(0.8)
            rows = [r.rstrip() for r in (d.read_screen()[0] or [])]
            res[p] = rows
            print(f"== {p}\n" + "\n".join("  |" + r for r in rows if r), flush=True)
        d.close()
    with open(out, "w") as f:
        json.dump({"serial": serial, "get_warnings": warnings, "screens": res}, f, indent=1)
    print("wrote", out)


if __name__ == "__main__":
    main()
