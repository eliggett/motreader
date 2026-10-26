"""The motreader CLI's CSV/YAML, for checking the web app against it
(tests/js/tables-parity.test.js).

    PYTHONPATH=. python3 tools/py_tables.py export FILE...
        FILE: an archive or a decrypted body (*.plain.bin). Prints
        {FILE: {name: text, ...}} with the files cli.export writes.
    PYTHONPATH=. python3 tools/py_tables.py import TEMPLATE DIR OUT
        cli.do_import (output on stderr).
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile

from motreader import cli
from motreader.archive import BANNER_PREFIX, Archive
from motreader.crypto import encrypt_body


def export_one(path: str) -> dict:
    with open(path, "rb") as fh:
        data = fh.read()
    with tempfile.TemporaryDirectory() as tmp:
        arc = path
        if not data.startswith(BANNER_PREFIX):
            arc = os.path.join(tmp, "A.ARC")
            Archive(body=encrypt_body(data)).save(arc)
        out = os.path.join(tmp, "out")
        with contextlib.redirect_stdout(sys.stderr):
            cli.export(arc, out)
        files = {}
        for name in sorted(os.listdir(out)):
            with open(os.path.join(out, name), newline="") as fh:
                files[name] = fh.read()
    return files


def main() -> None:
    if sys.argv[1] == "export":
        res = {}
        for p in sys.argv[2:]:
            try:
                res[p] = export_one(p)
            except Exception as e:  # noqa: BLE001 - report per file
                res[p] = {"error": f"{type(e).__name__}: {e}"}
        json.dump(res, sys.stdout)
    elif sys.argv[1] == "import":
        with contextlib.redirect_stdout(sys.stderr):
            cli.do_import(*sys.argv[2:5])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
