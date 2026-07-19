---
name: site-preview
description: Build a small static website, render a screenshot of it, drop the screenshot on the whiteboard, and open the real page for the user.
---

# Site preview

Use this skill whenever a task ends with a website, HTML page, or visual artifact the user will want to see.

## Build

1. Write the site into the project workspace (for example `site/index.html`). Keep it self-contained: inline CSS, no CDN dependencies, and real copy written for this product, never filler text.
2. If the board holds a wireframe or labelled sketch of the layout, follow it: match the sections, ordering, and labels the user drew.

## Screenshot

Render headlessly with the installed Chrome:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --screenshot="$PWD/site/preview.png" \
  --window-size=1280,900 --hide-scrollbars "file://$PWD/site/index.html"
```

If that binary is missing, try `"/Applications/Chromium.app/Contents/MacOS/Chromium"` or `npx --yes playwright screenshot --viewport-size=1280,900 "file://$PWD/site/index.html" site/preview.png`.

## Show the user

1. Put the screenshot on the whiteboard with `place_image`, placed beside the related sketch or diagram (`placeNear` + `placeDirection`), so the user sees the result where they drew the idea.
2. When the user asks to open or view the site, run `open "$PWD/site/index.html"`. That launches their browser with the real page; the screenshot on the board is not a substitute for opening it when asked.
3. Say what you built in one short first-person sentence; the details live on the board and in the files.
