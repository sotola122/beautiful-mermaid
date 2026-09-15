import { describe, expect, test } from "bun:test";
import { detectExtendedKind, isWireglyphSource } from "../detect.ts";
import { DiagramRenderError } from "../errors.ts";
import { renderMermaidASCII, renderMermaidSVG } from "../index.ts";

describe("wireglyph routing", () => {
  test("detects packet-beta, registermap, and heuristic packet DSL", () => {
    expect(detectExtendedKind("packet-beta\n0-7: a")).toBe("packet-beta");
    expect(detectExtendedKind("registermap\nwidth: 32")).toBe("registermap");
    expect(detectExtendedKind("memory-map\ncols: 8")).toBe("memorymap");
    expect(isWireglyphSource("packet\ncols: 1\nB1: X")).toBe(true);
    expect(isWireglyphSource("# Title\ncols: 1\nB1: X\n")).toBe(true);
    expect(isWireglyphSource("flowchart TD\n  A --> B")).toBe(false);
  });

  test("SVG and ASCII refuse wireglyph sources", () => {
    const source = "packet\ncols: 1\nB1: X";
    expect(() => renderMermaidSVG(source)).toThrow(DiagramRenderError);
    try {
      renderMermaidSVG(source);
      throw new Error("expected DiagramRenderError");
    } catch (error) {
      expect(error).toBeInstanceOf(DiagramRenderError);
      expect((error as DiagramRenderError).diagnostics[0]?.code).toBe(
        "BM_E_ROUTE_WIREGYPH",
      );
    }
    expect(() => renderMermaidASCII(source)).toThrow(DiagramRenderError);
  });
});
