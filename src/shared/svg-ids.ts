/** Deterministic SVG IDs from a caller prefix and a stable suffix. */
export function svgId(idPrefix: string | undefined, suffix: string): string {
  const prefix = (idPrefix ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return prefix ? `${prefix}${suffix}` : suffix;
}

export function validateCssFontFamily(fontFamily: string): string {
  if (/[;{}<>]|<\/style|]]>/i.test(fontFamily)) {
    throw new Error("Invalid fontFamily: contains CSS/XML metacharacters");
  }
  return fontFamily;
}
