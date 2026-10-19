import type { ElkExtendedEdge, ElkNode } from "elkjs";
import { DiagramRenderError } from "../errors.ts";
import { elkLayoutSync } from "../elk-instance.ts";
import { FONT_SIZES, FONT_WEIGHTS, NODE_PADDING } from "../styles.ts";
import { measureMultilineText } from "../text-metrics.ts";
import type { RenderOptions } from "../types.ts";
import type {
  Box,
  PlannedEdgeRoute,
  PositionedLane,
  PositionedNode,
  RoutedEdge,
  SwimlaneDiagram,
  SwimlaneDirection,
  SwimlaneLayout,
  SwimlaneNode,
  SwimlaneSide,
} from "./types.ts";
import { flowSides, projectPort, routeEdges, SWL_E_ROUTING } from "./routing.ts";
import { edgeLabelBounds } from "./renderer.ts";

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
const PORT_PREFIX = "swl_port_";

type Side = SwimlaneSide;

/**
 * Node faces per edge role. Forward and backward edges get opposite faces so a
 * node never shows its inputs and outputs on the same face; the cross faces are
 * only used after a conflict is detected (see `planEdgeSides`).
 */
function sideRoles(direction: SwimlaneDirection): {
  fwdOut: Side;
  fwdIn: Side;
  bwdOut: Side;
  bwdIn: Side;
  crossIn: Side;
  crossOut: Side;
} {
  const flow = flowSides(direction);
  switch (direction) {
    case "RL":
      return { fwdOut: flow.from, fwdIn: flow.to, bwdOut: flow.to, bwdIn: flow.from, crossIn: "N", crossOut: "S" };
    case "TB":
    case "BT":
      return { fwdOut: flow.from, fwdIn: flow.to, bwdOut: flow.to, bwdIn: flow.from, crossIn: "E", crossOut: "W" };
    default:
      return { fwdOut: flow.from, fwdIn: flow.to, bwdOut: flow.to, bwdIn: flow.from, crossIn: "N", crossOut: "S" };
  }
}

interface SideAssignment {
  from: Side;
  to: Side;
  feedback: boolean;
  selfLoop: boolean;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPoint(point: { x: number; y: number }): { x: number; y: number } {
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
    height = diameter;
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

function collapse(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const out: { x: number; y: number }[] = [{ ...points[0]! }];
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

/**
 * Decide which node face every edge attaches to before ELK runs.
 *
 * Forward edges use the flow faces, backward edges the opposite ones. When a
 * face would carry both incoming and outgoing edges, the backward attachments
 * move to a cross face so inputs and outputs stay apart.
 */
function planEdgeSides(
  diagram: SwimlaneDiagram,
  nodes: readonly PositionedNode[],
  direction: SwimlaneDirection,
): Map<string, SideAssignment> {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const roles = sideRoles(direction);
  const assignments = new Map<string, SideAssignment>();

  for (const edge of diagram.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) throw routingError(`Missing endpoint for ${edge.id}`);
    if (edge.source === edge.target) {
      assignments.set(edge.id, {
        from: roles.fwdOut,
        to: roles.bwdIn,
        feedback: false,
        selfLoop: true,
      });
      continue;
    }
    if (isBackEdge(direction, source, target)) {
      assignments.set(edge.id, {
        from: roles.bwdOut,
        to: roles.bwdIn,
        feedback: true,
        selfLoop: false,
      });
    } else {
      assignments.set(edge.id, {
        from: roles.fwdOut,
        to: roles.fwdIn,
        feedback: false,
        selfLoop: false,
      });
    }
  }

  interface Attachment {
    edgeId: string;
    end: "s" | "t";
    direction: "in" | "out";
    role: "forward" | "backward" | "self";
  }
  const groups = new Map<string, Attachment[]>();
  const add = (nodeId: string, attachment: Attachment): void => {
    const key = `${nodeId}:${assignments.get(attachment.edgeId)![attachment.end === "s" ? "from" : "to"]}`;
    groups.set(key, [...(groups.get(key) ?? []), attachment]);
  };
  for (const edge of diagram.edges) {
    const assignment = assignments.get(edge.id)!;
    const role = assignment.selfLoop ? "self" : assignment.feedback ? "backward" : "forward";
    add(edge.source, { edgeId: edge.id, end: "s", direction: "out", role });
    add(edge.target, { edgeId: edge.id, end: "t", direction: "in", role });
  }
  for (const list of groups.values()) {
    const hasOut = list.some((item) => item.direction === "out");
    const hasIn = list.some((item) => item.direction === "in");
    if (!hasOut || !hasIn) continue;
    for (const item of list) {
      if (item.role !== "backward") continue;
      const assignment = assignments.get(item.edgeId)!;
      const side = item.direction === "in" ? roles.crossIn : roles.crossOut;
      if (item.end === "s") assignment.from = side;
      else assignment.to = side;
    }
  }

  return assignments;
}

interface HarvestedLayout {
  boxes: Map<string, Box>;
  ports: Map<string, { x: number; y: number }>;
  sections: Map<string, { x: number; y: number }[]>;
}

/**
 * Walk an ELK result, collecting absolute node boxes, absolute port positions
 * and edge sections (coordinates are relative to the edge's container).
 */
function harvest(node: ElkNode, originX: number, originY: number, out: HarvestedLayout): void {
  const x = originX + (node.x ?? 0);
  const y = originY + (node.y ?? 0);
  out.boxes.set(node.id, {
    x: round(x),
    y: round(y),
    width: round(node.width ?? 0),
    height: round(node.height ?? 0),
  });
  const ports = (node as { ports?: { id: string; x?: number; y?: number }[] }).ports ?? [];
  for (const port of ports) {
    out.ports.set(port.id, { x: x + (port.x ?? 0), y: y + (port.y ?? 0) });
  }
  const edges = (node as { edges?: ElkExtendedEdge[] }).edges ?? [];
  for (const edge of edges) {
    const section = edge.sections?.[0];
    if (!section) continue;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
      (point) => ({ x: originX + point.x, y: originY + point.y }),
    );
    out.sections.set(edge.id, points);
  }
  for (const child of node.children ?? []) harvest(child, x, y, out);
}

function sideName(side: Side): string {
  switch (side) {
    case "E":
      return "EAST";
    case "W":
      return "WEST";
    case "N":
      return "NORTH";
    default:
      return "SOUTH";
  }
}

interface PortPlan {
  readonly id: string;
  readonly side: Side;
  readonly index: number;
}

/** Build ELK fixed-side ports for every edge endpoint from the side plan. */
function buildPorts(
  diagram: SwimlaneDiagram,
  assignments: Map<string, SideAssignment> | undefined,
  direction: SwimlaneDirection,
): Map<string, PortPlan[]> {
  const flow = flowSides(direction);
  const out = new Map<string, PortPlan[]>();
  const counters = new Map<string, number>();
  const push = (nodeId: string, edgeId: string, end: "s" | "t", side: Side): void => {
    const key = `${nodeId}:${side}`;
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    const list = out.get(nodeId) ?? [];
    list.push({ id: `${PORT_PREFIX}${edgeId}_${end}`, side, index });
    out.set(nodeId, list);
  };
  for (const edge of diagram.edges) {
    const assignment = assignments?.get(edge.id);
    push(edge.source, edge.id, "s", assignment?.from ?? flow.from);
    push(edge.target, edge.id, "t", assignment?.to ?? flow.to);
  }
  return out;
}

function buildElkGraph(
  diagram: SwimlaneDiagram,
  options: RenderOptions,
  assignments?: Map<string, SideAssignment>,
): ElkNode {
  const padding = options.padding ?? SWL_LAYOUT.padding;
  const nodeSpacing = options.nodeSpacing ?? SWL_LAYOUT.nodeSpacing;
  const layerSpacing = options.layerSpacing ?? SWL_LAYOUT.layerSpacing;
  const sizes = new Map(diagram.nodes.map((node) => [node.id, measureNode(node)] as const));
  const ports = buildPorts(diagram, assignments, diagram.direction);
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
      const nodePorts = (ports.get(node.id) ?? []).map((port) => ({
        id: port.id,
        width: 0,
        height: 0,
        layoutOptions: {
          "elk.port.side": sideName(port.side),
          "elk.port.index": String(port.index),
        },
      }));
      return {
        id: node.id,
        width: size.width,
        height: size.height,
        layoutOptions: {
          "elk.partitioning.partition": String(index),
          "elk.portConstraints": "FIXED_ORDER",
        },
        ports: nodePorts,
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
      sources: [`${PORT_PREFIX}${edge.id}_s`],
      targets: [`${PORT_PREFIX}${edge.id}_t`],
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
      "elk.spacing.portPort": "8",
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

interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function emptyBounds(): ContentBounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function includeBox(bounds: ContentBounds, box: Box): void {
  bounds.minX = Math.min(bounds.minX, box.x);
  bounds.minY = Math.min(bounds.minY, box.y);
  bounds.maxX = Math.max(bounds.maxX, box.x + box.width);
  bounds.maxY = Math.max(bounds.maxY, box.y + box.height);
}

function includePoint(bounds: ContentBounds, point: { x: number; y: number }, pad = 0): void {
  bounds.minX = Math.min(bounds.minX, point.x - pad);
  bounds.minY = Math.min(bounds.minY, point.y - pad);
  bounds.maxX = Math.max(bounds.maxX, point.x + pad);
  bounds.maxY = Math.max(bounds.maxY, point.y + pad);
}

/** Everything the renderer paints, so a translation can keep it all visible. */
function contentBounds(
  lanes: readonly PositionedLane[],
  nodes: readonly PositionedNode[],
  edges: readonly RoutedEdge[],
): ContentBounds {
  const bounds = emptyBounds();
  for (const lane of lanes) {
    includeBox(bounds, lane.box);
    includeBox(bounds, lane.headerBox);
  }
  for (const node of nodes) includeBox(bounds, node.box);
  for (const edge of edges) {
    for (const point of edge.points) includePoint(bounds, point, 1);
    const label = edgeLabelBounds(edge);
    if (label) includeBox(bounds, label);
    if (edge.kind !== "none" && edge.points.length >= 2) {
      const last = edge.points[edge.points.length - 1]!;
      const prev = edge.points[edge.points.length - 2]!;
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      const length = Math.hypot(dx, dy) || 1;
      includePoint(bounds, { x: last.x + (dx / length) * 2, y: last.y + (dy / length) * 2 }, 2.5);
    }
  }
  return bounds;
}

function shiftBox(box: Box, dx: number, dy: number): Box {
  return { x: round(box.x + dx), y: round(box.y + dy), width: box.width, height: box.height };
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

  const firstPass = (() => {
    try {
      return elkLayoutSync(buildElkGraph(diagram, options));
    } catch (error) {
      throw routingError(error instanceof Error ? error.message : "ELK swimlane layout failed");
    }
  })();
  const firstHarvest: HarvestedLayout = { boxes: new Map(), ports: new Map(), sections: new Map() };
  harvest(firstPass, 0, 0, firstHarvest);
  const firstNodes: PositionedNode[] = diagram.nodes.map((node) => {
    const box = firstHarvest.boxes.get(node.id);
    if (!box) throw routingError(`Missing ELK box for ${node.id}`);
    return { ...node, box };
  });
  const assignments = planEdgeSides(diagram, firstNodes, diagram.direction);

  let result: ElkNode;
  try {
    result = elkLayoutSync(buildElkGraph(diagram, options, assignments));
  } catch (error) {
    throw routingError(error instanceof Error ? error.message : "ELK swimlane layout failed");
  }

  const harvested: HarvestedLayout = { boxes: new Map(), ports: new Map(), sections: new Map() };
  harvest(result, 0, 0, harvested);

  const nodes: PositionedNode[] = diagram.nodes.map((node) => {
    const box = harvested.boxes.get(node.id);
    if (!box) throw routingError(`Missing ELK box for ${node.id}`);
    return { ...node, box };
  });
  const byId = new Map(nodes.map((node) => [node.id, node] as const));

  const rawLanes: PositionedLane[] = diagram.lanes.map((lane) => {
    const box = harvested.boxes.get(`${LANE_PREFIX}${lane.id}`);
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
  const routePlan: PlannedEdgeRoute[] = diagram.edges.map((edge) => {
    const assignment = assignments.get(edge.id)!;
    if (assignment.feedback) feedback.add(edge.id);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const fromRaw = harvested.ports.get(`${PORT_PREFIX}${edge.id}_s`);
    const toRaw = harvested.ports.get(`${PORT_PREFIX}${edge.id}_t`);
    return {
      edgeId: edge.id,
      from: assignment.from,
      to: assignment.to,
      feedback: assignment.feedback,
      selfLoop: assignment.selfLoop,
      fromPort:
        source && fromRaw
          ? projectPort(source.box, assignment.from, source.shape, fromRaw)
          : undefined,
      toPort:
        target && toRaw ? projectPort(target.box, assignment.to, target.shape, toRaw) : undefined,
      elkPoints: harvested.sections.get(edge.id),
    };
  });

  const routedResult = routeEdges(diagram, draft, feedback, 0, routePlan);
  const routed: RoutedEdge[] = routedResult.edges.map((edge) => ({
    ...edge,
    points: collapse(edge.points.map(roundPoint)),
  }));

  const bounds = contentBounds(lanes, nodes, routed);
  const margin = (options.padding ?? SWL_LAYOUT.padding) / 2;
  const finite = Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY);
  const shiftX = finite ? Math.max(0, margin - bounds.minX) : 0;
  const shiftY = finite ? Math.max(0, margin - bounds.minY) : 0;
  const shiftedLanes = shiftX === 0 && shiftY === 0
    ? lanes
    : lanes.map((lane) => ({
        ...lane,
        box: shiftBox(lane.box, shiftX, shiftY),
        headerBox: shiftBox(lane.headerBox, shiftX, shiftY),
      }));
  const shiftedNodes = shiftX === 0 && shiftY === 0
    ? nodes
    : nodes.map((node) => ({ ...node, box: shiftBox(node.box, shiftX, shiftY) }));
  const shiftedEdges = shiftX === 0 && shiftY === 0
    ? routed
    : routed.map((edge) => ({
        ...edge,
        points: edge.points.map((point) => ({
          x: round(point.x + shiftX),
          y: round(point.y + shiftY),
        })),
        labelBox: edge.labelBox ? shiftBox(edge.labelBox, shiftX, shiftY) : undefined,
      }));

  const width = finite ? round(bounds.maxX + shiftX + margin) : round(margin * 2);
  const height = finite ? round(bounds.maxY + shiftY + margin) : round(margin * 2);

  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
    direction: diagram.direction,
    lanes: shiftedLanes,
    nodes: shiftedNodes,
    edges: shiftedEdges,
    reroutedEdges: routedResult.reroutedEdges,
    overlappingEdges: routedResult.overlappingEdges,
  };
}
