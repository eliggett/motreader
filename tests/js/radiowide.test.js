// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELDS, SCREENS } from "../../web/lib/radiowide.js";

test("every radio-wide field is on exactly one screen, and every screen entry is a field", () => {
    const placed = SCREENS.flatMap((s) => s.fields.map(([k]) => k));
    assert.deepEqual([...placed].sort(), FIELDS.map((f) => f.key).sort());
    assert.equal(new Set(placed).size, placed.length);
});
