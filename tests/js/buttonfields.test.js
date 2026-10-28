// @ts-check
/**
 * Button edits on an open document (lib/buttonfields.js): RSS's rules by
 * default, experimental edits only when asked for (and they stay allowed
 * while other buttons are edited), the result exports and reads back, and
 * the warnings about Sel / Home.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDocument, changes } from "../../web/lib/document.js";
import { exportArchive } from "../../web/lib/export.js";
import { setButton, setButtons } from "../../web/lib/buttonfields.js";
import { missingRequired, functionChoices } from "../../web/lib/buttons.js";
import { InvalidValue } from "../../web/lib/errors.js";
import { SPECTRA } from "./util.js";

const ARCHIVE = join(SPECTRA, "ARCHIVE");
const find = (/** @type {string} */ f) => {
    const hit = existsSync(ARCHIVE) ? readdirSync(ARCHIVE).find((x) => x.toLowerCase() === f.toLowerCase()) : undefined;
    return hit ? join(ARCHIVE, hit) : null;
};
const open = (/** @type {string} */ f) => openDocument(f, new Uint8Array(readFileSync(/** @type {string} */ (find(f)))));
const fn = (/** @type {import("../../web/lib/document.js").CodeplugDocument} */ d, /** @type {string} */ b) => d.buttons.find((x) => x.button === b)?.function;

test("standard head: edits, refusals, experimental, export", { skip: !find("a604aun0.331") }, () => {
    const d = open("a604aun0.331");
    assert.deepEqual(missingRequired(d.cp, d.buttons), []);
    setButton(d, "Ind 1", "airhn");
    assert.equal(fn(d, "Ind 1"), "Airhn", "RSS's label");
    assert.deepEqual(changes(d).buttons, ["Ind 1"]);
    assert.throws(() => setButton(d, "Ind 2", "Airhn"), /both have Airhn/);
    assert.throws(() => setButton(d, "Ind 5", "Scan"), /fixed in RSS/);
    assert.throws(() => setButton(d, "Ind 2", "Nope"), InvalidValue);
    // Sel stays on Ind 5 in RSS (Rotary too): elsewhere only as an experimental edit
    assert.throws(() => setButton(d, "Ind 2", "Sel"), /doesn't offer Sel/);
    assert.equal(functionChoices(d.cp, "Ind 2").offered[0]?.label, "Blank", "Blank first");
    assert.deepEqual(functionChoices(d.cp, "Ind 2").other.map((c) => c.label), ["Sel"]);
    // experimental: Ind 5 off Sel, * to a function; then an ordinary edit still goes through
    setButton(d, "Ind 5", "Blank", true);
    setButton(d, "*", "VRS", true);
    setButton(d, "Ind 2", "Blank");
    assert.deepEqual(d.buttons.filter((b) => b.hack).map((b) => b.button), ["Ind 5", "*"]);
    assert.deepEqual(missingRequired(d.cp, d.buttons), ["Sel"]);
    let res = exportArchive(d, d.radioWideEdits);
    assert.deepEqual(res.problems, []);
    const back = openDocument(d.fileName, res.bytes);
    assert.deepEqual(back.buttons.map((b) => b.function), d.buttons.map((b) => b.function));
    // back to RSS's own: * = Rcl again, no longer experimental
    setButton(d, "*", "Rcl", true);
    setButton(d, "Ind 5", "Sel", true);
    assert.equal(fn(d, "*"), "Rcl");
    assert.deepEqual(d.buttons.filter((b) => b.hack).map((b) => b.button), []);
    res = exportArchive(d, d.radioWideEdits);
    assert.equal(openDocument(d.fileName, res.bytes).buttons.find((b) => b.button === "Ind 5")?.function, "Sel");
});

test("A9 head: offered functions, direct entry, experimental keys", { skip: !find("a221azn0.035") }, () => {
    const d = open("a221azn0.035");
    const { offered, other } = functionChoices(d.cp, "1");
    assert.ok(!offered.some((c) => c.label === "Scan") && other.some((c) => c.label === "Scan"), "keypad keys aren't offered Scan");
    assert.throws(() => setButton(d, "1", "Scan"), /does not offer/);
    assert.equal(offered[0]?.label, "Blank", "Blank first");
    setButton(d, "1", "zone 4");
    assert.equal(fn(d, "1"), "Zone 4");
    assert.throws(() => setButton(d, "*", "Scan"), /fixed in RSS/);
    setButtons(d, [{ button: "*", function: "Mute" }, { button: "Home", function: "Scan" }], true);
    assert.deepEqual(missingRequired(d.cp, d.buttons), ["Home"]);
    setButton(d, "Ind 1", "Blank", true);
    assert.deepEqual(missingRequired(d.cp, d.buttons), ["Sel", "Home"]);
    const res = exportArchive(d, d.radioWideEdits);
    assert.deepEqual(res.problems, []);
    const back = openDocument(d.fileName, res.bytes);
    assert.deepEqual(back.buttons.map((b) => b.function), d.buttons.map((b) => b.function));
});
