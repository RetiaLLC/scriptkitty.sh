#!/usr/bin/env node
// Tests for web/boardprobe.js — the file the site ships, imported unmodified.
//
//   node scripts/test_boardprobe.mjs                       synthetic tests only (no hardware)
//   node scripts/test_boardprobe.mjs --rom /dev/cu.X       + real board in DOWNLOAD mode
//        [--stub]  go through the flasher stub, as the site does after loader.main() —
//                  required for the flash (firmware env) layer
//   node scripts/test_boardprobe.mjs --serial /dev/cu.X    research only: ask RUNNING Meshtastic
//        [--expect-line nibble] [--expect-model "Nibble Zero"]
//        [--no-reset]    leave the board in the ROM loader afterwards (a board whose app
//                        firmware has no usable USB must never be rebooted by a test)
//        [--all-pins]    also dump every probe-safe GPIO (signature research for new boards)
//        [--ssh pi@host] run the bridge on a workbench Pi (direct USB) instead of locally;
//                        expects ~/sk/probe_bridge.py + ~/sk/with_port.sh there
//
// Hardware modes go through scripts/probe_bridge.py (pyserial / esptool).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = await import(path.join(here, "..", "web", "boardprobe.js"));
const mesh = await import(path.join(here, "research", "meshtastic_query.mjs"));
const BRIDGE = path.join(here, "probe_bridge.py");

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// --------------------------------------------------------------------------- synthetic
console.log("synthetic");

await test("usbHint maps board-definition PIDs, ignores ROM/HWCDC and foreign VIDs", () => {
  assert.equal(probe.usbHint({ usbVendorId: 0x303a, usbProductId: 0x8168 }), "bluetooth-nugget");
  assert.equal(probe.usbHint({ usbVendorId: 0x303a, usbProductId: 0x81b4 }), "nibble");
  assert.equal(probe.usbHint({ usbVendorId: 0x303a, usbProductId: 0x1001 }), null);
  assert.equal(probe.usbHint({ usbVendorId: 0x05ac, usbProductId: 0x020b }), null);
  assert.equal(probe.usbHint({}), null);
});

await test("lineForPioEnv covers every env name embedded in the shipped catalog images", () => {
  const cases = {
    "nugget-s3-lora": ["bluetooth-nugget", null],
    "nugget-bluetooth-rmf95": ["bluetooth-nugget", null],
    "nugget": ["bluetooth-nugget", null],                  // oui-spy
    "nibble_screen_connect_repeater": ["nibble", "Nibble Screen Connect"],   // MeshCore
    "nibble_zero_connect_repeater_": ["nibble", "Nibble Zero"],
    "nugget-s2-rfm95": ["usb-nugget", null],
    "nibble-esp32": ["nibble", "Nibble OG (S3)"],
    "nibble-esp32_sx1262": ["nibble", "Nibble Connect"],
    "nibble-connect": ["nibble", "Nibble Connect"],
    "nibble-screen-connect": ["nibble", "Nibble Screen Connect"],
    "nibble-zero-connect": ["nibble", "Nibble Zero"],
    "nibble-zero-connet": ["nibble", "Nibble Zero"],       // sic — the live 2.7.17 build
    "nibble-rp2040": ["nibble-rp2040", null],
    "retia_dcbadge-tft": ["defcon-badge", null],
  };
  for (const [env, [line, model]] of Object.entries(cases)) {
    assert.deepEqual(probe.lineForPioEnv(env), { line, model }, env);
  }
  assert.equal(probe.lineForPioEnv("heltec-v3"), null);
});

// hand-built FromRadio frames
const str = (s) => [...new TextEncoder().encode(s)];
const lenDelim = (field, bytes) => [(field << 3) | 2, bytes.length, ...bytes];
const frame = (body) => Uint8Array.from([0x94, 0xc3, body.length >> 8, body.length & 0xff, ...body]);
const myInfo = (env) => frame([0x08, 0x07, ...lenDelim(3, [0x08, 0xe5, 0xf9, 0x83, 0x94, 0x0d, 0x40, 0x03, ...lenDelim(13, str(env))])]);
const metadata = (ver) => frame(lenDelim(13, lenDelim(1, str(ver))));

await test("MeshtasticSniffer: frames split across chunks, log text interleaved", () => {
  const s = new mesh.MeshtasticSniffer();
  const log = Uint8Array.from(str("\x1b[32mINFO \x1b[0m| 21:35:03 66 [Router] hello\r\n"));
  const a = myInfo("nibble-zero-connect"), b = metadata("2.7.23.b246bcd");
  const all = Uint8Array.from([...log, ...a, ...log, ...b]);
  for (let i = 0; i < all.length; i += 7) s.feed(all.subarray(i, i + 7));
  assert.equal(s.pioEnv, "nibble-zero-connect");
  assert.equal(s.firmwareVersion, "2.7.23.b246bcd");
  assert.equal(s.frames, 2);
});

await test("MeshtasticSniffer: survives garbage, bogus lengths and a false magic", () => {
  const s = new mesh.MeshtasticSniffer();
  s.feed(Uint8Array.from([0x94, 0xc3, 0xff, 0xff, 1, 2, 3, 0x94, 0xc3, 0x00]));   // oversize len, then partial
  s.feed(Uint8Array.from([0x03, 0xff, 0xff, 0xff]));                                 // completes a junk frame
  s.feed(myInfo("nibble-esp32"));
  assert.equal(s.pioEnv, "nibble-esp32");
});

await test("classifyS3FourMeg: every board signature, plus the ambiguous cases", () => {
  const fp = (over) => ({ 4: "float", 5: "float", 6: "float", 7: "float", 8: "float", 9: "float", 10: "float",
    12: "float", 13: "float", 18: "float", 21: "float", 35: "float", 36: "float", 47: "float", ...over });
  const c = (over, extra) => { const r = probe.classifyS3FourMeg(fp(over), extra); return [r.line, r.models]; };
  assert.deepEqual(c({ 35: "HIGH", 36: "HIGH", 12: "HIGH", 13: "HIGH", 18: "HIGH" }), ["bluetooth-nugget", []]);
  assert.deepEqual(c({ 35: "HIGH", 36: "HIGH", 12: "LOW" }), ["bluetooth-nugget", []], "button held");
  assert.deepEqual(c({ 4: "HIGH", 9: "HIGH", 5: "LOW" }), ["nibble", ["Nibble OG (S3)"]]);
  // measured on a real Nibble Zero, 2026-09-21
  const zero = { 4: "LOW", 5: "LOW", 6: "HIGH", 7: "HIGH", 8: "HIGH", 10: "HIGH", 21: "HIGH" };
  assert.deepEqual(c(zero, { oled: true }), ["nibble", ["Nibble Zero", "Nibble Screen Connect"]]);
  assert.deepEqual(c(zero, { oled: false }), ["nibble", ["Nibble Connect"]]);
  assert.deepEqual(c(zero), ["nibble", []]);
  assert.deepEqual(c({}), [null, []], "bare dev board");
  assert.deepEqual(c({ 35: "HIGH", 36: "HIGH", 6: "HIGH", 10: "HIGH" }), [null, []], "contradictory");
  assert.deepEqual(c({ 35: "HIGH" }), [null, []], "one display line only is not a Nugget");
});

// Register-level model of a board: external parts per pin, internal pulls from IO_MUX.
function fakeChip(external) {
  const reg = new Map(); let ops = 0;
  const level = (pin) => {
    if (external[pin] === "pullup") return 1;
    if (external[pin] === "low") return 0;
    const mux = reg.get(0x60009004 + 4 * pin) || 0;
    return mux & (1 << 8) ? 1 : 0;                       // floating: follows the internal pull
  };
  return {
    get ops() { return ops; }, reg,
    async readReg(a) {
      ops++;
      if (a === 0x6000403c || a === 0x60004040) {
        let w = 0; const base = a === 0x6000403c ? 0 : 32;
        for (let b = 0; b < 32; b++) if (level(base + b)) w |= 1 << b;
        return w >>> 0;
      }
      return reg.get(a) ?? 0xa00;
    },
    async writeReg(a, v) { ops++; reg.set(a, v >>> 0); },
  };
}

await test("pullFollow: classifies, costs 4N+6 ops, restores every IO_MUX register", async () => {
  const chip = fakeChip({ 35: "pullup", 36: "pullup", 5: "low", 6: "pullup" });
  const pins = [4, 5, 6, 35, 36];
  const fp = await probe.pullFollow(chip, pins);
  assert.deepEqual(fp, { 4: "float", 5: "LOW", 6: "HIGH", 35: "HIGH", 36: "HIGH" });
  assert.equal(chip.ops, 4 * pins.length + 6);
  for (const p of pins) assert.equal(chip.reg.get(0x60009004 + 4 * p), 0xa00, `GPIO${p} restored`);
});

await test("pullFollow: refuses USB, flash/PSRAM, strap and UART0 pins", async () => {
  for (const p of [0, 19, 20, 26, 32, 43, 44, 45]) {
    await assert.rejects(() => probe.pullFollow(fakeChip({}), [p]), /not safe/, `GPIO${p}`);
  }
});

// A flash image: ESP app header at 0x10000, env path planted `at` bytes into the app.
function fakeFlash(env, at) {
  const img = new Uint8Array(0x10000 + 0x40000).fill(0xff);
  img[0x10000] = 0xe9;
  if (env) img.set(new TextEncoder().encode(`/x/.pio/libdeps/${env}/NimBLE/src/a.cpp\0`), 0x10000 + at);
  let reads = 0, bytes = 0;
  return { get reads() { return reads; }, get bytes() { return bytes; },
    readFlash: async (a, n) => { reads++; bytes += n; return img.subarray(a, a + n); } };
}

await test("envFromFlash: Meshtastic-style hit costs one 16 KB read; deep hit, seam and blanks", async () => {
  let f = fakeFlash("nibble-zero-connet", 6 * 1024);
  assert.equal(await probe.envFromFlash(f.readFlash), "nibble-zero-connet");
  assert.deepEqual([f.reads, f.bytes], [1, 0x4000]);
  f = fakeFlash("nibble_screen_connect_repeater", 178 * 1024);
  assert.equal(await probe.envFromFlash(f.readFlash), "nibble_screen_connect_repeater");
  assert.equal(f.reads, 2);
  f = fakeFlash("nibble-esp32", 0x4000 - 20);                       // path straddles the two reads
  assert.equal(await probe.envFromFlash(f.readFlash), "nibble-esp32");
  assert.equal(await probe.envFromFlash(fakeFlash(null, 0).readFlash), null);
  const blank = { readFlash: async (a, n) => new Uint8Array(n).fill(0xff) };
  assert.equal(await probe.envFromFlash(blank.readFlash), null, "erased flash: no app header, one read");
});

await test("probeS3FourMeg: firmware narrows the model but can never override the pins", async () => {
  const zeroPins = { 4: "low", 5: "low", 6: "pullup", 7: "pullup", 8: "pullup", 10: "pullup", 21: "pullup" };
  // I2C slave model is out of scope for fakeChip, so SDA just stays high -> no ACK -> "Connect" guess…
  let r = await probe.probeS3FourMeg({ ...fakeChip(zeroPins), ...fakeFlash("nibble-zero-connect", 6000) });
  assert.deepEqual([r.line, r.models, r.source], ["nibble", ["Nibble Connect"], "pins"], "single model: flash never read");
  // …pins that match nothing: firmware may name the board
  r = await probe.probeS3FourMeg({ ...fakeChip({}), ...fakeFlash("nibble-screen-connect", 6000) });
  assert.deepEqual([r.line, r.models, r.source], ["nibble", ["Nibble Screen Connect"], "firmware"]);
  // Nugget pins + Nibble firmware (the mis-flash this whole feature exists to prevent): pins win
  r = await probe.probeS3FourMeg({ ...fakeChip({ 35: "pullup", 36: "pullup" }), ...fakeFlash("nibble-esp32", 6000) });
  assert.deepEqual([r.line, r.models, r.source, r.env], ["bluetooth-nugget", [], "pins", null]);
  // no readFlash (ROM loader, no stub): pins only, no throw
  r = await probe.probeS3FourMeg(fakeChip({}));
  assert.deepEqual([r.line, r.source], [null, null]);
});

// --------------------------------------------------------------------------- hardware
function lines(child) { return createInterface({ input: child.stdout })[Symbol.asyncIterator](); }

// Web-Serial-shaped port backed by the pyserial bridge.
class BridgePort {
  constructor(dev) { this.dev = dev; }
  getInfo() { return {}; }
  async open() {
    const [cmd, cargs] = bridgeCmd(["serial", this.dev], this.dev);
    this.child = spawn(cmd, cargs, { stdio: ["pipe", "pipe", "inherit"] });
    const it = lines(this.child);
    const first = await it.next();
    if (first.value !== "READY") throw new Error(`bridge: ${first.value}`);
    let cancelled = false;
    this.readable = new ReadableStream({
      async pull(ctrl) {
        const { value, done } = await it.next();
        if (done || cancelled) { try { ctrl.close(); } catch {} return; }
        if (value.startsWith("D ")) ctrl.enqueue(new Uint8Array(Buffer.from(value.slice(2), "base64")));
      },
      cancel() { cancelled = true; },
    });
    const child = this.child;
    this.writable = new WritableStream({
      write(chunk) { child.stdin.write(`W ${Buffer.from(chunk).toString("base64")}\n`); },
    });
  }
  async setSignals() {}
  async close() { try { this.child.stdin.write("Q\n"); } catch {} this.child.kill(); }
}

// Local: python3 bridge …   Remote: ssh host ~/sk/with_port.sh DEV python3 ~/sk/probe_bridge.py …
// (with_port.sh pauses whatever holds DEV — the slot's RFC2217 proxy — for the duration.)
function bridgeCmd(args, dev) {
  const ssh = opt("--ssh");
  if (!ssh) return ["python3", [BRIDGE, ...args]];
  return ["ssh", ["-T", "-o", "BatchMode=yes", ssh, "~/sk/with_port.sh", dev, "python3", "~/sk/probe_bridge.py", ...args]];
}

async function romIo(dev, stub) {
  const extra = [...(stub ? ["--stub"] : []), ...(argv.includes("--no-reset") ? ["--no-reset"] : [])];
  const before = opt("--before"); if (before) extra.push("--before", before);
  const [cmd, cargs] = bridgeCmd(["esptool", dev, ...extra], dev);
  const child = spawn(cmd, cargs, { stdio: ["pipe", "pipe", "inherit"] });
  const it = lines(child);
  const hello = JSON.parse((await it.next()).value);
  const rpc = async (req) => { child.stdin.write(JSON.stringify(req) + "\n"); return JSON.parse((await it.next()).value); };
  return {
    hello,
    readReg: async (a) => (await rpc({ op: "r", a })).v,
    writeReg: async (a, v) => { await rpc({ op: "w", a, v: v >>> 0 }); },
    ...(stub ? { readFlash: async (a, n) => new Uint8Array(Buffer.from((await rpc({ op: "f", a, n })).d, "base64")) } : {}),
    close: async () => { await rpc({ op: "q" }); child.kill(); },
  };
}

const expectLine = opt("--expect-line"), expectModel = opt("--expect-model");

if (opt("--serial")) {
  console.log(`hardware: running firmware on ${opt("--serial")}`);
  await test("queryMeshtastic identifies the board without resetting it", async () => {
    const r = await mesh.queryMeshtastic(new BridgePort(opt("--serial")));
    console.log("        ->", JSON.stringify(r));
    assert.ok(r, "no Meshtastic answer");
    if (expectLine) assert.equal(r.line, expectLine);
    if (expectModel) assert.equal(r.model, expectModel);
  });
}

if (opt("--rom")) {
  const stub = argv.includes("--stub");
  console.log(`hardware: ${stub ? "flasher stub" : "ROM loader"} on ${opt("--rom")}`);
  const io = await romIo(opt("--rom"), stub);
  console.log("        ", JSON.stringify(io.hello));
  await test("probeS3FourMeg identifies the board", async () => {
    const r = await probe.probeS3FourMeg(io);
    console.log("        ->", JSON.stringify(r));
    if (expectModel && stub) assert.deepEqual(r.models, [expectModel], "with flash access the model should be exact");
    if (expectLine) assert.equal(r.line, expectLine);
    if (expectModel) assert.ok(r.models.includes(expectModel), `models ${JSON.stringify(r.models)}`);
  });
  if (argv.includes("--all-pins")) {
    const all = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 47, 48];
    const fp = await probe.pullFollow(io, all);
    const by = {};
    for (const [p, s] of Object.entries(fp)) (by[s] ||= []).push(Number(p));
    console.log("        all-pins ->", JSON.stringify(by));
  }
  await test("i2cAck: nothing answers at 0x3D, and a second pull-follow still matches (pins restored)", async () => {
    const before = await probe.pullFollow(io, [7, 8]);
    if (before[7] === "HIGH" && before[8] === "HIGH") assert.equal(await probe.i2cAck(io, 8, 7, 0x3d), false);
    assert.deepEqual(await probe.pullFollow(io, [7, 8]), before);
  });
  await io.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
