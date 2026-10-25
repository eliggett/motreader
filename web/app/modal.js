// @ts-check
/**
 * Modal dialogs on the native <dialog> element. `openModal` resolves with the
 * chosen button's value, or `null` if the dialog is dismissed with Escape.
 * Only one dialog is open at a time; `current()` describes it so the test API
 * can see and answer it.
 *
 * A dialog can stay open after a button: `onButton(value)` returning false
 * keeps it (e.g. to show a validation error). `onOpen(ctl)` gets a handle to
 * change the buttons or close it from code (the export dialog's progress).
 */
import { h } from "./dom.js";

/** @typedef {{ label: string, value: string, primary?: boolean, disabled?: boolean }} Button */
/**
 * @typedef {{
 *   setButtons: (b: Button[]) => void,
 *   close: (value: string | null) => void,
 *   dialog: HTMLDialogElement,
 * }} ModalControl
 */
/**
 * @typedef {{
 *   title: string,
 *   body: Node | string,
 *   buttons?: Button[],
 *   wide?: boolean,
 *   onButton?: (value: string | null) => boolean | Promise<boolean>,
 *   onOpen?: (ctl: ModalControl) => void,
 * }} ModalSpec
 */

/** @type {{ spec: ModalSpec, dialog: HTMLDialogElement, buttons: Button[], press: (v: string | null) => void, close: (v: string | null) => void } | null} */
let open = null;

/** Show a dialog; resolves with the pressed button's value (null on Escape). */
export function openModal(/** @type {ModalSpec} */ spec) {
    if (open) open.close(null);
    const dialog = h("dialog", { class: spec.wide ? "modal wide" : "modal" });
    const bar = h("div", { class: "modal-buttons" });
    return new Promise((resolve) => {
        const close = (/** @type {string | null} */ value) => {
            if (open?.dialog !== dialog) return;
            open = null;
            dialog.close();
            dialog.remove();
            resolve(value);
        };
        const press = async (/** @type {string | null} */ value) => {
            if (spec.onButton && (await spec.onButton(value)) === false) return;
            close(value);
        };
        const setButtons = (/** @type {Button[]} */ buttons) => {
            if (open?.dialog === dialog) open.buttons = buttons;
            bar.replaceChildren(...buttons.map((b) => h("button", {
                class: b.primary ? "primary" : "", disabled: b.disabled, onclick: () => press(b.value),
            }, b.label)));
            /** @type {HTMLButtonElement | null} */ (bar.querySelector("button.primary:not(:disabled)"))?.focus();
        };
        dialog.append(h("h2", {}, spec.title), h("div", { class: "modal-body" }, spec.body), bar);
        dialog.addEventListener("cancel", (e) => {
            e.preventDefault();
            void press(null);
        });
        document.body.append(dialog);
        const buttons = spec.buttons ?? [{ label: "OK", value: "ok", primary: true }];
        open = { spec, dialog, buttons, press, close };
        dialog.showModal();
        setButtons(buttons);
        spec.onOpen?.({ setButtons, close, dialog });
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

/** The open dialog, for the test API: title, text and (enabled) button values. */
export function current() {
    if (!open) return null;
    return {
        title: open.spec.title,
        text: /** @type {HTMLElement | null} */ (open.dialog.querySelector(".modal-body"))?.innerText ?? "",
        buttons: open.buttons.filter((b) => !b.disabled).map((b) => b.value),
    };
}

/** Press a button of the open dialog by value (null = Escape), as a click would. */
export function answer(/** @type {string | null} */ value) {
    if (!open) throw new Error("no dialog is open");
    if (value !== null && !open.buttons.some((b) => b.value === value && !b.disabled)) {
        throw new Error(`the dialog has no enabled "${value}" button`);
    }
    open.press(value);
}

/** The open dialog element (for tests that fill in its fields), or null. */
export const currentDialog = () => open?.dialog ?? null;
