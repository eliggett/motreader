# motreader

Import/export tool for **Motorola Spectra RSS** (R06.00.05) codeplug archive
files — the `A*`/`B*` files and `SPECTRAM.DBF` produced by `SPECTRA.EXE`.

Goal: `archive → CSV (modes/channels) + YAML (other radio data)`, and the
reverse `CSV + YAML → valid archive`.

## Status

| Component | State |
|---|---|
| `SPECTRAM.DBF` index read/write | ✅ byte-exact (`motreader/dbf.py`) |
| Archive container (banner + body) | ✅ (`motreader/archive.py`) |
| Body cipher (decrypt/encrypt) | ✅ **solved**, byte-exact vs RSS (`motreader/crypto.py`) |
| Codeplug field map | 🔧 **VHF + 900 MHz: names, independent RX/TX/T·A freq, PL — DONE, validated byte-exact vs RSS across every on-hand radio** (one universal byte-linear codec + structural table finders; 900: 566AYA/604ATY/604AUN/617ASN; VHF: 617ASQ + **221AZN `T83FWA` A9 head**, 11-char ASCII names + CTCSS PL). **Per-mode options now mapped + round-tripped** (white-box via the dosbox-x harness, verified loading correctly in real RSS): VHF — Transmit/Talkaround Power, uP Xtal Shift, MDC PTT ID, Phone Encode, MPL Type; 900 MHz — **Audio Compander** ("hear clear"), Adaptive Splatter, MDC PTT ID, Phone Encode, Reverse Burst/TOC, UnMute/Mute Type, MPL Type, powers, uP Xtal. All in CSV. **Squelch type** (Carrier/PL/DPL/INV.DPL) derived for both bands (`rx/tx_squelch_type`); PL tones decoded; **DPL codes fully decoded AND editable on both bands** (`D023`…`D754`, the 83-code DCS set). 900: 2-byte pair at rec+25/26 Rx & rec+29/30 Tx. **VHF: the same 83-value map stored big-endian in the mode tone slot (Rx rec+17/18, Tx rec+19/20), with hi bit 0x20 selecting normal DPL vs INV.DPL** — cracked on 221AZN (T83FW) via the harness, validated byte-exact vs RSS, and a motreader DPL/INV.DPL edit GET-loaded into real RSS showing the right type + code. PL tones are also **editable on VHF** (Carrier↔PL↔DPL, byte-exact via RSS-captured tone tables, validated in real RSS). Unrecognized layouts still flagged `900?` (names/raw only, never bogus freqs). **Radio-wide ZONES — DONE (read + write, validated vs the RSS zone editor on every zone-bearing radio)**: zone **name** + **mode membership** (a mode may be in several zones), on all four on-hand radios with zones — 566AYA (12), 617ASN (4), 604AUN (4) on 900, and 221AZN (12) on VHF — via a structural locator that adapts the membership width to the mode count (`W∈{⌈n/8⌉,⌈n/8⌉−1}`, flag records `W+3`) and the zone-name encoding to the head type (6-bit packed for standard heads; fixed-width ASCII in the string pool for the A9/expanded head). No false zones on radios without them (617ASQ → none). `radio.yaml` gains a `zones:` list (mode numbers + readable names); edits are surgical and loaded correctly by RSS (`HAMZONE`/`ZEBRA` + membership shown). A9-head name edits keep the control-head checksum valid (no GET warning). **Radio-wide settings — DONE (read + write)**: 69 fields (60 editable) from the RSS RADIO-WIDE, OPTIONS, SCAN OPTIONS, CONVENTIONAL, DTMF, MDC and CONTROL HEAD OPTIONS screens (home zone/mode, volumes, tones, TOT/mode-names/compander masters, horn & lights timers, MDC unit/group/fleet IDs + options, DTMF ID + timing, backlight…) exported as `radio_wide:` in `radio.yaml`; decode matches the RSS screens of all six radios, and edits GET-load in real RSS with no warning (the extension section's checksum is recomputed). **Phone list + MPL list — DONE (read + write)**: `phones.csv` and `mpl.csv`, plus the phone access/release codes and timing in `radio_wide`; decode matches RSS on all six radios, edits GET-load in RSS with no warning. **Siren / PA / accessory options — DONE**: the SIREN/PUBLIC ADDRESS and additional-options settings (read + write, RSS-validated), plus read-only Siren/PA, Horn & Lights Rearm, Vehicle Repeater, Internal PA, Speaker A/B and Control Head Type. **Control-head buttons — DONE (read + write, all heads)**: `buttons.csv`, incl. the A9/S9000e head (24 keys, 65 functions, direct-entry Zone/Mode/Status/Message N; RSS re-save byte-identical). **Zone Operation — DONE**: decoded on all radios; switching it re-packs the codeplug exactly like RSS (standard-head conventional radios up to 120 modes; RSS-validated). **Add / delete modes — DONE** (`add-mode`, `delete-mode`; standard heads and the A9/S9000e head; RSS-validated). **Add / delete zones — DONE** (`add-zone`, `delete-zone`; standard + A9 heads; RSS-validated). **Zone scan lists — DONE** (`zones[].scan` in radio.yaml: members, Priority 1/2 incl. `<SELMOD>`, scan type and ZONE SCAN OPTIONS; plus scan hang times / Tx Revert / Dynamic Priority in `radio_wide`; RSS-validated on all four zone radios). **Zones-off scan — DONE** (modes.csv `scan*` columns: SCAN, Scan Button Control, Coded Squelch, Talkback, Mode Slave lists; radio.yaml `conventional_scan`: SCAN TYPE, Op Select / Mode Slave, the Op Select list; RSS-validated on 617ASQ, 604ATY, 604AUN). **Remove trunking — DONE** (`remove-trunking`: last trunked mode becomes conventional, systems 0; RSS-validated on 566AYA). VRS options, System Search & Lock, DTMF/call lists: TODO (CODED SQUELCH, 604ATY-squelch, DTMF, 900 PL *write*: preserved-only) |
| CSV/YAML import/export CLI | ✅ `motreader/cli.py` — lossless round-trip, surgical edits |

**Resuming work?** Read `notes/STATUS.md` first — full state, RSS UI flow, the
dosbox-x spy toolkit, the **inverse-oracle** method (how VHF + 900 were solved),
user corrections, and the prioritized next steps. Next open item: UHF/800/lowband
frequency codecs via the same inverse oracle.

## Usage

```
python -m motreader.cli export <archive> <outdir>          # -> modes.csv, phones.csv, mpl.csv + radio.yaml
python -m motreader.cli import <template_archive> <outdir> <new_archive>
python -m motreader.cli decode <archive> [plain.bin]        # raw decrypted body
```

Export writes a CSV per multi-row category (`modes.csv`, `phones.csv`, `mpl.csv` when MPL is enabled) and a YAML for
single-record radio data (`radio.yaml`). Import is **template-patch**: unchanged
input re-encrypts byte-identically to the original; an edit changes only the
mapped bytes. Frequencies (RX/TA) decode and round-trip exactly; unmapped fields
are preserved verbatim via the raw record bytes.

See `notes/FORMAT.md` for the reverse-engineering notes and what's known about
the archive format and the body scrambler.

## Layout

```
motreader/      Python library (dbf, archive, crypto, codeplug, cli)
web/            the web app (static: open index.html via any web server)
  lib/          format core in plain JS, no browser or Node APIs
  app/          the UI; tabs/ holds one module per tab
  vendor/       vendored third-party JS (see vendor/VENDOR.md)
server/         HTTPS test server for web/ (local testing only)
tools/          reverse-engineering helpers (pyghidra scripts, analysis),
                fetch_vendor.sh, cdp.mjs (headless-Chrome driver)
tests/          pytest round-trip tests; tests/js/ are the web app's Node tests
notes/          format documentation
samples/        (gitignored) copies of archives used while developing
```

## Development

Uses the venv at `~/venv` (PyYAML, pytest, pyghidra). Reverse engineering uses
Ghidra 12 headless against `SPECTRA1.EXE`.

```
PYTHONPATH=. python -m pytest tests -q
```

### Web app

The web app is plain JavaScript modules: no build step, the files in `web/`
are what gets served. Types are JSDoc comments checked by TypeScript's
checker, which never emits anything. Needs Node 22+ for the tests and tools
(Node 24 LTS lives in `~/.local/opt`, linked from `~/.local/bin`).

```
npm install                 # once: the dev-only checker (typescript, @types/node)
npm test                    # Node tests over tests/js/
npm run check               # type check web/lib, web/app, tests/js
npm run serve               # HTTPS on https://localhost:4443/ (run server/gen_keys.sh once first)
node tools/cdp.mjs --load ARCHIVE 'mr.tab("hex")' 'mr.text()'   # drive it headless
```

`window.mr` in the page is the test API (`web/app/testapi.js`): load a file
from bytes, switch tabs, read the visible text, inspect and answer dialogs,
read the log. Third-party code is copied into `web/vendor/` by
`tools/fetch_vendor.sh`, pinned by version and checksum.

## Safety note

The archive write path uses **template-patch**: it starts from a known-good
archive and changes only the exact bytes (down to individual bits in shared
flag bytes) for the fields you edited, preserving **every** other byte verbatim —
so any per-mode feature the tool doesn't yet understand is kept at the source
codeplug's known-good value. It then re-reads its own output to verify the edited
fields, and prints a change report listing exactly which modes/bytes changed. An
unedited round-trip is byte-identical (tested against every on-hand radio). RSS
does not verify the codeplug's internal checksum on GET (confirmed via the
dosbox-x harness), so stale checksums are harmless for the archive workflow.
Flashing a malformed codeplug to a radio can mistune or disable it, so the tool
favors preservation over regeneration.
