import type { RenderOptions } from "../types.ts";
import { DiagramRenderError } from "../errors.ts";
import { layoutSwimlane } from "./layout.ts";
import { parseSwimlane } from "./parser.ts";
import { renderSwimlaneSvg } from "./renderer.ts";
import type { DiagramColors } from "../theme.ts";

export function renderSwimlaneSVG(
  source: string,
  colors: DiagramColors,
  font: string,
  transparent: boolean,
  idPrefix = "",
  options: RenderOptions = {},
): string {
  const parsed = parseSwimlane(source);
  const errors = parsed.diagnostics.filter((item) => item.severity === "error");
  if (errors.length) {
    throw new DiagramRenderError(errors[0]?.message ?? "swimlane parse failed", errors);
  }
  const layout = layoutSwimlane(parsed.diagram, { ...options, idPrefix });
  return renderSwimlaneSvg(
    layout,
    { ...colors, swimlane: options.swimlane ?? colors.swimlane },
    font,
    transparent,
    idPrefix,
    parsed.diagram.accessibility,
  );
}
