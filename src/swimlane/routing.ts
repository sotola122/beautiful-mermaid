import { DiagramRenderError } from "../errors.ts";
import type {
  Box,
  PositionedNode,
  RoutedEdge,
  SwimlaneDiagram,
  SwimlaneLayout,
} from "./types.ts";

export const SWL_E_ROUTING = "SWL_E_ROUTING";

const CLEAR = 8;
const LOOP = 18;
const PARALLEL = 8;
const BEND_COST = 80;
const ENDPOINT_PAD = 3;

export type Point = { x: number; y: number };
type Side = "N" | "S" | "E" | "W";

function round(value: number): number {
  return Math.round(value * 100) / 100;
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

export function port(box: Box, toward: Point, shape: string): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (shape === "circle") {
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: cx + (dx / len) * (box.width / 2),
      y: cy + (dy / len) * (box.height / 2),
    };
  }
  if (shape === "diamond") {
    const hw = box.width / 2;
    const hh = box.height / 2;
    const adx = Math.abs(dx) / (hw || 1);
    const ady = Math.abs(dy) / (hh || 1);
    const scale = 1 / (adx + ady || 1);
    return { x: cx + dx * scale, y: cy + dy * scale };
  }
  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: dx > 0 ? box.x + box.width : box.x, y: cy };
  }
  return { x: cx, y: dy > 0 ? box.y + box.height : box.y };
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

function flowSides(direction: SwimlaneLayout["direction"]): { from: Side; to: Side } {
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

function sidePort(box: Box, side: Side, shape: string, shift = 0): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const inset = Math.min(6, box.width / 4, box.height / 4);

  if (shape === "diamond") {
    switch (side) {
      case "E":
        return { x: box.x + box.width, y: cy };
      case "W":
        return { x: box.x, y: cy };
      case "S":
        return { x: cx, y: box.y + box.height };
      case "N":
        return { x: cx, y: box.y };
    }
  }

  if (shape === "circle") {
    const rx = box.width / 2;
    const ry = box.height / 2;
    switch (side) {
      case "E":
        return { x: cx + rx, y: cy };
      case "W":
        return { x: cx - rx, y: cy };
      case "S":
        return { x: cx, y: cy + ry };
      case "N":
        return { x: cx, y: cy - ry };
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

function keyOf(x: number, y: number): string {
  return `${round(x)},${round(y)}`;
}

function roundPoint(point: Point): Point {
  return { x: round(point.x), y: round(point.y) };
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
      if (segmentHits(obstacles, { x: current.x, y: current.y }, next)) continue;
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
      push(next.x, next.y, current.cost + length + bend + stable, current.key, next.dir);
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

function selfLoop(
  box: Box,
  offset: number,
  obstacles: readonly Box[],
): Point[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const variants = (reach: number): Point[][] => [
    [
      { x: box.x + box.width, y: cy + offset },
      { x: box.x + box.width + reach, y: cy + offset },
      { x: box.x + box.width + reach, y: box.y - reach },
      { x: cx, y: box.y - reach },
      { x: cx, y: box.y },
    ],
    [
      { x: box.x + box.width, y: cy + offset },
      { x: box.x + box.width + reach, y: cy + offset },
      { x: box.x + box.width + reach, y: box.y + box.height + reach },
      { x: cx, y: box.y + box.height + reach },
      { x: cx, y: box.y + box.height },
    ],
    [
      { x: box.x, y: cy + offset },
      { x: box.x - reach, y: cy + offset },
      { x: box.x - reach, y: box.y - reach },
      { x: cx, y: box.y - reach },
      { x: cx, y: box.y },
    ],
    [
      { x: box.x, y: cy + offset },
      { x: box.x - reach, y: cy + offset },
      { x: box.x - reach, y: box.y + box.height + reach },
      { x: cx, y: box.y + box.height + reach },
      { x: cx, y: box.y + box.height },
    ],
  ];
  let fallback = variants(LOOP + Math.abs(offset) + 72)[1]!;
  for (const extra of [0, 12, 24, 40, 72]) {
    const reach = LOOP + Math.abs(offset) + extra;
    for (const points of variants(reach)) {
      fallback = points;
      if (!pathHits(obstacles, points)) return points;
    }
  }
  return fallback;
}

function hullFallback(
  sp: Point,
  from: Side,
  tp: Point,
  to: Side,
  obstacles: readonly Box[],
  extra: number,
): Point[] {
  const xs = [sp.x, tp.x, ...obstacles.flatMap((box) => [box.x, box.x + box.width])];
  const ys = [sp.y, tp.y, ...obstacles.flatMap((box) => [box.y, box.y + box.height])];
  const left = Math.min(...xs) - CLEAR - extra;
  const right = Math.max(...xs) + CLEAR + extra;
  const top = Math.min(...ys) - CLEAR - extra;
  const bottom = Math.max(...ys) + CLEAR + extra;
  const sStub = outerStub(sp, from);
  const tStub = outerStub(tp, to);
  const ring: Point[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  const candidates: Point[][] = [];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const c = ring[(i + 2) % ring.length]!;
    candidates.push(
      collapse([
        sp,
        sStub,
        { x: a.x, y: sStub.y },
        a,
        b,
        { x: b.x, y: tStub.y },
        tStub,
        tp,
      ]),
      collapse([
        sp,
        sStub,
        { x: a.x, y: sStub.y },
        a,
        b,
        c,
        { x: c.x, y: tStub.y },
        tStub,
        tp,
      ]),
    );
  }
  let best = candidates[0]!;
  let bestLen = Infinity;
  for (const points of candidates) {
    if (pathHits(obstacles, points)) continue;
    let len = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      len +=
        Math.abs(points[i + 1]!.x - points[i]!.x) +
        Math.abs(points[i + 1]!.y - points[i]!.y);
    }
    if (len < bestLen) {
      best = points;
      bestLen = len;
    }
  }
  return best;
}

function labelCandidates(
  points: readonly Point[],
  label: string,
): Box[] {
  const width = Math.max(24, label.length * 7);
  const height = 16;
  const boxes: Box[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    boxes.push({ x: mx - width / 2, y: my - height / 2, width, height });
    boxes.push({ x: mx - width / 2, y: my - height - 4, width, height });
    boxes.push({ x: mx - width / 2, y: my + 4, width, height });
  }
  return boxes;
}

function routingError(message: string, line?: number): DiagramRenderError {
  return new DiagramRenderError(message, [
    { code: SWL_E_ROUTING, severity: "error", message, line },
  ]);
}

export interface RouteEdgesResult {
  readonly edges: readonly RoutedEdge[];
  readonly reroutedEdges: number;
}

export function routeEdges(
  diagram: SwimlaneDiagram,
  layout: SwimlaneLayout,
  feedback: Set<string>,
  extraGutter = 0,
): RouteEdgesResult {
  const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
  const pairCount = new Map<string, number>();
  const pairSeen = new Map<string, number>();
  const sideCount = new Map<string, number>();
  const sideSeen = new Map<string, number>();
  const planned = diagram.edges.map((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      throw routingError(`Missing endpoint for ${edge.id}`, edge.span.line);
    }
    const sides =
      edge.source === edge.target
        ? { from: "E" as Side, to: "N" as Side }
        : chainSides(layout.direction, source, target, feedback.has(edge.id));
    const sourceKey = `${source.id}:${sides.from}`;
    const targetKey = `${target.id}:${sides.to}`;
    sideCount.set(sourceKey, (sideCount.get(sourceKey) ?? 0) + 1);
    sideCount.set(targetKey, (sideCount.get(targetKey) ?? 0) + 1);
    return { edge, source, target, sides, sourceKey, targetKey };
  });
  for (const edge of diagram.edges) {
    const key = `${edge.source}->${edge.target}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }

  const placedLabels: Box[] = [];
  const routed: RoutedEdge[] = [];
  let reroutedEdges = 0;

  for (const item of planned) {
    const { edge, source, target, sides, sourceKey, targetKey } = item;
    const key = `${edge.source}->${edge.target}`;
    const index = pairSeen.get(key) ?? 0;
    pairSeen.set(key, index + 1);
    const sourceIndex = sideSeen.get(sourceKey) ?? 0;
    sideSeen.set(sourceKey, sourceIndex + 1);
    const targetIndex = sideSeen.get(targetKey) ?? 0;
    sideSeen.set(targetKey, targetIndex + 1);
    const pairOffset = (index - ((pairCount.get(key) ?? 1) - 1) / 2) * PARALLEL;
    const sourceSpread = (sideCount.get(sourceKey) ?? 1) > 1
      ? (sourceIndex - ((sideCount.get(sourceKey) ?? 1) - 1) / 2) * PARALLEL
      : 0;
    const targetSpread = (sideCount.get(targetKey) ?? 1) > 1
      ? (targetIndex - ((sideCount.get(targetKey) ?? 1) - 1) / 2) * PARALLEL
      : 0;
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

    if (edge.source === edge.target) {
      const points = selfLoop(source.box, pairOffset, others);
      const labelBox = placeLabel(points, edge.label, others);
      if (labelBox) placedLabels.push(labelBox);
      routed.push({ ...edge, points, labelBox });
      continue;
    }

    const sp = roundPoint(sidePort(source.box, sides.from, source.shape, pairOffset + sourceSpread));
    const tp = roundPoint(sidePort(target.box, sides.to, target.shape, pairOffset + targetSpread));
    const sStub = roundPoint(outerStub(sp, sides.from));
    const tStub = roundPoint(outerStub(tp, sides.to));
    let gutter = extraGutter;
    if (feedback.has(edge.id)) {
      gutter = Math.max(gutter, 28);
    }
    const tryRoute = (gutterPad: number): Point[] | null => {
      const { xs, ys } = channelAxes(layout, source, target, gutterPad);
      xs.push(sStub.x, tStub.x);
      ys.push(sStub.y, tStub.y);
      const mid = findOrthogonalPath(sStub, tStub, keepOut, xs, ys);
      const points = mid ? collapse([sp, ...mid, tp]) : null;
      if (!points || pathHits(others, points)) return null;
      return points;
    };
    let points: Point[] | null = null;
    for (const gutterPad of [gutter, gutter + 24, gutter + 48, gutter + 80]) {
      points = tryRoute(gutterPad);
      if (points) {
        if (gutterPad > gutter) reroutedEdges += 1;
        break;
      }
    }
    if (!points) {
      points = hullFallback(sp, sides.from, tp, sides.to, others, Math.max(gutter, 28));
      reroutedEdges += 1;
    }
    const labelBox = placeLabel(points, edge.label, others);
    if (labelBox) placedLabels.push(labelBox);
    routed.push({ ...edge, points, labelBox });
  }
  return { edges: routed, reroutedEdges };
}

function placeLabel(
  points: readonly Point[],
  label: string | undefined,
  obstacles: readonly Box[],
): Box | undefined {
  if (!label) return undefined;
  for (const box of labelCandidates(points, label)) {
    if (!obstacles.some((obstacle) => overlaps(obstacle, box))) return box;
  }
  return undefined;
}
