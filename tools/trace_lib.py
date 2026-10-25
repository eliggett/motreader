"""Launch/teardown for the motreader Phase-1 harness: the patched dosbox-x
under a private Xvfb, serving the control socket. Owns the full lifecycle and
*always* kills its dosbox-x and Xvfb on exit (standing user instruction: stray
quit dialogs accumulate on the desktop otherwise).

Several harnesses can run at once (up to ~4 on an 8-core machine): give each
its own X display with $MOT_DISP (e.g. :101) and its own sandbox. Each one
only kills its own processes; the display's stale Xvfb is cleared on start.

Typical use:

    from trace_lib import Harness
    with Harness(sandbox_c) as h:
        d = h.connect()          # returns a dbxctl.Dbx
        ... drive via d ...
    # dosbox-x + Xvfb killed here, unconditionally
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from dbxctl import Dbx

DBX = os.environ.get(
    "DBX", os.path.join(ROOT, "dosbox-x", "src", "dosbox-x"))


def kill_all(disp=":99"):
    """The standing cleanup: SIGKILL every dosbox-x and the private Xvfb.
    (Not used by Harness, which only kills its own processes so parallel
    harnesses can coexist.)"""
    subprocess.run(["pkill", "-9", "-x", "dosbox-x"], check=False)
    subprocess.run(["pkill", "-9", "-f", f"Xvfb {disp}"], check=False)


def _kill_display(disp):
    """SIGKILL a stale Xvfb on this display (from a crashed earlier run)."""
    subprocess.run(["pkill", "-9", "-f", f"^Xvfb {disp} "], check=False)


CONF_TEMPLATE = """\
[sdl]
output=surface
autolock=false
[dosbox]
machine=svga_s3
working directory option = noprompt
memsize=4
[cpu]
cputype=386
core=simple
cycles={cycles}
[parallel]
parallel1=file append:printout.prn timeout:2000
[autoexec]
mount c "{sandbox_c}"
c:
cd \\MRSS\\SPECTRA
SPECTRA.EXE
"""


class Harness:
    def __init__(self, sandbox_c, workdir, disp=None, cycles=20000):
        self.sandbox_c = sandbox_c
        self.workdir = workdir
        self.disp = disp or os.environ.get("MOT_DISP", ":99")
        self.cycles = cycles
        # AF_UNIX paths are capped at ~108 chars, so the socket must live at a
        # short runtime path (not the long scratchpad workdir). Artifacts still
        # go in workdir.
        rundir = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
        self.sock = os.path.join(rundir, f"motrace{os.getpid()}.sock")
        self.conf = os.path.join(workdir, "dosbox-x.conf")
        self.xvfb = None
        self.dbx = None
        self.client = None

    def __enter__(self):
        os.makedirs(self.workdir, exist_ok=True)
        # the print-capture file lands in the launch CWD; run from workdir
        with open(self.conf, "w") as f:
            f.write(CONF_TEMPLATE.format(
                sandbox_c=self.sandbox_c, cycles=self.cycles))
        _kill_display(self.disp)
        time.sleep(1)
        # private X server
        self.xvfb = subprocess.Popen(
            ["Xvfb", self.disp, "-screen", "0", "1024x768x16"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2)
        env = dict(os.environ)
        env["DISPLAY"] = self.disp
        env["DOSBOX_CTLSOCK"] = self.sock
        logf = open(os.path.join(self.workdir, "dosbox.log"), "w")
        self.dbx = subprocess.Popen(
            [DBX, "-conf", self.conf],
            cwd=self.workdir, env=env, stdout=logf, stderr=subprocess.STDOUT)
        return self

    def connect(self, timeout=60.0):
        self.client = Dbx(self.sock, connect_retries=int(timeout * 2))
        return self.client

    def __exit__(self, *exc):
        try:
            if self.client:
                self.client.close()
        finally:
            # kill (and reap) only this harness's own dosbox-x and Xvfb
            for p in (self.dbx, self.xvfb):
                if p:
                    p.kill()
                    try:
                        p.wait(timeout=5)
                    except Exception:
                        pass
        return False


# ---------------------------------------------------------------------------
# White-box helpers on top of the control channel (break-on-watch + overlays)

def overlay_of(file_log, lin):
    """Map a linear code address to (file, file_offset) using the INT 21h
    file-read log: the most recent read whose destination covers it. RSS's
    Turbo Pascal overlays are loaded this way, so this names the .OVL/.EXE
    bytes that are executing at a CS:IP."""
    for name, pos, dest, n, _cyc in reversed(file_log):
        if dest <= lin < dest + n:
            return name, pos + (lin - dest)
    return None


RSS_DIR = os.path.expanduser("~/.dosbox/c/MRSS/SPECTRA")
_code_files = None


def locate_code(code, ip_index, rss_dir=RSS_DIR, win=16):
    """Find live code bytes in RSS's .EXE/.OVL files -> (file, offset of the
    byte at ip_index) or None. Content search, because Turbo Pascal's overlay
    manager both reloads overlays constantly and MOVES them inside its buffer
    with plain memory copies (no DOS read), so the file-read log alone can't
    say what is at an address. Several windows vote, so the few bytes the
    loader patches (relocation fixups) don't defeat it."""
    global _code_files
    if _code_files is None:
        _code_files = {}
        for fn in sorted(os.listdir(rss_dir)):
            if fn.upper().endswith((".EXE", ".OVL")):
                with open(os.path.join(rss_dir, fn), "rb") as f:
                    _code_files[fn] = f.read()
    votes = {}
    for start in range(0, len(code) - win + 1, win // 2):
        chunk = code[start:start + win]
        if len(set(chunk)) < 4:
            continue                      # too uniform to be informative
        for fn, data in _code_files.items():
            i = data.find(chunk)
            if i >= 0 and data.find(chunk, i + 1) < 0:    # unique in that file
                key = (fn, i - start + ip_index)
                votes[key] = votes.get(key, 0) + 1
    if not votes:
        return None
    best = max(votes, key=votes.get)
    return best if votes[best] >= 2 else None


def context(d, before=0x40, after=0x40, stack=0x40):
    """Snapshot of the CPU at a stop: registers, code bytes around CS:IP,
    the stack, and DS:SI / ES:DI windows, plus where the code came from."""
    regs = d.regs()
    lin =(regs["cs"] << 4) + regs["ip"]
    out = {
        "regs": regs,
        "lin": lin,
        "code_start": lin - before,
        "code": d.read_mem(lin - before, before + after),
        "stack": d.read_mem((regs["ss"] << 4) + regs["sp"], stack),
        "ds_si": d.read_mem((regs["ds"] << 4) + regs["si"], 0x20),
        "es_di": d.read_mem((regs["es"] << 4) + regs["di"], 0x20),
    }
    out["overlay"] = locate_code(out["code"], before) or \
        overlay_of(getattr(d, "prior_flog", []) + d.file_log(), lin)
    return out


def boot_cached(h, d, state_path, prepare):
    """Restore a saved emulator state if one exists, else run prepare(d) (e.g.
    boot RSS + GET the radio) and save the state for next time. Turns a
    2-4 minute boot into ~1 s. The state belongs to one sandbox/config: delete
    it when the sandbox changes."""
    import json
    flog_path = state_path + ".flog.json"
    if os.path.exists(state_path):
        # load only once the machine is fully up (RSS drawing text): loading
        # during early emulator init crashes dosbox-x
        for _ in range(120):
            rows = d.read_screen()[0]
            if rows and any(r.strip() for r in rows):
                break
            time.sleep(0.5)
        time.sleep(1.0)
        d.load_state(state_path)
        time.sleep(1.0)
        # the emulator's file-read log is not part of the state: reuse the one
        # recorded up to the save, so overlays loaded before it stay mappable
        with open(flog_path) as f:
            d.prior_flog = [tuple(x) for x in json.load(f)]
        d.file_log(clear=True)
        return "restored"
    prepare(d)
    d.save_state(state_path)
    with open(flog_path, "w") as f:
        json.dump(d.file_log(), f)
    d.prior_flog = []
    return "saved"
