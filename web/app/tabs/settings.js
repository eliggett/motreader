// @ts-check
/**
 * Tabs built from the radio-wide field screens (lib/radiowide.js SCREENS):
 * Radio-Wide, Conventional and the options part of Control Head. Read-only
 * for now. A field RSS doesn't show for this radio is left out.
 */
import { h, fill } from "../dom.js";
import { SCREENS } from "../../lib/radiowide.js";
import { empty, infoTable, note, section, NO_DOC } from "./common.js";

/**
 * The screens of `tab` for `doc`, as sections.
 * @param {"radiowide" | "conventional" | "head"} tab
 * @param {import("../state.js").Document} doc
 */
export function screenSections(tab, doc) {
    return SCREENS.filter((s) => s.tab === tab).map((s) => {
        const rows = s.fields
            .filter(([key]) => key in doc.radioWide && doc.radioWide[key] !== null)
            .map(([key, label]) => ({ label, value: String(doc.radioWide[key]) }));
        return section(s.title, rows.length ? infoTable(rows) : note("Not available on this radio."));
    });
}

/**
 * @param {string} id @param {string} title @param {"radiowide" | "conventional" | "head"} tab
 * @param {(doc: import("../state.js").Document) => Node[]} [extra]  more sections after the screens
 * @returns {import("./common.js").Tab}
 */
export function settingsTab(id, title, tab, extra) {
    return {
        id, title,
        render(el, doc) {
            if (!doc) return fill(el, empty(NO_DOC));
            fill(el, note("Read-only for now: editing arrives in the next milestone."), screenSections(tab, doc), extra?.(doc) ?? []);
        },
    };
}

export const radioWideTab = settingsTab("radiowide", "Radio-Wide", "radiowide");
export const conventionalTab = settingsTab("conventional", "Conventional", "conventional");
export const headTab = settingsTab("head", "Control Head", "head", () => [
    section("Buttons", h("p", { class: "note" }, "Control head button assignment arrives in a later milestone.")),
]);
