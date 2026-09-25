#!/bin/bash
# touch_to_rom.sh MAC_COLON MAC_PLAIN — if the board is running a TinyUSB app, 1200-baud-touch it
# into the ROM loader; wait for the JTAG unit and the portal's proxy; print the ROM devnode or NONE.
set -u
MC=$1; MP=$2
byid() { local p; p=$(readlink -f /dev/serial/by-id/*"$1"* 2>/dev/null); [ -n "$p" ] && [ -e "$p" ] && echo "$p"; }
app=$(byid "$MP"); rom=$(byid "JTAG_serial_debug_unit_$MC")
if [ -n "$app" ]; then
  ~/sk/with_port.sh "$app" python3 - "$app" <<'PY'
import serial, sys, time
try:
    p = serial.Serial(sys.argv[1], 1200); p.dtr = False; p.rts = False; time.sleep(0.3); p.close()
except Exception:
    pass
PY
  for i in $(seq 1 20); do sleep 0.5; rom=$(byid "JTAG_serial_debug_unit_$MC"); [ -n "$rom" ] && break; done
fi
[ -n "$rom" ] && sleep 4
echo "${rom:-NONE}"
