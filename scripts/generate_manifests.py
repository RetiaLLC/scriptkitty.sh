#!/usr/bin/env python3
"""Generate ESP Web Tools manifests from Board Profiles.

Because CI produces a MERGED single-file image for ESP32 (flashed at 0x0), each
ESP manifest has exactly one part at offset 0. ESP8266 is likewise a single image
at 0x0. RP2040 profiles get NO ESP Web Tools manifest - they use the UF2 path - but
we still emit a small sidecar json the site uses to render the UF2/BOOTSEL flow.

ESP Web Tools chipFamily strings are specific: ESP8266, ESP32, ESP32-S2, ESP32-S3.
"""
import argparse
import glob
import json
import os
import sys

import yaml

CHIP_FAMILY = {
    "esp8266": "ESP8266",
    "esp32": "ESP32",
    "esp32-s2": "ESP32-S2",
    "esp32-s3": "ESP32-S3",
}


def esp_manifest(profile: dict, bin_rel_path: str) -> dict:
    fam = CHIP_FAMILY[profile["mcu"]]
    return {
        "name": profile.get("display_name", profile["id"]),
        "version": profile.get("version", "latest"),
        "new_install_prompt_erase": True,
        "builds": [
            {
                "chipFamily": fam,
                # merged image -> one part at 0x0
                "parts": [{"path": bin_rel_path, "offset": 0}],
            }
        ],
    }


def uf2_sidecar(profile: dict, uf2_rel_path: str) -> dict:
    rec = profile.get("recovery", {})
    return {
        "name": profile.get("display_name", profile["id"]),
        "mcu": "rp2040",
        "flow": "uf2",
        "uf2_path": uf2_rel_path,
        "serial_trigger": rec.get("serial_trigger", "touch-1200"),
        "bootloader_entry": rec.get("bootloader_entry", "bootsel-hold"),
        "drive_label": "RPI-RP2",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profiles-dir", required=True)
    ap.add_argument("--firmware-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)

    count = 0
    index = []
    for path in sorted(glob.glob(os.path.join(args.profiles_dir, "*.yaml"))):
        with open(path) as f:
            profile = yaml.safe_load(f)
        pid = profile["id"]
        mcu = profile["mcu"]

        if mcu == "rp2040":
            uf2 = f"{pid}.uf2"
            if not os.path.exists(os.path.join(args.firmware_dir, uf2)):
                print(f"::warning::{pid}: no {uf2} present, skipping sidecar")
                continue
            doc = uf2_sidecar(profile, f"../firmware/{uf2}")
            flow = "uf2"
        elif mcu in CHIP_FAMILY:
            b = f"{pid}.bin"
            if not os.path.exists(os.path.join(args.firmware_dir, b)):
                print(f"::warning::{pid}: no {b} present, skipping manifest")
                continue
            doc = esp_manifest(profile, f"../firmware/{b}")
            flow = "esp-serial"
        else:
            print(f"::error::{pid}: unknown mcu '{mcu}'")
            return 1

        out = os.path.join(args.out_dir, f"{pid}.json")
        with open(out, "w") as f:
            json.dump(doc, f, indent=2)
        print(f"-> {out}")
        count += 1

        # catalog entry the static site renders cards from
        index.append({
            "id": pid,
            "name": profile.get("display_name", pid),
            "product_line": profile.get("product_line", ""),
            "model": profile.get("model", ""),
            "mcu": mcu,
            "radio": profile.get("radio", ""),
            "version": str(profile.get("version", "")),
            "description": profile.get("description", ""),
            "program_url": profile.get("program_url", ""),
            "addons": profile.get("addons", []) or [],
            "recommended": bool(profile.get("recommended", False)),
            "flow": flow,
            "manifest": f"{pid}.json",
        })

    index_path = os.path.join(args.out_dir, "index.json")
    with open(index_path, "w") as f:
        json.dump({"targets": index}, f, indent=2)
    print(f"-> {index_path}")

    print(f"generated {count} manifest(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
