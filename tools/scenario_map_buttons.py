#!/usr/bin/env python3
"""Map CONTROL HEAD KEYPAD buttons to their codeplug storage: for each TAB stop,
note which button cell is highlighted (screen row/col + its caption), step it
once with DOWN, leave the screen (accepting RSS's "Duplicate Buttons!" F2) and
SAVE. Diffing consecutive saves gives button -> bytes.

Usage: scenario_map_buttons.py <serial> <sandbox_c> <workdir> [max_tabs]
Writes <workdir>/b<k>.bin (after stepping TAB stop k), base.bin, buttons.json.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from scenario_rw_map import active_pos, active_field
from scenario_cycle_button import open_keypad, leave


def caption(rows, y, x):
    """Button caption: the header text right above the highlighted cell."""
    for yy in range(y - 1, max(y - 4, 0), -1):
        seg = rows[yy][max(0, x - 2):x + 8].strip()
        if seg:
            return seg
    return "?"


def main():
    serial, sandbox_c, workdir = sys.argv[1:4]
    mx = int(sys.argv[4]) if len(sys.argv) > 4 else 30
    arch = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)
    out = []
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        N.save(d, arch, os.path.join(workdir, "base.bin"))
        first = None
        for k in range(mx):
            open_keypad(d, k)
            pos = active_pos(d)
            rows = d.read_screen()[0] or []
            if first is None:
                first = pos
            elif pos == first:
                print(f"tab {k}: wrapped", flush=True)
                N.to_main(d)
                break
            cap = caption(rows, pos[0], pos[1]) if pos[0] is not None else "?"
            before = active_field(d)[2]
            d.send_keys("down"); time.sleep(0.6)
            after = active_field(d)[2]
            dup = leave(d)
            N.save(d, arch, os.path.join(workdir, f"b{k}.bin"))
            out.append({"tab": k, "pos": pos, "caption": cap, "before": before,
                        "after": after, "dup": dup})
            print(f"tab {k}: pos={pos} [{cap}] {before!r} -> {after!r}{' dup' if dup else ''}", flush=True)
            with open(os.path.join(workdir, "buttons.json"), "w") as f:
                json.dump(out, f, indent=1)
        d.close()
    print("done")


if __name__ == "__main__":
    main()
