// @ts-check
/** Reading files the user picks, and handing files back as downloads. */

/**
 * Ask the user for a file. Resolves with its name and bytes, or null if the
 * picker is cancelled.
 * @param {string} accept  e.g. ".csv,.yaml,.yml"; "" for any file
 * @returns {Promise<{ name: string, bytes: Uint8Array } | null>}
 */
export function pickFile(accept = "") {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.addEventListener("change", async () => {
            const f = input.files?.[0];
            resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
        });
        input.addEventListener("cancel", () => resolve(null));
        input.click();
    });
}

/** Offer `data` to the user as a download named `name`. */
export function download(/** @type {Uint8Array | string} */ data, /** @type {string} */ name, type = "application/octet-stream") {
    const blob = new Blob([typeof data === "string" ? data : new Uint8Array(data)], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
