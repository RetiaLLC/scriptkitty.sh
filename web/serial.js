// Browser serial monitor built on the raw Web Serial API — same lineage as the
// spacehuhn / nugget.dev terminal: connect to a port, stream its output, send
// commands, pick baud + line ending, autoscroll. No dependency on the flasher.

const connectBtn = document.getElementById("connect");
const baudSel = document.getElementById("baud");
const lineEndingSel = document.getElementById("lineEnding");
const autoscroll = document.getElementById("autoscroll");
const echo = document.getElementById("echo");
const resetBtn = document.getElementById("reset");
const clearBtn = document.getElementById("clear");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");
const termEl = document.getElementById("terminal");
const form = document.getElementById("sendForm");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");

const MAX_CHARS = 200_000; // trim backlog so the DOM node stays light

let port = null;
let reader = null;
let keepReading = false;
let readClosed = null;

if (!("serial" in navigator)) {
  document.getElementById("unsupported").hidden = false;
  connectBtn.disabled = true;
}

intro();

connectBtn.addEventListener("click", () => (port ? disconnect() : connect()));
clearBtn.addEventListener("click", () => (termEl.textContent = ""));
resetBtn.addEventListener("click", resetBoard);
saveBtn.addEventListener("click", saveLog);
baudSel.addEventListener("change", () => {
  if (port) writeLine(`(reconnect to apply ${baudSel.value} baud)`, "sys");
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  sendCommand();
});

async function connect() {
  try {
    port = await navigator.serial.requestPort();
  } catch {
    return; // user dismissed the picker
  }
  try {
    await port.open({ baudRate: parseInt(baudSel.value, 10), bufferSize: 8192 });
  } catch (e) {
    writeLine(`Could not open port: ${e.message}`, "err");
    port = null;
    return;
  }
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
      if (value) write(value);
    }
  } catch (e) {
    writeLine(`Read error: ${e.message}`, "err");
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function sendCommand() {
  const text = inputEl.value;
  if (!port || !port.writable) return;
  const payload = text + unescapeEnding(lineEndingSel.value);
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(payload));
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
  port = null;
  reader = null;
  setConnected(false);
  writeLine("Disconnected.", "sys");
}

// Pulse DTR/RTS to reboot the board (ESP reset line), like spacehuhn's Reset.
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
  const blob = new Blob([termEl.textContent], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "scriptkitty-serial-log.txt";
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- rendering ---------------------------------------------------------------
function write(str) {
  const atBottom = isNearBottom();
  termEl.append(document.createTextNode(str));
  if (termEl.textContent.length > MAX_CHARS) {
    termEl.textContent = termEl.textContent.slice(-MAX_CHARS);
  }
  if (autoscroll.checked && atBottom) termEl.scrollTop = termEl.scrollHeight;
}

function writeLine(str, kind) {
  const span = document.createElement("span");
  span.className = `line line-${kind || "sys"}`;
  span.textContent = str + "\n";
  const atBottom = isNearBottom();
  termEl.append(span);
  if (autoscroll.checked && atBottom) termEl.scrollTop = termEl.scrollHeight;
}

function isNearBottom() {
  return termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight < 40;
}

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

function unescapeEnding(v) {
  return v.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}

function intro() {
  writeLine("Welcome to the scriptkitty Serial Monitor  =^._.^=", "sys");
  writeLine("Click Connect, pick your board's port, and go.", "sys");
}

// tidy up if the device is unplugged
if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", (e) => {
    if (port && e.target === port) disconnect();
  });
}
