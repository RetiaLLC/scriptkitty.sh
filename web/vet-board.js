// vet-board.js — the board model at the top of a vet report: the PCB drawn from its KiCad
// layout (vet-layouts.js) with the parts a failing check implicates painted red (fail) or
// amber (warn). Pads are matched by GPIO net across every part, so a bridge reported on the
// ESP module's castellations also lights the same nets where they land on the radio module.
// Clicking a painted part jumps to that finding. Plain SVG, no dependencies.

const RANK = { fail: 2, warn: 1 };

// What each check points at. Protocol entries carry `refs` (pins, radio, i2c, ir, beacon,
// module); GPIO numbers resolve to pads through the layout's nets.
export function boardHighlights(report, protocol, layout) {
  const out = [];
  const spec = (g) => (protocol.pins || []).find((p) => p.gpio === g);
  for (const c of report?.checks || []) {
    if (!RANK[c.status]) continue;
    let refs = [], gpios = [], m;
    if ((m = /^gpio(\d+)$/.exec(c.id))) { gpios = [+m[1]]; refs = spec(+m[1])?.refs || []; }
    else if ((m = /^bridge-(\d+)-(\d+)$/.exec(c.id))) gpios = [+m[1], +m[2]];
    else if (c.id === "radio") { refs = protocol.radio?.refs || []; }
    else if (c.id === "antenna") { refs = protocol.radio?.antRefs || []; }
    else if (/^i2c-/.test(c.id)) { const bus = (protocol.i2c || []).find((b) => c.id === `i2c-${b.sda}`); refs = bus?.refs || []; gpios = bus ? [bus.sda, bus.scl] : []; }
    else if (c.id === "ir") { refs = protocol.ir?.refs || []; gpios = protocol.ir ? [protocol.ir.gpio] : []; }
    else if (["boot", "flash", "psram", "chip", "firmware"].includes(c.id)) refs = protocol.module?.refs || [];
    else if (c.id === "audio") refs = protocol.firmwareAudio?.refs || [];
    else if (c.id === "mic") refs = protocol.firmwareMic?.refs || [];
    else if (c.id === "beacon") refs = protocol.beacon?.refs || [];
    if (!refs.length && !gpios.length) continue;
    if (layout) { refs = refs.filter((r) => layout.parts.some((p) => p.ref === r)); }
    out.push({ checkId: c.id, status: c.status, title: c.title, refs, gpios });
  }
  return out;
}

export function renderBoard(el, layout, highlights, { onPick = () => {}, title = "" } = {}) {
  if (!el) return null;
  if (!layout) { el.hidden = true; el.replaceChildren(); return null; }
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs = {}, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
  const [x0, y0, x1, y1] = layout.bbox, pad = 1.5;
  const svg = mk("svg", { viewBox: `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`, class: "board-svg", role: "img", "aria-label": `${title || "board"} model` });
  svg.append(mk("path", { d: layout.outline, class: "board-face" }));

  const byRef = new Map(), byGpio = new Map();
  const bump = (map, k, h) => { const cur = map.get(k); if (!cur || RANK[h.status] > RANK[cur.status]) map.set(k, h); };
  for (const h of highlights) { for (const r of h.refs) bump(byRef, r, h); for (const g of h.gpios) bump(byGpio, g, h); }

  // parts: back side first (dashed), highlighted ones last so they sit on top
  const parts = [...layout.parts].sort((a, b) => (a.layer === "B" ? 0 : 1) - (b.layer === "B" ? 0 : 1) || (byRef.has(a.ref) ? 1 : 0) - (byRef.has(b.ref) ? 1 : 0));
  for (const p of parts) {
    const h = byRef.get(p.ref);
    const w = p.w || 1.4, hh = p.h || 1.4;
    const g = mk("g", { class: `part layer-${p.layer}${h ? ` hl hl-${h.status} clickable` : ""}`, "data-ref": p.ref });
    g.append(p.shape === "circle"
      ? mk("circle", { cx: p.x, cy: p.y, r: Math.max(w, hh) / 2 })
      : mk("rect", { x: p.x - w / 2, y: p.y - hh / 2, width: w, height: hh, rx: 0.25, transform: `rotate(${-p.rot} ${p.x} ${p.y})` }));
    const tip = `${p.ref}${p.label ? " — " + p.label : ""}${p.value && p.value !== p.label ? ` (${p.value})` : ""}${p.layer === "B" ? " · on the back" : ""}${h ? `\n${h.status.toUpperCase()}: ${h.title}` : ""}`;
    g.append(mk("title", {}, tip));
    if (p.label && (w * hh >= 12 || h)) g.append(mk("text", { x: p.x, y: p.y, class: "part-label", "text-anchor": "middle", "dominant-baseline": "middle" }, p.label));
    if (h) g.addEventListener("click", () => onPick(h.checkId));
    svg.append(g);
  }
  // pads on a highlighted net — every place that net is soldered
  for (const pd of layout.pads) {
    const h = pd.gpio != null ? byGpio.get(pd.gpio) : null;
    if (!h) continue;
    const c = mk("circle", { cx: pd.x, cy: pd.y, r: Math.max(0.6, Math.max(pd.w || 1, pd.h || 1) * 0.55), class: `pad hl hl-${h.status} clickable` });
    c.append(mk("title", {}, `${pd.ref} pad ${pd.pad} — GPIO${pd.gpio}\n${h.status.toUpperCase()}: ${h.title}`));
    c.addEventListener("click", () => onPick(h.checkId));
    svg.append(c);
  }
  el.replaceChildren(svg);
  const legend = document.createElement("div"); legend.className = "board-legend";
  const items = [`<span><i class="sw sw-fail"></i>needs rework</span>`, `<span><i class="sw sw-warn"></i>check</span>`, `<span><i class="sw sw-back"></i>on the back of the board</span>`];
  const note = highlights.length ? "Click a painted part or pad to jump to its finding." : "Nothing to point at — every part the vet can see checked out.";
  legend.innerHTML = items.join("") + `<span class="board-note">${note}</span>`;
  el.append(legend);
  el.hidden = false;
  return svg;
}

// A small bar chart of the antenna sweep: max RSSI per band, the noise floor, the pass line.
export function sweepChartSvg(c) {
  const bands = c?.sweep || [];
  if (!bands.length) return "";
  const W = 380, H = 118, L = 36, R = 6, T = 10, B = 24, min = -120, max = -50, thr = -95;
  const y = (dbm) => T + ((max - Math.max(min, Math.min(max, dbm))) / (max - min)) * (H - T - B);
  const bw = (W - L - R) / bands.length;
  const peak = Math.max(...bands.map((b) => b.max));
  let s = `<svg class="vet-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="RSSI per band">`;
  for (const g of [-60, -80, -100]) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/><text class="tick" x="${L - 4}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end">${g}</text>`;
  if (c.floor != null) s += `<line class="floor" x1="${L}" x2="${W - R}" y1="${y(c.floor).toFixed(1)}" y2="${y(c.floor).toFixed(1)}"/><text class="floor-label" x="${L + 3}" y="${(y(c.floor) - 3).toFixed(1)}">floor ${Math.round(c.floor)} dBm</text>`;
  s += `<line class="thr" x1="${L}" x2="${W - R}" y1="${y(thr).toFixed(1)}" y2="${y(thr).toFixed(1)}"/><text class="thr-label" x="${W - R}" y="${(y(thr) - 3).toFixed(1)}" text-anchor="end">antenna heard ≥ ${thr} dBm</text>`;
  bands.forEach((b, i) => {
    const x = L + i * bw + 3, top = y(b.max), hot = b.max >= thr || (c.lift >= 10 && b.max === peak);
    s += `<rect class="bar${hot ? " bar-hot" : ""}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${(H - B - top).toFixed(1)}"><title>${b.mhz} MHz — max ${Math.round(b.max)} dBm, mean ${Math.round(b.mean)} dBm</title></rect>`;
    s += `<text class="tick" x="${(x + (bw - 6) / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${b.mhz}</text>`;
  });
  s += `<text class="axis" x="${W - R}" y="${H - 8}" text-anchor="end"></text><text class="axis" x="${L - 4}" y="${T - 2}" text-anchor="end">dBm</text></svg>`;
  return s;
}

// The live IR panel: a strip of the last samples plus every code decoded so far.
export function irLiveHtml(p, secondsLeft, esc = (s) => String(s)) {
  const w = 320, h = 36, n = Math.max(2, p.recent?.length || 0), step = w / (n - 1);
  const pts = (p.recent || []).map((v, i) => `${(i * step).toFixed(1)},${v ? 5 : h - 5}`).join(" ");
  const codes = [];
  for (const f of p.frames || []) {
    if (f.unknown) continue;
    if (f.repeat) { if (codes.length) codes[codes.length - 1].repeats++; continue; }
    const last = codes[codes.length - 1];
    if (last && last.hex === f.hex) last.count++; else codes.push({ ...f, count: 1, repeats: 0 });
  }
  const hx = (v, n = 2) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(n, "0");
  const list = codes.length
    ? codes.map((c) => `<span class="ir-code"><b>NEC ${esc(c.hex)}</b>${c.name ? ` <em>${esc(c.name)}</em>` : ""}<small>addr ${hx(c.address)} · cmd ${hx(c.command)}${c.valid ? "" : " · checksum?"}${c.count > 1 ? ` · ×${c.count}` : ""}${c.repeats ? ` · +${c.repeats} repeats` : ""}</small></span>`).join("")
    : `<span class="ir-none">${p.transitions ? "activity on the receiver, waiting for a clean frame…" : "no light yet — hold a button on the remote, aimed at the board"}</span>`;
  return `<div class="ir-live"><div class="ir-head"><b>IR receiver</b> · ${secondsLeft} s left · ${p.transitions || 0} edges${p.rmt === false ? " · hardware capture unavailable, counting edges only" : ""}</div>` +
    `<svg class="ir-wave" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg><div class="ir-frames">${list}</div></div>`;
}
