"""Control-head button map for the A9 / S9000e head ("CONVENTIONAL EXPANDED",
221AZN): RSS CHANGE/VIEW -> CONTROL HEAD -> F2 KEYPAD. Exported as buttons.csv
alongside the Standard/Enhanced/Rotary map in buttons.py.

Located and tabulated white-box with the dosbox-x harness: every editable key
class (Ind, keypad, labelled) was stepped through every function RSS offers
and saved (tools/scenario_cycle_button.py); the bytes RSS wrote are the
template table below (notes/ground-truth/buttons_a9_templates.json).

Storage (offsets for 221AZN; located relative to the A9 head checksum):

* Key map: 88 x 7-byte records, two copies 0x268 apart (copy 2 is the
  trunking layer: some functions write a different record or Blank there).
  Record = 6-byte function template + 1 byte: flags (b7-b6, from the template)
  | key code (b5-b0). The key code is the key's own "home" code unless the
  function has a fixed one (Mode Dn 0x0c, Vol Up 0x11, Sel 0x0e ...); Mode X
  writes home + 0x1d.
* Bitmap (11 bytes right before the key map): one bit per record, MSB first,
  set when the copy-1 record's 2nd byte is 0x90 (e.g. Airhn).
* Indicator list: 5-byte entries (group, function, param, flags|LED, x),
  zero-terminated. Fixed radio entries first, then the Ind buttons' entries in
  key-record order. Ind n lights LED n + 5.
* All of it is covered by the A9 head checksum (big-endian sum of words at odd
  addresses), which is carried by the edit delta.
"""

from __future__ import annotations

from typing import Optional

from .codeplug import Codeplug
from .buttons import Button

N_RECS = 88
REC_LEN = 7
COPY2 = 0x268
MAP_FROM_CK = 0x23          # first key record = checksum offset + 0x23
SIDE_FROM_MAP = 0x7D2       # indicator list = key map + 0x7d2
BITMAP_LEN = 11             # 88-bit map just before the key map (MSB first):
                            # bit set = copy-1 record's 2nd byte is 0x90 (Airhn ...)
SIDE_LEN = 5
SIDE_CAP = 0x180            # indicator list area (zero-filled; 221AZN has zeros to 0x1842)

# button -> (record index, home key code, LED or None); export order
KEYS = {
    "Ind 1": (19, 0x0e, 6), "Ind 2": (27, 0x14, 7), "Ind 3": (35, 0x15, 8),
    "Ind 4": (21, 0x16, 9), "Ind 5": (29, 0x17, 0x0A), "Ind 6": (37, 0x18, 0x0B),
    "1": (22, 0x01, None), "2": (39, 0x02, None), "3": (15, 0x03, None),
    "4": (23, 0x04, None), "5": (38, 0x05, None), "6": (14, 0x06, None),
    "7": (20, 0x07, None), "8": (18, 0x08, None), "9": (12, 0x09, None),
    "*": (17, 0x0a, None), "0": (34, 0x00, None), "#": (10, 0x0b, None),
    "Mode Dn": (28, 0x12, None), "Mode Up": (26, 0x12, None),
    "Vol Dn": (33, 0x12, None), "Vol Up": (36, 0x12, None),
    "Zone Up": (25, 0x12, None), "Home": (9, 0x12, None),
}
FIXED = {"*", "0", "#",                  # RSS: "... May NOT Be Changed"
         "Ind 1", "Home"}                # RSS: "SEL / HOME Button Is REQUIRED" there
IND = tuple(k for k in KEYS if k.startswith("Ind"))
KEYPAD = tuple(str(i) for i in range(1, 10))
LABELLED = ("Mode Dn", "Mode Up", "Vol Dn", "Vol Up", "Zone Up", "Home")
DUP_SCOPE = IND + KEYPAD    # RSS's duplicate check covers only these buttons
NOT_OFFERED = {"Securenet"}              # encryption: decoded, never offered
# Byte-identical functions: RSS writes the same bytes for both, so a saved
# codeplug can't tell them apart. Decode reports the name RSS shows on GET;
# the alias is accepted on import (same bytes).
ALIASES = {"V/A Dn": "Vol Dn", "V/A Up": "Vol Up", "Scrl-Lt": "Mode Dn",
           "Scrl-Rt": "Mode Up", "Send-A": "Sel", "Pass": "Emp No"}

# Function templates: label -> (full name,
#   copy-1 record (6-byte hex, flags, code), copy-2 record (same),
#   indicator entries (hex "ggffppFFxx", FF = flags, LED added per key),
#   data slots (where, byte) for direct-entry functions)
# code: None = the key's home code, "+1d" = home + 0x1d, int = fixed code.
FUNCTIONS: dict = {}     # filled from the generated table below
ALLOWED: dict = {}       # "ind" / "keypad" / labelled key name -> labels RSS offers

from ._a9_table import FUNCTIONS as _F, ALLOWED as _A   # noqa: E402
FUNCTIONS.update(_F)
ALLOWED.update(_A)


def _class(button: str) -> str:
    """Key of ALLOWED: "ind", "keypad", or the labelled key's own name."""
    return "ind" if button in IND else "keypad" if button in KEYPAD else button


def has_a9(cp: Codeplug) -> bool:
    return cp.ascii_names is not None and _layout(cp) is not None


def _layout(cp: Codeplug) -> Optional[tuple]:
    """(map start, indicator list start) or None if the structure is not the
    one mapped on 221AZN (then buttons are left alone)."""
    from .lists import a9_head_checksum_off
    ck = a9_head_checksum_off(cp)
    if ck is None:
        return None
    m = ck + MAP_FROM_CK
    b = cp.body
    s = m + SIDE_FROM_MAP
    if s + SIDE_CAP > len(b):
        return None
    # sanity: every record's 2nd byte is a plausible template byte, both copies
    # agree on the blank layer records, and the indicator list terminates
    blank = bytes.fromhex("008000000000")
    if sum(b[m + COPY2 + REC_LEN * i:][:6] == blank for i in range(40, N_RECS)) < 30:
        return None
    if _read_side(b, s) is None:
        return None
    return m, s


def _read_side(b, s) -> Optional[list]:
    out = []
    a = s
    while a + SIDE_LEN <= s + SIDE_CAP:
        e = bytes(b[a:a + SIDE_LEN])
        if e == b"\0" * SIDE_LEN:
            return out
        out.append(e)
        a += SIDE_LEN
    return None


def _rec(b, m, idx, copy):
    a = m + copy * COPY2 + REC_LEN * idx
    return bytes(b[a:a + REC_LEN])


def _code(c, home):
    return home if c is None else (home + 0x1D) & 0x3F if c == "+1d" else c


def _build(label, home, led, data):
    """-> (rec1, rec2, [indicator entries]) for a function on a key."""
    _name, r1, r2, sides, slots = FUNCTIONS[label]
    recs = []
    for t, fl, c in (r1, r2):
        recs.append(bytearray(bytes.fromhex(t) + bytes([fl | _code(c, home)])))
    ents = []
    for e in sides:
        x = bytearray.fromhex(e)
        x[3] |= led
        ents.append(x)
    for where, i in slots:
        tgt = recs[0] if where == "r1" else recs[1] if where == "r2" else ents[int(where[1:])]
        tgt[i] = data
    return bytes(recs[0]), bytes(recs[1]), [bytes(e) for e in ents]


def _match(label, b, m, side, button):
    """Data value (or True) if `button`'s bytes are exactly `label`, else None."""
    idx, home, led = KEYS[button]
    have1, have2 = _rec(b, m, idx, 0), _rec(b, m, idx, 1)
    mine = [e for e in side if led is not None and e[3] & 0x3F == led]
    slots = FUNCTIONS[label][4]
    cands = [0] if not slots else sorted({have1[i] for w, i in slots if w == "r1"} or {0})
    for d in cands:
        r1, r2, ents = _build(label, home, led or 0, d)
        if r1 == have1 and r2 == have2 and (led is None or ents == mine):
            return d if slots else True
    return None


def _label_of(label, d):
    return label.replace("X", str(d)) if FUNCTIONS[label][4] else label


def decode_buttons(cp: Codeplug) -> list:
    lay = _layout(cp) if cp.ascii_names is not None else None
    if lay is None:
        return []
    m, s = lay
    b = cp.body
    side = _read_side(b, s)
    out = []
    for btn, (idx, _home, _led) in KEYS.items():
        raw = (_rec(b, m, idx, 0) + _rec(b, m, idx, 1)).hex()
        lab, name = "0x" + raw, ""
        for cand in FUNCTIONS:
            if cand in ALIASES:
                continue
            d = _match(cand, b, m, side, btn)
            if d is not None:
                lab, name = _label_of(cand, d), FUNCTIONS[cand][0]
                break
        out.append(Button(btn, lab, name, raw, btn not in FIXED))
    return out


def _parse(btn, func):
    """'Zone 3' -> ('Zone X', 3); 'Scan' -> ('Scan', 0)."""
    f = " ".join(func.split())
    for lab, (_n, _r1, _r2, _s, slots) in FUNCTIONS.items():
        if lab.lower() == f.lower() and not slots:
            return lab, 0
        if slots:
            stem = lab[:-1].strip().lower()
            if f.lower().startswith(stem) and f[len(stem):].strip().isdigit():
                return lab, int(f[len(stem):])
    raise ValueError(f"button {btn}: unknown A9 function {func!r} "
                     f"(known: {sorted(FUNCTIONS)})")


def encode_buttons(cp: Codeplug, body: bytearray, rows) -> None:
    """Apply buttons.csv rows on an A9 head (change-gated per button)."""
    lay = _layout(cp)
    if lay is None:
        raise ValueError("A9 key map not recognized; refusing to edit buttons")
    m, s = lay
    orig = {x.button: x for x in decode_buttons(cp)}
    want = {}
    for r in rows:
        o = orig.get(r.button)
        if o is None:
            raise ValueError(f"button {r.button!r} does not exist on this head "
                             f"(buttons: {list(orig)})")
        if " ".join(r.function.split()).lower() == " ".join(o.function.split()).lower():
            continue
        if not o.editable:
            raise ValueError(f"button {r.button} is fixed in RSS ({o.function})")
        lab, d = _parse(r.button, r.function)
        if lab in NOT_OFFERED or lab not in ALLOWED.get(_class(r.button), ()):
            raise ValueError(f"button {r.button}: RSS does not offer {lab!r} there "
                             f"(offered: {ALLOWED.get(_class(r.button))})")
        if FUNCTIONS[lab][4] and not 1 <= d <= 99:
            raise ValueError(f"button {r.button}: {lab} needs a number (e.g. "
                             f"{lab.replace('X', '2')!r})")
        want[r.button] = (lab, d)
    if not want:
        return
    # RSS refuses the same function on two buttons ("Duplicate Buttons!"). Its
    # check is by label (Send-A next to Sel is accepted), so compare labels,
    # for the buttons being changed.
    final = {btn: _label_of(*want[btn]) if btn in want else o.function
             for btn, o in orig.items()}
    for btn in want:
        lab = final[btn]
        if lab == "Blank" or btn not in DUP_SCOPE:
            continue
        for other, olab in final.items():
            if other != btn and other in DUP_SCOPE and olab.lower() == lab.lower():
                raise ValueError(f"buttons {btn} and {other} both have {lab}: RSS "
                                 "refuses duplicate buttons (blank one of them)")
    before = bytes(body)
    side = _read_side(body, s)
    for btn, (lab, d) in want.items():
        idx, home, led = KEYS[btn]
        r1, r2, ents = _build(lab, home, led or 0, d)
        a = m + REC_LEN * idx
        body[a:a + REC_LEN] = r1
        body[a + COPY2:a + COPY2 + REC_LEN] = r2
        if led is not None:
            side = _place(side, ents, led, idx)
        bit = m - BITMAP_LEN + idx // 8, 0x80 >> (idx % 8)
        if r1[1] == 0x90:
            body[bit[0]] |= bit[1]
        else:
            body[bit[0]] &= ~bit[1] & 0xFF
    raw = b"".join(side)
    if len(raw) + SIDE_LEN > SIDE_CAP:
        raise ValueError("A9 indicator list full")
    body[s:s + SIDE_CAP] = raw + b"\0" * (SIDE_CAP - len(raw))
    _carry_checksum(cp, before, body, m, s)


_LED_REC = {led: idx for _b, (idx, _h, led) in KEYS.items() if led is not None}


def _place(side, ents, led, idx):
    """Replace one Ind key's indicator entries, keeping the list in RSS order:
    fixed radio entries first, then Ind keys by key-record index."""
    keep = [e for e in side if e[3] & 0x3F != led]

    def after(e):        # True if e sorts before the new key's entries
        own = _LED_REC.get(e[3] & 0x3F)
        return own is None or own < idx
    pos = 0
    for i, e in enumerate(keep):
        if after(e):
            pos = i + 1
    return keep[:pos] + list(ents) + keep[pos:]


def _carry_checksum(cp, before, body, m, s):
    from .lists import a9_head_checksum_off
    ck = a9_head_checksum_off(cp)
    spans = ((m - BITMAP_LEN, m + N_RECS * REC_LEN), (m + COPY2, m + COPY2 + N_RECS * REC_LEN),
             (s, s + SIDE_CAP))
    delta = sum((body[i] - before[i]) << (8 if i & 1 else 0)
                for lo, hi in spans for i in range(lo, hi) if body[i] != before[i])
    v = (int.from_bytes(body[ck:ck + 2], "big") + delta) & 0xFFFF
    body[ck:ck + 2] = v.to_bytes(2, "big")


def button_offsets(cp: Codeplug) -> set:
    lay = _layout(cp) if cp.ascii_names is not None else None
    if lay is None:
        return set()
    m, s = lay
    return set(range(m - BITMAP_LEN, m + N_RECS * REC_LEN)) | \
        set(range(m + COPY2, m + COPY2 + N_RECS * REC_LEN)) | set(range(s, s + SIDE_CAP))
