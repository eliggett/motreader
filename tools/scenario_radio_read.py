#!/usr/bin/env python3
"""Boot RSS with COM1/COM2 on dosbox-x's `rib` backend, each wired to a
tools/fake_radio.py instance, and run READ (GET/SAVE -> F2), or with
--program: GET the sandbox's archive, then PROGRAM it (GET/SAVE -> F8).
Prints the screens along the way; the radios' message logs and memory dumps
land in the workdir.

With --save DST (READ only): once the read finishes, SAVE it to the
archive and copy the archive file to DST.

Usage: scenario_radio_read.py <sandbox_c> <workdir> [--image FILE] [--wait S]
                              [--program] [--save DST]
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
    ap.add_argument("--save")
    ap.add_argument("--set", action="append", default=[])
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)

    radios = []
    for com, port in PORTS.items():
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
    conf = "[serial]\n" + "".join(
        f"serial{com}=rib port:{port}\n" for com, port in PORTS.items())
    try:
        with Harness(a.sandbox_c, a.workdir, extra_conf=conf) as h:
            d = h.connect()
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
            d.send_keys("f8" if a.program else "f2")   # PROGRAM / READ
            t_end = time.time() + a.wait
            last = None
            while time.time() < t_end:
                s = scr(d)
                if s != last:
                    show(d, f"t+{a.wait - (t_end - time.time()):.0f}s")
                    last = s
                    if a.program and "Press F8 AGAIN" in s:
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
