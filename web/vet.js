// vet.js — "Diagnose my cat": the browser side of vetprobe.js. Connects like the Flash
// page (same esptool-js, same TinyUSB touch fallback, same S3 watchdog reset), runs the
// protocol's exam, then reboots the board and reads its console for the boot verdict.
import { PROTOCOLS } from "./vet-protocols.js";
import * as vet from "./vetprobe.js";
import * as probe from "./boardprobe.js";
import { LAYOUTS } from "./vet-layouts.js";
import { renderBoard, boardHighlights, sweepChartSvg, irLiveHtml } from "./vet-board.js";

const $ = (id) => document.getElementById(id);
const HAS_SERIAL = "serial" in navigator;
if (!HAS_SERIAL) { $("unsupported").hidden = false; $("diagnose").disabled = true; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CAT = {
  idle: ` /\\_/\\\n( o.o )\n (")_(")`, working: ` /\\_/\\\n( o.o )7\n (")_(")`,
  healthy: ` /\\_/\\\n( ^.^ )♥\n (")_(")`, check: ` /\\_/\\\n( o.o )?\n (")_(")`, rework: ` /\\_/\\\n( x.x )\n (")_(")`,
};
function mascot(phase, title, sub) {
  $("heroCat").textContent = CAT[phase] || CAT.idle;
  $("vetHero").dataset.phase = phase;
  if (title) $("heroTitle").textContent = title;
  if (sub) $("heroSub").textContent = sub;
}
function status(html, kind = "busy") { const el = $("status"); el.hidden = false; el.className = `banner banner-detect banner-${kind}`; el.innerHTML = html; }
function progress(frac) { $("heroBar").hidden = frac == null; if (frac != null) $("heroBarFill").style.width = `${Math.round(frac * 100)}%`; }

for (const [key, p] of Object.entries(PROTOCOLS)) { const o = document.createElement("option"); o.value = key; o.textContent = p.name; $("protocol").append(o); }
// "This unit has…" — the selected protocol's optional parts (Auto: the union over all
// protocols); a part left unchecked is checked for being genuinely absent and reported as
// info, not as a fault. Parts a board usually ships without start unticked.
function renderParts(key) {
  const protos = key && PROTOCOLS[key] ? [PROTOCOLS[key]] : Object.values(PROTOCOLS);
  const prev = fittedFromUi();
  const parts = {}, absent = new Set();
  for (const p of protos) {
    for (const [k, name] of Object.entries(p.optionalParts || {})) parts[k] = parts[k] || name;
    for (const k of p.defaultAbsent || []) absent.add(k);
  }
  $("parts").replaceChildren();
  for (const [k, name] of Object.entries(parts)) {
    const l = document.createElement("label"); l.className = "ctl ctl-check"; l.title = "Untick if this unit is a build without this part";
    const on = k in prev ? prev[k] : !(absent.size && absent.has(k) && protos.length === 1);
    l.innerHTML = `<input type="checkbox" data-part="${escapeHtml(k)}" ${on ? "checked" : ""} /> has ${escapeHtml(name)}`;
    $("parts").append(l);
  }
}
$("protocol").addEventListener("change", () => renderParts($("protocol").value === "auto" ? null : $("protocol").value));
const fittedFromUi = () => Object.fromEntries([...document.querySelectorAll("#parts input[data-part]")].map((i) => [i.dataset.part, i.checked]));
renderParts(null);

// --- ports: same rules as the Flash page — a single remembered board is reused, the ROM
// after a TinyUSB touch is a new device the browser must be shown once.
let esptoolMod = null;
const loadEsptool = () => esptoolMod || (esptoolMod = import("./vendor/esptool-js/bundle.js"));
// Every image the catalog ships, keyed by the ELF hash esptool stamps into the app header
// (index.json `app_elf_sha256`, per target and per channel release) — the same table the
// Flash page's Detect uses, so "Installed firmware" names our build and version exactly.
async function loadImages() {
  try {
    const res = await fetch("manifests/index.json", { cache: "no-cache" });
    if (!res.ok) return null;
    const t = {};
    for (const x of (await res.json()).targets || []) {
      const base = { id: x.id, name: x.name, line: x.product_line, model: x.model || null };
      if (x.app_elf_sha256) t[x.app_elf_sha256] = { ...base, version: x.version };
      for (const r of (x.channel && x.channel.releases) || []) if (r.app_elf_sha256) t[r.app_elf_sha256] = { ...base, version: r.version, tag: r.tag };
    }
    return t;
  } catch { return null; }
}
const IMAGES = loadImages();
let grantedPort = null;
async function acquirePort({ pick = false } = {}) {
  if (grantedPort && !pick) return grantedPort;
  if (!pick) {
    const known = (await navigator.serial.getPorts()).filter((p) => p.getInfo().usbVendorId != null);
    if (known.length === 1) return (grantedPort = known[0]);
  }
  return (grantedPort = await navigator.serial.requestPort());
}
async function bootloaderTouch(port) {
  const before = new Set(await navigator.serial.getPorts());
  try { await port.open({ baudRate: 1200 }); try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {} await sleep(250); } catch {}
  try { await port.close(); } catch {}
  let gone = false;
  for (let waited = 0; waited < 4000; waited += 250) {
    await sleep(250);
    const now = await navigator.serial.getPorts();
    gone = gone || !now.includes(port);
    const fresh = now.find((p) => !before.has(p) && p.getInfo().usbVendorId === 0x303a);
    if (fresh) return { gone: true, fresh };
    if (!gone && waited >= 1500) break;
    if (gone && waited >= 3000) break;
  }
  return { gone, fresh: null };
}

// --- the exam ----------------------------------------------------------------
let running = false;
$("diagnose").addEventListener("click", () => diagnose());
$("again").addEventListener("click", () => diagnose());
$("copy").addEventListener("click", () => { if (lastReport) navigator.clipboard.writeText(reportText(lastReport)).then(() => { $("copy").textContent = "Copied"; setTimeout(() => ($("copy").textContent = "Copy report"), 1500); }); });
let lastReport = null, lastKey = null;

async function diagnose({ touched = false } = {}) {
  if (!HAS_SERIAL || running) return;
  running = true; $("diagnose").disabled = true;
  $("report").hidden = true;
  mascot("working", "Examining…", "Hold still. This takes a few seconds.");
  try {
    const { ESPLoader, Transport } = await loadEsptool();
    let port;
    try { port = await acquirePort(); } catch { status("No port chosen.", "err"); return finish("idle"); }
    let info = {}; try { info = port.getInfo() || {}; } catch {}

    const term = { clean() {}, writeLine(d) { status(escapeHtml(String(d)), "busy"); }, write() {} };
    const transport = new Transport(port, false);
    const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: term, debugLogging: false });
    if (info.usbVendorId === 0x303a && typeof loader.connect === "function") { const orig = loader.connect.bind(loader); loader.connect = (m, _a, d) => orig(m, 3, d); }

    let chipName;
    try {
      status("Connecting to the board…");
      chipName = await loader.main();
    } catch (e) {
      try { await transport.disconnect(); } catch {}
      if (!touched && info.usbVendorId === 0x303a) {
        status("The running firmware ignored the reset — rebooting it into flashing mode…");
        const r = await bootloaderTouch(port);
        if (r.fresh) { grantedPort = r.fresh; running = false; $("diagnose").disabled = false; return diagnose({ touched: true }); }
        if (r.gone) {
          grantedPort = null;
          status("The board rebooted into flashing mode and shows up as a new device — pick it once: <button class=\"btn btn-inline\" id=\"pickRebooted\" type=\"button\">Connect to the rebooted board</button>", "ok");
          $("pickRebooted").addEventListener("click", async () => {
            try { grantedPort = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] }); } catch { return; }
            diagnose({ touched: true });
          });
          return finish("idle");
        }
      }
      grantedPort = null;
      status(`Couldn't reach the board: ${escapeHtml(e.message)}. Put it in download mode (hold BOOT while plugging in) and try again.`, "err");
      return finish("rework", "Couldn't connect");
    }

    // identity from esptool, then the protocol
    const chip = { chipName };
    try { chip.mac = await loader.chip.readMac(loader); } catch {}
    try { chip.flashId = await loader.readFlashId(); } catch {}
    const stats = { reads: 0, writes: 0, batches: 0, batched: 0 };
    const io = {
      stats,
      readReg: (a) => { stats.reads++; return loader.readReg(a); },
      writeReg: (a, v, m) => { stats.writes++; return m == null ? loader.writeReg(a, v) : loader.writeReg(a, v, m); },
      // many register writes in ONE loader command: the flasher stub walks the
      // [addr, value, mask, delay_us] tuples back to back (this is how esptool itself does
      // write_reg's delay_after_us). One USB round-trip instead of one per edge.
      writeRegs: (list) => {
        stats.batches++; stats.batched += list.length;
        const pkt = new Uint8Array(16 * list.length), dv = new DataView(pkt.buffer);
        list.forEach(([a, v, m = 0xffffffff, d = 0], i) => { dv.setUint32(16 * i, a >>> 0, true); dv.setUint32(16 * i + 4, v >>> 0, true); dv.setUint32(16 * i + 8, m >>> 0, true); dv.setUint32(16 * i + 12, d >>> 0, true); });
        return loader.checkCommand("write target memory", loader.ESP_WRITE_REG, pkt);
      },
      readFlash: async (a, n) => { const d = await loader.readFlash(a, n); try { await transport.read(250); } catch {} return d; },
    };
    if (typeof loader.checkCommand !== "function" || loader.ESP_WRITE_REG == null) delete io.writeRegs;
    let key = $("protocol").value, why = "";
    if (key === "auto") {
      const mcu = /ESP32-S3/i.test(chipName) ? "esp32-s3" : /ESP32-S2/i.test(chipName) ? "esp32-s2" : /ESP8266/i.test(chipName) ? "esp8266" : null;
      const mb = chip.flashId != null ? vet.flashSizeMb(chip.flashId) : null;
      let line = null, model = null;
      if (mcu === "esp32-s3" && mb === 16) line = "newsheen";
      else if (mcu === "esp32-s3" && mb === 8) line = "defcon-badge";
      else if (mcu === "esp32-s3" && mb === 4) { status("Identifying which ESP32-S3 board this is…"); try { const r = await probe.probeS3FourMeg(io, { images: await IMAGES }); line = r.line; model = r.model || r.models?.[0] || null; } catch {} }
      key = (model && Object.keys(PROTOCOLS).find((k) => PROTOCOLS[k].model === model)) || Object.keys(PROTOCOLS).find((k) => PROTOCOLS[k].line === line) || null;
      why = model ? `identified as ${model}` : line ? `identified as ${line}` : `${chipName}${mb ? ", " + mb + " MB" : ""}`;
      if (key) { const declared = fittedFromUi(); renderParts(key); for (const i of document.querySelectorAll("#parts input[data-part]")) if (i.dataset.part in declared) i.checked = declared[i.dataset.part]; }
      if (!key) {
        try { await transport.disconnect(); } catch {}
        status(`No vet protocol for this board yet (${escapeHtml(why)}). Pick one explicitly if you know what it is.`, "err");
        return finish("check", "No protocol");
      }
    }
    const protocol = PROTOCOLS[key]; lastKey = key;
    const steps = ["identity", "pins", "bridges", "radio", "antenna", "i2c", "firmware", "beacon"];
    const labels = { identity: "Reading chip, flash and eFuses", pins: "Measuring rest levels on every pin", bridges: "Looking for solder bridges between neighbouring pins", radio: "Asking the LoRa radio to identify itself", antenna: "Listening for off-air RF through the antenna (receive only)", i2c: "Scanning the I2C header", firmware: "Reading the installed firmware", beacon: "Blinking the debug LED" };
    status(`${escapeHtml(protocol.name)}${why ? " (" + escapeHtml(why) + ")" : ""} — starting the exam…`);
    const report = await vet.runExam(io, protocol, {
      chip, images: await IMAGES, fitted: fittedFromUi(), doBeacon: $("blink").checked,
      onStep: (s) => { progress(steps.indexOf(s) / steps.length); status(`${escapeHtml(protocol.name)} — ${labels[s] || s}…`); },
    });
    progress(1);

    // interactive: the IR receiver only proves itself when it sees light. Rest level can't
    // separate "unpowered" from "no internal pull-up", so ask for a remote.
    if ($("irTest").checked && protocol.ir && (fittedFromUi()[protocol.ir.part] !== false)) {
      const rest = report.fingerprint[protocol.ir.gpio];
      mascot("working", "Point a remote at the cat", "Hold any button on an IR remote aimed at the board for the next 8 seconds.");
      const t0 = Date.now();
      const r = await vet.irListen(io, protocol, { ms: 8000, restLevel: rest, onProgress: (p) => status(irLiveHtml(p, Math.max(0, 8 - Math.round((Date.now() - t0) / 1000)), escapeHtml), "busy") });
      report.checks.push(r);
      report.counts[r.status] = (report.counts[r.status] || 0) + 1;
      // the passive GPIO verdict is superseded by the live one
      const passive = report.checks.find((c) => c.id === `gpio${protocol.ir.gpio}`);
      if (passive && r.status === "pass" && passive.status !== "pass") { report.counts[passive.status]--; report.counts.info = (report.counts.info || 0) + 1; passive.status = "info"; passive.detail += " — but it decodes IR (see below)"; delete passive.hint; }
      report.verdict = report.counts.fail ? "needs-rework" : report.counts.warn ? "check" : "healthy";
    }

    // boot check: hand the board back to its firmware and watch the console
    if ($("bootCheck").checked && /esp32-s3/i.test(protocol.mcu)) {
      status("Rebooting the board into its firmware and watching it boot…");
      const before = new Set(await navigator.serial.getPorts());
      let reset = false;
      try { await probe.s3ResetToApp(io); reset = true; } catch (e) { console.warn("[vet] reset failed", e); }
      try { await transport.disconnect(); } catch {}
      if (reset) {
        const boot = await bootWatch(port, before, 6000);
        report.checks.push({ id: "boot", title: "Boots into its firmware", status: boot.status, detail: boot.detail, ...(boot.hint ? { hint: boot.hint } : {}) });
        report.counts[boot.status] = (report.counts[boot.status] || 0) + 1;
        // an amplifier can't be seen electrically — if the firmware that drives it is running
        // and told us its address, hand the user its own controls
        const fa = protocol.firmwareAudio, b = boot.banner || {};
        if (fa && fittedFromUi()[fa.part] !== false && b.name && fa.match.test(b.name)) {
          const links = vet.audioLinks(protocol, b.ip || b.apip);
          report.checks.push({ id: "audio", title: `Audio — via ${b.name}`, status: "info",
            detail: b.ip ? `firmware is up at ${b.ip}${b.wiring ? ` (wiring ${b.wiring})` : ""}` : "firmware is up (no LAN address seen — try its soft-AP)",
            hint: "The I²S amplifier can't be measured from here. \"Make it sing\" plays a chiptune through it (it interrupts a stream); if you hear it, the amp, its wiring and the speaker are good.", links });
          report.counts.info = (report.counts.info || 0) + 1;
        }
        const fm = protocol.firmwareMic;
        if (fm && fittedFromUi()[fm.part] !== false && b.name && fm.match.test(b.name)) {
          mascot("working", "Make some noise", "Talk, clap or play music near the board for 8 seconds.");
          status("Listening to the microphone through the firmware… make some noise near the board");
          const text = await readConsole(port, 8000);
          const m = vet.micVerdict(protocol, text);
          report.checks.push(m); report.counts[m.status] = (report.counts[m.status] || 0) + 1;
        }
        report.verdict = report.counts.fail ? "needs-rework" : report.counts.warn ? "check" : "healthy";
      }
    } else { try { await transport.disconnect(); } catch {} }
    grantedPort = null;
    lastReport = report;
    render(report);
    const phase = report.verdict === "healthy" ? "healthy" : report.verdict === "check" ? "check" : "rework";
    const line = report.verdict === "healthy" ? "Healthy cat" : report.verdict === "check" ? "Mostly fine — a few things to look at" : `Needs rework — ${report.counts.fail} finding${report.counts.fail === 1 ? "" : "s"}`;
    status(`<b>${escapeHtml(protocol.name)}</b>: ${escapeHtml(line)}.`, report.verdict === "healthy" ? "ok" : report.verdict === "check" ? "ok" : "err");
    finish(phase, line, "Scroll down for the findings. Hints point at the part to check.");
  } catch (e) {
    console.error("[vet]", e);
    grantedPort = null;
    status(`The exam stopped: ${escapeHtml(e.message)}`, "err");
    finish("rework", "Exam interrupted");
  }
}
function finish(phase, title = "Diagnose my cat", sub) { running = false; $("diagnose").disabled = !HAS_SERIAL; progress(null); mascot(phase, title, sub); }

// Read the console for a while with DTR/RTS low (never DTR high on an HWCDC board).
async function readConsole(port, ms) {
  let text = "";
  try {
    await port.open({ baudRate: 115200 });
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
    const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => ({ done: true }))]);
      if (chunk.done) break;
      text += chunk.value;
    }
    try { await reader.cancel(); } catch {}
  } catch (e) { console.warn("[vet] console read failed", e); }
  try { await port.close(); } catch {}
  return text;
}

// After the watchdog reset: an HWCDC/ROM board keeps its port — open it with DTR and RTS low
// (DTR high would drop it back into download mode) and read; a TinyUSB app takes over USB and
// the old port vanishes, which is itself the "it booted" signal.
async function bootWatch(port, before, ms) {
  const t0 = Date.now();
  let vanishedAt = null;
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    const now = await navigator.serial.getPorts();
    if (!now.includes(port)) { vanishedAt = Date.now() - t0; break; }
  }
  if (vanishedAt != null) {
    const fresh = await waitFresh(before, 4000);
    return vet.analyzeBootLog("", { vanishedAfterMs: fresh ? fresh.ms : vanishedAt, windowMs: ms });
  }
  let text = "";
  try {
    await port.open({ baudRate: 115200 });
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
    const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => ({ done: true }))]);
      if (chunk.done) break;
      text += chunk.value;
    }
    try { await reader.cancel(); } catch {}
  } catch (e) { console.warn("[vet] console read failed", e); }
  try { await port.close(); } catch {}
  return vet.analyzeBootLog(text, { windowMs: ms });
}
async function waitFresh(before, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(250);
    const fresh = (await navigator.serial.getPorts()).find((p) => !before.has(p) && p.getInfo().usbVendorId != null);
    if (fresh) return { port: fresh, ms: Date.now() - t0 };
  }
  return null;
}

// --- rendering -----------------------------------------------------------------
const ICON = { pass: "✓", warn: "!", fail: "✗", info: "·", skip: "–" };
const GROUP = (c) => c.id === "boot" || c.id === "audio" || c.id === "mic" ? "Boot" : c.id === "declared" ? "Identity" : c.id === "ir" ? "Pins" : c.id.startsWith("gpio") ? "Pins" : c.id.startsWith("bridge") ? "Solder bridges" : c.id.startsWith("i2c") ? "I2C" : c.id === "radio" || c.id === "antenna" ? "Radio" : c.id === "firmware" || c.id === "beacon" ? "Firmware" : "Identity";
function jumpTo(id) {
  const el = document.getElementById(`check-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("vet-flash"); void el.offsetWidth; el.classList.add("vet-flash");
}
function render(r) {
  $("report").hidden = false;
  const proto = PROTOCOLS[lastKey] || {};
  const layout = LAYOUTS[proto.layout || lastKey] || null;
  if ($("board")) renderBoard($("board"), layout, boardHighlights(r, proto, layout), { onPick: jumpTo, title: proto.name || r.board });
  $("summary").className = `vet-summary verdict-${r.verdict}`;
  $("summary").innerHTML = `<div class="vet-verdict">${r.verdict === "healthy" ? "Healthy" : r.verdict === "check" ? "Check" : "Needs rework"}</div>` +
    `<div class="vet-counts">${r.counts.pass} pass · ${r.counts.warn} warn · ${r.counts.fail} fail · ${r.chip.chipName ? escapeHtml(r.chip.chipName) : ""}${r.chip.mac ? " · " + escapeHtml(r.chip.mac) : ""} · ${escapeHtml(timingText(r))}</div>`;
  const wrap = $("checks"); wrap.replaceChildren();
  let group = null;
  const order = ["Identity", "Radio", "Pins", "Solder bridges", "I2C", "Firmware", "Boot"];
  const sorted = [...r.checks].sort((a, b) => order.indexOf(GROUP(a)) - order.indexOf(GROUP(b)) || ({ fail: 0, warn: 1, pass: 2, info: 3, skip: 4 }[a.status] - { fail: 0, warn: 1, pass: 2, info: 3, skip: 4 }[b.status]));
  for (const c of sorted) {
    const g = GROUP(c);
    if (g !== group) { group = g; const h = document.createElement("div"); h.className = "tag-head"; h.innerHTML = `<span class="tag-name">${g}</span><span class="tag-rule"></span>`; wrap.append(h); }
    const row = document.createElement("div"); row.className = `vet-row vet-${c.status}`; row.id = `check-${c.id}`;
    const links = (c.links || []).map((l) => `<a class="vet-link" href="${escapeHtml(l.href)}" target="_blank" rel="noopener">${escapeHtml(l.label)} ↗</a>`).join(" ");
    const extra = c.id === "antenna" ? sweepChartSvg(c) : c.id === "ir" && c.frames?.length ? irLiveHtml({ recent: [], transitions: c.transitions, frames: c.frames, rmt: c.rmt }, 0, escapeHtml).replace(/<div class="ir-head">.*?<\/div>/, "").replace(/<svg class="ir-wave".*?<\/svg>/, "") : "";
    row.innerHTML = `<span class="vet-icon">${ICON[c.status]}</span><div class="vet-body"><div class="vet-title">${escapeHtml(c.title)}</div><div class="vet-detail">${escapeHtml(c.detail)}</div>${c.hint ? `<div class="vet-hint">↳ ${escapeHtml(c.hint)}</div>` : ""}${extra}${links ? `<div class="vet-links">${links}</div>` : ""}</div>`;
    wrap.append(row);
  }
}
function timingText(r) {
  const secs = (ms) => `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
  const slow = Object.entries(r.timings || {}).filter(([, ms]) => ms >= 1000).map(([k, ms]) => `${k} ${secs(ms)}`);
  return `${secs(r.ms)}${slow.length ? " (" + slow.join(", ") + ")" : ""}`;
}
function reportText(r) {
  const absent = Object.entries(r.fitted || {}).filter(([, v]) => v === false).map(([k]) => k);
  const link = r.ops ? `link: ${r.ops.reads} reads, ${r.ops.writes} writes, ${r.ops.batches} batches carrying ${r.ops.batched} writes` : null;
  const timing = r.timings ? "timing: " + Object.entries(r.timings).map(([k, ms]) => `${k} ${(ms / 1000).toFixed(1)} s`).join(", ") + ` — total ${(r.ms / 1000).toFixed(1)} s` : null;
  const lines = [`${r.board} — ${r.verdict} (${r.counts.pass} pass, ${r.counts.warn} warn, ${r.counts.fail} fail)`, `${r.chip.chipName || ""} ${r.chip.mac || ""}`.trim(), ...(absent.length ? [`declared not fitted: ${absent.join(", ")}`] : []), ...(timing ? [timing] : []), ...(link ? [link] : []), ""];
  for (const c of r.checks) lines.push(`${ICON[c.status]} ${c.title}: ${c.detail}${c.hint ? `\n    -> ${c.hint}` : ""}`);
  return lines.join("\n");
}
// exposed for the simulator / console
window.vetRender = render; window.vetRunOn = async (io, chip, key = "newsheen") => { lastKey = key; return vet.runExam(io, PROTOCOLS[key], { chip, images: await IMAGES, doBeacon: false }); };
// #demo=<name> renders a canned report (demo-<name>.json next to the page) so the report
// layout can be reviewed without a board — clearly labelled, never a live exam.
if (/^#demo=[a-z0-9-]+$/.test(location.hash)) {
  const name = location.hash.slice(6);
  fetch(`demo-${name}.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((rep) => {
    if (!rep) return status(`No demo report called “${escapeHtml(name)}”.`, "err");
    lastKey = rep.protocolKey || "newsheen"; lastReport = rep; render(rep);
    status(`<b>Demo report</b> “${escapeHtml(name)}” — canned data for layout review, not a live exam.`, "ok");
    mascot(rep.verdict === "healthy" ? "healthy" : rep.verdict === "check" ? "check" : "rework", `Demo: ${rep.verdict}`, "Nothing was measured — this is a saved report.");
  });
}
window.vetIrDemo = (p, secs = 5) => status(irLiveHtml(p, secs, escapeHtml), "busy");
mascot("idle");
