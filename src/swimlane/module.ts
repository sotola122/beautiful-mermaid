import { detectExtendedKind } from "../detect.ts";
import type { RegisteredDiagram } from "../diagram-registry.ts";
import { parseSwimlane } from "./parser.ts";
import { layoutSwimlane } from "./layout.ts";
import { renderSwimlaneSVG } from "./render-entry.ts";

export const swimlaneDiagramModule: RegisteredDiagram = {
  id: "swimlane",
  detect: (text) => detectExtendedKind(text) === "swimlane",
  parse: (text) => parseSwimlane(text).diagram,
  layout: (parsed, options) => layoutSwimlane(parsed as Parameters<typeof layoutSwimlane>[0], options),
  render: (text, colors, font, transparent, options) =>
    renderSwimlaneSVG(text, colors, font, transparent, options.idPrefix ?? "", options),
};
