/**
 * Geometry helpers shared by the swimlane routing regression tests.
 *
 * These helpers deliberately parse the rendered SVG through attribute
 * matching instead of a regex that depends on attribute order, so an
 * extraction bug cannot silently degrade into "zero edges, all green".
 */
import { FONT_SIZES } from "../../styles.ts";
import { measureMultilineText } from "../../text-metrics.ts";
import type {
  Box,
  PositionedNode,
  RoutedEdge,
  SwimlaneLayout,
} from "../../swimlane/types.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Side = "N" | "S" | "E" | "W";

export interface SvgEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly Point[];
}

export interface SvgNode {
  readonly id: string;
  readonly shape: string;
  readonly box: Box;
}

export interface Endpoint {
  readonly edgeId: string;
  readonly nodeId: string;
  readonly kind: "source" | "target";
  readonly shape: string;
  readonly box: Box;
  readonly side: Side;
  readonly point: Point;
}

export interface Penetration {
  readonly edgeId: string;
  readonly nodeId: string;
  readonly segment: number;
  readonly length: number;
}

export interface Overlap {
  readonly a: string;
  readonly b: string;
  readonly axis: "x" | "y";
  readonly length: number;
  readonly offset: number;
}

export interface DuplicateEndpoint {
  readonly nodeId: string;
  readonly side: Side;
  readonly point: Point;
  readonly edgeIds: readonly string[];
}

export interface BoxIssue {
  readonly id: string;
  readonly kind: "edge" | "label" | "arrow";
  readonly box: Box;
}

const EPS = 0.25;

/** Parse the attributes of a single SVG tag without relying on attribute order. */
export function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  for (const match of tag.matchAll(re)) attrs[match[1]!] = match[2]!;
  return attrs;
}

/** Every `<path>` that carries `data-edge-id`, independent of attribute order. */
export function extractSvgEdges(svg: string): SvgEdge[] {
  const out: SvgEdge[] = [];
  for (const match of svg.matchAll(/<path\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0]);
    if (!attrs["data-edge-id"]) continue;
    out.push({
      id: attrs["data-edge-id"]!,
      from: attrs["data-from"] ?? "",
      to: attrs["data-to"] ?? "",
      points: parsePathPoints(attrs["d"] ?? ""),
    });
  }
  return out;
}

export function parsePathPoints(d: string): Point[] {
  const points: Point[] = [];
  const re = /([ML])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
  for (const match of d.matchAll(re)) {
    points.push({ x: Number(match[2]), y: Number(match[3]) });
  }
  return points;
}

/** Every `<g data-node-id=...>` shape, reduced to its bounding box. */
export function extractSvgNodes(svg: string): SvgNode[] {
  const out: SvgNode[] = [];
  for (const match of svg.matchAll(/<g\b[^>]*\bdata-node-id="[^"]*"[^>]*>/g)) {
    const attrs = parseAttributes(match[0]);
    const id = attrs["data-node-id"]!;
    const shape = attrs["data-shape"] ?? "rectangle";
    const rest = svg.slice(match.index! + match[0].length);
    const body = rest.slice(0, rest.indexOf("</g>"));
    const box = shapeBox(body);
    if (box) out.push({ id, shape, box });
  }
  return out;
}

export function extractSvgLanes(svg: string): { id: string; box: Box }[] {
  const out: { id: string; box: Box }[] = [];
  for (const match of svg.matchAll(/<g\b[^>]*\bdata-lane-id="[^"]*"[^>]*>/g)) {
    const attrs = parseAttributes(match[0]);
    const rest = svg.slice(match.index! + match[0].length);
    const body = rest.slice(0, rest.indexOf("</g>"));
    const rect = body.match(/<rect\b[^>]*>/);
    if (!rect) continue;
    const rattrs = parseAttributes(rect[0]);
    out.push({
      id: attrs["data-lane-id"]!,
      box: {
        x: Number(rattrs["x"]),
        y: Number(rattrs["y"]),
        width: Number(rattrs["width"]),
        height: Number(rattrs["height"]),
      },
    });
  }
  return out;
}

function shapeBox(body: string): Box | undefined {
  const rect = body.match(/<rect\b[^>]*>/);
  if (rect) {
    const attrs = parseAttributes(rect[0]);
    return {
      x: Number(attrs["x"]),
      y: Number(attrs["y"]),
      width: Number(attrs["width"]),
      height: Number(attrs["height"]),
    };
  }
  const circle = body.match(/<circle\b[^>]*>/);
  if (circle) {
    const attrs = parseAttributes(circle[0]);
    const cx = Number(attrs["cx"]);
    const cy = Number(attrs["cy"]);
    const r = Number(attrs["r"]);
    return { x: cx - r, y: cy - r, width: r * 2, height: r * 2 };
  }
  const polygon = body.match(/<polygon\b[^>]*>/);
  if (polygon) {
    const attrs = parseAttributes(polygon[0]);
    const nums = [...(attrs["points"] ?? "").matchAll(/(-?\d+(?:\.\d+)?)/g)].map((item) =>
      Number(item[1]),
    );
    if (nums.length < 6) return undefined;
    const xs = nums.filter((_, index) => index % 2 === 0);
    const ys = nums.filter((_, index) => index % 2 === 1);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return undefined;
}

export function extractViewBox(svg: string): Box {
  const attrs = parseAttributes(svg.slice(0, svg.indexOf(">") + 1));
  const parts = (attrs["viewBox"] ?? "").trim().split(/\s+/).map(Number);
  const [x, y, width, height] = parts;
  return { x: x!, y: y!, width: width!, height: height! };
}

export function nearestSide(box: Box, point: Point): Side {
  const distances: [Side, number][] = [
    ["W", Math.abs(point.x - box.x)],
    ["E", Math.abs(point.x - (box.x + box.width))],
    ["N", Math.abs(point.y - box.y)],
    ["S", Math.abs(point.y - (box.y + box.height))],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0]![0];
}

export function edgesByNode(node: PositionedNode, edges: readonly RoutedEdge[]): Endpoint[] {
  const out: Endpoint[] = [];
  for (const edge of edges) {
    if (edge.points.length < 2) continue;
    if (edge.source === node.id) {
      out.push({
        edgeId: edge.id,
        nodeId: node.id,
        kind: "source",
        shape: node.shape,
        box: node.box,
        side: nearestSide(node.box, edge.points[0]!),
        point: edge.points[0]!,
      });
    }
    if (edge.target === node.id) {
      const last = edge.points[edge.points.length - 1]!;
      out.push({
        edgeId: edge.id,
        nodeId: node.id,
        kind: "target",
        shape: node.shape,
        box: node.box,
        side: nearestSide(node.box, last),
        point: last,
      });
    }
  }
  return out;
}

/**
 * Endpoints of distinct edges that attach to the same node side at the very
 * same point. These are visually indistinguishable and defeat the arrowhead.
 */
export function duplicateEndpoints(
  layout: SwimlaneLayout,
  tolerance = 0.6,
): DuplicateEndpoint[] {
  const groups: DuplicateEndpoint[] = [];
  for (const node of layout.nodes) {
    const endpoints = edgesByNode(node, layout.edges);
    const bySide = new Map<Side, Endpoint[]>();
    for (const endpoint of endpoints) {
      const list = bySide.get(endpoint.side) ?? [];
      list.push(endpoint);
      bySide.set(endpoint.side, list);
    }
    for (const [side, list] of bySide) {
      const used = new Set<number>();
      for (let i = 0; i < list.length; i += 1) {
        if (used.has(i)) continue;
        const cluster = [i];
        for (let j = i + 1; j < list.length; j += 1) {
          if (used.has(j)) continue;
          const a = list[i]!.point;
          const b = list[j]!.point;
          if (Math.hypot(a.x - b.x, a.y - b.y) <= tolerance) {
            used.add(j);
            cluster.push(j);
          }
        }
        if (cluster.length < 2) continue;
        used.add(i);
        groups.push({
          nodeId: node.id,
          side,
          point: list[i]!.point,
          edgeIds: cluster.map((index) => list[index]!.edgeId),
        });
      }
    }
  }
  return groups;
}

/** Minimum distance between two attaching endpoints on the same node side. */
export function minEndpointSeparation(
  layout: SwimlaneLayout,
): { nodeId: string; side: Side; separation: number; edges: [string, string] } | undefined {
  let best: { nodeId: string; side: Side; separation: number; edges: [string, string] } | undefined;
  for (const node of layout.nodes) {
    const endpoints = edgesByNode(node, layout.edges);
    const bySide = new Map<Side, Endpoint[]>();
    for (const endpoint of endpoints) {
      const list = bySide.get(endpoint.side) ?? [];
      list.push(endpoint);
      bySide.set(endpoint.side, list);
    }
    for (const [side, list] of bySide) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]!.point;
          const b = list[j]!.point;
          const separation = Math.hypot(a.x - b.x, a.y - b.y);
          if (!best || separation < best.separation) {
            best = {
              nodeId: node.id,
              side,
              separation,
              edges: [list[i]!.edgeId, list[j]!.edgeId],
            };
          }
        }
      }
    }
  }
  return best;
}

export function endpointsOnOutline(
  layout: SwimlaneLayout,
  tolerance = 1.5,
): { edgeId: string; nodeId: string; kind: "source" | "target"; distance: number }[] {
  const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
  const bad: { edgeId: string; nodeId: string; kind: "source" | "target"; distance: number }[] = [];
  for (const edge of layout.edges) {
    if (edge.points.length < 2) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source) {
      const distance = distanceToShapeOutline(source, edge.points[0]!);
      if (distance > tolerance) {
        bad.push({ edgeId: edge.id, nodeId: source.id, kind: "source", distance });
      }
    }
    if (target) {
      const distance = distanceToShapeOutline(target, edge.points[edge.points.length - 1]!);
      if (distance > tolerance) {
        bad.push({ edgeId: edge.id, nodeId: target.id, kind: "target", distance });
      }
    }
  }
  return bad;
}

export function distanceToShapeOutline(node: PositionedNode, point: Point): number {
  const box = node.box;
  switch (node.shape) {
    case "diamond": {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const hw = box.width / 2;
      const hh = box.height / 2;
      const value = Math.abs(point.x - cx) / hw + Math.abs(point.y - cy) / hh;
      // Distance to the boundary along the scaled L1 metric, converted to px.
      return Math.abs(value - 1) * Math.min(hw, hh);
    }
    case "circle": {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const r = Math.min(box.width, box.height) / 2;
      return Math.abs(Math.hypot(point.x - cx, point.y - cy) - r);
    }
    case "stadium":
    case "rounded": {
      const radius = node.shape === "stadium" ? box.height / 2 : 6;
      const inner = {
        x: box.x + radius,
        y: box.y + radius,
        width: Math.max(0, box.width - radius * 2),
        height: Math.max(0, box.height - radius * 2),
      };
      return Math.abs(distancePointToBox(point, inner) - radius);
    }
    default: {
      const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
      const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
      if (dx === 0 && dy === 0) {
        return Math.min(
          point.x - box.x,
          box.x + box.width - point.x,
          point.y - box.y,
          box.y + box.height - point.y,
        );
      }
      return Math.hypot(dx, dy);
    }
  }
}

/**
 * Segments that pass through the *interior* of a node shape. Contact with the
 * edge's own source/target node is legitimate and therefore excluded.
 */
export function nodePenetrations(layout: SwimlaneLayout): Penetration[] {
  const out: Penetration[] = [];
  for (const edge of layout.edges) {
    if (edge.points.length < 2) continue;
    const mine = new Set([edge.source, edge.target]);
    for (const node of layout.nodes) {
      if (mine.has(node.id)) continue;
      for (let i = 0; i < edge.points.length - 1; i += 1) {
        const length = interiorOverlap(edge.points[i]!, edge.points[i + 1]!, node);
        if (length > 0) {
          out.push({ edgeId: edge.id, nodeId: node.id, segment: i, length });
        }
      }
    }
  }
  return out;
}

/** Length (in px) of the sub-segment that lies strictly inside the shape. */
export function interiorOverlap(a: Point, b: Point, node: PositionedNode): number {
  const box = node.box;
  switch (node.shape) {
    case "diamond":
      return clipDiamond(a, b, box, EPS);
    case "circle":
      return clipCircle(a, b, box, EPS);
    case "stadium":
      return clipRounded(a, b, box, box.height / 2, EPS);
    case "rounded":
      return clipRounded(a, b, box, 6, EPS);
    default:
      return clipRect(a, b, box, EPS);
  }
}

function clipInterval(
  a: Point,
  b: Point,
  constraints: { a: number; b: number; c: number }[],
): number {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const constraint of constraints) {
    // constraint.a * x(t) + constraint.b * y(t) <= constraint.c
    const p = constraint.a * dx + constraint.b * dy;
    const q = constraint.c - constraint.a * a.x - constraint.b * a.y;
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return 0;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return 0;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return 0;
      if (r < t1) t1 = r;
    }
  }
  if (t1 <= t0) return 0;
  return (t1 - t0) * Math.hypot(dx, dy);
}

function clipRect(a: Point, b: Point, box: Box, eps: number): number {
  const x0 = box.x + eps;
  const x1 = box.x + box.width - eps;
  const y0 = box.y + eps;
  const y1 = box.y + box.height - eps;
  if (x1 <= x0 || y1 <= y0) return 0;
  // |-1 0| * (x,y) <= -x0  →  -x <= -x0  →  x >= x0
  return clipInterval(a, b, [
    { a: -1, b: 0, c: -x0 },
    { a: 1, b: 0, c: x1 },
    { a: 0, b: -1, c: -y0 },
    { a: 0, b: 1, c: y1 },
  ]);
}

function clipDiamond(a: Point, b: Point, box: Box, eps: number): number {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const hw = box.width / 2;
  const hh = box.height / 2;
  const limit = 1 - eps / Math.min(hw, hh);
  if (limit <= 0) return 0;
  const sx = 1 / hw;
  const sy = 1 / hh;
  const ox = -cx / hw;
  const oy = -cy / hh;
  return clipInterval(a, b, [
    { a: sx, b: sy, c: limit - ox - oy },
    { a: -sx, b: sy, c: limit + ox - oy },
    { a: sx, b: -sy, c: limit - ox + oy },
    { a: -sx, b: -sy, c: limit + ox + oy },
  ]);
}

function clipCircle(a: Point, b: Point, box: Box, eps: number): number {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = Math.min(box.width, box.height) / 2 - eps;
  if (r <= 0) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - cx;
  const fy = a.y - cy;
  const qa = dx * dx + dy * dy;
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - r * r;
  if (qa < 1e-12) return qc < 0 ? 1 : 0;
  const disc = qb * qb - 4 * qa * qc;
  if (disc <= 0) return 0;
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, (-qb - root) / (2 * qa));
  const t1 = Math.min(1, (-qb + root) / (2 * qa));
  if (t1 <= t0) return 0;
  return (t1 - t0) * Math.sqrt(qa);
}

/** Distance from a point to an axis-aligned solid box (0 when inside). */
export function distancePointToBox(point: Point, box: Box): number {
  const dx = Math.max(box.x - point.x, point.x - (box.x + box.width), 0);
  const dy = Math.max(box.y - point.y, point.y - (box.y + box.height), 0);
  return Math.hypot(dx, dy);
}

function clipRounded(a: Point, b: Point, box: Box, radius: number, eps: number): number {
  const inner = {
    x: box.x + radius,
    y: box.y + radius,
    width: Math.max(0, box.width - radius * 2),
    height: Math.max(0, box.height - radius * 2),
  };
  const limit = radius - eps;
  if (limit <= 0) return 0;
  const distance = segmentBoxDistance(a, b, inner);
  if (distance >= limit) return 0;
  // Approximate the shared length: measure the fraction of the segment that is
  // inside the rounded shape by sampling at 0.25px resolution.
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1e-9) return 0;
  const steps = Math.max(2, Math.ceil(length / 0.25));
  let inside = 0;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (distancePointToBox(point, inner) < limit) inside += 1;
  }
  return (inside / (steps + 1)) * length;
}

export function segmentBoxDistance(a: Point, b: Point, box: Box): number {
  if (segmentIntersectsBox(a, b, box)) return 0;
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  let best = Infinity;
  for (const corner of corners) best = Math.min(best, pointSegmentDistance(corner, a, b));
  best = Math.min(best, distancePointToBox(a, box), distancePointToBox(b, box));
  return best;
}

function segmentIntersectsBox(a: Point, b: Point, box: Box): boolean {
  return clipRect(a, b, box, 0) > 0;
}

export function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 < 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/**
 * Pairs of edge segments that run on the same track: collinear within
 * `lateral` px and overlapping for more than `minLength` px.
 */
export function collinearOverlaps(
  layout: SwimlaneLayout,
  lateral = 1.5,
  minLength = 4,
): Overlap[] {
  const out: Overlap[] = [];
  const edges = layout.edges.filter((edge) => edge.points.length >= 2);
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const a = edges[i]!;
      const b = edges[j]!;
      for (let ai = 0; ai < a.points.length - 1; ai += 1) {
        for (let bi = 0; bi < b.points.length - 1; bi += 1) {
          const overlap = segmentOverlap(
            a.points[ai]!,
            a.points[ai + 1]!,
            b.points[bi]!,
            b.points[bi + 1]!,
            lateral,
          );
          if (overlap && overlap.length > minLength) {
            out.push({ a: a.id, b: b.id, axis: overlap.axis, length: overlap.length, offset: overlap.offset });
          }
        }
      }
    }
  }
  return out;
}

function segmentOverlap(
  p1: Point,
  p2: Point,
  q1: Point,
  q2: Point,
  lateral: number,
): { axis: "x" | "y"; length: number; offset: number } | undefined {
  const pH = Math.abs(p1.y - p2.y) < 0.5;
  const qH = Math.abs(q1.y - q2.y) < 0.5;
  const pV = Math.abs(p1.x - p2.x) < 0.5;
  const qV = Math.abs(q1.x - q2.x) < 0.5;
  if (pH && qH) {
    const offset = Math.abs(p1.y - q1.y);
    if (offset > lateral) return undefined;
    const length = intervalOverlap(p1.x, p2.x, q1.x, q2.x);
    return length > 0 ? { axis: "x", length, offset } : undefined;
  }
  if (pV && qV) {
    const offset = Math.abs(p1.x - q1.x);
    if (offset > lateral) return undefined;
    const length = intervalOverlap(p1.y, p2.y, q1.y, q2.y);
    return length > 0 ? { axis: "y", length, offset } : undefined;
  }
  return undefined;
}

function intervalOverlap(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return Math.max(0, hi - lo);
}

/** The background rectangle the renderer draws behind an edge label. */
export function renderedLabelBox(edge: RoutedEdge): Box | undefined {
  if (!edge.label) return undefined;
  const metrics = measureMultilineText(edge.label, FONT_SIZES.edgeLabel, 500);
  const center = edge.labelBox
    ? { x: edge.labelBox.x + edge.labelBox.width / 2, y: edge.labelBox.y + edge.labelBox.height / 2 }
    : edge.points[Math.floor(edge.points.length / 2)];
  if (!center) return undefined;
  return {
    x: center.x - (metrics.width + 16) / 2,
    y: center.y - (metrics.height + 16) / 2,
    width: metrics.width + 16,
    height: metrics.height + 16,
  };
}

export function outsideViewBox(
  layout: SwimlaneLayout,
  viewBox: Box,
  arrowLength = 1.5,
): BoxIssue[] {
  const issues: BoxIssue[] = [];
  const inside = (box: Box, id: string, kind: BoxIssue["kind"]): void => {
    if (
      box.x < viewBox.x - 0.01 ||
      box.y < viewBox.y - 0.01 ||
      box.x + box.width > viewBox.x + viewBox.width + 0.01 ||
      box.y + box.height > viewBox.y + viewBox.height + 0.01
    ) {
      issues.push({ id, kind, box });
    }
  };
  for (const edge of layout.edges) {
    for (const point of edge.points) {
      inside({ x: point.x, y: point.y, width: 0, height: 0 }, edge.id, "edge");
    }
    const last = edge.points[edge.points.length - 1];
    const prev = edge.points[edge.points.length - 2];
    if (last && prev && edge.kind !== "none") {
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      const length = Math.hypot(dx, dy) || 1;
      const tip = { x: last.x + (dx / length) * arrowLength, y: last.y + (dy / length) * arrowLength };
      inside({ x: tip.x - 2.5, y: tip.y - 2.5, width: 5, height: 5 }, `${edge.id}:arrow`, "arrow");
    }
    const label = renderedLabelBox(edge);
    if (label) inside(label, `${edge.id}:label`, "label");
  }
  return issues;
}

export function layoutSignature(layout: SwimlaneLayout): string {
  const round = (value: number): number => Math.round(value * 100) / 100;
  return JSON.stringify({
    width: round(layout.width),
    height: round(layout.height),
    nodes: layout.nodes.map((node) => ({
      id: node.id,
      box: {
        x: round(node.box.x),
        y: round(node.box.y),
        width: round(node.box.width),
        height: round(node.box.height),
      },
    })),
    edges: layout.edges.map((edge) => ({
      id: edge.id,
      points: edge.points.map((point) => ({ x: round(point.x), y: round(point.y) })),
      labelBox: edge.labelBox
        ? {
            x: round(edge.labelBox.x),
            y: round(edge.labelBox.y),
            width: round(edge.labelBox.width),
            height: round(edge.labelBox.height),
          }
        : undefined,
    })),
  });
}
