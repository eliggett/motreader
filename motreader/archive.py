"""Motorola Spectra RSS archive-file container.

An archive file (e.g. ``A566AYA0.014``) is:

    [ 83-byte ASCII banner ][ scrambled codeplug body ]

The banner is a fixed string the RSS writes verbatim and checks on load. The
body is the radio codeplug image run through a deterministic, data-independent
scrambler (see ``crypto`` once recovered). Archives come in ``A``/``B`` pairs
that share a per-archive scrambler state but hold two copies of the image.

This module only handles the container (splitting/joining banner and body).
The scrambler itself lives in :mod:`motreader.crypto` once the algorithm is
recovered from the RSS binary.
"""

from __future__ import annotations

from dataclasses import dataclass

# Archives open with one of two banners. The common prefix is 52 bytes; the
# long variant adds a CR/LF + copyright line + 0x1A (83 bytes total).
BANNER_PREFIX = b"Requires MOTOROLA Radio Service Software For Spectra"
BANNER_LONG = BANNER_PREFIX + b"\r\nCOPYRIGHT MOTOROLA INC.,1987\x1a"
BANNER = BANNER_LONG
assert len(BANNER_PREFIX) == 0x34, len(BANNER_PREFIX)
assert len(BANNER_LONG) == 0x53, len(BANNER_LONG)


@dataclass
class Archive:
    """A split archive file: fixed banner + raw (still-scrambled) body."""

    body: bytes
    banner: bytes = BANNER

    @classmethod
    def load(cls, path: str) -> "Archive":
        with open(path, "rb") as fh:
            data = fh.read()
        if not data.startswith(BANNER_PREFIX):
            raise ValueError(f"{path}: missing Spectra archive banner")
        # Long banner (with copyright line) vs short banner (prefix only).
        if data[: len(BANNER_LONG)] == BANNER_LONG:
            n = len(BANNER_LONG)
        else:
            n = len(BANNER_PREFIX)
        return cls(body=data[n:], banner=data[:n])

    def save(self, path: str) -> None:
        with open(path, "wb") as fh:
            fh.write(self.banner)
            fh.write(self.body)

    def __len__(self) -> int:
        return len(self.banner) + len(self.body)
