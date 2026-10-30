#!/usr/bin/env python3
"""A fake Spectra on the far side of dosbox-x's `rib` serial backend.

dosbox-x (serialN=rib port:N) models the RIB and bus: echo and BUSY timing
stay inside the emulator. This end plays the radio: it decodes RSS's SB9600
messages, logs them, answers codeplug reads from a memory image and applies
writes to it.

Usage: fake_radio.py [--port 7600] [--image FILE] [--log FILE] [--dump FILE]
  --image  raw codeplug memory (address 0 = file offset 0); unset bytes read 0xFF
  --dump   write the memory image here on disconnect (to capture RSS writes)
  --set    ADDR=HEXBYTES, poke bytes over the image (repeatable)
"""
import argparse
import os
import socket
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from motreader import sb9600 as sb  # noqa: E402


SCRAMBLED_SESSIONS = (0xD1, 0x51)


class Radio:
    def __init__(self, mem, log):
        self.mem = mem
        self.log = log
        self.t0 = time.monotonic()
        self.rx = bytearray()      # bytes of the message in progress
        self.reads = self.writes = 0
        self.session = None        # MODE byte 1 that opened the current session
        self.chain = None          # payload[2] of the last scrambled read

    def is_scrambled(self, p):
        """Whether RSS scrambled this read. A scrambled read sends data 0, so
        its first frame has p0 == p1; later frames of the same read carry the
        previous frame's scrambled byte 2 as their data. Only the codeplug
        sessions (0xd1, and 0x51 for a second control head) scramble."""
        if self.session not in SCRAMBLED_SESSIONS:
            return False
        if self.chain is not None and sb.unscramble(*p[:3])[2] == self.chain:
            return True
        return p[0] == p[1]

    def note(self, msg):
        self.log.write(f"{time.monotonic() - self.t0:9.3f} {msg}\n")
        self.log.flush()

    def message(self, m):
        """A full 5-byte message from RSS; returns the reply bytes (or b"")."""
        p, c = m[:4], m[4]
        ok = "ok" if sb.crc(p) == c else f"BADCRC want {sb.crc(p):02x}"
        op = p[3]
        desc = ""
        reply = b""
        if op != sb.OP_READ:
            self.chain = None
        if op == sb.OP_READ:
            scr = self.is_scrambled(p)
            self.chain = p[2] if scr else None
            hi, lo, _ = sb.unscramble(*p[:3]) if scr else (p[0], p[1], p[2])
            a = hi << 8 | lo
            data = bytes([self.mem.get(a, 0xFF), self.mem.get(a + 1, 0xFF)])
            if scr:
                reply = sb.read_reply(data, True)
            elif self.session == 0xB1:
                # S9000e region: byte 0 carries a third data byte (RSS reads
                # 3 per message here)
                reply = sb.read_reply(data, False, r0=self.mem.get(a + 2, 0xFF))
            else:
                # the real radio echoes the address's high byte in byte 0
                reply = sb.read_reply(data, False, r0=hi)
            desc = f"READ {a:04x}{' scr' if scr else ''} -> {data.hex()}"
            self.reads += 1
        elif op == sb.OP_WRITE:
            # writes carry their own data byte, so they never chain
            scr = self.session in SCRAMBLED_SESSIONS
            hi, lo, v = sb.unscramble(*p[:3]) if scr else (p[0], p[1], p[2])
            a = hi << 8 | lo
            self.mem[a] = v
            desc = f"WRITE {a:04x}={v:02x}{' scr' if scr else ''}"
            if not scr:
                uh, ul, ud = sb.unscramble(*p[:3])
                desc += f" (if scrambled: {uh << 8 | ul:04x}={ud:02x})"
            self.writes += 1
        elif op == sb.OP_MODE:
            desc = f"MODE {p[:3].hex()}"
            if p[0] == 0 and p[1] in (0x90, 0x92):
                self.session = None
            elif p[0] == 0:
                self.session = p[1]
        else:
            desc = f"OP {op:02x} {p[:3].hex()}"
            if op & 0x80:
                desc += " (wants a reply; none sent)"
        self.note(f"<- {m.hex()} {ok}  {desc}")
        if reply:
            self.note(f"-> {reply.hex()}")
        return reply


def serve(port, radio, dump):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(1)
    radio.note(f"listening on {port}")
    conn, _ = srv.accept()
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    radio.note("emulator connected")
    buf = b""
    try:
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
            while len(buf) >= 2:
                kind, val = buf[0], buf[1]
                buf = buf[2:]
                if kind == ord("B"):
                    radio.note(f"   PC BUSY {val}")
                    if val:
                        radio.rx.clear()     # a new message starts
                elif kind == ord("R"):
                    radio.note(f"   rate {val * 100} baud")
                elif kind == ord("D"):
                    radio.rx.append(val)
                    if len(radio.rx) == 5:
                        reply = radio.message(bytes(radio.rx))
                        radio.rx.clear()
                        if reply:
                            out = b"B\x01" + b"".join(
                                b"D" + bytes([x]) for x in reply) + b"B\x00"
                            conn.sendall(out)
    finally:
        radio.note(f"disconnected: {radio.reads} reads, {radio.writes} writes")
        if dump:
            top = max(radio.mem) + 1 if radio.mem else 0
            with open(dump, "wb") as f:
                f.write(bytes(radio.mem.get(a, 0xFF) for a in range(top)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7600)
    ap.add_argument("--image")
    ap.add_argument("--log")
    ap.add_argument("--dump")
    ap.add_argument("--set", action="append", default=[])
    a = ap.parse_args()
    mem = {}
    if a.image:
        mem = dict(enumerate(open(a.image, "rb").read()))
    for spec in a.set:
        addr, hexbytes = spec.split("=")
        for i, v in enumerate(bytes.fromhex(hexbytes)):
            mem[int(addr, 16) + i] = v
    log = open(a.log, "w") if a.log else sys.stdout
    serve(a.port, Radio(mem, log), a.dump)


if __name__ == "__main__":
    main()
