#!/usr/bin/env python3
"""Step one CONTROL HEAD KEYPAD button through every function RSS offers,
saving after each, to build the function-code table.

At each value: record the short label (highlighted cell) and the help-line
full name, leave the screen (RSS's "Duplicate Buttons!" dialog is accepted with
F2, which blanks whichever button is later in TAB order; if that is this one,
the next value is re-stepped from the start),
SAVE to <workdir>/v<i>.bin.

Usage: scenario_cycle_button.py <serial> <sandbox_c> <workdir> <tabs> [max] [up|down] [skip]
  <tabs>  TAB presses from screen entry to reach the button (Ind 1 = 0)
  [skip]  step this many values first without saving (resume a broken cycle)
Direct-entry functions (label ending "X", e.g. "Zone  X") get the value $BTN_DATA
(default 2) typed into their data field. $BTN_PREP="<tab>:<n>" first moves a
function RSS requires (HOME, Sel) onto another key (see PREP).
Writes <workdir>/values.json: [{"i", "label", "name", "dup"}].
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from scenario_rw_map import active_field


DATA = os.environ.get("BTN_DATA", "2")    # value typed into direct-entry functions
# "<tab>:<n>": in the first step, also press DOWN n times on the button at TAB
# stop <tab> (same screen session). Moves a function RSS requires somewhere
# (HOME, Sel) onto another key so the cycled button may give it up.
PREP = os.environ.get("BTN_PREP")


def open_keypad(d, tabs):
    N.to_main(d)
    for k in ("f4", "f6", "f2"):
        d.send_keys(k); time.sleep(1.0)
    for _ in range(tabs):
        d.send_keys("tab"); time.sleep(0.3)
    time.sleep(0.4)


def current(d):
    rows = d.read_screen()[0] or []
    _, _, label = active_field(d)
    # help line: right half of the "SPECTRA  Model: ..." row
    row = next((r for r in rows if "Model:" in r), "")
    return label, row[41:].strip()


def leave(d, seen=None):
    """F10 out of the keypad screen; accept a duplicate-button dialog. Any
    other screen met on the way out is appended to `seen` (list of rows)."""
    dup = False
    for _ in range(4):
        d.send_keys("f10"); time.sleep(0.9)
        s = N.scr(d)
        if "Duplicate Buttons" in s:
            dup = True
            d.send_keys("f2"); time.sleep(0.9)
            continue
        if "KEYPAD" not in s:
            break
        if seen is not None:
            seen.append([r.rstrip() for r in (d.read_screen()[0] or []) if r.strip()])
    if not N.to_main(d) and seen is not None:
        seen.append([r.rstrip() for r in (d.read_screen()[0] or []) if r.strip()])
    return dup


def recover(d):
    """Back to MAIN MENU from an unexpected dialog: try the usual answers."""
    for k in ("f2", "enter", "esc", "f10", "f10", "f2", "f10"):
        if "MAIN MENU" in N.scr(d):
            return True
        d.send_keys(k); time.sleep(0.9)
    return N.to_main(d)


def main():
    serial, sandbox_c, workdir, tabs = sys.argv[1:5]
    tabs = int(tabs)
    mx = int(sys.argv[5]) if len(sys.argv) > 5 else 80
    key = sys.argv[6] if len(sys.argv) > 6 else "down"
    skip = int(sys.argv[7]) if len(sys.argv) > 7 else 0
    arch = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)
    vals = []
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        origin = None
        if skip:
            open_keypad(d, tabs)
            origin = current(d)[0]
            for _ in range(skip):
                d.send_keys(key); time.sleep(0.6)
            leave(d)
        open_keypad(d, tabs)
        label, name = current(d)
        first = label
        origin = origin or first        # the value at position 0
        N.to_main(d)
        N.save(d, arch, os.path.join(workdir, f"v{skip}.bin"))
        vals.append({"i": skip, "label": label, "name": name, "dup": False})
        print(f"v0: {label!r} {name!r}", flush=True)
        presses = 1
        for i in range(1, mx + 1):
            prep = None
            if PREP and i == 1:
                ptab, pn = (int(x) for x in PREP.split(":"))
                prep = (ptab, pn)
            if prep and prep[0] < tabs:
                open_keypad(d, prep[0])
                for _ in range(prep[1]):
                    d.send_keys("down"); time.sleep(0.4)
                for _ in range(tabs - prep[0]):
                    d.send_keys("tab"); time.sleep(0.3)
            else:
                open_keypad(d, tabs)
            # after a duplicate, RSS's F2 blanked THIS button: step from the
            # start value again, past the duplicate
            for _ in range(presses):
                d.send_keys(key); time.sleep(0.6)
            label, name = current(d)
            if prep and prep[0] > tabs:
                for _ in range(prep[0] - tabs):
                    d.send_keys("tab"); time.sleep(0.3)
                for _ in range(prep[1]):
                    d.send_keys("down"); time.sleep(0.4)
            data = None
            if label.rstrip().endswith("X"):        # direct-entry function (Zone X ...)
                data = DATA
                d.send_keys("enter"); time.sleep(0.5)
                d.send_keys("del", "del"); time.sleep(0.4)
                for ch in DATA:
                    d.send_keys(ch); time.sleep(0.3)
                d.send_keys("enter"); time.sleep(0.6)
            seen = []
            dup = leave(d, seen)
            ok = True
            try:
                N.save(d, arch, os.path.join(workdir, f"v{i + skip}.bin"))
            except RuntimeError:
                ok = False
                seen.append([r.rstrip() for r in (d.read_screen()[0] or []) if r.strip()])
                recover(d)
            vals.append({"i": i + skip, "label": label, "name": name, "dup": dup,
                         "saved": ok, "screens": seen, "data": data})
            print(f"v{i}: {label!r} {name!r}{' (dup blanked)' if dup else ''}"
                  f"{'' if ok else ' SAVE FAILED'}", flush=True)
            for sc in seen:
                print("   | " + "\n   | ".join(sc), flush=True)
            with open(os.path.join(workdir, "values.json"), "w") as f:
                json.dump(vals, f, indent=1)
            if label in (first, origin):
                break
            # RSS's duplicate F2 blanks whichever button is later in TAB order;
            # if that was this one it is back at the start value, and the next
            # value is (its position = i) + 1 steps away
            presses = 1
            if dup:
                open_keypad(d, tabs)
                now, _ = current(d)
                N.to_main(d)
                if now == origin:
                    presses = skip + i + 1
        d.close()
    print("done")


if __name__ == "__main__":
    main()
