#!/usr/bin/env python3
"""Inverse-oracle sweep: patch chosen 24-bit synth values into a VHF archive's
mode freq fields (RX+TX), re-encrypt, so RSS can decode+PRINT the MHz it thinks
each value means. Maps stored-value -> displayed-MHz precisely.

Usage:
  invsweep.py patch  <src_archive> <dst_archive> v0 v1 v2 ...   # hex 24-bit LE values
  invsweep.py geom   <archive>                                   # print record geom

Freq field: record stride 26; per record, byte off 9 = RX tag (0xe9),
off 10-12 = RX value (3 bytes LE), off 13 = TX tag (0xa9), off 14-16 = TX value.
Both RX and TX are set to the same value (simplex) so the printed Rx/Tx agree.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from motreader.archive import Archive
from motreader.crypto import decrypt_body, encrypt_body

STRIDE = 26


def find_records(body):
    hits = [i for i in range(len(body) - 8)
            if body[i] == 0xE9 and body[i + 4] == 0xA9]
    return hits  # each is the RX-tag offset of a record


def patch(src, dst, values):
    ar = Archive.load(src)
    body = bytearray(decrypt_body(ar.body))
    tags = find_records(body)
    n = min(len(tags), len(values))
    for i in range(n):
        v = values[i] & 0xFFFFFF
        b = bytes([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF])
        rx = tags[i]           # 0xE9 here
        body[rx + 1:rx + 4] = b   # RX value
        body[rx + 5:rx + 8] = b   # TX value (tag at rx+4 is 0xA9)
    newbody = encrypt_body(bytes(body))
    Archive(body=newbody, banner=ar.banner).save(dst)
    # verify round-trip
    chk = decrypt_body(Archive.load(dst).body)
    for i in range(n):
        rx = tags[i]
        got = chk[rx + 1] | (chk[rx + 2] << 8) | (chk[rx + 3] << 16)
        assert got == (values[i] & 0xFFFFFF), (i, hex(got))
    print(f"patched {n} modes -> {dst}")
    for i in range(n):
        print(f"  mode {i+1:02d}: 0x{values[i]&0xFFFFFF:06x}")


def geom(path):
    ar = Archive.load(path)
    body = decrypt_body(ar.body)
    tags = find_records(body)
    print(f"len={len(body)} records={len(tags)} stride~{tags[1]-tags[0] if len(tags)>1 else '?'}")
    for i, t in enumerate(tags):
        print(f"  mode {i+1:02d} @0x{t:04x}: " + body[t:t+8].hex(' '))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "geom":
        geom(sys.argv[2])
    elif cmd == "patch":
        src, dst = sys.argv[2], sys.argv[3]
        vals = [int(x, 16) for x in sys.argv[4:]]
        patch(src, dst, vals)
