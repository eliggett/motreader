"""Alignment over SB9600: what RSS's SERVICE -> ALIGNMENT screens do,
decoded from RSS traffic and checked on a 617ASN (notes/RADIO-PROTOCOL.md,
"Alignment (RSS SERVICE)").

A screen puts the radio in a test mode (opcode 0x40) on one of its built-in
test frequencies, sends the slider's value live (opcodes 0x28, 0x32, 0x33,
0x42, 0x43), keys the transmitter with the PTT button message (opcode 0x0a,
button 3) and programs the value into the MCU EEPROM, then that block's sum
byte, as RSS's F8 PROGRAM VALUE does. Live values last until the radio
restarts.

PTT safety: key() works only in a test mode that transmits, and a watchdog
unkeys after at most PTT_LIMIT seconds. unkey() sends PTT OFF twice and reads
the transmit state back (RAM 0x000d and 0x003b, bit 3 of each, set only
while keyed); it retries, and raises PttError if it can't confirm.
"""
import threading
import time
from dataclasses import dataclass

from . import sb9600 as sb
from .radio import SESSION_CODEPLUG, SESSION_MCU, BusError

PTT_LIMIT = 10.0          # s: never key longer (the radio's PA can overheat)
PTT_MARGIN = 1.0          # s: the watchdog fires this much before the limit
PTT_ON = bytes([0x00, 0x03, 0x01, 0x0A])     # SETBUT button 3 (PTT) pressed
PTT_OFF = bytes([0x00, 0x03, 0x00, 0x0A])    # released
TEST_EXIT = bytes([0x01, 0x00, 0x00, 0x40])
TX_FLAGS = ((0x000D, 0x08), (0x003B, 0x08))  # RAM bits set only while keyed
POWER_NOW = 0x000A        # RAM: the power code in use (high or low power)
# RAM showing the receiver's squelch open (the BUSY LED, indicator 0x0a):
# 0x0031 is 0x0c open / 0 closed, 0x0038 bit 5 set open
BUSY_FLAGS = ((0x0031, 0xFF), (0x0038, 0x20))
FREQS = ("low", "mid", "high")


class PttError(BusError):
    """PTT OFF could not be confirmed: switch the radio off."""


def rev7(v: int) -> int:
    """Bit-reverse 7 bits (warp and power are stored and sent this way)."""
    return sb.rev8(v & 0x7F) >> 1


def test_mode(code: int) -> bytes:
    return bytes([0x01, code, 0x10, 0x40])


@dataclass(frozen=True)
class Adjustment:
    key: str
    title: str                  # RSS's screen title
    addr: int                   # the MCU EEPROM byte F8 programs
    block: tuple[int, int]      # first, last byte summed into sum_addr
    sum_addr: int
    top: int                    # the slider runs 0..top
    entry: int                  # test mode on entering the screen
    freqs: tuple[int, int, int] | None   # test modes for F2 / F3 / F4
    transmits: bool             # F6 TOGGLE PTT
    live_unkeyed: bool          # RSS sends the value while not keyed too
    extra: int | None = None    # another MCU EEPROM byte the live message needs

    def decode(self, b: int) -> int:
        """The slider value from the stored byte."""
        if self.key == "warp":
            return rev7(b)
        if self.key in ("high_power", "low_power"):
            return 127 - rev7(b)
        if self.key == "current_limit":
            return b >> 3 & 0x0F
        return b

    def encode(self, v: int, old: int) -> int:
        """The stored byte for slider value v (old: the byte it replaces)."""
        if self.key == "warp":
            return rev7(v)
        if self.key in ("high_power", "low_power"):
            return rev7(127 - v)
        if self.key == "current_limit":
            return old & 0x87 | v << 3
        return v

    def live(self, v: int, extra: int | None) -> list[bytes]:
        """The messages that set value v in the running radio."""
        if self.key == "squelch":
            return [bytes([0x01, 0x02, v, 0x28])]
        if self.key == "deviation":
            return [bytes([0x01, (v + 1) << 4 & 0xFF, extra, 0x32])]
        if self.key == "warp":
            return [bytes([0x01, 0x00, rev7(v), 0x43])]
        if self.key in ("high_power", "low_power"):
            return [bytes([0x01, 0x01, rev7(127 - v), 0x33])]
        # current limit: RSS sends the high power level with it
        return [bytes([0x01, 0x00, v << 3, 0x42]), bytes([0x01, 0x01, extra, 0x33])]


ADJUSTMENTS = {a.key: a for a in (
    Adjustment("squelch", "DEFAULT SQUELCH", 0xB64F, (0xB645, 0xB658), 0xB664,
               15, 0x41, None, False, True),
    Adjustment("deviation", "TRANSMITTER DEVIATION", 0xB644, (0xB644, 0xB644), 0xB663,
               14, 0x42, (0x42, 0x52, 0x62), True, False, extra=0xB645),
    Adjustment("warp", "REFERENCE OSCILLATOR WARP", 0xB62D, (0xB62D, 0xB633), 0xB661,
               127, 0x41, None, True, True),
    Adjustment("high_power", "TRANSMITTER HIGH POWER", 0xB62F, (0xB62D, 0xB633), 0xB661,
               127, 0x11, (0x41, 0x51, 0x61), True, True),
    Adjustment("current_limit", "POWER AMPLIFIER (PA) CURRENT LIMIT", 0xB62C,
               (0xB600, 0xB62C), 0xB660, 15, 0x11, (0x42, 0x52, 0x62), True, True,
               extra=0xB62F),
    Adjustment("low_power", "TRANSMITTER LOW POWER", 0xB62E, (0xB62D, 0xB633), 0xB661,
               127, 0x41, (0x42, 0x52, 0x62), True, True),
)}


class Aligner:
    """One alignment screen at a time on a Radio. Thread-safe: the PTT
    watchdog runs on a timer thread. Use as a context manager: leaving
    unkeys (verified), leaves test mode and restarts the radio."""

    def __init__(self, radio, limit: float = PTT_LIMIT, log=None):
        if not 0 < limit <= PTT_LIMIT:
            raise ValueError(f"PTT limit is at most {PTT_LIMIT} s")
        self.radio = radio
        self.limit = limit
        self.log = log or (lambda msg: None)
        self.lock = threading.RLock()
        self.adj: Adjustment | None = None
        self.freq: str | None = None      # None: the screen's entry test mode
        self.stored = 0                   # the EEPROM byte as read
        self.extra: int | None = None
        self.value = 0                    # the slider value now
        self.keyed_at: float | None = None
        self.fault: Exception | None = None   # from the watchdog
        self._timer: threading.Timer | None = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        try:
            self.leave()
        finally:
            self.radio.needs_reset = True
            self.radio.finish()           # MODE_DONE: the radio restarts
        return False

    def _send(self, payload: bytes):
        with self.lock:
            self.radio.link.transact(payload)

    def _read_mcu(self, addr: int, n: int) -> bytes:
        with self.lock, self.radio.session(SESSION_MCU):
            return self.radio.read(addr, n, False)

    def enter(self, key: str, freq: str | None = None) -> int:
        """Open a screen: read its stored value, start its test mode. Returns
        the slider value."""
        adj = ADJUSTMENTS[key]
        if freq is not None and (adj.freqs is None or freq not in FREQS):
            raise ValueError(f"{key}: no test frequency {freq!r}")
        with self.lock:
            self.unkey()
            self.stored = self._read_mcu(adj.addr, 1)[0]
            self.extra = self._read_mcu(adj.extra, 1)[0] if adj.extra else None
            self.adj, self.freq = adj, freq
            self.value = adj.decode(self.stored)
            self._send(test_mode(self._test_code()))
            self.log(f"{adj.title}: stored {self.stored:02x} = {self.value}, "
                     f"test mode {self._test_code():02x}")
            return self.value

    def _test_code(self) -> int:
        adj = self._need()
        return adj.entry if self.freq is None else adj.freqs[FREQS.index(self.freq)]

    def _need(self) -> Adjustment:
        if self.adj is None:
            raise RuntimeError("no alignment screen open")
        return self.adj

    def set_freq(self, freq: str):
        """Change the test frequency (unkeys first, as RSS does)."""
        adj = self._need()
        if adj.freqs is None or freq not in FREQS:
            raise ValueError(f"{adj.key}: no test frequency {freq!r}")
        with self.lock:
            self.unkey()
            self.freq = freq
            self._send(test_mode(self._test_code()))

    def set(self, v: int):
        """Set the slider: sent live when RSS would (keyed, or always for
        squelch, warp and power)."""
        adj = self._need()
        if not 0 <= v <= adj.top:
            raise ValueError(f"{adj.key}: {v} is outside 0..{adj.top}")
        with self.lock:
            self.value = v
            if self.keyed_at is not None or adj.live_unkeyed:
                for p in adj.live(v, self.extra):
                    self._send(p)

    def key(self, secs: float | None = None) -> float:
        """PTT ON for secs (at most the limit, less the watchdog margin).
        Returns the seconds until the watchdog unkeys."""
        adj = self._need()
        if not adj.transmits:
            raise RuntimeError(f"{adj.key} does not transmit")
        if self.fault:
            raise self.fault
        auto = self.limit - PTT_MARGIN
        secs = auto if secs is None else min(secs, auto)
        with self.lock:
            if self.keyed_at is not None:
                return self.remaining()
            self._timer = threading.Timer(secs, self._expire)
            self._timer.daemon = True
            self.keyed_at = time.monotonic()
            self._timer.start()
            try:
                self._send(PTT_ON)
                for p in adj.live(self.value, self.extra):
                    self._send(p)
            except BaseException:
                self.unkey()
                raise
            self.log(f"PTT ON ({secs:.1f} s)")
            return secs

    def remaining(self) -> float:
        """Seconds until the watchdog unkeys (0 if not keyed)."""
        if self.keyed_at is None or self._timer is None:
            return 0.0
        return max(0.0, self._timer.interval - (time.monotonic() - self.keyed_at))

    def _expire(self):
        try:
            self.unkey()
            self.log("PTT OFF: time limit")
        except Exception as e:      # noqa: BLE001 - reported on the next call
            self.fault = e
            self.log(f"PTT OFF FAILED: {e}")

    def transmitting(self) -> bool:
        """Read the transmit state from RAM."""
        with self.lock:
            return any(self._read_mcu(a, 1)[0] & bit for a, bit in TX_FLAGS)

    def busy(self) -> bool:
        """Whether the squelch is open (the BUSY LED) now."""
        with self.lock:
            return any(self._read_mcu(a, 1)[0] & mask for a, mask in BUSY_FLAGS)

    def auto_squelch(self, dwell: float = 0.5, samples: int = 5,
                     progress=None) -> int | None:
        """On the squelch screen: the lowest value at which BUSY stays off
        (samples reads after dwell seconds at each value), left set live
        (not programmed). None, and the old value back, if every value is
        busy (a signal on the test frequency?)."""
        adj = self._need()
        if adj.key != "squelch":
            raise RuntimeError("auto squelch needs the squelch screen")
        start = self.value
        for v in range(adj.top + 1):
            self.set(v)
            time.sleep(dwell)
            open_ = sum(self.busy() for _ in range(samples))
            if progress:
                progress(v, open_, samples)
            if not open_:
                return v
        self.set(start)
        return None

    def unkey(self, tries: int = 5) -> bool:
        """PTT OFF twice, then read back that the radio isn't transmitting.
        Safe to call when not keyed. Returns True once confirmed."""
        with self.lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            was = self.keyed_at
            last = None
            for _ in range(tries):
                try:
                    for _ in range(2):
                        self._send(PTT_OFF)
                    if not self.transmitting():
                        self.keyed_at = None
                        if was is not None:
                            self.log(f"PTT OFF (verified) after "
                                     f"{time.monotonic() - was:.1f} s")
                        return True
                    last = "the radio still reads as transmitting"
                except BusError as e:
                    last = str(e)
                time.sleep(0.1)
            raise PttError(f"PTT OFF not confirmed ({last}): switch the radio off")

    def program(self) -> tuple[int, int] | None:
        """F8 PROGRAM VALUE: write the slider value into the MCU EEPROM and
        update the block's sum byte, as RSS does; both read back. Not while
        keyed. Returns (old, new) stored bytes, or None if unchanged."""
        adj = self._need()
        with self.lock:
            self.unkey()
            new = adj.encode(self.value, self.stored)
            if new == self.stored:
                return None
            r = self.radio
            with r.session(SESSION_CODEPLUG):     # RSS writes MCU EEPROM here
                r.write(adj.addr, bytes([new]), True)
            if self._read_mcu(adj.addr, 1)[0] != new:
                raise BusError(f"{adj.addr:04x} did not read back as {new:02x}")
            lo, hi = adj.block
            s = sum(self._read_mcu(lo, hi - lo + 1)) & 0xFF
            with r.session(SESSION_CODEPLUG):
                r.write(adj.sum_addr, bytes([s]), True)
            if self._read_mcu(adj.sum_addr, 1)[0] != s:
                raise BusError(f"sum byte {adj.sum_addr:04x} did not read back as {s:02x}")
            old, self.stored = self.stored, new
            self.log(f"programmed {adj.addr:04x} {old:02x} -> {new:02x}, "
                     f"sum {adj.sum_addr:04x} = {s:02x}")
            return old, new

    def leave(self):
        """Unkey (verified) and leave test mode."""
        with self.lock:
            self.unkey()
            if self.adj is not None:
                self._send(TEST_EXIT)
                self.adj = None
