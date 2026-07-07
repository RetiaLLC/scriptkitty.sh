// Serial monitor on xterm.js: real ANSI colorization (green by default), fit-to-window,
// in-buffer search, optional timestamps, command history, and a full-session log that is
// NEVER truncated (kept separately from the terminal scrollback so Save gets everything).

const connectBtn = document.getElementById("connect");
const baudSel = document.getElementById("baud");
const lineEndingSel = document.getElementById("lineEnding");
const echo = document.getElementById("echo");
const timestamps = document.getElementById("timestamps");
const resetBtn = document.getElementById("reset");
const clearBtn = document.getElementById("clear");
const saveBtn = document.getElementById("save");
const searchInput = document.getElementById("search");
const statusEl = document.getElementById("status");
const autoReconnectChk = document.getElementById("autoReconnect");
const quickSendEl = document.getElementById("quickSend");
const form = document.getElementById("sendForm");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");

// Quick-send macros — the WiFi Nugget commands from skickar/CatGotYourPassword
// (Missoula Wi-Fi self-defense class). Each button sends the command as-is.
const MACROS = [
  { label: "Scan devices", cmd: "scan -ch 1-12 -t 60 -ct 5000" },
  { label: "Probe reveal", cmd: "scan -m st -ch 1-12 -t 60 -ct 5000" },
  { label: "Pineapple reveal", cmd: 'probe -ssid/s "Pineapple1","Pineapple2","Pineapple3","Pineapple4","Pineapple5","Pineapple6","Pineapple7","Pineapple8","Pineapple9","Pineapple10","Pineapple11","Pineapple12","Pineapple13","Pineapple14","Pineapple15","Pineapple16","Pineapple17","Pineapple18","Pineapple19","Pineapple20","Pineapple21","Pineapple22","Pineapple23","Pineapple24","Pineapple25","Pineapple26","Pineapple27","Pineapple28","Pineapple29","Pineapple30","Pineapple31","Pineapple32","Pineapple33","Pineapple34" -ch 6' },
  { label: "Beacon swarm", cmd: 'beacon "A_Guest","Ace Hotel","Americas Best Value Inn","Amoeba - Guest","Budget Inn","CableWiFi","Camden","CenterWiFi","CityofLosAngelesGuest","CoffeeBeanWifi","Comfort Inn","Cricket-Guest","DHS_Guest","DaysInnOnline","Dennys_Guest_WIFI","FBI-SurveillanceVan","Google Starbucks","Guest","Guest T-Mobile","Guestnet","Hazelitas-guest","Hollywood Guest Inn","Hollywood Palms Inn & Suites","JWMarriott_GUEST","JWMarriott_LOBBY","Jacks_Guest","LAFILM Guest","LATTC-Visitor","LATimes-Guest","LAUSD-Guest","LAX-C guest","McDonalds Free WiFi","Moment Hotel","Netflix","Oh Ranger! Wi-Fi","PATH Wifi","Paulist-guest","Philz Coffee","Public Health Guest","Rodeway Inn","Roosevelt","SETUP","Saharan Motor Hotel","Sandhouse Wi-Fi","Staff","Starbucks WiFi","Stella Barra Guest","Students","Sunset 8 Motel","THEMELT","TWCWiFi","TWGuest","Tender Greens","URBAN_GUEST_WIFI","USC Guest Wireless","WHOPPERWIFI","WK-Guest","WL-GUEST","WLAN-GUEST","Wendys_Guest","WhopperWifi","WlanVPN","admin-guest","att-wifi","attwifi" -mon' },
];
// Control keys (raw bytes). Ctrl-C stops a running scan/beacon; Ctrl-D exits a REPL.
const CTRL_KEYS = [
  { label: "Ctrl-C", code: 3 },
  { label: "Ctrl-D", code: 4 },
  { label: "Esc", code: 27 },
];

let port = null;
let reader = null;
let keepReading = false;
let readClosed = null;
let fullLog = "";              // entire session, ANSI-stripped, never truncated
let atLineStart = true;        // for timestamp insertion
const history = [];            // sent-command history
let histIdx = -1;

const supported = "serial" in navigator;
if (!supported) {
  document.getElementById("unsupported").hidden = false;
  connectBtn.disabled = true;
}

// --- terminal ----------------------------------------------------------------
const term = new Terminal({
  fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  fontSize: 13,
  scrollback: 100000,
  cursorBlink: false,
  disableStdin: true,          // input goes through the send box below
  convertEol: false,           // firmware controls its own line endings
  theme: {
    background: "#07090d",
    foreground: "#4af07a",     // terminal green by default
    cursor: "#7cf5c4",
    selectionBackground: "#2a3140",
    black: "#0b0e13", red: "#ff6b6b", green: "#4af07a", yellow: "#f0d99a",
    blue: "#6ea8fe", magenta: "#c792ea", cyan: "#7cf5c4", white: "#e6e9ef",
    brightBlack: "#66707e", brightRed: "#ff8080", brightGreen: "#7cf5c4",
    brightYellow: "#ffe9a8", brightBlue: "#8fb8ff", brightMagenta: "#e0b0ff",
    brightCyan: "#a8f5e0", brightWhite: "#ffffff",
  },
});
const fitAddon = new FitAddon.FitAddon();
const searchAddon = new SearchAddon.SearchAddon();
term.loadAddon(fitAddon);
term.loadAddon(searchAddon);
term.open(document.getElementById("terminal"));
function refit() { try { fitAddon.fit(); } catch {} }
// Fit now, next frame, and again after the monospace web font loads — fitting before
// the font's metrics are known miscomputes row height and clips the top line.
refit();
requestAnimationFrame(refit);
setTimeout(refit, 250);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
new ResizeObserver(refit).observe(document.getElementById("terminal"));
window.addEventListener("resize", refit);

buildQuickSend();
intro();

// --- events ------------------------------------------------------------------
connectBtn.addEventListener("click", () => (port ? disconnect() : connect()));
clearBtn.addEventListener("click", () => { term.clear(); fullLog = ""; atLineStart = true; });
resetBtn.addEventListener("click", resetBoard);
saveBtn.addEventListener("click", saveLog);
baudSel.addEventListener("change", () => { if (port) writeLine(`(reconnect to apply ${baudSel.value} baud)`, "sys"); });
form.addEventListener("submit", (e) => { e.preventDefault(); sendCommand(); });
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? searchAddon.findPrevious(searchInput.value) : searchAddon.findNext(searchInput.value); }
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp") { e.preventDefault(); nav(-1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); nav(1); }
});
function nav(dir) {
  if (!history.length) return;
  if (histIdx === -1) histIdx = history.length;
  histIdx = Math.max(0, Math.min(history.length, histIdx + dir));
  inputEl.value = history[histIdx] || "";
}

// --- serial ------------------------------------------------------------------
async function connect() {
  let p;
  try { p = await navigator.serial.requestPort(); }
  catch { return; }
  await openPort(p);
}
async function openPort(p) {
  port = p;
  try { await port.open({ baudRate: parseInt(baudSel.value, 10), bufferSize: 8192 }); }
  catch (e) { writeLine(`Could not open port: ${e.message}`, "err"); port = null; return; }
  setConnected(true);
  writeLine(`Connected at ${baudSel.value} baud.`, "sys");
  readLoop();
}
// Reconnect without a prompt to a board already granted this session (e.g. right
// after flashing on the Flash page, or when the same board is re-plugged in).
async function tryAutoReconnect() {
  if (!supported || port || !autoReconnectChk.checked) return;
  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length) { writeLine("Auto-reconnecting to a known board…", "sys"); await openPort(ports[0]); }
  } catch { /* ignore */ }
}

async function readLoop() {
  const decoder = new TextDecoderStream();
  readClosed = port.readable.pipeTo(decoder.writable).catch(() => {});
  reader = decoder.readable.getReader();
  keepReading = true;
  try {
    while (keepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) onIncoming(value);
    }
  } catch (e) {
    writeLine(`Read error: ${e.message}`, "err");
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function onIncoming(text) {
  fullLog += stripAnsi(text);                      // whole-session log (clean)
  term.write(timestamps.checked ? stamp(text) : text);
}

async function sendCommand() {
  const text = inputEl.value;
  if (text) { history.push(text); histIdx = -1; }
  inputEl.value = "";
  await sendText(text);
}
async function sendText(text) {
  if (!port || !port.writable) return;
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text + unescapeEnding(lineEndingSel.value)));
    if (echo.checked) writeLine(`» ${text}`, "in");
  } catch (e) { writeLine(`Write error: ${e.message}`, "err"); } finally { writer.releaseLock(); }
}
async function sendRaw(bytes, label) {
  if (!port || !port.writable) return;
  const writer = port.writable.getWriter();
  try {
    await writer.write(new Uint8Array(bytes));
    if (echo.checked && label) writeLine(`» ${label}`, "in");
  } catch (e) { writeLine(`Write error: ${e.message}`, "err"); } finally { writer.releaseLock(); }
}
function buildQuickSend() {
  quickSendEl.replaceChildren();
  const lbl = document.createElement("span");
  lbl.className = "qs-label"; lbl.textContent = "Quick send:";
  quickSendEl.append(lbl);
  for (const m of MACROS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "qs-btn"; b.textContent = m.label; b.disabled = true;
    b.title = m.cmd.length > 90 ? m.cmd.slice(0, 90) + "…" : m.cmd;
    b.addEventListener("click", () => sendText(m.cmd));
    quickSendEl.append(b);
  }
  const sep = document.createElement("span");
  sep.className = "qs-sep"; quickSendEl.append(sep);
  for (const c of CTRL_KEYS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "qs-btn qs-ctrl"; b.textContent = c.label; b.disabled = true;
    b.title = `Send ${c.label}`;
    b.addEventListener("click", () => sendRaw([c.code], c.label));
    quickSendEl.append(b);
  }

  // A tiny toggle lives in the input row (which is always present), so hiding the
  // macros costs zero extra height — the bar is fully removed and the terminal grows.
  const toggle = document.getElementById("qsToggle");
  const setCollapsed = (c) => {
    quickSendEl.classList.toggle("collapsed", c);
    toggle.classList.toggle("active", !c);
    toggle.setAttribute("aria-expanded", String(!c));
    try { localStorage.setItem("sk_qs_collapsed", c ? "1" : "0"); } catch {}
    // fit AFTER the layout reflows, so xterm actually fills the reclaimed space
    requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
  };
  toggle.addEventListener("click", () => setCollapsed(!quickSendEl.classList.contains("collapsed")));
  let collapsed = false;
  try { collapsed = localStorage.getItem("sk_qs_collapsed") === "1"; } catch {}
  setCollapsed(collapsed);
}
function setQuickSendEnabled(on) {
  quickSendEl.querySelectorAll(".qs-btn").forEach((b) => (b.disabled = !on));
}

async function disconnect() {
  keepReading = false;
  try { if (reader) await reader.cancel(); } catch {}
  try { if (readClosed) await readClosed; } catch {}
  try { await port.close(); } catch {}
  port = null; reader = null;
  setConnected(false);
  writeLine("Disconnected.", "sys");
}

async function resetBoard() {
  if (!port) return;
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise((r) => setTimeout(r, 120));
    await port.setSignals({ requestToSend: false });
    writeLine("Sent reset (DTR/RTS pulse).", "sys");
  } catch (e) {
    writeLine(`Reset not supported on this port: ${e.message}`, "err");
  }
}

function saveLog() {
  const fname = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const blob = new Blob([fullLog], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `scriptkitty-serial-${fname}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- helpers -----------------------------------------------------------------
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function stamp(text) { // insert a dim timestamp at the start of each new line
  let out = "";
  for (const ch of text) {
    if (atLineStart) { out += `\x1b[90m[${ts()}]\x1b[0m `; atLineStart = false; }
    out += ch;
    if (ch === "\n") atLineStart = true;
  }
  return out;
}
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
function writeLine(text, kind) {
  const color = kind === "sys" ? "\x1b[38;2;110;168;254m" : kind === "in" ? "\x1b[38;2;124;245;196m" : kind === "err" ? "\x1b[38;2;255;128;128m" : "";
  term.write(`${color}${text}\x1b[0m\r\n`);
  fullLog += text + "\n";
  atLineStart = true;
}
function unescapeEnding(v) { return v.replace(/\\r/g, "\r").replace(/\\n/g, "\n"); }
function setConnected(on) {
  connectBtn.textContent = on ? "Disconnect" : "Connect";
  connectBtn.classList.toggle("secondary", on);
  statusEl.textContent = on ? "Connected" : "Disconnected";
  statusEl.classList.toggle("ok", on);
  baudSel.disabled = on;
  resetBtn.disabled = !on;
  inputEl.disabled = !on;
  sendBtn.disabled = !on;
  setQuickSendEnabled(on);
  if (on) inputEl.focus();
}
function intro() {
  writeLine("scriptkitty Serial Monitor  =^._.^=", "sys");
  writeLine("Click Connect, choose your board's port, and go. Output is colorized; the whole session is saved (never truncated).", "sys");
}

// remember baud + auto-reconnect preference across visits
try {
  const b = localStorage.getItem("sk_serial_baud"); if (b) baudSel.value = b;
  const ar = localStorage.getItem("sk_serial_autoreconnect"); if (ar !== null) autoReconnectChk.checked = ar === "1";
} catch {}
baudSel.addEventListener("change", () => { try { localStorage.setItem("sk_serial_baud", baudSel.value); } catch {} });
autoReconnectChk.addEventListener("change", () => { try { localStorage.setItem("sk_serial_autoreconnect", autoReconnectChk.checked ? "1" : "0"); } catch {} });

if (supported) {
  navigator.serial.addEventListener("disconnect", (e) => { if (port && e.target === port) disconnect(); });
  // reconnect when a previously-granted board is (re)plugged in
  navigator.serial.addEventListener("connect", () => { tryAutoReconnect(); });
  // and try once on load (covers the hand-off straight from flashing)
  tryAutoReconnect();
}
