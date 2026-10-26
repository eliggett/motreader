// @ts-check
/**
 * The structural operations (adding / deleting modes and zones, Zone
 * Operation, trunk removal, zones-off scan list types and scan lists, zone
 * scan lists) must give the same bytes as the Python ones -- or refuse with
 * the same message -- on every sample. The cases are generated here from
 * each sample's decoded contents, applied by tools/py_struct.py and by
 * web/lib, and compared. (The Python ops are checked against RSS's own saves
 * in tests/test_*.py.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { isArchive, splitArchive } from "../../web/lib/archive.js";
import { decryptBody } from "../../web/lib/crypto.js";
import { parseCodeplug, zoneOperation } from "../../web/lib/codeplug.js";
import { addMode, deleteMode } from "../../web/lib/modeops.js";
import { addZone, deleteZone } from "../../web/lib/zonelist.js";
import { zonesOn, zonesOff } from "../../web/lib/zoneop.js";
import { removeTrunking } from "../../web/lib/trunking.js";
import * as convscan from "../../web/lib/convscan.js";
import * as scanlist from "../../web/lib/scanlist.js";
import { InvalidValue } from "../../web/lib/errors.js";
import { sampleFiles } from "./reference.js";
import { ROOT } from "./util.js";

/** @param {string} path @returns {Uint8Array} */
function bodyOf(path) {
    const data = new Uint8Array(readFileSync(path));
    return isArchive(data) ? decryptBody(splitArchive(data).body) : data;
}

/** @typedef {{ op: string, [k: string]: any }} Op */

/** @param {Uint8Array} body @param {Op} op */
function run(body, op) {
    switch (op.op) {
        case "add_mode": return addMode(body, op.after, { copyFrom: op.copy_from ?? null, name: op.name ?? null, zones: op.zones ?? [] });
        case "delete_mode": return deleteMode(body, op.number);
        case "add_zone": return addZone(body, op.position, op.modes, op.name ?? null);
        case "delete_zone": return deleteZone(body, op.number);
        case "zones_on": return zonesOn(body);
        case "zones_off": return zonesOff(body);
        case "remove_trunking": return removeTrunking(body);
        case "set_list_types": return convscan.setListTypes(body, op.non_priority_list, op.priority_list);
        case "set_scan_type": return convscan.setScanType(body, op.scan_type);
        case "conv_encode": {
            const conv = op.conv ? { ...{ scan_type: "Disabled", non_priority_list: "Op Select", priority_list: "Op Select", priority_1: null, priority_2: null, modes: null }, ...op.conv } : null;
            return convscan.encode(body, conv, (op.rows ?? []).map((/** @type {any} */ r) => ({ ...convscan.modeScan(r.mode), ...r })));
        }
        case "scan_encode": return scanlist.encode(body, op.scans.map((/** @type {any} */ z) => ({ ...scanlist.zoneScan(z.zone), ...z })));
        default: throw new Error(`unknown op ${op.op}`);
    }
}

/** The operations to try on one sample, from what it holds. @returns {[string, Op[]][]} */
function casesFor(/** @type {Uint8Array} */ body) {
    let cp;
    try {
        cp = parseCodeplug(body);
    } catch {
        return [];
    }
    const n = cp.modes.length;
    if (!n) return [];
    const nz = cp.zones.length;
    const zoned = zoneOperation(body) === true;
    const z1 = zoned && nz ? [1] : [];
    const mid = Math.max(1, Math.floor(n / 2));
    /** @type {[string, Op[]][]} */
    const c = [
        ["add first", [{ op: "add_mode", after: 0, zones: z1 }]],
        ["add last named", [{ op: "add_mode", after: n, name: "TEST", zones: zoned ? [1, Math.min(2, nz)] : [] }]],
        ["add mid copy", [{ op: "add_mode", after: mid, copy_from: n, zones: z1 }]],
        ["add no zone", [{ op: "add_mode", after: 1 }]],
        ["add bad copy", [{ op: "add_mode", after: 1, copy_from: n + 5, zones: z1 }]],
        ["delete first", [{ op: "delete_mode", number: 1 }]],
        ["delete mid", [{ op: "delete_mode", number: mid }]],
        ["delete last", [{ op: "delete_mode", number: n }]],
        ["add then delete", [{ op: "add_mode", after: 2, zones: z1 }, { op: "delete_mode", number: 1 }]],
        ["add 9", Array.from({ length: 9 }, (_, i) => ({ op: "add_mode", after: n + i, zones: z1 }))],
        ["zones on", [{ op: "zones_on" }]],
        ["zones off", [{ op: "zones_off" }]],
        ["zones off, add, on", [{ op: "zones_off" }, { op: "add_mode", after: 1 }, { op: "zones_on" }]],
        ["remove trunking", [{ op: "remove_trunking" }]],
        ["remove trunking, delete 2", [{ op: "remove_trunking" }, { op: "delete_mode", number: 2 }]],
    ];
    if (nz) {
        c.push(
            ["add zone first", [{ op: "add_zone", position: 1, modes: [1] }]],
            ["add zone last", [{ op: "add_zone", position: nz + 1, modes: [1, n], name: "NEW Z" }]],
            ["add zone empty", [{ op: "add_zone", position: 1, modes: [] }]],
            ["delete zone 1", [{ op: "delete_zone", number: 1 }]],
            ["delete zone last", [{ op: "delete_zone", number: nz }]],
            ["add zone, delete zone 1", [{ op: "add_zone", position: 2, modes: Array.from({ length: n }, (_, i) => i + 1) }, { op: "delete_zone", number: 1 }]],
            ["zone scan", [{ op: "scan_encode", scans: [{ zone: 1, scan_type: "Pri Tlkgr", priority_1: n, priority_2: "SELMOD", modes: [1, 2] }] }]],
            ["zone scan talkgroup pri", [{ op: "scan_encode", scans: [{ zone: 1, scan_type: "Talkgroup", priority_1: 1 }] }]],
            ["zone scan options", [{ op: "scan_encode", scans: [{ zone: nz, talkback_scan: "Disabled", scan_button_control: "Override", coded_squelch_scan: "Disabled", non_priority_list: "Op Select", priority_list: "Op Select", modes: [n] }] }]],
            ["zone scan too many", [{ op: "scan_encode", scans: [{ zone: 1, scan_type: "Pri Tlkgr", modes: Array.from({ length: Math.min(n, 20) }, (_, i) => i + 1) }] }]],
            ["mode ops keep zone scan", [{ op: "scan_encode", scans: [{ zone: 1, scan_type: "Pri Tlkgr", priority_1: Math.min(3, n), modes: [n] }] },
                { op: "add_mode", after: 1, zones: [1] }, { op: "delete_mode", number: Math.min(3, n) + 1 }]],
        );
    }
    for (const [nl, pl] of [["Op Select", "Op Select"], ["Mode Slave", "Op Select"], ["Op Select", "Mode Slave"], ["Mode Slave", "Mode Slave"]]) {
        c.push([`list types ${nl} / ${pl}`, [{ op: "set_list_types", non_priority_list: nl, priority_list: pl }]]);
        c.push([`list types ${nl} / ${pl}, then add + delete`, [{ op: "set_list_types", non_priority_list: nl, priority_list: pl },
            { op: "add_mode", after: 1 }, { op: "delete_mode", number: n }]]);
    }
    c.push(
        ["scan type talkgroup", [{ op: "set_scan_type", scan_type: "Talkgroup" }]],
        ["scan type pri tlkgr", [{ op: "set_scan_type", scan_type: "Pri Tlkgr" }]],
        ["mode scan flags", [{ op: "conv_encode", rows: [{ mode: 1, scan: "Enabled", talkback_scan: "Enabled", coded_squelch_scan: "Disabled" },
            { mode: n, scan_button_control: "Override", scan: "Enabled" }] }]],
        ["mode slave list", [{ op: "set_list_types", non_priority_list: "Mode Slave", priority_list: "Mode Slave" },
            { op: "conv_encode", rows: [{ mode: 1, scan: "Enabled", priority_1: n, modes: [2, 3].filter((m) => m <= n) }, { mode: 2, priority_2: 1, modes: [1] }] }]],
        ["op select list", [{ op: "set_list_types", non_priority_list: "Op Select", priority_list: "Op Select" },
            { op: "conv_encode", conv: { priority_1: "SELMOD", priority_2: n, modes: [1, 2] }, rows: [{ mode: 1, scan: "Enabled" }] }]],
        ["pri op select, np slave", [{ op: "set_list_types", non_priority_list: "Mode Slave", priority_list: "Op Select" },
            { op: "conv_encode", conv: { non_priority_list: "Mode Slave", priority_1: 1 }, rows: [{ mode: 2, scan: "Enabled", modes: [n] }] }]],
        ["bad priority", [{ op: "set_list_types", non_priority_list: "Mode Slave", priority_list: "Mode Slave" },
            { op: "conv_encode", rows: [{ mode: 1, priority_1: n + 3 }] }]],
    );
    return c;
}

const files = sampleFiles().filter((p) => !p.toLowerCase().endsWith(".dbf"));
/** @type {{ id: string, file: string, ops: Op[] }[]} */
const cases = [];
for (const file of files) {
    let body;
    try {
        body = bodyOf(file);
    } catch {
        continue;
    }
    for (const [what, ops] of casesFor(body)) {
        cases.push({ id: `${file.startsWith(ROOT) ? relative(ROOT, file) : file.replace(/^.*\/SPECTRA\//, "")}: ${what}`, file, ops });
    }
}

/** Run the Python side once. */
function python() {
    const r = spawnSync("python3", [join(ROOT, "tools", "py_struct.py")], {
        cwd: ROOT, env: { ...process.env, PYTHONPATH: ROOT }, input: JSON.stringify(withConvDefaults()),
        encoding: "utf8", maxBuffer: 1 << 28,
    });
    if (r.status !== 0) return { error: r.stderr };
    return /** @type {Record<string, any>} */ (JSON.parse(r.stdout));
}

/**
 * conv_encode's `conv` as both sides get it: the current scan type and list
 * types filled in from the body the op will see (Python's ConvScan defaults
 * would otherwise ask for a re-pack).
 */
function withConvDefaults() {
    return cases.map((c) => {
        if (!c.ops.some((op) => op.op === "conv_encode" && op.conv)) return c;
        let body = bodyOf(c.file);
        const ops = c.ops.map((op) => {
            let o = op;
            if (op.op === "conv_encode" && op.conv) {
                let cur = null;
                try {
                    cur = convscan.decode(body)[0];
                } catch { /* refused below */ }
                o = { ...op, conv: { scan_type: cur?.scan_type ?? "Disabled", non_priority_list: cur?.non_priority_list ?? "Op Select",
                    priority_list: cur?.priority_list ?? "Op Select", ...op.conv } };
            }
            try {
                body = run(body, o);
            } catch { /* later ops see the last good body; the run stops there anyway */ }
            return o;
        });
        return { ...c, ops };
    });
}

const prepared = withConvDefaults();
const ref = python();

test("there are structural cases", () => {
    assert.ok(cases.length > 1000, `only ${cases.length}`);
    assert.ok(!("error" in ref && typeof ref.error === "string" && !ref[cases[0]?.id ?? ""]), `Python failed: ${ref.error}`);
});

test("structural operations match Python on every sample", () => {
    const bad = [];
    let ok = 0;
    let refused = 0;
    for (const c of prepared) {
        const want = ref[c.id];
        /** @type {{ sha256?: string, length?: number, error?: string }} */
        let got;
        try {
            let body = bodyOf(c.file);
            for (const op of c.ops) body = run(body, op);
            got = { sha256: createHash("sha256").update(body).digest("hex"), length: body.length };
        } catch (e) {
            if (!(e instanceof InvalidValue)) got = { error: `BUG ${e instanceof Error ? e.stack : e}` };
            else got = { error: e.message };
        }
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${c.id}\n  Python ${JSON.stringify(want)}\n  JS     ${JSON.stringify(got)}`);
        else if (got.error) refused++;
        else ok++;
    }
    assert.equal(bad.length, 0, `${bad.length} of ${prepared.length} differ (${ok} equal, ${refused} refused alike):\n${bad.slice(0, 15).join("\n")}`);
    assert.ok(ok > 500, `only ${ok} cases produced a body`);
});
