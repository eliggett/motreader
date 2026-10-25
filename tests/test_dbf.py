"""Round-trip tests for the dBASE III index reader/writer."""

import os
from datetime import date

import pytest

from motreader.dbf import DbfTable, Field, read_dbf, write_dbf

SPECTRA = os.path.expanduser("~/Documents/Ham Radio/Motorola/SPECTRA")
REAL_DBFS = [
    f"{SPECTRA}/ARCHIVE/spectram.dbf",
    f"{SPECTRA}/ARCHIVE-20250412/spectram.dbf",
    f"{SPECTRA}/AR-ORIG/SPECTRAM.DBF",
    f"{SPECTRA}/AR-ORIG/SPE.DBF",
    f"{SPECTRA}/ARCHIVE-bk/SPECTRAM.DBF",
]


@pytest.mark.parametrize("path", REAL_DBFS)
def test_real_dbf_byte_exact(tmp_path, path):
    if not os.path.exists(path):
        pytest.skip(f"sample not present: {path}")
    table = read_dbf(path)
    out = str(tmp_path / "out.dbf")
    write_dbf(table, out)
    assert open(out, "rb").read() == open(path, "rb").read()


def test_fields_parsed():
    path = REAL_DBFS[0]
    if not os.path.exists(path):
        pytest.skip("sample not present")
    t = read_dbf(path)
    names = [f.name for f in t.fields]
    assert names == ["SERIAL", "MODEL", "FILENAME", "DATEPGM", "CUSTOMER"]
    assert t.records
    r = t.records[0]
    assert len(r["SERIAL"]) <= 10
    assert isinstance(r["DATEPGM"], (date, type(None), str))


def test_synthetic_roundtrip(tmp_path):
    fields = [
        Field("SERIAL", "C", 10),
        Field("MODEL", "C", 16),
        Field("FILENAME", "C", 12),
        Field("DATEPGM", "D", 8),
        Field("CUSTOMER", "C", 15),
    ]
    t = DbfTable(
        fields=fields,
        records=[
            {"SERIAL": "123ABC4567", "MODEL": "D45KGA5JB7AK",
             "FILENAME": "A123ABC4.567", "DATEPGM": date(1997, 2, 2),
             "CUSTOMER": "test"},
        ],
        last_update=date(1987, 3, 10),
    )
    out = str(tmp_path / "s.dbf")
    write_dbf(t, out)
    t2 = read_dbf(out)
    assert t2.records[0]["SERIAL"] == "123ABC4567"
    assert t2.records[0]["DATEPGM"] == date(1997, 2, 2)
    assert t2.records[0]["CUSTOMER"] == "test"
