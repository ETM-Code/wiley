/**
 * The colour system every agent-drawn diagram is built from.
 *
 * Nodes and edges name a semantic role, never a hex value, and a theme turns
 * that role into concrete Excalidraw styling. The palette below is open-color
 * sampled at the same shade indexes Excalidraw's own picker uses, so a themed
 * diagram sits inside the editor's native palette instead of beside it.
 */

import {
  DIAGRAM_EDGE_ARROWS,
  DIAGRAM_EDGE_LINE_STYLES,
  DIAGRAM_EDGE_WEIGHTS,
  DIAGRAM_NODE_EMPHASES,
  DIAGRAM_NODE_ROLES,
  DIAGRAM_THEME_NAMES,
  type DiagramEdgeArrow,
  type DiagramEdgeLineStyle,
  type DiagramEdgeWeight,
  type DiagramNodeEmphasis,
  type DiagramNodeRole,
  type DiagramThemeName,
} from "../shared/diagram-stamp";

export type HueName =
  | "gray"
  | "graphite"
  | "red"
  | "pink"
  | "grape"
  | "violet"
  | "indigo"
  | "blue"
  | "cyan"
  | "teal"
  | "green"
  | "lime"
  | "yellow"
  | "orange";

export type PaletteEntry = {
  /** The element background at normal emphasis. */
  fill: string;
  /** The lighter wash used for quiet emphasis and container tints. */
  soft: string;
  /** Borders and connector lines. */
  stroke: string;
};

/**
 * Which open-color hue and shade indexes each entry was sampled from. The
 * unit test reads open-color out of node_modules and checks every literal
 * above against this provenance, so a mistyped hex cannot survive.
 */
export type PaletteProvenance = { hue: string; fill: number; soft: number; stroke: number };

export const HUES: Record<HueName, PaletteEntry> = {
  gray: { fill: "#e9ecef", soft: "#f8f9fa", stroke: "#495057" },
  graphite: { fill: "#ced4da", soft: "#f1f3f5", stroke: "#212529" },
  red: { fill: "#ffc9c9", soft: "#fff5f5", stroke: "#e03131" },
  pink: { fill: "#fcc2d7", soft: "#fff0f6", stroke: "#c2255c" },
  grape: { fill: "#eebefa", soft: "#f8f0fc", stroke: "#9c36b5" },
  violet: { fill: "#d0bfff", soft: "#f3f0ff", stroke: "#6741d9" },
  indigo: { fill: "#bac8ff", soft: "#edf2ff", stroke: "#3b5bdb" },
  blue: { fill: "#a5d8ff", soft: "#e7f5ff", stroke: "#1971c2" },
  cyan: { fill: "#99e9f2", soft: "#e3fafc", stroke: "#0c8599" },
  teal: { fill: "#96f2d7", soft: "#e6fcf5", stroke: "#099268" },
  green: { fill: "#b2f2bb", soft: "#ebfbee", stroke: "#2f9e44" },
  lime: { fill: "#d8f5a2", soft: "#f4fce3", stroke: "#66a80f" },
  yellow: { fill: "#ffec99", soft: "#fff9db", stroke: "#f08c00" },
  orange: { fill: "#ffd8a8", soft: "#fff4e6", stroke: "#e8590c" },
};

export const HUE_PROVENANCE: Record<HueName, PaletteProvenance> = {
  gray: { hue: "gray", fill: 2, soft: 0, stroke: 7 },
  graphite: { hue: "gray", fill: 4, soft: 1, stroke: 9 },
  red: { hue: "red", fill: 2, soft: 0, stroke: 8 },
  pink: { hue: "pink", fill: 2, soft: 0, stroke: 8 },
  grape: { hue: "grape", fill: 2, soft: 0, stroke: 8 },
  violet: { hue: "violet", fill: 2, soft: 0, stroke: 8 },
  indigo: { hue: "indigo", fill: 2, soft: 0, stroke: 8 },
  blue: { hue: "blue", fill: 2, soft: 0, stroke: 8 },
  cyan: { hue: "cyan", fill: 2, soft: 0, stroke: 8 },
  teal: { hue: "teal", fill: 2, soft: 0, stroke: 8 },
  green: { hue: "green", fill: 2, soft: 0, stroke: 8 },
  lime: { hue: "lime", fill: 2, soft: 0, stroke: 8 },
  yellow: { hue: "yellow", fill: 2, soft: 0, stroke: 8 },
  orange: { hue: "orange", fill: 2, soft: 0, stroke: 8 },
};

export type NodeRole = DiagramNodeRole;

export const NODE_ROLES = DIAGRAM_NODE_ROLES;

/** Unfilled, dark-bordered: the look a diagram has when nothing is themed. */
export const NEUTRAL_ENTRY: PaletteEntry = {
  fill: "transparent",
  soft: "transparent",
  stroke: "#1e1e1e",
};

/**
 * The base role palette, exactly as Excalidraw would offer it. Themes below
 * re-point roles at other hues; these are the constants the palette test
 * pins against open-color.
 */
export const PALETTE: Record<NodeRole, PaletteEntry> = {
  primary: HUES.blue,
  success: HUES.green,
  warning: HUES.yellow,
  danger: HUES.red,
  accent: HUES.violet,
  muted: HUES.gray,
  neutral: NEUTRAL_ENTRY,
};

export type ThemeName = DiagramThemeName;

export const THEME_NAMES = DIAGRAM_THEME_NAMES;

export const DEFAULT_THEME: ThemeName = "slate";

export type DiagramTheme = {
  name: ThemeName;
  /** Role to palette entry, the whole of what a theme decides. */
  entries: Record<NodeRole, PaletteEntry>;
  /** Applied to nodes that name no role. */
  defaultRole: NodeRole;
  /** Connector lines: one neutral ink, so the wiring never competes with a node. */
  edgeColor: string;
  titleColor: string;
  /** Dark and light extremes, used for whichever reads on a given fill. */
  inkColor: string;
  paperColor: string;
};

/**
 * The theme's quiet register: the surface a node takes when the request said
 * it does not matter.
 *
 * It cannot simply be gray. On a warm board a cold gray fill is the one thing
 * on the page that belongs to no family, and a reader has no way to tell
 * whether it means something or was forgotten. Naming a hue per theme and
 * dropping it to the wash keeps "this is background" legible without leaving
 * the palette. Grayscale themes name gray and stay exactly where they were.
 *
 * The border has to come from the same hue as the fill. A pale orange ellipse
 * outlined in gray on a board of orange-outlined boxes is read as an outlier
 * the drawing forgot to finish, which is the exact opposite of "this one is
 * background".
 */
type QuietSpec = { hue: HueName; weight: "fill" | "soft" };

/**
 * The accent is the one hue a theme spends on "look here", so it has to be
 * visibly off the theme's own family. A green board whose accent was teal and
 * whose success was lime handed the reader four adjacent greens and no way to
 * tell which of them was the point. The unit test holds every accent a wide
 * turn of the colour wheel away from its own primary and success.
 */
type ThemeSpec = {
  roles: Record<Exclude<NodeRole, "muted">, HueName | "neutral">;
  quiet: QuietSpec;
  defaultRole: NodeRole;
  title: HueName | "neutral";
};

const THEME_SPECS: Record<ThemeName, ThemeSpec> = {
  // Neutral-forward: unroled nodes stay unfilled and colour is the exception.
  slate: {
    roles: {
      primary: "indigo",
      success: "teal",
      warning: "orange",
      danger: "red",
      accent: "grape",
      neutral: "neutral",
    },
    quiet: { hue: "gray", weight: "fill" },
    defaultRole: "neutral",
    title: "neutral",
  },
  ocean: {
    roles: {
      primary: "blue",
      success: "teal",
      warning: "yellow",
      danger: "red",
      accent: "violet",
      neutral: "neutral",
    },
    quiet: { hue: "blue", weight: "soft" },
    defaultRole: "primary",
    title: "blue",
  },
  /**
   * A green board, but not three greens deep. The primary was green, success
   * was lime, and the quiet register was green's own wash, so an incident
   * board handed a reader a pale green, a green and a yellow-green and no way
   * to tell which difference meant something. Success is the role a green
   * belongs to, so it keeps the hue and the primary steps round to cyan: the
   * blue-green edge of the same family, far enough that the two read as two
   * decisions. The quiet register follows the primary, as every theme's does,
   * which makes the third fill a value step within one hue rather than a
   * fourth colour.
   */
  forest: {
    roles: {
      primary: "cyan",
      success: "green",
      warning: "yellow",
      danger: "red",
      accent: "violet",
      neutral: "neutral",
    },
    quiet: { hue: "cyan", weight: "soft" },
    defaultRole: "primary",
    title: "green",
  },
  sunset: {
    roles: {
      primary: "orange",
      success: "lime",
      warning: "yellow",
      danger: "red",
      accent: "pink",
      neutral: "neutral",
    },
    quiet: { hue: "orange", weight: "soft" },
    defaultRole: "primary",
    title: "orange",
  },
  grape: {
    roles: {
      primary: "grape",
      success: "teal",
      warning: "yellow",
      danger: "pink",
      accent: "indigo",
      neutral: "neutral",
    },
    quiet: { hue: "grape", weight: "soft" },
    defaultRole: "primary",
    title: "grape",
  },
  // Grayscale only: two weights of gray and the unfilled neutral.
  mono: {
    roles: {
      primary: "graphite",
      success: "gray",
      warning: "graphite",
      danger: "graphite",
      accent: "gray",
      neutral: "neutral",
    },
    quiet: { hue: "gray", weight: "fill" },
    defaultRole: "neutral",
    title: "neutral",
  },
};

function entryFor(name: HueName | "neutral"): PaletteEntry {
  return name === "neutral" ? NEUTRAL_ENTRY : HUES[name];
}

function quietEntry(spec: QuietSpec): PaletteEntry {
  const hue = HUES[spec.hue];
  return { fill: hue[spec.weight], soft: hue.soft, stroke: hue.stroke };
}

/**
 * The one ink every connector is drawn in. Wiring is not a role: it has to
 * recede behind whatever it joins, on a warm board and a cold one alike, and
 * gray is the only value that does that everywhere.
 */
const LINE_COLOR = HUES.gray.stroke;

function buildTheme(name: ThemeName): DiagramTheme {
  const spec = THEME_SPECS[name];
  const entries = Object.fromEntries(
    NODE_ROLES.map((role) => [
      role,
      role === "muted" ? quietEntry(spec.quiet) : entryFor(spec.roles[role]),
    ]),
  ) as Record<NodeRole, PaletteEntry>;
  return {
    name,
    entries,
    defaultRole: spec.defaultRole,
    edgeColor: LINE_COLOR,
    titleColor: entryFor(spec.title).stroke,
    inkColor: NEUTRAL_ENTRY.stroke,
    paperColor: "#ffffff",
  };
}

export const THEMES: Record<ThemeName, DiagramTheme> = Object.fromEntries(
  THEME_NAMES.map((name) => [name, buildTheme(name)]),
) as Record<ThemeName, DiagramTheme>;

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

export function isNodeRole(value: unknown): value is NodeRole {
  return typeof value === "string" && (NODE_ROLES as readonly string[]).includes(value);
}

export function resolveTheme(name?: unknown): DiagramTheme {
  return THEMES[isThemeName(name) ? name : DEFAULT_THEME];
}

/** Every colour a theme can legitimately put on the board. */
export function themeColors(theme: DiagramTheme): Set<string> {
  const colors = new Set<string>(["transparent", theme.edgeColor, theme.titleColor, theme.inkColor, theme.paperColor]);
  for (const entry of Object.values(theme.entries)) {
    colors.add(entry.fill);
    colors.add(entry.soft);
    colors.add(entry.stroke);
  }
  return colors;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value.trim());
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. Unparseable or transparent colours read as paper. */
export function relativeLuminance(color: string): number {
  const value = color.trim();
  if (!HEX.test(value)) return 1;
  let hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join("");
  const int = Number.parseInt(hex.slice(0, 6), 16);
  return 0.2126 * channel((int >> 16) & 0xff)
    + 0.7152 * channel((int >> 8) & 0xff)
    + 0.0722 * channel(int & 0xff);
}

export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** CIE L*a*b*, D65, the space every colour distance below is measured in. */
function toLab(color: string): { l: number; a: number; b: number } | null {
  const value = color.trim();
  if (!HEX.test(value)) return null;
  let hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join("");
  const int = Number.parseInt(hex.slice(0, 6), 16);
  const [red, green, blue] = [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff].map(channel);
  const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) / 0.95047;
  const y = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return { l: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/**
 * How much colour a fill carries: its distance from the neutral axis in Lab.
 * Every hue in the palette sits above 20 and every gray below 4, so this
 * cleanly says whether a fill is speaking colour at all.
 */
export function colorChroma(color: string): number {
  const lab = toLab(color);
  return lab === null ? 0 : Math.hypot(lab.a, lab.b);
}

/**
 * CIEDE2000, the standard colour difference (CIE 142-2001). Plain Lab
 * distance is not usable here: it calls two pale washes further apart than
 * two grays a reader separates at a glance, because it takes no account of
 * how much less a chroma difference is worth at high chroma. The correction
 * terms are the whole reason this formula exists rather than Pythagoras.
 */
export function colorDifference(first: string, second: string): number {
  const one = toLab(first);
  const two = toLab(second);
  if (one === null || two === null) return Number.POSITIVE_INFINITY;
  const radians = Math.PI / 180;
  const chroma1 = Math.hypot(one.a, one.b);
  const chroma2 = Math.hypot(two.a, two.b);
  const meanChroma = (chroma1 + chroma2) / 2;
  const boost = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
  const a1 = (1 + boost) * one.a;
  const a2 = (1 + boost) * two.a;
  const c1 = Math.hypot(a1, one.b);
  const c2 = Math.hypot(a2, two.b);
  const h1 = c1 === 0 ? 0 : ((Math.atan2(one.b, a1) / radians) + 360) % 360;
  const h2 = c2 === 0 ? 0 : ((Math.atan2(two.b, a2) / radians) + 360) % 360;
  const deltaL = two.l - one.l;
  const deltaC = c2 - c1;
  const rawHue = c1 * c2 === 0 ? 0
    : Math.abs(h2 - h1) <= 180 ? h2 - h1
      : h2 - h1 > 180 ? h2 - h1 - 360
        : h2 - h1 + 360;
  const deltaH = 2 * Math.sqrt(c1 * c2) * Math.sin((rawHue * radians) / 2);
  const meanL = (one.l + two.l) / 2;
  const meanC = (c1 + c2) / 2;
  const meanH = c1 * c2 === 0 ? h1 + h2
    : Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2
      : h1 + h2 < 360 ? (h1 + h2 + 360) / 2
        : (h1 + h2 - 360) / 2;
  const turn = 1
    - 0.17 * Math.cos((meanH - 30) * radians)
    + 0.24 * Math.cos(2 * meanH * radians)
    + 0.32 * Math.cos((3 * meanH + 6) * radians)
    - 0.20 * Math.cos((4 * meanH - 63) * radians);
  const weightL = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const weightC = 1 + 0.045 * meanC;
  const weightH = 1 + 0.015 * meanC * turn;
  const rotation = -Math.sin(2 * 30 * Math.exp(-(((meanH - 275) / 25) ** 2)) * radians)
    * 2 * Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7));
  return Math.sqrt(
    (deltaL / weightL) ** 2
    + (deltaC / weightC) ** 2
    + (deltaH / weightH) ** 2
    + rotation * (deltaC / weightC) * (deltaH / weightH),
  );
}

/**
 * The label colour that reads on a given fill. Whichever of ink and paper
 * wins is always at least 4.5:1, so a themed label can never be unreadable.
 */
export function readableInk(theme: DiagramTheme, background: string): string {
  const surface = background === "transparent" || !isHexColor(background) ? theme.paperColor : background;
  return contrastRatio(theme.inkColor, surface) >= contrastRatio(theme.paperColor, surface)
    ? theme.inkColor
    : theme.paperColor;
}

export type NodeEmphasis = DiagramNodeEmphasis;

export const NODE_EMPHASES = DIAGRAM_NODE_EMPHASES;

export function isNodeEmphasis(value: unknown): value is NodeEmphasis {
  return typeof value === "string" && (NODE_EMPHASES as readonly string[]).includes(value);
}

export type NodeStyleOverrides = { backgroundColor?: string; strokeColor?: string };

export type ResolvedNodeStyle = {
  backgroundColor: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  fillStyle: "solid";
  labelColor: string;
};

export function resolveNodeStyle(
  theme: DiagramTheme,
  role: NodeRole | undefined,
  emphasis: NodeEmphasis = "normal",
  overrides: NodeStyleOverrides = {},
): ResolvedNodeStyle {
  const entry = theme.entries[role ?? theme.defaultRole];
  // A node that named no role is the page, not the point. Themes whose
  // default role is the primary hue would otherwise paint the whole board in
  // the same fill the request uses to say "this one matters", and nothing
  // would stand out from anything. The wash keeps the theme's family without
  // spending its strongest colour on a node that asked for nothing.
  const wash = emphasis === "quiet" || (role === undefined && emphasis === "normal");
  const themed = wash ? entry.soft : entry.fill;
  const backgroundColor = overrides.backgroundColor ?? themed;
  return {
    backgroundColor,
    strokeColor: overrides.strokeColor ?? entry.stroke,
    strokeWidth: emphasis === "strong" ? 2 : 1,
    opacity: emphasis === "quiet" ? 70 : 100,
    // Hachure on a themed fill reads as scribble, never as a filled box.
    fillStyle: "solid",
    labelColor: readableInk(theme, backgroundColor),
  };
}

/** Containers always take the soft wash, whatever the role's normal fill is. */
export function resolveContainerTint(theme: DiagramTheme, role: NodeRole | undefined): string {
  return theme.entries[role ?? theme.defaultRole].soft;
}

export type EdgeLineStyle = DiagramEdgeLineStyle;
export type EdgeWeight = DiagramEdgeWeight;
export type EdgeArrow = DiagramEdgeArrow;

export const EDGE_LINE_STYLES = DIAGRAM_EDGE_LINE_STYLES;
export const EDGE_WEIGHTS = DIAGRAM_EDGE_WEIGHTS;
export const EDGE_ARROWS = DIAGRAM_EDGE_ARROWS;

export function isEdgeLineStyle(value: unknown): value is EdgeLineStyle {
  return typeof value === "string" && (EDGE_LINE_STYLES as readonly string[]).includes(value);
}

export function isEdgeWeight(value: unknown): value is EdgeWeight {
  return typeof value === "string" && (EDGE_WEIGHTS as readonly string[]).includes(value);
}

export function isEdgeArrow(value: unknown): value is EdgeArrow {
  return typeof value === "string" && (EDGE_ARROWS as readonly string[]).includes(value);
}

export type EdgeStyleInput = {
  style?: EdgeLineStyle;
  weight?: EdgeWeight;
  /** A hex value or one of the node role names. */
  color?: string;
  arrow?: EdgeArrow;
};

export type ResolvedEdgeStyle = {
  strokeColor: string;
  strokeStyle: EdgeLineStyle;
  strokeWidth: number;
  opacity: number;
  startArrowhead: "arrow" | null;
  endArrowhead: "arrow" | null;
  labelColor: string;
};

export function resolveEdgeColor(theme: DiagramTheme, color?: string): string {
  if (isNodeRole(color)) return theme.entries[color].stroke;
  if (isHexColor(color)) return color.trim();
  return theme.edgeColor;
}

export function resolveEdgeStyle(theme: DiagramTheme, edge: EdgeStyleInput = {}): ResolvedEdgeStyle {
  const arrow = edge.arrow ?? "end";
  const weight = edge.weight ?? "normal";
  return {
    strokeColor: resolveEdgeColor(theme, edge.color),
    strokeStyle: edge.style ?? "solid",
    strokeWidth: weight === "strong" ? 2 : 1,
    opacity: weight === "quiet" ? 70 : 100,
    startArrowhead: arrow === "both" ? "arrow" : null,
    endArrowhead: arrow === "none" ? null : "arrow",
    labelColor: theme.inkColor,
  };
}
