# web/fonts/

This directory is served by the app's own static handler (`server/static.mjs`
already knows `font/woff2`). It exists so the two brand faces can be **self
hosted**: constraint 3 of the KAN-105 brief forbids a web font fetched over the
network — no `<link>` to `fonts.googleapis.com`, no `@import`, nothing that
leaves this origin. Every `@font-face` in `web/styles.css` therefore points at a
file here, after trying `local()` first.

## The four files this directory expects

| file | family | weight | used for |
|---|---|---|---|
| `zen-maru-gothic-500.woff2` | Zen Maru Gothic | 500 | display face, medium |
| `zen-maru-gothic-700.woff2` | Zen Maru Gothic | 700 | every heading (the brand signature) |
| `karla-400.woff2` | Karla | 400 | UI chrome — body default, nav, tabs, labels |
| `karla-600.woff2` | Karla | 600 | UI chrome — active/emphasised chrome |

They are **latin-subset WOFF2 cut from the Google Fonts originals**
(Zen Maru Gothic and Karla, both SIL Open Font License 1.1). Nothing in this
repository downloads them: an owner places the four files here by hand, once,
and they are then served from `http://127.0.0.1:<port>/fonts/…` like any other
static asset. Keep the OFL licence text alongside them if you redistribute.

## Until they are here

`styles.css` still works. Each `url()` 404s, its `@font-face` fails, and the
family falls through to the next entry in the stack:

* `"Zen Maru Gothic"` → the Karla stack → `ui-sans-serif`/`system-ui`
* `Karla` → `ui-sans-serif`/`system-ui` (exactly what the app used before)
* prose is Georgia and figures are the system mono — neither is downloaded at all

`font-display: swap` means first paint never waits on any of this, and no
measure, `ch` width or size in the sheet depends on a downloaded face.
