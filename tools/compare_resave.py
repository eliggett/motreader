#!/usr/bin/env python3
"""Compare an archive motreader wrote with RSS's re-save of it (GET + SAVE):
decrypt both and list every differing byte outside the per-save bookkeeping
RSS rewrites on each save (nonce, dates, counters). No output lines besides
the summary means RSS re-saved it byte-identically.

Usage: compare_resave.py <motreader_archive> <rss_resaved_archive>
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from motreader.archive import Archive
from motreader.crypto import decrypt_body

# bytes RSS restamps on every save (FORMAT §5: the per-save metadata block)
BOOK = set(range(13)) | {0xDA, 0xDB, 0xDC, 0xE0, 0xEF, 0xF0} | set(range(0x1BC, 0x1C0)) | set(range(0x1DE, 0x1E6))


def main():
    a, b = (decrypt_body(Archive.load(p).body) for p in sys.argv[1:3])
    diffs = [i for i in range(min(len(a), len(b))) if a[i] != b[i] and i not in BOOK]
    for i in diffs[:40]:
        print(f"  0x{i:04x}: motreader {a[i]:02x}  RSS {b[i]:02x}")
    same_len = len(a) == len(b)
    print(f"{'IDENTICAL' if same_len and not diffs else 'DIFFERENT'}: {len(diffs)} byte(s) differ "
          f"outside the per-save bookkeeping; lengths {len(a)} / {len(b)}")
    sys.exit(0 if same_len and not diffs else 1)


if __name__ == "__main__":
    main()
