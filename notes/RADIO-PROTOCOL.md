# Programming the radio directly: findings and plan

Goal: read and write a Spectra's codeplug from motreader (Python first, then
the web app), and patch dosbox-x so Linux users can run the original RSS on a
real serial port.

Status: findings from static analysis only. Nothing here has been tested
against a radio or the emulator yet. Items marked *(guess)* are readings of
decompiled code that still need confirming.

## Hardware path

PC RS-232 → RIB (level translator) → radio SB9600 bus (data + BUSY).

- PC **DTR** drives the bus BUSY line (RSS raises it while it sends).
- Bus BUSY comes back on **CTS**, and the cable ties CTS to **RI**. RSS reads
  only RI (see below).
- The bus is half-duplex: everything RSS transmits comes back as an echo.

Known working setups: RSS on real DOS, DOSBox on Windows, and a modified DOSBox
on a Raspberry Pi (Ham-VoIP distribution; source not published). DOSBox on
Linux with a USB-serial adapter fails with a "radio not powered" type error.

## What RSS's serial driver does

The driver lives in **SPECTRA1.EXE segment `10bd`** (main EXE, not an
overlay), so it can be read from the existing Ghidra project. Its functions
(Ghidra names):

| Function | Role |
|---|---|
| `FUN_10bd_0006` | Entry point: `(…, cmd, …, address, buffer)`. Picks the port, dispatches commands, runs the send/receive loop |
| `FUN_10bd_04fa` | Fills the UART register table at DS:0x420–0x430 from the base port |
| `FUN_10bd_0465` | cmd 1: save UART state, set **9600 8N1** (divisor 0x000C), IER=0 |
| `FUN_10bd_0499` | cmd 9: same, but **1200 baud** (divisor 0x0060) *(guess: bootstrap/flash use)* |
| `FUN_10bd_04cd` | cmd 7: restore the saved UART state |
| `FUN_10bd_0389` | Builds the outgoing 5-byte message for cmds 2–6, 8, 10 |
| `FUN_10bd_020d` | Receive path: echo check, CRC, reply handling |
| `FUN_10bd_0157` | End of a frame: drop BUSY, check the line, retry logic |
| `FUN_10bd_0542`, `_0576` | Address scrambling (XOR 0x9B / 0xB5 with a bit-reverse helper) *(guess)* |
| `FUN_1115_0072` | Delay: a busy-wait loop calibrated at startup (counts at DS:0x434/0x436) |

Callers in segment **`1e34`** form the command layer (programming mode,
addresses such as 0x6028, block reads/writes). Not yet analysed.

UART register table (DS words): 0x420 THR/RBR, 0x422 DLL, 0x424 IER,
0x426 DLM, 0x428 IIR, 0x42a LCR, 0x42c MCR, 0x42e LSR, 0x430 MSR.
COM1 (0x3F8) or COM2 (0x2F8) is chosen from DS:0x2532.

### Line usage

- **Polling only.** IER is 0, and OUT2 is never set. No IRQs, FIFO untouched.
- **MCR is only ever written 0 or 1**: DTR is the BUSY output, RTS is unused.
- **MSR bit 0x40 (RI) is the BUSY input.** CTS (0x10) is never tested.

### Sending a message (cmd path in `FUN_10bd_0006`)

1. Spin while RI is set, up to 0x9FFF MSR reads; timeout → **error 7**.
2. Wait 7 delay units and re-check RI clear (repeat 1 if it isn't).
3. Raise DTR (MCR=1), read RBR to flush, write the first byte.
4. For each byte, poll LSR data-ready for up to 0x50 delay units. Compare the
   echoed byte with what was sent; a mismatch is treated as a collision
   (**error 1**). Send the next byte only after its echo.
5. After 5 bytes, drop DTR (MCR=0), wait **one** delay unit, then read RI.
   **If RI is still set → error 9** (except cmd 10).
6. Wait for the radio's 5-byte reply, checking the CRC. No reply in time →
   **error 8**. Retries up to 10 times.

### Message format

- 5 bytes per SB9600 message.
- CRC is table-driven; table `00 99 AC 35 C7 5E 6B F2`, held at
  `buffer+0x118`.
- The 4 payload bytes are built as `addr_hi, addr_lo, data, opcode`, then the
  CRC.
- Read (cmd 5): `addr_hi addr_lo 00 87`. The address is scrambled when the
  caller sets the flag *(guess)*. RSS expects reply opcode 0x07.
- Write (cmd 4): `addr_hi addr_lo <byte> 07` *(guess)*.
- cmds 2, 3, 6 send fixed messages (`00 01 05 08`, `00 01 01 08`,
  `00 00 00 08`); cmds 8 and 10 send 4 caller-supplied bytes.

### Error codes → messages

Not mapped yet. RSS's messages include "Serial Bus Failure: Bus Timeout",
"…Busy Line Locked", "…Power Fault", "…Protocol Error", and "Unable To
Communicate With Radio". The Linux symptom is most likely error 9 or 7.

## Why it probably fails under DOSBox on Linux

RSS drops DTR and expects RI to follow within **one delay unit**. On a real
UART with a RIB, that takes microseconds. Through Linux + USB it doesn't:

- A DTR change is a USB control transfer.
- FTDI reports modem lines (including RI) in its bulk-in packets, which can
  wait up to the 16 ms latency timer. Some CH340/PL2303 clones don't report
  RI at all.
- DOSBox's directserial polls the modem lines on its own ~1 ms timer.

RSS therefore sees its own BUSY still asserted on RI and reports a bus fault.
The Ham-VoIP build very likely patched exactly this.

## Plan

The logic analyzer step is dropped: the emulator gives us the protocol, and
we'll check it against the real radio by reading (not writing) first.

### 1. Command layer (static RE)

- Decompile segment `1e34` and the callers of `FUN_10bd_0006`: entering
  programming mode, address map, block size, reset.
- Confirm the scramble and CRC by implementing them in Python and checking
  against hand-computed frames.
- Map error codes to message strings.

### 2. Fake radio in the emulator

- Add a dosbox-x serial backend (or extend `nullmodem`) whose RI and echo are
  controlled by an external process.
- Write a Python fake RIB+radio: echo bytes, follow DTR on RI, answer SB9600
  messages from a codeplug image we already decode (the owner's own radio;
  third-party codeplugs stay structural samples only).
- Drive RSS "Read radio" through the existing headless harness. Success: RSS
  saves an archive identical to the source codeplug.
- Drive RSS "Program radio" against the fake and log the full write sequence.
  This is how we learn writing without risking a radio.

### 3. dosbox-x patch for real ports on Linux

Goal: unmodified RSS works on Linux with a USB-serial adapter.

- Trace the real-port path in dosbox-x 2024.03.01 (`directserial`,
  `libserial` Linux side): when MSR is refreshed, and how MCR writes reach
  the port.
- Measure with the hardware: a small pyserial script toggles DTR and logs RI
  with timestamps; try FTDI `latency_timer=1`.
- Likely fix: after a guest MCR write, refresh modem status synchronously
  (`TIOCMGET`) and/or hold RI to follow DTR until the hardware confirms it,
  as a config option for RIB cables.
- Upstream the patch to dosbox-x if it stays small and optional.

### 4. motreader read (Python)

- `motreader.radio`: pyserial, 9600 8N1, DTR out / RI in, generous timeouts
  (we aren't bound by RSS's one-unit check).
- Read-only first. Success: a radio read matches an RSS archive of the same
  radio byte for byte (after the archive's own wrapping is removed).

### 5. Write, then the web app

- Allow writes only after reads round-trip, and always take a backup read
  first.
- Web: Web Serial API (`setSignals({dataTerminalReady})`,
  `getSignals().ringIndicator`). Chrome/Edge only. Share the protocol logic as
  a JS mirror of the Python module, as with the codec.

Out of scope: firmware flashing (the 1200-baud bootstrap path).
