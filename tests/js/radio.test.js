// @ts-check
// web/lib/sb9600.js and web/lib/radio.js: the same checks as tests/test_sb9600.py
// and tests/test_radio.py, against a port of tools/fake_radio.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sb from "../../web/lib/sb9600.js";
import * as rd from "../../web/lib/radio.js";
import { fromHex, hex } from "../../web/lib/bytes.js";
import { openArchive } from "../../web/lib/archive.js";
import { FakeRadio } from "./fakeradio.js";

test("CRC matches messages RSS sent", () => {
    for (const wire of ["00d10108a6", "0090010864", "00930108f4", "0092010884", "001201087f",
        "001001089f", "005101085d", "fbfb528757", "a9e3ca873b", "b67500877d", "000000873e",
        "04fb4e075b", "b87acf07a1", "08f7bd070d"]) {
        assert.equal(hex(sb.frame(fromHex(wire).subarray(0, 4))), wire);
    }
});

test("scramble and unscramble RSS's requests", () => {
    for (const [wire, addr, data] of /** @type {[string, number, number][]} */ ([
        ["04fb4e07", 0x6000, 0xFF], ["b87acf07", 0x6000, 0x43], ["b4467307", 0x6001, 0x4F],
        ["08f7bd07", 0x6CFF, 0xFF], ["fbfb5287", 0x6038, 0x00]])) {
        const w = Array.from(fromHex(wire));
        const [hi, lo, d] = sb.unscramble(/** @type {number} */ (w[0]), /** @type {number} */ (w[1]), /** @type {number} */ (w[2]));
        assert.deepEqual([(hi << 8) | lo, d], [addr, data]);
        assert.deepEqual(sb.scramble(hi, lo, d), w.slice(0, 3));
    }
    assert.deepEqual(sb.scramble(0x60, 0x39, 0x52), [0xA9, 0xE3, 0xCA]);    // a chained read frame
});

test("reply scramble round-trips; a real radio's reply", () => {
    for (let i = 0; i < 500; i++) {
        const r0 = (i * 37) & 0xFF, d1 = (i * 101 + 7) & 0xFF, d0 = (i * 13 + 3) & 0xFF;
        assert.deepEqual(sb.unscrambleReply(r0, ...sb.scrambleReply(r0, d1, d0)), [d1, d0]);
    }
    assert.deepEqual(sb.unscrambleReply(0x60, 0xA8, 0x06), [0x4F, 0x43]);   // "CO" from a 617ASQ
    assert.equal(hex(sb.readReply([0x43, 0x4F], false).subarray(0, 4)), "004f4307");
});

const OPTIONS = fromHex("005640a318f7b1f74484001f11000000");   // a 617ASQ's

/** A tiny deterministic PRNG (tests only). */
function rng(/** @type {number} */ seed) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) & 0xFF;
}

/**
 * A codeplug-shaped image and the radio memory holding it (as test_radio.py's
 * synthetic_image): the real header text, a length byte for `blocks` blocks,
 * random bytes elsewhere; s9000e adds the A9-head bit and the 0x8000 region.
 */
function syntheticImage(blocks = 3, seed = 7, s9000e = false) {
    const r = rng(seed);
    let cp = Uint8Array.from({ length: blocks * 0x100 }, r);
    cp.set(new TextEncoder().encode("COPYRIGHT MOTOROLA INC.,1987"));
    cp[0x1C] = blocks * 8 + 4;
    cp[0x39] = 0x07;
    cp.fill(0xFF, 0x40, 0x48);
    cp[0x60] = s9000e ? /** @type {number} */ (cp[0x60]) & ~0x20 : /** @type {number} */ (cp[0x60]) | 0x20;
    /** @type {Map<number, number>} */
    const mem = new Map();
    cp.forEach((b, i) => mem.set(0x6000 + i, b));
    if (s9000e) {
        const ext = Uint8Array.from({ length: 0x2000 }, r);
        ext.forEach((b, i) => mem.set(0x8000 + i, b));
        const all = new Uint8Array(cp.length + ext.length);
        all.set(cp);
        all.set(ext, cp.length);
        cp = all;
    }
    for (const [a, v] of [[0xB675, 0x12], [0xB676, 0x34], [0xB677, 0x35], [0xB69F, 0x56], [0xB6A0, 0x39],
        [0xB6A1, 0x9A], [0xB6A2, 0xBC], [0xFFC6, 0xB6], [0xFFC7, 0x81]]) mem.set(/** @type {number} */ (a), /** @type {number} */ (v));
    OPTIONS.forEach((v, i) => mem.set(0xB681 + i, v));
    return { cp, mem };
}

const quick = { restartMs: 0 };

test("readAll reads the codeplug, MCU bytes and options, and writes nothing", async () => {
    const { cp, mem } = syntheticImage();
    const fake = new FakeRadio(mem);
    const got = await new rd.Radio(fake).readAll();
    assert.deepEqual(got.codeplug, cp);
    assert.deepEqual([...got.mcu.keys()], [0xB675, 0xB69F, 0xB681]);
    assert.equal(hex(/** @type {Uint8Array} */ (got.mcu.get(0xB69F))), "56399abc");
    assert.deepEqual(got.options, OPTIONS);
    assert.equal(hex(/** @type {Uint8Array} */ (fake.sent.at(-1)).subarray(0, 4)), "00100108");
    assert.equal(fake.writes, 0);
});

test("archiveFile: RSS's name and body layout", async () => {
    const { cp, mem } = syntheticImage();
    cp.set(new TextEncoder().encode("617ASQ1266"), 0x1D);
    cp.forEach((b, i) => mem.set(0x6000 + i, b));
    const r = await new rd.Radio(new FakeRadio(mem)).readAll();
    const f = rd.archiveFile(r);
    assert.equal(f.name, "A617ASQ1.266");
    const body = openArchive(f.bytes).plain;
    assert.deepEqual(body.subarray(0xAD), cp);
    assert.deepEqual(body.subarray(13, 19), OPTIONS.subarray(0, 6));
    assert.ok(body.subarray(19, 0xAD).every((x) => x === 0));
    assert.deepEqual(rd.imageFromBody(body).image, cp);
});

test("program writes like RSS and verifies", async () => {
    const { cp, mem } = syntheticImage();
    const img = cp.slice();
    img.set(new TextEncoder().encode("edited codeplug!"), 0x100);
    const fake = new FakeRadio(mem);
    const back = await new rd.Radio(fake).programVerified(img, quick);
    assert.deepEqual(back.codeplug, img);
    const writes = fake.sent.filter((m) => m[3] === sb.OP_WRITE);
    const un = (/** @type {Uint8Array} */ m) => sb.unscramble(/** @type {number} */ (m[0]), /** @type {number} */ (m[1]), /** @type {number} */ (m[2]));
    assert.deepEqual(un(/** @type {Uint8Array} */ (writes[0])), [0x60, 0x00, 0xFF]);   // header byte first
    assert.deepEqual(writes.slice(1, 4).map((w) => un(w).slice(0, 2)), [[0x60, 0], [0x60, 1], [0x60, 2]]);
    assert.equal(writes.length, 1 + cp.length);
});

for (const [field, off, val] of /** @type {[string, number, number | null][]} */ ([
    ["serial", 0x20, null], ["model", 0x48, null], ["length", 0x1C, 0xFF]])) {
    test(`program refuses a different ${field}`, async () => {
        const { cp, mem } = syntheticImage();
        const other = cp.slice();
        other[off] = val ?? /** @type {number} */ (other[off]) ^ 1;
        const fake = new FakeRadio(mem);
        await assert.rejects(new rd.Radio(fake).program(other), (e) => e instanceof rd.ProgramRefused && e.message.includes(field));
        assert.equal(fake.writes, 0);
    });
}

test("the radio is left restarted: MODE_DONE is the last message, also after a failure", async () => {
    const { cp, mem } = syntheticImage();
    const fake = new FakeRadio(mem);
    const radio = new rd.Radio(fake);
    await radio.programVerified(cp, quick);
    assert.equal(hex(/** @type {Uint8Array} */ (fake.sent.at(-1)).subarray(0, 4)), "00100108");
    assert.equal(radio.needsReset, false);
    // a read that fails half-way: finish() sends the reset once
    const failing = new FakeRadio(syntheticImage().mem);
    const r2 = new rd.Radio({ transact: (p) => (p[3] === sb.OP_READ && failing.reads > 5 ? Promise.reject(new rd.BusError("gone")) : failing.transact(p)) });
    await assert.rejects(r2.readAll(), rd.BusError);
    assert.equal(r2.needsReset, true);
    await r2.finish();
    await r2.finish();
    const sent = failing.sent.map((m) => hex(m.subarray(0, 4)));
    assert.equal(sent.at(-1), "00100108");
    assert.equal(sent.filter((m) => m === "00100108").length, 1);
});

test("a bigger codeplug (modes added) fits up to the EEPROM", async () => {
    const { cp, mem } = syntheticImage(3);
    const big = syntheticImage(5, 9).cp;
    big.set(cp.subarray(0x1D, 0x27), 0x1D);
    big.set(cp.subarray(0x44, 0x58), 0x44);
    assert.deepEqual((await new rd.Radio(new FakeRadio(mem)).programVerified(big, quick)).codeplug, big);
});

test("clone keeps the radio's serial and checks its features", async () => {
    const { cp, mem } = syntheticImage(3, 11);
    const src = cp.slice();
    src.set(new TextEncoder().encode("617ASN1767"), 0x1D);
    src.set(new TextEncoder().encode("cloned!!"), 0x100);
    await assert.rejects(new rd.Radio(new FakeRadio(mem)).program(src), /clone/);
    const fake = new FakeRadio(new Map(mem));
    const other = fromHex("005640a31ef7");
    await assert.rejects(new rd.Radio(fake).program(src, { clone: true, options: other }), /features/);
    assert.equal(fake.writes, 0);
    const back = await new rd.Radio(new FakeRadio(mem)).programVerified(src, { ...quick, clone: true, options: OPTIONS.subarray(0, 6) });
    const want = src.slice();
    want.set(cp.subarray(0x1D, 0x27), 0x1D);
    assert.deepEqual(back.codeplug, want);
    await new rd.Radio(new FakeRadio(syntheticImage(3, 11).mem)).program(src, { clone: true, options: other, ignoreFeatures: true });
});

test("S9000e: the second region is read and programmed in its own session", async () => {
    const { cp, mem } = syntheticImage(3, 7, true);
    assert.equal(cp.length, 0x300 + 0x2000);
    const fake = new FakeRadio(mem);
    const radio = new rd.Radio(fake);
    assert.deepEqual((await radio.readAll()).codeplug, cp);
    const img = cp.slice();
    img.set(new TextEncoder().encode("S9000e region ok"), img.length - 16);
    assert.deepEqual((await radio.programVerified(img, quick)).codeplug, img);
    assert.ok(fake.sent.some((m) => hex(m.subarray(0, 4)) === "00b10508"));
    // and refused on a standard-head radio
    const std = new FakeRadio(syntheticImage().mem);
    await assert.rejects(new rd.Radio(std).program(img), /control head/);
    assert.equal(std.writes, 0);
});

test("readRange / writeRange: any address in block-sized sessions; registers refused", async () => {
    const { mem } = syntheticImage();
    for (let a = 0xB600; a < 0xB800; a++) if (!mem.has(a)) mem.set(a, a & 0xFF);
    const fake = new FakeRadio(mem);
    const radio = new rd.Radio(fake);
    const got = await radio.readRange(0xB5F0, 0xB710);
    assert.equal(got.length, 0x120);
    assert.equal(got[0x10 + 0x81], OPTIONS[0]);
    assert.equal(fake.sent.filter((m) => hex(m.subarray(0, 4)) === "00d10108").length, 3);   // per 0x100 block
    await radio.writeRange(0xB6F0, fromHex("a1b2c3"));
    assert.deepEqual([mem.get(0xB6F0), mem.get(0xB6F1), mem.get(0xB6F2)], [0xA1, 0xB2, 0xC3]);
    await assert.rejects(radio.readRange(0x0FF0, 0x1010), RangeError);
    assert.equal(rd.writableRegion(0xB6F0, 0xB6F3)?.id, "mcu_eeprom");
    assert.equal(rd.writableRegion(0x9000, 0x9001), undefined);       // ROM
    assert.equal(rd.writableRegion(0x7FFF, 0x8001), undefined);       // straddles
});

test("cancel stops a verify; finish() then restarts the radio", async () => {
    const { cp, mem } = syntheticImage();
    const fake = new FakeRadio(mem);
    const radio = new rd.Radio(fake);
    const img = await radio.program(cp);
    let n = 0;
    const p = radio.verify(img, { restartMs: 0, progress: () => (++n === 1 ? radio.cancel() : undefined) });
    await assert.rejects(p, rd.Cancelled);
    assert.equal(radio.needsReset, true);
    await radio.finish();
    assert.equal(hex(/** @type {Uint8Array} */ (fake.sent.at(-1)).subarray(0, 4)), "00100108");
    // the next operation isn't cancelled
    assert.deepEqual((await radio.readAll()).codeplug, cp);
});
