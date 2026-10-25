#!/usr/bin/env bash
# Drive the Spectra RSS under dosbox-x in a private Xvfb, screenshotting as it
# runs. Keystrokes are supplied as an AUTOTYPE argument string (queued before
# the program launches and delivered on a timeline).
#
# Usage: oracle_run.sh <sandbox_c_dir> <seconds> <shotdir> "<autotype args>"
#   autotype args example:  -w 4 up enter -w 2 f3 ...
# Env: DISP (default :99), SHOT_EVERY (default 2)
set -u
SANDBOX_C="$1"; SECONDS_RUN="$2"; SHOTDIR="$3"; AUTOKEYS="${4:-}"
DISP="${DISP:-:99}"
SHOT_EVERY="${SHOT_EVERY:-2}"
mkdir -p "$SHOTDIR"
CONF="$SHOTDIR/dosbox-x.conf"

# Build dosbox-x config. AUTOTYPE (if any) runs before SPECTRA.EXE so its
# queued keys feed the program as menus appear.
AUTOTYPE_LINE=""
[ -n "$AUTOKEYS" ] && AUTOTYPE_LINE="autotype $AUTOKEYS"
cat > "$CONF" <<EOF
[sdl]
output=surface
autolock=false
[dosbox]
machine=svga_s3
working directory option = noprompt
captures=$SHOTDIR
[cpu]
cputype=386
core=normal
cycles=20000
[parallel]
parallel1=file append:printout.prn timeout:2000
[dos]
[render]
[autoexec]
mount c "$SANDBOX_C"
c:
cd \\MRSS\\SPECTRA
$AUTOTYPE_LINE
SPECTRA.EXE
EOF

# Clean any prior servers on this display
pkill -f "Xvfb $DISP" 2>/dev/null
pkill -f "dosbox-x.*$CONF" 2>/dev/null
sleep 1
Xvfb "$DISP" -screen 0 1024x768x16 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2
DISPLAY="$DISP" dosbox-x -conf "$CONF" >"$SHOTDIR/dosbox.log" 2>&1 &
DB_PID=$!

n=0
elapsed=0
while [ "$elapsed" -lt "$SECONDS_RUN" ]; do
  sleep "$SHOT_EVERY"
  elapsed=$((elapsed + SHOT_EVERY))
  printf -v idx "%02d" "$n"
  import -display "$DISP" -window root "$SHOTDIR/shot_$idx.png" 2>/dev/null \
    || { xwd -display "$DISP" -root 2>/dev/null | convert xwd:- "$SHOTDIR/shot_$idx.png" 2>/dev/null; }
  n=$((n + 1))
  kill -0 "$DB_PID" 2>/dev/null || { echo "dosbox-x exited early at ${elapsed}s"; break; }
done

kill "$DB_PID" 2>/dev/null
pkill -f "$CONF" 2>/dev/null
kill "$XVFB_PID" 2>/dev/null
echo "done: $n shots in $SHOTDIR"
