# Motorola Spectra RSS archive format

Reverse-engineered specification of the archive files written by the Motorola
Spectra Radio Service Software (RSS **R06.00.05**, RVN4001N; 16-bit MS-DOS,
Turbo Pascal). No public decoder existed; this was recovered from scratch.
Everything here is implemented and tested in `motreader/`.

## 1. Files on disk

| File | Format | Status |
|---|---|---|
| `SPECTRAM.DBF`, `SPE.DBF` | dBASE III archive index | **Decoded** — `motreader/dbf.py` |
| `A<serial>.<ext>` / `B<serial>.<ext>` | archive (banner + encrypted codeplug) | **Decoded** — `archive.py` + `crypto.py` |
| `SPECTRA.CFG` | RSS config (archive paths, screen colors) | not needed |
| `SPECTRA.ATB`, `SPECTRA.BTS` | misc RSS state | not examined |

Archives come in `A`/`B` pairs per radio. Saving from RSS rewrites the `A` file
and updates the DBF (stamping the current date); the `B` file is a prior copy.
Each save re-randomizes the encryption nonce, so `A` and `B` — and successive
saves — look completely different on disk even for identical codeplug content.

## 2. DBF index (`SPECTRAM.DBF`)

Standard **dBASE III** table mapping radios to their archive files:

| Field | Type | Width |
|---|---|---|
| `SERIAL` | C | 10 |
| `MODEL` | C | 16 |
| `FILENAME` | C | 12 |
| `DATEPGM` | D | 8 (ASCII `YYYYMMDD`) |
| `CUSTOMER` | C | 15 |

Record length 62 (1 deletion-flag byte + 61). RSS quirks required for a
byte-exact rewrite: the header is one byte larger than the dBASE minimum (a
`0x00` pad after the `0x0D` field terminator), and files carry **no** trailing
`0x1A` EOF marker. Dates stored as `(year-1900)` in the file header byte.

## 3. Archive file container

```
[ banner ][ encrypted codeplug body ]
```

Two banner variants:

- **Long** (83 bytes, `0x53`) — the common case:
  `Requires MOTOROLA Radio Service Software For Spectra\r\nCOPYRIGHT MOTOROLA INC.,1987\x1a`
- **Short** (52 bytes, `0x34`) — rare, older format: the prefix
  `Requires MOTOROLA Radio Service Software For Spectra` only.

The body is everything after the banner. **Note:** the single short-banner file
present (`AR-ORIG/A428TWN2.810`) has never been readable (even in RSS) and uses a
different/older scheme; it is out of scope.

## 4. Body cipher — SOLVED (`motreader/crypto.py`)

A self-chaining byte stream cipher. The keystream byte is a running `state` that
folds in a Microsoft-`rand()` LCG (fixed seed 1) and the previous plaintext byte.
The per-save randomness is a **13-byte nonce stored in the clear** at the start
of the body, which only sets the initial `state`.

```
body = archive[banner_len:]
plain[0:13] = cipher[0:13]                          # nonce, in the clear
state = (cipher[2] + cipher[6] - cipher[8]) & 0xFF  # initial state from nonce
seed  = 1
plain[13] = cipher[13] ^ state
for k in 13 .. len-2:
    seed  = (seed * 0x343FD + 0x269EC3) & 0xFFFFFFFF   # MS rand() LCG
    rand  = (seed >> 16) & 0xFF
    state = (rand + state + plain[k]) & 0xFF
    plain[k+1] = cipher[k+1] ^ state
```

Encryption is the exact inverse; keeping the original nonce makes an unmodified
body re-encrypt byte-identically (ideal for lossless template-patch writes).

**Verified:** output matches RSS's own decryption byte-for-byte (two nonces);
byte-exact round-trip on all 51 long-banner archives; decrypted plaintext entropy
drops from ~7.98 to ~4–5.7 and contains readable ASCII (`COPYRIGHT MOTOROLA
INC.,1987`, serial, model).

### How it was recovered (reproducible)

The built-in dosbox-x savestate crashes (`buffer overflow detected`), so a custom
memory spy was patched into the dosbox-x source (`dosbox-x/`):

- `src/hardware/memory.cpp`: `MEM_SpyDump` (periodic low-RAM dump), `MEM_SpyWatch`
  (dense dumps during decode), `MEM_SpyDumpBuf`, and `MEM_SpyWrite` (write
  watchpoint logging CS:IP of writes into the codeplug buffer).
- `src/dos/dos.cpp`: INT 21h read hook that recognizes the archive banner and
  arms the spy.
- Gated by env `DOSBOX_SPYDIR`; build normally, run RSS with `core=simple` so the
  write-watchpoint sees CPU stores.

The write-watchpoint pinpointed the decrypt store at guest `CS:IP 1c4d:025c`;
disassembling around it (and the RNG at `cb6:7268`, the seeder at `cb6:7256`)
gave the algorithm, confirmed against captured plaintext (`tools/oracle_spy.sh`,
`tools/find_plain.py`).

## 5. Decrypted codeplug layout (`motreader/codeplug.py`)

Offsets are into the decrypted body (566AYA0014, 900 MHz example). Field mapping
was done by correlating against the RSS **PRINT** (MODE/RADIO SUMMARY, captured
via dosbox-x parallel-port-to-file) and by the **differential oracle**: edit one
field in RSS, save, decrypt both, diff the plaintext (the per-save nonce no
longer interferes once decrypted).

> **On-disk ≠ in-RAM (white-box, 2026-10-22).** This section describes the
> **on-disk decrypted body**, which is what motreader reads/writes and what the
> codecs below are fit to (validated byte-exact). RSS itself does **not** keep
> the codeplug in this form in memory: at GET it parses the body into a working
> image of **decoded strings/enums** (frequencies become TP ASCII strings like
> `"146.52000"`; the on-disk freq bytes do not survive). That's why the codecs
> here are "on-disk byte → value" relations, computed by RSS once at load. For
> fields not yet mapped on disk (per-channel power, compander, …), the Phase-1
> harness can read RSS's already-decoded working-image value directly — see
> `notes/PHASE1-HARNESS.md` §13.

**Older format versions (101–114; 2026-10-25).** RSS R06 opens and saves these
in their own version (the 3 digits after the serial). Seen on AR-ORIG samples:
101/102 (900 MHz, all trunked or trunked + one conventional mode), 112 (VHF,
900 MHz mixed) and 114 (VHF, 900 MHz mixed). What is known:
- The mode pointer table is there (header 0xED, n = 0x109, record length
  0x10A) with the usual base **0x5F53**, but there is no radio-wide ext block
  to derive the base from.
- The conventional record is the current one for its first 24 bytes (VHF: view
  +3..+26; 900 MHz conventional records match the 900 layout too), with its
  8-bit sum at **true start +23**, followed by a per-mode scan list (the record
  length grows with the mode count: 33, 35, 36 on the samples).
- Mode names: the 6-bit table at 0x266, as now.
- Zones, radio-wide settings and lists are not mapped (the zone finder matches
  the phone list on v112).

Versions 112 and 114 (VHF) were checked: every one of 145 modes decodes as RSS's
MODE SUMMARY prints it; web-app edits (names, 5 / 6.25 kHz RX, RX ≥ 166.15, TX,
T·A, PL, DPL, MDC PTT ID) GET with no warning, show in RSS, and RSS re-saves the
file byte-identically; RSS's own edits leave valid sums at +23. motreader opens
them **modes only** (`support.js`); 101 and 102 stay read-only. On both v112/114
VHF radios RSS shows Transmit Power as "Not Avail" (and MPL Type on one), so
those bits have no effect there.

Header / global:
- `0x00`: 13-byte nonce, then padding.
- `0xAD`: `COPYRIGHT MOTOROLA INC.,1987` signature.
- `0xCA`: serial + codeplug version (`566AYA001400 115A`).
- `0xF1`: model/tanapa (`D37KGA5JB5FK`).

Mode alpha-tag table — `0x266`, **6 bytes/mode**, 8 chars 6-bit packed
(`char - 0x20`, MSB first). Mode N at `0x266 + 6*(N-1)`. Same offset on the
standard VHF and 900 samples.

**A9 / "CONVENTIONAL EXPANDED" head (longer names).** Radios with the A9 Systems-
9000 remote head (e.g. `T83FWA7HA9AK`, 221AZN) store mode names as **fixed-width
plain ASCII** (11 chars seen; left-justified, space/NUL padded), *not* 6-bit
packed, and leave the `0x266` table blank (or sparse garbage). The ASCII table is
in mode order at a dynamic offset.

It is located **structurally and content-independently** (`find_ascii_name_table`
→ `_find_name_table_by_defaults`): RSS fills every *unprogrammed* mode slot with
the fixed default name `MODE <n>` (n = the 1-based mode number), with the number
right-justified to the field's end. Those defaults appear verbatim on a constant
stride, and each one pins the table exactly — `width` = the stride between
consecutive defaults, `start = match.end() - n·width`. Every default agrees on
one `(start, width)`, so the locator keys off Motorola's own default string, not
off what the user named the programmed modes. (This is why there are far more
`MODE nn` entries than conventional modes — the default pool is shared and runs
well past the conventional table.)

Only a *fully* programmed codeplug (zero default slots) lacks this anchor; that
rare case falls back to a frequency-correlation heuristic
(`_find_name_table_by_freq`): among the constant-width printable runs, pick the
one whose entry digits best match the decoded mode RX frequencies (ham names
embed the channel freq). The decoder auto-selects 6-bit vs ASCII by which
actually yields readable names, so standard heads are unaffected.

The mode-record layout and the per-channel frequency encoding are **band-specific**
(`codeplug.py` detects the band from the body structure and branches):

### 5a. VHF conventional — SOLVED (validated byte-exact vs RSS)

Records are a run of **26-byte** records located structurally by their tag bytes:
TX tag `0xE9` at record offset 9, T/A tag `0xA9` at offset 13 (consistent stride
26). RX, TX and T/A are three **independent** fields; each is a two-byte value
`(lo, mid)` whose **displayed frequency is linear in the individual bytes** (not
in the packed integer):

| Field | bytes (rec offset) | `freq_MHz =` |
|---|---|---|
| RX  | lo=6,  mid=7            | `0.635·lo  + 0.64·mid + 52.91` |
| TX  | lo=10, mid=11, band=12 | `0.3175·lo + 0.32·mid + 81.28` |
| T/A | lo=14, mid=15, band=16 | `0.3175·lo + 0.32·mid + 81.28` |

The TX/TA coefficients are exactly **half** the RX ones; the ratio `c1/c0 = 128/127`
gives 2.5 kHz tuning resolution (5 kHz for RX) via `mid − lo`. The third **band
byte** selects the VCO band and has **zero effect on the displayed frequency** —
it is preserved on edit and set by frequency only for a brand-new value (rule
below). An unchanged field keeps its original bytes for lossless re-encrypt.

**Encoding = synthesizer counts (2026-10-24, RSS sweep).** Each field is a step
count `C = 127·lo + 128·mid` (`freq = step·C + k`, step 2.5 kHz TX/TA, 5 kHz RX),
which fits a 127/128 dual-modulus prescaler: `N = 127·Np + A` with **mid = A, the
swallow count**, and lo = `Np − A − 256` (8 bits; the TX offset 81.28 MHz =
32512 steps = 127·256). Most frequencies therefore have two byte pairs, mid and
mid+127, that RSS *displays* the same; **RSS always writes the smaller mid**
(every one of the 6818 VHF frequency fields in the RSS saves on hand has
mid < 127; TX 162.56 MHz, C = 127·256, is written lo=128 mid=127, the only form).
The other pair may well not tune the same, so motreader writes RSS's:
`mid = C mod 127` (or 127 when that needs lo > 255). Until 2026-10-24 motreader
picked whichever pair had the smaller floating-point error, e.g. TX 146.415 as
lo=58 mid=146 where RSS writes lo=186 mid=19.

**Not every TX/TA frequency above 165.74 MHz can be stored**: when `C − 128·mid`
needs lo > 255 (C > 32385 + 128·(C mod 127)), no pair exists. RSS accepts such a
value without complaint and stores a *wrapped* one (617ASQ: TX 165.75 saved as
84.47, 174.0 as 92.72); 165.0, 170.25 and 171.0 store fine. motreader refuses
them. RX (offset 52.91 MHz) is unaffected in 136–174.

**Band byte rule** (`tools/scenario_vhf_band_sweep.py`, 181 points typed into
RSS on 617ASQ, 144–174 MHz, plus 221AZN's saves): 6 MHz bands with exact
boundaries, `v = ⌊(f − 126) / 6⌋` clamped to 3..7, byte = `0x80 | v0<<5 | v1<<2 | v2<<3`:

| TX/TA MHz | byte | v |
|---|---|---|
| below 150 (seen down to 142 on 221AZN) | `0xA4` | 3 |
| 150–156 | `0x88` | 4 |
| 156–162 | `0xA8` | 5 |
| 162–168 | `0x8C` | 6 |
| 168–174 (174.000 included) | `0xAC` | 7 |

(The earlier rule, `0x88` up to 157 and `0xA8` above, was wrong for 156–157 and
above 162 MHz.) Data: `notes/ground-truth/vhf_band_rss/`.

**RX on a 6.25 kHz raster (2026-10-25, RSS sweeps on 617ASQ and an AR-ORIG v112
radio; 78 values typed into RSS, encoded byte-exact).** The RX field is the same
synthesizer count as UHF's, on a **5 kHz or 6.25 kHz** reference:

| Field | MHz | flags |
|---|---|---|
| RX (+6/+7) | `step·(127·(lo + 256·(+5).b0) + 128·mid) − 109.65` | +5 b0 = lo's 9th bit; flag byte +8 = `b0 6.25 kHz \| b2 ≥ 166.150 MHz` |

- Every 5 kHz value has +5 b0 set (and +8 b0 clear), which makes this the
  linear `0.635·lo + 0.64·mid + 52.91` above; 6.25 kHz values (145.6125,
  146.50625 …) need the general form (e.g. 145.6125 = lo 0xF6, mid 0x4B, +5 b0
  clear, +8 = 0x01). The 6.25 kHz flag is the opposite of UHF's (where b0 marks
  5 kHz): it marks the step that isn't the band's usual one.
- RSS uses 5 kHz when the frequency is on that raster, else 6.25 kHz, else
  refuses it. mid = count mod 127 (the smaller swallow count, as TX).
- Flag b2 switches exactly at **166.150 MHz** (166.145 and 166.14375 clear;
  166.15 and 166.15625 set), for both steps. No sample had an RX that high, so
  b2 was never seen set before.
- RSS's RX limits are per model: both radios refused 136.0–140.0 ("Outside
  Range"); the v112 one took 144.0–174.005.
- TX/T·A keep the 2.5 kHz codec above.

### 5a-UHF. UHF conventional — SOLVED (2026-10-25, validated vs RSS)

Mapped on a 440–490 MHz A9-head radio (model T84FWA…, a third-party AR-ORIG
sample; only the codec is recorded here) with `tools/scenario_freq_sweep.py`:
type frequencies into RSS's MODE screen, SAVE, read the bytes. **The record is
the VHF one** (26-byte view = true − 3; tags at +9/+13; tone slots +17..+22 in
the same codec; option bits as VHF), so motreader parses UHF with the VHF code
and a different frequency codec. It is the same 127/128 dual-modulus
synthesizer as VHF (`N = 127·Np + A`, mid = A), on a **6.25 kHz or 5 kHz**
reference:

| Field | MHz | flags |
|---|---|---|
| TX (+10/+11), T/A (+14/+15) | `step·(127·(lo + 256 + 256·tag.b1) + 128·mid)` | tag (+9/+13) b1 = lo's 9th bit, b0 its complement (E9/EA); band byte (+12/+16) = `0x80 \| b0 5 kHz \| b2 ≥ 467.000 MHz` |
| RX (+6/+7) | `step·(127·(lo + 512 + 256·(+5).b0) + 128·mid) − 109.65` | +5 b0 = lo's 9th bit; flag byte +8 = `b0 5 kHz \| b2 ≥ 467.000 MHz \| b3` |

- 109.65 MHz is the first IF (the same as VHF and 900 MHz: the RX synthesizer
  runs that far above the receive frequency).
- RSS uses the 6.25 kHz reference when the frequency is on that raster
  (460.000, 460.025 …), else 5 kHz (444.44); other values are mostly refused.
  RSS sometimes writes a 2.5 kHz form (band byte b1) that isn't decoded —
  motreader opens such a codeplug read-only.
- RSS forces TX/T·A power **Low above 470.000 MHz** (tag b6 cleared); this
  radio accepted 440–490 MHz.
- Band byte b2 / flag b2 switch exactly at 467.000 MHz (466.99375 still clear):
  two VCO ranges, not VHF's 6 MHz bands.
- Flag b3: RSS sets it on every save (an unedited GET+SAVE sets it on all 19
  modes that had it clear); it doesn't change the frequency.
- Detection: TX tag E9/EA, a TX band byte 0x80..0x87 (VHF's always has b3 or b5
  set) and an RX that reads as UHF.
- Entering some RX frequencies makes RSS change uP Xtal Shift (+3 b4) with a
  "Crystal Frequency Will Be Shifted" dialog; motreader leaves it as a setting.

Validated: all 49 modes of the sample decode as RSS's MODE SUMMARY prints them;
134 values typed in RSS encode to its exact bytes; a web-app edit (6.25 and
5 kHz RX/TX pairs, a TX above 470 MHz) GETs with no warning, shows every value,
and RSS's re-save differs only by RSS's own normalizations (flag b3, and the
stale +20 b1 it clears on viewed modes).

### 5a-800. 800 MHz conventional — decoded, not edited (2026-10-25)

Two AR-ORIG radios (model D45…, RSS: "800 Mhz", both TRUNKED DUAL MODE with a
trunked mode 1) keep their conventional modes in the VHF record, with the UHF
form of the codec on a **12.5 kHz** reference:

| Field | MHz |
|---|---|
| RX (+6/+7) | `0.0125·(127·(lo + 256·(+5).b0) + 128·mid) + 109.65` (the IF is *added* here) |
| TX (+10/+11), T/A (+14/+15) | `0.0125·(127·(lo + 256 + 256·tag.b1) + 128·mid)` |

All 11 conventional modes decode as RSS's MODE SUMMARY prints them (tones in
the VHF slots too). As on 900 MHz, RSS shows **TX = the TX field when
programmed, else the T/A field** (a simplex mode). Band bytes seen: 0x88
(806–808 MHz), 0x8C (853 MHz). Detection: VHF tags with an RX that reads as
800 MHz and not as VHF. Until 2026-10-25 these decoded as VHF with nonsense
frequencies (RX ≈ 187 MHz) and opened editable, the trunked mode 1 included.
Encoding isn't mapped (the band byte, RX flag bits), so 800 MHz codeplugs
open read-only.

Trunked records in a VHF-layout table are recognised by their length byte at
true start +1, `0x25` (37) or `0x2F` (47), after a byte below 0x80 (0x1F / 0x20
/ 0x21); a conventional record starts with a flag byte with bit 7 set (0x84 /
0x94 / 0xB4 on every sample). They are listed with no values and never written.
In the mode pointer table the trunked records come first, at their own length,
before conventional records `0x10A` apart, and the band is voted on the
conventional records only.

### 5a-UHF2. The 403–441 MHz range — SOLVED (2026-10-29, RSS sweep)

518ATN (model `D44ZXA5JC7AK`, K1IMD's set, format 115, standard head) has four
47-byte trunked modes, then 24 conventional modes in the VHF record. The UHF
codec above decodes them: modes 20–28, named `430.600` … `430.800`, decode to
exactly those frequencies, and the rest are 430.05–430.375 RX / 431.65–431.975
TX and one 444.1 / 449.1 MHz repeater pair (PL 123.0). The band split
differs from the 440–490 MHz radio's. `tools/scenario_freq_sweep.py` on this
radio (145 values typed into RSS; data `notes/ground-truth/uhf_403_rss/`):

| | b2 set from | RSS accepts |
|---|---|---|
| RX flag byte (+8) | **418.000 MHz** (417.99375 clear) | 403.000–441.000 |
| TX / T·A band byte (+12 / +16) | **421.000 MHz** (420.99375 clear) | 403.000–441.000 |

Everything else is the codec above: all 91 accepted values encode to RSS's
exact bytes with these splits. No power limit was seen (High kept to 441 MHz).

**RSS's own tables (SPECTRA1.EXE, 8-byte doubles).** The splits come from per-
range VCO tables: RX at file offset 0x4E1B8, `(low, split, split, top)` per
range, after the VHF ones; TX at 0x4E308, `(split, top)`, repeated at 0x4E470.
The entry limits (what RSS lets you type) are at 0x4B60A.

| Range (RX low–top) | RX b2 from | TX b2 from |
|---|---|---|
| 403–441 | 418 | 421 |
| 438–470 | 454 | 458 |
| 440–491 | 467 | 467 |
| 453–491 | 468 | 468 |
| 475–515 | 495 | 500 |

b2 selects the upper of two VCO segments, `split ≤ f ≤ top`. Two rows are
confirmed by sweeps (403–441 here, 440–491 on the A9 radio); motreader uses
only those two. RSS has nothing above the top. 518ATN's mode 5 (444.1 / 449.1
MHz, PL 123.0) has b2 **clear** on both fields, and K1IMD, a Motorola tech,
programmed it into a working radio, so above the top b2 is clear: the window
rule. (444.1 / 449.1 is also what the 438–470 range would write, splits
454 / 458; the channel may have been programmed under that range.)

motreader keeps the ranges in `UHF_RANGES` and picks a codeplug's range by
whose rule its modes' b2 bits follow, the model's band letter (the one after
the band digit: `D44Z…` = 403–441; `D44K…`, `T44K…` = 440–491) deciding
first. A codeplug that fits no range opens read-only. Frequencies outside
RSS's entry limits are stored by the window rule and noted in the UI.

**RSS normalizations seen on re-save** (not motreader's doing; same on the
unedited original, `vhf_band_rss/rss_617asq_resave_*`): on 617ASQ, viewing a mode
screen clears a stale bit `true +20 b1` in that mode's record (and fixes its
sum), and any GET+SAVE turns the byte at body 0x660 (just past the mode table)
from `0xFF` to `0x00`. Home mode outside the home zone is moved to the zone's
first mode on save.

Recovered with the **inverse oracle**: template-patch a chosen stored value into
the record, re-encrypt, let RSS decode + PRINT the MHz. A byte-linear least-squares
fit over the oracle map was machine-exact (err ≈ 5·10⁻¹⁴), then confirmed by a
second run across 136–174 MHz with independent ±600 kHz splits (`tools/invsweep.py`
for value→MHz mapping, `tools/vhf.py` for the codec research). The same codec is
in `motreader/codeplug.py`.

**Record location** is anchored on the longest 26-byte-stride run of the TX/T·A
tag pair (`0xE9` @ rec offset 9, `0xA9` @ offset 13) and then **extended** in both
directions over adjacent valid records (`find_vhf_records`). The extension picks
up RX-only modes — e.g. NOAA weather — whose TX/T·A fields are blank (tag bytes
`0x68`/`0x28`, value bytes zero) and which would otherwise split the tag run. A
TX or T·A field is **"Blank"** exactly when both value bytes are zero (the tag
byte itself varies — `0xE9` and `0xA9` both occur for programmed T·A).

**Power level is encoded in the tag bytes (white-box, 2026-10-22).** The two
"tag" bytes are not opaque markers — **bit 6 (`0x40`) = power High/Low**:
- `rec+9`  (the `0xE9`/`0xA9` TX tag):  bit6 set → **Transmit Power High**, clear → Low.
- `rec+13` (the `0xA9`/`0xE9` T·A tag): bit6 set → **Talkaround Power High**, clear → Low.

Derived by the **harness-driven differential** (`tools/field_diff.py`,
`tools/scenario_map_screen.py`): toggle the field in RSS (closed-loop via the
screen reader), SAVE, decrypt-diff vs a double baseline (noise & the save-side
checksum block subtracted). Confirmed causally (toggling flips exactly that bit)
and across 221AZN's 65 modes.

**Per-mode record flag/field map (26-byte record; offsets are rec-relative):**

| rec off | field | encoding |
|---|---|---|
| +3  | uP Xtal Shift / MPL Type | bit4 = uP Xtal; bits5–6 = MPL Type |
| +4  | MDC PTT ID / Phone Encode | bit7 = MDC PTT ID; bit5 = Phone Encode (bit0 also toggles) |
| +6,+7 | **Rx frequency** | known byte-linear codec (confirmed white-box) |
| +9  | TX tag `0xE9` / **Transmit Power** | bit6 = power High(1)/Low(0) |
| +10,+11 | **Tx frequency** | known codec |
| +12 | Tx band (VCO) | no freq effect |
| +13 | T·A tag `0xA9` / **Talkaround Power** | bit6 = power; clearing TA zeroes +13..+16 |
| +14,+15 | **T·A frequency** | known codec |
| +16 | T·A band (VCO) | |
| +17..+22 | PL/CTCSS tones + DPL codes | PL + DPL/INV.DPL, decode **and** encode; 3 slots: Rx +17/18, Tx +19/20, T·A +21/22 |
| +24 | Call Signalling | bit6 = MDC (partial — see below) |

**MPL Type (rec+3 bits 5–6)** — full value set, derived by cycling the field in
RSS (`tools/scenario_cycle_enum.py`): bit5 = TX, bit6 = RX.

| bits5–6 | value |
|---|---|
| `00` | Disabled |
| `01` (bit5) | TX Only |
| `10` (bit6) | RX Only |
| `11` | RX & TX |

**Call Signalling (rec+24 bit6) — partially mapped, deferred.** Cycling it showed
three UI values (Disabled / MDC / DTMF) but only **MDC** sets `rec+24` bit6;
**DTMF stores byte-identically to Disabled** (empty body diff) — DTMF evidently
needs separate DTMF sub-config to persist distinctly. So it is not a clean
single-byte enum and is **not wired into the CSV** (would be lossy); `rec+24`
bit6 is effectively an "MDC call-signalling" flag. Revisit with DTMF config.

Decoded + encoded in `motreader/codeplug.py` (CSV columns `tx_power`, `ta_power`,
`up_xtal_shift`, `mdc_ptt_id`, `phone_encode`, `mpl_type`); each encodes
bit-surgically (template-patch preserves all other bits) and was validated
loading correctly in real RSS.

Global (radio/options region, not per-mode): **Channel Chg ID Register**
≈ `0x24a` bit1 / `0x24d`. These per-channel options live on the RSS **MODE /
MODE OPT 1** screens, **not** in any PRINT; MODE UTILITY (F8) is an operations
menu (DELETE/COPY BLOCK), not field data. Audio Compander / Adaptive Splatter /
Data Mode Control read "Not Avail" on this VHF radio (not mappable here).

**Per-record checksum byte.** Every per-mode edit also flips bits in a byte at
`rec_base + 0x1c` (e.g. `0x71b` for mode 1) whose change tracks which record bits
changed — a per-record checksum/parity. Together with the save-side block below,
this is what the write path must reproduce (see checksum note).

> **Header checksum — the radio DOES check it (found 2026-10-30).** Body
> **0x1DE** (radio 0x6131) = **8-bit sum of body 0xF1..0x1DD** (radio
> 0x6044..0x6130: model, home mode, MDC IDs and the rest of the fixed header).
> RSS doesn't check it on GET, but a radio programmed with a stale one shows
> **FL 01/82** ("codeplug checksum") at power-on and doesn't start. It holds in
> every archive on hand; motreader recomputes it on every write path
> (`fix_header_checksum` / `fixHeaderChecksum`). The radio also maintains it
> itself (firmware 0xB566, after storing the home mode at 0x6062). Details in
> RADIO-PROTOCOL.md. The rest of the note below stands: the other per-save
> bytes are stamps, not checksums.
>
> **Write-path checksums (earlier conclusion, now amended above).**
> RSS writes two save-side artifacts the on-disk field edits don't touch:
> - a **per-save metadata block** `{0xdc, 0xf0, 0x1bc–0x1bf, 0x1de–0x1e5}` — NOT
>   data-derived (it differs between two identical-data saves when they cross a
>   clock tick), i.e. a save timestamp/counter, not an integrity checksum;
> - a **per-record checksum/parity byte** at `rec_base + 0x1c` (data-derived;
>   flips with the record's changed bits).
>
> **RSS does not verify either on GET.** A motreader template-patch edit (only
> the field bytes changed, both "checksums" left stale) was GET-loaded into RSS
> and displayed the edited value correctly (mode-1 Rx 146.52→**146.40000**), with
> no error. So motreader's write path needs **no** checksum recomputation to
> produce RSS-loadable archives. (Only PROGRAM-to-radio over a RIB is untested —
> the radio firmware *might* check — but that path is out of scope.) Verified via
> `tools/field_diff.py` + the harness GET; see `notes/PHASE1-HARNESS.md` §13.

**VHF PL (CTCSS)** — each mode record carries two tone slots, a 16-bit value
`(hi, lo)` big-endian with **bit15 = tone enabled**; the low 15 bits encode the
tone two different ways:

| Slot | bytes (rec offset) | `tone_Hz =` |
|---|---|---|
| Rx (decode) | hi=17, lo=18 | `(val & 0x7FFF) / 61.2428` |
| Tx (encode) | hi=19, lo=20 | `165596.6 / (val & 0x7FFF)` |

The Tx slot stores the tone **period**, the Rx slot a **freq-linear** value; both
map (nearest) to the standard CTCSS table. Validated byte-exact vs the 221AZN RSS
MODE SUMMARY (every Rx/Tx code). Modes commonly have Tx-only (PL encode, carrier-
squelch RX) or both. A third slot at off 21-22 holds the T·A tone (not printed by
RSS's two-column summary, and preserved rather than exposed).

**PL write — DONE (byte-exact, validated in RSS).** The `K` formulas decode every
tone correctly, but ENCODE is **not** a clean `round(f*K)` — RSS lands a few tones
one count off (Rx 162.2/192.8/179.9/206.5/82.5; Tx 179.9/114.8). So encode uses
**exact tone→byte tables** (`VHF_PL_RX_BY_TONE` / `VHF_PL_TX_BY_TONE`) captured by
cycling the 221AZN "TPL CODE" field through its whole list via the harness
(`tools/scenario_vhf_pl_table.py`), with the formula as a fallback for a tone the
head does not carry. This Spectra VHF head offers **40 CTCSS tones** (67.0–250.3,
the older "standard" set; it omits 159.8/165.5/171.3/177.3/183.5/189.9/196.6/
199.5/241.8/254.1). Writes are change-gated **on the decoded value** (so an
unchanged tone is byte-identical even where the formula would round differently),
handle Carrier↔PL↔DPL↔INV.DPL per slot, and were **validated end-to-end in real
RSS**: motreader set mode 1 → Rx TPL 141.3 / Tx TPL 123.0 and mode 5 → Rx 162.2 /
Tx 179.9 (both off-by-one tones), and RSS displayed them exactly. (900 PL *write*
is still preserved-only — only the Rx code byte is mapped there.)

**Squelch TYPE (both bands)** — a per-slot, derived field now exported as
`rx_squelch_type` / `tx_squelch_type`: **Carrier** (slot == 0, no tone), **PL**
(CTCSS, enabled and below the DPL threshold), **DPL**/**INV.DPL** (digital — VHF
slot ≥ `0xC000`; 900 code byte ≥ `0xC0`). This makes Carrier explicit and decodes
DPL modes that would otherwise read as blank PL.

**VHF DPL / INV.DPL — SOLVED (decode + encode, validated byte-exact vs RSS).**
221AZN (`T83FWA`, VHF) had no DPL mode, so one was added in RSS via the harness
(`tools/scenario_vhf_dpl_table.py`) and the Rx CODE field cycled through codes.
Result: **VHF stores the DPL code big-endian in the same 2-byte tone slot used by
PL** (Rx +17/18, Tx +19/20, T·A +21/22) using the **identical 83-value map as 900**
(`DPL_CODE_BY_PAIR`), with a single difference — **hi-byte bit `0x20` = normal
`DPL`; cleared = `INV.DPL`** (so an INV.DPL slot's bytes equal the 900 pair
exactly, and a normal-DPL slot is that pair `| 0x20` in the hi byte). Decode:
`code = DPL_CODE_BY_PAIR[(hi & ~0x20, lo)]`, polarity from `hi & 0x20`. Encode is
change-gated (unchanged ⇒ byte-identical) and writes exactly the Rx/Tx slot bytes;
polarity comes from `rx/tx_squelch_type` (DPL vs INV.DPL), else preserves the
original. **Validated end-to-end in real RSS**: motreader edits setting mode 2 →
`DPL D311` and mode 3 → `INV.DPL D023` GET-loaded and displayed `Rx DPL 311` /
`Rx INV.DPL 023`. 22 captured codes (both polarities) decode exactly; all 83 × 2
pairs are distinct. **Correction (2026-10-23):** that polarity sense holds for the
**Rx** slot only. In the **Tx** slot it is reversed (bit 0x20 SET = INV.DPL).
A motreader Tx "DPL 311" written with the bit set loaded in RSS as "Tx INV.DPL
311". Fixed (`is_tx` on the VHF DPL codec) and RSS-validated: Tx DPL 311 = `d5 49`,
Tx INV.DPL 023 = `f8 64`. No on-hand VHF radio had a Tx DPL, so no earlier export
changed. (VHF **PL** write is also done now — see the PL-write note above.)

### 5b. 900 MHz conventional — SOLVED (validated byte-exact vs RSS)

**Records are byte-linear in the same codec as VHF.** Three independent fields;
decode + encode validated byte-exact vs RSS (566AYA repeater modes, 604ATY
repeater + simplex, 617ASN 935-band, all via the inverse oracle):

| Field | bytes (rec offset) | `freq_MHz =` |
|---|---|---|
| RX  | lo=14, mid=15           | `0.0125·(255·lo + 256·mid) + 109.65` |
| TX  | carry=17, lo=18, mid=19 | `0.0125·(255·lo + 256·mid) + 816·(carry & 1)` |
| T/A | carry=21, lo=22, mid=23 | `0.0125·(255·lo + 256·mid) + 816·(carry & 1)` |

TX/T·A share one codec; RX uses the same `255·lo + 256·mid` form with base
**109.65** and no carry byte (RX-tag off13 is always `0xA0`). The TX/TA **carry
byte** (`0xE8/0xE9/0xA8…`) selects the VCO band: its **bit0 is a +816 MHz**
high-count (`0xFF00` × 12.5 kHz; `816 = 0.0125·0xFF00`); other bits (e.g. `0x40`)
don't affect the frequency. (The earlier `925.65 + 0.0125·off15` RX formula was an
approximation that only held when off14 correlated; the byte-linear form is exact
for every model, incl. 617ASN's 935–940 MHz band.)

**RSS display logic** (recovered on 604ATY): off17-19 is the repeater-input TX
(902 band), off21-23 the RX-side/talk-around TX. RSS shows **TX = off17-19 if
programmed, else off21-23** (a simplex mode); **T/A** only for a repeater mode.
An unprogrammed slot (no valid TX/TA carry byte) shows an RSS band default.

**Record location is structural and stride-agnostic** (`find_900_table`): a run of
records with RX-tag `0xA0`@off13 + end-tag `0x8C`@off24 at a constant stride —
**26 bytes** (566AYA) or **40 bytes** (604ATY, with 14 extra per-mode bytes) etc.
566AYA keeps its fixed `0x0D26` start (it has a special non-conventional mode 1).

- **Squelch code — SOLVED (decode + encode, validated in RSS).** The 6-byte block
  at rec+25..+30 holds the Rx code, a T·A code, and the Tx code:
  - **Rx code** = rec+25 (PL) / rec+25,+26 (DPL pair). **Tx code** = rec+29 (PL) /
    rec+29,+30 (DPL pair). rec+27,+28 = T·A code. Rx Code == Tx Code on every GT
    mode. (The +26/+29/+30 bytes fall in the *next* record's address space but
    belong to this mode's squelch — confirmed: patching them set this mode's code
    with the next mode undisturbed.)
  - **PL (CTCSS):** rec+25 byte `0x93–0xbf` indexes a tone (`PL_CODE_BY_BYTE`,
    incl. `0xa6=162.2`); `0x00` = Carrier.
  - **DPL (digital/DCS):** the code is the 2-byte pair (rec+25, rec+26). rec+25
    alone collides (566AYA `0xd8`→both `125` & `532`); the pair is unique. The full
    **83-code** standard DPL set (`DPL_CODE_BY_PAIR`) was captured by cycling the Rx
    CODE field in RSS (both directions) and **validated byte-exact vs the MODE
    SUMMARY GT: 566AYA 46/46, 617ASN 40/40** (and Rx 121/121, 52/52 over all modes).
    Codes shown as `D###` (e.g. `D411`). **Encode validated in real RSS:** a
    motreader edit `D411→D023` on mode 6 GET-loaded and displayed Rx/Tx DPL 023,
    next mode untouched. Writing a DPL code rewrites exactly rec+25,+26 (Rx) and
    rec+29,+30 (Tx); unchanged modes stay byte-identical.
  - 604ATY (stride 40) stores its code at a different record offset (not +25) —
    squelch decode there is a follow-up. (On 900 the pair has hi-byte bit `0x20`
    clear, which on VHF denotes INV.DPL; whether 900 exposes a normal/invert flag
    is untested — all on-hand 900 DPL modes are the bit-`0x20`-clear form. See the
    VHF DPL note in §5a for the shared codec.)

**900 per-mode options (mapped white-box via the harness; rec-relative).** These
appear on the RSS MODE / MODE OPT 1 screens and are NOT in any PRINT. The power
bits ride in bit6 of the TX/TA *carry* bytes — the bits the freq codec above
already noted as "don't affect frequency":

rec+11 and rec+12 are packed per-mode **flag bytes** (rec+11 on 617ASN baseline =
`0x94`, rec+12 = `0x7a`); the power bits ride in bit6 of the TX/TA *carry* bytes —
the bits the freq codec above already noted as "don't affect frequency":

| rec off | field | bit(s) | polarity / values |
|---|---|---|---|
| +11 | UnMute/Mute Type | 0x03 (bits0-1) | 0=Std/Std, 2=AND/Std, 3=AND/OR (1=Std/OR, unoffered) |
| +11 | **Reverse Burst/TOC** | 0x04 (bit2) | SET = Enabled |
| +11 | uP Xtal Shift | 0x10 (bit4) | SET = Disabled |
| +11 | MPL Type | 0x60 (bits5-6) | 0=Disabled, 0x20=TX Only, 0x40=RX Only, 0x60=RX & TX |
| +12 | **Audio Compander** | 0x08 (bit3) | SET = Enabled |
| +12 | Phone Encode | 0x20 (bit5) | SET = Enabled |
| +12 | Adaptive Splatter (a.k.a. **Flutter Filter**) | 0x40 (bit6) | SET = Enabled |
| +12 | **MDC PTT ID** | 0x80 (bit7) | SET = Enabled |
| +17 | Transmit Power (= TX carry byte) | 0x40 (bit6) | SET = High |
| +21 | Talkaround Power (= TA carry byte) | 0x40 (bit6) | SET = High |

Decoded + bit-surgically encoded in `codeplug.py` (CSV cols `audio_compander`,
`adaptive_splatter`, `mdc_ptt_id`, `phone_encode`, `reverse_burst_toc`,
`unmute_mute_type`, `mpl_type`, plus the shared `tx_power`/`ta_power`/
`up_xtal_shift`). All mapped by harness-driven cycling on the MODE and MODE OPT 1
screens and each **validated loading in real RSS**: a motreader edit (MDC
PTT ID→Enabled, Phone Encode→Disabled, Reverse Burst/TOC→Disabled, UnMute/Mute
Type→AND/OR — 2 bytes changed, rec+11 & rec+12) GET-loaded and displayed exactly.
The owner's "Flutter Filter" is just another name for **Adaptive Splatter**.

**CODED SQUELCH — deferred (preserved-only).** On 617ASN it shows `Conventional`
and is **not an editable tab stop** (becomes editable only under configs not
present on hand), so its on-disk bits can't be mapped differentially here. It is
left out of the CSV and preserved verbatim via the raw record bytes — the safe
default. (Likewise DTMF call-signalling sub-config, deprioritized by the owner.)

- Other 900 models (notably **D37KMA 617ASN**'s 935-band: now decoded via the
  universal RX formula) — all on-hand 900 archives except 221AZN (`T83F`, a
  different product line) decode. If no layout is recognized the band is flagged
  `900?` and only names/raw are exported (never bogus MHz).

Pointer/index table at `0x0C1B` (122 × u16, base `0x6c5f` ↔ `0x0D26`). Trunking
modes are present but out of scope (no key files; hams don't use it).

Other multi-row tables seen but not yet mapped: MDC/signalling (`0x15F+`).
Control-head buttons (RSS F6) → YAML, TODO.

### 5c. Zones — SOLVED (name + membership, validated vs the RSS zone editor)

A **zone** is a named group of modes; a mode may belong to several zones (RSS:
CHANGE/VIEW → RADIO-WIDE → ZONE LIST). The zone block is **three tightly-packed
parallel arrays of N entries** (N = zone count), located structurally by
`find_zone_block` (no fixed offset / no pointer — confirmed none exists). Cracked
and validated on all four on-hand zone-bearing radios:

| radio | head | N | W | names | memb @ |
|---|---|---|---|---|---|
| 566AYA | std 900 | 12 | 16 | 6-bit @0x7b7 | 0x8e7 |
| 617ASN1767 | std 900 | 4 | 7 | 6-bit @0x553 | 0x597 |
| 604AUN0331 | std 900 | 4 | 6 | 6-bit @0x51b | 0x55b |
| 221AZN0035 | VHF A9 | 12 | 9 | ASCII @0x1b44 | 0x46d |

| array | width/zone | contents |
|---|---|---|
| names | 6 B (6-bit) or ASCII | zone name (see head note) |
| flags | `W+3` B | per-zone scan-options byte (model-specific offset/value) + scan-list data |
| membership | `W` B | **mode bitmap**, bit `(mode-1)` LSB-first (bit0 of byte0 = mode 1) |

- **W (membership width) tracks the mode count**: `W ∈ {ceil(n/8), ceil(n/8)-1}`.
- **Flag record = `W+3` bytes.** Its scan-options byte repeats per zone at a
  model-specific offset/value (`0xF4`/`0xA0`/`0x78`/`0xF0` seen); decoded in §5l.
- **Name storage follows the head type, exactly like MODE names**: standard heads
  pack 6-bit (6 B/zone) immediately before the flag array; the A9/expanded head
  stores fixed-width ASCII as the N entries right before the ASCII mode-name table
  (so names live far from the flag+membership block). Names may contain `/` / `-`.

Decode membership: for each set bit at byte `i`, bit `b`, the mode is `i*8+b+1`.
Every stored zone is non-empty — **RSS deletes a zone with no modes on save**
(warning *"Empty zones will be deleted"*), so N = number of non-empty zones, no pad.

Locator: the **6-bit path** anchors on the 6-bit zone-name run (stops at
punctuation) then validates a periodic flag byte + membership after it. The
**ASCII path** anchors on the flag+membership block in the low binary region
(`<0x1000`) via the periodic flag byte, then maps N ASCII names before the mode
table. The flags→membership pad (0–8 B, varies) is resolved by choosing the
alignment that **minimizes the max mode number** (a byte-shift sprays bits into the
top byte, pushing it to the `W*8` ceiling), tie-broken by **max mode adjacency**.
Radios without zones yield none (617ASQ → 0; no false positives).

Write (template-patch, change-gated): zone **name** (repack 6-bit or write ASCII)
and **membership** (repack the `W`-B bitmap) only; the flag byte + the rest of the
`W+3` record (scan list) are preserved verbatim. Validated end-to-end in real RSS:
566AYA zone1→`ZEBRA` [2,3,18,99] and 221AZN zone1→`HAMZONE` [1,2,3,60] both GET-loaded
showing the new name + membership, other zones intact.

**A9-head caveat:** a 221AZN membership edit trips a dismissable *"Bad control head
checksum"* warning on GET (its membership block ~0x46d is inside the control-head-
checksummed region). RSS loads the data fine; the checksum is not yet recomputed —
crack it alongside the control-head buttons work. The 900 radios show no warning.

The flag record (scan-options byte, priority modes, zone scan list) is decoded
and editable since 2026-10-24 (§5l); add/delete zone is §5k.

Band note: the user hex-edited SPECTRA1.EXE per WA1MIK to allow 902-928 MHz ham
use. That changes the EXE's band *limits*, not the per-channel encoding, so the
archive decode is unaffected.

### 5d. Radio-wide settings — SOLVED (read + write, validated vs RSS on every radio)

RSS CHANGE/VIEW → RADIO-WIDE (F2) / its OPTIONS (F9) / SCAN OPTIONS (F6),
CONVENTIONAL (F3) / DTMF OPTIONS (F2) / MDC OPTIONS (F3), CONTROL HEAD → OPTIONS
(F6→F9). Mapped white-box with `tools/scenario_rw_map.py` (step one field, SAVE,
decrypt-diff) on 566AYA; decoded values checked against the captured RSS screens of
**all six** on-hand radios (`notes/ground-truth/rw_<serial>.json`,
`tests/test_radiowide.py`). Implementation + full field table: `motreader/radiowide.py`.

Two storage areas:

* **Fixed header** (absolute offsets, identical on every model seen — 900 trunked +
  conventional, VHF standard + A9 head):

| off | field |
|---|---|
| 0x0E3 | master overrides: b1 Audio Compandor, b2 Adaptive Splatter (900 only), b3 Time Out Timer, b4 Mode Names |
| 0x0E4 | b5 MDC Signalling (read-only: RSS also rewrites per-mode MDC bits) |
| 0x105 | b2 PTT Ignition Sense, b4 Scan Nuisance Delete, b6 Scan Off HUB (SET=Disabled), b7 HUB Switch |
| 0x109 | Max User Modes (= mode count; read-only) |
| 0x10B | low nibble Minimum Volume; b7 = Mode Names mirror |
| 0x10E | b0 Mode Change Tone, b1 Scan Pri-2 Activity tone, b2 Scan Pri-1 Activity tone, b3 PTT on Rx-Only Mode, b4 Volume Set Tone |
| 0x10F | Home Mode |
| 0x119 | Number of MPL (read-only: resizes the MPL table) |
| 0x1B3-4 | MDC Unit ID (BCD) |
| 0x1B5 | MDC Group ID (BCD) |
| 0x1B7 | hi nibble MDC Fleet ID; lo nibble MDC System Delay ×100 ms |
| 0x1B8 | b1 Sidetone, b3 PTT-ID Ending, b4 PTT-ID Beginning, b7 Signalling Type (SET=1200, clear=600) |
| 0x1B9 | b0 Channel-Busy-Wait = Infinite, b4 Emergency |
| 0x1C2 | Channel Busy Wait, 0.5 s units (when not Infinite) |
| 0x1D2 | b5 MDC Preamble |
| 0x1DD | Home Zone (0 = no zones) |

* **Radio-wide extension section** (position varies: 566AYA 0x9a8, 617ASN 0x5b4,
  221AZN 0x4da …). Self-describing: **byte0 = section length L** (0x8b; 0x95 on
  604AUN, whose extra 10 bytes are appended at the end), **byte L-1 = 8-bit sum of
  bytes [0, L-1)**; bytes 7,8 = mode count. Located by that signature
  (`find_ext_block`). RSS keeps the sum current; motreader recomputes it on edit
  (real RSS GETs the result with **no warning**). Offsets relative to the section:

| rel | field |
|---|---|
| +0x02 | b4 Subsequent Call Alert (SET=Disabled) |
| +0x03 | mirrors of Pri-1 (b3) / Pri-2 (b2) activity tones and Nuisance Delete (b0) |
| +0x04 | b0 Positional (zones) |
| +0x0A / +0x0B | Horn / Lights Time Out (s) |
| +0x24 | Scan Lookback Cycle Count |
| +0x2F-31 | DTMF Individual ID (BCD, 0xF-padded, up to 6 digits) |
| +0x32 | b2 DTMF End-of-Callback (SET=Disabled) |
| +0x33 / +0x34 / +0x36 | DTMF Digit / Interdigit / System Delay, ×5 ms |
| +0x6A / +0x6B | Speaker B Min Volume / Speaker B VIP Number |
| +0x6C | control-head options: b0-1 Default Dim (Off/Low/Medium/High), b2 Default Backlight, b4/b5/b6 High/Medium/Low Backlight (also changes with Control Head Type) |

Header bytes 0xDE–0xEF behave like a **section directory / pointers + a header
sum** (0xEF): they move when a table is resized (Number of MPL, Single Tone,
RAC). Such count fields are exported read-only — template-patch never resizes.

RSS side effects motreader deliberately does NOT replicate (it only flips the
master bit): toggling a master override in RSS also rewrites the matching bit in
every mode record, and Mode Names → Disabled resets every name to `MODE n`.

**PHONE LIST OPTIONS** (F3 → F7 → F9, conventional only), also in `radio_wide`:

| where | field |
|---|---|
| 0x174-0x175 + ext+0x45 hi nibble | Access Code: 5 dial chars in that nibble order, right-justified, 0xF = blank |
| ext+0x45 lo nibble + 0x176-0x177 | Release Code: 5 dial chars in that nibble order, left-justified |
| 0x178 | Digit Time ×5 ms |
| 0x179-0x17A | System Delay, big-endian 16-bit ×5 ms (617ASQ: 01 90 = 2000) |
| 0x1CA | Interdigit Time ×5 ms |

Dial nibbles (codes, phone numbers): 0-9, A = `*`, B = `#`, C = `P` (pause), F = unused.

**Control-head / accessory block (CHB)**: a third area. It follows the mode-name
table (after model-specific tables on the 604s): 566AYA 0x542, 617ASN 0x3A4,
617ASQ 0x2A2, 221AZN 0x230, 604AUN 0x3B6, 604ATY 0x596. Located by +0x66..+0x68 =
`04 80 00` plus its **checksum: the 8-bit sum of [+0x1E, +0x11E) stored at
+0x11E** (`find_chb_block`; unique on all radios). motreader recomputes it, and RSS
GETs the result with no warning.

| where | field |
|---|---|
| hdr 0x17C b7 + CHB+0x5F b7 | Siren/P.A. Options: b7 clear = Disabled; set + 0x5F b7 = PA only, else Siren/PA. **Editable** (see below) |
| hdr 0x17D b5 | Vehicle Repeater (read-only; enabling also writes CHB+0x17 b2, +0x1D, +0x27 and a table at CHB+0xAE) |
| CHB+0x18 b0, +0x13 b0 | Horn & Lights Rearm: Disabled / Enabled / Permanent (+0x13 b0) (read-only) |
| CHB+0x17 b3 / b4 | Internal PA / Speaker A/B ("Not Avail" while Siren/PA is on) (read-only) |
| CHB+0x5E | b0 Siren Ignition Sense, b1 Ex Rd Ignition Sense, b2 P.A. Ignition Sense, b3-5 Manual Siren Tone one-hot (Wail/Yelp/Airhorn), b7 siren/PA on |
| CHB+0x5F | low nibble Default P.A. Volume, b4 After Reset (SET=Off, else Last State), b5 Hilo/Airhorn Tones (SET=Disabled), b6 Option Audio Routing (SET=Disabled), b7 PA only |
| Control Head Type | 0x10D b5 clear = S9000e (A9, **fixed in RSS**); 0x10D b4 = Rotary; else CHB+0x17 b1 = Enhanced / clear = Standard. **Editable** among Standard / Enhanced / Rotary: see "Head type swap" below |
| hdr 0x10D b6 | Phone/DTMF Encode: 1 = Unlimited, 0 = List (read-only, derived: Rotary forces List; otherwise the model default = NOT 0x10D b1) |
| ext+0x74 (only the L=0x95 ext, 604AUN) | ADDITIONAL OPTIONS: b4 TX Mic Input Control (SET=Current), b5 Filtered Audio Thru Rear, b7 MIC Gain |

**CHB+0x1C/+0x1D = W, the control-head summary word — SOLVED.** W is the 16-bit
sum S of CHB bytes [+0x12, +0x1B), bit-interleaved MSB-first as s7 s15 s6 s14 …
s0 s8, stored big-endian. Found white-box by breaking on RSS's write of W into its
save buffer, which led to the encoder at SPECTRA4.OVL file offset 0x32911. It
matches all 22 distinct saved variants. Those bytes hold the Siren (+0x14 b2),
Rearm (+0x13/+0x18 b0), Internal PA / Speaker A/B (+0x17 b3/b4) and head-type
(+0x17 b1) bits, so changing any of them changes W. (The earlier "0x0004 when
siren + rearm" and "radio-specific base" were just this checksum.) motreader
recomputes W, then the CHB checksum, whenever it edits the CHB.

**Editable:** Siren/P.A. Options (hdr 0x17C b7, CHB+0x14 b2, +0x5E b7, +0x5F b7),
Horn & Lights Rearm, Internal PA, Speaker A/B. All 17 captured RSS transitions
reproduce byte for byte (tests keep the RSS saves in
`notes/ground-truth/siren_617ASN_rss/` and `accessory_566AYA_rss/`), and edits on
617ASN, 566 and 604AUN (incl. Siren/PA off with Rearm on) GET in RSS with no
warning. **Not exposed:** Vehicle Repeater (owner's choice, like SECURENET and trunking;
preserved verbatim). Header 0x1DE
changed with the siren on 617ASN: it is the header checksum (0x17C is in its range;
see the checksum note), which motreader now recomputes. PA only shows only the PUBLIC ADDRESS half of the
SIREN/PA screen. The SIREN settings appear with Siren/PA. Rearm, VRS, Internal PA,
Speaker A/B and head type stay read-only (base-W problem plus other side effects).

**Not yet mapped (preserved verbatim):** Zone Operation (RSS: disabling clears all
zone lists), VRS OPTIONS (sub-screen, needs Vehicle Repeater on; no on-hand radio
has it), Phone/DTMF Encode (Unlimited/List; not editable in RSS on these models, and
the bit is ambiguous across six samples), Dual Control Head, SYSTEM SEARCH AND LOCK
(604ATY only: per-mode table, likely the 8×6 block before its CHB), trunking timing,
DTMF/call lists, single tones. (Scan hang times and the CONVENTIONAL scan type /
list types are now decoded: §5l, §5m.)

**Head type swap** (`_encode_head`; RSS cycled both ways on 617ASN, 566AYA and
617ASQ plus 604AUN: all 16 transitions reproduce byte for byte, and two swaps
GET-loaded in RSS with no warning):

* Enhanced or Rotary: set 0x1CD b3 and CHB+0x17 b1, CHB+0x46 |= 0x0C (never
  cleared again), CONTROL HEAD OPTIONS ext+0x6C := 0x63 (defaults). The
  Standard head has no options screen; its byte is left as is.
* Rotary: also 0x10D b4; Phone/DTMF Encode → List (0x10D b6 = 0); Volume Set
  Tone (0x10E b4) off, shown "Not Avail"; Mode Change Tone becomes "Zone Mode
  Change Tone" and is turned off (0x10E b0) when Zone Operation is off (home
  zone 0, which matches Zone Operation on all six radios).
* Leaving Rotary: 0x10D b6 := NOT 0x10D b1 (model default).
* RSS warns "All names will be modified" on every swap, but no names changed
  for these radios.
* Ignored as save bookkeeping: 0xDA/0xDB also change on any RSS save.

### 5f. Control-head button map — SOLVED for all heads (buttons.csv)

`motreader/buttons.py`. A fixed header table of **20 × 4-byte entries at 0x123**
(function code = two 16-bit halves, e.g. Scan `02 00 02 01`, Phone `11 01 00 00`,
Blank `00 00 00 00`):

| entry | button |
|---|---|
| 0-4 | Ind 1 … Ind 5 (Ind 5 fixed "Sel": no RSS tab stop) |
| 5-7 | unused on these heads |
| 8 | key 0 |
| 9-17 | keys 1 … 9 |
| 18, 19 | `*` / `#`, fixed (code `02 02 00 00`, shown as Rcl / Del by position) |

**Airhn flag: CHB+0x46 b4** is set while some button holds Airhn (08 05 00 00)
and cleared when none does, with the CHB checksum (+0x11E). An RSS cycle of
604AUN Ind 1 through all 28 functions (2026-10-28,
`notes/ground-truth/buttons_604AUN_rss/`) changed nothing else outside the
button table. Also seen in that cycle and 617ASN's: `01 1a 00 00` = A/B
(Speaker A/B); ST's full name is "SingleTone".

Header **0x10D b1 set = no full keypad** (617ASN, 617ASQ): only Ind 1-5 and keys
7/8/9 exist. This is also why Phone/DTMF Encode defaults to List there. 32
function codes with RSS's short and full names (`buttons.FUNCTIONS`) were
collected from all six radios' KEYPAD screens and full function cycles (604AUN
Ind 1 = 28 functions incl. the siren set; 566 keys 1 and 7). Button positions
were mapped with `tools/scenario_map_buttons.py` and codes with
`tools/scenario_cycle_button.py`. Decode matches RSS on all five radios with this
head type, and edits on 604AUN and 566 GET-load in RSS with no warning. No
checksum involved. Duplicate functions are refused (RSS: "Duplicate Buttons!").

**A9 / S9000e head (221AZN) — SOLVED (`motreader/buttons_a9.py`).** Offsets for
221AZN; located from the A9 head checksum `ck` (0xDAF).

| area | where | content |
|---|---|---|
| 0x90 bitmap | ck+0x18 (0xDC7), 11 B | one bit per key record, MSB first; set when the copy-1 record's 2nd byte is 0x90 (Airhn, and records 0/1/5) |
| key map, copy 1 | ck+0x23 (0xDD2), 88 × 7 B | per record: 6-byte function template + 1 byte `flags (b7-6) \| key code (b5-0)` |
| key map, copy 2 | +0x268 (0x103A) | same layout; the trunking layer (Blank or a trunked variant for some functions) |
| indicator list | map+0x7D2 (0x15A4), 5-B entries, zero-terminated | `group, function, param, flags\|LED, x`; 21 fixed radio entries, then the Ind keys' entries in key-record order (Ind n = LED n+5) |

All of it is under the A9 head checksum (the same odd-address big-endian word
sum), which motreader carries by the edit delta.

Button → record (home code): Ind 1 19 (Sel, fixed), Ind 2 27 (0x14), Ind 3 35
(0x15), Ind 4 21 (0x16), Ind 5 29 (0x17), Ind 6 37 (0x18); keys 1-9 records 22,
39, 15, 23, 38, 14, 20, 18, 12 (code = digit); `*` 17 (RCL), `0` 34 (Sql, code 0),
`#` 10 (Del); Mode Dn 28, Mode Up 26, Vol Dn 33, Vol Up 36, Zone Up 25 (code
0x12), Home 9 (fixed). Records 40-87 hold the keypad layers (codes 0x19-0x32),
records 0-8 fixed head records; all preserved.

The key code is the key's home code unless the function has a fixed one (Mode
Dn/Scrl-Lt 0x0c, Mode Up/Scrl-Rt 0x0d, Vol Dn 0x10, Vol Up 0x11, Home 0x0f,
Sel/Send-A 0x0e, Del 0x0b, RCL 0x0a, Clr 0x13, Zone Up/Dn 0x12); Mode X writes
home + 0x1d. Direct-entry values (Zone/Mode/Sts/Msg N) are plain binary at
record byte 3 (both copies), and for Sts/Msg also at byte 2 of their 4 indicator
entries. The 65 templates (`motreader/_a9_table.py`, from
`tools/build_a9_button_table.py`) were captured by stepping Ind 2, key 1 and
the five editable labelled keys through every function RSS offers
(`tools/scenario_cycle_button.py`; data runs with 2/5/12). All 496 steps replay
byte-exact; a 12-button motreader edit GET-loads in RSS with no warning and
RSS's re-save is byte-identical. Six function pairs are byte-identical (Vol
Dn/V/A Dn ...); RSS shows the first name after GET.

### 5g. Zone Operation (RADIO-WIDE) — SOLVED: decode + switch (zoneop.py)

**Switch: control-head block +0x13 bit 4** (set = zone radio), on all six radios
against the RSS screen; `radio_wide.zone_operation`. Zones are decoded only
when it is on (the structural finder used to invent 2 zones on 604ATY).

RSS help (4072-4074): zones on = scan lists per zone and a mode list per zone;
off = mode-driven radio. Positional (ext+0x04 b0): on a zone change go to the
same position in the new zone instead of its last-used mode. Home zone (0x1DD)
must contain the home mode (0x10F).

**Codeplug skeleton** (found for this; all pointers are big-endian body offset
+ a model EEPROM base: 0x5F53 on most radios, 0x1953 on 604AUN):

| where | content |
|---|---|
| hdr 0xE5 | -> radio-wide ext block (base = word - ext offset) |
| hdr 0xE7 | -> a mode list section (01 02 … n) |
| hdr 0xED | -> **mode pointer table**: n = hdr 0x109 words, one per mode record; 8-bit sum of the table right after it |
| hdr 0xDD | -> section after the pointer table |
| hdr 0x10A | **mode record length** (26/27/40; zones-off 900 MHz records grow) |
| hdr 0xC9 | body size / 32 (604AUN: +1) |
| ext +0x1E | zone membership width W (0x8F = "15 + flag" on the 128-mode radios with zones off) |
| ext +0x20/+0x22 | -> sections after the mode records (W+2 / W+1-byte bitmap + 2 bytes, …) |
| ext +0x54/+0x56/+0x58 | -> zone membership / flag / name sections; +0x5B = zone count |
| zone names | 6 B/zone (6-bit); A9 head: 11-char ASCII in its string pool (pointer 0) |
| zone flag section | 2-byte length, then per zone W+3: scan-options byte, 2 priority bytes, W-byte zone scan list |
| zone membership | 2-byte length, W bytes per zone, **8-bit sum** (motreader now keeps it valid on zone edits) |
| body length | FF-padded to k*0x100 + 0xAD; with the 0x53-byte banner the file is k+1 whole 256-byte blocks, the "File Blocks" RSS flashes on reading (566AYA 27, 221AZN 46, 617ASN 14) |

Each mode record ends with an 8-bit sum (not verified by RSS on GET).
motreader now locates mode records through the pointer table (900 view = true
start − 11, VHF = true start − 3; 566AYA's first record is a 37-byte special one),
so decoding survives records moving or growing.

**Switching (RSS saves of all six radios, `notes/ground-truth/zoneop_rss/`):**

* On → off: zone sections deleted; on the 26/27-byte 900 MHz layouts every
  record grows by E zero bytes after its checksum, E = 2 + ⌈n/8⌉ (trunked:
  2 + min(ext[0x11], 16); RSS SPECTRA4.OVL X[0x3AA] = X[0x172] + 2, found by
  break-on-write); every pointer behind the change moves; zone pointers and
  count cleared; CHB bit, W, CHB/ext checksums, home zone 0, 0xC9, padding.
  Dialog: "Disabling zone mode will clear all zone lists" (F2).
* Off → on: RSS won't pack until every mode is in a zone ("mode # N is not
  assigned to any zone. Archive will not be packed") and the home mode is in the
  home zone. motreader creates what RSS does for one zone: "ZONE  01" with every
  mode, flag byte 0xA0, home zone 1, and removes the per-mode scan lists.
* Not every model has per-mode scan lists: 617ASQ and 221AZN (VHF) and 604ATY
  (40-byte layout) keep their record length.

**motreader** (`zoneop.zones_off/zones_on`, applied first on import when
`radio_wide.zone_operation` changes): byte-exact vs RSS for 617ASN (off) and
617ASQ (on); 604AUN (off) except header 0x1D5-0x1D7, which RSS set to
`0a 0f 10` but doesn't need (its GET + re-SAVE keeps motreader's `80 00 00`).
All three GET-load in RSS with no warning and RSS re-saves them unchanged
(617ASQ: one tail byte RSS normalizes on its own output too). Refused, with a
message: the A9 head (zone names in the string pool, A9 pointers into it shift),
trunked codeplugs, and more than 120 user modes (RSS also rewrites the scan
bitmaps at ext+0x20/+0x22 with recomputed content).

**Off → on drops only the per-mode lists the records carry (2026-10-25).** A
900 radio's records carry per-mode scan lists after RSS's zones off, but not
once both CONVENTIONAL lists are Op Select (617ASN's 3-mode backup in
ARCHIVE-bk: zones off, Op Select, L = 26). zones_on used to cut E bytes per
record anyway (a corrupt codeplug); it now takes E from the zones-off scan
layout (2 + W with a Mode Slave list, else 0), which agrees with every RSS
capture. On that backup the switch (plus an added zone) GET-loads with no
warning; RSS's re-save differs only in the radio-wide conventional list after
the records (`ff 00 c0` -> `00 00 00`): with zones on RSS clears that unused
list when it saves (the 617ASQ tail byte above is the same normalization).

### 5h. Removing trunking (TRUNKED DUAL MODE) — 566AYA done (trunking.py)

The repeater-builder workaround (notes/Miscellaneous Spectra Topics.html,
"Removing That Last Trunking Mode") uses an RSS bug to delete the last trunked
mode; 604AUN went through it (TRUNKED DUAL MODE, MAX SYSTEMS / SUBFLEETS 00,
"No Trunking data loaded"; its 2025-04 archive pair shows RSS's last step,
systems 1/1 -> 0/0, deleting the 96-byte control-channel tables behind ext
+0x14/+0x16 and renumbering the internal mode list).

Trunk layout on 566AYA (also A617AVE0.527, A604HQJ2.211 in AR-ORIG: archives that came
with the RSS install, from an old radio shop PC; unknown radios, used only as
structural samples):

| where | content |
|---|---|
| mode 1 record | 37 bytes (regular = hdr 0x10A); word at +2 -> personality section |
| personality section | 27 bytes, length byte 0x1B, right after the mode records; word at +10 -> talkgroup block + 4 |
| talkgroup block | 4-byte head + 37 bytes, at the end of the data |
| hdr 0x1D6 / 0x1D7 | MAX SYSTEMS / MAX SUBFLEETS (RSS radio-wide screen) |
| hdr 0x1DC | 0x54 on trunked codeplugs, 0 after |
| hdr word 0xE9 | -> trunking system tables when present (MAX SYSTEMS 15 radios); 0 on 566AYA |
| ext[L-5] | number of conventional modes (n - 1 with one trunked mode) |
| mode-list section (hdr 0xE7) | index list (n), per-mode type bytes (n; 0x10 = trunked on 566AYA), 2n zeros, 8-bit sum before the pointer table |

`motreader remove-trunking` turns mode 1 into a conventional mode (a copy of
mode 2; nothing renumbers, you gain a channel) and removes the personality
and talkgroup block: on 566AYA RSS GETs it with no warning, shows the
604AUN-style "No Trunking data loaded" and a conventional mode 1, and its
re-SAVE is byte-identical. Refused: no trunked mode, more than one trunked
mode, and codeplugs with system tables (hdr 0xE9 != 0: RSS also re-packs
those; the two AR-ORIG samples convert and load but RSS's re-save still
changes them). Not tried on a radio: the article reports an ER 01/02 or
01/82 after the RSS-bug method, cleared by reading the radio and writing it back.

### 5i. Squelch codes: independent Rx / Tx / T·A on both bands — SOLVED

Every mode has three 2-byte tone slots, in the same codec on both bands (the
VHF tone slot: 0 = Carrier, >= 0xC000 = DPL by the 83-code map, else bit15 +
Rx Hz × 61.2428 / Tx and T·A 165596.6 ÷ Hz). DPL polarity (hi bit 0x20): SET = DPL
in a VHF Rx slot, SET = INV.DPL in every other slot (900 Rx included).

| band | Rx | Tx | T·A | record sum |
|---|---|---|---|---|
| VHF (view = true − 3) | view +17/+18 | +19/+20 | +21/+22 | true + L − 1 |
| 900 (view = true − 11) | view +25/+26 (true +14) | +27/+28 (true +16) | +29/+30 (true +18) | true + L − 1 (566AYA zones-off: +25) |

Found by stepping each code of 566AYA mode 2 in RSS (notes/ground-truth/
tones_rss/): each edit changes only its slot + the record's 8-bit sum. The old
900 decode read only the first Rx byte and assumed "Rx Code == Tx Code"; the RSS
MODE SUMMARY shows otherwise (617ASN mode 6: Rx 411 / Tx blank). Now: 297/302 Rx
+ Tx codes match the summaries (the 5 are RSS showing TX 203.5 / 218.1 as
203.4 / 218.2 from the stored period), all 615 programmed 900 slots on the four
radios re-encode byte-exact, the five RSS edits replay byte-exact, and a
motreader split-tone edit (Rx 100.0 / Tx D023 / T·A 123.0) shows exactly in RSS and
re-saves byte-identically; VHF T·A (617ASQ 88.5) likewise. motreader recomputes
each changed mode record's sum (as RSS does). The earlier 900 DPL writer put
the "Tx" pair at view +29/+30, which is the T·A slot; fixed.

### 5j. Adding / deleting modes — SOLVED (modeops.py, standard + A9 heads)

RSS MODE UTILITY (mode screen F8): ADD MODE (Insert After, New Mode Name, Copy
From, ZONE #), DELETE BLOCK, DELETE MODE, COPY MODE (and MOVE MODE with zones
off). Captured on 617ASN (900, zones on), 617ASQ (VHF, zones off) and 604AUN
(900, zones off with per-mode scan lists); notes/ground-truth/modeops_rss/.

RSS keeps everything in mode order: a mode inserted after N becomes N+1.

| what | change |
|---|---|
| name table (0x266, 6 B/mode, 6-bit) | name inserted / removed at the mode's position |
| mode-list section (hdr 0xE7) | index list 1..n, type bytes (n), 2n zeros, sum: rebuilt for the new n |
| pointer table (hdr 0xED) | entry inserted / removed, sum |
| mode record | inserted at its position (ADD = model default record; Copy From = byte copy of that mode's record) |
| zone membership (LSB-first) | renumbered; the new mode joins ZONE # |
| zone scan lists in the flag records (MSB-first) | renumbered; priority-mode bytes renumbered (deleted one -> 0) |
| W = ceil(n/8) (ext+0x1E) | zone sections and the bitmaps after the records (ext +0x20/+0x22) widen / narrow (617ASN 56 -> 57 modes) |
| zones-off per-mode scan lists | 2 + ceil(n/8) bytes after each 26/27-byte 900 record: every record grows / shrinks (604AUN 48 -> 49: 35 -> 36 bytes) |
| counts | 0x109, 0x110, ext +7 / +8, ext+0x86 (conventional modes) |
| mode numbers in the header | 0x10F home mode, 0x1B6, 0x1C1 (deleted mode -> 0) |
| pointers | header 0xDD/E5/E7/ED; ext +0x18 +0x1A +0x1C +0x20 +0x22 +0x25 +0x27 +0x29 +0x2B +0x2D +0x41 +0x47 +0x49 +0x50 +0x54/56/58 |
| sums / size | ext, membership, pointer table, mode list, 0xC9, FF padding |

**MPL tables (2026-10-25).** ext +0x47 / +0x49 point at the MPL code table
(6 bytes per entry) and the MPL name table (6-bit, 6 bytes per entry) right
after it; both are 0 with MPL off (Number of MPL 0), as on every radio the
captures above were made on, which is why they weren't seen moving. On a
standard head the MPL tables sit after the 6-bit mode names, so an add /
delete moves them: without moving the pointers RSS read the MPL list 6 bytes
off (566AYA with trunking removed, a mode added: MPL 1 came back as
"GXB$Z(3H" and RSS re-saved the list shifted). With +0x47 / +0x49 moved, RSS
re-saves the result byte-identically. (A9 head: +0x49 = 0, the MPL names are in
the head block, and nothing before the records moves.)

motreader matches RSS byte-exact on all nine captured operations except one
deliberate byte: after a delete RSS leaves the old last mode's membership bit
set (617ASN zone 4, mode 53 of 52); motreader clears it so a later add doesn't
silently join that zone. motreader's own adds/deletes GET-load in RSS with no
warning, show the right modes, and RSS re-saves them byte-identically.

**A9 / S9000e head (221AZN; RSS ADD at the end, insert after 1, copy, DELETE).**
The body is the radio data, FF-padded to a page (body offset ≡ 0xAD mod 0x100,
i.e. a 0x100-aligned radio address), followed by the **head block** (0x2000
bytes on 221AZN, at 0xDAD = radio 0x6D00: `00 00`, checksum, button maps,
ASCII string block). RSS re-packs the radio data exactly as above except that
the 6-bit name table at 0x266 is not touched (the A9 head uses that area for
other data), then:

* moves the head block **whole** to the next page boundary after the radio data
  (65 → 66 modes: 0xDAD → 0xEAD, body +0x100; after a delete it stays and the FF
  padding grows). Nothing points into it, and it moves by whole pages, so its
  content (and its checksum's byte lanes) is unchanged;
* mode names live in a **fixed array of 11-byte slots** (more slots than
  modes; spare slots hold leftovers / RSS defaults). ADD after N: slots N+1..n
  move up one, the new name goes in slot N+1, old slot n+1 is overwritten.
  DELETE N: slots N+1..n move down one, slot n keeps its old name (now spare);
* RSS's default name is `"  MODE   66"` (`"  MODE" + %5d`); RSS shows it with
  the leading spaces;
* the head checksum is carried by the name changes' delta;
* direct-entry **"Mode N" buttons are not renumbered** (key 1 = Mode 30 stays
  Mode 30 after DELETE 2 / insert after 1: it then reaches a different mode).

motreader matches all four RSS captures byte-exact, and its own add (default
and named), add + delete, and add + delete + CSV edit (name, Rx, Tx, Tx PL)
GET-load in RSS with no warning, show the right modes, and RSS re-saves them
byte-identically. The head-checksum locator now looks up to a page past the
mode records for the page-aligned `ff×6 00 00` mark (it moves after an ADD).

### 5k. Adding / deleting zones — SOLVED (zonelist.py, standard + A9 heads)

RSS RADIO-WIDE F7 ZONE NAME LIST: F3 ADD ZONE ("Add Zone At Position", Enter
executes), F4 DELETE ZONE ("Del Zone At Position", Enter, then a "Deleting
Zone" F2 CONTINUE dialog), F2 MODE LIST (Tab to a mode's IN ZONE field, Down
= Y). Captured on 617ASN, 604AUN, 566AYA and 221AZN (A9);
notes/ground-truth/zonelist_rss/.

The zone tables are three contiguous sections right before the ext block:

| section | content | on ADD at P |
|---|---|---|
| names (ext+0x58; standard heads only) | 6 B/zone, 6-bit | name inserted at P (RSS default "ZONE  nn") |
| flags (ext+0x56) | 2-byte length, W+3 B/zone: scan-options byte, 2 priority-mode bytes, W-byte zone scan list | `a0 00 00` + W zero bytes inserted at P; length + W+3 |
| membership (ext+0x54) | 2-byte length, W B/zone (LSB-first), 8-bit sum | the zone's bitmap inserted at P; length + W; sum |

Then ext+0x5B (zone count), ext sum, the three zone pointers, every pointer
behind them (header 0xDD/0xE5/0xE7/0xED, ext +0x20/+0x22, the mode pointer
table + its sum), 0xC9 and the FF padding. DELETE is the reverse.

**A9 head (221AZN).** The radio data is re-packed as above (no names section);
the head block moves whole to the next page boundary after it (§5j). In the
head's string area the zone names (11 chars) sit right before the mode-name
slots (250 of them on 221AZN), followed by a zero pad up to the next strings
(" PENDING ..."; 308 bytes on 221AZN). ADD at P inserts the name at zone slot
P and shifts everything after it (later zone names and all mode slots) by 11
into the pad; DELETE shifts back and refills the pad with zeros. Head string
descriptors (head +0x76F on 221AZN): `0b 01 <nz> <zone table ptr>` (zone
count byte := new count) and three words pointing at the mode-name table
(`... 0b 01 fa <ptr>`, = zone ptr + nz·11), which move by ±11. Pointers in
the head are head-relative (the block moves by whole pages and they don't
change). The head checksum is carried.

**Home zone (0x1DD).** RSS: ADD leaves it alone, DELETE at or before it sets
it to 01 (and packing resets the home mode to that zone's first mode). motreader
renumbers it so it follows its zone, and refuses deleting it; the only
difference from RSS in the captures (azzinsm, azbzins: byte 0x1DD).

Direct-entry "Zone N" buttons on the A9 aren't renumbered by RSS (key 1 = Zone 5
before and after an insert at 1 and a delete of zone 3); nor by motreader.

motreader matches the eight RSS captures byte-exact (except the home zone as
above), and its own results (617ASN insert at 2, 221AZN insert at 1 + delete
of the old zone 1, 604AUN delete, plus an A9 mode add after those) GET-load
in RSS with no warning, show the right zone list, home zone and ZONE MODE
LIST, and RSS re-saves them byte-identically.

### 5l. Zone scan lists + ZONE SCAN OPTIONS — SOLVED (scanlist.py)

RSS RADIO-WIDE F2 → ZONE LIST F7 → SCAN LIST F7 (TAB through the entries,
UP/DOWN cycles a mode's type; PgDn = next 32 modes; F4/F3 next/previous zone)
and SCAN OPTIONS F8. Mapped one field per RSS SAVE (`tools/scenario_rw_map.py`)
on 604AUN, 617ASN, 566AYA and 221AZN; notes/ground-truth/scanlist_rss/.

Each zone's `W+3`-byte record in the zone flag section (ext +0x56, §5c):

| byte | content |
|---|---|
| +0 | scan-options byte: 0x80 SCAN TYPE Talkgroup / 0x08 Pri Tlkgr (neither = Disabled); 0x40 Talkback Scan Enabled; 0x20 Scan Button Control Active (clear = Override); 0x10 Coded Squelch Scan Enabled; 0x04 Non-Priority List Op Select (clear = Zone Slaved); 0x03 Priority List Op Select (clear = Zone Slaved) |
| +1 / +2 | Priority 1 / Priority 2 mode: mode number, **0xFF = `<SELMOD>`** (the selected mode), 0 = none |
| +3 | `W`-byte bitmap of the **N Pri** (non-priority) members, **MSB-first** (0x80 of the first byte = mode 1; the membership bitmap is LSB-first) |

- `<SELMOD>` is always on the list and counted ("List = 12 of 16 Max" = 1 +
  bitmap bits + non-SELMOD priority modes); it is N Pri unless a priority byte
  is 0xFF. A priority mode is not in the bitmap. **16 members max.**
- A scan list may hold modes outside its zone (221AZN zone 6 scans mode 1).
- Entry cycle (DOWN): blank → Pri 2 → Pri 1 → N Pri → blank, skipping a
  priority already taken. On a Talkgroup list only blank / N Pri, and
  `<SELMOD>` is fixed N Pri. SCAN TYPE Pri Tlkgr → Talkgroup drops both
  priority modes (not demoted to N Pri). With Disabled the list is kept but
  RSS won't open it ("SCAN IS DISABLED ON THIS ZONE").
- SCAN TYPE choices are model-specific: 617ASN Talkgroup / Disabled / Pri
  Tlkgr; 604AUN Pri Tlkgr / Disabled; 566AYA Talkgroup / Disabled. Priority
  List appears only with Pri Tlkgr, Non-Priority List not with Disabled.
- RSS's new-zone byte 0xA0 = Talkgroup, Scan Button Active, the rest off.
- Fixed-size records: edits are in place. ADD / DELETE MODE renumber the bitmap
  and the priority bytes; 0xFF stays (RSS ADD MODE on 604AUN: Pri 1 30 → 31,
  Pri 2 2 → 3, a zone-3 `<SELMOD>` Pri 1 kept; motreader byte-exact).

**SCAN CONFIGURATION (RADIO-WIDE F6), added to radio_wide:** Conv Receive /
Transmit Hang Time = header 0x111 / 0x112 in 0.25 s units
(`scan_conv_rx/tx_hang_time_ms`); Tx Revert Mode = 0x105 b0 Active / b5 Home /
neither Selected, offered only with Scan Off HUB disabled; Dynamic Priority
Assignment = 0x105 b3 (mirror ext+0x03 b1; "Not Avail" on 566AYA / 604AUN /
617ASN). The trunk timing fields are not exported (trunking is not exposed).

Validated: 23 RSS saves reproduce byte-exact from a motreader edit of the base;
motreader edits on all four zone radios (Pri Tlkgr with `<SELMOD>` Pri 2 and
both list types Op Select; Disabled; a full 16-member list; 221AZN with the new
radio-wide fields) GET-load with no warning, show exactly as set, and RSS
re-saves them byte-identically.

**Zones off:** see §5m.

### 5m. Zones-off scan (per-mode SCAN, Op Select / Mode Slave lists) — SOLVED (convscan.py)

With Zone Operation off, scan is configured per mode (mode screen SCAN; OPT 1:
Scan Button Control, Coded Squelch Scan, Talkback Scan; F6 CHANNEL / PRI TLKGROUP
SCAN LIST) and on CONVENTIONAL (F4 → F3: SCAN TYPE, Non_Priority List, Priority
List). Mapped one field per RSS SAVE on 617ASQ (VHF), 604ATY, and zones-off 604AUN /
617ASN (900; the latter two made with motreader's RSS-validated `zones_off`), plus
RSS re-packs and mode adds/deletes on populated lists; notes/ground-truth/convscan_rss/.

**Mode record (true start from the pointer table) +20:** 0x02 SCAN (scan type Pri
Tlkgr / Channel), 0x01 Scan Button Control Active, 0x04 Coded Squelch Scan, 0x10
Talkback Scan, 0x80 Non-Priority List Op Select, 0x60 Priority List Op Select (the
last two are copies of the CONVENTIONAL setting in every record; clear = Mode
Slave). **900 MHz SCAN TYPE Talkgroup:** a scanning mode has record **+2 b4**
(0xA0 → 0xB0, the RX tag byte) instead of +20 b1. RSS's CONVENTIONAL SCAN TYPE is
not stored anywhere else: it reads Talkgroup / Pri Tlkgr (900) / Channel (VHF)
from the modes, and **Disabled when no mode scans** (zones-off 617ASN / 604AUN;
then it isn't a tab stop). It is editable only where RSS offers it (604ATY: Pri
Tlkgr ↔ Talkgroup; 617ASQ is fixed at Channel). Talkgroup forces the Priority
List to Mode Slave; going back warns "If Pri Tlkgr Is Selected Non_Priority Scan
List(S) Will Be Cleared Out" (F2/F10).

**A list** = `[Pri 1][Pri 2][members]`: priority = mode number, 0xFF `<SELMOD>`,
0 none; members = W-byte bitmap MSB-first (W = ext+0x1E & 0x7F) or, with ext+0x1E
b7 (604ATY, 128 modes, W field 15), up to 15 mode numbers zero-padded in RSS's
order (it appends new members and closes gaps; RSS converts it to a bitmap once
the radio has ≤ 120 modes).

| setting | where the list lives |
|---|---|
| both Op Select | one radio-wide list: members at ext+0x22's pointer, the priority bytes the 2 bytes before; `<SELMOD>` listed; records keep no list |
| any Mode Slave | every record grows by **2+W** bytes after its checksum (VHF 26 → 30, 900 27 → 27+2+W; the sum stays at base−1) holding that mode's `[Pri 1][Pri 2][bitmap]`; the radio-wide list then **mirrors mode 1's** list (not the home mode's) |
| Non-Priority Mode Slave + Priority Op Select | shared priorities in the radio-wide list, copied into every record; per-mode bitmaps; `<SELMOD>` listed; a mode in its own bitmap even if it is a shared priority |
| Non-Priority Op Select + Priority Mode Slave | per-mode priorities; members radio-wide (records' bitmaps unused); no `<SELMOD>` |
| both Mode Slave | no `<SELMOD>`; max = mode count |

- `<SELMOD>` exists only with Priority List Op Select. Max members = min(16, n +
  1 if `<SELMOD>`).
- With Non-Priority Mode Slave a mode is always on its own list ("The Selected
  Mode May Not Be Deleted From the List"); RSS sets the mode's own bit whenever it
  displays that list (just paging past a mode adds it).
- 900 only: ext+0x20 points at a second list of the same shape (zeros on every
  sample; preserved; renumbered on mode add/delete).
- **Re-pack Op Select ↔ Mode Slave** (`set_list_types`; byte-exact vs RSS for all
  four 617ASQ transitions and 604ATY Priority → Mode Slave): records grow/shrink
  by 2+W; a list turning Mode Slave starts as a copy of the radio-wide list in
  every mode (`<SELMOD>` → 0 without Priority Op Select); turning Op Select it
  keeps mode 1's; pointer table + sum, ext +0x20/+0x22 and other pointers behind
  the records, header 0x10A, ext sum, record sums, FF padding / 0xC9.
- **SCAN TYPE** (`set_scan_type`, 900): Pri Tlkgr → Talkgroup = Priority List →
  Mode Slave (re-pack) + every scanning mode's bit +20 b1 → +2 b4; back = the bits
  only (byte-exact vs RSS on a 59-mode 604ATY: the full 128-mode one can't take
  the Talkgroup lists, "Codeplug Has Exceeded Radio Memory By 1939 Bytes").
- **Mode add/delete** (modeops): every list renumbered. RSS bugs, not copied:
  ADD leaves the member numbered after+1 unchanged (617ASQ Op Select, 617ASQ and
  604AUN Mode Slave; zone scan lists are fine), and DELETE on 900 Mode Slave lists
  shifts later members down by two; 617ASQ deletes are correct and match
  byte-exact.
- The 900 RX tag check now masks +2 b4 (a Talkgroup codeplug was mis-detected as
  VHF).

Validated: 30 RSS single-step saves reproduce byte-exact; motreader edits (617ASQ
Op Select list + per-mode options; 617ASQ re-packed to both Mode Slave with a
mode-2 list; zones-off 604AUN SCAN on + Mode Slave list; 604ATY number list with
modes 100/128) GET-load with no warning, show as set, and RSS re-saves them
byte-identically.

### 5e. Phone list + MPL list — SOLVED (read + write, validated vs RSS)

`motreader/lists.py`, exported as `phones.csv` / `mpl.csv`; decode matches the RSS
screens of all six radios (`notes/ground-truth/lists_<serial>.json`,
`tests/test_lists.py`), and a motreader edit set GET-loaded in real RSS with no
warning (`lists_221AZN0035_edited.json`). Edits touch only list bytes.

* **Phone list** (9 entries, shared by conventional + trunked interconnect).
  Numbers: 9 × 8 bytes at **0x1E8**, 16 dial nibbles, 0xF-padded. Names:
  standard heads 9 × 6 bytes **6-bit at 0x230** (right before the mode names at
  0x266); the A9 head keeps 0x230.. for other data and stores 11-char ASCII names
  in its string block. 566AYA stores a populated list but RSS shows "PHONE Is
  Disabled" on that model.
* **A9 ASCII string block** (221AZN, 11 chars/slot, in order): STATUS ×8,
  MESSAGE ×8, CODE ×4, UNIT ×8, UNIT ×8, **PHONE ×9**, SITE ×8, **MPL ×16**, one
  more (" REMOTE"), **ZONE ×n_zones**, **MODE ×n_modes**. Located backwards from
  the mode-name table.
* **MPL list** (header 0x119 = count; 0 = Disabled and no table). N × 6-byte
  records (RX, TX, TA squelch slots, 2 bytes each). The table moves with other sections
  (566AYA 0x6F1, 604ATY 0x73D, 221AZN 0x37F); located by N valid squelch triples
  (not all Carrier) followed on standard heads by N 6-bit names. Zero/stray bytes
  before it give the same table shifted back 6 at a time; the real start is the
  last of that run. Slot codec = the VHF tone slot on **both bands**: 0 =
  Carrier, ≥ 0xC000 = DPL (83-code map), else bit15 + RX Hz×61.2428 / TX,TA
  period. RSS displays TX/TA tones as **165600 / period** to 0.1 Hz (pinned to
  [165598.7, 165603.6) by 19 captured periods), so non-standard stored values
  read e.g. `186.3 --` / `168.0 --`; motreader exports exactly that.
* **DPL polarity (bit 0x20 of the hi byte):** RX slot on VHF: SET = DPL. TX/TA slots
  (both bands) and the RX slot on 900: SET = INV.DPL. The same holds for VHF
  **mode records** (see §5a correction).

**A9 control-head checksum.** On the A9 head RSS checks a 16-bit sum over the
ASCII string block ("Bad control head checksum." on GET otherwise). The checksum
is a sum of **big-endian words starting at odd addresses**, stored big-endian
at 0xDAF on 221AZN, after the mode records behind an `ff×6 00 00` run (the
head block starts page-aligned at the `00 00`; see §5j: it moves after an ADD).
RSS edits of the MPL table, ext section, mode records, zone membership and
header fields don't change it. The exact region start/end and initial constant
are not pinned down (only one A9 sample), so motreader carries it forward
incrementally by the edit delta (`lists.fix_a9_head_checksum`, applied to every
import). This makes A9 mode/zone/phone/MPL name edits load with no warning.

## 6. Export model

- Any category with multiple rows → its own **CSV** (modes, scan lists, zones,
  call lists, …).
- Single-record data → **YAML** (radio-wide config, control-head buttons, …).
- Write path is **template-patch**: start from the original archive, change only
  mapped fields, preserve every unknown byte and the nonce, re-encrypt, and
  verify by re-decoding the output.

## 7. Bands (from RSS frequency-entry prompts)

Lowband (32/38/48 MHz), VHF (159 MHz), UHF (422/451/474/505 MHz),
800/900 (860.9625 / 896.0125 / 927 MHz). PL entered in Hz or as a code; DPL too.
