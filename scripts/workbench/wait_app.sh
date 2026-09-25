#!/bin/bash
# wait_app.sh MAC_PLAIN [secs] — wait for the TinyUSB app device; print how long it took or STUCK.
MP=$1; N=$(( ${2:-8} * 4 ))
for i in $(seq 1 $N); do sleep 0.25; p=$(readlink -f /dev/serial/by-id/*FH4R2*"$MP"* 2>/dev/null); [ -n "$p" ] && [ -e "$p" ] && { echo "app back at $p in $(python3 -c "print($i/4)")s"; exit 0; }; done
echo "STUCK in ROM after ${2:-8}s"; exit 1
