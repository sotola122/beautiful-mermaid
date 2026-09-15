import { describe, expect, test } from "bun:test";
import { assertFiniteGeometry, BM_E_NONFINITE_GEOMETRY } from "../geometry-guard.ts";
import { DiagramRenderError } from "../errors.ts";

describe("assertFiniteGeometry", () => {
  test("accepts a finite layout with positive root size", () => {
    expect(() =>
      assertFiniteGeometry(
        { width: 120, height: 80, nodes: [{ x: 1, y: 2, width: 10, height: 10 }] },
        "flowchart",
      ),
    ).not.toThrow();
  });

  test("rejects NaN coordinates", () => {
    try {
      assertFiniteGeometry({ width: 100, height: 80, y: Number.NaN }, "flowchart");
      throw new Error("expected DiagramRenderError");
    } catch (error) {
      expect(error).toBeInstanceOf(DiagramRenderError);
      const diagnostics = (error as DiagramRenderError).diagnostics;
      expect(diagnostics[0]?.code).toBe(BM_E_NONFINITE_GEOMETRY);
      expect(diagnostics[0]?.path).toBe("flowchart.y");
    }
  });

  test("rejects Infinity and non-positive root dimensions", () => {
    expect(() => assertFiniteGeometry({ width: 10, height: Infinity }, "sequence")).toThrow(
      DiagramRenderError,
    );
    expect(() => assertFiniteGeometry({ width: 0, height: 40 }, "class")).toThrow(DiagramRenderError);
  });

  test("walks Maps and arrays", () => {
    const layout = {
      width: 10,
      height: 10,
      nodes: new Map([["A", { x: Number.NaN, y: 0 }]]),
    };
    expect(() => assertFiniteGeometry(layout, "er")).toThrow(DiagramRenderError);
  });
});
