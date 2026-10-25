// @ts-check
/** Zones: each zone's name and member modes. Read-only for now. */
import { h, fill } from "../dom.js";
import { empty, note, NO_DOC } from "./common.js";

/** @type {import("./common.js").Tab} */
export default {
    id: "zones",
    title: "Zones",
    render(el, doc) {
        if (!doc) return fill(el, empty(NO_DOC));
        if (doc.radioWide.zone_operation === "Disabled") return fill(el, empty("Zone Operation is off on this radio: it has no zones."));
        const zones = doc.cp.zones;
        if (!zones.length) return fill(el, empty("No zones were found in this codeplug."));
        const nameOf = new Map(doc.cp.modes.map((m) => [m.number, m.name]));
        const home = doc.radioWide.home_zone;
        fill(el,
            note(`${zones.length} zones. Read-only for now: zone and scan list editing arrives in a later milestone.`),
            h("div", { class: "table-wrap" },
                h("table", { class: "grid" },
                    h("thead", {}, h("tr", {}, h("th", { class: "num" }, "#"), h("th", { class: "name" }, "Name"),
                        h("th", { class: "num" }, "Modes"), h("th", {}, "Members"))),
                    h("tbody", {}, zones.map((z) => h("tr", {},
                        h("td", { class: "num" }, z.number),
                        h("td", { class: "name" }, z.name, z.number === home ? h("span", { class: "tag" }, "home") : null),
                        h("td", { class: "num" }, z.modes.length),
                        h("td", { class: "members" }, z.modes.map((n) => `${n} ${nameOf.get(n) ?? "?"}`).join(", "))))))));
    },
};
