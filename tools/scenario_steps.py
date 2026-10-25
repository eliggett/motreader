#!/usr/bin/env python3
"""Drive RSS through an ad-hoc list of steps (boot + GET first) for quick
experiments: navigate, type, dump the screen, SAVE the codeplug.

Usage: scenario_steps.py <sandbox_c> <workdir> <step> [<step> ...]
  main             go to MAIN MENU
  k:<keys>         send keys (space-separated dbxctl tokens, e.g. k:f4 f3 f7)
  t:<text>         type literal text (spaces become the 'space' key)
  dump             print the screen (with the active/inverse field)
  save:<name>      SAVE the working codeplug, copy to <workdir>/<name>.bin
  sleep:<s>        wait
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from scenario_rw_map import active_field


def dump(d, label):
    rows = d.read_screen()[0] or []
    y, _, fld = active_field(d)
    print(f"===== {label}   [active row {y}: {fld!r}]")
    for r in rows:
        if r.rstrip():
            print("  |" + r.rstrip())
    sys.stdout.flush()


def main():
    sandbox_c, workdir = sys.argv[1:3]
    steps = sys.argv[3:]
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        for st in steps:
            op, _, arg = st.partition(":")
            if op == "main":
                N.to_main(d)
            elif op == "k":
                for tok in arg.split():
                    d.send_keys(tok); time.sleep(0.6)
                time.sleep(0.6)
            elif op == "t":
                for ch in arg:
                    d.send_keys("space" if ch == " " else ch); time.sleep(0.15)
                time.sleep(0.4)
            elif op == "dump":
                dump(d, arg or "screen")
            elif op == "save":
                N.save(d, arch_dir, os.path.join(workdir, arg + ".bin"))
                print(f"saved {arg}", flush=True)
            elif op == "sleep":
                time.sleep(float(arg))
            else:
                raise SystemExit(f"bad step {st!r}")
        d.close()


if __name__ == "__main__":
    main()
