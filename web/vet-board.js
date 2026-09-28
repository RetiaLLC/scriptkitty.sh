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
  const byRef = new Map(), byGpio = new Map();
  const bump = (map, k, h) => { const cur = map.get(k); if (!cur || RANK[h.status] > RANK[cur.status]) map.set(k, h); };
  for (const h of highlights) { for (const r of h.refs) bump(byRef, r, h); for (const g of h.gpios) bump(byGpio, g, h); }
  const layerOf = {}; for (const p of layout.parts) layerOf[p.ref] = p.layer;
  const padCount = {}; for (const pd of layout.pads) padCount[pd.ref] = (padCount[pd.ref] || 0) + 1;

  // One drawing per side. The bottom view is mirrored left-to-right, i.e. the board as you
  // see it once you flip it over, so a part sits where your iron would find it.
  const side = (layer) => {
    const mirror = layer === "B";
    const mx = (x) => (mirror ? x0 + x1 - x : x);
    const svg = mk("svg", { viewBox: `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`, class: `board-svg board-${layer}`, role: "img", "aria-label": `${title || "board"} ${mirror ? "bottom" : "top"} view` });
    const face = mk("path", { d: layout.outline, class: "board-face" });
    if (mirror) face.setAttribute("transform", `translate(${x0 + x1} 0) scale(-1 1)`);
    svg.append(face);
    const parts = layout.parts.filter((p) => p.layer === layer).sort((a, b) => (byRef.has(a.ref) ? 1 : 0) - (byRef.has(b.ref) ? 1 : 0));
    for (const p of parts) {
      const h = byRef.get(p.ref);
      const w = p.w || 1.4, hh = p.h || 1.4, cx = mx(p.x);
      const g = mk("g", { class: `part${h ? ` hl hl-${h.status} clickable` : ""}`, "data-ref": p.ref });
      g.append(p.shape === "circle"
        ? mk("circle", { cx, cy: p.y, r: Math.max(w, hh) / 2 })
        : mk("rect", { x: cx - w / 2, y: p.y - hh / 2, width: w, height: hh, rx: 0.25, transform: `rotate(${mirror ? p.rot : -p.rot} ${cx} ${p.y})` }));
      g.append(mk("title", {}, `${p.ref}${p.label ? " — " + p.label : ""}${p.value && p.value !== p.label ? ` (${p.value})` : ""}${h ? `\n${h.status.toUpperCase()}: ${h.title}` : ""}`));
      if (p.label && (w * hh >= 12 || h)) g.append(mk("text", { x: cx, y: p.y, class: "part-label", "text-anchor": "middle", "dominant-baseline": "middle" }, p.label));
      if (h) g.addEventListener("click", () => onPick(h.checkId));
      svg.append(g);
    }
    for (const pd of layout.pads) {
      if (layerOf[pd.ref] !== layer) continue;
      const h = pd.gpio != null ? byGpio.get(pd.gpio) : null;
      if (h) {
        const c = mk("circle", { cx: mx(pd.x), cy: pd.y, r: Math.max(0.6, Math.max(pd.w || 1, pd.h || 1) * 0.55), class: `pad hl hl-${h.status} clickable` });
        c.append(mk("title", {}, `${pd.ref} pad ${pd.pad} — GPIO${pd.gpio}\n${h.status.toUpperCase()}: ${h.title}`));
        c.addEventListener("click", () => onPick(h.checkId));
        svg.append(c);
      } else if (padCount[pd.ref] >= 8) {
        const d = mk("circle", { cx: mx(pd.x), cy: pd.y, r: Math.max(0.28, Math.min(pd.w || 1, pd.h || 1) * 0.3), class: "pad pad-dot" });
        d.append(mk("title", {}, `${pd.ref} pad ${pd.pad}${pd.gpio != null ? ` — GPIO${pd.gpio}` : pd.net ? ` — ${pd.net.split("/").pop()}` : ""}`));
        svg.append(d);
      }
    }
    const fig = document.createElement("figure"); fig.className = `board-side board-side-${layer}`;
    const n = highlights.filter((h) => h.refs.some((r) => layerOf[r] === layer) || h.gpios.some((g) => layout.pads.some((pd) => pd.gpio === g && layerOf[pd.ref] === layer))).length;
    fig.append(svg);
    const cap = document.createElement("figcaption");
    cap.textContent = (mirror ? "Bottom — as you see it flipped over" : "Top") + (n ? ` · ${n} finding${n === 1 ? "" : "s"} on this side` : "");
    fig.append(cap);
    return fig;
  };
  const views = document.createElement("div"); views.className = "board-views";
  views.append(side("F"));
  if (layout.parts.some((p) => p.layer === "B")) views.append(side("B"));
  el.replaceChildren(views);
  const legend = document.createElement("div"); legend.className = "board-legend";
  const note = highlights.length ? "Click a painted part or pad to jump to its finding." : "Nothing to point at — every part the vet can see checked out.";
  legend.innerHTML = `<span><i class="sw sw-fail"></i>needs rework</span><span><i class="sw sw-warn"></i>check</span><span class="board-note">${note}</span>`;
  el.append(legend);
  el.hidden = false;
  return views;
}

// A small bar chart of the antenna sweep: max RSSI per band, the noise floor, the pass line.
export function sweepChartSvg(c) {
  const bands = c?.sweep || [];
  if (!bands.length) return "";
  // wide viewBox so the axis text stays small next to the bars; a legend row up top keeps the
  // threshold/floor labels off the bars (they used to overprint the right-hand bars).
  const W = 460, H = 150, L = 40, R = 12, T = 30, B = 26, min = -120, max = -50, thr = -95;
  const plotH = H - T - B;
  const y = (dbm) => T + ((max - Math.max(min, Math.min(max, dbm))) / (max - min)) * plotH;
  const bw = (W - L - R) / bands.length;
  const peak = Math.max(...bands.map((b) => b.max));
  let s = `<svg class="vet-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="RSSI per band">`;
  // legend row (above the plot): threshold swatch + label, then the floor swatch + label
  s += `<line class="thr" x1="${L}" x2="${L + 16}" y1="12" y2="12"/><text class="thr-label" x="${L + 21}" y="15">heard ≥ ${thr} dBm</text>`;
  if (c.floor != null) s += `<line class="floor" x1="${L + 150}" x2="${L + 166}" y1="12" y2="12"/><text class="floor-label" x="${L + 171}" y="15">floor ${Math.round(c.floor)} dBm</text>`;
  // horizontal gridlines with left-edge dBm ticks
  for (const g of [-60, -80, -100]) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/><text class="tick" x="${L - 5}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end">${g}</text>`;
  s += `<text class="axis" x="${L - 5}" y="${(T - 4).toFixed(1)}" text-anchor="end">dBm</text>`;
  // threshold + floor lines across the plot (labels live in the legend, not on the bars)
  s += `<line class="thr" x1="${L}" x2="${W - R}" y1="${y(thr).toFixed(1)}" y2="${y(thr).toFixed(1)}"/>`;
  if (c.floor != null) s += `<line class="floor" x1="${L}" x2="${W - R}" y1="${y(c.floor).toFixed(1)}" y2="${y(c.floor).toFixed(1)}"/>`;
  // bars + MHz labels
  bands.forEach((b, i) => {
    const x = L + i * bw + 3, top = y(b.max), hot = b.max >= thr || (c.lift >= 10 && b.max === peak);
    s += `<rect class="bar${hot ? " bar-hot" : ""}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${(H - B - top).toFixed(1)}" rx="1"><title>${b.mhz} MHz — max ${Math.round(b.max)} dBm, mean ${Math.round(b.mean)} dBm</title></rect>`;
    s += `<text class="tick" x="${(x + (bw - 6) / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle">${b.mhz}</text>`;
  });
  s += `<text class="axis" x="${(L + (W - L - R) / 2).toFixed(1)}" y="${H - 1}" text-anchor="middle">MHz</text></svg>`;
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
