// vetprobe.js — "Diagnose my cat": a soldering exam run through the ESP32-S3 ROM loader /
// flasher stub, no firmware required. Feed it an `io` ({ readReg, writeReg, readFlash? })
// and a protocol from vet-protocols.js; get back a report of pass/warn/fail checks with
// rework hints. Pure module: the page (vet.js) and scripts/test_vetprobe.mjs both use it.
//
// What it can and cannot see. Everything here is electrical: rest levels with only the
// chip's own pulls, whether a neighbouring pin follows one we drive weakly (a solder
// bridge), whether an SPI radio answers with its ID, whether an I2C bus has pull-ups and
// devices. It cannot light a WS2812 (needs 800 kHz timing) or hear a mic — those need
// firmware. It never writes flash or eFuses. Drives are at the weakest pad strength
// (~5 mA) so a pin shorted to a rail is not harmed.
import {
  pullFollow, i2cAck, appInfoFromFlash,
  GPIO, ioMux, funcOutSel, FUN_PD, FUN_PU, FUN_IE, MCU_SEL_GPIO, bank, bit, UNSAFE, EN_W1TS, EN_W1TC, IN,
} from "./boardprobe.js";

const OUT_W1TS = [GPIO + 0x08, GPIO + 0x14];
const OUT_W1TC = [GPIO + 0x0c, GPIO + 0x18];
const EFUSE_RD_MAC_SPI_SYS_3 = 0x60007050, EFUSE_RD_MAC_SPI_SYS_4 = 0x60007054;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pad control with bookkeeping so every pin we touch goes back exactly as found.
class Pads {
  constructor(io) { this.io = io; this.saved = new Map(); }
  async claim(pin) {
    if (this.saved.has(pin)) return;
    this.saved.set(pin, [await this.io.readReg(ioMux(pin)), await this.io.readReg(funcOutSel(pin))]);
    await this.io.writeReg(funcOutSel(pin), 0x100);                    // plain GPIO output signal
  }
  async input(pin, pull = 0) {                                           // high-Z input, optional internal pull
    await this.claim(pin);
    await this.io.writeReg(EN_W1TC[bank(pin)], bit(pin));
    await this.io.writeReg(ioMux(pin), MCU_SEL_GPIO | FUN_IE | pull);
  }
  async drive(pin, level) {                                              // push-pull at the weakest strength
    await this.claim(pin);
    await this.io.writeReg(ioMux(pin), MCU_SEL_GPIO | FUN_IE);
    await this.io.writeReg((level ? OUT_W1TS : OUT_W1TC)[bank(pin)], bit(pin));
    await this.io.writeReg(EN_W1TS[bank(pin)], bit(pin));
  }
  async set(pin, level) { await this.io.writeReg((level ? OUT_W1TS : OUT_W1TC)[bank(pin)], bit(pin)); }
  async read(pin) { return (((await this.io.readReg(IN[bank(pin)])) >>> 0) & bit(pin)) !== 0; }
  async restore() {
    for (const [pin, [mux, sel]] of this.saved) {
      await this.io.writeReg(EN_W1TC[bank(pin)], bit(pin));
      await this.io.writeReg(ioMux(pin), mux);
      await this.io.writeReg(funcOutSel(pin), sel);
    }
    this.saved.clear();
  }
}

const check = (id, title, status, detail, hint) => ({ id, title, status, detail: detail || "", ...(hint ? { hint } : {}) });

// ---------------------------------------------------------------- identity
export function flashSizeMb(flashId) {
  const sizeId = (flashId >> 16) & 0xff;
  if (sizeId < 0x12 || sizeId > 0x20) return null;
  return Math.pow(2, sizeId) / (1024 * 1024);
}
const FLASH_VENDORS = { 0x20: "XMC", 0xc8: "GigaDevice", 0xef: "Winbond", 0x68: "Boya", 0x85: "Puya", 0x1c: "EON", 0x0b: "XTX", 0xc2: "Macronix" };

export async function identityChecks(io, protocol, chip = {}) {
  const out = [];
  if (chip.chipName) {
    const ok = protocol.mcu === "esp32-s3" ? /ESP32-S3/i.test(chip.chipName) : true;
    out.push(check("chip", "Chip", ok ? "pass" : "fail", `${chip.chipName}${chip.mac ? " · MAC " + chip.mac : ""}`,
      ok ? undefined : `This protocol is for an ${protocol.mcu.toUpperCase()} board.`));
  }
  if (chip.flashId != null && protocol.module?.flashMb) {
    const mb = flashSizeMb(chip.flashId), vendor = FLASH_VENDORS[chip.flashId & 0xff] || `0x${(chip.flashId & 0xff).toString(16)}`;
    const ok = mb === protocol.module.flashMb;
    out.push(check("flash", "Flash", ok ? "pass" : "fail", `${mb ?? "?"} MB (${vendor})`,
      ok ? undefined : `Expected ${protocol.module.flashMb} MB — is the fitted module a ${protocol.module.name}?`));
  }
  try {
    const w3 = (await io.readReg(EFUSE_RD_MAC_SPI_SYS_3)) >>> 0, w4 = (await io.readReg(EFUSE_RD_MAC_SPI_SYS_4)) >>> 0;
    const flashCap = (w3 >>> 27) & 7, psramCap = (w4 >>> 3) & 3;      // espefuse: FLASH_CAP 0 none/1 8M/2 4M · PSRAM_CAP 0 none/1 8M/2 2M
    const psram = { 0: "none", 1: "8 MB (octal)", 2: "2 MB" }[psramCap] ?? `code ${psramCap}`;
    if (protocol.module?.psram) {
      const wantOctal = /octal|8MB/i.test(protocol.module.psram), isOctal = psramCap === 1;
      const status = psramCap === 0 ? "warn" : isOctal === wantOctal ? "pass" : "fail";
      out.push(check("psram", "PSRAM (eFuse)", status, `${psram}${flashCap ? `, in-package flash code ${flashCap}` : ", external flash"}`,
        status === "fail" ? (isOctal ? "An octal-PSRAM module (N16R8) is fitted: it owns GPIO33-37, so the I2C/I2S sensor header pins are dead and firmware built for quad PSRAM will not boot." : "Module PSRAM type does not match the design.")
        : status === "warn" ? "No PSRAM reported — a plain N16 module? PSRAM-dependent firmware will fail." : undefined));
    } else out.push(check("psram", "PSRAM (eFuse)", "info", psram));
  } catch { /* eFuse read unavailable */ }
  return out;
}

// ---------------------------------------------------------------- rest levels
export function judgePin(spec, level) {
  const on = (key) => spec[key];
  const held = level === "HIGH" || level === "LOW";
  const okNote = spec.passNote ? ` — ${spec.passNote}` : "";
  const custom = level === "float" ? on("onFLOAT") : level === "LOW" ? on("onLOW") : level === "HIGH" ? on("onHIGH") : null;
  if (level === "noise") return { status: "warn", detail: "reads unstable", hint: "Re-run; if it persists suspect a floating input picking up a neighbour." };
  switch (spec.expect) {
    case "float":
      if (level === "float") return { status: "pass", detail: "floats" + okNote };
      return custom ? { status: custom.status, detail: `held ${level}`, hint: custom.hint }
                    : { status: "warn", detail: `held ${level}`, hint: `Nothing should drive GPIO${spec.gpio}; look for a solder bridge to ${level === "HIGH" ? "3V3 / a pulled-up neighbour" : "GND / a neighbour"}.` };
    case "HIGH":
      if (level === "HIGH") return { status: "pass", detail: "pulled up" + okNote };
      return custom ? { status: custom.status, detail: level === "float" ? "floats (no pull-up)" : "held LOW", hint: custom.hint }
                    : { status: "fail", detail: level === "float" ? "floats (no pull-up)" : "held LOW" };
    case "LOW":
      if (level === "LOW") return { status: "pass", detail: "driven low" + okNote };
      return custom ? { status: custom.status, detail: level === "float" ? "floats" : "held HIGH", hint: custom.hint }
                    : { status: "warn", detail: level === "float" ? "floats" : "held HIGH" };
    case "held":
      if (held) return { status: "pass", detail: `driven ${level}` + okNote };
      return custom ? { status: custom.status, detail: "floats", hint: custom.hint } : { status: "warn", detail: "floats" };
    case "rom": return { status: "info", detail: `${level} (ROM-mode JTAG level, not a board signal)` };
    default: return { status: "info", detail: level };
  }
}

export async function pinChecks(io, protocol) {
  const specs = protocol.pins.filter((p) => !UNSAFE.has(p.gpio));
  const fp = await pullFollow(io, specs.map((p) => p.gpio));
  const out = specs.map((spec) => {
    const j = judgePin(spec, fp[spec.gpio]);
    return { ...check(`gpio${spec.gpio}`, `GPIO${spec.gpio} — ${spec.name}`, j.status, j.detail, j.hint), gpio: spec.gpio, level: fp[spec.gpio] };
  });
  return { checks: out, fingerprint: fp };
}

// ---------------------------------------------------------------- solder bridges
// Adjacent module pins: drive one weakly, see whether the other follows in BOTH directions
// (a pulled-up neighbour follows "high" on its own; only a real short also follows "low").
export function adjacentPairs(protocol) {
  const order = protocol.module?.pinOrder || [];
  const drive = new Set(protocol.driveSafe || []);
  const readable = (p) => Number.isInteger(p) && !UNSAFE.has(p);
  const pairs = [];
  for (let i = 0; i + 1 < order.length; i++) {
    const a = order[i], b = order[i + 1];
    if (!readable(a) || !readable(b)) continue;
    if (drive.has(a)) pairs.push([a, b]); else if (drive.has(b)) pairs.push([b, a]);
  }
  return pairs;
}

export async function bridgeChecks(io, protocol, fingerprint = {}) {
  const pairs = adjacentPairs(protocol);
  if (!pairs.length) return { checks: [], bridged: [] };
  const pads = new Pads(io);
  const bridged = [];
  try {
    for (const [a, b] of pairs) {
      const follows = {};
      for (const level of [1, 0]) {
        await pads.input(b, level ? FUN_PD : FUN_PU);                // pull the listener the other way
        await pads.drive(a, level);
        await pads.read(b);                                           // settle read
        follows[level] = (await pads.read(b)) === !!level;
        await pads.input(a, 0);
      }
      if (follows[1] && follows[0]) bridged.push([a, b]);
    }
  } finally { await pads.restore(); }
  const fmt = ([a, b]) => `GPIO${a} ↔ GPIO${b}`;
  const checks = bridged.length
    ? bridged.map(([a, b]) => check(`bridge-${a}-${b}`, `Solder bridge ${fmt([a, b])}`, "fail", "the second pin follows the first both high and low",
        `Adjacent castellations on the module — reflow / wick between them.`))
    : [check("bridges", "Solder bridges (adjacent module pins)", "pass", `none among ${pairs.length} neighbouring pairs`)];
  return { checks, bridged, pairs: pairs.length };
}

// ---------------------------------------------------------------- radio
async function spiSession(io, r) {
  const pads = new Pads(io);
  await pads.drive(r.nss, 1); await pads.drive(r.sck, 0); await pads.drive(r.mosi, 0);
  await pads.input(r.miso, 0);
  if (r.busy != null) await pads.input(r.busy, 0);
  const xfer = async (bytes) => {
    await pads.set(r.nss, 0);
    const rx = [];
    for (const byte of bytes) {
      let v = 0;
      for (let i = 7; i >= 0; i--) {
        await pads.set(r.mosi, (byte >> i) & 1);
        await pads.set(r.sck, 1); v = (v << 1) | (await pads.read(r.miso) ? 1 : 0); await pads.set(r.sck, 0);
      }
      rx.push(v);
    }
    await pads.set(r.nss, 1);
    return rx;
  };
  return { pads, xfer };
}

export async function radioChecks(io, protocol) {
  const r = protocol.radio;
  if (!r) return [];
  const out = [];
  const { pads, xfer } = await spiSession(io, r);
  try {
    // reset pulse through NRST (external pull-up releases it), then wait for BUSY to drop
    if (r.nrst != null) { await pads.drive(r.nrst, 0); await sleep(5); await pads.input(r.nrst, 0); }
    let busyTrace = [];
    if (r.busy != null) {
      for (let i = 0; i < 20; i++) { const b = await pads.read(r.busy); busyTrace.push(b ? 1 : 0); if (!b && i >= 2) break; }
    }
    // is anything driving MISO while selected? (a missing module leaves it floating)
    await pads.set(r.nss, 0);
    await pads.input(r.miso, FUN_PD); const d = await pads.read(r.miso);
    await pads.input(r.miso, FUN_PU); const u = await pads.read(r.miso);
    await pads.input(r.miso, 0); await pads.set(r.nss, 1);
    const misoDriven = d === u;

    if (r.type === "sx126x") {
      const st = await xfer([0xc0, 0x00]);
      const status = st[1], mode = (status >> 4) & 7, cmd = (status >> 1) & 7;
      const id = await xfer([0x1d, 0x03, 0x20, 0x00, ...new Array(16).fill(0)]).then((b) => b.slice(4));
      const idStr = String.fromCharCode(...id).replace(/\0.*$/, "");
      const alive = /^SX126/.test(idStr);
      const modeName = { 2: "STDBY_RC", 3: "STDBY_XOSC", 4: "FS", 5: "RX", 6: "TX" }[mode] || `mode ${mode}`;
      out.push(check("radio", `LoRa radio — ${r.part || "SX126x"}`, alive ? "pass" : "fail",
        alive ? `answers: "${idStr}", ${modeName}, BUSY ${busyTrace.at(-1) === 0 ? "released" : "still high"}`
              : `no ID (${misoDriven ? "MISO is driven but the reply is garbage" : "MISO never driven"}; status 0x${(status ?? 0).toString(16)}; BUSY trace ${busyTrace.join("") || "n/a"})`,
        alive ? undefined
              : misoDriven ? `Something answers on MISO but not as an SX126x — check SCK/MOSI for bridges (GPIO${r.sck}/GPIO${r.mosi}) and NSS (GPIO${r.nss}).`
              : `The module isn't talking: check ${r.part || "the radio"} is soldered (MISO GPIO${r.miso}, NSS GPIO${r.nss}, SCK GPIO${r.sck}), its 3V3 and GND pins, and that BUSY (GPIO${r.busy}) drops after reset.`));
    } else if (r.type === "sx127x") {
      const v = (await xfer([0x42, 0x00]))[1];
      const alive = v === 0x12;
      out.push(check("radio", `LoRa radio — ${r.part || "SX127x"}`, alive ? "pass" : "fail",
        alive ? `RegVersion 0x12 (SX1276/RFM95)` : `RegVersion 0x${v.toString(16)} (${misoDriven ? "MISO driven" : "MISO never driven"})`,
        alive ? undefined : `Check the module is soldered and powered (MISO GPIO${r.miso}, NSS GPIO${r.nss}, SCK GPIO${r.sck}).`));
    }
  } finally { await pads.restore(); }
  return out;
}

// ---------------------------------------------------------------- I2C
export async function i2cChecks(io, protocol, fingerprint = {}) {
  const out = [];
  for (const bus of protocol.i2c || []) {
    const up = fingerprint[bus.sda] === "HIGH" && fingerprint[bus.scl] === "HIGH";
    if (!up) { out.push(check(`i2c-${bus.sda}`, `I2C scan — ${bus.name}`, "skip", "bus not pulled up (see the SDA/SCL pin checks)")); continue; }
    const found = [];
    for (let a = 0x08; a < 0x78; a++) if (await i2cAck(io, bus.sda, bus.scl, a)) found.push(a);
    const hex = found.map((a) => "0x" + a.toString(16).padStart(2, "0"));
    const expected = bus.expectDevices || [];
    const missing = expected.filter((a) => !found.includes(a));
    const status = missing.length ? "fail" : "pass";
    out.push(check(`i2c-${bus.sda}`, `I2C scan — ${bus.name}`, status,
      found.length ? `devices at ${hex.join(", ")}` : (expected.length ? "no devices answered" : "bus healthy, nothing fitted (expected)"),
      missing.length ? `Expected ${missing.map((a) => "0x" + a.toString(16)).join(", ")} to answer.` : undefined));
  }
  return out;
}

// ---------------------------------------------------------------- beacon + firmware
export async function beacon(io, protocol, { blinks = 3, ms = 120 } = {}) {
  const b = protocol.beacon;
  if (!b) return null;
  const pads = new Pads(io);
  try { for (let i = 0; i < blinks; i++) { await pads.drive(b.gpio, 1); await sleep(ms); await pads.drive(b.gpio, 0); await sleep(ms); } }
  finally { await pads.restore(); }
  return check("beacon", `Blinked ${b.name}`, "info", `${blinks}× — if it stayed dark, check the LED and its resistor`);
}

export async function firmwareCheck(io, images = null) {
  if (!io.readFlash) return null;
  try {
    const { env, elfSha } = await appInfoFromFlash(io.readFlash, { deep: false });
    if (!elfSha && !env) return check("firmware", "Installed firmware", "info", "no app image at 0x10000 (blank or non-standard layout)");
    const img = images && elfSha && images[elfSha];
    return check("firmware", "Installed firmware", "info", img ? `${img.name}${img.version ? " " + img.version : ""} (catalog image)` : env ? `PlatformIO env "${env}"` : `ELF ${elfSha.slice(0, 12)}…`);
  } catch { return null; }
}

// ---------------------------------------------------------------- boot watch (parser)
// Feed the text read from the JTAG/HWCDC console for a few seconds after a reset (DTR low!).
export function analyzeBootLog(text, { vanishedAfterMs = null, windowMs = 6000 } = {}) {
  const banners = (text.match(/ESP-ROM:esp32/g) || []).length;
  const resets = [...text.matchAll(/rst:0x([0-9a-f]+) \(([A-Z_0-9]+)\)/gi)].map((m) => m[2]);
  const boots = [...text.matchAll(/boot:0x([0-9a-f]+) \(([A-Z_0-9()\/]+)\)/gi)].map((m) => m[2]);
  const invalid = /invalid header/i.test(text);
  const panic = /Guru Meditation|abort\(\)|Backtrace:|assert failed/i.test(text);
  const download = boots.some((b) => /DOWNLOAD/.test(b));
  const brownout = resets.some((r) => /BROWN/.test(r));
  // the firmware's own first words, after the ROM/2nd-stage bootloader lines
  const fwLines = text.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l && !/^(ESP-ROM:|Build:|rst:|boot:|Saved PC|SPIWP|mode:|load:|entry |waiting for download|invalid header)/.test(l)).slice(0, 4);
  let status, detail, hint;
  if (vanishedAfterMs != null) { status = "pass"; detail = `firmware took over USB after ${(vanishedAfterMs / 1000).toFixed(1)} s (TinyUSB app running)`; }
  else if (invalid) { status = "fail"; detail = "ROM finds no valid image (\"invalid header\") — flash is blank or corrupt"; hint = "Flash a firmware, then re-run the boot check."; }
  else if (panic) { status = "fail"; detail = `firmware crashes (${banners} boot${banners === 1 ? "" : "s"} in ${windowMs / 1000} s, panic text seen)`; hint = "Capture the console for the backtrace; suspect the firmware/board mismatch or a peripheral that failed above."; }
  else if (brownout) { status = "fail"; detail = `brownout resets (${resets.filter((r) => /BROWN/.test(r)).length})`; hint = "Power: check the +5V/3V3 rails under load (U3, D1, USB cable)."; }
  else if (banners > 1) { status = "fail"; detail = `reboot loop: ${banners} boots in ${windowMs / 1000} s (${[...new Set(resets)].join(", ")})`; hint = "Crash loop without panic text on this console — read the firmware's own console for the reason."; }
  else if (download) { status = "warn"; detail = "still in download mode after the reset"; hint = "BOOT held or strapped low? Or the FORCE_DOWNLOAD latch — power-cycle once."; }
  else if (banners === 1 && boots.some((b) => /SPI_FAST_FLASH_BOOT/.test(b))) { status = "pass"; detail = `one clean boot (${resets[0] || "reset"}), no further resets in ${windowMs / 1000} s`; }
  else if (banners === 0) { status = "info"; detail = "no console output — firmware running silently or console on UART0"; }
  else { status = "info"; detail = `${banners} boot(s): ${boots.join(", ")}`; }
  if (fwLines.length && status !== "fail") detail += ` — console: ${fwLines.join(" ⏎ ").slice(0, 160)}`;
  return { status, detail, hint, banners, resets, boots, invalid, panic, brownout, firmwareLines: fwLines };
}

// ---------------------------------------------------------------- the exam
export async function runExam(io, protocol, { chip = {}, images = null, onStep = () => {}, doBridges = true, doRadio = true, doI2c = true, doBeacon = true } = {}) {
  const t0 = Date.now();
  const checks = [];
  onStep("identity"); checks.push(...await identityChecks(io, protocol, chip));
  onStep("pins");     const pins = await pinChecks(io, protocol); checks.push(...pins.checks);
  if (doBridges) { onStep("bridges"); checks.push(...(await bridgeChecks(io, protocol, pins.fingerprint)).checks); }
  if (doRadio)   { onStep("radio");   checks.push(...await radioChecks(io, protocol)); }
  if (doI2c)     { onStep("i2c");     checks.push(...await i2cChecks(io, protocol, pins.fingerprint)); }
  onStep("firmware"); const fw = await firmwareCheck(io, images); if (fw) checks.push(fw);
  if (doBeacon)  { onStep("beacon");  const b = await beacon(io, protocol); if (b) checks.push(b); }
  const counts = { pass: 0, warn: 0, fail: 0, info: 0, skip: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const verdict = counts.fail ? "needs-rework" : counts.warn ? "check" : "healthy";
  return { board: protocol.name, line: protocol.line, chip, checks, counts, verdict, fingerprint: pins.fingerprint, ms: Date.now() - t0 };
}
