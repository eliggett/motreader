// @ts-check
/**
 * Modal dialogs on the native <dialog> element. `openModal` resolves with the
 * chosen button's value, or `null` if the dialog is dismissed with Escape.
 * Only one dialog is open at a time; `current()` describes it so the test API
 * can see and answer it.
 */
import { h } from "./dom.js";

/** @typedef {{ label: string, value: string, primary?: boolean }} Button */
/**
 * @typedef {{
 *   title: string,
 *   body: Node | string,
 *   buttons?: Button[],
 *   wide?: boolean,
 * }} ModalSpec
 */

/** @type {{ spec: ModalSpec, dialog: HTMLDialogElement, close: (v: string | null) => void } | null} */
let open = null;

/** Show a dialog; resolves with the pressed button's value (null on Escape). */
export function openModal(/** @type {ModalSpec} */ spec) {
    if (open) open.close(null);
    const buttons = spec.buttons ?? [{ label: "OK", value: "ok", primary: true }];
    const dialog = h("dialog", { class: spec.wide ? "modal wide" : "modal" });
    return new Promise((resolve) => {
        const close = (/** @type {string | null} */ value) => {
            if (open?.dialog !== dialog) return;
            open = null;
            dialog.close();
            dialog.remove();
            resolve(value);
        };
        dialog.append(
            h("h2", {}, spec.title),
            h("div", { class: "modal-body" }, spec.body),
            h("div", { class: "modal-buttons" },
                buttons.map((b) => h("button", { class: b.primary ? "primary" : "", onclick: () => close(b.value) }, b.label))),
        );
        dialog.addEventListener("cancel", (e) => {
            e.preventDefault();
            close(null);
        });
        document.body.append(dialog);
        open = { spec, dialog, close };
        dialog.showModal();
        /** @type {HTMLButtonElement | null} */ (dialog.querySelector("button.primary"))?.focus();
    });
}

/** An informational dialog with a single OK button. */
export function alertModal(/** @type {string} */ title, /** @type {Node | string} */ body) {
    return openModal({ title, body }).then(() => undefined);
}

/** OK/Cancel; resolves true for OK. */
export async function confirmModal(/** @type {string} */ title, /** @type {Node | string} */ body, okLabel = "OK") {
    const v = await openModal({
        title, body,
        buttons: [{ label: "Cancel", value: "cancel" }, { label: okLabel, value: "ok", primary: true }],
    });
    return v === "ok";
}

/** The open dialog, for the test API: title, text and button values. */
export function current() {
    if (!open) return null;
    return {
        title: open.spec.title,
        text: open.dialog.querySelector(".modal-body")?.textContent ?? "",
        buttons: (open.spec.buttons ?? [{ label: "OK", value: "ok" }]).map((b) => b.value),
    };
}

/** Press a button of the open dialog by value (null dismisses it). */
export function answer(/** @type {string | null} */ value) {
    if (!open) throw new Error("no dialog is open");
    open.close(value);
}
