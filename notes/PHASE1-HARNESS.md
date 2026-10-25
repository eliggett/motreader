# Phase 1 — White-box tracing harness (spec + results)

Status: **BUILT & VALIDATED (2026-10-22).** The harness is implemented and
proven end-to-end against RSS running the 221AZN (T83F) codeplug. See
**§13 Results** at the bottom for what was built, how it was validated, and the
findings that reshape Phases 2–5. The sections below are the as-built design.

## 0. Why

Everything motreader "knows" about the codeplug was recovered by black-box fitting
(edit a field, diff the plaintext, fit coefficients) plus structural heuristics
(tag runs, the `MODE <n>` default-slot anchor, frequency correlation). That can
only ever cover the radios we physically own, and it leans on assumptions about
content. The goal of the larger effort is to **extract RSS's own codeplug schema**
— per model/head/band: section directory, record sizes, field offsets, and the
exact (integer) codecs — by observing the program interpret the buffer, then
lifting the specific routines it uses. Phase 1 builds the smallest harness that
proves the method on the **read path** and establishes the reusable tooling.

See `notes/FORMAT.md` for what's decoded today and `notes/STATUS.md` for the
oracle tooling we already have. The cipher was cracked with an earlier version of
exactly this approach (a memory spy patched into dosbox-x).

## 1. Scope

**In scope (Phase 1):**
- Reliably locate the decoded-codeplug RAM buffer every run.
- Trace every **read/write** that touches that buffer, with the CS:IP doing it.
- Probe the Turbo Pascal real→string formatter to capture each numeric field's
  pre-format value and link it to the buffer bytes that produced it.
- **Single-step micro-tracing** of an isolated routine (per-instruction
  register/flag/memory deltas) so an algorithm can be read off by observation
  rather than decompiled — this is the primary derivation method (see §6).
- A **text-screen reader** (decode the video character buffer to exact text +
  highlight state) used both to drive RSS in a closed loop and to let us "see"
  the screen without screenshots/OCR (see §5.7).
- A control channel to script scenarios, insert trace markers, read memory, read
  the screen, and single-step.
- An offline analyzer that turns a trace into a "field → source bytes + routine"
  report.
- **Validation:** re-derive one already-known field (VHF RX frequency) entirely
  from a trace + single-stepping the implicated routine, with no curve fitting.

**Out of scope (later phases, noted so the design leaves room):**
- Data-flow **taint** propagation (Phase 3 / optional PANDA).
- The **write/encode** path end-to-end (Phase 5) — Phase 1 only *logs* writes.
- Extracting the per-model **schema table** from the EXE (Phase 4).
- The **MCP** veneer over the control channel (added once the command set settles).

## 2. What we already have (build on, don't rebuild)

- **Patched dosbox-x** at `dosbox-x/` with a working memory spy:
  `src/hardware/memory.cpp` — `MEM_SpyDump`, `MEM_SpyWatch`, `MEM_SpyDumpBuf`,
  `MEM_SpyWrite` (write watchpoint logging CS:IP); `src/dos/dos.cpp` — an INT 21h
  read hook that recognizes the archive banner and arms the spy. Gated by env
  `DOSBOX_SPYDIR`. Build output `dosbox-x/src/dosbox-x`.
- The decrypt store is at guest **CS:IP `1c4d:025c`**; the RNG at `cb6:7268`, the
  seeder at `cb6:7256` (from the cipher work — same binary).
- `tools/oracle_run.sh` (scripted RSS under Xvfb :99 with AUTOTYPE + print
  capture), `tools/oracle_spy.sh` (drives the patched build with `DOSBOX_SPYDIR`,
  `core=simple`), `tools/mk_single_sandbox.py` (single-radio archive list).
- Ghidra 12 + pyghidra in `~/venv` for targeted static analysis.
- Ground truth prints in `notes/ground-truth/` give expected field values.

**Core requirement:** memory ops must flow through the instrumentable `mem_*`
path, so run with `core=normal` (or `core=simple`, as the cipher work did). The
`dynamic`/`dynrec` JIT inlines accesses and must stay off.

**On static tooling (Ghidra et al.):** this is a 16-bit real-mode Turbo Pascal
binary with overlays, so Ghidra's **C decompiler is expected to be unreliable or
to bail** (segmented/far pointers break its flat memory model; overlays fracture
the call graph; TP's 6-byte `real`, length-prefixed strings, set types, nested
procedures with static links, and hand-written RTL math don't match C-shaped
patterns). The design therefore **does not depend on decompilation**:

- **Primary derivation is dynamic** — single-step the short routine the trace
  identifies and watch the arithmetic (§6). Decompiler-independent and immune to
  the Pascal/overlay issues.
- **Ghidra is still useful for disassembly, cross-references, data/structure
  views, and annotation** — the routines we care about are tens of instructions,
  and the Phase-4 schema-table hunt reads *data*, where the decompiler isn't
  involved. Use it as a workbench, trust the listing over the decompiler output.
- **miasm** (handles x86-16) is the optional path to lift a routine to a
  symbolic expression — an exact formula instead of a curve fit.
- If available, **older IDA (7.x)** handles 16-bit DOS + TP overlays and Borland
  RTL signatures better than Ghidra; fine to use as the disassembly workbench.

## 3. Success criteria

1. Buffer locator returns a correct `[base, len)` for ≥3 different archives
   (one VHF, two 900) with no manual offsets.
2. For a scripted "display mode N" scenario, the analyzer lists the exact buffer
   offsets read during that field's render and the CS:IP(s) that read them.
3. The formatter probe reports `146.520` (decoded from the TP real) for the RX
   render of a known mode, time-correlated to those reads.
4. Single-stepping the implicated routine yields the **real** RX formula; we can
   state it as integer math and show our fitted `0.635·lo+0.64·mid+52.91` is its
   float-equivalent — **derived, not fitted** (Ghidra/miasm only to confirm).
5. Navigation is driven closed-loop via `read-screen`, not blind AUTOTYPE.
6. dosbox-x and Xvfb are killed on scenario exit (standing instruction).

## 4. Architecture

```
  scenario driver (host)                     instrumented dosbox-x (guest RSS)
  ───────────────────────                    ─────────────────────────────────
  mk_single_sandbox ─┐                        ┌───────────────────────────────┐
  closed-loop driver ┼── launch ── Xvfb :99 ──┤ CPU core (normal/simple)       │
  (read screen,      │                        │   ├─ retired-instr counter     │
   decide, send key) │                        │   ├─ buffer locator (decrypt   │
         │           │                        │   │    store hook + sig scan)  │
         │  control channel (unix socket)      │   ├─ range watchpoint tracer   │
         ├──────────────────────────────────▶ │   ├─ TP-formatter breakpoint   │
         │   read-screen / set-watch / set-bp  │   ├─ single-step micro-tracer  │
         │   read-mem / mark / step / regs     │   ├─ text-screen reader(0xB8000)│
         │   send-keys / continue              │   └─ command poll @ safe point │
         │                                     └──────────────┬────────────────┘
         ▼                                                    ▼
  trace_decode.py ◀──────────── trace file (binary) ◀── trace writer
  trace_analyze.py ─▶ "field → bytes + routine" report
```

## 5. Components

### 5.1 Buffer locator
- **Primary:** hook the decrypt output. We already know the decrypt store at
  `1c4d:025c`; capture the destination linear address of its stores. First store
  = `base`; track the max to get `len`. This is authoritative and survives any
  relocation across runs.
- **Cross-check:** after GET completes, scan guest conventional + loaded segments
  for the body signature `COPYRIGHT MOTOROLA INC.,1987`; `base = match − 0xAD`
  (signature is at body offset `0xAD`; serial at `+0x1D`). The two must agree.
- Emits a `BUFFER base=… len=…` record at the head of the trace. The watch range
  defaults to `[base, base+len)` unless overridden.

### 5.2 Range watchpoint tracer
- Config: one or more `[lo, hi)` linear ranges, direction filter (R / W / both).
- On each in-range access, emit a record with: retired-instruction count, `CS`,
  `EIP`, linear addr, **buffer-relative offset** (`addr − base`), size (1/2/4),
  value, direction. (See §7 for the record schema.)
- Implementation: extend the existing `MEM_SpyWrite` into a generic hook on the
  byte/word/dword read and write paths in `src/hardware/memory.cpp`; pull
  `SegValue(cs)`/`reg_eip` for the CS:IP. Gate behind a new env/socket config so
  normal runs are unaffected.
- **CS:IP caveat:** `reg_eip` may point mid-instruction at the time of the access;
  that's fine for locating the routine — the analyzer/Ghidra disassembles a window
  around it. Record it verbatim; don't try to compute the instruction start now.
- **Overlays:** RSS (Turbo Pascal) likely swaps code overlays, so the same linear
  code address can host different routines over time. Log raw `CS:EIP`; when an
  INT 21h overlay-load is seen (EXEC/overlay calls), emit an `OVL` marker so the
  analyzer can bind a CS:IP to the overlay resident at that moment. Full overlay
  resolution is Phase 2; Phase 1 just records the markers.

### 5.3 Turbo Pascal real→string probe
- Purpose: capture each numeric field's value *before* it becomes text, and anchor
  it in time next to the buffer reads that computed it.
- TP's 6-byte `real` is passed on the stack; the formatter (`Str`/`Real2Str` RTL)
  is the convergence point for every displayed number. Phase 1 finds its entry
  two ways and keeps whichever lands first:
  - **Bootstrap (dynamic):** set a watchpoint on the on-screen/print text buffer
    that ends up holding `"146.520"`, backtrack to the routine that wrote it, and
    from there to its caller (the formatter). Record that CS:IP.
  - **Confirm (static):** identify the same routine in Ghidra by its TP-RTL shape.
- Once known, set a code breakpoint there. On hit, log the raw 6-byte real from
  the stack (decoded offline: `value = ±mantissa·2^(exp−129)`), the retired-instr
  count, and the return address (one-level backtrace) so we know which caller/field
  it served.
- **Linking:** because both the tracer and this probe stamp the retired-instr
  counter, the analyzer attributes the buffer reads immediately preceding a format
  call (within the same marker window) as that value's source bytes, and their
  CS:IP as the decode routine.

### 5.4 Control channel
- A localhost/Unix socket the instrumented build serves, drained from a **safe
  poll point** in the CPU loop (top of loop and at watchpoint hits) to avoid
  cross-thread races with the single CPU thread.
- Command set (also see §8): `set-watch`, `clear-watch`, `set-bp`, `clear-bp`,
  `read-mem addr len`, `regs`, `step [n]`, `continue`, `pause`, `read-screen`,
  `send-keys`, `mark <label>` (inject a labeled marker into the trace), `flush`,
  `instr-count`, `quit`.
- **First-cut fallback:** if the socket plumbing is slow to bring up, accept a
  static config via env (watch range from the locator, trace path) and derive
  markers from sentinels the AUTOTYPE triggers (e.g., a benign I/O-port write or
  a chosen INT the driver issues at BEGIN/END of a render). The socket is the real
  target because it's the MCP foundation; the sentinel path unblocks validation.

### 5.5 Scenario driver (closed-loop)
- Reuses `mk_single_sandbox.py` + Xvfb. A **scenario** is:
  `{ serial, navigation goal, marker points, expected field values }`.
- **Closed-loop driving replaces blind AUTOTYPE.** The driver uses the text-screen
  reader (§5.7): *read the screen → confirm we are on the expected menu/field →
  send the next key(s) via `send-keys` → read again to verify the result.* This
  removes the fixed-timing guesswork that made AUTOTYPE drop keystrokes (see
  STATUS "arrow keys don't move the highlight") — selection state is now observed,
  not assumed. AUTOTYPE remains available as a fallback for bring-up.
- Steps: build single-radio sandbox → launch instrumented dosbox-x with watch
  config + trace output → navigate to the target screen in a closed loop →
  `mark BEGIN:<field>` / render / `mark END:<field>` → quit → **kill dosbox-x and
  Xvfb :99** (`pkill -9 -x dosbox-x; pkill -9 -f 'Xvfb :99'`).
- Deterministic: a fixed archive and screen-verified navigation so traces are
  comparable across runs (needed for the differential experiment in §9).

### 5.6 Single-step micro-tracer
- Purpose: derive a routine's algorithm by observation, without the decompiler.
- Once a field's decode routine is localized (its CS:IP from §5.2, bounded by the
  reads and the §5.3 format call), set the instruction pointer region and
  single-step it, logging per instruction: the opcode, and the **deltas** to
  registers, flags, and any memory read/written. The resulting micro-trace shows
  the input buffer bytes flowing through concrete arithmetic to the output value.
- For a short routine this is read directly; for anything branchy, feed the same
  instruction window to **miasm** for a symbolic expression.
- Driven over the control channel (`set-bp` to the routine entry, then `step`/
  `regs`/`read-mem` in a loop); the host records the micro-trace to its own file.

### 5.7 Text-screen reader
- RSS is a DOS **text-mode** UI: TP's CRT unit writes straight to video memory at
  physical `0xB8000` (not via INT 10h), where each of the 80×25 cells is
  `[ASCII byte][attribute byte]`. Snapshotting that buffer gives the **exact**
  screen text — no screenshots, no OCR.
- **Locate the live buffer robustly** via the BIOS data area: video mode at
  `0040:0049` (expect 0x03, 80×25 color), active page offset at `0040:004E`,
  columns at `0040:004A`. Decode char bytes to an 80×25 text grid.
- **Attributes = selection/highlight.** RSS marks the selected list item / active
  field by inverting video or changing color (e.g. attr `0x70` = black-on-white).
  The reader returns the attribute grid too and flags cells whose attribute
  differs from the field default, so the driver (and later, I over MCP) can tell
  *which* item is highlighted — the key signal the old driver lacked.
- Exposed as a control-channel command (`read-screen [--attrs]`) returning the
  text grid plus a list of highlighted cells. Tiny to implement on top of the
  existing memory-read path.
- Caveat: valid only in text mode. R06 is text throughout; if a graphics mode is
  ever detected via `0040:0049`, the reader reports "not text mode" rather than
  returning garbage.

### 5.8 Trace writer + offline analyzer
- Writer: compact **binary** stream to a file in the scenario's output dir (append,
  flushed on `mark`/`flush`/exit). Binary keeps the per-access overhead low under
  `core=normal`.
- `tools/trace_decode.py`: binary → iterable of typed records.
- `tools/trace_analyze.py`: segment by markers; for a field window, print the
  buffer reads (offset, size, value, CS:IP), the formatter value(s), and a
  proposed "field @ offset(s), decoded by routine @ CS:IP" summary. Also supports
  **trace-diff**: given two scenario traces differing in one field, report the
  offsets whose read values differ (white-box version of today's plaintext diff).

## 6. Instrumentation points in dosbox-x

- `src/hardware/memory.cpp` — generalize `MEM_SpyWrite`; add read hooks on the
  byte/word/dword paths; range filter; emit records. New module `trace.cpp` for
  the writer + socket is cleaner than growing `memory.cpp`.
- CPU loop (`src/cpu/core_normal*.cpp` / `core_simple`) — a retired-instruction
  counter, the command-poll safe point, the code-breakpoint check for §5.3, and
  the **single-step hook** (§5.6): when armed, stop after each instruction so the
  control channel can read `regs`/memory before stepping again.
- **Text-screen read** (§5.7): no new hook needed beyond the memory-read path —
  resolve the active text buffer via the BIOS data area (`0040:0049/004A/004E`)
  and read `0xB8000` region; expose as `read-screen`.
- `src/dos/dos.cpp` — reuse the INT 21h hook to detect GET/load and to emit `OVL`
  markers on overlay/EXEC calls.
- All new behavior gated behind a new env (e.g. `DOSBOX_TRACECFG`) + the socket,
  so an un-configured build runs normally.

## 7. Trace record schema (draft)

Fixed-size little-endian records, 1-byte type tag + payload:

| Type | Fields |
|---|---|
| `BUFFER` | base (u32), len (u32) |
| `R` / `W` | instr_count (u64), cs (u16), eip (u32), off (i32, rel base), size (u8), value (u32) |
| `FMT` | instr_count (u64), real6 (6 bytes), ret_addr (u32) |
| `MARK` | instr_count (u64), label (len-prefixed string) |
| `OVL` | instr_count (u64), details (load addr / file id) |
| `BP` | instr_count (u64), cs (u16), eip (u32) |

Analyzer decodes `real6` and renders `off` as both absolute and
record-relative (given a known record stride) for readability.

## 8. Control command set (draft)

```
set-watch <lo> <hi> [r|w|rw]      clear-watch <id>
set-bp <cs> <eip>                 clear-bp <id>
read-mem <addr> <len>             regs
step [n]                          continue        pause
read-screen [--attrs]             send-keys <keys>
mark <label>                      flush           instr-count
quit
```
`read-screen` returns the 80×25 text grid (and, with `--attrs`, the attribute
grid + highlighted-cell list) for closed-loop driving (§5.5/§5.7). `send-keys`
injects keystrokes (the loop's "act" step). Responses are line-oriented text/JSON
(TBD). This set is intentionally the minimum that supports §9 and maps cleanly
onto an MCP tool surface later.

## 9. Validation experiment (the Phase-1 gate)

1. **Scenario A:** load a known radio, navigate to the MODE screen for a mode with
   a known RX (e.g. VHF mode 1 = 146.520), `mark BEGIN:rx` / render / `mark END:rx`.
2. Expect the analyzer to show reads at the RX field offsets within that mode's
   record and an `FMT` value decoding to **146.520** in the same window.
3. **Scenario B (differential):** same radio but RX patched to a different known
   value; trace-diff A vs B → the differing read offsets must be exactly the RX
   field bytes (confirms source bytes white-box, matching today's result).
4. **Single-step the implicated routine** (§5.6) and read the arithmetic off the
   per-instruction deltas → obtain the **real** decode (expected: an integer
   PLL-divider computation, of which `0.635·lo + 0.64·mid + 52.91` is the float
   projection). Confirm in Ghidra's listing and/or miasm; do **not** depend on the
   decompiler.
5. Navigation for A and B is done **closed-loop via `read-screen`** (not blind
   AUTOTYPE), and each step is screen-verified.
6. **Pass** when (2)–(5) hold and the buffer locator + markers worked across the
   archives in §3. That demonstrates the method end-to-end on reads; Phases 2–5
   then scale it to every field, the schema table, and the write path.

## 10. Deliverables / file layout

- `dosbox-x/src/hardware/trace.cpp` (+ hooks in `memory.cpp`, CPU core, `dos.cpp`).
- `tools/trace_run.sh` — scenario launcher (like `oracle_run.sh` + trace cfg +
  guaranteed dosbox/Xvfb cleanup).
- `tools/trace_decode.py`, `tools/trace_analyze.py`.
- `notes/PHASE1-HARNESS.md` (this file); results appended to `notes/STATUS.md`.
- Trace artifacts under the scenario output dir (git-ignored, large).

## 11. Risks & mitigations

- **JIT bypass** → force `core=normal`/`simple`; assert at startup that a JIT core
  is not selected when tracing is enabled.
- **Buffer relocation across runs** → locate via the decrypt-store hook, not a
  fixed address; cross-check with the signature scan.
- **`EIP` mid-instruction** → accept it; disassemble a window in Ghidra.
- **Overlays remap code addresses** → emit `OVL` markers in Phase 1; resolve the
  CS:IP→routine binding in Phase 2. (This is also why we single-step rather than
  decompile: stepping follows the live code regardless of overlay swaps.)
- **Finding the TP formatter** → dual bootstrap (output-buffer backtrack) +
  static confirm; don't block on the static ID.
- **Ghidra decompiler unreliable on 16-bit TP** → expected; derivation is dynamic
  (single-step) and uses Ghidra only for disassembly/data views (see §2).
- **Screen reader only valid in text mode** → gate on `0040:0049`; report
  "not text mode" instead of returning garbage if a graphics mode appears.
- **IPC thread-safety** → drain commands only at the CPU-loop safe point and at
  watch hits; no access to emulator state off-thread.
- **Perf under `core=normal` with range logging** → scenarios are short scripted
  sessions; filter strictly to the buffer range; buffer/stream the trace.

## 12. Open decisions (resolve at build time)

- Socket now vs. sentinel-marker fallback for the very first bring-up.
- Binary vs. TSV trace (spec assumes binary; TSV is easier to eyeball).
- Response encoding for the control channel (JSON vs. plain lines) — pick with the
  eventual MCP wrapper in mind.
- Whether to keep tracing in dosbox-x long-term or, if granularity disappoints,
  escalate to Bochs (gdbstub + instrument interface) or PANDA (record/replay +
  taint). Phase 1 commits to dosbox-x; this decision is revisited at Phase 3.

Resolved at build time: **socket** (not sentinel fallback); **binary** trace
with a Python decoder; **plain-line** control protocol (one command → one reply;
read-screen is multi-line terminated by `.`). dosbox-x granularity was more than
adequate — no escalation needed.

## 13. Results (as-built, 2026-10-22)

### What was built
All in `dosbox-x/`, gated by env `DOSBOX_CTLSOCK` (inert otherwise), **requires
`core=simple`** (the tracer hooks the non-inline `mem_readb/w/d` + `mem_writeb/w/d`
that only the simple core routes through; `core=normal`/JIT inline them):

- `src/hardware/memory.cpp` — the whole harness module appended here (no
  autotools changes): Unix-socket control channel served from safe points;
  range-watchpoint tracer (`TRACE_Mem`, R/W, logs cycle_count + CS:IP + addr +
  size + value); signature/`find` scan of low RAM; text-screen reader (BIOS data
  area `0040:0049/004A/004E` + video RAM read **through `mem_readb_inline`**, not
  `phys_readb`, because the text buffer is behind the VGA page handler under
  svga_s3); key injection via `BIOS_AddKeyToBuffer`; **speed control**
  (`speed <cycles>` / `speed max` sets `CPU_CycleMax`); breakpoints; and the
  single-step micro-tracer (writes `S` records with full register state).
- `src/cpu/core_simple.cpp` — one per-instruction gate (`motrace_gate` →
  `TRACE_StepGate()`), which also freezes the CPU thread while paused (a stop
  must serve the socket *there*, because returning CBRET_NONE does **not** return
  to `Normal_Loop`'s top — its inner `while(1)` just re-enters the core).
- `src/dosbox.cpp` — `TRACE_Poll()` call in `Normal_Loop` (the RUN-mode drain).

Host tooling in `tools/`: `dbxctl.py` (control client + typed helpers — the MCP
foundation), `trace_decode.py` / `trace_analyze.py` (binary trace → records,
field windows, A/B diff), `trace_lib.py` + `trace_run.sh` + `trace_kill.sh`
(launch under Xvfb :99 with **guaranteed dosbox-x + Xvfb SIGKILL** on exit),
`scenario_smoke.py`. Note: the control socket must live at a short path
(`$XDG_RUNTIME_DIR`), not the long scratchpad dir — AF_UNIX caps `sun_path` ~108.

### Validation (the §9 gate)
- Buffer located every run by signature scan: `find 434f505952494748`
  ("COPYRIGH") → the codeplug's `COPYRIGHT MOTOROLA INC.,1987` string.
- Closed-loop navigation of RSS **entirely via the screen reader + key
  injection** (no blind AUTOTYPE): splash → MAIN → F3 GET/SAVE → F3 GET FILE →
  F8 GET SELECTED → F4 CHANGE/VIEW → F5 MODE, reading/verifying each screen.
- Range-watch trace of the mode-render path + an A/B **trace-diff** (mode 1 vs
  mode 2) cleanly isolated the fields that change between modes.
- Single-step micro-tracer proven: `pause` → `step 40` produced 40 `S` records
  with `cycle_count` +1 per instruction and correct register deltas (caught a
  BIOS delay loop decrementing CX).

### Findings that reshape Phases 2–5
1. **The in-RAM codeplug layout ≠ the on-disk decrypted body.** The on-disk
   freq bytes (e.g. mode-1 RX `5e 35`) do **not** appear anywhere in guest RAM
   after GET — RSS transforms them on load.
2. **RSS parses the archive into a working image of decoded strings/enums.**
   Every frequency is stored as a Turbo Pascal length-prefixed ASCII string
   (`09 "146.52000"`); mode names are TP ShortStrings too. The Rx/Tx/TA freqs
   for a mode are three separate `"146.52000"` strings in the working struct
   (seen at 0x77b81/0x77bc5/0x77c4d, with another copy near 0x5dbdf).
3. **Therefore the binary→MHz decode is a GET-time conversion,** and screen
   re-render just copies the pre-formatted strings (the mode1/mode2 diff showed
   only ASCII name/number differences, no binary freq read).
4. **Strategic consequence:** the cleanest way to "read every attribute with no
   test-and-find" is to map **RSS's working-image record** (strings/enums RSS
   already decoded) and correlate each field to on-disk bytes — rather than
   reverse a numeric codec per field. This directly answers the per-channel
   params question (power level, compander): they live in the working image as
   decoded enums, reachable from the MODE OPT/UTILITY screens.
5. Code segments seen: `1c4d` is RSS's main code/overlay segment (same as the
   known decrypt store `1c4d:025c`); `1c4d:01af` is a **generic byte-store**
   (builds paths *and* strings — not a freq-specific formatter, so not a useful
   breakpoint anchor on its own). `0cb6` holds string-copy/display routines
   (`0cb6:1e20`, `0cb6:0662`) and the RNG (`0cb6:7268`).

### Immediate next experiment (Phase 2 entry)
To derive the on-disk→MHz codec white-box (if still wanted beyond the already
byte-exact black-box fit): trace **reads** of the transient decrypted-body
buffer during GET (watch writes to find where decrypt lands, then watch reads of
it) to catch the freq parser, then single-step it. But the higher-value Phase-2
task per finding (4) is to **map the working-image record struct**: diff the
working image across a one-field edit, label each string/enum slot, and build the
field table from it.


## 14. Tooling upgrade (2026-10-23): save states, break-on-watch, overlay map

Three additions to the control channel (`dosbox-x/src/hardware/memory.cpp`,
`src/dos/dos.cpp`) and their Python wrappers (`tools/dbxctl.py`,
`tools/trace_lib.py`):

| command | what |
|---|---|
| `save-state <file>` / `load-state <file>` | Whole-emulator snapshot via dosbox-x's SaveState (remark/confirm dialogs suppressed). Only at the main-loop safe point; refused while frozen at a break. Load only after the machine is up (RSS text on screen): loading during early init crashes dosbox-x. |
| `set-watch <lo> <hi> <r\|w\|rw>[b] [val]` | `b` = **break**: freeze the CPU at the next instruction boundary after a matching access (optionally only if the value == `val`). Works without a trace file. |
| `hit` | The last break hit: R/W, addr, size, value, CS:EIP, cycle. |
| `file-log [clear]` | Every INT 21h read: file, file offset, destination, count, cycle (also an `F` trace record). |

Python: `Dbx.save_state/load_state/hit/file_log`, `set_watch(..., brk=True,
value=...)`; `trace_lib.boot_cached(h, d, state, prepare)` (boot + GET once,
then restore in about 1 s; the RSS splash wait dominates, about 8 s total);
`trace_lib.context(d)` (registers, code ±0x40, stack, DS:SI / ES:DI, and the
code's origin); `trace_lib.locate_code(code, ip_index)`.

**Overlay lesson:** RSS's Turbo Pascal overlays thrash, and the overlay manager
also *moves* loaded overlays inside its buffer with plain memory copies. The
file-read log alone can't say what code sits at an address. `locate_code` finds
the live code bytes in the .EXE/.OVL files (voting windows, tolerant of fixups);
the log is a fallback. Result: a CS:IP → (file, offset), so Capstone/Ghidra can
read the whole routine statically.

**Worked example** (`tools/scenario_break_w.py`): break on the write of the
control-head summary word W into RSS's save buffer. The first hit was a block move
(the body shifted up 0x100 bytes for a header). Breaking on the pre-move address
caught the real encoder at SPECTRA4.OVL 0x32911: W = sum of CHB[+0x12, +0x1B),
bit-interleaved. About 50 s per experiment after the first, versus 3-4 min before.

## 15. Parallel harnesses + button cycling (2026-10-24)

**Parallel runs.** `Harness` now kills only its own dosbox-x and Xvfb (it used
to pkill every instance). Run up to ~4 at once on an 8-core machine, each with
its own display and sandbox: `MOT_DISP=:101 ... mk_single_sandbox.py <S>
<own dir>`. The socket path is per-PID already. `trace_lib.kill_all()` still
exists for a manual sweep. Gotcha: never edit a shell script while bash is
running it (bash reads scripts incrementally; the job's tail runs garbage).

**`tools/scenario_cycle_button.py`** (any head): steps one KEYPAD button
through every function RSS offers, SAVE after each. Handles:
* "Duplicate Buttons!": F2 blanks whichever button is later in TAB order; if
  that was the cycled one, the cycle re-steps from the start to the next value.
* Direct-entry functions (label ending `X`): Enter, Del Del, `$BTN_DATA`, Enter.
* `$BTN_PREP="<tab>:<n>"`: first move a function RSS requires onto another key
  in the same screen session (didn't help for A9 Sel/Home: those keys are fixed).
* Unexpected dialogs: screen captured into values.json, recovery, carry on.
* `[skip]` to resume mid-cycle.

`tools/build_a9_button_table.py <runs dir>` turns the A9 runs into
`motreader/_a9_table.py`. ~19 s per function; a full key is ~16 min.
