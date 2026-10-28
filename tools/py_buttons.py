"""Decode / edit control-head buttons with the Python code, so the JavaScript
port (web/lib/buttons.js) can be checked against it
(tests/js/buttons-parity.test.js).

    PYTHONPATH=. python3 tools/py_buttons.py < cases.json

cases.json: {"decode": [FILE...], "edit": [{"id", "file", "rows": [{button,
function}], "hack"}]}. FILE: an archive or a decrypted body. Prints
{"decode": {FILE: [Button...] or {"error"}}, "edit": {id: {"sha256"} or
{"error"}}}.
"""

from __future__ import annotations

import hashlib
import json
import sys
from dataclasses import asdict

from motreader import buttons
from motreader.archive import BANNER_PREFIX, Archive
from motreader.codeplug import Codeplug
from motreader.crypto import decrypt_body

_cps: dict = {}


def cp_of(path: str) -> Codeplug:
    if path not in _cps:
        with open(path, "rb") as fh:
            data = fh.read()
        body = decrypt_body(Archive.load(path).body) if data.startswith(BANNER_PREFIX) else data
        _cps[path] = Codeplug.parse(body)
    return _cps[path]


def main() -> None:
    cases = json.load(sys.stdin)
    out: dict = {"decode": {}, "edit": {}}
    for f in cases.get("decode", []):
        try:
            out["decode"][f] = [asdict(b) for b in buttons.decode_buttons(cp_of(f))]
        except Exception as e:  # noqa: BLE001 - report per file
            out["decode"][f] = {"error": f"{type(e).__name__}: {e}"}
    for c in cases.get("edit", []):
        try:
            cp = cp_of(c["file"])
            body = bytearray(cp.body)
            rows = [buttons.Button(r["button"], r["function"]) for r in c["rows"]]
            buttons.encode_buttons(cp, body, rows, c.get("hack", False))
            out["edit"][c["id"]] = {"sha256": hashlib.sha256(body).hexdigest()}
        except ValueError as e:
            out["edit"][c["id"]] = {"error": str(e)}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
