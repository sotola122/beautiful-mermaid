export function firstKeywordLine(text: string): string {
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    return trimmed;
  }
  return "";
}

export type ExtendedKind =
  | "swimlane"
  | "packet"
  | "packet-beta"
  | "registermap"
  | "memorymap";

export function detectExtendedKind(text: string): ExtendedKind | null {
  const first = firstKeywordLine(text).toLowerCase();
  if (/^swimlane(-beta)?(\s|$)/.test(first)) return "swimlane";
  if (/^packet-beta(\s|$)/.test(first)) return "packet-beta";
  if (/^packet(\s|$)/.test(first)) return "packet";
  if (/^register(map)?(\s|$)/.test(first)) return "registermap";
  if (/^memory[-_]?map(\s|$)/.test(first)) return "memorymap";
  return null;
}

export function isWireglyphSource(text: string): boolean {
  const kind = detectExtendedKind(text);
  if (
    kind === "packet" ||
    kind === "packet-beta" ||
    kind === "registermap" ||
    kind === "memorymap"
  ) {
    return true;
  }
  const first = firstKeywordLine(text);
  return (
    (first.startsWith("#") || /^(title|cols|wrap)\s*:/i.test(first)) &&
    /\bcols\s*:/.test(text) &&
    /^(?:B|Byte)\d+/m.test(text)
  );
}
