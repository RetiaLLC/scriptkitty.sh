#!/usr/bin/env python3
"""Hardware bridge for scripts/test_boardprobe.mjs — lets Node drive web/boardprobe.js
against a real board, since Node has no Web Serial. Line-oriented over stdin/stdout.

  probe_bridge.py serial PORT        raw duplex at 115200, DTR high / RTS low
        -> "READY", then "D <base64>" per read;   <- "W <base64>" to write, "Q" to quit
  probe_bridge.py esptool PORT [--stub] [--no-reset] [--before MODE]
        ROM loader (or flasher stub) register access. --no-reset leaves the board in the
        loader on quit (a board whose app firmware has no usable USB must NOT be rebooted);
        --before is esptool's connect mode (default_reset | no_reset | usb_reset).
        -> {"ready":..} then one JSON reply per request
        <- {"op":"r","a":addr} | {"op":"w","a":addr,"v":val} | {"op":"f","a":addr,"n":len}
           | {"op":"q"}     (f = read_flash, needs --stub, replies base64; q hard-resets)

RESEARCH/TEST TOOL — not used by the site or CI.
"""
import base64
import json
import sys
import threading


def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()


def serial_mode(port):
    import serial
    p = serial.Serial()
    p.port, p.baudrate, p.timeout = port, 115200, 0.01
    p.dtr, p.rts = True, False
    p.open()
    alive = True

    def pump():
        while alive:
            try:
                data = p.read(4096)
            except Exception:
                break
            if data:
                out("D " + base64.b64encode(data).decode())

    threading.Thread(target=pump, daemon=True).start()
    out("READY")
    for line in sys.stdin:
        line = line.strip()
        if line.startswith("W "):
            p.write(base64.b64decode(line[2:]))
            p.flush()
        elif line == "Q":
            break
    alive = False
    p.close()


def esptool_mode(port, stub, reset=True, before="default_reset"):
    import contextlib
    with contextlib.redirect_stdout(sys.stderr):       # keep esptool's chatter off the RPC pipe
        from esptool.cmds import detect_chip
        esp = detect_chip(port, connect_mode=before)
        chip = esp.get_chip_description()
        mac = ":".join(f"{b:02x}" for b in esp.read_mac())
        flash_id = None
        if stub:
            esp = esp.run_stub()
            flash_id = esp.flash_id()
    out(json.dumps({"ready": True, "chip": chip, "mac": mac, "stub": stub, "flash_id": flash_id}))
    for line in sys.stdin:
        req = json.loads(line)
        if req["op"] == "r":
            out(json.dumps({"v": esp.read_reg(req["a"])}))
        elif req["op"] == "w":
            esp.write_reg(req["a"], req["v"])
            out(json.dumps({"ok": True}))
        elif req["op"] == "f":
            with contextlib.redirect_stdout(sys.stderr):
                data = esp.read_flash(req["a"], req["n"])
            out(json.dumps({"d": base64.b64encode(data).decode()}))
        elif req["op"] == "q":
            break
    with contextlib.redirect_stdout(sys.stderr):
        if reset:
            try:
                esp.hard_reset()
            except Exception:
                pass
    out(json.dumps({"bye": True, "reset": reset}))


if __name__ == "__main__":
    mode, port = sys.argv[1], sys.argv[2]
    if mode == "serial":
        serial_mode(port)
    else:
        args = sys.argv[3:]
        before = args[args.index("--before") + 1] if "--before" in args else "default_reset"
        esptool_mode(port, "--stub" in args, reset="--no-reset" not in args, before=before)
