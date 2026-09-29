/**
 * Token count formatting for the budget meters. Raw below 1000, otherwise Nk
 * (one decimal once >= 10k gets noisy) or N.nM past a million.
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const m = n / 1_000_000;
  return `${Math.round(m * 10) / 10}M`;
}
