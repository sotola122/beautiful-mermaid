# Swimlane diagrams

`swimlane` / `swimlane-beta` is a first-class diagram type in this fork. Detection
goes through `registerDiagram()` in `src/diagram-registry.ts`. Layout uses the
same synchronous ELK.js singleton as flowcharts, class diagrams, and ER diagrams.

## Pipeline

```
Swimlane DSL
    → parser (src/swimlane/parser.ts)
    → AST (src/swimlane/types.ts)
    → ELK compound graph (src/swimlane/layout.ts)
    → SVG (src/swimlane/renderer.ts)
```

Custom code owns lane order, headers, padding, separators, and node-to-lane
assignment. ELK owns node placement, ranking, spacing, orthogonal routing,
crossing reduction, and inter-lane edges.

Lane order is forced with `elk.partitioning.activate` plus
`elk.partitioning.partition = source index` on each lane compound and its nodes.
`elk.hierarchyHandling = INCLUDE_CHILDREN` so cross-lane edges are routed.

After ELK, swimlane code equalizes and abuts lane boxes so they form a continuous
band, snaps endpoints onto node outlines, and only falls back to the orthogonal
grid router when an ELK section would pass through another node.

## DSL

```
swimlane LR
lane User
  Start
  Submit
lane api "Backend API"
  validate "Validate Request"
  process "Process Request"
Start -> Submit
Submit -> validate
validate -> process
```

- Header: `swimlane` or `swimlane-beta`, optional `LR` / `TB` / `RL` / `BT` / `TD`.
  Default direction is **LR**.
- `lane id "Label"` or `lane Name`.
- Nodes: bare ids, `id "Label"`, or Mermaid shape forms (`A[Label]`, `A([Label])`, …).
- Edges: `->` or `-->`, optional `|label|`.
- `subgraph id [Label] … end` remains supported for existing `swimlane-beta` samples.

## Theme

`RenderOptions.swimlane` / `DiagramColors.swimlane`:

```
laneBackground
alternateLaneBackground
laneBorder
laneHeaderBackground
laneHeaderText
laneSeparator
```

Unset values fall back to the shared `--surface` / `--border` / `--accent` / `--fg`
derivation used by other diagram types.
