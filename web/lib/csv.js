// @ts-check
/**
 * CSV the way Python's csv module writes it (so files interchange with the
 * motreader CLI): CRLF line ends, fields quoted only when they hold a comma,
 * a quote or a line break, quotes doubled. The reader also takes LF line
 * ends, a UTF-8 byte-order mark (spreadsheets add one) and quoted fields
 * spanning lines.
 */

/** One CSV field. */
function field(/** @type {string} */ s) {
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of text fields -> CSV text. */
export function toCsv(/** @type {string[][]} */ rows) {
    return rows.map((r) => r.map(field).join(",") + "\r\n").join("");
}

/** CSV text -> rows of text fields (blank lines skipped). */
export function parseCsv(/** @type {string} */ text) {
    const s = text.replace(/^﻿/, "");
    /** @type {string[][]} */
    const rows = [];
    /** @type {string[]} */
    let row = [];
    let cur = "";
    let quoted = false;
    let i = 0;
    const endRow = () => {
        row.push(cur);
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
        cur = "";
    };
    while (i < s.length) {
        const c = s[i];
        if (quoted) {
            if (c === '"') {
                if (s[i + 1] === '"') {
                    cur += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
            } else {
                cur += c;
            }
            i++;
            continue;
        }
        if (c === '"') quoted = true;
        else if (c === ",") {
            row.push(cur);
            cur = "";
        } else if (c === "\r" || c === "\n") {
            endRow();
            if (c === "\r" && s[i + 1] === "\n") i++;
        } else {
            cur += c;
        }
        i++;
    }
    if (quoted) throw new SyntaxError("CSV ends inside a quoted field");
    if (cur !== "" || row.length) endRow();
    return rows;
}

/** CSV text -> objects keyed by the header row (like csv.DictReader); short rows get "". */
export function parseCsvObjects(/** @type {string} */ text) {
    const [header, ...rows] = parseCsv(text);
    if (!header) return { header: [], rows: [] };
    const objs = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
    return { header, rows: /** @type {Record<string, string>[]} */ (objs) };
}

/**
 * A value as Python's str() writes it in a CSV cell: null -> "", a float
 * column's whole number -> "146.0" (Python floats always show a decimal
 * point), other numbers by shortest round-trip form (as repr()).
 */
export function pyCell(/** @type {unknown} */ v, float = false) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number" && float && Number.isInteger(v)) return v.toFixed(1);
    return String(v);
}
