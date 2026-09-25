#!/bin/bash
# with_port.sh DEV CMD... — run CMD with exclusive use of serial device DEV on a workbench
# Pi: SIGSTOPs every process holding DEV open (the slot's RFC2217 proxy), runs CMD, then
# SIGCONTs them again — even if CMD fails. The portal keeps the slot; it just goes quiet.
#
# Re-enumeration race: after a board re-enumerates (1200-baud touch, hard reset) the portal
# restarts the slot's proxy a few seconds later. A proxy that starts mid-command reads from
# the port too and corrupts the esptool stream. So: wait for a holder to appear before
# starting, let it finish its DTR/RTS open sequence before pausing it, and keep watching
# for late arrivals while CMD runs. Our own children (the bridge) share our process group
# and are never paused.
set -u
dev=$1; shift
stopped=$(mktemp)
mypg=$(ps -o pgid= -p $$ | tr -d ' ')
holders() {
  for p in $(sudo fuser "$dev" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$'); do
    [ "$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')" = "$mypg" ] && continue
    echo "$p"
  done
}
stop_new() {
  for p in $(holders); do
    grep -qx "$p" "$stopped" && continue
    sleep 0.7                                   # a just-started proxy: let its open sequence finish
    sudo kill -STOP "$p" 2>/dev/null && echo "$p" >> "$stopped"
  done
}
resume() {
  [ -n "${watcher:-}" ] && kill "$watcher" 2>/dev/null
  for p in $(cat "$stopped"); do sudo kill -CONT "$p" 2>/dev/null; done
  rm -f "$stopped"
}
trap resume EXIT
for i in $(seq 1 14); do [ -n "$(holders)" ] && break; sleep 0.5; done   # portal bringing the proxy back?
stop_new
( while sleep 0.5; do stop_new; done ) & watcher=$!
"$@"
