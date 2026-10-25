#!/usr/bin/env python3
"""White-box the ZONE OPERATION re-pack: turn zones off on the RADIO-WIDE
screen (accepting "Disabling zone mode will clear all zone lists"), then SAVE.

  find  mode: after the SAVE, locate RSS's plain save buffer in RAM (by the
              saved body's bytes) and print its address.
  break mode: break on a write of <val> to <addr> during the SAVE and dump the
              CPU context (registers, code, stack, overlay file + offset).

Usage: scenario_zone_break.py <serial> <sandbox_c> <workdir> <state.sav> find
       scenario_zone_break.py <serial> <sandbox_c> <workdir> <state.sav> break <addr_hex> <val_hex> [nth]
A state file (boot + GET) is created on the first run and restored later.
$ZB_EARLY=1: arm the break before the toggle (catch work done on the screen).
$ZB_FARPTRS="-0xac,-0xa0@0x3a0": also dump the structures behind far pointers
at ss:bp+K (from +off); $ZB_LOCALS="0x9a,-0x9c": raw stack-frame words.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness, boot_cached, context
import rss_nav as N
from scenario_enum_map import robust_boot, reget


def zones_off(d):
    N.to_main(d)
    for k in ("f4", "f2"):
        d.send_keys(k); time.sleep(1.2)
    d.send_keys("down"); time.sleep(1.5)
    if "CONTINUE" in N.scr(d):
        d.send_keys("f2"); time.sleep(1.5)
    for _ in range(6):
        if "MAIN MENU" in N.scr(d):
            return
        d.send_keys("f10"); time.sleep(1.5)
        if "CONTINUE" in N.scr(d):
            d.send_keys("f2"); time.sleep(1.5)


def main():
    serial, sandbox_c, workdir, state, mode = sys.argv[1:6]
    arch = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        how = boot_cached(h, d, state, lambda d: (robust_boot(d), reget(d), N.to_main(d)))
        print("state", how, flush=True)
        early = os.environ.get("ZB_EARLY") and mode == "break"
        if early:                 # catch the write during the toggle, not the SAVE
            addr, val = int(sys.argv[6], 16), int(sys.argv[7], 16)
            d.set_watch(addr, addr + 1, "w", brk=True, value=val)
            N.to_main(d)
            for k in ("f4", "f2"):
                d.send_keys(k); time.sleep(1.2)
            d.send_keys("down"); time.sleep(1.5)
            d.send_keys("f2"); time.sleep(1.5)      # CONTINUE (clear all zone lists)
            d.send_keys("f10")
        else:
            zones_off(d)
        if mode == "find":
            N.save(d, arch, os.path.join(workdir, "saved.bin"))
            from motreader.archive import Archive
            from motreader.crypto import decrypt_body
            body = decrypt_body(Archive.load(os.path.join(workdir, "saved.bin")).body)
            for off in (0x100, 0x200, 0x300):
                hits = d.find(body[off:off + 24])
                print(f"body[{off:#x}:+24] at", [hex(a - off) for a in hits], flush=True)
        else:
            addr, val = int(sys.argv[6], 16), int(sys.argv[7], 16)
            nth = int(sys.argv[8]) if len(sys.argv) > 8 else 1
            if not early:
                d.set_watch(addr, addr + 1, "w", brk=True, value=val)
                N.key_to(d, "f3", "GET / SAVE MENU"); N.key_to(d, "f7", "SAVE CODEPLUG")
                d.send_keys("f8")
            for k in range(nth):
                hit = None
                for _ in range(240):
                    hit = d.hit()
                    if hit:
                        break
                    time.sleep(0.5)
                print(f"hit {k + 1}:", hit, flush=True)
                if not hit:
                    break
                ctx = context(d)
                r = ctx["regs"]
                print("regs:", " ".join(f"{a}={v:04x}" for a, v in r.items() if a != "cyc"))
                print("code @%x:" % ctx["code_start"], ctx["code"].hex(" "))
                print("stack:", ctx["stack"].hex(" "))
                print("overlay:", ctx["overlay"], flush=True)
                # $ZB_FARPTRS="-0xac,0xa6": dump 0x80 bytes behind the far
                # pointers stored at ss:bp+K (structures the code reads)
                # "K" or "K@off": the far pointer at ss:bp+K, dumped from +off
                for kk in filter(None, os.environ.get("ZB_FARPTRS", "").split(",")):
                    k0, _, off = kk.partition("@")
                    a = (r["ss"] << 4) + ((r["bp"] + int(k0, 16)) & 0xFFFF)
                    fp = d.read_mem(a, 4)
                    lin = (int.from_bytes(fp[2:4], "little") << 4) + int.from_bytes(fp[0:2], "little")
                    lin += int(off, 16) if off else 0
                    print(f"[bp{kk}] -> {lin:#x}:", d.read_mem(lin, 0x80).hex(" "), flush=True)
                # "K,...": raw words on the stack frame at ss:bp+K
                for kk in filter(None, os.environ.get("ZB_LOCALS", "").split(",")):
                    a = (r["ss"] << 4) + ((r["bp"] + int(kk, 16)) & 0xFFFF)
                    print(f"[bp{kk}] =", d.read_mem(a, 8).hex(" "), flush=True)
                with open(os.path.join(workdir, f"hit{k + 1}.json"), "w") as f:
                    json.dump({"hit": hit, "regs": r, "code_start": ctx["code_start"],
                               "code": ctx["code"].hex(), "stack": ctx["stack"].hex(),
                               "overlay": ctx["overlay"]}, f, indent=1)
                d.cont()
            d.clear_watch()
        d.close()


if __name__ == "__main__":
    main()
