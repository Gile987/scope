# Light palette

A single-hue (230) neutral ramp + one action color. Every token is paired with
**the only role it should fill**. Pick the lowest-luminance token that still meets
the contrast rule for the role — never go darker "for emphasis".

## Tokens

| Token        | Hex      | HSB          | HSL              | Tailwind utility     | Role                          |
|--------------|----------|--------------|------------------|----------------------|-------------------------------|
| `--action`   | `#3D55CC`| 230, 70, 80  | 230° 58% 52%     | `bg-action` `text-action` | Primary CTA / interactive    |
| `--ink-900`  | `#141A33`| 230, 60, 20  | 230° 43% 14%     | `text-ink-900`       | Heading text                   |
| `--ink-500`  | `#505673`| 230, 30, 45  | 230° 18% 38%     | `text-ink-500`       | Secondary / body text          |
| `--ink-300`  | `#878CA8`| 230, 20, 66  | 230° 16% 59%     | `border-ink-300`     | Non-decorative borders         |
| `--ink-100`  | `#DADEF2`| 230, 10, 95  | 230° 49% 90%     | `border-ink-100`     | Decorative borders only        |
| `--ink-50`   | `#F5F6FA`| 230, 2, 98   | 230° 33% 97%     | `bg-ink-50`          | Alternate backgrounds          |
| `--ink-0`    | `#FFFFFF`| 0, 0, 100    | 0° 0% 100%       | `bg-ink-0`           | Main background                |

The `--action-foreground` is `#FFFFFF` — always pair it with `--action` for text/icons on the CTA.

## Rules

### R1 — One role per token
A token has **exactly one** role. Do not use `--ink-500` for borders just because it's "darker than `--ink-300`". If a screen needs a custom shade, propose a new token.

### R2 — Contrast against the lightest surface
"Lightest" = whichever of `--ink-0` or `--ink-50` is behind the element. Every meaningful (non-decorative) token must beat the contrast threshold against both:

| Token       | Min contrast vs lightest |
|-------------|--------------------------|
| `--action`  | **4.5 : 1**              |
| `--ink-900` | **4.5 : 1**              |
| `--ink-500` | **4.5 : 1**              |
| `--ink-300` | **3 : 1**   (UI element) |
| `--ink-100` | none — decorative only   |

Decorative borders (`--ink-100`) **must never** be the sole visual indicator of state, focus, or hierarchy — those need a token that meets contrast.

### R3 — Background pairing
- `--ink-0` (white) is the canonical main background. Cards, sheets, dialogs, the page body.
- `--ink-50` is for **alternate** backgrounds — banded table rows, code blocks, "lifted" sections, sidebars when stacked on white. Never on top of `--ink-0` without a separator.
- Never use `--ink-100` as a background — it's too saturated to read text on.

### R4 — Borders
- Use `--ink-300` for any border the user is meant to perceive: input field outlines, dividers between primary regions, table separators.
- Use `--ink-100` only when a line is purely cosmetic: decorative card outlines, between cells inside a single grouped component, an avatar ring. If removing the line wouldn't change comprehension, it's decorative.

### R5 — Text
- `--ink-900` is the default for headings (`h1`–`h4`) and body copy that needs maximum legibility.
- `--ink-500` is for secondary text: captions, metadata, helper text, disabled-but-still-readable labels. Never for the primary content of a screen.
- For text on `--action` use `--action-foreground` (white). Don't pair `--ink-900` with `--action` — readability is unreliable.

### R6 — Action color is reserved
`--action` is for elements the user **actuates**: primary buttons, primary links, focus rings, selected states, progress indicators. Don't use it as decoration, as a background tint, or as a heading color — that dilutes its signal.

### R7 — Brand color is separate
Brand color (`--brand-*`, the Lens teal) is the marketing/identity color and is reserved for the New Run CTA and similar product-identity moments. It is **not** part of this neutral palette and does not replace `--action`.

## Example usage

```tsx
// Primary CTA
<button className="bg-action text-action-foreground hover:bg-action/90">
  Save
</button>

// Card with a decorative outline
<div className="bg-ink-0 border border-ink-100 rounded-lg p-6">
  <h2 className="text-ink-900 text-xl font-semibold">Heading</h2>
  <p className="text-ink-500 mt-2">Secondary description text.</p>
</div>

// Banded table
<tr className="even:bg-ink-50">
  <td className="border-b border-ink-300">…</td>
</tr>
```

## Adding tokens vs. reaching for ad-hoc hex

Don't `bg-[#abcdef]`. If the existing palette doesn't have what you need:

1. Check whether an existing token would do at lower saturation. It usually will.
2. If a genuinely new shade is needed, open a PR that adds a new token to `apps/portal/src/index.css`, names the role, and updates this doc.

A small palette is the design system. New ad-hoc colors are not "freedom" — they're entropy.
