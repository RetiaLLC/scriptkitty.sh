# scriptkitty.sh - web flasher + CI

Browser-based firmware flasher (ESP Web Tools + a UF2/BOOTSEL flow for RP2040),
deployed to GitHub Pages. Two GitHub Actions workflows implement the build
pipeline; the Python scripts they call are functional, not pseudocode.

Target domain: **scriptkitty.sh** (custom domain). Until DNS is wired the site is
served at the default `https://<owner>.github.io/<repo>/` Pages URL.

## Layout

```
web/                     static app served at the site root (index.html + assets)
  vendor/esp-web-tools/  vendored ESP Web Tools 10.2.1 (no runtime CDN)
profiles/                one Board Profile per flashable target
scripts/                 build/validate/plan/fetch/manifest helpers
projects/                source for binary_source: ci profiles (compiled in CI)
.github/workflows/       pr-validate.yml (PRs) + build-deploy.yml (main/cron)
```

## The two workflows

### `pr-validate.yml` - runs on pull requests
- **Holds no secrets.** `permissions: contents: read` only - no `pages:write`, no
  `id-token:write`. A malicious PR literally cannot publish or sign anything.
- Validates every changed Board Profile against schema + policy.
- Test-compiles only the profiles you author (`binary_source: ci`); asserts a
  flashable artifact was produced so an empty build fails the check.

### `build-deploy.yml` - runs on merge to `main`, weekly cron, and manual dispatch
- The only workflow with `pages: write`, `id-token: write`, `attestations: write`.
- Three source paths, handled by job:
  - **`ci`** - `compile-ci`: PlatformIO (primary) / arduino-cli, then
    `esptool merge_bin` for ESP32 into one image flashed at `0x0`.
  - **`release`** - `fetch-release`: pulls the **pinned** Meshtastic release asset
    (we do *not* rebuild upstream Meshtastic) and verifies its hash.
  - **`static`** - passed through at assemble time (exception-only).
- Every artifact is SHA-256 hashed and gets a **GitHub build-provenance
  attestation** tying it to the source commit + toolchain.
- `assemble-deploy` collects artifacts, generates ESP Web Tools manifests from the
  profiles, asserts the self-hosted ESP Web Tools bundle is present (no runtime
  CDN), and deploys to Pages.
- The weekly `cron` rebuilds everything to catch upstream/toolchain drift - the
  "keep firmware from getting stale" requirement.

## Why Meshtastic is fetched, not built

Meshtastic is a large upstream build with its own per-board variant system and long
compile times. Retia's own docs compile it via a separate Action
(`nsgodshall/retia-boards`) and ship releases. So CI **pins a release tag** and
fetches the asset - reproducible, fast, and it still gets hashed + attested for
provenance. Reserve in-CI compilation for firmware you author.

## Scripts (all tested)

| Script | Role |
|---|---|
| `validate_profiles.py` | Schema + policy checks. Enforces the static-binary ban, the `latest`-tag ban, and the ESP32 `flash.*` requirement for merge_bin. |
| `plan_builds.py` | Diffs changed profiles/projects, emits GitHub matrix JSON split into `ci` vs `release`. |
| `build_firmware.sh` | Compiles a profile and packages per chip: ESP32 -> `merge_bin`; ESP8266 -> single image; RP2040 -> `.uf2` as-is. |
| `fetch_release.py` | Downloads + verifies a pinned release asset for `release` profiles. |
| `generate_manifests.py` | Profiles -> ESP Web Tools manifests (one part at `0x0` for merged images) + UF2 sidecars for RP2040. |
| `profile_get.py` | Reads dotted keys from a profile for the bash build script. |

## Board Profile -> CI contract

A profile's `provenance.binary_source` decides its path (`ci` / `release` /
`static`). ESP32 profiles must declare `flash.{mode,frequency,size}` because
`merge_bin` needs them and a wrong value produces a silent boot-loop. RP2040
profiles must set `flash.format: uf2`. See `profiles/` for one example of each.

## Local test

```bash
pip install pyyaml --break-system-packages
python3 scripts/validate_profiles.py --all
python3 scripts/plan_builds.py --all --split-sources --github-output /tmp/out
python3 scripts/generate_manifests.py --profiles-dir profiles \
    --firmware-dir /tmp/fw --out-dir /tmp/manifests
# preview the site locally (manifests + firmware are produced by CI, but the
# static app and vendored flasher render offline):
python3 -m http.server -d web 8000   # then open http://localhost:8000/
```

## Deploy checklist

1. Push this repo to GitHub, then **Settings -> Pages -> Source: GitHub Actions**.
2. First run: **Actions -> Build & Deploy -> Run workflow** (or push to `main`).
3. **Custom domain:** once live, set Settings -> Pages -> Custom domain to
   `scriptkitty.sh`, add the DNS records GitHub shows (apex `A`/`AAAA` or a `CNAME`
   for a subdomain), and commit the generated `web/CNAME` so redeploys keep it.
4. **Vendor ESP Web Tools** is already done (`web/vendor/esp-web-tools/`, pinned
   10.2.1). The deploy job hard-fails if it goes missing, by design.
5. **Pin `expected_sha256`** in each `release` profile once you know the asset hash,
   turning a moved/retagged upstream asset into a hard failure instead of a silent
   swap.
6. **`ci` profiles need their source** under `projects/` (e.g.
   `projects/usb-nugget/badusb` for `usb-nugget-s2-rev1`) before `compile-ci` can
   build them. Until that source lands, keep only `release` profiles active or the
   compile job will fail and block the deploy.
