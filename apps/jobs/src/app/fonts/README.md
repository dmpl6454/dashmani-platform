# Self-hosted fonts (jobs + web)

These files replace `next/font/google`, which downloads from fonts.googleapis.com during
`next build`. A transient failure there (`TypeError: Cannot read properties of null
(reading '1')` in `@next/font/dist/google/loader.js`) failed the 2026-11-02 production
deploy and fails CI now and then. With the files in the repo, the build never touches the
network for fonts.

Each `.woff2` is the same cut Google Fonts serves for the family as the old
`next/font/google` call requested it, but with latin and latin-ext in ONE file
(Google serves them as two files split by `unicode-range`, and `next/font/local` takes
one file per face):

| File | Upstream source (github.com/google/fonts, `ofl/`) | Axes kept (same as Google serves) |
| --- | --- | --- |
| `dm-sans.woff2` | `dmsans/DMSans[opsz,wght].ttf` | wght 100–1000, opsz pinned to 9 |
| `bricolage-grotesque.woff2` | `bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf` | opsz 12–96, wght 200–800, wdth pinned to 100 |
| `instrument-serif-{regular,italic}.woff2` | `instrumentserif/InstrumentSerif-{Regular,Italic}.ttf` | static |
| `jetbrains-mono.woff2` | `jetbrainsmono/JetBrainsMono[wght].ttf` | wght 400–800 |
| `apps/web/src/app/fonts/manrope.woff2` | `manrope/Manrope[wght].ttf` | wght 200–800 |

The licences (SIL OFL 1.1) sit next to the files as `OFL-<family>.txt`.

## Regenerating

With `pip install fonttools brotli`:

```bash
fonttools varLib.instancer DMSans[opsz,wght].ttf opsz=9 -o dm-sans.ttf
fonttools varLib.instancer BricolageGrotesque[opsz,wdth,wght].ttf wdth=100 -o bricolage-grotesque.ttf
fonttools varLib.instancer JetBrainsMono[wght].ttf wght=400:800 -o jetbrains-mono.ttf
# Manrope and Instrument Serif need no instancing.
pyftsubset <font>.ttf --unicodes="$LATIN,$LATIN_EXT" --layout-features='*' \
  --flavor=woff2 --output-file=<font>.woff2
```

`$LATIN` and `$LATIN_EXT` are Google's own `unicode-range` lists for those subsets:

- latin: `U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD`
- latin-ext: `U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF`
