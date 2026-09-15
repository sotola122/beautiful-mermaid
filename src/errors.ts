export type DiagramDiagnosticSeverity = "error" | "warning";

export interface DiagramDiagnostic {
  readonly code: string;
  readonly severity: DiagramDiagnosticSeverity;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly path?: string;
}

export class DiagramRenderError extends Error {
  readonly name = "DiagramRenderError";
  readonly diagnostics: readonly DiagramDiagnostic[];

  constructor(message: string, diagnostics: readonly DiagramDiagnostic[] = []) {
    super(message);
    this.diagnostics = diagnostics;
  }
}
