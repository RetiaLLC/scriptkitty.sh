// Searchable "all downloads" catalog. Reads manifests/index.json (generated in CI by
// scripts/generate_manifests.py). Manual device picker + optional auto-detect (reads the
// chip over Web Serial via vendored esptool-js), Recommended badges, add-ons, per-device
// flashing help, and flashing via vendored esptool-js (fast baud, single 0x0 image).

const targetsEl = document.getElementById("targets");
const searchEl = document.getElementById("search");
const filtersEl = document.getElementById("filters");
const countEl = document.getElementById("count");
const detectBtn = document.getElementById("detect");
const detectedEl = document.getElementById("detected");
const baudSel = document.getElementById("baud");
const eraseChk = document.getElementById("erase");
const tpl = document.getElementById("tpl-card");

const HAS_SERIAL = "serial" in navigator;
if (!HAS_SERIAL) {
  document.getElementById("unsupported").hidden = false;
  detectBtn.disabled = true;
}

const MCU_LABEL = {
  "esp32": "ESP32", "esp32-s2": "ESP32-S2", "esp32-s3": "ESP32-S3",
  "esp8266": "ESP8266", "rp2040": "RP2040",
};
const RADIO_LABEL = { rfm95: "RFM95 (LoRa)", sx1262: "SX1262 (LoRa)" };

// Product lines in display order: [key, heading, subtitle]
const LINES = [
  ["usb-nugget", "USB Nugget", "ESP32-S2 USB attack platform"],
  ["wifi-nugget", "WiFi Nugget", "ESP8266 Wi-Fi hacking tool"],
  ["bluetooth-nugget", "Bluetooth Nugget", "ESP32-S3 Bluetooth / LoRa platform"],
  ["nibble", "Nibble", "ESP32-S3 Meshtastic / Meshcore boards"],
  ["pusheen", "Pusheen", "ESP8266 cat-lamp"],
];

// Which product lines share each chip family (same-silicon collisions can't be
// resolved by auto-detect — the user confirms with the manual picker).
const LINES_BY_MCU = {
  "esp8266": ["wifi-nugget", "pusheen"],
  "esp32-s2": ["usb-nugget"],
  "esp32-s3": ["bluetooth-nugget", "nibble"],
};

// Per-device flashing / recovery help, keyed by product line.
const HELP = {
  "usb-nugget": "Native USB (ESP32-S2). Enter flashing mode: hold BOOT (GPIO0), tap RESET, then release BOOT. After flashing, tap RESET to run.",
  "wifi-nugget": "ESP8266 (D1 Mini). Usually flashes automatically. If it fails, hold the FLASH button while plugging in USB, then release.",
  "pusheen": "ESP8266 (D1 Mini). Usually flashes automatically. If it fails, hold the FLASH button while plugging in USB, then release.",
  "bluetooth-nugget": "Native USB (ESP32-S3, Wemos S3 Mini). Hold BOOT, tap RESET (or hold BOOT while plugging in USB), then release. After flashing, tap RESET or replug.",
  "nibble": "Native USB (ESP32-S3, Waveshare S3 Zero — no RESET button). Hold BOOT while plugging in USB to enter flashing mode, then release. After flashing, unplug and replug.",
};

let ALL = [];
let activeLine = "all";
let query = "";
let detectedMcu = null;

// esptool-js is vendored and dynamic-imported once, shared by detect + flash.
let _esptool = null;
function loadEsptool() {
  if (!_esptool) _esptool = import("./vendor/esptool-js/bundle.js");
  return _esptool;
}
// A port the user has already granted this session — reuse it so Detect→Flash
// (or repeat flashes) don't re-prompt the browser port picker.
let grantedPort = null;
async function acquirePort() {
  if (grantedPort) return grantedPort;
  grantedPort = await navigator.serial.requestPort();
  return grantedPort;
}

init();

async function init() {
  let data;
  try {
    const res = await fetch("manifests/index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    renderEmpty(err);
    return;
  }
  ALL = (data && data.targets) || [];
  if (!ALL.length) { renderEmpty(); return; }

  buildFilters();
  searchEl.addEventListener("input", () => { query = searchEl.value.trim().toLowerCase(); render(); });
  detectBtn.addEventListener("click", detectBoard);
  render();
}

function buildFilters() {
  const present = new Set(ALL.map((t) => t.product_line));
  const chips = [["all", "All", ALL.length]];
  for (const [key, label] of LINES) {
    if (present.has(key)) chips.push([key, label, ALL.filter((t) => t.product_line === key).length]);
  }
  filtersEl.replaceChildren();
  for (const [key, label, n] of chips) {
    const b = document.createElement("button");
    b.className = "filter" + (key === activeLine ? " active" : "");
    b.dataset.line = key;
    b.innerHTML = `${label} <span class="filter-n">${n}</span>`;
    b.addEventListener("click", () => {
      activeLine = key;
      // a manual pick overrides an earlier auto-detect
      if (detectedMcu) clearDetection(false);
      syncFilterButtons();
      render();
    });
    filtersEl.append(b);
  }
}

function syncFilterButtons() {
  filtersEl.querySelectorAll(".filter").forEach((el) => el.classList.toggle("active", el.dataset.line === activeLine));
}

function matches(t) {
  if (detectedMcu && t.mcu !== detectedMcu) return false;
  if (activeLine !== "all" && t.product_line !== activeLine) return false;
  if (!query) return true;
  const hay = [
    t.name, t.model, t.product_line, t.description, t.mcu, t.radio,
    MCU_LABEL[t.mcu], (t.addons || []).join(" "),
  ].join(" ").toLowerCase();
  return query.split(/\s+/).every((term) => hay.includes(term));
}

function render() {
  const shown = ALL.filter(matches);
  countEl.textContent = shown.length === ALL.length
    ? `${ALL.length} programs`
    : `${shown.length} of ${ALL.length} programs`;

  if (!shown.length) {
    targetsEl.replaceChildren(el("div", "empty", "No firmware matches your search."));
    return;
  }

  // group shown items by line, in LINES order then any extras
  const byLine = new Map();
  for (const t of shown) {
    if (!byLine.has(t.product_line)) byLine.set(t.product_line, []);
    byLine.get(t.product_line).push(t);
  }
  const order = [...LINES.map((l) => l[0]), ...[...byLine.keys()].filter((k) => !LINES.some((l) => l[0] === k))];

  targetsEl.replaceChildren();
  for (const key of order) {
    const items = byLine.get(key);
    if (!items || !items.length) continue;
    // recommended first, then by name
    items.sort((a, b) => (b.recommended === true) - (a.recommended === true) || (a.name || "").localeCompare(b.name || ""));
    const meta = LINES.find((l) => l[0] === key);
    const section = document.createElement("section");
    section.className = "line-section";
    const head = document.createElement("div");
    head.className = "line-head";
    head.innerHTML = `<h2>${meta ? meta[1] : key}</h2>` + (meta ? `<span>${meta[2]}</span>` : "") +
      `<span class="line-n">${items.length}</span>`;
    section.append(head);
    if (HELP[key]) {
      const help = document.createElement("details");
      help.className = "line-help";
      help.innerHTML = `<summary>Flashing help</summary><p>${HELP[key]}</p>`;
      section.append(help);
    }
    const grid = document.createElement("div");
    grid.className = "targets";
    for (const t of items) grid.append(renderCard(t));
    section.append(grid);
    targetsEl.append(section);
  }
}

function renderCard(t) {
  const node = tpl.content.cloneNode(true);
  node.querySelector(".card-name").textContent = t.name || t.id;
  node.querySelector(".mcu").textContent = MCU_LABEL[t.mcu] || t.mcu;
  if (t.recommended) node.querySelector(".rec-badge").hidden = false;
  node.querySelector(".card-desc").textContent = stripNote(t.description);
  node.querySelector(".model").textContent = t.model || "—";
  node.querySelector(".version").textContent = t.version ? `v${t.version}` : "—";

  const radioWrap = node.querySelector(".radio-wrap");
  if (t.radio) node.querySelector(".radio").textContent = RADIO_LABEL[t.radio] || t.radio;
  else radioWrap.remove();

  const addonsEl = node.querySelector(".addons");
  const addons = t.addons || [];
  if (addons.length) {
    addonsEl.innerHTML = `<span class="addons-label">Add-ons needed</span>` +
      addons.map((a) => `<span class="addon">${a}</span>`).join("");
  } else {
    addonsEl.innerHTML = `<span class="addon addon-ok">No add-ons needed</span>`;
  }

  const src = node.querySelector(".src-link");
  if (t.program_url) src.href = t.program_url;
  else src.remove();

  const actionEl = node.querySelector(".card-action");
  if (t.flow === "uf2") renderUf2(actionEl, t);
  else renderEsp(actionEl, t);
  return node;
}

function renderEsp(actionEl, t) {
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.type = "button";
  if (HAS_SERIAL) {
    btn.textContent = "Flash";
    btn.addEventListener("click", () => flashProfile(t));
  } else {
    btn.textContent = "Chrome or Edge required";
    btn.disabled = true;
  }
  actionEl.append(btn);
}

async function renderUf2(actionEl, t) {
  let side = {};
  try {
    const res = await fetch(`manifests/${t.manifest}`, { cache: "no-cache" });
    if (res.ok) side = await res.json();
  } catch { /* defaults below */ }
  const uf2Path = side.uf2_path ? side.uf2_path.replace(/^\.\.\//, "") : `firmware/${t.id}.uf2`;
  const dl = document.createElement("a");
  dl.className = "btn";
  dl.href = uf2Path;
  dl.setAttribute("download", "");
  dl.textContent = "Download .uf2";
  actionEl.append(dl);
}

// --- auto-detect via vendored esptool-js -------------------------------------
async function detectBoard() {
  if (!HAS_SERIAL) return;
  showDetected("Loading detector…", "busy");
  let mod;
  try {
    mod = await loadEsptool();
  } catch (e) {
    showDetected("Couldn't load the detector.", "err");
    return;
  }
  const { ESPLoader, Transport } = mod;

  let port;
  try {
    port = await acquirePort();
  } catch {
    hideDetected(); // user dismissed the port picker
    return;
  }

  const term = { clean() {}, writeLine(d) { showDetected(String(d), "busy"); }, write(d) {} };
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: term, debugLogging: false });
  try {
    showDetected("Connecting to board…", "busy");
    const chipName = await loader.main();              // connects, detects chip
    const mcu = mapChip(chipName);
    let flash = "";
    try { flash = flashLabel(await loader.readFlashId()); } catch {}
    applyDetection(mcu, chipName, flash);
  } catch (e) {
    showDetected(`Detect failed: ${e.message}. Put the board in download mode (see Flashing help) and try again.`, "err");
  } finally {
    try { await transport.disconnect(); } catch {}
  }
}

function mapChip(chipName) {
  const s = (chipName || "").toUpperCase();
  if (s.includes("ESP8266")) return "esp8266";
  if (s.includes("ESP32-S2") || s.includes("ESP32S2")) return "esp32-s2";
  if (s.includes("ESP32-S3") || s.includes("ESP32S3")) return "esp32-s3";
  return null;
}

function flashLabel(flashId) {
  const sizeId = (flashId >> 16) & 0xff;
  if (sizeId < 0x12 || sizeId > 0x20) return "";
  const mb = Math.pow(2, sizeId) / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB flash` : "";
}

function applyDetection(mcu, chipName, flash) {
  if (!mcu) {
    showDetected(`Detected ${chipName || "an unknown chip"} — not a recognized Nugget/Nibble chip.`, "err");
    return;
  }
  detectedMcu = mcu;
  const lines = LINES_BY_MCU[mcu] || [];
  const chipTxt = `${MCU_LABEL[mcu]}${flash ? " · " + flash : ""}`;
  if (lines.length === 1) {
    activeLine = lines[0];
    const name = LINES.find((l) => l[0] === lines[0])[1];
    showDetected(`Detected <b>${name}</b> (${chipTxt}) — showing its firmware.`, "ok");
  } else {
    activeLine = "all";
    const names = lines.map((k) => LINES.find((l) => l[0] === k)[1]).join(" or a ");
    showDetected(`Detected <b>${chipTxt}</b> — this is a ${names}. Pick your exact board below.`, "ok");
  }
  syncFilterButtons();
  render();
}

function showDetected(html, kind) {
  detectedEl.hidden = false;
  detectedEl.className = `banner banner-detect banner-${kind}`;
  const clear = (kind === "ok" || kind === "err") ? ` <button class="link-clear" type="button">clear</button>` : "";
  detectedEl.innerHTML = html + clear;
  const btn = detectedEl.querySelector(".link-clear");
  if (btn) btn.addEventListener("click", () => clearDetection(true));
}

function hideDetected() { detectedEl.hidden = true; detectedEl.innerHTML = ""; }

function clearDetection(rerender) {
  detectedMcu = null;
  activeLine = "all";
  hideDetected();
  syncFilterButtons();
  if (rerender) render();
}

// --- flashing via vendored esptool-js ----------------------------------------
async function flashProfile(t) {
  if (!HAS_SERIAL) return;
  const baud = parseInt(baudSel.value, 10) || 460800;

  let mod;
  try { mod = await loadEsptool(); }
  catch { openFlash(t); showFlashError(t, "Couldn't load the flasher."); return; }
  const { ESPLoader, Transport } = mod;

  let port;
  try { port = await acquirePort(); }
  catch { return; } // user dismissed the port picker

  openFlash(t);
  const term = { clean() {}, writeLine(d) { setFlashStatus(String(d)); }, write(d) {} };
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: baud, romBaudrate: 115200, terminal: term, debugLogging: false });
  try {
    setFlashStatus("Connecting to board…");
    const chipName = await loader.main();
    const mcu = mapChip(chipName);
    if (mcu && mcu !== t.mcu) {
      throw new Error(`This board is ${chipName}, but "${t.name}" is built for ${MCU_LABEL[t.mcu] || t.mcu}.`);
    }
    setFlashStatus("Downloading firmware…");
    const resp = await fetch(`firmware/${t.id}.bin`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`Couldn't fetch firmware (HTTP ${resp.status}).`);
    const data = loader.ui8ToBstr(new Uint8Array(await resp.arrayBuffer()));
    const eraseAll = !!(eraseChk && eraseChk.checked);
    if (eraseAll) setFlashStatus("Erasing flash…");
    setFlashStatus(`Writing at ${baud} baud…`);
    await loader.writeFlash({
      fileArray: [{ data, address: 0 }],
      flashSize: "keep", flashMode: "keep", flashFreq: "keep",
      eraseAll, compress: true,
      reportProgress: (i, written, total) => setFlashProgress(written, total),
    });
    setFlashStatus("Rebooting…");
    await loader.after("hard_reset");
    showFlashSuccess(t);
  } catch (e) {
    showFlashError(t, e && e.message ? e.message : String(e));
  } finally {
    try { await transport.disconnect(); } catch {}
  }
}

let overlayEl = null;
function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "flash-overlay";
  overlayEl.hidden = true;
  overlayEl.innerHTML =
    `<div class="flash-modal" role="dialog" aria-modal="true">
       <h3 class="flash-title"></h3>
       <div class="flash-bar"><div class="flash-bar-fill"></div></div>
       <div class="flash-pct"></div>
       <div class="flash-status"></div>
       <div class="flash-actions"></div>
     </div>`;
  document.body.append(overlayEl);
  return overlayEl;
}
function openFlash(t) {
  const o = ensureOverlay();
  o.hidden = false;
  o.className = "flash-overlay state-flashing";
  o.querySelector(".flash-title").textContent = `Flashing ${t.name}`;
  o.querySelector(".flash-bar").style.display = "";
  o.querySelector(".flash-actions").replaceChildren();
  setFlashProgress(0, 1);
  setFlashStatus("");
}
function setFlashStatus(text) { ensureOverlay().querySelector(".flash-status").textContent = text; }
function setFlashProgress(written, total) {
  const o = ensureOverlay();
  const pct = total ? Math.round((written / total) * 100) : 0;
  o.querySelector(".flash-bar-fill").style.width = pct + "%";
  o.querySelector(".flash-pct").textContent = pct + "%";
}
function showFlashSuccess(t) {
  const o = ensureOverlay();
  o.className = "flash-overlay state-ok";
  o.querySelector(".flash-title").textContent = `✓ Flashed ${t.name}`;
  setFlashProgress(1, 1);
  setFlashStatus("Your board rebooted into the new firmware.");
  const actions = o.querySelector(".flash-actions");
  actions.replaceChildren(
    btnEl("a", "btn", "Open Serial Monitor", { href: "serial.html" }),
    btnEl("button", "btn secondary", "Flash another board", { onclick: () => {
      grantedPort = null; closeFlash(); clearDetection(true); window.scrollTo({ top: 0, behavior: "smooth" });
    } }),
    btnEl("button", "btn secondary", "Done", { onclick: closeFlash }),
  );
}
function showFlashError(t, msg) {
  const o = ensureOverlay();
  o.className = "flash-overlay state-err";
  o.querySelector(".flash-title").textContent = "Flashing failed";
  o.querySelector(".flash-bar").style.display = "none";
  setFlashStatus(`${msg}  If this keeps happening, lower the Speed setting and make sure the board is in download mode (see Flashing help), then retry.`);
  const actions = o.querySelector(".flash-actions");
  actions.replaceChildren(
    btnEl("button", "btn", "Retry", { onclick: () => { closeFlash(); flashProfile(t); } }),
    btnEl("button", "btn secondary", "Close", { onclick: closeFlash }),
  );
}
function closeFlash() { if (overlayEl) overlayEl.hidden = true; }
function btnEl(tag, cls, text, opts) {
  const n = document.createElement(tag);
  n.className = cls; n.textContent = text;
  if (tag === "button") n.type = "button";
  if (opts && opts.href) n.href = opts.href;
  if (opts && opts.onclick) n.addEventListener("click", opts.onclick);
  return n;
}

// --- helpers -----------------------------------------------------------------
function stripNote(desc) {
  if (!desc) return "";
  return desc.split(/\s*NOTE:/i)[0].trim();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function renderEmpty(err) {
  targetsEl.replaceChildren(el("div", "empty", err
    ? "No firmware published yet — run the Build & Deploy workflow to populate the library."
    : "No firmware is configured yet."));
}
