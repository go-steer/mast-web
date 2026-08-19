# web/vendor — third-party browser bundles

Vendored, exact-version copies of the three libraries the transcript renderer uses.
Previously loaded from `cdn.jsdelivr.net` at runtime; vendored because:

1. **Air-gapped / single-binary deploys.** `internal/webui` `go:embed`s this tree into
   `mast-web-server`, and the README advertises air-gapped and `--ui` single-binary
   shapes. A CDN `<script>` tag means markdown + highlighting silently break with no
   network — `web/app.js:1665-1666` guards on `typeof marked/hljs`, so the failure is
   invisible.
2. **Supply chain.** Agent tokens live in `localStorage` on this origin, so any script
   the page loads can exfiltrate them. Removing the third-party origin entirely is a
   stronger fix than SRI, and it lets the CSP be a flat `script-src 'self'`.
3. **SRI was not actually available.** jsDelivr minifies `/npm/**.min.js` on the fly and
   stamps its output with *"Do NOT use SRI with dynamically generated files"*.

## Contents

| File | Package | Version | Source |
|---|---|---|---|
| `marked-12.0.2.min.js` | `marked` | 12.0.2 | `https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js` |
| `marked-highlight-2.2.4.umd.js` | `marked-highlight` | 2.2.4 | `https://cdn.jsdelivr.net/npm/marked-highlight@2.2.4/lib/index.umd.js` |
| `highlight-11.12.0.min.js` | `highlight.js` | 11.12.0 | `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.12.0/build/highlight.min.js` |

Licenses: marked — MIT; marked-highlight — MIT; highlight.js — BSD-3-Clause. Each file
retains its upstream license banner.

## Note on the highlight.js source URL

It is deliberately **not** `npm/highlight.js@11/lib/common.min.js`, which is what
`index.html` used before. That path is a CommonJS module whose first statement is
`require("./core")` — in a browser it throws immediately, `window.hljs` is never defined,
and `app.js:1666`'s `typeof hljs !== 'undefined'` guard silently skips highlighting. Syntax
highlighting never actually worked. The browser bundle lives in the separate
`highlightjs/cdn-release` repo, which is what we vendor.

## Refreshing

Bump the version in the URL, re-download, rename to match the new version, and update both
this table and the `<script>` tags in `web/index.html`. Verify the file is a browser bundle
before committing:

```sh
grep -c 'require(' web/vendor/<file>.js   # must be 0
```
