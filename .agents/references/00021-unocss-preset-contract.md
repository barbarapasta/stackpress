# UnoCSS Preset Contract

Use this reference for the `stackpress/unocss` preset: its breakpoint prefixes,
rule families, and what it does not include. Other package exports and
generated-client shape are in
[Exports, Types, And Generated Contracts](00014-exports-types-generated-contracts.md).

```ts
import stackpressPreset from 'stackpress/unocss';
// presets: [stackpressPreset()]
```

The default export is a `definePreset` factory currently named
`unocss-frui-preset`. It provides desktop-first max-width variants:

| Prefix | Max width |
| --- | --- |
| `r4xl-` | 1920px |
| `r3xl-` | 1536px |
| `r2xl-` | 1280px |
| `rxl-` | 1024px |
| `rlg-` | 992px |
| `rmd-` | 767px |
| `rsm-` | 420px |
| `rxs-` | 360px |

Rule families:

- `theme-*`, `theme-bg-*`, `theme-bc-*` map names or numeric theme slots to CSS variables;
- `hex-*`, `rgb-*`, `rgba-*` provide text/background/border colors;
- `px-*` provides exact border, margin, padding, dimensions, position, opacity,
  z-index, line-height, flex-basis/gap, font-size, and percent-minus-pixel forms.

The preset adds utilities; it does not include the exported reset or Stackpress
stylesheet automatically. Configure UnoCSS/Vite and import required CSS files.
Generated dynamic class strings may require explicit scanning/safelist evidence.

## Source Anchors And Authority

Anchors: `packages/stackpress/src/unocss.ts` and the `./unocss` export in its manifest.
Package source is authority; existing docs are parity benchmarks.
