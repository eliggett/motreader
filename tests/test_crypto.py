"""Tests for the recovered Spectra archive body cipher."""

import os

import pytest

from motreader.archive import Archive
from motreader.crypto import decrypt_body, encrypt_body

SPECTRA = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA")


def _archives():
    out = []
    for d in ("ARCHIVE", "AR-ORIG", "ARCHIVE-20250412", "ARCHIVE-bk"):
        base = os.path.join(SPECTRA, d)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            p = os.path.join(base, name)
            try:
                with open(p, "rb") as fh:
                    if fh.read(8) == b"Requires":
                        out.append(p)
            except (OSError, IsADirectoryError):
                pass
    return out


def test_roundtrip_all_archives():
    archives = _archives()
    if not archives:
        pytest.skip("no sample archives present")
    for p in archives:
        arc = Archive.load(p)
        plain = decrypt_body(arc.body)
        assert encrypt_body(plain) == arc.body, f"round-trip failed for {p}"


def test_decrypt_reveals_signature():
    """A decrypted body should contain the Motorola codeplug signature."""
    p = os.path.join(SPECTRA, "ARCHIVE", "a566aya0.014")
    if not os.path.exists(p):
        pytest.skip("sample not present")
    plain = decrypt_body(Archive.load(p).body)
    assert b"COPYRIGHT MOTOROLA INC.,1987" in plain
    assert b"566AYA0014" in plain


def test_known_vector():
    """Initial state = (b2 + b6 - b8) & 0xFF and the first 13 bytes are the nonce."""
    cipher = bytes(range(60))
    plain = decrypt_body(cipher)
    assert plain[:13] == cipher[:13]
    assert decrypt_body(encrypt_body(plain)) == plain
