// @ts-check
/** Start-up: wire the toolbar, tabs, log panel and test API. */
import { $ } from "./dom.js";
import { log } from "./log.js";
import { store } from "./state.js";
import { initTabs } from "./tabbar.js";
import { initLogView } from "./logview.js";
import { installTestApi } from "./testapi.js";
import { VERSION } from "./version.js";
import * as actions from "./actions.js";
import { isDirty } from "./editing.js";

/** Toolbar buttons (by data-action) and the commands they run. */
const COMMANDS = {
    "import-codeplug": actions.importCodeplug,
    "import-tables": actions.importTables,
    "export-codeplug": actions.exportCodeplug,
    "export-yaml": actions.exportYaml,
    "export-csv": actions.exportCsv,
    "about": actions.about,
};

/** Buttons that need an open document. */
const NEEDS_DOC = ["import-tables", "export-codeplug", "export-yaml", "export-csv"];

function start() {
    initLogView($("#log"));
    initTabs($("#tabs"), $("#main"));

    for (const [name, run] of Object.entries(COMMANDS)) {
        $(`[data-action="${name}"]`).addEventListener("click", () => {
            run().catch((e) => log.error(`${name} failed: ${e instanceof Error ? e.stack ?? e.message : e}`));
        });
    }
    const enable = () => {
        for (const name of NEEDS_DOC) {
            /** @type {HTMLButtonElement} */ ($(`[data-action="${name}"]`)).disabled = !store.get();
        }
        const doc = store.get();
        const dirty = isDirty();
        $("#doc-name").textContent = doc ? `${doc.fileName}${dirty ? " (modified)" : ""}` : "";
        $("#doc-name").classList.toggle("dirty", dirty);
        // a codeplug motreader can't edit safely says so above every tab
        const notice = $("#notice");
        notice.hidden = !doc || doc.support.editable;
        if (doc && !doc.support.editable) {
            notice.textContent = `Read-only: ${doc.support.reasons.join("; ")}. It can be viewed (and exported unchanged), not edited.`;
        }
    };
    store.subscribe(enable);
    enable();

    // the browser asks before leaving the page with unexported edits
    window.addEventListener("beforeunload", (e) => {
        if (isDirty()) e.preventDefault();
    });
    window.addEventListener("error", (e) => log.error(`Uncaught: ${e.message} (${e.filename}:${e.lineno})`));
    window.addEventListener("unhandledrejection", (e) => log.error(`Unhandled: ${e.reason}`));
    log.info(`motreader ${VERSION} ready`);
}

/** @type {() => void} */
let started = () => {};
installTestApi(new Promise((r) => (started = r)));
start();
started();
