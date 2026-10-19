/**
 * Swimlane routing regression tests (SOT-84).
 *
 * These tests exist because the previous suite extracted edges with an
 * attribute-order-dependent regex, so a broken extraction returned zero edges
 * and the geometry assertions passed vacuously.
 *
 * Every test here asserts the extracted collection is non-empty first, then
 * checks the geometry exposed by the samples under `examples/`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMermaidSVG } from "../index.ts";
import { parseSwimlane } from "../swimlane/parser.ts";
import { layoutSwimlane } from "../swimlane/layout.ts";
import { THEMES } from "../theme.ts";
import type { SwimlaneLayout } from "../swimlane/types.ts";
import {
  collinearOverlaps,
  duplicateEndpoints,
  edgesByNode,
  endpointsOnOutline,
  extractSvgEdges,
  extractSvgNodes,
  extractViewBox,
  layoutSignature,
  minEndpointSeparation,
  nodePenetrations,
  outsideViewBox,
} from "./support/swimlane-geometry.ts";

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../examples");

/** The seven samples named in SOT-84 (two live one directory up). */
const SAMPLES = [
  "swimlane-firmware.mmd",
  "swimlane-basic.mmd",
  "swimlane/can-isotp-dtc.mmd",
  "swimlane/ble-connect-notify.mmd",
  "swimlane/i2c-sensor-burst.mmd",
  "swimlane/mqtt-ota-chunk.mmd",
  "swimlane/usb-control-enum.mmd",
] as const;

interface Rendered {
  readonly name: string;
  readonly source: string;
  readonly layout: SwimlaneLayout;
  readonly edgeCount: number;
  readonly svg: string;
  readonly viewBox: { x: number; y: number; width: number; height: number };
}

function renderSample(name: string): Rendered {
  const source = readFileSync(join(examplesRoot, name), "utf8");
  const parsed = parseSwimlane(source);
  const layout = layoutSwimlane(parsed.diagram);
  const svg = renderMermaidSVG(source, { ...THEMES["zinc-light"]!, idPrefix: "sot84-" });
  return {
    name,
    source,
    layout,
    edgeCount: parsed.diagram.edges.length,
    svg,
    viewBox: extractViewBox(svg),
  };
}

const rendered = SAMPLES.map((name) => [name, renderSample(name)] as const);
const byName = new Map(rendered);

/**
 * A fixture that forces several edges onto one face of a diamond, a circle and
 * a rectangle: all shapes must fan their ports out instead of collapsing them.
 */
const SHAPE_FANOUT = `swimlane LR
lane Source
  rect[rectangle hub]
  dia{decision hub}
  cir((circle hub))
lane Sink
  r1[rect one]
  r2[rect two]
  r3[rect three]
  d1[diamond one]
  d2[diamond two]
  d3[diamond three]
  c1[circle one]
  c2[circle two]
  c3[circle three]
rect --> r1
rect --> r2
rect --> r3
dia --> d1
dia --> d2
dia --> d3
cir --> c1
cir --> c2
cir --> c3
`;

const BRANCH_MERGE_FEEDBACK = `swimlane LR
lane A
  start([start])
  left[branch left]
  right[branch right]
  end([end])
lane B
  work[work]
start --> left
start --> right
left --> end
right --> end
end --> work
work --> start
`;

const MULTI_EDGE = `swimlane LR
lane A
  send[producer]
lane B
  recv[consumer]
send --> recv
send --> recv
send --> recv
`;

describe("SOT-84 edge extraction", () => {
  for (const [name, item] of rendered) {
    test(`${name}: every IR edge has a matching path[data-edge-id]`, () => {
      const svgEdges = extractSvgEdges(item.svg);
      // Non-vacuous: a broken extractor must not be able to pass this test.
      expect(item.edgeCount).toBeGreaterThan(0);
      expect(svgEdges.length).toBe(item.edgeCount);
      expect(new Set(svgEdges.map((edge) => edge.id))).toEqual(
        new Set(item.layout.edges.map((edge) => edge.id)),
      );
      for (const edge of svgEdges) {
        expect(edge.points.length).toBeGreaterThanOrEqual(2);
      }
    });

    test(`${name}: SVG path geometry matches the layout IR`, () => {
      const svgEdges = new Map(extractSvgEdges(item.svg).map((edge) => [edge.id, edge] as const));
      expect(svgEdges.size).toBeGreaterThan(0);
      for (const edge of item.layout.edges) {
        const svgEdge = svgEdges.get(edge.id);
        expect(svgEdge).toBeTruthy();
        expect(svgEdge!.points.length).toBe(edge.points.length);
        for (let i = 0; i < edge.points.length; i += 1) {
          expect(svgEdge!.points[i]!.x).toBeCloseTo(edge.points[i]!.x, 1);
          expect(svgEdge!.points[i]!.y).toBeCloseTo(edge.points[i]!.y, 1);
        }
      }
      const svgNodes = extractSvgNodes(item.svg);
      expect(svgNodes.length).toBe(item.layout.nodes.length);
    });
  }
});

describe("SOT-84 endpoints and ports", () => {
  for (const [name, item] of rendered) {
    test(`${name}: endpoints lie on the outline of their node shape`, () => {
      expect(item.layout.edges.length).toBeGreaterThan(0);
      expect(endpointsOnOutline(item.layout, 1.5)).toEqual([]);
    });

    test(`${name}: no two edges attach to the same point on a node face`, () => {
      expect(item.layout.edges.length).toBeGreaterThan(0);
      expect(duplicateEndpoints(item.layout, 0.6)).toEqual([]);
      const separation = minEndpointSeparation(item.layout);
      if (separation) expect(separation.separation).toBeGreaterThanOrEqual(3);
    });

    test(`${name}: no node mixes incoming and outgoing edges on one face`, () => {
      expect(item.layout.edges.length).toBeGreaterThan(0);
      const mixed: string[] = [];
      for (const node of item.layout.nodes) {
        const endpoints = edgesByNode(node, item.layout.edges);
        const directions = new Map<string, Set<string>>();
        for (const endpoint of endpoints) {
          const set = directions.get(endpoint.side) ?? new Set<string>();
          set.add(endpoint.kind);
          directions.set(endpoint.side, set);
        }
        for (const [side, set] of directions) {
          if (set.has("source") && set.has("target")) {
            mixed.push(`${node.id}:${side}`);
          }
        }
      }
      expect(mixed).toEqual([]);
    });
  }

  test("diamond, circle and rectangle fan out identical same-side ports", () => {
    const parsed = parseSwimlane(SHAPE_FANOUT);
    const layout = layoutSwimlane(parsed.diagram);
    for (const id of ["rect", "dia", "cir"]) {
      const node = layout.nodes.find((item) => item.id === id);
      expect(node).toBeTruthy();
      const endpoints = edgesByNode(node!, layout.edges).filter(
        (endpoint) => endpoint.kind === "source",
      );
      expect(endpoints.length).toBe(3);
      expect(endpointsOnOutline(layout, 1.5)).toEqual([]);
      const separation = minEndpointSeparation({
        ...layout,
        edges: layout.edges.filter((edge) => edge.source === id),
      });
      expect(separation).toBeTruthy();
      expect(separation!.separation).toBeGreaterThanOrEqual(3);
      expect(duplicateEndpoints(layout, 0.6)).toEqual([]);
    }
  });
});

describe("SOT-84 node penetration", () => {
  for (const [name, item] of rendered) {
    test(`${name}: no edge segment crosses a foreign node interior`, () => {
      expect(item.layout.edges.length).toBeGreaterThan(0);
      expect(item.layout.nodes.length).toBeGreaterThan(0);
      const penetrations = nodePenetrations(item.layout);
      expect(
        penetrations.map(
          (item) => `${item.edgeId}->${item.nodeId} seg${item.segment} ${item.length.toFixed(1)}px`,
        ),
      ).toEqual([]);
    });
  }
});

describe("SOT-84 track separation", () => {
  for (const [name, item] of rendered) {
    test(`${name}: no two edges share a track`, () => {
      expect(item.layout.edges.length).toBeGreaterThan(0);
      const overlaps = collinearOverlaps(item.layout, 1.5, 4);
      expect(
        overlaps.map(
          (item) =>
            `${item.a}/${item.b} ${item.axis} off${item.offset.toFixed(1)} ${item.length.toFixed(1)}px`,
        ),
      ).toEqual([]);
    });
  }

  for (const [label, source] of [
    ["branch and merge", BRANCH_MERGE_FEEDBACK],
    ["multi-edge pair", MULTI_EDGE],
  ] as const) {
    test(`${label}: parallel routes stay on separate tracks`, () => {
      const parsed = parseSwimlane(source);
      const layout = layoutSwimlane(parsed.diagram);
      expect(layout.edges.length).toBeGreaterThan(0);
      expect(collinearOverlaps(layout, 1.5, 4)).toEqual([]);
      expect(duplicateEndpoints(layout, 0.6)).toEqual([]);
      expect(nodePenetrations(layout)).toEqual([]);
      const separation = minEndpointSeparation(layout);
      if (separation) expect(separation.separation).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("SOT-84 labels and viewBox", () => {
  for (const [name, item] of rendered) {
    test(`${name}: labels, arrows and connectors stay inside the viewBox`, () => {
      expect(item.layout.edges.length).toBeGreaterThan(0);
      expect(item.viewBox.x).toBe(0);
      expect(item.viewBox.y).toBe(0);
      expect(item.viewBox.width).toBeGreaterThan(0);
      expect(item.viewBox.height).toBeGreaterThan(0);
      expect(outsideViewBox(item.layout, item.viewBox)).toEqual([]);
      for (const edge of extractSvgEdges(item.svg)) {
        for (const point of edge.points) {
          expect(point.x).toBeGreaterThanOrEqual(-0.01);
          expect(point.y).toBeGreaterThanOrEqual(-0.01);
          expect(point.x).toBeLessThanOrEqual(item.viewBox.width + 0.01);
          expect(point.y).toBeLessThanOrEqual(item.viewBox.height + 0.01);
        }
      }
    });
  }

  test("ble-connect-notify: the no branch label is not clipped on the left", () => {
    const item = byName.get("swimlane/ble-connect-notify.mmd")!;
    const labelled = item.layout.edges.filter((edge) => edge.label);
    expect(labelled.length).toBeGreaterThan(0);
    const no = labelled.find((edge) => edge.label === "no");
    expect(no).toBeTruthy();
    expect(no!.labelBox).toBeTruthy();
    expect(no!.labelBox!.x).toBeGreaterThanOrEqual(0);
    expect(no!.labelBox!.y).toBeGreaterThanOrEqual(0);
    for (const edge of item.layout.edges) {
      for (const point of edge.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
      }
    }
    expect(outsideViewBox(item.layout, item.viewBox)).toEqual([]);
  });
});

describe("SOT-84 determinism", () => {
  for (const [name, item] of rendered) {
    test(`${name}: repeated renders produce identical geometry`, () => {
      const again = renderSample(name);
      expect(item.layout.nodes.length).toBeGreaterThan(0);
      expect(item.layout.edges.length).toBeGreaterThan(0);
      expect(layoutSignature(again.layout)).toBe(layoutSignature(item.layout));
      expect(extractSvgEdges(again.svg)).toEqual(extractSvgEdges(item.svg));
      expect(extractSvgNodes(again.svg)).toEqual(extractSvgNodes(item.svg));
    });
  }

  test("the compared collections are non-empty across the sample set", () => {
    const nodes = rendered.flatMap(([, item]) => item.layout.nodes);
    const edges = rendered.flatMap(([, item]) => item.layout.edges);
    const labels = edges.filter((edge) => edge.label);
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);
    expect(labels.length).toBeGreaterThan(0);
  });
});
