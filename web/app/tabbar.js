// @ts-check
/**
 * The tab strip and its panels. Only the visible tab is rendered; it is
 * redrawn when shown and whenever the document changes. The selected tab is
 * kept in the URL hash (#modes), so a reload stays where you were.
 */
import { h } from "./dom.js";
import { store } from "./state.js";
import { log } from "./log.js";
import { TABS } from "./tabs/index.js";

/** @type {string} */
let active = TABS[0]?.id ?? "";
/** @type {Map<string, { button: HTMLButtonElement, panel: HTMLElement }>} */
const parts = new Map();

/** Build the tab strip into `bar` and the panels into `main`. */
export function initTabs(/** @type {HTMLElement} */ bar, /** @type {HTMLElement} */ main) {
    bar.setAttribute("role", "tablist");
    for (const t of TABS) {
        const button = h("button", {
            role: "tab", id: `tab-${t.id}`, "aria-controls": `panel-${t.id}`,
            onclick: () => showTab(t.id),
            onkeydown: (/** @type {KeyboardEvent} */ e) => arrowKeys(e, t.id),
        }, t.title);
        const panel = h("section", { role: "tabpanel", id: `panel-${t.id}`, "aria-labelledby": `tab-${t.id}`, class: "panel" });
        bar.append(button);
        main.append(panel);
        parts.set(t.id, { button, panel });
    }
    store.subscribe(() => renderActive());
    window.addEventListener("hashchange", () => showTab(location.hash.slice(1), false));
    showTab(location.hash.slice(1) || active, false);
}

/** Show tab `id` (ignored if there is no such tab). */
export function showTab(/** @type {string} */ id, setHash = true) {
    if (!parts.has(id)) return;
    active = id;
    for (const [tid, p] of parts) {
        const on = tid === id;
        p.button.setAttribute("aria-selected", String(on));
        p.button.tabIndex = on ? 0 : -1;
        p.panel.hidden = !on;
    }
    if (setHash && location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
    renderActive();
}

/** The id of the visible tab. */
export const activeTab = () => active;

function renderActive() {
    const tab = TABS.find((t) => t.id === active);
    const p = parts.get(active);
    if (!tab || !p) return;
    try {
        tab.render(p.panel, store.get());
    } catch (e) {
        log.error(`${tab.title} tab failed to draw: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
}

/** Left/Right/Home/End move between tabs, as for any tab strip. */
function arrowKeys(/** @type {KeyboardEvent} */ e, /** @type {string} */ id) {
    const i = TABS.findIndex((t) => t.id === id);
    const n = TABS.length;
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const t = TABS[to];
    if (!t) return;
    showTab(t.id);
    parts.get(t.id)?.button.focus();
}
