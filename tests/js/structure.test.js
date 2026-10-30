// @ts-check
/**
 * Structural changes on an open document (lib/structure.js): edits made
 * before a change are kept, the result exports and reads back cleanly, the
 * bytes equal the plain operation's (checked against Python and RSS
 * elsewhere), and undo restores the document.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDocument, changes } from "../../web/lib/document.js";
import { headerChecksum } from "../../web/lib/codeplug.js";
import { openArchive } from "../../web/lib/archive.js";
import { exportArchive } from "../../web/lib/export.js";
import { setModeField } from "../../web/lib/modefields.js";
import { setRadioWide } from "../../web/lib/document.js";
import { equal } from "../../web/lib/bytes.js";
import { addMode, deleteMode } from "../../web/lib/modeops.js";
import { removeTrunking } from "../../web/lib/trunking.js";
import * as S from "../../web/lib/structure.js";
import { InvalidValue } from "../../web/lib/errors.js";
import { SPECTRA, fixed } from "./util.js";

const ARCHIVE = join(SPECTRA, "ARCHIVE");
/** The archive's path in ARCHIVE, matched case-insensitively (DOS names), or null. */
const find = (/** @type {string} */ f) => {
    const hit = existsSync(ARCHIVE) ? readdirSync(ARCHIVE).find((x) => x.toLowerCase() === f.toLowerCase()) : undefined;
    return hit ? join(ARCHIVE, hit) : null;
};
const has = (/** @type {string} */ f) => find(f) !== null;
const open = (/** @type {string} */ f) => openDocument(f, new Uint8Array(readFileSync(/** @type {string} */ (find(f)))));

test("add / duplicate / delete modes on a zoned radio, with edits made before", { skip: !has("a617asn1.767") }, () => {
    let d = open("a617asn1.767");
    const n = d.cp.modes.length;
    setModeField(d.cp, 3, "name", "EDITED 3");
    // the plain operation on the unedited body, for comparison
    const plainAdd = addMode(d.plain, 5, { copyFrom: 14, name: "NEW", zones: [1] });
    d = S.addModeTo(d, { after: 5, copyFrom: 14, name: "new", zones: [1] });
    assert.equal(d.cp.modes.length, n + 1);
    assert.equal(d.cp.modes[5]?.name, "NEW");
    assert.equal(d.cp.modes[2]?.name, "EDITED 3", "an edit made before the change is kept");
    assert.ok(d.cp.zones[0]?.modes.includes(6));
    assert.deepEqual(d.ops, ['added mode 6 "NEW"']);
    assert.ok(changes(d).any, "a structural change counts as a change");
    // apart from mode 3's name, the same bytes as the plain operation
    const named = addMode(open("a617asn1.767").plain, 5, { copyFrom: 14, name: "NEW", zones: [1] });
    assert.ok(equal(named, plainAdd));
    d = S.duplicateModeIn(d, 6);
    assert.equal(d.cp.modes[6]?.name, "NEW");
    assert.deepEqual(S.zonesOf(d, 7), S.zonesOf(d, 6));
    d = S.deleteModeIn(d, 1);
    assert.equal(d.cp.modes.length, n + 1);
    assert.equal(d.cp.modes[1]?.name, "EDITED 3");
    const res = exportArchive(d, d.radioWideEdits);
    assert.deepEqual(res.problems, []);
    const back = openDocument(d.fileName, res.bytes);
    assert.deepEqual(back.cp.modes.map((m) => m.name), d.cp.modes.map((m) => m.name));
    // undo, step by step, back to the file as opened (with its edit)
    d = S.undoLast(S.undoLast(S.undoLast(d)));
    assert.equal(d.ops.length, 0);
    assert.equal(d.cp.modes.length, n);
    assert.equal(d.cp.modes[2]?.name, "EDITED 3");
    assert.throws(() => S.undoLast(d), InvalidValue);
});

test("names and refusals are checked like edits", { skip: !has("a617asn1.767") }, () => {
    const d = open("a617asn1.767");
    assert.throws(() => S.addModeTo(d, { after: 1, name: "BAD.NAME", zones: [1] }), /can't use/);
    assert.throws(() => S.addModeTo(d, { after: 1 }), /must go in a zone/);
    assert.throws(() => S.addZoneTo(d, { position: 1, modesText: "" }), /at least one mode/);
    assert.throws(() => S.addZoneTo(d, { position: 1, modesText: "1-x" }), /mode number or range/);
    assert.throws(() => S.deleteModeIn(d, /** @type {number} */ (d.plain[0x10F])), /home mode/);
    assert.equal(S.addModeTo(d, { after: 1, zones: [1] }).cp.modes[1]?.name, "MODE   2", "RSS's default name");
});

test("zones: add, delete, scan list, Zone Operation off and on", { skip: !has("a617asn1.767") }, () => {
    let d = open("a617asn1.767");
    const nz = d.cp.zones.length;
    d = S.addZoneTo(d, { position: 2, name: "new z", modesText: "1-3, 9" });
    assert.equal(d.cp.zones.length, nz + 1);
    assert.equal(d.cp.zones[1]?.name, "NEW Z");
    assert.deepEqual(d.cp.zones[1]?.modes, [1, 2, 3, 9]);
    const sc = /** @type {import("../../web/lib/scanlist.js").ZoneScan} */ (S.zoneScans(d)[1]);
    d = S.setZoneScan(d, { ...sc, scan_type: "Pri Tlkgr", priority_1: 3, priority_2: "SELMOD", modes: [1, 2] });
    const sc2 = S.zoneScans(d)[1];
    assert.deepEqual([sc2?.scan_type, sc2?.priority_1, sc2?.priority_2, sc2?.modes], ["Pri Tlkgr", 3, "SELMOD", [1, 2]]);
    d = S.deleteZoneIn(d, 2);
    assert.equal(d.cp.zones.length, nz);
    d = S.setZoneOperationIn(d, false);
    assert.equal(d.radioWide.zone_operation, "Disabled");
    assert.equal(d.cp.zones.length, 0);
    const [conv, rows] = S.convScans(d);
    assert.ok(conv && rows.length === d.cp.modes.length, "zones off: per-mode scan settings");
    d = S.setModeScan(d, { mode: 2, scan: "Enabled" });
    assert.equal(S.convScans(d)[1][1]?.scan, "Enabled");
    d = S.setConvScan(d, { non_priority_list: "Mode Slave", priority_list: "Mode Slave" });
    assert.equal(S.convScans(d)[0]?.priority_list, "Mode Slave");
    d = S.setModeScan(d, { mode: 2, priority_1: 5, modes: [1, 3] });
    const r2 = S.convScans(d)[1][1];
    assert.deepEqual([r2?.priority_1, r2?.modes], [5, [1, 2, 3]], "a mode is always on its own list");
    d = S.setZoneOperationIn(d, true);
    assert.equal(d.cp.zones.length, 1);
    assert.equal(d.cp.zones[0]?.modes.length, d.cp.modes.length);
    assert.deepEqual(exportArchive(d, d.radioWideEdits).problems, []);
});

test("trunk removal as the plain operation does it", { skip: !has("a566aya0.014") }, () => {
    const d = open("a566aya0.014");
    assert.ok(d.trunk.info);
    const e = S.removeTrunkingIn(d);
    assert.ok(equal(e.plain, fixed(removeTrunking(d.plain))));
    assert.equal(e.trunk.info, null);
    assert.ok(!e.cp.trunked_mode1);
    assert.equal(e.cp.modes[0]?.rx_mhz, e.cp.modes[1]?.rx_mhz, "mode 1 is now a copy of mode 2");
    assert.deepEqual(exportArchive(e, {}).problems, []);
    assert.throws(() => S.deleteModeIn(d, 3), /trunked codeplug/);
    assert.ok(equal(S.deleteModeIn(e, 3).plain, fixed(deleteMode(e.plain, 3))));
});

test("radio-wide edits made before a change are kept", { skip: !has("a617asq1.266") }, () => {
    let d = open("a617asq1.266");
    setRadioWide(d, "minimum_volume", 3);
    d = S.addModeTo(d, { after: d.cp.modes.length, zones: S.zonesOnIn(d) ? [1] : [] });
    assert.equal(d.radioWide.minimum_volume, 3);
    assert.deepEqual(d.radioWideEdits, {});
});

test("every archive RSS saved has the header checksum the radio checks", { skip: !existsSync(ARCHIVE) }, () => {
    let n = 0;
    for (const f of readdirSync(ARCHIVE)) {
        if (!/^[ab].*\.\d{3}$/i.test(f)) continue;
        const body = openArchive(new Uint8Array(readFileSync(join(ARCHIVE, f)))).plain;
        assert.equal(body[0x1DE], headerChecksum(body), f);
        n++;
    }
    assert.ok(n > 0);
});

test("an MDC Unit ID edit updates the header checksum (FL 01/82 otherwise)", { skip: !has("a617asq1.266") }, () => {
    const d = open("a617asq1.266");
    setRadioWide(d, "mdc_unit_id", d.radioWide.mdc_unit_id === "1118" ? "1110" : "1118");
    const plain = exportArchive(d, d.radioWideEdits).plain;
    assert.notEqual(plain[0x1DE], d.plain[0x1DE]);
    assert.equal(plain[0x1DE], headerChecksum(plain));
});
