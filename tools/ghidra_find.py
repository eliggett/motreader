"""Find code that references key Spectra strings, and decompile it.

Strings live in DGROUP (undefined data in Ghidra), so we search raw memory for
the bytes, then (a) check Ghidra references, and (b) scan instructions for an
immediate operand equal to the string's segment offset. Decompiles every
referencing function and its callers.
"""

import os
import sys

import pyghidra

pyghidra.start()

from ghidra.base.project import GhidraProject  # noqa: E402
from ghidra.app.decompiler import DecompInterface  # noqa: E402
from ghidra.util.task import ConsoleTaskMonitor  # noqa: E402

TARGETS = [
    b"Decoding Codeplug Data",
    b"Saving Data To Archive Disk",
    b"Reading Codeplug From Archive",
    b"Archive Updated OK",
    b"GET CODEPLUG DATA FROM ARCHIVE",
]


def main(project_location, project_name, outdir):
    os.makedirs(outdir, exist_ok=True)
    gp = GhidraProject.openProject(project_location, project_name, False)
    prog = gp.openProgram("/", "SPECTRA1.EXE", True)
    try:
        run(prog, outdir)
    finally:
        gp.close()


def run(prog, outdir):
    mem = prog.getMemory()
    fm = prog.getFunctionManager()
    listing = prog.getListing()
    refman = prog.getReferenceManager()
    decomp = DecompInterface()
    decomp.openProgram(prog)
    monitor = ConsoleTaskMonitor()

    def find_bytes(pat):
        hits = []
        addr = mem.findBytes(prog.getMinAddress(), pat, None, True, monitor)
        while addr is not None:
            hits.append(addr)
            nxt = addr.add(1)
            addr = mem.findBytes(nxt, pat, None, True, monitor)
        return hits

    def decompile(func):
        res = decomp.decompileFunction(func, 90, monitor)
        if res and res.decompileCompleted():
            return res.getDecompiledFunction().getC()
        return "// decompile failed: %s\n" % func.getName()

    report = open(os.path.join(outdir, "find_report.txt"), "w")
    cfuncs = {}

    def note(func, why):
        if func is None:
            return
        cfuncs.setdefault(func.getEntryPoint().toString(), (func, why))

    for pat in TARGETS:
        report.write("\n=== %r ===\n" % pat)
        hits = find_bytes(pat)
        for h in hits:
            report.write("  found at %s (offset %#x)\n" % (h, h.getOffset()))
            # (a) Ghidra-known references
            refs = list(refman.getReferencesTo(h))
            for r in refs:
                f = fm.getFunctionContaining(r.getFromAddress())
                report.write("    ref from %s in %s\n" % (
                    r.getFromAddress(), f.getName() if f else "<none>"))
                note(f, "ref %r" % pat)
            # (b) scan for immediate == offset
            off = h.getOffset() & 0xFFFF
            scanned = 0
            for ins in listing.getInstructions(True):
                for i in range(ins.getNumOperands()):
                    for obj in ins.getOpObjects(i):
                        try:
                            val = obj.getValue() & 0xFFFF
                        except Exception:
                            continue
                        if val == off and off != 0:
                            f = fm.getFunctionContaining(ins.getAddress())
                            report.write("    imm@ %s in %s : %s\n" % (
                                ins.getAddress(), f.getName() if f else "<none>", ins))
                            note(f, "imm %r" % pat)
                            scanned += 1
                if scanned > 40:
                    break

    # decompile callers too
    callers = {}
    for key, (f, why) in list(cfuncs.items()):
        for c in f.getCallingFunctions(monitor):
            callers.setdefault(c.getEntryPoint().toString(), (c, "caller of %s" % f.getName()))
    cfuncs.update(callers)

    with open(os.path.join(outdir, "find_funcs.c"), "w") as fh:
        for key, (f, why) in cfuncs.items():
            fh.write("\n/* ===== %s @ %s  (%s) ===== */\n" % (f.getName(), key, why))
            fh.write(decompile(f))

    report.write("\n-- %d functions dumped --\n" % len(cfuncs))
    report.close()
    print("FIND DONE ->", outdir, "funcs:", len(cfuncs))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
