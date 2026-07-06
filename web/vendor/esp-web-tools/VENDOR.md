# Vendored dependency

esp-web-tools 10.2.1 (Apache-2.0) - contents of the npm package's `dist/web/`.
Source: https://registry.npmjs.org/esp-web-tools/-/esp-web-tools-10.2.1.tgz

Self-contained: `install-button.js` and its sibling chunks import each other with
relative `./` paths only, so everything resolves same-origin (no runtime CDN).
The deploy job asserts `install-button.js` is present.

To update: download a newer tarball, replace this directory's `*.js` with the new
`dist/web/*.js`, and bump the version here.
