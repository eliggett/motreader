#!/usr/bin/env python3
"""Map every toggleable field on one RSS MODE sub-screen to its on-disk bytes,
driving an already-running harness dosbox-x over its control socket.

Discovers the TAB field order, toggles each field once (DOWN), SAVEs, diffs the
decrypted body vs a baseline (noise subtracted, checksum block annotated), then
reverts (UP). Non-editable fields ("Not Avail") are skipped.

Usage: scenario_map_screen.py <sock> <arch_dir> <workdir> <screen> [max_tabs]
  <screen> = opt1 | mode | util
Assumes RSS is freshly launched (will boot + GET the single sandbox radio).
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dbxctl import Dbx
import rss_nav as N
from field_diff import CHECKSUM_BLOCK, _body, _diff
from motreader import codeplug as C


def changed_lines(before, after):
    return [(i, a.strip(), b.strip()) for i, (a, b) in enumerate(zip(before, after)) if a != b]


def main():
    sock, arch_dir, workdir, screen = sys.argv[1:5]
    max_tabs = int(sys.argv[5]) if len(sys.argv) > 5 else 14
    d = Dbx(sock)
    N.boot_and_get(d)

    def rows(): return d.read_screen()[0] or []

    # baselines with identical nav context (enter screen, then save)
    N.enter_screen(d, screen); N.save(d, arch_dir, f"{workdir}/ms_b0.035")
    N.enter_screen(d, screen); N.save(d, arch_dir, f"{workdir}/ms_b1.035")
    b0 = _body(f"{workdir}/ms_b0.035"); b1 = _body(f"{workdir}/ms_b1.035")
    noise = _diff(b0, b1)
    # band-agnostic record offsets (VHF + 900) for annotation only
    cp0 = C.Codeplug.parse(b0)
    offs = [m.offset for m in cp0.modes]
    recs = offs or [0]
    stride = (offs[1] - offs[0]) if len(offs) > 1 else 26
    print(f"band={cp0.band} screen={screen}  noise={sorted(hex(i) for i in noise)}  "
          f"mode1@{recs[0]:#x} stride {stride}\n")

    seen = []
    for k in range(max_tabs):
        N.enter_screen(d, screen)
        for _ in range(k):
            d.send_keys("tab"); time.sleep(0.25)
        before = rows()
        d.send_keys("down"); time.sleep(0.4)
        after = rows()
        chg = changed_lines(before, after)
        if not chg:
            d.send_keys("up"); time.sleep(0.2)
            continue
        label = chg[0][2] or chg[0][1]
        if label in seen:
            print(f"tab#{k}: wrapped ({label!r}) -> stop"); d.send_keys("up"); break
        seen.append(label)
        N.save(d, arch_dir, f"{workdir}/ms_ed.035")
        edit = _body(f"{workdir}/ms_ed.035")
        field = _diff(b0, edit) - noise
        clean = sorted(field - CHECKSUM_BLOCK)
        inck = sorted(field & CHECKSUM_BLOCK)
        print(f"tab#{k}: {label!r}")
        for i in clean:
            if recs[0] <= i:
                m = (i - recs[0]) // stride + 1; off = (i - recs[0]) % stride
                rel = f"  mode{m} rec+{off}"
            else:
                rel = "  (global/header)"
            print(f"     body[{i:#06x}] {b0[i]:#04x}->{edit[i]:#04x} xor{b0[i]^edit[i]:08b}{rel}")
        if not clean:
            print(f"     (checksum-block only: {[hex(x) for x in inck]})")
        elif inck:
            print(f"     (+checksum touched: {[hex(x) for x in inck]})")
        # revert
        N.enter_screen(d, screen)
        for _ in range(k):
            d.send_keys("tab"); time.sleep(0.25)
        d.send_keys("up"); time.sleep(0.3)
    d.close()
    print("\ndone.")


if __name__ == "__main__":
    main()
