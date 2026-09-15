import { DiagramRenderError, type DiagramDiagnostic } from "../errors.ts";
import type {
  Lane,
  SourceSpan,
  SwimlaneDiagram,
  SwimlaneDirection,
  SwimlaneEdge,
  SwimlaneNode,
  SwimlaneShape,
} from "./types.ts";

const ALLOWED_STYLE = new Set([
  "fill",
  "stroke",
  "color",
  "stroke-width",
  "stroke-dasharray",
]);

export interface SwimlaneParseResult {
  readonly diagram: SwimlaneDiagram;
  readonly diagnostics: readonly DiagramDiagnostic[];
}

function span(line: number, column = 0): SourceSpan {
  return { line, column };
}

function splitStatements(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/<br\s*\/?>/gi, "\n");
}

function parseDirection(token: string | undefined): SwimlaneDirection {
  const value = (token ?? "LR").toUpperCase();
  if (value === "TD" || value === "TB") return "TB";
  if (value === "BT" || value === "LR" || value === "RL") return value;
  throw new DiagramRenderError(`SWL_E_DIRECTION: unsupported direction "${token}"`, [
    { code: "SWL_E_DIRECTION", severity: "error", message: `unsupported direction ${token}` },
  ]);
}

function slugId(label: string, fallback: string): string {
  const slug = label.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[A-Za-z_][\w-]*$/.test(slug)) return slug;
  return fallback;
}

function parseLaneHeader(line: string, fallbackId: string): { id: string; label: string } | null {
  const quotedId = line.match(/^lane\s+([A-Za-z_][\w-]*)\s+("[^"]*"|'[^']*')$/);
  if (quotedId) return { id: quotedId[1]!, label: unquote(quotedId[2]!) };
  const plain = line.match(/^lane\s+([A-Za-z_][\w-]*)$/);
  if (plain) return { id: plain[1]!, label: plain[1]! };
  const labeled = line.match(/^lane\s+("[^"]*"|'[^']*')$/);
  if (labeled) {
    const label = unquote(labeled[1]!);
    return { id: slugId(label, fallbackId), label };
  }
  return null;
}

function parseQuotedNode(line: string): { id: string; label: string; shape: SwimlaneShape } | null {
  const match = line.match(/^([A-Za-z_][\w-]*)\s+("[^"]*"|'[^']*')$/);
  if (!match) return null;
  return { id: match[1]!, label: unquote(match[2]!), shape: "rectangle" };
}

function parseNodeShape(raw: string): { id: string; label: string; shape: SwimlaneShape } | null {
  const stadium = raw.match(/^([A-Za-z_][\w-]*)\(\[([^\]]*)\]\)$/);
  if (stadium) return { id: stadium[1]!, label: unquote(stadium[2]!), shape: "stadium" };
  const circle = raw.match(/^([A-Za-z_][\w-]*)\(\((.*)\)\)$/);
  if (circle) return { id: circle[1]!, label: unquote(circle[2]!), shape: "circle" };
  const diamond = raw.match(/^([A-Za-z_][\w-]*)\{([^}]*)\}$/);
  if (diamond) return { id: diamond[1]!, label: unquote(diamond[2]!), shape: "diamond" };
  const rounded = raw.match(/^([A-Za-z_][\w-]*)\(([^)]*)\)$/);
  if (rounded) return { id: rounded[1]!, label: unquote(rounded[2]!), shape: "rounded" };
  const rectangle = raw.match(/^([A-Za-z_][\w-]*)\[([^\]]*)\]$/);
  if (rectangle) return { id: rectangle[1]!, label: unquote(rectangle[2]!), shape: "rectangle" };
  const bare = raw.match(/^([A-Za-z_][\w-]*)$/);
  if (bare) return { id: bare[1]!, label: bare[1]!, shape: "rectangle" };
  return null;
}

function parseSubgraphHeader(line: string): { id: string; label: string } | null {
  const labeled = line.match(/^subgraph\s+([A-Za-z_][\w-]*)\s*\[\s*(.+?)\s*\]$/);
  if (labeled) return { id: labeled[1]!, label: unquote(labeled[2]!) };
  const plain = line.match(/^subgraph\s+([A-Za-z_][\w-]*)$/);
  if (plain) return { id: plain[1]!, label: plain[1]! };
  if (/^subgraph\s+/.test(line)) {
    throw new DiagramRenderError("SWL_E_LANE: nested or unnamed Japanese lane IDs are unsupported", [
      { code: "SWL_E_LANE", severity: "error", message: line },
    ]);
  }
  return null;
}

function kindFromOp(op: string): SwimlaneEdge["kind"] {
  if (op === "-.->") return "dotted";
  if (op === "==>") return "thick";
  if (op === "---") return "none";
  return "solid";
}

function takeEdgeOp(
  input: string,
): { op: string; label?: string; rest: string } | null {
  const labeled = input.match(/^(?:-->|->)\|([^|]+)\|\s*/);
  if (labeled) {
    return { op: "-->", label: labeled[1], rest: input.slice(labeled[0].length) };
  }
  const plain = input.match(/^(-->|---|-\.->|==>|->)\s*/);
  if (!plain) return null;
  return { op: plain[1]!, rest: input.slice(plain[0].length) };
}

type ParsedEdgeNode = {
  id: string;
  label: string;
  shape: SwimlaneShape;
};

function parseEdge(
  line: string,
  sourceOrder: number,
  lineNo: number,
): { edges: SwimlaneEdge[]; nodes: ParsedEdgeNode[] } | null {
  const edges: SwimlaneEdge[] = [];
  const nodes: ParsedEdgeNode[] = [];
  let rest = line.trim();
  const firstNodeEnd = rest.search(/\s*(-->\|[^|]+\||->\|[^|]+\||-->|---|-\.->|==>|->)/);
  if (firstNodeEnd < 0) return null;
  let previous = parseNodeShape(rest.slice(0, firstNodeEnd).trim()) ?? parseQuotedNode(rest.slice(0, firstNodeEnd).trim());
  rest = rest.slice(firstNodeEnd).trim();
  if (!previous?.id) return null;
  nodes.push(previous);
  while (rest) {
    const op = takeEdgeOp(rest);
    if (!op) return null;
    rest = op.rest;
    const nextOp = rest.search(/\s*(-->\|[^|]+\||->\|[^|]+\||-->|---|-\.->|==>|->)/);
    const nodeRaw = (nextOp === -1 ? rest : rest.slice(0, nextOp)).trim();
    const next = parseNodeShape(nodeRaw) ?? parseQuotedNode(nodeRaw) ?? parseNodeShape(nodeRaw.replace(/\|.*$/, "").trim());
    if (!next?.id) return null;
    nodes.push(next);
    edges.push({
      id: `e${sourceOrder + edges.length}`,
      source: previous.id,
      target: next.id,
      label: op.label,
      kind: kindFromOp(op.op),
      sourceOrder: sourceOrder + edges.length,
      span: span(lineNo),
    });
    previous = next;
    rest = nextOp === -1 ? "" : rest.slice(nextOp).trim();
  }
  return edges.length ? { edges, nodes } : null;
}

export function parseSwimlane(source: string): SwimlaneParseResult {
  const diagnostics: DiagramDiagnostic[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let headerSeen = false;
  let direction: SwimlaneDirection = "LR";
  const lanes: Lane[] = [];
  const nodes: SwimlaneNode[] = [];
  const edges: SwimlaneEdge[] = [];
  const nodeIndex = new Map<string, SwimlaneNode>();
  let currentLane: Lane | undefined;
  let laneDepth = 0;
  let laneKeywordMode = false;
  let accTitle: string | undefined;
  let accDescr: string | undefined;
  let sourceOrder = 0;

  const addNode = (node: SwimlaneNode): void => {
    const existing = nodeIndex.get(node.id);
    if (existing && existing.laneId !== node.laneId) {
      throw new DiagramRenderError(`SWL_E_LANE: node ${node.id} belongs to multiple lanes`, [
        { code: "SWL_E_LANE", severity: "error", message: node.id, line: node.span.line, column: 0 },
      ]);
    }
    if (!existing) {
      nodes.push(node);
      nodeIndex.set(node.id, node);
      return;
    }
    const upgraded: SwimlaneNode = {
      ...existing,
      label: node.label !== node.id ? node.label : existing.label,
      shape: node.shape !== "rectangle" ? node.shape : existing.shape,
    };
    if (upgraded.label === existing.label && upgraded.shape === existing.shape) return;
    nodeIndex.set(node.id, upgraded);
    const idx = nodes.findIndex((item) => item.id === node.id);
    if (idx >= 0) nodes[idx] = upgraded;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    if (/^(---|\.\.\.)/.test(trimmed) || trimmed.startsWith("%%{") || trimmed.startsWith("init:")) {
      throw new DiagramRenderError("SWL_E_UNSUPPORTED: frontmatter/init is not supported", [
        { code: "SWL_E_UNSUPPORTED", severity: "error", message: trimmed, line: lineNo, column: 0 },
      ]);
    }
    for (const statement of splitStatements(trimmed)) {
      if (!headerSeen) {
        const header = statement.match(/^swimlane(?:-beta)?(?:\s+(\S+))?$/i);
        if (!header) {
          throw new DiagramRenderError("SWL_E_HEADER: expected swimlane or swimlane-beta", [
            { code: "SWL_E_HEADER", severity: "error", message: statement, line: lineNo, column: 0 },
          ]);
        }
        direction = parseDirection(header[1]);
        headerSeen = true;
        continue;
      }
      const accT = statement.match(/^accTitle:\s*(.*)$/);
      if (accT) {
        accTitle = accT[1];
        continue;
      }
      const accD = statement.match(/^accDescr:\s*(.*)$/);
      if (accD) {
        accDescr = accD[1];
        continue;
      }
      if (/^accDescr\s*\{/.test(statement)) {
        throw new DiagramRenderError("SWL_E_UNSUPPORTED: multiline accDescr is not supported", [
          { code: "SWL_E_UNSUPPORTED", severity: "error", message: statement, line: lineNo, column: 0 },
        ]);
      }
      const laneHeader = parseLaneHeader(statement, `lane${lanes.length}`);
      if (laneHeader) {
        if (laneDepth > 0) {
          throw new DiagramRenderError("SWL_E_NESTED: nested subgraphs are not supported", [
            { code: "SWL_E_NESTED", severity: "error", message: statement, line: lineNo, column: 0 },
          ]);
        }
        if (lanes.some((lane) => lane.id === laneHeader.id)) {
          throw new DiagramRenderError(`SWL_E_LANE: duplicate lane ${laneHeader.id}`, [
            { code: "SWL_E_LANE", severity: "error", message: laneHeader.id, line: lineNo, column: 0 },
          ]);
        }
        laneKeywordMode = true;
        currentLane = { id: laneHeader.id, label: laneHeader.label, sourceOrder: lanes.length, nodeIds: [] };
        lanes.push(currentLane);
        continue;
      }
      const sub = parseSubgraphHeader(statement);
      if (sub) {
        if (laneDepth > 0 || laneKeywordMode) {
          throw new DiagramRenderError("SWL_E_NESTED: nested subgraphs are not supported", [
            { code: "SWL_E_NESTED", severity: "error", message: statement, line: lineNo, column: 0 },
          ]);
        }
        if (lanes.some((lane) => lane.id === sub.id)) {
          throw new DiagramRenderError(`SWL_E_LANE: duplicate lane ${sub.id}`, [
            { code: "SWL_E_LANE", severity: "error", message: sub.id, line: lineNo, column: 0 },
          ]);
        }
        currentLane = { id: sub.id, label: sub.label, sourceOrder: lanes.length, nodeIds: [] };
        lanes.push(currentLane);
        laneDepth = 1;
        continue;
      }
      if (statement === "end") {
        if (laneKeywordMode && laneDepth === 0) {
          currentLane = undefined;
          continue;
        }
        if (laneDepth !== 1) {
          throw new DiagramRenderError("SWL_E_END: extra end", [
            { code: "SWL_E_END", severity: "error", message: statement, line: lineNo, column: 0 },
          ]);
        }
        laneDepth = 0;
        currentLane = undefined;
        continue;
      }
      if (/^(classDef|class|style|linkStyle)\b/.test(statement)) {
        const styleMatch = statement.match(/^style\s+(\S+)\s+(.+)$/);
        if (styleMatch) {
          const props = Object.fromEntries(
            styleMatch[2]!.split(",").map((part) => {
              const [k, ...rest] = part.split(":");
              return [k.trim(), rest.join(":").trim()];
            }),
          );
          for (const key of Object.keys(props)) {
            if (!ALLOWED_STYLE.has(key)) {
              throw new DiagramRenderError(`SWL_E_STYLE: unsupported style ${key}`, [
                { code: "SWL_E_STYLE", severity: "error", message: key, line: lineNo, column: 0 },
              ]);
            }
          }
          const target = nodeIndex.get(styleMatch[1]!);
          if (target) {
            const styled = { ...target, style: props };
            nodeIndex.set(target.id, styled);
            const idx = nodes.findIndex((node) => node.id === target.id);
            if (idx >= 0) nodes[idx] = styled;
          }
        }
        continue;
      }
      const edge = parseEdge(statement, sourceOrder, lineNo);
      if (edge) {
        if (laneKeywordMode) {
          for (const node of edge.nodes) {
            if (!nodeIndex.has(node.id)) {
              throw new DiagramRenderError("SWL_E_LANE: edge endpoint is not in a lane", [
                { code: "SWL_E_LANE", severity: "error", message: node.id, line: lineNo, column: 0 },
              ]);
            }
          }
        } else if (currentLane) {
          for (const node of edge.nodes) {
            addNode({
              id: node.id,
              label: node.label,
              shape: node.shape,
              laneId: currentLane.id,
              sourceOrder: sourceOrder++,
              span: span(lineNo),
            });
          }
        }
        for (const item of edge.edges) {
          edges.push(item);
          sourceOrder += 1;
        }
        continue;
      }
      const node = parseQuotedNode(statement) ?? parseNodeShape(statement);
      if (node) {
        if (!currentLane) {
          throw new DiagramRenderError(`SWL_E_LANE: node ${node.id} is not inside a lane`, [
            { code: "SWL_E_LANE", severity: "error", message: node.id, line: lineNo, column: 0 },
          ]);
        }
        addNode({
          ...node,
          laneId: currentLane.id,
          sourceOrder: sourceOrder++,
          span: span(lineNo),
        });
        continue;
      }
      throw new DiagramRenderError(`SWL_E_SYNTAX: unsupported statement`, [
        { code: "SWL_E_SYNTAX", severity: "error", message: statement, line: lineNo, column: 0 },
      ]);
    }
  }

  if (!headerSeen) {
    throw new DiagramRenderError("SWL_E_HEADER: expected swimlane or swimlane-beta", [
      { code: "SWL_E_HEADER", severity: "error", message: "missing header" },
    ]);
  }
  if (laneDepth !== 0) {
    throw new DiagramRenderError("SWL_E_END: missing end", [
      { code: "SWL_E_END", severity: "error", message: "unclosed subgraph" },
    ]);
  }
  for (const edge of edges) {
    if (!nodeIndex.has(edge.source) || !nodeIndex.has(edge.target)) {
      throw new DiagramRenderError("SWL_E_LANE: edge endpoint is not in a lane", [
        { code: "SWL_E_LANE", severity: "error", message: `${edge.source}-->${edge.target}` },
      ]);
    }
  }

  const lanesWithNodes = lanes.map((lane) => ({
    ...lane,
    nodeIds: nodes.filter((node) => node.laneId === lane.id).map((node) => node.id),
  }));

  return {
    diagram: {
      direction,
      lanes: lanesWithNodes,
      nodes,
      edges,
      accessibility: accTitle || accDescr ? { title: accTitle, description: accDescr } : undefined,
    },
    diagnostics,
  };
}
