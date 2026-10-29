"""Spectra RSS archive body cipher (recovered from the RSS binary).

The codeplug body (archive bytes after the 83-byte banner) is obfuscated with a
self-chaining byte cipher keyed off a per-save 13-byte plaintext nonce and a
fixed Microsoft-`rand()` LCG (seed 1). Recovered by tracing the decrypt loop in
the running RSS (Turbo Pascal; the decrypt store was at guest CS:IP 1c4d:025c).

Decryption (body = archive[0x53:]):

    plain[0:13] = cipher[0:13]                       # nonce, stored in the clear
    state = (cipher[2] + cipher[6] - cipher[8]) & 0xFF
    seed  = 1
    plain[13] = cipher[13] ^ state
    for k in 13 .. len-2:
        seed = (seed * 0x343FD + 0x269EC3) & 0xFFFFFFFF
        rand = (seed >> 16) & 0xFF
        state = (rand + state + plain[k]) & 0xFF
        plain[k+1] = cipher[k+1] ^ state

Encryption is the exact inverse; the nonce (first 13 plaintext bytes) is kept
from the original so re-encrypting an unmodified body is byte-identical.

Verified: byte-exact round-trip against RSS-decrypted codeplugs for multiple
archives/nonces.
"""

from __future__ import annotations

LCG_A = 0x343FD
LCG_C = 0x269EC3
NONCE_LEN = 13


def _init_state(body: bytes) -> int:
    return (body[2] + body[6] - body[8]) & 0xFF


def decrypt_body(cipher: bytes) -> bytes:
    """Decrypt a scrambled codeplug body to plaintext."""
    n = len(cipher)
    if n <= NONCE_LEN:
        return bytes(cipher)
    out = bytearray(cipher[:NONCE_LEN])  # nonce stored in the clear
    state = _init_state(cipher)
    out.append(cipher[NONCE_LEN] ^ state)
    seed = 1
    for k in range(NONCE_LEN, n - 1):
        seed = (seed * LCG_A + LCG_C) & 0xFFFFFFFF
        rand = (seed >> 16) & 0xFF
        state = (rand + state + out[k]) & 0xFF
        out.append(cipher[k + 1] ^ state)
    return bytes(out)


def encrypt_body(plain: bytes) -> bytes:
    """Re-encrypt a plaintext codeplug body. The first 13 bytes (nonce) are
    kept verbatim, so an unmodified body re-encrypts byte-identically."""
    n = len(plain)
    if n <= NONCE_LEN:
        return bytes(plain)
    out = bytearray(plain[:NONCE_LEN])
    state = _init_state(plain)  # first 13 bytes equal the ciphertext nonce
    out.append(plain[NONCE_LEN] ^ state)
    seed = 1
    for k in range(NONCE_LEN, n - 1):
        seed = (seed * LCG_A + LCG_C) & 0xFFFFFFFF
        rand = (seed >> 16) & 0xFF
        state = (rand + state + plain[k]) & 0xFF
        out.append(plain[k + 1] ^ state)
    return bytes(out)
