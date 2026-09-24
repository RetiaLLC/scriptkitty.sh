// boardprobe.js — tells same-silicon boards apart for "Detect my board".
//
// esptool can't separate the Bluetooth Nugget (LOLIN S3 Mini) from the Nibble line
// (Waveshare S3-Zero): same ESP32-S3FH4R2, same 4 MB flash, same ROM USB ID. But the
// carrier PCBs hang different parts on different GPIOs, and the ROM loader's
// READ_REG / WRITE_REG / READ_FLASH let us look — no firmware needs to be running.
// Layers, cheapest first; each one only runs if it can still change the answer:
//
//   usbHint()          USB PID of a running TinyUSB firmware          free      hint only
//   pullFollow()       which pins have external pull-ups / drivers    ~60 ops   decides the family
//   i2cAck()           is there a display on the Nibble I2C bus       ~45 ops   Connect vs the rest
//   appInfoFromFlash() ELF hash + PlatformIO env of the installed app  16 KB     picks the exact model
//                      (hash -> catalog image when it's one of ours; env name otherwise)
//
// No DOM and no esptool import — I/O arrives as
//   io = { readReg(addr), writeReg(addr, value), readFlash(addr, size) }
// so scripts/test_boardprobe.mjs drives this exact file from Node against a real board.
// (Asking *running* Meshtastic for its env was measured too slow and flaky to live here:
// see scripts/research/meshtastic_query.mjs.)

// ---------------------------------------------------------------------------
// USB identity. Web Serial exposes VID/PID only, and a PID just names the board
// definition the *firmware* was built with (the ROM loader and HWCDC builds are all
// 303a:1001; Retia BadUSB spoofs 05ac:020b) — a hint, never a verdict.
// PIDs from espressif/usb-pids allocated-pids.txt.
export const ESPRESSIF_VID = 0x303a;
const USB_PID_HINTS = {
  0x8167: "bluetooth-nugget", // LOLIN S3 Mini — Arduino
  0x8168: "bluetooth-nugget", // LOLIN S3 Mini — CircuitPython
  0x8169: "bluetooth-nugget", // LOLIN S3 Mini — UF2 bootloader
  0x822b: "nibble",           // Waveshare ESP32-S3-Zero — Arduino
  0x822c: "nibble",           // Waveshare ESP32-S3-Zero — CircuitPython/MicroPython
  0x822d: "nibble",           // Waveshare ESP32-S3-Zero — UF2 bootloader
  0x81b3: "nibble",           // Waveshare ESP32-S3-Zero — UF2 bootloader (older)
  0x81b4: "nibble",           // Waveshare ESP32-S3-Zero — CircuitPython (upstream build)
};
export function usbHint(info) {
  if (!info || info.usbVendorId !== ESPRESSIF_VID) return null;
  return USB_PID_HINTS[info.usbProductId] || null;
}

// ---------------------------------------------------------------------------
// Firmware env. PlatformIO builds leak their env name through __FILE__ paths
// (".pio/libdeps/<env>/…"), and the env names the exact board variant. In every Meshtastic
// image in the catalog the first hit is 5-8 KB into the app; MeshCore's is within 180 KB.
// Env names below are the ones actually embedded in the shipped images (the live Nibble
// Zero build really is spelled "nibble-zero-connet"). First match wins.
const PIO_ENV_MAP = [
  [/^nugget-s2/, "usb-nugget", null],
  [/^nugget/, "bluetooth-nugget", null],
  [/screen[-_]connect/, "nibble", "Nibble Screen Connect"],
  [/zero[-_]conn/, "nibble", "Nibble Zero"],
  [/^nibble[-_]rp2/, "nibble-rp2040", null],
  [/^nibble.*(sx1262|connect)/, "nibble", "Nibble Connect"],
  [/^nibble/, "nibble", "Nibble OG (S3)"],
  [/dcbadge/, "defcon-badge", null],
  [/newsheen|pusheen|puck/, "newsheen", null],
];
export function lineForPioEnv(env) {
  for (const [re, line, model] of PIO_ENV_MAP) if (re.test(env || "")) return { line, model };
  return null;
}

const APP_OFFSET = 0x10000;          // first app partition in every catalog image
const ENV_HEAD = 0x4000;             // Meshtastic: env is in the first 16 KB
const ENV_MORE = 0x2c000;            // MeshCore & co: look 176 KB further, once
const ENV_RE = /\.pio\/libdeps\/([A-Za-z0-9_.-]+)\//;
const latin1 = new TextDecoder("latin1");
// esp_app_desc_t sits at app+0x20 (magic 0xABCD5432); esptool patches the build's ELF
// SHA-256 in at desc+0x90. Unique per build — the catalog's index.json carries it as
// `app_elf_sha256` per image, so 32 bytes identify "which of our images is on here".
const APP_DESC = 0x20, APP_DESC_MAGIC = [0x32, 0x54, 0xcd, 0xab], ELF_SHA_AT = 0x90;

// One 16 KB read answers both questions; the 176 KB follow-up only happens when the env
// wasn't in the head AND the caller still needs it (a catalog hash hit makes it moot).
export async function appInfoFromFlash(readFlash, { deep = true, needEnv = () => true } = {}) {
  const head = await readFlash(APP_OFFSET, ENV_HEAD);
  if (!head || head[0] !== 0xe9) return { env: null, elfSha: null };  // no ESP app image here
  let elfSha = null;
  if (APP_DESC_MAGIC.every((b, i) => head[APP_DESC + i] === b)) {
    elfSha = [...head.subarray(APP_DESC + ELF_SHA_AT, APP_DESC + ELF_SHA_AT + 32)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let m = ENV_RE.exec(latin1.decode(head));
  if (!m && deep && needEnv(elfSha)) {
    const overlap = 96;                                               // a path may straddle the seam
    m = ENV_RE.exec(latin1.decode(await readFlash(APP_OFFSET + ENV_HEAD - overlap, ENV_MORE + overlap)));
  }
  return { env: m ? m[1] : null, elfSha };
}
export async function envFromFlash(readFlash, opts) { return (await appInfoFromFlash(readFlash, opts)).env; }

// ---------------------------------------------------------------------------
// Electrical fingerprint (ESP32-S3 register map).
const GPIO = 0x60004000;
const OUT_W1TC = GPIO + 0x0c;
const EN_W1TS = [GPIO + 0x24, GPIO + 0x30];
const EN_W1TC = [GPIO + 0x28, GPIO + 0x34];
const IN = [GPIO + 0x3c, GPIO + 0x40];
const funcOutSel = (pin) => GPIO + 0x554 + 4 * pin;
const ioMux = (pin) => 0x60009004 + 4 * pin;
const FUN_PD = 1 << 7, FUN_PU = 1 << 8, FUN_IE = 1 << 9, MCU_SEL_GPIO = 1 << 12;
const bank = (pin) => (pin < 32 ? 0 : 1);
const bit = (pin) => (1 << (pin % 32)) >>> 0;

// Never probed: 0/3/45/46 straps, 19/20 USB D-/D+, 26-32 in-package flash + PSRAM,
// 43/44 UART0 (the ROM drives TX).
const UNSAFE = new Set([0, 3, 19, 20, 26, 27, 28, 29, 30, 31, 32, 43, 44, 45, 46]);

// Pull-follow test, entirely passive (only the chip's ~45 k internal pulls are switched,
// nothing is driven): sample every pin with pull-DOWN on, again with pull-UP on.
//   (0,1) "float" nothing attached      (1,1) "HIGH" external pull-up / driven high
//   (0,0) "LOW"   driven / pulled low   (1,0) "noise"
// Batched so N pins cost 4N+6 register ops instead of 7N.
export async function pullFollow(io, pins) {
  for (const p of pins) if (UNSAFE.has(p)) throw new Error(`GPIO${p} is not safe to probe`);
  const saved = new Map();
  for (const p of pins) saved.set(p, await io.readReg(ioMux(p)));
  const banks = [...new Set(pins.map(bank))];
  const sample = async (pull) => {
    for (const p of pins) await io.writeReg(ioMux(p), MCU_SEL_GPIO | FUN_IE | pull);
    const words = [0, 0];
    for (const b of banks) words[b] = (await io.readReg(IN[b])) >>> 0;
    return words;
  };
  let down, up;
  try {
    for (const b of banks) {
      const mask = pins.filter((p) => bank(p) === b).reduce((m, p) => (m | bit(p)) >>> 0, 0);
      await io.writeReg(EN_W1TC[b], mask);               // make sure we're not driving any of them
    }
    down = await sample(FUN_PD);
    up = await sample(FUN_PU);
  } finally {
    for (const p of pins) await io.writeReg(ioMux(p), saved.get(p));
  }
  const fp = {};
  for (const p of pins) {
    const d = (down[bank(p)] & bit(p)) ? 1 : 0, u = (up[bank(p)] & bit(p)) ? 1 : 0;
    fp[p] = d ? (u ? "HIGH" : "noise") : (u ? "float" : "LOW");
  }
  return fp;
}

// One I2C address probe, bit-banged open-drain: a line is only ever pulled LOW (output
// latch 0, toggle output-enable) and released to the board's own pull-ups — never driven
// high. Only call this on pins pullFollow() reported HIGH (i.e. a real pulled-up bus).
export async function i2cAck(io, sda, scl, addr) {
  if (sda >= 32 || scl >= 32) throw new Error("i2cAck: bank-0 pins only");
  const pins = [sda, scl], saved = [];
  for (const p of pins) for (const reg of [ioMux(p), funcOutSel(p)]) saved.push([reg, await io.readReg(reg)]);
  const lo = (p) => io.writeReg(EN_W1TS[0], bit(p));
  const hi = (p) => io.writeReg(EN_W1TC[0], bit(p));
  let ack = false;
  try {
    await io.writeReg(EN_W1TC[0], (bit(sda) | bit(scl)) >>> 0);
    await io.writeReg(OUT_W1TC, (bit(sda) | bit(scl)) >>> 0);
    for (const p of pins) { await io.writeReg(funcOutSel(p), 0x100); await io.writeReg(ioMux(p), MCU_SEL_GPIO | FUN_IE); }
    await lo(sda); await lo(scl);                                    // START (bus idles high)
    const byte = (addr << 1) & 0xff;                                 // write direction
    let sdaLow = true;
    for (let i = 7; i >= 0; i--) {
      const want = !((byte >> i) & 1);                               // true = pull SDA low
      if (want !== sdaLow) { await (want ? lo(sda) : hi(sda)); sdaLow = want; }
      await hi(scl); await lo(scl);
    }
    if (sdaLow) await hi(sda);                                       // release for the ACK slot
    await hi(scl);
    ack = (((await io.readReg(IN[0])) >>> 0) & bit(sda)) === 0;
    await lo(scl);
    await lo(sda); await hi(scl); await hi(sda);                     // STOP
  } finally {
    await io.writeReg(EN_W1TC[0], (bit(sda) | bit(scl)) >>> 0);
    for (const [reg, val] of saved) await io.writeReg(reg, val);
  }
  return ack;
}

// Signatures. "measured" = read off real hardware (scripts/fingerprints/); the rest come
// from the KiCad netlists and still want a bench confirmation.
//   Bluetooth Nugget   35,36 HIGH  4.7k display I2C pull-ups            (measured: 1 unit)
//                      — and the S3-Zero doesn't even bond out GPIO33-37, so no Nibble can
//                        ever load these two pins.
//   Nibble OG (S3)     4,9 HIGH    10k on RFM95 RESET/NSS; 5 = DIO0     (netlist)
//   Nibble Zero /      6,10 HIGH   10k on SX1262 RESET/NSS              (measured: 2 Zeros +
//   Connect / Screen   7,8 HIGH    10k I2C; 5 LOW = BUSY idle            1 Screen Connect)
//   Screen Connect     1,2 HIGH    pull-ups on the A/B buttons — both Zeros float here.
//                      (1 unit; treated as a preference between the two, not a verdict)
// Not signatures: GPIO4 (SX1262 DIO1) follows the radio's IRQ state; the Nugget's button
// lines float (the schematic's 10k pull-ups aren't fitted); GPIO38 LOW / 39-40 HIGH show up
// on every S3 in ROM mode (JTAG pins). 21/47 — the two dev modules' RGB LED data pins — read
// HIGH on the S3-Zero and LOW on the S3 Mini (one unit each); logged, not voting.
const S3_PROBE_PINS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 21, 35, 36, 47];
const OLED_ADDR = 0x3c;

export function classifyS3FourMeg(fp, { oled = null } = {}) {
  const high = (...pins) => pins.every((p) => fp[p] === "HIGH");
  const evidence = [];
  const nugget = high(35, 36);
  const sx1262Family = high(6, 10);
  const og = high(4, 9) && !sx1262Family;
  const nibbleBus = high(7, 8);
  if (nugget) evidence.push("display pull-ups on GPIO35/36");
  if (sx1262Family) evidence.push("SX1262 reset/select pull-ups on GPIO6/10");
  if (og) evidence.push("RFM95 reset/select pull-ups on GPIO4/9");
  if (nibbleBus) evidence.push("I2C pull-ups on GPIO7/8");
  if (oled === true) evidence.push("display answers at 0x3C on GPIO8/7");
  const abPullups = high(1, 2);
  if (abPullups && oled === true) evidence.push("button pull-ups on GPIO1/2 (Screen Connect)");

  const nibble = sx1262Family || og || nibbleBus;
  if (nugget === nibble) return { line: null, models: [], evidence };   // neither, or contradictory
  if (nugget) return { line: "bluetooth-nugget", models: [], evidence };

  // Models only ever re-order / badge the Nibble sub-groups — every build stays visible —
  // so a provisional guess here is cheap to be wrong about.
  let models = [];
  if (og) models = ["Nibble OG (S3)"];
  // Zero vs Screen Connect: same radio, same display bus. The one Screen Connect measured
  // has pull-ups on the A/B buttons and both Zeros don't — enough to order the two, not
  // to drop one. Firmware/catalog evidence narrows it further when available.
  else if (oled === true) models = abPullups ? ["Nibble Screen Connect", "Nibble Zero"] : ["Nibble Zero", "Nibble Screen Connect"];
  // Screenless SX1262 board = Connect (from the product line-up; not yet bench-confirmed).
  else if (sx1262Family && oled === false) models = ["Nibble Connect"];
  return { line: "nibble", models, evidence };
}

// Full pass for an ESP32-S3 with 4 MB flash. `io` talks to the ROM loader or the flasher
// stub (readFlash needs the stub; leave it off and the firmware layer is skipped).
// `images` maps app_elf_sha256 -> { line, model, id, name, version } for every catalog image.
// Hardware decides the family; firmware (catalog hash first, env name second) may only
// narrow the model *within* that family, or speak up when the pins match nothing — a board
// flashed with the wrong build must not be able to talk its way into the wrong family.
export async function probeS3FourMeg(io, { images = null } = {}) {
  let ops = 0;
  const counted = {
    readReg: (a) => { ops++; return io.readReg(a); },
    writeReg: (a, v) => { ops++; return io.writeReg(a, v); },
  };
  const t0 = Date.now();
  const fingerprint = await pullFollow(counted, S3_PROBE_PINS);
  let oled = null;
  const first = classifyS3FourMeg(fingerprint);
  // The display probe drives pins, so it only runs where it can change the answer and
  // where the passive pass already proved a pulled-up bus: SX1262-family Nibbles.
  if (first.line === "nibble" && !first.models.length) {
    const bus = fingerprint[7] === "HIGH" && fingerprint[8] === "HIGH";
    oled = bus ? await i2cAck(counted, 8, 7, OLED_ADDR) : false;   // no pulled-up bus -> nothing to ACK
  }
  let { line, models, evidence } = classifyS3FourMeg(fingerprint, { oled });
  let source = line ? "pins" : null, env = null, elfSha = null, installed = null;

  if (io.readFlash && (!line || (line === "nibble" && models.length !== 1))) {
    try {
      ({ env, elfSha } = await appInfoFromFlash(io.readFlash, { deep: true, needEnv: (sha) => !(images && sha && images[sha]) }));
    } catch { env = null; elfSha = null; }
    installed = (images && elfSha && images[elfSha]) || null;
    // what the installed firmware says the board is: exact catalog image beats env name
    const fw = installed ? { line: installed.line, model: installed.model || null }
             : env ? lineForPioEnv(env) : null;
    const via = installed ? "catalog" : "firmware";
    if (fw && !line) {
      ({ line } = fw); models = fw.model ? [fw.model] : []; source = via;
    } else if (fw && fw.line === line && fw.model && (!models.length || models.includes(fw.model))) {
      models = [fw.model]; source = `pins+${via}`;
    }
    if (installed) evidence = [...evidence, `running our ${installed.name}${installed.version ? " " + installed.version : ""} image`];
    else if (env) evidence = [...evidence, `installed firmware was built for "${env}"`];
  }
  return { line, models, source, evidence, fingerprint, oled, env, elfSha, installed, ops, ms: Date.now() - t0 };
}
