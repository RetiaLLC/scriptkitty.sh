# Flasher — root cause, edge cases, and what's validated

## The bug we hit (and fixed)

Flashing failed **deterministically** mid-write (e.g. `Failed to write compressed
data to flash after seq 27 failed with status 201,0`, or `serial data stream
stopped`) at the **same point regardless of baud rate**, while the desktop
`esptool.py` flashed the same image fine.

**Root cause:** esptool-js **0.6.0** changed `writeFlash`'s `fileArray[].data` to
require a **`Uint8Array`**. Our flasher passed a **binary string** (via the
pre-0.6.0 `ui8ToBstr(...)` helper), which 0.6.0 mis-encodes — corrupting a
deterministic block and aborting (esptool-js has no per-block retry). This is
[esptool-js issue #233](https://github.com/espressif/esptool-js/issues/233)
(works in 0.5.7, broke in 0.6.0 via PR #228); it bites hardest on ARM64/macOS.

**Fix:** pass `new Uint8Array(await resp.arrayBuffer())` to `writeFlash`. One line.

**How we proved it (on real hardware, headless):** we ran the *actual* esptool-js
0.6.0 library against the WiFi Nugget in node (a Web Serial shim over
node-serialport). A/B result:

| Encoding | Result on the board |
|---|---|
| binary string (`ui8ToBstr`) | **FAILS** mid-write (reproduces the bug) |
| `Uint8Array` | **SUCCESS** — 100% written, verified |

Baud was never the cause. The earlier "high-baud corruption" and "erase-first"
theories were wrong.

## Speed (secondary)

Web Serial high-baud reliability *is* adapter-dependent (CH340 is flaky above
115200), so **Auto** speed picks by chip:

- **ESP8266** (D1 Mini / WiFi Nugget / Pusheen — CH340): **115200**
- **native-USB ESP32-S2/S3** (USB Nugget, Bluetooth Nugget, Nibble): **460800**

Manual override is under Advanced. `serialOptions.bufferSize: 8192` gives high-baud
read headroom.

## Edge-case matrix

| # | Situation | Handling | Status |
|---|---|---|---|
| 1 | Unsupported browser (Firefox/Safari/mobile) | `serial` check → banner; Flash buttons disabled ("Chrome or Edge required") | ✅ |
| 2 | User cancels the port picker | overlay closes silently, no scary error | ✅ |
| 3 | Board/driver not showing in picker | Advanced → Help: CH340/CP2102 driver links + "use a data cable" | ✅ guidance |
| 4 | Port busy (other tab / Arduino IDE) | mapped error "The board is busy… close other tabs" + classic fallback | ✅ |
| 5 | Native-USB board not in download mode | up-front hint on connect for S2/S3; mapped error → BOOT/RESET steps | ✅ |
| 6 | Wrong firmware for the chip | chip-family check → "Wrong firmware for this board" | ✅ |
| 7 | esptool-js Uint8Array bug (#233) | pass Uint8Array — **fixed, hardware-proven** | ✅ fixed |
| 8 | Board unplugged mid-flash | mapped error "connection dropped" → Retry / classic | ✅ |
| 9 | CH340 corruption above 115200 | Auto caps ESP8266 at 115200; classic fallback; manual override | ✅ mitigated |
| 10 | Large 4 MB image, slow at 115200 | live "Writing N%" + "keep this tab open"; compression shrinks wire bytes | ✅ |
| 11 | Detect → Flash (avoid 2nd port prompt) | granted port reused on success, dropped on failure | ✅ |
| 12 | Flash → Serial Monitor port handoff | port released after flash; monitor requests a fresh one | ✅ |
| 13 | Primary flasher misbehaves | ESP Web Tools "classic flasher" button in the error panel (fresh port, 115200) | ✅ |
| 14 | Ambiguous auto-detect (same silicon) | narrow to chip family, ask user to confirm the exact model | ✅ |
| 15 | esptool-js bundle fails to load | caught → error + classic offered | ✅ |
| 16 | Closing the dialog mid-flash | no Close button during the writing state (only after) | ✅ |
| 17 | Background-tab throttling | "keep this tab open" guidance shown during write | ✅ guidance |

## What's hardware-validated vs. still needs a browser pass

**Validated on the physical WiFi Nugget (ESP8266):** the Uint8Array fix (A/B), and
every ESP8266 catalog bin flashes + verifies; MicroPython boots to its REPL.

**Still needs a real browser + board (can't be automated headlessly — Web Serial
needs a user gesture):**
- The full browser click-through on the WiFi Nugget (should now succeed at 115200).
- **USB Nugget (S2)** and **Bluetooth Nugget / Nibble (S3)** — native-USB download-mode
  entry + flashing at the 460800 Auto rate.
- The Serial Monitor talking to a live board, and Detect → Flash on one gesture.
