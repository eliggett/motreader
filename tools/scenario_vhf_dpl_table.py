#!/usr/bin/env python3
"""Build the VHF DPL-code table on 221AZN. Phase 1: set a mode's Rx SQUELCH TYPE
to `target` (DPL or INV.DPL) with a first code and SAVE (persist). Phase 2: cycle
the Rx CODE field, re-navigating each step, and record displayed code -> the Rx
DPL slot bytes (rec+17 hi, rec+18 lo). Prints a ready-to-paste dict.

Usage: scenario_vhf_dpl_table.py <serial> <sandbox_c> <workdir> <mode_num>
                                 [max_steps] [DPL|INV.DPL] [down|up]
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N
from field_diff import _body
from motreader import codeplug as C
from motreader.archive import Archive
from motreader.crypto import decrypt_body

RX_TYPE_TAB = 4


def boot(d):
    for _ in range(12):
        if "MAIN MENU" in N.scr(d):
            break
        d.send_keys("enter"); time.sleep(1.5)
    else:
        raise RuntimeError("no MAIN MENU")
    N.key_to(d, "f3", "GET / SAVE MENU"); d.send_keys("f3")
    if not N.wait_for(d, "RADIO SERIAL") and "WARNING" in N.scr(d):
        d.send_keys("f2"); N.wait_for(d, "RADIO SERIAL")
    d.send_keys("f8"); N.wait_for(d, "GET / SAVE MENU")


def to_mode(d, num):
    N.to_main(d)
    N.key_to(d, "f4", "CHANGE / VIEW CODEPLUG")
    N.key_to(d, "f5", "CONVENTIONAL MODE CONFIGURATION")
    d.send_keys("f2"); time.sleep(0.5)
    for ch in f"{num:03d}":
        d.send_keys(ch); time.sleep(0.15)
    d.send_keys("enter"); time.sleep(0.6)
    N.wait_for(d, f"MODE {num:03d}", tries=20)


def line(rows, label):
    for r in rows:
        if label in r:
            return r.split(label, 1)[1].strip(". ")
    return ""


def main():
    serial, sandbox_c, workdir, mode_s = sys.argv[1:5]
    num = int(mode_s)
    max_steps = int(sys.argv[5]) if len(sys.argv) > 5 else 95
    target = sys.argv[6] if len(sys.argv) > 6 else "DPL"
    direction = sys.argv[7] if len(sys.argv) > 7 else "down"
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        boot(d)
        cp0 = C.Codeplug.parse(decrypt_body(Archive.load(N.resolve_afile(arch_dir)).body))
        base = cp0.modes[num - 1].offset
        print(f"booted; mode{num}@{base:#x}  Rx DPL slot +17={base+17:#x} +18={base+18:#x}  "
              f"target={target}\n", flush=True)

        # Phase 1: make the mode persistently `target` with a first code.
        to_mode(d, num)
        for _ in range(RX_TYPE_TAB):
            d.send_keys("tab"); time.sleep(0.15)
        for _ in range(8):
            if line(d.read_screen()[0] or [], "Rx SQUELCH TYPE") == target:
                break
            d.send_keys("down"); time.sleep(0.4)
        else:
            print(f"could not set type {target}"); d.close(); return
        d.send_keys("tab"); time.sleep(0.3)           # -> Rx CODE
        d.send_keys("down"); time.sleep(0.4)          # Blank -> first code
        rows = d.read_screen()[0] or []
        print(f"phase1 set: Rx TYPE={line(rows,'Rx SQUELCH TYPE')!r} "
              f"CODE={line(rows,'Rx CODE')!r}", flush=True)
        N.save(d, arch_dir, f"{workdir}/vt_init.035")

        # find the Rx CODE field tab now that the type is DPL
        tab = None
        for k in range(14):
            to_mode(d, num)
            for _ in range(k):
                d.send_keys("tab"); time.sleep(0.2)
            pre = d.read_screen()[0] or []
            d.send_keys(direction); time.sleep(0.4)
            post = d.read_screen()[0] or []
            if (line(pre, "Rx CODE") != line(post, "Rx CODE")
                    and "DPL" in line(post, "Rx SQUELCH TYPE")):
                tab = k
                break
            d.send_keys("up" if direction == "down" else "down"); time.sleep(0.2)
        if tab is None:
            print("no Rx CODE field after setting DPL"); d.close(); return
        print(f"Rx CODE field tab#{tab}\n", flush=True)

        # Phase 2: cycle, re-navigating each step.
        table = {}
        first = None
        for step in range(max_steps):
            to_mode(d, num)
            for _ in range(tab):
                d.send_keys("tab"); time.sleep(0.2)
            d.send_keys(direction); time.sleep(0.4)
            rows = d.read_screen()[0] or []
            rxt = line(rows, "Rx SQUELCH TYPE")
            if "DPL" not in rxt:
                print(f"step {step}: type left DPL ({rxt}) -> stop"); break
            code = line(rows, "Rx CODE").strip()
            body = _body(N.save(d, arch_dir, f"{workdir}/vt_{step}.035"))
            hi, lo = body[base + 17], body[base + 18]
            print(f"  {rxt:>8} {code:>6}: {hi:#04x} {lo:#04x}", flush=True)
            if first is None:
                first = code
            elif code == first:
                print("  -> wrapped"); break
            table[code] = (hi, lo)
        d.close()

    print(f"\n# VHF {target}: code -> (hi@+17, lo@+18)")
    def okey(c):
        try:
            return int(c, 8)
        except ValueError:
            return 9999
    for code in sorted(table, key=okey):
        hi, lo = table[code]
        print(f'    "{code}": ({hi:#04x}, {lo:#04x}),')
    print(f"\n{len(table)} codes captured.")


if __name__ == "__main__":
    main()
