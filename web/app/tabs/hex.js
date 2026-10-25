// @ts-check
/** Hex view: the decrypted codeplug in `hexdump -C` form. Read-only. */
import { h, fill } from "../dom.js";
import { hexdump } from "../../lib/bytes.js";
import { empty, note, NO_DOC } from "./common.js";

/** @type {import("./common.js").Tab} */
export default {
    id: "hex",
    title: "Hex",
    render(el, doc) {
        if (!doc) return fill(el, empty(NO_DOC));
        fill(el,
            note(`The decrypted codeplug, ${doc.plain.length} bytes. Bytes 0–12 are the nonce (the cipher key RSS `
                + "picks on each save); offsets are the ones notes/FORMAT.md uses."),
            h("pre", { class: "hexdump" }, hexdump(doc.plain)));
    },
};
