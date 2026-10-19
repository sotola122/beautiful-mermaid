import { DiagramRenderError } from "../errors.ts";
import { FONT_SIZES } from "../styles.ts";
import { measureMultilineText } from "../text-metrics.ts";
import type {
  Box,
  PositionedNode,
  RoutedEdge,
  SwimlaneDiagram,
  SwimlaneLayout,
  SwimlaneRoutePlan,
  SwimlaneSide,
} from "./types.ts";

export const SWL_E_ROUTING = "SWL_E_ROUTING";

const CLEAR = 8;
const LOOP = 18;
const BEND_COST = 80;
const ENDPOINT_PAD = 3;

/** Lateral distance at which two parallel edge segments count as one track. */
const TRACK_LATERAL = 1.6;
/** Collinear overlap (px) that makes a route unacceptable. */
const MAX_TRACK_OVERLAP = 4;
/** Relative cost of running along an already accepted track in the A* search. */
const TRACK_WEIGHT = 14;

export type Point = { x: number; y: number };
type Side = SwimlaneSide;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPoint(point: Point): Point {
  return { x: round(point.x), y: round(point.y) };
}

function inflate(box: Box, pad = CLEAR): Box {
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

function containsPoint(box: Box, point: Point, pad = 0.5): boolean {
  return (
    point.x > box.x + pad &&
    point.x < box.x + box.width - pad &&
    point.y > box.y + pad &&
    point.y < box.y + box.height - pad
  );
}

function segmentBox(p: Point, q: Point): Box {
  return {
    x: Math.min(p.x, q.x) - 0.75,
    y: Math.min(p.y, q.y) - 0.75,
    width: Math.abs(q.x - p.x) + 1.5,
    height: Math.abs(q.y - p.y) + 1.5,
  };
}

export function segmentHits(obstacles: readonly Box[], p: Point, q: Point): boolean {
  const seg = segmentBox(p, q);
  return obstacles.some((box) => overlaps(box, seg));
}

function pathHits(obstacles: readonly Box[], points: readonly Point[]): boolean {
  for (let i = 0; i < points.length - 1; i += 1) {
    if (segmentHits(obstacles, points[i]!, points[i + 1]!)) return true;
  }
  return false;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map(round))].sort((a, b) => a - b);
}

/**
 * Collinear edge segments already used by accepted routes.
 *
 * Indexed in 2px buckets so the A* search can penalise sharing a track without
 * scanning every accepted edge.
 */
export class TrackIndex {
  private readonly horizontal = new Map<number, { key: number; min: number; max: number }[]>();
  private readonly vertical = new Map<number, { key: number; min: number; max: number }[]>();

  add(points: readonly Point[]): void {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      if (Math.abs(a.y - b.y) < 0.5) {
        this.push(this.horizontal, a.y, Math.min(a.x, b.x), Math.max(a.x, b.x));
      } else if (Math.abs(a.x - b.x) < 0.5) {
        this.push(this.vertical, a.x, Math.min(a.y, b.y), Math.max(a.y, b.y));
      }
    }
  }

  private push(
    map: Map<number, { key: number; min: number; max: number }[]>,
    key: number,
    min: number,
    max: number,
  ): void {
    const bucket = Math.round(key / 2);
    const list = map.get(bucket) ?? [];
    list.push({ key, min, max });
    map.set(bucket, list);
  }

  /** Longest overlap with an existing track for the segment p→q. */
  stepOverlap(p: Point, q: Point): number {
    const horizontal = Math.abs(p.y - q.y) < 0.5;
    const vertical = Math.abs(p.x - q.x) < 0.5;
    if (!horizontal && !vertical) return 0;
    const key = horizontal ? p.y : p.x;
    const map = horizontal ? this.horizontal : this.vertical;
    const lo = horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
    const hi = horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
    let best = 0;
    const bucket = Math.round(key / 2);
    for (let offset = -1; offset <= 1; offset += 1) {
      for (const track of map.get(bucket + offset) ?? []) {
        if (Math.abs(track.key - key) > TRACK_LATERAL) continue;
        const overlap = Math.max(0, Math.min(hi, track.max) - Math.max(lo, track.min));
        if (overlap > best) best = overlap;
      }
    }
    return best;
  }

  /** Total collinear overlap of a whole polyline with accepted tracks. */
  routeOverlap(points: readonly Point[]): number {
    let total = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      total += this.stepOverlap(points[i]!, points[i + 1]!);
    }
    return total;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

export function flowSides(direction: SwimlaneLayout["direction"]): { from: Side; to: Side } {
  switch (direction) {
    case "RL":
      return { from: "W", to: "E" };
    case "BT":
      return { from: "N", to: "S" };
    case "TB":
      return { from: "S", to: "N" };
    default:
      return { from: "E", to: "W" };
  }
}

function facingSides(from: Box, to: Box): { from: Side; to: Side } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: "E", to: "W" } : { from: "W", to: "E" };
  }
  return dy >= 0 ? { from: "S", to: "N" } : { from: "N", to: "S" };
}

function chainSides(
  direction: SwimlaneLayout["direction"],
  source: PositionedNode,
  target: PositionedNode,
  feedback: boolean,
): { from: Side; to: Side } {
  const flow = flowSides(direction);
  if (feedback) return { from: flow.to, to: flow.from };
  if (source.laneId === target.laneId) return flow;
  return facingSides(source.box, target.box);
}

function sideSpan(box: Box, side: Side): number {
  return side === "E" || side === "W" ? box.height : box.width;
}

/**
 * Port on a node face. `shift` moves the port along the face so several edges
 * sharing a side stay visually distinct. Diamond and circle shapes apply the
 * same shift along their real outline instead of collapsing onto a vertex.
 */
export function sidePort(box: Box, side: Side, shape: string, shift = 0): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const inset = Math.min(6, box.width / 4, box.height / 4);

  if (shape === "diamond") {
    const hw = box.width / 2;
    const hh = box.height / 2;
    const along = (span: number): number => clamp(0.5 + shift / Math.max(1, span), 0.05, 0.95);
    switch (side) {
      case "E": {
        const t = along(box.height);
        return { x: cx + hw * (1 - 2 * Math.abs(t - 0.5)), y: box.y + box.height * t };
      }
      case "W": {
        const t = along(box.height);
        return { x: cx - hw * (1 - 2 * Math.abs(t - 0.5)), y: box.y + box.height * t };
      }
      case "S": {
        const t = along(box.width);
        return { x: box.x + box.width * t, y: cy + hh * (1 - 2 * Math.abs(t - 0.5)) };
      }
      case "N": {
        const t = along(box.width);
        return { x: box.x + box.width * t, y: cy - hh * (1 - 2 * Math.abs(t - 0.5)) };
      }
    }
  }

  if (shape === "circle") {
    const rx = box.width / 2;
    const ry = box.height / 2;
    switch (side) {
      case "E": {
        const dy = clamp(shift, -ry * 0.85, ry * 0.85);
        return { x: cx + rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2)), y: cy + dy };
      }
      case "W": {
        const dy = clamp(shift, -ry * 0.85, ry * 0.85);
        return { x: cx - rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2)), y: cy + dy };
      }
      case "S": {
        const dx = clamp(shift, -rx * 0.85, rx * 0.85);
        return { x: cx + dx, y: cy + ry * Math.sqrt(Math.max(0, 1 - (dx / rx) ** 2)) };
      }
      case "N": {
        const dx = clamp(shift, -rx * 0.85, rx * 0.85);
        return { x: cx + dx, y: cy - ry * Math.sqrt(Math.max(0, 1 - (dx / rx) ** 2)) };
      }
    }
  }

  if (shape === "stadium") {
    const r = box.height / 2;
    if (side === "E" || side === "W") {
      const y = clamp(cy + shift, box.y + 2, box.y + box.height - 2);
      const dy = y - cy;
      const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
      return side === "W"
        ? { x: box.x + r - dx, y }
        : { x: box.x + box.width - r + dx, y };
    }
    const x = clamp(cx + shift, box.x + r, box.x + box.width - r);
    return { x, y: side === "N" ? box.y : box.y + box.height };
  }

  if (side === "E" || side === "W") {
    const y = clamp(cy + shift, box.y + inset, box.y + box.height - inset);
    return { x: side === "W" ? box.x : box.x + box.width, y };
  }
  const x = clamp(cx + shift, box.x + inset, box.x + box.width - inset);
  return { x, y: side === "N" ? box.y : box.y + box.height };
}

/** Evenly spread port offsets for `count` attachments on one node face. */
export function sidePortOffsets(count: number, box: Box, side: Side): number[] {
  if (count <= 0) return [];
  const span = sideSpan(box, side);
  const inset = Math.min(6, span / 4);
  const usable = Math.max(0, span - inset * 2);
  const step = count > 1 ? usable / count : 0;
  return Array.from({ length: count }, (_, index) => (index - (count - 1) / 2) * step);
}

/**
 * Project a port that ELK placed on a node's bounding box onto the real shape
 * outline, keeping the approach axis so orthogonality is preserved.
 */
export function projectPort(box: Box, side: Side, shape: string, point: Point): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  switch (shape) {
    case "diamond": {
      const hw = box.width / 2;
      const hh = box.height / 2;
      if (side === "E" || side === "W") {
        const t = clamp(0.5 + (point.y - cy) / box.height, 0.05, 0.95);
        const reach = hw * (1 - 2 * Math.abs(t - 0.5));
        return { x: side === "E" ? cx + reach : cx - reach, y: box.y + box.height * t };
      }
      const t = clamp(0.5 + (point.x - cx) / box.width, 0.05, 0.95);
      const reach = hh * (1 - 2 * Math.abs(t - 0.5));
      return { x: box.x + box.width * t, y: side === "S" ? cy + reach : cy - reach };
    }
    case "circle": {
      const rx = box.width / 2;
      const ry = box.height / 2;
      if (side === "E" || side === "W") {
        const dy = clamp(point.y - cy, -ry * 0.98, ry * 0.98);
        const reach = rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2));
        return { x: side === "E" ? cx + reach : cx - reach, y: cy + dy };
      }
      const dx = clamp(point.x - cx, -rx * 0.98, rx * 0.98);
      const reach = ry * Math.sqrt(Math.max(0, 1 - (dx / rx) ** 2));
      return { x: cx + dx, y: side === "S" ? cy + reach : cy - reach };
    }
    case "stadium":
    case "rounded": {
      const radius = shape === "stadium" ? box.height / 2 : 6;
      const straight =
        side === "E" || side === "W"
          ? Math.max(0, box.height / 2 - radius)
          : Math.max(0, box.width / 2 - radius);
      if (side === "E" || side === "W") {
        const dy = clamp(point.y - cy, -box.height / 2, box.height / 2);
        const beyond = Math.max(0, Math.abs(dy) - straight);
        const dx = Math.sqrt(Math.max(0, radius * radius - beyond * beyond));
        return {
          x: side === "E" ? box.x + box.width - radius + dx : box.x + radius - dx,
          y: cy + dy,
        };
      }
      const dx = clamp(point.x - cx, -box.width / 2, box.width / 2);
      const beyond = Math.max(0, Math.abs(dx) - straight);
      const dyArc = Math.sqrt(Math.max(0, radius * radius - beyond * beyond));
      return {
        x: cx + dx,
        y: side === "S" ? box.y + box.height - radius + dyArc : box.y + radius - dyArc,
      };
    }
    default: {
      if (side === "E" || side === "W") {
        const y = clamp(point.y, box.y + 0.5, box.y + box.height - 0.5);
        return { x: side === "E" ? box.x + box.width : box.x, y };
      }
      const x = clamp(point.x, box.x + 0.5, box.x + box.width - 0.5);
      return { x, y: side === "S" ? box.y + box.height : box.y };
    }
  }
}

function outerStub(portPoint: Point, side: Side, dist = CLEAR): Point {
  switch (side) {
    case "E":
      return { x: portPoint.x + dist, y: portPoint.y };
    case "W":
      return { x: portPoint.x - dist, y: portPoint.y };
    case "S":
      return { x: portPoint.x, y: portPoint.y + dist };
    case "N":
      return { x: portPoint.x, y: portPoint.y - dist };
  }
}

/**
 * Distance the search stub must travel to clear the node's own padded bounding
 * box. Diamond, circle and stadium ports sit inside their bounding box, so a
 * fixed 8px stub would start the A* search inside the node itself.
 */
function stubDistance(point: Point, side: Side, box: Box): number {
  switch (side) {
    case "E":
      return Math.max(CLEAR, box.x + box.width + ENDPOINT_PAD + CLEAR - point.x);
    case "W":
      return Math.max(CLEAR, point.x - (box.x - ENDPOINT_PAD - CLEAR));
    case "S":
      return Math.max(CLEAR, box.y + box.height + ENDPOINT_PAD + CLEAR - point.y);
    case "N":
      return Math.max(CLEAR, point.y - (box.y - ENDPOINT_PAD - CLEAR));
  }
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
  // Remove spikes: a point that doubles back over the segment it came from is
  // never needed and would draw a visible hook at the arrowhead.
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    for (let i = 1; i < out.length - 1; i += 1) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      const next = out[i + 1]!;
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
      if ((colinearX || colinearY) && !between) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function keyOf(x: number, y: number): string {
  return `${round(x)},${round(y)}`;
}

/**
 * Orthogonal A* / Dijkstra on a sparse channel graph.
 * Vertices are intersections of candidate X/Y channels. Edges exist only when
 * the orthogonal segment does not hit an obstacle.
 */
export function findOrthogonalPath(
  start: Point,
  goal: Point,
  obstacles: readonly Box[],
  xs: readonly number[],
  ys: readonly number[],
  tracks?: TrackIndex,
): Point[] | null {
  start = { x: round(start.x), y: round(start.y) };
  goal = { x: round(goal.x), y: round(goal.y) };
  const gridX = uniqueSorted([...xs, start.x, goal.x]);
  const gridY = uniqueSorted([...ys, start.y, goal.y]);
  if (gridX.length === 0 || gridY.length === 0) return null;

  const startKey = keyOf(start.x, start.y);
  const goalKey = keyOf(goal.x, goal.y);
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const dirOf = new Map<string, "H" | "V" | "S">();
  dist.set(startKey, 0);
  dirOf.set(startKey, "S");

  const heap: { key: string; x: number; y: number; cost: number }[] = [
    { key: startKey, x: start.x, y: start.y, cost: 0 },
  ];
  const seen = new Set<string>();

  const siftUp = (index: number) => {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]!.cost <= heap[index]!.cost) break;
      const tmp = heap[parent]!;
      heap[parent] = heap[index]!;
      heap[index] = tmp;
      index = parent;
    }
  };
  const siftDown = (index: number) => {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && heap[left]!.cost < heap[smallest]!.cost) smallest = left;
      if (right < heap.length && heap[right]!.cost < heap[smallest]!.cost) smallest = right;
      if (smallest === index) break;
      const tmp = heap[index]!;
      heap[index] = heap[smallest]!;
      heap[smallest] = tmp;
      index = smallest;
    }
  };
  const push = (x: number, y: number, cost: number, parent: string, dir: "H" | "V") => {
    const key = keyOf(x, y);
    const prevCost = dist.get(key);
    if (prevCost !== undefined && prevCost <= cost) return;
    dist.set(key, cost);
    prev.set(key, parent);
    dirOf.set(key, dir);
    heap.push({ key, x, y, cost });
    siftUp(heap.length - 1);
  };

  while (heap.length) {
    const current = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      siftDown(0);
    }
    if (seen.has(current.key)) continue;
    seen.add(current.key);
    if (current.key === goalKey) break;

    const incoming = dirOf.get(current.key) ?? "S";
    const xi = gridX.indexOf(round(current.x));
    const yi = gridY.indexOf(round(current.y));
    const neighbors: { x: number; y: number; dir: "H" | "V" }[] = [];
    if (xi >= 0) {
      if (xi > 0) neighbors.push({ x: gridX[xi - 1]!, y: current.y, dir: "H" });
      if (xi < gridX.length - 1) neighbors.push({ x: gridX[xi + 1]!, y: current.y, dir: "H" });
    }
    if (yi >= 0) {
      if (yi > 0) neighbors.push({ x: current.x, y: gridY[yi - 1]!, dir: "V" });
      if (yi < gridY.length - 1) neighbors.push({ x: current.x, y: gridY[yi + 1]!, dir: "V" });
    }

    for (const next of neighbors) {
      const nextKey = keyOf(next.x, next.y);
      if (seen.has(nextKey)) continue;
      const from = { x: current.x, y: current.y };
      if (segmentHits(obstacles, from, next)) continue;
      if (
        nextKey !== goalKey &&
        obstacles.some((box) => containsPoint(box, next))
      ) {
        continue;
      }
      const length =
        Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
      const bend =
        incoming !== "S" && incoming !== next.dir ? BEND_COST : 0;
      const stable = next.dir === "H" ? next.y * 0.001 : next.x * 0.001;
      const shared = tracks?.stepOverlap(from, next) ?? 0;
      const trackCost = shared > 0.5 ? length * TRACK_WEIGHT : 0;
      push(next.x, next.y, current.cost + length + bend + stable + trackCost, current.key, next.dir);
    }
  }

  if (!dist.has(goalKey)) return null;
  const keys: string[] = [goalKey];
  while (keys[0] !== startKey) {
    const parent = prev.get(keys[0]!);
    if (!parent) return null;
    keys.unshift(parent);
  }
  const points = keys.map((key) => {
    const [x, y] = key.split(",").map(Number);
    return { x: x!, y: y! };
  });
  points[0] = { x: start.x, y: start.y };
  points[points.length - 1] = { x: goal.x, y: goal.y };
  return collapse(points);
}

function nearbyObstacles(
  layout: SwimlaneLayout,
  source: PositionedNode,
  target: PositionedNode,
  extraGutter: number,
): readonly PositionedNode[] {
  const pad = CLEAR + extraGutter + 48;
  const left = Math.min(source.box.x, target.box.x) - pad;
  const top = Math.min(source.box.y, target.box.y) - pad;
  const union: Box = {
    x: left,
    y: top,
    width: Math.max(source.box.x + source.box.width, target.box.x + target.box.width) - left + pad,
    height: Math.max(source.box.y + source.box.height, target.box.y + target.box.height) - top + pad,
  };
  const hits = layout.nodes.filter(
    (node) =>
      node.id !== source.id &&
      node.id !== target.id &&
      overlaps(node.box, union),
  );
  if (hits.length <= 16) return hits;
  const sx = source.box.x + source.box.width / 2;
  const sy = source.box.y + source.box.height / 2;
  const tx = target.box.x + target.box.width / 2;
  const ty = target.box.y + target.box.height / 2;
  const dist = (node: PositionedNode): number => {
    const nx = node.box.x + node.box.width / 2;
    const ny = node.box.y + node.box.height / 2;
    const dx = tx - sx;
    const dy = ty - sy;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((nx - sx) * dx + (ny - sy) * dy) / len2));
    return Math.hypot(nx - (sx + dx * t), ny - (sy + dy * t));
  };
  return [...hits].sort((a, b) => dist(a) - dist(b)).slice(0, 16);
}

function channelAxes(
  layout: SwimlaneLayout,
  source: PositionedNode,
  target: PositionedNode,
  extraGutter: number,
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const lane of layout.lanes) {
    xs.push(lane.box.x, lane.box.x + lane.box.width);
    ys.push(lane.headerBox.y + lane.headerBox.height + CLEAR);
  }
  for (const node of [source, target, ...nearbyObstacles(layout, source, target, extraGutter)]) {
    xs.push(
      node.box.x - CLEAR,
      node.box.x + node.box.width / 2,
      node.box.x + node.box.width + CLEAR,
    );
    ys.push(
      node.box.y - CLEAR,
      node.box.y + node.box.height / 2,
      node.box.y + node.box.height + CLEAR,
    );
  }
  const minX = Math.min(...layout.lanes.map((lane) => lane.box.x), source.box.x, target.box.x);
  const maxX = Math.max(
    ...layout.lanes.map((lane) => lane.box.x + lane.box.width),
    source.box.x + source.box.width,
    target.box.x + target.box.width,
  );
  const minY = Math.min(
    ...layout.lanes.map((lane) => lane.box.y),
    source.box.y,
    target.box.y,
  );
  const maxY = Math.max(
    ...layout.lanes.map((lane) => lane.box.y + lane.box.height),
    source.box.y + source.box.height,
    target.box.y + target.box.height,
  );
  xs.push(minX - CLEAR - extraGutter, maxX + CLEAR + extraGutter);
  ys.push(minY - CLEAR - extraGutter, maxY + CLEAR + extraGutter);
  return { xs, ys };
}

interface Ring {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function perimeterCoord(point: Point, ring: Ring): number {
  const width = ring.right - ring.left;
  const height = ring.bottom - ring.top;
  if (Math.abs(point.y - ring.top) < 0.01) return point.x - ring.left;
  if (Math.abs(point.x - ring.right) < 0.01) return width + (point.y - ring.top);
  if (Math.abs(point.y - ring.bottom) < 0.01) return width + height + (ring.right - point.x);
  return 2 * width + height + (ring.bottom - point.y);
}

function ringCorners(ring: Ring): { coord: number; point: Point }[] {
  const width = ring.right - ring.left;
  const height = ring.bottom - ring.top;
  return [
    { coord: 0, point: { x: ring.left, y: ring.top } },
    { coord: width, point: { x: ring.right, y: ring.top } },
    { coord: width + height, point: { x: ring.right, y: ring.bottom } },
    { coord: 2 * width + height, point: { x: ring.left, y: ring.bottom } },
  ];
}

/** Both perimeter walks between two points sitting on the same ring. */
function ringArcs(from: Point, to: Point, ring: Ring): Point[][] {
  const width = ring.right - ring.left;
  const height = ring.bottom - ring.top;
  const perimeter = 2 * (width + height);
  if (perimeter <= 0) return [[from, to]];
  const corners = ringCorners(ring);
  const fromCoord = perimeterCoord(from, ring);
  const toCoord = perimeterCoord(to, ring);

  const collect = (start: number, end: number, forward: boolean): Point[] => {
    const span = forward
      ? end >= start
        ? end - start
        : perimeter - start + end
      : start >= end
        ? start - end
        : perimeter - end + start;
    const points: Point[] = [from];
    const entries: { coord: number; point: Point }[] = [];
    for (const corner of corners) {
      const delta = forward
        ? corner.coord >= start
          ? corner.coord - start
          : perimeter - start + corner.coord
        : corner.coord <= start
          ? start - corner.coord
          : perimeter - corner.coord + start;
      if (delta > 0.01 && delta < span - 0.01) entries.push({ coord: delta, point: corner.point });
    }
    entries.push({ coord: span, point: to });
    entries.sort((a, b) => a.coord - b.coord);
    for (const entry of entries) points.push(entry.point);
    return points;
  };

  return [collect(fromCoord, toCoord, true), collect(fromCoord, toCoord, false)];
}

function ringExit(point: Point, side: Side, ring: Ring): Point {
  switch (side) {
    case "E":
      return { x: ring.right, y: point.y };
    case "W":
      return { x: ring.left, y: point.y };
    case "S":
      return { x: point.x, y: ring.bottom };
    case "N":
      return { x: point.x, y: ring.top };
  }
}

function shortest(paths: readonly Point[][]): Point[] {
  let best = paths[0]!;
  let bestLength = Infinity;
  for (const points of paths) {
    let length = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      length += Math.abs(points[i + 1]!.x - points[i]!.x) + Math.abs(points[i + 1]!.y - points[i]!.y);
    }
    if (length < bestLength) {
      best = points;
      bestLength = length;
    }
  }
  return best;
}

function routeIsClean(
  points: readonly Point[],
  obstacles: readonly Box[],
  tracks: TrackIndex | undefined,
  strict: boolean,
): boolean {
  if (points.length < 2) return false;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  }
  if (pathHits(obstacles, points)) return false;
  if (strict && tracks && tracks.routeOverlap(points) > MAX_TRACK_OVERLAP) return false;
  return true;
}

/**
 * Self-loop made of an orthogonal walk around the node ring.
 *
 * Returns `null` when no candidate is free of obstacles and accepted tracks;
 * callers must not treat a colliding candidate as a valid route.
 */
function selfLoop(
  source: Point,
  from: Side,
  target: Point,
  to: Side,
  box: Box,
  obstacles: readonly Box[],
  tracks: TrackIndex | undefined,
  strict: boolean,
): Point[] | null {
  for (const extra of [0, 16, 32, 56, 96, 160]) {
    const reach = LOOP + Math.abs(source.y - target.y) / 2 + extra;
    const ring: Ring = {
      left: box.x - reach,
      right: box.x + box.width + reach,
      top: box.y - reach,
      bottom: box.y + box.height + reach,
    };
    const exit = ringExit(source, from, ring);
    const entry = ringExit(target, to, ring);
    const candidates = ringArcs(exit, entry, ring).map((arc) =>
      collapse([source, ...arc, target]),
    );
    const clean = candidates.filter((points) =>
      routeIsClean(points, obstacles, tracks, strict),
    );
    if (clean.length) return shortest(clean);
  }
  return null;
}

/**
 * Ring detour around every obstacle between two ports.
 *
 * Only collision-free candidates are returned: when every ring size is blocked
 * the caller gets `null` and reports a diagnosable routing failure instead of a
 * node-penetrating route.
 */
function hullFallback(
  sp: Point,
  from: Side,
  tp: Point,
  to: Side,
  obstacles: readonly Box[],
  extra: number,
  tracks: TrackIndex | undefined,
  strict: boolean,
  bounds: readonly Box[] = obstacles,
): Point[] | null {
  const xs = [sp.x, tp.x, ...bounds.flatMap((box) => [box.x, box.x + box.width])];
  const ys = [sp.y, tp.y, ...bounds.flatMap((box) => [box.y, box.y + box.height])];
  const base: Ring = {
    left: Math.min(...xs) - CLEAR,
    right: Math.max(...xs) + CLEAR,
    top: Math.min(...ys) - CLEAR,
    bottom: Math.max(...ys) + CLEAR,
  };
  for (const expand of [extra, extra + 24, extra + 56, extra + 96, extra + 160]) {
    const ring: Ring = {
      left: base.left - expand,
      right: base.right + expand,
      top: base.top - expand,
      bottom: base.bottom + expand,
    };
    const exit = ringExit(sp, from, ring);
    const entry = ringExit(tp, to, ring);
    const candidates = ringArcs(exit, entry, ring)
      .map((arc) => collapse([sp, ...arc, tp]))
      .filter((points) => routeIsClean(points, obstacles, tracks, strict));
    if (candidates.length) return shortest(candidates);
  }
  return null;
}

function labelCandidates(points: readonly Point[], label: string): Box[] {
  const metrics = measureMultilineText(label, FONT_SIZES.edgeLabel, 500);
  const width = metrics.width + 16;
  const height = metrics.height + 16;
  const count = points.length - 1;
  const order = Array.from({ length: count }, (_, index) => index).sort(
    (a, b) => Math.abs(a - (count - 1) / 2) - Math.abs(b - (count - 1) / 2),
  );
  const boxes: Box[] = [];
  for (const index of order) {
    const a = points[index]!;
    const b = points[index + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const cx = a.x + (b.x - a.x) * t;
      const cy = a.y + (b.y - a.y) * t;
      boxes.push({ x: cx - width / 2, y: cy - height - 4, width, height });
      boxes.push({ x: cx - width / 2, y: cy + 4, width, height });
      if (!horizontal) {
        boxes.push({ x: cx - width - 4, y: cy - height / 2, width, height });
        boxes.push({ x: cx + 4, y: cy - height / 2, width, height });
      }
      if (length < width + 8) break;
    }
  }
  if (!boxes.length) {
    const mid = points[Math.floor(points.length / 2)]!;
    boxes.push({ x: mid.x - width / 2, y: mid.y - height - 4, width, height });
  }
  return boxes;
}

/**
 * Place a label next to the segment closest to the middle of the route that
 * does not overlap an obstacle. Always returns a box (the least overlapping one
 * as a last resort) so the renderer never falls back to an unconstrained spot.
 */
function placeLabel(
  points: readonly Point[],
  label: string | undefined,
  obstacles: readonly Box[],
): Box | undefined {
  if (!label) return undefined;
  const candidates = labelCandidates(points, label);
  let best = candidates[0]!;
  let bestPenalty = Infinity;
  for (const box of candidates) {
    let penalty = 0;
    for (const obstacle of obstacles) penalty += overlapArea(obstacle, box);
    if (penalty < bestPenalty - 1e-9) {
      best = box;
      bestPenalty = penalty;
      if (penalty === 0) break;
    }
  }
  return best;
}

function routingError(message: string, line?: number): DiagramRenderError {
  return new DiagramRenderError(message, [
    { code: SWL_E_ROUTING, severity: "error", message, line },
  ]);
}

export interface RouteEdgesResult {
  readonly edges: readonly RoutedEdge[];
  readonly reroutedEdges: number;
  /** Edges that had to share part of an existing track (dense diagrams only). */
  readonly overlappingEdges: number;
}

/** Deterministic port offsets for attachments that have no ELK port. */
function fallbackOffsets(
  diagram: SwimlaneDiagram,
  layout: SwimlaneLayout,
  planned: Map<string, SwimlaneRoutePlan[number]>,
  feedback: Set<string>,
): Map<string, number> {
  const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
  const orderOf = new Map(diagram.edges.map((edge, index) => [edge.id, index] as const));
  const groups = new Map<string, string[]>();
  for (const edge of diagram.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const entry = planned.get(edge.id);
    const isSelfLoop = entry?.selfLoop ?? edge.source === edge.target;
    const isFeedback = entry?.feedback ?? feedback.has(edge.id);
    const sides: { from: Side; to: Side } =
      entry ??
      (isSelfLoop
        ? { from: "E", to: "N" }
        : chainSides(layout.direction, source, target, isFeedback));
    const sourceKey = `${source.id}:${sides.from}`;
    const targetKey = `${target.id}:${sides.to}`;
    groups.set(sourceKey, [...(groups.get(sourceKey) ?? []), edge.id]);
    if (!isSelfLoop) groups.set(targetKey, [...(groups.get(targetKey) ?? []), edge.id]);
  }
  const offsets = new Map<string, number>();
  for (const [key, edgeIds] of groups) {
    const index = key.lastIndexOf(":");
    const nodeId = key.slice(0, index);
    const side = key.slice(index + 1) as Side;
    const node = byId.get(nodeId);
    if (!node) continue;
    const list = [...edgeIds].sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0));
    const spread = sidePortOffsets(list.length, node.box, side);
    list.forEach((edgeId, at) => offsets.set(`${edgeId}@${nodeId}:${side}`, spread[at]!));
  }
  return offsets;
}

export function routeEdges(
  diagram: SwimlaneDiagram,
  layout: SwimlaneLayout,
  feedback: Set<string>,
  extraGutter = 0,
  routePlan?: SwimlaneRoutePlan,
): RouteEdgesResult {
  const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
  const planned = new Map<string, SwimlaneRoutePlan[number]>();
  for (const entry of routePlan ?? []) planned.set(entry.edgeId, entry);
  const offsets = fallbackOffsets(diagram, layout, planned, feedback);

  const tracks = new TrackIndex();
  const placedLabels: Box[] = [];
  const routed: RoutedEdge[] = [];
  let reroutedEdges = 0;
  let overlappingEdges = 0;

  for (const edge of diagram.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      throw routingError(`Missing endpoint for ${edge.id}`, edge.span.line);
    }
    const entry = planned.get(edge.id);
    const isSelfLoop = entry?.selfLoop ?? edge.source === edge.target;
    const isFeedback = entry?.feedback ?? feedback.has(edge.id);
    const sides: { from: Side; to: Side } =
      entry ??
      (isSelfLoop
        ? { from: "E", to: "N" }
        : chainSides(layout.direction, source, target, isFeedback));

    const ignore = new Set([source.id, target.id]);
    const others = [
      ...layout.nodes.filter((node) => !ignore.has(node.id)).map((node) => inflate(node.box)),
      ...placedLabels,
    ];
    const keepOut = [
      ...others,
      inflate(source.box, ENDPOINT_PAD),
      inflate(target.box, ENDPOINT_PAD),
    ];
    const labelObstacles = [
      ...others,
      inflate(source.box, 2),
      inflate(target.box, 2),
    ];

    if (isSelfLoop) {
      const offset = offsets.get(`${edge.id}@${source.id}:${sides.from}`) ?? 0;
      const sp = roundPoint(entry?.fromPort ?? sidePort(source.box, sides.from, source.shape, offset));
      const tp = roundPoint(entry?.toPort ?? sidePort(target.box, sides.to, target.shape, 0));
      let points = selfLoop(sp, sides.from, tp, sides.to, source.box, others, tracks, true);
      let relaxed = false;
      if (!points) {
        points = selfLoop(sp, sides.from, tp, sides.to, source.box, others, tracks, false);
        relaxed = points !== null;
      }
      if (!points) {
        throw routingError(
          `SWL_E_ROUTING: no collision-free self-loop for ${edge.id}`,
          edge.span.line,
        );
      }
      const labelBox = placeLabel(points, edge.label, labelObstacles);
      if (labelBox) placedLabels.push(labelBox);
      tracks.add(points);
      reroutedEdges += 1;
      if (relaxed) overlappingEdges += 1;
      routed.push({ ...edge, points: points.map(roundPoint), labelBox });
      continue;
    }

    const sp = roundPoint(
      entry?.fromPort ??
        sidePort(
          source.box,
          sides.from,
          source.shape,
          offsets.get(`${edge.id}@${source.id}:${sides.from}`) ?? 0,
        ),
    );
    const tp = roundPoint(
      entry?.toPort ??
        sidePort(
          target.box,
          sides.to,
          target.shape,
          offsets.get(`${edge.id}@${target.id}:${sides.to}`) ?? 0,
        ),
    );
    const sStub = roundPoint(outerStub(sp, sides.from, stubDistance(sp, sides.from, source.box)));
    const tStub = roundPoint(outerStub(tp, sides.to, stubDistance(tp, sides.to, target.box)));

    const elkPoints =
      !isFeedback && entry?.elkPoints ? normalizeElkSection(entry.elkPoints, sp, tp) : null;
    if (elkPoints && routeIsClean(elkPoints, others, tracks, true)) {
      const labelBox = placeLabel(elkPoints, edge.label, labelObstacles);
      if (labelBox) placedLabels.push(labelBox);
      tracks.add(elkPoints);
      routed.push({ ...edge, points: elkPoints.map(roundPoint), labelBox });
      continue;
    }

    let gutter = extraGutter;
    if (isFeedback) gutter = Math.max(gutter, 28);
    const gutters = [gutter, gutter + 24, gutter + 48, gutter + 80, gutter + 140];
    const ownBounds = [inflate(source.box, 2), inflate(target.box, 2)];
    let points: Point[] | null = null;
    let relaxed = false;
    for (const strict of [true, false]) {
      for (const gutterPad of gutters) {
        const { xs, ys } = channelAxes(layout, source, target, gutterPad);
        xs.push(sStub.x, tStub.x);
        ys.push(sStub.y, tStub.y);
        const mid = findOrthogonalPath(sStub, tStub, keepOut, xs, ys, tracks);
        if (!mid) continue;
        const candidate = collapse([sp, ...mid, tp]);
        if (routeIsClean(candidate, others, tracks, strict)) {
          points = candidate;
          relaxed = !strict;
          break;
        }
      }
      if (points) break;
      points = hullFallback(
        sp,
        sides.from,
        tp,
        sides.to,
        others,
        Math.max(gutter, 28),
        tracks,
        strict,
        [...others, ...ownBounds],
      );
      if (points) {
        relaxed = !strict;
        break;
      }
    }
    if (!points) {
      throw routingError(
        `SWL_E_ROUTING: no collision-free route for ${edge.id} (${edge.source}->${edge.target})`,
        edge.span.line,
      );
    }
    reroutedEdges += 1;
    if (relaxed) overlappingEdges += 1;
    const labelBox = placeLabel(points, edge.label, labelObstacles);
    if (labelBox) placedLabels.push(labelBox);
    tracks.add(points);
    routed.push({ ...edge, points: points.map(roundPoint), labelBox });
  }
  return { edges: routed, reroutedEdges, overlappingEdges };
}

/**
 * ELK sections are orthogonal by construction; drop them when they are not,
 * when a coordinate is non-finite, or when they do not span the planned ports.
 */
function normalizeElkSection(
  points: readonly Point[],
  sp: Point,
  tp: Point,
): Point[] | null {
  if (points.length < 2) return null;
  const all = [sp, ...points.slice(1, -1).map((point) => ({ ...point })), tp];
  for (const point of all) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  }
  for (let i = 0; i < all.length - 1; i += 1) {
    const a = all[i]!;
    const b = all[i + 1]!;
    const horizontal = Math.abs(a.y - b.y) < 0.75;
    const vertical = Math.abs(a.x - b.x) < 0.75;
    if (!horizontal && !vertical) return null;
  }
  return collapse(all).map(roundPoint);
}
