#!/usr/bin/env python3
"""VHF DPL differential on 221AZN. Set a mode's Rx SQUELCH TYPE to DPL (or
INV.DPL), then cycle the Rx CODE field, SAVE + decrypt-diff each step, and print
displayed code -> changed bytes. Locates the VHF DPL byte(s) and builds the
code<->bytes map in one pass.

Usage: scenario_vhf_dpl_diff.py <serial> <sandbox_c> <workdir> <mode_num>
                                [steps] [DPL|INV.DPL]
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

RX_TYPE_TAB = 4  # Rx SQUELCH TYPE is tab stop #4 on the VHF MODE screen


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


def set_rx_type(d, num, target):
    """From mode start, tab to Rx SQUELCH TYPE and cycle DOWN until it shows
    `target`. Leaves the cursor ON the Rx SQUELCH TYPE field."""
    to_mode(d, num)
    for _ in range(RX_TYPE_TAB):
        d.send_keys("tab"); time.sleep(0.15)
    for _ in range(8):
        rows = d.read_screen()[0] or []
        if line(rows, "Rx SQUELCH TYPE") == target:
            return True
        d.send_keys("down"); time.sleep(0.4)
    return line(d.read_screen()[0] or [], "Rx SQUELCH TYPE") == target


def main():
    serial, sandbox_c, workdir, mode_s = sys.argv[1:5]
    mode_num = int(mode_s)
    steps = int(sys.argv[5]) if len(sys.argv) > 5 else 6
    target = sys.argv[6] if len(sys.argv) > 6 else "DPL"
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        boot(d)
        print(f"booted + GET ok; VHF {target} diff on mode {mode_num}\n", flush=True)

        cp0 = C.Codeplug.parse(decrypt_body(Archive.load(N.resolve_afile(arch_dir)).body))
        base = cp0.modes[mode_num - 1].offset
        stride = cp0.modes[1].offset - cp0.modes[0].offset
        print(f"mode{mode_num}@{base:#x} stride {stride}\n", flush=True)

        # double baseline (noise) -- no edits
        to_mode(d, mode_num); N.save(d, arch_dir, f"{workdir}/vd_b0.035")
        to_mode(d, mode_num); N.save(d, arch_dir, f"{workdir}/vd_b1.035")
        b0 = _body(f"{workdir}/vd_b0.035"); b1 = _body(f"{workdir}/vd_b1.035")
        noise = _diff(b0, b1)
        print(f"noise bytes: {sorted(hex(i) for i in noise)}\n", flush=True)

        # set Rx SQUELCH TYPE to target; the Rx CODE field is the next tab stop
        if not set_rx_type(d, mode_num, target):
            print(f"could not set Rx SQUELCH TYPE to {target}"); d.close(); return
        d.send_keys("tab"); time.sleep(0.3)   # -> Rx CODE
        rows = d.read_screen()[0] or []
        print(f"on Rx CODE (initial {line(rows,'Rx CODE')!r})", flush=True)

        print(f"\nstep: Rx CODE -> changed bytes (rec rel); raw rec[16:23]; Tx/TA codes")
        for step in range(steps):
            d.send_keys("down"); time.sleep(0.4)
            rows = d.read_screen()[0] or []
            code = line(rows, "Rx CODE"); rxt = line(rows, "Rx SQUELCH TYPE")
            body = _body(N.save(d, arch_dir, f"{workdir}/vd_s{step}.035"))
            field = sorted((_diff(b0, body) - noise) - CHECKSUM_BLOCK)
            ann = " ".join(f"+{i-base}={body[i]:#04x}(was {b0[i]:#04x})" for i in field)
            raw = body[base+16:base+23].hex(' ')
            txt = f"{line(rows,'Tx SQUELCH TYPE')}/{line(rows,'TA Squelch Type')}"
            print(f"  {rxt:>8} {code:>8}: [{ann}]  rec16-22={raw}  TxTA={txt}", flush=True)
        d.close()
    print("done.")


if __name__ == "__main__":
    main()
