// @ts-check
/**
 * The Control Head tab's buttons: the head drawn from the owner's drawings
 * (heads/), each programmable key labelled with its function; click a key
 * (or its row in the list below) for the functions RSS offers there. With
 * "Experimental" on, the menus also offer what RSS doesn't (the fixed keys,
 * functions RSS doesn't offer on a key), set apart and flagged everywhere.
 */
import { h } from "../dom.js";
import { note, section } from "./common.js";
import { HEAD_DRAWINGS } from "../heads/index.js";
import { editButton } from "../editing.js";
import { openButtonMenu } from "../buttonmenu.js";
import { functionChoices, missingRequired, isA9 } from "../../lib/buttons.js";
import { valueLabel } from "../../lib/radiowide.js";

/** @typedef {import("../state.js").Document} Document */
/** @typedef {import("../../lib/buttonfields.js").DocButton} DocButton */
/** @typedef {import("../heads/index.js").HeadShape} HeadShape */

const NS = "http://www.w3.org/2000/svg";
const STORE_KEY = "motreader.buttons.experimental";
/** Drawing order of the drawings' layers (bottom first); others go before Text. */
const ORDER = ["OverallOutline", "Outlines", "Misc", "Knobs", "LEDs", "LEDs_NP", "Buttons_NP", "Buttons"];
const SKIP = new Set(["TotalOutline"]);

let experimental = (() => {
    try {
        return localStorage.getItem(STORE_KEY) === "1";
    } catch {
        return false;
    }
})();

/** An SVG element. @param {string} tag @param {Record<string, string | number | undefined>} attrs @param {...(Node | string)} kids */
function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
    el.append(...kids);
    return el;
}

/** The geometry of a shape as an SVG element (no styling). */
function shapeEl(/** @type {HeadShape} */ s, /** @type {string} */ cls) {
    if (s.kind === "rect") return svg("rect", { x: s.x, y: s.y, width: s.w, height: s.h, rx: s.rx || undefined, ry: s.ry || undefined, class: cls });
    if (s.kind === "circle") return svg("circle", { cx: s.cx, cy: s.cy, r: s.r, class: cls });
    if (s.kind === "ellipse") return svg("ellipse", { cx: s.cx, cy: s.cy, rx: s.rx, ry: s.ry, class: cls });
    return svg("text", { x: s.x, y: s.y, "font-size": s.size, class: cls }, s.text ?? "");
}

/** A readable name for a drawing label: "btn-dim" -> "Dim", "LED-xmit" -> "XMIT LED". */
function prettyLabel(/** @type {string | undefined} */ label) {
    if (!label) return "";
    const [kind, ...rest] = label.split("-");
    const name = rest.join(" ");
    if (/^led$/i.test(kind ?? "")) return `${name.toUpperCase()} LED`;
    if (kind === "knob") return `${name[0]?.toUpperCase()}${name.slice(1)} knob`;
    if (kind === "con") return `${name[0]?.toUpperCase()}${name.slice(1)} connector`;
    return `${name[0]?.toUpperCase()}${name.slice(1)}`;
}

/** Centre and size of a key shape. */
function box(/** @type {HeadShape} */ s) {
    if (s.kind === "rect") return { cx: (s.x ?? 0) + (s.w ?? 0) / 2, cy: (s.y ?? 0) + (s.h ?? 0) / 2, w: s.w ?? 0, h: s.h ?? 0 };
    const rx = s.r ?? s.rx ?? 0;
    const ry = s.r ?? s.ry ?? 0;
    return { cx: s.cx ?? 0, cy: s.cy ?? 0, w: 2 * rx, h: 2 * ry };
}

/** What a key shows: the function's short label ("?" for a code motreader can't name). */
const keyText = (/** @type {DocButton} */ b) => (b.function.startsWith("0x") ? "?" : b.function);

/**
 * Open the function menu for `b`, anchored to `anchor`.
 * @param {Document} doc @param {DocButton} b @param {Element} anchor
 */
function menuFor(doc, b, anchor) {
    const { offered, other } = functionChoices(doc.cp, b.button);
    /** @type {import("../buttonmenu.js").MenuGroup[]} */
    const groups = [{ title: b.editable ? "RSS" : "RSS keeps this key fixed", items: b.editable ? offered : [] }];
    if (experimental) {
        groups.push({
            title: "Not allowed by RSS (experimental)", items: other,
            note: "RSS never writes these: what the radio does with them is untested.",
        });
    }
    openButtonMenu(anchor, {
        title: `${b.button}: ${b.function}${b.name ? ` (${b.name})` : ""}`,
        current: b.function,
        groups,
        onPick: (text, gi) => {
            const res = editButton(b.button, text, gi > 0 || !b.editable);
            if (res.error) {
                const msg = document.getElementById("buttons-msg");
                if (msg) msg.textContent = `${b.button}: ${res.error}`;
            }
        },
    });
}

/** Can the menu do anything for this button? */
const usable = (/** @type {Document} */ doc, /** @type {DocButton} */ b) => doc.support.editable && (b.editable || experimental);

/** The head drawing with the codeplug's buttons on it, or null if there's no drawing for this head. */
function drawing(/** @type {Document} */ doc, /** @type {string} */ head, /** @type {Map<string, DocButton>} */ byName) {
    const d = HEAD_DRAWINGS[head];
    if (!d) return null;
    const layers = Object.keys(d.layers).filter((l) => !SKIP.has(l));
    const rank = (/** @type {string} */ l) => (l === "Text" ? 99 : ORDER.includes(l) ? ORDER.indexOf(l) : 50);
    layers.sort((a, b) => rank(a) - rank(b));
    const root = svg("svg", { viewBox: d.viewBox.join(" "), class: "head-svg", role: "group", "aria-label": `${valueLabel("control_head_type", head)} control head` });
    for (const layer of layers) {
        const g = svg("g", { class: `hd-layer hd-${layer.toLowerCase()}` });
        for (const s of /** @type {HeadShape[]} */ (d.layers[layer])) {
            const label = s.label ?? "";
            if (layer === "Buttons" && s.button && s.kind !== "text") {
                g.append(keyEl(doc, s, byName.get(s.button)));
                continue;
            }
            let cls = "hd-shape";
            if (layer === "OverallOutline") cls = "hd-face";
            else if (layer === "Outlines") cls = /display/i.test(label) ? "hd-display" : "hd-area";
            else if (layer === "Misc") cls = "hd-misc";
            else if (layer === "Knobs") cls = "hd-knob";
            else if (layer.startsWith("LEDs")) cls = `hd-led${/xmit/i.test(label) ? " xmit" : /busy/i.test(label) ? " busy" : ""}`;
            else if (layer === "Buttons_NP" || layer === "Buttons") cls = "hd-key np";
            else if (layer === "Text") cls = "hd-print";
            const el = shapeEl(s, cls);
            if (label && s.kind !== "text") {
                el.append(svg("title", {}, `${prettyLabel(label)}${layer.endsWith("_NP") || layer === "Knobs" ? ": not programmable" : ""}`));
            }
            g.append(el);
        }
        root.append(g);
    }
    return root;
}

/** One programmable key: its shape, its function, its state. */
function keyEl(/** @type {Document} */ doc, /** @type {HeadShape} */ s, /** @type {DocButton | undefined} */ b) {
    const { cx, cy, w, h: kh } = box(s);
    const i = b ? doc.buttons.indexOf(b) : -1;
    const changed = b && b.function !== doc.original.buttons[i];
    const state = !b ? "absent" : !b.editable ? "fixed" : "";
    const g = svg("g", {
        class: ["hd-btn", state, changed ? "changed" : "", b?.hack ? "hack" : "", b && usable(doc, b) ? "live" : ""].filter(Boolean).join(" "),
        "data-button": s.button,
    });
    g.append(shapeEl(s, "hd-key"));
    if (b) {
        const text = keyText(b);
        const size = Math.min(kh * 0.42, (w * 0.86) / Math.max(1, text.length * 0.6));
        g.append(svg("text", { x: cx, y: cy, "font-size": size.toFixed(2), class: "hd-label", "text-anchor": "middle", "dominant-baseline": "central" }, text));
        const tip = `${b.button}: ${b.function}${b.name ? ` (${b.name})` : ""}${!b.editable ? " · fixed in RSS" : ""}${b.hack ? " · experimental" : ""}`;
        g.append(svg("title", {}, tip));
        if (usable(doc, b)) {
            g.setAttribute("tabindex", "0");
            g.setAttribute("role", "button");
            g.setAttribute("aria-label", tip);
            g.id = `hd-key-${(s.label ?? s.button ?? "").replace(/[^\w-]/g, "")}`;
            g.addEventListener("click", () => menuFor(doc, b, g));
            g.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    menuFor(doc, b, g);
                }
            });
        }
    } else {
        g.append(svg("title", {}, `${s.button}: not on this radio`));
    }
    return g;
}

/** The list of every button in the codeplug, with what can't be seen on the drawing. */
function buttonList(/** @type {Document} */ doc, /** @type {Set<string>} */ drawn, /** @type {string} */ headName) {
    const rows = doc.buttons.map((b, i) => {
        const changed = b.function !== doc.original.buttons[i];
        const notes = [
            !b.editable ? "fixed in RSS" : "",
            b.hack ? "experimental" : "",
            drawn.size && !drawn.has(b.button) ? `not on the ${headName} head` : "",
        ].filter(Boolean).join(", ");
        const fn = h("button", {
            class: `fn-chip${changed ? " changed" : ""}${b.hack ? " hack" : ""}`,
            id: `btn-fn-${i}`,
            disabled: !usable(doc, b),
            title: usable(doc, b) ? "Choose a function" : b.editable ? "" : "Fixed in RSS: turn on Experimental to change it",
        }, b.function);
        fn.addEventListener("click", () => menuFor(doc, b, fn));
        return h("tr", { class: changed ? "changed" : "" },
            h("th", {}, b.button), h("td", {}, fn), h("td", { class: "muted" }, b.name), h("td", { class: "row-note" }, notes));
    });
    return h("table", { class: "info buttons-list" },
        h("thead", {}, h("tr", {}, h("th", {}, "Button"), h("th", {}, "Function"), h("th", {}, "Full name"), h("th", {}, ""))),
        h("tbody", {}, rows));
}

/** Warnings about the buttons as a whole. */
function warnings(/** @type {Document} */ doc) {
    const out = [];
    const a9 = isA9(doc.cp);
    for (const f of missingRequired(doc.cp, doc.buttons)) {
        out.push(f === "Sel"
            ? `No button has Sel. RSS keeps Sel on ${a9 ? "Ind 1" : "Ind 5"} ("SEL / HOME Button Is REQUIRED For Proper Control Head Operation").`
            : "No button has Home. RSS keeps Home on the Home key (\"SEL / HOME Button Is REQUIRED For Proper Control Head Operation\").");
    }
    const hacks = doc.buttons.filter((b) => b.hack);
    if (hacks.length) out.push(`Experimental (RSS doesn't allow these): ${hacks.map((b) => `${b.button} = ${b.function}`).join(", ")}.`);
    if (a9 && doc.buttons.some((b) => /^[1-9]$/.test(b.button) && b.function !== "Blank")) {
        out.push("On the S9000e, a keypad key 1-9 with a function no longer dials its DTMF digit (on the A7 it still does).");
    }
    return out;
}

/** The Buttons section of the Control Head tab. */
export function buttonsSection(/** @type {Document} */ doc) {
    if (!doc.buttons.length) {
        return section("Buttons", note(isA9(doc.cp)
            ? "The S9000e key map wasn't recognised in this codeplug: its buttons are kept as they are."
            : "No control-head buttons were found in this codeplug."));
    }
    const head = String(doc.radioWide.control_head_type ?? "");
    const headName = valueLabel("control_head_type", head);
    const byName = new Map(doc.buttons.map((b) => [b.button, b]));
    const d = HEAD_DRAWINGS[head];
    const drawn = new Set(d ? (d.layers.Buttons ?? []).map((s) => s.button).filter((x) => x !== undefined) : []);
    const pic = drawing(doc, head, byName);
    const absentKeys = [...drawn].filter((x) => !byName.has(x));
    const toggle = h("input", { type: "checkbox", id: "buttons-experimental", checked: experimental });
    toggle.addEventListener("change", () => {
        experimental = toggle.checked;
        try {
            localStorage.setItem(STORE_KEY, experimental ? "1" : "0");
        } catch { /* a convenience only */ }
        // redraw with the new menus (the tab listens for edits; nothing changed in the document)
        const sec = document.getElementById("buttons-section");
        sec?.replaceWith(buttonsSection(doc));
    });
    const warn = warnings(doc);
    const el = section("Buttons",
        note(`${headName} head. Click a key (or a function in the list) to change it. Keys RSS keeps fixed are dimmed`
            + `${absentKeys.length ? `; keys this radio doesn't have (${absentKeys.join(", ")}) are hatched` : ""}.`),
        pic ? h("div", { class: "head-wrap" }, pic) : note(`There's no drawing for the ${headName} head yet.`),
        h("p", { class: "field-msg error", id: "buttons-msg" }),
        warn.length ? h("div", { class: "warn-box" }, h("ul", {}, warn.map((w) => h("li", {}, w)))) : null,
        h("label", { class: "check" }, toggle,
            " Experimental: also offer what RSS doesn't allow (its fixed keys, functions RSS doesn't offer on a key)"),
        buttonList(doc, drawn, headName));
    el.id = "buttons-section";
    return el;
}
