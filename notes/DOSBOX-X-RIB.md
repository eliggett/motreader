# Running Motorola RSS on Linux with dosbox-x and a RIB

Stock DOSBox and dosbox-x can't program a Spectra from Linux through a USB
serial adapter. Motorola's RSS fails with "Serial Bus Failure" errors such as
"Power Fault". The cause is SB9600 timing: RSS allows only a few milliseconds
for each byte's echo and for the BUSY line to change, and a USB adapter can't
answer that fast. Our dosbox-x branch `serial-rib` adds a `rib:1` option to
`directserial` that handles the echo and BUSY inside the emulator. With it,
unmodified RSS reads and programs a real radio on Linux. This was tested with
a 617ASQ Spectra and an FTDI FT232R adapter.

The technical details are in `RADIO-PROTOCOL.md`, under "Linux / real-port
problems in dosbox-x".

## 1. Clone

The branch is on our fork:

```sh
git clone -b serial-rib https://github.com/eliggett/dosbox-x-spy.git dosbox-x
cd dosbox-x
```

To keep up with upstream as well:

```sh
git remote add upstream https://github.com/joncampbell123/dosbox-x.git
git fetch upstream
```

The branch also carries motreader's memory-spy and trace hooks. They do
nothing unless `DOSBOX_SPYDIR` or `DOSBOX_CTLSOCK` is set in the environment,
so you can ignore them.

## 2. Build

Install the build dependencies. On Debian or Ubuntu:

```sh
sudo apt install build-essential automake autoconf libtool nasm pkg-config \
    libsdl2-dev libsdl2-net-dev libncurses-dev libpcap-dev libslirp-dev \
    libfluidsynth-dev libavformat-dev libavcodec-dev libswscale-dev \
    libfreetype-dev libxkbfile-dev libxrandr-dev libpng-dev zlib1g-dev
```

For Fedora and other distributions, see `BUILD.md` in the repo. The optional
libraries (fluidsynth, ffmpeg, pcap, slirp) can be left out. `configure` then
builds without those features, and RSS needs none of them.

Then build the SDL2 version:

```sh
./autogen.sh
./configure --enable-sdl2
make -j"$(nproc)"
```

The binary is `src/dosbox-x`. You can run it from there; installing is
optional (`sudo make install` puts it in `/usr/local/bin`). To confirm you
have the right build, step 4 shows the line to look for in the log when the
port opens.

If you update the branch later, run `git pull` and then `make` again. Rerun
`./autogen.sh` and `./configure` only if `Makefile.am` or `configure.ac`
changed.

## 3. Set up the serial port

**Permissions.** Your user must be able to open `/dev/ttyUSB0`:

```sh
sudo usermod -aG dialout "$USER"     # then log out and back in
ls -l /dev/ttyUSB0                   # crw-rw---- root dialout
```

**Latency.** With `rib:1`, dosbox-x asks the driver for low-latency mode
itself. On an FTDI adapter that brings the latency from 16 ms down to 1 ms.
If the log reports that this failed, or you want to be sure, set it by hand
(it resets when the adapter is unplugged):

```sh
cat /sys/bus/usb-serial/devices/ttyUSB0/latency_timer   # 16 by default
echo 1 | sudo tee /sys/bus/usb-serial/devices/ttyUSB0/latency_timer
```

To make it stick, add a udev rule such as
`/etc/udev/rules.d/99-ftdi-latency.rules`:

```
ACTION=="add", SUBSYSTEM=="usb-serial", DRIVER=="ftdi_sio", ATTR{latency_timer}="1"
```

**On Windows** (not yet tested with this branch): the 16 ms delay comes from
the FTDI chip, not from Linux, so it applies here too. dosbox-x can't change
it on Windows, so set it by hand with FTDI's VCP driver:

1. Open Device Manager, expand **Ports (COM & LPT)**, and open the
   properties of **USB Serial Port (COMn)**.
2. On the **Port Settings** tab, click **Advanced…**.
3. Under **BM Options**, set **Latency Timer (msec)** to **1** and click OK.
   The same dialog sets the COM port number, which goes in the dosbox-x
   config as `realport:COMn`.
4. Unplug the adapter and plug it back in.

The setting is kept when you replug the adapter, but only for that adapter
(Windows stores it per FTDI serial number). It lives in the registry as the
DWORD `LatencyTimer` under
`HKLM\SYSTEM\CurrentControlSet\Enum\FTDIBUS\<device>\0000\Device Parameters`.
Other chips (CP210x, CH340, Prolific) have no such setting.

A low-latency port is required whatever the emulator does. In simulation,
RSS read the whole codeplug with up to 4 ms of delay in each direction,
failed near the end at 8 ms, and failed at once at 16 ms. FTDI adapters work.
Some cheap clones report the modem lines slowly or not at all.

**Check the cable before starting RSS (optional).** Run this with the radio
connected through the RIB and switched on. It never writes to the radio.
From the motreader repo:

```sh
python3 tools/rib_check.py /dev/ttyUSB0          # BUSY lines and DTR round trip
python3 tools/rib_check.py /dev/ttyUSB0 --read   # also reads a few header bytes (read-only)
```

The first form only pulses BUSY three times, briefly, as every programming
session does. `--read` opens a read session like RSS's and ends it the same
way, so the radio restarts afterwards, just as it does after an RSS READ.

## 4. Configure dosbox-x

Put RSS in a directory that will be drive C:. This guide assumes
`~/dosbox/c/MRSS/SPECTRA/SPECTRA.EXE`; adjust the paths to match yours.
Create `~/dosbox/rss-rib.conf`:

```ini
[sdl]
output=surface
autolock=false

[dosbox]
machine=svga_s3
memsize=4
working directory option=noprompt

[cpu]
cputype=386
core=simple
cycles=20000

[serial]
serial1=directserial realport:ttyUSB0 rib:1

[autoexec]
mount c ~/dosbox/c
c:
cd \MRSS\SPECTRA
SPECTRA.EXE
```

Notes on these settings:

- `realport:ttyUSB0` is the device name without `/dev/`.
- `serial1` is COM1. If your RSS is set to use another COM port, put the line
  on the matching `serialN`.
- The `[dosbox]` and `[cpu]` settings are the ones we tested with. RSS times
  the bus with delay loops, so use a fixed `cycles` value rather than
  `auto` or `max`.

`rib:1` turns on the following behaviour. Each item has an option to tune it,
added after `rib:1` on the same `serial1=` line:

| Option | Default with `rib:1` | What it does |
|---|---|---|
| `ribecho:` | `1` | Echoes each sent byte to RSS at once, and drops the hardware's copy when it arrives. A hardware byte that differs is passed on, so bus collisions still show. |
| `ribholdoff:` | `30` (ms) | BUSY, as RSS sees it on RI and CTS, is our own DTR OR the hardware's BUSY. For this many ms after each DTR change, only DTR counts, while the hardware lines settle. |
| `rxdelay:` | `50` (ms) | How long a received byte waits for RSS to read it before it counts as an overrun. Stock directserial uses 0, which loses bytes. |
| (none) | always on | Sent bytes go out 5 at a time, one SB9600 message, or as soon as RSS pauses. The radio ignores a message whose bytes are more than about 2 ms apart. |
| (none) | always on | Low-latency mode on the port (see step 3). |

For example: `serial1=directserial realport:ttyUSB0 rib:1 ribholdoff:40`.

## 5. Run

```sh
src/dosbox-x -conf ~/dosbox/rss-rib.conf      # or: dosbox-x -conf …  if installed
```

When the port opens, the log (the terminal you started from) should show a
line like this:

```
Serial1: RIB mode, BUSY hold-off 30 ms, rxdelay 50 ms, local echo, low-latency port
```

If `, low-latency port` is missing, set the latency timer by hand (step 3).
If the line is missing altogether, you are running a stock dosbox-x rather
than this build.

Then use RSS as normal: READ, PROGRAM and CLONE all work. **Read and save
the radio before programming it**, so you have a backup.

## Troubleshooting

- **"Serial Bus Failure" at once.** Check that you started this build, not the
  distribution's `dosbox-x` (look for the log line above). Check the latency
  timer and the cable (`rib_check.py`).
- **Fails part-way through a read.** Latency is marginal. Set the latency
  timer to 1, close anything else that uses the USB bus heavily, and try
  `rxdelay:100`.
- **"Permission denied" or the port won't open.** See dialout under step 3.
  Make sure nothing else (motreader, the web app, `screen`, ModemManager)
  has the port open.
- **Byte-level log.** Run with `MOT_RIBDEBUG=1` in the environment to log
  every byte: sent, echoed locally, hardware echo dropped, received.

  ```sh
  MOT_RIBDEBUG=1 src/dosbox-x -conf ~/dosbox/rss-rib.conf 2>&1 | tee rib.log
  ```
- **The web app's Read Radio fails straight after using dosbox-x** with
  "The device has been lost". dosbox-x leaves the port's VMIN at 0, which
  Chrome can't handle. Fix it with `stty -F /dev/ttyUSB0 min 1`, or by
  replugging the adapter.

## Without a radio

The branch also adds a `rib` serial type (`serial1=rib port:N [host:H]`). It
connects COM1 over TCP to a simulated radio, `tools/fake_radio.py`, and is
used by motreader's test harness (`tools/scenario_radio_read.py`). You don't
need it to work with a real radio.
