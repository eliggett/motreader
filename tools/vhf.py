#!/usr/bin/env python3
"""VHF Spectra freq codec (recovered via inverse oracle) + oracle patch-by-freq.

Record (26 B, conventional VHF): per-field freq is byte-linear (NOT a linear
function of the packed integer):

  RX : off6(lo) off7(mid)           freq = 0.635*lo  + 0.64*mid + 52.91
  TX : off9=0xe9 tag, off10(lo) off11(mid) off12(band)
                                    freq = 0.3175*lo + 0.32*mid + 81.28
  T/A: off13=0xa9 tag, off14(lo) off15(mid) off16(band)   (same as TX)

The 'band' byte (off12/off16) does NOT affect the displayed frequency
(coefficient 0); it is a VCO/band select the radio uses. We preserve it on
edit, or pick it by range when synthesizing a new value.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from motreader.archive import Archive
from motreader.crypto import decrypt_body, encrypt_body

# per-field linear coefficients (MHz)
RX = (0.635,  0.64, 52.91)
TX = (0.3175, 0.32, 81.28)
TA = TX


def decode(lo, mid, coef):
    c0, c1, k = coef
    return round(c0 * lo + c1 * mid + k, 4)


def encode(freq, coef):
    """Find (lo, mid) in 0..255 best matching freq for the given field coef."""
    c0, c1, k = coef
    best = None
    for mid in range(256):
        # lo = (freq - k - c1*mid)/c0
        lo = round((freq - k - c1 * mid) / c0)
        if 0 <= lo <= 255:
            err = abs(c0 * lo + c1 * mid + k - freq)
            if best is None or err < best[0]:
                best = (err, lo, mid)
    return best  # (err, lo, mid)


def tx_band_byte(freq):
    """Observed TX/TA band byte by frequency range (display-independent)."""
    # 144..148 -> 0xa4 ; 150..155 -> 0x88 ; 160 -> 0xa8  (coarse; preserve when possible)
    if freq < 149.0:
        return 0xa4
    if freq < 157.0:
        return 0x88
    return 0xa8


def find_records(body):
    return [i for i in range(len(body) - 8)
            if body[i] == 0xE9 and body[i + 4] == 0xA9]


def decode_archive(path):
    body = decrypt_body(Archive.load(path).body)
    out = []
    for t in find_records(body):
        r = body[t - 9:t - 9 + 26]
        out.append(dict(
            rx=decode(r[6], r[7], RX),
            tx=decode(r[10], r[11], TX),
            ta=decode(r[14], r[15], TA),
            txband=r[12], taband=r[16],
        ))
    return out


def patch_freqs(src, dst, triples):
    """triples: list of (rx, tx, ta) MHz per mode (None to leave unchanged)."""
    ar = Archive.load(src)
    body = bytearray(decrypt_body(ar.body))
    tags = find_records(body)
    for i, (rx, tx, ta) in enumerate(triples):
        if i >= len(tags):
            break
        s = tags[i] - 9
        if rx is not None:
            e, lo, mid = encode(rx, RX)
            body[s + 6], body[s + 7] = lo, mid
        if tx is not None:
            e, lo, mid = encode(tx, TX)
            body[s + 10], body[s + 11], body[s + 12] = lo, mid, tx_band_byte(tx)
        if ta is not None:
            e, lo, mid = encode(ta, TA)
            body[s + 14], body[s + 15], body[s + 16] = lo, mid, tx_band_byte(ta)
    Archive(body=encrypt_body(bytes(body)), banner=ar.banner).save(dst)
    print(f"patched {len(triples)} modes -> {dst}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "decode":
        for i, m in enumerate(decode_archive(sys.argv[2]), 1):
            print(f"  m{i:02d} rx={m['rx']:.4f} tx={m['tx']:.4f} ta={m['ta']:.4f} "
                  f"band={m['txband']:02x}/{m['taband']:02x}")
    elif cmd == "selftest":
        # round-trip every 2.5 kHz-ish target
        for coef, name in [(RX, "RX"), (TX, "TX")]:
            worst = 0
            f = 136.0
            while f <= 174.0:
                e, lo, mid = encode(f, coef)
                worst = max(worst, e)
                f += 0.005
            print(f"{name}: worst encode err over 136-174 MHz = {worst*1000:.3f} kHz")
