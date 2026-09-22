// meshtastic_query.mjs — RESEARCH, not shipped. Ask a *running* Meshtastic board which
// build it is: FromRadio.my_info (field 3) carries MyNodeInfo.pio_env (field 13).
//
// Why it isn't in web/boardprobe.js: measured 2026-09-21 on a Nibble Zero running a
// TinyUSB-CDC Meshtastic 2.7.23 build, the reply took 0.3-11 s, arrived within a 12 s
// budget only about half the time, sometimes surfaced a whole port-session late, and
// never came at all with RTS high. Far too slow and flaky for the detect path. The same
// env name is readable from flash in ~0.1 s (boardprobe.js envFromFlash), so detect uses
// that instead. Parser + query kept because they're tested and may suit the serial
// monitor page, where a multi-second wait is fine.
//
//   import { queryMeshtastic, MeshtasticSniffer } from "./meshtastic_query.mjs";

import { lineForPioEnv } from "../../web/boardprobe.js";

const STREAM_MAGIC = [0x94, 0xc3];
const MAX_FRAME = 512;
// ToRadio{ want_config_id = 42 } behind the 4-byte stream header — small enough to
// hand-assemble, so the site needs no protobuf library.
const WANT_CONFIG = Uint8Array.of(0x94, 0xc3, 0x00, 0x02, 0x18, 0x2a);
const WAKE = new Uint8Array(32).fill(0xc3);

function readVarint(buf, i) {
  let v = 0, mul = 1;
  for (let n = 0; n < 10 && i < buf.length; n++) {
    const b = buf[i++];
    v += (b & 0x7f) * mul; mul *= 128;   // Number, not |: tags are tiny, big values are only skipped
    if (!(b & 0x80)) return [v, i];
  }
  return [null, i];
}
// Yields [fieldNumber, wireType, bytes|number] for one protobuf message; stops quietly on garbage.
function* pbFields(buf) {
  let i = 0;
  while (i < buf.length) {
    let tag, len, v;
    [tag, i] = readVarint(buf, i);
    if (tag == null) return;
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) { [v, i] = readVarint(buf, i); if (v == null) return; yield [field, wire, v]; }
    else if (wire === 1) { i += 8; }
    else if (wire === 5) { i += 4; }
    else if (wire === 2) {
      [len, i] = readVarint(buf, i);
      if (len == null || i + len > buf.length) return;
      yield [field, wire, buf.subarray(i, i + len)]; i += len;
    } else return;
  }
}
const utf8 = new TextDecoder();

// Incremental parser for the Meshtastic serial stream (frames are interleaved with plain
// debug-log text, which the magic search skips).
export class MeshtasticSniffer {
  constructor() { this.buf = new Uint8Array(0); this.frames = 0; this.pioEnv = null; this.firmwareVersion = null; }
  feed(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    let i = 0;
    for (;;) {
      while (i + 1 < merged.length && !(merged[i] === STREAM_MAGIC[0] && merged[i + 1] === STREAM_MAGIC[1])) i++;
      if (i + 4 > merged.length) break;
      const len = (merged[i + 2] << 8) | merged[i + 3];
      if (len > MAX_FRAME) { i += 2; continue; }
      if (i + 4 + len > merged.length) break;           // partial frame — wait for more
      this._frame(merged.subarray(i + 4, i + 4 + len));
      i += 4 + len;
    }
    this.buf = merged.slice(Math.min(i, merged.length));
  }
  _frame(body) {
    this.frames++;
    for (const [field, wire, val] of pbFields(body)) {
      if (wire !== 2) continue;
      if (field === 3) {                                  // FromRadio.my_info
        for (const [f, w, v] of pbFields(val)) if (f === 13 && w === 2) this.pioEnv = utf8.decode(v);
      } else if (field === 13) {                          // FromRadio.metadata
        for (const [f, w, v] of pbFields(val)) if (f === 1 && w === 2) this.firmwareVersion = utf8.decode(v);
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens `port` (Web Serial) at 115200, asks for the config stream, closes the port again.
// Resolves { pioEnv, firmwareVersion, line, model, ms } or null when nothing Meshtastic-
// shaped answers. Never resets the board: DTR is raised (TinyUSB CDC firmware won't talk
// without it) and RTS stays low (RTS high = total silence on the TinyUSB build). Writes
// made right after open get swallowed, and every want_config restarts the device's config
// state machine — so send late and re-send sparingly.
export async function queryMeshtastic(port, { timeoutMs = 12000, resendAtMs = [400, 3000] } = {}) {
  const t0 = Date.now();
  await port.open({ baudRate: 115200 });
  const sniffer = new MeshtasticSniffer();
  let reader = null, writer = null, reading = true;
  try {
    try { await port.setSignals({ dataTerminalReady: true, requestToSend: false }); } catch { /* not all ports support it */ }
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    const pump = (async () => {
      try {
        while (reading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) sniffer.feed(value);
        }
      } catch { /* port went away / cancelled */ }
    })();
    const sends = [...resendAtMs];
    let envAt = 0;
    for (;;) {
      const now = Date.now() - t0;
      if (sniffer.pioEnv && !envAt) envAt = now;
      // version arrives a few frames after my_info — give it a moment, but don't hold the result for it
      if (envAt && (sniffer.firmwareVersion || now - envAt > 250)) break;
      if (!envAt && now > timeoutMs) break;
      if (!sniffer.frames && sends.length && now >= sends[0]) {
        sends.shift();
        try { await writer.write(WAKE); await writer.write(WANT_CONFIG); } catch { break; }
      }
      await sleep(15);
    }
    reading = false;
    try { await reader.cancel(); } catch {}
    await pump;
  } finally {
    try { reader && reader.releaseLock(); } catch {}
    try { writer && writer.releaseLock(); } catch {}
    try { await port.close(); } catch {}
  }
  if (!sniffer.pioEnv) return null;
  const hit = lineForPioEnv(sniffer.pioEnv) || { line: null, model: null };
  return { pioEnv: sniffer.pioEnv, firmwareVersion: sniffer.firmwareVersion, ...hit, ms: Date.now() - t0 };
}
