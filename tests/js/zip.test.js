// @ts-check
// web/lib/zip.js: Python's zipfile reads what it writes, byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zip, crc32, utf8 } from "../../web/lib/zip.js";

test("crc32 check value", () => {
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xCBF43926);
});

test("utf8 matches TextEncoder", () => {
    for (const t of ["", "abc", "héllo", "€ 1", "𝄞 clef", "Ω≈ç√"]) assert.deepEqual(utf8(t), new TextEncoder().encode(t));
});

test("python's zipfile reads the archive back", () => {
    const bin = Uint8Array.from({ length: 70000 }, (_, i) => (i * 31 + 7) & 0xFF);
    const z = zip([{ name: "radio/ram.bin", bytes: bin }, { name: "README.txt", bytes: "héllo\n" },
        { name: "empty.bin", bytes: new Uint8Array(0) }], new Date(2026, 9, 31, 15, 30, 10));
    const dir = mkdtempSync(join(tmpdir(), "mr-zip-"));
    try {
        const path = join(dir, "t.zip");
        writeFileSync(path, z);
        const out = execFileSync("python3", ["-c", `
import sys, zipfile, hashlib
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for i in z.infolist():
    print(i.filename, i.file_size, hashlib.sha1(z.read(i)).hexdigest(), i.date_time)
`, path], { encoding: "utf8" }).trim().split("\n");
        const sha = (/** @type {string | Uint8Array} */ b) => execFileSync("python3", ["-c",
            "import sys, hashlib; print(hashlib.sha1(sys.stdin.buffer.read()).hexdigest())"], { input: b, encoding: "utf8" }).trim();
        assert.deepEqual(out, [
            `radio/ram.bin 70000 ${sha(bin)} (2026, 10, 31, 15, 30, 10)`,
            `README.txt 7 ${sha(new TextEncoder().encode("héllo\n"))} (2026, 10, 31, 15, 30, 10)`,
            `empty.bin 0 ${sha(new Uint8Array(0))} (2026, 10, 31, 15, 30, 10)`,
        ]);
    } finally {
        rmSync(dir, { recursive: true });
    }
});
