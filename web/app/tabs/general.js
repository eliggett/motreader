// @ts-check
/** General Info: what the codeplug is (model, serial, size, features...). */
import { fill } from "../dom.js";
import { empty, infoTable, NO_DOC } from "./common.js";

/** @type {import("./common.js").Tab} */
export default {
    id: "general",
    title: "General Info",
    render(el, doc) {
        if (!doc) return fill(el, empty(NO_DOC));
        fill(el,
            infoTable([
                ["File name", doc.fileName],
                ["File size", `${doc.raw.length} bytes`],
            ]),
            empty("Model, serial, modes, zones, band and the rest arrive with the codeplug decoder."));
    },
};
