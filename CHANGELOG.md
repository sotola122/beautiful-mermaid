# Changelog

## 1.2.0 — tep-hardware / sotola122 fork

Origin: https://github.com/sotola122/beautiful-mermaid  
Upstream: lukilabs/beautiful-mermaid@2ac8bbbb060ca0a65a6a21f3200bd99b1587b488 (1.1.3)

### Added
- `swimlane` / `swimlane-beta` SVG via `registerDiagram`, dedicated `lane` DSL, and ELK.js compound layout
- `DiagramRenderError` diagnostics
- Orthogonal `routeEdges` cleanup with `reroutedEdges` stats on the swimlane layout

### Split out
- Packet DSL → `@sotola122/wireglyph`
- Interface Spec HTML/SVG → `@sotola122/tessaline`

### Unsupported
- Swimlane ASCII (explicit error, no flowchart fallback)
- Packet / registermap / memorymap in this package (routed to `@sotola122/wireglyph`)
- Nested swimlane subgraphs, BPMN
- CJS builds

### Rollback
1. Revert md-docs `package.json` / lockfiles to drop
   `@sotola122/beautiful-mermaid` (`file:packages/beautiful-mermaid`) and
   `bundledDependencies`.
2. Restore mermaid-renderer to the previous local pipeline.

### Compatibility
| Surface | Contract |
| --- | --- |
| Root SVG/ASCII | Existing 6 diagram types unchanged |
| `./swimlane` | `swimlane` / `swimlane-beta` via root `renderMermaidSVG` (ELK.js) |
| ASCII | Swimlane and wireglyph kinds error; no flowchart fallback |

