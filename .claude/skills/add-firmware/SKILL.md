---
name: add-firmware
description: >-
  Add a new firmware image to the scriptkitty.sh browser flasher (repo
  RetiaLLC/scriptkitty.sh). Use whenever asked to add or list a firmware binary in
  the catalog, wire up a board's firmware, link its source repo, or add quickstart
  instructions for a firmware. Covers the Board Profile schema, where the .bin goes,
  provenance (static / release / ci), validation, and manifest generation.
---

# Adding a firmware to scriptkitty.sh

Each firmware in the catalog is **one Board Profile** (`profiles/<id>.yaml`) plus its
**binary**. On push to `main`, CI validates the profiles, runs
`scripts/generate_manifests.py` to produce `manifests/index.json` + a per-profile ESP
Web Tools manifest, and deploys to **https://scriptkitty.sh**. The site reads
`index.json` and renders a card for each firmware, grouped by product line. **You do
not touch any HTML/JS to add a firmware** — you add a profile (and usually a `.bin`),
and the card appears automatically.

## Prereqs
- Work in the repo root (`profiles/`, `firmware/`, `scripts/`, `web/` are here).
- `pip install pyyaml --break-system-packages` (needed by the scripts).

## Step 1 — choose an id
- kebab-case, pattern `<product>-<program>`, e.g. `usb-nugget-badusb`, `nibble-zero-meshtastic`.
- **The id MUST equal the filename**: `profiles/<id>.yaml` with `id: <id>` inside.

## Step 2 — add the binary (pick the provenance path)
`provenance.binary_source` decides how the binary gets to the site:

- **`static`** (most common — you have a working `.bin`): commit the prebuilt image to
  `firmware/<id>.bin`. Requires a documented `provenance.exception` (why it's a
  committed binary rather than a CI build). RP2040 ships `firmware/<id>.uf2` instead.
- **`release`**: don't commit a binary — CI fetches a **pinned** GitHub release asset.
  Provide `provenance.release.{repo, tag, asset_pattern}` (never `tag: latest`).
- **`ci`**: don't commit a binary — CI compiles it from `projects/<dir>`. Provide
  `build.{system, environment|fqbn, project_dir}` and, for ESP32, `flash.{mode,frequency,size}`.

**Critical for ESP boards:** the image must be a **single merged image flashed at
`0x0`** (bootloader + partitions + app combined, e.g. from `esptool merge_bin`). A raw
app-only `.bin` will **not boot**. RP2040 uses a `.uf2`.

## Step 3 — write the profile
Minimal `static` example (`profiles/usb-nugget-badusb.yaml`):

```yaml
id: usb-nugget-badusb                 # must match filename
display_name: "USB Nugget"            # shown as the card title
product_line: usb-nugget              # groups the card (see valid list below)
model: "USB Nugget"                   # exact board model (helps disambiguate)
mcu: esp32-s2                          # esp8266 | esp32 | esp32-s2 | esp32-s3 | rp2040
version: "1.0.0"                       # optional, shown as vX.Y.Z
radio: rfm95                           # optional: rfm95 | sx1262 (LoRa boards)
description: "A versatile USB attack platform that hacks computers in seconds."
program_url: https://github.com/RetiaLLC/USB-Nugget   # "Source ↗" link on the card
addons:                                # optional hardware needed beyond the base board
  - "RFM95 LoRa backpack"
recommended: true                      # optional: badge + sorts first (one per model)
quickstart:                            # optional: shown in a "Quickstart" expander
  - "Flash this firmware, then unplug and replug the board."
  - "It shows up as a USB drive — edit payload.dd with your DuckyScript."
  - "Plug into a target; the payload runs automatically."
provenance:
  binary_source: static
  exception: "Prebuilt 0x0 image imported from <source>; migrate to release/ci later."
  imported_from:                       # optional provenance breadcrumb for static bins
    repo: RetiaLLC/esp-web-flasher-wifi-nugget
    path: js/binaries-usb/USBNugget.bin
```

`release` example (Meshtastic-style, no committed binary):

```yaml
id: nibble-rp2040-rfm95
display_name: "Nibble (RP2040)"
product_line: nibble
mcu: rp2040
version: "2.6.2"
flash:
  format: uf2            # REQUIRED for rp2040
provenance:
  binary_source: release
  release:
    repo: owner/repo               # GitHub repo hosting the release
    tag: v2.6.2-nibble             # exact tag, never "latest"
    asset_pattern: "firmware-nibble-{mcu}-*.uf2"   # {mcu} → mcu with dashes removed
    expected_sha256: ""            # pin in production for a hard integrity check
```

## Step 4 — link the repo
- `program_url` → the source/docs URL; renders as the card's **Source ↗** link.
- `static`: also fill `provenance.imported_from.{repo, path}` (where the bin came from).
- `release`: `provenance.release.repo` is the source of record.

## Step 5 — add quickstart instructions
`quickstart:` is a YAML list of short imperative steps shown in a collapsible
**"Quickstart"** on the card. Keep it to ~3–6 steps, beginner-facing (audience is
students). Include a safety/legal note for offensive tools.

## Step 6 — validate + preview locally
```bash
python3 scripts/validate_profiles.py --all          # schema + policy checks
# preview the generated catalog entry:
python3 scripts/generate_manifests.py --profiles-dir profiles \
    --firmware-dir firmware --out-dir /tmp/m && python3 -c \
    "import json;print(json.load(open('/tmp/m/index.json'))['targets'][-1])"
```
(For a full local site preview, copy `firmware/` → `web/firmware/`, generate into
`web/manifests/`, then `python3 -m http.server -d web`. Those dirs are gitignored.)

## Step 7 — commit
Commit `profiles/<id>.yaml` (and `firmware/<id>.bin` for `static`). Pushing to `main`
runs the deploy workflow (validate → build/fetch → generate manifests → publish). The
card shows up on scriptkitty.sh automatically; no front-end edits needed.

## Valid values (enforced by scripts/validate_profiles.py)
| Field | Values |
|---|---|
| `mcu` | `esp8266`, `esp32`, `esp32-s2`, `esp32-s3`, `rp2040` |
| `provenance.binary_source` | `static`, `release`, `ci` |
| `product_line` (reuse existing) | `usb-nugget`, `wifi-nugget`, `bluetooth-nugget`, `nibble`, `pusheen` |
| `radio` (optional) | `rfm95`, `sx1262` |

## Gotchas
- **id must equal the filename.** `profiles/foo.yaml` → `id: foo`.
- **`static` requires `provenance.exception`** (a documented reason).
- **ESP `.bin` must be a merged image flashed at `0x0`**, not app-only.
- **`rp2040` requires `flash.format: uf2`** and ships a `.uf2`, not a `.bin`.
- **`release` tag must be an exact tag, not `latest`.**
- **`recommended: true`** adds a badge and sorts the card first — use one per device/model.
- **New product line?** Also add it to `LINES` in `web/app.js` (`[key, heading, subtitle]`)
  for a proper section heading, and to `LINES_BY_MCU` if the chip is shared with another
  line (so Detect narrows correctly). Reuse an existing `product_line` when you can.

See `profile-template.yaml` in this skill folder for a copy-paste starting point.
