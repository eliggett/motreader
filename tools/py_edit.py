"""Apply edit scripts with the Python write path, so the JavaScript one
(web/lib/export.js buildBody) can be checked against it
(tests/js/edit-parity.test.js).

    PYTHONPATH=. python3 tools/py_edit.py < cases.json

cases.json is a list of {"id", "file", "modes": [{"number", field: value...}],
"zones": [{"number", "name"?, "modes"?}], "radio_wide": {key: value}}; each
mode/zone field is set as is on the parsed Codeplug, then rebuild(),
radiowide.encode() and the A9 head checksum run, as cli.do_import does.
Prints {id: {"sha256", "changed": [offsets]} or {"error"}}.
"""

from __future__ import annotations

import hashlib
import json
import sys

from motreader import lists, radiowide
from motreader.archive import BANNER_PREFIX, Archive
from motreader.codeplug import Codeplug
from motreader.crypto import decrypt_body

_bodies: dict = {}


def body_of(path: str) -> bytes:
    if path not in _bodies:
        with open(path, "rb") as fh:
            data = fh.read()
        _bodies[path] = decrypt_body(Archive.load(path).body) if data.startswith(BANNER_PREFIX) else data
    return _bodies[path]


def apply(case: dict) -> bytes:
    body = body_of(case["file"])
    cp = Codeplug.parse(body)
    for e in case.get("modes", []):
        m = cp.modes[e["number"] - 1]
        for k, v in e.items():
            if k != "number":
                setattr(m, k, v)
    for e in case.get("zones", []):
        z = cp.zones[e["number"] - 1]
        for k, v in e.items():
            if k != "number":
                setattr(z, k, v)
    out = cp.rebuild()
    if case.get("radio_wide"):
        out = radiowide.encode(bytes(out), case["radio_wide"])
    out = bytearray(out)
    lists.fix_a9_head_checksum(cp, out)
    return bytes(out)


def main() -> None:
    res = {}
    for case in json.load(sys.stdin):
        try:
            out = apply(case)
            body = body_of(case["file"])
            res[case["id"]] = {"sha256": hashlib.sha256(out).hexdigest(),
                               "changed": [i for i in range(len(out)) if out[i] != body[i]]}
        except Exception as e:  # noqa: BLE001 - report per case
            res[case["id"]] = {"error": f"{type(e).__name__}: {e}"}
    json.dump(res, sys.stdout)


if __name__ == "__main__":
    main()
