#!/usr/bin/env python3
"""Type frequencies into chosen modes' Rx / Tx / talk-around fields in RSS,
SAVE, and print the record bytes RSS stored: the data for mapping a band's
frequency codec (any band, any head).

Usage: scenario_freq_sweep.py <sandbox_c> <workdir> <field:mode:MHz> ...
  field: rx | tx | ta (ta needs TALKAROUND enabled on that mode)
Each mode is reached with GOTO MODE and each field found by the label of the
active (inverse-video) field, so screen layouts that differ by head don't
matter. RSS overwrites a field in place, so values are typed full width
(NNN.NNNNN). A value RSS refuses is reported with its message.
Prints one JSON object per entry: field, mode, typed, status, and the stored
record bytes (view = true start - 3, as motreader's VHF view).
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from motreader.archive import Archive
from motreader.crypto import decrypt_body
from motreader.codeplug import mode_pointer_table

LABELS = {"rx": "Rx FREQUENCY", "tx": "Tx FREQUENCY", "ta": "Frequency"}


def active(d):
    """(column, row text, field text) of the inverse-video field."""
    rows, attrs = d.read_screen(attrs=True)
    for y, (r, a) in enumerate(zip(rows or [], attrs or [])):
        if y > 21:
            continue
        cells = [a[i:i + 2] for i in range(0, len(a), 2)]
        if "70" in cells:
            x0 = cells.index("70")
            x1 = x0
            while x1 < len(cells) and cells[x1] == "70":
                x1 += 1
            return x0, r, r[x0:x1].strip()
    return None, "", ""


REFUSALS = ("Outside Range", "Not A Valid", "Invalid", "Must", "Exceed")


def refusal(d):
    """RSS's refusal message on screen, if any."""
    screen = N.scr(d)
    return next((s for s in REFUSALS if s in screen), "")


def goto_mode(d, n):
    """GOTO MODE n. Returns a refusal RSS raised for the field being left
    (some values are only checked on leaving): the field is then restored."""
    d.send_keys("f2"); time.sleep(0.6)
    late = refusal(d)
    if late:
        d.send_keys("esc"); time.sleep(0.8)
        if "CONVENTIONAL MODE CONFIGURATION" not in N.scr(d) or refusal(d):
            N.to_main(d)
            N.key_to(d, "f4", "CHANGE / VIEW")
            N.key_to(d, "f5", "MODE CONFIGURATION")
        d.send_keys("f2"); time.sleep(0.6)
    for ch in f"{n:03d}":
        d.send_keys(ch); time.sleep(0.15)
    d.send_keys("enter"); time.sleep(0.8)
    if not N.wait_for(d, f"MODE {n:03d}", tries=20):
        raise RuntimeError(f"GOTO MODE {n} failed:\n" + N.scr(d))
    return late


def to_field(d, field):
    """Press Enter until the active field is `field`'s (left column)."""
    want = LABELS[field]
    for _ in range(14):
        x0, row, _ = active(d)
        left = row[:40] if row else ""
        if x0 is not None and x0 < 40 and want in left and (field != "ta" or "Rx" not in left and "Tx" not in left):
            return True
        d.send_keys("enter"); time.sleep(0.5)
    return False


def main():
    sandbox_c, workdir = sys.argv[1:3]
    entries = []
    for a in sys.argv[3:]:
        f, m, v = a.split(":")
        entries.append((f, int(m), float(v)))
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)
    out = os.path.join(workdir, "sweep.bin")
    status = []
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        N.to_main(d)
        N.key_to(d, "f4", "CHANGE / VIEW")
        N.key_to(d, "f5", "MODE CONFIGURATION")
        for field, mode, mhz in entries:
            late = goto_mode(d, mode)
            if late and status:
                status[-1] = f"{late} (on leaving the field)"
            if not to_field(d, field):
                status.append("field not found")
                continue
            for ch in f"{mhz:09.5f}":
                d.send_keys(ch); time.sleep(0.12)
            d.send_keys("enter"); time.sleep(0.8)
            # some Rx values raise "Crystal Frequency Will Be Shifted" (uP crystal shift): F2 continues
            for _ in range(3):
                if "Crystal Frequency" not in N.scr(d) and active(d)[2] != "F2":
                    break
                d.send_keys("f2"); time.sleep(0.8)
            msg = refusal(d)
            status.append(msg or "ok")
            if msg:
                # RSS keeps the field open on a refusal: restore it and get back to the mode screen
                d.send_keys("esc"); time.sleep(0.8)
                if "CONVENTIONAL MODE CONFIGURATION" not in N.scr(d):
                    N.to_main(d)
                    N.key_to(d, "f4", "CHANGE / VIEW")
                    N.key_to(d, "f5", "MODE CONFIGURATION")
        d.send_keys("f2"); time.sleep(0.6)       # leave the last field the same way, to catch a late refusal
        late = refusal(d)
        if late and status:
            status[-1] = f"{late} (on leaving the field)"
            d.send_keys("esc"); time.sleep(0.8)
        N.to_main(d)
        N.save(d, arch_dir, out)
        d.close()
    body = decrypt_body(Archive.load(out).body)
    starts = mode_pointer_table(body)[2]
    for (field, mode, mhz), st in zip(entries, status):
        t = starts[mode - 1]
        print(json.dumps({"field": field, "mode": mode, "typed": mhz, "status": st,
                          "view": body[t - 3:t + 26].hex()}), flush=True)


if __name__ == "__main__":
    main()
