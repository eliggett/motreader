// @ts-check
/**
 * Control-head buttons (web/lib/buttons.js) against the Python code
 * (tools/py_buttons.py) on every sample: the decoded buttons are the same,
 * and button edits -- RSS's and the experimental ones -- give the same bytes
 * or refuse alike. (The Python side is checked against RSS's own saves in
 * tests/test_buttons*.py.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { spawnSync } from "node:child_process";
import { isArchive, splitArchive } from "../../web/lib/archive.js";
import { decryptBody } from "../../web/lib/crypto.js";
import { parseCodeplug } from "../../web/lib/codeplug.js";
import { decodeButtons, encodeButtons, functionChoices, isA9 } from "../../web/lib/buttons.js";
import { InvalidValue } from "../../web/lib/errors.js";
import { sampleFiles } from "./reference.js";
import { ROOT } from "./util.js";

/** @param {string} path */
function cpOf(path) {
    const data = new Uint8Array(readFileSync(path));
    try {
        return parseCodeplug(isArchive(data) ? decryptBody(splitArchive(data).body) : data);
    } catch {
        return null;
    }
}

const files = sampleFiles().filter((f) => !f.toLowerCase().endsWith(".dbf"));
const cps = new Map(files.map((f) => [f, cpOf(f)]));
const id = (/** @type {string} */ f) => relative(ROOT, f);

/** @typedef {{ id: string, file: string, rows: { button: string, function: string }[], hack: boolean }} EditCase */

/** Edits to try on one sample: some functions on every button (all of them on the first two A9 / standard samples). */
function casesFor(/** @type {string} */ file, /** @type {boolean} */ full) {
    const cp = /** @type {import("../../web/lib/codeplug.js").Codeplug} */ (cps.get(file));
    const btns = decodeButtons(cp);
    /** @type {EditCase[]} */
    const out = [];
    const add = (/** @type {string} */ what, /** @type {{ button: string, function: string }[]} */ rows, hack = false) => out.push({ id: `${id(file)} ${what}${hack ? " (hack)" : ""}`, file, rows, hack });
    btns.forEach((b, i) => {
        const { offered, other } = functionChoices(cp, b.button);
        const text = (/** @type {import("../../web/lib/buttons.js").Choice} */ c) => (c.data ? c.label.replace("X", String(1 + (i % 12))) : c.label);
        const step = full ? 1 : 13;
        // RSS's choices; the others both refused and as experimental edits
        offered.filter((_, k) => k % step === i % step).forEach((c) => add(`${b.button} = ${text(c)}`, [{ button: b.button, function: text(c) }]));
        other.filter((_, k) => k % step === i % step).forEach((c) => {
            add(`${b.button} = ${text(c)}`, [{ button: b.button, function: text(c) }]);
            add(`${b.button} = ${text(c)}`, [{ button: b.button, function: text(c) }], true);
        });
        add(`${b.button} unchanged`, [{ button: b.button, function: b.function }]);
    });
    add("unknown function", [{ button: btns[0]?.button ?? "Ind 1", function: "NOPE" }]);
    add("unknown button", [{ button: "Ind 9", function: "Scan" }]);
    if (isA9(cp)) add("zone 0", [{ button: "Ind 2", function: "Zone 0" }]);
    // a swap through two buttons (duplicate checks see the final layout)
    const [x, y] = btns.filter((b) => b.editable);
    if (x && y) add("swap", [{ button: x.button, function: y.function }, { button: y.button, function: x.function }]);
    return out;
}

const usable = files.filter((f) => cps.get(f) && decodeButtons(/** @type {any} */ (cps.get(f))).length);
const firstA9 = usable.filter((f) => isA9(/** @type {any} */ (cps.get(f)))).slice(0, 2);
const firstStd = usable.filter((f) => !isA9(/** @type {any} */ (cps.get(f)))).slice(0, 2);
const edits = usable.flatMap((f) => casesFor(f, firstA9.includes(f) || firstStd.includes(f)));

const ref = (() => {
    const r = spawnSync("python3", ["tools/py_buttons.py"], {
        cwd: ROOT, env: { ...process.env, PYTHONPATH: ROOT }, encoding: "utf8", maxBuffer: 1 << 30,
        input: JSON.stringify({ decode: files.filter((f) => cps.get(f)), edit: edits }),
    });
    return r.status === 0 ? /** @type {{ decode: Record<string, any>, edit: Record<string, any> }} */ (JSON.parse(r.stdout)) : null;
})();

/** A refusal's message without its list of choices, quoting as JSON does. */
const gist = (/** @type {string} */ m) => m.split(" (")[0]?.replace(/'/g, "\"");

test("Python reference available", { skip: ref ? false : "Python unavailable" }, () => {
    assert.ok(usable.length > 100 && firstA9.length > 0, `${usable.length} samples with buttons, ${firstA9.length} A9`);
});

test("decoded buttons match Python on every sample", { skip: !ref }, () => {
    for (const f of files) {
        const cp = cps.get(f);
        if (!cp) continue;
        const want = /** @type {any} */ (ref).decode[f];
        assert.ok(!want?.error, `${id(f)}: Python failed: ${want?.error}`);
        assert.deepEqual(decodeButtons(cp), want, id(f));
    }
});

test(`button edits match Python (${edits.length} cases)`, { skip: !ref }, () => {
    let refused = 0;
    for (const c of edits) {
        const cp = /** @type {import("../../web/lib/codeplug.js").Codeplug} */ (cps.get(c.file));
        const want = /** @type {any} */ (ref).edit[c.id];
        const body = cp.body.slice();
        let err = null;
        try {
            encodeButtons(cp, body, c.rows, c.hack);
        } catch (e) {
            if (!(e instanceof InvalidValue)) throw e;
            err = e.message;
        }
        if (want.error !== undefined) {
            refused++;
            assert.equal(err && gist(err), gist(want.error), `${c.id}: refusal`);
        } else {
            assert.equal(err, null, `${c.id}: JS refused, Python didn't`);
            assert.equal(createHash("sha256").update(body).digest("hex"), want.sha256, c.id);
        }
    }
    assert.ok(refused > 0 && refused < edits.length, `${refused} of ${edits.length} refused`);
});
