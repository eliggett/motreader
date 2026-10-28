// @ts-check
/**
 * The generated files are up to date with their sources (the head drawings
 * in graphics/, the A9 button table in motreader/), and each drawing has the
 * programmable keys RSS shows for that head.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { HEAD_DRAWINGS } from "../../web/app/heads/index.js";
import { KEYPAD_ORDER, SMALL_ORDER } from "../../web/lib/buttons.js";
import { ROOT } from "./util.js";

const check = (/** @type {string} */ tool) => spawnSync("python3", [`tools/${tool}`, "--check"], {
    cwd: ROOT, env: { ...process.env, PYTHONPATH: ROOT }, encoding: "utf8",
});

test("web/app/heads is generated from graphics/ (run tools/build_heads.py)", () => {
    const r = check("build_heads.py");
    assert.equal(r.status, 0, r.stderr);
});

test("web/lib/a9table.js is generated from motreader/_a9_table.py (run tools/build_a9_table_js.py)", () => {
    const r = check("build_a9_table_js.py");
    assert.equal(r.status, 0, r.stderr);
});

const drawn = (/** @type {string} */ head) => new Set((HEAD_DRAWINGS[head]?.layers.Buttons ?? []).map((s) => s.button));

test("each drawing has the keys RSS shows for its head", () => {
    assert.deepEqual(drawn("Enhanced"), new Set(KEYPAD_ORDER));
    assert.deepEqual(drawn("Standard"), new Set(SMALL_ORDER));
    // RSS with the Rotary head: Ind 1-5, keys 1-4 and 7 (owner, 2026-10-27)
    assert.deepEqual(drawn("Rotary"), new Set(["Ind 1", "Ind 2", "Ind 3", "Ind 4", "Ind 5", "1", "2", "3", "4", "7"]));
    assert.deepEqual(drawn("S9000e"), new Set(["Ind 1", "Ind 2", "Ind 3", "Ind 4", "Ind 5", "Ind 6",
        "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#", "Mode Dn", "Mode Up", "Vol Dn", "Vol Up", "Zone Up", "Home"]));
});
