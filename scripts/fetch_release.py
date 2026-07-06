#!/usr/bin/env python3
"""Fetch a pinned release artifact for a profile whose binary_source is 'release'.

Meshtastic firmware is large and complex to build; rather than recompile upstream
on every merge, we pull the exact published asset the profile pins. The profile
declares which repo, which release tag, and an asset-name pattern:

    provenance:
      binary_source: release
      release:
        repo: nsgodshall/retia-boards        # owner/repo hosting the release
        tag: v2.6.2-nibble                    # exact tag - never "latest" in prod
        asset_pattern: "firmware-nibble-{mcu}-*.bin"
        expected_sha256: "abc123..."          # optional but recommended: pin the hash

Pinning the tag (not 'latest') is what makes the build reproducible; the optional
expected_sha256 turns a moved/retagged asset into a hard failure instead of a
silent substitution.
"""
import argparse
import fnmatch
import hashlib
import os
import sys
import urllib.request
import urllib.error
import json

import yaml


def gh_api(url: str) -> dict:
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    token = os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    profile_path = f"profiles/{args.profile}.yaml"
    with open(profile_path) as f:
        p = yaml.safe_load(f)

    prov = p.get("provenance", {})
    if prov.get("binary_source") != "release":
        print(f"::error::{args.profile}: fetch_release called but binary_source != release")
        return 1

    rel = prov.get("release") or {}
    repo = rel.get("repo")
    tag = rel.get("tag")
    pattern = rel.get("asset_pattern")
    if not (repo and tag and pattern):
        print(f"::error::{args.profile}: release block needs repo, tag, asset_pattern")
        return 1
    if tag == "latest":
        print(f"::error::{args.profile}: pin an exact tag, not 'latest' (breaks reproducibility)")
        return 1

    mcu = p.get("mcu", "")
    pattern = pattern.format(mcu=mcu.replace("-", ""))

    print(f"== Fetching {args.profile} from {repo}@{tag} matching '{pattern}' ==")
    release = gh_api(f"https://api.github.com/repos/{repo}/releases/tags/{tag}")

    asset = next(
        (a for a in release.get("assets", []) if fnmatch.fnmatch(a["name"], pattern)),
        None,
    )
    if asset is None:
        names = ", ".join(a["name"] for a in release.get("assets", []))
        print(f"::error::{args.profile}: no asset matched '{pattern}'. available: {names}")
        return 1

    os.makedirs(args.out_dir, exist_ok=True)
    # keep the extension the upstream asset uses (.bin or .uf2)
    ext = ".uf2" if asset["name"].endswith(".uf2") else ".bin"
    out_path = os.path.join(args.out_dir, f"{args.profile}{ext}")

    print(f"-- downloading {asset['name']} -> {out_path}")
    urllib.request.urlretrieve(asset["browser_download_url"], out_path)

    digest = hashlib.sha256(open(out_path, "rb").read()).hexdigest()
    expected = rel.get("expected_sha256")
    if expected:
        if digest != expected:
            print(f"::error::{args.profile}: sha256 mismatch\n  expected {expected}\n  got      {digest}")
            return 1
        print(f"-- sha256 verified against pinned value")
    else:
        print(f"::warning::{args.profile}: no expected_sha256 pinned. got {digest}")

    print(f"-> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
