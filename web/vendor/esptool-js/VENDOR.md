# Vendored dependency

esptool-js 0.6.0 (Apache-2.0) — `bundle.js` is the package's self-contained bundle
(no external imports). Used by the site's "Detect my board" flow to read the chip
family + flash size over Web Serial. Flashing itself uses ESP Web Tools; this is
detection only.

Update: download a newer esptool-js tarball, replace bundle.js, bump the version here.
