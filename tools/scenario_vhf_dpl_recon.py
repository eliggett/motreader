#!/usr/bin/env python3
"""VHF DPL recon on 221AZN: GET, go to a mode, dump the MODE screen, then find
the 'Rx SQUELCH TYPE' field, cycle it to DPL, and dump what RSS shows (the
default DPL code it picks + the Tx side). Pure read -- no SAVE. Establishes the
field layout before the differential.

Usage: scenario_vhf_dpl_recon.py <serial> <sandbox_c> <workdir> <mode_num>
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N


def boot(d):
    for _ in range(12):
        if "MAIN MENU" in N.scr(d):
            break
        d.send_keys("enter"); time.sleep(1.5)
    else:
        raise RuntimeError("no MAIN MENU:\n" + N.scr(d))
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


def dump(d, tag):
    rows = d.read_screen()[0] or []
    print(f"----- {tag} -----", flush=True)
    for r in rows:
        if r.strip():
            print("  " + r.rstrip(), flush=True)
    return rows


def line(rows, label):
    for r in rows:
        if label in r:
            return r.split(label, 1)[1].strip(". ")
    return ""


def main():
    serial, sandbox_c, workdir, mode_s = sys.argv[1:5]
    mode_num = int(mode_s)
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        boot(d)
        print(f"booted + GET ok; mode {mode_num}\n", flush=True)
        to_mode(d, mode_num)
        rows = dump(d, f"MODE {mode_num} initial")
        # find the Rx SQUELCH TYPE field: tab until DOWN changes it.
        found = None
        for k in range(16):
            to_mode(d, mode_num)
            for _ in range(k):
                d.send_keys("tab"); time.sleep(0.15)
            pre = d.read_screen()[0] or []
            d.send_keys("down"); time.sleep(0.4)
            post = d.read_screen()[0] or []
            a, b = line(pre, "Rx SQUELCH TYPE"), line(post, "Rx SQUELCH TYPE")
            if a != b:
                found = k
                print(f"\nRx SQUELCH TYPE field at tab#{k}: {a!r} -> {b!r}", flush=True)
                break
            d.send_keys("up"); time.sleep(0.15)
        if found is None:
            print("could not find Rx SQUELCH TYPE field"); d.close(); return
        # from mode start, tab to the field, cycle until DPL shows
        to_mode(d, mode_num)
        for _ in range(found):
            d.send_keys("tab"); time.sleep(0.15)
        for step in range(6):
            rows = d.read_screen()[0] or []
            t = line(rows, "Rx SQUELCH TYPE")
            print(f"  cycle {step}: Rx SQUELCH TYPE={t!r} Rx CODE={line(rows,'Rx CODE')!r}", flush=True)
            if "DPL" in t:
                break
            d.send_keys("down"); time.sleep(0.4)
        dump(d, f"MODE {mode_num} after reaching DPL")
        d.close()
    print("done.")


if __name__ == "__main__":
    main()
