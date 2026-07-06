#!/usr/bin/env bash
# Build one profile's firmware and emit a single flashable artifact into --out-dir.
#
#   ESP32-S2 / S3  -> compile, then `esptool merge_bin` into one 0x0 image
#                     (ESP Web Tools cannot patch flash freq/size/mode on the fly,
#                      so a merged single-file image is required)
#   ESP8266        -> compile, single image, no merge
#   RP2040         -> compile, emit .uf2 as-is (UF2 carries its own addressing)
#
# Primary build system is PlatformIO; arduino-cli is used only when the project
# ships an arduino-cli build (detected via profile.build.system).
set -euo pipefail

PROFILE="" PROJECT_DIR="" OUT_DIR="" CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROFILE" ] && [ -n "$PROJECT_DIR" ] && [ -n "$OUT_DIR" ] || {
  echo "usage: build_firmware.sh --profile ID --project-dir DIR --out-dir DIR [--check-only]" >&2
  exit 2
}
mkdir -p "$OUT_DIR"

# --- read the fields we need out of the profile via a tiny python helper --------
read_profile() { python3 scripts/profile_get.py "profiles/${PROFILE}.yaml" "$1"; }

MCU="$(read_profile mcu)"
BUILD_SYSTEM="$(read_profile build.system || echo platformio)"
PIO_ENV="$(read_profile build.environment || echo "")"
FQBN="$(read_profile build.fqbn || echo "")"
FLASH_MODE="$(read_profile flash.mode || echo dio)"
FLASH_FREQ="$(read_profile flash.frequency || echo 40m)"
FLASH_SIZE="$(read_profile flash.size || echo 4MB)"

echo "== Building $PROFILE  (mcu=$MCU, system=$BUILD_SYSTEM) =="

BUILD_TMP="$(mktemp -d)"
trap 'rm -rf "$BUILD_TMP"' EXIT

# --- compile -------------------------------------------------------------------
case "$BUILD_SYSTEM" in
  platformio)
    [ -n "$PIO_ENV" ] || { echo "::error::profile $PROFILE has build.system=platformio but no build.environment"; exit 1; }
    ( cd "$PROJECT_DIR" && pio run -e "$PIO_ENV" )
    BUILD_OUT="$PROJECT_DIR/.pio/build/$PIO_ENV"
    ;;
  arduino-cli)
    [ -n "$FQBN" ] || { echo "::error::profile $PROFILE has build.system=arduino-cli but no build.fqbn"; exit 1; }
    arduino-cli compile --fqbn "$FQBN" --output-dir "$BUILD_TMP" "$PROJECT_DIR"
    BUILD_OUT="$BUILD_TMP"
    ;;
  *)
    echo "::error::unknown build.system '$BUILD_SYSTEM' in profile $PROFILE"; exit 1 ;;
esac

# --- package per chip family ---------------------------------------------------
case "$MCU" in
  rp2040)
    UF2="$(find "$BUILD_OUT" -name '*.uf2' | head -n1)"
    [ -n "$UF2" ] || { echo "::error::no .uf2 produced for $PROFILE"; exit 1; }
    cp "$UF2" "$OUT_DIR/${PROFILE}.uf2"
    echo "-> $OUT_DIR/${PROFILE}.uf2"
    ;;

  esp8266)
    BIN="$(find "$BUILD_OUT" -name '*.bin' ! -name '*bootloader*' ! -name '*partition*' | head -n1)"
    [ -n "$BIN" ] || { echo "::error::no .bin produced for $PROFILE"; exit 1; }
    cp "$BIN" "$OUT_DIR/${PROFILE}.bin"
    echo "-> $OUT_DIR/${PROFILE}.bin (single image)"
    ;;

  esp32-s2|esp32-s3|esp32)
    # Locate the four standard parts. PlatformIO names them predictably.
    BOOT="$(find "$BUILD_OUT" -name 'bootloader.bin' | head -n1)"
    PART="$(find "$BUILD_OUT" -name 'partitions.bin' | head -n1)"
    APP="$(find "$BUILD_OUT" -maxdepth 1 -name 'firmware.bin' | head -n1)"
    # boot_app0 ships with the framework, not the build dir; locate it in ~/.platformio
    BOOTAPP="$(find "$HOME/.platformio" -name 'boot_app0.bin' 2>/dev/null | head -n1 || true)"

    for v in BOOT:$BOOT PART:$PART APP:$APP BOOTAPP:$BOOTAPP; do
      name="${v%%:*}"; path="${v#*:}"
      [ -n "$path" ] || { echo "::error::$PROFILE: missing $name for merge_bin"; exit 1; }
    done

    CHIP="${MCU/esp32-/esp32}"; [ "$MCU" = "esp32" ] && CHIP="esp32"
    # esp32-s2 -> esp32s2, esp32-s3 -> esp32s3
    CHIP="$(echo "$MCU" | tr -d '-')"

    echo "-- esptool merge_bin ($CHIP, mode=$FLASH_MODE freq=$FLASH_FREQ size=$FLASH_SIZE) --"
    python3 -m esptool --chip "$CHIP" merge_bin \
      -o "$OUT_DIR/${PROFILE}.bin" \
      --flash_mode "$FLASH_MODE" \
      --flash_freq "$FLASH_FREQ" \
      --flash_size "$FLASH_SIZE" \
      0x1000  "$BOOT" \
      0x8000  "$PART" \
      0xe000  "$BOOTAPP" \
      0x10000 "$APP"
    echo "-> $OUT_DIR/${PROFILE}.bin (merged, flash at 0x0)"
    ;;

  *)
    echo "::error::unhandled mcu '$MCU' for profile $PROFILE"; exit 1 ;;
esac

if [ "$CHECK_ONLY" = "1" ]; then
  echo "check-only: artifact produced, not published."
fi
