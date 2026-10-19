export type SwimlaneDirection = "TB" | "BT" | "LR" | "RL";

export interface SourceSpan {
  readonly line: number;
  readonly column: number;
}

export interface Lane {
  readonly id: string;
  readonly label: string;
  /** DSL appearance index. ELK partitioning uses this; lanes are never reordered. */
  readonly sourceOrder: number;
  readonly nodeIds: readonly string[];
}

export type SwimlaneShape =
  | "rectangle"
  | "rounded"
  | "stadium"
  | "diamond"
  | "circle";

export interface SwimlaneNode {
  readonly id: string;
  readonly label: string;
  readonly shape: SwimlaneShape;
  readonly laneId: string;
  readonly sourceOrder: number;
  readonly span: SourceSpan;
  readonly style?: Readonly<Record<string, string>>;
}

export interface SwimlaneEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
  readonly kind: "solid" | "dotted" | "thick" | "none";
  readonly sourceOrder: number;
  readonly span: SourceSpan;
}

export interface SwimlaneDiagram {
  readonly direction: SwimlaneDirection;
  readonly lanes: readonly Lane[];
  readonly nodes: readonly SwimlaneNode[];
  readonly edges: readonly SwimlaneEdge[];
  readonly accessibility?: { title?: string; description?: string };
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PositionedNode extends SwimlaneNode {
  readonly box: Box;
}

export interface PositionedLane extends Lane {
  readonly box: Box;
  readonly headerBox: Box;
}

export interface RoutedEdge extends SwimlaneEdge {
  readonly points: readonly { x: number; y: number }[];
  readonly labelBox?: Box;
}

/** Node face a swimlane edge attaches to. */
export type SwimlaneSide = "N" | "S" | "E" | "W";

/**
 * Pre-computed routing intent for one edge.
 *
 * `from`/`to` are handed to ELK as fixed-side port constraints before layout
 * runs; `fromPort`/`toPort` are the port positions ELK resolved for them and
 * `elkPoints` is ELK's own orthogonal section, used as the primary route.
 */
export interface PlannedEdgeRoute {
  readonly edgeId: string;
  readonly from: SwimlaneSide;
  readonly to: SwimlaneSide;
  readonly feedback: boolean;
  readonly selfLoop: boolean;
  readonly fromPort?: { readonly x: number; readonly y: number };
  readonly toPort?: { readonly x: number; readonly y: number };
  readonly elkPoints?: readonly { readonly x: number; readonly y: number }[];
}

export type SwimlaneRoutePlan = readonly PlannedEdgeRoute[];

export interface SwimlaneLayout {
  readonly width: number;
  readonly height: number;
  readonly direction: SwimlaneDirection;
  readonly lanes: readonly PositionedLane[];
  readonly nodes: readonly PositionedNode[];
  readonly edges: readonly RoutedEdge[];
  readonly reroutedEdges: number;
  /**
   * Edges that could not be given a free track and had to share part of an
   * existing one. Zero for every sample; non-zero only for very dense graphs.
   */
  readonly overlappingEdges?: number;
}
