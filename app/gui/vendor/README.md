# app/gui/vendor

Vendored browser bundles for the NW.js GUI. RMCH has no npm install step, so the
GUI loads these as plain `<script>` tags from `app/gui/index.html`.

| File | Version | Origin |
| --- | --- | --- |
| `vue.global.prod.js` | Vue 3.5.13 | `https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js` |
| `naive-ui.prod.js` | Naive UI 2.35.0 | `https://unpkg.com/naive-ui@2.35.0/dist/index.prod.js` |
| `jsoneditor/jsoneditor.min.js` | jsoneditor 10.4.3 (full build) | `https://unpkg.com/jsoneditor@10.4.3/dist/jsoneditor.min.js` |
| `jsoneditor/jsoneditor.min.css` | jsoneditor 10.4.3 | `https://unpkg.com/jsoneditor@10.4.3/dist/jsoneditor.min.css` |
| `jsoneditor/img/jsoneditor-icons.svg` | jsoneditor 10.4.3 | same dist tarball |

Notes:

- **Vue must be the full build** (`vue.global.prod.js`, not `vue.runtime.*`): the
  page has no bundler, so components carry string `template`s that the runtime
  compiles. `tools/gui-check.mjs` asserts the compiler is present.
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
- All bundles must stay compatible with the NW.js runtime RMCH borrows
  (NW 0.54 / Chromium 91). Check that before bumping any version — jsoneditor
  10.x dist is clean (`Object.hasOwn` / `structuredClone` / `.at()` / `static {}`
  all absent), verify the next one before upgrading.
