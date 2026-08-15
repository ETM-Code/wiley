import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as fontkitModule from "fontkit";
import type { Font } from "fontkit";

const fontkit = (fontkitModule as { default?: typeof fontkitModule }).default ?? fontkitModule;

import {
  WIDE_GLYPH_ADVANCE_RATIO,
  WIDE_GLYPH_MIN_CODE_POINT,
  setDiagramTextMeasurer,
} from "../../src/renderer/diagram-layout";

let faces: Font[] | null = null;

/**
 * Loads the Excalifont subsets that ship inside @excalidraw/excalidraw, so
 * tests measure the exact font the app renders instead of an estimate.
 */
function loadExcalifont(): Font[] {
  if (faces) return faces;
  const dir = path.join(
    process.cwd(),
    "node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont",
  );
  faces = readdirSync(dir)
    .filter((file) => file.endsWith(".woff2"))
    .map((file) => fontkit.create(readFileSync(path.join(dir, file))) as Font);
  if (faces.length === 0) throw new Error("No Excalifont subsets found in @excalidraw/excalidraw");
  return faces;
}

export function installExcalifontMeasurer(): void {
  const fonts = loadExcalifont();
  setDiagramTextMeasurer((text, fontSize) => {
    let width = 0;
    for (const character of Array.from(text)) {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) continue;
      const face = fonts.find((candidate) => candidate.hasGlyphForCodePoint(codePoint));
      if (!face) {
        // Excalifont ships no emoji glyphs; the browser falls through to the
        // platform emoji font, which draws a square tile. Measuring these
        // against Excalifont's notdef metrics under-reports them badly.
        width += codePoint >= WIDE_GLYPH_MIN_CODE_POINT
          ? fontSize * WIDE_GLYPH_ADVANCE_RATIO
          : (fonts[0].layout(character).advanceWidth / fonts[0].unitsPerEm) * fontSize;
        continue;
      }
      width += (face.layout(character).advanceWidth / face.unitsPerEm) * fontSize;
    }
    return width > 0 ? width : null;
  });
}

export function uninstallExcalifontMeasurer(): void {
  setDiagramTextMeasurer(null);
}
