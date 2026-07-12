// scriptkitty.sh — detect-first home. Reads manifests/index.json (generated in CI by
// scripts/generate_manifests.py). Pick a device tile (or auto-detect the chip over Web
// Serial via vendored esptool-js) to reveal its firmware as expanding cards; the
// recommended build opens first. Flashing runs on the vendored esptool-js (fast baud,
// single 0x0 image) with a reactive ASCII-cat mascot mirroring each flash.

const buildsEl = document.getElementById("builds");
const tilesEl = document.getElementById("tiles");
const searchEl = document.getElementById("search");
const detectBtn = document.getElementById("detect");
const detectedEl = document.getElementById("detected");
const baudSel = document.getElementById("baud");
const eraseChk = document.getElementById("erase");
const famHelpEl = document.getElementById("famHelp");

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

// Product lines in display order: [key, heading, short family descriptor].
const LINES = [
  ["usb-nugget", "USB Nugget", "USB attack platform"],
  ["wifi-nugget", "WiFi Nugget", "Wi-Fi hacking tool"],
  ["bluetooth-nugget", "Bluetooth Nugget", "Bluetooth / LoRa platform"],
  ["nibble", "Nibble", "Meshtastic / Meshcore"],
  ["defcon-badge", "DEF CON Badge (2026)", "conference badge — mesh, games & more"],
  ["pusheen", "Pusheen", "just for fun"],
];
function famName(key) { const l = LINES.find((x) => x[0] === key); return l ? l[1] : key; }
function famTag(key) { const l = LINES.find((x) => x[0] === key); return l ? l[2] : ""; }

// Board line-art (black-on-white; displayed inverted + screen so it reads as white line
// art on the dark UI). Keyed by product line.
const BOARD_IMG = {
  "usb-nugget": "assets/boards/usb-nugget.png",
  "wifi-nugget": "assets/boards/wifi-nugget.png",
  "bluetooth-nugget": "assets/boards/bluetooth-nugget.png",
  "nibble": "assets/boards/nibble.png",
  "pusheen": "assets/boards/pusheen.png",
  "defcon-badge": "assets/boards/defcon-badge.png",
};

// Which product lines share each chip family (same-silicon collisions can't be
// resolved by auto-detect — the user confirms with the manual picker).
const LINES_BY_MCU = {
  "esp8266": ["wifi-nugget", "pusheen"],
  "esp32-s2": ["usb-nugget"],
  "esp32-s3": ["bluetooth-nugget", "nibble", "defcon-badge"],
};
// Flash size resolves same-silicon collisions where it can: every S3 Nugget/Nibble is
// 4 MB, the DEF CON badge is the only 8 MB ESP32-S3 in the catalog.
const LINES_BY_MCU_FLASH = {
  "esp32-s3": { 8: ["defcon-badge"], 4: ["bluetooth-nugget", "nibble"] },
};

// Per-device flashing / recovery help, keyed by product line.
const HELP = {
  "usb-nugget": "Native USB (ESP32-S2). Enter flashing mode: hold BOOT (GPIO0), tap RESET, then release BOOT. After flashing, tap RESET to run.",
  "wifi-nugget": "ESP8266 (D1 Mini). Usually flashes automatically. If it fails, hold the FLASH button while plugging in USB, then release.",
  "pusheen": "ESP8266 (D1 Mini). Usually flashes automatically. If it fails, hold the FLASH button while plugging in USB, then release.",
  "bluetooth-nugget": "Native USB (ESP32-S3, Wemos S3 Mini). Hold BOOT, tap RESET (or hold BOOT while plugging in USB), then release. After flashing, tap RESET or replug.",
  "nibble": "Native USB (ESP32-S3, Waveshare S3 Zero — no RESET button). Hold BOOT while plugging in USB to enter flashing mode, then release. After flashing, unplug and replug.",
  "defcon-badge": "Native USB (ESP32-S3). Enter flashing mode: hold SW2 (BOOT), tap SW1 (RESET), release SW2. After flashing, tap RESET. The Badge Launcher firmwares REQUIRE a FAT-formatted micro-SD card — grab the SD zip(s) from the release linked on the card.",
};

// reactive-mascot ASCII art
const CAT = {
  idle: ` /\\_/\\
( o.o )
 (")_(")`,
  working: ` /\\_/\\
( o.o )7
 (")_(")`,
  success: ` /\\_/\\
( ^.^ )♥
 (")_(")`,
  error: ` /\\_/\\
( x.x )
 (")_(")`,
};

let ALL = [];
let openLines = new Set();       // device families whose firmware section is expanded (multi-open)
let query = "";                  // free-text search (spans every family when set)
let openCards = new Set();       // ids of expanded firmware cards

const linePresent = (k) => ALL.some((t) => t.product_line === k);

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

  buildTiles();
  if (searchEl) searchEl.addEventListener("input", () => { query = searchEl.value.trim().toLowerCase(); render(); });
  detectBtn.addEventListener("click", detectBoard);
  // remember the user's flash-speed choice across visits
  try { const saved = localStorage.getItem("sk_baud"); if (saved && baudSel) baudSel.value = saved; } catch {}
  if (baudSel) baudSel.addEventListener("change", () => { try { localStorage.setItem("sk_baud", baudSel.value); } catch {} });
  setupCustomFlash();
  setMascot("idle");

  // Expand the family/families named in the URL hash (comma-separated, shareable).
  // A fresh visit with no hash starts with nothing expanded — you click a device to
  // reveal its projects.
  openLinesFromHash();
  render();
  window.addEventListener("hashchange", () => { openLinesFromHash(); render(); });
}

function openLinesFromHash() {
  const keys = (location.hash || "").replace(/^#/, "").split(",")
    .map((s) => s.trim()).filter((k) => k && linePresent(k));
  openLines = new Set(keys);
}
function syncHash() {
  const h = [...openLines].join(",");
  try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch {}
}

// --- device tiles ------------------------------------------------------------
function familiesPresent() {
  const present = LINES.filter(([key]) => ALL.some((t) => t.product_line === key));
  const extras = [...new Set(ALL.map((t) => t.product_line))]
    .filter((k) => !LINES.some((l) => l[0] === k))
    .map((k) => [k, k, ""]);
  return [...present, ...extras];
}

function buildTiles() {
  tilesEl.replaceChildren();
  for (const [key, name] of familiesPresent()) {
    const items = ALL.filter((t) => t.product_line === key);
    const mcu = items[0] && items[0].mcu;
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    tile.dataset.key = key;
    tile.innerHTML =
      `<span class="tile-caret" aria-hidden="true">›</span>` +
      `<span class="tile-text">` +
        `<span class="tile-name">${escapeHtml(name)}</span>` +
        `<span class="tile-chip">${MCU_LABEL[mcu] || mcu || ""}</span>` +
      `</span>` +
      `<span class="tile-count">${items.length}</span>`;
    tile.addEventListener("click", () => toggleLine(key));
    tilesEl.append(tile);
  }
  syncTiles();
}

function syncTiles() {
  tilesEl.querySelectorAll(".tile").forEach((el) => {
    const on = openLines.has(el.dataset.key);
    el.classList.toggle("active", on);
    el.setAttribute("aria-expanded", String(on));
  });
}

// Tiles are independent toggles: click to reveal a device's firmware, click again
// (or click an already-expanded device) to collapse it. Several can be open at once.
function toggleLine(key) {
  if (openLines.has(key)) openLines.delete(key); else openLines.add(key);
  query = "";
  if (searchEl) searchEl.value = "";
  hideDetected();
  syncHash();
  render();
}
// Detection sets exactly which families are shown (single or all applicable).
function setOpenLines(keys) {
  openLines = new Set(keys);
  openCards = new Set();   // fresh context → every card collapsed
  query = "";
  if (searchEl) searchEl.value = "";
  syncHash();
  render();
}

// --- device firmware sections ------------------------------------------------
function updateFamilyHelp() {
  if (!famHelpEl) return;
  const open = orderedLines([...openLines]).filter(linePresent);
  if (!open.length) {
    famHelpEl.textContent = "Pick a device above, then plug it in and hit Flash.";
  } else if (open.length === 1) {
    famHelpEl.textContent = HELP[open[0]] || "Plug the board in, pick a build, and hit Flash.";
  } else {
    famHelpEl.innerHTML = open
      .map((k) => `<b>${escapeHtml(famName(k))}:</b> ${escapeHtml(HELP[k] || "Plug in, pick a build, and hit Flash.")}`)
      .join("<br><br>");
  }
}

// Group a family's builds by model (variant) when it meaningfully clusters — e.g. the
// Nibble line splits into Nibble Zero / Connect / Screen Connect. Flat otherwise.
function groupsFor(items) {
  const models = [...new Set(items.map((t) => t.model || ""))].filter(Boolean);
  // Only sub-group when a family has ≥3 genuine board variants (e.g. the Nibble line:
  // Zero / Connect / OG / Screen Connect). A base model + one add-on variant stays flat.
  if (models.length < 3) return [{ tag: "", show: false, items }];
  const order = [];
  const by = new Map();
  for (const t of items) {
    const m = t.model || "Other";
    if (!by.has(m)) { by.set(m, []); order.push(m); }
    by.get(m).push(t);
  }
  return order.map((m) => ({ tag: m, show: true, items: by.get(m) }));
}

const recThenName = (a, b) =>
  (b.recommended === true) - (a.recommended === true) || (a.name || "").localeCompare(b.name || "");

// A build matches when every search term appears in its name/model/line/desc/chip/radio.
function matchesQuery(t) {
  const hay = [
    t.name, t.model, t.product_line, t.description, t.mcu, t.radio,
    MCU_LABEL[t.mcu], (t.addons || []).join(" "),
  ].join(" ").toLowerCase();
  return query.split(/\s+/).every((term) => hay.includes(term));
}

function familyHeader(key, count, total) {
  const mcu = (ALL.find((t) => t.product_line === key) || {}).mcu;
  const countTxt = (total != null && count !== total)
    ? `${count} of ${total} builds`
    : `${count} build${count === 1 ? "" : "s"}`;
  const head = el("div", "fam-head");
  head.innerHTML =
    `<span class="fam-name">${escapeHtml(famName(key))}</span>` +
    `<span class="fam-meta">${MCU_LABEL[mcu] || mcu || ""}${famTag(key) ? " · " + escapeHtml(famTag(key)) : ""}</span>` +
    `<span class="fam-count">${countTxt}</span>`;
  return head;
}

function tagHeader(g) {
  const gh = el("div", "tag-head");
  gh.innerHTML =
    `<span class="tag-name">${escapeHtml(g.tag)}</span>` +
    `<span class="tag-count">${g.items.length} build${g.items.length === 1 ? "" : "s"}</span>` +
    `<span class="tag-rule" aria-hidden="true"></span>`;
  return gh;
}

// group product lines in LINES order, then any extras not in LINES
function orderedLines(keys) {
  return [
    ...LINES.map((l) => l[0]).filter((k) => keys.includes(k)),
    ...keys.filter((k) => !LINES.some((l) => l[0] === k)),
  ];
}

function render() {
  syncTiles();
  updateFamilyHelp();
  if (query) { renderSearch(); return; }
  renderOpenLines();
}

function renderOpenLines() {
  const keys = orderedLines([...openLines]).filter(linePresent);
  if (!keys.length) {
    const prompt = el("div", "pick-prompt");
    prompt.textContent = "Pick a device above to see its firmware — or hit Detect to auto-select.";
    buildsEl.replaceChildren(prompt);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const key of keys) frag.append(familySection(key));
  buildsEl.replaceChildren(frag);
}

function familySection(key) {
  const items = ALL.filter((t) => t.product_line === key).sort(recThenName);
  const section = el("section", "fam-section");
  section.append(familyHeader(key, items.length));
  if (!items.length) {
    section.append(emptyBox("No firmware for this device yet — run the Build & Deploy workflow to populate it."));
    return section;
  }
  for (const g of groupsFor(items)) {
    if (g.show) section.append(tagHeader(g));
    const list = el("div", "fw-list");
    for (const t of g.items) list.append(renderCard(t));
    section.append(list);
  }
  return section;
}

// search spans every family — results grouped by family (flat list per family)
function renderSearch() {
  const shown = ALL.filter(matchesQuery);
  if (!shown.length) {
    buildsEl.replaceChildren(emptyBox("No firmware matches your search."));
    return;
  }
  const byLine = new Map();
  for (const t of shown) {
    if (!byLine.has(t.product_line)) byLine.set(t.product_line, []);
    byLine.get(t.product_line).push(t);
  }
  const frag = document.createDocumentFragment();
  for (const key of orderedLines([...byLine.keys()])) {
    const items = byLine.get(key).sort(recThenName);
    const total = ALL.filter((t) => t.product_line === key).length;
    const section = el("section", "fam-section");
    section.append(familyHeader(key, items.length, total));
    const list = el("div", "fw-list");
    for (const t of items) list.append(renderCard(t));
    section.append(list);
    frag.append(section);
  }
  buildsEl.replaceChildren(frag);
}

function renderCard(t) {
  const open = openCards.has(t.id);
  const img = BOARD_IMG[t.product_line];
  const desc = stripNote(t.description);
  const chip = MCU_LABEL[t.mcu] || t.mcu || "";
  const ver = t.version ? `v${t.version}` : "";

  const card = el("article", "fw-card" + (open ? " open" : ""));
  card.dataset.id = t.id;

  // ---- header (click to expand) ----
  const headBtn = document.createElement("button");
  headBtn.type = "button";
  headBtn.className = "fw-head";
  headBtn.setAttribute("aria-expanded", String(open));

  const thumb = el("span", "fw-thumb");
  if (img) {
    const im = document.createElement("img");
    im.src = img; im.alt = ""; im.loading = "lazy";
    thumb.append(im);
  } else {
    thumb.append(el("span", "fw-thumb-ph", "▢"));
  }

  const main = el("span", "fw-main");
  const titleRow = el("span", "fw-titlerow");
  titleRow.append(el("span", "fw-name", t.name || t.id));
  if (t.recommended) titleRow.append(el("span", "fw-default", "★ DEFAULT"));
  const chipRow = el("span", "fw-chiprow");
  chipRow.append(el("span", "fw-chip", chip));
  if (ver) chipRow.append(el("span", "fw-ver", ver));
  main.append(titleRow, chipRow);
  if (desc) main.append(el("span", "fw-short", desc));

  headBtn.append(thumb, main, el("span", "fw-chevron", "▸"));
  card.append(headBtn);

  // ---- expanded detail ----
  const detail = el("div", "fw-detail");
  if (img) {
    const wrap = el("div", "fw-img");
    const im = document.createElement("img");
    im.src = img; im.alt = `${famName(t.product_line)} board`; im.loading = "lazy";
    wrap.append(im);
    detail.append(wrap);
  }
  if (desc) detail.append(el("p", "fw-long", desc));

  const meta = el("div", "fw-meta");
  meta.append(metaItem("Model", t.model || "—"), metaItem("Version", ver || "—"));
  if (t.radio) meta.append(metaItem("Radio", RADIO_LABEL[t.radio] || t.radio));
  detail.append(meta);

  const addons = t.addons || [];
  if (addons.length) detail.append(el("div", "fw-addon", `⚠ needs ${addons.join(", ")}`));

  const links = el("div", "fw-links");
  const steps = t.quickstart || [];
  if (steps.length) {
    const d = document.createElement("details");
    d.className = "fw-quickstart";
    const sum = document.createElement("summary");
    sum.innerHTML = `<span class="adv-caret" aria-hidden="true">▸</span> Quickstart`;
    const ol = document.createElement("ol");
    for (const s of steps) { const li = document.createElement("li"); li.textContent = s; ol.append(li); }
    d.append(sum, ol);
    links.append(d);
  }
  if (t.program_url) {
    const a = document.createElement("a");
    a.className = "fw-src"; a.href = t.program_url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "Source ↗";
    links.append(a);
  }
  if (links.childElementCount) detail.append(links);
  card.append(detail);

  // ---- flash row ----
  const flashRow = el("div", "fw-flashrow");
  flashRow.append(makeFlashAction(t, open));
  card.append(flashRow);

  headBtn.addEventListener("click", () => toggleCard(card, t));
  return card;
}

function metaItem(label, value) {
  const d = el("div", "fw-meta-item");
  d.append(el("dt", null, label), el("dd", null, value));
  return d;
}

function toggleCard(card, t) {
  const nowOpen = !card.classList.contains("open");
  card.classList.toggle("open", nowOpen);
  const head = card.querySelector(".fw-head");
  if (head) head.setAttribute("aria-expanded", String(nowOpen));
  if (nowOpen) openCards.add(t.id); else openCards.delete(t.id);
  const btn = card.querySelector(".fw-flash[data-flash='esp']");
  if (btn && !btn.disabled) btn.textContent = nowOpen ? "⚡ Flash this build" : "⚡ Flash";
}

function makeFlashAction(t, open) {
  if (t.flow === "uf2") return makeUf2Action(t);
  const btn = document.createElement("button");
  btn.className = "btn fw-flash";
  btn.type = "button";
  if (HAS_SERIAL) {
    btn.dataset.flash = "esp";
    btn.textContent = open ? "⚡ Flash this build" : "⚡ Flash";
    btn.addEventListener("click", () => flashProfile(t));
  } else {
    btn.textContent = "Needs Web Serial";
    btn.disabled = true;
  }
  return btn;
}

function makeUf2Action(t) {
  const dl = document.createElement("a");
  dl.className = "btn fw-flash";
  dl.textContent = "Download .uf2";
  dl.setAttribute("download", "");
  dl.href = `firmware/${t.id}.uf2`;
  // refine the path from the side manifest when available
  fetch(`manifests/${t.manifest}`, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((side) => { if (side && side.uf2_path) dl.href = side.uf2_path.replace(/^\.\.\//, ""); })
    .catch(() => {});
  return dl;
}

// --- reactive mascot ---------------------------------------------------------
let mascotTimer = null;
function setMascot(phase, name) {
  const cat = document.getElementById("heroCat");
  const title = document.getElementById("heroTitle");
  const sub = document.getElementById("heroSub");
  const bar = document.getElementById("heroBar");
  const hero = document.getElementById("detectHero");
  if (!cat) return;
  clearTimeout(mascotTimer); mascotTimer = null;

  const artKey = phase === "found" ? "success" : phase;
  cat.textContent = CAT[artKey] || CAT.idle;
  if (hero) hero.className = "detect-hero mascot-" + artKey;

  const idle = phase === "idle";
  if (sub) sub.hidden = !idle;
  if (bar) bar.hidden = phase !== "working";
  if (detectBtn) detectBtn.hidden = phase === "working";

  if (phase === "working") title.textContent = `Flashing ${name || "your board"}…`;
  else if (phase === "success") title.textContent = `${name || "Your board"} flashed! Unplug & enjoy ♥`;
  else if (phase === "error") title.textContent = "Hiccup — check the popup for the fix";
  else if (phase === "found") title.textContent = name && name !== "board"
    ? `Found your ${name} — here it is`
    : "Found your board — pick which one below";
  else title.textContent = "Plug in your board";

  // reactive states settle back to idle so the hero stays inviting
  if (phase === "success") mascotTimer = setTimeout(() => setMascot("idle"), 5000);
  else if (phase === "error") mascotTimer = setTimeout(() => setMascot("idle"), 6000);
  else if (phase === "found") mascotTimer = setTimeout(() => setMascot("idle"), 4500);
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
    // Drop the port so the next "Detect my board" click re-opens the browser picker —
    // lets the user choose a different port (or the same one, in download mode) on retry.
    grantedPort = null;
    showDetected(`Detect failed: ${e.message}. Put the board in download mode (see Flashing help), then click Detect to try again — you can pick a different port.`, "err");
    setMascot("error");
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
    setMascot("error");
    return;
  }
  let lines = LINES_BY_MCU[mcu] || [];
  const flashMb = parseInt(flash, 10); // "8 MB flash" -> 8, "" -> NaN
  const byFlash = (LINES_BY_MCU_FLASH[mcu] || {})[flashMb];
  if (byFlash) lines = byFlash;
  // only offer families that actually have firmware in the catalog
  lines = lines.filter((k) => ALL.some((t) => t.product_line === k));
  const chipTxt = `${MCU_LABEL[mcu]}${flash ? " · " + flash : ""}`;

  if (lines.length === 1) {
    setOpenLines(lines);
    setMascot("found", famName(lines[0]));
    showDetected(`Detected <b>${famName(lines[0])}</b> (${chipTxt}) — showing its firmware.`, "ok");
  } else if (lines.length > 1) {
    // ambiguous chip: open every applicable board (all highlighted green) so the user
    // collapses whichever isn't theirs
    setOpenLines(lines);
    setMascot("found", "board");
    const allOpen = lines.length === 2 ? "Both are" : "They're all";
    showDetected(`Detected <b>${chipTxt}</b> — this could be ${joinBoards(lines)}. ${allOpen} open below; collapse the one that isn't yours.`, "ok");
  } else {
    showDetected(`Detected ${chipTxt} — no matching firmware in the catalog yet.`, "err");
    setMascot("error");
  }
}

function showDetected(html, kind) {
  detectedEl.hidden = false;
  detectedEl.className = `banner banner-detect banner-${kind}`;
  const actions = (kind === "ok" || kind === "err")
    ? ` <button class="link-repick" type="button">use a different port</button> <button class="link-clear" type="button">clear</button>`
    : "";
  detectedEl.innerHTML = html + actions;
  const clearBtn = detectedEl.querySelector(".link-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => clearDetection());
  // Picked the wrong serial port? Drop it and re-prompt the browser port picker.
  const repick = detectedEl.querySelector(".link-repick");
  if (repick) repick.addEventListener("click", () => { grantedPort = null; detectBoard(); });
}

function hideDetected() { detectedEl.hidden = true; detectedEl.innerHTML = ""; }

// "a WiFi Nugget or a Pusheen" / "a Bluetooth Nugget, a Nibble, or a DEF CON Badge"
function joinBoards(keys) {
  const names = keys.map(famName);
  if (names.length === 1) return "a " + names[0];
  if (names.length === 2) return "a " + names[0] + " or a " + names[1];
  return "a " + names.slice(0, -1).join(", a ") + ", or a " + names[names.length - 1];
}

function clearDetection() {
  hideDetected();
  setMascot("idle");
}

// --- flashing via vendored esptool-js ----------------------------------------
// D1 Mini (ESP8266) boards use a CH340 that is unreliable over Web Serial above
// 115200; native-USB ESP32-S2/S3 have no such adapter and handle high baud fine.
const NATIVE_USB = new Set(["esp32-s2", "esp32-s3"]);
function resolveBaud(mcu) {
  const sel = baudSel ? baudSel.value : "auto";
  if (sel && sel !== "auto") return parseInt(sel, 10) || 115200;
  // 460800 is hardware-verified fast + reliable on both the CH340 (ESP8266) and
  // native-USB (ESP32-S2/S3) boards; 921600 is the CH340's ceiling and fails.
  return 460800;
}
const BOOT_HELP = "hold the BOOT button, tap RESET once, then release BOOT (no RESET button? hold BOOT while plugging in USB, then release)";

// Flash a catalog profile: fetch its (single, merged) bin and run the shared flasher.
function flashProfile(t) {
  return flashImage({
    name: t.name, manifest: t.manifest, expectMcu: t.mcu,
    loadParts: async () => {
      const resp = await fetch(`firmware/${t.id}.bin`, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`Couldn't download the firmware (HTTP ${resp.status}).`);
      return [{ data: new Uint8Array(await resp.arrayBuffer()), address: 0 }];
    },
    retry: () => flashProfile(t),
  });
}
// Flash one or more user-supplied .bin parts, each at its own offset (Adafruit-style
// multi-part). No chip lock-in — it's the user's file(s).
function flashCustomParts(parts) {
  const name = parts.length === 1 ? parts[0].file.name : `${parts.length} parts`;
  return flashImage({
    name, manifest: null, expectMcu: null,
    loadParts: async () => Promise.all(parts.map(async (p) => ({
      data: new Uint8Array(await p.file.arrayBuffer()), address: p.offset || 0,
    }))),
    retry: () => flashCustomParts(parts),
  });
}

// Shared esptool-js flash flow used by both the catalog and the custom-.bin path.
async function flashImage(ctx) {
  if (!HAS_SERIAL) return;
  const baud = resolveBaud(ctx.expectMcu);
  const eraseAll = !!(eraseChk && eraseChk.checked);

  let mod;
  try { mod = await loadEsptool(); }
  catch { openFlash(ctx); showFlashError(ctx, "Couldn't load the flasher.", {}); return; }
  const { ESPLoader, Transport } = mod;

  openFlash(ctx);
  if (NATIVE_USB.has(ctx.expectMcu)) setFlashHint(`If your board won't connect, put it in install mode: ${BOOT_HELP}.`);

  let port;
  try { port = await acquirePort(); }
  catch { closeFlash(); setMascot("idle"); return; } // user dismissed the browser port picker

  const term = { clean() {}, writeLine() {}, write() {} };
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport, baudrate: baud, romBaudrate: 115200,
    serialOptions: { bufferSize: 8192, flowControl: "none" },
    terminal: term, debugLogging: false,
  });
  try {
    setFlashStatus("Connecting to your board…");
    const chipName = await loader.main();
    const mcu = mapChip(chipName);
    if (ctx.expectMcu && mcu && mcu !== ctx.expectMcu) {
      const err = new Error(`This board is a ${chipName}, but “${ctx.name}” is built for ${MCU_LABEL[ctx.expectMcu] || ctx.expectMcu}.`);
      err.mismatch = true;
      throw err;
    }
    setFlashHint("Keep this tab open and don't unplug the board until it says Done.");
    setFlashStatus(ctx.expectMcu ? "Downloading firmware…" : `Detected ${chipName || "chip"}. Loading your file…`);
    // esptool-js 0.6.0 requires each part's data as a Uint8Array (issue #233).
    const parts = await ctx.loadParts();
    if (!parts.length || parts.some((p) => !p.data || !p.data.length)) throw new Error("A firmware part is empty or unreadable.");
    if (eraseAll) setFlashStatus("Erasing the whole chip…");
    await loader.writeFlash({
      fileArray: parts,
      flashSize: "keep", flashMode: "keep", flashFreq: "keep",
      eraseAll, compress: true,
      reportProgress: (i, written, total) => {
        setFlashProgress(written, total);
        const lbl = parts.length > 1 ? `part ${i + 1}/${parts.length} ` : "";
        setFlashStatus(`Writing ${lbl}… ${Math.round((written / total) * 100)}%`);
      },
    });
    setFlashStatus("Finishing up…");
    await loader.after("hard_reset");
    showFlashSuccess(ctx);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    try { await transport.disconnect(); } catch {}
    // A failed attempt can leave the port's streams in a bad state; drop the reference
    // so a retry (or the classic flasher) acquires a clean port instead of reusing it.
    grantedPort = null;
    showFlashError(ctx, msg, { mismatch: !!e.mismatch, mcu: ctx.expectMcu });
    return;
  }
  try { await transport.disconnect(); } catch {}
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
       <pre class="flash-cat" aria-hidden="true"></pre>
       <div class="flash-bar"><div class="flash-bar-fill"></div></div>
       <div class="flash-pct"></div>
       <div class="flash-status"></div>
       <div class="flash-hint"></div>
       <div class="flash-actions"></div>
     </div>`;
  document.body.append(overlayEl);
  return overlayEl;
}
function openFlash(ctx) {
  const o = ensureOverlay();
  o.hidden = false;
  o.className = "flash-overlay state-flashing";
  o.querySelector(".flash-title").textContent = `Flashing ${ctx.name}`;
  o.querySelector(".flash-cat").textContent = "";
  o.querySelector(".flash-bar").style.display = "";
  o.querySelector(".flash-actions").replaceChildren();
  setFlashProgress(0, 1);
  setFlashStatus("");
  setFlashHint("");
  setMascot("working", ctx.name);
}
function setFlashStatus(text) { ensureOverlay().querySelector(".flash-status").textContent = text; }
function setFlashHint(text) { ensureOverlay().querySelector(".flash-hint").textContent = text; }
function setFlashProgress(written, total) {
  const o = ensureOverlay();
  const pct = total ? Math.round((written / total) * 100) : 0;
  o.querySelector(".flash-bar-fill").style.width = pct + "%";
  o.querySelector(".flash-pct").textContent = pct + "%";
  const hb = document.getElementById("heroBarFill");
  if (hb) hb.style.width = pct + "%";
}
function showFlashSuccess(ctx) {
  const o = ensureOverlay();
  o.className = "flash-overlay state-ok";
  o.querySelector(".flash-title").textContent = `✓ Flashed ${ctx.name}!`;
  o.querySelector(".flash-cat").textContent = catArt("hacker");
  setFlashProgress(1, 1);
  setFlashStatus("Your board is restarting into the new firmware.");
  setFlashHint("If it doesn't start up, unplug the board and plug it back in.");
  const actions = o.querySelector(".flash-actions");
  actions.replaceChildren(
    btnEl("a", "btn", "Open Serial Monitor", { href: "serial.html" }),
    btnEl("button", "btn secondary", "Flash another board", { onclick: () => {
      grantedPort = null; closeFlash(); clearDetection(); window.scrollTo({ top: 0, behavior: "smooth" });
    } }),
    btnEl("button", "btn secondary", "Done", { onclick: closeFlash }),
  );
  setMascot("success", ctx.name);
}
// Turn a raw esptool-js error into a plain-language explanation for a beginner.
function mapFlashError(raw, info) {
  const m = (raw || "").toLowerCase();
  if (info.mismatch) return { title: "Wrong firmware for this board", body: raw + " Pick the firmware that matches your board.", classic: false };
  if (/already open|resource busy|failed to open|access denied|in use|not readable|not writable/.test(m))
    return { title: "The board is busy", body: "Another program or browser tab is using this board. Close the Serial Monitor tab, Arduino IDE, or other flasher tabs, then try again.", classic: true };
  if (/failed to connect|sync|no serial data|timed out|packet header|invalid head|wrong boot/.test(m))
    return { title: "Couldn't reach the board", body: (NATIVE_USB.has(info.mcu) ? `Put the board in install mode — ${BOOT_HELP} — then Retry. ` : "") + "Also make sure you're using a USB cable that carries data (not charge-only), and that nothing else has the port open.", classic: true };
  if (/disconnect|device.*(lost|gone)|stream stopped|noise|corruption|break/.test(m))
    return { title: "The connection dropped", body: "The board disconnected while flashing. Check the USB cable and port, then Retry. If it keeps happening, use the classic flasher below.", classic: true };
  return { title: "Flashing didn't finish", body: raw + " Try again, or use the classic flasher below.", classic: true };
}
function showFlashError(ctx, msg, info) {
  info = info || {};
  const o = ensureOverlay();
  o.className = "flash-overlay state-err";
  const mapped = mapFlashError(msg, info);
  o.querySelector(".flash-title").textContent = mapped.title;
  o.querySelector(".flash-bar").style.display = "none";
  setFlashStatus(mapped.body);
  setFlashHint("");

  const actions = o.querySelector(".flash-actions");
  actions.replaceChildren();
  if (ctx.retry) actions.append(btnEl("button", "btn", "Retry", { onclick: () => { closeFlash(); ctx.retry(); } }));
  if (mapped.classic && ctx.manifest) actions.append(classicFlasherButton(ctx));
  actions.append(btnEl("button", "btn secondary", "Close", { onclick: closeFlash }));
  setMascot("error", ctx.name);
}

// The ESP Web Tools "classic flasher" fallback: battle-tested at 115200 over Web
// Serial. Rendered as a real <esp-web-install-button> so its dialog manages its own
// fresh port; we just close our overlay when it launches.
function classicFlasherButton(ctx) {
  const ewt = document.createElement("esp-web-install-button");
  ewt.setAttribute("manifest", `manifests/${ctx.manifest}`);
  const act = document.createElement("button");
  act.setAttribute("slot", "activate");
  act.className = "btn secondary";
  act.textContent = "Use classic flasher";
  act.addEventListener("click", closeFlash);
  ewt.append(act);
  const unsupported = document.createElement("span");
  unsupported.setAttribute("slot", "unsupported");
  unsupported.className = "unsupported-note";
  unsupported.textContent = "Needs a Web Serial browser";
  ewt.append(unsupported);
  return ewt;
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

// --- custom .bin flashing (single merged image, or multi-part like Adafruit) --
function parseOffset(v) {
  const raw = (v || "0").trim();
  const o = /^0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
  return Number.isFinite(o) && o >= 0 ? o : 0;
}
function setupCustomFlash() {
  const fileInput = document.getElementById("customFile");
  const dropzone = document.getElementById("dropzone");
  const dropText = document.getElementById("dropText");
  const flashBtn = document.getElementById("customFlash");
  const offsetInput = document.getElementById("customOffset");
  const partsEl = document.getElementById("cfParts");
  const addBtn = document.getElementById("cfAddPart");
  if (!fileInput || !dropzone || !flashBtn) return;

  let file0 = null;
  const extra = []; // additional parts: [{ file, offsetInput }]
  const anyFile = () => !!file0 || extra.some((e) => e.file);
  const refreshBtn = () => { flashBtn.disabled = !HAS_SERIAL || !anyFile(); };

  const setFile0 = (f) => {
    file0 = f || null;
    dropText.innerHTML = file0
      ? `<b>${escapeHtml(file0.name)}</b> · ${(file0.size / 1024).toFixed(1)} KB`
      : "Drop a <b>.bin</b> here, or click to choose a file";
    refreshBtn();
  };
  fileInput.addEventListener("change", () => setFile0(fileInput.files[0]));
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault(); dropzone.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile0(e.dataTransfer.files[0]);
  });

  function addPartRow(defaultOffset) {
    const row = document.createElement("div");
    row.className = "cf-part";
    const fileBtn = document.createElement("label");
    fileBtn.className = "cf-file";
    const fi = document.createElement("input");
    fi.type = "file"; fi.accept = ".bin,application/octet-stream"; fi.hidden = true;
    const fname = document.createElement("span");
    fname.className = "cf-fname"; fname.textContent = "Choose .bin…";
    fileBtn.append(fi, fname);
    const off = document.createElement("input");
    off.className = "cf-offset"; off.value = defaultOffset || "0x10000"; off.spellcheck = false; off.placeholder = "0x…";
    off.setAttribute("aria-label", "part offset");
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "cf-remove"; rm.textContent = "✕"; rm.title = "Remove this part";
    row.append(fileBtn, off, rm);
    const entry = { file: null, offsetInput: off };
    fi.addEventListener("change", () => { entry.file = fi.files[0] || null; fname.textContent = entry.file ? entry.file.name : "Choose .bin…"; refreshBtn(); });
    rm.addEventListener("click", () => { row.remove(); const i = extra.indexOf(entry); if (i >= 0) extra.splice(i, 1); refreshBtn(); });
    extra.push(entry);
    partsEl.append(row);
  }
  if (addBtn && partsEl) addBtn.addEventListener("click", () => addPartRow());

  flashBtn.addEventListener("click", () => {
    const parts = [];
    if (file0) parts.push({ file: file0, offset: parseOffset(offsetInput && offsetInput.value) });
    for (const e of extra) if (e.file) parts.push({ file: e.file, offset: parseOffset(e.offsetInput.value) });
    if (!parts.length) return;
    flashCustomParts(parts);
  });
  refreshBtn();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- helpers -----------------------------------------------------------------
function stripNote(desc) {
  if (!desc) return "";
  return desc.split(/\s*NOTE:/i)[0].trim();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function catArt(name) {
  const e = document.querySelector(`#cats [data-cat="${name}"]`);
  return e ? e.textContent : "";
}
function emptyBox(text) {
  const box = el("div", "empty");
  const cat = document.createElement("pre");
  cat.className = "cat-art";
  cat.textContent = catArt("terminal");
  box.append(cat, el("div", "empty-text", text));
  return box;
}
function renderEmpty(err) {
  buildsEl.replaceChildren(emptyBox(err
    ? "No firmware published yet — run the Build & Deploy workflow to populate the library."
    : "No firmware is configured yet."));
}
