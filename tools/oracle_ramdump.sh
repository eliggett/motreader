#!/usr/bin/env bash
# Boot RSS, run an AUTOTYPE sequence, and let dosbox-x autosave machine state
# (RAM) periodically so we can extract the decrypted codeplug from memory.
# Usage: oracle_ramdump.sh <sandbox_c> <seconds> <outdir> "<autotype args>"
set -u
SANDBOX_C="$1"; SECONDS_RUN="$2"; OUT="$3"; AUTOKEYS="${4:-}"
DISP="${DISP:-:99}"
mkdir -p "$OUT/state"
CONF="$OUT/dosbox-x.conf"
AT=""; [ -n "$AUTOKEYS" ] && AT="autotype $AUTOKEYS"
cat > "$CONF" <<EOF
[sdl]
output=surface
autolock=false
[dosbox]
machine=vgaonly
working directory option = noprompt
memsize=4
autosave=10 2-2
[cpu]
cputype=386
core=normal
cycles=max
[sblaster]
sbtype=none
[gus]
gus=false
[speaker]
pcspeaker=false
[midi]
mpu401=none
mididevice=none
[innova]
[ne2000]
[autoexec]
mount c "$SANDBOX_C"
c:
cd \\MRSS\\SPECTRA
$AT
SPECTRA.EXE
EOF
pkill -9 -f "Xvfb $DISP" 2>/dev/null; pkill -9 -f "$CONF" 2>/dev/null; sleep 1
Xvfb "$DISP" -screen 0 1024x768x16 >/dev/null 2>&1 &
XV=$!
sleep 2
DISPLAY="$DISP" dosbox-x -conf "$CONF" -savedir "$OUT/state" >"$OUT/dosbox.log" 2>&1 &
DB=$!
n=0; e=0
while [ "$e" -lt "$SECONDS_RUN" ]; do
  sleep 3; e=$((e+3))
  printf -v idx "%02d" "$n"
  import -display "$DISP" -window root "$OUT/shot_$idx.png" 2>/dev/null || true
  n=$((n+1))
  kill -0 "$DB" 2>/dev/null || { echo "dosbox exited at ${e}s"; break; }
done
# Graceful shutdown so dosbox-x finalizes the savestate zip, then force.
kill -TERM "$DB" 2>/dev/null
for i in 1 2 3 4 5 6; do sleep 1; kill -0 "$DB" 2>/dev/null || break; done
pkill -9 -f "$CONF" 2>/dev/null; kill "$XV" 2>/dev/null
echo "=== state files ==="; ls -la "$OUT/state" 2>/dev/null; find "$OUT/state" -type f
echo "done $n shots"
