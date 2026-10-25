#!/usr/bin/env python3
"""Build the empirical 900 DPL-code table: on a DPL mode, cycle the Rx CODE field
through every value and record (displayed octal code -> the 2 encoding bytes at
mode+25 and mode+26). Stops when the code wraps. Prints a ready-to-paste dict.

Usage: scenario_dpl_table.py <serial> <sandbox_c> <workdir> <mode_num> [max_steps]
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


def find_rx_code_tab(d, num):
    for k in range(14):
        to_mode(d, num)
        for _ in range(k):
            d.send_keys("tab"); time.sleep(0.2)
        pre = d.read_screen()[0] or []
        d.send_keys("down"); time.sleep(0.4)
        post = d.read_screen()[0] or []
        if (line(pre, "Rx CODE") != line(post, "Rx CODE")
                and "DPL" in line(post, "Rx SQUELCH TYPE")):
            d.send_keys("up"); time.sleep(0.2)
            return k
        d.send_keys("up"); time.sleep(0.2)
    return None


def main():
    serial, sandbox_c, workdir, mode_s = sys.argv[1:5]
    num = int(mode_s)
    max_steps = int(sys.argv[5]) if len(sys.argv) > 5 else 95
    direction = sys.argv[6] if len(sys.argv) > 6 else "down"  # "up" | "down"
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        boot(d)
        cp0 = C.Codeplug.parse(decrypt_body(Archive.load(N.resolve_afile(arch_dir)).body))
        base = cp0.modes[num - 1].offset
        print(f"booted; mode{num}@{base:#x}  code bytes at +25={base+25:#x} +26={base+26:#x}\n",
              flush=True)
        tab = find_rx_code_tab(d, num)
        if tab is None:
            print("no Rx CODE field"); d.close(); return
        print(f"Rx CODE field tab#{tab}\n", flush=True)

        table = {}   # code -> (b25, b26)
        first = None
        for step in range(max_steps):
            to_mode(d, num)
            for _ in range(tab):
                d.send_keys("tab"); time.sleep(0.2)
            d.send_keys(direction); time.sleep(0.4)
            rows = d.read_screen()[0] or []
            if "DPL" not in line(rows, "Rx SQUELCH TYPE"):
                print(f"step {step}: type left DPL ({line(rows,'Rx SQUELCH TYPE')}) -> stop")
                break
            code = line(rows, "Rx CODE").strip()
            body = _body(N.save(d, arch_dir, f"{workdir}/dt_{step}.035"))
            b25, b26 = body[base + 25], body[base + 26]
            print(f"  {code:>4}: {b25:#04x} {b26:#04x}", flush=True)
            if first is None:
                first = code
            elif code == first:
                print("  -> wrapped"); break
            table[code] = (b25, b26)
        d.close()
    print("\n# code -> (b25,b26)")
    def okey(c):
        try:
            return int(c, 8)
        except ValueError:
            return 9999
    for code in sorted(table, key=okey):
        b25, b26 = table[code]
        print(f'    "{code}": ({b25:#04x}, {b26:#04x}),')
    print(f"\n{len(table)} codes captured.")


if __name__ == "__main__":
    main()
