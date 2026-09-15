import { measureTextWidth, measureMultilineText } from "../text-metrics.ts";

export type TextMetricsFn = (
  text: string,
  fontSize: number,
  fontWeight?: number,
) => number;

export const defaultTextMetrics: TextMetricsFn = (text, fontSize, fontWeight = 400) =>
  measureTextWidth(text, fontSize, fontWeight);

export { measureMultilineText };
