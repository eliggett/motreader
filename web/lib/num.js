// @ts-check
/** Number helpers that must agree exactly with the Python implementation. */

/**
 * Python's `round(x, nd)`: the exact binary value of `x` rounded to `nd`
 * decimals, ties to even. `toFixed` already rounds the exact value correctly
 * except on an exact tie, where it rounds away from zero; ties are detected
 * from the exact decimal expansion (`toFixed(100)` is exact for the magnitudes
 * codeplug values have).
 */
export function pyRound(/** @type {number} */ x, nd = 0) {
    if (!Number.isFinite(x)) return x;
    const exact = Math.abs(x).toFixed(100);
    const dot = exact.indexOf(".");
    const tail = exact.slice(dot + 1 + nd);
    let r = Number(x.toFixed(nd));
    if (/^50*$/.test(tail)) {
        // exact tie: toFixed went away from zero; Python goes to the even neighbour
        const scaled = Math.round(Math.abs(r) * 10 ** nd);
        if (scaled % 2 === 1) r = Math.sign(x) * (scaled - 1) / 10 ** nd;
    }
    return Object.is(r, -0) ? 0 : r;
}
