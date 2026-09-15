import { describe, expect, test } from "bun:test";
import { renderMermaidSVG } from "../index.ts";
import { parseSwimlane } from "../swimlane/parser.ts";
import { layoutSwimlane } from "../swimlane/layout.ts";
import { THEMES } from "../theme.ts";
import { registerDiagram } from "../diagram-registry.ts";

const basic = `swimlane LR
lane Client
  Request
lane Server
  Validate
  Process
lane Database
  Query
Request -> Validate
Validate -> Query
Query -> Process
`;

const firmware = `swimlane LR
lane Device
  Boot
  Connect
  Apply
lane Server
  Authenticate
  CheckVersion
  Download
Boot -> Connect
Connect -> Authenticate
Authenticate -> CheckVersion
CheckVersion -> Download
Download -> Apply
`;

function laneOrder(svg: string): string[] {
  return [...svg.matchAll(/data-lane-id="([^"]+)"/g)].map((match) => match[1]!);
}

function nodeIds(svg: string): string[] {
  return [...svg.matchAll(/data-node-id="([^"]+)"/g)].map((match) => match[1]!);
}

function parseNodeBoxes(svg: string): { id: string; box: { x: number; y: number; width: number; height: number } }[] {
  const nodes: { id: string; box: { x: number; y: number; width: number; height: number } }[] = [];
  const groups = [...svg.matchAll(/<g data-node-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
  for (const group of groups) {
    const inner = group[2]!;
    const rect = inner.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
    if (rect) {
      nodes.push({
        id: group[1]!,
        box: { x: Number(rect[1]), y: Number(rect[2]), width: Number(rect[3]), height: Number(rect[4]) },
      });
      continue;
    }
    const points = inner.match(/points="([^"]+)"/)?.[1] ?? inner.match(/d="([^"]+)"/)?.[1] ?? "";
    const nums = [...points.matchAll(/(-?\d+(?:\.\d+)?)/g)].map((item) => Number(item[1]));
    if (nums.length < 4) continue;
    const xs = nums.filter((_, index) => index % 2 === 0);
    const ys = nums.filter((_, index) => index % 2 === 1);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    nodes.push({
      id: group[1]!,
      box: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
    });
  }
  return nodes;
}

function parseLaneBoxes(svg: string): { id: string; box: { x: number; y: number; width: number; height: number } }[] {
  return [...svg.matchAll(/<g data-lane-id="([^"]+)"[^>]*><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)].map(
    (match) => ({
      id: match[1]!,
      box: {
        x: Number(match[2]),
        y: Number(match[3]),
        width: Number(match[4]),
        height: Number(match[5]),
      },
    }),
  );
}

function contains(outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

describe("swimlane dedicated DSL", () => {
  test("two lanes", () => {
    const parsed = parseSwimlane(`swimlane LR
lane A
  Start
lane B
  End
Start -> End
`);
    expect(parsed.diagram.lanes.map((lane) => lane.id)).toEqual(["A", "B"]);
    expect(parsed.diagram.nodes).toHaveLength(2);
  });

  test("three lanes keep source order", () => {
    const parsed = parseSwimlane(basic);
    expect(parsed.diagram.lanes.map((lane) => lane.id)).toEqual(["Client", "Server", "Database"]);
    expect(parsed.diagram.lanes.map((lane) => lane.nodeIds)).toEqual([
      ["Request"],
      ["Validate", "Process"],
      ["Query"],
    ]);
  });

  test("LR orientation places lanes left to right", () => {
    const layout = layoutSwimlane(parseSwimlane(basic).diagram);
    const xs = layout.lanes.map((lane) => lane.box.x);
    expect(xs[0]!).toBeLessThan(xs[1]!);
    expect(xs[1]!).toBeLessThan(xs[2]!);
  });

  test("TB orientation places lanes top to bottom", () => {
    const source = basic.replace("swimlane LR", "swimlane TB");
    const layout = layoutSwimlane(parseSwimlane(source).diagram);
    const ys = layout.lanes.map((lane) => lane.box.y);
    expect(ys[0]!).toBeLessThan(ys[1]!);
    expect(ys[1]!).toBeLessThan(ys[2]!);
  });

  test("ELK routes are orthogonal", () => {
    const layout = layoutSwimlane(parseSwimlane(basic).diagram);
    expect(layout.edges.length).toBeGreaterThan(0);
    for (const edge of layout.edges) {
      for (let i = 0; i < edge.points.length - 1; i += 1) {
        const a = edge.points[i]!;
        const b = edge.points[i + 1]!;
        expect(Math.abs(a.x - b.x) < 0.75 || Math.abs(a.y - b.y) < 0.75).toBe(true);
      }
    }
  });

  test("same-lane edge", () => {
    const layout = layoutSwimlane(parseSwimlane(`swimlane LR
lane Server
  Validate
  Process
Validate -> Process
`).diagram);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.points.length).toBeGreaterThanOrEqual(2);
  });

  test("cross-lane edge", () => {
    const layout = layoutSwimlane(parseSwimlane(`swimlane LR
lane Client
  Request
lane Server
  Validate
Request -> Validate
`).diagram);
    expect(layout.edges[0]?.source).toBe("Request");
    expect(layout.edges[0]?.target).toBe("Validate");
    expect(layout.edges[0]?.points.length).toBeGreaterThanOrEqual(2);
  });

  test("edge crossing multiple lanes", () => {
    const layout = layoutSwimlane(parseSwimlane(`swimlane LR
lane Client
  Request
lane Server
  Validate
lane Database
  Query
Request -> Query
`).diagram);
    expect(layout.edges[0]?.points.length).toBeGreaterThanOrEqual(2);
  });

  test("branch and merge", () => {
    const source = `swimlane LR
lane A
  Start
  Left
  Right
  End
Start -> Left
Start -> Right
Left -> End
Right -> End
`;
    const layout = layoutSwimlane(parseSwimlane(source).diagram);
    expect(layout.edges).toHaveLength(4);
    expect(renderMermaidSVG(source)).toContain("data-edge-id");
  });

  test("long labels expand the lane", () => {
    const layout = layoutSwimlane(parseSwimlane(`swimlane LR
lane api "Backend API with a very long header"
  validate "Validate the incoming request payload carefully"
`).diagram);
    expect(layout.lanes[0]!.box.width).toBeGreaterThan(120);
    expect(layout.nodes[0]!.box.width).toBeGreaterThan(72);
  });

  test("empty lane is still drawn", () => {
    const svg = renderMermaidSVG(`swimlane LR
lane A
  Start
lane Empty
lane C
  End
Start -> End
`);
    expect(laneOrder(svg)).toEqual(["A", "Empty", "C"]);
  });

  test("explicit node IDs", () => {
    const parsed = parseSwimlane(`swimlane LR
lane api "Backend API"
  validate "Validate Request"
  process "Process Request"
validate -> process
`);
    expect(parsed.diagram.lanes[0]?.label).toBe("Backend API");
    expect(parsed.diagram.nodes.find((node) => node.id === "validate")?.label).toBe("Validate Request");
  });

  test("edge labels", () => {
    const svg = renderMermaidSVG(`swimlane LR
lane A
  Start
lane B
  End
Start -->|ok| End
`);
    expect(svg).toContain("ok");
  });

  test("dark theme", () => {
    const svg = renderMermaidSVG(basic, { ...THEMES["zinc-dark"], idPrefix: "dark-" });
    expect(svg).toContain("--bg:#18181B");
    expect(svg).toContain("--fg:#FAFAFA");
  });

  test("light theme", () => {
    const svg = renderMermaidSVG(basic, { ...THEMES["zinc-light"], idPrefix: "light-" });
    expect(svg).toContain("--bg:#FFFFFF");
    expect(svg).toContain("--fg:#27272A");
  });

  test("deterministic lane ordering", () => {
    const svg = renderMermaidSVG(firmware);
    expect(laneOrder(svg)).toEqual(["Device", "Server"]);
    const layout = layoutSwimlane(parseSwimlane(firmware).diagram);
    expect(layout.lanes.map((lane) => lane.id)).toEqual(["Device", "Server"]);
    expect(layout.lanes[0]!.box.x).toBeLessThan(layout.lanes[1]!.box.x);
  });

  test("deterministic SVG output", () => {
    const a = renderMermaidSVG(firmware, { idPrefix: "d-" });
    const b = renderMermaidSVG(firmware, { idPrefix: "d-" });
    expect(a).toBe(b);
  });

  test("nodes stay inside their lane", () => {
    const svg = renderMermaidSVG(firmware);
    const lanes = new Map(parseLaneBoxes(svg).map((lane) => [lane.id, lane.box] as const));
    const layout = layoutSwimlane(parseSwimlane(firmware).diagram);
    for (const node of layout.nodes) {
      const lane = lanes.get(node.laneId);
      expect(lane).toBeTruthy();
      expect(contains(lane!, node.box)).toBe(true);
    }
  });

  test("default direction is LR", () => {
    expect(parseSwimlane(`swimlane
lane A
  Start
`).diagram.direction).toBe("LR");
  });

  test("registry detect still selects swimlane", () => {
    const svg = renderMermaidSVG(basic);
    expect(svg).toContain('data-diagram-type="swimlane"');
    expect(nodeIds(svg)).toEqual(["Request", "Validate", "Process", "Query"]);
  });

  test("registerDiagram is part of the public surface", () => {
    expect(typeof registerDiagram).toBe("function");
  });
});

describe("existing diagram types stay on their pipelines", () => {
  test("flowchart is unchanged", () => {
    const svg = renderMermaidSVG("flowchart LR\n  A[Keep] --> B[Existing]");
    expect(svg).toContain('class="node"');
    expect(svg).not.toContain('data-diagram-type="swimlane"');
  });

  test("sequence is unchanged", () => {
    const svg = renderMermaidSVG("sequenceDiagram\n  A->>B: hi");
    expect(svg).not.toContain('data-diagram-type="swimlane"');
    expect(svg).toContain("hi");
  });

  test("class is unchanged", () => {
    const svg = renderMermaidSVG("classDiagram\n  class Foo");
    expect(svg).not.toContain('data-diagram-type="swimlane"');
    expect(svg).toContain("Foo");
  });
});

describe("swimlane SVG snapshot", () => {
  test("firmware example is a stable SVG structure", () => {
    const svg = renderMermaidSVG(firmware, { idPrefix: "snap-" });
    expect(svg).toMatchSnapshot();
    expect(laneOrder(svg)).toEqual(["Device", "Server"]);
    expect(parseNodeBoxes(svg).map((node) => node.id)).toEqual([
      "Boot",
      "Connect",
      "Apply",
      "Authenticate",
      "CheckVersion",
      "Download",
    ]);
  });

  test("firmware TB example is a stable SVG structure", () => {
    const source = firmware.replace("swimlane LR", "swimlane TB");
    const svg = renderMermaidSVG(source, { idPrefix: "snap-tb-" });
    expect(svg).toMatchSnapshot();
    expect(laneOrder(svg)).toEqual(["Device", "Server"]);
  });
});
