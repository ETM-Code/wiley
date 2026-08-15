import type { DiagramPlan, LayoutParams } from "../../src/renderer/diagram-layout";
import type { DiagramElementRole, DiagramThemeName } from "../../src/shared/diagram-stamp";

export type DiagramFixture = {
  name: string;
  params: LayoutParams;
};

export type PlanPart = {
  role: DiagramElementRole;
  key?: string;
  edgeIndex?: number;
  skeleton: Record<string, unknown>;
};

/**
 * Builds a plan directly, bypassing the planner. Negative fixtures need
 * geometry and styling the planner would never produce, so the checks can be
 * proven to fire rather than merely observed not to.
 */
export function handBuiltPlan(
  parts: PlanPart[],
  options: { theme?: DiagramThemeName; explicitColors?: string[]; diagramId?: string } = {},
): DiagramPlan {
  const roles = new Map<string, { role: DiagramElementRole; key?: string; edgeIndex?: number }>();
  const elementIdByNode = new Map<string, string>();
  for (const part of parts) {
    const id = String(part.skeleton.id);
    roles.set(id, {
      role: part.role,
      ...(part.key ? { key: part.key } : {}),
      ...(part.edgeIndex === undefined ? {} : { edgeIndex: part.edgeIndex }),
    });
    if (part.role === "node" && part.key) elementIdByNode.set(part.key, id);
  }
  return {
    skeletons: parts.map((part) => part.skeleton),
    nodeCount: parts.filter((part) => part.role === "node").length,
    edgeCount: parts.filter((part) => part.role === "edge").length,
    edgeLabelCount: parts.filter((part) => part.role === "edgeLabel").length,
    elementIdByNode,
    diagramId: options.diagramId ?? "wd-dirty",
    roles,
    theme: options.theme ?? "slate",
    explicitColors: new Set(options.explicitColors ?? []),
  };
}

function dirtyNode(
  id: string,
  overrides: Record<string, unknown>,
): PlanPart {
  return {
    role: "node",
    key: id,
    skeleton: {
      id: `wd-dirty-n-${id}`,
      type: "rectangle",
      x: 0,
      y: 0,
      width: 160,
      height: 80,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      strokeWidth: 1,
      label: { text: id, strokeColor: "#1e1e1e" },
      ...overrides,
    },
  };
}

/**
 * Explicit colours a caller genuinely asked for, arranged so the label sits
 * on a fill it cannot be read against. Never part of the all-clean sweep.
 */
export const contrastTrapPlan: DiagramPlan = handBuiltPlan([
  dirtyNode("readable", {
    backgroundColor: "#1971c2",
    label: { text: "readable", strokeColor: "#ffffff" },
  }),
  dirtyNode("trap", {
    x: 400,
    backgroundColor: "#1971c2",
    label: { text: "trap", strokeColor: "#495057" },
  }),
], { explicitColors: ["#1971c2"] });

/** A colour that belongs to no theme and was never requested. */
export const strayColorPlan: DiagramPlan = handBuiltPlan([
  dirtyNode("a", { backgroundColor: "#bada55" }),
]);

/** Six nodes wearing five theme fills: a rainbow, not a diagram. */
export const rainbowPlan: DiagramPlan = handBuiltPlan(
  ["#a5d8ff", "#96f2d7", "#ffec99", "#ffc9c9", "#99e9f2", "#a5d8ff"].map((fill, index) => dirtyNode(
    `n${index}`,
    { x: index * 300, backgroundColor: fill },
  )),
  { theme: "ocean" },
);

/** Three stroke weights on nodes reads as three unrelated diagrams. */
export const strokeWidthSoupPlan: DiagramPlan = handBuiltPlan(
  [1, 2, 4].map((strokeWidth, index) => dirtyNode(`n${index}`, { x: index * 300, strokeWidth })),
);

/**
 * The exact architecture diagram the user drew that came out tangled. Its
 * graph is the layout regression; the hand-picked hexes it arrived with are
 * now expressed as roles, which is what the tool asks agents to do.
 */
export const planningDiagram: LayoutParams = {
  theme: "ocean",
  title: "Voice coding architecture",
  nodes: [
    { id: "plan", label: "Planning Model", shape: "rectangle", rounded: true, role: "primary", emphasis: "strong" },
    { id: "tests", label: "Local Coder • Tests", shape: "rectangle", rounded: true, role: "neutral" },
    { id: "backend", label: "Local Coder • Backend", shape: "rectangle", rounded: true, role: "neutral" },
    { id: "frontend", label: "Local Coder • Frontend", shape: "rectangle", rounded: true, role: "neutral" },
    { id: "runtime", label: "Local Runtime / Workspace", shape: "rectangle", rounded: true, role: "muted" },
    { id: "voice", label: "Voice Assistant / Orchestrator", shape: "ellipse", role: "primary" },
  ],
  edges: [
    { from: "plan", to: "tests", label: "tasks" },
    { from: "plan", to: "backend", label: "tasks" },
    { from: "plan", to: "frontend", label: "tasks" },
    { from: "tests", to: "plan", label: "tasks" },
    { from: "backend", to: "runtime", label: "code" },
    { from: "backend", to: "runtime", label: "verify" },
    { from: "runtime", to: "voice", label: "results" },
    { from: "frontend", to: "voice", label: "delegate" },
  ],
};

/** Adversarial graphs every layout change has to survive unchanged. */
export const stressGraphs: DiagramFixture[] = [
  { name: "user planning diagram", params: planningDiagram },
  {
    name: "fan-in of eight labelled edges",
    params: {
      nodes: [
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `source-${index}`,
          label: `Producer ${index + 1}`,
        })),
        { id: "sink", label: "Aggregator", shape: "rectangle" },
      ],
      edges: Array.from({ length: 8 }, (_, index) => ({
        from: `source-${index}`,
        to: "sink",
        label: index % 2 === 0 ? "emit" : "flush",
      })),
    },
  },
  {
    name: "fan-out of eight",
    params: {
      nodes: [
        { id: "hub", label: "Dispatcher", shape: "diamond" },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `worker-${index}`,
          label: `Worker ${index + 1}`,
        })),
      ],
      edges: Array.from({ length: 8 }, (_, index) => ({
        from: "hub",
        to: `worker-${index}`,
        label: "job",
      })),
    },
  },
  {
    name: "twelve-node chain",
    params: {
      layout: { direction: "DOWN" },
      nodes: Array.from({ length: 12 }, (_, index) => ({
        id: `step-${index}`,
        label: `Step ${index + 1}`,
      })),
      edges: Array.from({ length: 11 }, (_, index) => ({
        from: `step-${index}`,
        to: `step-${index + 1}`,
        label: index % 3 === 0 ? "then" : undefined,
      })),
    },
  },
  {
    name: "dense bipartite mesh",
    params: {
      nodes: [
        ...Array.from({ length: 4 }, (_, index) => ({ id: `left-${index}`, label: `Service ${index + 1}` })),
        ...Array.from({ length: 4 }, (_, index) => ({ id: `right-${index}`, label: `Queue ${index + 1}` })),
      ],
      edges: Array.from({ length: 16 }, (_, index) => ({
        from: `left-${Math.floor(index / 4)}`,
        to: `right-${index % 4}`,
      })),
    },
  },
  {
    name: "long labels across shapes",
    params: {
      nodes: [
        { id: "a", label: "Authentication and session management gateway", shape: "rectangle" },
        { id: "b", label: "Is the refresh token still within its validity window?", shape: "diamond" },
        { id: "c", label: "Long-running background reconciliation loop", shape: "ellipse" },
        { id: "d", label: "OK", shape: "rectangle" },
      ],
      edges: [
        { from: "a", to: "b", label: "validate" },
        { from: "b", to: "c", label: "expired so re-enroll" },
        { from: "b", to: "d", label: "still valid" },
        { from: "c", to: "a", label: "retry" },
      ],
    },
  },
  {
    name: "decision tree with yes/no labels",
    params: {
      layout: { direction: "DOWN" },
      nodes: [
        { id: "start", label: "Request", shape: "ellipse" },
        { id: "auth", label: "Authenticated?", shape: "diamond" },
        { id: "quota", label: "Quota left?", shape: "diamond" },
        { id: "serve", label: "Serve", shape: "rectangle" },
        { id: "deny", label: "Deny", shape: "rectangle" },
        { id: "bill", label: "Bill account", shape: "rectangle" },
      ],
      edges: [
        { from: "start", to: "auth" },
        { from: "auth", to: "quota", label: "yes" },
        { from: "auth", to: "deny", label: "no" },
        { from: "quota", to: "serve", label: "yes" },
        { from: "quota", to: "deny", label: "no" },
        { from: "serve", to: "bill" },
      ],
    },
  },
  {
    name: "top-to-bottom fan-in (ports spread across node width)",
    params: {
      title: "Task and Verification Loop",
      layout: { direction: "DOWN" },
      nodes: [
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `source-${index}`,
          label: `Stage ${index + 1}`,
        })),
        { id: "ledger", label: "SQLite Runtime Ledger jobs, events, board" },
        { id: "verify", label: "Verify local tests", shape: "diamond" },
      ],
      edges: [
        ...Array.from({ length: 6 }, (_, index) => ({
          from: `source-${index}`,
          to: "ledger",
          label: index % 2 === 0 ? "events" : undefined,
        })),
        { from: "ledger", to: "verify", label: "edit + test" },
        { from: "verify", to: "ledger", label: "pass" },
      ],
    },
  },
  {
    name: "text-only captions alongside boxes",
    params: {
      title: "Request lifecycle",
      layout: { direction: "DOWN" },
      nodes: [
        { id: "note", label: "Every step is idempotent", shape: "text" },
        { id: "accept", label: "Accept", shape: "rectangle" },
        { id: "queue", label: "Queue", shape: "rectangle" },
        { id: "caption", label: "Retries land back here after a bounded backoff window", shape: "text" },
        { id: "done", label: "Complete", shape: "ellipse" },
      ],
      edges: [
        { from: "note", to: "accept" },
        { from: "accept", to: "queue", label: "enqueue" },
        { from: "queue", to: "caption" },
        { from: "caption", to: "done", label: "drain" },
      ],
    },
  },
  {
    name: "emoji labels on nodes and edges",
    params: {
      title: "🚀 Release train",
      nodes: [
        { id: "build", label: "🔨 Build" },
        { id: "review", label: "🔍 Review changes" },
        { id: "ship", label: "🚀 Ship it 🎉", shape: "ellipse" },
        { id: "rollback", label: "⛔️ Rollback", shape: "diamond" },
      ],
      edges: [
        { from: "build", to: "review", label: "✅ green" },
        { from: "review", to: "ship", label: "approved" },
        { from: "ship", to: "rollback", label: "🔥 alarm" },
        { from: "rollback", to: "build" },
      ],
    },
  },
  {
    name: "cycle with parallel edges",
    params: {
      nodes: [
        { id: "a", label: "Editor" },
        { id: "b", label: "Compiler" },
        { id: "c", label: "Runner" },
      ],
      edges: [
        { from: "a", to: "b", label: "source" },
        { from: "b", to: "c", label: "binary" },
        { from: "c", to: "a", label: "feedback" },
        { from: "a", to: "b", label: "config" },
      ],
    },
  },
];
