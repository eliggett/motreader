// @ts-check
/**
 * The pop-up menu of functions for a control-head button, anchored to what
 * was clicked (a key on the drawing or a cell of the button list). Groups of
 * choices; a direct-entry function ("Zone X") asks for its number in place.
 * Arrow keys move, Enter picks, Escape or a click elsewhere closes.
 */
import { h } from "./dom.js";

/** @typedef {import("../lib/buttons.js").Choice} Choice */
/** @typedef {{ title: string, items: Choice[], note?: string }} MenuGroup */

/** @type {{ el: HTMLElement, close: () => void } | null} */
let open = null;

/** Close the open menu, if any. */
export function closeButtonMenu() {
    open?.close();
}

/**
 * Open the menu under `anchor`. `onPick(text, group)` gets the function text
 * ("Scan", "Zone 3") and the index of its group.
 * @param {Element} anchor
 * @param {{ title: string, current: string, groups: MenuGroup[], onPick: (text: string, group: number) => void }} spec
 */
export function openButtonMenu(anchor, spec) {
    closeButtonMenu();
    const el = h("div", { class: "btn-menu", role: "menu", "aria-label": spec.title });
    const items = /** @type {HTMLButtonElement[]} */ ([]);
    el.append(h("div", { class: "btn-menu-title" }, spec.title));
    spec.groups.forEach((g, gi) => {
        if (!g.items.length) return;
        el.append(h("div", { class: `btn-menu-group${gi ? " other" : ""}` }, g.title));
        if (g.note) el.append(h("div", { class: "btn-menu-note" }, g.note));
        for (const c of g.items) {
            const current = c.data ? spec.current.toLowerCase().startsWith(c.label.slice(0, -1).trim().toLowerCase() + " ")
                : spec.current.toLowerCase() === c.label.toLowerCase();
            const b = h("button", { class: `btn-menu-item${current ? " current" : ""}${gi ? " other" : ""}`, role: "menuitem", title: c.name },
                h("span", { class: "fn" }, c.data ? `${c.label.slice(0, -1).trim()} #…` : c.label), h("span", { class: "full" }, c.name));
            b.addEventListener("click", () => (c.data ? askNumber(b, c, gi) : pick(c.label, gi)));
            items.push(b);
            el.append(b);
        }
    });
    const pick = (/** @type {string} */ text, /** @type {number} */ gi) => {
        close();
        spec.onPick(text, gi);
    };
    /** Direct entry: the item becomes a number field. */
    const askNumber = (/** @type {HTMLButtonElement} */ b, /** @type {Choice} */ c, /** @type {number} */ gi) => {
        const stem = c.label.slice(0, -1).trim();
        const cur = spec.current.toLowerCase().startsWith(`${stem.toLowerCase()} `) ? spec.current.slice(stem.length).trim() : "";
        const input = h("input", { type: "number", min: 1, max: 99, value: cur || "1", class: "btn-menu-num", "aria-label": `${stem} number` });
        const ok = h("button", { class: "small primary" }, "Set");
        const go = () => {
            const n = Number(input.value);
            if (Number.isInteger(n) && n >= 1 && n <= 99) pick(`${stem} ${n}`, gi);
            else input.setCustomValidity("1 to 99");
        };
        ok.addEventListener("click", go);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") go();
            e.stopPropagation();
            if (e.key === "Escape") close();
        });
        const row = h("div", { class: "btn-menu-entry" }, h("span", { class: "fn" }, stem), input, ok);
        b.replaceWith(row);
        input.focus();
        input.select();
    };
    const onKey = (/** @type {KeyboardEvent} */ e) => {
        const i = items.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
        if (e.key === "Escape") {
            e.preventDefault();
            close();
            if (anchor instanceof HTMLElement || anchor instanceof SVGElement) anchor.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const live = items.filter((x) => x.isConnected);
            const j = live.indexOf(/** @type {HTMLButtonElement} */ (items[i]));
            live[(j + (e.key === "ArrowDown" ? 1 : live.length - 1)) % live.length]?.focus();
        }
    };
    const onDown = (/** @type {PointerEvent} */ e) => {
        if (!el.contains(/** @type {Node} */ (e.target))) close();
    };
    function close() {
        if (open?.el !== el) return;
        open = null;
        el.remove();
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("resize", close);
    }
    document.body.append(el);
    // under the anchor, kept inside the window
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const top = r.bottom + 4 + el.offsetHeight > window.innerHeight ? Math.max(4, r.top - 4 - el.offsetHeight) : r.bottom + 4;
    el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
    el.style.top = `${Math.max(4, top)}px`;
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", close);
    open = { el, close };
    (items.find((b) => b.classList.contains("current")) ?? items[0])?.focus();
}
