"""Parse captured RSS radio-wide screens (notes/ground-truth/rw_<serial>.json)
into {screen_path: {label: value}} so decoded fields can be checked against
what RSS displays. A field on screen looks like `Label.......value`, two per
row (left/right column)."""
import json
import re

# label = words separated by single spaces; value = up to the next 2+ spaces
_FIELD = re.compile(r"([A-Za-z#][A-Za-z0-9#/&()\-.]*(?: [A-Za-z0-9#/&()\-.]+)*?)"
                    r"\s*\.{2,} *(\S+(?: \S+)*)")


def parse_rows(rows):
    out = {}
    for r in rows[3:22]:            # skip title/help lines and the F-key bar
        for m in _FIELD.finditer(r):
            # first occurrence wins (e.g. CONV vs TRUNK 'Receive Hang Time')
            out.setdefault(m.group(1).rstrip(". "), m.group(2).strip())
    return out


def load(path):
    with open(path) as f:
        g = json.load(f)
    return {p: parse_rows(rows) for p, rows in g["screens"].items()}
