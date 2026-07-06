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
const form = document.getElementById("sendForm");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");

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
fitAddon.fit();
new ResizeObserver(() => { try { fitAddon.fit(); } catch {} }).observe(document.getElementById("terminal"));
window.addEventListener("resize", () => { try { fitAddon.fit(); } catch {} });

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
  try { port = await navigator.serial.requestPort(); }
  catch { return; }
  try { await port.open({ baudRate: parseInt(baudSel.value, 10), bufferSize: 8192 }); }
  catch (e) { writeLine(`Could not open port: ${e.message}`, "err"); port = null; return; }
  setConnected(true);
  writeLine(`Connected at ${baudSel.value} baud.`, "sys");
  readLoop();
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
  if (!port || !port.writable) return;
  const payload = text + unescapeEnding(lineEndingSel.value);
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(payload));
    if (text) { history.push(text); histIdx = -1; }
    if (echo.checked) writeLine(`» ${text}`, "in");
    inputEl.value = "";
  } catch (e) {
    writeLine(`Write error: ${e.message}`, "err");
  } finally {
    writer.releaseLock();
  }
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
  if (on) inputEl.focus();
}
function intro() {
  writeLine("scriptkitty Serial Monitor  =^._.^=", "sys");
  writeLine("Click Connect, choose your board's port, and go. Output is colorized; the whole session is saved (never truncated).", "sys");
}

if (supported) {
  navigator.serial.addEventListener("disconnect", (e) => { if (port && e.target === port) disconnect(); });
}
