# Vendored dependency

esptool-js 0.6.0 (Apache-2.0) — `bundle.js` is the package's self-contained bundle
(no external imports). It powers BOTH the site's "Detect my board" flow (reads chip
family + flash size over Web Serial) and flashing itself (single merged image written
at 0x0, fast baud by default with a speed selector + optional full erase). No CDN.

Update: download a newer esptool-js tarball, replace bundle.js, bump the version here.
