#!/usr/bin/env python3
"""Break-on-write demo + investigation: catch the instruction that writes the
control-head summary word W into RSS's save buffer, and dump its context
(registers, code bytes, stack, overlay file/offset).

Usage: scenario_break_w.py <serial> <sandbox_c> <workdir> <state.sav> <addr_hex> <val_hex> [keys...]
  keys: RSS key tokens to send from MAIN MENU before the SAVE (e.g. to enable
        Horn & Lights Rearm). A state file is created on the first run (boot +
        GET) and restored on later runs.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_lib import Harness, boot_cached, context
import rss_nav as N
from scenario_enum_map import robust_boot, reget


def main():
    serial, sandbox_c, workdir, state, addr, val = sys.argv[1:7]
    keys = sys.argv[7:]
    addr, val = int(addr, 16), int(val, 16)
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        t0 = time.time()
        how = boot_cached(h, d, state, lambda d: (robust_boot(d), reget(d), N.to_main(d)))
        print(f"state {how} in {time.time() - t0:.1f}s; screen has model: {'Model:' in N.scr(d)}", flush=True)
        N.to_main(d)
        for k in keys:
            d.send_keys(k); time.sleep(0.6)
        N.to_main(d)
        d.set_watch(addr, addr + 1, "w", brk=True, value=val)
        # SAVE without waiting on the screen: we expect to freeze mid-save
        N.key_to(d, "f3", "GET / SAVE MENU"); N.key_to(d, "f7", "SAVE CODEPLUG")
        d.send_keys("f8")
        hit = None
        for _ in range(240):
            hit = d.hit()
            if hit:
                break
            time.sleep(0.5)
        print("hit:", hit, flush=True)
        if hit:
            ctx = context(d)
            r = ctx["regs"]
            print("regs:", " ".join(f"{k}={v:04x}" for k, v in r.items() if k != "cyc"))
            print("code @%x:" % ctx["code_start"], ctx["code"].hex(" "))
            print("stack:", ctx["stack"].hex(" "))
            print("ds:si:", ctx["ds_si"].hex(" "), " es:di:", ctx["es_di"].hex(" "))
            print("overlay:", ctx["overlay"])
            with open(os.path.join(workdir, "flog.json"), "w") as f:
                json.dump(getattr(d, "prior_flog", []) + d.file_log(), f)
            with open(os.path.join(workdir, "hit.json"), "w") as f:
                json.dump({"hit": hit, "regs": r, "code_start": ctx["code_start"],
                           "code": ctx["code"].hex(), "stack": ctx["stack"].hex(),
                           "overlay": ctx["overlay"]}, f, indent=1)
            d.clear_watch()
            d.cont()
        d.close()


if __name__ == "__main__":
    main()
