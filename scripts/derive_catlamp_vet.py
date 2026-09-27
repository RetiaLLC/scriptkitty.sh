# derive catlamp.site/vet/vet.js from scriptkitty's web/vet.js (Newsheen-only site: other
# board lines are filtered out of the protocol table). usage: derive_catlamp_vet.py <catlamp-vet-dir>
import sys
W = sys.argv[1]
src = open("/Users/skicka/scriptkitty-flash/web/vet.js").read()
def sub(old, new):
    global src
    assert src.count(old) == 1, (old[:60], src.count(old)); src = src.replace(old, new)
sub('// vet.js — "Diagnose my cat": the browser side of vetprobe.js. Connects like the Flash\n// page (same esptool-js, same TinyUSB touch fallback, same S3 watchdog reset), runs the\n// protocol\'s exam, then reboots the board and reads its console for the boot verdict.',
    '// vet.js — "Diagnose my cat" on catlamp.site: the browser side of vetprobe.js. Same code as\n// scriptkitty.sh/vet.html (esptool-js, TinyUSB touch fallback, S3 watchdog reset), with the\n// site\'s own firmware table so the installed image is named. Never writes flash or eFuses.\n// CSP: everything here is same-origin — no inline scripts, no third-party fetches.\n// GENERATED from ~/scriptkitty-flash/web/vet.js (scratchpad derive_catlamp_vet.py) — edit there.')
sub('const loadEsptool = () => esptoolMod || (esptoolMod = import("./vendor/esptool-js/bundle.js"));',
    'const loadEsptool = () => esptoolMod || (esptoolMod = import("./vendor/esptool-bundle.js"));\n// app ELF sha256 -> { id, name, version, line, model } for every image this site ships\n// (built from firmware/*.bin by scripts in the repo); lets the report say "WLEDkitty 17.0.0"\n// instead of a hash. Missing table = still works, just anonymous.\nconst IMAGES = fetch("./images.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);')
sub('try { line = (await probe.probeS3FourMeg(io)).line; } catch {} }',
    'try { line = (await probe.probeS3FourMeg(io, { images: await IMAGES })).line; } catch {} }')
sub('const report = await vet.runExam(io, protocol, {\n      chip, fitted: fittedFromUi(), doBeacon: $("blink").checked,',
    'const report = await vet.runExam(io, protocol, {\n      chip, images: await IMAGES, fitted: fittedFromUi(), doBeacon: $("blink").checked,')
sub('function finish(phase, title = "Diagnose my cat", sub) { running = false; $("diagnose").disabled = !HAS_SERIAL; progress(null); mascot(phase, title, sub); }',
    'const IDLE = { title: "Ready when you are", sub: "Plug in your Sheen and press Diagnose." };\nfunction finish(phase, title = IDLE.title, sub) { running = false; $("diagnose").disabled = !HAS_SERIAL; progress(null); mascot(phase, title, sub ?? (phase === "idle" ? IDLE.sub : undefined)); }')
sub('mascot("idle");\n', 'mascot("idle", IDLE.title, IDLE.sub);\n')
sub('finish(phase, line, "Scroll down for the findings. Hints point at the part to check.");',
    'finish(phase, line, "The findings are below. Each hint names the part to look at.");')
sub('window.vetRender = render; window.vetRunOn = (io, chip, key = "newsheen") => vet.runExam(io, PROTOCOLS[key], { chip, doBeacon: false });',
    'window.vetRender = render; window.vetRunOn = async (io, chip, key = "newsheen") => vet.runExam(io, PROTOCOLS[key], { chip, images: await IMAGES, doBeacon: false });')
sub('import { PROTOCOLS } from "./vet-protocols.js";',
    'import { PROTOCOLS as ALL_PROTOCOLS } from "./vet-protocols.js";\n// catlamp.site is the Newsheen site: only its own line is offered here\nconst PROTOCOLS = Object.fromEntries(Object.entries(ALL_PROTOCOLS).filter(([, p]) => p.line === "newsheen"));')
open(f"{W}/vet.js", "w").write(src); print("catlamp vet.js derived:", len(src.splitlines()), "lines")
