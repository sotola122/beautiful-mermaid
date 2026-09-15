import type { DiagramColors } from "./theme.ts";
import type { RenderOptions } from "./types.ts";

export interface RegisteredDiagram {
  readonly id: string;
  detect: (text: string) => boolean;
  parse?: (text: string) => unknown;
  layout?: (parsed: unknown, options?: RenderOptions) => unknown;
  render: (
    text: string,
    colors: DiagramColors,
    font: string,
    transparent: boolean,
    options: RenderOptions,
  ) => string;
}

const diagrams: RegisteredDiagram[] = [];

export function registerDiagram(diagram: RegisteredDiagram): void {
  const index = diagrams.findIndex((item) => item.id === diagram.id);
  if (index >= 0) diagrams[index] = diagram;
  else diagrams.push(diagram);
}

export function detectRegistered(text: string): RegisteredDiagram | undefined {
  return diagrams.find((diagram) => diagram.detect(text));
}
