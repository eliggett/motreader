#!/usr/bin/env python3
"""Analyze a harness trace: segment by markers, summarize the buffer accesses
in a field window, and diff two traces that differ in one field.

  python tools/trace_analyze.py window <trace.bin> [BEGIN_label]
  python tools/trace_analyze.py diff   <a.bin> <b.bin>

'window' lists, per marker segment, the distinct buffer offsets read/written
and the CS:IP(s) that touched them -- i.e. "this field was decoded from these
source bytes by the routine(s) at these addresses".

'diff' reports the buffer offsets whose READ values differ between two traces
(the white-box equivalent of diffing decrypted plaintexts): if A and B differ
only in one field, the differing offsets are that field's source bytes.
"""
import sys
from collections import OrderedDict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from trace_decode import load, Buffer, Access, Mark, Step


def _base(recs):
    return next((r.base for r in recs if isinstance(r, Buffer)), 0)


def segments(recs):
    """Split the access stream into (label, [Access]) windows by Mark records."""
    segs = []
    label = "(start)"
    cur = []
    for r in recs:
        if isinstance(r, Mark):
            segs.append((label, cur))
            label = r.label
            cur = []
        elif isinstance(r, Access):
            cur.append(r)
    segs.append((label, cur))
    return segs


def window(path, only_label=None):
    recs = load(path)
    base = _base(recs)
    print(f"base={base:#x}" if base else "base=unknown (no watch base)")
    for label, accs in segments(recs):
        if not accs:
            continue
        if only_label and only_label not in label:
            continue
        reads = [a for a in accs if not a.write]
        writes = [a for a in accs if a.write]
        print(f"\n=== {label} === {len(reads)} reads, {len(writes)} writes")
        # distinct offsets read, with the values and the code that read them
        byoff = OrderedDict()
        for a in reads:
            key = (a.addr, a.size)
            byoff.setdefault(key, {"vals": set(), "csip": set()})
            byoff[key]["vals"].add(a.value)
            byoff[key]["csip"].add((a.cs, a.eip))
        for (addr, size), info in byoff.items():
            off = addr - base if base else addr
            vals = " ".join(f"{v:#x}" for v in sorted(info["vals"]))
            csip = " ".join(f"{cs:04x}:{ip:04x}" for cs, ip in sorted(info["csip"]))
            print(f"  off {off:+#06x} sz{size}  vals={vals}  by {csip}")


def diff(path_a, path_b):
    ra, rb = load(path_a), load(path_b)
    ba, bb = _base(ra), _base(rb)

    def read_map(recs, base):
        m = {}
        for r in recs:
            if isinstance(r, Access) and not r.write:
                m.setdefault(r.addr - base, set()).add(r.value)
        return m

    ma, mb = read_map(ra, ba), read_map(rb, bb)
    offs = sorted(set(ma) | set(mb))
    print("offsets whose READ value differs between the two traces:")
    any_diff = False
    for o in offs:
        va, vb = ma.get(o, set()), mb.get(o, set())
        if va != vb:
            any_diff = True
            sa = " ".join(f"{v:#x}" for v in sorted(va)) or "-"
            sb = " ".join(f"{v:#x}" for v in sorted(vb)) or "-"
            print(f"  off {o:+#06x}:  A={sa}   B={sb}")
    if not any_diff:
        print("  (none)")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    mode = sys.argv[1]
    if mode == "window":
        window(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif mode == "diff":
        diff(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
