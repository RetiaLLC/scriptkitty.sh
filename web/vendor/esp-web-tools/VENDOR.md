# Vendored dependency

esp-web-tools 10.2.1 (Apache-2.0) — contents of the npm package's `dist/web/`.
Self-contained (relative imports only, no runtime CDN). Used as the "classic
flasher" FALLBACK: the primary flasher is vendored esptool-js; ESP Web Tools is
offered when a custom flash fails (it's battle-tested at 115200 over Web Serial).
