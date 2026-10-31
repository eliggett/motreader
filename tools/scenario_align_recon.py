#!/usr/bin/env python3
"""Boot RSS and walk SERVICE -> ALIGNMENT: open each adjustment screen, wait,
print it, and leave with F10. By default it presses nothing else, so RSS
only reads and sets up the radio as it does on entering a screen; --keys
presses more in each screen (arrows, F2-F4, F6 PTT, F8 program), F6 and F8
only on an emulated radio.
MOT_RIBDEBUG=1 puts every byte in dosbox.log; decode it with
tools/rib_log_decode.py.

Leaving SERVICE is not read-only: RSS re-reads MCU EEPROM 0xB600..0xB7FE
and rewrites a few bytes, among them the check byte 0xB7FF, from what it
read. A bus error there corrupts it (FL 01/92 at power-up). So on any
"Serial Bus Failure" this stops at once, without leaving SERVICE: it kills
dosbox-x and (real radio) sends MODE_DONE to restart the radio itself. It
ends that way too unless --leave is given. At the end it reads the real
radio's 0xB6A0..0xB7FF and checks the sum.

Links:
  real     COM1 = the host port (--realport) through directserial rib:1
  pty-rib  directserial rib:1 on a pty served by tools/pty_rib.py (no BUSY)
  pty-bus  the same with BUSY modelled (tools/ptybus/ptybus.so preloaded:
           RIB lag and a 2 ms TIOCMGET, as on an FT232R)
  rib      dosbox-x's rib backend + tools/fake_radio.py (BUSY modelled)

Usage: scenario_align_recon.py <sandbox_c> <workdir> [--link real|pty-rib|pty-bus|rib]
           [--image FILE] [--realport ttyUSB0] [--screens f2,f3,f5,f7,f7f9,f8]
           [--dwell S] [--serial-opts "..."] [--leave]
"""
import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, ".."))
from trace_lib import Harness  # noqa: E402
from rss_nav import scr, wait_for  # noqa: E402

FAILURE = "Serial Bus Failure"


class BusFailure(Exception):
    pass


def show(d, title):
    print(f"----- {title} ({time.strftime('%H:%M:%S')}) -----", flush=True)
    for r in d.read_screen()[0] or []:
        if r.strip():
            print("  |" + r.rstrip())
    sys.stdout.flush()


def settle(d, secs):
    """Wait secs, printing each new screen; BusFailure on a bus error."""
    last = None
    t_end = time.time() + secs
    while time.time() < t_end:
        s = scr(d)
        if s != last:
            show(d, "screen")
            last = s
            if FAILURE in s:
                raise BusFailure(s)
        time.sleep(0.3)


def restart_radio(port):
    """MODE_DONE: leaves programming mode (the radio restarts)."""
    from motreader.radio import SerialLink, Radio, MODE_DONE
    link = SerialLink("/dev/" + port)
    try:
        Radio(link).mode(*MODE_DONE)
    finally:
        link.close()


def check_mcu_sum(port):
    from motreader.radio import SerialLink, Radio, SESSION_MCU
    link = SerialLink("/dev/" + port)
    r = Radio(link)
    try:
        with r.session(SESSION_MCU):
            d = r.read(0xB6A0, 0x160, False)
    finally:
        r.finish()
        link.close()
    s = sum(d) & 0xFF
    print(f"MCU EEPROM sum 0xB6A0..0xB7FF = {s:02x} "
          f"({'OK' if s == 0 else 'BAD: radio will show FL 01/92'}), "
          f"0xB7FF = {d[-1]:02x}", flush=True)
    return s == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sandbox_c")
    ap.add_argument("workdir")
    ap.add_argument("--link", choices=("real", "pty-rib", "pty-bus", "rib"), default="real")
    ap.add_argument("--image")
    ap.add_argument("--realport", default="ttyUSB0")
    ap.add_argument("--screens", default="f2,f3,f5,f7,f7f9,f8")
    ap.add_argument("--dwell", type=float, default=12)
    ap.add_argument("--serial-opts", default="")
    ap.add_argument("--chatter-delay", type=float, default=10.0)
    ap.add_argument("--leave", action="store_true",
                    help="leave SERVICE through RSS (it rewrites MCU EEPROM "
                         "bytes, 0xB7FF among them); default: kill dosbox-x "
                         "in SERVICE and restart the radio with MODE_DONE")
    ap.add_argument("--keys", default="",
                    help="keys pressed in each screen after it opens, e.g. "
                         "up,up,down,f3,f6,f6,f8 (F6 = PTT, F8 = program: "
                         "refused on the real radio)")
    ap.add_argument("--key-dwell", type=float, default=3)
    a = ap.parse_args()
    actions = [k for k in a.keys.split(",") if k]
    if a.link == "real" and {"f6", "f8"} & set(actions):
        sys.exit("refusing F6 (PTT) / F8 (program) on the real radio")
    os.makedirs(a.workdir, exist_ok=True)
    os.environ["MOT_RIBDEBUG"] = "1"
    opts = (" " + a.serial_opts) if a.serial_opts else ""
    procs = []
    if a.link == "real":
        conf = f"[serial]\nserial1=directserial realport:{a.realport} rib:1{opts}\n"
    elif a.link in ("pty-rib", "pty-bus"):
        cmd = [sys.executable, os.path.join(HERE, "pty_rib.py"),
               "--log", os.path.join(a.workdir, "radio_pty.log"),
               "--chatter-delay", str(a.chatter_delay)]
        if a.link == "pty-bus":
            shm = os.path.join(a.workdir, "bus.shm")
            cmd += ["--bus", shm]
            os.environ["LD_PRELOAD"] = os.path.join(HERE, "ptybus", "ptybus.so")
            os.environ["MOT_PTYBUS"] = shm
            os.environ.setdefault("MOT_PTYBUS_STALL_US", "2000")
        if a.image:
            cmd += ["--image", a.image]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
        procs.append(p)
        dev = p.stdout.readline().strip()
        conf = f"[serial]\nserial1=directserial realport:{dev[5:]} rib:1{opts}\n"
    else:
        cmd = [sys.executable, os.path.join(HERE, "fake_radio.py"),
               "--port", "7600", "--log", os.path.join(a.workdir, "radio.log"),
               "--dump", os.path.join(a.workdir, "radio.bin")]
        if a.image:
            cmd += ["--image", a.image]
        procs.append(subprocess.Popen(cmd))
        time.sleep(1)
        conf = "[serial]\nserial1=rib port:7600\n"
    failed = False
    try:
        with Harness(a.sandbox_c, a.workdir, extra_conf=conf) as h:
            d = h.connect()
            try:
                if wait_for(d, "Press Any Key", tries=150):
                    d.send_keys("enter")
                if not wait_for(d, "MAIN MENU", tries=150):
                    raise RuntimeError("no MAIN MENU:\n" + scr(d))
                print("MARK service", time.time(), flush=True)
                d.send_keys("f2")
                settle(d, 15)
                print("MARK alignment", time.time(), flush=True)
                d.send_keys("f2")
                settle(d, 15)
                for spec in a.screens.split(","):
                    keys = [spec[i:i + 2] for i in range(0, len(spec), 2)]
                    for k in keys:
                        print("MARK", spec, k, time.time(), flush=True)
                        d.send_keys(k)
                        settle(d, a.dwell)
                    for k in actions:
                        print("MARK", spec, "key", k, time.time(), flush=True)
                        d.send_keys(k)
                        settle(d, a.key_dwell)
                    for k in keys:
                        print("MARK", spec, "f10", time.time(), flush=True)
                        d.send_keys("f10")
                        settle(d, 8)
                print("MARK exit-alignment", time.time(), flush=True)
                d.send_keys("f10")
                settle(d, 10)
                if a.leave:
                    print("MARK exit-service", time.time(), flush=True)
                    d.send_keys("f10")
                    settle(d, 60)
                else:
                    failed = None        # stop here; MODE_DONE below
                print("MARK done", time.time(), flush=True)
            except BusFailure:
                failed = True
                print("ABORT: bus failure; not leaving SERVICE", flush=True)
    finally:
        for p in procs:
            p.terminate()
            try:
                p.wait(timeout=5)
            except Exception:
                p.kill()
    if a.link == "real":
        if failed is not False:
            restart_radio(a.realport)
            time.sleep(10)          # the radio restarts (RESTART_WAIT)
        check_mcu_sum(a.realport)
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()
