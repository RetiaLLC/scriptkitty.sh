#!/usr/bin/env python3
"""Deep-probe experiments over the ESP32-S3 ROM loader (no flash/eFuse writes).

  1. I2C scan, bit-banged open-drain through GPIO registers
  2. SX126x / SX127x radio ID, bit-banged SPI at weakest drive strength
  3. raw eFuse block dump (for later diff against a Bluetooth Nugget)
  4. flash forensics: partition table, app image, identifying strings

RESEARCH TOOL — not used by the site or CI. Run scripts/pin_fingerprint.py first:
steps 1-2 DRIVE pins (open-drain for I2C, weakest push-pull for SPI), so only point
them at pins the passive fingerprint says are a bus. Board must be in download mode.

    deep_probe.py PORT SDA SCL CS SCK MOSI MISO BUSY APP_DUMP_OUT
    # Nibble Zero / Connect:
    deep_probe.py /dev/cu.usbmodem1101 8 7 10 12 11 13 5 /tmp/app.bin
"""
import json, re, struct, sys, time
from esptool.cmds import detect_chip

G = 0x60004000
OUT_W1TS, OUT_W1TC = G + 0x08, G + 0x0C
EN_W1TS, EN_W1TC = G + 0x24, G + 0x28
IN0, IN1 = G + 0x3C, G + 0x40
FUNC_OUT_SEL = lambda n: G + 0x554 + 4 * n
IOMUX = lambda n: 0x60009004 + 4 * n
FUN_PD, FUN_PU, FUN_IE, MCU_GPIO = 1 << 7, 1 << 8, 1 << 9, 1 << 12

port = sys.argv[1]
SDA, SCL = int(sys.argv[2]), int(sys.argv[3])
CS, SCK, MOSI, MISO, BUSY = (int(x) for x in sys.argv[4:9])

esp = detect_chip(port)
ops = [0]
def rd(a): ops[0] += 1; return esp.read_reg(a)
def wr(a, v): ops[0] += 1; esp.write_reg(a, v)
def pin_in(n): return (rd(IN0 if n < 32 else IN1) >> (n % 32)) & 1

out = {"chip": esp.get_chip_description(), "mac": ":".join(f"{b:02x}" for b in esp.read_mac())}
saved = {}
def claim(n, pulls=0):
    saved.setdefault(IOMUX(n), rd(IOMUX(n)))
    saved.setdefault(FUNC_OUT_SEL(n), rd(FUNC_OUT_SEL(n)))
    wr(EN_W1TC, 1 << n)
    wr(FUNC_OUT_SEL(n), 0x100)             # plain GPIO output signal
    wr(IOMUX(n), MCU_GPIO | FUN_IE | pulls)  # FUN_DRV=0 -> weakest (~5 mA) drive

# ---------------------------------------------------------------- 1. I2C scan
t0 = time.time(); o0 = ops[0]
for p in (SDA, SCL):
    claim(p)
    wr(OUT_W1TC, 1 << p)                   # output latch low; "drive" = enable, "release" = disable
lo = lambda p: wr(EN_W1TS, 1 << p)
hi = lambda p: wr(EN_W1TC, 1 << p)
def start(): hi(SDA); hi(SCL); lo(SDA); lo(SCL)
def stop(): lo(SDA); hi(SCL); hi(SDA)
def wbyte(b):
    for i in range(7, -1, -1):
        (hi if (b >> i) & 1 else lo)(SDA); hi(SCL); lo(SCL)
    hi(SDA); hi(SCL); ack = pin_in(SDA) == 0; lo(SCL)
    return ack
def rbyte(ack):
    hi(SDA); v = 0
    for _ in range(8):
        hi(SCL); v = (v << 1) | pin_in(SDA); lo(SCL)
    (lo if ack else hi)(SDA); hi(SCL); lo(SCL); hi(SDA)
    return v
idle = (pin_in(SDA), pin_in(SCL))
found = []
for addr in range(0x08, 0x78):
    start(); ok = wbyte(addr << 1); stop()
    if ok: found.append(addr)
status = {}
for addr in found:
    start()
    if wbyte((addr << 1) | 1): status[hex(addr)] = hex(rbyte(False))
    stop()
out["i2c"] = {"pins": f"SDA{SDA}/SCL{SCL}", "idle_levels": idle, "acks": [hex(a) for a in found],
              "status_byte": status, "ops": ops[0] - o0, "seconds": round(time.time() - t0, 2)}
hi(SDA); hi(SCL)

# ---------------------------------------------------------------- 2. radio over SPI
t0 = time.time(); o0 = ops[0]
radio = {}
for p in (CS, SCK, MOSI): claim(p)
claim(MISO); claim(BUSY)
wr(OUT_W1TS, 1 << CS); wr(OUT_W1TC, (1 << SCK) | (1 << MOSI))
wr(EN_W1TS, (1 << CS) | (1 << SCK) | (1 << MOSI))
def follow(n):
    wr(IOMUX(n), MCU_GPIO | FUN_IE | FUN_PD); d = pin_in(n)
    wr(IOMUX(n), MCU_GPIO | FUN_IE | FUN_PU); u = pin_in(n)
    wr(IOMUX(n), MCU_GPIO | FUN_IE)
    return {(0, 1): "float", (1, 1): "HIGH", (0, 0): "LOW", (1, 0): "noise"}[(d, u)]
radio["miso_cs_high"] = follow(MISO)
wr(OUT_W1TC, 1 << CS); time.sleep(0.01)
radio["miso_cs_low"] = follow(MISO)       # a real SPI slave drives MISO only while selected
radio["busy"] = pin_in(BUSY)
def xfer(byte):
    v = 0
    for i in range(7, -1, -1):
        wr(OUT_W1TS if (byte >> i) & 1 else OUT_W1TC, 1 << MOSI)
        wr(OUT_W1TS, 1 << SCK); v = (v << 1) | pin_in(MISO); wr(OUT_W1TC, 1 << SCK)
    return v
def cmd(bytes_):
    wr(OUT_W1TC, 1 << CS); r = [xfer(b) for b in bytes_]; wr(OUT_W1TS, 1 << CS); return r
wr(OUT_W1TS, 1 << CS)
r = cmd([0xC0, 0x00]); radio["sx126x_GetStatus"] = [hex(x) for x in r]
r = cmd([0x1D, 0x03, 0x20, 0x00] + [0x00] * 16)
radio["sx126x_reg_0x0320"] = bytes(r[4:]).decode("ascii", "replace")
r = cmd([0x42, 0x00]); radio["sx127x_RegVersion(0x42)"] = hex(r[1])
radio["ops"] = ops[0] - o0; radio["seconds"] = round(time.time() - t0, 2)
wr(EN_W1TC, (1 << CS) | (1 << SCK) | (1 << MOSI))
out["radio"] = radio

for a, v in saved.items(): wr(a, v)

# ---------------------------------------------------------------- 3. eFuse blocks
EF = 0x60007000
out["efuse_raw"] = {hex(off): f"{rd(EF + off):08x}" for off in range(0x2C, 0x180, 4)}

# ---------------------------------------------------------------- 4. flash forensics
stub = esp.run_stub()
t0 = time.time()
pt = stub.read_flash(0x8000, 0xC00)
parts = []
for i in range(0, 0xC00, 32):
    e = pt[i:i + 32]
    if e[:2] != b"\xaa\x50": break
    typ, sub, addr, size = struct.unpack("<BBII", e[2:12])
    parts.append({"label": e[12:28].split(b"\0")[0].decode(), "type": typ, "sub": hex(sub), "addr": hex(addr), "size": hex(size)})
out["partitions"] = parts
app = next((int(p["addr"], 16) for p in parts if p["type"] == 0), 0x10000)
hdr = stub.read_flash(app, 0x18)
nseg = hdr[1]; off = app + 0x18; end = off
for _ in range(nseg):
    la, ln = struct.unpack("<II", stub.read_flash(off, 8)); off += 8 + ln; end = off
size = end - app
img = stub.read_flash(app, size)
out["app"] = {"offset": hex(app), "bytes": size, "read_seconds": round(time.time() - t0, 2)}
strs = set(m.group().decode() for m in re.finditer(rb"[\x20-\x7e]{5,80}", img))
pat = re.compile(r"nibble|nugget|retia|lolin|waveshare|s3.?zero|s3.?mini|meshtastic|meshcore|circuitpython|wled|marauder|rnode|reticulum|pio_env|firmware.version|\bv?\d+\.\d+\.\d+[.\w-]*\b.*(mesh|core)", re.I)
hits = sorted(s for s in strs if pat.search(s))
out["marker_strings"] = hits[:60]
out["marker_count"] = len(hits)
open(sys.argv[9], "wb").write(img)

print(json.dumps(out, indent=1))
try: stub.hard_reset()
except Exception: pass
