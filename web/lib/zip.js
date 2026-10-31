// @ts-check
/**
 * A minimal .zip writer: entries stored (no compression), CRC-32, no zip64
 * (each file and the whole archive under 4 GB). Enough to hand several
 * files over as one download; every unzip tool reads it.
 */

/** @type {Uint32Array | null} */
let table = null;

/** CRC-32 (IEEE 802.3, as zip uses). */
export function crc32(/** @type {Uint8Array} */ data) {
    if (!table) {
        table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (const b of data) crc = /** @type {number} */ (table[(crc ^ b) & 0xFF]) ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** UTF-8 bytes of a string (web/lib uses no browser APIs, so no TextEncoder). */
export function utf8(/** @type {string} */ s) {
    /** @type {number[]} */
    const out = [];
    for (const ch of s) {
        const c = /** @type {number} */ (ch.codePointAt(0));
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
        else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return Uint8Array.from(out);
}

/** MS-DOS date and time words (local time, 2-second resolution). */
function dosTime(/** @type {Date} */ d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return [time, date];
}

/**
 * The zip file holding `files` (names may contain "/" for folders).
 * @param {{ name: string, bytes: Uint8Array | string }[]} files  strings are stored as UTF-8
 * @param {Date} [when]  the entries' modification time
 */
export function zip(files, when = new Date()) {
    const [time, date] = dosTime(when);
    /** @type {Uint8Array[]} */
    const parts = [];
    /** @type {Uint8Array[]} */
    const central = [];
    let offset = 0;
    for (const f of files) {
        const name = utf8(f.name);
        const data = typeof f.bytes === "string" ? utf8(f.bytes) : f.bytes;
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034B50, true);   // local file header
        local.setUint16(4, 20, true);           // version needed: 2.0
        local.setUint16(6, 0x0800, true);       // flags: UTF-8 names
        local.setUint16(8, 0, true);            // stored
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        parts.push(new Uint8Array(local.buffer), name, data);
        const dir = new DataView(new ArrayBuffer(46));
        dir.setUint32(0, 0x02014B50, true);     // central directory header
        dir.setUint16(4, 20, true);             // version made by
        dir.setUint16(6, 20, true);
        dir.setUint16(8, 0x0800, true);
        dir.setUint16(10, 0, true);
        dir.setUint16(12, time, true);
        dir.setUint16(14, date, true);
        dir.setUint32(16, crc, true);
        dir.setUint32(20, data.length, true);
        dir.setUint32(24, data.length, true);
        dir.setUint16(28, name.length, true);
        dir.setUint32(42, offset, true);
        central.push(new Uint8Array(dir.buffer), name);
        offset += 30 + name.length + data.length;
    }
    const dirSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);         // end of central directory
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of all) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
