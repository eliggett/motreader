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


def synthetic_image(blocks=3, seed=7, s9000e=False):
    """A codeplug-shaped image: the real header text, a length byte for
    `blocks` blocks, random bytes elsewhere (0xFF and the probe byte included).
    s9000e: A9-head bit, plus the 0x2000-byte region at 0x8000."""
    rng = random.Random(seed)
    cp = bytearray(rng.randrange(256) for _ in range(blocks * 0x100))
    head = b"COPYRIGHT MOTOROLA INC.,1987"
    cp[:len(head)] = head
    cp[0x1C] = blocks * 8 + 4            # (k - 4) * 32 = blocks * 0x100
    cp[0x39] = 0x07                      # RSS's 2-bytes-per-message probe
    cp[0x40:0x48] = b"\xff" * 8
    cp[0x60] = cp[0x60] & ~0x20 if s9000e else cp[0x60] | 0x20     # head type
    mem = {0x6000 + i: b for i, b in enumerate(cp)}
    if s9000e:
        ext = bytes(rng.randrange(256) for _ in range(0x2000))
        mem.update({0x8000 + i: b for i, b in enumerate(ext)})
        cp += ext
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


@pytest.mark.parametrize("field, off, val", [
    ("serial", 0x20, None), ("model", 0x48, None),
    ("length", 0x1C, 0xFF),            # header claims more than the image holds
])
def test_program_refuses(field, off, val):
    cp, mem = synthetic_image()
    other = bytearray(cp)
    other[off] = other[off] ^ 0x01 if val is None else val
    link = SimLink(mem)
    with pytest.raises(rd.ProgramRefused, match=field):
        rd.Radio(link).program(bytes(other))
    assert link.fake.writes == 0


def test_program_bigger_codeplug():
    # adding modes grows the codeplug: allowed up to the EEPROM size
    cp, mem = synthetic_image(blocks=3)
    big, _ = synthetic_image(blocks=5, seed=9)
    big = bytearray(big)
    big[0x1D:0x27], big[0x44:0x58] = cp[0x1D:0x27], cp[0x44:0x58]
    back = rd.Radio(SimLink(mem)).program_verified(bytes(big))
    assert back.codeplug == bytes(big)


def other_radio_image():
    """The same model with a different serial and contents."""
    cp, _ = synthetic_image(seed=11)
    other = bytearray(cp)
    other[0x1D:0x27] = b"617ASN1767"
    return cp, bytes(other)


def test_clone_keeps_target_serial():
    cp, mem = synthetic_image(seed=11)
    _, src = other_radio_image()
    src = bytearray(src)
    src[0x100:0x108] = b"cloned!!"
    back = rd.Radio(SimLink(mem)).program_verified(bytes(src), clone=True,
                                                   options=OPTIONS[:6])
    want = bytearray(src)
    want[0x1D:0x27] = cp[0x1D:0x27]          # the radio keeps its serial
    assert back.codeplug == bytes(want)


def test_clone_checks_features():
    _, mem = synthetic_image(seed=11)
    _, src = other_radio_image()
    other_options = b"\x00\x56\x40\xa3\x1e\xf7"
    link = SimLink(mem)
    with pytest.raises(rd.ProgramRefused, match="features"):
        rd.Radio(link).program(src, clone=True, options=other_options)
    assert link.fake.writes == 0
    rd.Radio(SimLink(mem)).program(src, clone=True, options=other_options,
                                   ignore_features=True)


def test_dump_skips_registers_and_reads_both_sessions():
    cp, mem = synthetic_image()
    radio = rd.Radio(SimLink(mem))
    cmem, ok, bad = radio.dump(rd.SESSION_CODEPLUG, 0x6000, 0x6300)
    assert bytes(cmem[0x6000:0x6300]) == cp and not bad
    mmem, ok, bad = radio.dump(rd.SESSION_MCU, 0x0F00, 0x1200,
                               skip=(rd.HC11_REGISTERS,))
    assert [a for a in ok] == [0x0F00, 0x1100]          # 0x1000 block skipped
    assert bytes(mmem[0x1000:0x1100]) == b"\xff" * 0x100


def test_s9000e_read_and_program():
    cp, mem = synthetic_image(s9000e=True)
    assert len(cp) == 3 * 0x100 + 0x2000
    link = SimLink(mem)
    radio = rd.Radio(link)
    assert radio.read_all().codeplug == cp          # second region included
    new = bytearray(cp)
    new[-16:] = b"S9000e region ok"
    back = radio.program_verified(bytes(new))
    assert back.codeplug == bytes(new)
    # the 0x8000 region was written unscrambled in its own session
    assert any(m[:4] == bytes([0x00, 0xB1, 0x05, 0x08]) for m in link.sent)


def test_s9000e_image_refused_on_standard_head_radio():
    _, mem = synthetic_image()
    cp9, _ = synthetic_image(s9000e=True)
    link = SimLink(mem)
    with pytest.raises(rd.ProgramRefused, match="control head"):
        rd.Radio(link).program(cp9)
    assert link.fake.writes == 0
