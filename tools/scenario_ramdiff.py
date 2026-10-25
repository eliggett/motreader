#!/usr/bin/env python3
"""Snapshot guest conventional RAM, run RSS steps, snapshot again, and report
bytes that changed (optionally only from <old> to <new>). Locates where RSS's
in-RAM working image keeps a value, for a follow-up write-watch.

Usage: scenario_ramdiff.py <sandbox_c> <workdir> <old_hex|-> <new_hex|-> <steps...>
  steps: main | k:<keys> | dump[:label]   (as scenario_steps.py)
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from scenario_steps import dump

LO, HI, CHUNK = 0x0, 0xA0000, 0x1000


def snap(d):
    return b"".join(d.read_mem(a, CHUNK) for a in range(LO, HI, CHUNK))


def main():
    sandbox_c, workdir, old, new = sys.argv[1:5]
    steps = sys.argv[5:]
    os.makedirs(workdir, exist_ok=True)
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        N.to_main(d)
        phases = [[]]
        for st in steps:                     # 'snap' splits the steps into phases
            if st == "snap":
                phases.append([])
            else:
                phases[-1].append(st)
        snaps = []
        for i, ph in enumerate(phases):
            for st in ph:
                op, _, arg = st.partition(":")
                if op == "main":
                    N.to_main(d)
                elif op == "k":
                    for tok in arg.split():
                        d.send_keys(tok); time.sleep(0.6)
                    time.sleep(0.6)
                elif op == "dump":
                    dump(d, arg or "screen")
            snaps.append(snap(d))
            with open(os.path.join(workdir, f"ram{i}.bin"), "wb") as f:
                f.write(snaps[-1])
        d.close()
    a, b = snaps[0], snaps[-1]
    ch = [i for i in range(len(a)) if a[i] != b[i]]
    print(f"{len(ch)} bytes changed")
    if old != "-":
        o, n = int(old, 16), int(new, 16)
        ch = [i for i in ch if a[i] == o and b[i] == n]
        print(f"{len(ch)} changed {o:02x}->{n:02x}:")
    for i in ch[:60]:
        print(f"  {LO + i:#07x}: {a[max(0,i-16):i+16].hex(' ')}  ->  {b[max(0,i-16):i+16].hex(' ')}")


if __name__ == "__main__":
    main()
