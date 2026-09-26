#!/usr/bin/env python3
"""Local-dev helper: mirror the LIVE catalog metadata into web/manifests/index.json and add
`app_elf_sha256` to every ESP32-S3 image by range-reading the live bins (until CI has run the
new generate_manifests.py). Lets a local preview at http://localhost:8765 exercise every Detect
layer against real boards. web/manifests is gitignored — nothing to commit.

NB: only metadata is mirrored. Local Flash still serves web/firmware/*.bin, which may be
stale or missing — mirror the bins too (see the scriptkitty-flasher skill) before flashing.
"""
import concurrent.futures as cf
import json
import os
import sys
import urllib.request

BASE = "https://scriptkitty.sh/"
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "manifests", "index.json")


def get(url, rng=None):
    req = urllib.request.Request(url, headers={"User-Agent": "scriptkitty-dev"})
    if rng:
        req.add_header("Range", f"bytes={rng[0]}-{rng[1]}")
    return urllib.request.urlopen(req, timeout=30).read()


def elf_sha(path):
    try:
        b = get(BASE + path, (0x10020, 0x100CF))          # esp_app_desc_t at app+0x20
    except Exception:
        return None
    return b[0x90:0xB0].hex() if b[:4] == b"\x32\x54\xcd\xab" else None


def main():
    idx = json.loads(get(BASE + "manifests/index.json"))
    jobs = []
    for t in idx["targets"]:
        if t.get("mcu") != "esp32-s3" or not t.get("app_elf_sha256") is None:
            continue
        rels = (t.get("channel") or {}).get("releases") or []
        if rels:
            for r in rels:
                if not r.get("app_elf_sha256"):
                    jobs.append((r, f"firmware/versions/{t['id']}/{r['tag']}.bin"))
        else:
            jobs.append((t, f"firmware/{t['id']}.bin"))
    with cf.ThreadPoolExecutor(8) as ex:
        for obj, sha in zip([j[0] for j in jobs], ex.map(elf_sha, [j[1] for j in jobs])):
            if sha:
                obj["app_elf_sha256"] = sha
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(idx, f, indent=2)
    n = sum(1 for t in idx["targets"] if t.get("app_elf_sha256")) + sum(
        1 for t in idx["targets"] for r in ((t.get("channel") or {}).get("releases") or []) if r.get("app_elf_sha256"))
    print(f"wrote {OUT}: {len(idx['targets'])} targets, {n} images with app_elf_sha256")


if __name__ == "__main__":
    sys.exit(main())
