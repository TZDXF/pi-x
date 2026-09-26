/** Session-wide token-weighted share of input served from cache. */
export function averageCacheRate(tokens?: { input: number, cacheRead: number, cacheWrite: number } | null): number | null {
  if (!tokens) return null
  const totalInput = tokens.input + tokens.cacheRead + tokens.cacheWrite
  if (totalInput <= 0) return null
  return tokens.cacheRead / totalInput
}
