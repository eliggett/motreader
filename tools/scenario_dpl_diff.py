#!/usr/bin/env python3
"""Find the 900 DPL-code bytes by a harness differential: on a DPL mode, locate
the 'Rx CODE' field (the one whose DOWN changes the Rx code while the Rx SQUELCH
TYPE stays 'DPL' -- so no type-change cascade), then cycle it a few steps, SAVE
each, and diff the decrypted body. Prints displayed code -> changed bytes.

Usage: scenario_dpl_diff.py <serial> <sandbox_c> <workdir> <mode_num> [max_steps]
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N
from field_diff import CHECKSUM_BLOCK, _body, _diff
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


def main():
    serial, sandbox_c, workdir, mode_s = sys.argv[1:5]
    mode_num = int(mode_s)
    max_steps = int(sys.argv[5]) if len(sys.argv) > 5 else 6
    which = sys.argv[6] if len(sys.argv) > 6 else "Rx"   # "Rx" | "Tx"
    code_lbl, type_lbl = f"{which} CODE", f"{which} SQUELCH TYPE"
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        boot(d)
        print(f"booted + GET ok; probing mode {mode_num}\n", flush=True)

        # record offset for annotation
        cp0 = C.Codeplug.parse(decrypt_body(Archive.load(N.resolve_afile(arch_dir)).body))
        base = cp0.modes[mode_num - 1].offset
        stride = cp0.modes[1].offset - cp0.modes[0].offset
        print(f"mode{mode_num}@{base:#x} stride {stride}\n", flush=True)

        # double baseline for noise
        to_mode(d, mode_num); N.save(d, arch_dir, f"{workdir}/dd_b0.035")
        to_mode(d, mode_num); N.save(d, arch_dir, f"{workdir}/dd_b1.035")
        b0 = _body(f"{workdir}/dd_b0.035"); b1 = _body(f"{workdir}/dd_b1.035")
        noise = _diff(b0, b1)

        # find the Rx CODE field: TAB until DOWN changes 'Rx CODE' while
        # 'Rx SQUELCH TYPE' stays the same.
        to_mode(d, mode_num)
        rx_code_tab = None
        for k in range(14):
            to_mode(d, mode_num)
            for _ in range(k):
                d.send_keys("tab"); time.sleep(0.2)
            pre = d.read_screen()[0] or []
            d.send_keys("down"); time.sleep(0.4)
            post = d.read_screen()[0] or []
            if (line(pre, code_lbl) != line(post, code_lbl)
                    and line(pre, type_lbl) == line(post, type_lbl)
                    and "DPL" in line(post, type_lbl)):
                rx_code_tab = k
                print(f"{code_lbl} field at tab#{k}; "
                      f"{line(pre,code_lbl)!r} -> {line(post,code_lbl)!r}", flush=True)
                break
            # revert this probe
            d.send_keys("up"); time.sleep(0.2)
        if rx_code_tab is None:
            print(f"could not locate {code_lbl} field"); d.close(); return

        # cycle the Rx CODE field, saving + diffing each step. Also read mode
        # (mode_num+1) back to see whether its displayed Rx code is disturbed
        # (i.e. whether the changed bytes really belong to the next mode).
        lo, hi = base + 20, base + 26 + 16   # dump mode_num+20 .. next+16
        print(f"\nstep: Rx CODE -> changed bytes; raw[{lo:#x}:{hi:#x}]; next-mode code")
        for step in range(max_steps):
            to_mode(d, mode_num)
            for _ in range(rx_code_tab):
                d.send_keys("tab"); time.sleep(0.2)
            d.send_keys("down"); time.sleep(0.4)
            rows = d.read_screen()[0] or []
            code = line(rows, code_lbl); typ = line(rows, type_lbl)
            body = _body(N.save(d, arch_dir, f"{workdir}/dd_s{step}.035"))
            field = sorted((_diff(b0, body) - noise) - CHECKSUM_BLOCK)
            ann = " ".join(f"{i:#x}:{b0[i]:#04x}->{body[i]:#04x}" for i in field)
            raw = body[lo:hi].hex()
            # read next mode's displayed code
            to_mode(d, mode_num + 1)
            nrows = d.read_screen()[0] or []
            nxt = f"{line(nrows,'Rx SQUELCH TYPE')}/{line(nrows,'Rx CODE')}"
            print(f"  code={code:>10} changed[{ann}]  raw={raw}  next={nxt}", flush=True)
        d.close()
    print("done.")


if __name__ == "__main__":
    main()
