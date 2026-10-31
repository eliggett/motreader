// @ts-check
// web/lib/align.js: the same checks as tests/test_align.py, against a
// simulated radio.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sb from "../../web/lib/sb9600.js";
import { Radio } from "../../web/lib/radio.js";
import { hex } from "../../web/lib/bytes.js";
import { ADJUSTMENTS, Aligner, PttError, PTT_OFF, PTT_ON, decode, encode, rev7 } from "../../web/lib/align.js";

// MCU EEPROM of the 617ASN as RSS read it (squelch 10, deviation 11, warp
// 72, high power 98, current limit 7, low power 46)
const EEPROM = [[0xB62C, 0xB8], [0xB62D, 0x09], [0xB62E, 0x45], [0xB62F, 0x5C], [0xB630, 0xFF], [0xB631, 0xFF],
    [0xB632, 0xFF], [0xB633, 0xFF], [0xB644, 0x0B], [0xB645, 0x0A], [0xB64F, 0x0A]];

/** Answers MCU reads and scrambled writes; keys on PTT ON, unkeys on PTT OFF unless `stuck`. */
class FakeLink {
    constructor(stuck = false, quietFrom = 3) {
        this.squelch = 10;         // live squelch; BUSY below quietFrom
        this.quietFrom = quietFrom;
        /** @type {Map<number, number>} */
        this.mem = new Map(/** @type {[number, number][]} */ (EEPROM));
        /** @type {Uint8Array[]} */
        this.sent = [];
        this.keyed = false;
        this.stuck = stuck;
        /** @type {number | null} */
        this.session = null;
    }

    /** @param {Uint8Array} p */
    async transact(p) {
        this.sent.push(p);
        const [p0, p1, p2, op] = /** @type {[number, number, number, number]} */ (Array.from(p));
        if (op === sb.OP_MODE) this.session = p1 === 0x90 || p1 === 0x92 ? null : p1;
        else if (hex(p) === hex(PTT_ON)) this.keyed = true;
        else if (hex(p) === hex(PTT_OFF)) { if (!this.stuck) this.keyed = false; }
        else if (op === 0x28) this.squelch = p2;
        else if (op === sb.OP_WRITE) {
            assert.equal(this.session, 0xD1);
            const [hi, lo, v] = sb.unscramble(p0, p1, p2);
            this.mem.set((hi << 8) | lo, v);
        } else if (op === sb.OP_READ) {
            assert.equal(this.session, 0x93);
            const a = (p0 << 8) | p1;
            const busy = this.squelch < this.quietFrom;
            const get = (/** @type {number} */ x) => x === 0x0031 ? (busy ? 0x0C : 0) : x === 0x0038 ? (busy ? 0x28 : 0x08)
                : x === 0x000D ? (this.keyed ? 0x08 : 0)
                : x === 0x003B ? (this.keyed ? 0x18 : 0x10) : this.mem.get(x) ?? 0xFF;
            return sb.readReply([get(a), get(a + 1)], false, p0);
        }
        return null;
    }

    /** The messages to the radio other than PTT, test mode and memory. */
    live() {
        return this.sent.filter((p) => ![sb.OP_MODE, sb.OP_READ, sb.OP_WRITE, 0x0A, 0x40].includes(/** @type {number} */ (p[3])))
            .map((p) => hex(p));
    }
}

const aligner = (/** @type {FakeLink} */ link, opt = {}) => new Aligner(new Radio(link), opt);
const adj = (/** @type {string} */ key) => /** @type {import("../../web/lib/align.js").Adjustment} */ (ADJUSTMENTS.find((a) => a.key === key));

test("decode / encode match what RSS showed", () => {
    const want = { squelch: 10, deviation: 11, warp: 72, high_power: 98, current_limit: 7, low_power: 46 };
    const mem = new Map(/** @type {[number, number][]} */ (EEPROM));
    for (const [key, v] of Object.entries(want)) {
        const a = adj(key), b = /** @type {number} */ (mem.get(a.addr));
        assert.equal(decode(a, b), v);
        assert.equal(encode(a, v, b), b);
    }
    assert.equal(rev7(72), 0x09);
    for (let v = 0; v < 128; v++) assert.equal(rev7(rev7(v)), v);
});

test("live messages as RSS sent them", async () => {
    const link = new FakeLink();
    const al = aligner(link);
    await al.enter("squelch");
    assert.equal(hex(/** @type {Uint8Array} */ (link.sent.at(-1))), "01411040");
    await al.set(11);
    await al.set(12);
    assert.deepEqual(link.live(), ["01020b28", "01020c28"]);

    link.sent.length = 0;
    await al.enter("deviation");
    await al.set(12);                       // not keyed: RSS sends nothing
    assert.deepEqual(link.live(), []);
    await al.key(1000);
    await al.set(13);
    await al.unkey();
    assert.deepEqual(link.live(), ["01d00a32", "01e00a32"]);

    link.sent.length = 0;
    await al.enter("high_power", "mid");
    assert.equal(hex(/** @type {Uint8Array} */ (link.sent.at(-1))), "01511040");
    await al.set(99);
    assert.deepEqual(link.live(), ["01011c33"]);

    link.sent.length = 0;
    await al.enter("current_limit");
    await al.set(8);
    assert.deepEqual(link.live(), ["01004042", "01015c33"]);
});

test("PTT OFF is sent twice and read back", async () => {
    const link = new FakeLink();
    const al = aligner(link);
    await al.enter("deviation");
    await al.key(5000);
    assert.ok(link.keyed);
    const n = link.sent.length;
    assert.equal(await al.unkey(), true);
    assert.ok(!link.keyed && al.keyedAt === null);
    assert.deepEqual(link.sent.slice(n).filter((p) => p[3] === 0x0A).map((p) => hex(p)), [hex(PTT_OFF), hex(PTT_OFF)]);
});

test("the watchdog unkeys", async () => {
    const link = new FakeLink();
    let changes = 0;
    const al = aligner(link, { limitMs: 1700, onChange: () => changes++ });    // watchdog at 0.5 s
    await al.enter("high_power");
    assert.equal(await al.key(), 500);
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(!link.keyed && al.keyedAt === null);
    assert.equal(changes, 2);
    assert.throws(() => aligner(link, { limitMs: 30000 }), RangeError);
});

test("a long key is capped; squelch doesn't transmit", async () => {
    const al = aligner(new FakeLink());
    await al.enter("low_power");
    assert.ok((await al.key(60000)) <= 8800);
    await al.unkey();
    await al.enter("squelch");
    assert.throws(() => al.key(), /does not transmit/);
});

test("a radio that stays keyed throws PttError", async () => {
    const al = aligner(new FakeLink(true));
    await al.enter("deviation");
    await al.key(5000);
    await assert.rejects(al.unkey(2), PttError);
});

test("program writes the value and the block sum, as RSS did", async () => {
    const link = new FakeLink();
    const al = aligner(link);
    await al.enter("warp");
    await al.set(73);
    assert.deepEqual(await al.program(), [0x09, 0x49]);
    assert.equal(link.mem.get(0xB62D), 0x49);
    assert.equal(link.mem.get(0xB661), 0xE6);         // what RSS wrote
    assert.equal(await al.program(), null);
});

test("leave unkeys and leaves test mode", async () => {
    const link = new FakeLink();
    const al = aligner(link);
    await al.enter("deviation");
    await al.key(5000);
    await al.leave();
    assert.ok(!link.keyed);
    assert.ok(link.sent.some((p) => hex(p) === "01000040"));
});

test("auto squelch finds the lowest value without BUSY", async () => {
    const link = new FakeLink(false, 3);
    const al = aligner(link);
    await al.enter("squelch");
    /** @type {[number, number][]} */
    const seen = [];
    assert.equal(await al.autoSquelch({ dwellMs: 0, progress: (v, n) => seen.push([v, n]) }), 3);
    assert.deepEqual(seen, [[0, 5], [1, 5], [2, 5], [3, 0]]);
    assert.equal(await al.busy(), false);
    assert.equal(link.mem.get(0xB64F), 0x0A);           // not programmed
    const all = aligner(new FakeLink(false, 99));
    await all.enter("squelch");
    assert.equal(await all.autoSquelch({ dwellMs: 0, samples: 1 }), null);
    assert.equal(all.value, 10);
});

test("slider ranges follow the model (D43 VHF: deviation 0-12)", async () => {
    const link = new FakeLink();
    Array.from("D43KMA7JA5BK", (c, i) => link.mem.set(0xB675 + i, c.charCodeAt(0)));
    const al = aligner(link);
    await al.enter("deviation");
    assert.equal(al.model, "D43KMA7JA5BK");
    assert.equal(al.top(), 12);
    assert.throws(() => al.set(13), RangeError);
    const other = aligner(new FakeLink());
    await other.enter("deviation");
    assert.equal(other.top(), 14);
});
