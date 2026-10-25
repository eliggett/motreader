#!/usr/bin/env python3
"""Control-channel client for the motreader-patched dosbox-x (Phase-1 harness).

The patched dosbox-x serves a line-oriented command protocol on a Unix socket
(path = env DOSBOX_CTLSOCK the emulator was launched with). This is the host
side: a small library (class `Dbx`) plus a CLI for ad-hoc commands. It is the
foundation the eventual MCP veneer wraps.

See notes/PHASE1-HARNESS.md s5.4/s8 for the command set. Everything here is
synchronous request/response (one command -> one reply), except read-screen
(multi-line, terminated by a ".").

CLI:
    python tools/dbxctl.py <sock> <command...>
    python tools/dbxctl.py <sock> screen          # pretty-print the screen
    python tools/dbxctl.py <sock> regs
    python tools/dbxctl.py <sock> read-mem 7abcd 32
"""
import socket as _socket
import sys
import time


class Dbx:
    def __init__(self, path, timeout=30.0, connect_retries=60):
        self.path = path
        self.sock = None
        self._buf = b""
        last = None
        for _ in range(connect_retries):
            try:
                s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
                s.settimeout(timeout)
                s.connect(path)
                self.sock = s
                return
            except OSError as e:          # socket not up yet
                last = e
                time.sleep(0.5)
        raise last

    # ---- low level ----
    def _send(self, line):
        self.sock.sendall(line.encode() + b"\n")

    def _readline(self):
        while b"\n" not in self._buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("control socket closed")
            self._buf += chunk
        i = self._buf.index(b"\n")
        line = self._buf[:i]
        self._buf = self._buf[i + 1:]
        return line.decode(errors="replace")

    def cmd(self, line):
        """Send a command, return the single reply line."""
        self._send(line)
        return self._readline()

    # ---- typed helpers ----
    def ping(self):
        return self.cmd("ping")

    def regs(self):
        r = self.cmd("regs")
        out = {}
        for tok in r.split()[1:]:
            if "=" in tok:
                k, v = tok.split("=", 1)
                out[k] = int(v, 16) if k != "cyc" else int(v)
        return out

    def instr_count(self):
        return int(self.cmd("instr-count").split()[1])

    def read_mem(self, addr, length):
        r = self.cmd(f"read-mem {addr:x} {length}")
        parts = r.split()
        if parts[0] != "mem":
            raise RuntimeError(f"read-mem failed: {r}")
        return bytes.fromhex(parts[2]) if len(parts) > 2 else b""

    def find(self, pattern):
        """pattern: bytes. Returns list of physical addresses."""
        r = self.cmd("find " + pattern.hex())
        parts = r.split()
        if len(parts) < 2 or parts[1] == "none":
            return []
        return [int(x, 16) for x in parts[1:]]

    def set_watch(self, lo, hi, rw="rw", brk=False, value=None):
        """Watch [lo, hi). rw: 'r'|'w'|'rw'. brk=True pauses the CPU right after
        a matching access (optionally only when the accessed value == value);
        then use hit() / context() and cont()."""
        mode = rw + ("b" if brk else "")
        tail = f" {value:x}" if value is not None else ""
        return self.cmd(f"set-watch {lo:x} {hi:x} {mode}{tail}")

    def hit(self):
        """Last break-on-watch hit as a dict (or None)."""
        r = self.cmd("hit").split()
        if r[1] == "none":
            return None
        out = {"write": r[1] == "W"}
        for kv in r[2:]:
            k, v = kv.split("=")
            if k == "at":
                cs, ip = v.split(":")
                out["cs"], out["ip"] = int(cs, 16), int(ip, 16)
            elif k == "cyc":
                out["cyc"] = int(v)
            else:
                out[k] = int(v, 16)
        return out

    def file_log(self, clear=False):
        """INT 21h file reads since start/clear: [(name, pos, dest, n, cyc)]."""
        if clear:
            return self.cmd("file-log clear")
        self._send("file-log")
        out = []
        while True:
            line = self._readline()
            if line == ".":
                return out
            name, *kv = line.split()
            d = dict(x.split("=") for x in kv)
            out.append((name, int(d["pos"], 16), int(d["dest"], 16), int(d["n"], 16), int(d["cyc"])))

    def save_state(self, path):
        """Snapshot the whole emulator to a file (only while running, not
        while frozen at a breakpoint)."""
        r = self.cmd(f"save-state {path}")
        if r != "ok":
            raise RuntimeError(r)

    def load_state(self, path):
        r = self.cmd(f"load-state {path}")
        if r != "ok":
            raise RuntimeError(r)

    def clear_watch(self):
        return self.cmd("clear-watch")

    def trace_base(self, addr):
        return self.cmd(f"trace-base {addr:x}")

    def trace_open(self, path):
        return self.cmd(f"trace-open {path}")

    def trace_close(self):
        return self.cmd("trace-close")

    def flush(self):
        return self.cmd("flush")

    def mark(self, label):
        return self.cmd(f"mark {label}")

    def set_bp(self, cs, ip):
        return self.cmd(f"set-bp {cs:x} {ip:x}")

    def clear_bp(self):
        return self.cmd("clear-bp")

    def bp_status(self):
        r = self.cmd("bp-status").split()
        hits = int(r[1].split("=")[1])
        return hits

    def step(self, n=1):
        return self.cmd(f"step {n}")

    def cont(self):
        return self.cmd("continue")

    def pause(self):
        return self.cmd("pause")

    def wait(self):
        """Block until the guest is paused; returns (cs, ip, cyc)."""
        r = self.cmd("wait").split()
        cs, ip = r[1].split(":")
        return int(cs, 16), int(ip, 16), int(r[2])

    def speed(self, v=None):
        return self.cmd("speed" if v is None else f"speed {v}")

    def send_keys(self, *toks):
        return self.cmd("send-keys " + " ".join(str(t) for t in toks))

    def read_screen(self, attrs=False):
        """Returns (rows, attr_rows_or_None). rows = list of 'rows' strings."""
        self._send("read-screen attrs" if attrs else "read-screen")
        hdr = self._readline()
        if hdr.startswith("screen notext"):
            return None, None
        _, cols, nrows = hdr.split()
        cols, nrows = int(cols), int(nrows)
        rows = [self._readline() for _ in range(nrows)]
        attr_rows = None
        line = self._readline()
        if line == "attrs":
            attr_rows = [self._readline() for _ in range(nrows)]
            line = self._readline()
        # line should now be "."
        return rows, attr_rows

    def screen_text(self, attrs=False):
        rows, _ = self.read_screen(attrs=attrs)
        return "\n".join(rows) if rows else "(not text mode)"

    def quit(self):
        try:
            self._send("quit")
            self._readline()
        except OSError:
            pass

    def close(self):
        if self.sock:
            self.sock.close()
            self.sock = None


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    path = sys.argv[1]
    args = sys.argv[2:]
    d = Dbx(path)
    if args[0] == "screen":
        print(d.screen_text(attrs=("attrs" in args)))
    elif args[0] == "regs":
        print(d.regs())
    else:
        # pass the raw command through
        line = " ".join(args)
        if line.startswith("read-screen"):
            print(d.screen_text(attrs=("attrs" in line)))
        else:
            print(d.cmd(line))
    d.close()


if __name__ == "__main__":
    main()
