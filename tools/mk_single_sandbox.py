#!/usr/bin/env python3
"""Build a sandbox MRSS/SPECTRA whose archive list holds ONE radio, so RSS
highlights it by default and F7 (GET CURRENT) loads it with no serial typing
(the AUTOTYPE serial entry is unreliable). Optionally patch the archive first.

Usage: mk_single_sandbox.py <serial> <dst_sandbox_c> [patched_a_archive]
  <serial>            e.g. 617ASN1665 (must exist in the source DBF)
  <dst_sandbox_c>     the C: dir to create (…/c with MRSS/SPECTRA inside)
  [patched_a_archive] optional: a pre-patched A-file to use instead of the real one
"""
import os, sys, shutil
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from motreader.dbf import read_dbf, write_dbf, DbfTable

SRC_MRSS = os.path.expanduser("~/.dosbox/c/MRSS/SPECTRA")
SRC_ARCH = os.environ.get("MOT_SRC_ARCH") or \
    os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA/ARCHIVE")   # $MOT_SRC_ARCH: another archive dir


def _ci(d, name):
    """Path of `name` in dir d, matched case-insensitively (DOS archives)."""
    for f in os.listdir(d):
        if f.lower() == name.lower():
            return os.path.join(d, f)
    return os.path.join(d, name)


def main():
    serial = sys.argv[1].upper()
    dst_c = sys.argv[2]
    patched = sys.argv[3] if len(sys.argv) > 3 else None

    dst_spectra = os.path.join(dst_c, "MRSS", "SPECTRA")
    if os.path.exists(dst_c):
        shutil.rmtree(dst_c)
    shutil.copytree(SRC_MRSS, dst_spectra)

    # find the DBF record for this serial
    src_dbf = _ci(SRC_ARCH, "spectram.dbf")
    t = read_dbf(src_dbf)
    rec = next((r for r in t.records if r["SERIAL"].strip() == serial), None)
    if rec is None:
        sys.exit(f"serial {serial} not in {src_dbf}")
    fn = rec["FILENAME"].strip()

    # fresh single-entry ARCHIVE dir
    arch = os.path.join(dst_spectra, "ARCHIVE")
    if os.path.exists(arch):
        shutil.rmtree(arch)
    os.makedirs(arch)
    # copy the a/b files (lowercase on disk)
    a_src = _ci(SRC_ARCH, fn.lower())
    b_src = _ci(SRC_ARCH, ("b" + fn[1:]).lower())
    shutil.copy(patched if patched else a_src, os.path.join(arch, fn.lower()))
    if os.path.exists(b_src):
        shutil.copy(b_src, os.path.join(arch, ("b" + fn[1:]).lower()))

    # single-record DBF
    one = DbfTable(fields=t.fields, records=[rec])
    write_dbf(one, os.path.join(arch, "spectram.dbf"))
    print(f"sandbox {dst_c}: only {serial} ({fn}) listed")


if __name__ == "__main__":
    main()
