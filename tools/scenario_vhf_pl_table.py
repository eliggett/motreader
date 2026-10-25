#!/usr/bin/env python3
"""Sweep the VHF PL (CTCSS) CODE field on 221AZN and record displayed tone ->
exact slot bytes, for the Rx slot (rec+17/18, freq-linear form) or the Tx slot
(rec+19/20, period form). Authoritative check of the encode formula across the
whole CTCSS range. Prints a ready-to-paste dict.

Usage: scenario_vhf_pl_table.py <serial> <sandbox_c> <workdir> <mode_num>
                                [max_steps] [Rx|Tx] [down|up]
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

TYPE_TAB = {"Rx": 4, "Tx": 6}      # SQUELCH TYPE tab stop per side
SLOT_OFF = {"Rx": 17, "Tx": 19}    # tone slot byte offset per side


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
    max_steps = int(sys.argv[5]) if len(sys.argv) > 5 else 60
    which = sys.argv[6] if len(sys.argv) > 6 else "Rx"
    direction = sys.argv[7] if len(sys.argv) > 7 else "down"
    type_lbl, code_lbl = f"{which} SQUELCH TYPE", f"{which} CODE"
    if which == "Tx":
        type_lbl, code_lbl = "Tx SQUELCH TYPE", "Tx CODE"
    type_tab, off = TYPE_TAB[which], SLOT_OFF[which]
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        boot(d)
        cp0 = C.Codeplug.parse(decrypt_body(Archive.load(N.resolve_afile(arch_dir)).body))
        base = cp0.modes[num - 1].offset
        print(f"booted; mode{num}@{base:#x} {which} slot +{off}/{off+1}\n", flush=True)

        # Phase 1: set {which} SQUELCH TYPE = TPL, first code, persist.
        # Auto-locate the SQUELCH TYPE field (its tab shifts when a CODE line
        # appears), by probing for the tab where DOWN changes that line.
        type_tab = None
        for k in range(12):
            to_mode(d, num)
            for _ in range(k):
                d.send_keys("tab"); time.sleep(0.15)
            pre = d.read_screen()[0] or []
            d.send_keys("down"); time.sleep(0.4)
            post = d.read_screen()[0] or []
            if line(pre, type_lbl) != line(post, type_lbl):
                type_tab = k
                d.send_keys("up"); time.sleep(0.2)    # revert the probe
                break
            d.send_keys("up"); time.sleep(0.2)
        if type_tab is None:
            print(f"could not locate {type_lbl} field"); d.close(); return
        print(f"{type_lbl} field tab#{type_tab}", flush=True)
        to_mode(d, num)
        for _ in range(type_tab):
            d.send_keys("tab"); time.sleep(0.15)
        for _ in range(8):
            if line(d.read_screen()[0] or [], type_lbl) == "TPL":
                break
            d.send_keys("down"); time.sleep(0.4)
        else:
            print("could not set TPL"); d.close(); return
        d.send_keys("tab"); time.sleep(0.3)           # -> CODE
        d.send_keys("down"); time.sleep(0.4)
        rows = d.read_screen()[0] or []
        print(f"phase1: {type_lbl}={line(rows,type_lbl)!r} {code_lbl}={line(rows,code_lbl)!r}",
              flush=True)
        N.save(d, arch_dir, f"{workdir}/pt_init.035")

        # find the CODE field tab
        tab = None
        for k in range(14):
            to_mode(d, num)
            for _ in range(k):
                d.send_keys("tab"); time.sleep(0.2)
            pre = d.read_screen()[0] or []
            d.send_keys(direction); time.sleep(0.4)
            post = d.read_screen()[0] or []
            if (line(pre, code_lbl) != line(post, code_lbl)
                    and line(post, type_lbl) == "TPL"):
                tab = k
                break
            d.send_keys("up" if direction == "down" else "down"); time.sleep(0.2)
        if tab is None:
            print("no CODE field"); d.close(); return
        print(f"{code_lbl} field tab#{tab}\n", flush=True)

        # Phase 2: cycle, re-navigating each step.
        table = {}
        first = None
        for step in range(max_steps):
            to_mode(d, num)
            for _ in range(tab):
                d.send_keys("tab"); time.sleep(0.2)
            d.send_keys(direction); time.sleep(0.4)
            rows = d.read_screen()[0] or []
            if line(rows, type_lbl) != "TPL":
                print(f"step {step}: type left PL -> stop"); break
            code = line(rows, code_lbl).strip()
            body = _body(N.save(d, arch_dir, f"{workdir}/pt_{step}.035"))
            hi, lo = body[base + off], body[base + off + 1]
            print(f"  {code:>8}: {hi:#04x} {lo:#04x}  (low15={((hi<<8|lo)&0x7fff)})",
                  flush=True)
            if first is None:
                first = code
            elif code == first:
                print("  -> wrapped"); break
            table[code] = (hi, lo)
        d.close()

    print(f"\n# VHF PL {which}: tone -> (hi, lo)")
    def tkey(c):
        try:
            return float(c)
        except ValueError:
            return 9999.0
    for code in sorted(table, key=tkey):
        hi, lo = table[code]
        print(f'    "{code}": ({hi:#04x}, {lo:#04x}),')
    print(f"\n{len(table)} tones captured.")


if __name__ == "__main__":
    main()
