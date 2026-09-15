import { DiagramRenderError, type DiagramDiagnostic } from './errors.ts'

export const BM_E_NONFINITE_GEOMETRY = 'BM_E_NONFINITE_GEOMETRY'

const DIMENSION_KEYS = new Set(['width', 'height'])

/**
 * Walk a layout result and throw `DiagramRenderError` when any numeric
 * value is non-finite, or when a `width`/`height` is not positive.
 *
 * Layout engines (ELK, sequence, xychart, swimlane) all produce plain
 * objects, arrays and Maps of numbers, so a single structural walk is
 * enough for every diagram type. Strings, booleans, functions and
 * `undefined` are ignored.
 */
export function assertFiniteGeometry(layout: unknown, kind: string): void {
  const problems: string[] = []
  const seen = new WeakSet<object>()

  const visit = (value: unknown, path: string): void => {
    if (problems.length >= 8) return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        problems.push(`${path} = ${String(value)}`)
        return
      }
      const key = path.slice(path.lastIndexOf('.') + 1)
      if (DIMENSION_KEYS.has(key) && value <= 0 && isRootDimension(path)) {
        problems.push(`${path} = ${value} (must be > 0)`)
      }
      return
    }
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (value instanceof Map) {
      for (const [k, v] of value) visit(v, `${path}[${String(k)}]`)
      return
    }
    if (value instanceof Set) {
      let index = 0
      for (const v of value) visit(v, `${path}[${index++}]`)
      return
    }
    for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`)
  }

  visit(layout, kind)

  if (problems.length === 0) return
  const diagnostics: DiagramDiagnostic[] = problems.map((problem) => ({
    code: BM_E_NONFINITE_GEOMETRY,
    severity: 'error',
    message: problem,
    path: problem.split(' = ')[0],
  }))
  throw new DiagramRenderError(
    `${kind}: layout produced non-finite geometry (${problems[0]})`,
    diagnostics,
  )
}

/** Only the top-level `width`/`height` of a layout must be strictly positive. */
function isRootDimension(path: string): boolean {
  return path.split('.').length === 2
}
