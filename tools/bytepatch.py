#!/usr/bin/env python3
"""Generic inverse-oracle byte patcher: set arbitrary bytes in 900-style mode
records (26 B @ 0x0D26), re-encrypt, so RSS can decode+PRINT the result.

Usage: bytepatch.py <src> <dst> <edits>
  edits = semicolon list of  mode:off=hexbyte[,hexbyte...]
  e.g.  "2:18=80,80; 3:22=80,80; 4:10=00"  (mode is 1-based record index)
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from motreader.archive import Archive
from motreader.crypto import decrypt_body, encrypt_body

OFF = 0x0D26
REC = 26


def main():
    src, dst, edits = sys.argv[1], sys.argv[2], sys.argv[3]
    ar = Archive.load(src)
    body = bytearray(decrypt_body(ar.body))
    for e in edits.split(';'):
        e = e.strip()
        if not e:
            continue
        mode_off, vals = e.split('=')
        mode, off = mode_off.split(':')
        mode = int(mode); off = int(off)
        vbytes = [int(x, 16) for x in vals.split(',')]
        base = OFF + (mode - 1) * REC
        for i, v in enumerate(vbytes):
            body[base + off + i] = v
        print(f"  mode {mode} off{off} <- {[f'{v:02x}' for v in vbytes]}")
    Archive(body=encrypt_body(bytes(body)), banner=ar.banner).save(dst)
    print(f"wrote {dst}")


if __name__ == "__main__":
    main()
