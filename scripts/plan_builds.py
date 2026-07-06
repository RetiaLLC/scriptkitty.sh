#!/usr/bin/env python3
"""Decide which profiles to build/fetch and emit GitHub Actions matrix outputs.

Maps each affected profile to the project directory that builds it (via
profile.build.project_dir), and splits into:
    ci_matrix       -> profiles compiled here (binary_source: ci)
    release_matrix  -> profiles fetched from a release (binary_source: release)
static profiles produce no job (they're passed through at assemble time).
"""
import argparse
import glob
import json
import subprocess

import yaml


def changed_profiles(base_ref: str):
    out = subprocess.run(
        ["git", "diff", "--name-only", base_ref, "--", "profiles/", "projects/"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    # any profile whose file changed, OR whose project dir changed
    changed = set()
    proj_changed = {f for f in out if f.startswith("projects/")}
    for path in glob.glob("profiles/*.yaml"):
        if path in out:
            changed.add(path)
            continue
        with open(path) as f:
            p = yaml.safe_load(f)
        pdir = (p.get("build") or {}).get("project_dir")
        if pdir and any(c.startswith(pdir.rstrip("/")) for c in proj_changed):
            changed.add(path)
    return sorted(changed)


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--changed-against")
    ap.add_argument("--split-sources", action="store_true")
    ap.add_argument("--github-output", required=True)
    args = ap.parse_args()

    files = sorted(glob.glob("profiles/*.yaml")) if args.all else changed_profiles(args.changed_against)

    ci, release = [], []
    for path in files:
        with open(path) as f:
            p = yaml.safe_load(f)
        pid = p["id"]
        src = (p.get("provenance") or {}).get("binary_source", "ci")
        entry = {"profile": pid, "dir": (p.get("build") or {}).get("project_dir", "")}
        if src == "ci":
            ci.append(entry)
        elif src == "release":
            release.append({"profile": pid})

    with open(args.github_output, "a") as out:
        out.write(f"ci_matrix={json.dumps(ci)}\n")
        out.write(f"release_matrix={json.dumps(release)}\n")
        out.write(f"any_ci={'true' if ci else 'false'}\n")
        out.write(f"any_release={'true' if release else 'false'}\n")

    print(f"planned: {len(ci)} ci, {len(release)} release, "
          f"{len(files) - len(ci) - len(release)} static/other")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
