// @ts-check
/** General Info: what the codeplug is (model, serial, size, features...). */
import { fill } from "../dom.js";
import { generalInfo } from "../../lib/info.js";
import { empty, infoTable, section, NO_DOC } from "./common.js";

/** @type {import("./common.js").Tab} */
export default {
    id: "general",
    title: "General Info",
    render(el, doc) {
        if (!doc) return fill(el, empty(NO_DOC));
        fill(el, generalInfo(doc).map((s) => section(s.title, infoTable(s.rows))));
    },
};
