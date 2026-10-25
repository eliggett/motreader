"""Decompile the function(s) containing given linear addresses.

Usage: python tools/ghidra_at.py <proj_loc> <proj_name> <outfile> <lin_hex> [lin_hex...]
Addresses are the flat offsets Ghidra prints (e.g. 0x3f697).
"""
import sys
import pyghidra

pyghidra.start()
from ghidra.base.project import GhidraProject  # noqa: E402
from ghidra.app.decompiler import DecompInterface  # noqa: E402
from ghidra.util.task import ConsoleTaskMonitor  # noqa: E402


def main():
    ploc, pname, outfile = sys.argv[1], sys.argv[2], sys.argv[3]
    lins = [int(x, 16) for x in sys.argv[4:]]
    gp = GhidraProject.openProject(ploc, pname, False)
    prog = gp.openProgram("/", "SPECTRA1.EXE", True)
    try:
        fm = prog.getFunctionManager()
        decomp = DecompInterface()
        decomp.openProgram(prog)
        mon = ConsoleTaskMonitor()
        # Build list of all functions with their flat offset ranges
        funcs = []
        for f in fm.getFunctions(True):
            ep = f.getEntryPoint().getOffset()
            body = f.getBody()
            funcs.append((f, ep, body))
        with open(outfile, "w") as fh:
            for lin in lins:
                fh.write("\n######## target linear %#x ########\n" % lin)
                # find function whose body contains any address with this flat offset
                hit = None
                for f, ep, body in funcs:
                    for rng in body.getAddressRanges():
                        if rng.getMinAddress().getOffset() <= lin <= rng.getMaxAddress().getOffset():
                            hit = f
                            break
                    if hit:
                        break
                if not hit:
                    # fallback: nearest preceding entry
                    cand = [x for x in funcs if x[1] <= lin]
                    cand.sort(key=lambda x: -x[1])
                    hit = cand[0][0] if cand else None
                if hit is None:
                    fh.write("  no function found\n")
                    continue
                res = decomp.decompileFunction(hit, 120, mon)
                c = res.getDecompiledFunction().getC() if res and res.decompileCompleted() else "// fail\n"
                fh.write("/* %s @ %s */\n%s\n" % (hit.getName(), hit.getEntryPoint(), c))
        print("AT DONE ->", outfile)
    finally:
        gp.close()


if __name__ == "__main__":
    main()
