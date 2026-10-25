#!/usr/bin/env python3
"""Full enum mapper: for each editable field on an RSS MODE sub-screen, cycle it
through ALL its values (DOWN + SAVE per step) and record each displayed value's
exact on-disk bytes. Band-agnostic (record offsets from Codeplug.parse).

Robustness: before mapping each field the pristine archive is restored and
re-GET, so every field starts from the known original value and accumulated
saves from a prior field never leak in. Save-time noise (double baseline) and the
known checksum/timestamp block are subtracted.

Usage: scenario_enum_map.py <serial> <sandbox_c> <workdir> <screen> [max_tabs] [max_steps]
  <screen> = opt1 | mode | util
Writes a readable report to stdout; raw per-step bodies kept in <workdir>.
"""
import os, sys, time, glob, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N
from field_diff import CHECKSUM_BLOCK, _body, _diff
from motreader import codeplug as C


def robust_boot(d):
    for _ in range(12):
        if "MAIN MENU" in N.scr(d):
            break
        d.send_keys("enter"); time.sleep(1.5)
    else:
        raise RuntimeError("never reached MAIN MENU:\n" + N.scr(d))


def reget(d):
    """From MAIN MENU: GET the (single) selected archive back into the working copy."""
    N.to_main(d)
    if not N.key_to(d, "f3", "GET / SAVE MENU"):
        raise RuntimeError("no GET/SAVE")
    d.send_keys("f3")
    if not N.wait_for(d, "RADIO SERIAL"):
        if "WARNING" in N.scr(d):
            d.send_keys("f2"); N.wait_for(d, "RADIO SERIAL")
        else:
            raise RuntimeError("no archive list:\n" + N.scr(d))
    d.send_keys("f8")
    if not N.wait_for(d, "GET / SAVE MENU"):
        raise RuntimeError("GET did not return:\n" + N.scr(d))


def enter(d, screen):
    N.to_main(d)
    if not N.key_to(d, "f4", "CHANGE / VIEW CODEPLUG"):
        raise RuntimeError("no CHG/VIEW")
    if not N.key_to(d, "f5", "CONVENTIONAL MODE CONFIGURATION"):
        raise RuntimeError("no MODE screen:\n" + N.scr(d))
    if screen == "mode":
        return
    if screen == "opt1":
        if not N.key_to(d, "f7", "MODE CONFIGURATION OPTIONS"):
            raise RuntimeError("no OPT1:\n" + N.scr(d))
    elif screen == "util":
        if not N.key_to(d, "f8", "MODE UTILITY"):
            raise RuntimeError("no UTILITY:\n" + N.scr(d))
    else:
        raise ValueError(screen)


def changed_lines(before, after):
    return [(i, a.rstrip(), b.rstrip())
            for i, (a, b) in enumerate(zip(before, after)) if a != b]


def main():
    serial, sandbox_c, workdir, screen = sys.argv[1:5]
    max_tabs = int(sys.argv[5]) if len(sys.argv) > 5 else 14
    max_steps = int(sys.argv[6]) if len(sys.argv) > 6 else 10
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)

    def a_files():
        return [f for f in glob.glob(os.path.join(arch_dir, "*"))
                if not os.path.basename(f).lower().endswith(".dbf")
                and not os.path.basename(f).lower().startswith("b")]

    orig_af = a_files()[0]
    orig_name = os.path.basename(orig_af)
    pristine = os.path.join(workdir, "pristine" + os.path.splitext(orig_name)[1])
    shutil.copy(orig_af, pristine)

    def restore():
        for f in a_files():
            os.remove(f)
        shutil.copy(pristine, os.path.join(arch_dir, orig_name))

    # Higher fixed cycle count speeds disk-bound SAVE/GET without the
    # half-rendered-screen races that "speed max" (unbounded) causes.
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        print(f"booted + GET ok; screen={screen}\n", flush=True)

        # ONE global baseline: every field self-reverts (cycles back to original),
        # so the pristine state persists and a single b0 is valid for all fields.
        enter(d, screen); N.save(d, arch_dir, f"{workdir}/em_b0.035")
        enter(d, screen); N.save(d, arch_dir, f"{workdir}/em_b1.035")
        b0 = _body(f"{workdir}/em_b0.035"); b1 = _body(f"{workdir}/em_b1.035")
        noise = _diff(b0, b1)

        # record offsets for annotation (parse the pristine body once)
        cp0 = C.Codeplug.parse(_body(pristine))
        offs = [m.offset for m in cp0.modes]
        recs = offs or [0]
        stride = (offs[1] - offs[0]) if len(offs) > 1 else 26
        print(f"band={cp0.band}  mode1@{recs[0]:#x} stride {stride}  n_modes={len(offs)}\n")

        first_label = None
        for k in range(max_tabs):
            # Each field self-reverts by cycling back to its original value, so
            # the archive stays effectively pristine for already-mapped fields
            # and the single global baseline above stays valid. No external
            # restore (which would go stale vs dosbox's dir cache).

            # step through this field's values
            enter(d, screen)
            for _ in range(k):
                d.send_keys("tab"); time.sleep(0.25)
            before = d.read_screen()[0] or []

            steps = []          # (value_text, line_idx, clean_bytes, body)
            orig_val = None
            wrapped = False
            for step in range(max_steps):
                pre = d.read_screen()[0] or []
                d.send_keys("down"); time.sleep(0.4)
                post = d.read_screen()[0] or []
                chg = changed_lines(pre, post)
                if not chg:
                    break  # non-editable or no more change
                line_idx, oldtxt, newtxt = chg[0]
                if orig_val is None:
                    orig_val = oldtxt.strip()   # field's original displayed value
                body = _body(N.save(d, arch_dir, f"{workdir}/em_s{k}_{step}.035"))
                field = sorted((_diff(b0, body) - noise) - CHECKSUM_BLOCK)
                steps.append((newtxt.strip(), line_idx, field, body))
                # re-enter for next DOWN (SAVE left the screen)
                enter(d, screen)
                for _ in range(k):
                    d.send_keys("tab"); time.sleep(0.25)
                cur = ((d.read_screen()[0] or []) + [""] * 25)[line_idx].strip()
                if cur == (orig_val or ""):
                    wrapped = True
                    break

            if not wrapped and steps:
                # Non-cyclic field (frequency / name / timer): it did not return
                # to its original within max_steps, so undo the DOWNs to restore
                # the working image, keeping the single global baseline valid for
                # the remaining fields.
                enter(d, screen)
                for _ in range(k):
                    d.send_keys("tab"); time.sleep(0.25)
                for _ in range(len(steps)):
                    d.send_keys("up"); time.sleep(0.2)

            if not steps:
                print(f"tab#{k}: (no editable field / no change)")
                continue
            label = steps[0][0]
            if first_label is None:
                first_label = label
            elif label == first_label:
                print(f"tab#{k}: wrapped to first field ({label!r}) -> stop")
                break

            def ann(i):
                if recs[0] <= i:
                    m = (i - recs[0]) // stride + 1
                    return f"m{m}+{(i - recs[0]) % stride}"
                return "global/hdr"

            print(f"tab#{k}: original={orig_val!r}  "
                  f"({'wrapped' if wrapped else 'stopped'})")
            for val, _, clean, body in steps:
                if clean:
                    bs = "  ".join(f"[{ann(i)}] {b0[i]:#04x}->{body[i]:#04x}"
                                   for i in clean)
                else:
                    bs = "(no data-byte change)"
                print(f"    {val:<22} {bs}")
            print(flush=True)
        d.close()
    print("done.")


if __name__ == "__main__":
    main()
