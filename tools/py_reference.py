"""Dump what the Python decoder makes of codeplug files, as JSON, so the
JavaScript port (web/lib) can be checked against it (tests/js/parity.test.js).

    PYTHONPATH=. python3 tools/py_reference.py FILE...

FILE is an archive (A*/B*, detected by its banner), a decrypted body
(*.plain.bin) or a SPECTRAM.DBF. Prints one JSON object keyed by the path.
A file Python can't read gets {"error": "..."}.
"""

from __future__ import annotations

import dataclasses
import datetime
import hashlib
import json
import sys

from motreader import convscan, lists, radiowide, scanlist, trunking
from motreader.archive import BANNER_PREFIX, Archive
from motreader.codeplug import Codeplug, mode_pointer_table, zone_operation, zone_sections
from motreader.crypto import decrypt_body
from motreader.dbf import read_dbf


def _plain(v):
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    if isinstance(v, tuple):
        return [_plain(x) for x in v]
    if isinstance(v, list):
        return [_plain(x) for x in v]
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if dataclasses.is_dataclass(v):
        return {f.name: _plain(getattr(v, f.name)) for f in dataclasses.fields(v)}
    return v


def codeplug(body: bytes) -> dict:
    cp = Codeplug.parse(body)
    pt = mode_pointer_table(body)
    try:
        trunk = trunking.trunking_info(body)
        trunk = None if trunk is None else {k: trunk[k] for k in ("r0", "pers", "tg", "data_end", "systems", "subfleets")}
    except ValueError as e:
        trunk = {"error": str(e)}
    def safe(fn):
        try:
            return _plain(fn(cp))
        except ValueError as e:
            return {"error": str(e)}
    return {
        "phones": safe(lists.decode_phones),
        "mpls": safe(lists.decode_mpls),
        "body_len": len(body),
        "signature": cp.signature,
        "serial": cp.serial,
        "model": cp.model,
        "band": cp.band,
        "format_version": cp.format_version,
        "ascii_names": _plain(cp.ascii_names),
        "modes": _plain(cp.modes),
        "zones": _plain(cp.zones),
        "zone_operation": zone_operation(body),
        "zone_sections": zone_sections(body),
        "mode_pointer_table": _plain(pt),
        "ext_block": radiowide.find_ext_block(body),
        "chb_block": radiowide.find_chb_block(body),
        "radio_wide": radiowide.decode(body, cp.band),
        "trunking": trunk,
        "zone_scan": _plain(scanlist.decode(body)),
        "conv_scan": _plain(list(convscan.decode(body))),
    }


def one(path: str) -> dict:
    with open(path, "rb") as fh:
        data = fh.read()
    if data.startswith(BANNER_PREFIX):
        arc = Archive.load(path)
        body = decrypt_body(arc.body)
        out = {"kind": "archive", "banner_len": len(arc.banner),
               "body_sha256": hashlib.sha256(body).hexdigest()}
        out.update(codeplug(body))
        return out
    if path.lower().endswith(".dbf"):
        t = read_dbf(path)
        return {"kind": "dbf", "fields": _plain(t.fields), "records": _plain(t.records),
                "last_update": _plain(t.last_update)}
    out = {"kind": "body"}
    out.update(codeplug(data))
    return out


def main(paths: list[str]) -> None:
    res = {}
    for p in paths:
        try:
            res[p] = one(p)
        except Exception as e:  # noqa: BLE001 - report, don't stop the batch
            res[p] = {"error": f"{type(e).__name__}: {e}"}
    json.dump(res, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1:])
