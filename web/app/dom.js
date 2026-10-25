// @ts-check
/**
 * Tiny element builder. Strings become text nodes, never HTML, so names and
 * other user data from a codeplug can't inject markup.
 *
 *   h("button", { class: "primary", onclick: go }, "Export")
 */

/** @typedef {Node | string | number | null | undefined | false} Child */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any>} [attrs]  `class`, `dataset`, `on<event>`, or any attribute;
 *     `false`/`null`/`undefined` values are skipped, `true` sets an empty attribute.
 * @param {...(Child | Child[])} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === false || v === null || v === undefined) continue;
        if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k === "class") el.className = v;
        else el.setAttribute(k, v === true ? "" : String(v));
    }
    append(el, children);
    return el;
}

/** Append children (strings as text) to `el`. */
export function append(/** @type {Element} */ el, /** @type {(Child | Child[])[]} */ children) {
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.append(typeof c === "number" ? String(c) : c);
    }
}

/** Replace everything inside `el` with `children`. */
export function fill(/** @type {Element} */ el, /** @type {(Child | Child[])[]} */ ...children) {
    el.replaceChildren();
    append(el, children);
}

/** `document.querySelector` that throws instead of returning null. */
export function $(/** @type {string} */ sel, /** @type {ParentNode} */ root = document) {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`missing element: ${sel}`);
    return /** @type {HTMLElement} */ (el);
}
