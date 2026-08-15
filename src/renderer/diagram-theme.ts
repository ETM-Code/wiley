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
  /** Connector lines, from the theme's own muted stroke. */
  edgeColor: string;
  titleColor: string;
  /** Dark and light extremes, used for whichever reads on a given fill. */
  inkColor: string;
  paperColor: string;
};

type ThemeSpec = {
  roles: Record<NodeRole, HueName | "neutral">;
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
      muted: "gray",
      neutral: "neutral",
    },
    defaultRole: "neutral",
    title: "neutral",
  },
  ocean: {
    roles: {
      primary: "blue",
      success: "teal",
      warning: "yellow",
      danger: "red",
      accent: "cyan",
      muted: "gray",
      neutral: "neutral",
    },
    defaultRole: "primary",
    title: "blue",
  },
  forest: {
    roles: {
      primary: "green",
      success: "lime",
      warning: "yellow",
      danger: "red",
      accent: "teal",
      muted: "gray",
      neutral: "neutral",
    },
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
      muted: "gray",
      neutral: "neutral",
    },
    defaultRole: "primary",
    title: "orange",
  },
  grape: {
    roles: {
      primary: "grape",
      success: "teal",
      warning: "yellow",
      danger: "pink",
      accent: "violet",
      muted: "gray",
      neutral: "neutral",
    },
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
      muted: "gray",
      neutral: "neutral",
    },
    defaultRole: "neutral",
    title: "neutral",
  },
};

function entryFor(name: HueName | "neutral"): PaletteEntry {
  return name === "neutral" ? NEUTRAL_ENTRY : HUES[name];
}

function buildTheme(name: ThemeName): DiagramTheme {
  const spec = THEME_SPECS[name];
  const entries = Object.fromEntries(
    NODE_ROLES.map((role) => [role, entryFor(spec.roles[role])]),
  ) as Record<NodeRole, PaletteEntry>;
  return {
    name,
    entries,
    defaultRole: spec.defaultRole,
    edgeColor: entries.muted.stroke,
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
  const themed = emphasis === "quiet" ? entry.soft : entry.fill;
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
