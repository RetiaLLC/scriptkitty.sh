#!/usr/bin/env python3
"""Validate Board Profiles against the schema and enforce policy rules.

Policy rules beyond plain schema:
  - binary_source: static  requires  provenance.exception  (the "static-binary ban")
  - binary_source: release requires  release.{repo,tag,asset_pattern} and tag != latest
  - esp32 profiles require flash.{mode,frequency,size} (needed for merge_bin)
  - rp2040 profiles must declare flash.format: uf2
"""
import argparse
import glob
import subprocess
import sys

import yaml

VALID_MCU = {"esp8266", "esp32", "esp32-s2", "esp32-s3", "rp2040"}
VALID_SOURCE = {"ci", "release", "static"}


def changed_files(base_ref: str):
    out = subprocess.run(
        ["git", "diff", "--name-only", base_ref, "--", "profiles/"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    return [f for f in out if f.endswith(".yaml")]


def validate(path: str) -> list[str]:
    errs = []
    try:
        with open(path) as f:
            p = yaml.safe_load(f)
    except Exception as e:
        return [f"{path}: unparseable YAML: {e}"]

    def req(key, cond=True):
        if key not in p or p[key] in (None, ""):
            errs.append(f"{path}: missing required '{key}'")
            return None
        return p[key]

    pid = req("id")
    if pid and pid != path.split("/")[-1][:-5]:
        errs.append(f"{path}: id '{pid}' must match filename")
    req("display_name")
    req("product_line")
    mcu = req("mcu")
    if mcu and mcu not in VALID_MCU:
        errs.append(f"{path}: mcu '{mcu}' not in {sorted(VALID_MCU)}")

    prov = p.get("provenance", {})
    src = prov.get("binary_source")
    if src not in VALID_SOURCE:
        errs.append(f"{path}: provenance.binary_source must be one of {sorted(VALID_SOURCE)}")

    if src == "static" and not prov.get("exception"):
        errs.append(f"{path}: binary_source 'static' requires provenance.exception (documented reason)")

    if src == "release":
        rel = prov.get("release", {})
        for k in ("repo", "tag", "asset_pattern"):
            if not rel.get(k):
                errs.append(f"{path}: release.{k} required when binary_source=release")
        if rel.get("tag") == "latest":
            errs.append(f"{path}: pin an exact release tag, not 'latest'")

    if mcu in {"esp32", "esp32-s2", "esp32-s3"} and src == "ci":
        flash = p.get("flash", {})
        for k in ("mode", "frequency", "size"):
            if not flash.get(k):
                errs.append(f"{path}: esp32 ci build needs flash.{k} (for esptool merge_bin)")

    if mcu == "rp2040":
        if p.get("flash", {}).get("format") != "uf2":
            errs.append(f"{path}: rp2040 profile must set flash.format: uf2")

    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--changed-against")
    args = ap.parse_args()

    if args.all:
        files = sorted(glob.glob("profiles/*.yaml"))
    else:
        files = changed_files(args.changed_against)

    if not files:
        print("no profiles to validate")
        return 0

    all_errs = []
    for f in files:
        all_errs += validate(f)

    if all_errs:
        for e in all_errs:
            print(f"::error::{e}")
        return 1
    print(f"validated {len(files)} profile(s) - ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
