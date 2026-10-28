// @ts-check
/**
 * The About box, drawn as a Spectra RSS help screen: a character grid in RSS's
 * own colours (read from RSS's text attributes: blue background, bright red
 * double-line frame, cyan title block, white path line, yellow text, the grey
 * F1-F10 bar). The text comes from about.html (<h2> titles, <p> paragraphs)
 * and is wrapped and paged here; PgUp / PgDn (or F7 / F8) turn the pages,
 * the scroll wheel turns them too; F10 or Escape returns.
 */
import { VERSION } from "./version.js";

const COLS = 96;              // screen width in characters
const SPLIT = 44;             // the column of the title block's divider (RSS: 40 of 80)
const BODY = 20;              // text rows per page
const WIDTH = COLS - 2 - 4;   // text width inside the frame and margins
const URL = /https?:\/\/[^\s<>"]+[^\s<>".,)]/g;

/** @typedef {{ text: string, cls: string, href?: string, key?: string }} Seg */
/** @typedef {{ segs: Seg[], keep?: boolean }} Line  keep: keep with the next line (titles) */

/** A 5-row block font for the banner. */
const FONT = /** @type {Record<string, string[]>} */ ({
    M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
    O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
    T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
    R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
    E: ["█████", "█    ", "████ ", "█    ", "█████"],
    A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
    D: ["████ ", "█   █", "█   █", "█   █", "████ "],
});

const pad = (/** @type {string} */ s, /** @type {number} */ n) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const center = (/** @type {string} */ s, /** @type {number} */ n) => pad(" ".repeat(Math.max(0, Math.floor((n - s.length) / 2))) + s, n);

/** Word-wrap `text` to `width`, the first line indented by `first` more. */
function wrap(/** @type {string} */ text, /** @type {number} */ width, first = 0) {
    const out = [];
    let line = " ".repeat(first);
    for (const w of text.split(/\s+/).filter(Boolean)) {
        if (line.trim() && line.length + 1 + w.length > width) {
            out.push(line);
            line = w;
        } else {
            line = line.trim() ? `${line} ${w}` : line + w;
        }
    }
    if (line.trim()) out.push(line);
    return out;
}

/** A body line's segments: the text (padded to the frame) with its URLs as links. */
function bodySegs(/** @type {string} */ text, /** @type {string} */ cls) {
    const full = pad(`  ${text}`, COLS - 2);
    /** @type {Seg[]} */
    const segs = [];
    let at = 0;
    for (const m of full.matchAll(URL)) {
        segs.push({ text: full.slice(at, m.index), cls });
        segs.push({ text: m[0], cls: `${cls} dos-link`, href: m[0] });
        at = (m.index ?? 0) + m[0].length;
    }
    segs.push({ text: full.slice(at), cls });
    return segs;
}

/** The about text as lines: the banner, then each section's title and wrapped paragraphs. */
function textLines(/** @type {DocumentFragment} */ about) {
    /** @type {Line[]} */
    const lines = [{ segs: bodySegs("", "dos-text") }];
    for (let row = 0; row < 5; row++) {
        const art = [..."MOTREADER"].map((c) => FONT[c]?.[row] ?? "").join(" ");
        lines.push({ segs: bodySegs(center(art, WIDTH), "dos-banner") });
    }
    lines.push({ segs: bodySegs("", "dos-text") });
    lines.push({ segs: bodySegs(center(`Spectra Codeplug Editor  -  Version ${VERSION}`, WIDTH), "dos-title") });
    for (const el of about.querySelectorAll("h2, p")) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        if (el.tagName === "H2") {
            lines.push({ segs: bodySegs("", "dos-text"), keep: true });
            lines.push({ segs: bodySegs(`${text.toUpperCase()}:`, "dos-title"), keep: true });
        } else {
            for (const l of wrap(text, WIDTH, 4)) lines.push({ segs: bodySegs(l, "dos-text") });
        }
    }
    return lines;
}

/** Split lines into pages of BODY rows, not leaving a title at the foot of a page. */
function paginate(/** @type {Line[]} */ lines) {
    /** @type {Line[][]} */
    const pages = [];
    let page = /** @type {Line[]} */ ([]);
    const blank = (/** @type {Line} */ l) => !l.segs.some((s) => s.text.trim());
    lines.forEach((l, i) => {
        // a title and its blank line go with the line after them
        let need = 1;
        if (l.keep) while (lines[i + need - 1]?.keep) need++;
        if (page.length + need > BODY) {
            pages.push(page);
            page = [];
        }
        if (page.length || !blank(l)) page.push(l);   // no blank line at the top of a page
    });
    if (page.length) pages.push(page);
    return pages;
}

/** The function-key bar: the key numbers, then two rows of labels. */
const KEYS = /** @type {[string, string, string][]} */ ([
    ["F1", "", ""], ["F2", "", ""], ["F3", "", ""], ["F4", "", ""], ["F5", "", ""], ["F6", "", ""],
    ["F7", "PAGE", "UP"], ["F8", "PAGE", "DOWN"], ["F9", "", ""], ["F10", "EXIT", ""],
]);

/** The whole screen for page `p` (0-based) of `pages`, as rows of segments. */
function screen(/** @type {Line[][]} */ pages, /** @type {number} */ p) {
    const L = SPLIT - 1;
    const R = COLS - SPLIT - 2;
    const f = (/** @type {string} */ text) => ({ text, cls: "dos-frame" });
    /** @type {Seg[][]} */
    const rows = [
        [f(`╔${"═".repeat(L)}╦${"═".repeat(R)}╗`)],
        [f("║"), { text: pad(" Radio Service Software", L), cls: "dos-head" }, f("║"),
            { text: pad(" Use PgUp / PgDn To View Help.", R), cls: "dos-head" }, f("║")],
        [f("║"), { text: pad(` SPECTRA        motreader ${VERSION}`, L), cls: "dos-head" }, f("║"),
            { text: pad(` Page ${p + 1} of ${pages.length}.`, R), cls: "dos-head" }, f("║")],
        [f("║"), { text: pad("", L), cls: "dos-path" }, f("║"), { text: pad(" Press F10 To Return To Menu.", R), cls: "dos-path" }, f("║")],
        [f("║"), { text: pad(" MAIN:ABOUT:HELP", L), cls: "dos-path" }, f("║"), { text: pad("", R), cls: "dos-path" }, f("║")],
        [f(`╠${"═".repeat(L)}╩${"═".repeat(R)}╣`)],
    ];
    const page = pages[p] ?? [];
    for (let i = 0; i < BODY; i++) rows.push([f("║"), ...(page[i]?.segs ?? bodySegs("", "dos-text")), f("║")]);
    rows.push([f(`╚${"═".repeat(COLS - 2)}╝`)]);
    // F-key bar: ten slots across the screen, each clickable
    const slot = Math.floor(COLS / KEYS.length);
    for (let r = 0; r < 3; r++) {
        rows.push(KEYS.map(([k, a, b], i) => {
            const w = i === KEYS.length - 1 ? COLS - slot * (KEYS.length - 1) : slot;
            return { text: pad(` ${[k, a, b][r]}`, w), cls: "dos-fkey", key: k };
        }));
    }
    return rows;
}

/** Show the About box (resolves when it is closed). @param {DocumentFragment} about */
export function showAboutBox(about) {
    const pages = paginate(textLines(about));
    let p = 0;
    const pre = document.createElement("pre");
    pre.className = "dos-screen";
    const dialog = document.createElement("dialog");
    dialog.className = "dos";
    dialog.setAttribute("aria-label", "About motreader");
    dialog.append(pre);
    const draw = () => {
        pre.replaceChildren();
        for (const row of screen(pages, p)) {
            const line = document.createElement("span");
            line.className = "dos-row";
            for (const s of row) {
                const el = document.createElement(s.href ? "a" : "span");
                el.className = s.cls;
                el.textContent = s.text;
                if (el instanceof HTMLAnchorElement && s.href) {
                    el.href = s.href;
                    el.target = "_blank";
                    el.rel = "noopener";
                }
                if (s.key) el.dataset.key = s.key;
                line.append(el);
            }
            pre.append(line);
        }
    };
    const turn = (/** @type {number} */ d) => {
        const q = Math.max(0, Math.min(pages.length - 1, p + d));
        if (q !== p) {
            p = q;
            draw();
        }
    };
    return new Promise((resolve) => {
        const close = () => {
            dialog.close();
            dialog.remove();
            resolve(undefined);
        };
        dialog.addEventListener("keydown", (e) => {
            const k = e.key;
            if (k === "PageDown" || k === "F8" || k === "ArrowDown" || k === " ") turn(1);
            else if (k === "PageUp" || k === "F7" || k === "ArrowUp") turn(-1);
            else if (k === "Home") turn(-pages.length);
            else if (k === "End") turn(pages.length);
            else if (k === "F10" || k === "Escape" || k === "Enter") close();
            else return;
            e.preventDefault();
        });
        dialog.addEventListener("cancel", (e) => {
            e.preventDefault();
            close();
        });
        pre.addEventListener("click", (e) => {
            const key = /** @type {HTMLElement} */ (e.target).dataset?.key;
            if (key === "F7") turn(-1);
            else if (key === "F8") turn(1);
            else if (key === "F10") close();
        });
        // the scroll wheel turns pages: one page per notch (a trackpad's small
        // deltas add up), with a pause so one flick doesn't skip to the end
        let wheel = 0;
        let quietUntil = 0;
        dialog.addEventListener("wheel", (e) => {
            e.preventDefault();
            const now = performance.now();
            if (now < quietUntil) return;
            wheel += e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
            if (Math.abs(wheel) >= 60) {
                turn(Math.sign(wheel));
                wheel = 0;
                quietUntil = now + 180;
            }
        }, { passive: false });
        // a click outside the screen returns too
        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) close();
        });
        draw();
        document.body.append(dialog);
        dialog.showModal();
        pre.tabIndex = 0;
        pre.focus();
    });
}
