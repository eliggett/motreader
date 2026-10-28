// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDocument, hasTrunking } from "../../web/lib/document.js";
import { generalInfo } from "../../web/lib/info.js";
import { readDbf, findArchiveRecord } from "../../web/lib/dbf.js";
import { SPECTRA } from "./util.js";

const ARCHIVE = join(SPECTRA, "ARCHIVE");
const have = existsSync(join(ARCHIVE, "A617ASQ1.266"));
const open = (/** @type {string} */ f) => openDocument(f, new Uint8Array(readFileSync(join(ARCHIVE, f))));
/** General Info as {label: value}. */
const info = (/** @type {import("../../web/lib/document.js").CodeplugDocument} */ d) =>
    Object.fromEntries(generalInfo(d).flatMap((s) => s.rows.map((r) => [r.label, r.value])));

test("General Info of a VHF radio with zones, with its DBF entry", { skip: !have }, () => {
    const d = open("A617ASQ1.266");
    const t = readDbf(new Uint8Array(readFileSync(join(ARCHIVE, "spectram.dbf"))));
    d.index = { fileName: "spectram.dbf", record: findArchiveRecord(t.records, d.fileName, d.cp.serial) };
    const i = info(d);
    assert.equal(i["Radio model"], "D43KMA7JA5BK");
    assert.equal(i["Serial number"], "617ASQ1266");
    assert.equal(i["Radio band"], "VHF");
    assert.equal(i["Customer"], "2M junk 3");
    assert.match(i["Date programmed"] ?? "", /^\d{4}-\d\d-\d\d$/);
    assert.equal(i["Zones"], String(d.cp.zones.length));
    assert.equal(i["Decrypted codeplug size"], `${d.plain.length} bytes`);
    assert.equal(i["Decryption key (nonce)"]?.split(" ").length, 13);
    assert.ok(!hasTrunking(d));
});

test("a B file finds its DBF entry by serial", { skip: !have }, () => {
    const d = open("B617ASQ1.266");
    const t = readDbf(new Uint8Array(readFileSync(join(ARCHIVE, "spectram.dbf"))));
    assert.equal(findArchiveRecord(t.records, d.fileName, d.cp.serial)?.CUSTOMER, "2M junk 3");
});

test("the trunked 566AYA reports removable trunking", { skip: !existsSync(join(ARCHIVE, "a566aya0.014")) }, () => {
    const d = open("a566aya0.014");
    assert.ok(d.trunk.info, d.trunk.unsupported ?? "no trunking found");
    assert.match(info(d)["Trunking"] ?? "", /^yes: mode 1 is trunked/);
    assert.equal(info(d)["Radio band"], "900 MHz");
});

test("File Blocks match what RSS shows on reading", () => {
    // counts read off RSS's screen as it loaded each archive
    for (const [f, n] of /** @type {[string, string][]} */ ([["a566aya0.014", "27"], ["a221azn0.035", "46"], ["a617asn1.767", "14"]])) {
        if (!existsSync(join(ARCHIVE, f))) continue;
        assert.equal(info(open(f))["File Blocks"], n, f);
    }
});

test("a non-archive is refused", () => {
    assert.throws(() => openDocument("x.bin", new Uint8Array(100)), /not a Spectra archive/);
});
