// Renders the flashable-target catalog from manifests/index.json (generated in CI
// by scripts/generate_manifests.py). ESP targets use the vendored ESP Web Tools
// install button; RP2040 targets render the UF2 / BOOTSEL drag-and-drop flow.

const targetsEl = document.getElementById("targets");
const tpl = document.getElementById("tpl-card");

// Web Serial gate (RP2040/UF2 does not need it, so this is a warning, not a block).
if (!("serial" in navigator)) {
  document.getElementById("unsupported").hidden = false;
}

const MCU_LABEL = {
  "esp32": "ESP32",
  "esp32-s2": "ESP32-S2",
  "esp32-s3": "ESP32-S3",
  "esp8266": "ESP8266",
  "rp2040": "RP2040",
};

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
  const targets = (data && data.targets) || [];
  if (!targets.length) {
    renderEmpty();
    return;
  }
  targetsEl.replaceChildren();
  for (const t of targets) targetsEl.append(renderCard(t));
}

function renderCard(t) {
  const node = tpl.content.cloneNode(true);
  node.querySelector(".card-name").textContent = t.name || t.id;
  node.querySelector(".mcu").textContent = MCU_LABEL[t.mcu] || t.mcu;
  node.querySelector(".version").textContent = t.version ? `v${t.version}` : "—";
  const flowEl = node.querySelector(".flow");
  const actionEl = node.querySelector(".card-action");

  if (t.flow === "uf2") {
    flowEl.textContent = "UF2 / BOOTSEL";
    renderUf2(actionEl, t);
  } else {
    flowEl.textContent = "Web Serial";
    renderEsp(actionEl, t);
  }
  return node;
}

function renderEsp(actionEl, t) {
  const btn = document.createElement("esp-web-install-button");
  btn.setAttribute("manifest", `manifests/${t.manifest}`);

  const activate = document.createElement("button");
  activate.setAttribute("slot", "activate");
  activate.textContent = `Flash ${t.name}`;
  btn.append(activate);

  const unsupported = document.createElement("span");
  unsupported.setAttribute("slot", "unsupported");
  unsupported.className = "unsupported-note";
  unsupported.textContent = "Your browser can't flash this — try Chrome or Edge.";
  btn.append(unsupported);

  actionEl.append(btn);
}

async function renderUf2(actionEl, t) {
  // The RP2040 sidecar (manifests/<id>.json) carries the uf2 path + recovery hints.
  let side = {};
  try {
    const res = await fetch(`manifests/${t.manifest}`, { cache: "no-cache" });
    if (res.ok) side = await res.json();
  } catch { /* fall back to defaults below */ }

  const drive = side.drive_label || "RPI-RP2";
  const uf2Path = side.uf2_path ? side.uf2_path.replace(/^\.\.\//, "") : `firmware/${t.id}.uf2`;

  const wrap = document.createElement("div");
  wrap.className = "uf2";
  wrap.innerHTML = `
    <ol>
      <li>Hold <b>BOOTSEL</b> and plug the board in (keep holding until it mounts).</li>
      <li>A drive named <span class="drive">${drive}</span> appears.</li>
      <li>Download the firmware below and drop the <b>.uf2</b> onto that drive.</li>
      <li>The board reboots into the new firmware automatically.</li>
    </ol>`;
  const dl = document.createElement("a");
  dl.className = "btn";
  dl.href = uf2Path;
  dl.setAttribute("download", "");
  dl.textContent = `Download ${t.name} .uf2`;
  wrap.append(dl);
  actionEl.append(wrap);
}

function renderEmpty(err) {
  const msg = document.createElement("div");
  msg.className = "empty";
  msg.textContent = err
    ? "No firmware published yet — run the Build & Deploy workflow to populate targets."
    : "No flashable targets are configured yet.";
  targetsEl.replaceChildren(msg);
}
