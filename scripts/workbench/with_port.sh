#!/bin/bash
# with_port.sh DEV CMD... — run CMD with exclusive use of serial device DEV on a workbench
# Pi: SIGSTOPs every process holding DEV open (the slot's RFC2217 proxy), runs CMD, then
# SIGCONTs them again — even if CMD fails. The portal keeps the slot; it just goes quiet.
set -u
dev=$1; shift
holders=$(sudo fuser "$dev" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | grep -v "^$$\$" || true)
resume() { for p in $holders; do sudo kill -CONT "$p" 2>/dev/null; done; }
trap resume EXIT
for p in $holders; do sudo kill -STOP "$p"; done
sleep 0.2
"$@"
