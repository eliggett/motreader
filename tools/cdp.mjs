#!/usr/bin/env node
// @ts-check
/**
 * Drive the web app in headless Chrome and print what came back.
 *
 * Starts server/server.py on a free port (serving web/), launches headless
 * Chrome with a throwaway profile, opens the app, waits for `mr.ready`, then
 * evaluates each expression in the page in order (promises are awaited) and
 * prints its JSON value. Console warnings/errors, uncaught exceptions and
 * failed loads are reported too. Both processes are killed (by their own PIDs)
 * on exit. Needs Node 22+ (built-in WebSocket).
 *
 *   node tools/cdp.mjs 'mr.tabs()' 'mr.log()'
 *   node tools/cdp.mjs --load ~/.dosbox/c/MRSS/SPECTRA/ARCHIVE/A617ASQ1.266 'mr.tab("hex")' 'mr.text().slice(0, 400)'
 *   node tools/cdp.mjs --screenshot /tmp/x.png 'mr.tab("general")'
 *
 * Options:
 *   --load PATH          load PATH into the app with mr.load() before the expressions
 *   --screenshot PATH    save a PNG of the page after the expressions
 *   --size WxH           window size (default 1280x900)
 *   --url URL            use an already-running server instead of starting one
 *   --chrome PATH        Chrome binary (default: google-chrome, chromium)
 *   --verbose            also print console.log / info lines
 *
 * Exit status is 1 if an expression threw or the page raised an uncaught error.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
/** @type {Record<string, string | boolean>} */
const opt = {};
/** @type {string[]} */
const exprs = [];
for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (a === "--verbose") opt.verbose = true;
    else if (a.startsWith("--")) opt[a.slice(2)] = args[++i] ?? "";
    else exprs.push(a);
}

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
/** @type {string | null} */
let profile = null;

function cleanup() {
    for (const c of children) {
        if (c.pid && c.exitCode === null) {
            try { process.kill(-c.pid, "SIGTERM"); } catch { try { c.kill("SIGTERM"); } catch { /* gone */ } }
        }
    }
    if (profile) rmSync(profile, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

/** A free TCP port on localhost. */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.on("error", reject);
        s.listen(0, "127.0.0.1", () => {
            const addr = s.address();
            s.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
        });
    });
}

/** Resolve once `port` accepts connections. */
async function waitForPort(/** @type {number} */ port, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const ok = await new Promise((r) => {
            const s = connect(port, "127.0.0.1", () => { s.end(); r(true); });
            s.on("error", () => r(false));
        });
        if (ok) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`nothing listening on port ${port}`);
}

function findChrome() {
    if (typeof opt.chrome === "string") return opt.chrome;
    for (const c of ["google-chrome", "chromium", "chromium-browser"]) {
        try {
            return execFileSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).trim();
        } catch { /* try next */ }
    }
    throw new Error("no Chrome found; pass --chrome PATH");
}

/** Minimal Chrome DevTools Protocol session over one WebSocket. */
class Cdp {
    /** @param {WebSocket} ws */
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
        this.pending = new Map();
        /** @type {((method: string, params: any) => void)[]} */
        this.listeners = [];
        ws.addEventListener("message", (ev) => {
            const m = JSON.parse(String(ev.data));
            if (m.id !== undefined) {
                const p = this.pending.get(m.id);
                this.pending.delete(m.id);
                if (m.error) p?.reject(new Error(`${m.error.message} ${m.error.data ?? ""}`));
                else p?.resolve(m.result);
            } else {
                for (const fn of this.listeners) fn(m.method, m.params);
            }
        });
    }
    /** @param {string} method @param {object} [params] @returns {Promise<any>} */
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    /** Resolve on the next `method` event. */
    once(/** @type {string} */ method, ms = 15000) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), ms);
            const fn = (/** @type {string} */ m, /** @type {any} */ p) => {
                if (m !== method) return;
                clearTimeout(t);
                this.listeners.splice(this.listeners.indexOf(fn), 1);
                resolve(p);
            };
            this.listeners.push(fn);
        });
    }
}

async function main() {
    let url = typeof opt.url === "string" ? opt.url : "";
    if (!url) {
        const port = await freePort();
        const server = spawn("python3", [join(ROOT, "server", "server.py"), String(port)], {
            cwd: join(ROOT, "web"), stdio: ["ignore", "ignore", "pipe"], detached: true,
        });
        children.push(server);
        let serverErr = "";
        server.stderr?.on("data", (d) => (serverErr += d));
        await waitForPort(port).catch((e) => {
            throw new Error(`${e.message}\n${serverErr}`);
        });
        url = `https://localhost:${port}/`;
    }

    const dport = await freePort();
    profile = mkdtempSync(join(tmpdir(), "motreader-chrome-"));
    const [w, h] = String(opt.size || "1280x900").split("x");
    const chrome = spawn(findChrome(), [
        "--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
        "--ignore-certificate-errors", "--no-first-run", "--no-default-browser-check",
        "--disable-extensions", `--window-size=${w},${h}`, "about:blank",
    ], { stdio: "ignore", detached: true });
    children.push(chrome);
    await waitForPort(dport);

    /** @type {any[]} */
    let targets = [];
    for (let i = 0; i < 50 && !targets.some((t) => t.type === "page"); i++) {
        targets = await fetch(`http://127.0.0.1:${dport}/json/list`).then((r) => r.json()).catch(() => []);
        if (!targets.some((t) => t.type === "page")) await new Promise((r) => setTimeout(r, 100));
    }
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome opened no page");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
    });
    const cdp = new Cdp(ws);

    let failed = false;
    const report = (/** @type {string} */ s) => process.stderr.write(s + "\n");
    cdp.listeners.push((method, p) => {
        if (method === "Runtime.consoleAPICalled") {
            const text = p.args.map((/** @type {any} */ a) => a.value ?? a.description ?? "").join(" ");
            if (p.type === "error" || p.type === "warning") report(`[console.${p.type}] ${text}`);
            else if (opt.verbose) report(`[console.${p.type}] ${text}`);
        } else if (method === "Runtime.exceptionThrown") {
            failed = true;
            const d = p.exceptionDetails;
            report(`[exception] ${d.exception?.description ?? d.text} (${d.url ?? ""}:${d.lineNumber})`);
        } else if (method === "Log.entryAdded" && p.entry.level === "error") {
            failed = true;
            report(`[${p.entry.source}] ${p.entry.text} ${p.entry.url ?? ""}`);
        }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url });
    await loaded;

    const evaluate = async (/** @type {string} */ expression) => {
        const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        }
        return r.result.value;
    };
    await evaluate("window.mr ? mr.ready.then(() => true) : Promise.reject(new Error('window.mr missing'))");

    if (typeof opt.load === "string") {
        const b64 = readFileSync(opt.load).toString("base64");
        await evaluate(`mr.load(${JSON.stringify(basename(opt.load))}, ${JSON.stringify(b64)})`);
    }
    for (const e of exprs) {
        try {
            const v = await evaluate(e);
            console.log(`> ${e}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);
        } catch (err) {
            failed = true;
            console.log(`> ${e}\n!! ${err instanceof Error ? err.message : err}`);
        }
    }
    const errors = await evaluate("mr.errors");
    if (errors.length) {
        failed = true;
        for (const e of errors) report(`[page error] ${e}`);
    }
    if (typeof opt.screenshot === "string") {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(opt.screenshot, Buffer.from(shot.data, "base64"));
        report(`screenshot: ${opt.screenshot}`);
    }
    ws.close();
    return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
});
