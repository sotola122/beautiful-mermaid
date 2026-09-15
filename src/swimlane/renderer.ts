import { svgId } from "../shared/svg-ids.ts";
import { FONT_SIZES, FONT_WEIGHTS, STROKE_WIDTHS, ARROW_HEAD } from "../styles.ts";
import { svgOpenTag, buildStyleBlock, type DiagramColors } from "../theme.ts";
import {
  escapeXml,
  renderMultilineText,
  renderMultilineTextWithBackground,
} from "../multiline-utils.ts";
import { measureMultilineText } from "../text-metrics.ts";
import type { Box, PositionedLane, PositionedNode, SwimlaneLayout } from "./types.ts";

function laneFill(colors: DiagramColors, index: number): string {
  const theme = colors.swimlane;
  if (index % 2 === 1) {
    return theme?.alternateLaneBackground ?? "color-mix(in srgb, var(--fg) 4%, var(--bg))";
  }
  return theme?.laneBackground ?? "var(--_group-fill)";
}

function nodeShape(node: PositionedNode): string {
  const { x, y, width, height } = node.box;
  const fill = escapeXml(node.style?.fill ?? "var(--_node-fill)");
  const stroke = escapeXml(node.style?.stroke ?? "var(--_node-stroke)");
  const sw = escapeXml(node.style?.["stroke-width"] ?? String(STROKE_WIDTHS.innerBox));
  switch (node.shape) {
    case "diamond": {
      const cx = x + width / 2;
      const cy = y + height / 2;
      return `<polygon points="${cx},${y} ${x + width},${cy} ${cx},${y + height} ${x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
    }
    case "circle": {
      const r = Math.min(width, height) / 2;
      return `<circle cx="${x + width / 2}" cy="${y + height / 2}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
    }
    case "stadium":
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" ry="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
    case "rounded":
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" ry="6" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
    default:
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="0" ry="0" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`;
  }
}

function unionBox(lanes: readonly PositionedLane[]): Box | undefined {
  if (lanes.length === 0) return undefined;
  const x = Math.min(...lanes.map((lane) => lane.box.x));
  const y = Math.min(...lanes.map((lane) => lane.box.y));
  const right = Math.max(...lanes.map((lane) => lane.box.x + lane.box.width));
  const bottom = Math.max(...lanes.map((lane) => lane.box.y + lane.box.height));
  return { x, y, width: right - x, height: bottom - y };
}

function arrowDefs(markerId: string): string {
  const w = ARROW_HEAD.width;
  const h = ARROW_HEAD.height;
  const style = 'fill="var(--_arrow)" stroke="var(--_arrow)" stroke-width="0.75" stroke-linejoin="round"';
  return (
    `<defs><marker id="${escapeXml(markerId)}" markerWidth="${w}" markerHeight="${h}" refX="${w - 1}" refY="${h / 2}" orient="auto">` +
    `<polygon points="0 0, ${w} ${h / 2}, 0 ${h}" ${style} /></marker></defs>`
  );
}

export function renderSwimlaneSvg(
  layout: SwimlaneLayout,
  colors: DiagramColors,
  font: string,
  transparent: boolean,
  idPrefix = "",
  accessibility?: { title?: string; description?: string },
): string {
  const markerId = svgId(idPrefix, "swl-arrow");
  const title = accessibility?.title;
  const desc = accessibility?.description;
  const theme = colors.swimlane ?? {};
  const laneBorder = theme.laneBorder ?? "var(--_node-stroke)";
  const separator = theme.laneSeparator ?? laneBorder;
  const headerFill = theme.laneHeaderBackground ?? "var(--_group-hdr)";
  const headerText = theme.laneHeaderText ?? "var(--_text-sec)";
  const open = svgOpenTag(layout.width, layout.height, colors, transparent).replace(
    "<svg ",
    '<svg role="img" data-diagram-type="swimlane" ',
  );
  const parts: string[] = [
    open,
    buildStyleBlock(font, false),
    arrowDefs(markerId),
  ];
  if (title) parts.push(`<title>${escapeXml(title)}</title>`);
  if (desc) parts.push(`<desc>${escapeXml(desc)}</desc>`);

  const bounds = unionBox(layout.lanes);
  if (bounds) {
    parts.push(
      `<rect class="swimlane-frame" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="none" stroke="${escapeXml(laneBorder)}" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
    );
  }

  for (const [index, lane] of layout.lanes.entries()) {
    parts.push(
      `<g data-lane-id="${escapeXml(lane.id)}" class="swimlane-lane"><rect x="${lane.box.x}" y="${lane.box.y}" width="${lane.box.width}" height="${lane.box.height}" fill="${escapeXml(laneFill(colors, index))}" stroke="none" />`,
      `<rect x="${lane.headerBox.x}" y="${lane.headerBox.y}" width="${lane.headerBox.width}" height="${lane.headerBox.height}" fill="${escapeXml(headerFill)}" />`,
      renderMultilineText(
        lane.label,
        lane.headerBox.x + 12,
        lane.headerBox.y + lane.headerBox.height / 2,
        FONT_SIZES.groupHeader,
        `font-size="${FONT_SIZES.groupHeader}" font-weight="${FONT_WEIGHTS.groupHeader}" fill="${escapeXml(headerText)}"`,
      ),
      `</g>`,
    );
    if (index > 0) {
      if (layout.direction === "LR" || layout.direction === "RL") {
        parts.push(
          `<line class="swimlane-separator" x1="${lane.box.x}" y1="${lane.box.y}" x2="${lane.box.x}" y2="${lane.box.y + lane.box.height}" stroke="${escapeXml(separator)}" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
        );
      } else {
        parts.push(
          `<line class="swimlane-separator" x1="${lane.box.x}" y1="${lane.box.y}" x2="${lane.box.x + lane.box.width}" y2="${lane.box.y}" stroke="${escapeXml(separator)}" stroke-width="${STROKE_WIDTHS.outerBox}" />`,
        );
      }
    }
  }

  for (const edge of layout.edges) {
    if (edge.points.length < 2) continue;
    const d = edge.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
    const dash = edge.kind === "dotted" ? ' stroke-dasharray="4 4"' : "";
    const width = edge.kind === "thick" ? STROKE_WIDTHS.connector * 2 : STROKE_WIDTHS.connector;
    const marker = edge.kind === "none" ? "" : ` marker-end="url(#${escapeXml(markerId)})"`;
    parts.push(
      `<path class="edge" data-edge-id="${escapeXml(edge.id)}" data-from="${escapeXml(edge.source)}" data-to="${escapeXml(edge.target)}" d="${d}" fill="none" stroke="var(--_line)" stroke-width="${width}"${dash}${marker}/>`,
    );
    if (edge.label) {
      const metrics = measureMultilineText(edge.label, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel);
      const mid = edge.labelBox
        ? { x: edge.labelBox.x + edge.labelBox.width / 2, y: edge.labelBox.y + edge.labelBox.height / 2 }
        : edge.points[Math.floor(edge.points.length / 2)]!;
      parts.push(
        `<g class="edge-label" data-from="${escapeXml(edge.source)}" data-to="${escapeXml(edge.target)}" data-label="${escapeXml(edge.label)}">`,
        renderMultilineTextWithBackground(
          edge.label,
          mid.x,
          mid.y,
          metrics.width,
          metrics.height,
          FONT_SIZES.edgeLabel,
          8,
          `text-anchor="middle" font-size="${FONT_SIZES.edgeLabel}" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-sec)"`,
          `rx="2" ry="2" fill="var(--bg)" stroke="var(--_inner-stroke)" stroke-width="1"`,
        ),
        `</g>`,
      );
    }
  }

  for (const node of layout.nodes) {
    const textFill = escapeXml(node.style?.color ?? "var(--_text)");
    parts.push(
      `<g data-node-id="${escapeXml(node.id)}" class="node" data-id="${escapeXml(node.id)}" data-label="${escapeXml(node.label)}" data-shape="${node.shape}">`,
      nodeShape(node),
      renderMultilineText(
        node.label || node.id,
        node.box.x + node.box.width / 2,
        node.box.y + node.box.height / 2,
        FONT_SIZES.nodeLabel,
        `text-anchor="middle" font-size="${FONT_SIZES.nodeLabel}" font-weight="${FONT_WEIGHTS.nodeLabel}" fill="${textFill}"`,
      ),
      `</g>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}
