// @ts-check
// Shared paths and helpers for the Node tests.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fixHeaderChecksum } from "../../web/lib/codeplug.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GROUND_TRUTH = join(ROOT, "notes", "ground-truth");
/** The RSS install's archive folders (the user's real archives; tests skip if absent). */
export const SPECTRA = join(homedir(), ".dosbox", "c", "MRSS", "SPECTRA");

/** True if `cmd` is on PATH. */
export function hasCommand(/** @type {string} */ cmd) {
    try {
        execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/** A copy of `body` with its header checksum recomputed (what motreader writes). */
export function fixed(/** @type {Uint8Array} */ body) {
    const c = body.slice();
    fixHeaderChecksum(c);
    return c;
}
