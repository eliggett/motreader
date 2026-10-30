"""Read a Spectra over a RIB, the way RSS does (notes/RADIO-PROTOCOL.md).

Wiring (RSS's RIB cable): DTR drives the SB9600 BUSY line, BUSY comes back on
CTS (tied to RI), and every transmitted byte is echoed by the bus.

Layers:

* ``SerialLink`` sends one SB9600 message and returns the reply (pyserial).
  Any object with the same ``transact(payload) -> bytes | None`` works, which
  is how the tests drive a simulated radio.
* ``Radio`` opens sessions and reads memory: the codeplug EEPROM at 0x6000
  (scrambled) and the MCU bytes RSS checks.

Reads change nothing. ``Radio.program`` writes a codeplug the way RSS does
(checked against RSS programming a real 617ASQ): see its docstring.
"""

from __future__ import annotations

import random
import time
from contextlib import contextmanager
from dataclasses import dataclass, field

from . import sb9600 as sb

CODEPLUG_BASE = 0x6000
BLOCK = 0x100
# The codeplug EEPROM is 8 KB (0x6000-0x7FFF): a blank radio makes RSS read
# to 0x7DFF, and the largest archive on hand is 0x1F00 bytes.
EEPROM_SIZE = 0x2000
SERIAL = slice(0x1D, 0x27)      # in the codeplug, e.g. "617ASQ1266"
MODEL = slice(0x44, 0x58)       # " 503D43KMA7JA5BK    "

# MODE (open, close) payloads per session, as RSS sends them.
SESSION_CODEPLUG = ((0xD1, 0x01), (0x90, 0x01))
SESSION_MCU = ((0x93, 0x01), (0x92, 0x01))
# S9000e (A9 head) radios: a second 8 KB codeplug region at 0x8000, in its
# own unscrambled session, three bytes per read message (traced from RSS
# against the fake radio; not yet seen on a real S9000e radio).
SESSION_EXT = ((0xB1, 0x05), (0x90, 0x05))
EXT_BASE = 0x8000
EXT_SIZE = 0x2000
MODE_DONE = (0x10, 0x01)        # RSS ends every READ with this

# 68HC11 register block: some reads have side effects (serial port flags),
# so memory dumps skip it unless asked.
HC11_REGISTERS = (0x1000, 0x1040)

# MCU bytes RSS reads during READ: b675.. starts the model number ("D43"),
# b69f.. unknown.
MCU_PROBES = ((0xB675, 3), (0xB69F, 4))
# RSS reads a pointer at ROM 0xFFC6 (codeplug session) to the radio's option
# block in MCU EEPROM (0xB681 on a 617ASQ); its first 6 bytes become archive
# prefix bytes 13..18 (a superset of the header's option bytes 0x6032..0x6037).
OPTIONS_POINTER = 0xFFC6
OPTIONS_LEN = 16


# RSS writes this MCU EEPROM byte after programming (0x39 on every radio
# seen, real and emulated); its meaning is unknown.
PROGRAMMED_FLAG = (0xB6A0, 0x39)


def split_dump(space: bytes) -> list[tuple[str, int, bytes, str]]:
    """Named pieces of a 64 KB address-space dump (68HC11 map as seen on a
    617ASQ): [(filename, start, bytes, description)]. On S9000e radios the
    0x8000-0x9FFF region is codeplug EEPROM instead of firmware."""
    cp_len = codeplug_length(space[CODEPLUG_BASE:CODEPLUG_BASE + 0x100]) \
        if space[CODEPLUG_BASE:CODEPLUG_BASE + 9] == b"COPYRIGHT" else 0
    ext = bool(cp_len) and has_ext_region(space[CODEPLUG_BASE:])
    parts = [
        ("ram.bin", 0x0000, 0x1000, "RAM (live state when dumped)"),
        ("firmware_low.bin", 0x1100, 0x6000, "code and tables below the codeplug"),
        ("codeplug_eeprom.bin", 0x6000, 0x8000, "codeplug EEPROM, all 8 KB"),
        ("codeplug.bin", 0x6000, 0x6000 + cp_len,
         "the codeplug in use (archive body from offset 0xAD)"),
    ]
    if ext:
        parts += [("codeplug_ext.bin", EXT_BASE, EXT_BASE + EXT_SIZE,
                   "S9000e second codeplug region (archive continues with it)"),
                  ("firmware.bin", 0xA000, 0x10000, "firmware ROM 0xA000-0xFFFF")]
    else:
        parts += [("firmware.bin", 0x8000, 0x10000,
                   "firmware ROM 0x8000-0xFFFF (includes the MCU EEPROM window)")]
    parts += [("mcu_eeprom.bin", 0xB600, 0xB800,
               "MCU EEPROM: serial, model, option block, alignment candidates")]
    return [(n, a, bytes(space[a:b]), d) for n, a, b, d in parts if b > a]


class BusError(Exception):
    pass


class ProgramRefused(Exception):
    pass


def has_ext_region(cp: bytes) -> bool:
    """S9000e / A9 head (header 0x60 b5 clear; FORMAT "Control Head Type"):
    the codeplug continues in the 0x8000 region. Every A9-head archive on
    hand is exactly EXT_SIZE longer than its header length; no other is."""
    return not cp[0x60] & 0x20


def codeplug_length(header: bytes) -> int:
    """Codeplug size from its header byte 0x1C: (k - 4) * 32, rounded up to
    whole blocks. Matches 51 of 57 archives on hand; of the rest, 604AUN's
    archive is one block shorter (reading extra is harmless) and the larger
    radios add a 0x2000 region not mapped yet."""
    n = (header[0x1C] - 4) * 32
    return -(-n // BLOCK) * BLOCK


class SerialLink:
    """One SB9600 message at a time over a RIB on a serial port.

    Unlike RSS we are not bound to a one-millisecond BUSY check: timeouts are
    generous so USB adapters' latency doesn't matter.
    """

    def __init__(self, port: str, *, echo_timeout=0.25, reply_timeout=0.6,
                 busy_timeout=2.0, tries=10, invert_busy=False, log=None):
        import serial  # pyserial; only needed for real ports

        self.ser = serial.Serial(port, 9600, bytesize=8, parity="N",
                                 stopbits=1, timeout=echo_timeout,
                                 rtscts=False, dsrdtr=False)
        try:
            self.ser.set_low_latency_mode(True)     # FTDI: 16 ms -> 1 ms
        except (AttributeError, NotImplementedError, OSError, ValueError):
            pass
        self.sense_busy = True
        self.drive_busy = True
        # some RIB cables invert BUSY (RadioConsole2 has the same option)
        self.invert_busy = invert_busy
        self._set_dtr(False)
        try:
            self.ser.rts = False
        except OSError:
            pass
        self.echo_timeout = echo_timeout
        self.reply_timeout = reply_timeout
        self.busy_timeout = busy_timeout
        self.tries = tries
        self.log = log

    def close(self):
        self._set_dtr(False)
        self.ser.close()

    def _set_dtr(self, on: bool):
        if not self.drive_busy:
            return
        try:
            self.ser.dtr = on != self.invert_busy
        except OSError:              # no modem lines (e.g. a pty)
            self.drive_busy = False

    def busy(self) -> bool:
        if not self.sense_busy:
            return False
        try:
            if self.invert_busy:
                return not (self.ser.ri and self.ser.cts)
            return bool(self.ser.ri or self.ser.cts)
        except OSError:              # no modem lines (e.g. a pty)
            self.sense_busy = False
            return False

    def _wait_idle(self):
        end = time.monotonic() + self.busy_timeout
        while self.busy():
            if time.monotonic() > end:
                raise BusError("BUSY line stuck (radio off, or cable/RIB fault?)")
            time.sleep(0.001)

    def _read(self, n, timeout):
        self.ser.timeout = timeout
        return self.ser.read(n)

    def transact(self, payload: bytes) -> bytes | None:
        msg = sb.frame(payload)
        wants_reply = bool(payload[3] & 0x80)
        for attempt in range(self.tries):
            if attempt:
                time.sleep(random.uniform(0.005, 0.03))
            self._wait_idle()
            self.ser.reset_input_buffer()
            self._set_dtr(True)
            try:
                # The whole message at once: the radio drops a message whose
                # bytes are spread out, and a USB round trip per byte is too
                # slow. The bus echoes it; a difference is a collision.
                self.ser.write(msg)
                if self._read(5, self.echo_timeout) != msg:
                    continue
                if not wants_reply:
                    time.sleep(0.02)
                    return None
                first = self._read(1, self.reply_timeout)
                self._set_dtr(False)        # RSS drops BUSY on the first reply byte
                if not first:
                    continue
                reply = first + self._read(4, self.reply_timeout)
                if len(reply) == 5:
                    if self.log:
                        self.log(f"{msg.hex()} -> {reply.hex()}")
                    return reply
            finally:
                self._set_dtr(False)
        raise BusError(f"no answer to {msg.hex()} after {self.tries} tries")


@dataclass
class ReadResult:
    codeplug: bytes                 # EEPROM from 0x6000
    mcu: dict = field(default_factory=dict)   # address -> bytes
    options: bytes = b""            # the option block (see OPTIONS_POINTER)

    def archive_body(self, nonce: bytes | None = None) -> bytes:
        """The decrypted archive body as RSS saves it: 13-byte nonce, the
        option block's first 6 bytes, zeros to 0xAD, then the codeplug."""
        nonce = nonce or bytes(random.randrange(256) for _ in range(13))
        prefix = bytearray(0xAD)
        prefix[:13] = nonce
        prefix[13:19] = self.options[:6].ljust(6, b"\0")
        return bytes(prefix) + self.codeplug


class Radio:
    def __init__(self, link, progress=None):
        self.link = link
        self.progress = progress or (lambda done, total: None)

    def mode(self, b1, b2):
        self.link.transact(bytes([0x00, b1, b2, sb.OP_MODE]))

    @contextmanager
    def session(self, which):
        (o1, o2), (c1, c2) = which
        self.mode(o1, o2)
        try:
            yield
        finally:
            self.mode(c1, c2)

    def read(self, addr: int, n: int, scrambled: bool, per_msg: int = 2) -> bytes:
        """Read n bytes from addr in the current session, per_msg bytes per
        message (1 or 2; 3 only unscrambled, where reply byte 0 is the third
        byte), chaining the scramble like RSS (10bd:02fb)."""
        out = bytearray()
        chain = 0
        while len(out) < n:
            hi, lo = addr >> 8 & 0xFF, addr & 0xFF
            if scrambled:
                p0, p1, p2 = sb.scramble(hi, lo, chain)
                chain = p2
            else:
                p0, p1, p2 = hi, lo, 0
            r = self.link.transact(bytes([p0, p1, p2, sb.OP_READ]))
            if r is None or r[3] != sb.OP_READ_REPLY:
                raise BusError(f"bad reply to read {addr:04x}: {r and r.hex()}")
            r1, r2 = (sb.unscramble_reply(*r[:3]) if scrambled else (r[1], r[2]))
            out.append(r2)
            if per_msg >= 2:
                out.append(r1)
            if per_msg == 3:
                out.append(r[0])
            addr += per_msg
        return bytes(out[:n])

    def read_codeplug(self) -> bytes:
        with self.session(SESSION_CODEPLUG):
            probe = self.read(CODEPLUG_BASE + 0x38, 3, True, per_msg=1)
        per = 1 if probe[1] == 0x28 else 2       # RSS's probe (1e34:0264)
        with self.session(SESSION_CODEPLUG):
            data = bytearray(self.read(CODEPLUG_BASE, BLOCK, True, per))
        if not data.startswith(b"COPYRIGHT MOTOROLA"):
            raise BusError("codeplug header not found at 0x6000: "
                           + bytes(data[:32]).hex())
        total = codeplug_length(data)
        self.progress(BLOCK, total)
        ext = has_ext_region(data)
        grand = total + (EXT_SIZE if ext else 0)
        for a in range(CODEPLUG_BASE + BLOCK, CODEPLUG_BASE + total, BLOCK):
            with self.session(SESSION_CODEPLUG):
                data += self.read(a, BLOCK, True, per)
            self.progress(len(data), grand)
        if ext:
            with self.session(SESSION_EXT):
                for a in range(EXT_BASE, EXT_BASE + EXT_SIZE, BLOCK):
                    data += self.read(a, BLOCK, False, per_msg=3)
                    self.progress(len(data), grand)
        return bytes(data)

    def read_mcu(self) -> dict:
        out = {}
        for addr, n in MCU_PROBES:
            with self.session(SESSION_MCU):
                out[addr] = self.read(addr, n, False, per_msg=1)
        return out

    def read_options(self) -> tuple[int, bytes]:
        with self.session(SESSION_CODEPLUG):
            ptr = self.read(OPTIONS_POINTER, 2, True, per_msg=1)
        addr = ptr[0] << 8 | ptr[1]
        with self.session(SESSION_MCU):
            return addr, self.read(addr, OPTIONS_LEN, False, per_msg=1)

    def write(self, addr: int, data: bytes, scrambled: bool, progress=None):
        """Write bytes one per message (opcode 0x07, no reply)."""
        for i, v in enumerate(data):
            a = addr + i
            hi, lo = a >> 8 & 0xFF, a & 0xFF
            p = sb.scramble(hi, lo, v) if scrambled else (hi, lo, v)
            self.link.transact(bytes([*p, sb.OP_WRITE]))
            if progress:
                progress(i + 1, len(data))

    def program(self, image: bytes, progress=None, *, clone=False,
                options: bytes | None = None, ignore_features=False) -> bytes:
        """Write a codeplug image (EEPROM from 0x6000) as RSS does: in one
        codeplug session, 0x6000 = 0xFF, then every byte from 0x6000 in
        order; then a reset. RSS also writes MCU byte 0xB6A0 = 0x39 afterwards;
        we only check that it already holds that. Returns the image written.

        Refuses (ProgramRefused) unless the model matches, the radio's serial
        matches (or ``clone``), and the image fits the codeplug EEPROM.

        ``clone``, like RSS's CLONE: write another radio's codeplug of the
        same model, with this radio's serial number put into it. ``options``
        (archive prefix bytes 13..18) are then checked against this radio's
        option block, as RSS does ("Target Radio has different features"),
        unless ``ignore_features``.

        Callers should keep a backup read and verify by reading back
        (``program_verified`` does both)."""
        with self.session(SESSION_CODEPLUG):
            head = self.read(CODEPLUG_BASE, 0x62, True)
        if not head.startswith(b"COPYRIGHT MOTOROLA"):
            raise ProgramRefused("radio codeplug header not recognised")
        if head[MODEL] != image[MODEL]:
            raise ProgramRefused(f"model differs: radio {head[MODEL]!r}, "
                                 f"image {image[MODEL]!r}")
        if head[SERIAL] != image[SERIAL]:
            if not clone:
                raise ProgramRefused(f"serial differs: radio {head[SERIAL]!r}, image "
                                     f"{image[SERIAL]!r} (clone to program it anyway)")
            image = image[:SERIAL.start] + head[SERIAL] + image[SERIAL.stop:]
        ext = has_ext_region(image)
        if ext != has_ext_region(head):
            raise ProgramRefused("control head differs: one is S9000e (A9), "
                                 "the other is not")
        main, extra = (image[:-EXT_SIZE], image[-EXT_SIZE:]) if ext else (image, b"")
        if len(main) > EEPROM_SIZE or len(main) % BLOCK:
            raise ProgramRefused(f"codeplug length {len(main):#x} does not fit the "
                                 f"{EEPROM_SIZE:#x}-byte codeplug EEPROM")
        if abs(codeplug_length(main) - len(main)) > BLOCK:   # 604AUN: one off
            raise ProgramRefused(f"image length {len(image):#x} disagrees with its "
                                 f"header ({codeplug_length(main):#x}"
                                 f"{' + 0x2000' if ext else ''})")
        if clone and not ignore_features:
            _, radio_options = self.read_options()
            if options is None or radio_options[:6] != options[:6]:
                raise ProgramRefused(
                    f"radio has different features: radio options "
                    f"{radio_options[:6].hex()}, archive {options and options[:6].hex()}")
        with self.session(SESSION_MCU):
            flag = self.read(PROGRAMMED_FLAG[0], 1, False, per_msg=1)[0]
        if flag != PROGRAMMED_FLAG[1]:
            raise ProgramRefused(f"MCU byte {PROGRAMMED_FLAG[0]:04x} is {flag:02x}, "
                                 f"not {PROGRAMMED_FLAG[1]:02x}: not seen before")
        if ext:
            self._probe_ext_writable()
        with self.session(SESSION_CODEPLUG):
            self.write(CODEPLUG_BASE, b"\xff", True)
            self.write(CODEPLUG_BASE, main, True, progress)
            if self.read(CODEPLUG_BASE, 2, True) != main[:2]:
                raise BusError("header byte did not read back after programming")
        if ext:
            with self.session(SESSION_EXT):
                self.write(EXT_BASE, extra, False, progress)
        self.mode(*MODE_DONE)
        return image

    def _probe_ext_writable(self):
        """RSS's check that the 0x8000 region is writable EEPROM: write the
        complement of its first byte, read it back, restore it."""
        with self.session(SESSION_EXT):
            v = self.read(EXT_BASE, 1, False, per_msg=1)[0]
            self.write(EXT_BASE, bytes([v ^ 0xFF]), False)
            ok = self.read(EXT_BASE, 1, False, per_msg=1)[0] == v ^ 0xFF
            self.write(EXT_BASE, bytes([v]), False)
        if not ok:
            raise ProgramRefused("the 0x8000 region is not writable (no S9000e "
                                 "codeplug EEPROM?)")

    def program_verified(self, image: bytes, progress=None, **kw) -> ReadResult:
        """program(), then read the whole radio back and compare."""
        image = self.program(image, progress, **kw)
        time.sleep(2.0)                      # let the radio restart after the reset
        back = self.read_all(finish=False)
        if back.codeplug != image:
            bad = [i for i in range(len(image)) if back.codeplug[i] != image[i]]
            raise BusError(f"verify failed at {len(bad)} bytes, first "
                           f"{CODEPLUG_BASE + bad[0]:#06x}")
        return back

    def dump(self, which, start=0x0000, end=0x10000, skip=(), progress=None):
        """Read [start, end) of one session's address space, 0x100 bytes per
        session, two bytes per message. Blocks the radio doesn't answer are
        skipped after a short try. Returns (bytearray, readable, failed): the
        memory (0xFF where not read) and the block start addresses."""
        scrambled = which is SESSION_CODEPLUG
        mem = bytearray(b"\xff" * 0x10000)
        readable, failed = [], []
        link = self.link
        quick = hasattr(link, "tries")        # SerialLink: give up fast
        if quick:
            saved = (link.tries, link.reply_timeout)
            link.tries, link.reply_timeout = 2, 0.15
        try:
            for a in range(start, end, BLOCK):
                if any(lo <= a < hi or lo < a + BLOCK <= hi for lo, hi in skip):
                    continue
                try:
                    with self.session(which):
                        mem[a:a + BLOCK] = self.read(a, BLOCK, scrambled)
                    readable.append(a)
                except BusError:
                    failed.append(a)
                    try:
                        self.mode(*which[1])      # close the session anyway
                    except BusError:
                        pass
                if progress:
                    progress(a + BLOCK - start, end - start)
        finally:
            if quick:
                link.tries, link.reply_timeout = saved
        return mem, readable, failed

    def read_all(self, finish=True) -> ReadResult:
        mcu = self.read_mcu()
        addr, options = self.read_options()
        mcu[addr] = options
        cp = self.read_codeplug()
        if finish:
            self.mode(*MODE_DONE)
        return ReadResult(cp, mcu, options)
