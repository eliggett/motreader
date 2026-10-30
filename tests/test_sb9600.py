"""SB9600 primitives against messages RSS sent to tools/fake_radio.py
(RSS in dosbox-x on the `rib` serial backend; notes/RADIO-PROTOCOL.md)."""

import random

import pytest

from motreader import sb9600 as sb


@pytest.mark.parametrize("wire", [
    "00d10108a6", "0090010864", "00930108f4", "0092010884", "001201087f",
    "001001089f", "005101085d",                     # MODE
    "fbfb528757", "a9e3ca873b", "b67500877d", "000000873e",   # READ
    "04fb4e075b", "b87acf07a1", "08f7bd070d",        # WRITE
])
def test_crc_matches_rss(wire):
    m = bytes.fromhex(wire)
    assert sb.frame(m[:4]) == m


@pytest.mark.parametrize("wire, addr, data", [
    ("04fb4e07", 0x6000, 0xFF),    # PROGRAM first invalidates the header byte
    ("b87acf07", 0x6000, 0x43),    # ... and later writes "COPYRIGHT ..."
    ("b4467307", 0x6001, 0x4F),
    ("08f7bd07", 0x6CFF, 0xFF),
    ("fbfb5287", 0x6038, 0x00),    # first frame of a read: data 0
])
def test_unscramble_rss_requests(wire, addr, data):
    hi, lo, d = sb.unscramble(*bytes.fromhex(wire)[:3])
    assert (hi << 8 | lo, d) == (addr, data)
    assert sb.scramble(hi, lo, d) == tuple(bytes.fromhex(wire)[:3])


def test_chained_read_frame():
    # RSS re-scrambles the next address over the previous frame's byte 2
    assert sb.scramble(0x60, 0x39, 0x52) == (0xA9, 0xE3, 0xCA)


def test_reply_scramble_roundtrip():
    rng = random.Random(1)
    for _ in range(500):
        r0, d1, d0 = (rng.randrange(256) for _ in range(3))
        assert sb.unscramble_reply(r0, *sb.scramble_reply(r0, d1, d0)) == (d1, d0)


def test_read_reply_layout():
    # plain: byte 2 is the byte at the address, byte 1 the next one
    assert sb.read_reply(b"\x43\x4f", scrambled=False)[:4] == bytes([0, 0x4F, 0x43, 0x07])


def test_real_radio_reply():
    # a 617ASQ's answer to RSS's first codeplug read (0x6000): "CO"
    assert sb.unscramble_reply(0x60, 0xA8, 0x06) == (ord("O"), ord("C"))
    assert sb.frame(bytes.fromhex("60a80607")) == bytes.fromhex("60a8060716")
