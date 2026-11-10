# Self-hosted fonts

These replace the Google Fonts `@import` in `src/app/globals.css` (2026-11-10, speed batch 4):
a CSS `@import` from fonts.googleapis.com held the first paint until Google's stylesheet and
then the font files arrived from a second origin. The `@font-face` rules in globals.css are
Google's own (same families, weights, `unicode-range` and `font-display: swap`), keeping only
the latin and latin-ext subsets; a browser still downloads only the files a page needs.

Files were fetched from Google Fonts' css2 API (Chrome user agent) on 2026-11-10; licences
(SIL Open Font License 1.1) are the `OFL-<family>.txt` files here. To refresh them, re-run the
same css2 URL and replace the files and the `@font-face` block together.
