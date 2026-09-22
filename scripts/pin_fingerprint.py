#!/usr/bin/env python3
"""Bench instrument: electrically fingerprint an ESP32-S3 board over the ROM loader.

RESEARCH TOOL — not used by the site or CI. It performs, from Python, exactly the
operations scriptkitty's "Detect my board" could perform in the browser with
esptool-js `readReg` / `writeReg`, so the predicted signatures below can be
verified on real hardware before any of this goes into web/app.js.

Why: the Bluetooth Nugget (LOLIN S3 Mini) and the Nibble (Waveshare S3-Zero) are
the same silicon (ESP32-S3FH4R2, 4 MB) and look identical to esptool. But their
carrier PCBs hang different resistors/parts on different GPIOs, and the ROM
loader's READ_REG/WRITE_REG let us see that without running any firmware.

Method ("pull-follow test"), per pin, entirely passive — only the chip's internal
~45 k pulls are switched, no pin is ever driven:
    1. input-enable the pad, internal pull-DOWN on  -> sample
    2. internal pull-UP on                          -> sample
    3. restore the pad's IO_MUX register
  (down, up) = (0,1) floating   -> nothing attached
             = (1,1) held HIGH  -> external pull-up (or driven high)
             = (0,0) held LOW   -> driven low / external pull-down
             = (1,0) noise      -> re-run

Predicted signatures (from the KiCad netlists):
  Bluetooth Nugget  nugget_v3 3.14 : 35,36 HIGH (4.7k I2C)  12,13,18 HIGH (10k buttons)
  Nibble OG / Zero  nibble_v1      : 4,9 HIGH (10k RST/CS)  5 held (RFM95 DIO0)
  Nibble Connect(+Screen) v2       : 6,10 HIGH (10k RST/CS) 7,8 HIGH (10k I2C)
                                     5 held (SX1262 BUSY)

Usage (board in download mode, or let esptool auto-reset it):
    python3 scripts/pin_fingerprint.py /dev/cu.usbmodem1101
    python3 scripts/pin_fingerprint.py rfc2217://100.83.202.100:4001 --json
"""
import argparse
import json
import sys

try:
    from esptool.cmds import detect_chip
except ImportError:  # pragma: no cover
    sys.exit("esptool not installed: pip install esptool")

GPIO_BASE = 0x60004000
GPIO_ENABLE_W1TC = GPIO_BASE + 0x28   # GPIO0-31 output-enable clear
GPIO_ENABLE1_W1TC = GPIO_BASE + 0x34  # GPIO32-48
GPIO_IN = GPIO_BASE + 0x3C            # GPIO0-31
GPIO_IN1 = GPIO_BASE + 0x40           # GPIO32-48
IO_MUX_BASE = 0x60009000

FUN_PD, FUN_PU, FUN_IE = 1 << 7, 1 << 8, 1 << 9
MCU_SEL_GPIO = 1 << 12                # MCU_SEL (bits 14:12) = 1 -> plain GPIO

# Never touched: 0/3/45/46 straps, 19/20 USB D-/D+, 26-32 in-package flash+PSRAM,
# 43/44 UART0 (the ROM drives TX).
SAFE_PINS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21,
             33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 47, 48]

LABEL = {(0, 1): "float", (1, 1): "HIGH", (0, 0): "LOW", (1, 0): "noise"}


def iomux(pin):
    return IO_MUX_BASE + 0x04 + 4 * pin


def sample(esp, pin):
    if pin < 32:
        return (esp.read_reg(GPIO_IN) >> pin) & 1
    return (esp.read_reg(GPIO_IN1) >> (pin - 32)) & 1


def probe(esp, pin):
    reg = iomux(pin)
    saved = esp.read_reg(reg)
    try:
        if pin < 32:
            esp.write_reg(GPIO_ENABLE_W1TC, 1 << pin)
        else:
            esp.write_reg(GPIO_ENABLE1_W1TC, 1 << (pin - 32))
        esp.write_reg(reg, MCU_SEL_GPIO | FUN_IE | FUN_PD)
        down = sample(esp, pin)
        esp.write_reg(reg, MCU_SEL_GPIO | FUN_IE | FUN_PU)
        up = sample(esp, pin)
    finally:
        esp.write_reg(reg, saved)
    return LABEL[(down, up)]


def verdict(fp):
    high = lambda *pins: all(fp.get(p) == "HIGH" for p in pins)
    held = lambda p: fp.get(p) in ("HIGH", "LOW")
    nugget = high(35, 36)
    nugget_btns = sum(fp.get(p) == "HIGH" for p in (12, 13, 18))
    nibble_og = high(4, 9) and held(5)
    # Zero / Connect / Screen Connect share the 7/8 I2C + 6/10 radio pin map; a Zero
    # without a radio fitted still shows the 7/8 pull-ups.
    nibble_connect = (high(6, 10) and held(5)) or high(7, 8)
    if nugget and not nibble_connect:
        lora = " + LoRa add-on" if high(4, 9) else ""
        return f"bluetooth-nugget{lora}  (I2C pull-ups on 35/36, {nugget_btns}/3 button pull-ups)"
    if not nugget and nibble_connect:
        return "nibble  (Zero / Connect / Screen Connect: pull-ups on 6/10 and/or 7/8)"
    if not nugget and nibble_og:
        return "nibble  (OG / Zero: pull-ups on 4/9, RFM95 DIO0 holds 5)"
    return "AMBIGUOUS — no known signature; site should fall back to opening both families"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("port")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--no-flash", action="store_true", help="skip the stub + flash reads")
    ap.add_argument("--no-reset", action="store_true",
                    help="leave the board in the ROM loader (use when its app firmware has no usable USB)")
    args = ap.parse_args()

    esp = detect_chip(args.port)
    chip = esp.get_chip_description()
    if "ESP32-S3" not in chip.upper():
        sys.exit(f"{chip}: this probe only knows the ESP32-S3 register map")
    mac = ":".join(f"{b:02x}" for b in esp.read_mac())

    fp = {pin: probe(esp, pin) for pin in SAFE_PINS}

    elf_sha = None
    if not args.no_flash:
        # Second, independent signal: which firmware is on the board right now.
        # esptool patches the app's ELF SHA-256 into esp_app_desc_t at app+0xB0;
        # it's unique per build, unlike the project/version strings.
        try:
            stub = esp.run_stub()
            desc = stub.read_flash(0x10020, 0xB0)
            if desc[:4] == b"\x32\x54\xcd\xab":
                elf_sha = desc[0x90:0xB0].hex()
        except Exception as e:  # blank flash, odd partition layout, etc.
            elf_sha = f"unreadable ({e})"

    result = {"chip": chip, "mac": mac, "fingerprint": fp,
              "app_elf_sha256": elf_sha, "verdict": verdict(fp)}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\n{chip}   MAC {mac}")
        print(f"app ELF sha256 @0x100B0: {elf_sha}")
        interesting = {p: s for p, s in fp.items() if s != "float"}
        print("non-floating pins:", ", ".join(f"GPIO{p}={s}" for p, s in interesting.items()) or "none")
        print("floating pins:    ", ", ".join(str(p) for p, s in fp.items() if s == "float"))
        print(f"\nverdict: {result['verdict']}")

    if not args.no_reset:
        try:
            esp.hard_reset()
        except Exception:
            pass


if __name__ == "__main__":
    main()
