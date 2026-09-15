import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMermaidSVG } from "../index.ts";

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../examples");

function listMmd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMmd(path));
    else if (entry.name.endsWith(".mmd")) out.push(path);
  }
  return out.sort();
}

const files = listMmd(examplesRoot);

describe("beautiful-mermaid examples", () => {
  test("examples/ contains multiple .mmd samples", () => {
    expect(statSync(examplesRoot).isDirectory()).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of files) {
    const rel = relative(examplesRoot, file);
    test(`renders ${rel}`, () => {
      const source = readFileSync(file, "utf8");
      const svg = renderMermaidSVG(source, { idPrefix: `ex-${rel.replace(/[^A-Za-z0-9]+/g, "-")}-` });
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
      expect(svg).not.toContain("<script");
    });
  }
});
