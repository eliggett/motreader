// @ts-check
/** Hex view: the codeplug in `hexdump -C` form. Read-only. */
import { h, fill } from "../dom.js";
import { hexdump } from "../../lib/bytes.js";
import { empty, NO_DOC } from "./common.js";

/** @type {import("./common.js").Tab} */
export default {
    id: "hex",
    title: "Hex",
    render(el, doc) {
        if (!doc) return fill(el, empty(NO_DOC));
        fill(el,
            h("p", { class: "note" }, "Raw archive file as imported. The decrypted codeplug replaces this once the decoder is ported."),
            h("pre", { class: "hexdump" }, hexdump(doc.raw)));
    },
};
