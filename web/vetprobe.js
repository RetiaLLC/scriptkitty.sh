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
// Writes are QUEUED and sent to the flasher stub in batches: one loader command carries many
// [addr, value, mask, delay_us] tuples and the stub applies them back to back, sleeping
// delay_us before each one. A USB round-trip costs milliseconds in a browser, so the
// bit-banged buses below are built from queued edges and only flushed when a level has to
// be read. Without io.writeRegs (older bridges) everything degrades to one write per op.
export const DATE_REGS = { "esp32-s3": 0x60000080, "esp32-s2": 0x3f400080, "esp32-c3": 0x60000080, "esp32": 0x3ff40078 };
let DATE_REG = DATE_REGS["esp32-s3"];      // a mask-0 write to UART_DATE_REG is esptool's own "just delay" no-op
const BATCH_MAX = 32;                       // tuples per command (512 B) — far below the stub's buffer
class Pads {
  constructor(io) { this.io = io; this.saved = new Map(); this.q = []; }
  queue(addr, value, delayUs = 0) { this.q.push([addr >>> 0, value >>> 0, 0xffffffff, delayUs | 0]); }
  delayUs(us) { this.q.push([DATE_REG, 0, 0, us | 0]); }
  async flush() {
    const q = this.q; if (!q.length) return; this.q = [];
    if (this.io.writeRegs) { for (let i = 0; i < q.length; i += BATCH_MAX) await this.io.writeRegs(q.slice(i, i + BATCH_MAX)); return; }
    let pending = 0;                                                     // fallback: sub-ms spacing is already guaranteed by the link
    for (const [a, v, m, d] of q) { pending += d; if (m !== 0) { if (pending >= 1000) await sleep(Math.ceil(pending / 1000)); pending = 0; await this.io.writeReg(a, v); } }
    if (pending >= 1000) await sleep(Math.ceil(pending / 1000));
  }
  async sleep(ms) { await this.flush(); await sleep(ms); }               // a wait only means something once the queue is on the board
  async claim(pin) {
    if (this.saved.has(pin)) return;
    this.saved.set(pin, [await this.io.readReg(ioMux(pin)), await this.io.readReg(funcOutSel(pin))]);
    this.queue(funcOutSel(pin), 0x100);                                  // plain GPIO output signal
  }
  async input(pin, pull = 0) {                                           // high-Z input, optional internal pull
    await this.claim(pin);
    this.queue(EN_W1TC[bank(pin)], bit(pin));
    this.queue(ioMux(pin), MCU_SEL_GPIO | FUN_IE | pull);
  }
  async drive(pin, level) {                                              // push-pull at the weakest strength
    await this.claim(pin);
    this.queue(ioMux(pin), MCU_SEL_GPIO | FUN_IE);
    this.queue((level ? OUT_W1TS : OUT_W1TC)[bank(pin)], bit(pin));
    this.queue(EN_W1TS[bank(pin)], bit(pin));
  }
  async set(pin, level, delayUs = 0) { this.queue((level ? OUT_W1TS : OUT_W1TC)[bank(pin)], bit(pin), delayUs); }
  async read(pin) { await this.flush(); return (((await this.io.readReg(IN[bank(pin)])) >>> 0) & bit(pin)) !== 0; }
  async restore() {
    for (const [pin, [mux, sel]] of this.saved) {
      this.queue(EN_W1TC[bank(pin)], bit(pin));
      this.queue(ioMux(pin), mux);
      this.queue(funcOutSel(pin), sel);
    }
    this.saved.clear();
    await this.flush();
  }
}

const check = (id, title, status, detail, hint) => ({ id, title, status, detail: detail || "", ...(hint ? { hint } : {}) });

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

export async function pinChecks(io, protocol, fitted = {}) {
  const specs = protocol.pins.filter((p) => !UNSAFE.has(p.gpio));
  const fp = await pullFollow(io, specs.map((p) => p.gpio));
  const out = specs.map((spec) => {
    const level = fp[spec.gpio];
    let j;
    if (spec.part && fitted[spec.part] === false) {
      // declared not fitted: the pin should be left alone by anything
      j = level === "float" ? { status: "info", detail: `floats — ${protocol.optionalParts?.[spec.part] || spec.part} declared not fitted` }
        : { status: "warn", detail: `held ${level} although ${protocol.optionalParts?.[spec.part] || spec.part} is declared not fitted`, hint: "Something drives this pin — is the part fitted after all, or is there a bridge?" };
    } else j = judgePin(spec, level);
    return { ...check(`gpio${spec.gpio}`, `GPIO${spec.gpio} — ${spec.name}`, j.status, j.detail, j.hint), gpio: spec.gpio, level };
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
  // readFrom = index of the first byte whose reply matters: earlier bytes (opcode, address)
  // are clocked out blind inside one batch; later ones cost a read per bit. Mode 0, ~1 µs edges.
  const xfer = async (bytes, readFrom = 0) => {
    await pads.set(r.nss, 0, 1);
    const rx = [];
    for (let k = 0; k < bytes.length; k++) {
      let v = 0;
      for (let i = 7; i >= 0; i--) {
        await pads.set(r.mosi, (bytes[k] >> i) & 1);
        await pads.set(r.sck, 1, 1);
        if (k >= readFrom) v = (v << 1) | (await pads.read(r.miso) ? 1 : 0);
        await pads.set(r.sck, 0, 1);
      }
      rx.push(v);
    }
    await pads.set(r.nss, 1, 1);
    await pads.flush();
    return rx;
  };
  return { pads, xfer };
}

export async function radioChecks(io, protocol, fingerprint = {}) {
  const r = protocol.radio;
  if (!r) return [];
  // every module-driven line floating = nothing fitted / unpowered, not a bad joint
  const moduleSilent = [r.busy, r.dio1].filter((p) => p != null).every((p) => fingerprint[p] === "float");
  const out = [];
  const { pads, xfer } = await spiSession(io, r);
  try {
    // reset pulse through NRST (external pull-up releases it), then wait for BUSY to drop
    if (r.nrst != null) { await pads.drive(r.nrst, 0); await pads.sleep(5); await pads.input(r.nrst, 0); }
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
      const st = await xfer([0xc0, 0x00], 1);
      const status = st[1], mode = (status >> 4) & 7, cmd = (status >> 1) & 7;
      const id = await xfer([0x1d, 0x03, 0x20, 0x00, ...new Array(16).fill(0)], 4).then((b) => b.slice(4));
      const idStr = String.fromCharCode(...id).replace(/\0.*$/, "");
      const alive = /^SX126/.test(idStr);
      const modeName = { 2: "STDBY_RC", 3: "STDBY_XOSC", 4: "FS", 5: "RX", 6: "TX" }[mode] || `mode ${mode}`;
      out.push(check("radio", `LoRa radio — ${r.part || "SX126x"}`, alive ? "pass" : "fail",
        alive ? `answers: "${idStr}", ${modeName}, BUSY ${busyTrace.at(-1) === 0 ? "released" : "still high"}`
              : `no ID (${misoDriven ? "MISO is driven but the reply is garbage" : "MISO never driven"}; status 0x${(status ?? 0).toString(16)}; BUSY trace ${busyTrace.join("") || "n/a"})`,
        alive ? undefined
              : misoDriven ? `Something answers on MISO but not as an SX126x — check SCK/MOSI for bridges (GPIO${r.sck}/GPIO${r.mosi}) and NSS (GPIO${r.nss}).`
              : moduleSilent ? `Every line the module would drive (BUSY GPIO${r.busy}, DIO1 GPIO${r.dio1}, MISO GPIO${r.miso}) floats: ${r.part || "the radio module"} is not fitted, or has no 3V3/GND. If this unit is meant to have LoRa, populate/solder it; if it's a no-radio build, ignore the radio section.`
              : `The module is powered but not answering: check its SPI joints (MISO GPIO${r.miso}, NSS GPIO${r.nss}, SCK GPIO${r.sck}, MOSI GPIO${r.mosi}) and that BUSY (GPIO${r.busy}) drops after reset.`));
    } else if (r.type === "sx127x") {
      const v = (await xfer([0x42, 0x00], 1))[1];
      const alive = v === 0x12;
      out.push(check("radio", `LoRa radio — ${r.part || "SX127x"}`, alive ? "pass" : "fail",
        alive ? `RegVersion 0x12 (SX1276/RFM95)` : `RegVersion 0x${v.toString(16)} (${misoDriven ? "MISO driven" : "MISO never driven"})`,
        alive ? undefined : `Check the module is soldered and powered (MISO GPIO${r.miso}, NSS GPIO${r.nss}, SCK GPIO${r.sck}).`));
    }
  } finally { await pads.restore(); }
  return out;
}

// ---------------------------------------------------------------- antenna (RX-only)
// An antenna is the only way ambient RF reaches the receiver. Tune across the bands that
// carry strong downlinks nearly everywhere people solder boards (US/EU cellular, the ISM
// band itself), sit in RX and sample instantaneous RSSI. An open RF port gives a flat
// noise floor (~-110…-120 dBm at 500 kHz); an antenna lifts at least one band well above
// it. This never transmits. A quiet room looks like a missing antenna, so a flat floor
// is reported as "can't tell", not as a failure.
const ANTENNA_BANDS_MHZ = [739, 751, 869, 881, 894, 915, 933, 945, 957];
const RX_BW_500K = 0x06;

export async function antennaCheck(io, protocol, { samples = 8, bands = ANTENNA_BANDS_MHZ } = {}) {
  const r = protocol.radio;
  if (!r || r.type !== "sx126x") return null;
  const { pads, xfer } = await spiSession(io, r);
  const busyLow = async () => { for (let i = 0; i < 40; i++) { if (r.busy == null || !(await pads.read(r.busy))) return true; } return false; };
  const cmd = async (bytes) => { await busyLow(); return xfer(bytes, Infinity); };          // reply not needed
  const sweep = [];
  let errors = null;
  try {
    if (r.rfsw != null) await pads.drive(r.rfsw, 1);                          // power the module's antenna switch
    await cmd([0x80, 0x00]);                                                   // SetStandby(STDBY_RC)
    if (r.tcxoV) {                                                             // SetDio3AsTcxoCtrl: 1.6/1.7/1.8/2.2/2.4/2.7/3.0/3.3 V
      const code = { 1.6: 0, 1.7: 1, 1.8: 2, 2.2: 3, 2.4: 4, 2.7: 5, 3.0: 6, 3.3: 7 }[r.tcxoV] ?? 2;
      await cmd([0x97, code, 0x00, 0x01, 0x40]);                               // 5 ms start-up
    }
    await cmd([0x89, 0x7f]);                                                   // Calibrate all
    await pads.sleep(10); await busyLow();
    await cmd([0x07, 0x00, 0x00]);                                             // ClearDeviceErrors: XOSC_START_ERR is always raised once after a TCXO setup
    if (r.dio2Switch !== false) await cmd([0x9d, 0x01]);                       // SetDio2AsRfSwitchCtrl
    await cmd([0x8a, 0x01]);                                                   // packet type LoRa
    await cmd([0x8b, 0x07, RX_BW_500K, 0x01, 0x00]);                           // SF7 / 500 kHz / CR 4/5
    for (const mhz of bands) {
      const f = Math.round((mhz * 1e6) * 33554432 / 32e6) >>> 0;              // f * 2^25 / 32 MHz
      await cmd([0x86, (f >>> 24) & 0xff, (f >>> 16) & 0xff, (f >>> 8) & 0xff, f & 0xff]);
      await cmd([0x82, 0xff, 0xff, 0xff]);                                     // SetRx continuous
      await pads.sleep(4);
      const vals = [];
      for (let i = 0; i < samples; i++) { const rr = await xfer([0x15, 0x00, 0x00], 2); vals.push(-rr[2] / 2); }
      sweep.push({ mhz, max: Math.max(...vals), mean: vals.reduce((a, b) => a + b, 0) / vals.length });
      await cmd([0x80, 0x00]);
    }
    await busyLow(); const e = await xfer([0x17, 0x00, 0x00, 0x00], 2); errors = (e[2] << 8) | e[3];   // GetDeviceErrors
  } finally { try { await xfer([0x80, 0x00], Infinity); } catch {} await pads.restore(); }
  const floor = Math.min(...sweep.map((b) => b.mean));
  const peakBand = sweep.reduce((a, b) => (b.max > a.max ? b : a), sweep[0]);
  const lift = peakBand.max - floor;
  const fmt = sweep.map((b) => `${b.mhz}:${Math.round(b.max)}`).join(" ");
  const errTxt = errors ? ` (radio reports errors 0x${errors.toString(16)}:${errors & 0x20 ? " XOSC start" : ""}${errors & 0x40 ? " PLL lock" : ""}${errors & 0x08 ? " ADC calib" : ""}${errors & 0x01 ? " RC64k" : ""}${errors & 0x02 ? " RC13M" : ""}${errors & 0x04 ? " PLL calib" : ""}${errors & 0x10 ? " image calib" : ""}${errors & 0x100 ? " PA ramp" : ""})` : "";
  let status, detail, hint;
  if (peakBand.max >= -95 || lift >= 10) {
    status = errors & 0x60 ? "warn" : "pass"; detail = `hears ambient RF: ${peakBand.mhz} MHz at ${Math.round(peakBand.max)} dBm, floor ${Math.round(floor)} dBm${errTxt}`;
    if (errors & 0x60) hint = "The radio heard the antenna but flagged its oscillator/PLL — check the module's TCXO supply and crystal; re-run once.";
  } else {
    const cal = r.antennaCalibration;
    status = "warn"; detail = `flat noise floor ${Math.round(floor)}…${Math.round(peakBand.max)} dBm across ${sweep.length} bands (${Math.round(lift)} dB spread)${errTxt}`;
    hint = `No off-air signal reached the receiver: the antenna is most likely missing / not soldered to ${r.antPad || "the ANT pad"}` +
      (cal ? ` — a unit with its antenna reads about ${cal.withMax} dBm on the loudest band here, ${cal.withLift}+ dB above this floor` : "") +
      `. A truly RF-quiet spot looks the same, so if you're sure the antenna is on, move near a window or a phone and re-run. Never transmit until this passes.`;
  }
  return { ...check("antenna", "Antenna installed (RX-only listen)", status, detail, hint), sweep, floor, lift, errors, raw: fmt };
}

// ---------------------------------------------------------------- I2C
// Open-drain bit-bang from queued edges: START, the 8 address bits and the ACK clock go out
// in one batch (~150 kHz SCL from the stub's microsecond delays), one read samples the ACK,
// and STOP rides along with the next address — about 2 round-trips per address instead of ~35.
// The output latch stays low; "drive low" = output-enable, "release" = high-Z + pull-up.
export async function i2cScan(io, sda, scl, addrs) {
  const pads = new Pads(io);
  const lo = (p, d = 0) => pads.queue(EN_W1TS[bank(p)], bit(p), d);
  const hi = (p, d = 0) => pads.queue(EN_W1TC[bank(p)], bit(p), d);
  const found = [];
  try {
    for (const p of [sda, scl]) { await pads.input(p, 0); pads.queue(OUT_W1TC[bank(p)], bit(p)); }
    for (const addr of addrs) {
      lo(sda, 3); lo(scl, 3);                                            // START (bus idles high)
      const byte = (addr << 1) & 0xff;                                   // write direction
      let sdaLow = true;
      for (let i = 7; i >= 0; i--) {
        const want = !((byte >> i) & 1);                                 // true = pull SDA low
        if (want !== sdaLow) { (want ? lo : hi)(sda, 1); sdaLow = want; }
        hi(scl, 3); lo(scl, 3);
      }
      if (sdaLow) hi(sda, 1);                                            // release for the ACK slot
      hi(scl, 3);
      const ack = !(await pads.read(sda));
      lo(scl, 3); lo(sda, 2); hi(scl, 3); hi(sda, 3);                    // STOP
      if (ack) found.push(addr);
    }
  } finally { await pads.restore(); }
  return found;
}

export async function i2cChecks(io, protocol, fingerprint = {}) {
  const out = [];
  for (const bus of protocol.i2c || []) {
    const up = fingerprint[bus.sda] === "HIGH" && fingerprint[bus.scl] === "HIGH";
    if (!up) { out.push(check(`i2c-${bus.sda}`, `I2C scan — ${bus.name}`, "skip", "bus not pulled up (see the SDA/SCL pin checks)")); continue; }
    const found = await i2cScan(io, bus.sda, bus.scl, Array.from({ length: 0x78 - 0x08 }, (_, i) => 0x08 + i));
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

// ---------------------------------------------------------------- IR receiver (interactive)
// Rest level alone can't tell a receiver that's unpowered from one whose open-collector
// output simply has no internal pull-up. Both are "float"; only one of them still decodes
// light. Enable the chip's pull-up on OUT and sample as fast as the link allows while the
// user holds a remote at the board: a live receiver pulls the line low in bursts (NEC: a
// 9 ms leader, then 560 µs marks; repeats every 110 ms while held).
export async function irListen(io, protocol, { ms = 6000, onProgress = () => {}, restLevel = null } = {}) {
  const ir = protocol.ir;
  if (!ir) return null;
  const pads = new Pads(io);
  let samples = 0, lows = 0, transitions = 0, last = null;
  const t0 = Date.now();
  try {
    await pads.input(ir.gpio, FUN_PU);
    while (Date.now() - t0 < ms) {
      const v = await pads.read(ir.gpio);
      samples++; if (!v) lows++;
      if (last != null && v !== last) transitions++;
      last = v;
      if (samples % 200 === 0) onProgress({ samples, lows, transitions, elapsed: Date.now() - t0 });
    }
  } finally { await pads.restore(); }
  const rate = samples / ((Date.now() - t0) / 1000);
  const seen = transitions >= 6 && lows >= 3;
  let status, detail, hint;
  if (seen) {
    status = "pass"; detail = `decodes IR: ${transitions} edges, ${lows} low samples of ${samples} (${Math.round(rate)} samples/s)`;
    if (restLevel === "float") detail += " — its output idles floating (no/weak internal pull-up): firmware must enable INPUT_PULLUP on this pin or decoding will be unreliable";
  } else if (lows === samples && samples > 0) {
    status = "fail"; detail = "output stuck low the whole time"; hint = "Receiver fitted backwards, damaged, or OUT shorted to GND at U4.";
  } else {
    status = restLevel === "float" ? "fail" : "warn";
    detail = `no IR seen in ${(ms / 1000).toFixed(0)} s (${samples} samples, ${transitions} edges)`;
    hint = restLevel === "float"
      ? "Its output neither idles high nor reacts to a remote: the receiver isn't powered. On this footprint that is BUG #2 — a VCC-middle part (Gikfun-style) lands its VCC on the GND pad. Fit a GND-middle TSOP38238 / VS1838B with the OUT leg in the square pad, or measure Vs (D3-side pad) for ~4.6 V."
      : "The output idles high (powered) but no remote was seen — press and hold a button on a remote aimed at the board while this runs, then re-run.";
  }
  return { ...check("ir", `IR receiver — ${ir.name}`, status, detail, hint), samples, lows, transitions, rate };
}

// ---------------------------------------------------------------- beacon + firmware
export async function beacon(io, protocol, { blinks = 3, ms = 120 } = {}) {
  const b = protocol.beacon;
  if (!b) return null;
  const pads = new Pads(io);
  try { for (let i = 0; i < blinks; i++) { await pads.drive(b.gpio, 1); await pads.sleep(ms); await pads.drive(b.gpio, 0); await pads.sleep(ms); } }
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
  return { status, detail, hint, banners, resets, boots, invalid, panic, brownout, firmwareLines: fwLines, banner: parseFirmwareBanner(text) };
}

// What the firmware tells us about itself on the console: a name line, the LAN IP it got,
// its soft-AP address, a wiring variant. Enough to reach it over HTTP afterwards.
export function parseFirmwareBanner(text) {
  const clean = (text || "").replace(/\x1b\[[0-9;]*m/g, "");
  const ip = (clean.match(/\bIP (\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || null;
  const apip = (clean.match(/AP(?:IP| at| ip)?[:= ]+(\d{1,3}(?:\.\d{1,3}){3})/i) || [])[1] || null;
  const wiring = (clean.match(/wiring\s*:\s*([A-Za-z0-9_+\/() -]{1,40})/i) || [])[1]?.trim() || null;
  const nameLine = clean.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(Newsheen Radio|WLED|Meshtastic|MeshCore|CircuitPython)\b|I2S mic test/i.test(l)) || null;
  return { name: nameLine, ip, apip, wiring };
}

// ---------------------------------------------------------------- audio via the firmware
// Pure: turn the firmware's status JSON into a check. Fetching is the caller's job (Node can
// hit the LAN directly; a browser page can only offer links — the puck sends no CORS headers).
export function audioVerdict(protocol, statusJson, { ip = null } = {}) {
  const fa = protocol.firmwareAudio;
  const st = statusJson || {};
  const stateName = fa?.states?.[st.state] || `state ${st.state}`;
  const where = ip ? ` at ${ip}` : "";
  if (statusJson == null) return check("audio", "Audio — via the firmware", "info", `firmware${where} didn't answer /api/status`, "Open the puck's web UI and use Sing, or check it's on the same network.");
  if (st.state >= 1) return check("audio", "Audio — via the firmware", "pass", `${stateName}: ${[st.station, st.title].filter(Boolean).join(" — ")}${st.vol != null ? ` (vol ${st.vol})` : ""}${where}`);
  return check("audio", "Audio — via the firmware", "info", `firmware idle${where}`, `Trigger ${fa?.singPath || "/api/sing"} — a chiptune through the amp. If you hear it, the amplifier, its wiring and the speaker are good.`);
}
// Mic verdict from a console capture of the "I2S mic test" firmware while the user makes
// noise. Every sample reading exactly ±1 means the data line idles high with nothing driving
// it (0xFFFFFF = -1): no mic, no power, or DOUT not on the SD pin. Constant garbage means a
// clock/format problem; a level that moves means a microphone hearing the room.
export function micVerdict(protocol, text, { madeNoise = true } = {}) {
  const fm = protocol.firmwareMic;
  const rows = [...(text || "").matchAll(/chan([AB])\s+peak=\s*(-?\d+)\s+rms=\s*(-?\d+)/g)].map((m) => ({ ch: m[1], peak: Math.abs(+m[2]), rms: Math.abs(+m[3]) }));
  if (!rows.length) return check("mic", "Microphone — via the firmware", "info", "no mic-test lines seen on the console", "Only the I2S mic test firmware reports samples; for WLEDkitty-audio use its web UI's Audio Source reading.");
  const byCh = {};
  for (const r of rows) (byCh[r.ch] ||= []).push(r);
  const summary = Object.entries(byCh).map(([ch, v]) => `chan${ch} rms ${Math.min(...v.map((x) => x.rms))}…${Math.max(...v.map((x) => x.rms))} (${v.length})`).join(", ");
  const live = Object.values(byCh).some((v) => {
    const body = v.slice(2);                                   // skip the start-up burst
    const distinct = new Set(body.map((x) => x.rms)).size;
    return body.length >= 4 && distinct >= 3 && body.some((x) => x.rms > 4);
  });
  const stuck = Object.values(byCh).every((v) => v.slice(2).every((x) => x.peak <= 1 && x.rms <= 1));
  const pins = fm?.pins ? ` (WS GPIO${fm.pins.ws}, SCK GPIO${fm.pins.sck}, SD GPIO${fm.pins.sd})` : "";
  if (live) return check("mic", "Microphone — via the firmware", "pass", `hears the room: ${summary}`);
  if (stuck) return check("mic", "Microphone — via the firmware", madeNoise ? "fail" : "warn", `every sample reads ±1: the data line idles high with nothing driving it — ${summary}`,
    `No microphone data${pins}. The mic is missing, unpowered (VIN/GND on J3), or its DOUT isn't wired to the SD pin; check SEL too. A live mic never returns a flat ±1 even in silence.`);
  return check("mic", "Microphone — via the firmware", "warn", `constant or garbage samples: ${summary}`, `Data arrives but doesn't follow sound — suspect BCLK/WS wiring${pins} or the I2S format (SPH0645 needs left-justified, 24-bit in 32).`);
}
export function audioLinks(protocol, ip) {
  const fa = protocol.firmwareAudio;
  if (!fa || !ip) return [];
  return [{ label: "What's playing", href: `http://${ip}${fa.statusPath}` }, { label: "Make it sing", href: `http://${ip}${fa.singPath}` }];
}

// ---------------------------------------------------------------- the exam
export async function runExam(io, protocol, { chip = {}, images = null, fitted = {}, onStep = () => {}, doBridges = true, doRadio = true, doAntenna = true, doI2c = true, doBeacon = true } = {}) {
  const t0 = Date.now();
  DATE_REG = DATE_REGS[protocol.mcu] || DATE_REGS["esp32-s3"];
  const timings = {}; let cur = null, tCur = 0;
  const step = (name) => { if (cur) timings[cur] = Date.now() - tCur; cur = name; tCur = Date.now(); onStep(name); };
  const checks = [];
  const declaredAbsent = Object.entries(protocol.optionalParts || {}).filter(([k]) => fitted[k] === false).map(([, name]) => name);
  if (declaredAbsent.length) checks.push(check("declared", "Declared not fitted", "info", declaredAbsent.join(", ")));
  step("identity"); checks.push(...await identityChecks(io, protocol, chip));
  step("pins");     const pins = await pinChecks(io, protocol, fitted); checks.push(...pins.checks);
  if (doBridges) { step("bridges"); checks.push(...(await bridgeChecks(io, protocol, pins.fingerprint)).checks); }
  if (doRadio && protocol.radio && fitted.radio === false) {
    checks.push(check("radio", `LoRa radio — ${protocol.radio.part || "module"}`, "info", "declared not fitted — radio and antenna checks skipped"));
  } else if (doRadio) {
    step("radio"); const radio = await radioChecks(io, protocol, pins.fingerprint); checks.push(...radio);
    if (doAntenna && radio.some((c) => c.id === "radio" && c.status === "pass")) { step("antenna"); const a = await antennaCheck(io, protocol); if (a) checks.push(a); }
  }
  if (doI2c)     { step("i2c");     checks.push(...await i2cChecks(io, protocol, pins.fingerprint)); }
  step("firmware"); const fw = await firmwareCheck(io, images); if (fw) checks.push(fw);
  if (doBeacon)  { step("beacon");  const b = await beacon(io, protocol); if (b) checks.push(b); }
  const counts = { pass: 0, warn: 0, fail: 0, info: 0, skip: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const verdict = counts.fail ? "needs-rework" : counts.warn ? "check" : "healthy";
  if (cur) timings[cur] = Date.now() - tCur;
  return { board: protocol.name, line: protocol.line, chip, fitted, checks, counts, verdict, fingerprint: pins.fingerprint, timings, ops: io.stats ? { ...io.stats } : undefined, ms: Date.now() - t0 };
}
