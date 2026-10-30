// @ts-check
/**
 * The web/lib decoder must agree exactly with the Python one (motreader-py/) on
 * every sample on hand: the RSS ground-truth captures and, when present, the
 * real archives under ~/.dosbox. Python is the reference; tools/py_reference.py
 * dumps what it decodes and tests/js/reference.js builds the same from web/lib.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { isArchive, splitArchive, joinArchive } from "../../web/lib/archive.js";
import { decryptBody, encryptBody } from "../../web/lib/crypto.js";
import { equal } from "../../web/lib/bytes.js";
import { sampleFiles, pythonReference, jsReference } from "./reference.js";
import { ROOT } from "./util.js";

const files = sampleFiles();
const ref = pythonReference(files);

test("there are samples to compare", () => {
    assert.ok(files.length > 200, `only ${files.length} sample files`);
});

for (const path of files) {
    const name = path.startsWith(ROOT) ? relative(ROOT, path) : path.replace(/^.*\/SPECTRA\//, "SPECTRA/");
    test(`decode matches Python: ${name}`, { skip: ref ? false : "Python reference unavailable" }, () => {
        const want = /** @type {Record<string, any>} */ (ref)[path];
        let got;
        try {
            got = JSON.parse(JSON.stringify(jsReference(path)));
        } catch (e) {
            got = { error: String(e) };
        }
        if (want.error || got.error) {
            assert.equal(Boolean(got.error), Boolean(want.error), `Python: ${want.error ?? "ok"}; JS: ${got.error ?? "ok"}`);
            return;
        }
        // compare section by section so a failure says where
        for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], `${name}: ${k}`);
        assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
    });
}

test("archives re-encrypt byte-identically", () => {
    let n = 0;
    for (const path of files) {
        const data = new Uint8Array(readFileSync(path));
        if (!isArchive(data)) continue;
        const a = splitArchive(data);
        const back = joinArchive({ banner: a.banner, body: encryptBody(decryptBody(a.body)) });
        assert.ok(equal(back, data), path);
        n++;
    }
    if (n === 0) test.skip?.("no archives on hand");
});
