import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "swimlane/index": "src/swimlane/index.ts",
  },
  format: ["esm"],
  dts: {
    compilerOptions: {
      skipLibCheck: true,
      strict: false,
    },
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  outDir: "dist",
  external: ["elkjs", "entities"],
});
