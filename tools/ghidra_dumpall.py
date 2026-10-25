"""Decompile every function in SPECTRA1.EXE to one text file, with an index.

Grep the result for the descramble routine (XOR loops, LCG multiply/add over a
buffer). Each function is tagged with its entry address and a crude feature
summary (#xor, #mul, has-loop) to make the crypto routine easy to spot.
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
    prog = gp.openProgram("/", "SPECTRA1.EXE", True)
    try:
        run(prog, outdir)
    finally:
        gp.close()


def run(prog, outdir):
    fm = prog.getFunctionManager()
    decomp = DecompInterface()
    decomp.openProgram(prog)
    monitor = ConsoleTaskMonitor()

    funcs = list(fm.getFunctions(True))
    index = []
    out = open(os.path.join(outdir, "all_funcs.c"), "w")
    for f in funcs:
        res = decomp.decompileFunction(f, 60, monitor)
        if not (res and res.decompileCompleted()):
            c = "// decompile failed\n"
        else:
            c = res.getDecompiledFunction().getC()
        ent = f.getEntryPoint().toString()
        nx = c.count("^")
        nmul = c.count("*")
        nmod = c.count("%")
        has_loop = ("while" in c) or ("for" in c) or ("do {" in c)
        # crude crypto score
        score = nx * 3 + (nmul if nmul < 20 else 0) + nmod * 2 + (5 if has_loop else 0)
        index.append((score, nx, nmul, nmod, has_loop, f.getName(), ent, len(c)))
        out.write("\n/* ===== %s @ %s  xor=%d mul=%d mod=%d loop=%s ===== */\n"
                  % (f.getName(), ent, nx, nmul, nmod, has_loop))
        out.write(c)
    out.close()

    index.sort(reverse=True)
    with open(os.path.join(outdir, "crypto_index.txt"), "w") as fh:
        fh.write("score xor mul mod loop  name @ entry  (clen)\n")
        for row in index:
            fh.write("%5d %3d %3d %3d %-5s  %s @ %s  (%d)\n"
                     % (row[0], row[1], row[2], row[3], row[4],
                        row[5], row[6], row[7]))
    print("DUMPALL DONE: %d funcs ->" % len(funcs), outdir)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
