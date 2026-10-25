#!/usr/bin/env python3
"""Smoke test for the Phase-1 harness control channel: launch the patched
dosbox-x, connect, and exercise ping/regs/speed/read-screen while RSS boots.
Prints the live screen so we can confirm the text-mode reader works end-to-end.

Usage: scenario_smoke.py <sandbox_c> <workdir>
"""
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from trace_lib import Harness


def main():
    sandbox_c, workdir = sys.argv[1], sys.argv[2]
    with Harness(sandbox_c, workdir) as h:
        d = h.connect()
        print("ping ->", d.ping())
        print("regs ->", d.regs())
        print("speed ->", d.speed())
        # watch it boot into RSS
        for i in range(12):
            time.sleep(3)
            rows, _ = d.read_screen()
            nonblank = [r for r in (rows or []) if r.strip()]
            print(f"\n----- screen @ ~{(i+1)*3}s ({len(nonblank)} non-blank rows) -----")
            for r in (rows or [])[:25]:
                if r.strip():
                    print("  |" + r.rstrip())
            # stop early once RSS main menu is clearly up
            joined = "\n".join(rows or [])
            if "RADIO SERVICE SOFTWARE" in joined or "F1" in joined and "F10" in joined:
                print("  (RSS menu detected)")
        print("\nfinal regs ->", d.regs())


if __name__ == "__main__":
    main()
