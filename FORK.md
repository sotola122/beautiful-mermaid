# Fork baseline

## Origin

GitHub origin for this fork is **https://github.com/sotola122/beautiful-mermaid**
(the public GitHub fork of `lukilabs/beautiful-mermaid`). That origin is the
source of truth for git history and issues. Do not treat an unpublished
`tep-hardware/beautiful-mermaid` GitHub repository as required.

This directory is origin `main` at `2ac8bbbb` plus the Swimlane overlay.
Packet and Interface Spec code moved to `@sotola122/wireglyph` and
`@sotola122/tessaline`. Origin editor, samples, examples, public assets, and site
scripts are kept. The npm `files` field still publishes `dist/` and docs only.

The intended published package name is `@sotola122/beautiful-mermaid`
(GitHub Packages, restricted). md-docs vendors this package as
`packages/beautiful-mermaid` via a `file:` dependency and `bundledDependencies`
so `npm pack` still ships a complete consumer until origin is the install
source.

A cloud agent cannot push to origin (`cursor[bot]` has no write access).
With write access, overlay this directory onto origin `main` and push
`cursor/packet-swimlane-interface-108e`:

```bash
git clone https://github.com/sotola122/beautiful-mermaid.git
# copy this tree except node_modules/ and dist/
git checkout -b cursor/packet-swimlane-interface-108e
git add -A && git commit && git push -u origin HEAD
```

## Upstream pin

| Field | Value |
| --- | --- |
| Upstream | https://github.com/lukilabs/beautiful-mermaid |
| SHA | `2ac8bbbb060ca0a65a6a21f3200bd99b1587b488` |
| Package | 1.1.3 |
| Fork SemVer | 1.2.0 (independent of upstream) |

Sync policy: never auto-merge upstream into main. Open a dedicated branch/PR
and rerun existing 6-type tests plus Packet, Swimlane, and Interface regressions.

## md-docs pin

| Field | Value |
| --- | --- |
| Design-time archive | `@tep-hardware/md-docs` 1.11.0 |
| Archive SHA-256 | `49f47bc10a057cf5dbda0af0e6b314be87994cf82bdff006ac46108bb296295a` |
| Archive git commit | not present in the tarball |
| Implementation checkout | 1.11.1 at `b21f8d2` (`CIをGitHub-hostedのTestランナーへ切り替える (#14)`) |

## Runtime

- Node.js 24 for md-docs consumers
- Bun 1.4.x for upstream-style `bun test` in this package
- ESM only. CJS is not a supported contract.

## Packet / interface split

Packet fixtures and the Packet SVG pipeline live in `@sotola122/wireglyph`.
Interface Spec HTML/SVG live in `@sotola122/tessaline`. This package throws
`BM_E_ROUTE_WIREGYPH` (and ASCII `BM_E_ASCII_UNSUPPORTED`) for packet,
packet-beta, registermap, memorymap, and heuristic Packet DSL sources.

Compatibility baselines for the original six diagram types live in
`src/__tests__/`. Swimlane tests are additive.

## Rollback cookbook

md-docs 1.11.x before this overlay used local Packet SVG and did not render
`apidoc` in the generated-markdown pipeline.

1. Revert the md-docs commit that added `packages/beautiful-mermaid` and the
   adapter imports (`mermaid-renderer.ts`, `process-packet.ts`,
   `interface-apidoc.ts`, `markdown-transforms.ts`).
2. Restore `package.json` dependencies/lockfiles (`package-lock.json` and
   `bun.lock`) to that ref.
3. Keep `scripts/lib/packet-dsl` parser tests and `tools/interface-spec` as the
   previous local copies. Do not publish `tools/`.
4. Do not silently fallback between old and new renderers in one build.

Stable release still requires an explicit publish/merge. This document does not
publish GitHub Packages.

