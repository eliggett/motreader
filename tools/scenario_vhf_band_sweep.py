#!/usr/bin/env python3
"""Map the VHF TX/TA "band" byte (record view +12 / +16) RSS writes for a
frequency: type up to 20 frequencies into a 10-mode VHF codeplug (Tx of modes
1-10, then talk-around of modes 10-1), SAVE, and print what RSS stored.

Usage: scenario_vhf_band_sweep.py <sandbox_c> <workdir> <MHz> [<MHz> ...]
The sandbox needs a VHF radio with >= 10 modes and talk-around enabled
(617ASQ). RSS overwrites a frequency field in place, so values are typed
full width (NNN.NNNNN). Prints: field mode MHz -> stored MHz, lo, mid, band.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from trace_lib import Harness
import rss_nav as N
from scenario_enum_map import robust_boot, reget
from motreader.archive import Archive
from motreader.crypto import decrypt_body
from motreader.codeplug import Codeplug


def typ(d, text):
    for ch in text:
        d.send_keys(ch); time.sleep(0.15)
    time.sleep(0.3)


def main():
    sandbox_c, workdir = sys.argv[1:3]
    freqs = [float(x) for x in sys.argv[3:]]
    if not 1 <= len(freqs) <= 20:
        raise SystemExit("1..20 frequencies")
    # TA values go to modes n..1 after the Tx pass, so at most as many as Tx values
    tx, ta = freqs[:10], freqs[10:]
    arch_dir = os.path.join(sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
    os.makedirs(workdir, exist_ok=True)
    out = os.path.join(workdir, "sweep.bin")
    with Harness(sandbox_c, workdir, cycles=120000) as h:
        d = h.connect()
        robust_boot(d)
        reget(d)
        N.to_main(d)
        N.key_to(d, "f4", "CHANGE / VIEW")
        N.key_to(d, "f5", "MODE CONFIGURATION")
        for k in ("enter", "enter"):            # NAME -> Rx -> Tx
            d.send_keys(k); time.sleep(0.6)
        for i, f in enumerate(tx):              # Tx of modes 1..n; F4 keeps the field
            typ(d, f"{f:09.5f}")
            if i < len(tx) - 1:
                d.send_keys("f4"); time.sleep(0.9)
        d.send_keys("enter"); time.sleep(0.6)   # commit the last Tx -> TALKAROUND
        if ta:
            d.send_keys("enter"); time.sleep(0.6)   # -> TA Frequency
            for f in ta:                        # TA of modes n..1; F3 commits + previous
                typ(d, f"{f:09.5f}")
                d.send_keys("f3"); time.sleep(0.9)
        N.to_main(d)
        N.save(d, arch_dir, out)
        d.close()
    cp = Codeplug.parse(decrypt_body(Archive.load(out).body))
    for i, f in enumerate(tx):
        m = cp.modes[i]
        print(f"tx mode {m.number:2d} {f:9.4f} -> {m.tx_mhz} lo={m.raw[10]} mid={m.raw[11]} band=0x{m.raw[12]:02x}")
    for i, f in enumerate(ta):
        m = cp.modes[len(tx) - 1 - i]
        print(f"ta mode {m.number:2d} {f:9.4f} -> {m.ta_mhz} lo={m.raw[14]} mid={m.raw[15]} band=0x{m.raw[16]:02x}")


if __name__ == "__main__":
    main()
