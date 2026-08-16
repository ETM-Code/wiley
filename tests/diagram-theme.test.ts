import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  HUES,
  HUE_PROVENANCE,
  NODE_ROLES,
  PALETTE,
  THEMES,
  THEME_NAMES,
  colorChroma,
  colorDifference,
  contrastRatio,
  isNodeRole,
  isThemeName,
  readableInk,
  resolveContainerTint,
  resolveEdgeColor,
  resolveEdgeStyle,
  resolveNodeStyle,
  resolveTheme,
  themeColors,
  type HueName,
} from "../src/renderer/diagram-theme";

const require = createRequire(import.meta.url);

/**
 * open-color arrives as a transitive dependency of Excalidraw rather than a
 * declared one, so the palette pin runs when it is installed and steps aside
 * when it is not.
 */
function loadOpenColor(): Record<string, string[]> | null {
  try {
    return require("open-color/open-color.json") as Record<string, string[]>;
  } catch {
    return null;
  }
}

/**
 * Where a fill sits on the colour wheel, or null when it carries too little
 * saturation for an angle to mean anything.
 */
function hueAngle(hex: string): number | null {
  if (!hex.startsWith("#") || hex.length !== 7) return null;
  const [red, green, blue] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  if (delta < 0.08) return null;
  const sixth = max === red
    ? ((green - blue) / delta + 6) % 6
    : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return sixth * 60;
}

/** The shorter way round the wheel between two angles. */
function hueDistance(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360;
  return gap > 180 ? 360 - gap : gap;
}

describe("diagram palette", () => {
  it("pins every hue to open-color at the shade indexes Excalidraw uses", () => {
    const openColor = loadOpenColor();
    if (!openColor) {
      expect(Object.keys(HUES).length).toBeGreaterThan(0);
      return;
    }
    for (const [name, entry] of Object.entries(HUES) as Array<[HueName, typeof HUES[HueName]]>) {
      const source = HUE_PROVENANCE[name];
      const shades = openColor[source.hue];
      expect(shades, `open-color has no hue ${source.hue}`).toBeTruthy();
      for (const index of [source.fill, source.soft, source.stroke]) {
        expect([0, 1, 2, 4, 6, 7, 8, 9]).toContain(index);
      }
      expect(entry.fill, `${name}.fill`).toBe(shades[source.fill]);
      expect(entry.soft, `${name}.soft`).toBe(shades[source.soft]);
      expect(entry.stroke, `${name}.stroke`).toBe(shades[source.stroke]);
    }
  });

  it("keeps the documented role constants", () => {
    expect(PALETTE.primary).toEqual({ fill: "#a5d8ff", soft: "#e7f5ff", stroke: "#1971c2" });
    expect(PALETTE.success).toEqual({ fill: "#b2f2bb", soft: "#ebfbee", stroke: "#2f9e44" });
    expect(PALETTE.warning).toEqual({ fill: "#ffec99", soft: "#fff9db", stroke: "#f08c00" });
    expect(PALETTE.danger).toEqual({ fill: "#ffc9c9", soft: "#fff5f5", stroke: "#e03131" });
    expect(PALETTE.accent).toEqual({ fill: "#d0bfff", soft: "#f3f0ff", stroke: "#6741d9" });
    expect(PALETTE.muted).toEqual({ fill: "#e9ecef", soft: "#f8f9fa", stroke: "#495057" });
    expect(PALETTE.neutral).toEqual({ fill: "transparent", soft: "transparent", stroke: "#1e1e1e" });
  });
});

describe("diagram themes", () => {
  it("defines all six themes with an entry for every role", () => {
    expect(THEME_NAMES).toHaveLength(6);
    for (const name of THEME_NAMES) {
      const theme = THEMES[name];
      expect(theme.name).toBe(name);
      for (const role of NODE_ROLES) expect(theme.entries[role]).toBeTruthy();
    }
  });

  it("draws every connector in one receding ink rather than a node colour", () => {
    for (const name of THEME_NAMES) {
      const theme = THEMES[name];
      // Wiring is not a role. Taking it from a role's stroke made a warm
      // board's connectors compete with its boxes for the same attention.
      expect(theme.edgeColor).toBe(HUES.gray.stroke);
      expect(theme.edgeColor).not.toBe("#1e1e1e");
    }
  });

  it("keeps mono grayscale", () => {
    const mono = THEMES.mono;
    for (const role of NODE_ROLES) {
      const entry = mono.entries[role];
      if (entry.fill === "transparent") continue;
      // open-color's grays carry a slight cool cast; anything with real hue
      // would separate its channels far wider than this.
      const channels = [1, 3, 5].map((index) => Number.parseInt(entry.fill.slice(index, index + 2), 16));
      expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(16);
    }
  });

  it("keeps every accent a wide turn of the wheel from its own theme", () => {
    // The accent is what a board spends on "look here". Sat next to the
    // primary on the colour wheel it stops being an accent and the board
    // reads as one hue smeared across several roles.
    for (const name of THEME_NAMES) {
      const theme = THEMES[name];
      const accent = hueAngle(theme.entries.accent.fill);
      // The grayscale theme separates by weight, not by hue, and a gray's
      // angle is an artefact of rounding rather than a colour.
      if (accent === null) continue;
      for (const against of ["primary", "success"] as const) {
        const other = hueAngle(theme.entries[against].fill);
        if (other === null) continue;
        expect(hueDistance(accent, other), `${name} accent vs ${against}`).toBeGreaterThanOrEqual(45);
      }
    }
  });

  it("keeps the forest board's greens from collapsing into one colour", () => {
    // What three panels read as one colour: the green the primary used to be
    // against the lime the success used to be, under the bar a board is now
    // held to. The greens are still in the palette, so the pair is still
    // measurable and still the reason the theme moved.
    expect(colorDifference(HUES.green.fill, HUES.lime.fill)).toBeCloseTo(9.99, 1);
    const forest = THEMES.forest;
    for (const [a, b] of [["primary", "success"], ["primary", "muted"], ["success", "muted"]] as const) {
      expect(colorDifference(forest.entries[a].fill, forest.entries[b].fill), `${a} vs ${b}`)
        .toBeGreaterThan(10.5);
    }
  });

  it("pins both ends of the bracket the fill distance is calibrated in", () => {
    // The quality check asks 10.5 of two fills on one board. The floor is the
    // forest pair above at 9.99; the ceiling is the tightest coloured pair any
    // theme still puts on a board, sunset's primary against its warning. Move
    // a palette across either and the number stops meaning what it says.
    expect(colorDifference(THEMES.sunset.entries.primary.fill, THEMES.sunset.entries.warning.fill))
      .toBeCloseTo(11.21, 1);
    // And the measure has to see a grayscale theme's two weights as near in
    // colour, since it is weight that separates them, not colour.
    expect(colorDifference(HUES.graphite.fill, HUES.gray.fill)).toBeLessThan(10.5);
    expect(colorChroma(HUES.graphite.fill)).toBeLessThan(5);
    expect(Math.min(...Object.values(HUES).map((hue) => colorChroma(hue.fill)))).toBeLessThan(5);
    for (const hue of ["red", "green", "blue", "cyan", "violet", "yellow"] as const) {
      expect(colorChroma(HUES[hue].fill), hue).toBeGreaterThan(20);
    }
  });

  it("keeps the quiet register inside each theme's own family", () => {
    // A cold gray on a warm board is the one fill that belongs to no family,
    // and a reader cannot tell whether it means something or was forgotten.
    for (const name of THEME_NAMES) {
      const theme = THEMES[name];
      const quiet = theme.entries.muted;
      // A colour-forward theme drops its own hue to the wash; a neutral one is
      // already speaking gray, so gray is its family.
      const expected = theme.entries[theme.defaultRole].fill === "transparent"
        ? HUES.gray.fill
        : theme.entries[theme.defaultRole].soft;
      expect(quiet.fill, name).toBe(expected);
      // Border from the same hue as the fill. A gray-outlined shape on a warm
      // board reads as one the drawing forgot to finish.
      const family = Object.values(HUES).find((hue) => hue.soft === quiet.soft);
      expect(quiet.stroke, name).toBe(family?.stroke);
    }
    expect(THEMES.sunset.entries.muted.stroke).toBe(HUES.orange.stroke);
    expect(THEMES.sunset.entries.muted.fill).toBe(HUES.orange.soft);
    expect(THEMES.grape.entries.muted.fill).toBe(HUES.grape.soft);
    // The grayscale themes were already speaking gray, so nothing moves.
    expect(THEMES.slate.entries.muted.fill).toBe(HUES.gray.fill);
    expect(THEMES.mono.entries.muted.fill).toBe(HUES.gray.fill);
  });

  it("falls back to slate for an unknown or missing theme name", () => {
    expect(resolveTheme(undefined).name).toBe("slate");
    expect(resolveTheme("chartreuse").name).toBe("slate");
    expect(resolveTheme("ocean").name).toBe("ocean");
    expect(isThemeName("forest")).toBe(true);
    expect(isThemeName("forrest")).toBe(false);
    expect(isNodeRole("danger")).toBe(true);
    expect(isNodeRole("dangerous")).toBe(false);
  });

  it("leaves an unroled node unfilled under the neutral-forward theme", () => {
    const style = resolveNodeStyle(THEMES.slate, undefined);
    expect(style.backgroundColor).toBe("transparent");
    expect(style.strokeColor).toBe("#1e1e1e");
  });

  it("keeps a themed board's strongest fill for the nodes that asked for it", () => {
    // Every colour-forward theme defaults unroled nodes to its primary hue,
    // so the wash is the only thing between "this one matters" and "all of
    // them look like they matter".
    for (const theme of [THEMES.ocean, THEMES.forest, THEMES.sunset, THEMES.grape]) {
      const anonymous = resolveNodeStyle(theme, undefined);
      const named = resolveNodeStyle(theme, "primary");
      expect(anonymous.backgroundColor).toBe(theme.entries[theme.defaultRole].soft);
      expect(anonymous.backgroundColor).not.toBe(named.backgroundColor);
      // Saying so out loud still gets the full fill, whatever the role.
      expect(resolveNodeStyle(theme, undefined, "strong").backgroundColor)
        .toBe(theme.entries[theme.defaultRole].fill);
    }
  });
});

describe("resolveNodeStyle", () => {
  it("maps emphasis to stroke weight, opacity, and the soft wash", () => {
    const theme = THEMES.ocean;
    const normal = resolveNodeStyle(theme, "primary", "normal");
    const strong = resolveNodeStyle(theme, "primary", "strong");
    const quiet = resolveNodeStyle(theme, "primary", "quiet");
    expect(normal).toMatchObject({ backgroundColor: "#a5d8ff", strokeWidth: 1, opacity: 100, fillStyle: "solid" });
    expect(strong).toMatchObject({ backgroundColor: "#a5d8ff", strokeWidth: 2, opacity: 100 });
    expect(quiet).toMatchObject({ backgroundColor: "#e7f5ff", strokeWidth: 1, opacity: 70 });
  });

  it("lets explicit colours beat the role", () => {
    const style = resolveNodeStyle(THEMES.ocean, "danger", "normal", {
      backgroundColor: "#123456",
      strokeColor: "#654321",
    });
    expect(style.backgroundColor).toBe("#123456");
    expect(style.strokeColor).toBe("#654321");
    // Dark fill flips the label to paper so it stays readable.
    expect(style.labelColor).toBe("#ffffff");
  });

  it("always picks a label ink that clears WCAG large-text contrast", () => {
    for (const name of THEME_NAMES) {
      const theme = THEMES[name];
      for (const role of NODE_ROLES) {
        for (const emphasis of ["normal", "strong", "quiet"] as const) {
          const style = resolveNodeStyle(theme, role, emphasis);
          const surface = style.backgroundColor === "transparent" ? theme.paperColor : style.backgroundColor;
          expect(contrastRatio(style.labelColor, surface)).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("tints containers with the soft shade regardless of emphasis", () => {
    expect(resolveContainerTint(THEMES.forest, "primary")).toBe("#e3fafc");
    expect(resolveContainerTint(THEMES.slate, undefined)).toBe("transparent");
  });

  it("reads ink against paper for a transparent surface", () => {
    expect(readableInk(THEMES.slate, "transparent")).toBe("#1e1e1e");
    expect(readableInk(THEMES.slate, "#111111")).toBe("#ffffff");
  });
});

describe("resolveEdgeStyle", () => {
  it("defaults to a solid muted single-headed arrow", () => {
    expect(resolveEdgeStyle(THEMES.grape)).toEqual({
      strokeColor: THEMES.grape.edgeColor,
      strokeStyle: "solid",
      strokeWidth: 1,
      opacity: 100,
      startArrowhead: null,
      endArrowhead: "arrow",
      labelColor: "#1e1e1e",
    });
  });

  it("maps style, weight, and arrow onto Excalidraw properties", () => {
    expect(resolveEdgeStyle(THEMES.ocean, { style: "dashed", weight: "strong", arrow: "both" }))
      .toMatchObject({ strokeStyle: "dashed", strokeWidth: 2, startArrowhead: "arrow", endArrowhead: "arrow" });
    expect(resolveEdgeStyle(THEMES.ocean, { style: "dotted", weight: "quiet", arrow: "none" }))
      .toMatchObject({ strokeStyle: "dotted", strokeWidth: 1, opacity: 70, endArrowhead: null });
  });

  it("accepts a role name or a hex value for colour and ignores anything else", () => {
    expect(resolveEdgeColor(THEMES.ocean, "danger")).toBe(THEMES.ocean.entries.danger.stroke);
    expect(resolveEdgeColor(THEMES.ocean, "#abcdef")).toBe("#abcdef");
    expect(resolveEdgeColor(THEMES.ocean, "puce")).toBe(THEMES.ocean.edgeColor);
    expect(resolveEdgeColor(THEMES.ocean, undefined)).toBe(THEMES.ocean.edgeColor);
  });
});

describe("themeColors", () => {
  it("covers every colour the resolvers can emit", () => {
    for (const name of THEME_NAMES) {
      const theme = THEMES[name];
      const allowed = themeColors(theme);
      for (const role of NODE_ROLES) {
        for (const emphasis of ["normal", "strong", "quiet"] as const) {
          const style = resolveNodeStyle(theme, role, emphasis);
          expect(allowed.has(style.backgroundColor)).toBe(true);
          expect(allowed.has(style.strokeColor)).toBe(true);
          expect(allowed.has(style.labelColor)).toBe(true);
        }
        expect(allowed.has(resolveEdgeColor(theme, role))).toBe(true);
      }
      expect(allowed.has(resolveEdgeStyle(theme).strokeColor)).toBe(true);
      expect(allowed.has(theme.titleColor)).toBe(true);
    }
  });
});
