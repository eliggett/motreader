#!/usr/bin/env python3
"""Enumerate a multi-value RSS field's full value set and each value's on-disk
encoding, by cycling it with DOWN and SAVE-ing after every step.

For each step: re-enter the screen, TAB to the field, press DOWN once (advances
the persisted value by one), read the displayed value, SAVE, and record mode-1's
record bytes. Stops when the displayed value cycles back to the first one.

Usage: scenario_cycle_enum.py <sock> <arch_dir> <workdir> <screen> <tab_index> <field_label_substr> [max_steps]
  e.g. ... opt1 4 "MPL Type"
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dbxctl import Dbx
import rss_nav as N
from field_diff import _body
from motreader import codeplug as C


def enter(d, screen):
    N.to_main(d)
    N.key_to(d, "f4", "CHANGE / VIEW")
    N.key_to(d, "f5", "MODE CONFIGURATION")
    if screen == "opt1":
        N.key_to(d, "f7", "CONFIGURATION OPTIONS")
    elif screen == "util":
        N.key_to(d, "f8", "UTILITY")


def main():
    sock, arch_dir, workdir, screen, tab_s, label_sub = sys.argv[1:7]
    tab_index = int(tab_s)
    max_steps = int(sys.argv[7]) if len(sys.argv) > 7 else 8
    d = Dbx(sock)
    N.boot_and_get(d)
    recs = C.find_vhf_records(_body(N.save(d, arch_dir, f"{workdir}/ce_base.035")))
    r0, stride = recs[0], recs[1] - recs[0]

    seen = []
    results = []
    for step in range(max_steps):
        enter(d, screen)
        for _ in range(tab_index):
            d.send_keys("tab"); time.sleep(0.25)
        before = d.read_screen()[0]
        d.send_keys("down"); time.sleep(0.4)
        after = d.read_screen()[0]
        chg = [y for x, y in zip(before, after) if x != y]
        # pull the displayed value for our field
        val = None
        for ln in chg:
            if label_sub in ln:
                val = ln.split(".")[-1].strip() if "." in ln else ln.strip()
        if val is None and chg:
            val = chg[0].strip()
        body = _body(N.save(d, arch_dir, f"{workdir}/ce_{step}.035"))
        rec = body[r0:r0 + stride]
        results.append((val, rec))
        print(f"step {step}: value={val!r}  mode1 rec={rec.hex()}")
        if val in seen:
            print(f"  -> cycled back to {val!r}; stop")
            break
        seen.append(val)
    d.close()

    # summarize which record bytes encode the value
    print("\n=== value -> differing record bytes (vs first value) ===")
    base = results[0][1]
    for val, rec in results:
        diffs = [(i, base[i], rec[i]) for i in range(len(rec)) if base[i] != rec[i]]
        ds = " ".join(f"+{i}:{a:#04x}->{b:#04x}" for i, a, b in diffs) or "(same as first)"
        print(f"  {val:<16} {ds}")


if __name__ == "__main__":
    main()
