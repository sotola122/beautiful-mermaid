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
import { routeEdges, SWL_E_ROUTING } from "./routing.ts";

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
    const colinearX =
      Math.abs(prev.x - cur.x) < 0.05 && Math.abs(cur.x - next.x) < 0.05;
    const colinearY =
      Math.abs(prev.y - cur.y) < 0.05 && Math.abs(cur.y - next.y) < 0.05;
    const between =
      (colinearX &&
        cur.y >= Math.min(prev.y, next.y) - 0.05 &&
        cur.y <= Math.max(prev.y, next.y) + 0.05) ||
      (colinearY &&
        cur.x >= Math.min(prev.x, next.x) - 0.05 &&
        cur.x <= Math.max(prev.x, next.x) + 0.05);
    if (!between) out.push({ ...cur });
  }
  out.push({ ...points[points.length - 1]! });
  return out;
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

function isBackEdge(
  direction: SwimlaneDirection,
  source: PositionedNode,
  target: PositionedNode,
): boolean {
  switch (direction) {
    case "RL":
      return target.box.x > source.box.x + source.box.width;
    case "BT":
      return target.box.y > source.box.y + source.box.height;
    case "TB":
      return target.box.y + target.box.height < source.box.y;
    default:
      return target.box.x + target.box.width < source.box.x;
  }
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
    if (!source || !target || edge.source === edge.target) continue;
    if (isBackEdge(diagram.direction, source, target)) feedback.add(edge.id);
  }

  const routedResult = routeEdges(diagram, draft, feedback);
  const routed: RoutedEdge[] = routedResult.edges.map((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    let points = [...edge.points];
    if (source) points = clipEdgeToShape(points, asFlowNode(source), true);
    if (target) points = clipEdgeToShape(points, asFlowNode(target), false);
    return { ...edge, points: collapse(points.map(roundPoint)) };
  });
  const reroutedEdges = routedResult.reroutedEdges;

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
