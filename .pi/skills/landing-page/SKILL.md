---
name: landing-page
description: Quality bar and structure for generating landing pages and small marketing sites that do not look like generic AI output.
---

# Landing page quality bar

Apply this when generating a landing page, marketing site, or product one-pager.

## Structure

- Hero: one concrete headline about what the product does for the user, one subline, one primary call to action. No "Welcome to" openers.
- Then 3 to 5 sections maximum: how it works, key capabilities, social proof or credibility, closing call to action. If the user sketched sections on the board, use exactly those.
- One `<main>` with semantic sections; real copy for this product, never filler text or invented placeholder brand names.

## Look

- Pick one accent color and stick to it; neutrals elsewhere. Dark text on light background or a deliberate dark theme, never grey-on-grey.
- One display font pairing via system fonts or a single `@font-face`; set a real type scale (hero around 3rem, body 1rem to 1.125rem, generous line height).
- Spacing does the design work: consistent vertical rhythm (multiples of 8px), max content width around 1100px, whitespace between sections.
- No stock gradients-on-everything, no emoji bullets, no three-column icon grids unless the content genuinely has three parallel items.

## Ship

- Single self-contained `index.html` with inline CSS unless the task says otherwise.
- Must render correctly at 1280px and 390px wide.
- Follow the `site-preview` skill to screenshot it, place it on the board, and open it when asked.
