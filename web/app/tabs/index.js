// @ts-check
/**
 * The tabs, in display order. Adding a tab: write a module that exports a
 * `Tab` (see common.js) and list it here.
 */
import general from "./general.js";
import modes from "./modes.js";
import zones from "./zones.js";
import hex from "./hex.js";
import tech from "./tech.js";
import { radioWideTab, conventionalTab, headTab } from "./settings.js";

/** @type {import("./common.js").Tab[]} */
export const TABS = [general, radioWideTab, conventionalTab, modes, zones, headTab, hex, tech];
