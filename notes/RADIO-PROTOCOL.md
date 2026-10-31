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
- `write-radio` accepts a bigger codeplug (more modes) up to the 8 KB
  codeplug EEPROM (0x6000–0x7FFF); the radio's length comes from header
  byte 0x601C. `--clone` programs another radio of the same model.
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
  **The byte wraps**: the UHF D44KXA7JA7BK's codeplug (128 modes) fills the
  whole 8 KB EEPROM and has 0x601C = 0x04 (256 + 4). motreader reads
  `((k − 4) mod 256 or 256) × 32`, at most 0x2000; before that fix it read
  only the first block. Its read matches the EEPROM dump byte for byte.
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
0x602D–0x602F, 0x6042–0x6043, 0x610F–0x6112, 0x6132–0x6138 (save time and
its checksum, history; see "Codeplug checksum the radio checks").

### PROGRAM on the real radio (617ASQ, RSS through dosbox-x)

Simpler than against the blank fake radio (no MCU RAM writes, no
`00 12 01`): checking reads (model b675.., option block via 0xFFC6, header
fields, b69f–b6a2), then in **one** codeplug session `WRITE 6000=FF`, every
byte 0x6000..end in order, `READ 6000`; then MCU read b69f–b6a0, `WRITE
b6a0=39` (scrambled, codeplug session; it already held 0x39), the 0x51
probe, and `00 10 01 08`. RSS's writes went out about 25–30 ms apart; the
radio needs no reply-time between them beyond that.

### CLONE (RSS → fake radio, 617ASN1665 archive onto a 617ASN1767)

RSS's CLONE MENU (GET/SAVE F5 → F8) shows the target's Serial Number, MDC
Unit Id and DTMF Unit Id (editable), says "Serial Number And Front Panel
Password Of The Radio Will Be Merged", then programs as above. Result: the
source codeplug verbatim except the **target's serial** (and the usual
RSS-rewritten bytes). Its help: same model only; conventional radios clone
completely except MDC ID and DTMF selective-call number; trunked radios only
phone/call/scan lists.

- **Features check**: the codeplug holds a copy of the radio's option block
  (16 bytes; at 0x62F7 on the 617ASN, found through a pointer at 0x652C).
  When the target's differs from the archive's, RSS warns "Target Radio has
  different features than current archive … may result in incorrect
  operation" (F2 continue / F10 abort).
- Front-panel password: not located. Not 0x605F–0x6060; the remaining
  candidates are the bytes RSS rewrites (0x610F–0x6112, 0x6131–0x6138).
- Nothing else in the codeplug range is kept from the target, so per-radio
  alignment data is not in the codeplug.

motreader: `write-radio … --clone` writes the archive's codeplug with the
radio's serial, after checking the model and the archive's option bytes
(prefix 13..18) against the radio's option block (`--ignore-features` to
override). Emulator check: clone 1665 → fake 1767 verified, then RSS READ of
the result is clean.

### S9000e / A9-head radios: a second codeplug region at 0x8000

Every A9 / S9000e-head archive (221AZN, 221ASJ, 617AWJ; header 0x60 b5
clear) is exactly 0x2000 bytes longer than its header length; no other
archive is (604ATY/604AUN are unrelated oddities). Traced with RSS against
the fake radio (221AZN):

- The archive codeplug is `main` (header length, at 0x6000 as usual) +
  0x2000 bytes at **0x8000–0x9FFF**.
- That region has its own session, **`00 b1 05` … `00 90 05`, unscrambled**.
  RSS reads it **three bytes per message** (reply byte 0 is the third data
  byte, at addr+2); writes are one byte per message.
- Before programming, RSS reads 0xE004–0xE009 in that session and checks the
  region is writable: read 0x8000, write its complement, read back, restore.
- PROGRAM order: codeplug session (0x6000=FF, main), then the 0x8000 region,
  then b6a0, 0x51 probe, reset.
- RSS READ of the fake reproduced the archive exactly once the fake held the
  radio's full 16-byte option block (the codeplug carries a copy of it).

Not yet confirmed on a real S9000e radio (the third reply byte especially).
On a standard-head radio 0x8000 is firmware ROM, so S9000e radios must map a
second EEPROM there. motreader reads/programs it when the head bit says so,
refuses to mix head types, and does RSS's writability probe first.

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
  0x602D–0x602F, 0x6042–0x6043, 0x610F–0x6112, 0x6131–0x6138. Now known:
  0x602D–0x602F is the save time and 0x6042 its checksum (with the pointers),
  0x6131 the header sum (both below, "Codeplug checksum the radio checks").
  0x6132–0x6138 behaves like a history list: on READ, RSS pushes a new
  2-byte entry in front and drops the last. 0x610F–0x6112 is still unknown
  (inside the header sum; the radio boots with either RSS's value or the
  radio's). motreader keeps the radio's values, which RSS accepts.
- RIB timing (FT232R): BUSY appears ~1.5–2 ms after DTR on, clears ~4 ms
  after DTR off.

## The radio's memory space (real 617ASQ, `dump-radio`)

Both the codeplug session (scrambled) and the MCU session (plain) see the
68HC11's 64 KB address space; the codeplug session answered every block,
the MCU session not 14 of them.

| Range | Contents |
|---|---|
| 0x0000–0x0FFF | RAM (live state); 0x4000–0x4FFF partly mirrors it |
| 0x1000–0x103F | 68HC11 registers (skipped: reads can clear serial-port flags) |
| 0x1100–0x5FFF | code and tables |
| 0x6000–0x7FFF | codeplug EEPROM (8 KB; here 0x600 used, rest 0xFF) |
| 0x8000–0xFFFF | firmware ROM (version text at 0xFFD2) |
| 0xB600–0xB6FF | MCU EEPROM: "COPYRIGHT MOTOROLA INC.,1987" + serial at 0xB600; values 0xB628–0xB66F (alignment candidates); model at 0xB675; option block at 0xB681; 0xB69F–0xB6BA all 0x39 |

The dumps contain Motorola firmware: keep them local, never commit them.

## Codeplug checksum the radio checks (FL 01/82)

Programming a codeplug whose MDC Unit ID motreader had changed made the radio
show **FL 01/82** at power-on (the owner's test, twice). Cause: radio
**0x6131 = 8-bit sum of 0x6044..0x6130**, which motreader didn't update.

- Found by brute force over all 100 distinct archives on hand (8- and 16-bit
  sums and XOR over every range, against every RSS-maintained byte): this is
  the only checksum among them; the others are save stamps. No sum or XOR
  covers a mode record either (rebuild already keeps the known record sums).
- Firmware (617ASQ dump, capstone M680X): routine **0x1DF0** sums B bytes
  from X and compares with the byte after them. 0xB566 calls it with X=0x6044,
  B=0xED and writes the result to 0x6131 through the EEPROM writer 0xB262,
  right after storing the current mode at 0x6062 (body 0x10F, Home Mode).
  0xC673 does the same for **MCU EEPROM 0xB62D..0xB633 → 0xB661** (alignment
  area; worth knowing for the alignment work). The boot-time check itself
  wasn't found in the 64 KB view (banked code?).
- Confirmed on the radio by RAM comparison after power-up: with only 0x6107
  changed (stale sum), 131 RAM bytes differ from good boots, most of the
  working state isn't loaded, and **RAM 0x0053 = 0x82** (the "82"); with the
  sum corrected, all 4024 stable bytes match the good boots and 0x0053 = 0.
  The web app then programmed MDC 1118 with the fix: no error; 1110 restored.
- The firmware's error reporter (0x81C8) turns an index 0-4 into
  0x81/0x82/0x84/0x88/0x90, so other checks may exist; motreader also keeps
  the ext-block, mode-table, record, control-head and A9 sums.

### Second one: the directory checksum at 0x6042 (also FL 01/82)

Adding a mode in the web app and programming it gave FL 01/82 again (the
owner's test, twice), with the header sum correct. Cause: radio
**0x6042..0x6043 = the 16-bit sum of 0x6000..0x6041, bit-interleaved**: the
sum's low byte goes in the odd bit positions (bit k → bit 2k+1) and its high
byte in the even ones (bit k → bit 2k), stored big-endian. 0x6000..0x6041 is
the copyright text, the save time (0x602D..0x602F) and the section pointers
(0x6030..0x6041). Adding or deleting a mode moves the pointers; RSS
recomputes this word and motreader didn't.

- Holds in 262 of the 264 distinct codeplugs on hand; the two misses were
  made by motreader. On the failing codeplug: stored 2b01, should be 8309.
- How it was found: on the radio, RSS's own add-mode result
  (rss_asqadd_after) booted and motreader's didn't. Copying RSS's bytes into
  the radio group by group (record, names, 0x6042, then the bookkeeping
  bytes) isolated 0x602E..0x602F: with RSS's value it boots, with the other
  it shows FL. Those bytes are the **save time**, not a checksum
  (0x602E..0x602F = day(5) hour(5) minute(6), e.g. f30d = the 30th, 12:13;
  0x602D holds the month), so the checked value had to cover them. Over the
  archives, 0x6042 changes exactly when a byte of 0x6000..0x6041 changes (and
  never for record, name or radio-wide edits). Single-byte steps of the save
  minute moved it monotonically, which revealed the interleaving.
- The radio code switches ROM banks (0x0FA0, 0x0FE0); the 64 KB dump holds
  only the bank that was mapped, which is why neither boot check shows up in
  it. The ROM self-test (0x2BE6, FL 01/81) is visible: it XORs the firmware
  and sets 0x81 in RAM 0x0053.
- Confirmed on the radio: the failing codeplug with only this word corrected
  (motreader write-radio now corrects both sums) boots with RAM 0x0053 = 0.
- motreader recomputes both sums on every write path (`fixHeaderChecksum` /
  `fix_header_checksum`).

## Open questions

- ~~MCU values / archive prefix~~ — answered by the real radio (above). The
  fake radio still needs the ROM pointer at 0xFFC6 and the option block to
  satisfy RSS's checks.
- The 0x2000 extra region on the larger radios.
- What the 16 RSS-maintained bytes encode.
- Error-code → message mapping.
- Alignment test frequencies other than the radio's three (RSS has no way
  either); the advanced alignment screens (SERVICE F4) not looked at.
- Front-panel password location.

## Alignment (RSS SERVICE)

Decoded by pressing every key of every screen in RSS against the emulated
radio (`tools/scenario_align_recon.py --link pty-bus --keys ...`), then checked
on the 900 MHz 617ASN1665 (D37KMA7JA5DK) into a dummy load with
`tools/align_ptt_probe.py` and `motreader-py/align.py`. Implemented in
`motreader-py/align.py` (CLI `align`) and `web/lib/align.js` (Tech tab).

### Screens

| Screen (RSS key) | EEPROM byte | stored as | range | live message | test mode: entry; F2 / F3 / F4 |
|---|---|---|---|---|---|
| DEFAULT SQUELCH (F2) | 0xB64F | v | 0–15 | `01 02 v 28` | 41; — |
| TX DEVIATION (F3) | 0xB644 | v | 0–12 (D37 900 MHz: 0–14) | `01 (v+1)<<4 [B645] 32`, keyed only | 42; 42 / 52 / 62 |
| REF OSC WARP (F5) | 0xB62D | rev7(v) | 0–127 | `01 00 rev7(v) 43` | 41; — |
| TX HIGH POWER (F7) | 0xB62F | rev7(127−v) | 0–127 | `01 01 rev7(127−v) 33` | 11; 41 / 51 / 61 |
| PA CURRENT LIMIT (F7, F9) | 0xB62C | 0x80 \| v<<3 | 0–15 | `01 00 v<<3 42` + `01 01 [B62F] 33` | 11; 42 / 52 / 62 |
| TX LOW POWER (F8) | 0xB62E | rev7(127−v) | 0–127 | `01 01 rev7(127−v) 33` | 41; 42 / 52 / 62 |

rev7 = the low 7 bits reversed. Values on this radio: squelch 10 (0a),
deviation 11 (0b, B645 = 0a), warp 72 (09), high power 98 (5c), current
limit 7 (b8), low power 46 (45).

- **Test mode** `01 XX 10 40` (no reply): the radio goes to one of its own
  test frequencies and shows it on its display (`01 ff cc 3c` messages, e.g.
  "350125PL"; "350125CS" in mode 11). `01 00 00 40` leaves test mode. Only
  these three frequencies are known; RSS can't set others.
- **Live values** (no reply) change the running radio until it restarts.
  RSS sends deviation only while keyed (on PTT ON and on each arrow); squelch,
  warp and power on each arrow; warp, power and current limit also on PTT ON.
  RAM **0x000a** holds the power code in use (read back 7c after high power
  96, 65 after low power 44).
- **PTT**: `00 03 01 0a` (SETBUT broadcast, button 3 = PTT, pressed) and
  `00 03 00 0a` (released). RSS sends the release on entering every screen.
  Keyed, the radio broadcasts `01 00 01 19` (RADKEY) and `01 0b 01 3c` (TX
  indicator on); released, `01 0b 00 3c` and `01 00 c0 1b`. In RAM, **0x000d
  bit 3 and 0x003b bit 3 are set only while keyed** (0x0030 goes 82 → 00
  too); motreader reads them back after every PTT OFF. RSS reads RAM
  0x000c..0x0012 (synthesizer) after keying to show "TRANSMITTER ON nnn.nnnn
  MHz". Changing the test frequency while keyed, RSS unkeys, sends the test
  mode and keys again; motreader leaves it unkeyed.
- **Squelch / BUSY LED** (squelch screen, test mode 41): the radio
  broadcasts indicator 0x0a, the BUSY LED: `01 0a 01 3c` on, `01 0a 00 3c`
  off, with `01 xx 03 1e` + `01 00 01 1d` (open) / `01 00 00 1e` + `01 00 00
  1d` (closed). In RAM, **0x0031 bits 0x0c set open** (0x0c / 0 on the
  900 MHz; the UHF keeps bit 5 set) and **0x0038 bit
  5** (also 0x0005 bit 6) follow it; motreader reads 0x0031 and 0x0038. On
  the 617ASN into a dummy load, squelch 0 is open and 1..15 closed, swept
  both ways, 6 reads each. motreader's auto squelch steps up from 0 to the
  first value with BUSY off in 5 reads (500 ms after each change), left live
  for F8 (it found 1 here).
- **F8 PROGRAM VALUE**: in the codeplug session (scrambled, as RSS writes the
  MCU EEPROM), write the byte; read it back in the MCU session; read the
  block and write its **sum byte** (8-bit sum, no negation); read it back.
  Blocks: **0xB660 = Σ 0xB600..0xB62C**, **0xB661 = Σ 0xB62D..0xB633** (the
  firmware's 0xC673 computes this one), **0xB662 = Σ 0xB634..0xB643**,
  **0xB663 = 0xB644**, **0xB664 = Σ 0xB645..0xB658**, 0xB693 = Σ
  0xB665..0xB674, 0xB69E = Σ 0xB694..0xB69D. None is in the 0xB7FF range.
- Reads seen on entering screens: MCU EEPROM b62c–b62f, b634–b645, b64f,
  b655–b664; RAM 0589; the serial 601d–6027 every ~4 s while a screen is open.
- **Leaving SERVICE writes the radio**, F8 or not: RSS re-reads MCU EEPROM
  0xB600–0xB7FE and rewrites every sum byte above and **0xB7FF =
  −(sum of 0xB6A0..0xB7FE) mod 256** (0xB6A0..0xB7FF sums to 0; holds on
  the 617ASQ dump too). RSS doesn't check reply CRCs, so a bus error during
  that read writes a wrong check byte: the radio then shows **FL 01/92** at
  power-up. It happened once here (0xB7FF = 0xDA), fixed by writing 0x68
  back. `scenario_align_recon.py` therefore never leaves SERVICE through
  RSS on a real radio unless `--leave`; it kills dosbox-x and sends
  MODE_DONE, and checks the sum afterwards. It refuses F6 and F8 on a real
  radio.

### VHF 617ASQ1266 (D43KMA7JA5BK), 2026-10-31

Same messages, test-mode codes, encodings, sum bytes and RAM flags; RSS's
values matched motreader's decode (squelch 7, deviation 1, warp 65, high
power 54, current limit 15 = 0x78, low power 17). Differences:

- **Deviation runs 0–12 in RSS** (0–14 on the D37 900 MHz). The owner
  (2026-10-31): take VHF as the rule for all models, the 900 MHz (the only
  narrowband Spectra) as the exception. motreader reads the model at 0xB675;
  deviation is 0–12 unless `MODEL_TOPS` says otherwise (D37: 0–14).
- Test frequencies: low "146025", high "173975" on the display.
- Keyed, this radio (known VCO fault) sends RADKEY `01 ff 01 19`,
  `01 0b 00 3c`, `01 ff 01 1d` and redraws its display every second or so;
  RAM 0x000d / 0x003b still read keyed throughout (0x0038 bit 5, a BUSY
  flag, is set while keyed too). Those bursts made 10 quick retries all
  collide (BusError). **Fix: before a retry, wait for 30 ms of silence on
  the bus** (≤ 1 s; `SerialLink._wait_quiet`, `WebSerialLink.waitQuiet`).
- Squelch 0–2 open, 3–15 closed on a dummy load (auto squelch: 3).
- F8 round trip squelch 7 → 8 → 7, 0xB664 9c → 9d → 9c.

### UHF D44KXA7JA7BK (serial field "WA6VVCUHF100"), 2026-10-31

First UHF Spectra on the bus. Same messages, test-mode codes, encodings, sum
bytes and PTT RAM flags; RSS's values matched motreader's decode (squelch
12, deviation 5, warp 70, high power 85, current limit 11 = 0xd8, low power
25). Display "450025PL" on the low test frequency. Keyed 2 s at each test
frequency: keyed throughout, unkeyed after. Live power read back in 0x000a.
F8 round trip squelch 12 → 13 → 12, 0xB664 cc → cd → cc.

- **Deviation 0–14 in RSS**, like the 900 MHz D37; only the D43 VHF shows
  0–12 so far (`MODEL_TOPS` has D37 and D44 at 14; the default stays 12 as
  the owner chose before this radio).
- **RAM 0x0031 keeps bit 5 set** here (0x2c open / 0x20 closed), so the
  BUSY test reads only bits 0x0c (0x0c open on the 900 MHz too). With it:
  squelch 0–5 open, 6 flickers, 7–15 closed (both ways); auto squelch 7.

### PTT safety (motreader)

Keying only in a test mode that transmits; a watchdog unkeys before 10 s
(Python at 9 s, the web app at 8.8 s since a background tab's timers can be
up to 1 s late); every PTT OFF is sent twice and then read back (RAM 0x000d,
0x003b), retried 5 times, else an error saying to switch the radio off.
Leaving (or a crash in Python's `with Aligner`) unkeys, leaves test mode and
restarts the radio; the web app also unkeys on leaving the page. Tested on
the real radio: keyed 1.4–3.4 s at a time, watchdog-only unkey at 2 s.
Programming (F8) tested on the real radio with squelch 10 → 11 → 10: value
and 0xB664 sum (df → e0 → df) read back each time.

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
- **Burst send** (`ribburst:1`, default): transmitted bytes are held and
  written to the port 5 at a time (one SB9600 message), or once the program
  pauses for two byte times. The radio drops a message spread over more than
  ~2 ms, and one write per byte through USB goes out on the 1 ms frame
  schedule, which can spread it that far. Bytes go out only once our BUSY
  shows on the bus (DTR is a USB control request, the data another
  endpoint), at most 3 ms after DTR. The port's DTR drops only once the
  burst has left the port (RSS, seeing the local echo, drops DTR earlier).
- **BUSY** reported on RI and CTS = our DTR, OR the hardware BUSY (CTS or
  RI). After our DTR drops, the hardware BUSY is ignored until it reads clear
  (our own BUSY lags ~4 ms) or `ribholdoff:` ms (default 30). A byte from
  another device while we don't hold the bus ends that at once, and reports
  BUSY for two byte times by itself.
- **New message** (DTR up): unread bytes from other devices are dropped (a
  UART would have overrun), late echoes of the last burst are still matched,
  and unsent bytes of a message RSS abandoned are discarded.
- **`rxdelay:50`** unless given: received bytes wait for the program.
- **Low latency**: `ASYNC_LOW_LATENCY` on the port (FTDI drops to 1 ms).
  If that fails (logged), set it by hand:
  `echo 1 | sudo tee /sys/bus/usb-serial/devices/ttyUSB0/latency_timer`.
  With it, modem lines come from the driver's change counters (TIOCGICOUNT)
  when TIOCMGET is slow: on an FTDI each TIOCMGET is a 2 ms USB request, and
  directserial asks every millisecond, which ran the emulator 3.5x slower
  than real time.
- `MOT_RIBDEBUG=1` in the environment logs every byte (tx, local echo,
  dropped hardware echo, received, stale), line changes and flushes to the
  dosbox-x log; `tools/rib_log_decode.py` decodes it into messages.

Real radio (617ASN1665, 2026-10-31), dosbox-x 9697afd3a: all alignment
screens read with 0 retries in 387 messages; RSS READ in 53 s (was 168 s),
identical to `read-radio` apart from the RSS-maintained bytes.

Testing without a radio, with BUSY: `tools/pty_rib.py --bus FILE` models the
RIB's BUSY (measured lag: ~1.5 ms on, ~4 ms off; the radio's own BUSY while
it talks), and `tools/ptybus/ptybus.so` (LD_PRELOAD in dosbox-x,
MOT_PTYBUS=FILE, MOT_PTYBUS_STALL_US=2000) gives the pty those modem lines
and the FTDI's TIOCMGET stall. `scenario_align_recon.py --link pty-bus`
runs it; the committed build before 9697afd3a fails there as on the radio.

## Web Serial (the web app's Read Radio / Write Radio)

`web/lib/sb9600.js` and `web/lib/radio.js` port the Python protocol and
`Radio` (async; same checks and order); `web/app/serial.js` is the Web Serial
link (`setSignals({dataTerminalReady})` for BUSY out, `getSignals()`
`clearToSend || ringIndicator` for BUSY in, one `writer.write()` per message).
`tests/js/radio.test.js` runs them against `tests/js/fakeradio.js`, a port of
`tools/fake_radio.py`.

Real 617ASQ, Chrome 152 on Linux, FTDI FT232R (2026-10-30): read 18 s, write
plus verify 82 s (backup read 15 s, 1536 writes about 47 s), no retries; the
web read is byte-identical to `read-radio`'s. Mode 10 was left named
WEBWRITE. Findings:

- **VMIN.** Chrome keeps the tty's termios VMIN/VTIME. pyserial (and DOSBox)
  leave VMIN = 0, so `read()` returns 0 when no data is waiting, which
  Chrome reports as `NetworkError: The device has been lost` straight after
  `open()`. Fix: `stty -F /dev/ttyUSB0 min 1`, or replug the adapter.
  `SerialLink.close()` now puts VMIN back to 1; the app's error message and
  help explain it.
- **Break after PROGRAM.** The radio's reset after `00 10 01` puts a break on
  the line; Chrome ends the readable stream with `BreakError`. That is
  non-fatal (`port.readable` is replaced), so the link takes the next stream.
- **Leave the radio restarted.** Any session leaves the control head
  frozen until `00 10 01` (MODE_DONE), which restarts the radio. The first
  version verified after PROGRAM's reset without sending it again, and the
  owner found the panel frozen. Now the verify read ends with MODE_DONE, and
  both the app and the CLI send it on the way out after an error too
  (`Radio.finish()`).
- After the reset the 617ASQ puts breaks on the line for 7-8 s and before
  then answers only after retries, so the verify waits 10 s (`RESTART_MS` /
  `RESTART_WAIT`).
- The echo arrives at about 1 ms per byte even without FTDI low latency.
- Write Radio's verify is optional and can be cancelled (`Radio.cancel()`
  stops between messages; `finish()` then restarts the radio if a session
  was opened). Progress counts RSS's 256-byte blocks, with a time estimate.
- **Tech tab** (`web/app/tabs/tech.js`, shared connection in
  `web/app/radioconn.js`): hex read of any address but the 68HC11 registers,
  through the codeplug session (it sees the whole 64 KB); hex write (≤256
  bytes) inside RAM, codeplug EEPROM or MCU EEPROM, scrambled in the
  codeplug session as RSS writes b6a0; regions (`REGIONS` in
  `web/lib/radio.js`) read to .bin, and EEPROM regions written from .bin
  (only the differing bytes, then read back). Real radio: 7F00 written and
  restored, MCU EEPROM saved and its identical file written back (nothing
  differed), firmware read cancelled at block 3 of 128. About 100 bytes/s
  reading and 32 bytes/s writing. Alignment: see "Alignment (RSS SERVICE)".
  **Read & save all** (Memory regions): the codeplug as Read Radio reads it
  (an RSS archive), then every region (the S9000e one only when the header
  says so), in one .zip with a README (`web/lib/zip.js`: stored, CRC-32).
  About 12 minutes (11:38 on the UHF D44 through Chrome); its codeplug,
  codeplug EEPROM, firmware and MCU EEPROM matched dump-radio byte for byte.
  0x4000–0x4FFF (inside "code below the codeplug") is live memory: it
  changes between reads on the UHF and the VHF 617ASQ alike.
- The port chooser lists every ttyS* as well; there is no filter, since a
  real RS-232 port is a valid choice.
- Testing: headed Chrome on Xvfb (`--ozone-platform=x11`, no WAYLAND_DISPLAY),
  port picked in the chooser with xdotool. Headless Chrome shows no chooser,
  and CDP's DeviceAccess domain doesn't cover serial.

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
- `python -m motreader.cli dump-radio <port> <outdir> [codeplug|mcu|both]`:
  read every address each session answers (read-only; ~11 min per session).
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
5. ~~Write~~ — `write-radio` done and tested on the real radio.
6. ~~Web app~~ — Read Radio / Write Radio over Web Serial (Chrome/Edge),
   tested on the real radio (above).

Out of scope: firmware flashing (the 1200-baud bootstrap path).
