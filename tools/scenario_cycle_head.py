#!/usr/bin/env python3
"""Cycle RADIO-WIDE OPTIONS -> Control Head Type through every value RSS offers,
accepting its confirm dialogs (their text is recorded) and SAVING after each
value, plus the CONTROL HEAD OPTIONS screen (F4 F6 F9) for each head.

Usage: scenario_cycle_head.py <serial> <sandbox_c> <workdir> [max_values] [up|down]
Writes <workdir>/head<i>.bin and <workdir>/heads.json.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from scenario_rw_map import active_field

HEADS = ("Standard", "Enhanced", "Rotary", "S9000e", "Remote", "W", "Dual", "Basic")


def to_field(d):
    """From MAIN: open RADIO-WIDE OPTIONS and TAB to Control Head Type."""
    N.to_main(d)
    for k in ("f4", "f2", "f9"):
        d.send_keys(k); time.sleep(1.0)
    for _ in range(25):
        _, row, fld = active_field(d)
        if fld and row.find(fld) > 0 and row[:row.find(fld)].strip().startswith("Control Head Type") \
                and "Internal PA" not in row[:row.find(fld)]:
            return fld
        d.send_keys("tab"); time.sleep(0.3)
    raise RuntimeError("Control Head Type not reachable:\n" + N.scr(d))


def screen_rows(d):
    return [r.rstrip() for r in (d.read_screen()[0] or [])]


def main():
    serial, sandbox_c, workdir = sys.argv[1:4]
    max_values = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    step_key = sys.argv[5] if len(sys.argv) > 5 else "down"
    arch = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)
    out = []
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        N.save(d, arch, os.path.join(workdir, "head0.bin"))
        first = to_field(d)
        print("start:", first, flush=True)
        N.to_main(d)
        for k in ("f4", "f6", "f9"):
            d.send_keys(k); time.sleep(1.0)
        out.append({"value": first, "dialogs": [], "options": screen_rows(d)})
        for i in range(1, max_values + 1):
            to_field(d)
            d.send_keys(step_key); time.sleep(0.8)
            dialogs = []
            for _ in range(4):                      # accept any confirm dialogs
                s = "\n".join(screen_rows(d))
                if "CONTINUE" in s or "F2" in s and "WARNING" in s:
                    dialogs.append([r for r in screen_rows(d)[8:20] if r.strip()])
                    d.send_keys("f2"); time.sleep(1.0)
                else:
                    break
            _, row, val = active_field(d)
            print(f"value {i}: {val!r} dialogs={len(dialogs)}", flush=True)
            for dl in dialogs:
                print("   dialog:", " | ".join(x.strip() for x in dl))
            N.save(d, arch, os.path.join(workdir, f"head{i}.bin"))
            N.to_main(d)
            for k in ("f4", "f6", "f9"):
                d.send_keys(k); time.sleep(1.0)
            out.append({"value": val, "dialogs": dialogs, "options": screen_rows(d)})
            if val == first:
                break
        d.close()
    with open(os.path.join(workdir, "heads.json"), "w") as f:
        json.dump(out, f, indent=1)
    print("done", [o["value"] for o in out])


if __name__ == "__main__":
    main()
