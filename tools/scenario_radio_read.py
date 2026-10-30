#!/usr/bin/env python3
"""Boot RSS with COM1/COM2 on dosbox-x's `rib` backend, each wired to a
tools/fake_radio.py instance, and run READ (GET/SAVE -> F2), or with
--program: GET the sandbox's archive, then PROGRAM it (GET/SAVE -> F8).
Prints the screens along the way; the radios' message logs and memory dumps
land in the workdir.

With --save DST (READ only): once the read finishes, SAVE it to the
archive and copy the archive file to DST.

With --link real, COM1 is the host's real port (--realport, default
ttyUSB0) through directserial rib:1: a real radio on a RIB.
With --link pty|pty-rib, COM1 is instead dosbox-x's directserial on a
pseudo-terminal served by tools/pty_rib.py (the real-port code path);
pty-rib adds the rib:1 option. --echo-delay simulates USB latency.

Usage: scenario_radio_read.py <sandbox_c> <workdir> [--image FILE] [--wait S]
                              [--program] [--save DST] [--set ADDR=HEX]
                              [--link rib|pty|pty-rib|real] [--echo-delay MS]
                              [--serial-opts "rxdelay:30 ..."]
"""
import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from trace_lib import Harness  # noqa: E402
from rss_nav import (scr, wait_for, key_to, to_main, boot_and_get,  # noqa: E402
                     save)

PORTS = {1: 7600, 2: 7601}


def show(d, title):
    print(f"----- {title} -----")
    for r in d.read_screen()[0] or []:
        if r.strip():
            print("  |" + r.rstrip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sandbox_c")
    ap.add_argument("workdir")
    ap.add_argument("--image")
    ap.add_argument("--wait", type=float, default=60)
    ap.add_argument("--program", action="store_true")
    ap.add_argument("--clone", metavar="SERIAL",
                    help="like --program, but through CLONE MENU -> F8, "
                         "entering SERIAL as the target radio's serial")
    ap.add_argument("--save")
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--link", choices=("rib", "pty", "pty-rib", "real"), default="rib")
    ap.add_argument("--realport", default="ttyUSB0",
                    help="with --link real: the host port (directserial rib:1)")
    ap.add_argument("--echo-delay", type=float, default=0.0)
    ap.add_argument("--serial-opts", default="",
                    help="extra directserial options, e.g. rxdelay:30")
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)

    radios = []
    if a.link == "real":
        conf = (f"[serial]\nserial1=directserial realport:{a.realport} rib:1"
                + (" " + a.serial_opts if a.serial_opts else "") + "\n")
    elif a.link != "rib":
        cmd = [sys.executable, os.path.join(HERE, "pty_rib.py"),
               "--log", os.path.join(a.workdir, "radio_pty.log"),
               "--echo-delay", str(a.echo_delay)]
        if a.image:
            cmd += ["--image", a.image]
        for spec in a.set:
            cmd += ["--set", spec]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
        radios.append(p)
        dev = p.stdout.readline().strip()            # /dev/pts/N
        opt = (" rib:1" if a.link == "pty-rib" else "") + \
            (" " + a.serial_opts if a.serial_opts else "")
        conf = f"[serial]\nserial1=directserial realport:{dev[5:]}{opt}\n"
    for com, port in PORTS.items():
        if a.link != "rib":
            break
        cmd = [sys.executable, os.path.join(HERE, "fake_radio.py"),
               "--port", str(port),
               "--log", os.path.join(a.workdir, f"radio_com{com}.log"),
               "--dump", os.path.join(a.workdir, f"radio_com{com}.bin")]
        if a.image:
            cmd += ["--image", a.image]
        for spec in a.set:
            cmd += ["--set", spec]
        radios.append(subprocess.Popen(cmd))
    time.sleep(1)
    if a.link == "rib":
        conf = "[serial]\n" + "".join(
            f"serial{com}=rib port:{port}\n" for com, port in PORTS.items())
    try:
        with Harness(a.sandbox_c, a.workdir, extra_conf=conf) as h:
            d = h.connect()
            if a.clone:
                a.program = True
            if a.program:
                boot_and_get(d)                     # leaves us in GET/SAVE
            else:
                if wait_for(d, "Press Any Key", tries=150):
                    d.send_keys("enter")
                if not wait_for(d, "MAIN MENU", tries=150):
                    to_main(d)
                if not key_to(d, "f3", "GET / SAVE MENU"):
                    raise RuntimeError("no GET/SAVE menu")
            show(d, "start")
            if a.clone:
                d.send_keys("f5")                   # CLONE MENU
                wait_for(d, "CLONE RADIO")
                d.send_keys("f8")
                wait_for(d, "Enter Radio Serial Number")
                for ch in a.clone.lower():
                    d.send_keys(ch)
                    time.sleep(0.15)
                d.send_keys("enter")
                time.sleep(1.0)
                show(d, "clone screen")
            d.send_keys("f8" if a.program else "f2")   # PROGRAM / READ
            t_end = time.time() + a.wait
            last = None
            while time.time() < t_end:
                s = scr(d)
                if s != last:
                    show(d, f"t+{a.wait - (t_end - time.time()):.0f}s")
                    last = s
                    if a.program and ("Press F8 AGAIN" in s
                                      or "Program TARGET" in s):
                        d.send_keys("f8")
                model = s.split("Model:", 1)[1].split("\n", 1)[0].strip() \
                    if "Model:" in s else ""
                if a.save and "GET / SAVE MENU" in s and model:
                    break
                time.sleep(1.0)
            if a.save:
                arch = os.path.join(a.sandbox_c, "MRSS", "SPECTRA", "ARCHIVE")
                print("saved to", save(d, arch, a.save))
    finally:
        for p in radios:
            p.terminate()
            try:
                p.wait(timeout=5)
            except Exception:
                p.kill()


if __name__ == "__main__":
    main()
