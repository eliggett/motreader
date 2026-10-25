// @ts-check
/** The log panel at the bottom of the page: entries, Debug checkbox, Export, Clear. */
import { h } from "./dom.js";
import { log, format, exportText, timestamp } from "./log.js";
import { download } from "./files.js";

let showDebug = false;

/** Build the panel into `el`. */
export function initLogView(/** @type {HTMLElement} */ el) {
    const list = h("ol", { class: "log-entries", "aria-live": "polite" });
    const debugBox = h("input", {
        type: "checkbox", id: "log-debug",
        onchange: () => {
            showDebug = debugBox.checked;
            redraw();
        },
    });
    el.append(
        h("div", { class: "log-bar" },
            h("strong", {}, "Log"),
            h("label", { for: "log-debug" }, debugBox, " Debug"),
            h("span", { class: "spacer" }),
            h("button", { onclick: exportLog }, "Export log"),
            h("button", { onclick: () => { log.clear(); redraw(); } }, "Clear")),
        list);

    const line = (/** @type {import("./log.js").Entry} */ e) => h("li", { class: `log-${e.level}` }, format(e));
    function redraw() {
        list.replaceChildren(...log.entries(showDebug).map(line));
        list.scrollTop = list.scrollHeight;
    }
    log.subscribe((e) => {
        if (e.level === "debug" && !showDebug) return;
        const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
        list.append(line(e));
        while (list.childElementCount > 2000) list.firstElementChild?.remove();
        if (atEnd) list.scrollTop = list.scrollHeight;
    });
    redraw();
}

function exportLog() {
    const t = timestamp(new Date()); // 2026-10-24 21:40:12.345 -> 20261024-214012
    const stamp = `${t.slice(0, 10).replace(/-/g, "")}-${t.slice(11, 19).replace(/:/g, "")}`;
    download(exportText(showDebug), `motreader-log-${stamp}.txt`, "text/plain");
    log.info("Log exported");
}
