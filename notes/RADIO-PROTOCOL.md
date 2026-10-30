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
- **Real radio (2026-10-30, VHF 617ASQ1266, FTDI FT232R + RIB):**
  `motreader read-radio` reads it (0x600 bytes, ~6 s), and **unmodified RSS
  READs it on Linux** through dosbox-x `directserial ... rib:1`. The two
  archives match except the nonce and 17 bytes RSS rewrites on READ; RSS
  GETs motreader's archive with no warning. RSS sent no writes; the radio
  re-reads unchanged.
- **Programming the real radio works**: unmodified RSS PROGRAM through
  dosbox-x `rib:1`, and `motreader write-radio` (same contents, then mode 10
  renamed via CSV import). Both verified by reading back; RSS reads the
  edited radio without complaint.

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

### PROGRAM on the real radio (617ASQ, RSS through dosbox-x)

Simpler than against the blank fake radio (no MCU RAM writes, no
`00 12 01`): checking reads (model b675.., option block via 0xFFC6, header
fields, b69f–b6a2), then in **one** codeplug session `WRITE 6000=FF`, every
byte 0x6000..end in order, `READ 6000`; then MCU read b69f–b6a0, `WRITE
b6a0=39` (scrambled, codeplug session; it already held 0x39), the 0x51
probe, and `00 10 01 08`. RSS's writes went out about 25–30 ms apart; the
radio needs no reply-time between them beyond that.

### READ sequence

Same probes, then 0x6000–0x6CFF in 0x100-byte blocks, two bytes per message.

## Real radio findings

- **Message spacing:** the radio ignores a message whose bytes are more than
  ~2 ms apart (tested: write gaps up to 2 ms answered, 3 ms+ never). So a
  message must go out as one burst; sending byte-by-byte and waiting for each
  echo through USB (as RSS does on a UART) gets no answer.
- **Option block:** RSS reads a pointer at ROM 0xFFC6 (codeplug session,
  1 byte per message: `b6 81`), then 16 bytes of MCU EEPROM at 0xB681
  (session 0x93). Its first 6 bytes are archive prefix bytes 13..18 (here
  `00 56 40 a3 18 f7`); they are a superset of the header's 0x6032..0x6037.
- Other reads: b675..b677 = start of the model number ("D43" for
  D43KMA7JA5BK); b68a..b68e, b69f..b6a2 (meaning unknown); ROM ffd2..ffd5
  (a version string, " 606*" here). Session 0x51 (rear head?) does answer.
- **Bookkeeping bytes** RSS rewrites in the archive on READ (radio address):
  0x602D–0x602F, 0x6042–0x6043, 0x610F–0x6112, 0x6131–0x6138. Encoded, not
  yet understood; motreader keeps the radio's values, which RSS accepts.
- RIB timing (FT232R): BUSY appears ~1.5–2 ms after DTR on, clears ~4 ms
  after DTR off.

## Open questions

- ~~MCU values / archive prefix~~ — answered by the real radio (above). The
  fake radio still needs the ROM pointer at 0xFFC6 and the option block to
  satisfy RSS's checks.
- The 0x2000 extra region on the larger radios.
- What the 16 RSS-maintained bytes encode.
- Error-code → message mapping.

## Linux / real-port problems in dosbox-x

Reproduced without hardware: dosbox-x's `directserial` on a pseudo-terminal
served by `tools/pty_rib.py` (a RIB + fake radio, optional simulated
latency). RSS PROGRAM on plain `directserial` failed with **"Serial Bus
Failure: Power Fault"**, the owner's Linux symptom. Causes found:

1. **Echo latency** (RSS gives up at once: error 8). RSS allows about 0x50
   delay units (~12–20 ms) for each byte's echo and ~0x78 units for a reply's
   first byte. Through USB the echo is a full round trip, and a host stall
   uses up the window too (dosbox-x ties emulated time to the wall clock).
2. **Receive overruns.** directserial's default `rxdelay:0` discards a byte
   the program hasn't read by the next 1 ms poll; RSS polls between delay
   loops, so an echo + reply burst overruns ("Overrun RX" in the log).
3. **RI timing** (error 9): after dropping DTR, RSS wants RI clear one delay
   unit later; USB adapters report modem lines only every few ms (FTDI: 16 ms
   default latency timer; some clones not at all).
4. **0xFF bytes eaten** — only in older dosbox-x (e.g. the 2024.03.01 distro
   package): POSIX `SERIAL_getextchar` treated every 0xFF as a PARMRK escape.
   Current upstream sets PARMRK and parses it properly.

Simulated latency per direction vs RSS READ (with the fix below): 0 and 4 ms
read the whole codeplug; 8 ms fails near the end; 16 ms fails at once. So a
low-latency port is required whatever the emulator does.

### The fix: `directserial ... rib:1` (dosbox-x branch `serial-rib`)

```
[serial]
serial1=directserial realport:ttyUSB0 rib:1
```

With `rib:1`:

- **Local echo** (`ribecho:1`, default): each transmitted byte is echoed to
  the program at once, and the hardware's copy is dropped when it arrives. A
  hardware byte that differs is passed on, so collisions still show.
- **Burst send**: transmitted bytes are held and written to the port 5 at a
  time (one SB9600 message), or once the program pauses for two byte times.
  The radio drops a message spread over more than ~2 ms, and an emulator
  slower than real time spreads RSS's bytes ~4 ms apart.
- **BUSY** reported on RI and CTS = our DTR, OR the hardware BUSY (CTS or RI)
  except for `ribholdoff:` ms (default 30) after each DTR change.
- **`rxdelay:50`** unless given: received bytes wait for the program.
- **Low latency**: `ASYNC_LOW_LATENCY` on the port (FTDI drops to 1 ms).
  If that fails (logged), set it by hand:
  `echo 1 | sudo tee /sys/bus/usb-serial/devices/ttyUSB0/latency_timer`.
- `MOT_RIBDEBUG=1` in the environment logs every byte (tx, local echo,
  dropped hardware echo, received) to the dosbox-x log.

## Tools

- `dosbox-x` branch `serial-rib` (in `dosbox-x/`): `directserial ... rib:1`
  (above), and a serial type `serialN=rib port:7600 [host:127.0.0.1]` for the
  fake radio: the RIB modelled inside the emulator, the radio process on TCP
  with 2-byte records (`D b` data, `B 0|1` BUSY, `R n` baud/100).
- `tools/fake_radio.py`: the radio end. Tracks sessions, unscrambles, serves
  reads from `--image` (+ `--set ADDR=HEX` pokes), applies writes, logs every
  message, `--dump`s memory on disconnect.
- `tools/pty_rib.py`: the same radio behind a RIB on a pseudo-terminal
  (bus echo, `--echo-delay`/`--reply-delay` to simulate USB latency).
- `tools/scenario_radio_read.py`: boots RSS on the harness and runs READ
  (optionally `--save`) or `--program`; `--link rib|pty|pty-rib`.
- `tools/rib_check.py <port> [--read]`: radio-room check: modem lines, how
  fast BUSY follows DTR, one header read.
- `motreader/sb9600.py`: CRC, scramble, reply layout. The CRC equals the
  256-entry table in RadioConsole2 (`daemon/SB9600.cs`) for every input.
- `motreader/radio.py` + `python -m motreader.cli read-radio <port> <outdir>`:
  read-only reader (codeplug.bin, mcu.json, radio.log, an archive).

RadioConsole2 (`~/Documents/projects/RadioConsole2`, open-source SB9600 radio
control) agrees: messages are `address, data, data, opcode, crc`; BUSY is
DTR out / CTS in (with an invert option for some cables); broadcast
`00 00 01 08` resets the radio, the same opcode family as RSS's session
messages.

## Plan

1. ~~Command layer~~ — done empirically (above); static RE only for the open
   questions.
2. ~~Fake radio in the emulator~~ — PROGRAM complete; READ complete except
   the MCU values.
3. ~~dosbox-x real ports on Linux~~ — RSS READ works on a real radio.
   Still to try: RSS PROGRAM on the real radio. Offer upstream afterwards.
4. ~~motreader read (Python)~~ — reads a real radio; archive accepted by RSS.
5. ~~Write~~ — `write-radio` done and tested on the real radio. **Next: the
   web app**.
   Web: Web Serial (`setSignals({dataTerminalReady})`,
   `getSignals().ringIndicator`), Chrome/Edge only.

Out of scope: firmware flashing (the 1200-baud bootstrap path).
