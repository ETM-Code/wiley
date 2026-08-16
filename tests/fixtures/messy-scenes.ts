/**
 * Sketches the way people actually draw them.
 *
 * Every scene here is raw Excalidraw element data with no stamp anywhere in
 * it: jittered boxes that nearly line up, arrows that stop a few pixels short
 * of the shape they mean, captions floating beside the thing they name, a
 * scribble nobody can read. The inference, the obstacle checks, and tidy mode
 * are all judged against these rather than against tidy synthetic input,
 * because a sketch is only worth handling if it is handled while it is a mess.
 */

export type MessyElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  containerId?: string;
  points?: Array<[number, number]>;
  startBinding?: { elementId: string };
  endBinding?: { elementId: string };
  strokeColor?: string;
  strokeStyle?: string;
  strokeWidth?: number;
  backgroundColor?: string;
  boundElements?: Array<{ id: string; type: string }>;
  version: number;
  customData?: unknown;
};

export type MessyScene = {
  name: string;
  /** What a correct reading of this sketch looks like. */
  expect: {
    nodes: number;
    edges: number;
    /** Edges missing at least one endpoint. */
    loose: number;
    unattached: number;
    /** Attachments the reading has to get right, as from -> to element ids. */
    attachments?: Array<[string, string]>;
    /** Labels the reading has to find, by the element wearing them. */
    labels?: Array<[string, string]>;
  };
  elements: MessyElement[];
};

let sequence = 0;

function box(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<MessyElement> = {},
): MessyElement {
  return { id, type: "rectangle", x, y, width, height, version: ++sequence, ...extra };
}

function label(id: string, containerId: string, shape: MessyElement, text: string): MessyElement {
  const width = Math.max(24, text.length * 9);
  return {
    id,
    type: "text",
    x: shape.x + (shape.width - width) / 2,
    y: shape.y + (shape.height - 22) / 2,
    width,
    height: 22,
    text,
    containerId,
    version: ++sequence,
  };
}

function note(id: string, x: number, y: number, text: string): MessyElement {
  return {
    id,
    type: "text",
    x,
    y,
    width: Math.max(24, text.length * 9),
    height: 20,
    text,
    version: ++sequence,
  };
}

function line(
  id: string,
  from: [number, number],
  to: [number, number],
  extra: Partial<MessyElement> = {},
): MessyElement {
  return {
    id,
    type: "arrow",
    x: from[0],
    y: from[1],
    width: Math.abs(to[0] - from[0]),
    height: Math.abs(to[1] - from[1]),
    points: [[0, 0], [to[0] - from[0], to[1] - from[1]]],
    version: ++sequence,
    ...extra,
  };
}

function scribble(id: string, x: number, y: number): MessyElement {
  return { id, type: "freedraw", x, y, width: 84, height: 41, version: ++sequence };
}

/** A shape with its bound caption, which is how most people label a box. */
function labelled(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  extra: Partial<MessyElement> = {},
): MessyElement[] {
  const shape = box(id, x, y, width, height, extra);
  return [shape, label(`${id}-t`, id, shape, text)];
}

function crookedSignup(): MessyScene {
  const shapes = [
    ...labelled("s-landing", 13, 7, 118, 57, "Landing"),
    ...labelled("s-signup", 251, 19, 122, 63, "Sign up"),
    ...labelled("s-verify", 249, 187, 126, 58, "Verify"),
    ...labelled("s-home", 11, 201, 120, 60, "Home"),
  ];
  return {
    name: "crooked-signup",
    expect: {
      nodes: 4,
      edges: 3,
      loose: 0,
      unattached: 1,
      attachments: [
        ["s-landing", "s-signup"],
        ["s-signup", "s-verify"],
        ["s-verify", "s-home"],
      ],
      labels: [["s-landing", "Landing"], ["s-home", "Home"]],
    },
    elements: [
      ...shapes,
      // Every one of these stops short of the box it means.
      line("a-1", [133, 37], [247, 49]),
      line("a-2", [310, 84], [312, 185]),
      line("a-3", [247, 216], [134, 229]),
      scribble("doodle", 420, 300),
    ],
  };
}

function boundFlow(): MessyScene {
  const shapes = [
    ...labelled("b-one", 40, 40, 140, 60, "Fetch"),
    ...labelled("b-two", 320, 40, 140, 60, "Parse"),
    ...labelled("b-three", 600, 40, 140, 60, "Store"),
  ];
  return {
    name: "bound-flow",
    expect: {
      nodes: 3,
      edges: 2,
      loose: 0,
      unattached: 0,
      attachments: [["b-one", "b-two"], ["b-two", "b-three"]],
    },
    elements: [
      ...shapes,
      line("b-a", [180, 70], [320, 70], {
        startBinding: { elementId: "b-one" },
        endBinding: { elementId: "b-two" },
      }),
      line("b-b", [460, 70], [600, 70], {
        startBinding: { elementId: "b-two" },
        endBinding: { elementId: "b-three" },
      }),
    ],
  };
}

function floatingLabels(): MessyScene {
  return {
    name: "floating-labels",
    expect: {
      nodes: 3,
      edges: 2,
      loose: 0,
      unattached: 0,
      labels: [["f-a", "Queue"], ["f-b", "Worker"], ["f-c", "Sink"]],
    },
    elements: [
      box("f-a", 20, 20, 130, 60),
      note("f-a-note", 45, 40, "Queue"),
      box("f-b", 300, 24, 130, 60),
      note("f-b-note", 322, 44, "Worker"),
      box("f-c", 580, 18, 130, 60),
      note("f-c-note", 612, 38, "Sink"),
      line("f-1", [150, 50], [300, 54]),
      note("f-1-note", 205, 44, "push"),
      line("f-2", [430, 54], [580, 48]),
      note("f-2-note", 487, 41, "drain"),
    ],
  };
}

function overlappingBoxes(): MessyScene {
  return {
    name: "overlapping-boxes",
    expect: { nodes: 4, edges: 1, loose: 0, unattached: 0 },
    elements: [
      ...labelled("o-a", 100, 100, 200, 120, "Outer"),
      ...labelled("o-b", 260, 160, 200, 120, "Middle"),
      ...labelled("o-c", 420, 220, 200, 120, "Inner"),
      ...labelled("o-d", 700, 100, 160, 80, "Apart"),
      line("o-1", [620, 280], [700, 180]),
    ],
  };
}

function halfConnectedFlow(): MessyScene {
  return {
    name: "half-connected-flow",
    expect: { nodes: 3, edges: 3, loose: 2, unattached: 1 },
    elements: [
      ...labelled("h-a", 30, 30, 140, 70, "Draft"),
      ...labelled("h-b", 400, 36, 140, 70, "Review"),
      ...labelled("h-c", 780, 30, 140, 70, "Ship"),
      line("h-1", [170, 65], [400, 70]),
      // Leaves Review and reaches nothing at all.
      line("h-2", [540, 70], [640, 240]),
      // Starts nowhere and arrives at Ship.
      line("h-3", [640, 300], [780, 70]),
      note("h-aside", 300, 400, "ask about rollback"),
    ],
  };
}

function denseCluster(): MessyScene {
  const elements: MessyElement[] = [];
  for (let index = 0; index < 6; index++) {
    const column = index % 3;
    const row = Math.floor(index / 3);
    elements.push(...labelled(
      `d-${index}`,
      60 + column * 210 + (index % 2 === 0 ? 7 : -5),
      60 + row * 150 + (column === 1 ? 11 : -3),
      160 + (index % 3) * 8,
      70,
      `Step ${index + 1}`,
    ));
  }
  for (let index = 0; index < 5; index++) {
    const from = elements.find((element) => element.id === `d-${index}`)!;
    const to = elements.find((element) => element.id === `d-${index + 1}`)!;
    elements.push(line(
      `d-a-${index}`,
      [from.x + from.width + 3, from.y + from.height / 2],
      [to.x - 4, to.y + to.height / 2],
    ));
  }
  return {
    name: "dense-cluster",
    expect: { nodes: 6, edges: 5, loose: 0, unattached: 0 },
    elements,
  };
}

function mixedStrokes(): MessyScene {
  return {
    name: "mixed-strokes",
    expect: { nodes: 4, edges: 3, loose: 0, unattached: 1 },
    elements: [
      ...labelled("m-a", 25, 30, 150, 70, "Client", {
        strokeColor: "#e03131", strokeWidth: 2, backgroundColor: "#ffc9c9",
      }),
      ...labelled("m-b", 330, 45, 150, 70, "Edge", {
        strokeColor: "#1971c2", strokeStyle: "dashed", backgroundColor: "transparent",
      }),
      ...labelled("m-c", 640, 25, 150, 70, "Origin", {
        strokeColor: "#2f9e44", strokeWidth: 4, backgroundColor: "#b2f2bb",
      }),
      ...labelled("m-d", 335, 260, 150, 70, "Cache", { strokeColor: "#f08c00" }),
      line("m-1", [175, 65], [330, 80], { strokeStyle: "dotted" }),
      line("m-2", [480, 80], [640, 60], { strokeWidth: 3 }),
      line("m-3", [405, 115], [408, 258]),
      scribble("m-doodle", 850, 300),
    ],
  };
}

function shapeMix(): MessyScene {
  return {
    name: "shape-mix",
    expect: { nodes: 4, edges: 3, loose: 0, unattached: 0 },
    elements: [
      ...labelled("x-start", 20, 120, 140, 70, "Start", {}),
      { ...box("x-check", 260, 100, 170, 110, {}), type: "diamond" },
      label("x-check-t", "x-check", box("x-check", 260, 100, 170, 110), "OK?"),
      { ...box("x-yes", 540, 30, 140, 70, {}), type: "ellipse" },
      label("x-yes-t", "x-yes", box("x-yes", 540, 30, 140, 70), "Accept"),
      { ...box("x-no", 540, 220, 140, 70, {}), type: "ellipse" },
      label("x-no-t", "x-no", box("x-no", 540, 220, 140, 70), "Reject"),
      line("x-1", [162, 155], [258, 155]),
      line("x-2", [432, 130], [538, 68]),
      line("x-3", [432, 182], [538, 252]),
    ],
  };
}

function nearMissEndpoints(): MessyScene {
  return {
    name: "near-miss-endpoints",
    expect: {
      nodes: 3,
      edges: 3,
      loose: 1,
      unattached: 0,
      attachments: [["n-a", "n-b"], ["n-b", "n-c"]],
    },
    elements: [
      ...labelled("n-a", 40, 40, 160, 80, "One"),
      ...labelled("n-b", 400, 44, 160, 80, "Two"),
      ...labelled("n-c", 760, 40, 160, 80, "Three"),
      // 14px short at one end, 12px short at the other: still obviously meant.
      line("n-1", [214, 80], [386, 84]),
      line("n-2", [574, 84], [746, 80]),
      // Halfway between Two and Three and nowhere near either.
      line("n-3", [640, 300], [700, 360]),
    ],
  };
}

function groupedCluster(): MessyScene {
  return {
    name: "grouped-cluster",
    expect: {
      nodes: 5,
      edges: 3,
      loose: 0,
      unattached: 0,
      attachments: [["g-a", "g-b"], ["g-b", "g-c"]],
      labels: [["g-ring", "Ingest"]],
    },
    elements: [
      // The ring somebody drew around the three steps, captioned at the top.
      box("g-ring", 40, 40, 640, 240),
      note("g-ring-note", 52, 48, "Ingest"),
      ...labelled("g-a", 80, 120, 150, 70, "Read"),
      ...labelled("g-b", 290, 128, 150, 70, "Clean"),
      ...labelled("g-c", 500, 116, 150, 70, "Write"),
      ...labelled("g-out", 300, 420, 150, 70, "Report"),
      line("g-1", [232, 155], [286, 163]),
      line("g-2", [442, 163], [496, 151]),
      // Drawn from the ring itself out to the box below it: an arrow onto
      // something that is framing rather than a step.
      line("g-3", [360, 282], [372, 418]),
    ],
  };
}

function tidyControl(): MessyScene {
  return {
    name: "already-tidy",
    expect: {
      nodes: 3,
      edges: 2,
      loose: 0,
      unattached: 0,
      attachments: [["t-a", "t-b"], ["t-b", "t-c"]],
    },
    elements: [
      ...labelled("t-a", 0, 0, 160, 80, "A"),
      ...labelled("t-b", 320, 0, 160, 80, "B"),
      ...labelled("t-c", 640, 0, 160, 80, "C"),
      line("t-1", [160, 40], [320, 40], {
        startBinding: { elementId: "t-a" },
        endBinding: { elementId: "t-b" },
      }),
      line("t-2", [480, 40], [640, 40], {
        startBinding: { elementId: "t-b" },
        endBinding: { elementId: "t-c" },
      }),
    ],
  };
}

const BUILDERS = [
  crookedSignup,
  boundFlow,
  floatingLabels,
  overlappingBoxes,
  halfConnectedFlow,
  denseCluster,
  mixedStrokes,
  shapeMix,
  nearMissEndpoints,
  groupedCluster,
  tidyControl,
];

/** A fresh copy every time, so a test that mutates a scene cannot poison another. */
export function messyScenes(): MessyScene[] {
  sequence = 0;
  return BUILDERS.map((build) => build());
}

export function messyScene(name: string): MessyScene {
  const scene = messyScenes().find((candidate) => candidate.name === name);
  if (!scene) throw new Error(`No messy scene called ${name}`);
  return scene;
}
