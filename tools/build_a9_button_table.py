#!/usr/bin/env python3
"""Build the A9 / S9000e button template table (motreader/_a9_table.py and
notes/ground-truth/buttons_a9_templates.json) from RSS cycle runs made with
tools/scenario_cycle_button.py on 221AZN0035, one run dir per key (see RUNS).

Usage: build_a9_button_table.py <dir holding the run dirs>

Per function it records the copy-1 / copy-2 record templates, the key-code
rule (key's home code, home + 0x1d, or a fixed code), the Ind keys' indicator
entries, and the data slots of direct-entry functions (found by comparing runs
made with different  values). Reports any inconsistency between keys.
"""
import sys, os, json
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from motreader.archive import Archive
from motreader.crypto import decrypt_body
SP = sys.argv[1]
SIDE = 0x15a4


def body(p):
    return decrypt_body(Archive.load(p).body)


def side(b):
    out, a = [], SIDE
    while b[a:a + 5] != b"\0" * 5:
        out.append(b[a:a + 5].hex())
        a += 5
    return out
M1, M2 = 0xdd2, 0x103a
# run dir -> (button, record, home code, led, data value)
RUNS = {
    "a9cyc_t1": ("Ind 2", 27, 0x14, 7, 2), "a9cyc_t1b": ("Ind 2", 27, 0x14, 7, 2),
    "a9cyc_t1c": ("Ind 2", 27, 0x14, 7, 2), "a9cyc_d5": ("Ind 2", 27, 0x14, 7, 5),
    "a9cyc_t6": ("1", 22, 0x01, None, 2), "a9cyc_d12": ("1", 22, 0x01, None, 12),
    "a9cyc_t18": ("Mode Dn", 28, 0x12, None, 2), "a9cyc_t19": ("Mode Up", 26, 0x12, None, 2),
    "a9cyc_t20": ("Vol Dn", 33, 0x12, None, 2), "a9cyc_t21": ("Vol Up", 36, 0x12, None, 2),
    "a9cyc_t22": ("Zone Up", 25, 0x12, None, 2),
}
obs = {}          # label -> list of (button, data, rec1, rec2, sides, home)
allowed = {}
names = {}
for dd, (btn, r, home, led, dval) in RUNS.items():
    p = os.path.join(SP, dd, "values.json")
    if not os.path.exists(p):
        continue
    for v in json.load(open(p)):
        lab = " ".join(v["label"].split()) or "Securenet"
        if lab not in allowed.setdefault(btn, []):
            allowed[btn].append(lab)
        if not v.get("saved", True):
            continue
        b = body(os.path.join(SP, dd, f"v{v['i']}.bin"))
        recs = [bytes(b[base + 7 * r: base + 7 * r + 7]) for base in (M1, M2)]
        if v["dup"] and recs[0][:6] == bytes.fromhex("008000000000") and lab != "Blank":
            continue          # RSS's duplicate F2 blanked this button
        sd = [bytes.fromhex(e) for e in side(b)
              if led is not None and int(e[6:8], 16) & 0x3f == led]
        names[lab] = v["name"]
        obs.setdefault(lab, []).append((btn, dval if v.get("data") else None, recs, sd, home, led))

table, report = {}, []
for lab, os_ in obs.items():
    # data slots: bytes equal to the typed value whose value follows the data
    slots = []
    datas = [o for o in os_ if o[1] is not None]
    if datas:
        ref = datas[0]
        for where in ["r1", "r2"] + [f"s{i}" for i in range(len(ref[3]))]:
            def get(o, where=where):
                return o[2][0] if where == "r1" else o[2][1] if where == "r2" else o[3][int(where[1:])]
            use = datas if where[0] == "r" else [o for o in datas if o[5] is not None]
            for i in range(6 if where[0] == "r" else 5):
                if use and all(get(o)[i] == o[1] for o in use) and len({o[1] for o in use}) > 1:
                    slots.append((where, i))
    # record templates + code rule, consistent over all observations
    recs = []
    for c in (0, 1):
        tmpl = {o[2][c][:6].hex() if not slots else
                bytes(0 if ("r%d" % (c + 1), i) in slots else x
                      for i, x in enumerate(o[2][c][:6])).hex() for o in os_}
        flags = {o[2][c][6] & 0xc0 for o in os_}
        codes = set()
        for o in os_:
            low, home = o[2][c][6] & 0x3f, o[4]
            if home is None:
                codes.add(("abs", low))
            elif low == home:
                codes.add(("home", low))
            elif low == (home + 0x1d) & 0x3f:
                codes.add(("+1d", low))
            else:
                codes.add(("abs", low))
        kinds = {k for k, _ in codes}
        if kinds == {"+1d"}:
            code = "+1d"
        elif "abs" in kinds or len({v for _, v in codes}) == 1 and len(os_) > 1 \
                and len({o[4] for o in os_}) > 1:
            vals = {v for _, v in codes}
            code = vals.pop() if len(vals) == 1 else None
            if len(vals):
                report.append((lab, c, "inconsistent code", codes))
        else:
            code = None
        if len(tmpl) > 1 or len(flags) > 1:
            report.append((lab, c, "inconsistent template", tmpl, flags))
        recs.append((sorted(tmpl)[0], flags.pop(), code))
    sides = None
    for o in os_:
        if o[5] is None:
            continue
        s = [bytes(0 if (f"s{k}", i) in slots else x for i, x in enumerate(e)).hex()
             for k, e in enumerate(o[3])]
        s = [e[:6] + "%02x" % (int(e[6:8], 16) & 0xc0) + e[8:] for e in s]
        if sides is not None and s != sides:
            report.append((lab, "inconsistent side", sides, s))
        sides = s
    table[lab] = (names[lab], recs[0], recs[1], sides or [], slots)

# "home" vs fixed code is ambiguous when only seen on keys whose home equals it
json.dump({"functions": table, "allowed": allowed},
          open(os.path.join(ROOT, "notes/ground-truth/buttons_a9_templates.json"), "w"), indent=1)
for r in report:
    print("!!", r)
print(len(table), "functions", {k: len(v) for k, v in allowed.items()})

# ---- emit motreader/_a9_table.py ----
def cls(btn):
    return "ind" if btn.startswith("Ind") else "keypad" if btn.isdigit() else btn
allowed_c = {}
for btn, labs in allowed.items():
    allowed_c.setdefault(cls(btn), [])
    for l in labs:
        if l not in allowed_c[cls(btn)]:
            allowed_c[cls(btn)].append(l)
L = ['"""GENERATED by the A9 button mapping (see buttons_a9.py) from RSS saves;',
     'do not edit by hand. Source: notes/ground-truth/buttons_a9_templates.json."""',
     "", "# label: (full name, (rec1 hex, flags, code), (rec2 hex, flags, code),",
     "#         [indicator entries], [data slots])", "FUNCTIONS = {"]
for lab in sorted(table, key=str.lower):
    n, r1, r2, sd, sl = table[lab]
    L.append(f"    {lab!r}: ({n!r},")
    L.append(f"        {tuple(r1)!r}, {tuple(r2)!r},")
    L.append(f"        {sd!r}, {[tuple(x) for x in sl]!r}),")
L.append("}")
L.append("")
L.append("# offered by RSS per key class / labelled key, in RSS's DOWN-arrow order")
L.append("ALLOWED = {")
for k, v in allowed_c.items():
    L.append(f"    {k!r}: {v!r},")
L.append("}")
open(os.path.join(ROOT, "motreader/_a9_table.py"), "w").write("\n".join(L) + "\n")
print("wrote _a9_table.py")
