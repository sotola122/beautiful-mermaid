import type { ElkExtendedEdge, ElkNode } from "elkjs";
import { DiagramRenderError } from "../errors.ts";
import { elkLayoutSync } from "../elk-instance.ts";
import { clipEdgeToShape } from "../shape-clipping.ts";
import { FONT_SIZES, FONT_WEIGHTS, NODE_PADDING } from "../styles.ts";
import { measureMultilineText } from "../text-metrics.ts";
import type { NodeShape, Point, PositionedNode as FlowNode, RenderOptions } from "../types.ts";
import type {
  Box,
  PositionedLane,
  PositionedNode,
  RoutedEdge,
  SwimlaneDiagram,
  SwimlaneDirection,
  SwimlaneLayout,
  SwimlaneNode,
} from "./types.ts";
import { findOrthogonalPath, routeEdges, segmentHits, SWL_E_ROUTING } from "./routing.ts";

export const SWL_LAYOUT = {
  headerH: 36,
  padding: 24,
  lanePadX: 16,
  lanePadY: 12,
  nodeSpacing: 28,
  layerSpacing: 48,
  minLane: 80,
  spacer: 28,
} as const;

const SPACER_PREFIX = "__swl_spacer_";
const LANE_PREFIX = "swl_lane_";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPoint(point: Point): Point {
  return { x: round(point.x), y: round(point.y) };
}

function measureNode(node: SwimlaneNode): { width: number; height: number } {
  const metrics = measureMultilineText(
    node.label || node.id,
    FONT_SIZES.nodeLabel,
    FONT_WEIGHTS.nodeLabel,
  );
  let width = metrics.width + NODE_PADDING.horizontal * 2;
  let height = metrics.height + NODE_PADDING.vertical * 2;
  if (node.shape === "diamond") {
    const side = Math.max(width, height) + NODE_PADDING.diamondExtra;
    width = side;
    height = side;
  }
  if (node.shape === "circle") {
    const diameter = Math.ceil(Math.sqrt(width * width + height * height)) + 8;
    width = diameter;
    height = width;
  }
  return { width: Math.max(width, 60), height: Math.max(height, 36) };
}

function elkDirection(direction: SwimlaneDirection): "RIGHT" | "LEFT" | "DOWN" | "UP" {
  switch (direction) {
    case "RL":
      return "LEFT";
    case "TB":
      return "DOWN";
    case "BT":
      return "UP";
    default:
      return "RIGHT";
  }
}

function isColumnLanes(direction: SwimlaneDirection): boolean {
  return direction === "LR" || direction === "RL";
}

function collapse(points: readonly Point[]): Point[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const out: Point[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = out[out.length - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const colinear =
      (Math.abs(prev.x - cur.x) < 0.05 && Math.abs(cur.x - next.x) < 0.05) ||
      (Math.abs(prev.y - cur.y) < 0.05 && Math.abs(cur.y - next.y) < 0.05);
    if (!colinear) out.push({ ...cur });
  }
  out.push({ ...points[points.length - 1]! });
  return out;
}

function edgePoints(edge: ElkExtendedEdge): Point[] {
  const points: Point[] = [];
  for (const section of edge.sections ?? []) {
    points.push(roundPoint(section.startPoint));
    for (const bend of section.bendPoints ?? []) points.push(roundPoint(bend));
    points.push(roundPoint(section.endPoint));
  }
  return collapse(points);
}

function nearestOnBox(box: Box, point: Point): Point {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  const cx = Math.max(left, Math.min(right, point.x));
  const cy = Math.max(top, Math.min(bottom, point.y));
  const dl = Math.abs(point.x - left);
  const dr = Math.abs(point.x - right);
  const dt = Math.abs(point.y - top);
  const db = Math.abs(point.y - bottom);
  const best = Math.min(dl, dr, dt, db);
  if (best === dl) return roundPoint({ x: left, y: cy });
  if (best === dr) return roundPoint({ x: right, y: cy });
  if (best === dt) return roundPoint({ x: cx, y: top });
  return roundPoint({ x: cx, y: bottom });
}

function extendToBox(box: Box, from: Point, toward: Point): Point {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
    return nearestOnBox(box, toward);
  }
  const ts: number[] = [];
  if (Math.abs(dx) > 0.05) {
    ts.push((box.x - from.x) / dx);
    ts.push((box.x + box.width - from.x) / dx);
  }
  if (Math.abs(dy) > 0.05) {
    ts.push((box.y - from.y) / dy);
    ts.push((box.y + box.height - from.y) / dy);
  }
  const hits = ts
    .filter((t) => t >= 0)
    .map((t) => ({ t, p: { x: from.x + dx * t, y: from.y + dy * t } }))
    .filter(({ p }) =>
      p.x >= box.x - 0.75 &&
      p.x <= box.x + box.width + 0.75 &&
      p.y >= box.y - 0.75 &&
      p.y <= box.y + box.height + 0.75
    )
    .sort((a, b) => a.t - b.t);
  return roundPoint(hits[0]?.p ?? {
    x: Math.max(box.x, Math.min(box.x + box.width, from.x)),
    y: Math.max(box.y, Math.min(box.y + box.height, from.y)),
  });
}

function asFlowNode(node: PositionedNode): FlowNode {
  return {
    id: node.id,
    label: node.label,
    shape: node.shape as NodeShape,
    x: node.box.x,
    y: node.box.y,
    width: node.box.width,
    height: node.box.height,
  };
}

function collectAbs(
  node: ElkNode,
  originX: number,
  originY: number,
  boxes: Map<string, Box>,
): void {
  const x = originX + (node.x ?? 0);
  const y = originY + (node.y ?? 0);
  boxes.set(node.id, {
    x: round(x),
    y: round(y),
    width: round(node.width ?? 0),
    height: round(node.height ?? 0),
  });
  for (const child of node.children ?? []) collectAbs(child, x, y, boxes);
}

function equalizeLanes(
  lanes: PositionedLane[],
  direction: SwimlaneDirection,
): PositionedLane[] {
  if (lanes.length === 0) return lanes;
  if (isColumnLanes(direction)) {
    const top = Math.min(...lanes.map((lane) => lane.box.y));
    const bottom = Math.max(...lanes.map((lane) => lane.box.y + lane.box.height));
    return lanes.map((lane) => ({
      ...lane,
      box: { ...lane.box, y: top, height: Math.max(bottom - top, SWL_LAYOUT.minLane) },
      headerBox: { x: lane.box.x, y: top, width: lane.box.width, height: SWL_LAYOUT.headerH },
    }));
  }
  const left = Math.min(...lanes.map((lane) => lane.box.x));
  const right = Math.max(...lanes.map((lane) => lane.box.x + lane.box.width));
  return lanes.map((lane) => ({
    ...lane,
    box: { ...lane.box, x: left, width: Math.max(right - left, SWL_LAYOUT.minLane) },
    headerBox: { x: left, y: lane.box.y, width: Math.max(right - left, SWL_LAYOUT.minLane), height: SWL_LAYOUT.headerH },
  }));
}

/** Close ELK partition gaps so lanes form a continuous swimlane. Source order is unchanged. */
function abutLanes(lanes: PositionedLane[], direction: SwimlaneDirection): PositionedLane[] {
  if (lanes.length < 2) return lanes;
  const next = lanes.map((lane) => ({
    ...lane,
    box: { ...lane.box },
    headerBox: { ...lane.headerBox },
  }));
  if (isColumnLanes(direction)) {
    const sorted = [...next].sort((a, b) => a.box.x - b.box.x || a.sourceOrder - b.sourceOrder);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const cur = sorted[i]!;
      const gap = sorted[i + 1]!.box.x - (cur.box.x + cur.box.width);
      if (gap > 0.5) {
        cur.box = { ...cur.box, width: cur.box.width + gap };
        cur.headerBox = { ...cur.headerBox, width: cur.headerBox.width + gap };
      }
    }
    return next;
  }
  const sorted = [...next].sort((a, b) => a.box.y - b.box.y || a.sourceOrder - b.sourceOrder);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const cur = sorted[i]!;
    const gap = sorted[i + 1]!.box.y - (cur.box.y + cur.box.height);
    if (gap > 0.5) {
      cur.box = { ...cur.box, height: cur.box.height + gap };
    }
  }
  return next;
}

function pathChanged(before: readonly Point[], after: readonly Point[]): boolean {
  if (before.length !== after.length) return true;
  return before.some(
    (point, index) => point.x !== after[index]?.x || point.y !== after[index]?.y,
  );
}

function inflateBox(box: Box, pad: number): Box {
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

function pathCrossesNodes(points: readonly Point[], boxes: readonly Box[]): boolean {
  for (const box of boxes) {
    const core = inflateBox(box, -2);
    if (core.width <= 1 || core.height <= 1) continue;
    for (let i = 0; i < points.length - 1; i += 1) {
      if (segmentHits([core], points[i]!, points[i + 1]!)) return true;
    }
  }
  return false;
}

function rerouteAround(
  points: Point[],
  others: readonly Box[],
  allBoxes: readonly Box[],
): Point[] {
  if (points.length < 2 || !pathCrossesNodes(points, others)) return points;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const box of allBoxes) {
    xs.push(box.x - 8, box.x, box.x + box.width / 2, box.x + box.width, box.x + box.width + 8);
    ys.push(box.y - 8, box.y, box.y + box.height / 2, box.y + box.height, box.y + box.height + 8);
  }
  const alt = findOrthogonalPath(points[0]!, points[points.length - 1]!, others.map((box) => inflateBox(box, 4)), xs, ys);
  if (alt && alt.length >= 2 && !pathCrossesNodes(alt, others)) return alt;
  return points;
}

function selfLoopPoints(box: Box, others: readonly Box[]): Point[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (const extra of [0, 16, 32, 48, 72]) {
    const reach = 18 + extra;
    const points = [
      { x: box.x + box.width, y: cy },
      { x: box.x + box.width + reach, y: cy },
      { x: box.x + box.width + reach, y: box.y - reach },
      { x: cx, y: box.y - reach },
      { x: cx, y: box.y },
    ].map(roundPoint);
    if (!pathCrossesNodes(points, others)) return points;
  }
  return [
    { x: box.x + box.width, y: cy },
    { x: box.x + box.width + 24, y: cy },
    { x: box.x + box.width + 24, y: box.y - 24 },
    { x: cx, y: box.y - 24 },
    { x: cx, y: box.y },
  ].map(roundPoint);
}

function routingError(message: string): DiagramRenderError {
  return new DiagramRenderError(message, [
    { code: SWL_E_ROUTING, severity: "error", message },
  ]);
}

function buildElkGraph(diagram: SwimlaneDiagram, options: RenderOptions): ElkNode {
  const padding = options.padding ?? SWL_LAYOUT.padding;
  const nodeSpacing = options.nodeSpacing ?? SWL_LAYOUT.nodeSpacing;
  const layerSpacing = options.layerSpacing ?? SWL_LAYOUT.layerSpacing;
  const sizes = new Map(diagram.nodes.map((node) => [node.id, measureNode(node)] as const));
  const byLane = new Map<string, SwimlaneNode[]>();
  for (const node of diagram.nodes) {
    const list = byLane.get(node.laneId) ?? [];
    list.push(node);
    byLane.set(node.laneId, list);
  }
  for (const list of byLane.values()) list.sort((a, b) => a.sourceOrder - b.sourceOrder);

  const children: ElkNode[] = diagram.lanes.map((lane, index) => {
    const headerW = measureMultilineText(lane.label, 13, 700).width + 24;
    const members = byLane.get(lane.id) ?? [];
    const kids: ElkNode[] = members.map((node) => {
      const size = sizes.get(node.id)!;
      return {
        id: node.id,
        width: size.width,
        height: size.height,
        layoutOptions: { "elk.partitioning.partition": String(index) },
      };
    });
    if (kids.length === 0) {
      kids.push({
        id: `${SPACER_PREFIX}${lane.id}`,
        width: SWL_LAYOUT.spacer,
        height: SWL_LAYOUT.spacer,
        layoutOptions: { "elk.partitioning.partition": String(index) },
      });
    }
    const minW = Math.max(SWL_LAYOUT.minLane, headerW);
    const minH = SWL_LAYOUT.headerH + SWL_LAYOUT.lanePadY * 2 + SWL_LAYOUT.spacer;
    return {
      id: `${LANE_PREFIX}${lane.id}`,
      layoutOptions: {
        "elk.padding": `[top=${SWL_LAYOUT.headerH + SWL_LAYOUT.lanePadY},left=${SWL_LAYOUT.lanePadX},bottom=${SWL_LAYOUT.lanePadY},right=${SWL_LAYOUT.lanePadX}]`,
        "elk.partitioning.partition": String(index),
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${round(minW)},${round(minH)})`,
      },
      children: kids,
    };
  });

  const edges: ElkExtendedEdge[] = diagram.edges.map((edge) => {
    const elkEdge: ElkExtendedEdge = {
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    };
    if (edge.label) {
      const metrics = measureMultilineText(edge.label, 12, 400);
      elkEdge.labels = [{ text: edge.label, width: metrics.width + 8, height: metrics.height + 6 }];
    }
    return elkEdge;
  });

  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": elkDirection(diagram.direction),
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.partitioning.activate": "true",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.spacing.nodeNode": String(nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
      "elk.spacing.edgeEdge": "16",
      "elk.spacing.edgeNode": "18",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.layered.crossingMinimization.hierarchicalSweepiness": "1",
      "elk.layered.thoroughness": "3",
      "elk.contentAlignment": "H_CENTER V_CENTER",
      "elk.portConstraints": "FREE",
      "elk.padding": `[top=${padding},left=${padding},bottom=${padding},right=${padding}]`,
      "elk.edgeLabels.placement": "CENTER",
    },
    children,
    edges,
  };
}

export function layoutSwimlane(
  diagram: SwimlaneDiagram,
  options: RenderOptions = {},
): SwimlaneLayout {
  if (diagram.lanes.length === 0) {
    return {
      width: 0,
      height: 0,
      direction: diagram.direction,
      lanes: [],
      nodes: [],
      edges: [],
      reroutedEdges: 0,
    };
  }

  let result: ElkNode;
  try {
    result = elkLayoutSync(buildElkGraph(diagram, options));
  } catch (error) {
    throw routingError(error instanceof Error ? error.message : "ELK swimlane layout failed");
  }

  const boxes = new Map<string, Box>();
  collectAbs(result, 0, 0, boxes);

  const nodes: PositionedNode[] = diagram.nodes.map((node) => {
    const box = boxes.get(node.id);
    if (!box) throw routingError(`Missing ELK box for ${node.id}`);
    return { ...node, box };
  });
  const byId = new Map(nodes.map((node) => [node.id, node] as const));

  const rawLanes: PositionedLane[] = diagram.lanes.map((lane) => {
    const box = boxes.get(`${LANE_PREFIX}${lane.id}`);
    if (!box) throw routingError(`Missing ELK lane box for ${lane.id}`);
    return {
      ...lane,
      box,
      headerBox: { x: box.x, y: box.y, width: box.width, height: SWL_LAYOUT.headerH },
    };
  });
  const lanes = abutLanes(equalizeLanes(rawLanes, diagram.direction), diagram.direction);

  const elkEdges = new Map((result.edges ?? []).map((edge) => [edge.id, edge] as const));
  const draft: SwimlaneLayout = {
    width: result.width ?? 0,
    height: result.height ?? 0,
    direction: diagram.direction,
    lanes,
    nodes,
    edges: [],
    reroutedEdges: 0,
  };
  const feedback = new Set<string>();
  for (const edge of diagram.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    if (isColumnLanes(diagram.direction)) {
      if (target.box.x + target.box.width < source.box.x) feedback.add(edge.id);
    } else if (target.box.y + target.box.height < source.box.y) {
      feedback.add(edge.id);
    }
  }

  let reroutedEdges = 0;
  const routed: RoutedEdge[] = diagram.edges.map((edge) => {
    const elkEdge = elkEdges.get(edge.id);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const others = nodes
      .filter((node) => node.id !== edge.source && node.id !== edge.target)
      .map((node) => node.box);
    if (edge.source === edge.target && source) {
      let points = selfLoopPoints(source.box, others);
      points = clipEdgeToShape(points, asFlowNode(source), true);
      points = clipEdgeToShape(points, asFlowNode(source), false);
      return { ...edge, points: collapse(points.map(roundPoint)) };
    }
    let points = elkEdge ? edgePoints(elkEdge) : [];
    if (points.length < 2 && source && target) {
      points = [
        { x: source.box.x + source.box.width / 2, y: source.box.y + source.box.height / 2 },
        { x: target.box.x + target.box.width / 2, y: target.box.y + target.box.height / 2 },
      ];
    }
    if (source && points.length >= 2) {
      points[0] = extendToBox(source.box, points[1]!, points[0]!);
    }
    if (target && points.length >= 2) {
      points[points.length - 1] = extendToBox(target.box, points[points.length - 2]!, points[points.length - 1]!);
    }
    if (source) points = clipEdgeToShape(points, asFlowNode(source), true);
    if (target) points = clipEdgeToShape(points, asFlowNode(target), false);
    const before = points.map((point) => ({ ...point }));
    points = rerouteAround(points, others, nodes.map((node) => node.box));
    if (source && target && pathCrossesNodes(points, others)) {
      try {
        const cleaned = routeEdges(
          { ...diagram, edges: [edge] },
          draft,
          feedback,
          24,
        );
        const alt = cleaned.edges[0]?.points;
        if (alt && alt.length >= 2 && !pathCrossesNodes(alt, others)) {
          points = [...alt];
          reroutedEdges += 1;
        }
      } catch {
        // Keep the ELK path when orthogonal cleanup cannot find a channel.
      }
    } else if (pathChanged(before, points)) {
      reroutedEdges += 1;
    }
    if (source) points = clipEdgeToShape(points, asFlowNode(source), true);
    if (target) points = clipEdgeToShape(points, asFlowNode(target), false);
    let labelBox: Box | undefined;
    const label = elkEdge?.labels?.[0];
    if (edge.label && label && label.x != null && label.y != null) {
      labelBox = {
        x: round(label.x),
        y: round(label.y),
        width: round(label.width ?? 0),
        height: round(label.height ?? 0),
      };
    }
    return { ...edge, points: collapse(points.map(roundPoint)), labelBox };
  });

  const xs = [result.width ?? 0];
  const ys = [result.height ?? 0];
  for (const lane of lanes) {
    xs.push(lane.box.x + lane.box.width);
    ys.push(lane.box.y + lane.box.height);
  }
  for (const node of nodes) {
    xs.push(node.box.x + node.box.width);
    ys.push(node.box.y + node.box.height);
  }
  for (const edge of routed) {
    for (const point of edge.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
  }

  return {
    width: round(Math.max(0, ...xs) + (options.padding ?? SWL_LAYOUT.padding) / 2),
    height: round(Math.max(0, ...ys) + (options.padding ?? SWL_LAYOUT.padding) / 2),
    direction: diagram.direction,
    lanes,
    nodes,
    edges: routed,
    reroutedEdges,
  };
}
