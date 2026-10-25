"""Standalone PyGhidra extractor for the Spectra archive descramble routines.

Opens the already-analyzed SPECTRA1.EXE from the headless project (read-only,
no re-analysis) and dumps: memory map, anchor-string xref functions decompiled,
and functions containing INT instructions (DOS file I/O).

Usage:
    python tools/ghidra_extract.py <project_location> <project_name> <outdir>
Requires env GHIDRA_INSTALL_DIR set to the Ghidra install.
"""

import os
import sys

import pyghidra

pyghidra.start()

from ghidra.base.project import GhidraProject  # noqa: E402
from ghidra.app.decompiler import DecompInterface  # noqa: E402
from ghidra.util.task import ConsoleTaskMonitor  # noqa: E402


def main(project_location, project_name, outdir):
    os.makedirs(outdir, exist_ok=True)
    gp = GhidraProject.openProject(project_location, project_name, False)
    prog = gp.openProgram("/", "SPECTRA1.EXE", True)  # read-only
    try:
        run(prog, outdir)
    finally:
        gp.close()


def run(prog, outdir):
    fm = prog.getFunctionManager()
    mem = prog.getMemory()
    listing = prog.getListing()

    with open(os.path.join(outdir, "memmap.txt"), "w") as fh:
        for b in mem.getBlocks():
            fh.write("%-18s %s - %s init=%s exec=%s size=%d\n" % (
                b.getName(), b.getStart(), b.getEnd(),
                b.isInitialized(), b.isExecute(), b.getSize()))

    decomp = DecompInterface()
    decomp.openProgram(prog)
    monitor = ConsoleTaskMonitor()

    def func_at(addr):
        return fm.getFunctionContaining(addr)

    def decompile(func):
        res = decomp.decompileFunction(func, 90, monitor)
        if res and res.decompileCompleted():
            return res.getDecompiledFunction().getC()
        return "// decompile failed: %s" % func.getName()

    refman = prog.getReferenceManager()

    def refs_to(addr):
        return refman.getReferencesTo(addr)

    anchors = ["Codeplug", "Decoding", "Saving Data", "Reading Codeplug",
               "Archive", "Requires MOTOROLA", "corrupt", "Corrupt"]
    dumped = set()
    anchor_funcs = []

    with open(os.path.join(outdir, "string_xrefs.txt"), "w") as fh:
        data_iter = listing.getDefinedData(True)
        for d in data_iter:
            v = d.getValue()
            s = str(v) if v is not None else ""
            if any(a in s for a in anchors):
                fh.write("STRING @ %s : %r\n" % (d.getAddress(), s[:70]))
                for r in refs_to(d.getAddress()):
                    f = func_at(r.getFromAddress())
                    nm = f.getName() if f else "<none>"
                    fh.write("   xref from %s in %s\n" % (r.getFromAddress(), nm))
                    if f:
                        anchor_funcs.append(f)

    with open(os.path.join(outdir, "anchor_funcs.c"), "w") as fh:
        for f in anchor_funcs:
            key = f.getEntryPoint().toString()
            if key in dumped:
                continue
            dumped.add(key)
            fh.write("\n/* ===== %s @ %s ===== */\n" % (f.getName(), key))
            fh.write(decompile(f))
            # Also dump callees one level down (the actual crypto is often a leaf)
            for callee in f.getCalledFunctions(monitor):
                ck = callee.getEntryPoint().toString()
                if ck in dumped:
                    continue
                dumped.add(ck)
                fh.write("\n/* --- callee %s @ %s (from %s) --- */\n" % (
                    callee.getName(), ck, f.getName()))
                fh.write(decompile(callee))

    with open(os.path.join(outdir, "int_funcs.txt"), "w") as fh:
        seen = set()
        for ins in listing.getInstructions(True):
            if ins.getMnemonicString().upper() == "INT":
                f = func_at(ins.getAddress())
                if f and f.getEntryPoint().toString() not in seen:
                    seen.add(f.getEntryPoint().toString())
                    fh.write("INT @ %s in %s : %s\n" % (
                        ins.getAddress(), f.getName(), ins))
        fh.write("-- %d functions contain INT --\n" % len(seen))

    print("EXTRACT DONE ->", outdir, "anchor_funcs:", len(dumped))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
