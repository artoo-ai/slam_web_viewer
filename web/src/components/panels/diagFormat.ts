/** Formatting helper shared across the diagnostics panels. Kept in its own
 *  module so the component files export only components (React Fast Refresh). */
export function fmtNum(v: number | null | undefined, digits = 2, unit = ''): string {
  if (v === null || v === undefined) return '—'
  return `${v.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}

/** Seconds since `ts` (a performance.now() stamp), or Infinity if never seen.
 *  The performance.now() call is kept out of component render bodies (the
 *  react-hooks purity rule flags impure calls there) — same approach as
 *  stalenessFeed.health(). */
export function ageSeconds(ts: number | null): number {
  return ts === null ? Infinity : (performance.now() - ts) / 1000
}
