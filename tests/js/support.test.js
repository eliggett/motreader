// @ts-check
/** Which codeplugs open editable, and which read-only (with a reason). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDocument } from "../../web/lib/document.js";
import { isArchive } from "../../web/lib/archive.js";
import { SPECTRA } from "./util.js";

const open = (/** @type {string} */ p) => openDocument(p, new Uint8Array(readFileSync(join(SPECTRA, p))));
const archivesIn = (/** @type {string} */ d) => (existsSync(join(SPECTRA, d)) ? readdirSync(join(SPECTRA, d)) : [])
    .filter((f) => statSync(join(SPECTRA, d, f)).isFile() && isArchive(readFileSync(join(SPECTRA, d, f)).subarray(0, 64)))
    .map((f) => `${d}/${f}`);

test("the owner's current archives are all editable", { skip: !existsSync(join(SPECTRA, "ARCHIVE")) }, () => {
    for (const p of archivesIn("ARCHIVE")) assert.ok(open(p).support.editable, `${p}: ${open(p).support.reasons}`);
});

test("a one-mode codeplug decodes (and is editable)", { skip: !existsSync(join(SPECTRA, "ARCHIVE-20250412/a617asq1.266")) }, () => {
    const d = open("ARCHIVE-20250412/a617asq1.266");
    assert.equal(d.cp.modes.length, 1);
    assert.equal(d.cp.band, "vhf");
    assert.ok(d.support.editable);
});

test("unsupported codeplugs open read-only with a reason", { skip: !existsSync(join(SPECTRA, "AR-ORIG")) }, () => {
    const cases = /** @type {[string, RegExp][]} */ ([
        ["AR-ORIG/A604HMW0.158", /format version 101/],
        ["AR-ORIG/A604HNU1.400", /format version 102/],
        ["AR-ORIG/A604HQN2.287", /mode table/],
        ["AR-ORIG/B617AVE0.527", /mode table|layout/],
        ["AR-ORIG/A617AVE0.527", /800 MHz/],
        ["AR-ORIG/A604HQJ2.211", /800 MHz/],
        ["ARCHIVE-20250412/b604aun0.331", /mode table/],
    ]);
    for (const [p, why] of cases) {
        if (!existsSync(join(SPECTRA, p))) continue;
        const s = open(p).support;
        assert.ok(!s.editable, p);
        assert.match(s.reasons.join("; "), why, p);
    }
    assert.ok(open("AR-ORIG/A221ASJ0.121").support.editable, "the UHF sample is editable since the UHF codec");
});

test("older format versions 112 and 114 open modes-only", { skip: !existsSync(join(SPECTRA, "AR-ORIG/A624HQE9.680")) }, () => {
    for (const p of ["AR-ORIG/A624HQE9.680", "AR-ORIG/A624HQU0.228"]) {
        const d = open(p);
        assert.ok(d.support.editable && d.support.modesOnly, `${p}: ${d.support.reasons}`);
        assert.equal(d.cp.band, "vhf");
        assert.equal(d.cp.modes.length, d.plain[0x109]);
        assert.deepEqual([d.cp.zones, d.phones, d.mpls, d.radioWide], [[], [], [], {}], "only the modes are decoded");
    }
});
