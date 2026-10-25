// @ts-check
/**
 * Tabs built from the radio-wide field screens (lib/radiowide.js SCREENS):
 * Radio-Wide, Conventional and the options part of Control Head, as forms.
 * A field RSS doesn't show for this radio (or in this state, e.g. the siren
 * settings with Siren/P.A. off) is left out; read-only ones are plain text.
 */
import { h, fill } from "../dom.js";
import { SCREENS, FIELD_BY_KEY, EN, SIREN_CHOICES, REARM_CHOICES, HEAD_CHOICES, valueLabel } from "../../lib/radiowide.js";
import { editRadioWide } from "../editing.js";
import { empty, note, section, NO_DOC, modesOnlyText } from "./common.js";
import { listSections } from "./lists.js";

/** @typedef {import("../state.js").Document} Document */

/** Units and steps worth saying next to a number field. */
function hint(/** @type {import("../../lib/radiowide.js").Field} */ f) {
    const s = f.scale ?? 1;
    switch (f.kind) {
        case "nibble": case "hinibble": return `0–${15 * s}${s > 1 ? `, steps of ${s}` : ""}`;
        case "byte": return `0–${255 * s}${s > 1 ? `, steps of ${s}` : ""}`;
        case "word": return `steps of ${s}`;
        case "bcd": return `${2 * (f.width ?? 1)} digits`;
        case "bcdf": return `1–${2 * (f.width ?? 1)} digits`;
        case "dial": return `up to ${f.nibs?.length} of 0-9 * #`;
        case "busywait": return "seconds in 0.5 s steps, or Infinite";
        default: return "";
    }
}

/** The choices of a field shown as a drop-down, or null for a text field. */
function choicesOf(/** @type {import("../../lib/radiowide.js").Field} */ f, /** @type {unknown} */ current) {
    switch (f.kind) {
        case "bit": return [...EN];
        case "enum": return (f.choices ?? []).filter((c) => !c.startsWith("?"));
        case "siren": return [...SIREN_CHOICES];
        case "rearm": return [...REARM_CHOICES];
        case "headtype": return current === "S9000e" ? null : [...HEAD_CHOICES];
        default: return null;
    }
}

/** One field as a form row. */
function fieldRow(/** @type {Document} */ doc, /** @type {string} */ key, /** @type {string} */ label) {
    const f = /** @type {import("../../lib/radiowide.js").Field} */ (FIELD_BY_KEY.get(key));
    const v = doc.radioWide[key];
    const cur = String(v);
    const changed = cur !== String(doc.original.radioWide[key]);
    const id = `rw-${key}`;
    const msg = h("span", { class: "field-msg" }, f.editable === false && f.note ? f.note : "");
    const choices = choicesOf(f, v);
    let control;
    if (f.editable === false || (f.kind === "headtype" && !choices)) {
        control = h("span", { class: "ro-value", id }, valueLabel(key, cur));
        if (f.kind === "headtype" && !choices) msg.textContent = "RSS can't change the S9000e (A9) head";
    } else if (choices) {
        const sel = h("select", { id },
            (choices.includes(cur) ? choices : [cur, ...choices]).map((c) => h("option", { value: c, selected: c === cur }, valueLabel(key, c))));
        sel.addEventListener("change", () => apply(sel.value));
        control = sel;
    } else {
        const input = h("input", { id, type: "text", value: cur, spellcheck: "false", size: 12 });
        input.addEventListener("change", () => apply(input.value));
        input.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                input.value = cur;
                msg.textContent = "";
            }
        });
        control = input;
        if (!msg.textContent) msg.textContent = hint(f);
    }
    function apply(/** @type {string} */ value) {
        const res = editRadioWide(key, value);
        // the tab redraws on success; on a refusal, say why where the field is
        if (res.error) {
            const again = document.getElementById(id);
            if (again instanceof HTMLInputElement || again instanceof HTMLSelectElement) again.value = cur;
            const m = again?.parentElement?.querySelector(".field-msg");
            if (m) {
                m.textContent = res.error;
                m.className = "field-msg error";
            }
        }
    }
    return h("div", { class: `form-row${changed ? " changed" : ""}` }, h("label", { for: id }, label), control, msg);
}

/**
 * The screens of `tab` for `doc`, as sections.
 * @param {"radiowide" | "conventional" | "head"} tab
 * @param {Document} doc
 */
export function screenSections(tab, doc) {
    return SCREENS.filter((s) => s.tab === tab).map((s) => {
        const rows = s.fields
            .filter(([key]) => key in doc.radioWide && doc.radioWide[key] !== null)
            .map(([key, label]) => fieldRow(doc, key, label));
        return section(s.title, rows.length ? h("div", { class: "form" }, rows) : note("Not available on this radio."));
    });
}

/**
 * @param {string} id @param {string} title @param {"radiowide" | "conventional" | "head"} tab
 * @param {(doc: Document) => Node[]} [extra]  more sections after the screens
 * @returns {import("./common.js").Tab}
 */
export function settingsTab(id, title, tab, extra) {
    return {
        id, title,
        render(el, doc) {
            if (!doc) return fill(el, empty(NO_DOC));
            if (doc.support.modesOnly) return fill(el, empty(modesOnlyText(doc)));
            // keep the scroll position and focus across the redraw after an edit
            const scroller = el.closest("main");
            const top = scroller?.scrollTop ?? 0;
            const focused = document.activeElement?.id;
            fill(el, screenSections(tab, doc), extra?.(doc) ?? []);
            if (scroller) scroller.scrollTop = top;
            if (focused) document.getElementById(focused)?.focus();
        },
    };
}

export const radioWideTab = settingsTab("radiowide", "Radio-Wide", "radiowide");
export const conventionalTab = settingsTab("conventional", "Conventional", "conventional", listSections);
export const headTab = settingsTab("head", "Control Head", "head", () => [
    section("Buttons", h("p", { class: "note" }, "Control head button assignment arrives in a later milestone.")),
]);
