#!/usr/bin/env bash
# Run RSS under the patched dosbox-x (with MEM_SpyDump) so guest RAM is dumped
# to $OUT/dump every second. After RSS decodes a codeplug, a dump will contain
# the plaintext codeplug image.
# Usage: oracle_spy.sh <sandbox_c> <seconds> <outdir> "<autotype args>"
set -u
SANDBOX_C="$1"; SECONDS_RUN="$2"; OUT="$3"; AUTOKEYS="${4:-}"
DISP="${DISP:-:99}"
DBX="${DBX:-$HOME/Documents/projects/motreader/dosbox-x/src/dosbox-x}"
mkdir -p "$OUT/dump"
CONF="$OUT/dosbox-x.conf"
AT=""; [ -n "$AUTOKEYS" ] && AT="autotype $AUTOKEYS"
cat > "$CONF" <<EOF
[sdl]
output=surface
autolock=false
[dosbox]
machine=svga_s3
working directory option = noprompt
memsize=4
[cpu]
cputype=386
core=simple
cycles=20000
[parallel]
parallel1=file append:printout.prn timeout:2000
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
DISPLAY="$DISP" DOSBOX_SPYDIR="$OUT/dump" "$DBX" -conf "$CONF" >"$OUT/dosbox.log" 2>&1 &
DB=$!
n=0; e=0
while [ "$e" -lt "$SECONDS_RUN" ]; do
  sleep 3; e=$((e+3))
  printf -v idx "%02d" "$n"
  import -display "$DISP" -window root "$OUT/shot_$idx.png" 2>/dev/null || true
  n=$((n+1))
  kill -0 "$DB" 2>/dev/null || { echo "dosbox exited at ${e}s"; break; }
done
kill "$DB" 2>/dev/null; sleep 1; pkill -9 -f "$CONF" 2>/dev/null; kill "$XV" 2>/dev/null
echo "=== dumps ==="; ls -la "$OUT/dump" 2>/dev/null | tail -8
echo "done $n shots"
