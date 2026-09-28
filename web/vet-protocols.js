// vet-protocols.js — "Diagnose my cat": per-board exam protocols for vetprobe.js.
//
// Everything a protocol asserts is something the ROM loader can observe on a bare board
// with no firmware: what each GPIO rests at with only the chip's internal pulls (external
// pull-ups, parts driving the pin, nothing at all), which module pins sit next to each
// other (solder bridges), which radio should answer over SPI, which I2C bus should carry
// pull-ups. Expectations are written against the board's KiCad netlist and, where we have
// them, against measured units — every line says which.
//
// Pin expectation vocabulary: "HIGH" external pull-up / driven high · "LOW" driven low ·
// "float" nothing attached · "held" driven either way (state-dependent outputs) ·
// "rom" a level the ESP32-S3 ROM itself imposes in download mode (JTAG pins), not the board.

// ESP32-S3-WROOM-1 castellations in physical order (from the netlist's U7 pin numbers),
// strap/USB/UART/power pins included so adjacency is right, then filtered at run time.
export const WROOM1_PIN_ORDER = ["GND", "3V3", "EN", 4, 5, 6, 7, 15, 16, 17, 18, 8, 19, 20, 3, 46, 9, 10, 11, 12, 13, 14, 21, 47, 48, 45, 0, 35, 36, 37, 38, 39, 40, 41, 42, 44, 43, 2, 1, "GND"];

// Waveshare ESP32-S3-Zero castellations (footprint waveshare_esp32_s3_smt&tht in the Retia
// library, identical on the OG, Connect and Screen Connect PCBs; the Zero uses the "full"
// footprint that adds a row of bottom pads 17 18 38 39 40 41 42 45 under the module). Two rows
// of nine with the USB end between them — a non-numeric entry breaks adjacency.
export const S3_ZERO_PIN_ORDER = [43, 44, 13, 12, 11, 10, 9, 8, 7, "USB", 6, 5, 4, 3, 2, 1, "3V3", "GND", "5V"];
export const S3_ZERO_BOTTOM_ROW = [17, 18, 38, 39, 40, 41, 42, 45];
const S3_ZERO_MODULE = { name: "Waveshare ESP32-S3-Zero (ESP32-S3FH4R2)", flashMb: 4, psram: "2MB quad", pinOrder: S3_ZERO_PIN_ORDER };
// pins every S3-Zero carrier shares: bottom pads nobody routes, pins the module never bonds
// out (a Bluetooth Nugget pulls 35/36 up — so a HIGH there means "wrong board"), JTAG pins.
const s3ZeroCommon = ({ bottomUsed = [] } = {}) => [
  { gpio: 21, expect: "any", name: "S3-Zero onboard WS2812 data (module-internal; reads high on every module measured)" },
  ...[14, 15, 16, 17, 18, 41, 42].filter((g) => !bottomUsed.includes(g)).map((g) => ({ gpio: g, expect: "float", name: "S3-Zero bottom pad (unused on this board)" })),
  ...[33, 34, 35, 36, 37, 47, 48].map((g) => ({ gpio: g, expect: "float", name: "not bonded out on the S3-Zero",
      onHIGH: { status: "warn", hint: "An S3-Zero can't load this pin. A Bluetooth Nugget pulls GPIO35/36 up — is the right protocol selected?" },
      onLOW: { status: "warn", hint: "An S3-Zero can't load this pin — re-run; if it persists the module isn't an S3-Zero." } })),
  ...[38, 39, 40].map((g) => ({ gpio: g, expect: "rom", name: "S3-Zero bottom pad — JTAG pin in ROM mode" })),
];
const wioSx1262Pins = ({ nrstPull, nssPull }) => [
  { gpio: 6, expect: "HIGH", name: `Wio-SX1262 NRST (${nrstPull})`, part: "radio", refs: ["U3"],
    onFLOAT: { status: "fail", hint: `${nrstPull} missing/open, or Wio pin 5 / the S3-Zero pad isn't soldered.` },
    onLOW: { status: "fail", hint: "Held low — the radio sits in reset. Bridge to GND, or to GPIO5 (BUSY) right next to it on the module." } },
  { gpio: 10, expect: "HIGH", name: `Wio-SX1262 NSS (${nssPull})`, part: "radio", refs: ["U3"],
    onFLOAT: { status: "fail", hint: `${nssPull} missing/open.` },
    onLOW: { status: "fail", hint: "Held low — radio permanently selected. Bridge to GND or to a neighbour (GPIO9 / GPIO11 on the module edge)." } },
  { gpio: 5, expect: "LOW", name: "Wio-SX1262 BUSY (module output)", part: "radio", refs: ["U3"],
    onFLOAT: { status: "warn", hint: "Nothing drives BUSY — Wio-SX1262 not fitted, unpowered, or its pin 11 open." },
    onHIGH: { status: "warn", hint: "BUSY stuck high — module held in reset or unpowered; see the radio check." } },
  { gpio: 4, expect: "held", name: "Wio-SX1262 DIO1 (IRQ output)", part: "radio", refs: ["U3"],
    onFLOAT: { status: "warn", hint: "DIO1 floats — Wio pin 12 open?" } },
  { gpio: 11, expect: "float", name: "SPI MOSI (→ Wio pin 3)", part: "radio", refs: ["U3"] },
];

export const PROTOCOLS = {
  // Newsheen / Pusheen puck — esp32_base_puck_v2 (RetiaLLC/pusheen_hardware,
  // 130mm_Pusheen/esp32_base_puck_v2). Netlist exported 2026-09-26.
  newsheen: {
    name: "Newsheen puck (esp32_base_puck_v2)",
    line: "newsheen",
    mcu: "esp32-s3",
    module: { name: "ESP32-S3-WROOM-1-N16R2", flashMb: 16, psram: "2MB quad", pinOrder: WROOM1_PIN_ORDER, refs: ["U7"] },
    layout: "newsheen",                                                  // board model in vet-layouts.js
    pins: [
      { gpio: 16, expect: "float", refs: ["U5", "R21"], name: "NeoPixel data (→ U5 level shifter)",
        onLOW:  { status: "fail", hint: "Known BUG #1: U5's DIR pin is strapped to GND by R21, so the shifter drives this pin instead of listening — the 8 LEDs will never light. Fix per unit: solder-bridge U5 pin 5 (DIR) to pin 6 (VCCB), back side, SOT-23-6." },
        onHIGH: { status: "warn", hint: "Held high — check for a bridge to 3V3 near U5/R21." } },
      { gpio: 4, expect: "HIGH", refs: ["U4"], name: "IR receiver OUT (U4)", part: "ir",
        // measured on every unit with a receiver so far: the VS1838-type parts these boards
        // ship with have an open-collector OUT with no internal pull-up, so at rest they
        // float exactly like an empty footprint. Float is therefore no finding at all — only
        // the remote test (irListen) proves a receiver. A receiver whose supply pad is at GND
        // (BUG #2) clamps OUT low through its protection diode, which the rest level does show.
        onFLOAT: { status: "info", detail: "idles open (no internal pull-up) — the open-collector receiver these boards use rests exactly like an empty footprint",
                   hint: "Rest level can't tell a fitted receiver from a missing one; the IR remote test can — hold any remote at the board when the vet asks." },
        onLOW:   { status: "fail", hint: "Output clamped low — BUG #2 (a VCC-middle receiver in this GND-middle footprint puts its supply on the GND pad and its protection diode pins OUT low), a receiver fitted backwards, or OUT shorted to GND at U4." },
        passNote: "a receiver with an internal pull-up, powered — this also proves the +5V rail is up" },
      { gpio: 17, expect: "HIGH", refs: ["SW3", "R3"], name: "User button SW3 (10K R3)",
        onFLOAT: { status: "fail", hint: "10K pull-up R3 missing or open." },
        onLOW:   { status: "fail", hint: "Button stuck or SW3/C11 shorted to GND." } },
      { gpio: 35, expect: "HIGH", refs: ["J3", "R18"], name: "I2C SDA (5.1K R18, J3 header)",
        onFLOAT: { status: "fail", hint: "Pull-up R18 missing — or an N16R8 (octal PSRAM) module is fitted and owns GPIO33-37." },
        onLOW:   { status: "fail", hint: "SDA shorted to GND (R18 / J3)." } },
      { gpio: 36, expect: "HIGH", refs: ["J3", "R19"], name: "I2C SCL (5.1K R19, J3 header)",
        onFLOAT: { status: "fail", hint: "Pull-up R19 missing — or an N16R8 (octal PSRAM) module is fitted and owns GPIO33-37." },
        onLOW:   { status: "fail", hint: "SCL shorted to GND (R19 / J3)." } },
      { gpio: 9,  expect: "HIGH", refs: ["U6", "R23"], name: "LoRa NRST (10K R23)",
        onFLOAT: { status: "fail", hint: "R23 missing/open — the radio never leaves reset cleanly." },
        onLOW:   { status: "fail", hint: "NRST held low — short at R23/U6 pin 5." } },
      { gpio: 10, expect: "HIGH", refs: ["U6", "R22"], name: "LoRa NSS (10K R22)",
        onFLOAT: { status: "fail", hint: "R22 missing/open — the radio is selected at random." },
        onLOW:   { status: "fail", hint: "NSS held low — short at R22/U6 pin 6." } },
      { gpio: 47, expect: "LOW", refs: ["U6"], name: "LoRa BUSY (U6 output)", part: "radio",
        onFLOAT: { status: "warn", hint: "Nothing drives BUSY — Wio-SX1262 not soldered, or its 3V3/GND pins open." },
        onHIGH:  { status: "warn", hint: "BUSY stuck high — module held in reset or unpowered; see the radio check." } },
      { gpio: 21, expect: "held", refs: ["U6"], name: "LoRa DIO1 (U6 IRQ output)", part: "radio",
        onFLOAT: { status: "warn", hint: "DIO1 floats — U6 pin 12 open?" } },
      { gpio: 11, expect: "float", refs: ["U6"], name: "LoRa MOSI" }, { gpio: 12, expect: "float", refs: ["U6"], name: "LoRa MISO (idle, NSS high)" },
      { gpio: 13, expect: "float", refs: ["U6"], name: "LoRa SCK" },  { gpio: 14, expect: "float", refs: ["U6"], name: "LoRa RF switch" },
      { gpio: 37, expect: "float", refs: ["J3"], name: "I2S WS (J3 pin 5)" },
      { gpio: 38, expect: "rom", refs: ["J3"], name: "I2S SCK (J3 pin 3) — JTAG pin in ROM mode" },
      { gpio: 39, expect: "rom", refs: ["J3"], name: "I2S SD (J3 pin 4) — JTAG pin in ROM mode" },
      { gpio: 40, expect: "rom", name: "unused — JTAG pin in ROM mode" },
      { gpio: 15, expect: "float", name: "buzzer stub (nothing fitted)" },
      { gpio: 1,  expect: "float", refs: ["TP4"], name: "BATT_VOLT test point TP4",
        onHIGH: { status: "fail", hint: "Something is driving TP4 — a battery wired straight to GPIO1 with no divider will destroy the pin (4.2 V on a 3.3 V input). Use 100K/100K." } },
      { gpio: 2,  expect: "float", refs: ["TP5"], name: "CHG_CNTRL test point TP5" },
      { gpio: 48, expect: "any", refs: ["D14", "R14"], name: "debug LED D14 (330R R14)" },
      ...[5, 6, 7, 8, 18, 41, 42].map((g) => ({ gpio: g, expect: "float", name: "unconnected module pin" })),
    ],
    // pins the bridge test may drive at the weakest strength (never radio outputs 21/47,
    // never the IR open-collector's neighbours' partner… it's fine: 4 is open-collector)
    driveSafe: [4, 5, 6, 7, 8, 15, 16, 17, 18, 9, 10, 11, 12, 13, 14, 48, 35, 36, 37, 38, 39, 40, 41, 42, 1, 2],
    // Wio-SX1262: TCXO on DIO3 (1.8 V), DIO2 drives the T/R switch, RF_SW (GPIO14) powers it;
    // ANT1 is a bare pad for a quarter-wave wire.
    radio: { type: "sx126x", nss: 10, mosi: 11, miso: 12, sck: 13, busy: 47, nrst: 9, dio1: 21, rfsw: 14, tcxoV: 1.8, dio2Switch: true, part: "Wio-SX1262 (U6)", antPad: "ANT1 (wire antenna pad)", refs: ["U6"], antRefs: ["ANT1"],
      // measured on the same unit in the same room, 2026-09-26: wire antenna on → 739 MHz
      // at -87…-91 dBm, 11-15 dB above the floor; wire off → flat -103…-107 dBm, 4 dB spread
      antennaCalibration: { withMax: -91, withLift: 11, withoutFloor: -107, withoutLift: 4 } },
    i2c: [{ sda: 35, scl: 36, name: "sensor header J3", expectDevices: [], refs: ["J3"] }],
    beacon: { gpio: 48, name: "debug LED D14", refs: ["D14"] },
    // interactive: point a remote at the board — the receiver pulls OUT low in 38 kHz bursts
    ir: { gpio: 4, part: "ir", name: "IR receiver (U4)", refs: ["U4"] },
    // parts a unit may legitimately ship without — the user declares them; declared-absent
    // parts are checked for being genuinely absent (their pins float) and reported as info
    optionalParts: { radio: "LoRa module (Wio-SX1262)", ir: "IR receiver", amp: "I2S amplifier (MAX98357A)", mic: "I2S microphone (SPH0645)" },
    defaultAbsent: ["amp", "mic"],                                          // most pucks ship without either
    // what proves the parts a pull test can't see
    liveTests: { amp: "Tick \"Amp tone test\": the vet plays a 1 kHz tone through the amplifier and asks whether you heard it. With Newsheen Radio running, its own \"make it sing\" link appears after the boot check.",
                 mic: "Tick \"Mic level test\": the vet clocks the microphone and shows its live level for a few seconds while you talk or clap.",
                 ir: "Tick \"IR remote test\" and hold a remote at the board." },
    // I2S header J3 — the amplifier (DIN) and the microphone (SD) share these three lines
    i2s: { ws: 37, sck: 38, sd: 39 },
    // An I2S mic (WS 37 / SCK 38 / SD 39) is as invisible as the amp and won't clock out data
    // below ~1 MHz BCLK, so it is judged from a firmware that runs it: the "I2S mic test"
    // diagnostic streams `chanA peak=… rms=…` lines on the console.
    firmwareMic: { part: "mic", match: /I2S mic test/i, pins: { ws: 37, sck: 38, sd: 39 }, refs: ["J3"] },
    // The amp's I2S inputs are invisible to a pull test; the firmware that drives it isn't.
    // Newsheen Radio prints its IP at boot and exposes status / a test tune over HTTP.
    firmwareAudio: { part: "amp", match: /Newsheen Radio/i, statusPath: "/api/status", singPath: "/api/sing", refs: ["J3"],
      states: ["idle", "speaking", "singing", "playing a file", "streaming"] },
    known: [
      "BUG #1 (all units so far): U5 DIR strapped low → LEDs dark. Signature: GPIO16 reads LOW.",
      "BUG #2: U4 footprint is GND-middle (TSOP38238/VS1838B); a VCC-middle breakout receiver is never powered. Signature: GPIO4 floats.",
    ],
  },

  // ------------------------------------------------------------------ Nibble line
  // All four Nibbles are a Waveshare ESP32-S3-Zero on a carrier. Netlists: RetiaLLC/Nibble
  // open_sourced_nibble_v1_dual_micro (OG) and RetiaLLC/nibble_hardware — v1_lora_nibble_esps3_
  // zero_connect (Connect), esp32_s3_wroom/zero_connect_v2 + full_screen_connect v1 (Zero),
  // v2_lora_nibble_esps3_zero_screen_connect (Screen Connect). Rest levels measured on workbench5
  // 2026-09-21..25 (one unit each, two Zeros). Bridge/radio/antenna checks: first bench run 2026-09-27.
  "nibble-og-s3": {
    name: "Nibble OG (ESP32-S3-Zero + RFM95W)",
    line: "nibble", model: "Nibble OG (S3)",
    mcu: "esp32-s3",
    module: S3_ZERO_MODULE,
    pins: [
      { gpio: 4, expect: "HIGH", name: "RFM95 RESET (10K R2)", part: "radio",
        onFLOAT: { status: "fail", hint: "R2 (10K to 3V3) missing/open, or RFM95 pin 6 / the S3-Zero pad isn't soldered." },
        onLOW: { status: "fail", hint: "Held low — radio stuck in reset. Bridge to GND or to GPIO5 (DIO0) next to it on the module edge." } },
      { gpio: 9, expect: "HIGH", name: "RFM95 NSS / SPI_CS (10K R3)", part: "radio",
        onFLOAT: { status: "fail", hint: "R3 (10K to 3V3) missing/open." },
        onLOW: { status: "fail", hint: "Held low — radio permanently selected. Bridge to GND or to GPIO8/GPIO10 beside it." } },
      { gpio: 5, expect: "LOW", name: "RFM95 DIO0 (IRQ output)", part: "radio",
        onFLOAT: { status: "warn", hint: "Nothing drives DIO0 — RFM95W not fitted, unpowered, or its pin 14 open." },
        onHIGH: { status: "warn", hint: "DIO0 high at rest — an interrupt left pending by firmware, or a bridge to pulled-up GPIO4/GPIO6." } },
      { gpio: 6, expect: "float", name: "SPI SCK (→ RFM95 pin 4)", part: "radio" },
      { gpio: 7, expect: "float", name: "SPI MISO (RFM95 pin 2, idle)", part: "radio" },
      { gpio: 8, expect: "float", name: "SPI MOSI (→ RFM95 pin 3)", part: "radio" },
      { gpio: 10, expect: "float", name: "I2C SCL — test point TP10, no pull-ups on this board" },
      { gpio: 11, expect: "float", name: "I2C SDA — test point TP9, no pull-ups on this board" },
      { gpio: 1, expect: "any", name: "debug LED D1 (300R R4)" },
      { gpio: 2, expect: "float", name: "CS_ACCESSORY — test point TP8" },
      ...[12, 13].map((g) => ({ gpio: g, expect: "float", name: "unconnected S3-Zero pin" })),
      ...s3ZeroCommon(),
    ],
    driveSafe: [1, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13],                         // never 5: DIO0 is the radio's output
    radio: { type: "sx127x", nss: 9, mosi: 8, miso: 7, sck: 6, nrst: 4, dio0: 5, part: "RFM95W-915S2 (U2)", antPad: "J1 (u.FL / IPEX) — the antenna arrives on a pigtail" },
    i2c: [{ sda: 11, scl: 10, name: "I2C test points TP9/TP10", optionalPullups: true, expectDevices: [] }],
    beacon: { gpio: 1, name: "debug LED D1" },
    optionalParts: { radio: "LoRa module (RFM95W)" },
    known: [
      "Measured 2026-09-25 (workbench5, 3c:0f:02:e4:f0:b0): GPIO4/9 HIGH, 5 LOW, 21 HIGH, everything else floats — exactly the netlist.",
      "The RFM95 antenna sweep (SX1276 RegRssiValue in continuous RX) is new: pass/lift thresholds are the SX1262 ones until an OG has been swept with and without its antenna.",
    ],
  },

  "nibble-connect": {
    name: "Nibble Connect (ESP32-S3-Zero + Wio-SX1262)",
    line: "nibble", model: "Nibble Connect",
    mcu: "esp32-s3",
    module: S3_ZERO_MODULE,
    pins: [
      ...wioSx1262Pins({ nrstPull: "pull-up", nssPull: "10K R1" }),
      { gpio: 12, expect: "float", name: "SPI MISO (Wio pin 2, idle)", part: "radio" },
      { gpio: 13, expect: "float", name: "SPI SCK (→ Wio pin 4)", part: "radio" },
      { gpio: 7, expect: "float", name: "I2C SCL — J1/J3 headers, no pull-ups on this board" },
      { gpio: 8, expect: "float", name: "I2C SDA — J1/J3 headers, no pull-ups on this board" },
      { gpio: 9, expect: "float", name: "CS_ACCESSORY (J1 header)" },
      { gpio: 1, expect: "any", name: "debug LED (300R R4)" },
      { gpio: 2, expect: "float", name: "IO_GENERAL (header)" },
      ...s3ZeroCommon(),
    ],
    driveSafe: [1, 2, 6, 7, 8, 9, 10, 11, 12, 13],                            // never 4/5: DIO1 and BUSY are module outputs
    // RF_SW is GPIO3 (a strap pin, so it is never probed) — the antenna check drives it high
    // for the receive path and restores it before the reboot.
    radio: { type: "sx126x", nss: 10, mosi: 11, miso: 12, sck: 13, busy: 5, nrst: 6, dio1: 4, rfsw: 3, tcxoV: 1.8, dio2Switch: true,
      alt: { sck: 12, miso: 13 }, part: "Wio-SX1262 (U3)", antPad: "the Wio-SX1262's u.FL (IPEX) — the antenna arrives on a pigtail" },
    i2c: [{ sda: 8, scl: 7, name: "I2C headers J1/J3", optionalPullups: true, expectDevices: [] }],
    beacon: { gpio: 1, name: "debug LED" },
    optionalParts: { radio: "LoRa module (Wio-SX1262)" },
    known: [
      "Measured 2026-09-25 (workbench5, b8:f8:62:d9:54:70): 6/10 HIGH, 4/5 LOW, 21 HIGH, 7/8 float (no display, no I2C pull-ups).",
      "Meshtastic's nibble-connect variant uses SCK 13 / MISO 12; the Zero swaps them. The radio check tries the swapped pair if the first gets no ID.",
    ],
  },

  "nibble-zero": {
    name: "Nibble Zero (ESP32-S3-Zero + Wio-SX1262 + 0.96\" OLED)",
    line: "nibble", model: "Nibble Zero",
    mcu: "esp32-s3",
    module: { ...S3_ZERO_MODULE, name: "Waveshare ESP32-S3-Zero (ESP32-S3FH4R2, full footprint)", refs: ["U1"] },
    layout: "nibble-zero",
    pins: [
      ...wioSx1262Pins({ nrstPull: "10K RN1", nssPull: "10K RN1" }),
      { gpio: 12, expect: "float", refs: ["U3"], name: "SPI SCK (→ Wio pin 4)", part: "radio" },
      { gpio: 13, expect: "float", refs: ["U3"], name: "SPI MISO (Wio pin 2, idle)", part: "radio" },
      { gpio: 7, expect: "HIGH", refs: ["P1", "RN1", "J1"], name: "I2C SCL (10K RN1) → OLED P1, Qwiic J1",
        onFLOAT: { status: "fail", hint: "RN1 (10K array) open on the SCL leg, or the pad lifted." }, onLOW: { status: "fail", hint: "SCL held low — the OLED FPC or J1 is shorting it, or a bridge to GND." } },
      { gpio: 8, expect: "HIGH", refs: ["P1", "RN1", "J1"], name: "I2C SDA (10K RN1) → OLED P1, Qwiic J1",
        onFLOAT: { status: "fail", hint: "RN1 (10K array) open on the SDA leg, or the pad lifted." }, onLOW: { status: "fail", hint: "SDA held low — a stuck OLED (power-cycle) or a bridge to GND." } },
      { gpio: 9, expect: "float", refs: ["J2"], name: "CS_ACCESSORY (J2 header)" },
      { gpio: 1, expect: "float", refs: ["SW1"], name: "button A (SW1) — no pull-up, firmware uses INPUT_PULLUP",
        onHIGH: { status: "info", hint: "Pulled up: a Screen Connect has 10K here, a Zero doesn't — check the protocol." }, onLOW: { status: "fail", hint: "Button A reads pressed — stuck switch or bridge to GND." } },
      { gpio: 2, expect: "float", refs: ["SW2"], name: "button B / trackball press (SW2) — no pull-up",
        onLOW: { status: "fail", hint: "Button B reads pressed — stuck switch or bridge to GND." } },
      { gpio: 17, expect: "float", refs: ["D7"], name: "WS2812 D7 data-in (bottom pad 23)" },
      { gpio: 18, expect: "float", refs: ["J3"], name: "J3 header spare (bottom pad 24)" },
      { gpio: 41, expect: "float", refs: ["SW4"], name: "trackball DOWN (SW4, bottom pad)", onLOW: { status: "fail", hint: "Reads pressed — stuck switch or bridge to GND." } },
      { gpio: 42, expect: "float", refs: ["SW5"], name: "trackball LEFT (SW5, bottom pad)", onLOW: { status: "fail", hint: "Reads pressed — stuck switch or bridge to GND." } },
      ...s3ZeroCommon({ bottomUsed: [17, 18, 41, 42] }),
    ],
    driveSafe: [1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 38, 39, 40, 41, 42],
    // The S3-Zero "full" footprint has a HIDDEN bottom row of castellations soldered under the
    // module (this edge, top->bottom). They bridge during reflow — the usual cause of a stuck
    // trackball button (40/41/42/45 run here) — and can't be seen or wicked from the top.
    bridgeRows: [{ pins: [45, 42, 41, 40, 39, 38, 18, 17], under: true,
      hint: "Known Nibble Zero fault: a solder bridge on the ESP32-S3-Zero's bottom-row pads, hidden UNDER the module (the trackball lines 40/41/42/45 run along this edge) — the usual cause of a stuck button. You can't wick a short you can't reach: reflow the module off with hot air, clean the pads, and set it back down straight (a skewed module is the tell)." }],
    radio: { type: "sx126x", nss: 10, mosi: 11, miso: 13, sck: 12, busy: 5, nrst: 6, dio1: 4, rfsw: 3, tcxoV: 1.8, dio2Switch: true,
      alt: { sck: 13, miso: 12 }, part: "Wio-SX1262 (U3)", antPad: "the Wio-SX1262's u.FL (IPEX) — the antenna arrives on a pigtail", refs: ["U3"], antRefs: ["U3"] },
    i2c: [{ sda: 8, scl: 7, name: "OLED P1 (0.96\", 128×64) + Qwiic J1", expectDevices: [0x3c], part: "display", refs: ["P1"] }],
    beacon: { gpio: 39, name: "status LED (330R R4, bottom pad)", refs: ["R4"] },
    optionalParts: { radio: "LoRa module (Wio-SX1262)", display: "0.96\" OLED (SSD1306 at 0x3C)" },
    known: [
      "Measured 2026-09-21/22 (two units, 3c:0f:02:e5:3d:70 and 3c:0f:02:e4:ec:34, pin-for-pin identical): 6/7/8/10 HIGH, 4/5 LOW, 21 HIGH; SSD1306 answers at 0x3C (status 0x45); SX1262 IDs with SCK 12 / MISO 13.",
      "Trackball UP (GPIO40) and RIGHT (GPIO45) sit on JTAG/strap pins and are not judged.",
      "Known fault: the S3-Zero's bottom-row castellations (17/18/38/39/40/41/42/45), hidden under the module, bridge during reflow and stick a button. The bridge test now drives that row; RIGHT (45, a strap) can't be driven, so a 45-bridge shows only as GPIO42 held high in the rest levels. Fix = hot-air the module off and reseat it straight.",
    ],
  },

  "nibble-screen-connect": {
    name: "Nibble Screen Connect (ESP32-S3-Zero + Wio-SX1262 + 0.91\" OLED)",
    line: "nibble", model: "Nibble Screen Connect",
    mcu: "esp32-s3",
    module: S3_ZERO_MODULE,
    pins: [
      { gpio: 1, expect: "HIGH", name: "button A (SW1, 10K R3)",
        onFLOAT: { status: "fail", hint: "R3 (10K) missing/open — or this is a Nibble Zero (no button pull-ups)." }, onLOW: { status: "fail", hint: "Button A reads pressed — stuck switch or bridge to GND." } },
      { gpio: 2, expect: "HIGH", name: "button B (SW2, 10K R5)",
        onFLOAT: { status: "fail", hint: "R5 (10K) missing/open." }, onLOW: { status: "fail", hint: "Button B reads pressed — stuck switch or bridge to GND." } },
      ...wioSx1262Pins({ nrstPull: "10K R2", nssPull: "10K R1" }),
      { gpio: 12, expect: "float", name: "SPI MISO (Wio pin 2, idle)", part: "radio" },
      { gpio: 13, expect: "float", name: "SPI SCK (→ Wio pin 4)", part: "radio" },
      { gpio: 7, expect: "HIGH", name: "I2C SCL (10K R6) → OLED P2, J1",
        onFLOAT: { status: "fail", hint: "R6 (10K) missing/open — or a v1 board, which routes SCL to GPIO9 instead." }, onLOW: { status: "fail", hint: "SCL held low — the OLED FPC or J1 is shorting it, or a bridge to GND." } },
      { gpio: 8, expect: "HIGH", name: "I2C SDA (10K R7) → OLED P2, J1",
        onFLOAT: { status: "fail", hint: "R7 (10K) missing/open." }, onLOW: { status: "fail", hint: "SDA held low — a stuck OLED (power-cycle) or a bridge to GND." } },
      { gpio: 9, expect: "any", name: "status LED (330R R4) / CS_ACCESSORY on J2" },
      ...s3ZeroCommon(),
    ],
    driveSafe: [1, 2, 6, 7, 8, 9, 10, 11, 12, 13],
    radio: { type: "sx126x", nss: 10, mosi: 11, miso: 12, sck: 13, busy: 5, nrst: 6, dio1: 4, rfsw: 3, tcxoV: 1.8, dio2Switch: true,
      alt: { sck: 12, miso: 13 }, part: "Wio-SX1262 (U3)", antPad: "the Wio-SX1262's u.FL (IPEX) — the antenna arrives on a pigtail" },
    i2c: [{ sda: 8, scl: 7, name: "OLED P2 (0.91\", 128×32) + J1", expectDevices: [0x3c], part: "display" }],
    beacon: { gpio: 9, name: "status LED (R4)" },
    optionalParts: { radio: "LoRa module (Wio-SX1262)", display: "0.91\" OLED (SSD1306 at 0x3C)" },
    known: [
      "Measured 2026-09-24 (workbench5, 24:ec:4a:2f:c0:40): 1/2/6/7/8/10 HIGH, 4/5 LOW, 21 HIGH, 9 float — a v2 board.",
      "v1 PCBs routed SCL to GPIO9 (net GPIO09_I2C0_SCL); on those GPIO9 reads HIGH and GPIO7 floats, and the display scan needs SCL 9.",
    ],
  },

  // ------------------------------------------------------------------ Bluetooth Nugget
  // LOLIN S3 Mini carrier (nugget_v3 3.14 / v4). Castellation order not on file → no bridge
  // test. Rest levels measured 2026-09-21 (f0:f5:bd:6d:3e:c8): 35/36 HIGH only.
  "bluetooth-nugget": {
    name: "Bluetooth Nugget (LOLIN S3 Mini)",
    line: "bluetooth-nugget", model: "Bluetooth Nugget",
    mcu: "esp32-s3",
    module: { name: "LOLIN S3 Mini (ESP32-S3FH4R2)", flashMb: 4, psram: "2MB quad" },
    pins: [
      { gpio: 35, expect: "HIGH", name: "OLED I2C SDA (4.7K pull-up)", part: "display",
        onFLOAT: { status: "fail", hint: "4.7K pull-up missing/open or the OLED header unsoldered — the display bus is dead." } },
      { gpio: 36, expect: "HIGH", name: "OLED I2C SCL (4.7K pull-up)", part: "display",
        onFLOAT: { status: "fail", hint: "4.7K pull-up missing/open or the OLED header unsoldered." } },
      ...[11, 12, 13, 18].map((g) => ({ gpio: g, expect: "float", name: "button (no pull-up fitted; firmware uses INPUT_PULLUP)", onLOW: { status: "fail", hint: "Reads pressed — stuck switch or bridge to GND." } })),
      { gpio: 10, expect: "float", name: "WS2812 ×3 data" },
      { gpio: 15, expect: "any", name: "status LED" },
      { gpio: 4, expect: "float", name: "LoRa add-on RESET (10K when the RFM95 add-on is fitted)", part: "radio", onHIGH: { status: "pass", detail: "pulled up — LoRa add-on fitted" } },
      { gpio: 9, expect: "float", name: "LoRa add-on NSS (10K when fitted)", part: "radio", onHIGH: { status: "pass", detail: "pulled up — LoRa add-on fitted" } },
      { gpio: 16, expect: "held", name: "LoRa add-on DIO0 (RFM95 IRQ output)", part: "radio",
        onFLOAT: { status: "warn", hint: "DIO0 floats — the RFM95 add-on isn't fitted, or its DIO0 line is open." } },
      ...[6, 7, 8].map((g) => ({ gpio: g, expect: "float", name: "LoRa add-on SPI", part: "radio" })),
      { gpio: 47, expect: "any", name: "S3 Mini onboard WS2812 data (module-internal; read low on the unit measured)" },
      { gpio: 14, expect: "any", part: "radio", name: "header pin — a LoRa backpack may drive this (e.g. DIO1 / a control line on the v6 backpack)" },
      ...[1, 2, 5, 17, 21, 33, 34, 37, 41, 42, 48].map((g) => ({ gpio: g, expect: "float", name: "unused module pin" })),
      ...[38, 39, 40].map((g) => ({ gpio: g, expect: "rom", name: "JTAG pin in ROM mode" })),
    ],
    driveSafe: [],
    radio: { type: "sx127x", nss: 9, mosi: 8, miso: 7, sck: 6, nrst: 4, dio0: 16, part: "RFM95 add-on", antPad: "the add-on's antenna" },
    i2c: [{ sda: 35, scl: 36, name: "OLED (128×64 SSD1306)", expectDevices: [0x3c], part: "display" }],
    beacon: { gpio: 15, name: "status LED" },
    optionalParts: { radio: "LoRa add-on (RFM95)", display: "OLED (SSD1306 at 0x3C)" },
    defaultAbsent: ["radio"],
    known: ["Buttons 11/12/13/18 float on the shipped board although the v3.14 schematic shows 10K pull-ups.", "Radio pins are the nugget-bluetooth-rmf95 Meshtastic variant's.", "With a LoRa backpack fitted (tick \"has LoRa add-on\"): DIO0 (GPIO16) idles LOW = normal (it's the RFM95 IRQ output), and the v6 backpack drives GPIO14 high — both are reported, not faults. Bench-seen 2026-09-28 on a v6 backpack over USB."],
  },

  // ------------------------------------------------------------------ DEF CON badge
  // 2024 Retia DEF CON badge — RetiaLLC/DefconBadge2026 hardware/kicad/2024_def_con_badge_v1.
  // ESP32-S3-WROOM-1 (8 MB), ILI9341 2.4" TFT + XPT2046 touch + microSD + RFM95W (SX1276) all on
  // one SPI bus (SCK 13 / MISO 12 / MOSI 11), gated through 0R networks RN1-RN8. Pins resolved
  // against the Meshtastic variant.h (firmware/meshtastic/variant.h) — the 0R sheet net names
  // ("/buttons/ESP32_GPIOxx") do NOT reflect the wired function. NOT yet measured on a unit:
  // rest-level expectations are the netlist's; the JTAG-capable / 0R-jumper pins are reported
  // without judgement until a badge is examined.
  "defcon-badge": {
    name: "DEF CON badge (2024, ESP32-S3-WROOM-1)",
    line: "defcon-badge",
    mcu: "esp32-s3",
    module: { name: "ESP32-S3-WROOM-1 (8 MB)", flashMb: 8, pinOrder: WROOM1_PIN_ORDER, refs: ["U1"] },
    layout: "defcon-badge",
    pins: [
      // d-pad + A/B: each switch has a 10K pull-up (R10-R15) and a 0.01uF debounce cap -> rest HIGH.
      { gpio: 4, expect: "HIGH", refs: ["SW4", "R11"], name: "UP button SW4 (10K R11)",
        onFLOAT: { status: "fail", hint: "10K pull-up R11 missing/open." },
        onLOW: { status: "fail", hint: "SW4 stuck closed, or C8/SW4 shorted to GND." } },
      { gpio: 5, expect: "HIGH", refs: ["SW5", "R12"], name: "DOWN button SW5 (10K R12)",
        onFLOAT: { status: "fail", hint: "10K pull-up R12 missing/open." },
        onLOW: { status: "fail", hint: "SW5 stuck closed, or C9/SW5 shorted to GND." } },
      { gpio: 6, expect: "HIGH", refs: ["SW6", "R13"], name: "RIGHT button SW6 (10K R13)",
        onFLOAT: { status: "fail", hint: "10K pull-up R13 missing/open." },
        onLOW: { status: "fail", hint: "SW6 stuck closed, or C10/SW6 shorted to GND." } },
      { gpio: 7, expect: "HIGH", refs: ["SW7", "R14"], name: "B button SW7 (10K R14)",
        onFLOAT: { status: "fail", hint: "10K pull-up R14 missing/open." },
        onLOW: { status: "fail", hint: "SW7 stuck closed, or C11/SW7 shorted to GND." } },
      { gpio: 8, expect: "HIGH", refs: ["SW8", "R15"], name: "A button SW8 (10K R15)",
        onFLOAT: { status: "fail", hint: "10K pull-up R15 missing/open." },
        onLOW: { status: "fail", hint: "SW8 stuck closed, or C12/SW8 shorted to GND." } },
      // LEFT button SW3 is on GPIO3 (a strapping pin) -> in the UNSAFE set, never probed. See known[].
      // LoRa RFM95W (SX1276) — CS/RESET pulled up 10K; shares the SPI bus; DIO0 is the module output.
      { gpio: 48, expect: "HIGH", refs: ["U2", "R8"], name: "LoRa NSS/CS (10K R8, via RN2)", part: "radio",
        onFLOAT: { status: "fail", hint: "R8 (10K) missing/open, or RN2 CS jumper unpopulated — the radio is selected at random." },
        onLOW: { status: "fail", hint: "NSS held low — short at R8 / RFM95 pin 5, or a bridge to GND." } },
      { gpio: 38, expect: "HIGH", refs: ["U2", "R7"], name: "LoRa RESET (10K R7, via RN2)", part: "radio",
        onFLOAT: { status: "fail", hint: "R7 (10K) missing/open, or RN2 RESET jumper unpopulated — the radio never leaves reset." },
        onLOW: { status: "fail", hint: "RESET held low — short at R7 / RFM95 pin 6." } },
      { gpio: 21, expect: "held", refs: ["U2"], name: "LoRa DIO0/IRQ (module output, via RN2)", part: "radio",
        onFLOAT: { status: "warn", hint: "Nothing drives DIO0 — RFM95W not fitted, unpowered, or its pin 14 / the RN2 jumper open." } },
      { gpio: 11, expect: "float", refs: ["U1", "U2", "U3"], name: "shared SPI MOSI (radio / TFT / SD / accessory)" },
      { gpio: 12, expect: "float", refs: ["U1", "U2", "U3"], name: "shared SPI MISO" },
      { gpio: 13, expect: "float", refs: ["U1", "U2", "U3"], name: "shared SPI SCK" },
      // I2C accessory headers J5/J6 — no onboard device, no onboard pull-ups.
      { gpio: 35, expect: "float", refs: ["J5", "J6"], name: "I2C SDA (accessory headers J5/J6)" },
      { gpio: 36, expect: "float", refs: ["J5", "J6"], name: "I2C SCL (accessory headers J5/J6)" },
      // NeoPixels / LED / buzzer.
      { gpio: 17, expect: "float", name: "NeoPixel data (10x WS2812)" },
      { gpio: 2, expect: "any", refs: ["R3"], name: "debug LED (green, 330R R3)" },
      { gpio: 9, expect: "float", refs: ["R6"], name: "buzzer (330R R6)" },
      // TFT control + 0R-jumper / JTAG-capable pins: driven only by firmware, or reconfigurable
      // jumpers — level is not board-determined at ROM rest, so reported without judgement until
      // a badge is measured (39/40/41/42 are also the S3 JTAG quartet).
      { gpio: 47, expect: "any", refs: ["U3"], name: "TFT CS (idle high under firmware)" },
      { gpio: 40, expect: "any", refs: ["U3"], name: "TFT DC / JTAG MTDO" },
      { gpio: 41, expect: "any", refs: ["U3"], name: "TFT RST / JTAG MTDI" },
      { gpio: 42, expect: "any", name: "spare (RN7 jumper) / JTAG MTMS" },
      { gpio: 39, expect: "any", name: "SD/aux (RN6 jumper) / JTAG MTCK" },
      { gpio: 10, expect: "any", name: "SD card CS (unused by badge firmware)" },
      { gpio: 14, expect: "any", name: "touch/aux (RN5 jumper)" },
      { gpio: 37, expect: "any", name: "accessory SPI (RN8 jumper)" },
      { gpio: 18, expect: "float", name: "unconnected module pin" },
      { gpio: 15, expect: "any", name: "GPIO15 — 32.768 kHz crystal (XTAL_32K_P)" },
      { gpio: 16, expect: "any", name: "GPIO16 — 32.768 kHz crystal (XTAL_32K_N)" },
    ],
    // bridge test may drive the confidently-known pins at weakest strength; never DIO0 (21, radio
    // output), never the JTAG-capable quartet (39-42) or the 32K crystal (15/16).
    driveSafe: [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 35, 36, 37, 38, 47, 48],
    radio: { type: "sx127x", nss: 48, mosi: 11, miso: 12, sck: 13, nrst: 38, dio0: 21,
      part: "RFM95W-915S2 (U2)", antPad: "J1 (u.FL / IPEX) or TP1 (wire antenna pad)", antRefs: ["J1", "TP1"], refs: ["U2"] },
    i2c: [{ sda: 35, scl: 36, name: "accessory headers J5/J6", optionalPullups: true, expectDevices: [], refs: ["J5", "J6"] }],
    beacon: { gpio: 2, name: "debug LED (green)", refs: ["R3"] },
    optionalParts: { radio: "LoRa module (RFM95W / SX1276)" },
    known: [
      "Pins from the Meshtastic variant.h (firmware/meshtastic/variant.h): SPI 13/12/11, LoRa CS 48 / RESET 38 / DIO0 21, TFT CS 47 / DC 40 / RST 41, I2C 35/36, NeoPixel 17 (x10), LED 2, buzzer 9, buttons SW3-8 on 3/4/5/6/7/8.",
      "NOT yet measured on a badge — rest-level expectations are the netlist's; the RFM95 antenna sweep uses the SX1276 path (thresholds are the SX1262 ones for now).",
      "LEFT button (SW3) is on GPIO3, a strapping pin, so it is never probed. GPIO39-42 are the S3 JTAG quartet and are reported without judgement until measured.",
    ],
  },
};
