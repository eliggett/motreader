# motreader — status & next steps

Snapshot for resuming after context compaction. Read with `notes/FORMAT.md`
(the format spec) and the module docstrings.

## Web app (2026-10-24) — the JavaScript transition

`web/` is the static web editor (plain JS modules + JSDoc type checking, no
build; `npm test`, `npm run check`, `npm run serve`). `web/lib/` is a port of
the Python format code that runs in the browser and in Node; Python stays as
the reverse-engineering tool and the reference:

- **Decode parity**: `tools/py_reference.py` + `tests/js/parity.test.js` — every
  sample (ground truth + archives, ~300 files) decodes identically.
- **Write parity**: `tools/py_edit.py` + `tests/js/edit-parity.test.js` — ~2,400
  generated edit cases produce byte-identical bodies.
- **RSS**: web-app exports of 617ASQ (VHF), 604AUN (900) and 221AZN (A9) GET
  with no warning, show the edits, and re-save byte-identically
  (`tools/scenario_validate_export.py`, `tools/compare_resave.py`; captures in
  `notes/ground-truth/vhf_band_rss/`).
- **CSV/YAML**: `tools/py_tables.py` + `tests/js/tables-parity.test.js` — the web
  app's modes.csv / phones.csv / mpl.csv / radio.yaml equal the CLI's (minus the
  scan parts not yet in the web app), and the same edited files imported by the
  CLI and the web app give byte-identical archives.
- Milestones done: 1 skeleton, 2 read-only, 3 editing + Export Codeplug, 4
  CSV/YAML + phone/MPL lists, 5 structural ops. Next: 6 control head buttons,
  7 export-time checks.
- M5 (2026-10-25): modeops / zonelist / zoneop / trunking removal / convscan /
  scanlist ported to web/lib (byte parity with Python on 10,700 generated
  cases over every sample: tools/py_struct.py, tests/js/struct-parity.test.js;
  scan decode in the decode parity). The app: add / duplicate / delete modes
  (Modes tab), add / delete zones and zone scan lists (Zones tab), Zone
  Operation switch (Radio-Wide), zones-off scan (Modes Scan columns, Conventional
  tab), Remove trunking (Modes tab), undo of each structural change
  (lib/document.js restructure keeps the previous document). CSV/YAML export
  now has the scan columns / conventional_scan / zones[].scan, equal to the
  CLI's, and import applies them (and the Zone Operation / list type switches)
  as the CLI does, byte-identical to its archives. Move mode isn't in Python
  yet (it needs its own RSS mapping). Older format versions: still modes only
  (no add / delete).
  Found on the way (fixed in Python too): mode add / delete didn't move ext
  +0x47 / +0x49 (MPL tables), so on a standard head with MPL enabled RSS read
  the MPL list 6 bytes off (FORMAT §5j); Zone Operation on cut per-mode scan
  lists from records that had none (FORMAT §5g). Web-app results checked in
  RSS (617ASN add / delete / zone / scan list, 617ASQ zones off + Mode Slave
  lists + add, 566AYA trunk removal + add, 617ASN 3-mode zones on + zone): no
  GET warning, and RSS re-saves them identically (the last one but for RSS's
  own conventional-list normalization).

UHF (2026-10-25): decoded, edited and exported (FORMAT §5a-UHF), validated
in RSS. Codeplugs motreader can't edit safely (older format versions 101/102,
inconsistent copies, all-trunked or mixed trunked radios, 800 MHz) open
read-only (lib/support.js).

Older format versions (2026-10-25, FORMAT §5): 112 and 114 open "modes only"
(modes decoded and edited; zones, radio-wide, lists not decoded and left
untouched), validated in RSS. VHF RX now takes the 6.25 kHz raster RSS also
uses on current radios (FORMAT §5a; the old decoder misread such modes).
800 MHz conventional modes decode (FORMAT §5a-800) but aren't edited; their
trunked mode 1 used to decode as a conventional mode and was editable.

Found while validating (fixed in Python too): an unedited rebuild zeroed tone
slots that aren't tones (six codeplugs); VHF frequencies now use RSS's byte pair
(smallest swallow count) and RSS's band byte (6 MHz bands; the old rule was
wrong above 156 MHz); TX/TA above 165.74 MHz that the synthesizer can't hold are
refused (RSS silently stores a wrong frequency). FORMAT §5a. Editing the TX of
a 900 MHz split mode with no talk-around no longer empties the mode.

## TL;DR

A working tool that converts Motorola Spectra RSS archive files ↔ CSV (channels)
+ YAML (radio data). The **encryption is fully cracked**, and **VHF and 900 MHz
channel decode are COMPLETE and validated byte-exact vs RSS across EVERY on-hand
radio** (566AYA, 604ATY, 604AUN, 617ASN 900-band variants, + 617ASQ and 221AZN
VHF) — independent RX/TX/T·A + names + PL, via one universal byte-linear codec and
structural table finders. Lossless round-trip; surgical edits. **30 tests pass.**

**221AZN (`T83FWA7HA9AK`) is now fully decoded** — it is a **VHF** radio with the
**A9 / "CONVENTIONAL EXPANDED" head** (not 900/trunking as previously guessed):
65 modes, **11-char ASCII mode names** (the A9 head's longer names, stored as
plain ASCII not 6-bit), independent RX/TX/T·A, and Rx/Tx **CTCSS PL**. Byte-exact
vs the RSS MODE SUMMARY (0/65 mismatches). GT: `notes/ground-truth/
modesummary_221azn0035.prn`.

**Phase-1 white-box harness is BUILT & VALIDATED (2026-10-22)** — a control
socket + range-watch tracer + text-screen reader + key injection + speed control
+ single-step micro-tracer patched into dosbox-x (`core=simple`), driven by
`tools/dbxctl.py` & friends. See `notes/PHASE1-HARNESS.md` §13. **Key finding:**
RSS parses the archive into an in-RAM **working image of decoded strings/enums**
(frequencies stored as TP ASCII strings like `"146.52000"`, NOT the on-disk
bytes), so the binary→value decode is a GET-time conversion and the working
image — not a per-field numeric codec — is the right Phase-2 target for reading
*every* attribute (incl. power level / compander) with no test-and-find.

**Phase-2 — systematic on-disk field mapping DONE for MODE/OPT1 (harness-driven;
`tools/field_diff.py`, `tools/scenario_map_screen.py`, `tools/rss_nav.py`).**
Toggle one field in RSS (closed-loop) → SAVE → decrypt-diff vs a double baseline
(noise subtracted) → exact on-disk bytes, no guessing. Per-mode record flag map
(rec-relative): **+3** uP Xtal(bit4)/MPL Type(bits5-6); **+4** MDC PTT ID(bit7)/
Phone Encode(bit5); **+6,7** Rx freq; **+9** TX tag + Transmit Power(bit6);
**+10,11** Tx freq; **+13** TA tag + Talkaround Power(bit6); **+14,15** TA freq;
**+17-22** PL tones; **+24** Call Signalling(bit6). Global: Channel Chg ID
Register ≈ 0x24a/0x24d. (Squelch type needs a tone code to commit; MODE UTILITY
is an ops menu, not data; Compander "Not Avail" on this VHF radio.) Full map in
`notes/FORMAT.md` §5a.

**Checksums — RESOLVED (good news): no write-path work needed.** The save-side
`{0xdc,0xf0,0x1bc-0x1e5}` block is a **per-save timestamp/counter** (not
data-derived), and `rec+0x1c` is a per-record checksum — **RSS verifies neither
on GET**. A motreader template-patch edit (checksums left stale) GET-loaded into
RSS and showed the edit (146.52→146.40000) with no error. So motreader's archive
write path is sound as-is.

**Per-mode options wired into CSV + write path (DONE, 33 tests).** `modes.csv`
now has `tx_power`, `ta_power`, `up_xtal_shift`, `mdc_ptt_id`, `phone_encode`,
`mpl_type` (VHF; `codeplug.py` decode + bit-surgical encode, template-patch
preserves all other bits). MPL Type is a 4-value enum (rec+3 bits5-6:
Disabled/TX Only/RX Only/RX & TX), fully enumerated by cycling in RSS
(`tools/scenario_cycle_enum.py`). Round-trip byte-exact when unchanged; a single
edit flips only the mapped bit(s). **End-to-end validated in real RSS**: motreader
edits (tx_power→Low, mdc→Disabled, up_xtal→Enabled; mpl_type→RX Only) GET-loaded
and displayed exactly. **Call Signalling deferred** — cycling showed Disabled/MDC/
DTMF but DTMF stores identically to Disabled (needs DTMF sub-config), so bit6 is
just an MDC flag; not wired to avoid a lossy enum.

**900 MHz per-mode options mapped + wired (44 tests).** On 900 radios (617ASN
D37KMA) the MODE + MODE OPT 1 screens expose a set of per-mode options, all now
mapped white-box via harness cycling and **validated loading in real RSS**. rec+11
and rec+12 are packed flag bytes:
- rec+11: UnMute/Mute Type (bits0-1: Std/Std, AND/Std, AND/OR), **Reverse Burst/
  TOC** (bit2, SET=Enabled), uP Xtal (bit4, SET=Disabled), MPL Type (bits5-6).
- rec+12: **Audio Compander** (bit3, the owner's "hear clear"), Phone Encode
  (bit5), Adaptive Splatter (bit6), **MDC PTT ID** (bit7); all SET=Enabled.
- powers ride in bit6 of the TX/TA freq-carry bytes (rec+17 / rec+21).

CSV cols: `audio_compander`, `adaptive_splatter`, `mdc_ptt_id`, `phone_encode`,
`reverse_burst_toc`, `unmute_mute_type`, `mpl_type`, `tx_power`, `ta_power`,
`up_xtal_shift`. End-to-end validation: a motreader edit of mode 1 (MDC→Enabled,
Phone→Disabled, RevBurst/TOC→Disabled, UnMute→AND/OR) changed exactly 2 bytes
(rec+11, rec+12), GET-loaded into RSS, and every value displayed as set.
(**Flutter Filter = Adaptive Splatter**, per the owner.)

**Squelch TYPE (both bands) DONE (45 tests).** New CSV cols `rx_squelch_type` /
`tx_squelch_type` = Carrier / PL / DPL, derived from the tone bytes (VHF 16-bit
slot bit15 / ≥0xC000; 900 code byte rec+25: 0=Carrier, 0x93-0xbf=PL, ≥0xc0=DPL).
PL table completed + validated vs GT (added 0xa6=162.2). Validated vs RSS MODE
SUMMARY on 566AYA/604ATY/617ASN (900) and 221AZN (VHF). Byte-identical round-trip.

**900 DPL code — SOLVED, in and out.** The DPL code is the 2-byte pair
(rec+25, rec+26) for Rx and (rec+29, rec+30) for Tx — rec+25 alone collides
(566AYA `0xd8`→both 125 & 532), the pair is unique. Full **83-code** standard DPL
set (`DPL_CODE_BY_PAIR` in codeplug.py) captured by cycling the Rx CODE field in
RSS (`tools/scenario_dpl_table.py`, both directions) and **validated byte-exact vs
GT: 566AYA 46/46, 617ASN 40/40** (Rx over all modes 121/121, 52/52). Codes show as
`D###`. **Encode validated in real RSS**: motreader `D411→D023` on mode 6 GET-loaded
showing Rx/Tx DPL 023, next mode untouched; a DPL edit rewrites exactly rec+25,+26
(Rx) & rec+29,+30 (Tx), unchanged = byte-identical.

**VHF DPL + INV.DPL — SOLVED, in and out.** 221AZN (`T83FWA`) had no DPL
mode, so one was added in RSS via the harness and the Rx CODE field cycled. VHF
stores the DPL code **big-endian in the same 2-byte tone slot as PL** (Rx +17/18,
Tx +19/20, T·A +21/22) using the **identical 83-value map as 900**, differing only
by **hi-byte bit `0x20`: set = normal `DPL`, clear = `INV.DPL`** (so INV.DPL bytes
equal the 900 pair exactly; normal DPL is that pair with `0x20` set in hi). Decode
`code = DPL_CODE_BY_PAIR[(hi & ~0x20, lo)]`; polarity from `hi & 0x20`. Encode is
change-gated, writes exactly the Rx/Tx slot bytes, polarity from `rx/tx_squelch_type`
(DPL vs INV.DPL) else preserves original. **Validated end-to-end in real RSS**:
motreader set mode 2 → `DPL D311` and mode 3 → `INV.DPL D023`; the patched archive
GET-loaded showing `Rx DPL 311` / `Rx INV.DPL 023`. 22 captured codes (both
polarities) decode exactly; all 83×2 pairs distinct. Tools: `scenario_read_modes.py`
(GOTO-MODE readback), `scenario_dpl_diff.py` (code differential), `scenario_dpl_table.py`
(900 table) + `scenario_vhf_dpl_recon.py` / `scenario_vhf_dpl_table.py` (VHF).

**VHF PL (CTCSS) write — SOLVED, byte-exact (51 tests).** The decode `K` formulas
are exact, but ENCODE isn't a clean `round(f*K)` (RSS lands a few tones one count
off), so encode uses **RSS-captured tone→byte tables** (`VHF_PL_RX_BY_TONE` /
`VHF_PL_TX_BY_TONE`, 40 tones each — this head's set, 67.0–250.3) built by cycling
the 221AZN "TPL CODE" field (`tools/scenario_vhf_pl_table.py`), formula fallback
otherwise. A unified `_write_squelch_vhf` handles Carrier↔PL↔DPL↔INV.DPL per slot,
change-gated on the DECODED value (unchanged ⇒ byte-identical). **Validated in real
RSS**: motreader mode 1 → Rx TPL 141.3 / Tx TPL 123.0, mode 5 → Rx 162.2 / Tx 179.9
(off-by-one tones) GET-loaded and displayed exactly.

**Radio-wide ZONES — SOLVED, in and out, GENERALIZED across heads (60 tests,
2026-10-23).** A zone is a named group of modes (a mode may belong to several).
Cracked + validated vs the RSS zone editor on ALL FOUR on-hand zone-bearing radios:
566AYA (12 zones), 617ASN1767 (4), 604AUN0331 (4) on 900, and 221AZN0035 (12) on VHF.
The zone block = three tightly-packed parallel arrays of N entries (N = zone count):
**names**, **flag records** (`W+3` B/zone), **membership** (`W` B/zone = mode BITMAP,
bit `(mode-1)` LSB-first). **W (membership width) tracks the mode count**: `W ∈
{ceil(n/8), ceil(n/8)-1}` (566AYA 16, 617ASN 7, 604AUN 6, 221AZN 9). The flag record
is `W+3`; its scan-options byte sits at a model-specific offset/value (0xF4/0xA0/0x78/
0xF0 seen) and repeats per zone. **Name storage follows the head type, like MODE
names**: standard heads pack 6-bit (6 B/zone) immediately before the flag array; the
A9/expanded head stores ASCII (fixed width) as the N entries right before the ASCII
mode-name table (names live far from the block). Zone names may contain `/` ("BBND/
MURS"). `find_zone_block` (codeplug.py): 6-bit path anchors on the 6-bit name run;
ASCII path anchors on the flag+membership block in the low binary region (<0x1000)
then maps N ASCII names before the mode table. Membership base among small pads is
chosen by **min-max-mode then max-adjacency** (a byte-shift sprays bits to the W*8
ceiling). RSS deletes empty zones on save → every stored zone non-empty (relied on).
`Zone` dataclass (name_enc/name_w/memb_w) + `cp.zones`; export adds `zones:` to
`radio.yaml` (authoritative mode numbers + read-only `mode_names`); import applies
name + membership change-gated (unedited = byte-identical). **Real-RSS validated**:
566AYA zone1→`ZEBRA` [2,3,18,99] and 221AZN zone1→`HAMZONE` [1,2,3,60] both GET-loaded
showing the new name + membership, other zones intact. **Full membership ground truth**
captured from the RSS MODE LIST (all pages, all zones) via `scenario_zone_dump_modelists.py`.
RSS zone-editor nav: MAIN→F4→F2 (RADIO-WIDE)→F7 (ZONE LIST)→F2 MODE LIST / F7 SCAN LIST
/ F8 SCAN OPTIONS; ADD/DEL ZONE = F3/F4. Scenarios: `scenario_zone_recon{,2,3}.py`,
`scenario_zone_names.py`, `scenario_zone_dump_modelists.py`, `scenario_zone_validate.py`.
**Zone deferred (preserved-only):** per-zone scan-options flag byte bits (SCAN OPTIONS
"Not Available For This Model" → can't isolate them); the per-zone **scan list**
(ordered priority structure in the `W+3` record); **add/delete zone** (changes N;
template-patch keeps N, only existing zones editable). **A9-head caveat:** a 221AZN
membership edit trips a dismissable "Bad control head checksum" warning on GET (its
membership block at ~0x46d is inside the control-head-checksummed region; RSS loads
it fine, checksum NOT yet recomputed — crack it with the control-head work). The 900
radios don't show this. 617ASQ correctly yields no zones (no false positives).

**Radio-wide settings — SOLVED, in and out (74 tests, 2026-10-23).** 47 fields (44 editable)
from the RSS RADIO-WIDE / OPTIONS / SCAN OPTIONS / CONVENTIONAL / DTMF / MDC /
CONTROL HEAD OPTIONS screens, exported as `radio_wide:` in `radio.yaml`
(`motreader/radiowide.py`, field map in `notes/FORMAT.md` §5d). Two areas: fixed
header offsets (same on all models) + a self-describing **radio-wide extension
section** (byte0 = length, last byte = 8-bit sum; located structurally; motreader
recomputes its sum). Mapped with the new generic screen mapper
`tools/scenario_rw_map.py <serial> <sandbox_c> <work> <keypath> [max_tabs]
[max_steps] [first_tab] [only_tabs]` (handles min/max limits + apply-to-all
confirm dialogs, aborts the destructive zone-clear one). Ground truth for every
radio captured by `tools/scenario_rw_gt.py` → `notes/ground-truth/rw_<serial>.json`
(parsed by `tools/rw_gt.py`); decode matches every displayed value on all six
radios. **Real-RSS write validation:** 21 edits on 221AZN GET-loaded with no
warning and displayed exactly (`rw_221AZN0035_edited.json`, regression test).
Count fields that resize tables (# MPL, max user modes, MDC signalling enable) are
read-only. Not yet mapped: Zone Operation, Control Head Type, horn/lights rearm,
siren/PA, vehicle repeater, internal PA, speaker A/B, scan hang times, and the
multi-row lists (MPL / DTMF / phone / call / single-tone → future CSVs).

**Phone list + MPL list + phone options — DONE, in and out (101 tests, 2026-10-23).**
`phones.csv` (9 names + dial strings) and `mpl.csv` (name + RX/TX/TA squelch
type/code, RSS wording TPL/DPL/INV.DPL/Carrier) via `motreader/lists.py`; PHONE
LIST OPTIONS (access/release code, digit/interdigit/system delay) added to
`radio_wide`. Decode matches the RSS screens of all six radios
(`lists_<serial>.json`). An RSS-validated edit set (phones, phone options, MPLs
with DPL/INV.DPL, VHF mode Tx/Rx DPL, A9 mode + zone names, zone membership) GET-loads
with **no warning**. Map in `notes/FORMAT.md` §5e. Found along the way:
(1) **VHF mode Tx DPL polarity was reversed** in the mode codec (Rx was right):
fixed + RSS-validated; no existing export affected. (2) **A9 control-head
checksum cracked**: a big-endian 16-bit word sum at 0xDAF over the ASCII name block,
carried incrementally on import. This fixes the old "Bad control head checksum" on A9
zone/name edits (that came from the zone *name*, not membership). New tool:
`tools/scenario_steps.py` (ad-hoc RSS step scripts: navigate/type/dump/save).
Validation rules for the future UI are collected in `notes/VALIDATION.md`.

**Siren / PA / accessory options — DONE (109 tests, 2026-10-23).** A third
radio-wide area, the checksummed *control-head/accessory block* (CHB, sum of
[+0x1E,+0x11E) at +0x11E, located by signature + checksum). SIREN/PUBLIC ADDRESS
screen (8 fields) and ADDITIONAL OPTIONS (3 fields, ext+0x74) are read+write,
RSS-validated on 604AUN (the only radio with Siren/PA on: 9 edits GET-loaded with
no warning). Read-only: Siren/P.A. Options, Horn & Lights Rearm, Vehicle Repeater,
Internal PA, Speaker A/B, Control Head Type (they rewrite derived CHB+0x1C/+0x1D
bytes and/or per-mode data). **Update (same day):** W cracked white-box with the new
harness tools (save states + break-on-write + overlay locator, §14 of
PHASE1-HARNESS.md): W = interleaved sum of CHB[+0x12,+0x1B). Siren/P.A. Options,
Horn & Lights Rearm, Internal PA and Speaker A/B are now all EDITABLE with no
refused transitions; 17/17 RSS transitions byte-exact, RSS-validated on 617ASN,
566AYA and 604AUN (132 tests). **Control Head Type is now editable** (Standard / Enhanced / Rotary; S9000e is fixed),
reproducing RSS's side effects: options reset, Rotary forcing Phone/DTMF Encode
to List and turning off Volume Set Tone (and Mode Change Tone without zones). 16/16
RSS transitions byte-exact, 2 swaps GET-validated (150 tests). Vehicle Repeater,
SECURENET and trunking are deliberately not exposed (owner): preserved verbatim.
Import applies only values that differ from the template, so a swap's side effects
stand unless those fields were edited too. Map in FORMAT §5d; rules in VALIDATION.md. Still open:
VRS OPTIONS (needs VRS on), Phone/DTMF Encode, Dual Control Head, 604ATY SYSTEM
SEARCH AND LOCK (per-mode table → CSV candidate), Zone Operation, scan hang times.

**Control-head button map — DONE for all six radios (168 tests, 2026-10-24).**
`buttons.csv` (button, function, full name, raw code, editable).
Standard/Enhanced/Rotary heads via `motreader/buttons.py`: 20 × 4-byte entries
at header 0x123, 32 function codes with RSS names, keypad layout from 0x10D b1;
matches RSS on 5 radios, edits GET-validated on 604AUN and 566. **A9/S9000e head
(221AZN) via `motreader/buttons_a9.py`**: 24 buttons (Ind 1-6, keys 0-9 * #, six
labelled keys), 65 functions incl. direct-entry Zone/Mode/Sts/Msg N, from a
template table generated from RSS saves (`tools/build_a9_button_table.py` →
`motreader/_a9_table.py`). All 496 RSS cycle steps replay byte-exact; a 12-button
edit set GET-loads in RSS with no warning, displays exactly, and RSS's re-SAVE is
byte-identical (FORMAT §5f, rules in VALIDATION.md).

**Zone Operation — DONE (decode + switch, 187 tests, 2026-10-24).** CHB+0x13 b4,
`radio_wide.zone_operation`; zones decoded only when on (fixes 2 phantom zones on
604ATY). Switching re-packs the codeplug; `motreader/zoneop.py` reproduces RSS
byte-exact (617ASN off, 617ASQ on; 604AUN off but 3 header bytes RSS doesn't
need), and RSS GETs + re-saves the results unchanged. Also found the codeplug
skeleton (header section pointers, mode pointer table, record length 0x10A,
zone section pointers in ext) — mode records are now located through RSS's
pointer table (fixes decoding of the longer zones-off records), zones through
RSS's pointers (any zone count), and zone membership edits keep the section's
checksum valid. Refused for now: A9 head, trunked, > 120 modes (FORMAT §5g).

**Remove trunking — DONE for 566AYA (191 tests, 2026-10-24).** `motreader
remove-trunking`: the trunked mode 1 becomes conventional (copy of mode 2),
personality + talkgroup data removed, MAX SYSTEMS/SUBFLEETS 0; RSS GETs it
cleanly ("No Trunking data loaded") and re-saves it byte-identically. Codeplugs
with trunking system tables (hdr 0xE9) are refused for now (FORMAT §5h). Also:
900 MHz decode now stops at RSS's mode count (header 0x109), dropping the 3-7
junk rows beyond it in exports.

**Independent Rx / Tx / T·A squelch codes — DONE, both bands (195 tests,
2026-10-24).** 900: three tone slots per mode (true +14/+16/+18) in the VHF codec;
VHF T·A slot now exposed too; modes.csv gains `ta_pl` / `ta_squelch_type`; record
sums recomputed on edit. RSS-validated both ways (FORMAT §5i). This retires the
"900 PL write" deferral and fixes the 900 DPL writer that hit the T·A slot.

**Add / delete modes — DONE for standard heads (213 tests, 2026-10-24).**
`motreader add-mode` / `delete-mode` (`motreader/modeops.py`) reproduce RSS's
MODE UTILITY byte-exact on 9 captured operations (VHF + 900, zones on/off,
width growth, per-mode scan-list growth); motreader results GET-load in RSS
and re-save byte-identically (FORMAT §5j). Not yet: trunked, >120
modes width changes, scan lists in use. Next: add/delete zones.

**Zones-off scan — DONE (351 tests, 2026-10-24).** `motreader/convscan.py`:
per-mode SCAN / Scan Button Control / Coded Squelch / Talkback and Mode Slave
lists in modes.csv; CONVENTIONAL SCAN TYPE, list types and the Op Select list in
radio.yaml `conventional_scan`. SCAN TYPE is derived from the modes (900
Talkgroup = record +2 b4); Op Select ↔ Mode Slave and Pri Tlkgr ↔ Talkgroup
re-pack like RSS (7 transitions byte-exact); 604ATY's mode-number list format;
modeops renumbers every zones-off list (RSS has two renumbering bugs, not
copied). 30 single-step RSS saves byte-exact; four motreader edits GET-load
with no warning, show as set, re-save identically (FORMAT §5m). Also fixed: the
900 RX-tag test (a Talkgroup codeplug decoded as VHF) and record sums at +26.

**Zone scan lists + ZONE SCAN OPTIONS — DONE (289 tests, 2026-10-24).**
`radio.yaml` zones[].scan (`motreader/scanlist.py`): scan type, talkback,
scan button control, coded squelch, Non-Priority / Priority list type,
Priority 1 / 2 (mode, SELMOD or none) and the N Pri members; plus the
radio-wide hang times, Tx Revert Mode and Dynamic Priority Assignment. Every
bit mapped from RSS saves (23 reproduce byte-exact); motreader edits on all four
zone radios GET-load in RSS with no warning, display as set and re-save
byte-identically (FORMAT §5l). modeops now keeps a `<SELMOD>` priority (0xFF)
on add/delete (RSS-verified). Zones-off scan: see above.

**Add / delete zones — DONE, standard + A9 heads (242 tests, 2026-10-24).**
`motreader add-zone` / `delete-zone` (`motreader/zonelist.py`) reproduce RSS's
ZONE NAME LIST byte-exact on 8 captures (617ASN, 604AUN, 221AZN A9), except
the home zone, which motreader keeps pointing at the same zone (RSS leaves the
number or resets it to 01). motreader results GET-load in RSS and re-save
byte-identically (FORMAT §5k). A9 zones are now decoded through RSS's zone
pointers (was a structural search capped at 20 zones). Not yet: trunked
codeplugs, the zone count limit (probably 40). Next: scan lists.

**A9 / S9000e mode add / delete / edit — DONE (220 tests, 2026-10-24).** RSS
captures on 221AZN (add at end, insert after 1, copy, delete) reproduced
byte-exact: the head block moves whole to the next page boundary and the
11-char names shift within their fixed slot array (FORMAT §5j). motreader's own
add, add + delete, and add + delete + CSV edit GET-load in RSS with no warning
and re-save byte-identically.

**Deferred (preserved-only), still safe:** CODED SQUELCH (shows `Conventional`; not
an editable tab stop on hand, so undecodable differentially — left out of CSV,
preserved via raw bytes); VHF T·A tone slot
(+21/+22 preserved, not exposed as a field); 604ATY stride-40 squelch-byte offset;
DTMF call-signalling (deprioritized).

**Preservation guarantee — explicit, audited, tested (42 tests).** The write path
is strictly template-patch: bit-surgical edits, every other byte (incl. features
motreader doesn't understand) preserved verbatim from the source. `motreader.cli
import` now prints a change report (no-op → "byte-identical … all features known
and unknown preserved"; edit → "changed N byte(s) in M mode(s): …"). A
parametrized test asserts unchanged rebuild is byte-identical for **every** on-hand
radio, and another asserts a single-field edit touches only that mode. This is the
owner's priority: always produce a valid codeplug with unknown per-mode features
at safe (source) values. (DTMF signalling deprioritized — owner says the only
radio with the hardware is a 5-6 channel VHF rig that doesn't use it.)

## Done (solid, tested — 30 tests pass)

- `motreader/crypto.py` — archive body cipher, **byte-exact vs RSS** (both
  directions). Self-chaining XOR, Microsoft-rand LCG seed 1, 13-byte nonce.
  See `notes/FORMAT.md` §4 / memory `spectra-cipher`.
- `motreader/dbf.py` — `SPECTRAM.DBF` index, byte-exact round-trip.
- `motreader/archive.py` — container, both banner variants (long 0x53 / short 0x34).
- `motreader/codeplug.py` — band-aware decode (both validated byte-exact vs RSS,
  both directions, via the inverse oracle). **mode names** (6-bit packed, 0x266).
  **VHF**: independent RX/TX/T·A, byte-linear (`RX=0.635·lo+0.64·mid+52.91`,
  `TX=TA=0.3175·lo+0.32·mid+81.28`), records found by 0xE9/0xA9 tags.
  **900 MHz**: RX `925.65+0.0125·off15`; TX (carry=17,lo=18,mid=19) & T/A
  (carry=21,lo=22,mid=23) both `0.0125·(255·lo+256·mid)+816·(carry&1)`; PL/DPL
  (off 25). Carry bit0 = +816 MHz high-count.
- `motreader/cli.py` — `export` (archive→modes.csv + radio.yaml), `import`
  (template-patch, lossless), `decode` (raw plaintext). Edits are surgical.
- `dosbox-x/` — **patched dosbox-x** with a memory spy (how the cipher + fields
  were recovered). Build output `dosbox-x/src/dosbox-x`.

## Reverse-engineering toolkit (all in `tools/`)

- `oracle_run.sh <sandbox_c> <sec> <shotdir> "<autotype>"` — drive RSS under the
  **system** dosbox-x: AUTOTYPE keystrokes, Xvfb :99, `import` screenshots,
  and RSS **print capture** via `[parallel] parallel1=file printout.prn`
  (lands in CWD). Used for the PRINT ground truth and the differential oracle.
- `oracle_spy.sh` — drive the **patched** dosbox-x (`DBX` var), env
  `DOSBOX_SPYDIR` set, `core=simple` so the write-watchpoint sees CPU stores.
  Dumps: `mem_*.bin` (low RAM), `watch_*.bin` (dense during decode),
  `buf_*.bin`, `writes.log` (CS:IP of writes into the codeplug buffer).
- `find_plain.py`, `ghidra_*.py` (pyghidra; re-import SPECTRA1.EXE if the
  scratchpad Ghidra project is gone), `oracle_ramdump.sh`.
- All runner configs now set `working directory option = noprompt` (no GUI
  dialog). The spy worked because the built-in dosbox-x savestate crashes.

### Driving RSS (learned UI flow)

Splash→Enter. F3 GET/SAVE → F3 GET from Archive → pick serial → F8 GET SELECTED
→ decodes. **Arrow keys don't move the archive-list highlight via AUTOTYPE**;
use **F6 ENTER S/N**, type the serial, Enter, then F8. F10 to main. F5 PRINT →
F2 RADIO CONFIG / F5 MODE SUMMARY. F4 CHANGE/VIEW → F5 MODE (edit name/freq/PL),
F6 CONTROL HEAD (buttons). Save: F3 → F7 SAVE → F8. Each save re-nonces + stamps
today's date. Example mode-name edit (QQQ) and freq edit are documented working.

## Key corrections from the user (IMPORTANT)

- **RX, TX, TA are three INDEPENDENT frequencies** (RSS prompts for each; there
  is no "split"). Current `codeplug.py` wrongly sets `tx = rx - 25` — replace
  with a real per-field decode. For VHF the record holds RX at off 10-12 and TX
  at off 14-16 (equal for simplex).
- Odd splits are normal (ham). Decode TX/TA independently, don't assume.
- **Trunking is out of scope** (user has no key files; hams don't use it).
- Archives are a **mix of VHF and 900 MHz** rigs; goal is **every band + config**.
- User hex-edited SPECTRA1.EXE for 902-928 ham (WA1MIK article, in `notes/`) —
  that changes band *limits* in the EXE, not the per-channel encoding.
- One VHF rig has the **A9 head** → **longer mode names** (the names-table entry
  size varies by head/display type; standard is 8 chars = 6 bytes). Must detect.

## Codeplug structure — robustness findings

Tables are **NOT at fixed offsets**; they shift with codeplug size/config, so
they must be located dynamically:

- **Strings table**: a run of 6-byte 6-bit-packed entries. Order =
  [radio-wide labels: status messages, PHONE list, ECHO…] then **mode names
  last**. Mode names = the last N entries.
- **Mode count N**: from the **mode pointer table** — a run of u16 in
  ~`[0x5800,0xE800)` whose dominant delta is 26 (the record stride).
  **It can be odd-byte-aligned** (566aya @0x0C1B) — scan every offset, not just
  even. Has non-monotonic jumps (±) and a trailing marker ≥0xe000.
- **Mode records**: 26 bytes each (conventional), at a dynamic offset; for
  566aya @0x0D26, for 617asq @0x0560.
- A working odd-aligned pointer-table finder nails N=122 for 566aya; it still
  needs ±1 cleanup and fails on `a604aty`/`a604aun` (different layout) — finish this.
- `A428TWN2.810` (short banner) has **never been readable** even in RSS → ignore.
- `a221azn0.035` is odd (tiny strings table) — likely trunking-heavy; low priority.

## VHF frequency — SOLVED (byte-exact vs RSS)

Not a function of the packed integer — it is **linear in the individual record
bytes** (each field a separate fractional-N value). Per field (rec offsets):
RX `lo=6,mid=7` → `0.635·lo+0.64·mid+52.91`; TX `lo=10,mid=11,band=12` and
T/A `lo=14,mid=15,band=16` → `0.3175·lo+0.32·mid+81.28`. The band byte
(`a4/88/a8`) selects the VCO band and has **zero effect on displayed freq**.
RX/TX/T·A are independent (splits work). Resolution 2.5 kHz (TX) / 5 kHz (RX).
See `notes/FORMAT.md §5a`, `motreader/codeplug.py`, `tests/test_vhf.py`.

**Method = the inverse oracle (reusable, powerful):** template-patch a chosen
stored value into a VHF archive's freq field, re-encrypt, drop it in the sandbox
`ARCHIVE` dir, and let RSS GET + PRINT it — RSS reports the MHz for *your* value
(16 points/print). A byte-linear lstsq fit was machine-exact; a 2nd run over
136–174 MHz with ±600 splits confirmed encode. Tools: `tools/invsweep.py`
(value→MHz mapping), `tools/vhf.py` (codec research). RSS prints land in the
**launch CWD** as `printout.prn` (not the DOS CWD).

### Inverse-oracle AUTOTYPE that works (GET by serial + PRINT MODE SUMMARY)
`-w 7 -p 1.0 enter , , f3 , , f3 , , f6 , 6 1 7 a s q 1 2 6 6 enter , , , f8 , , , , , f10 , , f5 , , f5 , , , , , ,`
(F3=GET/SAVE, F3=GET from Archive, F6=ENTER S/N, type serial lowercase→RSS
uppercases + jumps the highlight, F8=GET SELECTED, F10=main, F5=PRINT, F5=MODE
SUMMARY.) Lowercase serial letters are accepted. Sandbox archive path
`C:\MRSS\SPECTRA\ARCHIVE`; `oracle_run.sh` copies MRSS to a sandbox C:.

## 900 MHz — SOLVED across models (universal codec + structural table finder)

All on-hand 900 archives now decode byte-exact vs RSS (except 221AZN — a different
product line). The breakthroughs:
- **Universal byte-linear freq codec** (same form as VHF): RX
  `0.0125·(255·off14+256·off15)+109.65`; TX & T/A `0.0125·(255·lo+256·mid)+816·(carry&1)`
  at off17-19 / off21-23. The old `925.65+0.0125·off15` RX was an approximation;
  the byte-linear form is exact for every model (incl. 617ASN's 935-940 band).
- **RSS display logic** (seen on 604ATY): off17-19 = repeater-input TX (902),
  off21-23 = RX-side/talk-around TX. TX shown = off17-19 if set else off21-23
  (simplex); T/A only for repeater; unprogrammed slot → RSS band default.
- **Structural, stride-agnostic table finder** (`find_900_table`): run of records
  with 0xA0@off13 + 0x8C@off24 at a constant stride — **26 B** (566AYA) or **40 B**
  (604ATY). 566AYA stays on fixed 0x0D26 (special mode 1 preserves its numbering).

Validated byte-exact vs RSS ground truth: **566AYA** 121/121, **604ATY** 113/113
real modes (+ empties) incl. a round-trip EDIT validated via the oracle (repeater,
odd-split and simplex), **617ASN** 53/53. **604AUN** decodes (same family; no GT).
**221AZN** (model `T83FWA` — different product line, likely 800/trunking): flagged
`900?`, names/raw only. GT in `notes/ground-truth/modesummary_{566aya,604aty0472,
617asn1665}.prn`; encode validations `m900_604aty_encode_validation.prn` etc.

Safety: freqs are emitted only for a recognized layout + plausible values; an
unrecognized codeplug is tagged **`900?`** (names/raw only, never bogus MHz).

## Reliable oracle method (USE THIS — AUTOTYPE serial entry is flaky)

`tools/mk_single_sandbox.py <SERIAL> <sandbox_c>` builds a sandbox whose archive
list holds ONLY that radio (filtered DBF + its a/b files), so RSS highlights it by
default. Then drive with **F8 (GET SELECTED), no serial typing**:
```
AT="-w 6 -p 1.5 enter , , , , f3 , , f3 , , f8 , , , , , f10 , , f5 , , f5 , , , , ,"
bash tools/oracle_run.sh "$sandbox_c" 100 "$outdir" "$AT"   # run backgrounded (>120s)
# printout.prn lands in the LAUNCH CWD (project dir)
```
This reliably GETs + PRINTs MODE SUMMARY. (The old F6+type-serial flow dropped
keystrokes ~half the time.)

## Next steps (priority order)

1. ~~221AZN~~ ✅ DONE (VHF A9-head, 11-char ASCII names + CTCSS PL, 0/65 vs RSS).
   ~~A9-head variable-length names~~ ✅ (ASCII name table, structural locator).
   ~~VHF PL~~ ✅ decode (Rx linear / Tx period → CTCSS). Remaining VHF PL work:
   **write-back** of edited PL (currently read-only; template-patch preserves the
   original tone bytes), and **DPL** (digital, flag ≥0xC000 — no sample yet).
2. **Per-channel params the user asked about** (power level, "hear clear" /
   audio compander, etc.) — NOT in the MODE SUMMARY print; they live in the RSS
   mode-detail screen (F4→F5). Needs another oracle pass to locate in the record.
   Verify 604AUN by capturing GT.
3. ~~Control-head buttons~~ ✅ DONE (KEYPAD, all heads; see above). Still open on
   that menu: F3 DEK boxes (none on hand), F4 NAMES, F5/F6 VIP ports.
4. ~~General radio-wide config~~ ✅ DONE (see Radio-wide bullet). ~~MPL + phone
   lists~~ ✅ DONE. Remaining radio-wide: siren/lights/PA/vehicle repeater/speaker
   A-B (566AYA ~0x555-0x5ff), Zone Operation, Control Head Type, scan hang times,
   CONVENTIONAL scan type + list types (structural), DTMF/call lists, single tones
   (disabled on every on-hand radio). Was: Home Zone, Home
   Mode, Mode Names, Time Out Timer, Hub Switch, Min Volume, etc.; CONVENTIONAL
   config (F4→F3): MDC Unit/Group/Fleet IDs, # MPL. (Zones DONE — see above.)
5. ~~Zones~~ ✅ DONE (name + membership, read+write, RSS-validated). Per-zone scan
   lists + flag bits remain preserved-only (not editable on the on-hand model).
6. **UHF / lowband / 800** — no archives on hand; same inverse-oracle method when
   the user has one.

## Paths

- Project: `~/Documents/projects/motreader` (git not initialized).
- Archives (real): `~/Documents/Ham Radio/Motorola/SPECTRA/{ARCHIVE,AR-ORIG,…}`.
- RSS install for the oracle: `~/.dosbox/c/MRSS/SPECTRA` (copy to a sandbox C:
  dir; **the old scratchpad sandbox is session-specific and gone after compact**).
- Ground truth preserved in-repo: `notes/ground-truth/`.
- Ghidra 12 at `~/Applications/ghidra_12.1.2_PUBLIC_20260605/...`; pyghidra in
  `~/venv` (re-import SPECTRA1.EXE; the scratchpad project won't survive).
- Run tests: `PYTHONPATH=. python -m pytest tests -q` (venv `~/venv`).
