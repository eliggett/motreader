// @ts-check
/**
 * The JavaScript side of the Python parity check: the same JSON shape as
 * tools/py_reference.py, built from web/lib.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hex } from "../../web/lib/bytes.js";
import { isArchive, splitArchive } from "../../web/lib/archive.js";
import { decryptBody } from "../../web/lib/crypto.js";
import { readDbf } from "../../web/lib/dbf.js";
import { parseCodeplug, modePointerTable, zoneOperation, zoneSections } from "../../web/lib/codeplug.js";
import { decode as decodeRadioWide, findExtBlock, findChbBlock } from "../../web/lib/radiowide.js";
import { trunkingInfo } from "../../web/lib/trunking.js";
import { decodePhones, decodeMpls } from "../../web/lib/lists.js";
import { ROOT, GROUND_TRUTH, SPECTRA } from "./util.js";

/** Every codeplug sample on hand: ground-truth bodies, then archives and DBFs. */
export function sampleFiles() {
    const files = [];
    const walk = (/** @type {string} */ d) => {
        for (const f of readdirSync(d).sort()) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) walk(p);
            else if (f.endsWith(".bin")) files.push(p);
        }
    };
    walk(GROUND_TRUTH);
    for (const d of ["ARCHIVE", "ARCHIVE-20250412", "ARCHIVE-bk", "AR-ORIG"]) {
        const dir = join(SPECTRA, d);
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).sort()) {
            const p = join(dir, f);
            if (!statSync(p).isFile() || f.toUpperCase() === "A428TWN2.810") continue;   // never readable, even in RSS
            if (f.toLowerCase().endsWith(".dbf") || isArchive(readFileSync(p).subarray(0, 64))) files.push(p);
        }
    }
    return files;
}

/** Run the Python reference over `files`; null if Python or motreader isn't usable. */
export function pythonReference(/** @type {string[]} */ files) {
    const r = spawnSync("python3", [join(ROOT, "tools", "py_reference.py"), ...files], {
        cwd: ROOT, env: { ...process.env, PYTHONPATH: ROOT }, encoding: "utf8", maxBuffer: 1 << 30,
    });
    if (r.status !== 0) return null;
    return /** @type {Record<string, any>} */ (JSON.parse(r.stdout));
}

/** A value as plain JSON data (byte arrays as hex), like the Python side's `_plain`. */
function plain(/** @type {any} */ v) {
    return JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? hex(x) : x)));
}

function codeplug(/** @type {Uint8Array} */ body) {
    const cp = parseCodeplug(body);
    let trunk;
    try {
        const t = trunkingInfo(body);
        trunk = t && { r0: t.r0, pers: t.pers, tg: t.tg, data_end: t.data_end, systems: t.systems, subfleets: t.subfleets };
    } catch (e) {
        trunk = { error: e instanceof Error ? e.message : String(e) };
    }
    const safe = (/** @type {(cp: any) => unknown} */ fn) => {
        try {
            return plain(fn(cp));
        } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
        }
    };
    return {
        phones: safe(decodePhones),
        mpls: safe(decodeMpls),
        body_len: body.length,
        signature: cp.signature,
        serial: cp.serial,
        model: cp.model,
        band: cp.band,
        format_version: cp.format_version,
        ascii_names: cp.ascii_names,
        modes: plain(cp.modes),
        zones: plain(cp.zones),
        zone_operation: zoneOperation(body),
        zone_sections: zoneSections(body),
        mode_pointer_table: modePointerTable(body),
        ext_block: findExtBlock(body),
        chb_block: findChbBlock(body),
        radio_wide: decodeRadioWide(body, cp.band),
        trunking: trunk,
    };
}

/** The JS reference for one file (same shape as tools/py_reference.py). */
export function jsReference(/** @type {string} */ path) {
    const data = new Uint8Array(readFileSync(path));
    if (isArchive(data)) {
        const a = splitArchive(data);
        const body = decryptBody(a.body);
        return {
            kind: "archive", banner_len: a.banner.length,
            body_sha256: createHash("sha256").update(body).digest("hex"),
            ...codeplug(body),
        };
    }
    if (path.toLowerCase().endsWith(".dbf")) {
        const t = readDbf(data);
        return { kind: "dbf", fields: t.fields, records: t.records, last_update: t.lastUpdate };
    }
    return { kind: "body", ...codeplug(data) };
}
