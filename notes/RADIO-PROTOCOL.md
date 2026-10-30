# Programming the radio directly: findings and plan

Goal: read and write a Spectra's codeplug from motreader (Python first, then
the web app), and patch dosbox-x so Linux users can run the original RSS on a
real serial port.

Status (2026-10-30):

- **Done:** the serial driver is decoded from SPECTRA1.EXE, and RSS has been
  run against a fake radio in dosbox-x. **PROGRAM works end to end**: RSS
  wrote the archive into the fake radio, and every write is decoded. **READ**
  reads the whole codeplug, but the archive RSS then saves differs, because
  the fake can't supply the radio's real MCU memory (see Open questions).
- **Not done:** nothing has been tested on a real radio.

Items marked *(guess)* are unconfirmed.

## Hardware path

PC RS-232 → RIB (level translator) → radio SB9600 bus (data + BUSY).

- PC **DTR** drives the bus BUSY line (RSS raises it while it sends).
- Bus BUSY comes back on **CTS**, and the cable ties CTS to **RI**. RSS reads
  only RI.
- The bus is half-duplex: everything RSS transmits comes back as an echo.

Known working setups: RSS on real DOS, DOSBox on Windows, and a modified DOSBox
on a Raspberry Pi (Ham-VoIP distribution; source not published). DOSBox on
Linux with a USB-serial adapter fails with a "radio not powered" type error.

## RSS's serial driver (SPECTRA1.EXE segment `10bd`)

The driver is hand-written assembly in the main EXE. Ghidra's decompile of it
is misleading; read the disassembly (`capstone`, image base segment 0x1000).
Offsets below are `10bd:xxxx`.

| Routine | Role |
|---|---|
| `0006` | Entry `(per_reply, scramble, cmd, last_index, address, buffer)` + status pointer. Runs the whole transaction between `cli` and `sti` |
| `04fa` | UART register table at DS:0x420–0x430 from the base port (COM1 0x3F8 / COM2 0x2F8, from DS:0x2532) |
| `0465` | cmd 1: save UART state, **9600 8N1** (divisor 0x000C), IER=0 |
| `0499` | cmd 9: same at **1200 baud** (divisor 0x0060) *(guess: flash bootstrap)* |
| `04cd` | cmd 7: restore the saved UART state |
| `0389` | build the outgoing message for cmds 2–6, 8, 10 |
| `020d` | a byte arrived: running CRC, echo check, reply handling |
| `0157` | timeout handling, end of a frame |
| `0542` | scramble a request; `051c` unscramble a reply; `0576` bit-reverse a byte |
| `1115:0072` | delay: busy-wait loop calibrated at startup (DS:0x434/0x436) |

Commands: 2/3/6 send fixed MODE messages, 4 = write `last_index+1` bytes one
per message, 5 = read (`per_reply` = 1 or 2 bytes per message), 8/10 = send 4
caller bytes.

### Line usage

- **Polling only**: IER is 0, OUT2 never set, FIFO untouched.
- **MCR is only ever written 0 or 1**: DTR is the BUSY output, RTS unused.
- **MSR bit 0x40 (RI) is the BUSY input.** CTS is never tested.
- RBR is read three times per received byte (relies on the 8250 holding the
  last byte).

### One message

1. Spin while RI is set (up to 0x9FFF MSR reads → **error 7**). Wait 7 delay
   units, check RI again.
2. Raise DTR, flush RBR, send byte 0.
3. For each byte wait up to 0x50 delay units for its echo; a different byte
   is a collision (**error 1**, retry). After the 4th echo, send the CRC.
4. **Opcode bit 7 clear** (no reply expected): wait 0x18 units, drop DTR, wait
   **one** unit, and **RI must be clear (error 9)**. This is the check most
   likely to fail through Linux + USB.
5. **Opcode bit 7 set**: keep DTR up and wait up to 0x78 units for a 5-byte
   reply. No reply → retry (error 5 after 10 tries). Wrong reply opcode →
   **error 4**. **The reply CRC is not checked** (`test al,0` at `0274`).
6. Up to 10 tries per message.

### Message format

5 bytes: 4 payload bytes + CRC. Payload is `addr_hi, addr_lo, data, opcode`.

| Opcode | Meaning | Reply |
|---|---|---|
| 0x87 | read | `r0, d(addr+1), d(addr), 07, crc` (r0 is anything) |
| 0x07 | write one byte | none |
| 0x08 | MODE (session control): `00 xx yy 08` | none |

CRC (`020d:0221`): per byte `t = b ^ crc; a = ((t sar 1) >> 1) ^ t;
cl = a sar 1 (inverted if negative) & 0x0F; crc = (((a << 1) & 0xF0) + cl)
^ TABLE[t & 7]`, table `00 99 AC 35 C7 5E 6B F2`. Implemented in
`motreader/sb9600.py`; matches every message RSS sent (thousands, zero bad).

Scramble (requests in codeplug sessions): over `(hi, lo, data)`,
`s0 = data^hi^0x9B; s1 = rev(data)^s0; s2 = rev(lo)^s1^0xB5`, rev = bit
reverse. In a multi-message read, RSS re-scrambles each next address over the
**previous message's scrambled byte 2** (as its data), so only the first
message has `s0 == s1`. Writes scramble their own data byte. Replies are
unscrambled by RSS: `d1 = rev(r2^r1^0x5C)`, `d0 = rev(r2^r0^0xA4)`.

### Error codes

7 busy stuck before sending, 1 echo mismatch, 9 BUSY still set after release,
5 no reply, 4 wrong reply opcode, 8 nothing at all, 6 unknown command. Not yet
mapped to RSS's message texts ("Serial Bus Failure: Bus Timeout / Busy Line
Locked / Power Fault / Protocol Error").

## The radio side (learned from the emulator)

### Sessions

Every access is bracketed by MODE messages (`00 xx yy 08`):

| Open | Close | Memory | Scrambled |
|---|---|---|---|
| `00 d1 01` | `00 90 01` | codeplug EEPROM | yes |
| `00 93 01` | `00 92 01` | MCU space: RAM 0x00xx, internal EEPROM 0xB6xx (68HC11 map) | no |
| `00 91 yy` | `00 90 yy` | MCU EEPROM 0xB600 (yy = 0x16, 0x19 seen) | no |
| `00 51 01` | – | second (rear) control head *(guess)*; read once, skipped when blank | yes |

Other MODE messages: `00 12 01` (after RMW writes to MCU RAM: enter
programming mode? *(guess)*), `00 10 01` (end: reset the radio *(guess)*).

### Memory map

- **Codeplug EEPROM at 0x6000. `radio[0x6000 + n] == archive_body[0xAD + n]`**
  (decrypted body). The archive's first 0xAD bytes are RSS's own prefix
  (13 bytes that change each save, 6 bytes from the radio, then zeros). The
  EEPROM starts `COPYRIGHT MOTOROLA INC.,1987`, then the serial at 0x601C.
- **Length**: `(byte[0x601C] − 4) × 32`, rounded up to 0x100. Holds for 51
  of the 57 archives on hand; the exceptions (221 800 MHz trunked, 604ATY,
  617AWJ) carry an extra 0x2000 bytes, presumably a second region — not
  mapped yet. A blank radio (0xFF) makes RSS read up to 0x7DFF.
- Header pointers are radio addresses: 0x6030 → section after the pointer
  table (FORMAT.md "header 0xDD"), 0x6038, 0x603A.
- RSS checks before PROGRAM: model at 0x6044–0x6057 (`" 503D37KMA7JA5DK    "`,
  else **error 15 "Model Numbers Do Not Match"**), EEPROM version at
  0x6029–0x602C (else "EEProm Versions Do Not Match"), plus 0x6132–0x6138.

### PROGRAM sequence (RSS → fake radio)

1. Read header fields and MCU bytes (b675–b676, b69f–b6a2, …); RMW-write two
   MCU RAM bytes clearing bit 3, then `MODE 00 12 01`.
2. In a `d1` session: **write 0x6000 = 0xFF first** (invalidates the
   header), then every byte 0x6000–0x6CFF in order, then 0x6000 again with
   the real value. One byte per message, about 10 ms each (0xD00 bytes ≈
   35 s).
3. Write MCU 0xB6A0 (0x39 here), `MODE 00 10 01`.

The result equals the archive except 16 bytes RSS maintains itself:
0x602D–0x602F, 0x6042–0x6043, 0x610F–0x6112, 0x6132–0x6138 (dates, history,
check values *(guess)*).

### READ sequence

Same probes, then 0x6000–0x6CFF in 0x100-byte blocks, two bytes per message.

## Open questions

- **MCU values.** RSS reads b675–b676, b69f–b6a2 and chases pointers through
  them. With all-FF it accepts the radio but "converts" the codeplug on save
  (size 0xD00 → 0x1000, many fields). With the 6 radio-sourced archive prefix
  bytes guessed in, it refuses ("Your Radio Is Not Supported By This Service
  Software release"). Only the real radio can tell us these: read them with
  motreader and compare with an RSS archive of the same radio.
- The 0x2000 extra region on the larger radios.
- What the 16 RSS-maintained bytes encode.
- Error-code → message mapping.

## Linux / real-port problems in dosbox-x

1. **RI timing** (error 9): RSS drops DTR and expects RI clear one delay unit
   later. Through USB, a DTR change is a control transfer and RI comes back
   in the next status packet (FTDI: up to the 16 ms latency timer; some
   clones don't report RI at all). directserial also polls modem lines only
   every 1 ms.
2. **0xFF bytes are eaten.** `libserial.cpp` (POSIX `SERIAL_getextchar`)
   treats every received 0xFF as a PARMRK escape and reads the next byte in
   its place, although PARMRK is switched off. Any message containing 0xFF
   (common: data, CRC, scrambled bytes) is corrupted on Linux only.

## Tools

- `dosbox-x` branch `serial-rib` (in `dosbox-x/`): new serial type
  `serialN=rib port:7600 [host:127.0.0.1]`. Models the RIB inside the
  emulator (immediate echo, RI = DTR OR radio BUSY) and speaks a 2-byte
  record protocol to the radio process: `D b` data, `B 0|1` BUSY, `R n` baud/100.
- `tools/fake_radio.py`: the radio end. Tracks sessions, unscrambles, serves
  reads from `--image` (+ `--set ADDR=HEX` pokes), applies writes, logs every
  message, `--dump`s memory on disconnect.
- `tools/scenario_radio_read.py`: boots RSS on the harness with COM1/COM2 on
  `rib` and runs READ (optionally `--save` the result) or `--program`.
- `motreader/sb9600.py`: CRC, scramble, reply layout.

## Plan

1. ~~Command layer~~ — done empirically (above); static RE only for the open
   questions.
2. ~~Fake radio in the emulator~~ — PROGRAM complete; READ complete except
   the MCU values.
3. **dosbox-x real ports on Linux**: fix the 0xFF bug; make RI follow DTR
   locally (an option for RIB cables, reusing the `rib` model) with the real
   RI merged in once it settles; FTDI `latency_timer=1` advice. Test on the
   radio-room machine. Offer upstream.
4. **motreader read (Python)**: `motreader.radio` over pyserial: sessions,
   read 0x6000..length, plus a raw dump of the MCU bytes RSS reads, so the
   archive prefix can be pinned down against an RSS archive of the same
   radio. Generous timeouts (not bound by RSS's one-unit RI check).
5. **Write, then the web app**: only after reads round-trip; always a backup
   read first; copy RSS's invalidate-first order (0x6000=FF … 0x6000 last).
   Web: Web Serial (`setSignals({dataTerminalReady})`,
   `getSignals().ringIndicator`), Chrome/Edge only.

Out of scope: firmware flashing (the 1200-baud bootstrap path).
