"""Tests for motreader/align.py against a simulated radio."""

import time

import pytest

from motreader import sb9600 as sb
from motreader.align import ADJUSTMENTS, PTT_OFF, PTT_ON, Aligner, PttError, rev7
from motreader.radio import Radio

# MCU EEPROM of the 617ASN as RSS read it (squelch 10, deviation 11, warp
# 72, high power 98, current limit 7, low power 46)
EEPROM = {0xB62C: 0xB8, 0xB62D: 0x09, 0xB62E: 0x45, 0xB62F: 0x5C, 0xB630: 0xFF,
          0xB631: 0xFF, 0xB632: 0xFF, 0xB633: 0xFF, 0xB644: 0x0B, 0xB645: 0x0A,
          0xB64F: 0x0A}


class FakeLink:
    """Answers reads (MCU RAM/EEPROM, scrambled codeplug-session writes),
    keys on PTT ON and unkeys on PTT OFF unless `stuck`."""

    def __init__(self, stuck=False, quiet_from=3):
        self.mem = dict(EEPROM)
        self.squelch = 10          # live squelch; BUSY below quiet_from
        self.quiet_from = quiet_from
        self.sent = []
        self.keyed = False
        self.stuck = stuck
        self.session = None

    def transact(self, payload):
        p = bytes(payload)
        self.sent.append(p)
        op = p[3]
        if op == sb.OP_MODE:
            self.session = None if p[1] in (0x90, 0x92) else p[1]
        elif p == PTT_ON:
            self.keyed = True
        elif p == PTT_OFF and not self.stuck:
            self.keyed = False
        elif op == 0x28:
            self.squelch = p[2]
        elif op == sb.OP_WRITE:
            assert self.session == 0xD1
            hi, lo, v = sb.unscramble(*p[:3])
            self.mem[hi << 8 | lo] = v
        elif op == sb.OP_READ:
            assert self.session == 0x93
            a = p[0] << 8 | p[1]
            busy = self.squelch < self.quiet_from
            ram = {0x000D: 0x08 if self.keyed else 0, 0x003B: 0x18 if self.keyed else 0x10,
                   0x0031: 0x0C if busy else 0, 0x0038: 0x28 if busy else 0x08}
            get = lambda x: ram.get(x, self.mem.get(x, 0xFF))  # noqa: E731
            return sb.read_reply(bytes([get(a), get(a + 1)]), False, r0=p[0])
        return None

    def live(self):
        """The messages to the radio other than PTT, test mode and memory."""
        return [p.hex() for p in self.sent
                if p[3] not in (sb.OP_MODE, sb.OP_READ, sb.OP_WRITE, 0x0A, 0x40)]


def aligner(link, **kw):
    return Aligner(Radio(link), **kw)


def test_decode_matches_rss():
    want = {"squelch": 10, "deviation": 11, "warp": 72, "high_power": 98,
            "current_limit": 7, "low_power": 46}
    for key, v in want.items():
        a = ADJUSTMENTS[key]
        assert a.decode(EEPROM[a.addr]) == v
        assert a.encode(v, EEPROM[a.addr]) == EEPROM[a.addr]


def test_rev7():
    assert rev7(72) == 0x09 and rev7(73) == 0x49
    assert all(rev7(rev7(v)) == v for v in range(128))


def test_live_messages_as_rss_sent_them():
    link = FakeLink()
    al = aligner(link)
    al.enter("squelch")
    assert link.sent[-1].hex() == "01411040"
    al.set(11)
    al.set(12)
    assert link.live() == ["01020b28", "01020c28"]

    link.sent.clear()
    al.enter("deviation")
    al.set(12)                     # not keyed: RSS sends nothing
    assert link.live() == []
    al.key(1)
    al.set(13)
    al.unkey()
    assert link.live() == ["01d00a32", "01e00a32"]

    link.sent.clear()
    al.enter("warp")
    al.set(73)
    assert link.live() == ["01004943"]

    link.sent.clear()
    al.enter("high_power", "mid")
    assert link.sent[-1].hex() == "01511040"
    al.set(99)
    assert link.live() == ["01011c33"]

    link.sent.clear()
    al.enter("current_limit")
    al.set(8)
    assert link.live() == ["01004042", "01015c33"]

    link.sent.clear()
    al.enter("low_power")
    al.set(47)
    assert link.live() == ["01010533"]


def test_ptt_off_twice_and_verified():
    link = FakeLink()
    al = aligner(link)
    al.enter("deviation")
    al.key(5)
    assert link.keyed and al.keyed_at is not None
    n = len(link.sent)
    assert al.unkey()
    assert not link.keyed and al.keyed_at is None
    assert [p for p in link.sent[n:] if p[3] == 0x0A] == [PTT_OFF, PTT_OFF]


def test_watchdog_unkeys():
    link = FakeLink()
    al = aligner(link, limit=1.5)          # watchdog at 0.5 s
    al.enter("high_power")
    secs = al.key()
    assert secs == pytest.approx(0.5)
    time.sleep(1.0)
    assert not link.keyed and al.keyed_at is None


def test_key_limit_is_capped():
    al = aligner(FakeLink())
    al.enter("low_power")
    assert al.key(60) <= 9.0
    al.unkey()
    with pytest.raises(ValueError):
        Aligner(Radio(FakeLink()), limit=30)


def test_squelch_does_not_transmit():
    al = aligner(FakeLink())
    al.enter("squelch")
    with pytest.raises(RuntimeError):
        al.key()


def test_stuck_ptt_raises():
    link = FakeLink(stuck=True)
    al = aligner(link)
    al.enter("deviation")
    al.key(5)
    with pytest.raises(PttError):
        al.unkey(tries=2)


def test_program_writes_value_and_block_sum():
    link = FakeLink()
    al = aligner(link)
    al.enter("warp")
    al.set(73)
    assert al.program() == (0x09, 0x49)
    assert link.mem[0xB62D] == 0x49
    # RSS wrote e6 here after warp 73 on the same bytes
    assert link.mem[0xB661] == 0xE6
    assert al.program() is None            # unchanged: nothing written


def test_program_squelch_sum():
    link = FakeLink()
    for a in range(0xB645, 0xB659):
        link.mem.setdefault(a, 0)
    al = aligner(link)
    al.enter("squelch")
    al.set(12)
    al.program()
    assert link.mem[0xB664] == sum(link.mem[a] for a in range(0xB645, 0xB659)) & 0xFF


def test_leave_unkeys_and_exits_test_mode():
    link = FakeLink()
    with aligner(link) as al:
        al.enter("deviation")
        al.key(5)
    assert not link.keyed
    sent = [p.hex() for p in link.sent]
    assert "01000040" in sent and sent[-1] == "00100108"     # test exit, MODE_DONE


def test_auto_squelch():
    link = FakeLink(quiet_from=3)
    al = aligner(link)
    al.enter("squelch")
    seen = []
    assert al.auto_squelch(dwell=0, progress=lambda v, n, of: seen.append((v, n))) == 3
    assert seen == [(0, 5), (1, 5), (2, 5), (3, 0)]
    assert al.value == 3 and not al.busy()
    assert link.mem[0xB64F] == 0x0A            # not programmed


def test_auto_squelch_all_busy():
    link = FakeLink(quiet_from=99)
    al = aligner(link)
    al.enter("squelch")
    assert al.auto_squelch(dwell=0, samples=1) is None
    assert al.value == 10 and link.squelch == 10
    al.enter("deviation")
    with pytest.raises(RuntimeError):
        al.auto_squelch()
