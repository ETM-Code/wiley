import type { LayoutParams } from "../../src/renderer/diagram-layout";

export type DiagramFixture = {
  name: string;
  params: LayoutParams;
};

/** The exact architecture diagram the user drew that came out tangled. */
export const planningDiagram: LayoutParams = {
  title: "Voice coding architecture",
  nodes: [
    { id: "plan", label: "Planning Model", shape: "rectangle", rounded: true, backgroundColor: "#d1f7c4" },
    { id: "tests", label: "Local Coder • Tests", shape: "rectangle", rounded: true, backgroundColor: "#ffe8cc" },
    { id: "backend", label: "Local Coder • Backend", shape: "rectangle", rounded: true, backgroundColor: "#ffe8cc" },
    { id: "frontend", label: "Local Coder • Frontend", shape: "rectangle", rounded: true, backgroundColor: "#ffe8cc" },
    { id: "runtime", label: "Local Runtime / Workspace", shape: "rectangle", rounded: true, backgroundColor: "#efe2fd" },
    { id: "voice", label: "Voice Assistant / Orchestrator", shape: "ellipse", backgroundColor: "#d6e6ff" },
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
