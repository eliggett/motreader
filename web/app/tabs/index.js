// @ts-check
/**
 * The tabs, in display order. Adding a tab: write a module that exports a
 * `Tab` (see common.js) and list it here.
 */
import general from "./general.js";
import hex from "./hex.js";
import { placeholder } from "./common.js";

/** @type {import("./common.js").Tab[]} */
export const TABS = [
    general,
    placeholder("radiowide", "Radio-Wide", "Radio-wide settings arrive with the codeplug decoder."),
    placeholder("conventional", "Conventional", "Conventional settings arrive with the codeplug decoder."),
    placeholder("modes", "Modes", "The mode editor arrives with the codeplug decoder."),
    placeholder("zones", "Zones", "Zones and scan lists arrive with the codeplug decoder."),
    placeholder("head", "Control Head", "Control head buttons arrive with the codeplug decoder."),
    hex,
];
