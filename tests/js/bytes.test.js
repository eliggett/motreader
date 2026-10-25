// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as B from "../../web/lib/bytes.js";
import { GROUND_TRUTH, hasCommand } from "./util.js";

test("mul32 wraps like uint32_t where a plain multiply loses bits", () => {
    // The archive cipher's LCG step from seed 0xFFFFFFFF; expected value from
    // Python: (0xFFFFFFFF * 0x343FD + 0x269EC3) & 0xFFFFFFFF.
    assert.equal((B.mul32(0xFFFFFFFF, 0x343FD) + 0x269EC3) >>> 0, 0x00235AC6);
    // A product past 2^53 is where a plain multiply goes wrong.
    assert.equal(B.mul32(0xFFFFFFFF, 0xFFFFFFFF), 1);
    assert.equal((0xFFFFFFFF * 0xFFFFFFFF) >>> 0, 0);
    assert.equal(B.mul32(0x80000000, 2), 0);
    assert.equal(B.u32(-1), 0xFFFFFFFF);
});

test("be16 and putBe16 are big-endian and bounds-checked", () => {
    const b = new Uint8Array([0x5F, 0x53, 0x00]);
    assert.equal(B.be16(b, 0), 0x5F53);
    B.putBe16(b, 1, 0x1953);
    assert.deepEqual([...b], [0x5F, 0x19, 0x53]);
    assert.throws(() => B.be16(b, 2), RangeError);
    assert.throws(() => B.putBe16(b, 0, 0x10000), RangeError);
    assert.throws(() => B.at(b, -1), RangeError);
});

test("copy never aliases; subarray does", () => {
    const t = new Uint8Array([1, 2, 3]);
    const c = B.copy(t);
    c[0] = 9;
    assert.equal(t[0], 1);
    t.subarray(0, 1)[0] = 7;
    assert.equal(t[0], 7);
});

test("equal, diff, concat, hex round trip", () => {
    const a = B.fromHex("00 11 22 33");
    const b = B.fromHex("00112a33");
    assert.ok(!B.equal(a, b));
    assert.deepEqual(B.diff(a, b), [2]);
    assert.equal(B.hex(B.concat(a, b), " "), "00 11 22 33 00 11 2a 33");
    assert.throws(() => B.fromHex("abc"), SyntaxError);
});

test("hexdump matches hexdump -C on ground-truth codeplugs", { skip: !hasCommand("hexdump") }, () => {
    const files = readdirSync(GROUND_TRUTH).filter((f) => f.endsWith(".bin")).slice(0, 5);
    assert.ok(files.length > 0);
    for (const f of files) {
        const path = join(GROUND_TRUTH, f);
        const data = new Uint8Array(readFileSync(path));
        assert.equal(B.hexdump(data), execFileSync("hexdump", ["-C", "-v", path], { encoding: "utf8" }), f);
        assert.equal(B.hexdump(data, { squeeze: true }), execFileSync("hexdump", ["-C", path], { encoding: "utf8" }), f);
    }
});

test("hexdump of a short, ragged input matches hexdump -C", { skip: !hasCommand("hexdump") }, () => {
    for (const n of [1, 7, 8, 9, 15, 16, 17, 40]) {
        const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 10) & 0xFF);
        const want = execFileSync("hexdump", ["-C", "-v"], { input: data, encoding: "utf8" });
        assert.equal(B.hexdump(data), want, `length ${n}`);
    }
});
