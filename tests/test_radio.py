"""motreader.radio against tools/fake_radio.Radio (the radio side RSS was
checked against in the emulator), in-process and over a pty."""

import io
import os
import random
import subprocess
import sys

import pytest

from motreader import radio as rd
from motreader import sb9600 as sb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from fake_radio import Radio as FakeRadio  # noqa: E402


OPTIONS = bytes.fromhex("005640a318f7b1f74484001f11000000")   # a 617ASQ's


def synthetic_image(blocks=3, seed=7):
    """A codeplug-shaped image: the real header text, a length byte for
    `blocks` blocks, random bytes elsewhere (0xFF and the probe byte included)."""
    rng = random.Random(seed)
    cp = bytearray(rng.randrange(256) for _ in range(blocks * 0x100))
    head = b"COPYRIGHT MOTOROLA INC.,1987"
    cp[:len(head)] = head
    cp[0x1C] = blocks * 8 + 4            # (k - 4) * 32 = blocks * 0x100
    cp[0x39] = 0x07                      # RSS's 2-bytes-per-message probe
    cp[0x40:0x48] = b"\xff" * 8
    mem = {0x6000 + i: b for i, b in enumerate(cp)}
    mem.update({0xB675: 0x12, 0xB676: 0x34, 0xB677: 0x35, 0xB69F: 0x56,
                0xB6A0: 0x39, 0xB6A1: 0x9A, 0xB6A2: 0xBC,
                0xFFC6: 0xB6, 0xFFC7: 0x81})          # option-block pointer
    mem.update({0xB681 + i: v for i, v in enumerate(OPTIONS)})
    return bytes(cp), mem


class SimLink:
    """transact() straight into the fake radio, with the CRC on the wire."""

    def __init__(self, mem):
        self.fake = FakeRadio(mem, io.StringIO())
        self.sent = []

    def transact(self, payload):
        msg = sb.frame(payload)
        self.sent.append(msg)
        return self.fake.message(msg) or None


def test_codeplug_length():
    assert rd.codeplug_length(bytes(0x1C) + b"\x6c") == 0xD00
    # rounds up: reading a little extra is harmless (604HNU 0x22 -> 0x400;
    # 604AUN's 0x65 is the one archive that is a block shorter than this)
    assert rd.codeplug_length(bytes(0x1C) + b"\x22") == 0x400


def test_read_all_in_process():
    cp, mem = synthetic_image()
    link = SimLink(mem)
    got = rd.Radio(link).read_all()
    assert got.codeplug == cp
    assert got.mcu == {0xB675: b"\x12\x34\x35", 0xB69F: b"\x56\x39\x9a\xbc",
                       0xB681: OPTIONS}
    assert link.sent[-1][:4] == bytes([0, 0x10, 0x01, 0x08])   # RSS's ending
    assert link.fake.writes == 0                               # read-only


def test_archive_body_layout():
    cp, mem = synthetic_image()
    body = rd.Radio(SimLink(mem)).read_all().archive_body(nonce=bytes(13))
    assert body[0xAD:] == cp and len(body) == 0xAD + len(cp)
    assert body[13:19] == OPTIONS[:6] and not any(body[19:0xAD])


def test_over_pty():
    pytest.importorskip("serial")
    cp, _ = synthetic_image(blocks=2)
    img = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"radio_test_{os.getpid()}.bin")
    with open(img, "wb") as f:
        f.write(b"\xff" * 0x6000 + cp)
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "pty_rib.py"),
                          "--image", img, "--log", os.devnull],
                         stdout=subprocess.PIPE, text=True)
    try:
        dev = p.stdout.readline().strip()
        link = rd.SerialLink(dev, echo_timeout=0.5)
        try:
            assert rd.Radio(link).read_codeplug() == cp
        finally:
            link.close()
    finally:
        p.kill()
        p.wait()
        os.remove(img)


def test_program_in_process():
    cp, mem = synthetic_image()
    new = bytearray(cp)
    new[0x100:0x110] = b"edited codeplug!"
    link = SimLink(mem)
    back = rd.Radio(link).program_verified(bytes(new))
    assert back.codeplug == bytes(new)
    # RSS's order: the header byte is set to 0xFF first, then every byte
    writes = [m for m in link.sent if m[3] == sb.OP_WRITE]
    assert sb.unscramble(*writes[0][:3]) == (0x60, 0x00, 0xFF)
    assert [sb.unscramble(*w[:3])[:2] for w in writes[1:4]] == [(0x60, 0), (0x60, 1), (0x60, 2)]
    assert len(writes) == 1 + len(cp)


@pytest.mark.parametrize("field, off", [("serial", 0x20), ("model", 0x48), ("length", 0x1C)])
def test_program_refuses_other_radio(field, off):
    cp, mem = synthetic_image()
    other = bytearray(cp)
    other[off] ^= 0x01
    link = SimLink(mem)
    with pytest.raises(rd.ProgramRefused, match=field):
        rd.Radio(link).program(bytes(other))
    assert link.fake.writes == 0
