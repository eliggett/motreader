#!/usr/bin/env python3
"""Recon an RSS screen reached by a key path from MAIN MENU: dump it, then TAB
through its fields reporting which cell run is highlighted at each stop (the
active field), plus any sub-screens reached by the listed F-keys.

Usage: scenario_rw_recon.py <sandbox_c> <workdir> <path> [tabs] [fkeys]
  <path>   comma-separated keys from MAIN, e.g. "f4,f2" (RADIO-WIDE)
  [tabs]   how many TABs to walk (default 30)
  [fkeys]  comma-separated F-keys to probe from the screen (default none);
           '+' chains keys, e.g. f9+f7
"""
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
    return rows or []


def highlighted(d):
    """(row, col, text) runs whose attr differs from the screen's dominant attr
    on that row and looks like an inverse/selected field."""
    rows, attrs = d.read_screen(attrs=True)
    out = []
    if not rows or not attrs:
        return out
    # attr rows are 2 hex chars per cell; the active field is inverse (0x70)
    for y, (r, a) in enumerate(zip(rows, attrs)):
        if y > 21:
            continue
        cells = [a[i:i+2] for i in range(0, len(a), 2)]
        x = 0
        while x < len(cells):
            if cells[x] == "70":
                x0 = x
                while x < len(cells) and cells[x] == "70":
                    x += 1
                out.append((y, r[x0:x], r.rstrip()))
            else:
                x += 1
    return out


def goto(d, path):
    N.to_main(d)
    for k in path:
        d.send_keys(k)
        time.sleep(1.2)


def main():
    sandbox_c, workdir, path = sys.argv[1:4]
    tabs = int(sys.argv[4]) if len(sys.argv) > 4 else 30
    fkeys = sys.argv[5].split(",") if len(sys.argv) > 5 and sys.argv[5] else []
    path = path.split(",")
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        N.boot_and_get(d)
        goto(d, path)
        base = dump(d, "SCREEN " + ",".join(path))
        rows, attrs = d.read_screen(attrs=True)
        print("\n----- attrs -----")
        for a in attrs or []:
            print("  |" + a)
        prev = None
        for t in range(tabs):
            hl = highlighted(d)
            cur = d.read_screen()[0] or []
            chg = [(i, r.rstrip()) for i, (r, b) in enumerate(zip(cur, base)) if r != b]
            print(f"tab#{t}: hl={hl}")
            for i, r in chg:
                print(f"      changed row {i}: {r}")
            d.send_keys("tab")
            time.sleep(0.5)
        for fk in fkeys:
            goto(d, path)
            for k in fk.split("+"):     # "f9+f7" = a sub-sub-screen
                d.send_keys(k)
                time.sleep(1.5)
            dump(d, f"{','.join(path)} -> {fk.upper()}")


if __name__ == "__main__":
    main()
