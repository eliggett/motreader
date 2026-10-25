#!/usr/bin/env python3
"""Toggle RADIO-WIDE -> ZONE OPERATION, accept every CONTINUE dialog RSS raises
(recording its text), leave to MAIN MENU and SAVE. Diffing base.bin against
toggled.bin gives everything RSS rewrites for the switch.

Usage: scenario_zone_op.py <serial> <sandbox_c> <workdir> [extra steps]
  [extra steps]  scenario_steps-style keys to send on the RADIO-WIDE screen
                 after the toggle (e.g. "k:tab k:tab t:1" to set Home Zone 1);
                 "y:N" marks N rows of a ZONE MODE LIST "Y" (slowly: RSS drops
                 keys sent at 0.5 s on a 128-mode list)
Writes <workdir>/base.bin, toggled.bin and dialogs.json (every screen seen).
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from scenario_rw_map import active_field, active_pos


def rows(d):
    return [r.rstrip() for r in (d.read_screen()[0] or []) if r.strip()]


def is_dialog(s):
    return "CONTINUE" in s or "Press F2" in s


def main():
    serial, sandbox_c, workdir = sys.argv[1:4]
    extra = sys.argv[4:]
    arch = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)
    seen = []
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        N.save(d, arch, os.path.join(workdir, "base.bin"))
        N.to_main(d)
        for k in ("f4", "f2"):
            d.send_keys(k); time.sleep(1.2)
        seen.append({"step": "radio-wide", "rows": rows(d)})
        d.send_keys("down"); time.sleep(1.5)

        def settle(tag):
            for _ in range(6):
                s = N.scr(d)
                seen.append({"step": tag, "rows": rows(d)})
                if not is_dialog(s):
                    return
                d.send_keys("f2"); time.sleep(1.5)
        settle("toggle")
        for st in extra:
            kind, _, arg = st.partition(":")
            if kind == "k":
                for k in arg.split():
                    d.send_keys(k); time.sleep(0.5)
            elif kind == "w":           # wait (screens that redraw slowly)
                time.sleep(float(arg))
            elif kind == "y":           # ZONE MODE LIST: mark N rows "Y" (DOWN, TAB),
                for _ in range(int(arg)):   # closed loop: RSS lags on big codeplugs
                    for _ in range(3 if active_field(d)[2].strip() != "Y" else 0):
                        d.send_keys("down")
                        for _ in range(20):
                            time.sleep(0.25)
                            if active_field(d)[2].strip() == "Y":
                                break
                        if active_field(d)[2].strip() == "Y":
                            break
                    pos = active_pos(d)
                    d.send_keys("tab")
                    for _ in range(20):
                        time.sleep(0.25)
                        if active_pos(d) != pos:
                            break
            elif kind == "t":
                for ch in arg:
                    d.send_keys("space" if ch == " " else ch); time.sleep(0.3)
            settle(st)
        # leave: F10, accepting dialogs, until MAIN MENU
        for i in range(8):
            if "MAIN MENU" in N.scr(d):
                break
            d.send_keys("f10"); time.sleep(1.5)
            settle(f"exit{i}")
        seen.append({"step": "main", "rows": rows(d)})
        with open(os.path.join(workdir, "dialogs.json"), "w") as f:
            json.dump(seen, f, indent=1)
        try:
            N.save(d, arch, os.path.join(workdir, "toggled.bin"))
        finally:
            seen += [{"step": "save-dialog", "rows": [r for r in t.splitlines() if r.strip()]}
                     for t in N.SAVE_DIALOGS]
            with open(os.path.join(workdir, "dialogs.json"), "w") as f:
                json.dump(seen, f, indent=1)
        N.to_main(d)
        for k in ("f4", "f2"):
            d.send_keys(k); time.sleep(1.2)
        seen.append({"step": "after", "rows": rows(d)})
        with open(os.path.join(workdir, "dialogs.json"), "w") as f:
            json.dump(seen, f, indent=1)
        d.close()
    print("done")


if __name__ == "__main__":
    main()
