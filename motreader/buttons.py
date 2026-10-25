"""Control-head button map (RSS CHANGE/VIEW -> CONTROL HEAD -> F2 KEYPAD) for
the Standard / Enhanced / Rotary heads. Exported as buttons.csv.

Located white-box with the dosbox-x harness (tools/scenario_map_buttons.py:
step each button in RSS, SAVE, diff; tools/scenario_cycle_button.py: step one
button through every function to build the code table) and validated against
the RSS KEYPAD screens of every on-hand radio (notes/ground-truth/buttons_*.json,
tests/test_buttons.py).

Storage: a fixed header table of 20 x 4-byte entries at 0x123. Each entry is a
function code (two 16-bit halves, e.g. Scan = 02 00 02 01). Entry index:

    0-4   Ind 1 .. Ind 5    (Ind 5 is fixed "Sel": no RSS tab stop)
    5-7   unused on these heads (preserved)
    8     key 0
    9-17  keys 1 .. 9
    18,19 keys * and #      (fixed: Rcl / Del, code 02 02 00 00)

Radios without a full keypad (header 0x10D b1 set: 617ASN, 617ASQ) only have
Ind 1-5 and keys 7, 8, 9. The A9 / S9000e head (221AZN) uses a different,
record-based format: see buttons_a9.py (decode_buttons / encode_buttons /
button_offsets here dispatch to it).

Editing changes only the entry bytes (no checksum). RSS refuses to save a
function on two buttons ("Duplicate Buttons!"), so motreader refuses too.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

TABLE_OFF = 0x123
ENTRY_LEN = 4
NO_KEYPAD_FLAG = (0x10D, 1)        # set: only Ind 1-5 + keys 7/8/9

# button name -> entry index
ENTRIES = {"Ind 1": 0, "Ind 2": 1, "Ind 3": 2, "Ind 4": 3, "Ind 5": 4,
           "1": 9, "2": 10, "3": 11, "4": 12, "5": 13, "6": 14,
           "7": 15, "8": 16, "9": 17, "*": 18, "0": 8, "#": 19}
KEYPAD_ORDER = ("Ind 1", "Ind 2", "Ind 3", "Ind 4", "Ind 5",
                "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#")
SMALL_ORDER = ("Ind 1", "Ind 2", "Ind 3", "Ind 4", "Ind 5", "7", "8", "9")
FIXED = {"Ind 5", "*", "#"}         # no RSS tab stop
FIXED_LABEL = {"*": "Rcl", "#": "Del"}   # same code, label by position

# function code (hex) -> (RSS short label, RSS full name); collected from RSS
# screens and full function cycles (604AUN Ind 1: 28 functions incl. siren set;
# 566AYA keys 1 and 7) on 566AYA, 604AUN, 604ATY, 617ASN, 617ASQ. The functions
# RSS *offers* vary by button and enabled features (e.g. keypad keys on 566AYA
# offer only Blank/Phone/ZnDN/ZnUP/Page/MPL/Dir/Mon/Call/H/L; siren functions
# need Siren/PA): see notes/VALIDATION.md. motreader accepts any known code.
FUNCTIONS = {
    "00000000": ("Blank", "Blank Button, no function"),
    "00040004": ("Emer", "Emergency"),
    "01000000": ("ZnUP", "Zone Up"),
    "01800000": ("ZnDN", "Zone Down"),
    "01040000": ("Dir", "Conventional Direct"),
    "01050103": ("Mon", "Monitor"),
    "010d010e": ("H/L", "Horn and Lights"),
    "010f0000": ("RSSI", "Receive Signal Strength Ind."),
    "01100000": ("Sel", "Select"),
    "02000201": ("Scan", "Scan"),
    "02020000": ("Rcl/Del", "Keypad recall / delete (fixed * and # keys)"),
    "03000301": ("MPL", "Multiple Private Line"),
    "08000000": ("Siren", "Siren On/Off"),
    "08020000": ("PA", "Public Address"),
    "08050000": ("Airhn", "Siren Airhorn Selection"),
    "08060000": ("XRadB", "Standalone External Radio ON/OFF"),
    "080a0000": ("Wail", "Siren Wail Selection"),
    "080b0000": ("Yelp", "Siren Yelp Selection"),
    "080c0000": ("HiLo", "Siren HiLo Selection"),
    "080d0000": ("Man", "Manual Siren"),
    "080e0000": ("XRadA", "Siren External Radio Selection"),
    "0a000000": ("Sts", "Status,Keypad Data Entry Allowed"),
    "0b000000": ("Msg", "Message,Keypad Data Entry Allowed"),
    "0c080000": ("Bid", "Bid Button"),
    "10051005": ("Lck", "AMSS Lock"),
    "10061006": ("Ste", "AMSS Site"),
    "100e100e": ("Rpg", "Trunking Reprogram Request"),
    "11010000": ("Phone", "Trunk and/or Conv. Phone"),
    "11030000": ("Page", "MDC Page,Trunking Call Alert"),
    "11060000": ("Call", "Conv. MDC Call,Trnk Private Call"),
    "12011200": ("VRS", "Vehicle Repeater System"),
    "14001401": ("ST", ""),
}
CODE_BY_LABEL = {lab.lower(): code for code, (lab, _) in FUNCTIONS.items()
                 if lab != "Rcl/Del"}            # the fixed * / # code isn't assignable
BLANK = "00000000"


@dataclass
class Button:
    button: str
    function: str          # RSS short label, or "0x<8 hex>" for an unknown code
    name: str = ""         # RSS full name (informational)
    code: str = ""         # raw 4-byte code, hex
    editable: bool = True


def has_table(cp) -> bool:
    """Standard/Enhanced/Rotary heads only (not the A9/S9000e head)."""
    return cp.ascii_names is None


def layout(body) -> tuple:
    a, bit = NO_KEYPAD_FLAG
    return SMALL_ORDER if body[a] >> bit & 1 else KEYPAD_ORDER


def _code_at(body, button) -> str:
    e = TABLE_OFF + ENTRY_LEN * ENTRIES[button]
    return bytes(body[e:e + ENTRY_LEN]).hex()


def decode_buttons(cp) -> list:
    if not has_table(cp):
        from . import buttons_a9
        return buttons_a9.decode_buttons(cp)
    out = []
    for btn in layout(cp.body):
        code = _code_at(cp.body, btn)
        lab, name = FUNCTIONS.get(code, ("0x" + code, ""))
        if btn in FIXED_LABEL:
            lab = FIXED_LABEL[btn]
        out.append(Button(btn, lab, name, code, btn not in FIXED))
    return out


def _parse_function(btn: str, func: str) -> str:
    f = func.strip()
    if f.lower().startswith("0x") and len(f) == 10:
        int(f[2:], 16)
        return f[2:].lower()
    code = CODE_BY_LABEL.get(f.lower())
    if code is None:
        raise ValueError(f"button {btn}: unknown function {func!r} "
                         f"(known: {sorted(lab for lab, _ in FUNCTIONS.values())})")
    return code


def encode_buttons(cp, body: bytearray, rows) -> None:
    """Apply buttons.csv rows (change-gated on the function per button)."""
    if not has_table(cp):
        from . import buttons_a9
        return buttons_a9.encode_buttons(cp, body, rows)
    orig = {b.button: b for b in decode_buttons(cp)}
    want = {}
    for r in rows:
        o = orig.get(r.button)
        if o is None:
            raise ValueError(f"button {r.button!r} does not exist on this radio "
                             f"(buttons: {list(orig)})")
        if r.function.strip().lower() == o.function.lower():
            want[r.button] = o.code
            continue
        if not o.editable:
            raise ValueError(f"button {r.button} is fixed in RSS ({o.function})")
        want[r.button] = _parse_function(r.button, r.function)
    final = {b: want.get(b, o.code) for b, o in orig.items()}
    seen = {}
    for b, code in final.items():
        if code == BLANK or b in FIXED:
            continue
        if code in seen:
            lab = FUNCTIONS.get(code, ("0x" + code,))[0]
            raise ValueError(f"buttons {seen[code]} and {b} both have {lab}: RSS refuses "
                             "duplicate buttons (blank one of them)")
        seen[code] = b
    for b, code in want.items():
        if code != orig[b].code:
            e = TABLE_OFF + ENTRY_LEN * ENTRIES[b]
            body[e:e + ENTRY_LEN] = bytes.fromhex(code)


def button_offsets(cp) -> set:
    if not has_table(cp):
        from . import buttons_a9
        return buttons_a9.button_offsets(cp)
    return set(range(TABLE_OFF, TABLE_OFF + 20 * ENTRY_LEN))
