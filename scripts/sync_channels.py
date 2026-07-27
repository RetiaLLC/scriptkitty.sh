#!/usr/bin/env python3
"""Sync release CHANNELS: mirror a repo's releases for channel-sourced profiles.

A profile with `provenance.binary_source: channel` tracks ALL releases of a repo
instead of one pinned tag:

    provenance:
      binary_source: channel
      channel:
        repo: RetiaLLC/WLEDkitty
        asset_pattern: "wledkitty-badge.factory.bin"   # same asset name in every release
        verification_pattern: "verification-badge.json" # optional evidence sidecar
        max_prereleases: 5                               # optional, default 5

Semantics (the release-system contract):
    full release  = VERIFIED   (a human or the workbench flashed it on hardware)
    prerelease    = UNTESTED   (automatically compiled; flashable behind a warning)
Promotion is done in the source repo (flip prerelease off + attach evidence);
this script just reflects whatever the releases API says.

For each channel profile this script:
  - lists the repo's releases (newest first, drafts skipped),
  - keeps every verified release + the newest N prereleases,
  - downloads each matching asset to  <firmware-dir>/versions/<id>/<tag>.bin  (+ .sha256),
  - copies the NEWEST VERIFIED bin to <firmware-dir>/<id>.bin so every existing
    path (manifest generation, backfill, the default Flash button) works unchanged,
  - writes <channels-meta>/<id>.json for generate_manifests.py to fold into index.json.

Resilient by design: a failing release download skips that release; a failing
profile writes no meta (the card falls back to plain rendering on the backfilled
default bin). Exit is non-zero only for malformed profiles.
"""
import argparse
import fnmatch
import glob
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.request

import yaml

API = "https://api.github.com"


def gh_json(url: str):
    req = urllib.request.Request(url, headers=_headers(accept="application/vnd.github+json"))
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _headers(accept: str) -> dict:
    h = {"Accept": accept, "User-Agent": "scriptkitty-channel-sync"}
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def download(url: str, dest: str) -> str:
    """Download a release asset, return its sha256 hex digest."""
    req = urllib.request.Request(url, headers=_headers(accept="application/octet-stream"))
    sha = hashlib.sha256()
    tmp = dest + ".part"
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)
            sha.update(chunk)
    os.replace(tmp, dest)
    return sha.hexdigest()


def parse_version(tag: str):
    """wledkitty-v0.15.0 -> ('0.15.0', None); wledkitty-v0.15.0-sk.3 -> ('0.15.0', 3)."""
    m = re.search(r"v(\d[^\s]*?)(?:-sk\.(\d+))?$", tag)
    if not m:
        return tag, None
    return m.group(1), int(m.group(2)) if m.group(2) else None


def safe_name(tag: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", tag)


def sync_profile(profile: dict, firmware_dir: str, meta_dir: str) -> bool:
    pid = profile["id"]
    ch = profile["provenance"]["channel"]
    repo, pattern = ch["repo"], ch["asset_pattern"]
    ver_pattern = ch.get("verification_pattern")
    max_pre = int(ch.get("max_prereleases", 5))

    try:
        releases = gh_json(f"{API}/repos/{repo}/releases?per_page=100")
    except Exception as e:
        print(f"::warning::{pid}: could not list releases for {repo} ({e}); card falls back to last-known-good")
        return True

    releases = [r for r in releases if not r.get("draft")]
    releases.sort(key=lambda r: r.get("published_at") or "", reverse=True)

    kept, pre_kept = [], 0
    for rel in releases:
        asset = next((a for a in rel.get("assets", []) if fnmatch.fnmatch(a["name"], pattern)), None)
        if not asset:
            continue  # this release doesn't ship a bin for this target
        if rel.get("prerelease"):
            if pre_kept >= max_pre:
                continue
            pre_kept += 1
        kept.append((rel, asset))

    if not kept:
        print(f"::warning::{pid}: no releases in {repo} carry an asset matching '{pattern}'")
        return True

    vdir = os.path.join(firmware_dir, "versions", pid)
    os.makedirs(vdir, exist_ok=True)
    entries, latest_verified = [], None
    for rel, asset in kept:
        tag = rel["tag_name"]
        fname = safe_name(tag) + ".bin"
        dest = os.path.join(vdir, fname)
        try:
            sha = download(asset["url"], dest)
        except Exception as e:
            print(f"::warning::{pid}: download failed for {tag} ({e}); skipping this version")
            continue
        with open(dest + ".sha256", "w") as f:
            f.write(f"{sha}  {fname}\n")

        verified = not rel.get("prerelease")
        verification = None
        if verified and ver_pattern:
            vasset = next((a for a in rel.get("assets", []) if fnmatch.fnmatch(a["name"], ver_pattern)), None)
            if vasset:
                try:
                    vtmp = os.path.join(vdir, safe_name(tag) + ".verification.json")
                    download(vasset["url"], vtmp)
                    with open(vtmp) as f:
                        verification = json.load(f)
                    os.remove(vtmp)
                except Exception as e:
                    print(f"::warning::{pid}: unreadable verification asset on {tag} ({e})")

        version, sk_build = parse_version(tag)
        entry = {
            "tag": tag,
            "version": version,
            "sk_build": sk_build,
            "verified": verified,
            "method": (verification or {}).get("method"),
            "verified_date": (verification or {}).get("date"),
            "date": (rel.get("published_at") or "")[:10],
            "sha256": sha,
            "size": os.path.getsize(dest),
            "bin": f"versions/{pid}/{fname}",
            "manifest": f"{pid}@{safe_name(tag)}.json",
            "release_url": rel.get("html_url", ""),
        }
        entries.append(entry)
        if verified and latest_verified is None:
            latest_verified = entry

    if not entries:
        print(f"::warning::{pid}: every version download failed; card falls back to last-known-good")
        return True

    # Default bin = newest verified (what the big Flash button ships). If the channel
    # has no verified release yet, leave the default alone — backfill's last-known-good
    # (or nothing) is safer than silently defaulting to an untested build.
    if latest_verified:
        shutil.copyfile(os.path.join(firmware_dir, latest_verified["bin"]),
                        os.path.join(firmware_dir, f"{pid}.bin"))
        with open(os.path.join(firmware_dir, f"{pid}.bin.sha256"), "w") as f:
            f.write(f"{latest_verified['sha256']}  {pid}.bin\n")

    os.makedirs(meta_dir, exist_ok=True)
    with open(os.path.join(meta_dir, f"{pid}.json"), "w") as f:
        json.dump({
            "repo": repo,
            "latest_verified": latest_verified["tag"] if latest_verified else None,
            "releases": entries,
        }, f, indent=2)
    nv = sum(1 for e in entries if e["verified"])
    print(f"{pid}: {len(entries)} version(s) mirrored ({nv} verified, {len(entries) - nv} untested), "
          f"default = {latest_verified['tag'] if latest_verified else 'unchanged (none verified)'}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profiles-dir", required=True)
    ap.add_argument("--firmware-dir", required=True)
    ap.add_argument("--channels-meta", required=True)
    args = ap.parse_args()

    ok = True
    n = 0
    for path in sorted(glob.glob(os.path.join(args.profiles_dir, "*.yaml"))):
        with open(path) as f:
            profile = yaml.safe_load(f)
        prov = profile.get("provenance") or {}
        if prov.get("binary_source") != "channel":
            continue
        n += 1
        ok = sync_profile(profile, args.firmware_dir, args.channels_meta) and ok
    print(f"channel sync: {n} channel profile(s) processed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
