// @ts-check
/** Reading files the user picks, and handing files back as downloads. */

/** @typedef {{ name: string, bytes: Uint8Array }} PickedFile */

/**
 * Ask the user for files. Resolves with their names and bytes; an empty list
 * if the picker is cancelled.
 * @param {string} accept  e.g. ".csv,.yaml,.yml"; "" for any file
 * @param {boolean} multiple
 * @returns {Promise<PickedFile[]>}
 */
export function pickFiles(accept = "", multiple = false) {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.multiple = multiple;
        input.addEventListener("change", async () => {
            const files = [...(input.files ?? [])];
            resolve(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
        });
        input.addEventListener("cancel", () => resolve([]));
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
