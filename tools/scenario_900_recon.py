#!/usr/bin/env python3
"""Recon: boot+GET the 900 radio, dump the MODE screen and its sub-screens so we
can see which fields/sub-screens hold the deferred enums (CODED SQUELCH, Reverse
Burst/TOC, UnMute/Mute Type, MDC PTT ID, Phone Encode). Pure read, no saves.

Usage: scenario_900_recon.py <serial> <sandbox_c> <workdir>
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N


def dump(d, title):
    rows = d.read_screen()[0] or []
    print(f"\n===== {title} =====")
    for r in rows:
        if r.strip():
            print(r.rstrip())


def robust_boot_and_get(d):
    """Mirror FieldMapper's proven boot: send Enter UNCONDITIONALLY (the splash is
    graphics-mode, so its 'Press Any Key' text isn't visible to the text reader).
    Dumps the screen along the way for diagnosis."""
    for attempt in range(12):
        s = N.scr(d)
        print(f"[boot {attempt}] nonblank_lines={sum(1 for l in (d.read_screen()[0] or []) if l.strip())}")
        if "MAIN MENU" in s:
            break
        d.send_keys("enter")
        time.sleep(1.5)
    else:
        dump(d, "boot stuck")
        raise RuntimeError("never reached MAIN MENU")
    # now do the GET via rss_nav from MAIN MENU
    if not N.key_to(d, "f3", "GET / SAVE MENU"):
        raise RuntimeError("no GET/SAVE menu:\n" + N.scr(d))
    d.send_keys("f3")
    if not N.wait_for(d, "RADIO SERIAL"):
        if "WARNING" in N.scr(d):
            d.send_keys("f2"); N.wait_for(d, "RADIO SERIAL")
        else:
            raise RuntimeError("no archive list:\n" + N.scr(d))
    d.send_keys("f8")
    if not N.wait_for(d, "GET / SAVE MENU"):
        raise RuntimeError("GET did not return to menu:\n" + N.scr(d))
    if "Model:" not in N.scr(d):
        raise RuntimeError("no model after GET:\n" + N.scr(d))


def main():
    serial, sandbox_c, workdir = sys.argv[1:4]
    with Harness(sandbox_c, workdir, cycles=50000) as h:
        d = h.connect()
        robust_boot_and_get(d)
        print("booted + GET ok")

        def goto_mode():
            N.to_main(d)
            if not N.key_to(d, "f4", "CHANGE / VIEW CODEPLUG"):
                raise RuntimeError("no CHG/VIEW menu")
            if not N.key_to(d, "f5", "CONVENTIONAL MODE CONFIGURATION"):
                raise RuntimeError("no MODE config screen:\n" + N.scr(d))

        goto_mode()
        dump(d, "MODE screen (base)")

        # MODE OPT 1 (F7) and MODE UTILITY (F8) sub-screens.
        goto_mode()
        d.send_keys("f7"); time.sleep(1.2)
        dump(d, "MODE -> F7 (MODE OPT 1)")

        goto_mode()
        d.send_keys("f8"); time.sleep(1.2)
        dump(d, "MODE -> F8 (MODE UTILITY)")

        # SCAN LIST (F6) for completeness
        goto_mode()
        d.send_keys("f6"); time.sleep(1.2)
        dump(d, "MODE -> F6 (SCAN LIST)")
        d.close()


if __name__ == "__main__":
    main()
