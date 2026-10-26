"""Apply structural operations with the Python code, so the JavaScript ports
(web/lib/modeops.js, zonelist.js, zoneop.js, trunking.js, convscan.js,
scanlist.js) can be checked against it (tests/js/struct-parity.test.js).

    PYTHONPATH=. python3 tools/py_struct.py < cases.json

cases.json is a list of {"id", "file", "ops": [{"op", ...args}]}; the ops run
in order on the decrypted body:
  add_mode {after, copy_from?, name?, zones?}   delete_mode {number}
  add_zone {position, modes, name?}             delete_zone {number}
  zones_on / zones_off                          remove_trunking
  set_list_types {non_priority_list, priority_list}
  set_scan_type {scan_type}
  conv_encode {conv?: {...ConvScan}, rows: [{mode, ...}]}
  scan_encode {scans: [{zone, ...}]}
Prints {id: {"sha256", "length"} or {"error"}} (a refusal's message).
"""

from __future__ import annotations

import hashlib
import json
import sys

from motreader import convscan, modeops, scanlist, trunking, zonelist, zoneop
from motreader.archive import BANNER_PREFIX, Archive
from motreader.crypto import decrypt_body

_bodies: dict = {}


def body_of(path: str) -> bytes:
    if path not in _bodies:
        with open(path, "rb") as fh:
            data = fh.read()
        _bodies[path] = decrypt_body(Archive.load(path).body) if data.startswith(BANNER_PREFIX) else data
    return _bodies[path]


def run(body: bytes, op: dict) -> bytes:
    k = op["op"]
    if k == "add_mode":
        return modeops.add_mode(body, op["after"], copy_from=op.get("copy_from"), name=op.get("name"),
                                zones=op.get("zones", ()))
    if k == "delete_mode":
        return modeops.delete_mode(body, op["number"])
    if k == "add_zone":
        return zonelist.add_zone(body, op["position"], op["modes"], op.get("name"))
    if k == "delete_zone":
        return zonelist.delete_zone(body, op["number"])
    if k == "zones_on":
        return zoneop.zones_on(body)
    if k == "zones_off":
        return zoneop.zones_off(body)
    if k == "remove_trunking":
        return trunking.remove_trunking(body)
    if k == "set_list_types":
        return convscan.set_list_types(body, op["non_priority_list"], op["priority_list"])
    if k == "set_scan_type":
        return convscan.set_scan_type(body, op["scan_type"])
    if k == "conv_encode":
        conv = convscan.ConvScan(**op["conv"]) if op.get("conv") else None
        return convscan.encode(body, conv, [convscan.ModeScan(**r) for r in op.get("rows", [])])
    if k == "scan_encode":
        return scanlist.encode(body, [scanlist.ZoneScan(**z) for z in op["scans"]])
    raise SystemExit(f"unknown op {k}")


def main() -> None:
    out = {}
    for case in json.load(sys.stdin):
        body = body_of(case["file"])
        try:
            for op in case["ops"]:
                body = run(body, op)
            out[case["id"]] = {"sha256": hashlib.sha256(body).hexdigest(), "length": len(body)}
        except ValueError as e:
            out[case["id"]] = {"error": str(e)}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
