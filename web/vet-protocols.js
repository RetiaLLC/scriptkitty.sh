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

export const PROTOCOLS = {
  // Newsheen / Pusheen puck — esp32_base_puck_v2 (RetiaLLC/pusheen_hardware,
  // 130mm_Pusheen/esp32_base_puck_v2). Netlist exported 2026-09-26.
  newsheen: {
    name: "Newsheen puck (esp32_base_puck_v2)",
    line: "newsheen",
    mcu: "esp32-s3",
    module: { name: "ESP32-S3-WROOM-1-N16R2", flashMb: 16, psram: "2MB quad", pinOrder: WROOM1_PIN_ORDER },
    pins: [
      { gpio: 16, expect: "float", name: "NeoPixel data (→ U5 level shifter)",
        onLOW:  { status: "fail", hint: "Known BUG #1: U5's DIR pin is strapped to GND by R21, so the shifter drives this pin instead of listening — the 8 LEDs will never light. Fix per unit: solder-bridge U5 pin 5 (DIR) to pin 6 (VCCB), back side, SOT-23-6." },
        onHIGH: { status: "warn", hint: "Held high — check for a bridge to 3V3 near U5/R21." } },
      { gpio: 4, expect: "HIGH", name: "IR receiver OUT (U4)", part: "ir",
        // measured: a fitted, working receiver can idle floating too (no / weak internal
        // pull-up) — only the remote test separates that from BUG #2, so float is a warning
        onFLOAT: { status: "warn", hint: "Output isn't pulled up. Either no receiver is fitted, it's unpowered (BUG #2: a VCC-middle part never gets power on this GND-middle footprint), or it's a type without an internal pull-up — run the IR remote test to tell: a decode means it works (firmware must enable the pin's pull-up)." },
        onLOW:   { status: "fail", hint: "Output stuck low — receiver fitted backwards or shorted at U4." },
        passNote: "receiver powered and idle — this also proves the +5V rail is up" },
      { gpio: 17, expect: "HIGH", name: "User button SW3 (10K R3)",
        onFLOAT: { status: "fail", hint: "10K pull-up R3 missing or open." },
        onLOW:   { status: "fail", hint: "Button stuck or SW3/C11 shorted to GND." } },
      { gpio: 35, expect: "HIGH", name: "I2C SDA (5.1K R18, J3 header)",
        onFLOAT: { status: "fail", hint: "Pull-up R18 missing — or an N16R8 (octal PSRAM) module is fitted and owns GPIO33-37." },
        onLOW:   { status: "fail", hint: "SDA shorted to GND (R18 / J3)." } },
      { gpio: 36, expect: "HIGH", name: "I2C SCL (5.1K R19, J3 header)",
        onFLOAT: { status: "fail", hint: "Pull-up R19 missing — or an N16R8 (octal PSRAM) module is fitted and owns GPIO33-37." },
        onLOW:   { status: "fail", hint: "SCL shorted to GND (R19 / J3)." } },
      { gpio: 9,  expect: "HIGH", name: "LoRa NRST (10K R23)",
        onFLOAT: { status: "fail", hint: "R23 missing/open — the radio never leaves reset cleanly." },
        onLOW:   { status: "fail", hint: "NRST held low — short at R23/U6 pin 5." } },
      { gpio: 10, expect: "HIGH", name: "LoRa NSS (10K R22)",
        onFLOAT: { status: "fail", hint: "R22 missing/open — the radio is selected at random." },
        onLOW:   { status: "fail", hint: "NSS held low — short at R22/U6 pin 6." } },
      { gpio: 47, expect: "LOW", name: "LoRa BUSY (U6 output)", part: "radio",
        onFLOAT: { status: "warn", hint: "Nothing drives BUSY — Wio-SX1262 not soldered, or its 3V3/GND pins open." },
        onHIGH:  { status: "warn", hint: "BUSY stuck high — module held in reset or unpowered; see the radio check." } },
      { gpio: 21, expect: "held", name: "LoRa DIO1 (U6 IRQ output)", part: "radio",
        onFLOAT: { status: "warn", hint: "DIO1 floats — U6 pin 12 open?" } },
      { gpio: 11, expect: "float", name: "LoRa MOSI" }, { gpio: 12, expect: "float", name: "LoRa MISO (idle, NSS high)" },
      { gpio: 13, expect: "float", name: "LoRa SCK" },  { gpio: 14, expect: "float", name: "LoRa RF switch" },
      { gpio: 37, expect: "float", name: "I2S WS (J3 pin 5)" },
      { gpio: 38, expect: "rom", name: "I2S SCK (J3 pin 3) — JTAG pin in ROM mode" },
      { gpio: 39, expect: "rom", name: "I2S SD (J3 pin 4) — JTAG pin in ROM mode" },
      { gpio: 40, expect: "rom", name: "unused — JTAG pin in ROM mode" },
      { gpio: 15, expect: "float", name: "buzzer stub (nothing fitted)" },
      { gpio: 1,  expect: "float", name: "BATT_VOLT test point TP4",
        onHIGH: { status: "fail", hint: "Something is driving TP4 — a battery wired straight to GPIO1 with no divider will destroy the pin (4.2 V on a 3.3 V input). Use 100K/100K." } },
      { gpio: 2,  expect: "float", name: "CHG_CNTRL test point TP5" },
      { gpio: 48, expect: "any", name: "debug LED D14 (330R R14)" },
      ...[5, 6, 7, 8, 18, 41, 42].map((g) => ({ gpio: g, expect: "float", name: "unconnected module pin" })),
    ],
    // pins the bridge test may drive at the weakest strength (never radio outputs 21/47,
    // never the IR open-collector's neighbours' partner… it's fine: 4 is open-collector)
    driveSafe: [4, 5, 6, 7, 8, 15, 16, 17, 18, 9, 10, 11, 12, 13, 14, 48, 35, 36, 37, 38, 39, 40, 41, 42, 1, 2],
    // Wio-SX1262: TCXO on DIO3 (1.8 V), DIO2 drives the T/R switch, RF_SW (GPIO14) powers it;
    // ANT1 is a bare pad for a quarter-wave wire.
    radio: { type: "sx126x", nss: 10, mosi: 11, miso: 12, sck: 13, busy: 47, nrst: 9, dio1: 21, rfsw: 14, tcxoV: 1.8, dio2Switch: true, part: "Wio-SX1262 (U6)", antPad: "ANT1 (wire antenna pad)",
      // measured on the same unit in the same room, 2026-09-26: wire antenna on → 739 MHz
      // at -87…-91 dBm, 11-15 dB above the floor; wire off → flat -103…-107 dBm, 4 dB spread
      antennaCalibration: { withMax: -91, withLift: 11, withoutFloor: -107, withoutLift: 4 } },
    i2c: [{ sda: 35, scl: 36, name: "sensor header J3", expectDevices: [] }],
    beacon: { gpio: 48, name: "debug LED D14" },
    // interactive: point a remote at the board — the receiver pulls OUT low in 38 kHz bursts
    ir: { gpio: 4, part: "ir", name: "IR receiver (U4)" },
    // parts a unit may legitimately ship without — the user declares them; declared-absent
    // parts are checked for being genuinely absent (their pins float) and reported as info
    optionalParts: { radio: "LoRa module (Wio-SX1262, U6)", ir: "IR receiver (U4)", amp: "I2S amplifier (MAX98357A on J3)" },
    // The amp's I2S inputs are invisible to a pull test; the firmware that drives it isn't.
    // Newsheen Radio prints its IP at boot and exposes status / a test tune over HTTP.
    firmwareAudio: { part: "amp", match: /Newsheen Radio/i, statusPath: "/api/status", singPath: "/api/sing",
      states: ["idle", "speaking", "singing", "playing a file", "streaming"] },
    known: [
      "BUG #1 (all units so far): U5 DIR strapped low → LEDs dark. Signature: GPIO16 reads LOW.",
      "BUG #2: U4 footprint is GND-middle (TSOP38238/VS1838B); a VCC-middle breakout receiver is never powered. Signature: GPIO4 floats.",
    ],
  },
};
