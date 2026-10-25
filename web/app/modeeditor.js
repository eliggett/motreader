// @ts-check
/**
 * The single-mode editor: one mode's fields as a form in a dialog (handier
 * than scrolling a wide grid on a small screen). Changes are applied on OK,
 * each through the same checks as the grid; a refused value keeps the dialog
 * open with the reason beside the field.
 */
import { h, upperCaseAsTyped } from "./dom.js";
import { openModal } from "./modal.js";
import { store } from "./state.js";
import { editMode } from "./editing.js";
import { MODE_FIELDS, SQUELCH_CHOICES, fieldText, applies, nameRule, isTrunkedMode } from "../lib/modefields.js";

/** @typedef {import("../lib/codeplug.js").Mode} Mode */

/**
 * The talk-around warning from UI_plan.md: allowed, but noted, on a simplex
 * mode (Tx = Rx). Not modal; it sits under the form.
 * @param {string} rx @param {string} tx @param {string} ta
 */
export function talkAroundWarning(rx, tx, ta) {
    if (!ta.trim() || !rx.trim() || !tx.trim()) return "";
    return Number(rx) === Number(tx)
        ? "This is a simplex mode (Tx = Rx). Talk-around on a simplex mode isn't supported by the radio: "
            + "it's allowed here, but expect it to have no effect."
        : "";
}

/** Open the editor for mode number `n`. */
export async function openModeEditor(/** @type {number} */ n) {
    const doc = store.get();
    const m = doc?.cp.modes[n - 1];
    if (!doc || !m) return;
    const cp = doc.cp;
    const readOnly = isTrunkedMode(cp, m) || cp.band === "900?";
    const fields = MODE_FIELDS.filter((f) => applies(cp, m, f) || f.kind === "mhz");
    /** @type {Map<string, { input: HTMLInputElement | HTMLSelectElement, msg: HTMLElement }>} */
    const inputs = new Map();
    const warning = h("p", { class: "warn-text" });

    const rows = fields.map((f) => {
        const cur = fieldText(m, f.key);
        /** @type {HTMLInputElement | HTMLSelectElement} */
        let input;
        if (f.kind === "choice" || f.kind === "squelch") {
            const options = f.kind === "squelch" ? SQUELCH_CHOICES : /** @type {readonly string[]} */ (f.choices);
            input = h("select", { disabled: readOnly },
                (cur === "" || options.includes(cur) ? options : [cur, ...options]).map((o) => h("option", { value: o, selected: o === cur }, o)),
                cur === "" ? h("option", { value: "", selected: true }, "(not decoded)") : null);
        } else {
            input = h("input", {
                type: "text", value: cur, disabled: readOnly, spellcheck: "false",
                maxlength: f.kind === "name" ? nameRule(cp).width : false,
                inputmode: f.kind === "mhz" ? "decimal" : false,
            });
        }
        input.id = `me-${f.key}`;
        if (f.kind === "name" && input instanceof HTMLInputElement) upperCaseAsTyped(input);
        input.addEventListener("input", updateWarning);
        const msg = h("span", { class: "field-msg" });
        inputs.set(f.key, { input, msg });
        return h("div", { class: "form-row" }, h("label", { for: input.id }, f.label), input, msg);
    });

    function updateWarning() {
        const v = (/** @type {string} */ k) => inputs.get(k)?.input.value ?? "";
        warning.textContent = talkAroundWarning(v("rx_mhz"), v("tx_mhz"), v("ta_mhz"));
    }
    updateWarning();

    const body = h("div", { class: "mode-editor" },
        readOnly ? h("p", { class: "note" }, isTrunkedMode(cp, m)
            ? "Mode 1 is the trunked mode: motreader doesn't edit it."
            : "This codeplug's mode layout isn't recognised, so modes can't be edited.") : null,
        h("div", { class: "form" }, rows),
        warning);

    await openModal({
        title: `Mode ${n}: ${m.name || "(no name)"}`,
        body,
        buttons: readOnly ? [{ label: "Close", value: "cancel", primary: true }]
            : [{ label: "Cancel", value: "cancel" }, { label: "OK", value: "ok", primary: true }],
        onButton(value) {
            if (value !== "ok") return true;
            let ok = true;
            for (const f of fields) {
                const { input, msg } = /** @type {{ input: HTMLInputElement | HTMLSelectElement, msg: HTMLElement }} */ (inputs.get(f.key));
                const mode = /** @type {Mode} */ (store.get()?.cp.modes[n - 1]);
                msg.textContent = "";
                msg.className = "field-msg";
                if (input.value === fieldText(mode, f.key) || (f.kind !== "name" && f.kind !== "mhz" && input.value === "")) continue;
                if (!applies(cp, mode, f) && input.value === "") continue;
                const res = editMode(n, f.key, input.value);
                if (res.error) {
                    ok = false;
                    msg.textContent = res.error;
                    msg.classList.add("error");
                } else if (res.note) {
                    msg.textContent = res.note;
                }
                input.value = fieldText(/** @type {Mode} */ (store.get()?.cp.modes[n - 1]), f.key);
            }
            return ok;
        },
    });
}
