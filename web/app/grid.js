// @ts-check
/**
 * A spreadsheet-like table editor.
 *
 * Keyboard: arrows (and Home/End, PageUp/PageDown) move the active cell;
 * Enter, F2 or a double-click edits it; typing starts editing with what you
 * type; in an editor Enter commits and moves down, Tab commits and moves
 * right (Shift+Tab left), Escape cancels. Each commit goes through
 * `onEdit`, whose message (a refusal or a note) shows in the status line
 * under the table. Changed cells are highlighted.
 */
import { h, upperCaseAsTyped } from "./dom.js";

/**
 * @typedef {{ type: "text", maxLength?: number, upper?: boolean }
 *   | { type: "select", options: readonly string[], labels?: Record<string, string> }} Editor
 *   `upper`: turn lower case into upper case as it is typed; `labels`: option text by value.
 */
/**
 * @template R
 * @typedef {{
 *   id: string, label: string, cls?: string,
 *   text: (row: R) => string,
 *   editor?: (row: R) => Editor | null,
 *   changed?: (row: R) => boolean,
 * }} Column
 */
/**
 * @template R
 * @typedef {{
 *   columns: Column<R>[],
 *   rows: () => R[],
 *   onEdit: (row: R, column: string, text: string) => { error?: string, note?: string },
 *   rowAction?: { label: string, title?: string, run: (row: R) => void },
 *   rowClass?: (row: R) => string,
 *   label?: string,
 * }} GridSpec
 */

/**
 * @template R
 * @param {GridSpec<R>} spec
 */
export function createGrid(spec) {
    const cols = spec.columns;
    const actionCol = spec.rowAction ? 1 : 0;
    const table = h("table", { class: "grid editable", tabindex: 0, role: "grid", "aria-label": spec.label ?? "table" });
    const tbody = h("tbody");
    const status = h("p", { class: "grid-status", "aria-live": "polite" });
    table.append(
        h("thead", {}, h("tr", {},
            spec.rowAction ? h("th", { class: "action" }, "") : null,
            cols.map((c) => h("th", { class: c.cls ?? "" }, c.label)))),
        tbody);
    const el = h("div", { class: "grid-box" }, h("div", { class: "table-wrap" }, table), status);

    let r = 0;
    let c = 0;
    /** @type {{ td: HTMLTableCellElement, input: HTMLInputElement | HTMLSelectElement, row: R, col: Column<R> } | null} */
    let editing = null;
    /** @type {R[]} */
    let rows = [];

    const cellAt = (/** @type {number} */ ri, /** @type {number} */ ci) =>
        /** @type {HTMLTableCellElement | undefined} */ (tbody.rows[ri]?.cells[ci + actionCol]);

    function render() {
        rows = spec.rows();
        tbody.replaceChildren(...rows.map((row, ri) => h("tr", { class: spec.rowClass?.(row) ?? "" },
            spec.rowAction ? h("td", { class: "action" }, h("button", {
                class: "small", tabindex: -1, title: spec.rowAction.title ?? "",
                onclick: () => spec.rowAction?.run(row),
            }, spec.rowAction.label)) : null,
            cols.map((col, ci) => {
                const ed = col.editor?.(row) ?? null;
                return h("td", {
                    class: [col.cls ?? "", ed ? "" : "ro", col.changed?.(row) ? "changed" : ""].join(" ").trim(),
                    dataset: { r: String(ri), c: String(ci) },
                }, col.text(row));
            }))));
        r = Math.min(r, Math.max(rows.length - 1, 0));
        mark();
    }

    function mark() {
        tbody.querySelector("td.active")?.classList.remove("active");
        const td = cellAt(r, c);
        if (!td) return;
        td.classList.add("active");
        td.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    function move(/** @type {number} */ dr, /** @type {number} */ dc) {
        r = Math.max(0, Math.min(rows.length - 1, r + dr));
        c = Math.max(0, Math.min(cols.length - 1, c + dc));
        mark();
    }

    function say(/** @type {string} */ text, /** @type {"error" | "note" | ""} */ kind = "") {
        status.textContent = text;
        status.className = `grid-status ${kind}`;
    }

    /** Start editing the active cell; `initial` replaces its text (typing). */
    function edit(/** @type {string | null} */ initial = null) {
        const row = rows[r];
        const col = cols[c];
        const td = cellAt(r, c);
        if (row === undefined || !col || !td) return;
        const ed = col.editor?.(row) ?? null;
        if (!ed) {
            say(`${col.label} can't be edited here.`, "note");
            return;
        }
        const cur = col.text(row);
        /** @type {HTMLInputElement | HTMLSelectElement} */
        let input;
        if (ed.type === "select") {
            const options = ed.options.includes(cur) || cur === "" ? ed.options : [cur, ...ed.options];
            input = h("select", {}, options.map((o) => h("option", { value: o, selected: o === cur }, ed.labels?.[o] ?? o)));
            input.addEventListener("change", () => commit(0, 0));
        } else {
            const text = h("input", { type: "text", value: initial ?? cur, maxlength: ed.maxLength ?? false, spellcheck: "false" });
            if (ed.upper) upperCaseAsTyped(text);
            input = text;
        }
        input.addEventListener("keydown", (e) => {
            const k = /** @type {KeyboardEvent} */ (e);
            if (k.key === "Enter") {
                k.preventDefault();
                commit(1, 0);
            } else if (k.key === "Tab") {
                k.preventDefault();
                commit(0, k.shiftKey ? -1 : 1);
            } else if (k.key === "Escape") {
                k.preventDefault();
                cancel();
            }
            k.stopPropagation();
        });
        input.addEventListener("blur", () => {
            if (editing?.input === input) commit(0, 0, false);
        });
        td.replaceChildren(input);
        td.classList.add("editing");
        editing = { td, input, row, col };
        input.focus();
        if (input instanceof HTMLInputElement && initial === null) input.select();
    }

    function cancel() {
        if (!editing) return;
        editing = null;
        render();
        table.focus();
    }

    /** Apply the editor's text, then move by (dr, dc). */
    function commit(/** @type {number} */ dr, /** @type {number} */ dc, refocus = true) {
        if (!editing) return;
        const { input, row, col } = editing;
        editing = null;
        const text = input.value;
        if (text !== col.text(row)) {
            const res = spec.onEdit(row, col.id, text);
            if (res.error) say(`${col.label}: ${res.error}`, "error");
            else say(res.note ? `${col.label}: ${res.note}` : "", res.note ? "note" : "");
        }
        render();
        if (dr || dc) move(dr, dc);
        if (refocus) table.focus();
    }

    table.addEventListener("keydown", (e) => {
        if (editing) return;
        const page = Math.max(1, Math.floor((table.parentElement?.clientHeight ?? 400) / 28) - 1);
        /** @type {Record<string, () => void>} */
        const keys = {
            ArrowUp: () => move(-1, 0), ArrowDown: () => move(1, 0),
            ArrowLeft: () => move(0, -1), ArrowRight: () => move(0, 1),
            Home: () => move(0, -cols.length), End: () => move(0, cols.length),
            PageUp: () => move(-page, 0), PageDown: () => move(page, 0),
            Enter: () => edit(), F2: () => edit(),
            Tab: () => move(0, e.shiftKey ? -1 : 1),
        };
        const fn = keys[e.key];
        if (fn) {
            if (e.key === "Tab" && ((e.shiftKey && c === 0) || (!e.shiftKey && c === cols.length - 1))) return;   // leave the grid
            e.preventDefault();
            fn();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const ed = rows[r] !== undefined ? cols[c]?.editor?.(/** @type {R} */ (rows[r])) : null;
            if (ed?.type === "text") {
                e.preventDefault();
                edit(e.key);
            }
        }
    });
    table.addEventListener("click", (e) => {
        const td = /** @type {HTMLElement} */ (e.target).closest("td");
        if (!td?.dataset.r || editing?.td === td) return;
        r = Number(td.dataset.r);
        c = Number(td.dataset.c);
        mark();
        table.focus();
    });
    table.addEventListener("dblclick", (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest("td[data-r]")) edit();
    });

    render();
    return {
        el,
        /** Redraw from the rows (after outside changes); keeps the active cell. */
        refresh: render,
        /** Show a message in the status line. */
        say,
        /** The active cell as [row index, column id]. */
        active: () => /** @type {const} */ ([r, cols[c]?.id ?? ""]),
        /** Make (row index, column id) the active cell. */
        select(/** @type {number} */ ri, /** @type {string} */ colId) {
            r = ri;
            c = Math.max(0, cols.findIndex((x) => x.id === colId));
            mark();
        },
    };
}
