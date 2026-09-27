#!/usr/bin/env node
// Tests for web/vetprobe.js ("Diagnose my cat") — the shipped module, imported unmodified.
//
//   node scripts/test_vetprobe.mjs                              synthetic boards only
//   node scripts/test_vetprobe.mjs --rom /dev/cu.X --stub       real board in download mode / HWCDC app
//        [--protocol newsheen] [--boot-watch] (watchdog-reset into the firmware afterwards and read
//        its console for 6 s) [--not-fitted radio,ir] (declare optional parts this unit doesn't
//        carry) [--no-reset] [--ssh pi@host] [--json out.json]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vet = await import(path.join(here, "..", "web", "vetprobe.js"));
const probe = await import(path.join(here, "..", "web", "boardprobe.js"));
const { PROTOCOLS } = await import(path.join(here, "..", "web", "vet-protocols.js"));
const BRIDGE = path.join(here, "probe_bridge.py");
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
let failures = 0;
async function test(name, fn) { try { await fn(); console.log(`  ok    ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e.message}`); } }

// ------------------------------------------------------------------ a register-level board
// parts: { [gpio]: "pullup" | "low" | "high" }   bridges: [[a,b],…]   radio: "sx126x" | null
const GPIO = 0x60004000, OUT = [GPIO + 0x04, GPIO + 0x10], EN = [GPIO + 0x20, GPIO + 0x2c];
function FakeBoard({ parts = {}, bridges = [], radio = "sx126x", radioPins = PROTOCOLS.newsheen.radio, psramCap = 2, flashCap = 0, env = "newsheen-puck", rssi = () => -118 } = {}) {
  const regs = new Map(); let ops = 0;
  const out = [0, 0], en = [0, 0];
  const mux = (p) => regs.get(0x60009004 + 4 * p) ?? 0;
  const bit = (p) => (1 << (p % 32)) >>> 0, bank = (p) => (p < 32 ? 0 : 1);
  const isOut = (p) => (en[bank(p)] & bit(p)) !== 0, outLvl = (p) => (out[bank(p)] & bit(p)) ? 1 : 0;
  const peers = (p) => bridges.flatMap(([a, b]) => (a === p ? [b] : b === p ? [a] : []));
  // SX126x slave on the SPI pins
  const R = radioPins; const spi = { nss: 1, sck: 0, byteIdx: 0, bits: 0, rx: 0, cmd: null, miso: 0, resp: 0, args: [], mhz: 915 };
  const REG320 = [..."SX1261 V2D 2D02\0"].map((c) => c.charCodeAt(0));
  const STATUS = (2 << 4) | (1 << 1);
  const respByte = (k) => (spi.cmd === 0x1d && k >= 4 ? (REG320[k - 4] ?? 0) : spi.cmd === 0x15 && k === 2 ? Math.round(-2 * rssi(spi.mhz)) & 0xff : spi.cmd === 0x17 && k >= 2 ? 0 : STATUS);   // GetDeviceErrors: none
  const loadBit = () => { spi.miso = (spi.resp >> (7 - spi.bits)) & 1; };
  function level(p) {
    if (isOut(p)) return outLvl(p);
    for (const q of peers(p)) { if (isOut(q)) return outLvl(q); if (parts[q] === "pullup" || parts[q] === "high") return 1; if (parts[q] === "low") return 0; }
    if (radio && p === R.miso) return spi.nss === 0 ? spi.miso : ((mux(p) & (1 << 8)) ? 1 : 0);
    const ext = parts[p]; if (ext === "pullup" || ext === "high") return 1; if (ext === "low") return 0;
    return (mux(p) & (1 << 8)) ? 1 : 0;
  }
  function spiTick() {
    if (!radio) return;
    const nss = isOut(R.nss) ? outLvl(R.nss) : 1, sck = isOut(R.sck) ? outLvl(R.sck) : 0;
    if (spi.nss === 1 && nss === 0) { spi.byteIdx = 0; spi.bits = 0; spi.rx = 0; spi.cmd = null; spi.resp = respByte(0); loadBit(); }
    if (spi.nss === 0 && nss === 0 && spi.sck === 0 && sck === 1) {           // rising edge: sample MOSI
      spi.rx = ((spi.rx << 1) | level(R.mosi)) & 0xff; spi.bits++;
      if (spi.bits === 8) {
        if (spi.byteIdx === 0) { spi.cmd = spi.rx; spi.args = []; } else spi.args.push(spi.rx);
        if (spi.cmd === 0x86 && spi.args.length === 4) spi.mhz = Math.round((((spi.args[0] << 24) | (spi.args[1] << 16) | (spi.args[2] << 8) | spi.args[3]) >>> 0) * 32e6 / 33554432 / 1e6);
        spi.byteIdx++; spi.bits = 0; spi.rx = 0; spi.resp = respByte(spi.byteIdx);
      }
    }
    if (spi.nss === 0 && spi.sck === 1 && sck === 0) loadBit();               // falling edge: next MISO bit
    spi.nss = nss; spi.sck = sck;
  }
  const board = {
    get ops() { return ops; }, regs,
    async readReg(a) {
      ops++;
      if (a === GPIO + 0x3c || a === GPIO + 0x40) { const b = a === GPIO + 0x3c ? 0 : 1; let w = 0; for (let i = 0; i < 32; i++) if (level(b * 32 + i)) w |= 1 << i; return w >>> 0; }
      if (a === 0x60007050) return (flashCap << 27) >>> 0;
      if (a === 0x60007054) return (psramCap << 3) >>> 0;
      return regs.get(a) ?? 0xa00;
    },
    async writeReg(a, v) {
      ops++; v >>>= 0;
      const tbl = { [GPIO + 0x08]: ["out", 0, 1], [GPIO + 0x0c]: ["out", 0, 0], [GPIO + 0x14]: ["out", 1, 1], [GPIO + 0x18]: ["out", 1, 0],
                    [GPIO + 0x24]: ["en", 0, 1], [GPIO + 0x28]: ["en", 0, 0], [GPIO + 0x30]: ["en", 1, 1], [GPIO + 0x34]: ["en", 1, 0] };
      const t = tbl[a];
      if (t) { const arr = t[0] === "out" ? out : en; arr[t[1]] = t[2] ? (arr[t[1]] | v) >>> 0 : (arr[t[1]] & ~v) >>> 0; spiTick(); return; }
      regs.set(a, v);
    },
    async readFlash(addr, n) {
      const img = new Uint8Array(0x50000).fill(0xff); img[0x10000] = 0xe9; img.set([0x32, 0x54, 0xcd, 0xab], 0x10020);
      if (env) img.set(new TextEncoder().encode(`/x/.pio/libdeps/${env}/a.cpp\0`), 0x10000 + 6000);
      return img.subarray(addr, addr + n);
    },
  };
  return board;
}
const HEALTHY = { 4: "pullup", 17: "pullup", 35: "pullup", 36: "pullup", 9: "pullup", 10: "pullup", 47: "low", 21: "low", 38: "low", 39: "pullup", 40: "pullup" };
const chipInfo = { chipName: "ESP32-S3 (QFN56) (revision v0.2)", mac: "a4:cb:8f:00:00:00", flashId: 0x182020 };   // 16 MB XMC
const P = PROTOCOLS.newsheen;
const by = (r, id) => r.checks.find((c) => c.id === id);

console.log("synthetic");
await test("healthy puck: every check passes, radio identified, no bridges, verdict healthy", async () => {
  const r = await vet.runExam(FakeBoard({ parts: HEALTHY, rssi: (mhz) => (mhz === 869 ? -90 : -116) }), P, { chip: chipInfo, doBeacon: false });
  const bad = r.checks.filter((c) => c.status === "fail" || c.status === "warn");
  assert.deepEqual(bad, [], JSON.stringify(bad));
  assert.equal(r.verdict, "healthy");
  assert.match(by(r, "radio").detail, /SX1261 V2D 2D02.*STDBY_RC/);
  assert.equal(by(r, "flash").detail, "16 MB (XMC)"); assert.equal(by(r, "psram").status, "pass");
  assert.match(by(r, "bridges").detail, /none among \d+ neighbouring pairs/);
  assert.match(by(r, "i2c-35").detail, /nothing fitted/); assert.match(by(r, "firmware").detail, /newsheen-puck/);
});
await test("BUG #1 (U5 DIR strapped): GPIO16 held low -> fail with the bodge hint", async () => {
  const r = await vet.runExam(FakeBoard({ parts: { ...HEALTHY, 16: "low" } }), P, { chip: chipInfo, doBeacon: false });
  assert.equal(by(r, "gpio16").status, "fail"); assert.match(by(r, "gpio16").hint, /U5 pin 5 \(DIR\) to pin 6/); assert.equal(r.verdict, "needs-rework");
});
await test("BUG #2 (IR receiver unpowered / wrong pinout): GPIO4 floats -> fail", async () => {
  const parts = { ...HEALTHY }; delete parts[4];
  const r = await vet.runExam(FakeBoard({ parts }), P, { chip: chipInfo, doBeacon: false });
  assert.equal(by(r, "gpio4").status, "fail"); assert.match(by(r, "gpio4").hint, /VCC-middle/);
});
await test("antenna: a strong band lifts RSSI -> pass; flat floor -> warn; skipped when the radio failed", async () => {
  const withAnt = FakeBoard({ parts: HEALTHY, rssi: (mhz) => (mhz === 881 ? -84 : -117 + (mhz % 3)) });
  let r = await vet.runExam(withAnt, P, { chip: chipInfo, doBeacon: false });
  assert.equal(by(r, "antenna").status, "pass"); assert.match(by(r, "antenna").detail, /881 MHz at -84 dBm/);
  assert.equal(by(r, "antenna").sweep.length, 9);
  const noAnt = FakeBoard({ parts: HEALTHY, rssi: () => -118 });
  r = await vet.runExam(noAnt, P, { chip: chipInfo, doBeacon: false });
  assert.equal(by(r, "antenna").status, "warn"); assert.match(by(r, "antenna").hint, /Never transmit/);
  assert.equal(r.verdict, "check");
  const parts = { ...HEALTHY }; delete parts[47]; delete parts[21];
  r = await vet.runExam(FakeBoard({ parts, radio: null }), P, { chip: chipInfo, doBeacon: false });
  assert.equal(by(r, "antenna"), undefined, "no antenna check without a live radio");
});
await test("declared not fitted: a no-radio, no-IR build comes out healthy; a driven 'absent' pin still warns", async () => {
  const parts = { ...HEALTHY }; delete parts[47]; delete parts[21]; delete parts[4];
  let r = await vet.runExam(FakeBoard({ parts, radio: null }), P, { chip: chipInfo, doBeacon: false, fitted: { radio: false, ir: false } });
  assert.equal(r.verdict, "healthy", JSON.stringify(r.checks.filter((c) => c.status !== "pass" && c.status !== "info")));
  assert.equal(by(r, "radio").status, "info"); assert.equal(by(r, "gpio4").status, "info"); assert.equal(by(r, "antenna"), undefined);
  assert.match(by(r, "declared").detail, /Wio-SX1262.*IR receiver/);
  r = await vet.runExam(FakeBoard({ parts: HEALTHY }), P, { chip: chipInfo, doBeacon: false, fitted: { ir: false } });
  assert.equal(by(r, "gpio4").status, "warn", "IR declared absent but its output is pulled up");
});
await test("radio module missing: BUSY/DIO1 float, MISO never driven -> radio fail + warns", async () => {
  const parts = { ...HEALTHY }; delete parts[47]; delete parts[21];
  const r = await vet.runExam(FakeBoard({ parts, radio: null }), P, { chip: chipInfo, doBeacon: false });
  assert.equal(by(r, "radio").status, "fail"); assert.match(by(r, "radio").detail, /MISO never driven/); assert.equal(by(r, "gpio47").status, "warn");
  assert.match(by(r, "radio").hint, /not fitted/, "all module lines float -> 'not fitted' wording");
  // module powered (BUSY low) but SPI dead -> joint wording
  const r2 = await vet.runExam(FakeBoard({ parts: HEALTHY, radio: null }), P, { chip: chipInfo, doBeacon: false });
  assert.match(by(r2, "radio").hint, /SPI joints/);
});
await test("solder bridge GPIO37<->GPIO38 (J3 header pins) is found by the active test, not by rest levels", async () => {
  const r = await vet.runExam(FakeBoard({ parts: HEALTHY, bridges: [[37, 38]] }), P, { chip: chipInfo, doBeacon: false });
  assert.ok(r.checks.some((c) => c.id === "bridge-37-38" && c.status === "fail"), JSON.stringify(r.checks.filter((c) => c.id.startsWith("bridge"))));
  assert.equal(by(r, "gpio37").status, "warn", "rest level also shows it held (follows 38's ROM level)");
});
await test("pulled-up neighbours are not false bridges (17 next to 16 and 18; 9 next to 10)", async () => {
  const r = await vet.runExam(FakeBoard({ parts: HEALTHY }), P, { chip: chipInfo, doBeacon: false });
  assert.equal(r.checks.filter((c) => c.id.startsWith("bridge-")).length, 0);
});
await test("wrong module (N16R8 octal PSRAM) -> PSRAM check fails with the GPIO33-37 warning", async () => {
  const r = await vet.runExam(FakeBoard({ parts: HEALTHY, psramCap: 1 }), P, { chip: chipInfo, doBeacon: false });
  assert.equal(by(r, "psram").status, "fail"); assert.match(by(r, "psram").hint, /GPIO33-37/);
  const r2 = await vet.runExam(FakeBoard({ parts: HEALTHY }), P, { chip: { ...chipInfo, flashId: 0x162020 }, doBeacon: false });
  assert.equal(by(r2, "flash").status, "fail");
});
await test("battery wired straight to TP4: GPIO1 held high -> fail", async () => {
  const r = await vet.runExam(FakeBoard({ parts: { ...HEALTHY, 1: "high" } }), P, { chip: chipInfo, doBeacon: false });
  assert.equal(by(r, "gpio1").status, "fail"); assert.match(by(r, "gpio1").hint, /divider/);
});
await test("every pad the exam touched is restored", async () => {
  const b = FakeBoard({ parts: HEALTHY });
  await vet.runExam(b, P, { chip: chipInfo, doBeacon: false });
  const dirty = [...b.regs.entries()].filter(([a, v]) => a >= 0x60009004 && a < 0x60009004 + 4 * 49 && v !== 0xa00);
  assert.deepEqual(dirty, [], "IO_MUX left modified: " + JSON.stringify(dirty.map(([a]) => (a - 0x60009004) / 4)));
  assert.equal((await b.readReg(GPIO + 0x20)) >>> 0, 0xa00, "no output-enables left set (reg untouched)");
});
await test("analyzeBootLog: clean boot / reboot loop / blank flash / brownout / TinyUSB takeover", () => {
  const banner = (rst, boot) => `ESP-ROM:esp32s3-20210327\nBuild:Mar 27 2021\nrst:${rst}\nboot:${boot}\nSaved PC:0x40041a76\n`;
  const rc = (t, o) => vet.analyzeBootLog(t, o);
  assert.equal(rc(banner("0x15 (USB_UART_CHIP_RESET)", "0x8 (SPI_FAST_FLASH_BOOT)") + "entry 0x403c98b8\n").status, "pass");
  assert.equal(rc(banner("0xc (RTC_SW_CPU_RST)", "0x8 (SPI_FAST_FLASH_BOOT)").repeat(4)).status, "fail");
  assert.match(rc(banner("0x15 (USB_UART_CHIP_RESET)", "0x8 (SPI_FAST_FLASH_BOOT)") + "invalid header: 0xffffffff\n".repeat(3)).detail, /blank or corrupt/);
  assert.match(rc(banner("0xf (BROWN_OUT_RESET)", "0x8 (SPI_FAST_FLASH_BOOT)").repeat(2)).hint, /rails/);
  assert.equal(rc("", { vanishedAfterMs: 900 }).status, "pass");
  assert.equal(rc(banner("0x15 (USB_UART_CHIP_RESET)", "0x0 (DOWNLOAD(USB/UART0))") + "waiting for download\n").status, "warn");
});

// ------------------------------------------------------------------ hardware
function lines(child) { return createInterface({ input: child.stdout })[Symbol.asyncIterator](); }
function bridgeCmd(args, dev) {
  const ssh = opt("--ssh");
  if (!ssh) return ["python3", [BRIDGE, ...args]];
  return ["ssh", ["-T", "-o", "BatchMode=yes", ssh, "~/sk/with_port.sh", dev, "python3", "~/sk/probe_bridge.py", ...args]];
}
async function romIo(dev, stub, noReset) {
  const [cmd, cargs] = bridgeCmd(["esptool", dev, ...(stub ? ["--stub"] : []), ...(noReset ? ["--no-reset"] : [])], dev);
  const child = spawn(cmd, cargs, { stdio: ["pipe", "pipe", "inherit"] });
  const it = lines(child);
  const hello = JSON.parse((await it.next()).value);
  const rpc = async (req) => { child.stdin.write(JSON.stringify(req) + "\n"); return JSON.parse((await it.next()).value); };
  return {
    hello,
    readReg: async (a) => (await rpc({ op: "r", a })).v,
    writeReg: async (a, v, m) => { const r = await rpc({ op: "w", a, v: v >>> 0, ...(m != null ? { m: m >>> 0 } : {}) }); if (r.ok === false) throw new Error(r.error); },
    ...(stub ? { readFlash: async (a, n) => new Uint8Array(Buffer.from((await rpc({ op: "f", a, n })).d, "base64")) } : {}),
    close: async () => { try { await rpc({ op: "q" }); } catch {} child.kill(); },
  };
}
async function readConsole(dev, ms) {
  const [cmd, cargs] = bridgeCmd(["serial", dev, "--dtr-low"], dev);
  const child = spawn(cmd, cargs, { stdio: ["pipe", "pipe", "inherit"] });
  const it = lines(child);
  const first = await it.next();
  if (first.value !== "READY") { child.kill(); throw new Error(`console: ${first.value}`); }
  let text = ""; const t0 = Date.now();
  const timer = setTimeout(() => { try { child.stdin.write("Q\n"); } catch {} child.kill(); }, ms);
  for await (const l of it) { if (l.startsWith("D ")) text += Buffer.from(l.slice(2), "base64").toString("utf8"); if (Date.now() - t0 > ms) break; }
  clearTimeout(timer); child.kill();
  return text;
}
const icon = { pass: "✓", warn: "!", fail: "✗", info: "·", skip: "–" };
function printReport(r) {
  console.log(`\n${r.board} — ${r.verdict.toUpperCase()}  (${r.counts.pass} pass, ${r.counts.warn} warn, ${r.counts.fail} fail, ${r.ms} ms)`);
  for (const c of r.checks) console.log(`  ${icon[c.status]} ${c.title}: ${c.detail}${c.raw ? `\n      sweep (MHz:max dBm) ${c.raw}` : ""}${c.hint ? `\n      ↳ ${c.hint}` : ""}`);
}

if (opt("--rom")) {
  const dev = opt("--rom"), stub = argv.includes("--stub"), proto = PROTOCOLS[opt("--protocol") || "newsheen"];
  const bootWatch = argv.includes("--boot-watch");
  console.log(`\nhardware: ${proto.name} on ${dev}`);
  const io = await romIo(dev, stub, bootWatch || argv.includes("--no-reset"));
  console.log("        ", JSON.stringify(io.hello));
  let report;
  await test("exam runs to completion", async () => {
    const fitted = Object.fromEntries((opt("--not-fitted") || "").split(",").filter(Boolean).map((k) => [k.trim(), false]));
    report = await vet.runExam(io, proto, { chip: { chipName: io.hello.chip, mac: io.hello.mac, flashId: io.hello.flash_id }, fitted, onStep: (s) => process.stdout.write(`        ${s}… `) });
    console.log();
    printReport(report);
  });
  if (bootWatch && report) {
    await test("boot watch: watchdog-reset into the firmware and read its console", async () => {
      const t0 = Date.now();
      await probe.s3ResetToApp(io);
      await io.close();
      await new Promise((r) => setTimeout(r, 1500));
      let text = "";
      for (let i = 0; i < 4; i++) { try { text = await readConsole(dev, 6000); break; } catch (e) { await new Promise((r) => setTimeout(r, 800)); if (i === 3) throw e; } }
      const b = vet.analyzeBootLog(text);
      report.checks.push({ id: "boot", title: "Boots into its firmware", status: b.status, detail: b.detail, ...(b.hint ? { hint: b.hint } : {}) });
      console.log(`        ${icon[b.status]} boot: ${b.detail}${b.hint ? ` ↳ ${b.hint}` : ""}  [${text.length} bytes, ${Math.round((Date.now() - t0) / 100) / 10}s]`);
      console.log("        console:", JSON.stringify(text.slice(0, 400)));
    });
  } else await io.close();
  if (opt("--json") && report) fs.writeFileSync(opt("--json"), JSON.stringify(report, null, 1));
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
