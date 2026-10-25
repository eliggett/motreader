#!/usr/bin/env bash
# Standing cleanup: SIGKILL the harness dosbox-x and its private Xvfb so stray
# "are you sure you want to quit?" dialogs don't accumulate on the desktop.
DISP="${DISP:-:99}"
pkill -9 -x dosbox-x 2>/dev/null || true
pkill -9 -f "Xvfb $DISP" 2>/dev/null || true
echo "killed dosbox-x and Xvfb $DISP"
