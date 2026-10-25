// @ts-check
/**
 * Reader for RSS's archive index, SPECTRAM.DBF (FORMAT §2): a plain dBASE III
 * table, one record per archive:
 *
 *     SERIAL C(10)  MODEL C(16)  FILENAME C(12)  DATEPGM D(8)  CUSTOMER C(15)
 *
 * Read-only for now; the Python `motreader/dbf.py` also writes it.
 */
import { latin1 } from "./bytes.js";

/** @typedef {{ name: string, type: string, length: number, decimals: number }} DbfField */
/**
 * A record: field name -> value. C fields are strings, D fields "YYYY-MM-DD"
 * (or the raw text if not a valid date, or null if blank).
 * @typedef {Record<string, string | null> & { __deleted__: boolean }} DbfRecord
 */

const le = (/** @type {Uint8Array} */ b, /** @type {number} */ o, /** @type {number} */ n) => {
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + /** @type {number} */ (b[o + i]);
    return v;
};

/** Is y-m-d a real calendar date? */
function validDate(/** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ d) {
    if (y < 1 || m < 1 || m > 12 || d < 1) return false;
    const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= /** @type {number} */ (days[m - 1]);
}

const iso = (/** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ d) =>
    `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** @param {DbfField} f @param {Uint8Array} raw */
function decodeValue(f, raw) {
    if (f.type === "D") {
        const s = latin1(raw).trim();
        if (s.length === 8 && /^\d{8}$/.test(s)) {
            const [y, m, d] = [+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8)];
            return validDate(y, m, d) ? iso(y, m, d) : s;
        }
        return s || null;
    }
    return latin1(raw).replace(/[ \x00]+$/, "");
}

/** Parse a dBASE III file. */
export function readDbf(/** @type {Uint8Array} */ data) {
    if (data.length < 32) throw new Error("not a dBASE file (too short)");
    const [yy, mm, dd] = [/** @type {number} */ (data[1]), /** @type {number} */ (data[2]), /** @type {number} */ (data[3])];
    let lastUpdate = null;
    if (mm && dd) {
        const year = yy + (yy >= 70 ? 1900 : 2000);
        if (validDate(year, mm, dd)) lastUpdate = iso(year, mm, dd);
    }
    const nRecords = le(data, 4, 4);
    const headerSize = le(data, 8, 2);
    const recordSize = le(data, 10, 2);

    /** @type {DbfField[]} */
    const fields = [];
    for (let off = 32; off < headerSize && off + 32 <= data.length && data[off] !== 0x0D; off += 32) {
        const nameBytes = data.subarray(off, off + 11);
        const z = nameBytes.indexOf(0);
        fields.push({
            name: latin1(z < 0 ? nameBytes : nameBytes.subarray(0, z)),
            type: String.fromCharCode(/** @type {number} */ (data[off + 11])),
            length: /** @type {number} */ (data[off + 16]),
            decimals: /** @type {number} */ (data[off + 17]),
        });
    }

    /** @type {DbfRecord[]} */
    const records = [];
    for (let i = 0; i < nRecords; i++) {
        const start = headerSize + i * recordSize;
        const rec = data.subarray(start, start + recordSize);
        if (rec.length < recordSize) break;
        /** @type {DbfRecord} */
        const row = /** @type {any} */ ({ __deleted__: rec[0] === 0x2A });
        let pos = 1;
        for (const f of fields) {
            row[f.name] = decodeValue(f, rec.subarray(pos, pos + f.length));
            pos += f.length;
        }
        records.push(row);
    }
    return { fields, records, lastUpdate };
}

/**
 * The archive's live (not deleted) record: by FILENAME, ignoring case, else by
 * the radio's SERIAL (a B file, RSS's previous copy, isn't listed by name).
 */
export function findArchiveRecord(/** @type {DbfRecord[]} */ records, /** @type {string} */ fileName, serial = "") {
    const live = records.filter((r) => !r.__deleted__);
    const want = fileName.toUpperCase();
    return live.find((r) => (r.FILENAME ?? "").toUpperCase() === want)
        ?? (serial ? live.find((r) => r.SERIAL === serial) : undefined)
        ?? null;
}
