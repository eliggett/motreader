#!/usr/bin/env python3
"""Locate the decrypted Spectra codeplug inside a dosbox RAM dump.

Searches for known ASCII anchors (serial, mode names seen in the RSS PRINT) and
reports their offsets so we can carve the plaintext codeplug image out of RAM.
Then (optionally) XORs a candidate region against the archive ciphertext body to
check for a clean keystream.

Usage: find_plain.py <memdump.bin> [archive_body_file]
"""
import sys

# Anchors from the 566AYA0014 PRINT (serial + conventional mode alpha tags).
ANCHORS = [b"566AYA0014", b"L P 0375", b"AG2 2500", b"AX1 0500",
           b"SUN 2875", b"HP1 5250", b"098 USED"]


def main():
    data = open(sys.argv[1], "rb").read()
    print(f"dump size {len(data)} ({len(data)/1024/1024:.1f} MB)")
    hits = {}
    for a in ANCHORS:
        offs = []
        i = data.find(a)
        while i != -1 and len(offs) < 12:
            offs.append(i)
            i = data.find(a, i + 1)
        hits[a] = offs
        print(f"  {a!r}: {len(offs)} hit(s) at {[hex(o) for o in offs[:8]]}")
    # If serial found, show a window around the first hit
    ser = hits.get(b"566AYA0014") or []
    for o in ser[:3]:
        lo = max(0, o - 64)
        print(f"\n--- window around serial @ {hex(o)} ---")
        chunk = data[lo:o + 128]
        print(chunk.hex())
        print("".join(chr(c) if 32 <= c < 127 else "." for c in chunk))


if __name__ == "__main__":
    main()
