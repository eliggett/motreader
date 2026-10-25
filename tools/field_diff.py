#!/usr/bin/env python3
"""Harness-driven differential field mapper (Phase-2 workhorse).

Systematically locates the **on-disk** bytes of a codeplug field with no
guessing: drive RSS (under the patched dosbox-x, closed-loop via the screen
reader) to change exactly one field, SAVE, and diff the decrypted bodies against
a baseline. A second no-edit baseline save characterizes save-time "noise" so it
can be subtracted; a known save-side checksum/state block is also excluded.

This replaces ad-hoc "test and find": given a callback that performs one UI edit,
`map_field` returns the exact body offsets that edit changed.

Protocol (per field):
  1. save baseline            -> b0
  2. save baseline again      -> b1   (same data; b0^b1 beyond the nonce = noise)
  3. run edit_fn(dbx)         (one field changed in RSS's working copy)
  4. save edited              -> b2
  5. field = diff(b0,b2) - diff(b0,b1) - CHECKSUM_BLOCK

Findings that motivated this tool (221AZN VHF, see notes/PHASE1-HARNESS.md §13
and notes/FORMAT.md §5a):
  - RSS stores a working image of decoded strings/enums; the binary->value
    decode happens at GET, so field *values* are read from RAM but field
    *on-disk offsets* come from this save+decrypt-diff.
  - Tx Power  High/Low = bit6 of the record tag @ rec+9  (0xE9 set / 0xA9 clear)
  - TA Power  High/Low = bit6 of the record tag @ rec+13 (0xE9 set / 0xA9 clear)
  - Channel Chg ID Register lives in a global options region (~0x24a/0x24d).
  - A data-dependent block at {0xdc, 0xf0, 0x1bc-0x1bf, 0x1de-0x1e5} moves on
    some saves -> treated as a save-side checksum / persisted UI state; EXCLUDED
    here and FLAGGED for the write path (motreader must recompute it to produce
    RSS-loadable edited archives -- verify!).

Usage (library):
    from field_diff import FieldMapper, opt1_toggle
    with FieldMapper(sandbox_c, workdir, archive_path) as fm:
        offs = fm.map_field(opt1_toggle(tabs=2), "Transmit Power")
"""
import os
import sys
import time
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)
from trace_lib import Harness
from motreader import archive, crypto

NONCE_LEN = 13
# save-side checksum / persisted-state block to exclude from field diffs
CHECKSUM_BLOCK = {0xdc, 0xf0} | set(range(0x1bc, 0x1c0)) | set(range(0x1de, 0x1e6))


def _body(path):
    return crypto.decrypt_body(archive.Archive.load(path).body)


def _diff(a, b):
    return {i for i in range(NONCE_LEN, min(len(a), len(b))) if a[i] != b[i]}


class FieldMapper:
    def __init__(self, sandbox_c, workdir, archive_path, sock=None):
        self.h = Harness(sandbox_c, workdir)
        self.archive_path = archive_path   # the A-file RSS rewrites on SAVE
        self.workdir = workdir
        self.d = None

    def __enter__(self):
        self.h.__enter__()
        self.d = self.h.connect()
        self._boot_and_get()
        return self

    def __exit__(self, *exc):
        return self.h.__exit__(*exc)

    # ---- navigation ----
    def scr(self):
        return "\n".join(self.d.read_screen()[0] or [])

    def go(self, key, sub, tries=30):
        if key:
            self.d.send_keys(key)
        for _ in range(tries):
            if sub in self.scr():
                return True
            time.sleep(0.4)
        return False

    def to_main(self):
        for _ in range(6):
            if "MAIN MENU" in self.scr():
                return
            self.d.send_keys("f10")
            time.sleep(0.6)

    def _boot_and_get(self):
        self.go("", "Press Any Key")
        self.d.send_keys("enter"); self.go("", "MAIN MENU")
        self.go("f3", "GET / SAVE MENU")
        self.d.send_keys("f3")
        self.go("", "RADIO SERIAL")
        if "WARNING" in self.scr():
            self.d.send_keys("f2"); self.go("", "RADIO SERIAL")
        self.d.send_keys("f8"); self.go("", "GET / SAVE MENU")   # GET SELECTED

    def to_opt1(self):
        self.to_main()
        self.go("f4", "CHANGE / VIEW")
        self.go("f5", "MODE CONFIGURATION")
        self.go("f7", "CONFIGURATION OPTIONS")

    def save(self, dst):
        self.to_main()
        self.go("f3", "GET / SAVE MENU")
        self.d.send_keys("f7"); self.go("", "SAVE CODEPLUG")
        self.d.send_keys("f8"); time.sleep(3)      # SAVE FILE
        self.d.send_keys("f10"); time.sleep(2)     # abort diskette BACKUP
        self.go("", "GET / SAVE MENU")
        shutil.copy(self.archive_path, dst)

    # ---- the protocol ----
    def map_field(self, edit_fn, label, exclude_checksum=True):
        b0 = os.path.join(self.workdir, "fd_b0.035")
        b1 = os.path.join(self.workdir, "fd_b1.035")
        b2 = os.path.join(self.workdir, "fd_b2.035")
        self.save(b0)
        self.save(b1)
        edit_fn(self)                 # perform exactly one field change
        self.save(b2)
        base, basen, edit = _body(b0), _body(b1), _body(b2)
        noise = _diff(base, basen)
        field = _diff(base, edit) - noise
        if exclude_checksum:
            field -= CHECKSUM_BLOCK
        recs = None
        try:
            from motreader import codeplug as C
            recs = C.find_vhf_records(base)
        except Exception:
            pass
        out = []
        for i in sorted(field):
            rel = f" rec+{i-recs[0]}" if recs and recs[0] <= i else ""
            out.append((i, base[i], edit[i], rel))
        print(f"\n[{label}] field-only on-disk bytes (noise & checksum excluded):")
        for i, a, b, rel in out:
            print(f"   body[{i:#06x}] {a:#04x} -> {b:#04x}  xor {a ^ b:08b}{rel}")
        return out


def opt1_toggle(tabs):
    """Edit callback: on the MODE OPT 1 screen, TAB `tabs` times from the default
    field (Channel Chg ID), then press DOWN once to toggle that field's value.
    TAB order: 0=Channel Chg ID, 1=uP Xtal Shift, 2=Transmit Power, ..."""
    def _edit(fm):
        fm.to_opt1()
        for _ in range(tabs):
            fm.d.send_keys("tab"); time.sleep(0.3)
        fm.d.send_keys("down"); time.sleep(0.4)
    return _edit


if __name__ == "__main__":
    # demo: map Transmit Power on the 221AZN sandbox
    if len(sys.argv) < 4:
        sys.exit("usage: field_diff.py <sandbox_c> <workdir> <archive_A_file> [tabs] [label]")
    sandbox_c, workdir, arch = sys.argv[1:4]
    tabs = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    label = sys.argv[5] if len(sys.argv) > 5 else "Transmit Power"
    with FieldMapper(sandbox_c, workdir, arch) as fm:
        fm.map_field(opt1_toggle(tabs), label)
