#!/usr/bin/env python3
"""Spy on RSS while it rewrites the control-head summary word W (CHB+0x1C/+0x1D):
GET the radio, locate the CHB head in guest RAM by its bytes, write-watch W,
then toggle Horn & Lights Rearm / Siren-PA through the transitions that change
W, recording every write (CS:EIP + value) to a trace for trace_decode.py.

Usage: scenario_spy_w.py <sandbox_c> <workdir> <head_hex> <steps...>
  <head_hex>  CHB bytes +0x10..+0x1D as hex (the RAM signature; W = last 2)
  <steps>     like scenario_steps.py: main | k:<keys> | dump | mark:<label> |
              save:<name>; a first step chb=<hex> = the CHB body offset, used to
              watch W inside the plaintext body buffer when the head isn't in RAM
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from scenario_steps import dump


def main():
    sandbox_c, workdir, head_hex = sys.argv[1:4]
    steps = sys.argv[4:]
    chb_off = None
    if steps and steps[0].startswith("chb="):
        chb_off = int(steps.pop(0)[4:], 16)
    head = bytes.fromhex(head_hex)
    os.makedirs(workdir, exist_ok=True)
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        N.to_main(d)
        hits = d.find(head)
        print("CHB head in RAM at:", [hex(x) for x in hits], flush=True)
        sig = d.find(b"COPYRIGHT MOTOROLA INC.,1987")
        print("body signature at:", [hex(x) for x in sig], flush=True)
        if not hits and chb_off is not None:
            # watch W's slot in each candidate plaintext body buffer instead
            hits = [s - 0xAD + chb_off + 0x10 for s in sig]
        if not hits and "findbuf" not in " ".join(steps):
            d.close()
            return
        for a in hits:
            print(f"  {a:#x}: {d.read_mem(a - 0x10, 0x30).hex(' ')}")
        trace = os.path.join(workdir, "w.trace")
        d.trace_open(trace)
        for a in hits:
            w = a + len(head) - 2
            d.set_watch(w, w + 2, "w")
        for st in steps:
            op, _, arg = st.partition(":")
            if op == "main":
                N.to_main(d)
            elif op == "k":
                for tok in arg.split():
                    d.send_keys(tok); time.sleep(0.6)
                time.sleep(0.6)
            elif op == "dump":
                dump(d, arg or "screen")
            elif op == "mark":
                d.mark(arg)
            elif op == "save":
                arch = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
                N.save(d, arch, os.path.join(workdir, arg + ".bin"))
            elif op == "readmem":
                lin, ln, fn = arg.split(",")
                lin, ln = int(lin, 16), int(ln, 16)
                data = b"".join(d.read_mem(a, min(0x1000, lin + ln - a))
                                for a in range(lin, lin + ln, 0x1000))
                with open(os.path.join(workdir, fn), "wb") as f:
                    f.write(data)
                print(f"  dumped {lin:#x}+{ln:#x} -> {fn}", flush=True)
            elif op == "findbuf":
                # locate RSS's save buffer from the file just written: search
                # RAM for its ciphertext and plaintext; watch W's slot there
                from motreader.archive import Archive
                from motreader.crypto import decrypt_body
                arc = Archive.load(os.path.join(workdir, arg + ".bin"))
                plain = decrypt_body(arc.body)
                for name, blob in (("cipher", arc.body), ("plain", plain)):
                    for off in (0x10, 0x200, 0x800):
                        f = d.find(blob[off:off + 24])
                        print(f"  {name}@{off:#x} found at", [hex(x - off) for x in f], flush=True)
                        for base in f:
                            w = base - off + chb_off + 0x1C
                            d.set_watch(w, w + 2, "w")
                            print(f"    watching W slot {w:#x}", flush=True)
        for a in hits:
            print(f"  after {a:#x}: {d.read_mem(a - 0x10, 0x30).hex(' ')}")
        d.flush()
        d.trace_close()
        d.close()
    print("trace:", trace)


if __name__ == "__main__":
    main()
