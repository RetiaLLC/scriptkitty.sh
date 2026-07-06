// Searchable "all downloads" catalog. Reads manifests/index.json (generated in CI by
// scripts/generate_manifests.py), lets you search + filter by product line, shows each
// program's model/radio/add-ons, and flashes via the vendored ESP Web Tools button.

const targetsEl = document.getElementById("targets");
const searchEl = document.getElementById("search");
const filtersEl = document.getElementById("filters");
const countEl = document.getElementById("count");
const tpl = document.getElementById("tpl-card");

if (!("serial" in navigator)) {
  document.getElementById("unsupported").hidden = false;
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

let ALL = [];
let activeLine = "all";
let query = "";

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
      filtersEl.querySelectorAll(".filter").forEach((el) => el.classList.toggle("active", el.dataset.line === key));
      render();
    });
    filtersEl.append(b);
  }
}

function matches(t) {
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
    const meta = LINES.find((l) => l[0] === key);
    const section = document.createElement("section");
    section.className = "line-section";
    const head = document.createElement("div");
    head.className = "line-head";
    head.innerHTML = `<h2>${meta ? meta[1] : key}</h2>` + (meta ? `<span>${meta[2]}</span>` : "") +
      `<span class="line-n">${items.length}</span>`;
    section.append(head);
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
  const btn = document.createElement("esp-web-install-button");
  btn.setAttribute("manifest", `manifests/${t.manifest}`);
  const activate = document.createElement("button");
  activate.setAttribute("slot", "activate");
  activate.textContent = "Flash";
  btn.append(activate);
  const unsupported = document.createElement("span");
  unsupported.setAttribute("slot", "unsupported");
  unsupported.className = "unsupported-note";
  unsupported.textContent = "Chrome or Edge required";
  btn.append(unsupported);
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

// Drop the internal "NOTE: ..." reviewer aside from the public-facing description.
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
