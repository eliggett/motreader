#!/usr/bin/env bash
# Launch the motreader-patched dosbox-x (Phase-1 harness) fully detached, so it
# survives the launching shell and can be driven over the control socket across
# separate commands. core=simple is REQUIRED (the tracer hooks the non-inline
# mem accessors, which only core=simple uses).
#
# Usage: trace_run.sh <sandbox_c> <workdir> <sockpath>
# Then drive with: python tools/dbxctl.py <sockpath> <cmd...>
# Stop with:       tools/trace_kill.sh
set -u
SANDBOX_C="$1"; WORK="$2"; SOCK="$3"
DISP="${DISP:-:99}"
DBX="${DBX:-$HOME/Documents/projects/motreader/dosbox-x/src/dosbox-x}"
CYCLES="${CYCLES:-20000}"
mkdir -p "$WORK"
CONF="$WORK/dosbox-x.conf"
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
cycles=$CYCLES
[parallel]
parallel1=file append:printout.prn timeout:2000
[autoexec]
mount c "$SANDBOX_C"
c:
cd \\MRSS\\SPECTRA
SPECTRA.EXE
EOF

pkill -9 -x dosbox-x 2>/dev/null || true
pkill -9 -f "Xvfb $DISP" 2>/dev/null || true
rm -f "$SOCK"
sleep 1
setsid Xvfb "$DISP" -screen 0 1024x768x16 >/dev/null 2>&1 < /dev/null &
sleep 2
cd "$WORK"   # so printout.prn lands here
DISPLAY="$DISP" DOSBOX_CTLSOCK="$SOCK" setsid "$DBX" -conf "$CONF" \
    > "$WORK/dosbox.log" 2>&1 < /dev/null &
echo "launched dosbox-x (sock=$SOCK, work=$WORK); waiting for socket..."
for i in $(seq 1 40); do [ -S "$SOCK" ] && { echo "socket up"; exit 0; }; sleep 0.5; done
echo "WARNING: socket did not appear; see $WORK/dosbox.log"; exit 1
