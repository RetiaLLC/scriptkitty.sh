#!/usr/bin/env python3
"""Generate web/vet-layouts.js — board models for the vet page — straight from KiCad PCBs.

    board_layout.py newsheen=path/to/esp32_base_puck_v2.kicad_pcb [key=path ...] -o web/vet-layouts.js

Per board: the Edge.Cuts outline as one SVG path (lines + 3-point arcs, chained into a closed
loop), every footprint (ref, value, side, x, y, rotation, courtyard size) and every pad with
its net and, when the net names one, its GPIO number — so the page can paint the parts and
the pads a failing check implicates. Coordinates stay in KiCad millimetres (y down, like SVG).
"""
import json, math, re, sys

LABELS = {   # friendly names: per-board ref names (REF_LABELS[key]) first, then by value pattern
    "value": [(r"ESP32-S3-WROOM", "ESP32-S3"), (r"WIO-SX1262", "LoRa radio"), (r"TSOP", "IR receiver"), (r"SN74LVC1T45", "level shifter"),
              (r"AMS1117", "3.3 V reg"), (r"USB_C", "USB-C"), (r"WS2812", ""), (r"^LED$", "LED"), (r"SW_Push|SW_SPST", ""), (r"RFM95", "LoRa radio"),
              (r"ESP32-S3-ZERO", "ESP32-S3-Zero"), (r"HS96L03|HS91L02|SSD1306", "OLED"), (r"SolderJumper", "JP")],
    "ref": {"ANT1": "ANT"},
}
REF_LABELS = {
    "newsheen": {"J3": "J3 header", "SW3": "button", "SW1": "reset", "SW2": "boot", "R21": "R21", "D14": "LED", "JP1": "JP1"},
    "nibble-zero": {"SW1": "A", "SW2": "B", "SW3": "up", "SW4": "down", "SW5": "left", "SW6": "right", "RN1": "RN1", "R4": "LED R4", "D7": "WS2812", "J1": "Qwiic", "J2": "J2", "J3": "J3", "P1": "OLED"},
}

def tokenize(s): return re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+', s)
def parse(tokens):
    stack = [[]]
    for t in tokens:
        if t == "(": stack.append([])
        elif t == ")": x = stack.pop(); stack[-1].append(x)
        else: stack[-1].append(t[1:-1] if t.startswith('"') else t)
    return stack[0]
def find(n, k): return [x for x in n if isinstance(x, list) and x and x[0] == k]
def num(x): return float(x)
def pt(node, key):
    q = find(node, key); return (num(q[0][1]), num(q[0][2])) if q else None

def arc_svg(s, m, e):
    """3-point arc -> (radius, large, sweep) in a y-down frame (KiCad == SVG)."""
    ax, ay = s; bx, by = m; cx, cy = e
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9: return None
    ux = ((ax*ax + ay*ay) * (by - cy) + (bx*bx + by*by) * (cy - ay) + (cx*cx + cy*cy) * (ay - by)) / d
    uy = ((ax*ax + ay*ay) * (cx - bx) + (bx*bx + by*by) * (ax - cx) + (cx*cx + cy*cy) * (bx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    a1, am, a2 = (math.atan2(py - uy, px - ux) for px, py in (s, m, e))
    tw = 2 * math.pi
    fwd_m, fwd_e = (am - a1) % tw, (a2 - a1) % tw
    sweep = 1 if fwd_m < fwd_e else 0
    span = fwd_e if sweep else (a1 - a2) % tw
    return r, 1 if span > math.pi else 0, sweep

def outline_path(pcb):
    segs, circles = [], []
    for g in pcb:
        if not (isinstance(g, list) and g and g[0] in ("gr_line", "gr_arc", "gr_circle", "gr_rect")): continue
        ly = find(g, "layer")
        if not ly or ly[0][1] != "Edge.Cuts": continue
        if g[0] == "gr_circle":
            c, e = pt(g, "center"), pt(g, "end"); circles.append((c, math.hypot(e[0]-c[0], e[1]-c[1]))); continue
        if g[0] == "gr_rect":
            a, b = pt(g, "start"), pt(g, "end")
            segs += [{"s": a, "e": (b[0], a[1]), "m": None}, {"s": (b[0], a[1]), "e": b, "m": None}, {"s": b, "e": (a[0], b[1]), "m": None}, {"s": (a[0], b[1]), "e": a, "m": None}]
            continue
        segs.append({"s": pt(g, "start"), "e": pt(g, "end"), "m": pt(g, "mid") if g[0] == "gr_arc" else None})
    def close(a, b): return math.hypot(a[0]-b[0], a[1]-b[1]) < 0.02
    loops = []
    while segs:                                   # chain segments end-to-start into closed loops
        chain = [segs.pop(0)]
        while segs:
            cur = chain[-1]["e"]; hit = None
            for i, sg in enumerate(segs):
                if close(sg["s"], cur): hit = segs.pop(i); break
                if close(sg["e"], cur): sg = segs.pop(i); hit = {"s": sg["e"], "e": sg["s"], "m": sg["m"]}; break
            if not hit: break
            chain.append(hit)
        loops.append(chain)
    def loop_bbox(chain):
        xs, ys = [], []
        for sg in chain:
            xs += [sg["s"][0], sg["e"][0]]; ys += [sg["s"][1], sg["e"][1]]
            if sg["m"]: xs.append(sg["m"][0]); ys.append(sg["m"][1])
        return (min(xs), min(ys), max(xs), max(ys))
    if loops:
        chain = max(loops, key=lambda c: (lambda b: (b[2]-b[0]) * (b[3]-b[1]))(loop_bbox(c)))
        d = f"M {chain[0]['s'][0]:.3f} {chain[0]['s'][1]:.3f}"
        for sg in chain:
            if sg["m"]:
                r, large, sweep = arc_svg(sg["s"], sg["m"], sg["e"])
                d += f" A {r:.3f} {r:.3f} 0 {large} {sweep} {sg['e'][0]:.3f} {sg['e'][1]:.3f}"
            else: d += f" L {sg['e'][0]:.3f} {sg['e'][1]:.3f}"
        d += " Z"
        x0, y0, x1, y1 = loop_bbox(chain)
        return d, (x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5)
    if circles:
        (cx, cy), r = max(circles, key=lambda c: c[1])
        return f"M {cx-r:.3f} {cy:.3f} a {r:.3f} {r:.3f} 0 1 0 {2*r:.3f} 0 a {r:.3f} {r:.3f} 0 1 0 {-2*r:.3f} 0 Z", (cx-r-0.5, cy-r-0.5, cx+r+0.5, cy+r+0.5)
    return "", (0, 0, 10, 10)

def gpio_of(net):
    if not net: return None
    m = re.search(r"GPIO_?0*(\d+)", net, re.I) or re.search(r"\bIO_?0*(\d+)\b", net) or re.search(r"\bGP0*(\d+)\b", net)
    return int(m.group(1)) if m else None

def label_for(ref, value, key=None):
    if key in REF_LABELS and ref in REF_LABELS[key]: return REF_LABELS[key][ref]
    if ref in LABELS["ref"]: return LABELS["ref"][ref]
    for pat, lab in LABELS["value"]:
        if re.search(pat, value or "", re.I): return lab
    return None

def board(path, key=None):
    pcb = parse(tokenize(open(path).read()))[0]
    outline, bbox = outline_path(pcb)
    parts, pads = [], []
    for fp in find(pcb, "footprint"):
        ref = val = None
        for pr in find(fp, "property"):
            if len(pr) > 2 and pr[1] == "Reference": ref = pr[2]
            if len(pr) > 2 and pr[1] == "Value": val = pr[2]
        ly = find(fp, "layer"); at = find(fp, "at")
        if not at or not ref: continue
        layer = "B" if ly and ly[0][1].startswith("B") else "F"
        x, y = num(at[0][1]), num(at[0][2]); rot = num(at[0][3]) if len(at[0]) > 3 else 0.0
        xs, ys = [], []
        for k in ("fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly"):
            for e in find(fp, k):
                l2 = find(e, "layer")
                if not l2 or not re.search(r"CrtYd", l2[0][1]): continue
                for corner in ("start", "end", "center", "mid"):
                    for q in find(e, corner): xs.append(num(q[1])); ys.append(num(q[2]))
                for pts in find(e, "pts"):
                    for q in find(pts, "xy"): xs.append(num(q[1])); ys.append(num(q[2]))
        w = round(max(xs) - min(xs), 2) if xs else None; h = round(max(ys) - min(ys), 2) if ys else None
        plist = find(fp, "pad")
        if w is None and plist:   # test points etc.: size from the pad
            sz = find(plist[0], "size"); w = h = round(max(num(sz[0][1]), num(sz[0][2])), 2) if sz else 1.2
        shape = "circle" if (w and h and abs(w - h) < 0.05 and len(plist) <= 1) else "rect"
        parts.append({"ref": ref, "value": val, "layer": layer, "x": round(x, 3), "y": round(y, 3), "rot": rot, "w": w, "h": h, "shape": shape, "label": label_for(ref, val, key)})
        r = math.radians(rot)
        for p in plist:
            pat = find(p, "at")
            if not pat: continue
            px, py = num(pat[0][1]), num(pat[0][2])
            bx = x + px * math.cos(r) + py * math.sin(r); by = y - px * math.sin(r) + py * math.cos(r)
            net = find(p, "net"); net = next((x for x in reversed(net[0][1:]) if isinstance(x, str) and not re.fullmatch(r"\d+", x)), None) if net else None   # (net 12 "name") or (net "name")
            sz = find(p, "size"); pw = round(num(sz[0][1]), 2) if sz else 1.0; ph = round(num(sz[0][2]), 2) if sz else 1.0
            if pw * ph > 25: continue                       # thermal pads aren't castellations
            pads.append({"ref": ref, "pad": p[1], "x": round(bx, 3), "y": round(by, 3), "w": pw, "h": ph, "net": net, "gpio": gpio_of(net)})
    return {"outline": outline, "bbox": [round(v, 2) for v in bbox], "parts": parts, "pads": pads}

def main():
    args = sys.argv[1:]; out = "web/vet-layouts.js"
    if "-o" in args: i = args.index("-o"); out = args[i + 1]; del args[i:i + 2]
    layouts = {}
    for a in args:
        key, path = a.split("=", 1)
        b = board(path, key); b["key"] = key; layouts[key] = b
        print(f"{key}: {len(b['parts'])} parts, {len(b['pads'])} pads, {sum(1 for p in b['pads'] if p['gpio'] is not None)} with a GPIO, bbox {b['bbox']}")
    with open(out, "w") as f:
        f.write("// GENERATED by scripts/board_layout.py from the KiCad PCBs — do not edit by hand.\n")
        f.write("// Board models for the vet page: outline (SVG path, mm), parts (ref, side, position,\n// rotation, courtyard) and pads (position, net, GPIO). Consumed by vet-board.js.\n")
        f.write("export const LAYOUTS = " + json.dumps(layouts, separators=(",", ":")) + ";\n")
    print("wrote", out)

if __name__ == "__main__": main()
