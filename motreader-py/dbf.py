"""Minimal dBASE III reader/writer for Motorola Spectra RSS index files.

The RSS keeps an archive index in ``SPECTRAM.DBF`` (and a scratch ``SPE.DBF``).
These are plain dBASE III table files:

    SERIAL    C(10)   radio serial number
    MODEL     C(16)   model / tanapa number
    FILENAME  C(12)   archive file name (e.g. "A566AYA0.014")
    DATEPGM   D(8)    date programmed, stored as ASCII YYYYMMDD
    CUSTOMER  C(15)   optional customer name / id

The format is simple and fully documented, so this module is intentionally a
small, exact round-tripper rather than a general dBASE library: parse to a list
of records, edit, and write back byte-for-byte compatible files.
"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from datetime import date
from typing import Any

__all__ = ["Field", "DbfTable", "read_dbf", "write_dbf"]


@dataclass
class Field:
    """A dBASE field descriptor."""

    name: str
    type: str  # 'C', 'D', 'N', 'L', 'M' ...
    length: int
    decimals: int = 0

    def to_bytes(self) -> bytes:
        name = self.name.upper().encode("ascii")[:11]
        name = name + b"\x00" * (11 - len(name))
        out = bytearray(32)
        out[0:11] = name
        out[11] = ord(self.type)
        # bytes 12-15: field data address (runtime only) -> left zero
        out[16] = self.length & 0xFF
        out[17] = self.decimals & 0xFF
        return bytes(out)

    @classmethod
    def from_bytes(cls, b: bytes) -> "Field":
        name = b[0:11].split(b"\x00", 1)[0].decode("ascii", "replace")
        return cls(name=name, type=chr(b[11]), length=b[16], decimals=b[17])


@dataclass
class DbfTable:
    """A parsed dBASE III table.

    ``records`` is a list of dicts keyed by field name. Values are python str
    for C fields, ``datetime.date`` (or ``None``) for D fields. Deleted records
    carry ``__deleted__`` = True and are preserved so writes round-trip.
    """

    fields: list[Field]
    records: list[dict[str, Any]] = dc_field(default_factory=list)
    version: int = 0x03
    last_update: date | None = None
    # Preserved from the source file so writes round-trip byte-exactly. The RSS
    # pads the header with a 0x00 after the 0x0D field terminator (header_size
    # one larger than the dBASE minimum) and writes no trailing 0x1A EOF marker.
    header_size_raw: int | None = None
    has_eof: bool = False

    @property
    def record_size(self) -> int:
        return 1 + sum(f.length for f in self.fields)

    @property
    def header_size(self) -> int:
        return self.header_size_raw or (32 + 32 * len(self.fields) + 1)

    def field(self, name: str) -> Field:
        for f in self.fields:
            if f.name == name:
                return f
        raise KeyError(name)


def _decode_value(field: Field, raw: bytes) -> Any:
    if field.type == "D":
        s = raw.decode("ascii", "replace").strip()
        if len(s) == 8 and s.isdigit():
            try:
                return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))
            except ValueError:
                return s
        return None if not s else s
    # Character and everything else: strip trailing spaces/nulls.
    return raw.decode("latin-1").rstrip(" \x00")


def _encode_value(field: Field, value: Any) -> bytes:
    n = field.length
    if field.type == "D":
        if isinstance(value, date):
            s = f"{value.year:04d}{value.month:02d}{value.day:02d}"
        elif value:
            s = str(value)
        else:
            s = " " * n
        return s.encode("ascii")[:n].ljust(n, b" ")
    s = "" if value is None else str(value)
    return s.encode("latin-1")[:n].ljust(n, b" ")


def read_dbf(path: str) -> DbfTable:
    with open(path, "rb") as fh:
        data = fh.read()
    version = data[0]
    yy, mm, dd = data[1], data[2], data[3]
    last_update = None
    if mm and dd:
        year = yy + (1900 if yy >= 70 else 2000)
        try:
            last_update = date(year, mm, dd)
        except ValueError:
            last_update = None
    n_records = int.from_bytes(data[4:8], "little")
    header_size = int.from_bytes(data[8:10], "little")
    record_size = int.from_bytes(data[10:12], "little")

    # Parse field descriptors (32 bytes each) until the 0x0D terminator.
    fields: list[Field] = []
    off = 32
    while off < header_size and data[off] != 0x0D:
        fields.append(Field.from_bytes(data[off : off + 32]))
        off += 32

    records: list[dict[str, Any]] = []
    for i in range(n_records):
        start = header_size + i * record_size
        rec = data[start : start + record_size]
        if len(rec) < record_size:
            break
        row: dict[str, Any] = {"__deleted__": rec[0:1] == b"*"}
        pos = 1
        for f in fields:
            row[f.name] = _decode_value(f, rec[pos : pos + f.length])
            pos += f.length
        records.append(row)

    has_eof = len(data) >= header_size + n_records * record_size + 1 and (
        data[header_size + n_records * record_size : header_size + n_records * record_size + 1]
        == b"\x1a"
    )
    return DbfTable(
        fields=fields,
        records=records,
        version=version,
        last_update=last_update,
        header_size_raw=header_size,
        has_eof=has_eof,
    )


def write_dbf(table: DbfTable, path: str) -> None:
    hdr = bytearray(32)
    hdr[0] = table.version
    upd = table.last_update or date.today()
    hdr[1] = upd.year % 100
    hdr[2] = upd.month
    hdr[3] = upd.day
    live = [r for r in table.records]
    hdr[4:8] = len(live).to_bytes(4, "little")
    hdr[8:10] = table.header_size.to_bytes(2, "little")
    hdr[10:12] = table.record_size.to_bytes(2, "little")

    out = bytearray(hdr)
    for f in table.fields:
        out += f.to_bytes()
    out += b"\x0d"
    # Pad with 0x00 up to the recorded header size (the RSS adds one byte).
    if len(out) < table.header_size:
        out += b"\x00" * (table.header_size - len(out))

    for row in live:
        out += b"*" if row.get("__deleted__") else b" "
        for f in table.fields:
            out += _encode_value(f, row.get(f.name))
    if table.has_eof:
        out += b"\x1a"  # dBASE EOF marker (RSS files omit it)

    with open(path, "wb") as fh:
        fh.write(out)
