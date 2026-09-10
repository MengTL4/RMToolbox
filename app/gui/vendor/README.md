# app/gui/vendor

Vendored browser bundles for the NW.js GUI. The GUI loads these as plain
`<script>` tags from `app/gui/index.html`; npm dependencies build the new SFCs.

| File | Version | Origin |
| --- | --- | --- |
| `vue.global.prod.js` | Vue 3.5.13 | `https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js` |
| `naive-ui.prod.js` | Naive UI 2.45.3 | `https://unpkg.com/naive-ui@2.45.3/dist/index.prod.js` |
| `jsoneditor/jsoneditor.min.js` | jsoneditor 10.4.3 (full build) | `https://unpkg.com/jsoneditor@10.4.3/dist/jsoneditor.min.js` |
| `jsoneditor/jsoneditor.min.css` | jsoneditor 10.4.3 | `https://unpkg.com/jsoneditor@10.4.3/dist/jsoneditor.min.css` |
| `jsoneditor/img/jsoneditor-icons.svg` | jsoneditor 10.4.3 | same dist tarball |

Notes:

- The existing full Vue build is retained, but all application templates are now
  compiled as SFCs by Vite. They externalize Vue to this same global instance. Keep the npm Vue
  compiler and this vendored runtime at the same version.
  `tools/gui-check.mjs` checks all source SFCs and the compiled component registry.
- **Naive UI and jsoneditor are UMD.** NW.js injects `module`/`exports` into the
  page, which would send both bundles down their `require("vue")` branch and kill
  them, so `index.html` hides those globals while the vendor scripts evaluate and
  restores them afterwards. Do not "clean up" that dance.
- Naive UI is CSS-in-JS, so there is no vendor stylesheet to load. All theming
  lives in `app/gui/ui/theme.js`; `app/gui/styles.css` is document plumbing only.
- **jsoneditor ships a real stylesheet plus an icon sprite.** The CSS hardcodes
  `url(./img/jsoneditor-icons.svg)`, so the `img/` subdirectory must sit next to
  the stylesheet (structure cannot be flattened). Theming for RM 工具箱 lives in
  `app/gui/jsoneditor-theme.css`, re-skinned off `body.rm-dark` / `body.rm-light`
  — the one place where views-adjacent CSS is hand-written, because Naive's
  CSS-in-JS cannot reach third-party DOM. `tools/gui-check.mjs` asserts the
  sprite path resolves to the actual file and that the bundle exposes
  `window.JSONEditor` with the zh-CN locale inside.
- Bundles must work in the official runtime pinned by `nw-runtime.lock.json`
  (currently NW 0.115.0 / Chromium 152). Run `npm run test:gui-runtime` and the
  browser UI checks when upgrading. The historical NW 0.54 syntax restriction
  no longer applies to the toolbox GUI; injected game scripts remain separate.
- Naive UI was pinned to 2.35.0 for a while on the theory that Chromium 91 could
  not parse 2.36+ (ES2022 class `static {}` blocks), which forced a hand-written
  `NFlex` shim in `app/gui/ui/compat.js`. **The runtime is Chromium 152, not 91**,
  so the premise was simply wrong. The bundle is now 2.45.3 and the shim is gone;
  upgrade the bundle rather than re-implementing components locally.
