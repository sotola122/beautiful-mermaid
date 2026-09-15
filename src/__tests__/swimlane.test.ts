import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMermaidASCII, renderMermaidSVG, renderMermaidSVGAsync } from "../index.ts";
import { DiagramRenderError } from "../errors.ts";
import { parseSwimlane } from "../swimlane/parser.ts";
import { layoutSwimlane } from "../swimlane/layout.ts";
import {
  findOrthogonalPath,
  SWL_E_ROUTING,
} from "../swimlane/routing.ts";

const directions = ["TB", "TD", "BT", "LR", "RL"] as const;

function sample(direction: string): string {
  return `%% comment
swimlane-beta ${direction}
subgraph laneA [Lane A]
  A[Start] -->|go| B{Decision}
  B --> C((Done))
end
subgraph laneB [Lane B]
  D[Work]
end
A --> D
D --> C
`;
}

function richGraph(direction = "TB"): string {
  return `swimlane-beta ${direction}
accTitle: routing fixture
accDescr: branch merge feedback loop
subgraph operator [作業者]
  start([開始]) --> ask{確認?}
  ask -->|いいえ| start
  done([完了])
end
subgraph web [Web]
  read[読込] --> check{OK?}
  check -->|retry| read
end
subgraph device [端末]
  write[保存] --> write
end
start --> read
check -->|はい| write
write --> done
ask -->|はい| read
read --> read
`;
}

function parsePathPoints(svg: string): { id: string; points: { x: number; y: number }[] }[] {
  const edges: { id: string; points: { x: number; y: number }[] }[] = [];
  const re = /<path data-edge-id="([^"]+)" d="([^"]+)"/g;
  for (const match of svg.matchAll(re)) {
    const points = [...match[2]!.matchAll(/[ML]\s*([-\d.]+)\s+([-\d.]+)/g)].map((item) => ({
      x: Number(item[1]),
      y: Number(item[2]),
    }));
    edges.push({ id: match[1]!, points });
  }
  return edges;
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
    const circle = inner.match(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/);
    if (circle) {
      const cx = Number(circle[1]);
      const cy = Number(circle[2]);
      const r = Number(circle[3]);
      nodes.push({ id: group[1]!, box: { x: cx - r, y: cy - r, width: r * 2, height: r * 2 } });
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

describe("swimlane-beta", () => {
  test("LR lanes sit along x with a header on each lane top", () => {
    const layout = layoutSwimlane(parseSwimlane(sample("LR")).diagram);
    expect(layout.direction).toBe("LR");
    const xs = layout.lanes.map((lane) => lane.box.x);
    expect(xs[0]!).toBeLessThan(xs[1]!);
    for (const lane of layout.lanes) {
      expect(lane.headerBox.y).toBe(lane.box.y);
      expect(lane.headerBox.x).toBe(lane.box.x);
      expect(lane.headerBox.width).toBeCloseTo(lane.box.width, 5);
      expect(lane.headerBox.height).toBeGreaterThan(0);
      expect(lane.headerBox.height).toBeLessThan(lane.box.height);
    }
  });

  test("TB lanes sit along y with a full-width header on each row", () => {
    const layout = layoutSwimlane(parseSwimlane(sample("TB")).diagram);
    expect(layout.direction).toBe("TB");
    const ys = layout.lanes.map((lane) => lane.box.y);
    expect(ys[0]!).toBeLessThan(ys[1]!);
    const maxWidth = Math.max(...layout.lanes.map((lane) => lane.box.width));
    for (const lane of layout.lanes) {
      expect(lane.headerBox.y).toBe(lane.box.y);
      expect(lane.headerBox.x).toBe(lane.box.x);
      expect(lane.headerBox.width).toBeCloseTo(lane.box.width, 5);
      expect(lane.headerBox.width).toBeGreaterThan(maxWidth * 0.8);
      expect(lane.headerBox.height).toBeGreaterThan(0);
    }
  });

  test("parser keeps Japanese labels and chain edge labels", () => {
    const parsed = parseSwimlane(`swimlane-beta TB
subgraph process [処理レーン]
  A[開始] -->|進む| B[次] --> C[終了]
end
`);
    expect(parsed.diagram.lanes[0]?.label).toBe("処理レーン");
    expect(parsed.diagram.edges[0]?.label).toBe("進む");
    expect(parsed.diagram.edges[1]?.source).toBe("B");
    expect(parsed.diagram.nodes.find((node) => node.id === "A")?.label).toBe("開始");
    expect(parsed.diagram.nodes.find((node) => node.id === "B")?.label).toBe("次");
    expect(parsed.diagram.nodes.find((node) => node.id === "C")?.label).toBe("終了");
  });

  test("keeps stadium display labels from chain edges", () => {
    const parsed = parseSwimlane(`swimlane-beta TB
subgraph operator [作業者]
  start([開始]) --> done([完了])
end
`);
    expect(parsed.diagram.nodes.find((node) => node.id === "start")?.label).toBe("開始");
    expect(parsed.diagram.nodes.find((node) => node.id === "done")?.label).toBe("完了");
    expect(parsed.diagram.nodes.find((node) => node.id === "start")?.shape).toBe("stadium");
    const svg = renderMermaidSVG(`swimlane-beta TB
subgraph operator [作業者]
  start([開始]) --> done([完了])
end
`);
    expect(svg).toContain("開始");
    expect(svg).toContain("完了");
  });

  for (const direction of directions) {
    test(`renders ${direction} from root API`, () => {
      const svg = renderMermaidSVG(sample(direction), { idPrefix: `sw-${direction}-` });
      expect(svg).toContain('data-diagram-type="swimlane"');
      expect(svg).toContain("data-lane-id");
      expect(svg).toContain("data-node-id");
      expect(svg).toContain("data-edge-id");
    });
  }

  test("layout reports reroutedEdges stats", () => {
    const parsed = parseSwimlane(richGraph("TB"));
    const layout = layoutSwimlane(parsed.diagram);
    expect(layout.reroutedEdges).toBeGreaterThanOrEqual(0);
    expect(layout.edges.length).toBe(parsed.diagram.edges.length);
  });

  test("open channel reaches the goal without shortening", () => {
    const path = findOrthogonalPath(
      { x: 10, y: 50 },
      { x: 90, y: 50 },
      [],
      [10, 90],
      [50],
    );
    expect(path?.[0]).toEqual({ x: 10, y: 50 });
    expect(path?.at(-1)).toEqual({ x: 90, y: 50 });
  });

  test("orthogonal routes miss other node boxes", () => {
    const source = richGraph("TB");
    const parsed = parseSwimlane(source);
    const layout = layoutSwimlane(parsed.diagram);
    const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
    for (const edge of layout.edges) {
      const ignore = new Set([edge.source, edge.target]);
      const obstacles = layout.nodes
        .filter((node) => !ignore.has(node.id))
        .map((node) => node.box);
      const inside = (
        box: { x: number; y: number; width: number; height: number },
        point: { x: number; y: number },
      ) =>
        point.x > box.x + 2 &&
        point.x < box.x + box.width - 2 &&
        point.y > box.y + 2 &&
        point.y < box.y + box.height - 2;
      for (let i = 0; i < edge.points.length - 1; i += 1) {
        const a = edge.points[i]!;
        const b = edge.points[i + 1]!;
        for (const t of [0.25, 0.5, 0.75]) {
          const sample = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          expect(obstacles.some((box) => inside(box, sample))).toBe(false);
        }
      }
      const start = byId.get(edge.source)!;
      const end = byId.get(edge.target)!;
      expect(Math.hypot(edge.points[0]!.x - (start.box.x + start.box.width / 2), edge.points[0]!.y - (start.box.y + start.box.height / 2))).toBeLessThan(Math.max(start.box.width, start.box.height));
      const last = edge.points[edge.points.length - 1]!;
      expect(Math.hypot(last.x - (end.box.x + end.box.width / 2), last.y - (end.box.y + end.box.height / 2))).toBeLessThan(Math.max(end.box.width, end.box.height) + 12);
    }
  });

  test("same input yields the same route", () => {
    const a = renderMermaidSVG(richGraph("LR"), { idPrefix: "a-" });
    const b = renderMermaidSVG(richGraph("LR"), { idPrefix: "b-" });
    expect(parsePathPoints(a).map((edge) => edge.points)).toEqual(
      parsePathPoints(b).map((edge) => edge.points),
    );
    expect(parseNodeBoxes(a).map((node) => node.box)).toEqual(
      parseNodeBoxes(b).map((node) => node.box),
    );
  });

  test("blocked channel graph returns no path", () => {
    const wall = { x: 40, y: 0, width: 20, height: 100 };
    const path = findOrthogonalPath(
      { x: 10, y: 50 },
      { x: 90, y: 50 },
      [wall],
      [10, 90],
      [50],
    );
    expect(path).toBeNull();
  });

  test("SWL_E_ROUTING is a documented diagnostic code", () => {
    expect(SWL_E_ROUTING).toBe("SWL_E_ROUTING");
    const error = new DiagramRenderError("blocked", [
      { code: SWL_E_ROUTING, severity: "error", message: "blocked" },
    ]);
    expect(error.diagnostics[0]?.code).toBe(SWL_E_ROUTING);
  });

  test("async alias uses the same pipeline", async () => {
    const sync = renderMermaidSVG(sample("TB"));
    const asyncSvg = await renderMermaidSVGAsync(sample("TB"));
    expect(asyncSvg).toBe(sync);
  });

  test("ASCII is explicitly unsupported", () => {
    expect(() => renderMermaidASCII(sample("TB"))).toThrow(DiagramRenderError);
  });

  test("does not fall back packet DSL to flowchart ASCII", () => {
    expect(() => renderMermaidASCII("# Title\ncols: 1\nB1: X\n")).toThrow(
      DiagramRenderError,
    );
  });
});

function generateSwimlane(laneCount: number, nodesPerLane: number, targetEdges: number): string {
  const lines = ["swimlane-beta TB"];
  for (let lane = 0; lane < laneCount; lane += 1) {
    lines.push(`subgraph L${lane} [Lane ${lane}]`);
    for (let node = 0; node < nodesPerLane; node += 1) {
      lines.push(`  N${lane}_${node}[N${lane}_${node}]`);
      if (node > 0) lines.push(`  N${lane}_${node - 1} --> N${lane}_${node}`);
    }
    lines.push("end");
  }
  let edges = laneCount * Math.max(0, nodesPerLane - 1);
  const connect = (from: string, to: string) => {
    if (edges >= targetEdges) return;
    lines.push(`${from} --> ${to}`);
    edges += 1;
  };
  for (let skip = 2; skip < nodesPerLane; skip += 1) {
    for (let lane = 0; lane < laneCount; lane += 1) {
      for (let node = 0; node + skip < nodesPerLane; node += 1) {
        connect(`N${lane}_${node}`, `N${lane}_${node + skip}`);
      }
    }
  }
  for (let delta = 1; delta < laneCount; delta += 1) {
    for (let lane = 0; lane + delta < laneCount; lane += 1) {
      for (let node = 0; node < nodesPerLane; node += 1) {
        connect(`N${lane}_${node}`, `N${lane + delta}_${node}`);
      }
    }
  }
  return lines.join("\n");
}

describe("swimlane routing performance", () => {
  test("records 10x200x400 and stress 20x500x1000", () => {
    const cases = [
      { name: "10lane-200node-400edge", lanes: 10, nodes: 20, edges: 400 },
      { name: "stress-20lane-500node-1000edge", lanes: 20, nodes: 25, edges: 1000 },
    ] as const;
    const results = [];
    for (const item of cases) {
      const source = generateSwimlane(item.lanes, item.nodes, item.edges);
      const parsed = parseSwimlane(source);
      expect(parsed.diagram.nodes.length).toBe(item.lanes * item.nodes);
      expect(parsed.diagram.edges.length).toBeGreaterThanOrEqual(item.edges);
      const before = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const svg = renderMermaidSVG(source, { idPrefix: `${item.name}-` });
      const warm0 = performance.now();
      renderMermaidSVG(source, { idPrefix: `${item.name}-w-` });
      const warmMs = performance.now() - warm0;
      const coldMs = warm0 - t0;
      const heapDelta = process.memoryUsage().heapUsed - before;
      results.push({
        name: item.name,
        nodes: parsed.diagram.nodes.length,
        edges: parsed.diagram.edges.length,
        coldMs: Number(coldMs.toFixed(1)),
        warmMs: Number(warmMs.toFixed(1)),
        heapDeltaBytes: heapDelta,
        svgBytes: svg.length,
        runtime: `bun ${process.versions.bun ?? "unknown"}`,
      });
      expect(svg).toContain('data-diagram-type="swimlane"');
    }
    const out = join(
      dirname(fileURLToPath(import.meta.url)),
      "../.tmp/swimlane-routing-perf.json",
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    expect(results[0]?.coldMs).toBeLessThan(30_000);
    expect(results[1]?.coldMs).toBeLessThan(120_000);
  }, 180_000);
});

function japaneseSample(): string {
  return `swimlane-beta TB
subgraph operator [作業者]
  start([開始]) --> done([完了])
end
subgraph web [Webツール]
  read[設定読込]
end
start --> read
read --> done
`;
}

function distToRectOutline(
  box: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
): number {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  const dx = point.x < left ? left - point.x : point.x > right ? point.x - right : 0;
  const dy = point.y < top ? top - point.y : point.y > bottom ? point.y - bottom : 0;
  if (dx === 0 && dy === 0) {
    return Math.min(point.x - left, right - point.x, point.y - top, bottom - point.y);
  }
  return Math.hypot(dx, dy);
}

function nearestSide(
  box: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
): "N" | "S" | "E" | "W" {
  const dW = Math.abs(point.x - box.x);
  const dE = Math.abs(point.x - (box.x + box.width));
  const dN = Math.abs(point.y - box.y);
  const dS = Math.abs(point.y - (box.y + box.height));
  const best = Math.min(dW, dE, dN, dS);
  if (best === dW) return "W";
  if (best === dE) return "E";
  if (best === dN) return "N";
  return "S";
}

function segmentAlongSide(
  box: { x: number; y: number; width: number; height: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  const eps = 1.5;
  return (
    (Math.abs(a.x - box.x) < eps && Math.abs(b.x - box.x) < eps) ||
    (Math.abs(a.x - (box.x + box.width)) < eps && Math.abs(b.x - (box.x + box.width)) < eps) ||
    (Math.abs(a.y - box.y) < eps && Math.abs(b.y - box.y) < eps) ||
    (Math.abs(a.y - (box.y + box.height)) < eps && Math.abs(b.y - (box.y + box.height)) < eps)
  );
}

describe("swimlane arrow attachment", () => {
  test("cross-lane arrows meet the outline perpendicularly", () => {
    const parsed = parseSwimlane(japaneseSample());
    const layout = layoutSwimlane(parsed.diagram);
    const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
    expect(layout.edges.length).toBeGreaterThanOrEqual(3);

    for (const edge of layout.edges) {
      const start = byId.get(edge.source)!;
      const end = byId.get(edge.target)!;
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
      const first = edge.points[0]!;
      const last = edge.points[edge.points.length - 1]!;
      const prev = edge.points[edge.points.length - 2]!;
      expect(distToRectOutline(start.box, first)).toBeLessThan(1.5);
      expect(distToRectOutline(end.box, last)).toBeLessThan(1.5);
      expect(segmentAlongSide(end.box, prev, last)).toBe(false);

      const side = nearestSide(end.box, last);
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      if (side === "W") {
        expect(dx).toBeGreaterThan(Math.abs(dy));
      } else if (side === "E") {
        expect(dx).toBeLessThan(-Math.abs(dy));
      } else if (side === "N") {
        expect(dy).toBeGreaterThan(Math.abs(dx));
      } else {
        expect(dy).toBeLessThan(-Math.abs(dx));
      }
    }
  });

  test("simple LR and TB chains attach at the expected side centers", () => {
    const lr = layoutSwimlane(
      parseSwimlane(`swimlane-beta LR
subgraph laneA [A]
  scan[scan] --> connect[connect]
end
`).diagram,
    );
    const tb = layoutSwimlane(
      parseSwimlane(`swimlane-beta TB
subgraph laneA [A]
  scan[scan] --> connect[connect]
end
`).diagram,
    );
    const rl = layoutSwimlane(
      parseSwimlane(`swimlane-beta RL
subgraph laneA [A]
  scan[scan] --> connect[connect]
end
`).diagram,
    );
    const bt = layoutSwimlane(
      parseSwimlane(`swimlane-beta BT
subgraph laneA [A]
  scan[scan] --> connect[connect]
end
`).diagram,
    );

    const assertChain = (
      layout: ReturnType<typeof layoutSwimlane>,
      sourceSide: "N" | "S" | "E" | "W",
      targetSide: "N" | "S" | "E" | "W",
    ) => {
      const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
      const edge = layout.edges.find(
        (item) => item.source === "scan" && item.target === "connect",
      )!;
      const source = byId.get("scan")!;
      const target = byId.get("connect")!;
      const start = edge.points[0]!;
      const end = edge.points[edge.points.length - 1]!;
      expect(nearestSide(source.box, start)).toBe(sourceSide);
      expect(nearestSide(target.box, end)).toBe(targetSide);
      const sourceCenter =
        sourceSide === "E" || sourceSide === "W"
          ? source.box.y + source.box.height / 2
          : source.box.x + source.box.width / 2;
      const targetCenter =
        targetSide === "E" || targetSide === "W"
          ? target.box.y + target.box.height / 2
          : target.box.x + target.box.width / 2;
      const sourcePos = sourceSide === "E" || sourceSide === "W" ? start.y : start.x;
      const targetPos = targetSide === "E" || targetSide === "W" ? end.y : end.x;
      const sourceSpan =
        sourceSide === "E" || sourceSide === "W" ? source.box.height : source.box.width;
      const targetSpan =
        targetSide === "E" || targetSide === "W" ? target.box.height : target.box.width;
      expect(Math.abs(sourcePos - sourceCenter) / sourceSpan).toBeLessThan(0.2);
      expect(Math.abs(targetPos - targetCenter) / targetSpan).toBeLessThan(0.2);
    };

    assertChain(lr, "E", "W");
    assertChain(tb, "S", "N");
    assertChain(rl, "W", "E");
    assertChain(bt, "N", "S");
  });

  test("feedback and self-loop edges stay outside node interiors", () => {
    const layout = layoutSwimlane(parseSwimlane(richGraph("LR")).diagram);
    const boxes = layout.nodes.map((node) => node.box);
    for (const edge of layout.edges) {
      const source = layout.nodes.find((node) => node.id === edge.source)!;
      const target = layout.nodes.find((node) => node.id === edge.target)!;
      const inner = boxes.filter(
        (box) => box !== source.box && box !== target.box,
      );
      for (let i = 0; i < edge.points.length - 1; i += 1) {
        const a = edge.points[i]!;
        const b = edge.points[i + 1]!;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        for (const box of inner) {
          const inside =
            mx > box.x + 1 &&
            mx < box.x + box.width - 1 &&
            my > box.y + 1 &&
            my < box.y + box.height - 1;
          expect(inside).toBe(false);
        }
      }
    }
  });
});
