#!/usr/bin/env python3
"""Generic screen-field mapper for RSS radio-wide screens (the radio-wide
counterpart of scenario_enum_map.py): for each TAB stop on the screen reached by
<path> from MAIN MENU, step the field with DOWN (SAVE after every step) and
report the exact on-disk body bytes each displayed value produces.

Each step is diffed against the global double baseline (noise + the known
save-stamp block subtracted) AND against the previous step, so a field whose
change has side effects on other data is still readable. Cyclic fields revert
by wrapping; non-cyclic ones (numbers/timers) are undone with UP.

Usage: scenario_rw_map.py <serial> <sandbox_c> <workdir> <path> [max_tabs] [max_steps] [first_tab] [only_tabs]
  [only_tabs] comma-separated TAB indices to map (default: all)
  <path>  comma-separated keys from MAIN, e.g. f4,f2 (RADIO-WIDE) or f4,f2,f9
"""
import os, sys, time, glob, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N
from field_diff import CHECKSUM_BLOCK, _body, _diff
from scenario_enum_map import robust_boot, reget, changed_lines


def enter(d, path):
    N.to_main(d)
    for k in path:
        d.send_keys(k)
        time.sleep(1.0)
    time.sleep(0.5)


def active(d):
    """(row, text) of the inverse-video (attr 0x70) field = the active field."""
    y, line, _ = active_field(d)
    return y, line


def active_pos(d):
    """(row, col) of the inverse-video (attr 0x70) field, or (None, None)."""
    rows, attrs = d.read_screen(attrs=True)
    for y, a in enumerate(attrs or []):
        if y > 21:
            continue
        cells = [a[i:i+2] for i in range(0, len(a), 2)]
        if "70" in cells:
            return y, cells.index("70")
    return None, None


def active_field(d):
    """(row, row_text, field_text) where field_text is the inverse-video run."""
    rows, attrs = d.read_screen(attrs=True)
    for y, (r, a) in enumerate(zip(rows or [], attrs or [])):
        if y > 21:
            continue
        cells = [a[i:i+2] for i in range(0, len(a), 2)]
        if "70" in cells:
            x0 = cells.index("70")
            x1 = x0
            while x1 < len(cells) and cells[x1] == "70":
                x1 += 1
            return y, r.rstrip(), r[x0:x1].strip()
    return None, "", ""


def recover(d):
    """Back out of an unexpected prompt/dialog to MAIN MENU."""
    for k in ["esc", "f10", "f2", "f10", "esc", "f10", "f10"]:
        if "MAIN MENU" in N.scr(d):
            return True
        d.send_keys(k); time.sleep(0.8)
    return N.to_main(d)


def main():
    serial, sandbox_c, workdir, path = sys.argv[1:5]
    max_tabs = int(sys.argv[5]) if len(sys.argv) > 5 else 30
    max_steps = int(sys.argv[6]) if len(sys.argv) > 6 else 6
    first_tab = int(sys.argv[7]) if len(sys.argv) > 7 else 0
    only = {int(x) for x in sys.argv[8].split(",")} if len(sys.argv) > 8 else None
    path = path.split(",")
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)

    def nav(k):
        enter(d, path)
        for _ in range(k):
            d.send_keys("tab"); time.sleep(0.25)
        time.sleep(0.3)

    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        print(f"booted + GET ok; path={path}\n", flush=True)
        enter(d, path); N.save(d, arch_dir, f"{workdir}/b0.bin")
        enter(d, path); N.save(d, arch_dir, f"{workdir}/b1.bin")
        b0 = _body(f"{workdir}/b0.bin"); b1 = _body(f"{workdir}/b1.bin")
        noise = _diff(b0, b1) | CHECKSUM_BLOCK

        def fmt(ref, body, offs):
            return "  ".join(f"{i:#06x}:{ref[i]:02x}->{body[i]:02x}" for i in offs)

        seen_rows = []
        for k in range(first_tab, max_tabs):
            if only is not None and k not in only:
                continue
            nav(k)
            row, line = active(d)
            if row is None:
                print(f"tab#{k}: no active field"); continue
            # wrap = back at the first field's (row, column); two fields can
            # share a row (left/right columns), so the row alone is not enough
            pos = active_pos(d)
            if seen_rows and pos == seen_rows[0]:
                print(f"tab#{k}: wrapped to first field -> stop"); break
            seen_rows.append(pos)
            orig = line
            orig_field = active_field(d)[2]
            print(f"tab#{k}: row {row}: {orig.strip()}", flush=True)
            prev = b0
            steps = 0
            wrapped = False
            key, back = "down", "up"
            for step in range(max_steps):
                pre = d.read_screen()[0] or []
                d.send_keys(key); time.sleep(0.5)
                post = d.read_screen()[0] or []
                msg = " ".join(r for r in post[:4])
                if step == 0 and ("MINIMUM" in msg or "MAXIMUM" in msg):
                    key, back = back, key        # at a limit: step the other way
                    d.send_keys(key); time.sleep(0.5)
                    post = d.read_screen()[0] or []
                ptxt = "\n".join(post)
                if "CONTINUE" in ptxt and "ABORT" in ptxt:
                    if "zone lists" in ptxt.lower():
                        # "Disabling zone mode will clear all zone lists": destructive
                        d.send_keys("f10"); time.sleep(0.5)
                        print("    (destructive confirm dialog -> aborted; not mapped)")
                        break
                    d.send_keys("f2"); time.sleep(0.8)   # "apply to all modes" confirm
                    post = d.read_screen()[0] or []
                chg = [c for c in changed_lines(pre, post) if c[0] == row or c[0] > 3]
                if not chg:
                    print(f"    ({key.upper()} changes nothing: not editable) {msg.strip()[-60:]}")
                    break
                steps += 1
                newval = ((post + [""] * 25)[row]).rstrip()
                try:
                    body = _body(N.save(d, arch_dir, f"{workdir}/t{k}_s{step}.bin"))
                except RuntimeError as e:
                    print(f"    !! save failed after DOWN ({newval.strip()}): {str(e).splitlines()[0]}")
                    print("    !! screen:\n" + "\n".join("       |" + r.rstrip()
                          for r in (d.read_screen()[0] or []) if r.strip()))
                    recover(d)
                    break
                vb = sorted(_diff(b0, body) - noise)
                vp = sorted(_diff(prev, body) - noise)
                print(f"    -> {newval.strip()}")
                print(f"       vs base: {fmt(b0, body, vb) or '(none)'}")
                if vp != vb:
                    print(f"       vs prev: {fmt(prev, body, vp) or '(none)'}")
                other = [c for c in chg if c[0] != row]
                for c in other:
                    print(f"       (also screen row {c[0]}: {c[2].strip()})")
                prev = body
                nav(k)
                if active_field(d)[2] == orig_field:
                    wrapped = True
                    print("       (wrapped to original)")
                    break
            if steps and not wrapped:
                nav(k)
                for _ in range(steps):
                    d.send_keys(back); time.sleep(0.25)
                cur = ((d.read_screen()[0] or []) + [""] * 25)[row].rstrip()
                print(f"    undo -> {cur.strip()}")
            print(flush=True)
        d.close()
    print("done.")


if __name__ == "__main__":
    main()
